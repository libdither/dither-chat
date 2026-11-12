/**
 * What an unanswered turn weighs as it ages (docs/inbox.md, "What you owe"): the chance that you still answer it
 * within the reply window (3 days from the message), given that it is still open now. A table by age, per place shape
 * (a DM, or anything else) and how often you answer there (the reply-rate bucket), fitted on your own history of
 * turns: every turn the fold closed (attention.ts `foldMessage`'s `onSettle`), plus those still open past the window.
 *
 * It replaced `60 × rate × owedCurve(age)`, which held a turn near full weight for a day whatever the age said: most
 * of the hours a row spent above the "needs you" line belonged to turns you never answered. In the replay
 * (scripts/owed-replay.ts, fitted before 2025), that share fell from 64% to 42% for DMs in 2025-26 and from 53% to 25%
 * in the hub era, keeping 83% and 86% of the hours on turns you did answer, with the same order among open turns.
 *
 * A reaction answers a turn but carries no time, so reacted turns count in the reply rates and not in the table.
 * Metadata only: who, when and whether you answered, never what was said.
 */
import type * as P from '@dither-chat/protocol';
import { emptyTally, record, replyRate, tallyAt, type Tally } from './attention.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** attention.ts REPLY_WINDOW (not imported: this module is loaded while attention.ts is). */
const WINDOW = 3 * DAY;

/** The ages the table gives chances at; between two, the chance is drawn straight; from the last on, nothing is owed. */
export const OWED_AGES: readonly number[] = [0, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 18 * HOUR, DAY, 1.5 * DAY, 2 * DAY, 2.5 * DAY, WINDOW];
/** Upper edges of the reply-rate buckets: a rate below the first is bucket 0, at or above the last the last bucket. */
export const RATE_EDGES: readonly number[] = [0.8, 0.9, 0.95, 0.98];
/** A cell's chances lean on its shape's, and a shape's on the default table, as if this many turns said so. */
const PRIOR_TURNS = 20;
/** Fewer turns of a shape than this, and that shape keeps the default table. */
const MIN_TURNS = 200;
/** Below this chance a turn is not shown as owed (no ↩, no `owedSince`): about 3 points of 60. */
export const OWED_SHOWN = 0.05;

export type OwedShape = 'direct' | 'group';
export const owedShape = (shape: P.Shape): OwedShape => (shape === 'direct' ? 'direct' : 'group');

export interface OwedTable {
  /** Upper edges of its reply-rate buckets (RATE_EDGES when fitted here). */
  rateEdges: number[];
  /** P(answered within the window | still open at OWED_AGES[i]), by shape, then bucket, then age. */
  chance: Record<OwedShape, number[][]>;
  /** The mean reply rate of each bucket's turns, by shape: between two, the chance is drawn straight by rate. */
  rateMids: Record<OwedShape, number[]>;
  /** The turns each shape's bucket was fitted on (0: the default's). */
  turns: Record<OwedShape, number[]>;
  /** When it was fitted; null for the default. */
  fittedAt: number | null;
}

/**
 * The table before the hub has fitted its own: one person's DMs and groups before 2025, from scripts/owed-replay.ts
 * `--table`, rounded. Used until a fit has enough turns, and by the tests and the demo hub.
 */
export const DEFAULT_OWED_TABLE: OwedTable = {
  rateEdges: [0.8, 0.9, 0.95, 0.98],
  chance: {
    direct: [
      [0.75, 0.5, 0.47, 0.43, 0.38, 0.36, 0.3, 0.26, 0.23, 0.18, 0.12, 0.07, 0.03, 0],
      [0.87, 0.7, 0.67, 0.63, 0.59, 0.57, 0.53, 0.5, 0.47, 0.37, 0.26, 0.15, 0.08, 0],
      [0.92, 0.78, 0.75, 0.72, 0.69, 0.67, 0.62, 0.58, 0.53, 0.45, 0.33, 0.23, 0.11, 0],
      [0.95, 0.78, 0.75, 0.72, 0.69, 0.67, 0.62, 0.58, 0.53, 0.45, 0.33, 0.23, 0.11, 0],
      [1, 0.96, 0.96, 0.95, 0.93, 0.92, 0.89, 0.86, 0.79, 0.68, 0.54, 0.31, 0.17, 0],
    ],
    group: [
      [0.84, 0.7, 0.67, 0.65, 0.6, 0.57, 0.52, 0.46, 0.44, 0.37, 0.3, 0.19, 0.07, 0],
      [0.9, 0.8, 0.79, 0.77, 0.75, 0.73, 0.7, 0.67, 0.62, 0.55, 0.42, 0.27, 0.1, 0],
      [0.92, 0.83, 0.82, 0.8, 0.77, 0.75, 0.72, 0.69, 0.64, 0.58, 0.46, 0.32, 0.17, 0],
      [0.96, 0.9, 0.89, 0.87, 0.85, 0.83, 0.8, 0.78, 0.73, 0.66, 0.53, 0.4, 0.19, 0],
      [0.99, 0.95, 0.94, 0.93, 0.92, 0.91, 0.89, 0.86, 0.81, 0.74, 0.63, 0.45, 0.25, 0],
    ],
  },
  rateMids: { direct: [0.627, 0.861, 0.928, 0.967, 0.997], group: [0.695, 0.863, 0.928, 0.968, 0.994] },
  turns: { direct: [0, 0, 0, 0, 0], group: [0, 0, 0, 0, 0] },
  fittedAt: null,
};

/** How often you answer this turn's author here: this conversation's rate, pulled toward theirs everywhere. */
export function turnRate(conv: Tally | null, person: Tally | null): number {
  return replyRate(conv, replyRate(person, 0.5));
}

export const rateBucket = (rate: number, edges: readonly number[] = RATE_EDGES) => {
  const i = edges.findIndex((e) => rate < e);
  return i < 0 ? edges.length : i;
};

/** The middle of each bucket between these edges (and 0 and 1). */
function midpoints(edges: readonly number[]): number[] {
  return [0, ...edges].map((lo, b) => (lo + (edges[b] ?? 1)) / 2);
}

/** Where `x` falls between two neighbours of the sorted `xs`: the lower one's index and how far on (0..1), clamped at the ends. */
function between(xs: readonly number[], x: number): [number, number] {
  if (xs.length < 2 || x <= xs[0]) return [0, 0];
  let i = 0;
  while (i + 2 < xs.length && xs[i + 1] <= x) i++;
  return [i, Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i] || 1)))];
}

/**
 * The chance a turn open for `age` is still answered in time, at this shape and reply rate: drawn straight between
 * the table's ages, and between its buckets' mean rates, so a higher rate never weighs less within a bucket. 0 past
 * the window.
 */
export function owedChance(table: OwedTable, shape: P.Shape, rate: number, age: number): number {
  const rows = table.chance[owedShape(shape)];
  if (!rows?.length || age >= OWED_AGES[OWED_AGES.length - 1]) return 0;
  const [i, f] = between(OWED_AGES, Math.max(0, age));
  const at = (row: number[]) => row[i] + (row[i + 1] - row[i]) * f;
  const mids = table.rateMids?.[owedShape(shape)] ?? midpoints(table.rateEdges);
  // Below the lowest bucket's middle, down to nothing at a rate of 0: someone you never answer is owed nothing.
  if (rate < mids[0]) return at(rows[0]) * Math.max(0, rate) / mids[0];
  const [b, g] = between(mids, rate);
  const lo = at(rows[b]);
  return rows[b + 1] ? lo + (at(rows[b + 1]) - lo) * g : lo;
}

// ------------------------------------------------------------------ fitting

/** One addressed turn and what came of it, as the fold closed it (or as it still stands). */
export interface OwedTurn {
  conversationId: string;
  shape: P.Shape;
  authorKey: string | null;
  /** When it became owed: its first message for you. */
  addressed: number;
  /** When you answered (your next message, or the message you reacted to); null: not yet, or it ran out. */
  answeredAt: number | null;
  /** False when a reaction answered it, or you marked it "No reply needed": at no known time. */
  timed: boolean;
  /** You marked it "No reply needed" (replymarks.ts): neither addressed nor answered, as the fold counts it. */
  dismissed?: boolean;
}

export interface FitOptions {
  /** Turns from before this are fitted on; later ones still count toward the reply rates. Default: all. */
  until?: number;
  /** The time it is: a turn not answered and younger than the window is still open, and says nothing yet. */
  now: number;
  prior?: OwedTable;
  /** The reply-rate buckets' edges; RATE_EDGES by default. Another than the prior's leans on the prior's middle bucket. */
  edges?: readonly number[];
}

/** A turn with the reply rate you had with its author when it opened. */
export interface RatedTurn extends OwedTurn {
  rate: number;
}

/**
 * Each turn's reply rate as of its first message, from the turns that were over by then: the same tallies and the
 * same pull toward the author's rate everywhere as scoring uses (attention.ts `scoreConversation`).
 */
export function rateTurns(turns: OwedTurn[]): RatedTurn[] {
  const byStart = [...turns].sort((a, b) => a.addressed - b.addressed);
  // A dismissed turn counts toward no rate, as in the fold (attention.ts `dismiss`).
  const over = byStart.filter((t) => !t.dismissed).map((t) => ({ t, at: t.answeredAt ?? t.addressed + WINDOW })).sort((a, b) => a.at - b.at);
  const conv = new Map<string, Tally>();
  const person = new Map<string, Tally>();
  const get = (m: Map<string, Tally>, k: string) => m.get(k) ?? m.set(k, emptyTally()).get(k)!;
  const out: RatedTurn[] = [];
  let j = 0;
  for (const t of byStart) {
    for (; j < over.length && over[j].at < t.addressed; j++) {
      const d = over[j].t;
      const latency = d.answeredAt === null ? null : d.answeredAt - d.addressed;
      record(get(conv, d.conversationId), over[j].at, latency, d.timed);
      if (d.authorKey) record(get(person, d.authorKey), over[j].at, latency, d.timed);
    }
    const c = conv.get(t.conversationId);
    const p = t.authorKey ? person.get(t.authorKey) : undefined;
    out.push({ ...t, rate: turnRate(c ? tallyAt(c, t.addressed) : null, p ? tallyAt(p, t.addressed) : null) });
  }
  return out;
}

/** How long a turn was open: until your answer, else for good. */
export const openFor = (t: OwedTurn) => (t.answeredAt === null ? Infinity : Math.max(0, t.answeredAt - t.addressed));
/** Answered in time. */
export const answeredInTime = (t: OwedTurn) => t.answeredAt !== null && t.answeredAt - t.addressed <= WINDOW;
/** Whether a turn says anything about how open turns end: timed, and either answered or over its window. */
export const settled = (t: OwedTurn, now: number) => t.timed && (t.answeredAt !== null || now - t.addressed >= WINDOW);

/** Of these turns, how many were open at each age, and how many of those were answered in time. */
function survival(ts: RatedTurn[]): { open: number[]; answered: number[] } {
  const open = OWED_AGES.map(() => 0);
  const answered = OWED_AGES.map(() => 0);
  for (const t of ts) {
    const o = openFor(t);
    const y = answeredInTime(t);
    for (let i = 0; i < OWED_AGES.length; i++) {
      if (i > 0 && o <= OWED_AGES[i]) break;
      open[i]++;
      if (y) answered[i]++;
    }
  }
  return { open, answered };
}

/** Chances that lean on `prior` where there are few turns, and never rise with age. The last age owes nothing. */
function smooth(s: { open: number[]; answered: number[] }, prior: number[]): number[] {
  let min = 1;
  return OWED_AGES.map((_, i) => {
    if (i === OWED_AGES.length - 1) return 0;
    const c = (s.answered[i] + PRIOR_TURNS * prior[i]) / (s.open[i] + PRIOR_TURNS);
    min = Math.min(min, c);
    return Math.round(min * 1000) / 1000;
  });
}

/**
 * Fit the table: per shape, the share of turns still open at each age that were answered in time, then per reply-rate
 * bucket, each leaning on the level above it where it has few turns. A shape with too few turns keeps the prior's rows.
 */
export function fitOwedTable(turns: OwedTurn[], o: FitOptions): OwedTable {
  const prior = o.prior ?? DEFAULT_OWED_TABLE;
  const edges = [...(o.edges ?? RATE_EDGES)];
  const rated = rateTurns(turns).filter((t) => settled(t, o.now) && (o.until === undefined || t.addressed < o.until));
  const out: OwedTable = { rateEdges: edges, chance: { direct: [], group: [] }, rateMids: { direct: [], group: [] }, turns: { direct: [], group: [] }, fittedAt: o.now };
  // The prior's row for a bucket: its own where the edges agree, else the prior's bucket for the middle of this one.
  const same = edges.length === prior.rateEdges.length && edges.every((e, i) => e === prior.rateEdges[i]);
  const priorRows = (shape: OwedShape) =>
    edges.concat(1).map((hi, b) => prior.chance[shape][same ? b : rateBucket(((b ? edges[b - 1] : 0) + hi) / 2, prior.rateEdges)]);
  for (const shape of ['direct', 'group'] as OwedShape[]) {
    const mine = rated.filter((t) => owedShape(t.shape) === shape);
    const buckets = Array.from({ length: edges.length + 1 }, (_, b) => mine.filter((t) => rateBucket(t.rate, edges) === b));
    const pr = priorRows(shape);
    const mids = midpoints(edges);
    out.rateMids[shape] = buckets.map((b, i) => (b.length >= PRIOR_TURNS ? Math.round((b.reduce((a, t) => a + t.rate, 0) / b.length) * 1e4) / 1e4 : mids[i]));
    // Means of neighbouring buckets are in order unless a bucket is nearly empty: then its middle.
    for (let i = 1; i < mids.length; i++) if (out.rateMids[shape][i] <= out.rateMids[shape][i - 1]) out.rateMids[shape][i] = Math.max(mids[i], out.rateMids[shape][i - 1] + 1e-4);
    if (mine.length < MIN_TURNS) {
      out.chance[shape] = pr.map((r) => [...r]);
      out.rateMids[shape] = mids;
      out.turns[shape] = buckets.map(() => 0);
      continue;
    }
    // The shape's own rows, from the prior's bucket rows averaged by how many turns each bucket has.
    const whole = survival(mine);
    const weights = buckets.map((b) => b.length / mine.length);
    const priorRow = OWED_AGES.map((_, i) => pr.reduce((a, r, b) => a + r[i] * weights[b], 0));
    const shapeRow = smooth(whole, priorRow);
    out.chance[shape] = buckets.map((b) => smooth(survival(b), shapeRow));
    // Nor fall as the rate rises: a bucket below its neighbour takes the neighbour's chance.
    for (let b = 1; b < out.chance[shape].length; b++) out.chance[shape][b] = out.chance[shape][b].map((c, i) => Math.max(c, out.chance[shape][b - 1][i]));
    out.turns[shape] = buckets.map((b) => b.length);
  }
  return out;
}

/** Whether a stored table still fits this code: the same ages, a row per bucket. */
export function validTable(t: unknown): t is OwedTable {
  const x = t as OwedTable;
  if (!x || typeof x !== 'object' || !Array.isArray(x.rateEdges) || !x.chance) return false;
  const ok = (rows: unknown) =>
    Array.isArray(rows) && rows.length === x.rateEdges.length + 1 && rows.every((r) => Array.isArray(r) && r.length === OWED_AGES.length && r.every((v) => typeof v === 'number' && v >= 0 && v <= 1));
  const mids = (m: unknown) => Array.isArray(m) && m.length === x.rateEdges.length + 1 && m.every((v) => typeof v === 'number');
  return ok(x.chance.direct) && ok(x.chance.group) && !!x.rateMids && mids(x.rateMids.direct) && mids(x.rateMids.group);
}
