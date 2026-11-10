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
  'important',
  'active',
  'digest',
  'notInteresting',
  'votedUp',
  'votedDown',
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
    // Where triage put the newest unread message, and your votes here lately (votes.ts): TRIAGE_FEATURES.
    important: x.level === 'push' ? 1 : 0,
    active: x.level === 'quiet' ? 1 : 0,
    digest: x.level === 'digest' ? 1 : 0,
    notInteresting: x.level === 'drop' ? 1 : 0,
    votedUp: Math.log1p(x.votes?.up ?? 0),
    votedDown: Math.log1p(x.votes?.down ?? 0),
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
  /** The examination curve fitted with it, one value per EXAM_AT bucket, and from how many inbox opens; absent: the guess. */
  curve?: number[] | null;
  curveFrom?: number;
}

/**
 * The prior. The open chance is logistic in the formula's score: about 1 in 160 at 0 points, 1 in 7 at 50, even at
 * 77, as fitted to the opens on a real hub (2026-11, `inbox-replay.ts --calibrate`). Only the formula's score moves
 * it, so it orders as the formula. About one open in six leads to a message of yours.
 */
export const PRIOR: RankModel = { open: { bias: -5.1, formula: 0.66 }, send: { bias: -1.6 }, fitAt: null, moments: 0, rows: 0 };

/**
 * What triage knows of importance: where it put the newest unread message, and your votes lately. Measured in the
 * replay (2026-11-10) they did not help, so the hub keeps them at the prior's 0 (`--triage` tries them again).
 */
export const TRIAGE_FEATURES: readonly Feature[] = ['important', 'active', 'digest', 'notInteresting', 'votedUp', 'votedDown'];

/** How hard each weight is pulled back to the prior: the formula's two little, everything else more; Infinity keeps it there. */
export const LAMBDA: Record<Feature, number> = Object.fromEntries(
  FEATURES.map((f) => [f, f === 'bias' || f === 'formula' ? 1 : TRIAGE_FEATURES.includes(f) ? Infinity : 30]),
) as Record<Feature, number>;

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
 * is listed". With a fitted `curve` (fitRank's `curve`), its value for the position's bucket; else the guess, a
 * power law as for search results (`eta` 0 says position does not matter).
 */
export function examination(position: number, eta = EXAMINATION_ETA, curve?: readonly number[] | null): number {
  if (curve?.length) return curve[Math.min(bucketOf(position), curve.length - 1)];
  return (1 + Math.max(0, position)) ** -eta;
}
export const EXAMINATION_ETA = 0.5;
/** An open from far down counts at most this many times: one click must not outweigh the rest. */
export const MAX_IPW = 10;
/** Where a fitted curve steps: bucket i holds the positions from EXAM_AT[i] up to the next. */
export const EXAM_AT = [0, 1, 2, 3, 5, 8, 12, 20, 35, 60, 100] as const;
/** A fitted curve never goes below this, so an open from far down counts at most MAX_IPW times. */
export const EXAM_FLOOR = 1 / MAX_IPW;
/** The guess per bucket, at each bucket's first position: where a fit starts, and what few opens are pulled back to. */
export const GUESSED_CURVE: readonly number[] = EXAM_AT.map((p) => (1 + p) ** -EXAMINATION_ETA);
/** Pseudo-opens of the guess in each bucket: a bucket with a handful of opens stays near it. */
const CURVE_PRIOR = 3;

export function bucketOf(position: number): number {
  let i = 0;
  while (i + 1 < EXAM_AT.length && position >= EXAM_AT[i + 1]) i++;
  return i;
}

/** One training row: the features, what happened (a chance, for a soft label), and how much it counts. */
export interface RankRow {
  x: Features;
  y: number;
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
      if (lam === Infinity) continue;
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
  /** `pos`: where the row stood in the formula's one list then (0 = top), as the inbox had it, near enough. */
  rows: { x: Features; weight: number; open: Opened | null; chosen: boolean; sent?: boolean; pos?: number }[];
}

/** How you first got to a conversation after a moment: the source, its inbox row then, and how long after (ms). */
export interface Opened {
  source: string;
  rank: number | null;
  after?: number;
}

/** What a fit can be told: the pull to the prior, the position correction and its cap, and the horizon. */
export interface FitOptions {
  lambda?: Record<Feature, number>;
  eta?: number;
  cap?: number;
  /** Only opens this soon count (the moments must have been built with at least this horizon). */
  horizon?: number;
  /**
   * Fit the examination curve too: a position-based click model (P(open from the inbox) = examination(position) ×
   * the open chance), fitted by alternating the two, `rounds` times (curveFit). 'ipw' weights an inbox open by
   * 1/examination, as the guess does; 'em' instead takes a row not opened as a chance that it was wanted but not
   * seen (regression-EM, Wang et al. 2018).
   */
  curve?: 'ipw' | 'em';
  rounds?: number;
}

/** Fit both chances from the moments, starting from the prior. `eta` is the position correction (`examination`). */
export function fitRank(moments: readonly Moment[], at: number, o: FitOptions = {}): RankModel {
  return drain(fitRankSteps(moments, at, o));
}

/** How the hub fits: the examination curve fitted to your opens, each inbox open weighted by 1/examination. */
export const FIT: FitOptions = { eta: EXAMINATION_ETA, curve: 'ipw' };

/** One row as the fit sees it: opened within the horizon or not, and where it stood. */
export interface FitRow {
  x: Features;
  w: number;
  opened: Opened | null;
  pos: number | null;
}

/** `fitRank` in steps. */
export function* fitRankSteps(moments: readonly Moment[], at: number, o: FitOptions = {}): Generator<undefined, RankModel> {
  const rows: FitRow[] = [];
  const send: RankRow[] = [];
  const horizon = o.horizon ?? HORIZON;
  for (const m of moments)
    for (const r of m.rows) {
      rows.push({ x: r.x, w: r.weight, opened: r.open && (r.open.after ?? 0) <= horizon ? r.open : null, pos: r.pos ?? null });
      if (r.chosen && r.sent !== undefined) send.push({ x: r.x, y: r.sent ? 1 : 0, w: 1 });
    }
  const fit = (labelled: RankRow[]) => fitSteps(labelled, PRIOR.open, o.lambda);
  // The guess first: an inbox open counts 1/examination times.
  let open = yield* fit(rows.map((r) => ({ x: r.x, y: r.opened ? 1 : 0, w: r.w * openWeight(r.opened, o.eta, o.cap) })));
  let curve: number[] | null = null;
  let curveFrom = 0;
  if (o.curve && rows.length) {
    for (let i = 0; i < (o.rounds ?? 2); i++) {
      ({ curve, from: curveFrom } = curveFit(rows, open));
      yield;
      open = yield* fit(o.curve === 'ipw' ? rows.map((r) => ({ x: r.x, y: r.opened ? 1 : 0, w: r.w * openWeight(r.opened, o.eta, o.cap, curve) })) : emRows(rows, open, curve));
    }
  }
  return {
    open,
    send: send.length ? yield* fitSteps(send, PRIOR.send, o.lambda) : { ...PRIOR.send },
    fitAt: at,
    moments: moments.length,
    rows: rows.length,
    ...(curve ? { curve, curveFrom } : {}),
  };
}

/**
 * The E-step of regression-EM: a row opened is wanted; a row not opened was either not wanted or wanted and not
 * seen, so it counts as wanted with the chance (1 − e)·p / (1 − e·p), e its examination, p the open chance now.
 */
function emRows(rows: readonly FitRow[], w: Weights, curve: readonly number[]): RankRow[] {
  return rows.map((r) => {
    if (r.opened) return { x: r.x, y: 1, w: r.w };
    const e = r.pos == null ? 1 : examination(r.pos, 0, curve);
    const p = sigmoid(dot(w, r.x));
    return { x: r.x, y: ((1 - e) * p) / (1 - e * p), w: r.w };
  });
}

/**
 * The examination curve that best explains where your inbox opens came from, given the open chance `w`: per bucket,
 * the e that makes the opens there as likely as possible when each row is opened with e × p (rows opened from
 * elsewhere say nothing about the inbox and are left out). Then relative to the top row, pulled toward the guess
 * by CURVE_PRIOR opens per bucket, never rising further down, and between EXAM_FLOOR and 1.
 */
export function curveFit(rows: readonly FitRow[], w: Weights): { curve: number[]; from: number } {
  const n = EXAM_AT.length;
  const opens = new Array<number>(n).fill(0);
  const ps: { p: number; w: number }[][] = Array.from({ length: n }, () => []);
  let from = 0;
  for (const r of rows) {
    if (r.opened?.source === 'inbox' && r.opened.rank != null) {
      opens[bucketOf(r.opened.rank)] += r.w;
      from++;
    } else if (!r.opened && r.pos != null) ps[bucketOf(r.pos)].push({ p: sigmoid(dot(w, r.x)), w: r.w });
  }
  // Per bucket, the e where opens/e = Σ p/(1 − e·p) over the rows not opened (decreasing in e: bisect).
  const raw = opens.map((c, b) => {
    if (!c || !ps[b].length) return null;
    const maxP = Math.max(...ps[b].map((x) => x.p));
    let lo = 1e-6;
    let hi = Math.min(50, 0.999 / maxP);
    for (let k = 0; k < 50; k++) {
      const e = (lo + hi) / 2;
      const g = c / e - ps[b].reduce((a, x) => a + (x.w * x.p) / (1 - e * x.p), 0);
      if (g > 0) lo = e;
      else hi = e;
    }
    return (lo + hi) / 2;
  });
  const top = raw[0];
  const est = raw.map((e, b) => (e == null || !top ? GUESSED_CURVE[b] : e / top));
  const weight = opens.map((c) => c + CURVE_PRIOR);
  const pulled = est.map((e, b) => (opens[b] * e + CURVE_PRIOR * GUESSED_CURVE[b]) / weight[b]);
  const curve = decreasing(pulled, weight).map((e, b) => (b === 0 ? 1 : Math.round(Math.max(EXAM_FLOOR, Math.min(1, e)) * 1000) / 1000));
  return { curve, from };
}

/** The closest sequence that never rises (pool adjacent violators), each value counting `w` times. */
export function decreasing(v: readonly number[], w: readonly number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  v.forEach((x, i) => {
    blocks.push({ v: x, w: w[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v < blocks[blocks.length - 1].v) {
      const b = blocks.pop()!;
      const a = blocks[blocks.length - 1];
      a.v = (a.v * a.w + b.v * b.w) / (a.w + b.w || 1);
      a.w += b.w;
      a.n += b.n;
    }
  });
  return blocks.flatMap((b) => new Array<number>(b.n).fill(b.v));
}

/**
 * How much a row that was opened counts: an open from an inbox row far down says more than one from the top,
 * since you were less likely to see it there (inverse propensity, capped). `curve`: a fitted one, else the guess.
 */
export function openWeight(open: Opened | null, eta = EXAMINATION_ETA, cap = MAX_IPW, curve?: readonly number[] | null): number {
  if (!open || open.source !== 'inbox' || open.rank == null) return 1;
  return Math.min(cap, 1 / examination(open.rank, eta, curve));
}

export { logit, sigmoid };
