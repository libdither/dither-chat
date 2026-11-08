/**
 * Triage of mail and its notifications (mail/triage.ts, docs/mail-design.md §10) on FakeMailBackend with a real chat
 * store, chat's Triage and TriageVotes: bulk never notifies; someone you write to, writing to you, is Important; quiet
 * hours hold it; a device's "Email off"; one vote on Sam's mail moves Sam's chances on Signal, once merged; a sender
 * nobody knows reaches the one-list inbox only at Active; and the rest of what keeps mail from buzzing. Nothing here
 * sends a push: notifications are caught where main.ts would send them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId, mailId } from '@dither-chat/protocol/ids';
import { Attention } from '../src/attention.ts';
import { Delivery } from '../src/delivery.ts';
import { Devices } from '../src/devices.ts';
import { predict } from '../src/learn.ts';
import { mailAttention } from '../src/mail/attention.ts';
import { mailClassifier } from '../src/mail/classify.ts';
import { FakeMailBackend, type FakeInput } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople } from '../src/mail/people.ts';
import { mailTriage, type MailNotice } from '../src/mail/triage.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';

const ACC = 'acc_triageMail';
const ME = { name: 'Me', email: 'me@example.com' };
const SAM = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const JO = { name: 'Jo Park', email: 'jo@park.example' };
const THEO = { name: 'Theo', email: 'theo@example.net' };
const NEWS = { name: 'Rust Weekly', email: 'editor@rust-weekly.example' };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const until = async (f: () => unknown, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

let seq = 0;

/** You wrote to Sam and Jo a month ago; Theo never. Sam is on Signal too, in a DM with you. */
async function world(seed: (put: (i: FakeInput) => void) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-triage-'));
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  let sg: AccountRow = chat.createAccount({ network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
  chat.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
  sg = chat.accounts().find((a) => a.id === sg.id)!;
  chat.ingest(sg, { t: 'identity', identity: { nativeId: '+15550101', displayName: 'Sam Rivera', contact: true } });
  chat.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm-sam', shape: 'direct', participants: ['+15550101'] } });
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name });
  fake.put(ACC, { mailboxId: 'Sent', messageId: '<hello@x>', from: [ME], to: [SAM, JO], subject: 'Hello', receivedAt: Date.now() - 30 * DAY, flags: { seen: true } });
  seed((i) => void fake.put(ACC, i));
  const hub = new MailHub({ db: chat.db, backend: fake, log: () => {} });
  const triage = new Triage(chat);
  const votes = new TriageVotes(chat, triage);
  const attention = new Attention(chat, triage);
  const devices = new Devices(chat, triage);
  const delivery = new Delivery(chat, triage);
  const sent: MailNotice[] = [];
  const mt = mailTriage(hub)!;
  mt.bodyWaitMs = 300;
  mailPeople(hub)!.connect(chat);
  mailAttention(hub)!.connect(chat, attention);
  mt.connect({ store: chat, triage, votes, deliver: (n) => sent.push(n) });
  devices.otherChain = (id) => mt.chain(id);
  delivery.other = mt;
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  await Bun.sleep(20);
  cleanup = () => {
    mailPeople(hub)?.stop();
    hub.stop();
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const mid = (messageId: string) => mailId('mml', ACC, `m:${messageId}`);
  const row = (messageId: string) => chat.one<Record<string, any>>('SELECT * FROM mail_triage WHERE message_id = ?', mid(messageId));
  /** New mail, live: it is decided once its body came (or after the wait). */
  const arrive = async (i: FakeInput & { messageId: string }, decided = true) => {
    fake.deliver(ACC, { from: [SAM], to: [ME], subject: 'Hi', text: 'Hello there.', ...i });
    if (decided) await until(() => row(i.messageId), 3000, `a decision on ${i.messageId}`);
    else await Bun.sleep(500);
    return row(i.messageId);
  };
  const tid = (messageId: string) => chat.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', mid(messageId))!.thread_id;
  const samSignal = hubId('idn', 'signal', '+15550101');
  const dm = chat.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'dm-sam'`)!.id;
  /** A message from Sam on Signal, decided by chat's triage as it would be live. */
  const signalFromSam = async (body: string) => {
    const nativeId = `sig-${++seq}`;
    chat.ingest(sg, { t: 'message', message: { nativeId, conversation: 'dm-sam', author: '+15550101', ts: Date.now(), body }, live: true });
    const id = chat.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    return { id, decision: (await triage.decide(id))! };
  };
  return { chat, fake, hub, triage, votes, attention, devices, delivery, sent, mt, mid, row, arrive, tid, samSignal, dm, signalFromSam };
}

describe('what notifies', () => {
  test('bulk never notifies, nor is it triaged: no decision, no digest', async () => {
    const w = await world();
    await w.arrive(
      { messageId: '<news-1@x>', from: [NEWS], subject: 'Issue 600', text: 'This week: async closures. Are you ready?', bulk: { listId: '<weekly.rust-weekly.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null } },
      false,
    );
    await w.arrive({ messageId: '<gh-1@x>', from: [{ name: 'GitHub', email: 'notifications@github.example' }], subject: 'CI passed' }, false);
    expect(w.row('<news-1@x>')).toBeNull();
    expect(w.row('<gh-1@x>')).toBeNull();
    expect(w.sent).toHaveLength(0);
    expect(w.mt.items(0)).toHaveLength(0);
  });

  test('someone you write to, writing to you: Important, with the sender, the subject, the email mark', async () => {
    const w = await world();
    const r = await w.arrive({ messageId: '<sam-1@x>', subject: 'Dinner on Friday?', text: 'Are you free after 7? There is a new ramen place on Maple Street.' });
    expect(r).toMatchObject({ decision: 'push', level: 'push', delivered: 1, decided_by: 'rules' });
    const facts = JSON.parse(r!.facts);
    expect(facts).toMatchObject({ network: 'email', shape: 'mail', conversation: w.tid('<sam-1@x>'), spaces: [ACC], mention: true, known: true, question: true, base: 'push' });
    expect(facts.notify).toBeUndefined();
    expect(JSON.parse(r!.words)).toContain('ramen');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ title: 'Sam Rivera', level: 'push', addressed: true, threadId: w.tid('<sam-1@x>'), look: { network: 'email' } });
    expect(w.sent[0].body.startsWith('Dinner on Friday? — ')).toBe(true);
    expect(w.sent[0].reasons).toContain('Sam Rivera wrote to you');
    // In Cc: Active, a silent notification.
    const cc = await w.arrive({ messageId: '<sam-2@x>', to: [THEO], cc: [ME], subject: 'Plans' });
    expect(cc).toMatchObject({ decision: 'quiet', delivered: 1 });
    // On a list (neither To nor Cc): the digest, not below it.
    const list = await w.arrive({ messageId: '<sam-3@x>', to: [{ name: 'Climbers', email: 'climbers@lists.example' }], subject: 'Sunday' });
    expect(list).toMatchObject({ decision: 'digest', delivered: 0 });
    expect(JSON.parse(list!.reasons)[0]).toBe('Sam Rivera wrote to a list you are on');
    // The fold hears it was pushed; the board lists both.
    expect(w.mt.factsOf([w.mid('<sam-1@x>')]).get(w.mid('<sam-1@x>'))).toMatchObject({ pushed: true, question: true });
    expect(w.mt.items(0).map((i) => i.id)).toEqual([w.mid('<sam-3@x>'), w.mid('<sam-2@x>'), w.mid('<sam-1@x>')]);
    // The thread's view and the message's carry it.
    const thread = w.hub.store.threadView(w.hub.store.thread(w.tid('<sam-1@x>'))!);
    expect(thread.triage).toMatchObject({ kind: 'mail', id: w.mid('<sam-1@x>'), triage: { decision: 'push', feedback: null } });
    expect(w.hub.store.messageViews(w.tid('<sam-1@x>')).find((m) => m.id === w.mid('<sam-1@x>'))!.triage?.decision).toBe('push');
  });

  test('what a sync lists is never triaged, unread or not; only what arrives (or keep-up finds new)', async () => {
    const w = await world((put) => put({ messageId: '<old@x>', from: [SAM], to: [ME], subject: 'From before', receivedAt: Date.now() - 2 * MIN }));
    await Bun.sleep(400);
    expect(w.chat.one('SELECT 1 FROM mail_message WHERE id = ?', w.mid('<old@x>'))).not.toBeNull();
    expect(w.row('<old@x>')).toBeNull();
    expect(w.sent).toHaveLength(0);
    // Keep-up finding one that came meanwhile is new mail.
    w.fake.put(ACC, { messageId: '<meanwhile@x>', from: [SAM], to: [ME], subject: 'Meanwhile', receivedAt: Date.now() - MIN });
    await w.hub.refresh(ACC);
    await until(() => w.row('<meanwhile@x>'), 3000, 'the one keep-up found');
    expect(w.sent.map((n) => n.messageId)).toEqual([w.mid('<meanwhile@x>')]);
  });

  test('quiet hours hold mail as they hold chat, and their summary points at the thread', async () => {
    const w = await world();
    const h = new Date().getUTCHours();
    const at = (x: number) => `${String((x + 24) % 24).padStart(2, '0')}:00`;
    w.chat.setQuietHours({ enabled: true, start: at(h - 1), end: at(h + 2), timezone: 'UTC', allowStarred: false });
    const r = await w.arrive({ messageId: '<sam-q@x>', subject: 'Late night' });
    expect(r).toMatchObject({ decision: 'digest', level: 'push', delivered: 0 });
    expect(JSON.parse(r!.reasons)[0]).toBe(`Held by quiet hours until ${at(h + 2)}`);
    expect(w.sent).toHaveLength(0);
    expect(w.chat.quietHeld()).toMatchObject({ count: 1, conversationId: w.tid('<sam-q@x>'), messageId: w.mid('<sam-q@x>') });
    // Held, it still counts as Important for the inbox: it is rated so.
    expect(w.mt.rated(w.tid('<sam-q@x>'))).toBe(true);
  });

  test('late, already read, outside Inbox, muted: rated, but nobody is notified', async () => {
    const w = await world();
    const late = await w.arrive({ messageId: '<late@x>', receivedAt: Date.now() - 3 * 60 * MIN });
    expect(late).toMatchObject({ decision: 'push', delivered: 0 });
    expect(JSON.parse(late!.reasons)).toContain('Came in late: no notification');
    const read = await w.arrive({ messageId: '<read@x>', flags: { seen: true } });
    expect(read).toMatchObject({ decision: 'push', delivered: 0 });
    // Muted: silent, and not voted on.
    const first = await w.arrive({ messageId: '<m1@x>', subject: 'Muted thread' });
    w.chat.db.query('UPDATE mail_thread SET muted = 1 WHERE id = ?').run(w.tid('<m1@x>'));
    const muted = await w.arrive({ messageId: '<m2@x>', subject: 'Re: Muted thread', inReplyTo: '<m1@x>', references: ['<m1@x>'] });
    expect(first!.decision).toBe('push');
    expect(muted).toMatchObject({ decision: 'silent', delivered: 0 });
    expect(() => w.votes.vote(w.mid('<m2@x>'), 'up')).toThrow();
    expect(w.sent.map((n) => n.messageId)).toEqual([w.mid('<m1@x>')]);
  });

  test('a sender who looks spoofed never buzzes: Active at most', async () => {
    const w = await world();
    const r = await w.arrive({ messageId: '<spoof@x>', replyTo: [{ name: null, email: 'payments@elsewhere.example' }], subject: 'Invoice', text: 'Please pay the attached invoice today.' });
    expect(r).toMatchObject({ decision: 'quiet', delivered: 1 });
    expect(JSON.parse(r!.reasons).some((x: string) => x.startsWith('No buzz: Replies go to payments@elsewhere.example'))).toBe(true);
    // Learned or not, it stays there.
    w.votes.vote(w.mid('<spoof@x>'), 'push');
    const again = await w.arrive({ messageId: '<spoof-2@x>', replyTo: [{ name: null, email: 'payments@elsewhere.example' }], subject: 'Invoice' });
    expect(again!.decision).toBe('quiet');
  });
});

describe('device rules', () => {
  test('"Email off" on a device keeps mail off it, and only mail', async () => {
    const w = await world();
    w.devices.hello('dev-phone', 'Android app, Pixel', null);
    w.devices.hello('dev-laptop', 'Linux, Firefox', null);
    expect(w.devices.setRule('dev-phone', 'network', 'email', 'none')).toBeNull();
    await w.arrive({ messageId: '<sam-d@x>' });
    const thread = w.tid('<sam-d@x>');
    expect(w.devices.chain(thread)).toEqual([`conversation:${thread}`, `account:${ACC}`, 'network:email']);
    expect(w.devices.quietOn(thread, true)).toEqual(['dev-phone']);
    expect(w.devices.quietOn(w.dm, true)).toEqual([]);
    // One mail account off, mentions only for mail elsewhere.
    w.devices.setRule('dev-phone', 'network', 'email', null);
    w.devices.setRule('dev-laptop', 'account', ACC, 'mentions');
    expect(w.devices.quietOn(thread, true)).toEqual([]);
    expect(w.devices.quietOn(thread, false)).toEqual(['dev-laptop']);
  });
});

describe('one notification per thread', () => {
  test('its unread lines with the subject, and read anywhere takes it off', async () => {
    const w = await world();
    await w.arrive({ messageId: '<l1@x>', subject: 'Lease renewal', text: 'Could you sign pages 3 and 4?' });
    await w.arrive({ messageId: '<l2@x>', subject: 'Re: Lease renewal', inReplyTo: '<l1@x>', references: ['<l1@x>'], text: 'And the parking spot?' });
    const thread = w.tid('<l2@x>');
    const g = w.delivery.plan(thread, w.mid('<l2@x>'), 'push', true)!;
    expect(g.alert).toBe(true);
    expect(g.conv).toMatchObject({ title: 'Sam Rivera', shape: 'direct' });
    expect(g.lines.map((l) => l.body)).toEqual(['Lease renewal — Could you sign pages 3 and 4?', 'And the parking spot?']);
    expect(g.sender.name).toBe('Sam Rivera');
    expect(w.delivery.read()).toEqual([]);
    w.hub.readHere([thread]);
    expect(w.delivery.read()).toEqual([thread]);
  });
});

describe('votes', () => {
  test('one vote on Sam’s mail moves Sam’s chances on Signal, once they are one person', async () => {
    const w = await world();
    const before = await w.signalFromSam('see you at 7');
    expect(before.decision.decision).toBe('push');
    const r = await w.arrive({ messageId: '<sam-v@x>', subject: 'Dinner' });
    expect(r!.decision).toBe('push');
    // Merge Sam by mail into Sam on Signal (after the decision: the vote follows the merge).
    const pOf = (id: string) => w.chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', id)!.person_id;
    const samMail = w.chat.emailIdentity(SAM.email, SAM.name);
    w.chat.mergePersons(w.chat.ensurePerson(w.samSignal), pOf(samMail));
    const person = pOf(w.samSignal);
    expect(pOf(samMail)).toBe(person);
    const res = w.votes.vote(w.mid('<sam-v@x>'), 'down');
    expect(res.feedback).toBe('quiet');
    expect(res.policy.votes).toBe(1);
    expect(w.triage.learned.w.ping[`author:${person}`]).toBeLessThan(0);
    // The next Signal message from Sam: less likely to ping than before the vote.
    const after = await w.signalFromSam('running late');
    expect(after.decision.probs!.ping).toBeLessThan(before.decision.probs!.ping);
    // And what was learned names the mail in words.
    const facts = w.triage.factsFor(after.id, 'push')!;
    expect(predict(w.triage.learned, facts).probs.ping).toBeLessThan(0.9);
    expect(res.policy.factors.some((f) => f.text.includes('Sam Rivera'))).toBe(true);
  });

  test('no mail votes: chat learns exactly what it did', async () => {
    const w = await world();
    await w.arrive({ messageId: '<sam-n@x>' });
    const chatOnly = w.votes.examples().length;
    expect(chatOnly).toBe(0);
    w.votes.learn('test');
    expect(w.triage.learned.w).toEqual({ ping: {}, active: {}, interesting: {} });
  });

  test('a sender nobody knows reaches the inbox only at Active; a vote lets them in, and "Not a person" is a vote down', async () => {
    const w = await world();
    const r = await w.arrive({ messageId: '<theo-1@x>', from: [THEO], subject: 'Climbing on Sunday?', text: 'Gym at 10? I can bring the spare harness.' });
    expect(r).toMatchObject({ decision: 'digest', delivered: 0 });
    expect(JSON.parse(r!.facts)).toMatchObject({ known: false, base: 'digest' });
    expect(JSON.parse(r!.reasons)[0]).toBe('From someone you have not written to');
    const thread = w.tid('<theo-1@x>');
    const listed = () => {
      w.attention.sync([]);
      return w.attention.list().some((v) => v.id === thread);
    };
    expect(w.mt.rated(thread)).toBe(false);
    expect(listed()).toBe(false);
    w.votes.vote(w.mid('<theo-1@x>'), 'up');
    expect(w.row('<theo-1@x>')!.feedback).toBe('quiet');
    expect(w.mt.rated(thread)).toBe(true);
    await until(() => listed(), 2000, 'Theo in the inbox');
    // Not a person: a vote down, and out of the inbox.
    mailClassifier(w.hub)!.person(thread, false);
    expect(w.row('<theo-1@x>')!.feedback).toBe('digest');
    await until(() => !listed(), 2000, 'Theo out of the inbox');
  });

  test('the routes: the board’s list, and a vote by id as /api/messages/:id/feedback takes it', async () => {
    const w = await world();
    await w.arrive({ messageId: '<sam-r@x>' });
    const route = (method: string, path: string, body?: unknown) => {
      const url = new URL(`http://hub${path}`);
      return w.hub.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url);
    };
    const page = (await (await route('GET', '/api/mail/triage'))!.json()) as P.MailTriagePage;
    expect(page.items.map((i) => i.id)).toEqual([w.mid('<sam-r@x>')]);
    expect(page.items[0]).toMatchObject({ kind: 'mail', from: { email: SAM.email }, unread: true, triage: { decision: 'push' } });
    const v = (await (await route('POST', `/api/mail/triage/${w.mid('<sam-r@x>')}/vote`, { vote: 'down' }))!.json()) as { feedback: string; policy: P.TriagePolicyView };
    expect(v.feedback).toBe('quiet');
    expect(v.policy.votes).toBe(1);
    expect((await route('POST', `/api/mail/triage/${w.mid('<sam-r@x>')}/vote`, { vote: 'sideways' }))!.status).toBe(400);
    // A message the server lost keeps its vote (it is learned from); one without a vote goes.
    await w.arrive({ messageId: '<sam-gone@x>' });
    w.hub.emit('deleted', { accountId: ACC, messageIds: [w.mid('<sam-r@x>'), w.mid('<sam-gone@x>')] });
    expect(w.row('<sam-r@x>')).not.toBeNull();
    expect(w.row('<sam-gone@x>')).toBeNull();
    expect(w.votes.examples().filter((e) => e.vote)).toHaveLength(1);
  });
});
