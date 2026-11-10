/**
 * A Gmail account (docs/mail.md "Gmail") on FakeMailBackend's Gmail mode, which sends what dither-accounts' imap
 * extractor sends for one: a message in Inbox, All Mail and a label at once, with an id in each; labels as X-GM-LABELS
 * gives them; threads by X-GM-THRID; X-GM-MSGID as `emailId`; All Mail and no Archive; Important's role; CONDSTORE;
 * Gmail's MOVE, and the extractor's COPY out of All Mail; X-GM-RAW search; and the copy in Sent left to Gmail. Checked:
 * the first sync and the backfill keep one message (by Message-ID, or by emailId without one), a thread groups by
 * Gmail's thread, labels read the same from any mailbox and show as mailboxes, Important is a view, archive and Undo
 * before and after it went, Move to Inbox or a label from All Mail alone, trash, junk, star and read, changes made in
 * Gmail itself, search on the server in Gmail's syntax, a reply that shows once when Gmail's Sent copy comes, and list
 * mail classified by its headers.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { mailboxList } from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { mailClassifier } from '../src/mail/classify.ts';
import { FakeMailBackend, GMAIL, gmailBoxId } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailOps } from '../src/mail/ops.ts';
import { mailPeople } from '../src/mail/people.ts';
import { mailSearchOf } from '../src/mail/search.ts';
import { Store } from '../src/store.ts';
import { FakeClock } from './fixtures/clock.ts';

const ACC = 'acc_gmailTest01';
// A Workspace address: the hub knows the account is Gmail by its `[Gmail]` mailboxes.
const ME = { name: 'Me', email: 'me@workspace.example' };
const sam = { name: 'Sam Lee', email: 'sam@lee.example' };
const jo = { name: 'Jo Park', email: 'jo@park.example' };
const alex = { name: 'Alex', email: 'alex@north.example' };
const news = { name: 'Weekly News', email: 'editor@news.example' };
const H = 3_600_000;
const D = 24 * H;
const WORK = gmailBoxId('Work');

/** Each test's clock (world() makes one): the writer's pacing, the budget and the fake server's answers run on it. */
let clock = new FakeClock();
const until = (f: () => unknown, ms = 4000, what = 'condition') => clock.until(f, ms, what);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/**
 * Sam asks (Inbox, labelled Work and Important), you answer (Sent), Sam writes back (unread); a starred note from
 * Alex; a newsletter; an old message from Jo you archived; one from two years ago, past what the hub lists.
 */
function seed(f: FakeMailBackend, now = Date.now()) {
  f.put(ACC, { messageId: '<s1@x>', from: [sam], to: [ME], subject: 'Dinner on Friday?', receivedAt: now - 3 * H, labels: ['Work', '\\Important'], flags: { seen: true }, text: 'Are you free after 7?' });
  f.put(ACC, { mailboxId: GMAIL.sent, messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'], from: [ME], to: [sam], subject: 'Re: Dinner on Friday?', receivedAt: now - 2 * H, flags: { seen: true }, text: 'Yes, 7:30 works.' });
  f.put(ACC, { messageId: '<s3@x>', inReplyTo: '<s2@x>', references: ['<s1@x>', '<s2@x>'], from: [sam], to: [ME], subject: 'Re: Dinner on Friday?', receivedAt: now - H, text: 'Booked for 7:30.' });
  f.put(ACC, { messageId: '<a1@x>', from: [alex], to: [ME], subject: 'Tickets', receivedAt: now - 5 * H, flags: { seen: true, flagged: true }, text: 'Two for Saturday.' });
  f.put(ACC, {
    messageId: '<n1@x>',
    from: [news],
    to: [ME],
    subject: 'Weekly 12',
    receivedAt: now - 4 * H,
    bulk: { listId: '<weekly.news.example>', unsubscribe: '<https://news.example/leave>', precedence: 'bulk', autoSubmitted: null },
    text: 'This week in news.',
  });
  f.put(ACC, { mailboxId: GMAIL.all, messageId: '<j1@x>', from: [jo], to: [ME], subject: 'Old photos', receivedAt: now - 30 * D, flags: { seen: true }, labels: ['Work'], text: 'From the lake.' });
  f.put(ACC, { mailboxId: GMAIL.all, messageId: '<r1@x>', from: [{ name: 'Maple Hardware', email: 'orders@maple.example' }], to: [ME], subject: 'Your receipt', receivedAt: now - 730 * D, flags: { seen: true }, text: 'Keep this as your warranty.' });
}

interface World {
  fake: FakeMailBackend;
  hub: MailHub;
  chat: Store;
}

async function world(o: { classify?: boolean } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-gmail-'));
  clock = new FakeClock();
  const fake = new FakeMailBackend();
  fake.clock = clock;
  fake.addAccount(ACC, { email: ME.email, name: ME.name, opts: { ids: 'gmail' } });
  seed(fake, clock.now());
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const hub = new MailHub({ db: o.classify ? chat.db : new Database(':memory:', { strict: true }), backend: fake, log: () => {}, dataDir: dir, holdMs: 20, clock });
  if (o.classify) {
    mailPeople(hub)!.connect(chat);
    mailClassifier(hub)!.connect(chat);
  }
  const ops = mailOps(hub);
  ops.coalesceMs = 0;
  ops.pollMs = 20;
  ops.gmailArchiveHoldMs = 0;
  hub.start();
  cleanup.push(() => {
    mailPeople(hub)?.stop();
    hub.stop();
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await clock.wait(hub.sync(ACC)!.whenSynced());
  return { fake, hub, chat };
}

/** The backfill has listed what it lists (All Mail back a year, here). */
const backfilled = (w: World) => until(() => w.hub.sync(ACC)!.backfill.legs().length === 0 && !w.hub.sync(ACC)!.backfill.running, 15_000, 'the backfill');
const mid = (hdr: string) => mailId('mml', ACC, `m:${hdr}`);
const box = (w: World, native: string) => w.hub.store.mailboxByNative(ACC, native)!;
/** Where the hub has a message: the server's mailbox ids, sorted. */
const where = (w: World, hdr: string) =>
  w.hub.store
    .all<{ native_id: string }>('SELECT b.native_id FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ? ORDER BY b.native_id', mid(hdr))
    .map((r) => r.native_id);
/** Where the server has it. */
const onServer = (w: World, hdr: string) =>
  w.fake
    .messages(ACC)
    .filter((m) => m.messageId === hdr)
    .map((m) => m.mailboxId)
    .sort();
const copy = (w: World, hdr: string, mailbox: string) => w.fake.messages(ACC, mailbox).find((m) => m.messageId === hdr)!;
const threadOf = (w: World, hdr: string) => w.hub.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', mid(hdr))!.thread_id;
const view = (w: World, hdr: string) => w.hub.store.threadView(w.hub.store.thread(threadOf(w, hdr))!);
const rows = (w: World) => w.hub.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE account_id = ?', ACC)!.n;
const subjects = (w: World, key: string) => w.hub.store.listThreads(key, null, 100)!.threads.map((t) => t.subject);
const route = (w: World, method: string, path: string) => {
  const url = new URL(`http://hub${path}`);
  return clock.wait(w.hub.route(new Request(url, { method }), url));
};

describe('the first sync and the backfill', () => {
  test('one message in Inbox, All Mail and a label is one message here, wherever it was listed from', async () => {
    const w = await world();
    // The first sync lists Inbox and Sent: Sam's first message is there and in All Mail, Work and Important too.
    expect(onServer(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, GMAIL.important, WORK].sort());
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox]);
    await backfilled(w);
    // All Mail's listing adds a place, not a message.
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    expect(where(w, '<s2@x>')).toEqual([GMAIL.sent, GMAIL.all].sort());
    expect(where(w, '<j1@x>')).toEqual([GMAIL.all]);
    // Past the year the hub lists: only a search of the server finds it.
    expect(where(w, '<r1@x>')).toEqual([]);
    expect(rows(w)).toBe(6);
    // A label opened in the page: listed, one more place for the same message.
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, WORK].sort());
    expect(where(w, '<j1@x>')).toEqual([GMAIL.all, WORK].sort());
    expect(rows(w)).toBe(6);
    // A changes pass on every mailbox the hub follows adds nothing.
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(rows(w)).toBe(6);
    expect(w.hub.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_location WHERE message_id = ?', mid('<s1@x>'))!.n).toBe(3);
  });

  test('a thread is Gmail\'s thread (X-GM-THRID), even for a message whose headers name no other', async () => {
    const w = await world();
    const thrid = copy(w, '<s1@x>', GMAIL.inbox).threadId!;
    expect(copy(w, '<s3@x>', GMAIL.inbox).threadId).toBe(thrid);
    w.fake.deliver(ACC, { messageId: '<s4@x>', from: [sam], to: [ME], subject: 'Re: Dinner on Friday?', threadId: thrid, text: 'Parking is behind.' });
    await until(() => w.hub.store.one('SELECT 1 FROM mail_message WHERE id = ?', mid('<s4@x>')), 4000, 'the new message');
    const t = view(w, '<s1@x>');
    expect(threadOf(w, '<s4@x>')).toBe(t.id);
    expect(t.count).toBe(4);
    expect(w.hub.store.all<{ thread_by: string }>('SELECT thread_by FROM mail_message WHERE thread_id = ?', t.id).map((r) => r.thread_by)).toEqual(['native', 'native', 'native', 'native']);
    expect(t.id).toBe(mailId('mth', ACC, `n:${thrid}`));
  });
});

describe('labels', () => {
  test('a thread shows its own labels, not Gmail\'s system ones, and they read the same from any mailbox', async () => {
    const w = await world();
    // As the extractor gives them: from Inbox, Gmail leaves \Inbox out; from Work, Work.
    expect(copy(w, '<s1@x>', GMAIL.inbox).labels).toEqual([]);
    expect((await clock.wait(w.fake.call<{ messages: { labels: string[] }[] }>(ACC, 'mail.list', { mailboxId: WORK }))).messages.map((m) => m.labels)).toEqual([['\\Important', '\\Inbox'], []]);
    expect(view(w, '<s1@x>').labels).toEqual(['Work']);
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    // Listed from Work last: still Work.
    expect(view(w, '<s1@x>').labels).toEqual(['Work']);
    expect(view(w, '<j1@x>').labels).toEqual(['Work']);
    const msgs = w.hub.store.messageViews(threadOf(w, '<s1@x>'));
    expect(msgs.map((m) => m.labels)).toEqual([['Work'], [], []]);
    // Alex's starred note: the star is a flag here, not a label.
    expect(view(w, '<a1@x>')).toMatchObject({ flagged: true, labels: [] });
  });

  test('a label is a mailbox: in the list, and opened as one; `[Gmail]` holds only mailboxes and is never followed', async () => {
    const w = await world();
    const r = (await (await route(w, 'GET', '/api/mail'))!.json()) as { mailboxes: P.MailboxView[] };
    const boxes = r.mailboxes.filter((b) => b.accountId === ACC);
    expect(boxes.find((b) => b.path === 'Work')).toMatchObject({ name: 'Work', role: null, followed: false });
    expect(boxes.find((b) => b.path === '[Gmail]/All Mail')).toMatchObject({ role: 'all', followed: true });
    expect(boxes.some((b) => b.role === 'archive')).toBe(false);
    const list = async (native: string) => (await (await route(w, 'GET', `/api/mail/threads?list=${encodeURIComponent(mailboxList(box(w, native).id))}`))!.json()) as P.MailThreadPage;
    expect((await list(WORK)).threads.map((t) => t.subject)).toEqual(['Re: Dinner on Friday?', 'Old photos']);
    // `[Gmail]` cannot be listed (IMAP \Noselect: 404): its list is empty, and it is not kept up afterwards.
    expect((await list(GMAIL.parent)).threads).toEqual([]);
    expect(box(w, GMAIL.parent).follow).toBeNull();
    const before = w.fake.calls.filter((c) => c.input.mailboxId === GMAIL.parent).length;
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(w.fake.calls.filter((c) => c.input.mailboxId === GMAIL.parent).length).toBe(before);
  });
});

describe('filing', () => {
  test('archive takes it out of Inbox; it stays in All Mail and its label, one row there, no new message', async () => {
    const w = await world();
    await backfilled(w);
    const allIds = new Map(['<s1@x>', '<s3@x>'].map((h) => [h, copy(w, h, GMAIL.all).id]));
    const ops = mailOps(w.hub);
    expect(ops.move({ threadIds: [threadOf(w, '<s1@x>')], to: 'archive' })).toEqual({ ok: true, threads: 1, messages: 2 });
    expect(subjects(w, 'v:inbox:*')).not.toContain('Dinner on Friday?');
    await clock.wait(ops.idle());
    // On Gmail: MOVE from Inbox to All Mail takes \Inbox off; the label stays.
    expect(w.fake.calls.find((c) => c.op === 'mail.move')!.input.mailboxId).toBe(GMAIL.all);
    expect(onServer(w, '<s1@x>')).toEqual([GMAIL.all, GMAIL.important, WORK].sort());
    expect(onServer(w, '<s3@x>')).toEqual([GMAIL.all]);
    // The move answered the All Mail ids the hub had already: the same places, not new ones.
    for (const [h, id] of allIds) expect(copy(w, h, GMAIL.all).id).toBe(id);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual([GMAIL.all]);
    expect(where(w, '<s3@x>')).toEqual([GMAIL.all]);
    expect(w.hub.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_location WHERE mailbox_id = ?', box(w, GMAIL.all).id)!.n).toBe(6);
    expect(rows(w)).toBe(6);
    const t = view(w, '<s1@x>');
    expect(t.roles).not.toContain('inbox');
    expect(t.roles).toContain('all');
    expect(subjects(w, mailboxList(box(w, GMAIL.all).id)).filter((s) => s === 'Re: Dinner on Friday?')).toHaveLength(1);
  });

  test('Undo right after archive: held for the page\'s Undo, so nothing reaches Gmail', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    ops.gmailArchiveHoldMs = 400;
    const t = threadOf(w, '<a1@x>');
    ops.move({ threadIds: [t], to: 'archive' });
    expect(view(w, '<a1@x>').roles).not.toContain('inbox');
    await clock.advance(100);
    expect(w.fake.calls.some((c) => c.op === 'mail.move')).toBe(false);
    // The page's Undo: back to Inbox, before it went.
    ops.move({ threadIds: [t], to: 'inbox' });
    await clock.advance(500);
    await clock.wait(ops.idle());
    expect(w.fake.calls.some((c) => c.op === 'mail.move')).toBe(false);
    expect(onServer(w, '<a1@x>')).toEqual([GMAIL.inbox, GMAIL.all, GMAIL.starred].sort());
    expect(view(w, '<a1@x>')).toMatchObject({ pending: false, roles: expect.arrayContaining(['inbox']) });
    // Past the hold it goes.
    ops.move({ threadIds: [t], to: 'archive' });
    await until(() => w.fake.calls.some((c) => c.op === 'mail.move'), 3000, 'the archive');
    await clock.wait(ops.idle());
    expect(onServer(w, '<a1@x>')).toEqual([GMAIL.all, GMAIL.starred].sort());
  });

  test('Undo after the archive went: a copy from All Mail puts it back in Inbox, its labels on, no new row', async () => {
    const w = await world();
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    const ops = mailOps(w.hub);
    const t = threadOf(w, '<s1@x>');
    const allIds = ['<s1@x>', '<s3@x>'].map((h) => copy(w, h, GMAIL.all).id);
    ops.move({ threadIds: [t], to: 'archive' });
    await clock.wait(ops.idle());
    expect(onServer(w, '<s1@x>')).toEqual([GMAIL.all, GMAIL.important, WORK].sort());
    expect(where(w, '<s1@x>')).toEqual([GMAIL.all, WORK].sort());
    // The page's Undo, after the hold: back to Inbox. It shows there at once, and in All Mail still.
    expect(ops.move({ threadIds: [t], to: 'inbox' })).toEqual({ ok: true, threads: 1, messages: 2 });
    expect(view(w, '<s1@x>').roles).toEqual(expect.arrayContaining(['inbox', 'all']));
    await clock.wait(ops.idle());
    // From All Mail, so the extractor copies (a MOVE out of All Mail would delete it on Gmail): \Inbox on, Work and
    // Important stay; your reply in Sent is not touched.
    const call = w.fake.calls.filter((c) => c.op === 'mail.move').pop()!;
    expect(call.input.mailboxId).toBe(GMAIL.inbox);
    expect([...call.input.ids].sort()).toEqual([...allIds].sort());
    expect(onServer(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, GMAIL.important, WORK].sort());
    expect(onServer(w, '<s3@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    expect(onServer(w, '<s2@x>')).toEqual([GMAIL.sent, GMAIL.all].sort());
    for (const [i, h] of ['<s1@x>', '<s3@x>'].entries()) expect(copy(w, h, GMAIL.all).id).toBe(allIds[i]);
    // The hub has it where Gmail has it at once: Inbox by the copy's own id, All Mail and Work as they were.
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, WORK].sort());
    expect(w.hub.store.one('SELECT native_id FROM mail_location WHERE message_id = ? AND mailbox_id = ?', mid('<s1@x>'), box(w, GMAIL.inbox).id)).toEqual({ native_id: copy(w, '<s1@x>', GMAIL.inbox).id });
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, WORK].sort());
    expect(where(w, '<s3@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    expect(rows(w)).toBe(6);
    expect(view(w, '<s1@x>')).toMatchObject({ pending: false, labels: ['Work'] });
    expect(subjects(w, 'v:inbox:*').filter((s) => s === 'Re: Dinner on Friday?')).toHaveLength(1);
    expect(subjects(w, mailboxList(box(w, GMAIL.all).id)).filter((s) => s === 'Re: Dinner on Friday?')).toHaveLength(1);
  });

  test('Move to Inbox from All Mail alone: a copy, so it stays in All Mail and keeps its label', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    // Jo's photos: archived, labelled Work; the hub has not listed Work, so it knows only All Mail.
    expect(where(w, '<j1@x>')).toEqual([GMAIL.all]);
    const allId = copy(w, '<j1@x>', GMAIL.all).id;
    expect(ops.move({ threadIds: [threadOf(w, '<j1@x>')], to: 'inbox' })).toEqual({ ok: true, threads: 1, messages: 1 });
    expect(subjects(w, 'v:inbox:*')).toContain('Old photos');
    expect(subjects(w, mailboxList(box(w, GMAIL.all).id))).toContain('Old photos');
    await clock.wait(ops.idle());
    expect(w.fake.calls.find((c) => c.op === 'mail.move')!.input).toMatchObject({ ids: [allId], mailboxId: GMAIL.inbox });
    expect(onServer(w, '<j1@x>')).toEqual([GMAIL.inbox, GMAIL.all, WORK].sort());
    expect(copy(w, '<j1@x>', GMAIL.all).id).toBe(allId);
    expect(where(w, '<j1@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<j1@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    expect(rows(w)).toBe(6);
    expect(view(w, '<j1@x>')).toMatchObject({ pending: false, labels: ['Work'], roles: expect.arrayContaining(['inbox', 'all']) });
    expect(subjects(w, 'v:inbox:*').filter((s) => s === 'Old photos')).toHaveLength(1);
  });

  test('Move to a label from All Mail alone: a copy too, and it stays in All Mail', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    // Alex's starred note, archived: in All Mail (and Starred, which the hub has not listed).
    const t = threadOf(w, '<a1@x>');
    ops.move({ threadIds: [t], to: 'archive' });
    await clock.wait(ops.idle());
    expect(where(w, '<a1@x>')).toEqual([GMAIL.all]);
    expect(ops.move({ threadIds: [t], to: box(w, WORK).id })).toEqual({ ok: true, threads: 1, messages: 1 });
    await clock.wait(ops.idle());
    expect(w.fake.calls.filter((c) => c.op === 'mail.move').pop()!.input).toMatchObject({ ids: [copy(w, '<a1@x>', GMAIL.all).id], mailboxId: WORK });
    expect(onServer(w, '<a1@x>')).toEqual([GMAIL.all, GMAIL.starred, WORK].sort());
    expect(where(w, '<a1@x>')).toEqual([GMAIL.all, WORK].sort());
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    expect(where(w, '<a1@x>')).toEqual([GMAIL.all, WORK].sort());
    expect(view(w, '<a1@x>')).toMatchObject({ pending: false, flagged: true, labels: ['Work'] });
    expect(rows(w)).toBe(6);
  });

  test('out of All Mail into Trash is still a move: it leaves All Mail and its label', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    const allId = copy(w, '<j1@x>', GMAIL.all).id;
    ops.move({ threadIds: [threadOf(w, '<j1@x>')], to: 'trash' });
    await clock.wait(ops.idle());
    expect(w.fake.calls.find((c) => c.op === 'mail.move')!.input).toMatchObject({ ids: [allId], mailboxId: GMAIL.trash });
    expect(onServer(w, '<j1@x>')).toEqual([GMAIL.trash]);
    expect(where(w, '<j1@x>')).toEqual([GMAIL.trash]);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<j1@x>')).toEqual([GMAIL.trash]);
    expect(rows(w)).toBe(6);
  });

  test('trash takes it out of every mailbox but Trash, and leaves what you sent in Sent', async () => {
    const w = await world();
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    const ops = mailOps(w.hub);
    ops.move({ threadIds: [threadOf(w, '<s1@x>')], to: 'trash' });
    await clock.wait(ops.idle());
    // Gmail: into Trash is out of Inbox, All Mail, Work and Important at once.
    expect(onServer(w, '<s1@x>')).toEqual([GMAIL.trash]);
    expect(onServer(w, '<s3@x>')).toEqual([GMAIL.trash]);
    // Your reply was never moved: moving its All Mail copy would have taken it out of Sent too.
    expect(onServer(w, '<s2@x>')).toEqual([GMAIL.sent, GMAIL.all].sort());
    // The hub follows: Trash only, before any changes pass on All Mail.
    expect(where(w, '<s1@x>')).toEqual([GMAIL.trash]);
    expect(where(w, '<s3@x>')).toEqual([GMAIL.trash]);
    expect(subjects(w, mailboxList(box(w, WORK).id))).toEqual(['Old photos']);
    expect(w.hub.store.one<{ shut: number }>('SELECT shut FROM mail_search WHERE message_id = ?', mid('<s1@x>'))!.shut).toBe(1);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual([GMAIL.trash]);
    expect(where(w, '<s2@x>')).toEqual([GMAIL.sent, GMAIL.all].sort());
    expect(rows(w)).toBe(6);
  });

  test('junk: into Spam alone; Not junk brings it back to Inbox and All Mail', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    ops.move({ threadIds: [threadOf(w, '<n1@x>')], to: 'junk' });
    await clock.wait(ops.idle());
    expect(onServer(w, '<n1@x>')).toEqual([GMAIL.spam]);
    expect(where(w, '<n1@x>')).toEqual([GMAIL.spam]);
    expect(view(w, '<n1@x>').roles).toEqual(['junk']);
    ops.move({ threadIds: [threadOf(w, '<n1@x>')], to: 'inbox' });
    await clock.wait(ops.idle());
    expect(onServer(w, '<n1@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<n1@x>')).toEqual([GMAIL.inbox, GMAIL.all].sort());
    expect(rows(w)).toBe(6);
  });

  test('star, unstar, unread and read: on the message, in every mailbox; Starred gains and loses it', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    const t = threadOf(w, '<s1@x>');
    ops.flag({ threadIds: [t], flagged: true });
    await clock.wait(ops.idle());
    expect(copy(w, '<s3@x>', GMAIL.all).flags.flagged).toBe(true);
    expect(onServer(w, '<s3@x>')).toContain(GMAIL.starred);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<s1@x>')).toMatchObject({ flagged: true, labels: ['Work'] });
    ops.flag({ threadIds: [t], flagged: false });
    await clock.wait(ops.idle());
    expect(onServer(w, '<s3@x>')).not.toContain(GMAIL.starred);
    ops.flag({ threadIds: [t], seen: true });
    await clock.wait(ops.idle());
    expect(copy(w, '<s3@x>', GMAIL.all).flags.seen).toBe(true);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<s1@x>')).toMatchObject({ flagged: false, unread: 0 });
    ops.flag({ threadIds: [t], seen: false });
    await clock.wait(ops.idle());
    expect(copy(w, '<s3@x>', GMAIL.inbox).flags.seen).toBe(false);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<s1@x>').unread).toBe(1);
    expect(rows(w)).toBe(6);
  });

  test('changes made in Gmail itself: archived, starred, labelled, deleted', async () => {
    const w = await world();
    await backfilled(w);
    // Archived on the web: \Inbox off. Inbox's IDLE says so; All Mail keeps it.
    w.fake.label(ACC, copy(w, '<a1@x>', GMAIL.inbox).id, { remove: ['\\Inbox'] });
    await until(() => !view(w, '<a1@x>').roles.includes('inbox'), 4000, 'out of Inbox');
    expect(where(w, '<a1@x>')).toEqual([GMAIL.all]);
    // Starred on the phone, in Inbox: the flag on every copy.
    w.fake.setFlags(ACC, copy(w, '<s3@x>', GMAIL.inbox).id, { flagged: true });
    await until(() => view(w, '<s1@x>').flagged, 4000, 'starred');
    // A label added on the web: All Mail's next pass sees it (CONDSTORE: a changed message in every mailbox).
    w.fake.label(ACC, copy(w, '<n1@x>', GMAIL.inbox).id, { add: ['Reading'] });
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<n1@x>').labels).toEqual(['Reading']);
    // Deleted for good (emptied from the trash): gone here once the mailboxes it was in say so.
    w.fake.remove(ACC, copy(w, '<j1@x>', GMAIL.all).id);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(w.hub.store.one('SELECT 1 FROM mail_message WHERE id = ?', mid('<j1@x>'))).toBeNull();
    expect(rows(w)).toBe(5);
  });
});

describe('emailId', () => {
  /** A summary of the message the fake made, as `mailbox` lists it. */
  const listed = async (w: World, mailbox: string, id: string) => (await clock.wait(w.fake.call<{ messages: M.MailSummary[] }>(ACC, 'mail.list', { mailboxId: mailbox, limit: 500 }))).messages.find((s) => s.emailId === id)!;
  /** The hub's places for one message. */
  const placesOf = (w: World, messageId: string) =>
    w.hub.store.all<{ native_id: string }>('SELECT b.native_id FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ? ORDER BY b.native_id', messageId).map((r) => r.native_id);

  test('a message with no Message-ID is one message by its emailId (X-GM-MSGID), in Inbox, All Mail and a label', async () => {
    const w = await world();
    const m = w.fake.deliver(ACC, { messageId: null, from: [jo], to: [ME], subject: 'No header', labels: ['Work'], text: 'Sent by an old script.' });
    const gm = m.gm!;
    expect(w.fake.messages(ACC).filter((x) => x.gm === gm).map((x) => x.mailboxId).sort()).toEqual([GMAIL.inbox, GMAIL.all, WORK].sort());
    // Each mailbox's copy has its own id, and the same emailId.
    const copies = await Promise.all([GMAIL.inbox, GMAIL.all, WORK].map((b) => listed(w, b, gm)));
    expect(new Set(copies.map((s) => s.id)).size).toBe(3);
    expect(copies.map((s) => [s.messageId, s.emailId])).toEqual([[null, gm], [null, gm], [null, gm]]);
    await until(() => w.hub.store.one('SELECT 1 FROM mail_message WHERE email_id = ?', gm), 4000, 'the new message');
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    const ms = w.hub.store.all<{ id: string; email_id: string }>(`SELECT id, email_id FROM mail_message WHERE account_id = ? AND subject = 'No header'`, ACC);
    expect(ms).toEqual([{ id: mailId('mml', ACC, `e:${gm}`), email_id: gm }]);
    expect(placesOf(w, ms[0].id)).toEqual([GMAIL.inbox, GMAIL.all, WORK].sort());
    expect(rows(w)).toBe(7);
    // Those with a Message-ID keep their key, and have the emailId too.
    expect(w.hub.store.one('SELECT email_id FROM mail_message WHERE id = ?', mid('<s1@x>'))).toEqual({ email_id: copy(w, '<s1@x>', GMAIL.inbox).gm! });
  });

  test('a row from before emailIds came (keyed by its place) takes the emailId and stays the message', async () => {
    const w = await world();
    await backfilled(w);
    // On the server, unseen by the hub; then stored as a hub did before summaries had an emailId: by its place.
    const m = w.fake.put(ACC, { messageId: null, from: [jo], to: [ME], subject: 'No header', text: 'Sent by an old script.' });
    const inInbox = await listed(w, GMAIL.inbox, m.gm!);
    const { emailId: _gone, ...before } = inInbox;
    w.hub.store.ingest(ACC, box(w, GMAIL.inbox), [before]);
    const was = mailId('mml', ACC, `x:${GMAIL.inbox}/${m.id}`);
    expect(w.hub.store.one('SELECT email_id FROM mail_message WHERE id = ?', was)).toEqual({ email_id: null });
    // Listed again with it: the row at that place takes it; All Mail's copy finds the row by it.
    expect(w.hub.store.ingest(ACC, box(w, GMAIL.inbox), [inInbox]).added).toEqual([]);
    const fromAll = w.hub.store.ingest(ACC, box(w, GMAIL.all), [await listed(w, GMAIL.all, m.gm!)]);
    expect(fromAll).toMatchObject({ added: [], orphans: [] });
    expect(w.hub.store.one('SELECT email_id FROM mail_message WHERE id = ?', was)).toEqual({ email_id: m.gm });
    expect(placesOf(w, was)).toEqual([GMAIL.inbox, GMAIL.all].sort());
    expect(rows(w)).toBe(7);
  });

  test('without a Message-ID or an emailId, each place is a message of its own, as before', async () => {
    const w = await world();
    await backfilled(w);
    const m = w.fake.put(ACC, { messageId: null, from: [jo], to: [ME], subject: 'No header', text: 'Sent by an old script.' });
    for (const b of [GMAIL.inbox, GMAIL.all]) {
      const { emailId: _gone, ...s } = await listed(w, b, m.gm!);
      w.hub.store.ingest(ACC, box(w, b), [s]);
    }
    expect(w.hub.store.all(`SELECT id FROM mail_message WHERE account_id = ? AND subject = 'No header'`, ACC)).toHaveLength(2);
  });
});

describe('Important', () => {
  test('[Gmail]/Important has its role: a view, as Starred is, never a folder filing moves out of', async () => {
    const w = await world();
    await backfilled(w);
    const r = (await (await route(w, 'GET', '/api/mail'))!.json()) as { mailboxes: P.MailboxView[] };
    const boxes = r.mailboxes.filter((b) => b.accountId === ACC);
    expect(boxes.find((b) => b.path === '[Gmail]/Important')).toMatchObject({ role: 'important', followed: false });
    expect(boxes.find((b) => b.path === '[Gmail]/Starred')).toMatchObject({ role: 'flagged', followed: false });
    // Opened: Sam's first message is there too; still one message, its labels its own (Gmail's \Important not shown).
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, GMAIL.important).id));
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, GMAIL.important].sort());
    expect(view(w, '<s1@x>')).toMatchObject({ labels: ['Work'], roles: expect.arrayContaining(['inbox', 'all', 'important']) });
    expect(w.hub.store.one<{ labels: string }>('SELECT labels FROM mail_message WHERE id = ?', mid('<s1@x>'))!.labels).toContain('\\\\Important');
    // Archive and back to Inbox take nothing out of it: the extractor is never asked to move from Important.
    const ops = mailOps(w.hub);
    const t = threadOf(w, '<s1@x>');
    ops.move({ threadIds: [t], to: 'archive' });
    await clock.wait(ops.idle());
    ops.move({ threadIds: [t], to: 'inbox' });
    await clock.wait(ops.idle());
    expect(onServer(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, GMAIL.important, WORK].sort());
    expect(w.fake.calls.filter((c) => c.op === 'mail.move').flatMap((c) => c.input.ids as string[]).some((id) => id.startsWith(`${GMAIL.important}.`))).toBe(false);
    expect(where(w, '<s1@x>')).toEqual([GMAIL.inbox, GMAIL.all, GMAIL.important].sort());
    expect(rows(w)).toBe(6);
  });
});

describe('ids per mailbox', () => {
  test('Gmail over IMAP says nothing of its ids: per mailbox, so a move to Inbox from All Mail is a copy with an id of its own', async () => {
    const w = await world();
    const st = w.hub.store;
    expect([st.gmail(ACC), st.idPerMessage(ACC), st.gmailPerMailbox(ACC)]).toEqual([true, false, true]);
    expect(st.accountView(st.account(ACC)!)).toMatchObject({ kind: 'imap', sendCap: 35 * 1024 * 1024, maxRecipients: 500 });
    await backfilled(w);
    const ops = mailOps(w.hub);
    const allId = copy(w, '<j1@x>', GMAIL.all).id;
    ops.move({ threadIds: [threadOf(w, '<j1@x>')], to: 'inbox' });
    await clock.wait(ops.idle());
    const inboxId = copy(w, '<j1@x>', GMAIL.inbox).id;
    expect(inboxId).not.toBe(allId);
    expect(w.fake.messages(ACC).filter((m) => m.messageId === '<j1@x>')).toHaveLength(3);
    expect(st.all<{ native_id: string }>('SELECT native_id FROM mail_location WHERE message_id = ? ORDER BY native_id', mid('<j1@x>')).map((r) => r.native_id)).toEqual([allId, inboxId].sort());
  });
});

describe('search', () => {
  test('the server gets the query in Gmail\'s own syntax, in All Mail, and what only it has shows once', async () => {
    const w = await world();
    await backfilled(w);
    const s = mailSearchOf(w.hub)!;
    expect(s.serverForm(w.hub.store.account(ACC)!)).toBe('gmail');
    const page = await clock.wait(s.search('warranty from:maple', { server: true }));
    const call = w.fake.calls.filter((c) => c.op === 'mail.search').pop()!;
    expect(call.input).toMatchObject({ query: 'warranty from:maple' });
    expect(call.input.mailboxId).toBeUndefined();
    expect(page.hits).toEqual([]);
    expect(page.server!.hits.map((h) => h.thread.subject)).toEqual(['Your receipt']);
    expect(where(w, '<r1@x>')).toEqual([GMAIL.all]);
    // Gmail's operators: a label, in:, is:.
    await clock.wait(s.search('label:work is:unread', { server: true }));
    expect(w.fake.calls.filter((c) => c.op === 'mail.search').pop()!.input.query).toBe('label:work is:unread');
    const hits = (await clock.wait(w.fake.call<{ messages: { messageId: string }[] }>(ACC, 'mail.search', { query: 'label:work -in:inbox' }))).messages.map((m) => m.messageId);
    expect(hits).toEqual(['<j1@x>']);
    // Archived, in the hub's own words and on the server: on Gmail `in:archive` is All Mail but not Inbox or Sent.
    expect((await clock.wait(s.search('in:archive photos'))).hits.map((h) => h.thread.subject)).toEqual(['Old photos']);
    expect((await clock.wait(s.search('in:archive dinner'))).hits).toEqual([]);
    await clock.wait(s.search('in:archive photos', { server: true }));
    expect(w.fake.calls.filter((c) => c.op === 'mail.search').pop()!.input.query).toBe('photos -in:inbox -in:sent -in:drafts');
    expect(rows(w)).toBe(7);
  });
});

describe('sending', () => {
  test('a reply shows once when Gmail\'s own copy in Sent comes, in Sam\'s thread', async () => {
    const w = await world();
    await backfilled(w);
    const t = threadOf(w, '<s3@x>');
    const draft: P.MailDraft & { draftKey: string; clientId: string; tz: string } = {
      clientId: 'gmail-reply-1',
      draftKey: `t:${t}`,
      accountId: ACC,
      kind: 'reply',
      replyTo: mid('<s3@x>'),
      from: null,
      to: [sam],
      cc: [],
      bcc: [],
      subject: 'Re: Dinner on Friday?',
      text: 'See you there.',
      quote: false,
      files: [],
      forwardParts: [],
      tz: 'UTC',
    };
    const { outboxId } = await clock.wait(w.hub.outbox.accept(draft));
    await until(() => w.hub.outbox.item(outboxId)?.state === 'sent', 4000, 'sent');
    const sent = w.fake.sent[0];
    // Answered from Inbox's copy; nothing appended: Gmail keeps the copy, in Sent Mail and All Mail.
    expect(sent.mail.replyTo).toBe(copy(w, '<s3@x>', GMAIL.inbox).id);
    expect(onServer(w, sent.messageId)).toEqual([GMAIL.sent, GMAIL.all].sort());
    expect(copy(w, sent.messageId, GMAIL.sent).threadId).toBe(copy(w, '<s1@x>', GMAIL.inbox).threadId);
    await until(() => where(w, sent.messageId).length === 2, 4000, 'the copy in Sent and All Mail');
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(threadOf(w, sent.messageId)).toBe(t);
    expect(view(w, '<s1@x>').count).toBe(4);
    expect(w.hub.store.all('SELECT id FROM mail_message WHERE thread_id = ? AND addressed = ?', t, 'self')).toHaveLength(2);
    expect(rows(w)).toBe(7);
    expect(copy(w, '<s3@x>', GMAIL.all).flags.answered).toBe(true);
  });
});

describe('classification', () => {
  test('list mail is bulk by its headers (Gmail\'s categories never come over IMAP), the rest is personal', async () => {
    const w = await world({ classify: true });
    await until(() => w.hub.store.one<{ class: string | null }>('SELECT class FROM mail_message WHERE id = ?', mid('<n1@x>'))?.class, 4000, 'classified');
    const why = (hdr: string) => w.hub.store.one<{ class: string; class_why: string }>('SELECT class, class_why FROM mail_message WHERE id = ?', mid(hdr));
    expect(why('<n1@x>')).toEqual({ class: 'bulk', class_why: 'list' });
    expect(why('<s3@x>')).toEqual({ class: 'personal', class_why: 'mine' });
    expect(why('<s2@x>')).toEqual({ class: 'self', class_why: 'self' });
    expect(why('<a1@x>')).toMatchObject({ class: 'personal' });
    expect(w.fake.messages(ACC).some((m) => w.fake.labelsOnServer(ACC, m.id).some((l) => /^CATEGORY_/i.test(l)))).toBe(false);
    expect(subjects(w, 'v:updates:*')).toEqual(['Weekly 12']);
    expect(subjects(w, 'v:inbox:*')).toEqual(['Re: Dinner on Friday?', 'Tickets']);
  });
});
