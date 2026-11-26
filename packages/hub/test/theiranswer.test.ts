/**
 * When they are likely to answer you (theiranswer.ts, docs/profile.md "When they answer"): your turns and their
 * answers, time as they live it, and the estimate from a database: a message at their bedtime waits for their morning,
 * one in their afternoon is answered soon, and waiting longer moves it later.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { HOUR, offsetAt } from '../src/activitychart.ts';
import { rhythmTimes } from '../src/demo-clocks.ts';
import { HubServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Answers, awake, estimate, rates, turnsOf, type Seen } from '../src/theiranswer.ts';
import { Clocks } from '../src/theirclock.ts';
import { Triage } from '../src/triage.ts';

const MIN = 60_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 18, 0);
const TOKYO = { tz: 'Asia/Tokyo' };
/** Tokyo's hour at a moment. */
const tokyoHour = (t: number) => (((t + offsetAt(TOKYO, t)) % DAY) + DAY) % DAY / HOUR;

describe('turns', () => {
  const me = new Set(['me']);
  test('the first of a run of yours, answered by their next message; the quiet before it; a week without an answer is none', () => {
    const t = NOW - 30 * DAY;
    const { turns, open } = turnsOf(
      [
        ['them', t],
        ['me', t + 10 * MIN],
        ['me', t + 11 * MIN],
        ['them', t + 40 * MIN],
        ['me', t + 2 * DAY],
        ['them', t + 10 * DAY],
        ['them', t + 10 * DAY + MIN],
      ],
      me,
      NOW,
    );
    expect(turns).toEqual([
      { t0: t + 10 * MIN, gap: 10 * MIN, lat: 30 * MIN },
      { t0: t + 2 * DAY, gap: 2 * DAY - 40 * MIN, lat: null },
    ]);
    // The last word is theirs: for a message sent now, after the quiet since.
    expect(open).toEqual({ t0: NOW, gap: NOW - (t + 10 * DAY + MIN), waiting: false });
  });

  test("this week's turns are left out, answered or not: only their quick answers are known yet", () => {
    const { turns, open } = turnsOf(
      [
        ['me', NOW - 3 * DAY],
        ['them', NOW - 3 * DAY + 5 * MIN],
        ['me', NOW - HOUR],
      ],
      me,
      NOW,
    );
    expect(turns).toEqual([]);
    expect(open).toEqual({ t0: NOW - HOUR, gap: 3 * DAY - HOUR - 5 * MIN, waiting: true });
  });

  test('a message of yours unanswered for over a week is a turn without an answer, and nothing is waiting', () => {
    const { turns, open } = turnsOf([['me', NOW - 9 * DAY]], me, NOW);
    expect(turns).toEqual([{ t0: NOW - 9 * DAY, gap: 30 * DAY, lat: null }]);
    expect(open.waiting).toBe(false);
  });
});

describe('time as they live it', () => {
  // Around every day from 9 to 23 UTC, never at night.
  const hours = new Set<number>();
  for (let d = 1; d <= 60; d++) for (let h = 9; h < 23; h++) hours.add(Math.floor((NOW - d * DAY) / HOUR / 24) * 24 + h);
  const r = rates(hours, NOW);

  test('their hours count more than their nights, and a day is a day', () => {
    expect(r.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1, 6);
    expect(r[3]).toBeLessThan(0.1);
    expect(r[12]).toBeGreaterThan(1.4);
    const night = Date.UTC(2026, 10, 20, 1, 0);
    const noon = Date.UTC(2026, 10, 20, 12, 0);
    expect(awake(r, night, 6 * HOUR)).toBeLessThan(HOUR);
    expect(awake(r, noon, 6 * HOUR)).toBeGreaterThan(8 * HOUR);
    expect(awake(r, night, 2 * DAY + 3 * HOUR)).toBeCloseTo(2 * DAY + awake(r, night, 3 * HOUR), -3);
  });

  test('nobody seen: flat', () => {
    expect(rates(new Set(), NOW)).toEqual(new Array(24).fill(1));
  });

  test('an estimate: someone who answers in about 20 of their minutes, written to at their night, answers in their morning', () => {
    const theirs: Seen[] = Array.from({ length: 60 }, (_, i) => ({ gap: 3 * HOUR, v: (10 + i) * MIN, w: 1 }));
    const night = Date.UTC(2026, 10, 20, 2, 0);
    const n = estimate(theirs, [], r, night, 3 * HOUR, night);
    expect(utcHour(n.half!)).toBeGreaterThanOrEqual(9);
    expect(utcHour(n.half!)).toBeLessThan(11);
    const noon = Date.UTC(2026, 10, 20, 12, 0);
    const d = estimate(theirs, [], r, noon, 3 * HOUR, noon);
    expect(d.half! - noon).toBeLessThan(40 * MIN);
    expect(d.by[1]).toBeGreaterThan(90);
    expect(d.week).toBe(100);
    // Waiting moves it later: past every answer they gave, only everyone's are left to go by.
    const late = estimate(theirs, [{ gap: 3 * HOUR, v: 5 * HOUR, w: 1 }], r, noon, 3 * HOUR, noon + 3 * HOUR);
    expect(late.half!).toBeGreaterThan(noon + 3 * HOUR);
    expect(late.by.every((p, i) => i === 0 || p >= late.by[i - 1])).toBe(true);
  });

  test('someone who mostly does not answer: no half within the week', () => {
    const theirs: Seen[] = Array.from({ length: 20 }, (_, i) => ({ gap: DAY, v: i < 4 ? HOUR : null, w: 1 }));
    const e = estimate(theirs, [], r, NOW, DAY, NOW);
    expect(e.half).toBeNull();
    expect(e.week).toBeLessThan(30);
  });
});
/** The UTC hour of a moment. */
const utcHour = (t: number) => new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;

describe('from the database, and the endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-theiranswer-'));
  let store: Store;
  let hub: HubServer;
  let port = 0;
  const ann = hubId('idn', 'signal', 'ann');
  const annD = hubId('idn', 'discord', 'ann-d');
  const night = NOW; // 3 AM in Tokyo
  let afternoon = 0;
  const answers = (now: number) => new Answers({ db: store.db, clocks: new Clocks({ db: store.db, now: () => now }), now: () => now });

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    store.db.transaction(() => {
      const sig = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
      const dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
      store.ingest(sig, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me', isSelf: true } });
      store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
      store.ingest(sig, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
      store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann-d', displayName: 'Ann' } });
      store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me', 'ann'] } });
      store.ingest(dc, { t: 'conversation', conversation: { nativeId: 'dm-ann-d', shape: 'direct', participants: ['dme', 'ann-d'] } });
      store.mergePersons(store.ensurePerson(ann), store.ensurePerson(annD));
      // Ann in Tokyo: you write on Signal before each burst of hers, 5 to 30 minutes before, or in her night before
      // her first of the day; she answers on Discord as often as on Signal.
      const theirs = rhythmTimes({ zone: 'Asia/Tokyo', wake: 8, sleep: 24.5, perDay: 8, active: 0.9 }, 90, NOW + 2 * DAY, 5);
      let k = 0;
      const mine = (ts: number) => store.ingest(sig, { t: 'message', message: { nativeId: `m${k++}`, conversation: 'dm-ann', author: 'me', ts, body: 'x' } });
      theirs.forEach((ts, i) => {
        const before = theirs[i - 1];
        if (ts < night - 3 * DAY && (before === undefined || ts - before > HOUR)) mine(ts - before > 6 * HOUR && tokyoHour(ts) < 11 ? before + 2 * HOUR : ts - (5 + ((i * 7) % 25)) * MIN);
        if (i % 2) store.ingest(sig, { t: 'message', message: { nativeId: `s${i}`, conversation: 'dm-ann', author: 'ann', ts, body: 'x' } });
        else store.ingest(dc, { t: 'message', message: { nativeId: `d${i}`, conversation: 'dm-ann-d', author: 'ann-d', ts, body: 'x' } });
      });
      // Waiting at her 3 AM; and, in her day before that, a minute before a burst of hers.
      mine(night - 5 * MIN);
      const next = theirs.find((t, i) => t > night - 2 * DAY && tokyoHour(t) >= 10 && tokyoHour(t) < 22 && t - theirs[i - 1] > HOUR)!;
      afternoon = next - MIN;
      mine(next - 2 * MIN);
    })();
    store.flush();
    hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('written at her 3 AM: waiting, and likely answered in her morning', () => {
    const v = answers(night).answer(ann)!;
    expect(v.waiting).toBe(night - 5 * MIN);
    expect(v.turns).toBeGreaterThan(80);
    expect(v.own).toBeGreaterThan(0.9);
    expect(tokyoHour(v.half!)).toBeGreaterThanOrEqual(7);
    expect(tokyoHour(v.half!)).toBeLessThan(11);
    expect(v.by[0]).toBeLessThan(20);
    expect(v.by[0]).toBeLessThan(v.by[15]);
    expect(v.by.length).toBe(48);
  });

  test('written in her day: likely within the hour; her answers on Discord count for your Signal messages', () => {
    const v = answers(afternoon).answer(annD)!;
    expect(v.waiting).toBe(afternoon - MIN);
    expect(v.half! - afternoon).toBeLessThan(HOUR);
    expect(v.likely!).toBeGreaterThan(v.half!);
    expect(v.week).toBeGreaterThan(90);
  });

  test('once she has answered, it is for a message sent now; nothing for you', () => {
    const v = answers(afternoon + 2 * MIN).answer(ann)!;
    expect(v.waiting).toBeNull();
    expect(answers(night).answer(hubId('idn', 'signal', 'me'))).toBeNull();
    expect(answers(night).answer('idn_nobody')).toBeNull();
  });

  test('the endpoint: her estimate as of now; nobody is 404', async () => {
    const get = (q: string) => fetch(`http://127.0.0.1:${port}${q}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const r = await get(`/api/people/${ann}/answer`);
    expect(r.status).toBe(200);
    const v = (await r.json()) as P.TheirAnswerView;
    expect(v.by.length).toBe(48);
    expect(v.turns).toBeGreaterThan(0);
    expect((await get('/api/people/idn_nobody/answer')).status).toBe(404);
  });
});
