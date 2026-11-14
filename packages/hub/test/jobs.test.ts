/**
 * Index jobs (jobs.ts) and network search (netsearch.ts), against fake networks served a page or a search at a time.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { Jobs, PAGE } from '../src/jobs.ts';
import { BRISK, ReadingPace } from '../src/readingpace.ts';
import { BATCH, GAP_MS, HOURLY_CAP, NetSearch } from '../src/netsearch.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { FakeClock } from './fixtures/clock.ts';

const ME = '1';
const PEER = '2';
const minute = 60_000;
const T0 = Date.UTC(2026, 4, 1);
const n = (store: Store, sql: string, ...args: any[]) => (store.db.query(sql).get(...args) as any).n as number;

/**
 * In memory: the fake networks store each message on its own, 500 or so in a test, and on disk each was a commit and
 * an fsync, over 5 s on a busy machine. Nothing here has to outlive the process.
 */
function world(caps: P.Capability[] = ['history', 'walkMembers', 'search']) {
  const store = new Store(':memory:', mediaSigner('s'));
  let acc = store.createAccount({ id: 'acc_dc', network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'hello', network: 'discord', version: 'test', capabilities: caps });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: ME, isSelf: true } });
  acc = store.account('acc_dc')!;
  store.ingest(acc, { t: 'identity', identity: { nativeId: PEER, displayName: 'peer' } });
  return { store, acc };
}

/** A server with a category and channels, each channel `size` messages a minute apart. */
function guild(store: Store, acc: any, id: string, name: string, channels: string[], size: number) {
  store.ingest(acc, { t: 'space', space: { nativeId: id, kind: 'community', name } });
  store.ingest(acc, { t: 'space', space: { nativeId: `${id}-cat`, kind: 'section', name: 'Text', parents: [{ nativeId: id }] } });
  const all: Record<string, P.MessageFact[]> = {};
  for (const c of channels) {
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', name: c, spaces: [{ nativeId: `${id}-cat` }] } });
    all[c] = Array.from({ length: size }, (_, i) => ({ nativeId: `${c}-${i}`, conversation: c, author: PEER, ts: T0 + i * minute, body: `${c} message ${i}` }));
  }
  return all;
}

/** No reading pace: these tests are about what is fetched, readingpace.test.ts about how fast. */
const brisk = (store: Store, clock: FakeClock) => new ReadingPace(store, BRISK, clock);

const hub = (store: Store, network: P.Network, kind: 'conversation' | 'space', native: string) => (store.db.query(`SELECT id FROM ${kind} WHERE network = ? AND native_id = ?`).get(network, native) as any).id as string;

describe('index jobs', () => {
  test('page every channel of a server back to its start, then a repeat run fetches only what is new', async () => {
    const { store, acc } = world();
    const net = guild(store, acc, 'g1', 'Guild', ['c1', 'c2'], 250);
    // The hub has the newest 10 of c1 already, from live sync.
    for (const m of net.c1.slice(-10)) store.ingest(acc, { t: 'message', message: m, live: false });
    const clock = new FakeClock(T0 + 1000 * minute);
    const asked: { conversation: string; beforeTs: number; cursor?: string; pace?: string; limit: number }[] = [];
    const jobs = new Jobs(store, {
      online: () => true,
      clock,
      pace: brisk(store, clock),
      command: async (_a, cmd) => {
        expect(cmd.t).toBe('history');
        asked.push({ conversation: cmd.conversation, beforeTs: cmd.beforeTs, cursor: cmd.cursor, pace: cmd.pace, limit: cmd.limit });
        const below = net[cmd.conversation].filter((m) => m.ts < cmd.beforeTs);
        const page = below.slice(-cmd.limit);
        for (const m of page) store.ingest(acc, { t: 'message', message: m, live: false });
        // `next`: the oldest message's own id, as Discord's extractor answers.
        return { count: page.length, done: page.length === below.length, oldest: page[0]?.ts, next: page[0]?.nativeId };
      },
    });
    const v = jobs.create({ target: { kind: 'space', id: hub(store, 'discord', 'space', 'g1') }, history: true, members: false, repeatHours: 24 });
    expect(v).toMatchObject({ tasks: 2, state: 'running', current: 'c1', target: { name: 'Guild', network: 'discord' } });
    // The loop that starts repeating jobs when they are due.
    jobs.start();
    await clock.until(() => jobs.get(v.id)!.state === 'done', 600_000, 'the job');
    const done = jobs.get(v.id)!;
    expect(done).toMatchObject({ tasks: 2, done: 2, failed: 0, fetched: 490, pages: 10, nextRunAt: done.finishedAt! + 24 * 3_600_000 });
    expect(n(store, 'SELECT COUNT(*) AS n FROM message')).toBe(500);
    // Each channel is one span back to its start.
    expect(store.db.query('SELECT from_ts FROM history_span ORDER BY conversation_id').all()).toEqual([{ from_ts: 0 }, { from_ts: 0 }]);
    // Pages of 50, as the client scrolls, asked to be read like a person; each after the first goes back from the
    // message the one before ended on, by its own id.
    expect(PAGE).toBe(50);
    expect(asked.every((a) => a.limit === 50 && a.pace === 'read')).toBe(true);
    const c1 = asked.filter((a) => a.conversation === 'c1');
    expect(c1[0].cursor).toBeUndefined();
    expect(c1.slice(1).map((a) => a.cursor)).toEqual(['c1-200', 'c1-150', 'c1-100', 'c1-50']);

    // A day later, three new messages in c1: the next run asks one page per channel and stops at the span.
    net.c1.push(...[0, 1, 2].map((i) => ({ nativeId: `c1-new${i}`, conversation: 'c1', author: PEER, ts: clock.now() + i, body: 'new' })));
    asked.length = 0;
    // The loop is stopped while the clock skips to a minute before the repeat is due (stepping it through the day
    // fired 17,000 empty ticks), then started: it waits for that minute, and then starts the run.
    jobs.stop();
    await clock.advance(done.nextRunAt! - minute - clock.now());
    jobs.start();
    await clock.settle();
    expect(asked.length).toBe(0);
    expect(jobs.get(v.id)!.state).toBe('done');
    await clock.until(() => jobs.get(v.id)!.state === 'done' && asked.length > 0, 2 * minute, 'the repeat');
    expect(clock.now()).toBeGreaterThanOrEqual(done.nextRunAt!);
    jobs.stop();
    expect(asked.length).toBe(2);
    expect(jobs.get(v.id)).toMatchObject({ fetched: 3, pages: 2 });
  });

  test('threads under a channel and every server in a folder are planned; a place no account can fetch is skipped', () => {
    const { store, acc } = world();
    guild(store, acc, 'g1', 'One', ['a'], 0);
    guild(store, acc, 'g2', 'Two', ['b', 'c'], 0);
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 't1', shape: 'thread', name: 'a thread', parentConversation: 'a' } });
    store.setFolders([{ id: 'fld_x', name: 'Work', items: [{ kind: 'space', id: hub(store, 'discord', 'space', 'g1') }, { kind: 'space', id: hub(store, 'discord', 'space', 'g2') }] }]);
    const jobs = new Jobs(store, { online: () => false, command: async () => null });
    const places = jobs.places('folder', 'fld_x');
    expect(places.conversations.length).toBe(4);
    expect(places.spaces.length).toBe(2);
    const v = jobs.create({ target: { kind: 'folder', id: 'fld_x' }, history: true, members: true });
    expect(v).toMatchObject({ tasks: 6, skipped: 0, target: { name: 'Work', network: null } });

    const { store: s2, acc: a2 } = world(['send']);
    guild(s2, a2, 'g1', 'One', ['a'], 0);
    const j2 = new Jobs(s2, { online: () => true, command: async () => null });
    const none = j2.create({ target: { kind: 'space', id: hub(s2, 'discord', 'space', 'g1') }, history: true, members: true });
    expect(none).toMatchObject({ tasks: 0, skipped: 2 });
    j2.tick();
    expect(j2.get(none.id)).toMatchObject({ state: 'failed', error: 'None of your accounts can fetch this.' });

    // A voice channel's chat is paged but has no threads to list; a forum's posts are threads, with no history of its own.
    const { store: s3, acc: a3 } = world(['history', 'listThreads']);
    guild(s3, a3, 'g1', 'One', ['text'], 0);
    for (const [c, variant] of [['voice', 'voice'], ['forum', 'forum']] as const)
      s3.ingest(a3, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', variant, name: c, spaces: [{ nativeId: 'g1-cat' }] } });
    const j3 = new Jobs(s3, { online: () => false, command: async () => null });
    const v3 = j3.create({ target: { kind: 'space', id: hub(s3, 'discord', 'space', 'g1') }, history: true, members: false });
    const planned = s3.raw<{ kind: string; native_id: string }>('SELECT t.kind, c.native_id FROM job_task t JOIN conversation c ON c.id = t.target_id WHERE t.job_id = ? ORDER BY c.native_id, t.kind', v3.id);
    expect(planned.map((t) => `${t.kind} ${t.native_id}`)).toEqual(['threads forum', 'history text', 'threads text', 'history voice']);
  });

  test('threads under a channel are listed, archived ones too, and each found gets its history paged', async () => {
    const { store, acc } = world(['history', 'listThreads']);
    const net = guild(store, acc, 'g1', 'Guild', ['c1'], 5);
    // An archived thread under c1 the hub has never seen, with 3 messages.
    const thread: P.ConversationFact = { nativeId: 't9', shape: 'thread', name: 'old thread', parentConversation: 'c1' };
    net.t9 = [0, 1, 2].map((i) => ({ nativeId: `t9-${i}`, conversation: 't9', author: PEER, ts: T0 + i, body: `t ${i}` }));
    const clock = new FakeClock(T0 + 1000 * minute);
    const asked: string[] = [];
    let indexed = false;
    const jobs = new Jobs(store, {
      online: () => true,
      clock,
      pace: brisk(store, clock),
      command: async (_a, cmd) => {
        if (cmd.t === 'threads') {
          asked.push(`threads ${cmd.archived ? 'archived' : 'active'} ${cmd.offset}`);
          if (!cmd.archived) return { count: 0, more: false };
          // Discord's thread list is its search index: 202 the first time, so the same page is asked again.
          if (!indexed) {
            indexed = true;
            return { count: 0, more: false, retryAfterMs: 5000 };
          }
          store.ingest(acc, { t: 'conversation', conversation: thread });
          return { count: 1, more: false };
        }
        asked.push(`history ${cmd.conversation}`);
        const below = net[cmd.conversation].filter((m) => m.ts < cmd.beforeTs);
        for (const m of below) store.ingest(acc, { t: 'message', message: m, live: false });
        return { count: below.length, done: true, oldest: below[0]?.ts };
      },
    });
    const v = jobs.create({ target: { kind: 'space', id: hub(store, 'discord', 'space', 'g1') }, history: true, members: false });
    await clock.until(() => jobs.get(v.id)!.state === 'done', 600_000, 'the job');
    jobs.stop();
    // Threads first, so the thread's history is planned in this run.
    expect(asked.slice(0, 3)).toEqual(['threads active 0', 'threads archived 0', 'threads archived 0']);
    expect(asked.slice(3).sort()).toEqual(['history c1', 'history t9']);
    expect(jobs.get(v.id)).toMatchObject({ tasks: 3, done: 3, fetched: 8 });
  });

  test('a member walk widens a prefix that came back full, and keeps who it listed', async () => {
    const { store, acc } = world();
    guild(store, acc, 'g1', 'Big', [], 0);
    // 150 people named a…, 30 named b…: '' and 'a' come back full.
    const people = [...Array.from({ length: 150 }, (_, i) => `a${String(i).padStart(3, '0')}`), ...Array.from({ length: 30 }, (_, i) => `b${i}`)];
    for (const p of people) store.ingest(acc, { t: 'identity', identity: { nativeId: `u-${p}`, displayName: p } });
    const queries: string[] = [];
    const clock = new FakeClock(T0);
    const jobs = new Jobs(store, {
      online: () => true,
      clock,
      pace: brisk(store, clock),
      command: async (_a, cmd) => {
        expect(cmd.t).toBe('walkMembers');
        // No list of recent members here: answered without `next`, so the walk goes by name.
        if (cmd.recent) return { count: 0 };
        queries.push(cmd.query);
        const found = people.filter((p) => p.startsWith(cmd.query)).slice(0, cmd.limit);
        store.ingest(acc, { t: 'members', space: 'g1', source: 'walk', members: found.map((p) => ({ who: `u-${p}` })), total: people.length });
        return { count: found.length, total: people.length };
      },
    });
    const v = jobs.create({ target: { kind: 'space', id: hub(store, 'discord', 'space', 'g1') }, history: false, members: true });
    await clock.until(() => jobs.get(v.id)!.state === 'done', 3_600_000, 'the walk');
    jobs.stop();
    // Never an empty query: a user account may not send one.
    expect(queries).not.toContain('');
    // 'a' came back full: aa…a9 and the rest after it, before b.
    expect(queries.slice(0, 2)).toEqual(['a', 'aa']);
    expect(queries).toContain('a0');
    expect(queries).toContain('b');
    expect(queries).not.toContain('ba');
    // Kept though the passive members setting is off: you asked for this walk.
    expect(store.recordsMembers()).toBe(false);
    expect(n(store, `SELECT COUNT(*) AS n FROM membership WHERE source = 'walk'`)).toBe(180);
  });

  test('a member walk pages the recent members to the end, and a server too big for them as far as the list goes, never by name', async () => {
    const { store, acc } = world();
    guild(store, acc, 'g1', 'Mid', [], 0);
    guild(store, acc, 'g2', 'Huge', [], 0);
    // g1: 2,390 members in pages of 1,000, newest first, each page's `next` its oldest member.
    const mid = Array.from({ length: 2390 }, (_, i) => `m${i}`);
    const asked: string[] = [];
    const clock = new FakeClock(T0);
    const jobs = new Jobs(store, {
      online: () => true,
      clock,
      pace: brisk(store, clock),
      command: async (_a, cmd) => {
        expect(cmd.t).toBe('walkMembers');
        if (cmd.space === 'g2') {
          asked.push(`g2 ${cmd.recent ? `recent ${cmd.after ?? ''}` : cmd.query}`);
          if (cmd.recent) return { count: 1000, total: 50_000, next: `x${asked.length}` };
          return { count: 3, total: 50_000 };
        }
        expect(cmd.recent).toBe(true);
        asked.push(`g1 recent ${cmd.after ?? ''}`);
        const from = cmd.after ? mid.indexOf(cmd.after) + 1 : 0;
        const page = mid.slice(from, from + cmd.limit);
        store.ingest(acc, { t: 'members', space: 'g1', source: 'walk', members: page.slice(0, 500).map((p) => ({ who: `u-${p}` })), total: mid.length });
        store.ingest(acc, { t: 'members', space: 'g1', source: 'walk', members: page.slice(500).map((p) => ({ who: `u-${p}` })) });
        return { count: page.length, total: mid.length, next: page.length >= cmd.limit ? page[page.length - 1] : null };
      },
    });
    const a = jobs.create({ target: { kind: 'space', id: hub(store, 'discord', 'space', 'g1') }, history: false, members: true });
    await clock.until(() => jobs.get(a.id)!.state === 'done', 3_600_000, 'the recent walk');
    expect(asked).toEqual(['g1 recent ', 'g1 recent m999', 'g1 recent m1999']);
    expect(jobs.get(a.id)).toMatchObject({ membersListed: 2390 });
    expect(n(store, `SELECT COUNT(*) AS n FROM membership WHERE source = 'walk'`)).toBe(2390);
    // Over 10,000: the newest 10,000, a page at a time, and no member search for "a", "b", "c" after them.
    asked.length = 0;
    const b = jobs.create({ target: { kind: 'space', id: hub(store, 'discord', 'space', 'g2') }, history: false, members: true });
    await clock.until(() => jobs.get(b.id)!.state === 'done', 3_600_000, 'the walk');
    jobs.stop();
    expect(asked.length).toBe(10);
    expect(asked.every((a) => a.startsWith('g2 recent'))).toBe(true);
    expect(jobs.get(b.id)).toMatchObject({ membersListed: 10_000 });
  });

  test('pausing holds a job; a restart carries on from the cursor', async () => {
    const { store, acc } = world();
    const net = guild(store, acc, 'g1', 'Guild', ['c1'], 500);
    const clock = new FakeClock(T0 + 1000 * minute);
    let pages = 0;
    const command = async (_a: string, cmd: any) => {
      pages++;
      const below = net.c1.filter((m) => m.ts < cmd.beforeTs);
      const page = below.slice(-cmd.limit);
      for (const m of page) store.ingest(acc, { t: 'message', message: m, live: false });
      return { count: page.length, done: page.length === below.length, oldest: page[0]?.ts };
    };
    const jobs = new Jobs(store, { online: () => true, clock, command, pace: brisk(store, clock) });
    const v = jobs.create({ target: { kind: 'space', id: hub(store, 'discord', 'space', 'g1') }, history: true, members: false });
    await clock.until(() => pages >= 2, 60_000, 'two pages');
    jobs.pause(v.id);
    await clock.settle();
    const held = pages;
    await clock.until(() => false, 30_000, 'nothing').catch(() => {});
    expect(pages).toBe(held);
    expect(jobs.get(v.id)!.state).toBe('paused');
    jobs.stop();
    // A new hub over the same database.
    const again = new Jobs(store, { online: () => true, clock, command, pace: brisk(store, clock) });
    again.resume(v.id);
    await clock.until(() => again.get(v.id)!.state === 'done', 600_000, 'the rest');
    again.stop();
    expect(n(store, 'SELECT COUNT(*) AS n FROM message')).toBe(500);
    expect(pages).toBe(10);
  });
});

describe('network search', () => {
  test('asks the places jev ranks first, a few at a time and paced; keeps what it finds', async () => {
    const { store, acc } = world();
    const names = ['Rust', 'Climbing', 'Cooking', 'Speedrun', 'Music', 'Gardening', 'Chess', 'Films'];
    for (const [i, nm] of names.entries()) guild(store, acc, `g${i}`, nm, [`c${i}`], 0);
    // The Rust server has a message about lifetimes the hub has not stored.
    const remote: P.MessageFact = { nativeId: 'r1', conversation: 'c0', author: PEER, ts: T0, body: 'lifetimes are hard' };
    const clock = new FakeClock(T0 + 10 * minute);
    const asked: { scope: string; at: number }[] = [];
    const ns = new NetSearch(store, {
      online: () => true,
      clock,
      probe: async (q) => {
        expect(q).toContain('lifetimes');
        return { provider: 'jev', question: q, scores: names.map((nm, i) => ({ kind: 'space' as const, id: hub(store, 'discord', 'space', `g${i}`), p: nm === 'Rust' ? 0.9 : 0.1 - i * 0.01 })) };
      },
      command: async (_a, cmd) => {
        expect(cmd.t).toBe('search');
        asked.push({ scope: cmd.scope.id, at: clock.now() });
        if (cmd.scope.id !== 'g0') return { hits: [], total: 0, next: null };
        store.ingest(acc, { t: 'message', message: remote, live: false });
        return { hits: ['r1'], total: 1, next: null };
      },
    });
    const v = ns.start('lifetimes');
    await clock.until(() => asked.length >= BATCH && !ns.view(v.id)!.running, 120_000, 'the first batch');
    const after = ns.view(v.id)!;
    expect(after.ranked).toBe('jev');
    expect(asked[0].scope).toBe('g0');
    expect(asked.length).toBe(BATCH);
    // One search per account every few seconds.
    expect(asked.slice(1).map((x, i) => x.at - asked[i].at).every((d) => d >= GAP_MS.discord!)).toBe(true);
    expect(after.places[0]).toMatchObject({ name: 'Rust', state: 'done', found: 1, fresh: 1, total: 1 });
    expect(after.hits.map((h) => h.message.body)).toEqual(['lifetimes are hard']);
    expect(after.hits[0].snippet).toContain('\u0001lifetimes\u0002');
    expect(after.left).toBe(names.length - BATCH);
    // Stored like any backfill: the hub's own search finds it now.
    expect(store.search('lifetimes').hits.length).toBe(1);
    // More: the rest.
    await ns.more(v.id);
    await clock.until(() => !ns.view(v.id)!.running, 120_000, 'the rest');
    expect(asked.length).toBe(names.length);
    expect(ns.view(v.id)!.left).toBe(0);
  });

  test('a place Discord is still indexing is asked again after its wait, and if it still is, says so', async () => {
    const { store, acc } = world();
    guild(store, acc, 'g1', 'New', ['a'], 0);
    guild(store, acc, 'g2', 'Slow', ['b'], 0);
    const clock = new FakeClock(T0);
    const asked: string[] = [];
    const ns = new NetSearch(store, {
      online: () => true,
      clock,
      command: async (_a, cmd) => {
        asked.push(cmd.scope.id);
        // g1 is indexed by the second ask; g2 never in time (Discord said 1 s each time).
        if (cmd.scope.id === 'g2' || asked.filter((x) => x === 'g1').length === 1) return { hits: [], total: null, next: null, retryAfterMs: 1000 };
        return { hits: [], total: 0, next: null };
      },
    });
    const v = ns.start('hello');
    await clock.until(() => ns.view(v.id)!.places.length === 2 && !ns.view(v.id)!.running, 120_000, 'both places');
    const places = Object.fromEntries(ns.view(v.id)!.places.map((p) => [p.name, p]));
    expect(places.New).toMatchObject({ state: 'done', total: 0 });
    expect(places.Slow).toMatchObject({ state: 'failed', error: expect.stringContaining('still indexing') });
    expect(asked.filter((x) => x === 'g1')).toHaveLength(2);
    expect(asked.filter((x) => x === 'g2')).toHaveLength(3);
  });

  test('filters narrow the places; no capable account, deleted messages and an hourly cap say why', async () => {
    const { store, acc } = world();
    guild(store, acc, 'g1', 'One', ['a'], 0);
    guild(store, acc, 'g2', 'Two', ['b'], 0);
    const clock = new FakeClock(T0);
    let calls = 0;
    const ns = new NetSearch(store, { online: () => true, clock, command: async () => (calls++, { hits: [], total: 0, next: null }) });
    // in: a channel searches only its server, and only that channel in it.
    const v = ns.start('hello in:a');
    expect(ns.view(v.id)!.places.length).toBe(0);
    await clock.until(() => ns.view(v.id)!.places.length === 1 && !ns.view(v.id)!.running, 30_000, 'in:');
    expect(ns.view(v.id)!.places[0]).toMatchObject({ name: 'One', kind: 'space' });
    expect(ns.view(v.id)!.ranked).toBe('local');
    expect(ns.start('x is:deleted').note).toContain('Deleted');
    expect(ns.start('').note).toContain('Type');
    expect(ns.start('hello network:matrix').note).toContain('no place');

    const { store: s2 } = world(['history']);
    expect(new NetSearch(s2, { online: () => true, command: async () => null }).start('hi').note).toContain('None of your accounts');

    // Past the hourly cap, a place is held back rather than asked.
    for (let i = 0; calls < HOURLY_CAP && i < HOURLY_CAP; i++) {
      const s = ns.start(`word${i}`);
      await ns.more(s.id);
      await clock.until(() => !ns.view(s.id)!.running, 600_000, 'a search');
    }
    expect(calls).toBe(HOURLY_CAP);
    const held = ns.start('one more');
    await clock.until(() => !ns.view(held.id)!.running && ns.view(held.id)!.places.length > 0, 60_000, 'held');
    expect(ns.view(held.id)!.places[0].error).toContain('Held back');
  });
});
