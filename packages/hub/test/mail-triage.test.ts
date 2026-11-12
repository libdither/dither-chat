/**
 * Triage of mail and its notifications (mail/triage.ts, docs/mail-design.md §10) on FakeMailBackend with a real chat
 * store, chat's Triage and TriageVotes: bulk never notifies; someone you write to, writing to you, is a row on the
 * list; only someone set to always alert is an alert, and quiet hours hold it; a device's "Email off"; "less like
 * this" on Sam's mail lowers Sam's importance on Signal, once merged; a sender nobody knows reaches the one-list inbox
 * only when on the list; decisions from before the tiers; and the rest of what keeps mail from sounding. Nothing here
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
import { emptyModel, OLD_VOTE, predict, voteWeight } from '../src/learn.ts';
import { mailAttention } from '../src/mail/attention.ts';
import { mailClassifier } from '../src/mail/classify.ts';
import { FakeMailBackend, type FakeInput } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople } from '../src/mail/people.ts';
import { mailTriage, QUIET_REASON, type MailNotice } from '../src/mail/triage.ts';
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

/**
 * You wrote to Sam and Jo a month ago; Theo never. Sam is on Signal too, in a DM with you. `late`: mail's triage is
 * not connected to chat's until `connect()` is called, as on a hub whose mail was there before it.
 */
async function world(seed: (put: (i: FakeInput) => void) => void = () => {}, late = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-triage-'));
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  // No fsync per write (1,200 in this file), and nothing here has to outlive the process.
  chat.db.exec('PRAGMA synchronous = OFF');
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
  const connect = () => mt.connect({ store: chat, triage, votes, deliver: (n) => sent.push(n) });
  if (!late) connect();
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
  /** Set someone you get mail from to Always alert (a person rule `all`), or back to Automatic. */
  const alwaysAlert = (who: { name: string; email: string }, on = true) => chat.setRule('person', chat.ensurePerson(chat.emailIdentity(who.email, who.name)), on ? 'all' : null);
  return { chat, fake, hub, triage, votes, attention, devices, delivery, sent, mt, mid, row, arrive, tid, samSignal, dm, signalFromSam, alwaysAlert, connect };
}

describe('what notifies', () => {
  test('bulk never notifies, nor is it triaged: no decision, no row on the list', async () => {
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

  test('someone you write to, writing to you: on the list, with the sender, the subject, its importance, the email mark', async () => {
    const w = await world();
    const r = await w.arrive({ messageId: '<sam-1@x>', subject: 'Dinner on Friday?', text: 'Are you free after 7? There is a new ramen place on Maple Street.' });
    expect(r).toMatchObject({ decision: 'digest', level: 'digest', score: 0.8, delivered: 1, decided_by: 'rules' });
    expect(JSON.parse(r!.probs)).toEqual({ alert: 0.02, important: 0.8 });
    const facts = JSON.parse(r!.facts);
    // What a mail client would have notified you about: the model's start for importance.
    expect(facts).toMatchObject({ network: 'email', shape: 'mail', conversation: w.tid('<sam-1@x>'), spaces: [ACC], mention: true, known: true, question: true, base: 'quiet', notify: true });
    expect(facts.native).toBeUndefined();
    expect(JSON.parse(r!.words)).toContain('ramen');
    expect(JSON.parse(r!.reasons)).toEqual(['Sam Rivera wrote to you']);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ title: 'Sam Rivera', level: 'digest', importance: 0.8, addressed: true, threadId: w.tid('<sam-1@x>'), look: { network: 'email' } });
    expect(w.sent[0].body.startsWith('Dinner on Friday? — ')).toBe(true);
    expect(w.sent[0].reasons).toContain('Sam Rivera wrote to you');
    // In Cc: the list too.
    const cc = await w.arrive({ messageId: '<sam-2@x>', to: [THEO], cc: [ME], subject: 'Plans' });
    expect(cc).toMatchObject({ decision: 'digest', delivered: 1 });
    expect(JSON.parse(cc!.reasons)).toEqual(['Sam Rivera copied you in']);
    expect(w.sent[1]).toMatchObject({ level: 'digest', addressed: false });
    // On a mailing list (neither To nor Cc): no mail client would have notified you, and it says too little: below.
    const list = await w.arrive({ messageId: '<sam-3@x>', to: [{ name: 'Climbers', email: 'climbers@lists.example' }], subject: 'Sunday' });
    expect(list).toMatchObject({ decision: 'drop', level: 'drop', delivered: 0 });
    expect(JSON.parse(list!.facts)).toMatchObject({ base: 'digest', notify: false, score: 0.35 });
    expect(JSON.parse(list!.reasons)).toEqual(['Below the list: importance 31%', 'Sam Rivera wrote to a list you are on', 'About you: from someone you know']);
    expect(w.sent).toHaveLength(2);
    // The fold hears a notification went out; the board lists all three.
    expect(w.mt.factsOf([w.mid('<sam-1@x>')]).get(w.mid('<sam-1@x>'))).toMatchObject({ pushed: true, question: true });
    expect(w.mt.factsOf([w.mid('<sam-3@x>')]).get(w.mid('<sam-3@x>'))).toMatchObject({ pushed: false });
    expect(w.mt.items(0).map((i) => i.id)).toEqual([w.mid('<sam-3@x>'), w.mid('<sam-2@x>'), w.mid('<sam-1@x>')]);
    // The thread's view and the message's carry it.
    const thread = w.hub.store.threadView(w.hub.store.thread(w.tid('<sam-1@x>'))!);
    expect(thread.triage).toMatchObject({ kind: 'mail', id: w.mid('<sam-1@x>'), triage: { decision: 'digest', score: 0.8, feedback: null, probs: { alert: 0.02, important: 0.8 } } });
    expect(w.hub.store.messageViews(w.tid('<sam-1@x>')).find((m) => m.id === w.mid('<sam-1@x>'))!.triage?.decision).toBe('digest');
  });

  test('at your level: what is on the list at 60% is below it at 90%, and the other way at 30%', async () => {
    const w = await world();
    w.votes.setLevel(0.9);
    expect(await w.arrive({ messageId: '<sam-hi@x>', subject: 'Dinner?' })).toMatchObject({ decision: 'drop', delivered: 0 });
    expect(JSON.parse(w.row('<sam-hi@x>')!.reasons)[0]).toBe('Below the list: importance 80%');
    w.votes.setLevel(0.3);
    expect(await w.arrive({ messageId: '<sam-lo@x>', to: [{ name: 'Climbers', email: 'climbers@lists.example' }], subject: 'Sunday' })).toMatchObject({ decision: 'digest', delivered: 1 });
    expect(w.sent.map((n) => [n.messageId, n.level, n.importance])).toEqual([[w.mid('<sam-lo@x>'), 'digest', 0.313]]);
  });

  test('mail is an alert only from someone set to always alert', async () => {
    const w = await world();
    // Urgent words, a question, from someone you write to: still a row on the list. Nothing reads mail for urgency.
    const urgent = await w.arrive({ messageId: '<sam-u@x>', subject: 'Urgent: call me right now?', text: 'It is an emergency, are you there?' });
    expect(urgent).toMatchObject({ decision: 'digest', level: 'digest' });
    expect(JSON.parse(urgent!.facts)).toMatchObject({ urgent: true, question: true });
    w.alwaysAlert(SAM);
    const r = await w.arrive({ messageId: '<sam-a@x>', subject: 'Lunch' });
    expect(r).toMatchObject({ decision: 'push', level: 'push', delivered: 1, decided_by: 'rules' });
    expect(JSON.parse(r!.reasons)).toEqual(['From Sam Rivera, who is set to always alert']);
    expect(JSON.parse(r!.facts)).toMatchObject({ base: 'push', notify: true });
    expect(w.sent.at(-1)).toMatchObject({ messageId: w.mid('<sam-a@x>'), level: 'push', importance: 0.8, title: 'Sam Rivera' });
    // Whatever was learned about how much it matters: the rule decides, not the model.
    w.triage.learned = { w: { alert: { all: -10 }, important: { all: -10 } } };
    const still = await w.arrive({ messageId: '<sam-a2@x>', subject: 'Coffee' });
    expect(still).toMatchObject({ decision: 'push', decided_by: 'rules' });
    expect(still!.score).toBeLessThan(0.01);
    w.triage.learned = emptyModel();
    // Back to Automatic: the list again. Jo was never set: the list.
    w.alwaysAlert(SAM, false);
    expect((await w.arrive({ messageId: '<sam-a3@x>', subject: 'Tea' }))!.decision).toBe('digest');
    expect((await w.arrive({ messageId: '<jo-a@x>', from: [JO], subject: 'Tea' }))!.decision).toBe('digest');
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

  test('quiet hours hold an alert as a silent row on the list, and their summary points at the thread; list rows are not held', async () => {
    const w = await world();
    const h = new Date().getUTCHours();
    const at = (x: number) => `${String((x + 24) % 24).padStart(2, '0')}:00`;
    w.chat.setQuietHours({ enabled: true, start: at(h - 1), end: at(h + 2), timezone: 'UTC', allowStarred: false });
    // Not an alert: nothing to hold. It goes out as the silent row it always is.
    const plain = await w.arrive({ messageId: '<jo-q@x>', from: [JO], subject: 'Tomorrow' });
    expect(plain).toMatchObject({ decision: 'digest', level: 'digest', delivered: 1 });
    expect(JSON.parse(plain!.reasons)).toEqual(['Jo Park wrote to you']);
    expect(w.chat.quietHeld()).toBeNull();
    // An alert: held. It still shows, silently, as a row on the list.
    w.alwaysAlert(SAM);
    const r = await w.arrive({ messageId: '<sam-q@x>', subject: 'Late night' });
    expect(r).toMatchObject({ decision: 'digest', level: 'push', delivered: 1 });
    expect(JSON.parse(r!.reasons).slice(0, 2)).toEqual([`Held by quiet hours until ${at(h + 2)}`, 'From Sam Rivera, who is set to always alert']);
    expect(w.sent.map((n) => n.level)).toEqual(['digest', 'digest']);
    expect(w.chat.quietHeld()).toMatchObject({ count: 1, conversationId: w.tid('<sam-q@x>'), messageId: w.mid('<sam-q@x>') });
    expect(w.triage.takeHeldSummary(Date.now() + 3 * 60 * MIN)).toMatchObject({ body: '1 message held for you', conversationId: w.tid('<sam-q@x>'), messageId: w.mid('<sam-q@x>') });
    // Held, it still counts for the inbox: it is rated so.
    expect(w.mt.rated(w.tid('<sam-q@x>'))).toBe(true);
    // Allowed through: someone set to always alert sounds during quiet hours too.
    w.chat.setQuietHours({ enabled: true, start: at(h - 1), end: at(h + 2), timezone: 'UTC', allowStarred: true });
    const through = await w.arrive({ messageId: '<sam-q2@x>', subject: 'Later still' });
    expect(through).toMatchObject({ decision: 'push', level: 'push', delivered: 1 });
    expect(w.sent.at(-1)!.level).toBe('push');
    expect(w.chat.quietHeld()).toBeNull();
  });

  test('late, already read, outside Inbox, muted: rated, but nobody is notified', async () => {
    const w = await world();
    const late = await w.arrive({ messageId: '<late@x>', receivedAt: Date.now() - 3 * 60 * MIN });
    expect(late).toMatchObject({ decision: 'digest', delivered: 0 });
    expect(JSON.parse(late!.reasons)).toContain('Came in late: no notification');
    const read = await w.arrive({ messageId: '<read@x>', flags: { seen: true } });
    expect(read).toMatchObject({ decision: 'digest', delivered: 0 });
    expect(JSON.parse(read!.reasons)).toContain('Already read: no notification');
    // An alert is kept back by the same things.
    w.alwaysAlert(SAM);
    const alert = await w.arrive({ messageId: '<read-a@x>', flags: { seen: true } });
    expect(alert).toMatchObject({ decision: 'push', delivered: 0 });
    w.alwaysAlert(SAM, false);
    // Muted: silent, and not marked.
    const first = await w.arrive({ messageId: '<m1@x>', subject: 'Muted thread' });
    w.chat.db.query('UPDATE mail_thread SET muted = 1 WHERE id = ?').run(w.tid('<m1@x>'));
    const muted = await w.arrive({ messageId: '<m2@x>', subject: 'Re: Muted thread', inReplyTo: '<m1@x>', references: ['<m1@x>'] });
    expect(first!.decision).toBe('digest');
    expect(muted).toMatchObject({ decision: 'silent', delivered: 0 });
    expect(() => w.votes.mark(w.mid('<m2@x>'), { less: true })).toThrow('muted');
    expect(w.sent.map((n) => n.messageId)).toEqual([w.mid('<m1@x>')]);
  });

  test('a sender who looks spoofed never alerts, always alert or not: the list at most', async () => {
    const w = await world();
    w.alwaysAlert(SAM);
    const r = await w.arrive({ messageId: '<spoof@x>', replyTo: [{ name: null, email: 'payments@elsewhere.example' }], subject: 'Invoice', text: 'Please pay the attached invoice today.' });
    expect(r).toMatchObject({ decision: 'digest', level: 'digest', delivered: 1 });
    const reasons = JSON.parse(r!.reasons) as string[];
    expect(reasons[0].startsWith('No alert: Replies go to payments@elsewhere.example')).toBe(true);
    expect(reasons).toContain('From Sam Rivera, who is set to always alert');
    expect(w.sent.map((n) => n.level)).toEqual(['digest']);
    // The same sender, with nothing odd about the message: an alert.
    expect((await w.arrive({ messageId: '<honest@x>', subject: 'Invoice' }))!.decision).toBe('push');
    // Learned or not, a spoofed one stays off it.
    w.triage.learned = { w: { alert: { all: 10 }, important: { all: 10 } } };
    const again = await w.arrive({ messageId: '<spoof-2@x>', replyTo: [{ name: null, email: 'payments@elsewhere.example' }], subject: 'Invoice' });
    expect(again!.decision).toBe('digest');
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

describe('marks', () => {
  test('"less like this" on Sam’s mail lowers Sam’s importance on Signal, once they are one person', async () => {
    const w = await world();
    const before = await w.signalFromSam('see you at 7');
    // A DM nobody read for urgency: a Conversation, whatever its importance.
    expect(before.decision.decision).toBe('quiet');
    expect(before.decision.probs!.important).toBe(0.8);
    const r = await w.arrive({ messageId: '<sam-v@x>', subject: 'Dinner' });
    expect(r!.decision).toBe('digest');
    // Merge Sam by mail into Sam on Signal (after the decision: the mark follows the merge).
    const pOf = (id: string) => w.chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', id)!.person_id;
    const samMail = w.chat.emailIdentity(SAM.email, SAM.name);
    w.chat.mergePersons(w.chat.ensurePerson(w.samSignal), pOf(samMail));
    const person = pOf(w.samSignal);
    expect(pOf(samMail)).toBe(person);
    const res = w.votes.mark(w.mid('<sam-v@x>'), { less: true });
    expect(res.marks).toEqual({ less: true });
    expect(res.policy.votes).toBe(1);
    // Kept with mail's own decisions, as the vote it replaces was.
    expect(w.row('<sam-v@x>')).toMatchObject({ decision: 'digest', feedback: 'drop' });
    expect(w.triage.learned.w.important[`author:${person}`]).toBeLessThan(0);
    // It says nothing about alerts.
    expect(w.triage.learned.w.alert).toEqual({});
    // The next Signal message from Sam: less important than before the mark, and still a Conversation.
    const after = await w.signalFromSam('running late');
    expect(after.decision.probs!.important).toBeLessThan(before.decision.probs!.important);
    expect(after.decision.decision).toBe('quiet');
    // And what was learned names the mail in words.
    const facts = w.triage.factsFor(after.id, 'drop')!;
    expect(predict(w.triage.learned, facts).probs.important).toBeLessThan(0.8);
    expect(res.policy.factors.some((f) => f.text.includes('Sam Rivera'))).toBe(true);
    // The next mail in that thread is below the list, and says what it learned from.
    const next = await w.arrive({ messageId: '<sam-v2@x>', subject: 'Re: Dinner', inReplyTo: '<sam-v@x>', references: ['<sam-v@x>'] });
    expect(next).toMatchObject({ decision: 'drop', decided_by: 'learned', delivered: 0 });
    expect(JSON.parse(next!.reasons)[0]).toBe('Below the list, learned from your marks (was List)');
    // Taken back: nothing is left of it.
    expect(w.votes.mark(w.mid('<sam-v@x>'), { less: false }).marks).toEqual({});
    expect(w.row('<sam-v@x>')!.feedback).toBeNull();
    expect(w.triage.learned.w).toEqual({ alert: {}, important: {} });
  });

  test('mail has no alert marks: one changes nothing, and says what mark is there', async () => {
    const w = await world();
    await w.arrive({ messageId: '<sam-m@x>' });
    const id = w.mid('<sam-m@x>');
    expect(w.votes.mark(id, { alert: true }).marks).toEqual({});
    expect(w.row('<sam-m@x>')).toMatchObject({ decision: 'digest', feedback: null });
    w.votes.mark(id, { less: true });
    expect(w.votes.mark(id, { alert: false }).marks).toEqual({ less: true });
    expect(w.row('<sam-m@x>')!.feedback).toBe('drop');
    // null takes "less like this" back, as false does.
    expect(w.votes.mark(id, { less: null }).marks).toEqual({});
    expect(w.row('<sam-m@x>')!.feedback).toBeNull();
    expect(() => w.votes.mark(w.mid('<never@x>'), { less: true })).toThrow('never decided');
  });

  test('no mail marks: chat learns exactly what it did', async () => {
    const w = await world();
    await w.arrive({ messageId: '<sam-n@x>' });
    const chatOnly = w.votes.examples().length;
    expect(chatOnly).toBe(0);
    w.votes.learn('test');
    expect(w.triage.learned.w).toEqual({ alert: {}, important: {} });
  });

  test('a sender nobody knows reaches the inbox only when on the list; "less like this" keeps them out, and "Not a person" is that mark', async () => {
    const w = await world();
    const r = await w.arrive({ messageId: '<theo-1@x>', from: [THEO], subject: 'Climbing on Sunday?', text: 'Gym at 10? I can bring the spare harness.' });
    expect(r).toMatchObject({ decision: 'drop', level: 'drop', score: 0.425, delivered: 0 });
    expect(JSON.parse(r!.facts)).toMatchObject({ known: false, base: 'digest', notify: false, score: 0.5 });
    expect(JSON.parse(r!.reasons).slice(1)).toEqual(['From someone you have not written to', 'About you: to you, asks a question']);
    expect(JSON.parse(r!.reasons)[0]).toMatch(/^Below the list: importance 4[23]%$/);
    const thread = w.tid('<theo-1@x>');
    const listed = () => {
      w.attention.sync([]);
      return w.attention.list().some((v) => v.id === thread);
    };
    expect(w.mt.rated(thread)).toBe(false);
    expect(listed()).toBe(false);
    // With the list's level at 40%, his next one is on it: rated, notified, and in the inbox.
    w.votes.setLevel(0.4);
    const next = await w.arrive({ messageId: '<theo-2@x>', from: [THEO], subject: 'Re: Climbing on Sunday?', inReplyTo: '<theo-1@x>', references: ['<theo-1@x>'], text: 'Or Saturday? Tell me which.' });
    expect(next).toMatchObject({ decision: 'digest', delivered: 1 });
    expect(w.tid('<theo-2@x>')).toBe(thread);
    expect(w.mt.rated(thread)).toBe(true);
    await until(() => listed(), 2000, 'Theo in the inbox');
    // Less like this: out again, though the decision stays what it was.
    expect(w.votes.mark(w.mid('<theo-2@x>'), { less: true }).marks).toEqual({ less: true });
    expect(w.row('<theo-2@x>')).toMatchObject({ decision: 'digest', feedback: 'drop' });
    expect(w.mt.rated(thread)).toBe(false);
    await until(() => !listed(), 2000, 'Theo out of the inbox');
    // Taken back: in. Then "Not a person": the same mark, and out for good.
    w.votes.mark(w.mid('<theo-2@x>'), { less: false });
    expect(w.mt.rated(thread)).toBe(true);
    await until(() => listed(), 2000, 'Theo back in the inbox');
    mailClassifier(w.hub)!.person(thread, false);
    expect(w.row('<theo-2@x>')!.feedback).toBe('drop');
    expect(w.mt.rated(thread)).toBe(false);
    await until(() => !listed(), 2000, 'Theo out of the inbox');
  });

  test('what a sync found from a stranger is rated quietly: listed when on the list, not below it, and nobody is notified', async () => {
    const at = Date.now() - 3 * DAY;
    const w = await world((put) => {
      put({ messageId: '<theo-old1@x>', from: [THEO], to: [ME], subject: 'Climbing on Sunday?', text: 'Gym at 10? I can bring the spare harness.', receivedAt: at });
      put({ messageId: '<kit-old1@x>', from: [{ name: 'Kit', email: 'kit@example.org' }], to: [ME], subject: 'Old photos', text: 'Found these in a drawer.', receivedAt: at + 1000 });
      put({ messageId: '<sam-old1@x>', from: [SAM], to: [ME], subject: 'Climbing too?', text: 'Are you going?', receivedAt: at + 2000 });
      put({ messageId: '<theo-gone@x>', from: [THEO], to: [ME], subject: 'Climbing last year', receivedAt: Date.now() - 90 * DAY });
    });
    // What the model learned: a climbing trip is worth seeing.
    w.triage.learned = { w: { alert: {}, important: { 'w:climbing': 40 } } };
    w.mt.quietWaitMs = 300;
    const thread = (m: string) => w.tid(m);
    const listed = () => {
      w.attention.sync([]);
      return new Set(w.attention.list().map((v) => v.id));
    };
    expect(w.row('<theo-old1@x>')).toBeNull();
    expect(listed().has(thread('<theo-old1@x>'))).toBe(false);
    w.mt.sweep();
    await until(() => w.row('<theo-old1@x>') && w.row('<kit-old1@x>'), 3000, 'the quiet ratings');
    const theo = w.row('<theo-old1@x>')!;
    expect(theo).toMatchObject({ decision: 'digest', level: 'digest', delivered: 0, quiet: 1, decided_by: 'learned' });
    expect(JSON.parse(theo.reasons)[0]).toBe('List, learned from your marks (was Below the list)');
    expect(JSON.parse(theo.reasons)).toContain(QUIET_REASON);
    // Its body was waited for: the model read the text.
    expect(JSON.parse(theo.words)).toContain('harness');
    const kit = w.row('<kit-old1@x>')!;
    expect(kit).toMatchObject({ decision: 'drop', delivered: 0, quiet: 1 });
    await until(() => listed().has(thread('<theo-old1@x>')), 2000, 'Theo in the inbox');
    expect(listed().has(thread('<kit-old1@x>'))).toBe(false);
    // Someone you write to needs no rating to be listed; mail outside the window is never rated.
    expect(w.row('<sam-old1@x>')).toBeNull();
    expect(w.row('<theo-gone@x>')).toBeNull();
    expect(w.sent).toHaveLength(0);
    expect(w.chat.quietHeld()).toBeNull();
    // The board shows it with why; a second pass rates nothing again.
    expect(w.mt.items(0).find((i) => i.id === w.mid('<theo-old1@x>'))!.triage.reasons).toContain(QUIET_REASON);
    expect(w.mt.sweep()).toBe(0);
    // A mark moves it as any other: less like this, out of the inbox.
    w.votes.mark(w.mid('<theo-old1@x>'), { less: true });
    await until(() => !listed().has(thread('<theo-old1@x>')), 2000, 'Theo out of the inbox');
    expect(w.sent).toHaveLength(0);
  });

  test('a quiet rating is never a line of a later notification', async () => {
    const w = await world((put) => put({ messageId: '<theo-old2@x>', from: [THEO], to: [ME], subject: 'Climbing on Sunday?', text: 'Gym at 10?', receivedAt: Date.now() - 2 * DAY }));
    w.triage.learned = { w: { alert: {}, important: { 'w:climbing': 40 } } };
    w.mt.quietWaitMs = 300;
    w.mt.sweep();
    await until(() => w.row('<theo-old2@x>'), 3000, 'the quiet rating');
    expect(w.row('<theo-old2@x>')).toMatchObject({ decision: 'digest', delivered: 0, quiet: 1 });
    const r = await w.arrive({ messageId: '<theo-new2@x>', from: [THEO], subject: 'Re: Climbing on Sunday?', inReplyTo: '<theo-old2@x>', references: ['<theo-old2@x>'], text: 'Still on for climbing?' });
    expect(r).toMatchObject({ decision: 'digest', delivered: 1, quiet: 0 });
    const g = w.mt.gather(w.tid('<theo-new2@x>'), w.mid('<theo-new2@x>'))!;
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0].body).toContain('Still on');
  });

  test('the routes: the board’s list, and "less like this" by id as /api/messages/:id/feedback takes it', async () => {
    const w = await world();
    await w.arrive({ messageId: '<sam-r@x>' });
    const route = (method: string, path: string, body?: unknown) => {
      const url = new URL(`http://hub${path}`);
      return w.hub.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url);
    };
    const board = async () => (await (await route('GET', '/api/mail/triage'))!.json()) as P.MailTriagePage;
    const vote = async (body: unknown) => {
      const r = (await route('POST', `/api/mail/triage/${w.mid('<sam-r@x>')}/vote`, body))!;
      return { status: r.status, json: (await r.json()) as { marks: P.TriageMarks; policy: P.TriagePolicyView } };
    };
    const page = await board();
    expect(page.items.map((i) => i.id)).toEqual([w.mid('<sam-r@x>')]);
    expect(page.items[0]).toMatchObject({ kind: 'mail', from: { email: SAM.email }, unread: true, triage: { decision: 'digest', score: 0.8 } });
    expect(page.items[0].triage.marks).toBeUndefined();
    const v = await vote({ less: true });
    expect(v.json.marks).toEqual({ less: true });
    expect(v.json.policy.votes).toBe(1);
    expect(v.json.policy.thresholds).toEqual({ alert: 0.5, important: 0.6 });
    // The board shows the mark; the decision is the one that was made.
    expect((await board()).items[0].triage).toMatchObject({ decision: 'digest', marks: { less: true } });
    expect((await vote({ less: false })).json).toMatchObject({ marks: {}, policy: { votes: 0 } });
    expect(w.row('<sam-r@x>')!.feedback).toBeNull();
    // An app from before the tiers: its vote down is "less like this".
    expect((await vote({ vote: 'down' })).json.marks).toEqual({ less: true });
    // Anything else is refused: a vote up, a level, an alert mark alone.
    for (const body of [{ vote: 'up' }, { vote: 'sideways' }, { level: 'push' }, { alert: true }, {}]) expect((await vote(body)).status).toBe(400);
    expect((await route('POST', `/api/mail/triage/${w.mid('<nobody@x>')}/vote`, { less: true }))!.status).toBe(409);
    // A message the server lost keeps its mark (it is learned from); one without a mark goes.
    await w.arrive({ messageId: '<sam-gone@x>' });
    w.hub.emit('deleted', { accountId: ACC, messageIds: [w.mid('<sam-r@x>'), w.mid('<sam-gone@x>')] });
    expect(w.row('<sam-r@x>')).not.toBeNull();
    expect(w.row('<sam-gone@x>')).toBeNull();
    expect(w.votes.examples().filter((e) => e.vote)).toHaveLength(1);
  });
});

describe('decisions from before the tiers', () => {
  test('moved once when mail’s triage is connected: Important and Active to the list, Digest below it, each keeping what it was', async () => {
    const at = Date.now() - 2 * DAY;
    const w = await world((put) => {
      for (const [id, from] of [['<o-push@x>', SAM], ['<o-quiet@x>', JO], ['<o-digest@x>', THEO], ['<o-drop@x>', { name: 'Kit', email: 'kit@example.org' }], ['<o-silent@x>', { name: 'Lee', email: 'lee@example.org' }], ['<o-up@x>', { name: 'Max', email: 'max@example.org' }], ['<o-down@x>', { name: 'Noa', email: 'noa@example.org' }], ['<o-new@x>', { name: 'Oli', email: 'oli@example.org' }]] as const)
        put({ messageId: id, from: [from], to: [ME], subject: `About ${id}`, receivedAt: at });
    }, true);
    const tiersAt = w.chat.tiersAt();
    expect(tiersAt).toBeGreaterThan(0);
    // As a hub before the tiers left them: its levels, its facts (no `notify` yet), three chances, a vote up and a vote down.
    const factsOf = (messageId: string, base: string) => ({ network: 'email', shape: 'mail', conversation: w.tid(messageId), spaces: [ACC], author: `idn_${messageId}`, bot: false, mention: true, everyone: false, reply: false, question: false, urgent: false, active: false, media: false, base, score: 0.35 });
    const old = (messageId: string, decision: string, level: string | null, feedback: string | null = null, createdAt = tiersAt - DAY) =>
      w.chat.db
        .query(`INSERT INTO mail_triage (message_id, thread_id, account_id, address, decision, level, score, reasons, decided_by, facts, words, probs, delivered, feedback, feedback_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0.5, '[]', 'rules', ?, '[]', ?, 0, ?, ?, ?)`)
        .run(w.mid(messageId), w.tid(messageId), ACC, 'someone@example.org', decision, level, JSON.stringify(factsOf(messageId, decision)), JSON.stringify({ ping: 0.9, active: 0.9, interesting: 0.9 }), feedback, feedback ? createdAt : null, createdAt);
    old('<o-push@x>', 'push', 'push');
    old('<o-quiet@x>', 'quiet', 'quiet');
    old('<o-digest@x>', 'digest', 'digest');
    old('<o-drop@x>', 'drop', 'drop');
    old('<o-silent@x>', 'silent', null);
    old('<o-up@x>', 'digest', 'digest', 'quiet');
    old('<o-down@x>', 'push', 'push', 'digest');
    // Decided since the tiers: not one of the old ones, whatever it looks like.
    old('<o-new@x>', 'digest', 'digest', null, tiersAt + 1000);
    const rows = () => Object.fromEntries(w.chat.raw<Record<string, any>>('SELECT message_id, decision, level, was, feedback FROM mail_triage').map((r) => [r.message_id, [r.decision, r.level, r.was, r.feedback]]));
    w.connect();
    const moved = {
      [w.mid('<o-push@x>')]: ['digest', 'digest', 'push', null],
      [w.mid('<o-quiet@x>')]: ['digest', 'digest', 'quiet', null],
      [w.mid('<o-digest@x>')]: ['drop', 'drop', 'digest', null],
      [w.mid('<o-drop@x>')]: ['drop', 'drop', 'drop', null],
      [w.mid('<o-silent@x>')]: ['silent', null, null, null],
      [w.mid('<o-up@x>')]: ['drop', 'drop', 'digest', 'quiet'],
      [w.mid('<o-down@x>')]: ['digest', 'digest', 'push', 'digest'],
      [w.mid('<o-new@x>')]: ['digest', 'digest', null, null],
    };
    expect(rows()).toEqual(moved);
    // Once: connected again (a restart), what was moved is not moved a second time.
    w.mt.connect({ store: w.chat, triage: w.triage });
    expect(rows()).toEqual(moved);
    // The inbox reads them as it reads new ones; an old vote up still lets a stranger in, one down keeps one out.
    expect(w.mt.rated(w.tid('<o-push@x>'))).toBe(true);
    expect(w.mt.rated(w.tid('<o-quiet@x>'))).toBe(true);
    expect(w.mt.rated(w.tid('<o-digest@x>'))).toBe(false);
    expect(w.mt.rated(w.tid('<o-up@x>'))).toBe(true);
    expect(w.mt.rated(w.tid('<o-down@x>'))).toBe(false);
    // The three chances it kept are not the two the app reads; the old vote is history, not a mark.
    const item = w.mt.items(0).find((i) => i.id === w.mid('<o-up@x>'))!;
    expect(item.triage).toMatchObject({ decision: 'drop', feedback: 'quiet', probs: null });
    expect(item.triage.marks).toBeUndefined();
    // The old votes still teach importance, at half a mark's weight; a mark made since counts in full.
    w.votes.mark(w.mid('<o-new@x>'), { less: true });
    const ex = new Map(w.votes.examples().filter((e) => e.vote).map((e) => [e.facts.conversation, e]));
    expect([...ex.keys()].sort()).toEqual([w.tid('<o-up@x>'), w.tid('<o-down@x>'), w.tid('<o-new@x>')].sort());
    expect(ex.get(w.tid('<o-up@x>'))).toMatchObject({ label: 'quiet', vote: true });
    expect(ex.get(w.tid('<o-down@x>'))).toMatchObject({ label: 'digest', vote: true });
    expect(ex.get(w.tid('<o-up@x>'))!.weight).toBeCloseTo(OLD_VOTE * voteWeight(tiersAt - DAY, Date.now()), 3);
    expect(ex.get(w.tid('<o-new@x>'))).toMatchObject({ label: 'drop' });
    expect(ex.get(w.tid('<o-new@x>'))!.weight).toBeGreaterThan(0.99);
  });
});
