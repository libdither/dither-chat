/**
 * Time in voice channels (voicetime.ts) and what it adds to the people graph (closeness.ts): stretches from the voice
 * log, capped and dropped when no end was heard; time together counted from five minutes, split over the people in the
 * channel, crowds left out; ties between two others kept apart from talk, time with you toward their closeness; a
 * profile's voice and its Close to list. Nothing while the adversarial voice log is off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION, GRAPH_SOURCE } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { activityView, closeness, closeTo } from '../src/closeness.ts';
import { addTables } from '../src/add.ts';
import { peopleGraph } from '../src/graph.ts';
import { Store } from '../src/store.ts';
import { MAX_MS, personVoice, together, voiceStretches, type VoiceStretch } from '../src/voicetime.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-voicetime-'));
let store: Store;
let acc: ReturnType<Store['createAccount']>;
const did = (n: string) => hubId('idn', 'discord', n);
const cid = (n: string) => hubId('cnv', 'discord', n);
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 18);
const NOW = Date.UTC(2026, 9, 20);
const month = (ts: number) => new Date(ts).getUTCFullYear() * 12 + new Date(ts).getUTCMonth();

const voice = (channel: string, who: string[], at: number) =>
  store.ingest(acc, {
    t: 'voice',
    conversation: channel,
    space: 'g1',
    members: who.map((w) => ({ who: w })),
    ts: at,
  });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  acc = store.createAccount({
    network: 'discord',
    label: 'main',
    color: '#111',
    adapter: 'discord',
  });
  store.ingest(acc, {
    t: 'status',
    status: 'online',
    self: { nativeId: 'me', displayName: 'Me', isSelf: true },
  });
  for (const a of ['ann', 'bob', 'cat', 'dan'])
    store.ingest(acc, {
      t: 'identity',
      identity: { nativeId: a, displayName: a.toUpperCase() },
    });
  store.ingest(acc, {
    t: 'space',
    space: { nativeId: 'g1', kind: 'community', name: 'Guild' },
  });
  for (const c of ['vc1', 'vc2'])
    store.ingest(acc, {
      t: 'conversation',
      conversation: {
        nativeId: c,
        shape: 'channel',
        variant: 'voice',
        name: c,
        spaces: [{ nativeId: 'g1' }],
      },
    });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('with the voice log off', () => {
  test('nothing is kept, so nothing is counted', () => {
    store.setRetention(DEFAULT_RETENTION);
    voice('vc1', ['ann', 'bob'], T0);
    voice('vc1', [], T0 + 60 * MIN);
    expect(voiceStretches(store.db, NOW)).toEqual([]);
    expect(personVoice(store.db, [did('ann')], (i) => i, NOW)).toBeNull();
    expect(closeness(store.db).voiceTies).toEqual({});
  });
});

describe('with it on', () => {
  beforeAll(() => {
    store.setRetention({
      ...DEFAULT_RETENTION,
      adversarial: true,
      voice: true,
    });
    // An hour: Ann and Bob for all of it, Cat for the last 30 minutes, Dan for 3 minutes (too short to count).
    voice('vc1', ['ann', 'bob'], T0);
    voice('vc1', ['ann', 'bob', 'dan'], T0 + 10 * MIN);
    voice('vc1', ['ann', 'bob'], T0 + 13 * MIN);
    voice('vc1', ['ann', 'bob', 'cat'], T0 + 30 * MIN);
    voice('vc1', [], T0 + 60 * MIN);
    // A day later, you and Ann for 40 minutes, in the other channel; then Bob joins it and is still there.
    voice('vc2', ['me', 'ann'], T0 + 24 * 60 * MIN);
    voice('vc2', ['me'], T0 + 24 * 60 * MIN + 40 * MIN);
    voice('vc2', ['me', 'bob'], T0 + 24 * 60 * MIN + 50 * MIN);
  });

  test('stretches: from each join to the next move, open while still in it, capped at twelve hours', () => {
    const s = voiceStretches(store.db, NOW);
    const of = (who: string) => s.filter((x) => x.identityId === did(who)).map((x) => [x.conversationId, (x.from - T0) / MIN, (x.to - x.from) / MIN, x.open]);
    expect(of('ann')).toEqual([
      [cid('vc1'), 0, 60, false],
      [cid('vc2'), 24 * 60, 40, false],
    ]);
    expect(of('dan')).toEqual([[cid('vc1'), 10, 3, false]]);
    // Bob is still in vc2, as last heard, but days ago: twelve hours at most, and no longer taken as there now.
    expect(of('bob')[1]).toEqual([cid('vc2'), 24 * 60 + 50, MAX_MS / MIN, false]);
    const soon = voiceStretches(store.db, T0 + 24 * 60 * MIN + 80 * MIN).filter((x) => x.identityId === did('bob'));
    expect(soon[1]).toMatchObject({
      to: T0 + 24 * 60 * MIN + 80 * MIN,
      open: true,
    });
  });

  test('together: five minutes or more, how many were in the channel then, crowds left out', () => {
    const st = (who: string, from: number, to: number): VoiceStretch => ({
      identityId: who,
      conversationId: 'c',
      from: from * MIN,
      to: to * MIN,
      open: false,
    });
    const seen: [string, string, number, number][] = [];
    together([st('a', 0, 60), st('b', 0, 60), st('d', 10, 13), st('c', 30, 60)], (a, b, _f, ms, shared) => seen.push([a, b, ms / MIN, shared / MIN]));
    // A and B: 27 minutes alone (all of it), 3 with D and 30 with C (half of it each).
    expect(seen).toEqual([
      ['a', 'b', 60, 43.5],
      ['a', 'c', 30, 15],
      ['b', 'c', 30, 15],
    ]);
    const crowd = Array.from({ length: 30 }, (_, i) => st(`p${i}`, 0, 60));
    let n = 0;
    together(crowd, () => n++);
    expect(n).toBe(0);
  });

  test('closeness: voice ties between others, apart from talk; time with you counts toward them', () => {
    const run = closeness(store.db);
    const pair = (a: string, b: string) => (did(a) < did(b) ? `${did(a)} ${did(b)}` : `${did(b)} ${did(a)}`);
    const mo = month(T0);
    // Ann and Bob: 60 minutes, 33 of them with a third → 43.5 shared minutes × 0.1 = 4.35.
    expect(run.voiceTies[pair('ann', 'bob')]).toEqual([mo, 44]);
    // Ann and Cat: 30 minutes, three in the channel → 30 / 2 × 0.1 = 1.5.
    expect(run.voiceTies[pair('ann', 'cat')]).toEqual([mo, 15]);
    expect(run.voiceTies[pair('ann', 'dan')]).toBeUndefined();
    expect(run.ties[pair('ann', 'bob')]).toBeUndefined();
    expect(run.tieCounts[pair('ann', 'bob')]).toEqual([0, 0, 0, 60]);
    // You and Ann: 40 minutes × 0.5 = 20.
    expect(run.byIdentity[did('ann')]).toEqual([mo, 200]);
    // The graph gets them as its own runs; Ann–Cat is under the least a tie needs.
    const v = activityView(store, run).ties!;
    const [a, b] = [did('ann'), did('bob')].sort();
    expect(v.voice).toEqual([v.ids.indexOf(a), v.ids.indexOf(b), 1, mo, 44]);
  });

  test('Close to: strongest first, with what counted; your voice weight changes it', () => {
    const run = closeness(store.db);
    const now = new Date(NOW);
    const close = closeTo(store, run, did('ann'), null, 12, now);
    expect(close.map((c) => [c.key, c.voiceMinutes])).toEqual([
      [did('bob'), 60],
      [did('cat'), 30],
    ]);
    expect(close[0]).toMatchObject({
      identityId: did('bob'),
      replies: 0,
      reactions: 0,
      turns: 0,
      friends: false,
    });
    expect(close[0].strength).toBeGreaterThan(close[1].strength);
    const off = closeTo(store, run, did('ann'), { weights: {} as P.GraphTuning['weights'], fade: 18, voice: 0 }, 12, now);
    expect(off).toEqual([]);
  });

  test("a profile's voice: latest first, minutes, and who with in the past 90 days", () => {
    const v = personVoice(store.db, [did('ann')], (i) => i, NOW)!;
    expect(v.since).toBe(T0);
    expect(v.minutes).toEqual({ month: 100, days30: 100, total: 100 });
    expect(v.sessions).toEqual([
      {
        conversationId: cid('vc2'),
        from: T0 + 24 * 60 * MIN,
        to: T0 + 24 * 60 * MIN + 40 * MIN,
      },
      { conversationId: cid('vc1'), from: T0, to: T0 + 60 * MIN },
    ]);
    expect(v.with).toEqual([
      { key: did('bob'), identityId: did('bob'), minutes: 60 },
      { key: did('me'), identityId: did('me'), minutes: 40 },
      { key: did('cat'), identityId: did('cat'), minutes: 30 },
    ]);
  });

  test('the graph links whoever was in a voice channel to its server', () => {
    addTables(store.db);
    const g = peopleGraph(store);
    const dan = g.people.findIndex((p) => p.id === did('dan'));
    const guild = g.places.findIndex((q) => q.id === hubId('spc', 'discord', 'g1'));
    const bits = (pi: number, qi: number) => {
      for (let k = 0; k < g.links.length; k += 3) if (g.links[k] === pi && g.links[k + 1] === qi) return g.links[k + 2];
      return 0;
    };
    expect(dan).toBeGreaterThanOrEqual(0);
    expect(bits(dan, guild) & GRAPH_SOURCE.voice).toBe(GRAPH_SOURCE.voice);
  });

  test("voice changes stay out of a profile's History once adversarial features are hidden", () => {
    const fields = () => store.changes([{ kind: 'identity', id: did('ann') }]).map((c) => c.field);
    expect(fields()).toContain('voice');
    store.setRetention({ ...store.retention(), adversarial: false });
    expect(fields()).not.toContain('voice');
    store.setRetention({ ...store.retention(), adversarial: true });
  });
});
