/**
 * Big mailboxes (mail/backfill.ts, bodies.ts, cache.ts; docs/mail-design.md §3.3-§3.5, §2.5) against FakeMailBackend:
 * 60k messages, the first screen within three calls, the backfill back to the horizon with memory flat and only the
 * live window sent to pages; background work at most two calls a second; a page's call ahead of the background;
 * pages on demand past what the hub holds; eviction that keeps starred mail; the cap on summaries.
 *
 * The 60k run prints its timings (docs/mail.md has them).
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mailboxList } from '@dither-chat/protocol';
import { bigSweep, pageOnDemand } from '../src/mail/backfill.ts';
import { BIG_BODY_MS, BodyCache, searchText } from '../src/mail/cache.ts';
import { demoPng } from '../src/mail/demo-html.ts';
import { FakeMailBackend, fillMailbox, type FakeOpts } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { MAIL_LIMITS, syncHorizon } from '../src/mail/limits.ts';
import { FakeClock } from './fixtures/clock.ts';

const ACC = 'acc_loadTest01';
const ME = 'me@example.com';
const DAY = 86_400_000;
const NOW = Date.now();

const until = async (f: () => unknown, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const saved = { ...MAIL_LIMITS };
let hub: MailHub | null = null;
const dirs: string[] = [];
afterEach(() => {
  hub?.stop();
  hub = null;
  Object.assign(MAIL_LIMITS, saved);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Seed {
  inbox: number;
  sent?: number;
  archive?: number;
  junk?: number;
  /** How far back each mailbox reaches. */
  years?: number;
  text?: (i: number) => string;
}

function seed(f: FakeMailBackend, s: Seed) {
  const span = (s.years ?? 3) * 365 * DAY;
  const at = { newest: NOW - 60_000, oldest: NOW - 60_000 - span, self: ME, text: s.text };
  fillMailbox(f, ACC, 'INBOX', s.inbox, at);
  fillMailbox(f, ACC, 'Sent', s.sent ?? 0, at);
  fillMailbox(f, ACC, 'Archive', s.archive ?? 0, at);
  fillMailbox(f, ACC, 'Junk', s.junk ?? 0, at);
}

function world(s: Seed, o: { opts?: FakeOpts; file?: boolean; now?: () => number; clock?: FakeClock } = {}) {
  const fake = new FakeMailBackend();
  if (o.clock) fake.clock = o.clock;
  fake.addAccount(ACC, { email: ME, opts: { ids: 'imap', ...o.opts } });
  seed(fake, s);
  let db: Database;
  if (o.file) {
    const dir = mkdtempSync(join(tmpdir(), 'mail-load-'));
    dirs.push(dir);
    db = new Database(join(dir, 'hub.db'), { create: true, strict: true });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  } else {
    db = new Database(':memory:', { strict: true });
    db.exec('PRAGMA foreign_keys = ON');
  }
  hub = new MailHub({ db, backend: fake, log: () => {}, now: o.now, clock: o.clock });
  return { fake, hub, st: hub.store, db, start: () => (hub!.start(), hub!.sync(ACC)!) };
}

const count = (h: MailHub, sql: string, ...args: unknown[]) => h.store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, ...args)!.n;
const heldIn = (h: MailHub, native: string) => count(h, 'mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE b.native_id = ?', native);
const box = (h: MailHub, native: string) => h.store.mailboxByNative(ACC, native)!;
/** The backfill has nothing left and has stopped. */
const backfilled = (h: MailHub) => {
  const s = h.sync(ACC)!;
  return s.phase === 'idle' && s.backfill.legs().length === 0;
};
const background = (c: { op: string }) => c.op === 'mail.list' || c.op === 'mail.get';
const heapMb = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed / 1048576;
};

describe('60k messages', () => {
  test('the first screen within three calls; the backfill to the horizon and all of Inbox, memory flat, only the live window sent', async () => {
    // The budget lifted: as fast as the fake answers (the budget itself is the next test's).
    Object.assign(MAIL_LIMITS, { backgroundPerSec: 100_000, userPauseMs: 0 });
    const S = { inbox: 12_000, sent: 6_000, archive: 42_000 };
    // On a clock of its own, each call answered 20 ms later: the same steps in the same order every run.
    const clock = new FakeClock(NOW);
    const { fake, st, db, start } = world(S, { file: true, clock, opts: { latencyMs: 20 } });
    const t0 = performance.now();
    let first: { calls: number; ms: number } | null = null;
    // The heap as the summaries come in, every 5k.
    const heap: { held: number; mb: number }[] = [];
    let next = 5_000;
    hub!.on('ingested', () => {
      first ??= { calls: fake.calls.length, ms: performance.now() - t0 };
      const n = count(hub!, 'mail_message');
      if (n >= next) {
        heap.push({ held: n, mb: heapMb() });
        next += 5_000;
      }
    });
    // The server flushes every 80 ms: what goes to pages.
    const sentThreads = new Set<string>();
    const stale = new Set<string>();
    const progress: P.MailAccountView['sync'][] = [];
    let flushing = true;
    const flush = () => {
      for (const e of hub!.flush()) {
        if (e.t === 'mail.threads') for (const t of e.threads) sentThreads.add(t.id);
        if (e.t === 'mail.lists') for (const k of e.stale) stale.add(k);
        if (e.t === 'mail.progress') progress.push(e.sync);
      }
      if (flushing) clock.setTimeout(flush, 80);
    };
    clock.setTimeout(flush, 80);
    const s = start();
    await clock.wait(s.whenSynced());
    const synced = performance.now() - t0;
    try {
      await clock.until(() => backfilled(hub!), 60_000, 'the backfill');
      // The bodies ahead: asked for a few seconds after the last page, then fetched.
      await clock.advance(5_000);
      await clock.until(() => s.queue.size === 0, 60_000, 'the bodies ahead');
    } finally {
      flushing = false;
    }
    const ms = performance.now() - t0;
    heap.push({ held: count(hub!, 'mail_message'), mb: heapMb() });

    // The first screen: mailboxes, Inbox's state, Inbox's newest page.
    expect(first!.calls).toBeLessThanOrEqual(3);

    // The horizon: all of Inbox; Sent and Archive back a year, not further (the year back from where the clock was
    // at the start, and at the end).
    const h = syncHorizon(clock.now());
    const within = (native: string, from: number) => fake.messages(ACC, native).filter((m) => m.receivedAt >= from).length;
    expect(heldIn(hub!, 'INBOX')).toBe(S.inbox);
    for (const native of ['Sent', 'Archive']) {
      expect(heldIn(hub!, native)).toBeGreaterThanOrEqual(within(native, h));
      expect(heldIn(hub!, native)).toBeLessThanOrEqual(within(native, syncHorizon(NOW)));
    }
    expect(count(hub!, `mail_message m WHERE m.received_at < ? AND NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = m.id AND b.role = 'inbox')`, h - 3_600_000)).toBe(0);
    expect(box(hub!, 'INBOX').complete).toBe(1);
    expect(box(hub!, 'Archive').complete).toBe(0);

    // The progress line moved, and ended.
    expect(progress.some((p) => p.phase === 'backfill')).toBe(true);
    expect(st.accountView(st.account(ACC)!).sync.phase).toBe('idle');

    // Only the live window went to the pages as threads; the rest made their lists stale.
    const threads = count(hub!, 'mail_thread');
    expect(sentThreads.size).toBeLessThan(1_500);
    expect(stale.has(mailboxList(box(hub!, 'Archive').id))).toBe(true);

    // Memory: the summaries are in the database, not the heap.
    const growth = heap[heap.length - 1].mb - heap[0].mb;
    expect(growth).toBeLessThan(40);

    // A page past the horizon: Archive's next page, fetched for it.
    const oldest = st.one<{ last_at: number; id: string }>(
      `SELECT t.last_at, t.id FROM mail_thread t WHERE EXISTS (SELECT 1 FROM json_each(t.mailboxes) WHERE value = ?) ORDER BY t.last_at, t.id LIMIT 1`,
      box(hub!, 'Archive').id,
    )!;
    const before = fake.calls.length;
    const asked = performance.now();
    const page = (await clock.wait(pageOnDemand(hub!, mailboxList(box(hub!, 'Archive').id), `${oldest.last_at}:${oldest.id}`, 50)))!;
    const pageMs = performance.now() - asked;
    expect(page.pending).toBe(false);
    expect(page.threads.length).toBe(50);
    expect(page.threads.every((t) => t.lastAt < h)).toBe(true);
    expect(fake.calls.slice(before).map((c) => `${c.op} ${c.input.mailboxId}`)).toEqual(['mail.list Archive']);

    const pages = fake.calls.filter((c) => c.op === 'mail.list').length;
    const bodies = fake.calls.filter((c) => c.op === 'mail.get').length;
    // Bodies ahead: the newest personal mail of the last two weeks, no more than the cap.
    expect(bodies).toBeLessThanOrEqual(MAIL_LIMITS.prefetchMax);
    const held = count(hub!, 'mail_message');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const file = statSync(db.filename).size;
    console.log(
      `[mail-load] 60k on the server: first screen after ${first!.calls} calls, ${first!.ms.toFixed(0)} ms; first sync ${synced.toFixed(0)} ms; ` +
        `backfill done in ${(ms / 1000).toFixed(1)} s unthrottled (${pages} list pages, ${bodies} bodies ahead); held ${held} summaries in ${threads} threads; ` +
        `database ${(file / 1048576).toFixed(1)} MB (${Math.round(file / held)} B a summary); heap ${heap.map((x) => `${(x.held / 1000).toFixed(0)}k:${x.mb.toFixed(0)}`).join(' ')} MB; ` +
        `threads sent ${sentThreads.size}; a page past the horizon ${pageMs.toFixed(0)} ms; ` +
        `at ${saved.backgroundPerSec} calls/s the background takes about ${((pages + bodies) / saved.backgroundPerSec / 60).toFixed(1)} min`,
    );
  }, 120_000);
});

describe('the budget', () => {
  test('background work (prefetch and backfill) starts at most two calls a second', async () => {
    const clock = new FakeClock(NOW);
    const { fake, start } = world({ inbox: 3_000, sent: 600, archive: 3_000 }, { clock });
    const s = start();
    await clock.wait(s.whenSynced());
    const from = fake.calls.length;
    await clock.advance(2_600);
    const bg = fake.calls.slice(from).filter(background);
    expect(bg.length).toBeGreaterThanOrEqual(4);
    // In any second, at most two.
    expect(MAIL_LIMITS.backgroundPerSec).toBe(2);
    for (const c of bg) expect(bg.filter((x) => x.at >= c.at && x.at < c.at + 1_000).length).toBeLessThanOrEqual(MAIL_LIMITS.backgroundPerSec);
  }, 10_000);

  test('P0 overtakes P2 and P3: a body a page waits for goes first, and the background pauses after it', async () => {
    expect(MAIL_LIMITS.userPauseMs).toBe(10_000);
    MAIL_LIMITS.userPauseMs = 1_500;
    const clock = new FakeClock(NOW);
    const { fake, st, start } = world({ inbox: 3_000, sent: 600, archive: 3_000 }, { clock });
    const s = start();
    await clock.wait(s.whenSynced());
    // Recent personal mail's bodies are queued ahead (P2) a few seconds after the sync, behind the budget.
    await clock.until(() => s.queue.size >= 10, 6_000, 'the prefetch');
    const waiting = s.queue.size;
    // A message no prefetch wants: a hundred days old.
    const old = st.one<{ id: string }>('SELECT id FROM mail_message WHERE received_at < ? ORDER BY received_at DESC LIMIT 1', clock.now() - 100 * DAY)!.id;
    const asked = clock.now();
    const v = await clock.wait(hub!.body(old));
    expect(v.text).toBeNull();
    const call = fake.calls.find((c) => c.op === 'mail.get' && c.at >= asked && st.nativeOf(old)?.id === c.input.id)!;
    expect(call.at - asked).toBeLessThan(400);
    expect(s.queue.size).toBeGreaterThanOrEqual(waiting - 2);
    // Nothing in the background for MAIL_LIMITS.userPauseMs after it.
    await clock.advance(1_900);
    const next = fake.calls.slice(fake.calls.indexOf(call) + 1).find(background);
    expect(next).toBeDefined();
    expect(next!.at - call.at).toBeGreaterThanOrEqual(MAIL_LIMITS.userPauseMs);
  }, 15_000);
});

describe('pages on demand', () => {
  test('a mailbox the hub does not follow: its first page when opened, a state before it, kept up from then on', async () => {
    const { fake, st, start } = world({ inbox: 30, junk: 120 });
    const s = start();
    await s.whenSynced();
    const junk = box(hub!, 'Junk');
    expect(junk.follow).toBeNull();
    const before = fake.calls.length;
    const page = (await pageOnDemand(hub!, mailboxList(junk.id), null, 20))!;
    expect(page.threads.length).toBe(20);
    expect(page.pending).toBe(false);
    expect(fake.calls.slice(before).map((c) => `${c.op} ${c.input.mailboxId}${c.input.state ? ' @' : ''}`)).toEqual(['mail.changes Junk', 'mail.list Junk']);
    expect(box(hub!, 'Junk')).toMatchObject({ follow: 'open', complete: 1 });
    expect(st.mailboxView(box(hub!, 'Junk')).followed).toBe(false);
    // The rest of it is here: no more calls.
    const n = fake.calls.length;
    const p2 = (await pageOnDemand(hub!, mailboxList(junk.id), page.next, 50))!;
    expect(p2.threads.length).toBe(20);
    expect(p2.complete).toBe(true);
    expect(fake.calls.length).toBe(n);
    // Moved there by another client: found by its changes pass, not deleted as gone.
    const inboxMsg = fake.messages(ACC, 'INBOX')[0];
    fake.move(ACC, inboxMsg.id, 'Junk');
    await until(() => st.one(`SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE b.native_id = 'Junk' AND l.message_id = (SELECT id FROM mail_message WHERE message_id_hdr = ?)`, inboxMsg.messageId), 3000, 'the move');
  });

  test('a slow server: the answer says pending, and the threads come as mail.threads', async () => {
    const clock = new FakeClock(NOW);
    const { fake, start } = world({ inbox: 20, junk: 60 }, { clock });
    const s = start();
    await clock.wait(s.whenSynced());
    hub!.flush();
    // Its state and its first page take 5 s each: past the 8 s an answer waits.
    expect(MAIL_LIMITS.pageWaitMs).toBe(8_000);
    fake.setOpts(ACC, { latencyMs: 5_000 });
    const asked = clock.now();
    const page = (await clock.wait(pageOnDemand(hub!, mailboxList(box(hub!, 'Junk').id), null, 50)))!;
    expect(clock.now() - asked).toBe(8_000);
    expect(page).toMatchObject({ pending: true, next: null, complete: false });
    let got: string[] = [];
    await clock.until(
      () => {
        for (const e of hub!.flush()) if (e.t === 'mail.threads') got.push(...e.threads.filter((t) => t.mailboxIds.includes(box(hub!, 'Junk').id)).map((t) => t.id));
        return got.length >= 20;
      },
      4000,
      'the threads',
    );
    expect(new Set(got).size).toBe(20);
  });
});

describe('the body cache', () => {
  test('past its cap the least recently read bodies go; starred mail and kept bodies stay; the search text stays', async () => {
    let now = NOW;
    const { fake, st, start } = world({ inbox: 60, years: 0.1, text: (i) => `Message ${i}. ${'words '.repeat(3_000)}` }, { now: () => now });
    const s = start();
    await s.whenSynced();
    const ids = st.all<{ id: string }>('SELECT id FROM mail_message ORDER BY received_at').map((r) => r.id);
    for (const id of ids) {
      now += 1_000;
      if (!st.body(id)) await hub!.body(id);
      else st.touchBody(id);
    }
    // The oldest-read five are starred on the server; one more is kept for an outbox item (slice 5).
    const starred = ids.slice(0, 5);
    for (const id of starred) fake.setFlags(ACC, st.nativeOf(id)!.id, { flagged: true });
    await until(() => count(hub!, 'mail_message WHERE flagged = 1') === 5, 3000, 'the stars');
    st.db.query('UPDATE mail_body SET keep = 1 WHERE message_id = ?').run(ids[5]);
    const cache = new BodyCache(st, () => now);
    const one = st.body(ids[10])!.bytes;
    const evicted = cache.evict(one * 30);
    const left = new Set(st.all<{ message_id: string }>('SELECT message_id FROM mail_body').map((r) => r.message_id));
    for (const id of [...starred, ids[5]]) expect(left.has(id)).toBe(true);
    // What went is what was read longest ago.
    expect(evicted.length).toBeGreaterThan(30);
    const order = ids.filter((id) => !starred.includes(id) && id !== ids[5]);
    expect(evicted).toEqual(order.slice(0, evicted.length));
    expect(cache.sizes().bodies).toBeLessThanOrEqual(one * 30 * 0.9 + one * 6);
    // Previews and search text outlive the bodies; an evicted body is fetched again when opened.
    expect(count(hub!, 'mail_text')).toBe(60);
    expect(searchText(st, evicted[0])).toStartWith('Message ');
    expect(searchText(st, evicted[0])!.length).toBe(MAIL_LIMITS.textBytes);
    expect(st.one<{ preview: string | null }>('SELECT preview FROM mail_message WHERE id = ?', evicted[0])!.preview).toStartWith('Message ');
    const gets = fake.calls.filter((c) => c.op === 'mail.get').length;
    expect((await hub!.body(evicted[0])).text).toStartWith('Message ');
    expect(fake.calls.filter((c) => c.op === 'mail.get').length).toBe(gets + 1);
    // The search text has a cap of its own: the oldest mail's goes first.
    const text = cache.sizes().text;
    cache.trimText(text / 2);
    expect(searchText(st, ids[0])).toBeNull();
    expect(searchText(st, ids[59])).not.toBeNull();
  });

  test('an evicted body comes back for its HTML, its cid: pictures and its files (slice 3)', async () => {
    const png = demoPng(4, 4, [1, 2, 3], [200, 100, 50]);
    const media = mkdtempSync(join(tmpdir(), 'mail-load-media-'));
    dirs.push(media);
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME });
    fake.put(ACC, {
      messageId: '<html@load.example>',
      receivedAt: NOW - 1000,
      html: '<p>The sketch:</p><img src="cid:sketch@x">',
      text: 'The sketch.',
      attachments: [
        { id: '2', filename: 'sketch.png', mime: 'image/png', size: png.length, inline: true, contentId: '<sketch@x>' },
        { id: '3', filename: 'notes.txt', mime: 'text/plain', size: 5, inline: false, contentId: null },
      ],
      files: { '2': png, '3': 'notes' },
    });
    const db = new Database(':memory:', { strict: true });
    db.exec('PRAGMA foreign_keys = ON');
    hub = new MailHub({ db, backend: fake, log: () => {}, media: { dir: media, key: 'k' } });
    hub.start();
    await hub.sync(ACC)!.whenSynced();
    const st = hub.store;
    const id = st.one<{ id: string }>(`SELECT id FROM mail_message WHERE message_id_hdr = '<html@load.example>'`)!.id;
    const get = async (path: string) => (await hub!.route(new Request(`http://hub.test${path}`), new URL(`http://hub.test${path}`)))!;
    const view = (await (await get(`/api/mail/messages/${id}/body`)).json()) as P.MailBodyView;
    const file = view.attachments.find((x) => x.name === 'notes.txt')!;
    const cache = new BodyCache(st);
    const gets = () => fake.calls.filter((c) => c.op === 'mail.get').length;
    for (const path of [view.html!.url, `/api/mail/messages/${id}/cid/sketch%40x`, file.url]) {
      expect(cache.evict(0)).toContain(id);
      expect(st.body(id)).toBeNull();
      const before = gets();
      const r = await get(path);
      expect([path, r.status]).toEqual([path, 200]);
      expect(gets()).toBe(before + 1);
      expect(st.body(id)).not.toBeNull();
    }
    expect(await (await get(file.url)).text()).toBe('notes');
  });

  test('a body over 2 MB is kept only while it is read', async () => {
    let now = NOW;
    const { st, start, fake } = world({ inbox: 2, years: 0.01 }, { now: () => now });
    fake.put(ACC, { messageId: '<huge@load.example>', receivedAt: NOW - 1000, text: 'x'.repeat(MAIL_LIMITS.bodyMaxBytes + 10) });
    const s = start();
    await s.whenSynced();
    const id = st.one<{ id: string }>(`SELECT id FROM mail_message WHERE message_id_hdr = '<huge@load.example>'`)!.id;
    await hub!.body(id);
    expect(st.body(id)!.keep).toBe(-1);
    const cache = new BodyCache(st, () => now);
    now += BIG_BODY_MS - 1000;
    cache.evict();
    expect(st.body(id)).not.toBeNull();
    now += 2000;
    expect(cache.evict()).toContain(id);
    expect(st.body(id)).toBeNull();
    expect(searchText(st, id)!.length).toBe(MAIL_LIMITS.textBytes);
  });
});

describe('the cap on summaries', () => {
  test('the backfill stops at it; past it the oldest outside Inbox go, starred mail stays, and paging lists them again without a gap', async () => {
    Object.assign(MAIL_LIMITS, { backgroundPerSec: 100_000, userPauseMs: 0, maxPerAccount: 1_500 });
    const { fake, st, start } = world({ inbox: 300, archive: 3_000, years: 0.9 });
    const s = start();
    await s.whenSynced();
    await until(() => !s.backfill.running, 20_000, 'the backfill');
    const held = count(hub!, 'mail_message');
    expect(held).toBeGreaterThanOrEqual(1_500);
    expect(held).toBeLessThan(1_500 + MAIL_LIMITS.backfillPage);
    // Pages beyond it, as you scroll: over the cap.
    const arc = box(hub!, 'Archive');
    for (let i = 0; i < 3; i++) await s.backfill.more(arc.id);
    // The oldest of what is held, starred.
    const star = st.one<{ id: string }>(`SELECT m.id FROM mail_message m JOIN mail_location l ON l.message_id = m.id WHERE l.mailbox_id = ? ORDER BY m.received_at LIMIT 1`, arc.id)!.id;
    st.db.query('UPDATE mail_message SET flagged = 1 WHERE id = ?').run(star);
    const deleted: string[] = [];
    hub!.on('deleted', (e) => deleted.push(...e.messageIds));
    bigSweep(hub!);
    expect(count(hub!, 'mail_message')).toBe(1_500);
    expect(heldIn(hub!, 'INBOX')).toBe(300);
    expect(st.one('SELECT 1 FROM mail_message WHERE id = ?', star)).not.toBeNull();
    expect(deleted.length).toBeGreaterThan(0);
    // Archive's listing went back above what went: paging on lists it again, and what is held runs without a gap
    // from the newest down (the starred one aside).
    const contiguous = () => {
      const onServer = fake.messages(ACC, 'Archive').sort((a, b) => b.receivedAt - a.receivedAt).map((m) => m.messageId);
      const here = new Set(st.all<{ h: string }>(`SELECT m.message_id_hdr AS h FROM mail_message m JOIN mail_location l ON l.message_id = m.id WHERE l.mailbox_id = ? AND m.id != ?`, arc.id, star).map((r) => r.h));
      return onServer.slice(0, here.size).every((h) => here.has(h!));
    };
    expect(contiguous()).toBe(true);
    const n = heldIn(hub!, 'Archive');
    await s.backfill.more(arc.id);
    expect(heldIn(hub!, 'Archive')).toBeGreaterThan(n);
    expect(contiguous()).toBe(true);
  }, 30_000);
});

describe('a page that comes back', () => {
  test('lists made stale while it was away are named in its catch-up', async () => {
    const { Store } = await import('../src/store.ts');
    const { changesOf } = await import('../src/journal.ts');
    const { syncResponse } = await import('../src/sync.ts');
    const store = new Store(':memory:', (raw) => raw ?? null);
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME });
    seed(fake, { inbox: 600, years: 2 });
    Object.assign(MAIL_LIMITS, { backgroundPerSec: 100_000, userPauseMs: 0, liveWindow: 50 });
    hub = new MailHub({ db: store.db, backend: fake, log: () => {} });
    const record = () => store.journal.record(changesOf(hub!.flush()));
    hub.start();
    await hub.sync(ACC)!.whenSynced();
    record();
    const pos = store.journal.position();
    await until(() => backfilled(hub!), 10_000, 'the backfill');
    record();
    const r = syncResponse({ store, usage: {} as any, mail: hub, boot: 'b' }, { v: pos.v, epoch: pos.epoch, since: pos.seq });
    if (r.full) throw new Error('refused');
    const lists = r.events.find((e) => e.t === 'mail.lists') as Extract<P.ClientEvent, { t: 'mail.lists' }> | undefined;
    expect(lists?.stale).toContain('v:inbox:*');
    expect(lists?.stale).toContain(mailboxList(box(hub, 'INBOX').id));
    store.db.close();
  }, 20_000);
});
