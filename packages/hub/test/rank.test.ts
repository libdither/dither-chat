/**
 * The inbox's learned order (rank.ts, rankhistory.ts, ranker.ts, docs/inbox.md): the prior orders as the formula,
 * the fit learns what you open, opens from far down count more, and the hub rebuilds your opens and refits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ActivityStore } from '../src/activity.ts';
import { Attention, freshState, scoreConversation, VOTE_HALF_LIFE, voteDirection, votesAt, type ScoreInput } from '../src/attention.ts';
import { EXPLORE_REASON } from '@dither-chat/protocol';
import {
  bucketOf,
  curveFit,
  decreasing,
  drain,
  drawZ,
  epochOf,
  EXAM_AT,
  EXAM_FLOOR,
  examination,
  EXPLORE_EPOCH,
  FEATURES,
  FIT,
  fitLogistic,
  fitRank,
  fitSteps,
  FLOORED,
  GUESSED_CURVE,
  invertSPD,
  LAMBDA,
  logit,
  MAX_IPW,
  openWeight,
  posteriorSteps,
  predict,
  PRIOR,
  rankFeatures,
  spread,
  TRIAGE_FEATURES,
  Z_CLIP,
  type FitRow,
  type Moment,
  type RankModel,
  type RankRow,
} from '../src/rank.ts';
import { exploreOn, InboxRanker } from '../src/ranker.ts';
import { KEEP_RECENT, KEEP_SAMPLE, positions, sample, seenAt, type Conv, type Seen, type World } from '../src/rankhistory.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);

const input = (o: Partial<ScoreInput> = {}): ScoreInput => ({
  now: T0,
  shape: 'group',
  members: 8,
  lastMessageAt: T0 - HOUR,
  state: freshState(),
  author: null,
  authorName: null,
  unread: 0,
  mentions: 0,
  pinged: null,
  muted: null,
  usage: null,
  ...o,
});
const feats = (o: Partial<ScoreInput> = {}) => {
  const x = input(o);
  return rankFeatures(x, scoreConversation(x));
};

describe('the prior', () => {
  test('gives back the formula’s own score, so a fresh hub orders as today', () => {
    for (const o of [{}, { unread: 3 }, { shape: 'direct' as const, unread: 1 }, { lastMessageAt: T0 - 9 * DAY }, { usage: { score: 900, visitScore: 2, at: T0 - MIN, lastVisit: T0 - 20 * MIN } }]) {
      const x = input(o);
      const s = scoreConversation(x);
      expect(predict(PRIOR, rankFeatures(x, s)).points).toBeCloseTo(s.score, 0);
    }
  });

  test('about one open in six leads to a message', () => {
    expect(predict(PRIOR, feats()).send).toBeCloseTo(1 / 6, 1);
  });
});

describe('fitting', () => {
  const rows = (n: number, f: (i: number) => [Partial<ScoreInput>, 0 | 1]): RankRow[] =>
    Array.from({ length: n }, (_, i) => {
      const [o, y] = f(i);
      return { x: feats(o), y, w: 1 };
    });

  test('learns what you open on top of the formula, and stays at the prior without data', () => {
    // You open groups with a fresh message, whatever the formula says, and not the ones gone quiet.
    const fresh = { lastMessageAt: T0 - 5 * MIN };
    const quiet = { lastMessageAt: T0 - 3 * DAY };
    const data = rows(400, (i) => (i % 2 ? [fresh, i % 4 === 1 ? 1 : 0] : [quiet, 0]));
    const m = { ...PRIOR, open: fitLogistic(data, PRIOR.open) };
    const gap = (model: typeof PRIOR) => predict(model, feats(fresh)).open - predict(model, feats(quiet)).open;
    expect(gap(m)).toBeGreaterThan(gap(PRIOR) + 0.2);
    expect(predict(m, feats(fresh)).open).toBeGreaterThan(0.3);
    expect(fitLogistic([], PRIOR.open)).toEqual(PRIOR.open);
  });

  test('a few examples move it a little; many, more', () => {
    // You open DMs and not groups, all else alike.
    const one = (n: number) => fitLogistic(rows(n, (i) => (i % 2 ? [{ shape: 'direct' }, 1] : [{ shape: 'group' }, 0])), PRIOR.open).direct ?? 0;
    expect(one(4)).toBeGreaterThan(0);
    expect(one(4)).toBeLessThan(one(400) / 2);
  });
});

describe('the floor: what can only count for a row', () => {
  const rows = (n: number, f: (i: number) => [Partial<ScoreInput>, 0 | 1]): RankRow[] =>
    Array.from({ length: n }, (_, i) => {
      const [o, y] = f(i);
      return { x: feats(o), y, w: 1 };
    });
  // A week as it once went: the rows with something unread were at the top anyway and you opened what was under them.
  const unreadIgnored = rows(400, (i) => (i % 2 ? [{ unread: 6 }, 0] : [{ unread: 0 }, 1]));
  const at = (w: ReturnType<typeof fitLogistic>, k: (typeof FEATURES)[number]) => w[k] ?? 0;

  test('what is floored: unread, a mention, a reply owed, a conversation going on, an alert or a Conversation waiting, a DM', () => {
    expect([...FLOORED].sort()).toEqual(['direct', 'live', 'mentions', 'owed', 'pinged', 'unread']);
    for (const k of FLOORED) expect(FEATURES).toContain(k);
    // The hub fits with it.
    expect(FIT.floor).toBe(FLOORED);
  });

  test('without it the fit learns that unread rows are opened less; with it that weight never goes under the prior’s', () => {
    const free = fitLogistic(unreadIgnored, PRIOR.open);
    expect(at(free, 'unread')).toBeLessThan(-0.1);
    const floored = fitLogistic(unreadIgnored, PRIOR.open, LAMBDA, 25, FLOORED);
    expect(at(floored, 'unread')).toBe(at(PRIOR.open, 'unread'));
    expect(at(floored, 'unread')).toBe(0);
    // None of the floored ones is under the prior's; what is not floored still learns from the same rows.
    for (const f of FLOORED) expect(at(floored, f)).toBeGreaterThanOrEqual(at(PRIOR.open, f));
    expect(at(floored, 'formula')).not.toBe(at(PRIOR.open, 'formula'));
    // Step by step, as the hub fits, it is the same answer.
    expect(drain(fitSteps(unreadIgnored, PRIOR.open, LAMBDA, 25, FLOORED))).toEqual(floored);
    expect(drain(fitSteps(unreadIgnored, PRIOR.open))).toEqual(free);
  });

  test('every floored feature holds, each against rows that say it counts against', () => {
    const cases: [(typeof FEATURES)[number], Partial<ScoreInput>][] = [
      ['unread', { unread: 6 }],
      ['mentions', { unread: 3, mentions: 3 }],
      ['pinged', { unread: 1, pinged: 'A direct message' }],
      ['direct', { shape: 'direct' }],
    ];
    for (const [k, o] of cases) {
      const data = rows(400, (i) => (i % 2 ? [o, 0] : [{}, 1]));
      expect(feats(o)[k]).toBeGreaterThan(0);
      expect(at(fitLogistic(data, PRIOR.open), k)).toBeLessThan(0);
      const w = fitLogistic(data, PRIOR.open, LAMBDA, 25, FLOORED);
      for (const f of FLOORED) expect(at(w, f)).toBeGreaterThanOrEqual(at(PRIOR.open, f));
    }
  });

  test('it is a floor, not a pin: the fit may raise a floored weight, and one not named is free to fall', () => {
    const opened = rows(400, (i) => (i % 2 ? [{ unread: 6 }, 1] : [{ unread: 0 }, 0]));
    const raised = at(fitLogistic(opened, PRIOR.open, LAMBDA, 25, FLOORED), 'unread');
    expect(raised).toBeGreaterThan(0.05);
    // Above the floor it is the fit it would have been without one.
    expect(raised).toBe(at(fitLogistic(opened, PRIOR.open), 'unread'));
    // Only what is named: with another feature floored, unread falls as it does without a floor.
    expect(at(fitLogistic(unreadIgnored, PRIOR.open, LAMBDA, 25, ['direct']), 'unread')).toBe(at(fitLogistic(unreadIgnored, PRIOR.open), 'unread'));
  });

  test('the floor is the prior’s own weight, not zero', () => {
    const prior = { ...PRIOR.open, direct: 0.8 };
    const dmsIgnored = rows(400, (i) => (i % 2 ? [{ shape: 'direct' }, 0] : [{ shape: 'group' }, 1]));
    expect(at(fitLogistic(dmsIgnored, prior), 'direct')).toBeLessThan(0.8);
    expect(at(fitLogistic(dmsIgnored, prior, LAMBDA, 25, FLOORED), 'direct')).toBe(0.8);
  });

  test('a whole fit takes it as an option: the open chance is floored, with it and with the curve', () => {
    const quiet = feats({ unread: 0 });
    const unread = feats({ unread: 6 });
    const moments: Moment[] = Array.from({ length: 200 }, (_, i) => ({
      at: T0 + i * HOUR,
      rows: [
        { x: unread, weight: 1, open: null, chosen: false, pos: 0 },
        { x: quiet, weight: 1, open: { source: 'inbox', rank: 1, after: MIN }, chosen: true, sent: false, pos: 1 },
      ],
    }));
    expect(at(fitRank(moments, T0, { cov: false }).open, 'unread')).toBeLessThan(-0.1);
    expect(at(fitRank(moments, T0, { cov: false, floor: FLOORED }).open, 'unread')).toBe(0);
    expect(at(fitRank(moments, T0, { ...FIT, cov: false }).open, 'unread')).toBe(0);
    expect(at(fitRank(moments, T0, { ...FIT, cov: false, floor: [] }).open, 'unread')).toBeLessThan(-0.1);
  });
});

describe('seeing a row because it is listed', () => {
  test('rows further down are looked at less: an open from there counts more, up to a cap', () => {
    expect(examination(0)).toBe(1);
    expect(examination(3)).toBeCloseTo(0.5);
    expect(openWeight({ source: 'inbox', rank: 3 })).toBeCloseTo(2);
    expect(openWeight({ source: 'inbox', rank: 10_000 })).toBe(MAX_IPW);
    // Not from the inbox's list: where it was there does not matter.
    expect(openWeight({ source: 'notification', rank: null })).toBe(1);
    expect(openWeight(null)).toBe(1);
    // The replay tries other caps.
    expect(openWeight({ source: 'inbox', rank: 10_000 }, 0.5, 3)).toBe(3);
  });
});

describe('the examination curve, fitted', () => {
  test('a curve steps by bucket; without one, the guess', () => {
    expect(EXAM_AT.map(bucketOf)).toEqual(EXAM_AT.map((_, i) => i));
    expect(bucketOf(4)).toBe(3);
    expect(bucketOf(10_000)).toBe(EXAM_AT.length - 1);
    const curve = EXAM_AT.map((_, i) => 1 - i * 0.05);
    expect(examination(9, 0.5, curve)).toBe(curve[bucketOf(9)]);
    expect(examination(3, 0.5, null)).toBeCloseTo(0.5);
    expect(openWeight({ source: 'inbox', rank: 9 }, 0.5, MAX_IPW, curve)).toBeCloseTo(1 / curve[bucketOf(9)]);
  });

  test('never rising further down: adjacent violators pooled by their weight', () => {
    const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
    near(decreasing([1, 0.5, 0.7, 0.2], [1, 1, 1, 1]), [1, 0.6, 0.6, 0.2]);
    near(decreasing([1, 0.2, 0.8], [1, 3, 1]), [1, 0.35, 0.35]);
  });

  // Every row has a one-in-five chance of being wanted; the first 8 rows are always seen, the next 27 a third of the
  // time, and the rest a tenth: opens from the inbox at each position are what that gives.
  const truth = (pos: number) => (pos < 8 ? 1 : pos < 35 ? 0.3 : 0.1);
  const p = 0.2;
  const x = feats();
  const rowsAt = (pos: number, n = 400): FitRow[] => {
    const opened = Math.round(n * truth(pos) * p);
    return Array.from({ length: n }, (_, i) => ({ x, w: 1, pos, opened: i < opened ? { source: 'inbox', rank: pos } : null }));
  };
  const rows = Array.from({ length: 120 }, (_, pos) => rowsAt(pos)).flat();
  const w = { bias: logit(p) };

  test('it finds where you look from where your inbox opens came from', () => {
    const { curve, from } = curveFit(rows, w);
    expect(from).toBeGreaterThan(1000);
    expect(curve[0]).toBe(1);
    for (const b of [1, 2, 3, 4]) expect(curve[b]).toBeCloseTo(1, 1);
    for (const b of [5, 6, 7]) expect(curve[b]).toBeCloseTo(0.3, 1);
    for (const b of [8, 9, 10]) expect(curve[b]).toBeCloseTo(0.1, 1);
  });

  test('with a handful of opens it stays near the guess; never below the floor or above 1', () => {
    const few = [...rowsAt(0, 50), ...rowsAt(30, 50).map((r) => ({ ...r, opened: null })), ...rowsAt(30, 1)];
    const { curve } = curveFit(few, w);
    expect(curve[bucketOf(30)]).toBeLessThan(GUESSED_CURVE[bucketOf(30)] + 0.05);
    expect(Math.min(...curve)).toBeGreaterThanOrEqual(EXAM_FLOOR);
    expect(Math.max(...curve)).toBeLessThanOrEqual(1);
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeLessThanOrEqual(curve[i - 1]);
  });

  test('a fit with the curve keeps it, and opens from where you seldom look count more than the guess says', () => {
    const moments: Moment[] = [];
    for (let pos = 0; pos < 120; pos++) moments.push({ at: T0 + pos, rows: rowsAt(pos, 40).map((r) => ({ x: r.x, weight: 1, open: r.opened, chosen: false, pos })) });
    const m = fitRank(moments, T0, { curve: 'ipw' });
    expect(m.curve).toHaveLength(EXAM_AT.length);
    expect(m.curve![0]).toBe(1);
    expect(m.curveFrom).toBeGreaterThan(0);
    // The guess, as before: no curve kept.
    expect(fitRank(moments, T0).curve).toBeUndefined();
    expect(fitRank(moments, T0, { curve: 'em' }).curve).toHaveLength(EXAM_AT.length);
  });
});

describe('where each row stood', () => {
  test('the formula’s one list: muted last, then by score, then the latest message', () => {
    const s = (id: string, o: Partial<ScoreInput>) => ({ conv: { id, shape: 'group' }, input: input(o), lastThere: null }) as unknown as Seen;
    const seen = [s('quiet', { lastMessageAt: T0 - 5 * DAY }), s('muted', { unread: 5, muted: 'you' }), s('busy', { unread: 3 }), s('fresh', { lastMessageAt: T0 - MIN })];
    const pos = positions(seen, new Map(seen.map((x) => [x.conv.id, scoreConversation(x.input)])));
    expect([...pos.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual(['busy', 'fresh', 'quiet', 'muted']);
  });
});

describe('what triage knows, as features', () => {
  test('a vote up, down or right; decayed, and not before it was cast', () => {
    expect(voteDirection('quiet', 'push')).toBe(1);
    expect(voteDirection('push', 'digest')).toBe(-1);
    expect(voteDirection('digest', 'digest')).toBe(0);
    const votes = [
      { at: T0 - VOTE_HALF_LIFE, dir: -1 },
      { at: T0 - HOUR, dir: 1 },
      { at: T0 + HOUR, dir: 1 },
      { at: T0 - DAY, dir: 0 },
    ];
    expect(votesAt(votes, T0)!.down).toBeCloseTo(0.5);
    expect(votesAt(votes, T0)!.up).toBeCloseTo(1, 2);
    expect(votesAt(votes.slice(3), T0)).toBeNull();
    expect(votesAt(undefined, T0)).toBeNull();
  });

  test('the newest unread message triage decided on, with your vote once you cast it', () => {
    const conv: Conv = {
      id: 'c1',
      shape: 'group',
      members: 5,
      listed: true,
      usageKey: 'conversation:c1',
      muted: null,
      state: freshState(),
      lastMessageAt: T0 - 10 * MIN,
      lastOwn: T0 - 2 * HOUR,
      incoming: [
        { ts: T0 - 30 * MIN, mention: false, pushed: true, level: 'push', vote: null, votedAt: null },
        { ts: T0 - 20 * MIN, mention: false, pushed: true, level: 'quiet', vote: 'digest', votedAt: T0 + HOUR },
        { ts: T0 - 10 * MIN, mention: false, pushed: false, level: null, vote: null, votedAt: null },
      ],
    };
    const world: World = { convs: new Map([['c1', conv]]), stays: [], logStart: 0, tallies: new Map(), self: new Set(), selfPerson: null, votes: new Map([['c1', [{ at: T0 + HOUR, dir: -1 }]]]) };
    const now = seenAt(world, T0)[0].input;
    // Not decided (the newest) is passed over; the vote comes an hour later, so it is still Active and no vote yet.
    expect(now.level).toBe('quiet');
    expect(now.votes).toBeNull();
    const later = seenAt(world, T0 + 2 * HOUR)[0].input;
    expect(later.level).toBe('digest');
    expect(later.votes!.down).toBeCloseTo(1, 2);
    const f = rankFeatures(later, scoreConversation(later));
    expect([f.important, f.active, f.digest, f.notInteresting, f.votedUp]).toEqual([0, 0, 1, 0, 0]);
    expect(f.votedDown).toBeCloseTo(Math.log(2), 2);
  });

  test('the hub keeps them at the prior until they help; the replay can learn them', () => {
    // Important always opened, the rest never: only an unpinned fit learns it.
    const rows: RankRow[] = Array.from({ length: 200 }, (_, i) => {
      const x = input({ level: i % 2 ? 'push' : 'digest' });
      return { x: rankFeatures(x, scoreConversation(x)), y: i % 2, w: 1 };
    });
    expect(TRIAGE_FEATURES.every((f) => LAMBDA[f] === Infinity)).toBe(true);
    expect(fitLogistic(rows, PRIOR.open).important).toBeUndefined();
    const free = { ...LAMBDA, ...Object.fromEntries(TRIAGE_FEATURES.map((f) => [f, 30])) };
    expect(fitLogistic(rows, PRIOR.open, free).important).toBeGreaterThan(0.5);
  });
});

describe('exploring: a Thompson sample of the model', () => {
  test('the inverse of a symmetric positive-definite matrix', () => {
    const A = [
      [4, 1, 0.5],
      [1, 3, 0.2],
      [0.5, 0.2, 2],
    ];
    const inv = invertSPD(A);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(A[i].reduce((s, a, k) => s + a * inv[k][j], 0)).toBeCloseTo(i === j ? 1 : 0, 9);
  });

  test('more rows, less doubt; a pinned feature has none', () => {
    const rows = (n: number): RankRow[] => Array.from({ length: n }, (_, i) => ({ x: feats({ shape: i % 2 ? 'direct' : 'group' }), y: i % 3 ? 0 : 1, w: 1 }));
    const few = drain(posteriorSteps(rows(20), PRIOR.open));
    const many = drain(posteriorSteps(rows(2000), PRIOR.open));
    const free = FEATURES.filter((f) => LAMBDA[f] !== Infinity);
    expect(free.some((f) => (TRIAGE_FEATURES as readonly string[]).includes(f))).toBe(false);
    const x = feats({ shape: 'direct' });
    expect(spread(free, many, x)).toBeLessThan(spread(free, few, x) / 2);
    // With nothing to go on, only the pull to the prior: sd 1/sqrt(λ) on a lone feature.
    const none = drain(posteriorSteps([], PRIOR.open));
    expect(Math.sqrt(none[free.indexOf('direct')][free.indexOf('direct')])).toBeCloseTo(1 / Math.sqrt(30), 4);
  });

  test('a fit knows how sure it is, widened by how often each open was counted', () => {
    const x = feats();
    // One open, a row of each of three moments.
    const moments: Moment[] = [0, 1, 2].map((i) => ({ at: T0 + i * MIN, rows: [{ x, weight: 1, open: { source: 'notification', rank: null, after: MIN }, chosen: i === 2, sent: false }, { x, weight: 1, open: null, chosen: false }] }));
    const m = fitRank(moments, T0);
    expect(m.cov!.features).toEqual(FEATURES.filter((f) => LAMBDA[f] !== Infinity));
    expect(m.cov!.repeat).toBe(1);
    expect(fitRank(moments, T0, { cov: false }).cov).toBeUndefined();
  });

  test('the same draw for a conversation until the epoch turns; standard normal, clipped', () => {
    expect(drawZ('c1|e1')).toEqual(drawZ('c1|e1'));
    expect(drawZ('c1|e1')).not.toEqual(drawZ('c1|e2'));
    const zs = Array.from({ length: 4000 }, (_, i) => drawZ(`c${i}|e`).open);
    const mean = zs.reduce((a, z) => a + z, 0) / zs.length;
    const sd = Math.sqrt(zs.reduce((a, z) => a + (z - mean) ** 2, 0) / zs.length);
    expect(Math.abs(mean)).toBeLessThan(0.06);
    expect(sd).toBeGreaterThan(0.9);
    expect(sd).toBeLessThan(1.02);
    expect(Math.max(...zs.map(Math.abs))).toBeLessThanOrEqual(Z_CLIP);
    const m = { fitAt: T0 };
    expect(epochOf(m, T0 + MIN)).toBe(epochOf(m, T0 + 2 * MIN));
    expect(epochOf(m, T0)).not.toBe(epochOf(m, T0 + EXPLORE_EPOCH));
    expect(epochOf(m, T0)).not.toBe(epochOf({ fitAt: T0 + 1 }, T0));
  });

  test('a sample moves each logit by its spread times its draw; without doubt, the mean', () => {
    const x = feats({ unread: 2 });
    const free = FEATURES.filter((f) => LAMBDA[f] !== Infinity);
    const cov = { features: free, open: free.map((_, i) => free.map((_, j) => (i === j ? 0.04 : 0))), send: free.map((_, i) => free.map((_, j) => (i === j ? 0.04 : 0))) };
    const m: RankModel = { ...PRIOR, cov };
    const mean = predict(m, x);
    expect(predict(m, x, { open: 0, send: 0 })).toEqual(mean);
    expect(predict(PRIOR, x, { open: 2, send: 2 })).toEqual(predict(PRIOR, x));
    const up = predict(m, x, { open: 1, send: 0 });
    expect(logit(up.open) - logit(mean.open)).toBeCloseTo(spread(free, cov.open, x), 6);
    expect(predict(m, x, { open: 1, send: 0 }, 0)).toEqual(mean);
  });

  test('DITHER_INBOX_EXPLORE: on unless 0', () => {
    expect(exploreOn(undefined)).toBe(true);
    expect(exploreOn('1')).toBe(true);
    expect(exploreOn('0')).toBe(false);
  });
});

describe('the horizon', () => {
  test('an open later than the horizon counts as not opened, so moments built wide can try shorter ones', () => {
    const fresh = feats({ lastMessageAt: T0 - 5 * MIN });
    const quiet = feats({ lastMessageAt: T0 - 3 * DAY });
    // Fresh ones are opened at once; quiet ones too, but only five hours later.
    const moments: Moment[] = Array.from({ length: 40 }, (_, i) => ({
      at: T0 + i * HOUR,
      rows: [
        { x: fresh, weight: 1, open: { source: 'notification', rank: null, after: 10 * MIN }, chosen: true, sent: false },
        { x: quiet, weight: 1, open: i % 2 ? { source: 'notification', rank: null, after: 5 * HOUR } : null, chosen: false },
      ],
    }));
    const gap = (h: number) => {
      const m = fitRank(moments, T0, { horizon: h });
      return predict(m, fresh).open - predict(m, quiet).open;
    };
    expect(gap(HOUR)).toBeGreaterThan(gap(6 * HOUR));
    // Within six hours both kinds were opened; within one, only the fresh ones.
    expect(fitRank(moments, T0, { horizon: 6 * HOUR }).rows).toBe(80);
  });
});

describe('sampling a moment', () => {
  test('keeps what was opened, the most recent, and a sample of the rest that stands for all of it', () => {
    const seen = Array.from({ length: 200 }, (_, i) => ({ conv: { id: `c${i}` }, input: input({ lastMessageAt: T0 - i * MIN }), lastThere: null }) as unknown as Seen);
    const opened = new Map([['c150', {}]]);
    const s = sample(seen, opened, T0);
    expect(s.find((x) => x.seen.conv.id === 'c150')?.weight).toBe(1);
    expect(s.filter((x) => x.weight === 1).length).toBe(1 + KEEP_RECENT);
    expect(s.length).toBe(1 + KEEP_RECENT + KEEP_SAMPLE);
    // The sample counts for the whole rest.
    expect(s.filter((x) => x.weight > 1).reduce((a, x) => a + x.weight, 0)).toBeCloseTo(200 - 1 - KEEP_RECENT);
    expect(sample(seen, opened, T0).map((x) => x.seen.conv.id)).toEqual(s.map((x) => x.seen.conv.id));
  });
});

// ------------------------------------------------------------------ in the hub

describe('the hub learns from your opens', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  let activity: ActivityStore;
  let n = 0;
  const NOW = T0 + 10 * DAY;
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
  const say = (conversation: string, author: string, ts: number) =>
    store.ingest(acc, { t: 'message', message: { nativeId: `m${++n}`, conversation, author, ts, body: '' }, live: true });
  const open = (conversation: string, start: number, extra: Partial<P.VisitRecord> = {}) =>
    activity.visits([{ id: `v${++n}`, device: 'd1', view: 'conversation', conversationId: cid(conversation), start, end: start + 2 * MIN, active: 60, source: 'inbox', rank: 12, closed: true, ...extra }], NOW);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-rank-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'matrix', label: 'a', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    acc = store.account(acc.id)!;
    for (const who of ['sam', 'kim', 'lee']) store.ingest(acc, { t: 'identity', identity: { nativeId: who, displayName: who, contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['me', 'sam'] } });
    for (const g of ['climb', 'work', 'news', 'band', 'film']) store.ingest(acc, { t: 'conversation', conversation: { nativeId: g, shape: 'group', name: g, participants: ['me', 'kim', 'lee'] } });
    activity = new ActivityStore(store);
    // Eight days: everyone talks; you answer Sam, and every day you open "climb" an hour after it speaks, from far down.
    for (let d = 0; d < 8; d++) {
      const day = T0 + d * DAY;
      say('dm', 'sam', day + HOUR);
      say('dm', 'me', day + HOUR + 5 * MIN);
      for (const [i, g] of ['work', 'news', 'band', 'film'].entries()) say(g, 'kim', day + (2 + i) * HOUR);
      say('climb', 'lee', day + 7 * HOUR);
      open('climb', day + 8 * HOUR);
      open('dm', day + HOUR + 2 * MIN, { source: 'notification', rank: null, sent: 1 });
    }
    store.flush();
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fresh ranker is the prior, and wants to learn once opens have had their horizon', () => {
    const r = new InboxRanker(store, new Triage(store), 'model', undefined, () => NOW);
    expect(r.model).toEqual(PRIOR);
    expect(r.due()).toBe(true);
  });

  test('it refits from the log, a little at a time, and the place you keep opening moves up', async () => {
    let now = NOW;
    const triage = new Triage(store);
    const r = new InboxRanker(store, triage, 'model', join(dir, 'hub.sqlite'), () => now, false);
    const att = new Attention(store, triage, () => now);
    att.judge = r;
    // The next day, an hour after "climb" spoke, as on every other day.
    now = T0 + 8 * DAY + 8 * HOUR;
    say('climb', 'lee', now - HOUR);
    for (const [i, g] of ['work', 'news', 'band', 'film'].entries()) say(g, 'kim', now - (6 - i) * HOUR);
    store.flush();
    while (att.pump() > 0);
    const before = att.explain(cid('climb'))!;
    let fits = 0;
    r.onFit = () => fits++;
    const m = await r.refit({ stepMs: 1, pauseMs: 0 });
    expect(fits).toBe(1);
    expect(m.moments).toBeGreaterThan(10);
    expect(r.due()).toBe(false);
    att.rescoreAll(now);
    const rankOf = (score: (id: string) => number) => ['climb', 'work', 'news', 'band', 'film'].sort((a, b) => score(cid(b)) - score(cid(a))).indexOf('climb');
    const formula = rankOf((id) => att.explain(id)!.score);
    const learned = rankOf((id) => att.view(id)!.score);
    expect(learned).toBeLessThanOrEqual(formula);
    expect((att.explain(cid('climb'))!.learned as any).open).toBeGreaterThan((before.learned as any).open);
    // Saved: a new ranker starts from what was learned.
    expect(new InboxRanker(store, triage, 'model', undefined, () => now).model).toEqual(m);
  });

  test('exploring sorts by a sample that holds still within an epoch; off, by the mean; a big lift says why', () => {
    const triage = new Triage(store);
    const saved = new InboxRanker(store, triage, 'model', undefined, () => NOW).model;
    expect(saved.cov).toBeTruthy();
    const att = new Attention(store, triage, () => NOW);
    const r = new InboxRanker(store, triage, 'model', undefined, () => NOW);
    att.judge = r;
    att.rescoreAll(NOW);
    const ids = ['climb', 'work', 'news', 'band', 'film'].map(cid);
    const once = ids.map((id) => att.view(id)!.score);
    att.rescoreAll(NOW + MIN);
    // A minute later, the same draws: only what the features did moves a row.
    ids.forEach((id, i) => expect(Math.abs(att.view(id)!.score - once[i])).toBeLessThan(2));
    for (const id of ids) {
      const e = att.explain(id)!.learned as any;
      expect(e.explore).toBe(true);
      expect(att.view(id)!.score).toBe(e.sampled);
    }
    // Off: exactly the mean.
    const off = new Attention(store, triage, () => NOW);
    off.judge = new InboxRanker(store, triage, 'model', undefined, () => NOW, false);
    off.rescoreAll(NOW);
    for (const id of ids) expect(off.view(id)!.score).toBe((off.explain(id)!.learned as any).points);
    expect(r.view().explore).toMatchObject({ on: true, sampling: true, epochMinutes: 30, zClip: Z_CLIP });
    // A model saved before the curve and the covariance: due at once, so the first check after start fits them.
    const soon = new InboxRanker(store, triage, 'model', undefined, () => saved.fitAt! + MIN);
    expect(soon.due()).toBe(false);
    soon.model = { ...saved, cov: undefined };
    expect(soon.due()).toBe(true);
    soon.model = { ...saved, curve: undefined };
    expect(soon.due()).toBe(true);
    // Much doubt about a row: a draw lifts it, and its why says so, first.
    const doubt = new InboxRanker(store, triage, 'model', undefined, () => NOW);
    const free = saved.cov!.features;
    doubt.model = { ...saved, cov: { ...saved.cov!, open: free.map((_, i) => free.map((_, j) => (i === j ? 4 : 0))) } };
    const lifted = new Attention(store, triage, () => NOW);
    lifted.judge = doubt;
    lifted.rescoreAll(NOW);
    const views = ids.map((id) => lifted.view(id)!).filter((v) => v.reasons[0] === EXPLORE_REASON);
    for (let k = 0; !views.length && k < 48; k++) {
      lifted.rescoreAll(NOW + k * EXPLORE_EPOCH);
      views.push(...ids.map((id) => lifted.view(id)!).filter((v) => v.reasons[0] === EXPLORE_REASON));
    }
    expect(views.length).toBeGreaterThan(0);
  });

  test('shadow works it out and shows it, but the inbox keeps the formula; off does neither', () => {
    const triage = new Triage(store);
    for (const mode of ['shadow', 'off'] as const) {
      const att = new Attention(store, triage, () => NOW);
      att.judge = new InboxRanker(store, triage, mode, undefined, () => NOW);
      att.rescoreAll(NOW);
      const id = cid('climb');
      expect(att.view(id)!.score).toBeCloseTo(att.explain(id)!.score, 1);
      expect(att.explain(id)!.learned).toEqual(mode === 'shadow' ? expect.objectContaining({ mode: 'shadow' }) : null);
    }
  });

  test('the model as weights on named features, and back to the prior when the log is cleared', async () => {
    const triage = new Triage(store);
    const r = new InboxRanker(store, triage, 'model', undefined, () => NOW);
    const v = r.view();
    expect(Object.keys(v.learned.open).every((k) => (FEATURES as readonly string[]).includes(k))).toBe(true);
    // The examination curve it fitted, beside the guess, per stretch of rows.
    expect(v.examination.rows).toHaveLength(EXAM_AT.length);
    expect(v.examination.rows[0]).toMatchObject({ from: 1, to: 1, fitted: 1, guess: 1 });
    expect(v.examination.fittedFrom).toBeGreaterThan(0);
    // How far down the list was on screen, from the stays that say.
    expect(v.examination.staysWithDepth).toBe(0);
    open('work', T0 + 9 * DAY, { depth: 3 });
    open('work', T0 + 9 * DAY + HOUR, { depth: 20 });
    const seen = r.view().examination;
    expect(seen.staysWithDepth).toBe(2);
    expect(seen.rows.map((x) => x.onScreen)).toEqual(EXAM_AT.map((p) => (p <= 3 ? 1 : p <= 20 ? 0.5 : 0)));
    activity.clear();
    expect(r.due()).toBe(true);
    expect((await r.refit({ stepMs: 5, pauseMs: 0 })).moments).toBe(0);
    expect(r.model.open).toEqual(PRIOR.open);
    expect(r.due()).toBe(false);
  });
});

