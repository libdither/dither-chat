/**
 * Gmail on the web (docs/mail.md "Gmail"): dither-accounts' google kind, on FakeMailBackend's 'gmail-web' mode. A label
 * is a mailbox and a message has one id in all of them, as on Proton; the status says `provider` 'Gmail',
 * `idPerMessage`, `sendCap` and `maxRecipients`, and the address is a Workspace one, so the hub knows it is Gmail only
 * by what the extractor says. As dither-accounts reads Gmail's web protocol, its summaries carry no headers (no
 * Message-ID, In-Reply-To, References or list headers: mail.get has them) and its `emailId` is its id; Gmail's
 * categories come as `Category/…` labels. Checked: what the hub reads of the status, one message (and one id) in every
 * mailbox that lists it with no Message-ID on its summaries, the Message-ID from its body, a Promotions message as bulk
 * by its category, Move to Inbox from All Mail and into a label as label changes (nothing copied), archive and Undo
 * with no hold, trash and Undo, star and read, changes made in Gmail itself, search in Gmail's syntax, and the caps a
 * send is checked against.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mailboxList } from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import type { MailCallError } from '../src/mail/backend.ts';
import { FakeMailBackend, GMAIL_WEB, GMAIL_WEB_DETAILS, type FakeOpts } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailOps } from '../src/mail/ops.ts';
import { mailSearchOf } from '../src/mail/search.ts';
import { FakeClock } from './fixtures/clock.ts';

const ACC = 'acc_gmailWeb01';
// A Workspace address, and no `[Gmail]` mailboxes: only the status says this is Gmail.
const ME = { name: 'Me', email: 'me@workspace.example' };
const sam = { name: 'Sam Lee', email: 'sam@lee.example' };
const jo = { name: 'Jo Park', email: 'jo@park.example' };
const alex = { name: 'Alex', email: 'alex@north.example' };
const news = { name: 'Weekly News', email: 'editor@news.example' };
const H = 3_600_000;
const D = 24 * H;
const MB = 1024 * 1024;
const { inbox: INBOX, all: ALL, sent: SENT, important: IMPORTANT, trash: TRASH } = GMAIL_WEB;
/** The first user label the seed makes. */
const WORK = 'Label_1';

/** Each test's clock (world() makes one): the writer's pacing and the fake server's answers run on it. */
let clock = new FakeClock();
const until = (f: () => unknown, ms = 4000, what = 'condition') => clock.until(f, ms, what);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/**
 * Sam asks (Inbox, labelled Work and Important), you answer (Sent), Sam writes back (unread); a starred note from Alex
 * with tickets attached; a newsletter; an old message from Jo you archived, labelled Work; one from two years ago, past
 * what the hub lists.
 */
function seed(f: FakeMailBackend, now: number) {
  f.put(ACC, { messageId: '<s1@x>', from: [sam], to: [ME], subject: 'Dinner on Friday?', receivedAt: now - 3 * H, labels: ['Work', '\\Important'], flags: { seen: true }, text: 'Are you free after 7?' });
  f.put(ACC, { mailboxId: SENT, messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'], from: [ME], to: [sam], subject: 'Re: Dinner on Friday?', receivedAt: now - 2 * H, flags: { seen: true }, text: 'Yes, 7:30 works.' });
  f.put(ACC, { messageId: '<s3@x>', inReplyTo: '<s2@x>', references: ['<s1@x>', '<s2@x>'], from: [sam], to: [ME], subject: 'Re: Dinner on Friday?', receivedAt: now - H, text: 'Booked for 7:30.' });
  f.put(ACC, {
    messageId: '<a1@x>',
    from: [alex],
    to: [ME],
    subject: 'Tickets',
    receivedAt: now - 5 * H,
    flags: { seen: true, flagged: true },
    text: 'Two for Saturday.',
    attachments: [{ id: 'att-tickets', filename: 'tickets.pdf', mime: 'application/pdf', size: 3 * MB, inline: false, contentId: null }],
  });
  f.put(ACC, {
    messageId: '<n1@x>',
    from: [news],
    to: [ME],
    subject: 'Weekly 12',
    receivedAt: now - 4 * H,
    bulk: { listId: '<weekly.news.example>', unsubscribe: '<https://news.example/leave>', precedence: 'bulk', autoSubmitted: null },
    text: 'This week in news.',
  });
  f.put(ACC, { mailboxId: ALL, messageId: '<j1@x>', from: [jo], to: [ME], subject: 'Old photos', receivedAt: now - 30 * D, flags: { seen: true }, labels: ['Work'], text: 'From the lake.' });
  f.put(ACC, { mailboxId: ALL, messageId: '<r1@x>', from: [{ name: 'Maple Hardware', email: 'orders@maple.example' }], to: [ME], subject: 'Your receipt', receivedAt: now - 730 * D, flags: { seen: true }, text: 'Keep this as your warranty.' });
}

/** The world a test made last: `mid` finds its messages by the server's id (summaries carry no Message-ID here). */
let current: World;

interface World {
  fake: FakeMailBackend;
  hub: MailHub;
}

async function world(o: { opts?: FakeOpts } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-gmail-web-'));
  clock = new FakeClock();
  const fake = new FakeMailBackend();
  fake.clock = clock;
  fake.addAccount(ACC, { email: ME.email, name: ME.name, opts: { ids: 'gmail-web', ...o.opts } });
  seed(fake, clock.now());
  const hub = new MailHub({ db: new Database(':memory:', { strict: true }), backend: fake, log: () => {}, dataDir: dir, holdMs: 20, clock });
  const ops = mailOps(hub);
  ops.coalesceMs = 0;
  ops.pollMs = 20;
  // gmailArchiveHoldMs stays as it is: Gmail on the web is not held, and the tests below would see it if it were.
  hub.start();
  cleanup.push(() => {
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await clock.wait(hub.sync(ACC)!.whenSynced());
  current = { fake, hub };
  return current;
}

/** The backfill has listed what it lists (All Mail back a year, here). */
const backfilled = (w: World) => until(() => w.hub.sync(ACC)!.backfill.legs().length === 0 && !w.hub.sync(ACC)!.backfill.running, 15_000, 'the backfill');
/** The hub's message for a seeded one: keyed by its emailId, the server's id, since its summaries have no Message-ID. */
const mid = (hdr: string) => mailId('mml', ACC, `e:${onServer(current, hdr).id}`);
const box = (w: World, native: string) => w.hub.store.mailboxByNative(ACC, native)!;
/** The message on the server: there is one, whichever mailboxes list it. */
const onServer = (w: World, hdr: string) => {
  const ms = w.fake.messages(ACC).filter((m) => m.messageId === hdr);
  expect(ms).toHaveLength(1);
  return ms[0];
};
/** The mailboxes the server lists it in, sorted. */
const boxesOnServer = (w: World, hdr: string) => w.fake.mailboxesOf(ACC, onServer(w, hdr).id).sort();
/** Where the hub has it: the server's mailbox ids, sorted. */
const where = (w: World, hdr: string) =>
  w.hub.store
    .all<{ native_id: string }>('SELECT b.native_id FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ? ORDER BY b.native_id', mid(hdr))
    .map((r) => r.native_id);
/** The ids the hub has it by, in whichever mailbox: one, the message's. */
const idsHere = (w: World, hdr: string) => w.hub.store.all<{ native_id: string }>('SELECT DISTINCT native_id FROM mail_location WHERE message_id = ?', mid(hdr)).map((r) => r.native_id);
const threadOf = (w: World, hdr: string) => w.hub.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', mid(hdr))!.thread_id;
const view = (w: World, hdr: string) => w.hub.store.threadView(w.hub.store.thread(threadOf(w, hdr))!);
const rows = (w: World) => w.hub.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE account_id = ?', ACC)!.n;
const subjects = (w: World, key: string) => w.hub.store.listThreads(key, null, 100)!.threads.map((t) => t.subject);
const moves = (w: World) => w.fake.calls.filter((c) => c.op === 'mail.move');

describe('what the extractor says', () => {
  test('Gmail by its provider, though neither its address nor its mailboxes say so; one id a message; its caps', async () => {
    const w = await world();
    const st = w.hub.store;
    const a = st.account(ACC)!;
    expect(a.address).toBe(ME.email);
    expect(st.mailboxes(ACC).some((b) => /^\[(gmail|google mail)\]/i.test(b.path))).toBe(false);
    expect([st.gmail(ACC), st.idPerMessage(ACC), st.gmailPerMailbox(ACC)]).toEqual([true, true, false]);
    expect(st.accountView(a)).toMatchObject({ kind: 'google', sendCap: 25 * MB, maxRecipients: 500 });
    // Labels are mailboxes; All Mail is the one the hub keeps up with, beside Inbox and Sent.
    expect(
      st
        .mailboxes(ACC)
        .filter((b) => b.follow === 'always')
        .map((b) => b.native_id)
        .sort(),
    ).toEqual([ALL, INBOX, SENT].sort());
    expect(box(w, WORK)).toMatchObject({ path: 'Work', role: null });
  });
});

describe('one message', () => {
  test('in Inbox, All Mail and a label: one message here, by one id, wherever it was listed from', async () => {
    const w = await world();
    const s1 = onServer(w, '<s1@x>');
    expect(boxesOnServer(w, '<s1@x>')).toEqual([INBOX, ALL, IMPORTANT, WORK].sort());
    expect(where(w, '<s1@x>')).toEqual([INBOX]);
    await backfilled(w);
    expect(where(w, '<s1@x>')).toEqual([ALL, INBOX].sort());
    expect(where(w, '<s2@x>')).toEqual([ALL, SENT].sort());
    expect(where(w, '<j1@x>')).toEqual([ALL]);
    expect(rows(w)).toBe(6);
    // A label opened in the page: one more place, the same id.
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    expect(where(w, '<s1@x>')).toEqual([ALL, INBOX, WORK].sort());
    expect(idsHere(w, '<s1@x>')).toEqual([s1.id]);
    expect(rows(w)).toBe(6);
    // Its labels read the same from every mailbox: the person's own shown, Gmail's not.
    expect(view(w, '<s1@x>').labels).toEqual(['Work']);
    // The thread is Gmail's, three messages, none twice.
    const t = view(w, '<s1@x>');
    expect(t.count).toBe(3);
    expect(w.hub.store.messageViews(t.id).map((m) => m.subject)).toEqual(['Dinner on Friday?', 'Re: Dinner on Friday?', 'Re: Dinner on Friday?']);
    expect(subjects(w, mailboxList(box(w, ALL).id)).filter((s) => s === 'Re: Dinner on Friday?')).toHaveLength(1);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(rows(w)).toBe(6);
  });

  test('a message with no Message-ID is one message by its id (its emailId), in each mailbox listing it', async () => {
    const w = await world();
    const m = w.fake.deliver(ACC, { messageId: null, from: [jo], to: [ME], subject: 'No header', labels: ['Work'], text: 'Sent by an old script.' });
    await until(() => w.hub.store.one('SELECT 1 FROM mail_message WHERE email_id = ?', m.id), 4000, 'the new message');
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    const ms = w.hub.store.all<{ id: string }>(`SELECT id FROM mail_message WHERE account_id = ? AND subject = 'No header'`, ACC);
    expect(ms).toEqual([{ id: mailId('mml', ACC, `e:${m.id}`) }]);
    expect(w.hub.store.all<{ native_id: string }>('SELECT native_id FROM mail_location WHERE message_id = ?', ms[0].id).map((r) => r.native_id)).toEqual([m.id, m.id, m.id]);
  });
});

describe('summaries without headers', () => {
  test('no Message-ID on summaries: one message by its id; the body brings its Message-ID and threading headers', async () => {
    const w = await world();
    await backfilled(w);
    // The status says so, and the hub reads it.
    expect(w.hub.store.headerless(ACC)).toBe(true);
    expect(w.hub.store.one('SELECT summary_headers FROM mail_account WHERE id = ?', ACC)).toEqual({ summary_headers: 0 });
    const s3 = mid('<s3@x>');
    expect(w.hub.store.one('SELECT message_id_hdr, in_reply_to, email_id FROM mail_message WHERE id = ?', s3)).toEqual({ message_id_hdr: null, in_reply_to: null, email_id: onServer(w, '<s3@x>').id });
    // Fetched: its Message-ID and In-Reply-To from mail.get, the thread as Gmail has it.
    await clock.wait(w.hub.body(s3));
    expect(w.hub.store.one('SELECT message_id_hdr, in_reply_to FROM mail_message WHERE id = ?', s3)).toEqual({ message_id_hdr: '<s3@x>', in_reply_to: '<s2@x>' });
    expect(threadOf(w, '<s3@x>')).toBe(threadOf(w, '<s1@x>'));
    expect(rows(w)).toBe(6);
  });

  test("Gmail's categories come as labels: a Promotions message is bulk by rule 8, with no list headers to go by", async () => {
    const w = await world();
    const { mailClassifier } = await import('../src/mail/classify.ts');
    const { Store } = await import('../src/store.ts');
    const dir = mkdtempSync(join(tmpdir(), 'dither-mail-gmail-web-classify-'));
    const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    cleanup.push(() => (chat.db.close(), rmSync(dir, { recursive: true, force: true })));
    mailClassifier(w.hub)!.connect(chat);
    const m = w.fake.deliver(ACC, { messageId: '<sale@x>', from: [{ name: 'Shop', email: 'hello@shop.example' }], to: [ME], subject: '20% off', labels: ['Category/Promotions'], text: 'This week only.' });
    const id = mailId('mml', ACC, `e:${m.id}`);
    await until(() => w.hub.store.one('SELECT class FROM mail_message WHERE id = ?', id)?.class, 4000, 'classified');
    expect(w.hub.store.one('SELECT class, class_why, labels FROM mail_message WHERE id = ?', id)).toEqual({ class: 'bulk', class_why: 'category', labels: JSON.stringify(['Category/Promotions', '\\Inbox']) });
    // A category is a label, not a mailbox.
    expect(w.hub.store.mailboxes(ACC).some((b) => /Promotions/.test(b.path))).toBe(false);
  });
});

describe('filing', () => {
  test('Move to Inbox from All Mail only puts the label on: nothing copied, the same id, its label stays', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    // Jo's photos, archived and labelled Work; the hub has not listed Work, so it knows only All Mail.
    const j1 = onServer(w, '<j1@x>');
    expect(where(w, '<j1@x>')).toEqual([ALL]);
    expect(ops.move({ threadIds: [threadOf(w, '<j1@x>')], to: 'inbox' })).toEqual({ ok: true, threads: 1, messages: 1 });
    expect(subjects(w, 'v:inbox:*')).toContain('Old photos');
    expect(subjects(w, mailboxList(box(w, ALL).id))).toContain('Old photos');
    await clock.wait(ops.idle());
    expect(moves(w).map((c) => c.input)).toEqual([{ ids: [j1.id], mailboxId: INBOX }]);
    expect(w.fake.labelsOnServer(ACC, j1.id)).toEqual(['Work', '\\Inbox'].sort());
    expect(boxesOnServer(w, '<j1@x>')).toEqual([INBOX, ALL, WORK].sort());
    // Where Gmail has it, at once: Inbox by the message's own id, All Mail as it was.
    expect(where(w, '<j1@x>')).toEqual([ALL, INBOX].sort());
    expect(idsHere(w, '<j1@x>')).toEqual([j1.id]);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<j1@x>')).toEqual([ALL, INBOX].sort());
    expect(rows(w)).toBe(6);
    expect(view(w, '<j1@x>')).toMatchObject({ pending: false, labels: ['Work'], roles: expect.arrayContaining(['inbox', 'all']) });
    expect(subjects(w, 'v:inbox:*').filter((s) => s === 'Old photos')).toHaveLength(1);
  });

  test('into a label from Inbox: Inbox off, the label on, one id; the labels it had stay', async () => {
    const w = await world();
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    const ops = mailOps(w.hub);
    const n1 = onServer(w, '<n1@x>');
    ops.move({ threadIds: [threadOf(w, '<n1@x>')], to: box(w, WORK).id });
    expect(view(w, '<n1@x>').roles).not.toContain('inbox');
    await clock.wait(ops.idle());
    expect(moves(w).map((c) => c.input)).toEqual([{ ids: [n1.id], mailboxId: WORK }]);
    expect(boxesOnServer(w, '<n1@x>')).toEqual([ALL, WORK].sort());
    expect(where(w, '<n1@x>')).toEqual([ALL, WORK].sort());
    // Sam's question, in Inbox and labelled Work, into a label of its own: Work stays (the move names no mailbox it
    // comes from, so Gmail takes off only Inbox), and the hub does not take it out of Work either.
    w.fake.label(ACC, onServer(w, '<s1@x>').id, { add: ['Plans'] });
    await clock.wait(w.hub.sync(ACC)!.refreshMailboxes());
    const plans = w.hub.store.mailboxes(ACC).find((b) => b.path === 'Plans')!;
    ops.move({ messageIds: [mid('<s1@x>')], to: plans.id });
    expect(view(w, '<s1@x>').mailboxIds).toContain(box(w, WORK).id);
    await clock.wait(ops.idle());
    expect(boxesOnServer(w, '<s1@x>')).toEqual([ALL, IMPORTANT, plans.native_id, WORK].sort());
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual(expect.arrayContaining([ALL, WORK]));
    expect(where(w, '<s1@x>')).not.toContain(INBOX);
    expect(rows(w)).toBe(6);
  });

  test('archive takes Inbox off at once, not held; Undo puts it back on, its labels as they were', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    expect(ops.gmailArchiveHoldMs).toBeGreaterThan(1000);
    const t = threadOf(w, '<s1@x>');
    const ids = ['<s1@x>', '<s3@x>'].map((h) => onServer(w, h).id).sort();
    expect(ops.move({ threadIds: [t], to: 'archive' })).toEqual({ ok: true, threads: 1, messages: 2 });
    expect(subjects(w, 'v:inbox:*')).not.toContain('Dinner on Friday?');
    // idle() returns once nothing could go within a second: had the archive been held for Undo, it would not have gone.
    await clock.wait(ops.idle());
    expect(moves(w).map((c) => ({ ...c.input, ids: [...c.input.ids].sort() }))).toEqual([{ ids, mailboxId: ALL }]);
    expect(boxesOnServer(w, '<s1@x>')).toEqual([ALL, IMPORTANT, WORK].sort());
    expect(boxesOnServer(w, '<s3@x>')).toEqual([ALL]);
    expect(where(w, '<s1@x>')).toEqual([ALL]);
    expect(view(w, '<s1@x>')).toMatchObject({ pending: false });
    expect(view(w, '<s1@x>').roles).not.toContain('inbox');
    // Undo: back to Inbox, by the same ids; Work and Important stay, and your reply in Sent is not touched.
    expect(ops.move({ threadIds: [t], to: 'inbox' })).toEqual({ ok: true, threads: 1, messages: 2 });
    expect(view(w, '<s1@x>').roles).toEqual(expect.arrayContaining(['inbox', 'all']));
    await clock.wait(ops.idle());
    expect(moves(w).slice(1).map((c) => ({ ...c.input, ids: [...c.input.ids].sort() }))).toEqual([{ ids, mailboxId: INBOX }]);
    expect(boxesOnServer(w, '<s1@x>')).toEqual([INBOX, ALL, IMPORTANT, WORK].sort());
    expect(boxesOnServer(w, '<s2@x>')).toEqual([ALL, SENT].sort());
    expect(where(w, '<s1@x>')).toEqual([ALL, INBOX].sort());
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual([ALL, INBOX].sort());
    expect(idsHere(w, '<s1@x>')).toEqual([onServer(w, '<s1@x>').id]);
    expect(rows(w)).toBe(6);
    expect(view(w, '<s1@x>')).toMatchObject({ pending: false, labels: ['Work'] });
    expect(subjects(w, 'v:inbox:*').filter((s) => s === 'Re: Dinner on Friday?')).toHaveLength(1);
  });

  test('trash: into Trash alone, what you sent stays in Sent; Undo brings it back with its labels', async () => {
    const w = await world();
    await backfilled(w);
    await clock.wait(w.hub.sync(ACC)!.backfill.more(box(w, WORK).id));
    const ops = mailOps(w.hub);
    const t = threadOf(w, '<s1@x>');
    expect(ops.move({ threadIds: [t], to: 'trash' })).toEqual({ ok: true, threads: 1, messages: 2 });
    await clock.wait(ops.idle());
    expect(moves(w).map((c) => c.input.mailboxId)).toEqual([TRASH]);
    expect(boxesOnServer(w, '<s1@x>')).toEqual([TRASH]);
    expect(boxesOnServer(w, '<s3@x>')).toEqual([TRASH]);
    // Moving your reply to the trash would take it out of Sent: it was never moved.
    expect(boxesOnServer(w, '<s2@x>')).toEqual([ALL, SENT].sort());
    expect(w.fake.labelsOnServer(ACC, onServer(w, '<s1@x>').id)).toEqual(['Work', '\\Important', '\\Inbox', '\\Trash'].sort());
    // The hub follows: Trash only, before any changes pass.
    expect(where(w, '<s1@x>')).toEqual([TRASH]);
    expect(where(w, '<s3@x>')).toEqual([TRASH]);
    expect(subjects(w, mailboxList(box(w, WORK).id))).toEqual(['Old photos']);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual([TRASH]);
    expect(where(w, '<s2@x>')).toEqual([ALL, SENT].sort());
    // Undo: back to Inbox; Gmail puts it back where its labels say.
    ops.move({ threadIds: [t], to: 'inbox' });
    await clock.wait(ops.idle());
    expect(moves(w).slice(1).map((c) => c.input.mailboxId)).toEqual([INBOX]);
    expect(boxesOnServer(w, '<s1@x>')).toEqual([INBOX, ALL, IMPORTANT, WORK].sort());
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(where(w, '<s1@x>')).toEqual(expect.arrayContaining([INBOX, ALL]));
    expect(where(w, '<s1@x>')).not.toContain(TRASH);
    expect(view(w, '<s1@x>').roles).not.toContain('trash');
    expect(rows(w)).toBe(6);
  });

  test('star, unstar, read and unread: on the message, by its one id', async () => {
    const w = await world();
    await backfilled(w);
    const ops = mailOps(w.hub);
    const t = threadOf(w, '<s1@x>');
    const s3 = onServer(w, '<s3@x>');
    const flags = () => w.fake.calls.filter((c) => c.op === 'mail.flag').map((c) => c.input);
    ops.flag({ threadIds: [t], flagged: true });
    await clock.wait(ops.idle());
    expect(flags()).toEqual([{ ids: [s3.id], flagged: true }]);
    expect(onServer(w, '<s3@x>').flags.flagged).toBe(true);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<s1@x>')).toMatchObject({ flagged: true, pending: false });
    ops.flag({ threadIds: [t], flagged: false });
    ops.flag({ threadIds: [t], seen: true });
    await clock.wait(ops.idle());
    expect(onServer(w, '<s3@x>').flags).toMatchObject({ flagged: false, seen: true });
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<s1@x>')).toMatchObject({ flagged: false, unread: 0 });
    ops.flag({ threadIds: [t], seen: false });
    await clock.wait(ops.idle());
    expect(onServer(w, '<s3@x>').flags.seen).toBe(false);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<s1@x>').unread).toBe(1);
    expect(rows(w)).toBe(6);
  });

  test('changes made in Gmail itself: archived, starred, labelled, deleted', async () => {
    const w = await world();
    await backfilled(w);
    w.fake.label(ACC, onServer(w, '<a1@x>').id, { remove: ['\\Inbox'] });
    await until(() => !view(w, '<a1@x>').roles.includes('inbox'), 4000, 'out of Inbox');
    expect(where(w, '<a1@x>')).toEqual([ALL]);
    w.fake.setFlags(ACC, onServer(w, '<s3@x>').id, { flagged: true });
    await until(() => view(w, '<s1@x>').flagged, 4000, 'starred');
    w.fake.label(ACC, onServer(w, '<n1@x>').id, { add: ['Reading'] });
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(view(w, '<n1@x>').labels).toEqual(['Reading']);
    // Deleted for good: gone here once the other mailboxes the hub keeps up with were asked whether it moved.
    const j1 = mid('<j1@x>');
    w.fake.remove(ACC, onServer(w, '<j1@x>').id);
    await clock.wait(w.hub.sync(ACC)!.catchUp());
    expect(w.hub.store.all('SELECT 1 FROM mail_location WHERE message_id = ?', j1)).toEqual([]);
    await until(() => !w.hub.store.one('SELECT 1 FROM mail_message WHERE id = ?', j1), 4000, 'deleted');
    expect(rows(w)).toBe(5);
  });
});

describe('search', () => {
  test('the server gets the query in Gmail\'s syntax, in All Mail, and what only it has shows once', async () => {
    const w = await world();
    await backfilled(w);
    const s = mailSearchOf(w.hub)!;
    expect(s.serverForm(w.hub.store.account(ACC)!)).toBe('gmail');
    const page = await clock.wait(s.search('warranty from:maple', { server: true }));
    const call = w.fake.calls.filter((c) => c.op === 'mail.search').pop()!;
    expect(call.input).toMatchObject({ query: 'warranty from:maple' });
    expect(call.input.mailboxId).toBeUndefined();
    expect(page.server!.hits.map((h) => h.thread.subject)).toEqual(['Your receipt']);
    expect(where(w, '<r1@x>')).toEqual([ALL]);
    await clock.wait(s.search('label:work is:unread', { server: true }));
    expect(w.fake.calls.filter((c) => c.op === 'mail.search').pop()!.input.query).toBe('label:work is:unread');
    expect(rows(w)).toBe(7);
  });
});

describe('sending', () => {
  /** A forward of Alex's tickets (3 MB) to Jo, as the composer sends it. */
  let sends = 0;
  const forward = (w: World, o: Partial<P.MailSendRequest> = {}): P.MailSendRequest => ({
    clientId: `gmail-web-forward-${sends++}`,
    draftKey: `t:${threadOf(w, '<a1@x>')}`,
    accountId: ACC,
    kind: 'forward',
    replyTo: mid('<a1@x>'),
    from: null,
    to: [jo],
    cc: [],
    bcc: [],
    subject: 'Fwd: Tickets',
    text: 'For you.',
    quote: true,
    files: [],
    forwardParts: [{ messageId: mid('<a1@x>'), attachmentId: 'att-tickets', name: 'tickets.pdf', mime: 'application/pdf', size: 3 * MB }],
    tz: 'UTC',
    ...o,
  });
  const refused = (p: Promise<unknown>) => clock.wait(p).then(() => null, (e: MailCallError) => ({ status: e.status, message: e.message }));

  test('the caps a send is checked against, and the composer shows, are the ones the status says', async () => {
    const w = await world({ opts: { details: { ...GMAIL_WEB_DETAILS, sendCap: 2 * MB, maxRecipients: 3 } } });
    const st = w.hub.store;
    expect(st.accountView(st.account(ACC)!)).toMatchObject({ sendCap: 2 * MB, maxRecipients: 3 });
    const four = [sam, jo, alex, news].map((p) => ({ name: p.name, email: p.email }));
    expect(await refused(w.hub.outbox.accept(forward(w, { to: four, forwardParts: [] })))).toEqual({ status: 400, message: 'At most 3 recipients on one message from this account.' });
    expect(await refused(w.hub.outbox.accept(forward(w)))).toEqual({ status: 413, message: 'The files are 3.0 MB together; this account takes 2 MB of files on one message.' });
    // The status says more now: the page hears of it, and the same forward goes.
    w.fake.setStatus(ACC, { status: 'online', attention: null, self: { email: ME.email }, details: { canSend: true, sendNote: null, sendCap: 30 * MB }, layers: [] });
    await until(() => st.account(ACC)!.send_cap === 30 * MB, 4000, 'the new cap');
    expect(st.accountView(st.account(ACC)!)).toMatchObject({ sendCap: 30 * MB, maxRecipients: 3 });
    const { outboxId } = await clock.wait(w.hub.outbox.accept(forward(w)));
    await until(() => w.hub.outbox.item(outboxId)?.state === 'sent', 4000, 'sent');
    expect(w.fake.sent[0].files.map((f) => [f.filename, f.bytes.length])).toEqual([['tickets.pdf', 3 * MB]]);
  });
});
