/**
 * Keeping all mail (mail/keep.ts; docs/mail.md "Keeping all mail") on FakeMailBackend in its imap, proton, gmail and
 * gmail-web modes: the walk to the end of every mailbox and every body fetched; no eviction, no summary sweep and no
 * index cap for a kept account while one not kept behaves as before; the whole text found past 16 KB; attachments'
 * names; the disk guard; the background lane and an account that stops background reads; the search measure; Gmail's
 * audits, split when full or paged by ids, catching a message the hub lacked; "searched locally" on and off again;
 * server=auto leaving such an account out while server=1 asks it; an opaque cursor kept across a restart; the route.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { bigSweep } from '../src/mail/backfill.ts';
import { BodyCache, searchText } from '../src/mail/cache.ts';
import { FakeMailBackend, fillMailbox, GMAIL, GMAIL_WEB, GMAIL_WEB_DETAILS, type FakeOpts } from '../src/mail/fake.ts';
import { MailCallError, MailHub } from '../src/mail/index.ts';
import { AUDIT_LIMIT, auditQuery, keepOf, LOCAL_SEARCHES } from '../src/mail/keep.ts';
import { MAIL_LIMITS } from '../src/mail/limits.ts';
import { mailSearchOf, serverQuery } from '../src/mail/search.ts';
import { MailStore } from '../src/mail/store.ts';
import { parseSearch } from '@dither-chat/protocol';
import { FakeClock } from './fixtures/clock.ts';

const ACC = 'acc_keepTest01';
const OTHER = 'acc_keepTest02';
const ME = 'me@example.com';
const DAY = 86_400_000;
const GB = 1024 ** 3;
const NOW = new Date(2026, 10, 11, 12).getTime();

let clock = new FakeClock(NOW);
const saved = { ...MAIL_LIMITS };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  Object.assign(MAIL_LIMITS, saved);
});

interface World {
  fake: FakeMailBackend;
  hub: MailHub;
  db: Database;
  free: { bytes: number | null };
}

interface WorldOpts {
  ids?: FakeOpts['ids'];
  details?: Record<string, unknown>;
  keepAll?: boolean;
  seed?: (f: FakeMailBackend) => void;
  other?: boolean;
  /** The budget as it is (2 calls a second, a pause after a page's call); else lifted, for speed. */
  budget?: boolean;
  db?: Database;
}

async function world(o: WorldOpts = {}): Promise<World> {
  if (!o.budget) Object.assign(MAIL_LIMITS, { backgroundPerSec: 1_000, userPauseMs: 0 });
  // Audits at a search a second, on the test's clock.
  MAIL_LIMITS.auditPerHour = 3_600;
  if (!o.db) clock = new FakeClock(NOW);
  const fake = new FakeMailBackend();
  fake.clock = clock;
  const details = o.details ? { ...(o.ids === 'gmail-web' ? GMAIL_WEB_DETAILS : {}), ...o.details } : undefined;
  fake.addAccount(ACC, { email: ME, opts: { ids: o.ids ?? 'imap', ...(details ? { details } : {}) } });
  if (o.other) fake.addAccount(OTHER, { email: 'other@example.com', opts: { ids: 'imap' } });
  o.seed?.(fake);
  const db = o.db ?? new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  const free = { bytes: 100 * GB as number | null };
  const hub = new MailHub({ db, backend: fake, log: () => {}, clock, keepAll: o.keepAll ?? true, freeBytes: () => free.bytes });
  hub.start();
  cleanup.push(() => hub.stop());
  await clock.wait(hub.sync(ACC)!.whenSynced());
  if (o.other) await clock.wait(hub.sync(OTHER)!.whenSynced());
  return { fake, hub, db, free };
}

const keeper = (w: World) => keepOf(w.hub)!;
const view = (w: World, id = ACC) => keeper(w).view(w.hub.store.account(id)!);
const count = (w: World, sql: string, ...args: unknown[]) => w.hub.store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, ...args)!.n;
const held = (w: World, id = ACC) => count(w, 'mail_message WHERE account_id = ?', id);
const texts = (w: World, id = ACC) => count(w, 'mail_text t JOIN mail_message m ON m.id = t.message_id WHERE m.account_id = ?', id);
const bodies = (w: World, id = ACC) => count(w, 'mail_body b JOIN mail_message m ON m.id = b.message_id WHERE m.account_id = ?', id);
const mid = (hdr: string, id = ACC) => mailId('mml', id, `m:${hdr}`);
/** The walk is done and every message has its text. */
const kept = (w: World, ms = 6 * 3_600_000) => clock.until(() => view(w).walk.complete && view(w).bodies === held(w) && held(w) > 0, ms, 'everything kept');
const route = (w: World, method: string, path: string, body?: unknown) => {
  const url = new URL(`http://hub${path}`);
  return clock.wait(w.hub.route(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), url));
};

/** Mail over five years: Inbox, an Archive mostly older than a year, Sent, Junk, Trash and a folder the hub does not follow. */
function seedFolders(f: FakeMailBackend) {
  const at = (years: number) => ({ newest: NOW - 60_000, oldest: NOW - years * 365 * DAY, self: ME, text: (i: number) => `message ${i}, written ${years} years back` });
  fillMailbox(f, ACC, 'INBOX', 90, at(3));
  fillMailbox(f, ACC, 'Archive', 150, at(5));
  fillMailbox(f, ACC, 'Sent', 30, at(2));
  fillMailbox(f, ACC, 'Junk', 12, at(1));
  fillMailbox(f, ACC, 'Trash', 9, at(1));
  f.addMailbox(ACC, { id: 'Projects', name: 'Projects', path: 'Projects', parentId: null, role: null, unread: null, total: null });
  fillMailbox(f, ACC, 'Projects', 24, at(4));
}

describe('the walk and the bodies', () => {
  test('a kept account lists every mailbox to its end and fetches every body; past the summary cap, no sweep', async () => {
    MAIL_LIMITS.maxPerAccount = 100;
    const w = await world({ seed: seedFolders });
    await kept(w);
    const v = view(w);
    // Every mailbox to its end, the ones the hub did not follow kept up from now on.
    expect(v.walk.complete).toBe(true);
    expect(v.boxes.map((b) => b.name)).toEqual(['Archive', 'Inbox', 'Sent', 'Trash', 'Junk', 'Drafts', 'Projects']);
    for (const b of v.boxes) expect({ name: b.name, held: b.held, complete: b.complete }).toEqual({ name: b.name, held: b.total!, complete: true });
    expect(w.hub.store.mailboxByNative(ACC, 'Projects')!.follow).toBe('open');
    // All of it: older than a year, past 100 summaries.
    expect(held(w)).toBe(315);
    expect(v.messages).toEqual({ held: 315, total: 315 });
    expect(v.bodies).toBe(315);
    expect(texts(w)).toBe(315);
    // The hourly sweep leaves a kept account alone.
    bigSweep(w.hub);
    expect(held(w)).toBe(315);
    // No lane in the status: no call carried `background`.
    expect(w.fake.calls.some((c) => 'background' in c.input)).toBe(false);
    expect(v.state).toBe('idle');
    expect(v.bytes.text).toBeGreaterThan(0);
  });

  test('not kept: a year and all of Inbox, the cap and its sweep, as before', async () => {
    MAIL_LIMITS.maxPerAccount = 100;
    const w = await world({ seed: seedFolders, keepAll: false });
    // It stops at the cap, with a year of Archive still to list.
    await clock.until(() => held(w) >= 100 && !w.hub.sync(ACC)!.backfill.running, 3_600_000, 'the backfill at the cap');
    await clock.advance(10 * 60_000);
    expect(w.hub.sync(ACC)!.backfill.legs().length).toBeGreaterThan(0);
    expect(w.hub.store.mailboxByNative(ACC, 'Projects')!.follow).toBeNull();
    expect(w.hub.store.mailboxByNative(ACC, 'Archive')!.complete).toBe(0);
    expect(w.fake.calls.filter((c) => c.op === 'mail.list' && c.input.mailboxId === 'Junk')).toHaveLength(0);
    expect(w.fake.calls.filter((c) => c.op === 'mail.get')).toHaveLength(0);
    // The sweep trims it back to the cap, Inbox aside.
    MAIL_LIMITS.maxPerAccount = 95;
    bigSweep(w.hub);
    expect(held(w)).toBe(95);
    expect(view(w).state).toBe('off');
  });

  test('no eviction and no index cap for a kept account; the one beside it is evicted and trimmed as before', async () => {
    const w = await world({ seed: (f) => (seedFolders(f), fillMailbox(f, OTHER, 'INBOX', 40, { newest: NOW - 60_000, oldest: NOW - 30 * DAY, self: 'other@example.com', text: (i) => `other body ${i} `.repeat(40) })), other: true });
    w.hub.store.setKeep(OTHER, { keep: false });
    await kept(w);
    // The other account's bodies, as a page reads them.
    for (const m of w.hub.store.all<{ id: string }>('SELECT id FROM mail_message WHERE account_id = ? LIMIT 30', OTHER)) await clock.wait(w.hub.body(m.id));
    const keptBodies = bodies(w);
    const otherBodies = bodies(w, OTHER);
    expect(otherBodies).toBe(30);
    // Caps far below what is held.
    Object.assign(MAIL_LIMITS, { cacheMb: 0.005, indexMb: 0.005 });
    new BodyCache(w.hub.store).sweep();
    expect(bodies(w)).toBe(keptBodies);
    expect(texts(w)).toBe(315);
    expect(bodies(w, OTHER)).toBeLessThan(otherBodies);
    expect(texts(w, OTHER)).toBeLessThan(otherBodies);
    // What counts against the caps is the other account's alone.
    expect(new BodyCache(w.hub.store).sizes().bodies).toBeLessThanOrEqual(0.005 * 1024 * 1024);
  });

  test('the whole text is found past 16 KB; a body kept before at 16 KB is cut again from itself, with no call', async () => {
    const long = (word: string) => `${'filler words for the start of a long letter. '.repeat(700)}${word} at the very end.`;
    const w = await world({
      seed: (f) => {
        f.put(ACC, { messageId: '<long@x>', from: [{ name: 'Sam', email: 'sam@x.example' }], to: [{ name: null, email: ME }], subject: 'A long one', receivedAt: NOW - DAY, text: long('quokka') });
        f.put(ACC, { messageId: '<long2@x>', from: [{ name: 'Sam', email: 'sam@x.example' }], to: [{ name: null, email: ME }], subject: 'Another long one', receivedAt: NOW - 2 * DAY, text: long('wombat') });
      },
      keepAll: false,
    });
    // Read while not kept: its text is cut at 16 KB, so the word past it is not found.
    await clock.wait(w.hub.body(mid('<long2@x>')));
    expect(w.hub.store.one<{ cut: number }>('SELECT cut FROM mail_text WHERE message_id = ?', mid('<long2@x>'))!.cut).toBe(MAIL_LIMITS.textBytes);
    const s = mailSearchOf(w.hub)!;
    expect(s.local('wombat').hits).toHaveLength(0);
    // Kept from now on.
    await route(w, 'PUT', `/api/mail/keep/${ACC}`, { keep: true });
    await kept(w);
    expect(searchText(w.hub.store, mid('<long@x>'))!.length).toBeGreaterThan(MAIL_LIMITS.textBytes);
    expect(s.local('quokka').hits.map((h) => h.thread.subject)).toEqual(['A long one']);
    // Cut again from the body it had: one mail.get, the page's, for it.
    expect(w.fake.calls.filter((c) => c.op === 'mail.get').length).toBe(2);
    expect(s.local('wombat').hits.map((h) => h.thread.subject)).toEqual(['Another long one']);
    expect(w.hub.store.one<{ cut: number }>('SELECT cut FROM mail_text WHERE message_id = ?', mid('<long2@x>'))!.cut).toBe(0);
  });

  test("attachments' names are searchable, kept or not, also after the body goes; Gmail is asked filename:", async () => {
    const w = await world({
      keepAll: false,
      seed: (f) =>
        f.put(ACC, {
          messageId: '<f@x>',
          from: [{ name: 'Jo', email: 'jo@x.example' }],
          to: [{ name: null, email: ME }],
          subject: 'Numbers',
          receivedAt: NOW - DAY,
          text: 'See attached.',
          hasAttachments: true,
          attachments: [{ id: 'a1', filename: 'Q3-forecast_final.pdf', mime: 'application/pdf', size: 2000, inline: false, contentId: null }],
        }),
    });
    const s = mailSearchOf(w.hub)!;
    expect(s.local('filename:forecast').hits).toHaveLength(0);
    await clock.wait(w.hub.body(mid('<f@x>')));
    expect(s.local('filename:forecast').hits.map((h) => h.thread.subject)).toEqual(['Numbers']);
    expect(s.local('forecast').hits).toHaveLength(1);
    expect(s.local('filename:invoice').hits).toHaveLength(0);
    // The body evicted: the name stays.
    w.hub.store.db.query('DELETE FROM mail_body').run();
    expect(s.local('filename:"q3 forecast"').hits).toHaveLength(1);
    expect(serverQuery(parseSearch('filename:forecast', new Date(), 'mail'), 'gmail')).toBe('filename:forecast');
  });

  test('a database from before file names: the index is made again with them', () => {
    const db = new Database(':memory:', { strict: true });
    const st = new MailStore(db);
    st.upsertAccount({ id: ACC, kind: 'imap', label: 'x', level: 'write', dryRun: false, online: true });
    st.putMailboxes(ACC, [{ id: 'INBOX', name: 'INBOX', path: 'INBOX', parentId: null, role: 'inbox', unread: null, total: null }]);
    const box = st.mailboxByNative(ACC, 'INBOX')!;
    st.ingest(ACC, box, [{ id: '1', mailboxId: 'INBOX', messageId: '<old@x>', threadId: null, from: [{ name: null, email: 'a@x.example' }], to: [], cc: [], subject: 'Old', date: NOW, receivedAt: NOW, flags: { seen: true, flagged: false, answered: false, draft: false }, labels: [], size: 1, preview: null, hasAttachments: true }]);
    db.query(`INSERT INTO mail_body (message_id, text, parts, bytes, fetched_at, used_at) VALUES (?, 'hi', ?, 2, 0, 0)`).run(mid('<old@x>'), JSON.stringify([{ id: 'a', filename: 'lease-2025.pdf', mime: 'application/pdf', size: 1, inline: false, contentId: null }]));
    // As it was before: no `files`, a three-column index and its triggers.
    for (const t of ['mail_search_insert', 'mail_search_delete', 'mail_search_update']) db.exec(`DROP TRIGGER ${t}`);
    db.exec('DROP TABLE mail_fts_vocab; DROP TABLE mail_fts; ALTER TABLE mail_search DROP COLUMN files');
    db.exec(`CREATE VIRTUAL TABLE mail_fts USING fts5(subject, people, body, content = 'mail_search', content_rowid = 'n', tokenize = "unicode61 remove_diacritics 2")`);
    db.exec(`CREATE TRIGGER mail_search_insert AFTER INSERT ON mail_search BEGIN INSERT INTO mail_fts (rowid, subject, people, body) VALUES (new.n, new.subject, new.people, new.body); END`);
    db.exec(`INSERT INTO mail_fts (mail_fts) VALUES ('rebuild')`);
    const hub = new MailHub({ db, backend: null, log: () => {} });
    cleanup.push(() => hub.stop());
    expect(mailSearchOf(hub)!.local('filename:lease').hits.map((h) => h.thread.subject)).toEqual(['Old']);
    expect(mailSearchOf(hub)!.local('Old').hits).toHaveLength(1);
  });

  test('the disk guard stops body fetching under the floor, says so, and goes on above it', async () => {
    const w = await world({ seed: seedFolders });
    w.free.bytes = 5 * GB;
    await clock.until(() => view(w).walk.complete, 3_600_000, 'the walk');
    await clock.advance(120_000);
    const gets = w.fake.calls.filter((c) => c.op === 'mail.get').length;
    expect(view(w).state).toBe('disk');
    expect(view(w).bodies).toBeLessThan(held(w));
    await clock.advance(10 * 60_000);
    expect(w.fake.calls.filter((c) => c.op === 'mail.get').length).toBe(gets);
    expect((await route(w, 'GET', '/api/mail/keep').then((r) => r.json())).disk).toEqual({ free: 5 * GB, floor: 10 * GB });
    // A lower floor (DITHER_MAIL_KEEP_FREE_GB), or more room: on it goes.
    MAIL_LIMITS.keepFreeGb = 2;
    await kept(w);
    expect(view(w).state).toBe('idle');
  });

  test('the walk keeps a cursor as the server gave it, and goes on from it after a restart', async () => {
    const db = new Database(':memory:', { strict: true });
    clock = new FakeClock(NOW);
    const seed = (f: FakeMailBackend) => fillMailbox(f, ACC, GMAIL_WEB.all, 900, { newest: NOW - 60_000, oldest: NOW - 4 * 365 * DAY, self: ME });
    const w = await world({ ids: 'gmail-web', seed, db, budget: true });
    const all = () => w.hub.store.mailboxByNative(ACC, GMAIL_WEB.all)!;
    await clock.until(() => all().list_next && all().horizon! < NOW - 400 * DAY, 3_600_000, 'the walk past a year');
    const cursor = all().list_next as string;
    w.hub.stop();
    // A new hub on the same database: its first page of All Mail starts at that cursor.
    const w2 = await world({ ids: 'gmail-web', seed, db, budget: true });
    await clock.until(() => w2.fake.calls.some((c) => c.op === 'mail.list' && c.input.mailboxId === GMAIL_WEB.all && c.input.before), 600_000, 'the walk going on');
    expect(w2.fake.calls.find((c) => c.op === 'mail.list' && c.input.mailboxId === GMAIL_WEB.all && c.input.before)!.input.before).toBe(cursor);
  });
});

describe('the background lane, and an account that stops background reads', () => {
  test("with the lane: the archive's reads say background, a page's never do", async () => {
    const w = await world({ ids: 'proton', seed: seedProton, details: { idPerMessage: true, backgroundLane: true } });
    await kept(w);
    // The walk's pages (the first sync's are smaller, and not the archive's).
    const walk = w.fake.calls.filter((c) => c.op === 'mail.list' && c.input.limit === MAIL_LIMITS.backfillPage);
    expect(walk.length).toBeGreaterThan(2);
    expect(walk.every((c) => c.input.background === true)).toBe(true);
    const gets = w.fake.calls.filter((c) => c.op === 'mail.get');
    expect(gets.length).toBe(held(w));
    expect(gets.every((c) => c.input.background === true)).toBe(true);
    // A page's body: in the foreground.
    w.hub.store.db.query('DELETE FROM mail_body').run();
    const before = w.fake.calls.length;
    await clock.wait(w.hub.body(mid('<inbox0@big.example>')));
    expect(w.fake.calls.slice(before).find((c) => c.op === 'mail.get')!.input.background).toBeUndefined();
  });

  test('backgroundStopped stops the walk, the bodies and the audits at once; pages read on; it resumes when the status clears', async () => {
    const w = await world({ ids: 'proton', seed: seedProton, details: { idPerMessage: true, backgroundLane: true, backgroundStopped: 'challenge' } });
    await clock.advance(5 * 60_000);
    const v = view(w);
    expect(v.state).toBe('stopped');
    expect(v.stopped).toBe('challenge');
    expect(w.fake.calls.filter((c) => c.input.background)).toHaveLength(0);
    // A page reads on.
    await clock.wait(w.hub.body(mid('<inbox0@big.example>')));
    expect(view(w).bodies).toBe(1);
    // The status no longer says so: everything goes on.
    w.fake.setStatus(ACC, { status: 'online', self: { email: ME }, details: { idPerMessage: true, backgroundLane: true } });
    await kept(w);
    expect(view(w).stopped).toBeNull();
  });

  test('a background call answered 503 paused stops it the same way, and nothing is tried again until the status clears', async () => {
    const w = await world({ ids: 'proton', seed: seedProton, details: { idPerMessage: true, backgroundLane: true } });
    w.fake.fail('mail.get', new MailCallError('the account paused background reads', 503, 'paused'), (input) => !!input.background);
    await clock.until(() => view(w).stopped === 'paused', 600_000, 'stopped');
    const n = w.fake.calls.filter((c) => c.input.background).length;
    await clock.advance(10 * 60_000);
    expect(w.fake.calls.filter((c) => c.input.background).length).toBe(n);
    expect(view(w).state).toBe('stopped');
    w.fake.setStatus(ACC, { status: 'online', self: { email: ME }, details: { idPerMessage: true, backgroundLane: true } });
    await kept(w);
  });
});

/** A Proton account's mail: Inbox, its All mail (everything), Sent. */
function seedProton(f: FakeMailBackend) {
  fillMailbox(f, ACC, 'INBOX', 60, { newest: NOW - 60_000, oldest: NOW - 3 * 365 * DAY, self: ME });
  fillMailbox(f, ACC, 'Archive', 40, { newest: NOW - 60_000, oldest: NOW - 5 * 365 * DAY, self: ME });
}

describe('the search measure', () => {
  test('per account: the hits, held before, with text here, found here; the last 30 days on the page', async () => {
    const sam = { name: 'Sam', email: 'sam@x.example' };
    const me = { name: null, email: ME };
    const w = await world({
      keepAll: false,
      seed: (f) => {
        f.put(ACC, { messageId: '<z1@x>', from: [sam], to: [me], subject: 'Zoo trip', receivedAt: NOW - DAY, text: 'the zebra was asleep' });
        f.put(ACC, { messageId: '<z2@x>', from: [sam], to: [me], subject: 'Photos', receivedAt: NOW - 2 * DAY, text: 'one more zebra' });
        f.addMailbox(ACC, { id: 'Old', name: 'Old', path: 'Old', parentId: null, role: null, unread: null, total: null });
        f.put(ACC, { mailboxId: 'Old', messageId: '<z3@x>', from: [sam], to: [me], subject: 'Stripes', receivedAt: NOW - 900 * DAY, text: 'zebra crossing' });
      },
    });
    await clock.wait(w.hub.body(mid('<z1@x>')));
    const page = await clock.wait(mailSearchOf(w.hub)!.search('zebra', { server: true }));
    expect(page.server!.accounts[0]).toMatchObject({ state: 'done', found: 3 });
    const m = w.hub.store.one('SELECT found, held, bodies, local, full FROM mail_search_measure WHERE account_id = ?', ACC);
    // Three on the server; two held before; one with its text; that one found here.
    expect(m).toEqual({ found: 3, held: 2, bodies: 1, local: 1, full: 0 });
    expect(view(w).measure).toEqual({ searches: 1, found: 3, held: 2, bodies: 1, local: 1 });
    // A month later it has left the page's 30 days.
    w.hub.store.db.query('UPDATE mail_search_measure SET at = at - 31 * 86400000').run();
    expect(view(w).measure.searches).toBe(0);
  });
});

describe("Gmail's audits", () => {
  /** Mail over three years, one month with more than a search answers; and a label. */
  function seedGmail(f: FakeMailBackend) {
    fillMailbox(f, ACC, GMAIL.all, 120, { newest: NOW - 40 * DAY, oldest: NOW - 3 * 365 * DAY, self: ME, tag: 'old' });
    fillMailbox(f, ACC, GMAIL.inbox, 30, { newest: NOW - 60_000, oldest: NOW - 20 * DAY, self: ME, tag: 'new' });
    // A busy month: more than one search answers.
    const busy = new Date(2025, 5, 10).getTime();
    fillMailbox(f, ACC, GMAIL.all, AUDIT_LIMIT * 2 + 20, { newest: busy + 5 * DAY, oldest: busy, self: ME, tag: 'busy' });
    f.put(ACC, { mailboxId: GMAIL.all, messageId: '<label@x>', from: [{ name: 'Jo', email: 'jo@x.example' }], to: [{ name: null, email: ME }], subject: 'Trip', receivedAt: NOW - 100 * DAY, labels: ['Travel'], text: 'tickets' });
  }
  const audits = (w: World) => w.hub.store.all<{ start: number; end: number; state: string; server: number; held: number; caught: number; estimate: number | null; searches: number }>('SELECT * FROM mail_audit WHERE account_id = ? ORDER BY start', ACC);
  /** What the server holds in a window, in All Mail. */
  const inWindow = (w: World, all: string, r: { start: number; end: number }) => w.fake.messages(ACC, all).filter((m) => m.receivedAt >= r.start && m.receivedAt < r.end).length;
  const allMatch = (w: World) => {
    const a = audits(w);
    return a.length > 0 && a.every((r) => r.state === 'match');
  };

  test('month windows, split while full, operators only; a message the hub lacked is caught and stored', async () => {
    const w = await world({ ids: 'gmail', seed: seedGmail });
    await kept(w);
    await clock.until(() => allMatch(w), 6 * 3_600_000, 'every window matching');
    const searches = w.fake.calls.filter((c) => c.op === 'mail.search');
    // Operators only, never words: after: and before: in epoch seconds.
    expect(searches.every((c) => /^(after:\d+ )?before:\d+$/.test(c.input.query))).toBe(true);
    const windows = audits(w);
    // The busy month was split until no piece came back full.
    const busy = windows.find((r) => r.start === new Date(2025, 5, 1).getTime())!;
    expect(busy.server).toBe(inWindow(w, GMAIL.all, busy));
    expect(busy.server).toBeGreaterThan(AUDIT_LIMIT * 2);
    expect(busy.searches).toBeGreaterThan(2);
    expect(searches.length).toBeGreaterThan(windows.length);
    expect(windows[0].start).toBe(0);
    const v = view(w);
    expect(v.audit).toMatchObject({ windows: windows.length, matched: windows.length, missed: 0, caught: 0 });
    // The hub loses one (as if the walk had missed it); its window is due again a day later.
    const lost = mid('<old7@big.example>');
    const at = w.hub.store.one<{ received_at: number }>('SELECT received_at FROM mail_message WHERE id = ?', lost)!.received_at;
    w.hub.store.db.query('DELETE FROM mail_message WHERE id = ?').run(lost);
    expect(held(w)).toBe(view(w).messages.held);
    w.hub.store.db.query('UPDATE mail_audit SET checked_at = 0 WHERE account_id = ? AND start <= ? AND end > ?').run(ACC, at, at);
    await clock.until(() => w.hub.store.one('SELECT 1 FROM mail_message WHERE id = ?', lost), 3_600_000, 'the lost message caught');
    await clock.until(() => allMatch(w), 3_600_000, 'every window matching again');
    expect(view(w).audit!.caught).toBe(1);
  });

  test('ids-only search: a window paged whole by cursor, with the estimate, no splitting; a lacking message fetched by id', async () => {
    const w = await world({ ids: 'gmail-web', seed: (f) => {
      fillMailbox(f, ACC, GMAIL_WEB.all, 60, { newest: NOW - 40 * DAY, oldest: NOW - 2 * 365 * DAY, self: ME, tag: 'old' });
      const busy = new Date(2025, 5, 10).getTime();
      fillMailbox(f, ACC, GMAIL_WEB.all, 620, { newest: busy + 5 * DAY, oldest: busy, self: ME, tag: 'busy' });
    }, details: { searchIds: true, backgroundLane: true } });
    await kept(w);
    await clock.until(() => allMatch(w), 6 * 3_600_000, 'every window matching');
    const searches = w.fake.calls.filter((c) => c.op === 'mail.search');
    expect(searches.every((c) => c.input.idsOnly === true && c.input.limit === 500 && c.input.background === true)).toBe(true);
    const busy = audits(w).find((r) => r.start === new Date(2025, 5, 1).getTime())!;
    const n = inWindow(w, GMAIL_WEB.all, busy);
    expect(n).toBeGreaterThan(500);
    expect(busy).toMatchObject({ server: n, estimate: n, searches: 2 });
    expect(view(w).audit!.estimate).toBe(680);
    // One lost here is fetched by its id (with its body) when its window is searched again.
    const lost = mid('<busy3@big.example>');
    w.hub.store.db.query('DELETE FROM mail_message WHERE id = ?').run(lost);
    w.hub.store.db.query('UPDATE mail_audit SET checked_at = 0 WHERE account_id = ? AND start = ?').run(ACC, busy.start);
    await clock.until(() => w.hub.store.one('SELECT 1 FROM mail_body WHERE message_id = ?', lost), 3_600_000, 'the lost message caught');
    expect(view(w).audit!.caught).toBe(1);
  });

  test('re-checks: the current month daily, older ones less and less often', async () => {
    const { recheckMs } = await import('../src/mail/keep.ts');
    const at = (monthsAgo: number) => {
      const start = new Date(2026, 10 - monthsAgo, 1).getTime();
      return { start, end: new Date(2026, 11 - monthsAgo, 1).getTime(), state: 'match' };
    };
    expect(recheckMs(at(0), NOW)).toBe(DAY);
    expect(recheckMs(at(2), NOW)).toBe(7 * DAY);
    expect(recheckMs(at(8), NOW)).toBe(30 * DAY);
    expect(recheckMs(at(40), NOW)).toBe(182 * DAY);
    expect(auditQuery(0, 1_000_000)).toBe('before:1000');
    expect(auditQuery(1_000_000, 2_000_000)).toBe('after:1000 before:2000');
  });
});

describe('searched locally', () => {
  const sam = { name: 'Sam', email: 'sam@x.example' };
  function seedWords(f: FakeMailBackend) {
    for (let i = 0; i < 30; i++) f.put(ACC, { messageId: `<w${i}@x>`, from: [sam], to: [{ name: null, email: ME }], subject: `Note ${i}`, receivedAt: NOW - (i + 1) * DAY, text: `word${i} and the common otter` });
  }
  const ask = (w: World, q: string, server: boolean | 'auto') => clock.wait(mailSearchOf(w.hub)!.search(q, { server }));

  test('on once everything is held and the last 20 server searches found nothing new; off at once when one does; server=auto leaves it out, server=1 asks', async () => {
    const w = await world({ seed: seedWords });
    await kept(w);
    await clock.advance(60_000);
    expect(view(w).local.on).toBe(false);
    expect(view(w).local.missing).toEqual([`0 of ${LOCAL_SEARCHES} server searches measured`]);
    for (let i = 0; i < LOCAL_SEARCHES; i++) await ask(w, `word${i}`, true);
    expect(view(w).local).toEqual({ on: true, missing: [] });
    // server=auto: not asked, and the page says why.
    const calls = w.fake.calls.filter((c) => c.op === 'mail.search').length;
    const auto = await ask(w, 'nothing-here-at-all', 'auto');
    expect(auto.server!.accounts).toEqual([{ accountId: ACC, state: 'local', found: 0, error: null, note: 'Searched here: this hub holds all of its mail.' }]);
    expect(w.fake.calls.filter((c) => c.op === 'mail.search').length).toBe(calls);
    // server=1 asks it all the same, and measures; it finds what the hub does not have (it never heard of it).
    w.fake.put(ACC, { mailboxId: 'Archive', messageId: '<new@x>', from: [sam], to: [{ name: null, email: ME }], subject: 'Unheard', receivedAt: NOW - 50 * DAY, text: 'a narwhal' });
    const one = await ask(w, 'narwhal', true);
    expect(one.server!.accounts[0]).toMatchObject({ state: 'done', found: 1 });
    expect(w.fake.calls.filter((c) => c.op === 'mail.search').length).toBe(calls + 1);
    // Off at once.
    expect(view(w).local.on).toBe(false);
    expect(view(w).local.missing).toContain(`A server search in the last ${LOCAL_SEARCHES} found mail not held here`);
    expect((await ask(w, 'narwhal-again', 'auto')).server!.accounts[0].state).not.toBe('local');
  });

  test("off again when a mailbox's count grows past what is held", async () => {
    const w = await world({ seed: seedWords });
    await kept(w);
    for (let i = 0; i < LOCAL_SEARCHES; i++) await ask(w, `word${i}`, true);
    await clock.until(() => view(w).local.on, 3_600_000, 'searched locally');
    w.fake.put(ACC, { messageId: '<grown@x>', from: [sam], to: [{ name: null, email: ME }], subject: 'More', receivedAt: NOW - 3 * DAY, text: 'more' });
    await clock.wait(w.hub.sync(ACC)!.refreshMailboxes());
    expect(view(w).local.on).toBe(false);
    expect(view(w).local.missing).toEqual(['Inbox: fewer here than the server counts']);
  });
});

describe('the route', () => {
  test('GET lists each account measured; PUT turns keeping off or on, pauses and resumes', async () => {
    const w = await world({ seed: seedFolders, details: { storage: '4.2 GB of 15 GB', storageUsed: 4.2e9, storageTotal: 15e9 } });
    await kept(w);
    const page = (await (await route(w, 'GET', '/api/mail/keep')).json()) as P.MailKeepPage;
    expect(page.accounts).toHaveLength(1);
    const a = page.accounts[0];
    expect(a).toMatchObject({ accountId: ACC, keep: true, paused: false, state: 'idle', stopped: null, backgroundLane: false, messages: { held: 315, total: 315 }, bodies: 315, audit: null });
    expect(a.walk).toEqual({ complete: true, mailbox: null, back: null, done: 7, mailboxes: 7 });
    expect(a.storage).toEqual({ text: '4.2 GB of 15 GB', used: 4.2e9, total: 15e9 });
    const paused = (await (await route(w, 'PUT', `/api/mail/keep/${ACC}`, { paused: true })).json()) as P.MailKeepView;
    expect(paused).toMatchObject({ keep: true, paused: true, state: 'paused' });
    const off = (await (await route(w, 'PUT', `/api/mail/keep/${ACC}`, { keep: false, paused: false })).json()) as P.MailKeepView;
    expect(off).toMatchObject({ keep: false, paused: false, state: 'off', local: { on: false } });
    expect(w.hub.store.kept(ACC)).toBe(false);
    expect((await route(w, 'PUT', '/api/mail/keep/acc_nobody', { keep: true })).status).toBe(404);
    expect((await route(w, 'PUT', `/api/mail/keep/${ACC}`, {})).status).toBe(400);
  });
});
