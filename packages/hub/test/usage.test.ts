/**
 * Usage and automatic order: the decayed totals, the smart score, and the hub's table and API (docs/organize.md).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDecayed, cleanDelta, decayed, smartScore, USAGE_HALF_LIFE, type UsageState } from '@dither-chat/protocol';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { UsageStore } from '../src/usage.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

describe('decay', () => {
  test('halves each week', () => {
    expect(decayed(100, T0, T0 + USAGE_HALF_LIFE)).toBeCloseTo(50);
    expect(decayed(100, T0, T0 + 2 * USAGE_HALF_LIFE)).toBeCloseTo(25);
    expect(USAGE_HALF_LIFE).toBe(7 * DAY);
  });

  test('batches give the same total in any order', () => {
    const ds = [
      { seconds: 600, visits: 2, at: T0 },
      { seconds: 60, visits: 1, at: T0 + 3 * DAY },
      { seconds: 1200, visits: 4, at: T0 + 1 * DAY },
    ];
    const fold = (xs: typeof ds) => xs.reduce<ReturnType<typeof addDecayed> | null>((a, d) => addDecayed(a, d), null)!;
    const a = fold(ds);
    const b = fold([ds[2], ds[0], ds[1]]);
    expect(a.at).toBe(T0 + 3 * DAY);
    expect(b.at).toBe(a.at);
    expect(b.score).toBeCloseTo(a.score, 6);
    expect(b.visitScore).toBeCloseTo(a.visitScore, 6);
    // The same as decaying each one by hand to the latest time.
    expect(a.score).toBeCloseTo(600 * 2 ** (-3 / 7) + 60 + 1200 * 2 ** (-2 / 7), 6);
  });
});

describe('smart score', () => {
  const now = T0 + 10 * DAY;
  const u = (minutes: number, visits: number, lastVisitDaysAgo: number | null, atDaysAgo = 0) => ({ score: minutes * 60, visitScore: visits, at: now - atDaysAgo * DAY, lastVisit: lastVisitDaysAgo === null ? null : now - lastVisitDaysAgo * DAY });

  test('time and visits count in minutes, and fade with the week', () => {
    expect(smartScore(u(30, 0, null), now)).toBeCloseTo(30);
    expect(smartScore(u(30, 0, null, 7), now)).toBeCloseTo(15);
    expect(smartScore(u(0, 10, null), now)).toBeCloseTo(10);
  });

  test('a habit beats a single recent visit; recency separates otherwise equal places', () => {
    const habit = smartScore(u(300, 70, 2), now);
    const once = smartScore(u(2, 1, 0), now);
    expect(habit).toBeGreaterThan(once);
    expect(smartScore(u(10, 2, 0), now)).toBeGreaterThan(smartScore(u(10, 2, 3), now));
    // The recency bonus halves in a day.
    expect(smartScore(u(0, 0, 1), now)).toBeCloseTo(smartScore(u(0, 0, 0), now) / 2);
  });

  test('unread mentions nudge, capped', () => {
    expect(smartScore(null, now, 1)).toBe(10);
    expect(smartScore(null, now, 3)).toBe(30);
    expect(smartScore(null, now, 50)).toBe(30);
    // Not enough to beat a real habit.
    expect(smartScore(u(300, 70, 1), now, 0)).toBeGreaterThan(smartScore(u(5, 2, 4), now, 50));
  });
});

describe('what the hub accepts', () => {
  const now = T0;
  test('only ids, seconds and times; nonsense is dropped or clamped', () => {
    expect(cleanDelta({ kind: 'space', id: 's1', seconds: 30, visits: 1, at: now }, now)).toEqual({ kind: 'space', id: 's1', seconds: 30, visits: 1, at: now, lastVisit: null });
    expect(cleanDelta({ kind: 'message' as any, id: 'x', seconds: 30, visits: 0, at: now }, now)).toBeNull();
    expect(cleanDelta({ kind: 'space', id: '', seconds: 30, visits: 0, at: now }, now)).toBeNull();
    expect(cleanDelta({ kind: 'space', id: 's', seconds: 0, visits: 0, at: now }, now)).toBeNull();
    expect(cleanDelta({ kind: 'space', id: 's', seconds: 1e9, visits: 1e9, at: now }, now)).toMatchObject({ seconds: 3600, visits: 100 });
    // A clock in the future or a batch from long ago lands inside the window.
    expect(cleanDelta({ kind: 'space', id: 's', seconds: 1, visits: 0, at: now + DAY }, now)!.at).toBe(now);
    expect(cleanDelta({ kind: 'space', id: 's', seconds: 1, visits: 0, at: now - 400 * DAY }, now)!.at).toBe(now - 30 * DAY);
  });
});

describe('the table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-usage-'));
  const store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const usage = new UsageStore(store.db);
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('adds batches up, decayed, and counts a resent batch once', () => {
    expect(usage.apply('b1', [{ kind: 'space', id: 's1', seconds: 600, visits: 1, at: T0, lastVisit: T0 }], T0)).toBe(1);
    expect(usage.apply('b1', [{ kind: 'space', id: 's1', seconds: 600, visits: 1, at: T0, lastVisit: T0 }], T0)).toBe(0);
    usage.apply('b2', [{ kind: 'space', id: 's1', seconds: 300, visits: 2, at: T0 + 7 * DAY, lastVisit: T0 + 7 * DAY }], T0 + 7 * DAY);
    const [s1] = usage.list();
    expect(s1.score).toBeCloseTo(600 / 2 + 300);
    expect(s1.visitScore).toBeCloseTo(1 / 2 + 2);
    expect(s1.seconds).toBe(900);
    expect(s1.visits).toBe(3);
    expect(s1.lastVisit).toBe(T0 + 7 * DAY);
    expect(s1.at).toBe(T0 + 7 * DAY);
  });

  test('a late batch from another device does not move the total back in time', () => {
    usage.apply('b3', [{ kind: 'space', id: 's1', seconds: 600, visits: 0, at: T0, lastVisit: null }], T0 + 7 * DAY);
    const [s1] = usage.list();
    expect(s1.at).toBe(T0 + 7 * DAY);
    expect(s1.score).toBeCloseTo(600 / 2 + 300 + 600 / 2);
    expect(s1.lastVisit).toBe(T0 + 7 * DAY);
  });

  test('forgets places untouched for months once nothing is left of them (s1 and p1 here)', () => {
    usage.apply('b4', [{ kind: 'person', id: 'p1', seconds: 5, visits: 0, at: T0, lastVisit: null }], T0);
    expect(usage.list().some((u) => u.id === 'p1')).toBe(true);
    usage.apply('b5', [{ kind: 'space', id: 's2', seconds: 5, visits: 0, at: T0 + 200 * DAY }], T0 + 200 * DAY);
    expect(usage.list().map((u) => u.id)).toEqual(['s2']);
  });

  test('reset: one place, or everything', () => {
    usage.apply('b6', [{ kind: 'conversation', id: 'c1', seconds: 5, visits: 1, at: T0 + 200 * DAY }], T0 + 200 * DAY);
    usage.reset({ kind: 'space', id: 's2' });
    expect(usage.list().map((u) => u.id)).toEqual(['c1']);
    usage.reset();
    expect(usage.list()).toEqual([]);
  });

  test('sort settings: Manual by default for the rail, per scope, and only known values', () => {
    expect(usage.arrange().sort).toEqual({ rail: 'manual', people: 'recent' });
    usage.patchArrange({ sort: { rail: 'smart', people: 'manual', other: 'az' } as any });
    expect(usage.arrange().sort).toEqual({ rail: 'smart', people: 'recent' });
    usage.patchArrange({ dismissed: { cat1: ['space:a', 'space:b'] } });
    usage.patchArrange({ sort: { people: 'az' } });
    expect(usage.arrange()).toEqual({ sort: { rail: 'smart', people: 'az' }, dismissed: { cat1: ['space:a', 'space:b'] } });
    // The Groups list's scope from before it joined the inbox: kept on disk by older hubs, never shown.
    store.db.query(`UPDATE arrange_setting SET value = ? WHERE key = 'sort'`).run(JSON.stringify({ rail: 'az', people: 'smart', groups: 'smart' }));
    expect(usage.arrange().sort).toEqual({ rail: 'az', people: 'smart' });
    usage.patchArrange({ dismissed: { cat1: null } });
    expect(usage.arrange().dismissed).toEqual({});
  });
});

describe('the API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-usage-api-'));
  let port = 0;
  let server: HubServer;
  let store: Store;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const json = { 'content-type': 'application/json' };

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = { authorize: () => null, online: () => false } as any;
    server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = server.start().port!;
  });
  afterAll(() => {
    server.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a batch in, the totals and settings out, and a reset', async () => {
    const now = Date.now();
    const post = (batch: string) =>
      fetch(url('/api/usage'), { method: 'POST', headers: json, body: JSON.stringify({ batch, deltas: [{ kind: 'conversation', id: 'c1', seconds: 42, visits: 1, at: now, lastVisit: now }, { kind: 'bogus', id: 'x', seconds: 1 }] }) }).then((r) => r.json());
    expect(await post('x1')).toEqual({ applied: 1 });
    expect(await post('x1')).toEqual({ applied: 0 });
    const s = (await fetch(url('/api/usage')).then((r) => r.json())) as UsageState;
    expect(s.places).toHaveLength(1);
    expect(s.places[0]).toMatchObject({ kind: 'conversation', id: 'c1', seconds: 42, visits: 1, lastVisit: now });
    expect(s.arrange.sort.rail).toBe('manual');
    expect(s.halfLife).toBe(USAGE_HALF_LIFE);

    const a = await fetch(url('/api/arrange'), { method: 'PATCH', headers: json, body: JSON.stringify({ sort: { rail: 'smart' } }) }).then((r) => r.json());
    expect(a.sort.rail).toBe('smart');

    await fetch(url('/api/usage'), { method: 'DELETE', headers: json, body: '{}' });
    const after = (await fetch(url('/api/usage')).then((r) => r.json())) as UsageState;
    expect(after.places).toEqual([]);
    // Resetting usage keeps the chosen order.
    expect(after.arrange.sort.rail).toBe('smart');
  });
});
