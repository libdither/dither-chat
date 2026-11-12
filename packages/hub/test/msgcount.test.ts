/**
 * Message counts estimated from what the hub holds (msgcount.ts): the Wilson interval, a channel's age from its
 * snowflake, the unseen stretch, and the endpoint over a real store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DISCORD_EPOCH, binsFor, estimateMessages, snowflakeTime, unseenOf, wilson, type ChannelInput } from '../src/msgcount.ts';
import { HubServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const sf = (t: number, seq = 0) => String((BigInt(Math.round(t - DISCORD_EPOCH)) << 22n) + BigInt(seq));

/** A channel made `age` days ago, held for its last `held` days at `perDay` messages a day, `share` of them theirs. */
function channel(age: number, held: number, perDay: number, share: number, x: Partial<ChannelInput> = {}): ChannelInput {
  const oldest = NOW - held * DAY;
  const captured = Math.round(held * perDay);
  const { count } = binsFor(oldest, NOW);
  const bins = new Array(count).fill(Math.round(captured / count));
  return { network: 'discord', nativeId: sf(NOW - age * DAY), captured, oldest, newest: NOW, bins, authored: Math.round(captured * share), ...x };
}

describe('wilson', () => {
  test('no sample is no knowledge', () => expect(wilson(0, 0)).toEqual([0, 1]));
  test('zero and all keep their hard edge', () => {
    const [lo0, hi0] = wilson(0, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 3);
    const [lo1, hi1] = wilson(10, 10);
    expect(hi1).toBe(1);
    expect(lo1).toBeCloseTo(0.7225, 3);
  });
  test('a tiny sample is wide; a big one narrow, both around the share', () => {
    const [a, b] = wilson(1, 2);
    expect(b - a).toBeGreaterThan(0.8);
    const [c, d] = wilson(500, 1000);
    expect(c).toBeLessThan(0.5);
    expect(d).toBeGreaterThan(0.5);
    expect(d - c).toBeLessThan(0.07);
  });
});

describe('snowflakes', () => {
  test('dates a Discord id, and nothing else', () => {
    const t = Date.UTC(2021, 0, 1);
    expect(snowflakeTime(sf(t, 4095), NOW)).toBe(t);
    expect(snowflakeTime('!room:matrix.org', NOW)).toBeNull();
    expect(snowflakeTime('12', NOW)).toBeNull();
    expect(snowflakeTime(sf(NOW + 30 * DAY), NOW)).toBeNull();
  });
});

describe('estimateMessages', () => {
  test('half the life held at a steady rate: about twice what was seen', () => {
    const e = estimateMessages([channel(100, 50, 10, 0.1)], { now: NOW });
    expect(e).toMatchObject({ observed: 50, captured: 500, method: 'snowflake-lifetime' });
    expect(e.estimate).toBeCloseTo(100, -1);
    expect(e.low!).toBeGreaterThanOrEqual(50);
    expect(e.low!).toBeLessThanOrEqual(e.estimate!);
    expect(e.high!).toBeGreaterThanOrEqual(e.estimate!);
    expect(e.total!.estimate).toBeCloseTo(1000, -1);
    expect(e.shareLow).toBeLessThan(0.1);
    expect(e.shareHigh).toBeGreaterThan(0.1);
  });

  test('held back to the start: complete, the count itself', () => {
    const e = estimateMessages([channel(60, 60, 5, 0.2)], { now: NOW });
    expect(e).toMatchObject({ method: 'complete', observed: 60, estimate: 60, low: 60, high: 60 });
  });

  test('a network with undated ids gives no total', () => {
    const e = estimateMessages([channel(100, 50, 10, 0.1, { network: 'matrix', nativeId: '!r:x.org', bins: [] })], { now: NOW });
    expect(e.method).toBe('share');
    expect(e.estimate).toBeUndefined();
    expect(e.total).toBeUndefined();
    expect(e.reason).toContain('unknown');
    expect(e.observed).toBe(50);
  });

  test('tiny samples and too little history give no total', () => {
    expect(estimateMessages([channel(400, 10, 0.5, 0.4)], { now: NOW }).method).toBe('share'); // 5 messages
    expect(estimateMessages([channel(1000, 100, 10, 0.1)], { now: NOW }).method).toBe('share'); // a tenth of its life
  });

  test('nothing held at all', () => {
    const e = estimateMessages([], { now: NOW });
    expect(e).toMatchObject({ observed: 0, captured: 0, shareLow: 0, shareHigh: 1, method: 'share' });
  });

  test('someone with none of what was seen: 0, a small top', () => {
    const e = estimateMessages([channel(100, 50, 10, 0)], { now: NOW });
    expect(e.estimate).toBe(0);
    expect(e.low).toBe(0);
    expect(e.high!).toBeGreaterThan(0);
    expect(e.high!).toBeLessThan(10);
  });

  test('someone who wrote all of it: the whole channel', () => {
    const e = estimateMessages([channel(100, 50, 10, 1)], { now: NOW });
    expect(e.shareHigh).toBe(1);
    expect(e.estimate).toBe(e.total!.estimate);
  });

  test('an account made after the oldest message held adds nothing unseen', () => {
    const e = estimateMessages([channel(100, 50, 10, 0.1)], { from: NOW - 40 * DAY, now: NOW });
    expect(e).toMatchObject({ observed: 50, estimate: 50, low: 50 });
  });

  test('a few of theirs in a channel with no estimate: counted as seen, and said', () => {
    const e = estimateMessages([channel(100, 50, 10, 0.2), channel(100, 50, 2, 0.05, { nativeId: 'not-a-snowflake' })], { now: NOW });
    expect(e.method).toBe('snowflake-lifetime');
    expect(e.unestimated).toBe(5);
    expect(e.observed).toBe(105);
    expect(e.reason).toContain('may be more');
  });

  test('a channel with no estimate holding most of their messages: no total', () => {
    const e = estimateMessages([channel(100, 50, 10, 0.01), channel(100, 50, 10, 0.5, { network: 'discord', nativeId: 'not-a-snowflake' })], { now: NOW });
    expect(e.method).toBe('share');
    expect(e.estimate).toBeUndefined();
  });

  test('the range always brackets the estimate, and never drops below what was seen', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      const age = 10 + rnd() * 2000;
      const c = channel(age, age * (0.05 + rnd()), rnd() * 40, rnd() * rnd());
      c.bins = c.bins.map(() => Math.round(rnd() * 3 * (c.captured / c.bins.length)));
      const e = estimateMessages([c, channel(age, age * rnd(), rnd() * 5, rnd())], { now: NOW, from: rnd() < 0.3 ? NOW - rnd() * age * DAY : null });
      if (e.estimate === undefined) continue;
      expect(e.low!).toBeGreaterThanOrEqual(e.observed);
      expect(e.low!).toBeLessThanOrEqual(e.estimate);
      expect(e.high!).toBeGreaterThanOrEqual(e.estimate);
      expect(e.shareLow).toBeLessThanOrEqual(e.observed / e.captured + 1e-9);
      expect(e.shareHigh).toBeGreaterThanOrEqual(e.observed / e.captured - 1e-9);
    }
  });

  test('a quieter stretch held widens the range down, a busier one up', () => {
    const steady = unseenOf(channel(100, 50, 10, 0.1), NOW);
    const bursty = channel(100, 50, 10, 0.1);
    bursty.bins = bursty.bins.map((n, i) => (i % 2 ? Math.max(1, Math.round(n / 5)) : Math.round(n * 1.8)));
    const u = unseenOf(bursty, NOW);
    if ('reason' in steady || 'reason' in u) throw new Error('expected estimates');
    expect(u.low).toBeLessThan(steady.low / 3);
    expect(u.high).toBeGreaterThan(steady.high);
  });

  test('a stretch with nothing held may be a gap: no estimate, and never complete', () => {
    const holed = channel(100, 50, 10, 0.1);
    holed.bins[2] = 0;
    expect(unseenOf(holed, NOW)).toEqual({ reason: 'gaps in what is held' });
    // A recent page and the channel's first message, fetched alone, are not its whole history.
    const sparse = channel(60, 60, 5, 0.2);
    sparse.bins = sparse.bins.map((n, i) => (i === 0 || i === sparse.bins.length - 1 ? n : 0));
    expect(estimateMessages([sparse], { now: NOW })).toMatchObject({ method: 'share' });
  });
});

describe('the store and the endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-msgcount-'));
  let port = 0;
  let store: Store;
  let hub: HubServer;
  const GUILD = sf(NOW - 400 * DAY);
  const GENERAL = sf(NOW - 100 * DAY, 1);
  const ROOM = '!room:x.org';
  const ann = hubId('idn', 'discord', sf(NOW - 3000 * DAY, 2));
  const now = Date.now();
  // Held from 50 days ago to now in a channel made 100 days ago: 10 a day, every tenth from ann.
  const shift = now - NOW;

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    const d = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
    const m = store.createAccount({ network: 'matrix', label: 'm', color: '#111', adapter: 'matrix' });
    // One transaction: 536 writes, each its own commit and fsync, took over 5 s on a busy machine's disk.
    store.db.transaction(() => {
      store.ingest(d, { t: 'status', status: 'online', self: { nativeId: 'dme', isSelf: true } });
      store.ingest(d, { t: 'space', space: { nativeId: GUILD, kind: 'community', name: 'Guild' } });
      store.ingest(d, { t: 'conversation', conversation: { nativeId: GENERAL, shape: 'channel', name: 'general', spaces: [{ nativeId: GUILD }] } });
      store.ingest(m, { t: 'status', status: 'online', self: { nativeId: '@me:x.org', isSelf: true } });
      store.ingest(m, { t: 'space', space: { nativeId: '!space:x.org', kind: 'community', name: 'Matrix space' } });
      store.ingest(m, { t: 'conversation', conversation: { nativeId: ROOM, shape: 'channel', name: 'room', spaces: [{ nativeId: '!space:x.org' }] } });
      for (let i = 0; i < 500; i++) {
        const ts = NOW - 50 * DAY + Math.floor(i * (50 * DAY / 500)) + shift;
        const author = i % 10 === 0 ? sf(NOW - 3000 * DAY, 2) : `u${i % 7}`;
        store.ingest(d, { t: 'message', message: { nativeId: sf(ts - shift, 100 + i), conversation: GENERAL, author, ts, body: 'x' } });
      }
      for (let i = 0; i < 30; i++) store.ingest(m, { t: 'message', message: { nativeId: `$e${i}`, conversation: ROOM, author: i < 3 ? '@ann:x.org' : '@bob:x.org', ts: now - i * DAY, body: 'y' } });
    })();
    store.flush();
    hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a Discord server: seen, share and an estimated total', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/identities/${ann}/activity`);
    expect(res.status).toBe(200);
    const v = (await res.json()) as P.ActivityView;
    expect(v.spaces).toHaveLength(1);
    const e = v.spaces[0];
    expect(e).toMatchObject({ spaceId: hubId('spc', 'discord', GUILD), observed: 50, captured: 500, method: 'snowflake-lifetime', networks: ['discord'] });
    expect(e.estimate!).toBeGreaterThan(80);
    expect(e.estimate!).toBeLessThan(120);
    expect(e.low!).toBeLessThanOrEqual(e.estimate!);
    expect(e.high!).toBeGreaterThanOrEqual(e.estimate!);
    expect(e.asOf).toBeGreaterThan(now - DAY);
  });

  test('a Matrix space: seen and share, the total unknown', async () => {
    const v = (await (await fetch(`http://127.0.0.1:${port}/api/identities/${hubId('idn', 'matrix', '@ann:x.org')}/activity`)).json()) as P.ActivityView;
    expect(v.spaces[0]).toMatchObject({ observed: 3, captured: 30, method: 'share', networks: ['matrix'] });
    expect(v.spaces[0].estimate).toBeUndefined();
  });

  test('?space= one server, even with nothing from them; nobody is a 404', async () => {
    const sid = hubId('spc', 'matrix', '!space:x.org');
    const v = (await (await fetch(`http://127.0.0.1:${port}/api/identities/${ann}/activity?space=${sid}`)).json()) as P.ActivityView;
    expect(v.spaces).toEqual([expect.objectContaining({ spaceId: sid, observed: 0, captured: 30 })]);
    expect((await fetch(`http://127.0.0.1:${port}/api/identities/idn_nobody/activity`)).status).toBe(404);
  });

  test('joined after the oldest message held, with members kept: nothing unseen is theirs', () => {
    store.setRetention({ ...DEFAULT_RETENTION, adversarial: true, members: true });
    const sid = hubId('spc', 'discord', GUILD);
    const before = store.messageActivity({ identityId: ann })!.spaces[0];
    // A join after their first message held is a rejoin: ignored.
    store.db.query(`INSERT INTO membership (space_id, identity_id, joined_at, source, first_seen, last_seen) VALUES (?, ?, ?, 'seen', ?, ?)`).run(sid, ann, now - DAY, now, now);
    expect(store.messageActivity({ identityId: ann })!.spaces[0].estimate).toBe(before.estimate);
    // Joined between the channel's start and the oldest message held: only that part of the unseen time.
    store.db.query('UPDATE membership SET joined_at = ?').run(now - 75 * DAY);
    const after = store.messageActivity({ identityId: ann })!.spaces[0];
    expect(after.estimate!).toBeLessThan(before.estimate!);
    expect(after.estimate!).toBeGreaterThan(50);
    store.setRetention(DEFAULT_RETENTION);
    expect(store.messageActivity({ identityId: ann })!.spaces[0].estimate).toBe(before.estimate);
  });

  test('the counts read through indexes, not the whole table', () => {
    const plan = (sql: string, ...a: unknown[]) => (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(a as any[])) as { detail: string }[]).map((r) => r.detail).join(' | ');
    const conv = hubId('cnv', 'discord', GENERAL);
    expect(plan('SELECT conversation_id AS c, COUNT(*) AS n, MIN(ts) AS first FROM message WHERE author_id IN (?) GROUP BY conversation_id', ann)).toContain('USING INDEX message_author_ts');
    expect(plan('SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM message WHERE conversation_id = ?', conv)).toContain('COVERING INDEX message_conv_ts');
    expect(plan('SELECT MIN(?, CAST((ts - ?) / ? AS INTEGER)) AS b, COUNT(*) AS n FROM message WHERE conversation_id = ? GROUP BY b', 1, 0, 1, conv)).toContain('COVERING INDEX message_conv_ts');
  });
});
