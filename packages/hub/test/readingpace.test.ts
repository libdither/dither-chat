/**
 * The reading pace (readingpace.ts, docs/indexing.md "Reading pace"): its hours, sessions, breaks and daily cap, and
 * an index job run through a simulated day at that pace. Times are local, as the pace's are.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { Jobs } from '../src/jobs.ts';
import { READING, ReadingPace } from '../src/readingpace.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { FakeClock } from './fixtures/clock.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Local time on 2026-05-01 (or a later day). */
const at = (h: number, m = 0, day = 1) => new Date(2026, 4, day, h, m).getTime();
/** The pace's draws from a seed (mulberry32): the same run every time. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world() {
  const store = new Store(':memory:', mediaSigner('s'));
  let acc = store.createAccount({ id: 'acc_dc', network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'hello', network: 'discord', version: 'test', capabilities: ['history'] });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: '1', isSelf: true } });
  acc = store.account('acc_dc')!;
  store.ingest(acc, { t: 'identity', identity: { nativeId: '2', displayName: 'peer' } });
  return { store, acc };
}

describe('reading pace', () => {
  test('hours run past midnight, and a reading day from one start of them to the next', () => {
    const { store } = world();
    const pace = new ReadingPace(store, READING, new FakeClock(at(12)), seeded(1));
    expect([at(8, 59), at(9), at(23, 30), at(0, 30, 2), at(1, 0, 2), at(3, 0, 2)].map((t) => pace.inHours(t))).toEqual([false, true, true, true, false, false]);
    expect(pace.dayOf(at(0, 30, 2))).toBe(pace.dayOf(at(10)));
    expect(pace.dayOf(at(9, 0, 2))).not.toBe(pace.dayOf(at(10)));
    expect(pace.nextStart(at(3))).toBe(at(9));
    expect(pace.nextStart(at(9))).toBe(at(9, 0, 2));
    const allDay = new ReadingPace(store, { ...READING, hours: [0, 0] }, new FakeClock(at(3)));
    expect(allDay.inHours(at(3))).toBe(true);
  });

  test('out of hours it waits for them, starting a little late; in them, sessions with a break after each', () => {
    const { store } = world();
    const clock = new FakeClock(at(3));
    const pace = new ReadingPace(store, READING, clock, seeded(2));
    const w = pace.wait('acc_dc', 'jobs');
    expect(w).toBeGreaterThanOrEqual(at(9) - at(3));
    expect(w).toBeLessThanOrEqual(at(9, 40) - at(3));
    expect(pace.resting('acc_dc')).toMatchObject({ why: 'hours' });
    // Asked again, the same start: not a new draw every time.
    expect(pace.wait('acc_dc', 'jobs')).toBe(w);

    clock.now = () => at(10);
    expect(pace.wait('acc_dc', 'jobs')).toBe(0);
    expect(pace.resting('acc_dc')).toBeNull();
    // A page of 50 is read for a while before the next: 2.5 to 5 s, and a quarter to 0.7 s a message.
    const p = pace.read('acc_dc', 'jobs', 50);
    expect(p).toBeGreaterThanOrEqual(2500 + 50 * 250);
    expect(p).toBeLessThanOrEqual(5000 + 50 * 700);
    // The session lasts 5 to 20 minutes, then a break of 10 to 45.
    clock.now = () => at(10, 4);
    expect(pace.wait('acc_dc', 'jobs')).toBe(0);
    clock.now = () => at(10, 21);
    const rest = pace.wait('acc_dc', 'jobs');
    expect(rest).toBeGreaterThanOrEqual(10 * MIN);
    expect(rest).toBeLessThanOrEqual(45 * MIN);
    expect(pace.resting('acc_dc')).toMatchObject({ why: 'break' });
  });

  test("the day's share: read, it rests to the next day's hours; a restart keeps the count", () => {
    const { store } = world();
    const clock = new FakeClock(at(11));
    const pace = new ReadingPace(store, { ...READING, session: [Infinity, Infinity] }, clock, seeded(4));
    expect(pace.wait('acc_dc', 'jobs')).toBe(0);
    pace.read('acc_dc', 'jobs', 2990);
    expect(pace.wait('acc_dc', 'jobs')).toBe(0);
    // A new hub over the same database: still 2,990 today.
    const again = new ReadingPace(store, { ...READING, session: [Infinity, Infinity] }, clock, seeded(5));
    expect(again.today('acc_dc')).toBe(2990);
    again.read('acc_dc', 'jobs', 50);
    const w = again.wait('acc_dc', 'jobs');
    expect(clock.now() + w).toBeGreaterThanOrEqual(at(9, 0, 2));
    expect(again.resting('acc_dc')).toMatchObject({ why: 'cap' });
    // Past midnight, still the same reading day.
    clock.now = () => at(0, 30, 2);
    expect(again.wait('acc_dc', 'jobs')).toBeGreaterThan(0);
    // The next day's hours: a fresh share.
    clock.now = () => at(11, 0, 2);
    expect(again.wait('acc_dc', 'jobs')).toBe(0);
    expect(again.today('acc_dc')).toBe(0);
  });

  test('one reader per account at a time', () => {
    const { store } = world();
    const clock = new FakeClock(at(11));
    const pace = new ReadingPace(store, READING, clock, seeded(2));
    expect(pace.wait('acc_dc', 'jobs')).toBe(0);
    pace.read('acc_dc', 'jobs', 10);
    expect(pace.wait('acc_dc', 'gapfill')).toBeGreaterThan(0);
    pace.release('acc_dc', 'jobs');
    expect(pace.wait('acc_dc', 'gapfill')).toBe(0);
  });

  test('an index job through a day: only in hours, in sessions with breaks, no more than the cap', async () => {
    const { store, acc } = world();
    store.ingest(acc, { t: 'space', space: { nativeId: 'g1', kind: 'community', name: 'Big' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c1', shape: 'channel', name: 'c1', spaces: [{ nativeId: 'g1' }] } });
    // 8,000 messages a minute apart, ending a week before.
    const start = at(8);
    const net: P.MessageFact[] = Array.from({ length: 8000 }, (_, i) => ({ nativeId: `m${i}`, conversation: 'c1', author: '2', ts: start - 7 * 24 * HOUR - (8000 - i) * MIN, body: `m${i}` }));
    const clock = new FakeClock(start);
    const asked: { at: number; cursor?: string }[] = [];
    let defer = true;
    const jobs = new Jobs(store, {
      online: () => true,
      clock,
      pace: new ReadingPace(store, READING, clock, seeded(3)),
      command: async (_a, cmd) => {
        expect(cmd.t).toBe('history');
        // The first time the extractor cannot read (the owner is in the live view): nothing fetched, asked again later.
        if (defer) {
          defer = false;
          asked.push({ at: clock.now() });
          return { count: 0, done: false, deferMs: 2 * MIN };
        }
        asked.push({ at: clock.now(), cursor: cmd.cursor });
        const below = net.filter((m) => m.ts < cmd.beforeTs);
        const page = below.slice(-cmd.limit);
        for (const m of page) store.ingest(acc, { t: 'message', message: m, live: false });
        return { count: page.length, done: page.length === below.length, oldest: page[0]?.ts, next: page[0]?.nativeId };
      },
    });
    const v = jobs.create({ target: { kind: 'space', id: (store.db.query(`SELECT id FROM space WHERE native_id = 'g1'`).get() as any).id }, history: true, members: false });
    // Before 9:00 nothing; the job says why.
    await clock.until(() => clock.now() >= at(8, 50), 2 * HOUR, 'the morning');
    expect(asked.length).toBe(0);
    expect(jobs.get(v.id)!.resting).toMatchObject({ why: 'hours' });
    // The day's share is read well before the evening: resting for that, not the hours.
    await clock.until(() => clock.now() >= at(23), 16 * HOUR, 'the evening');
    expect(jobs.get(v.id)!.resting).toMatchObject({ why: 'cap' });
    await clock.until(() => clock.now() >= at(8, 0, 2), 10 * HOUR, 'the night');
    jobs.stop();
    expect(asked[0].at).toBeGreaterThanOrEqual(at(9));
    // The deferred ask was not a page: the next came two minutes later, and from the top.
    expect(asked[1].at - asked[0].at).toBeGreaterThanOrEqual(2 * MIN);
    expect(asked[1].cursor).toBeUndefined();
    const pages = asked.slice(1);
    // All in hours.
    expect(pages.every((p) => p.at >= at(9) && p.at < at(1, 0, 2))).toBe(true);
    // No more than the day's share (a page may finish past it).
    const day1 = (store.db.query('SELECT COUNT(*) AS n FROM message').get() as any).n as number;
    expect(day1).toBeGreaterThanOrEqual(READING.dailyCap);
    expect(day1).toBeLessThan(READING.dailyCap + 50);
    // A page of 50 is at least 15 s after the one before; breaks of 10 minutes or more come at least every 20 minutes.
    const gaps = pages.slice(1).map((p, i) => p.at - pages[i].at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2500 + 50 * 250);
    let run = 0;
    let longest = 0;
    for (const g of gaps) {
      if (g >= 10 * MIN) run = 0;
      else run += g;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(20 * MIN + 45_000);
    expect(gaps.filter((g) => g >= 10 * MIN).length).toBeGreaterThanOrEqual(1);
    // Each page went back from the one before by its oldest message's id.
    expect(pages.slice(1).every((p, i) => p.cursor === `m${8000 - 50 * (i + 1)}`)).toBe(true);
  });
});
