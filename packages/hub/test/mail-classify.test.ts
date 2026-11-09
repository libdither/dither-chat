/**
 * "From a person" (mail/classify.ts, docs/mail-design.md §4): each rule on its own, the order they go in, a thread's
 * class from its messages', and in a hub on FakeMailBackend: the classes ingest gives, People and Updates, writing to
 * someone reaching their other mail, a merge, and your overrides.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId, mailId } from '@dither-chat/protocol/ids';
import { classify, mailClassifier, threadClass, type ClassifyFacts } from '../src/mail/classify.ts';
import { FakeMailBackend } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople } from '../src/mail/people.ts';
import { Store } from '../src/store.ts';

// ------------------------------------------------------------------ the rules, pure

const base: ClassifyFacts = {
  addressed: 'to',
  fromAddr: 'sam@rivera.example',
  recipients: 1,
  bulk: null,
  labels: [],
  inJunk: false,
  threadMine: false,
  threadOverride: null,
  senderOverride: null,
  sender: () => ({ wroteTo: 0, tookPart: false, chat: false, known: false }),
};
const of = (o: Partial<ClassifyFacts>) => classify({ ...base, ...o });
const LIST = { listId: '<weekly.example>', unsubscribe: null, precedence: null, autoSubmitted: null };
const KNOWN = () => ({ wroteTo: 2, tookPart: false, chat: false, known: true });

describe('each rule', () => {
  test.each([
    ['1 thread override', { threadOverride: 'bulk' as const }, 'bulk', 'thread'],
    ['1 sender override', { senderOverride: 'personal' as const, bulk: LIST }, 'personal', 'sender'],
    ['2 from you', { addressed: 'self' as const }, 'self', 'self'],
    ['3 the thread holds one of yours', { threadMine: true }, 'personal', 'mine'],
    ['4 you wrote to them', { sender: KNOWN }, 'personal', 'wrote'],
    ['4 they wrote in a thread you took part in', { sender: () => ({ wroteTo: 0, tookPart: true, chat: false, known: true }) }, 'personal', 'wrote'],
    ['5 their person has a chat identity', { sender: () => ({ wroteTo: 0, tookPart: false, chat: true, known: true }) }, 'personal', 'merged'],
    ['5 their person writes from another address of theirs', { sender: () => ({ wroteTo: 0, tookPart: false, chat: false, known: true }) }, 'personal', 'merged'],
    ['6 in Junk', { inJunk: true }, 'bulk', 'junk'],
    ['7 List-Id', { bulk: LIST }, 'bulk', 'list'],
    ['7 List-Unsubscribe', { bulk: { ...LIST, listId: null, unsubscribe: '<mailto:leave@x>' } }, 'bulk', 'list'],
    ['7 Precedence: bulk', { bulk: { ...LIST, listId: null, precedence: ' Bulk ' } }, 'bulk', 'list'],
    ['7 Auto-Submitted', { bulk: { ...LIST, listId: null, autoSubmitted: 'auto-generated' } }, 'bulk', 'list'],
    ['8 a Gmail category', { labels: ['\\Inbox', 'CATEGORY_PROMOTIONS'] }, 'bulk', 'category'],
    ['8 the same, spelled another way', { labels: ['Category/Social'] }, 'bulk', 'category'],
    ['8 Proton’s newsletters', { labels: ['Category/Newsletters'] }, 'bulk', 'category'],
    ['8 Proton’s transactions: receipts and sign-in codes', { labels: ['Category/Transactions'] }, 'bulk', 'category'],
    ['9 no-reply', { fromAddr: 'no-reply@shop.example' }, 'bulk', 'automated'],
    ['9 notifications+tag', { fromAddr: 'notifications+abc@github.example' }, 'bulk', 'automated'],
    ['9 mailer-daemon', { fromAddr: 'MAILER-DAEMON@mx.example' }, 'bulk', 'automated'],
    ['10 a crowd, you hidden', { recipients: 14, addressed: 'hidden' as const }, 'bulk', 'crowd'],
    ['11 anyone else', {}, 'personal', 'unknown'],
  ])('%s', (_name, facts, cls, why) => {
    expect(of(facts as Partial<ClassifyFacts>)).toEqual({ class: cls as any, why: why as any });
  });

  test('what is not quite a rule', () => {
    // Auto-Submitted: no means a person sent it; Precedence: first-class is not a list.
    expect(of({ bulk: { ...LIST, listId: null, autoSubmitted: 'no' } }).why).toBe('unknown');
    expect(of({ bulk: { ...LIST, listId: null, precedence: 'first-class' } }).why).toBe('unknown');
    // A label of your own named Updates, a person called Newton, a crowd you are in To of.
    expect(of({ labels: ['Updates'] }).why).toBe('unknown');
    expect(of({ fromAddr: 'newton@physics.example' }).why).toBe('unknown');
    expect(of({ fromAddr: 'alertson@x.example' }).why).toBe('unknown');
    expect(of({ recipients: 30 }).why).toBe('unknown');
  });
});

describe('the order', () => {
  test('a person comes before every bulk rule: the newsletter author you write to, a list mail in your own thread', () => {
    expect(of({ sender: KNOWN, bulk: LIST, fromAddr: 'news@rust.example', labels: ['CATEGORY_UPDATES'] }).why).toBe('wrote');
    expect(of({ threadMine: true, bulk: LIST, inJunk: true }).why).toBe('mine');
  });
  test('the sender is asked only when the rules before it did not decide', () => {
    let asked = 0;
    const sender = () => (asked++, KNOWN());
    of({ threadMine: true, sender });
    of({ addressed: 'self', sender });
    of({ threadOverride: 'bulk', sender });
    expect(asked).toBe(0);
    of({ sender });
    expect(asked).toBe(1);
  });
  test('overrides come first, the thread before the sender; your own mail is never a sender override', () => {
    expect(of({ threadOverride: 'personal', senderOverride: 'bulk', bulk: LIST })).toEqual({ class: 'personal', why: 'thread' });
    expect(of({ senderOverride: 'bulk', sender: KNOWN, threadMine: true })).toEqual({ class: 'bulk', why: 'sender' });
    expect(of({ addressed: 'self', senderOverride: 'bulk' })).toEqual({ class: 'self', why: 'self' });
    expect(of({ addressed: 'self', threadOverride: 'bulk' })).toEqual({ class: 'bulk', why: 'thread' });
  });
  test('junk comes before list headers, and those before the address', () => {
    expect(of({ inJunk: true, bulk: LIST, fromAddr: 'no-reply@x.example' }).why).toBe('junk');
    expect(of({ bulk: LIST, fromAddr: 'no-reply@x.example' }).why).toBe('list');
  });
});

describe('a thread', () => {
  const p = (why: any) => ({ class: 'personal' as const, why });
  test('personal if any message is; unknown when only rule 11 says so; else bulk; else yours', () => {
    expect(threadClass([{ class: 'bulk', why: 'list' }, p('unknown')])).toEqual({ class: 'personal', unknown: true });
    expect(threadClass([p('unknown'), p('wrote')])).toEqual({ class: 'personal', unknown: false });
    expect(threadClass([{ class: 'self', why: 'self' }, { class: 'bulk', why: 'list' }])).toEqual({ class: 'bulk', unknown: false });
    expect(threadClass([{ class: 'self', why: 'self' }])).toEqual({ class: 'self', unknown: false });
  });
});

// ------------------------------------------------------------------ in a hub

const ACC = 'acc_classifyTest1';
const ME = { name: 'Me', email: 'me@example.com' };
const SAM = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const THEO = { name: 'Theo', email: 'theo@example.net' };
const NEWS = { name: 'Rust Weekly', email: 'editor@rust-weekly.example' };
const GH = { name: 'GitHub', email: 'notifications@github.example' };
const T0 = Date.UTC(2026, 10, 1, 12);
const H = 3_600_000;

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

const tid = (h: MailHub, messageId: string) => h.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', mailId('mml', ACC, `m:${messageId}`))!.thread_id;
const why = (h: MailHub, messageId: string) => h.store.one<{ class: string; class_why: string }>('SELECT class, class_why FROM mail_message WHERE id = ?', mailId('mml', ACC, `m:${messageId}`));

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-classify-'));
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const signal = chat.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
  chat.ingest(signal, { t: 'identity', identity: { nativeId: '+15550100', displayName: 'Lee', contact: true } });
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name });
  const put = (o: Parameters<FakeMailBackend['put']>[1]) => fake.put(ACC, { flags: { seen: true }, ...o });
  // Sam: you wrote first; Sam answered.
  put({ mailboxId: 'Sent', messageId: '<s1@x>', from: [ME], to: [SAM], subject: 'Dinner?', receivedAt: T0 });
  put({ messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'], from: [SAM], to: [ME], subject: 'Re: Dinner?', receivedAt: T0 + H });
  // Theo: two threads, never answered.
  put({ messageId: '<t1@x>', from: [THEO], to: [ME], subject: 'Climbing on Sunday', receivedAt: T0 + 2 * H });
  put({ messageId: '<t2@x>', from: [THEO], to: [ME], subject: 'Photos', receivedAt: T0 + 3 * H });
  // A newsletter, a notification, a Gmail promotion, a crowd you are Bcc'd on.
  put({ messageId: '<n1@x>', from: [NEWS], to: [ME], subject: 'Issue 600', receivedAt: T0 + 4 * H, bulk: { listId: '<rust-weekly.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null } });
  put({ messageId: '<g1@x>', from: [GH], to: [ME], subject: 'CI passed', receivedAt: T0 + 5 * H });
  put({ messageId: '<p1@x>', from: [{ name: 'Shop', email: 'deals@shop.example' }], to: [ME], subject: '20% off', receivedAt: T0 + 6 * H, labels: ['CATEGORY_PROMOTIONS'] });
  put({ messageId: '<c1@x>', from: [{ name: 'Club', email: 'chair@club.example' }], to: Array.from({ length: 12 }, (_, i) => ({ name: null, email: `m${i}@club.example` })), subject: 'AGM', receivedAt: T0 + 7 * H });
  // Lee writes by mail; Lee is also on Signal (merged later).
  put({ messageId: '<l1@x>', from: [{ name: 'Lee', email: 'lee@example.org' }], to: [ME], subject: 'hey', receivedAt: T0 + 8 * H, bulk: { listId: null, unsubscribe: '<mailto:x@y>', precedence: null, autoSubmitted: null } });
  const hub = new MailHub({ db: chat.db, backend: fake, log: () => {} });
  mailPeople(hub)!.connect(chat);
  mailClassifier(hub)!.connect(chat);
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  await Bun.sleep(20);
  const route = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://hub${path}`);
    return hub.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url);
  };
  cleanup = () => {
    mailPeople(hub)?.stop();
    hub.stop();
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { chat, fake, hub, route, signal };
}

const subjects = (h: MailHub, key: string) => h.store.listThreads(key, null, 50)!.threads.map((t) => t.subject);

describe('in a hub', () => {
  test('ingest classifies each message, and the thread with it', async () => {
    const { hub } = await world();
    expect(why(hub, '<s1@x>')).toEqual({ class: 'self', class_why: 'self' });
    expect(why(hub, '<s2@x>')).toEqual({ class: 'personal', class_why: 'mine' });
    expect(why(hub, '<t1@x>')).toEqual({ class: 'personal', class_why: 'unknown' });
    expect(why(hub, '<n1@x>')).toEqual({ class: 'bulk', class_why: 'list' });
    expect(why(hub, '<g1@x>')).toEqual({ class: 'bulk', class_why: 'automated' });
    expect(why(hub, '<p1@x>')).toEqual({ class: 'bulk', class_why: 'category' });
    expect(why(hub, '<c1@x>')).toEqual({ class: 'bulk', class_why: 'crowd' });
    const sam = hub.store.threadView(hub.store.thread(tid(hub, '<s1@x>'))!);
    expect(sam).toMatchObject({ class: 'personal', unknown: false });
    expect(hub.store.threadView(hub.store.thread(tid(hub, '<t1@x>'))!)).toMatchObject({ class: 'personal', unknown: true });
  });

  test('Inbox leaves bulk out; People and Updates split it', async () => {
    const { hub } = await world();
    expect(subjects(hub, 'v:inbox:*')).toEqual(['Photos', 'Climbing on Sunday', 'Re: Dinner?']);
    expect(subjects(hub, 'v:people:*')).toEqual(['Photos', 'Climbing on Sunday', 'Re: Dinner?']);
    expect(subjects(hub, 'v:updates:*')).toEqual(['hey', 'AGM', '20% off', 'CI passed', 'Issue 600']);
    expect(subjects(hub, `v:updates:${ACC}`)).toHaveLength(5);
  });

  test('writing to someone makes the rest of their mail from a person, a moment later', async () => {
    const { fake, hub } = await world();
    fake.deliver(ACC, { mailboxId: 'INBOX', messageId: '<t3@x>', inReplyTo: '<t1@x>', references: ['<t1@x>'], from: [ME], to: [THEO], subject: 'Re: Climbing on Sunday', receivedAt: T0 + 10 * H, flags: { seen: true } });
    await until(() => why(hub, '<t1@x>')?.class_why === 'mine', 3000, 'the answered thread');
    // His other thread: rule 4 now, not rule 11; no longer unknown.
    await until(() => why(hub, '<t2@x>')?.class_why === 'wrote', 3000, 'his other thread');
    expect(hub.store.threadView(hub.store.thread(tid(hub, '<t2@x>'))!).unknown).toBe(false);
  });

  test('a merge with a chat identity makes them a person you know (rule 5), list headers or not', async () => {
    const { chat, hub } = await world();
    expect(why(hub, '<l1@x>')!.class_why).toBe('list');
    const leeMail = chat.emailIdentity('lee@example.org', 'Lee');
    chat.ensurePerson(leeMail);
    const leeSignal = hubId('idn', 'signal', '+15550100');
    chat.ensurePerson(leeSignal);
    const p = (id: string) => chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', id)!.person_id;
    chat.mergePersons(p(leeSignal), p(leeMail));
    await until(() => why(hub, '<l1@x>')?.class_why === 'merged', 3000, 'Lee by mail, now known');
    expect(subjects(hub, 'v:people:*')).toContain('hey');
  });

  test('"Not a person" sends the thread and the sender to Updates; "This is a person" brings them back; null lets the rules decide', async () => {
    const { hub, route } = await world();
    const t1 = tid(hub, '<t1@x>');
    const off = await route('PUT', `/api/mail/threads/${t1}/person`, { person: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as any).sender).toBe(THEO.email);
    expect(why(hub, '<t1@x>')).toEqual({ class: 'bulk', class_why: 'thread' });
    // The sender's other thread goes too.
    expect(why(hub, '<t2@x>')).toEqual({ class: 'bulk', class_why: 'sender' });
    expect(subjects(hub, 'v:updates:*')).toEqual(expect.arrayContaining(['Climbing on Sunday', 'Photos']));
    expect(subjects(hub, 'v:inbox:*')).toEqual(['Re: Dinner?']);
    // A person after all: the thread override goes, the sender's says person.
    await route('PUT', `/api/mail/threads/${t1}/person`, { person: true });
    expect(why(hub, '<t1@x>')).toEqual({ class: 'personal', class_why: 'sender' });
    expect(hub.store.threadView(hub.store.thread(t1)!).unknown).toBe(false);
    await route('PUT', `/api/mail/threads/${t1}/person`, { person: null });
    expect(why(hub, '<t1@x>')).toEqual({ class: 'personal', class_why: 'unknown' });
    expect((await route('PUT', `/api/mail/threads/${t1}/person`, { person: 'maybe' }))!.status).toBe(400);
    expect((await route('PUT', '/api/mail/threads/mth_nope/person', { person: false }))!.status).toBe(404);
  });

  test('a sender override by address: a newsletter you want with your people', async () => {
    const { hub, route } = await world();
    const r = await route('PUT', `/api/mail/senders/${encodeURIComponent('Editor@Rust-Weekly.example')}`, { override: 'person' });
    expect(r!.status).toBe(200);
    expect(why(hub, '<n1@x>')).toEqual({ class: 'personal', class_why: 'sender' });
    expect(subjects(hub, 'v:people:*')).toContain('Issue 600');
    await route('PUT', `/api/mail/senders/${encodeURIComponent(NEWS.email)}`, { override: null });
    expect(why(hub, '<n1@x>')).toEqual({ class: 'bulk', class_why: 'list' });
    expect((await route('PUT', '/api/mail/senders/nobody', { override: 'bulk' }))!.status).toBe(400);
    expect((await route('PUT', `/api/mail/senders/${NEWS.email}`, { override: 'sometimes' }))!.status).toBe(400);
  });

  test('a sender classed personal by rule 11 gets an identity (slice 6), a bulk one never does', async () => {
    const { chat } = await world();
    expect(chat.one('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'email', THEO.email))).toEqual({ person_id: null });
    expect(chat.one('SELECT 1 FROM identity WHERE id = ?', hubId('idn', 'email', NEWS.email))).toBeNull();
    expect(chat.one('SELECT 1 FROM identity WHERE id = ?', hubId('idn', 'email', GH.email))).toBeNull();
  });
});
