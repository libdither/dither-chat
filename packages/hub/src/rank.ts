/**
 * The inbox's learned order (docs/inbox.md, "A learned order"). Two chances per conversation, each a logistic
 * regression over its metadata (never its text):
 *
 *  - open: you open it within the next few hours (`HORIZON`), given it is listed;
 *  - send: you write in it, given you opened it.
 *
 * The order is the expected value, open × (1 + send), turned back into the formula's points so the client still
 * sorts by one score and the switcher's lift means the same. "Seeing a chat because it is listed" is the third
 * chance, and it depends on where the row is, not on the chat: rows higher up are looked at more, so they get
 * opened more whatever they are. That is `examination`, and training divides it out of what you opened from the
 * inbox (the visit log keeps the row's position then).
 *
 * Both start from a prior that orders a fresh hub as the formula does: the open chance is a function of the
 * formula's score alone, the send chance a constant. What the hub learns from your opens is added on top, pulled
 * back to the prior (L2), so a few days of opens move it a little and a few weeks more.
 */
import { decayed } from '@dither-chat/protocol';
import { lastThere, type ScoreInput, type Scored } from './attention.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "Opened within the next few hours": the open chance's horizon. */
export const HORIZON = 3 * HOUR;
/** An open that leads to a message of yours is worth this much more than one that does not. */
export const SEND_VALUE = 1;

/** The features, in a fixed order. All from metadata: times, counts, shapes, the formula's parts. */
export const FEATURES = [
  'bias',
  'formula',
  'here',
  'hereDay',
  'never',
  'message',
  'messageDay',
  'wrote',
  'unread',
  'mentions',
  'owed',
  'live',
  'pinged',
  'relationship',
  'noise',
  'visits',
  'minutes',
  'direct',
  'group',
  'self',
  'muted',
] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, number>;

/** One conversation at one moment, as the model sees it. `s` is the formula's score of the same input. */
export function rankFeatures(x: ScoreInput, s: Scored): Features {
  const now = x.now;
  const since = (t: number | null | undefined) => (t ? Math.max(0, now - t) : Infinity);
  const there = since(lastThere(x.usage));
  const message = since(x.lastMessageAt);
  const u = x.usage;
  return {
    bias: 1,
    formula: s.score / 10,
    here: 2 ** (-there / HOUR),
    hereDay: 2 ** (-there / DAY),
    never: there === Infinity ? 1 : 0,
    message: 2 ** (-message / HOUR),
    messageDay: 2 ** (-message / DAY),
    wrote: 2 ** (-since(x.state.lastSent) / DAY),
    unread: Math.min(x.unread, 10) / 10,
    mentions: Math.min(x.mentions, 3) / 3,
    owed: (s.parts.owed ?? 0) / 60,
    live: (s.parts.live ?? 0) / 30,
    pinged: x.pinged ? 1 : 0,
    relationship: s.relationship,
    noise: s.noise.fit,
    visits: u ? Math.log1p(decayed(u.visitScore, u.at, now)) : 0,
    minutes: u ? Math.log1p(decayed(u.score, u.at, now) / 60) : 0,
    direct: x.shape === 'direct' ? 1 : 0,
    group: x.shape === 'group' ? 1 : 0,
    self: x.shape === 'self' ? 1 : 0,
    muted: x.muted ? 1 : 0,
  };
}

export const vector = (f: Features): number[] => FEATURES.map((k) => f[k]);

// ------------------------------------------------------------------ the model

export type Weights = Partial<Record<Feature, number>>;

export interface RankModel {
  open: Weights;
  send: Weights;
  /** When it was fitted, and from how many moments (opens) and rows. Null: the prior. */
  fitAt: number | null;
  moments: number;
  rows: number;
}

/**
 * The prior. The open chance is logistic in the formula's score: about 1 in 160 at 0 points, 1 in 7 at 50, even at
 * 77, as fitted to the opens on a real hub (2026-11, `inbox-replay.ts --calibrate`). Only the formula's score moves
 * it, so it orders as the formula. About one open in six leads to a message of yours.
 */
export const PRIOR: RankModel = { open: { bias: -5.1, formula: 0.66 }, send: { bias: -1.6 }, fitAt: null, moments: 0, rows: 0 };

/** How hard each weight is pulled back to the prior: the formula's two little, everything else more. */
export const LAMBDA: Record<Feature, number> = Object.fromEntries(FEATURES.map((f) => [f, f === 'bias' || f === 'formula' ? 1 : 30])) as Record<Feature, number>;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));
const dot = (w: Weights, f: Features) => FEATURES.reduce((a, k) => a + (w[k] ?? 0) * f[k], 0);

export interface Prediction {
  open: number;
  send: number;
  /** open × (1 + SEND_VALUE × send). */
  value: number;
  /** The value in the formula's points: under the prior, exactly the formula's own score. */
  points: number;
}

export function predict(m: RankModel, f: Features): Prediction {
  const open = sigmoid(dot(m.open, f));
  const send = sigmoid(dot(m.send, f));
  const value = open * (1 + SEND_VALUE * send);
  // The value as the open chance the prior would need to give it, with the prior's send chance; then the formula's
  // points that give that chance. Under the prior that is the formula's score itself.
  const as = Math.min(1 - 1e-9, value / (1 + SEND_VALUE * sigmoid(PRIOR.send.bias!)));
  const points = (10 * (logit(as) - PRIOR.open.bias!)) / PRIOR.open.formula!;
  return { open, send, value, points: Math.round(Math.max(-100, Math.min(200, points)) * 10) / 10 };
}

/**
 * How likely you are to look at the row at `position` (0 = top), relative to the top: "seeing a chat because it
 * is listed". A power law, as for search results; `eta` 0 says position does not matter.
 */
export function examination(position: number, eta = EXAMINATION_ETA): number {
  return (1 + Math.max(0, position)) ** -eta;
}
export const EXAMINATION_ETA = 0.5;
/** An open from far down counts at most this many times: one click must not outweigh the rest. */
export const MAX_IPW = 10;

/** One training row: the features, what happened, and how much it counts. */
export interface RankRow {
  x: Features;
  y: 0 | 1;
  w: number;
}

/** Run a generator of steps to the end. */
export function drain<T>(g: Generator<undefined, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * L2-regularised logistic regression toward `prior`, by coordinate Newton steps (as learn.ts). Dense: every row has
 * every feature.
 */
export function fitLogistic(rows: readonly RankRow[], prior: Weights, lambda: Record<Feature, number> = LAMBDA, sweeps = 25): Weights {
  return drain(fitSteps(rows, prior, lambda, sweeps));
}

/** `fitLogistic`, a feature at a time: the hub pauses between steps. */
export function* fitSteps(rows: readonly RankRow[], prior: Weights, lambda: Record<Feature, number> = LAMBDA, sweeps = 25): Generator<undefined, Weights> {
  const xs = rows.map((r) => vector(r.x));
  const w = FEATURES.map((k) => prior[k] ?? 0);
  const p0 = [...w];
  const z = xs.map((x) => x.reduce((a, v, j) => a + v * w[j], 0));
  for (let s = 0; s < sweeps; s++) {
    let moved = 0;
    for (let j = 0; j < FEATURES.length; j++) {
      const lam = lambda[FEATURES[j]];
      let g = lam * (w[j] - p0[j]);
      let H = lam;
      for (let i = 0; i < rows.length; i++) {
        const x = xs[i][j];
        if (!x) continue;
        const p = sigmoid(z[i]);
        g += rows[i].w * (p - rows[i].y) * x;
        H += rows[i].w * p * (1 - p) * x * x;
      }
      const d = Math.max(-2, Math.min(2, -g / H));
      if (!d) continue;
      w[j] += d;
      for (let i = 0; i < rows.length; i++) if (xs[i][j]) z[i] += d * xs[i][j];
      moved = Math.max(moved, Math.abs(d));
      yield;
    }
    if (moved < 1e-4) break;
  }
  return Object.fromEntries(FEATURES.map((k, j) => [k, Math.round(w[j] * 1e4) / 1e4]).filter(([, v]) => v !== 0));
}

/**
 * A moment you opened something: the listed conversations then (a sample, each row counting `weight` times), which
 * of them you opened within the horizon and how you first got there, and whether you wrote in the one you opened.
 */
export interface Moment {
  at: number;
  rows: { x: Features; weight: number; open: { source: string; rank: number | null } | null; chosen: boolean; sent?: boolean }[];
}

/** Fit both chances from the moments, starting from the prior. `eta` is the position correction (`examination`). */
export function fitRank(moments: readonly Moment[], at: number, o: { lambda?: Record<Feature, number>; eta?: number } = {}): RankModel {
  return drain(fitRankSteps(moments, at, o));
}

/** `fitRank` in steps. */
export function* fitRankSteps(moments: readonly Moment[], at: number, o: { lambda?: Record<Feature, number>; eta?: number } = {}): Generator<undefined, RankModel> {
  const open: RankRow[] = [];
  const send: RankRow[] = [];
  for (const m of moments)
    for (const r of m.rows) {
      open.push({ x: r.x, y: r.open ? 1 : 0, w: r.weight * (r.open ? openWeight(r.open, o.eta) : 1) });
      if (r.chosen && r.sent !== undefined) send.push({ x: r.x, y: r.sent ? 1 : 0, w: 1 });
    }
  return {
    open: open.length ? yield* fitSteps(open, PRIOR.open, o.lambda) : { ...PRIOR.open },
    send: send.length ? yield* fitSteps(send, PRIOR.send, o.lambda) : { ...PRIOR.send },
    fitAt: at,
    moments: moments.length,
    rows: open.length,
  };
}

/**
 * How much a row that was opened counts: an open from an inbox row far down says more than one from the top,
 * since you were less likely to see it there (inverse propensity, capped).
 */
export function openWeight(open: { source: string; rank: number | null } | null, eta = EXAMINATION_ETA): number {
  if (!open || open.source !== 'inbox' || open.rank == null) return 1;
  return Math.min(MAX_IPW, 1 / examination(open.rank, eta));
}

export { logit, sigmoid };
