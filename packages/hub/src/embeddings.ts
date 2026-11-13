/**
 * Message embeddings as content features for triage (docs/embeddings.md, docs/research/notification-design.md §5).
 *
 * jev, the machine's local model service, turns each message into a 256-d vector (Qwen3-Embedding-0.6B, prompted
 * with what the message asks of the reader). They live in their own `embeddings.sqlite` next to the hub database:
 * never in the sync journal, the activity exports or the logs, and they can always be made again. Each is centred on
 * the background mean (short chat messages otherwise all look alike), scaled to unit length and kept as int8.
 *
 * From them come numeric features per message, which the learning model weighs like any other:
 *   emb        a cross-fitted linear probe's logit: "reads like messages you answer"
 *   knn        how close it is to your labelled positives minus your negatives, nearest first in the same author's,
 *              then the conversation's, then all examples
 *   jev:<q>    jev's yes/no answer to a fixed question, as a logit (`QUESTIONS`: none are asked now)
 * A missing feature is absent from the map and so contributes nothing: jev down, nothing to embed, too few labels.
 *
 * Off unless DITHER_EMBEDDINGS=1. The embedder never blocks triage: it follows new messages in the background, in
 * batches, and fills in the last 30 days slowly when there is nothing new.
 */
import { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { isPrivateUrl } from './categorize.ts';
import { BUSY_MS } from './store.ts';
import { QUIET_CONVS_SQL, QUIET_VARIANTS, QUIET_VARIANTS_SQL } from './feed.ts';
import { SLICE_ROWS, sliced, whole, type SliceOptions } from './slices.ts';
import { noteWork } from './stalls.ts';
import { jobFailed } from './errors.ts';

type Head = P.TriageHead;

export const DIMS = 256;
export const EMBED_MODEL = 'qwen3-embedding:0.6b';
/** A fixed string: jev caches by it, and vectors made with another are not comparable. */
export const EMBED_INSTRUCT = 'Given a chat message someone received, represent what it asks of them, who it involves and how soon it needs them';
/** Bodies shorter than this carry the start of the message they reply to: "lol" to you is not "lol" to someone else. */
export const SHORT = 40;
export const RETENTION_DAYS = 30;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * jev's questions for content features: none now. The three there were (does it ask something, is it time-sensitive,
 * is it about plans with you) fed only the shadow model and answered about 1% on real messages. The one question
 * that decides anything, whether a message cannot wait, is triage's own (triage.ts `STOP_QUESTION`).
 */
export const QUESTIONS: Record<string, string> = {};
export const JEV_INSTRUCT = 'Given a chat message someone received, judge whether it meets the description';

// ------------------------------------------------------------------ what is embedded

export interface EmbedInput {
  body: string;
  shape: string;
  /** The message it replies to, and whether that one is yours. */
  reply?: { body: string; mine: boolean } | null;
  attachments?: { kind: string; name?: string | null }[];
  embedTitle?: string | null;
}

const SHAPE_WORD: Record<string, string> = { direct: 'DM', group: 'group chat', channel: 'channel', thread: 'thread', self: 'note to self' };

/** Mentions, custom emoji and code fences out; whitespace folded; at most `max` characters. */
export function cleanText(s: string, max = 1000): string {
  return s
    .replace(/<[@#:!&a-z]*[^>]*>/gi, ' ')
    .replace(/```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * What jev embeds for a message: `[shape] text`, with the start of the replied-to message when the text is short,
 * and for an empty body its first attachment or link title. Null when there is nothing to embed.
 */
export function embedText(m: EmbedInput): string | null {
  const body = cleanText(m.body);
  let text = body;
  if (!text) {
    const a = m.attachments?.[0];
    if (a) text = `(${a.kind}${a.name ? `: ${cleanText(a.name, 100)}` : ''})`;
    else if (m.embedTitle && cleanText(m.embedTitle)) text = `(link: ${cleanText(m.embedTitle, 200)})`;
  }
  if (!text) return null;
  const replied = m.reply ? cleanText(m.reply.body, 100) : '';
  const ctx = replied && body.length < SHORT ? ` (replying to ${m.reply!.mine ? 'your' : 'a'} message: "${replied}")` : '';
  return `[${SHAPE_WORD[m.shape] ?? m.shape}]${ctx} ${text}`;
}

// ------------------------------------------------------------------ vector math

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function unit(v: ArrayLike<number>): Float32Array {
  const n = Math.sqrt(dot(v, v)) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function meanOf(vs: readonly ArrayLike<number>[]): Float32Array {
  const m = new Float32Array(vs[0]?.length ?? DIMS);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i] += v[i] / vs.length;
  return m;
}

/** Take away the background mean and scale to unit length; `norm` is how far it was, to undo it. */
export function centre(v: ArrayLike<number>, mean: ArrayLike<number>): { v: Float32Array; norm: number } {
  const d = Float32Array.from(v, (x, i) => x - mean[i]);
  const norm = Math.sqrt(dot(d, d));
  return { v: unit(d), norm };
}

/** int8 with one scale per vector: the largest component maps to ±127. */
export function quantize(v: ArrayLike<number>): { q: Int8Array; scale: number } {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max / 127 || 1;
  return { q: Int8Array.from(v, (x) => Math.round(x / scale)), scale };
}

export function dequantize(q: Int8Array, scale: number): Float32Array {
  return Float32Array.from(q, (x) => x * scale);
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const logit = (p: number, eps = 1e-3) => {
  const q = Math.min(1 - eps, Math.max(eps, p));
  return Math.log(q / (1 - q));
};

// ------------------------------------------------------------------ labels (§3, the reply/reaction part)

export interface Turn {
  id: string;
  conversation: string;
  ts: number;
  mine: boolean;
  replyTo?: string | null;
  /** You reacted to it. The network gives no time for a reaction, so it counts as at once. */
  reacted?: boolean;
}

export interface Outcome {
  /** How long until you answered it (a reply, a reaction, or your next message there), or null. */
  delay: number | null;
  /** You had written there in the quarter hour before: you were already in the conversation. */
  engaged: boolean;
}

export const ENGAGED_MS = 15 * MIN;
export const PING_MS = 15 * MIN;
export const ACTIVE_MS = 3 * 60 * MIN;

/**
 * What you did about each message from someone else. Your reply goes to the message it names, else to the last
 * message before it from someone else that has no answer yet; a reaction answers its message.
 */
export function outcomes(turns: readonly Turn[]): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  const at = new Map<string, number>();
  const byConv = new Map<string, Turn[]>();
  for (const t of turns) (byConv.get(t.conversation) ?? byConv.set(t.conversation, []).get(t.conversation)!).push(t);
  for (const list of byConv.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let lastMine: number | null = null;
    let lastOther: Turn | null = null;
    for (const t of list) {
      if (!t.mine) {
        out.set(t.id, { delay: t.reacted ? 0 : null, engaged: lastMine !== null && t.ts - lastMine <= ENGAGED_MS });
        at.set(t.id, t.ts);
        lastOther = t;
        continue;
      }
      const target = t.replyTo && out.has(t.replyTo) ? t.replyTo : lastOther?.id;
      const o = target ? out.get(target) : undefined;
      if (o && o.delay === null) o.delay = Math.max(0, t.ts - at.get(target!)!);
      lastMine = t.ts;
      lastOther = null;
    }
  }
  return out;
}

/** What an outcome says of importance, as far as the reply rule goes: you answered within three hours. Engaged messages say nothing. */
export function outcomeLabels(o: Outcome): Partial<Record<Head, 0 | 1>> {
  if (o.engaged) return {};
  const d = o.delay;
  return { important: d !== null && d <= ACTIVE_MS ? 1 : 0 };
}

/** A vote from before the tiers (learn.ts `labels`). */
export function voteLabels(level: P.NotifyTier): Partial<Record<Head, 0 | 1>> {
  return { important: level === 'push' || level === 'quiet' ? 1 : 0 };
}

/** A Beta-smoothed answer rate as a logit, pulled toward `prior` by `m` pseudo-examples. */
export function rateLogit(pos: number, n: number, prior: number, m = 2): number {
  return logit((pos + m * prior) / (n + m), 1e-3);
}

// ------------------------------------------------------------------ the linear probe

export interface Probe {
  w: Float64Array;
  b: number;
}

export interface ProbeOptions {
  /** Each example's starting logit (the conversation's answer rate): the probe learns what is left. */
  offset?: readonly number[];
  weight?: readonly number[];
  lambda?: number;
  iters?: number;
}

/**
 * L2 logistic regression on unit vectors, by Böhning's bound: the Hessian never exceeds XᵀX/4, so one Cholesky
 * factor of that (plus λ) serves every step. Each step costs one pass over the data and converges monotonically.
 */
export function fitProbe(X: readonly ArrayLike<number>[], y: readonly number[], o: ProbeOptions = {}): Probe {
  return whole(fitProbeSteps(X, y, o));
}

/**
 * `fitProbe` as steps (slices.ts): the same arithmetic in the same order, yielding the rows it worked through about
 * every `SLICE_ROWS`. A row of the bound costs about d/4 rows of a gradient pass, so it counts as that many. The loops
 * themselves are plain functions over a range of rows, which the engine optimises better than a generator's body.
 */
export function* fitProbeSteps(X: readonly ArrayLike<number>[], y: readonly number[], o: ProbeOptions = {}): Generator<number, Probe> {
  const n = X.length;
  const d = X[0]?.length ?? DIMS;
  const D = d + 1;
  const lambda = o.lambda ?? 10;
  const H = new Float64Array(D * D);
  const row = new Float64Array(D);
  const boundRow = Math.max(1, Math.round(D / 4));
  const boundChunk = Math.max(1, Math.floor(SLICE_ROWS / boundRow));
  for (let i = 0; i < n; i += boundChunk) {
    const end = Math.min(n, i + boundChunk);
    addBound(H, row, X, o.weight, d, i, end);
    yield (end - i) * boundRow;
  }
  for (let j = 0; j < d; j++) H[j * D + j] += lambda;
  H[d * D + d] += 1e-3;
  const L = yield* choleskySteps(H, D);
  const w = new Float64Array(D);
  const g = new Float64Array(D);
  for (let it = 0; it < (o.iters ?? 60); it++) {
    g.fill(0);
    for (let i = 0; i < n; i += SLICE_ROWS) {
      const end = Math.min(n, i + SLICE_ROWS);
      addGradient(g, w, X, y, o.offset, o.weight, d, i, end);
      yield end - i;
    }
    for (let j = 0; j < d; j++) g[j] += lambda * w[j];
    const step = solve(L, D, g);
    let moved = 0;
    for (let j = 0; j < D; j++) {
      w[j] -= step[j];
      moved = Math.max(moved, Math.abs(step[j]));
    }
    if (moved < 1e-5) break;
  }
  return { w: w.slice(0, d), b: w[d] };
}

/** Rows [from, to) of the bound XᵀCX/4, into H's lower triangle. */
function addBound(H: Float64Array, row: Float64Array, X: readonly ArrayLike<number>[], weight: readonly number[] | undefined, d: number, from: number, to: number) {
  const D = d + 1;
  for (let i = from; i < to; i++) {
    const x = X[i];
    for (let j = 0; j < d; j++) row[j] = x[j];
    row[d] = 1;
    const s = (weight?.[i] ?? 1) / 4;
    for (let j = 0; j < D; j++) {
      const sj = s * row[j];
      if (!sj) continue;
      const base = j * D;
      for (let k = 0; k <= j; k++) H[base + k] += sj * row[k];
    }
  }
}

/** Rows [from, to) of the log loss's gradient at w, into g. */
function addGradient(g: Float64Array, w: Float64Array, X: readonly ArrayLike<number>[], y: readonly number[], offset: readonly number[] | undefined, weight: readonly number[] | undefined, d: number, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const x = X[i];
    let z = (offset?.[i] ?? 0) + w[d];
    for (let j = 0; j < d; j++) z += w[j] * x[j];
    const r = (weight?.[i] ?? 1) * (sigmoid(z) - y[i]);
    for (let j = 0; j < d; j++) g[j] += r * x[j];
    g[d] += r;
  }
}

export const probeLogit = (p: Probe, x: ArrayLike<number>) => p.b + dot(p.w, x);

/** Lower-triangular L with LLᵀ = A (A given in its lower triangle, row-major), a few rows at a time. */
function* choleskySteps(A: Float64Array, D: number): Generator<number, Float64Array> {
  const L = new Float64Array(D * D);
  // Row i costs about i²/2 multiply-adds, a gradient row about 2D: rows up to about SLICE_ROWS of those at a time.
  for (let i = 0; i < D; ) {
    let cost = 0;
    const from = i;
    while (i < D && (i === from || cost + (i * i) / (4 * D) <= SLICE_ROWS)) {
      cost += (i * i) / (4 * D);
      i++;
    }
    choleskyRows(A, L, D, from, i);
    yield Math.ceil(cost);
  }
  return L;
}

function choleskyRows(A: Float64Array, L: Float64Array, D: number, from: number, to: number) {
  for (let i = from; i < to; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * D + j];
      for (let k = 0; k < j; k++) s -= L[i * D + k] * L[j * D + k];
      L[i * D + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * D + j];
    }
  }
}

function solve(L: Float64Array, D: number, b: Float64Array): Float64Array {
  const z = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * D + k] * z[k];
    z[i] = s / L[i * D + i];
  }
  const x = new Float64Array(D);
  for (let i = D - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < D; k++) s -= L[k * D + i] * x[k];
    x[i] = s / L[i * D + i];
  }
  return x;
}

/** k contiguous blocks of examples already in time order: folds that keep a burst together. */
export function timeFolds(n: number, k = 5): number[] {
  return Array.from({ length: n }, (_, i) => Math.min(k - 1, Math.floor((i * k) / Math.max(1, n))));
}

/**
 * Out-of-fold probe logits: each example scored by a probe that never saw it, so a model trained on them does not
 * learn to trust a probe that memorised its own labels. Folds with no positive or no negative left score null.
 */
export function crossFit(X: readonly ArrayLike<number>[], y: readonly number[], folds: readonly number[], o: ProbeOptions = {}): (number | null)[] {
  return whole(crossFitSteps(X, y, folds, o));
}

export function* crossFitSteps(X: readonly ArrayLike<number>[], y: readonly number[], folds: readonly number[], o: ProbeOptions = {}): Generator<number, (number | null)[]> {
  const out: (number | null)[] = X.map(() => null);
  for (const f of new Set(folds)) {
    const tr = folds.flatMap((g, i) => (g === f ? [] : [i]));
    if (!tr.some((i) => y[i]) || !tr.some((i) => !y[i])) continue;
    const p = yield* fitProbeSteps(
      tr.map((i) => X[i]),
      tr.map((i) => y[i]),
      { ...o, offset: o.offset && tr.map((i) => o.offset![i]), weight: o.weight && tr.map((i) => o.weight![i]) },
    );
    let done = 0;
    for (let i = 0; i < folds.length; i++) {
      if (folds[i] !== f) continue;
      out[i] = probeLogit(p, X[i]);
      if (++done >= SLICE_ROWS) {
        yield done;
        done = 0;
      }
    }
    if (done) yield done;
  }
  return out;
}

/** The strengths `chooseLambda` tries. */
export const LAMBDAS = [1, 3, 10, 30];

/**
 * The probe's strength, chosen by its own cross-validation on the time folds: the one whose out-of-fold logits have
 * the lowest weighted log loss. Picking it on the days it is judged on would flatter it.
 */
export function chooseLambda(X: readonly ArrayLike<number>[], y: readonly number[], folds: readonly number[], o: ProbeOptions = {}, grid = LAMBDAS): number {
  return whole(chooseLambdaSteps(X, y, folds, o, grid));
}

export function* chooseLambdaSteps(X: readonly ArrayLike<number>[], y: readonly number[], folds: readonly number[], o: ProbeOptions = {}, grid = LAMBDAS): Generator<number, number> {
  let best = { lambda: o.lambda ?? 10, loss: Infinity };
  for (const lambda of grid) {
    const oof = yield* crossFitSteps(X, y, folds, { ...o, lambda });
    let loss = 0;
    let n = 0;
    oof.forEach((z, i) => {
      if (z === null) return;
      const w = o.weight?.[i] ?? 1;
      const p = 1 / (1 + Math.exp(-z));
      loss -= w * Math.log(Math.min(1 - 1e-9, Math.max(1e-9, y[i] ? p : 1 - p)));
      n += w;
    });
    if (n && loss / n < best.loss) best = { lambda, loss: loss / n };
  }
  return best.lambda;
}

// ------------------------------------------------------------------ nearest labelled neighbours

export interface Labelled {
  id: string;
  conversation: string;
  author: string | null;
  x: ArrayLike<number>;
  y: 0 | 1;
}

/** Mean of the k largest values. */
function topMean(sims: number[], k: number): number {
  sims.sort((a, b) => b - a);
  const m = Math.min(k, sims.length);
  let s = 0;
  for (let i = 0; i < m; i++) s += sims[i];
  return m ? s / m : 0;
}

/**
 * kNN similarity: the mean cosine to the k nearest positives minus the same for negatives, within the narrowest
 * scope (the author's examples, else the conversation's, else all) that has `min` examples of which some are
 * positive and some negative.
 */
export class KnnIndex {
  private byAuthor = new Map<string, number[]>();
  private byConv = new Map<string, number[]>();
  private all: number[];

  constructor(readonly examples: readonly Labelled[], readonly k = 5, readonly min = 10) {
    this.all = examples.map((_, i) => i);
    examples.forEach((e, i) => {
      if (e.author) (this.byAuthor.get(e.author) ?? this.byAuthor.set(e.author, []).get(e.author)!).push(i);
      (this.byConv.get(e.conversation) ?? this.byConv.set(e.conversation, []).get(e.conversation)!).push(i);
    });
  }

  /** Null when no scope has both kinds. `exclude` leaves one example out (itself, when scoring the examples). */
  score(x: ArrayLike<number>, scope: { author?: string | null; conversation?: string }, exclude?: ReadonlySet<string>): number | null {
    const scopes = [scope.author ? this.byAuthor.get(scope.author) : undefined, scope.conversation ? this.byConv.get(scope.conversation) : undefined, this.all];
    for (const [s, idx] of scopes.entries()) {
      if (!idx) continue;
      const use = exclude ? idx.filter((i) => !exclude.has(this.examples[i].id)) : idx;
      const pos: number[] = [];
      const neg: number[] = [];
      for (const i of use) (this.examples[i].y ? pos : neg).push(dot(x, this.examples[i].x));
      if (pos.length && neg.length && (use.length >= this.min || s === 2)) return topMean(pos, this.k) - topMean(neg, this.k);
    }
    return null;
  }
}

// ------------------------------------------------------------------ jev's answers

/** Would jev's content questions be asked of a message with these chances? Only where its importance is in doubt. */
export function needsJev(p: Partial<P.TriageProbs> | null | undefined): boolean {
  return !!p && typeof p.important === 'number' && p.important >= 0.2 && p.important <= 0.95;
}

/** jev's P(yes) per question as `jev:<q>` logits. P(yes) is uncalibrated; the learning model calibrates it. */
export function jevFeatures(answers: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [q, p] of Object.entries(answers)) out[`jev:${q}`] = logit(p, 1e-3);
  return out;
}

// ------------------------------------------------------------------ ranking metrics (for the evaluation)

/** Average precision (the area under the precision–recall curve, sklearn's step form; ties count as one step). */
export function averagePrecision(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const P = labels.reduce<number>((s, y) => s + y, 0);
  if (!P) return NaN;
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  let tp = 0;
  let seen = 0;
  let ap = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    let q = 0;
    while (j < order.length && scores[order[j]] === scores[order[i]]) q += labels[order[j++]];
    seen += j - i;
    tp += q;
    ap += (q / P) * (tp / seen);
    i = j;
  }
  return ap;
}

/** ROC AUC, ties counted half. */
export function rocAuc(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const order = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 0;
  let sumPos = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && scores[order[j]] === scores[order[i]]) j++;
    const mid = (rank + 1 + rank + (j - i)) / 2;
    for (let k = i; k < j; k++) if (labels[order[k]]) sumPos += mid;
    rank += j - i;
    i = j;
  }
  const P = labels.reduce<number>((s, y) => s + y, 0);
  const N = labels.length - P;
  return P && N ? (sumPos - (P * (P + 1)) / 2) / (P * N) : NaN;
}

// ------------------------------------------------------------------ the store

export interface Stored {
  conversation: string;
  author: string | null;
  ts: number;
  /** Centred, unit length. */
  v: Float32Array;
  /** How far it was from the mean before scaling: with the mean, gives the raw vector back. */
  norm: number;
}

/** `embeddings.sqlite`: one row per embedded message, jev's answers, the background mean and the job's cursors. */
export class EmbeddingStore {
  readonly db: Database;
  private meanCache: Float32Array | null | undefined;

  constructor(path: string, readonly version = `${EMBED_MODEL}|${DIMS}|${EMBED_INSTRUCT}`) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    this.db.exec('PRAGMA journal_mode = WAL');
    // As the hub's database (store.ts): to the disk at checkpoints, not at each commit.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE IF NOT EXISTS embedding (
        message_id      TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        author          TEXT,
        ts              INTEGER NOT NULL,
        v               BLOB NOT NULL,             -- int8[${DIMS}], centred and unit length
        scale           REAL NOT NULL,
        norm            REAL NOT NULL,
        kept            INTEGER NOT NULL DEFAULT 0 -- a labelled example: outlives the retention window
      );
      CREATE INDEX IF NOT EXISTS embedding_ts ON embedding(ts);
      CREATE TABLE IF NOT EXISTS answer (
        message_id TEXT NOT NULL,
        question   TEXT NOT NULL,
        p          REAL NOT NULL,
        ts         INTEGER NOT NULL,
        PRIMARY KEY (message_id, question)
      ) WITHOUT ROWID;
    `);
    // Another model, size or prompt makes vectors that cannot be compared with these: start over.
    if (this.get('version') !== version) {
      this.db.exec('DELETE FROM embedding; DELETE FROM meta;');
      this.set('version', version);
    }
  }

  get(key: string): string | null {
    const r = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: unknown } | null;
    return r ? String(r.value) : null;
  }

  set(key: string, value: string | null) {
    if (value === null) this.db.query('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** The background mean in jev's (raw, unit-length) space, fixed once set so stored vectors stay comparable. */
  mean(): Float32Array | null {
    if (this.meanCache === undefined) {
      const r = this.db.query(`SELECT value FROM meta WHERE key = 'mean'`).get() as { value: Uint8Array } | null;
      this.meanCache = r ? new Float32Array(new Uint8Array(r.value).buffer) : null;
    }
    return this.meanCache;
  }

  setMean(m: Float32Array) {
    this.db.query(`INSERT INTO meta (key, value) VALUES ('mean', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(new Uint8Array(Float32Array.from(m).buffer));
    this.meanCache = Float32Array.from(m);
  }

  /** Raw unit vectors from jev, centred on the mean (which must be set) and stored as int8. */
  put(rows: { id: string; conversation: string; author: string | null; ts: number; raw: ArrayLike<number> }[]) {
    const mean = this.mean();
    if (!mean) throw new Error('embeddings: no background mean yet');
    const ins = this.db.query(
      `INSERT INTO embedding (message_id, conversation_id, author, ts, v, scale, norm) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET v = excluded.v, scale = excluded.scale, norm = excluded.norm`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        const { v, norm } = centre(r.raw, mean);
        const { q, scale } = quantize(v);
        ins.run(r.id, r.conversation, r.author, r.ts, new Uint8Array(q.buffer), scale, norm);
      }
    })();
  }

  has(id: string): boolean {
    return !!this.db.query('SELECT 1 FROM embedding WHERE message_id = ?').get(id);
  }

  vector(id: string): Stored | null {
    return this.many([id]).get(id) ?? null;
  }

  many(ids: readonly string[]): Map<string, Stored> {
    return whole(this.manySteps(ids));
  }

  *manySteps(ids: readonly string[]): Generator<number, Map<string, Stored>> {
    const out = new Map<string, Stored>();
    const q = this.db.query('SELECT message_id, conversation_id, author, ts, v, scale, norm FROM embedding WHERE message_id = ?');
    let done = 0;
    for (const id of ids) {
      const r = q.get(id) as { message_id: string; conversation_id: string; author: string | null; ts: number; v: Uint8Array; scale: number; norm: number } | null;
      if (r) out.set(id, { conversation: r.conversation_id, author: r.author, ts: r.ts, v: dequantize(new Int8Array(new Uint8Array(r.v).buffer), r.scale), norm: r.norm });
      if (++done >= SLICE_ROWS / 4) {
        yield done;
        done = 0;
      }
    }
    if (done) yield done;
    return out;
  }

  /** The vector before centring (unit length), for comparison with the plain centroid. */
  raw(s: Stored): Float32Array {
    const mean = this.mean()!;
    return unit(Float32Array.from(s.v, (x, i) => x * s.norm + mean[i]));
  }

  count(): number {
    return (this.db.query('SELECT count(*) AS n FROM embedding').get() as { n: number }).n;
  }

  /** Mark labelled examples: they are kept past the retention window. */
  keep(ids: readonly string[]) {
    whole(this.keepSteps(ids));
  }

  /** `keep`, a transaction of a few thousand at a time. */
  *keepSteps(ids: readonly string[]): Generator<number, void> {
    const q = this.db.query('UPDATE embedding SET kept = 1 WHERE message_id = ?');
    const step = SLICE_ROWS / 2;
    for (let i = 0; i < ids.length; i += step) {
      const part = ids.slice(i, i + step);
      this.db.transaction(() => {
        for (const id of part) q.run(id);
      })();
      yield part.length;
    }
  }

  /** Forget what is older than the window and not a labelled example, and answers whose embedding went. */
  prune(now: number, days = RETENTION_DAYS): number {
    const n = this.db.query('DELETE FROM embedding WHERE ts < ? AND kept = 0').run(now - days * DAY).changes;
    this.db.query('DELETE FROM answer WHERE ts < ? AND message_id NOT IN (SELECT message_id FROM embedding WHERE kept = 1)').run(now - days * DAY);
    return n;
  }

  setAnswers(id: string, ts: number, answers: Record<string, number>) {
    const q = this.db.query('INSERT OR REPLACE INTO answer (message_id, question, p, ts) VALUES (?, ?, ?, ?)');
    for (const [k, p] of Object.entries(answers)) q.run(id, k, p, ts);
  }

  answers(id: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.query('SELECT question, p FROM answer WHERE message_id = ?').all(id) as { question: string; p: number }[]) out[r.question] = r.p;
    return out;
  }

  close() {
    this.db.close();
  }
}

// ------------------------------------------------------------------ jev

export interface JevClient {
  embed(texts: string[]): Promise<(number[] | null)[]>;
  judge(question: string, texts: string[]): Promise<(number | null)[]>;
}

/** jev's HTTP API (~/Projects/jev): `/v1/embed` and `/v1/judge`, both cached on its side. */
export class Jev implements JevClient {
  constructor(private url = 'http://127.0.0.1:7862', private timeoutMs = 120_000) {
    if (!isPrivateUrl(url)) throw new Error(`refusing to send messages to ${url}: not on this machine or a private network`);
  }

  async embed(texts: string[]) {
    const r = await this.post('/v1/embed', { texts, instruct: EMBED_INSTRUCT, dims: DIMS });
    if (!Array.isArray(r.embeddings) || r.embeddings.length !== texts.length) throw new Error('jev gave no embeddings');
    return r.embeddings as (number[] | null)[];
  }

  async judge(question: string, texts: string[]) {
    const r = await this.post('/v1/judge', { question, texts, instruct: JEV_INSTRUCT });
    if (!Array.isArray(r.p) || r.p.length !== texts.length) throw new Error('jev gave no answers');
    return r.p as (number | null)[];
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`jev answered ${res.status}`);
    return res.json();
  }
}

// ------------------------------------------------------------------ reading the hub

export interface MessageRow {
  id: string;
  rid: number;
  conversation_id: string;
  author_id: string | null;
  person_id: string | null;
  ts: number;
  body: string;
  extra: string | null;
  shape: string;
  /** The conversation's variant: a feed's and logged posts' are not embedded. */
  variant?: string;
  reply_body: string | null;
  reply_author: string | null;
}

const MESSAGE_SQL = `
  SELECT m.id, m.rowid AS rid, m.conversation_id, m.author_id, i.person_id, m.ts, m.body, m.extra, c.shape, c.variant,
         r.body AS reply_body, r.author_id AS reply_author
  FROM message m
  JOIN conversation c ON c.id = m.conversation_id
  LEFT JOIN identity i ON i.id = m.author_id
  LEFT JOIN message r ON r.id = m.reply_to_id`;

/** Your identities: each account's own, and every identity of the person that is you. */
export function selfIdentities(hub: Database): Set<string> {
  const rows = hub
    .query(`SELECT self_identity AS id FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM person p CROSS JOIN identity i ON i.person_id = p.id WHERE p.is_self = 1`)
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** The text to embed for a hub message, reading its attachment or link title when the body is empty. */
export function inputFor(hub: Database, m: MessageRow, self: ReadonlySet<string>): string | null {
  let attachments: { kind: string; name: string | null }[] = [];
  let embedTitle: string | null = null;
  if (!cleanText(m.body)) {
    attachments = hub.query('SELECT kind, name FROM attachment WHERE message_id = ? ORDER BY position LIMIT 1').all(m.id) as typeof attachments;
    try {
      embedTitle = (JSON.parse(m.extra ?? '{}') as { embeds?: { title?: string }[] }).embeds?.[0]?.title ?? null;
    } catch {}
  }
  const reply = m.reply_body !== null ? { body: m.reply_body, mine: !!m.reply_author && self.has(m.reply_author) } : null;
  return embedText({ body: m.body, shape: m.shape, reply, attachments, embedTitle });
}

/** Messages from others with what you did about them, in conversations where you wrote or reacted since `since`. */
export function loadTurns(hub: Database, since: number, self: ReadonlySet<string>): Turns {
  return whole(loadTurnsSteps(hub, since, self));
}

type Turns = { turns: Turn[]; rows: Map<string, { conversation: string; author: string | null; ts: number }> };

/** `loadTurns` as steps (slices.ts): a page of a conversation's messages at a time, in the same order. */
export function* loadTurnsSteps(hub: Database, since: number, self: ReadonlySet<string>): Generator<number, Turns> {
  const ids = [...self];
  if (!ids.length) return { turns: [], rows: new Map() };
  const mark = ids.map(() => '?').join(',');
  // Your reactions first, then their messages: there are far fewer of them than messages since `since`.
  const convs = hub
    .query(
      `SELECT c FROM (SELECT DISTINCT conversation_id AS c FROM message WHERE ts >= ? AND author_id IN (${mark})
       UNION SELECT m.conversation_id FROM reaction x CROSS JOIN message m ON m.id = x.message_id WHERE m.ts >= ? AND x.identity_id IN (${mark}))
       WHERE c NOT IN ${QUIET_CONVS_SQL} ORDER BY 1`,
    )
    .all(since, ...ids, since, ...ids) as { c: string }[];
  yield convs.length;
  const turns: Turn[] = [];
  const rows = new Map<string, { conversation: string; author: string | null; ts: number }>();
  const page = Math.min(2048, SLICE_ROWS);
  // In (ts, rowid) order, as the index on (conversation, ts) gives them: a page starts after the last one's end.
  const q = hub.query(
    `SELECT m.id, m.rowid AS rid, m.ts, m.author_id, i.person_id, m.reply_to_id,
            EXISTS (SELECT 1 FROM reaction x WHERE x.message_id = m.id AND x.identity_id IN (${mark})) AS reacted
     FROM message m LEFT JOIN identity i ON i.id = m.author_id
     WHERE m.conversation_id = ? AND m.ts >= ? AND (m.ts, m.rowid) > (?, ?) AND m.deleted = 0 ORDER BY m.ts, m.rowid LIMIT ?`,
  );
  for (const { c } of convs) {
    let after = [since, -1];
    for (;;) {
      const got = q.all(...ids, c, since, after[0], after[1], page) as { id: string; rid: number; ts: number; author_id: string | null; person_id: string | null; reply_to_id: string | null; reacted: number }[];
      for (const r of got) {
        const mine = !!r.author_id && self.has(r.author_id);
        turns.push({ id: r.id, conversation: c, ts: r.ts, mine, replyTo: r.reply_to_id, reacted: !!r.reacted });
        if (!mine) rows.set(r.id, { conversation: c, author: r.person_id ?? r.author_id, ts: r.ts });
      }
      yield got.length + 1;
      if (got.length < page) break;
      after = [got.at(-1)!.ts, got.at(-1)!.rid];
    }
  }
  return { turns, rows };
}

// ------------------------------------------------------------------ the background job

export interface EmbeddingsOptions {
  jev?: JevClient;
  now?: () => number;
  /** Texts per jev call. */
  batch?: number;
  /** jev questions asked per day at most (each message asks all of them). */
  jevPerDay?: number;
  /** Messages sampled to set the background mean. */
  meanSample?: number;
}

type HeadModel = { probe: Probe | null; oof: Map<string, number>; knn: KnnIndex | null };

/**
 * The embedder and the features. `tick()` does one step (new messages first, then the backfill); `start()` runs
 * steps on a slow timer; `refit()` relearns the probes and the kNN examples from the labels; `features()` reads
 * what there is for a message, at once.
 */
export class Embeddings {
  readonly store: EmbeddingStore;
  private jev: JevClient;
  private now: () => number;
  private batch: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heads: Partial<Record<Head, HeadModel>> = {};
  private asked = { day: '', n: 0 };
  private busy: Promise<unknown> = Promise.resolve();
  private lastRefit = 0;
  private parts = new Map<string, { at: number; yes: boolean }>();
  private caughtUp = false;

  constructor(private hub: Database, path: string, private opts: EmbeddingsOptions = {}) {
    this.store = new EmbeddingStore(path);
    this.jev = opts.jev ?? new Jev();
    this.now = opts.now ?? Date.now;
    this.batch = opts.batch ?? 64;
    // A backfill that finished before this start has nothing more to give the start's own refit.
    const low = this.store.get('backfill');
    this.caughtUp = low !== null && Number(low) <= 1;
  }

  /**
   * After a step: refit daily (a start's first step, since the models live in memory), and once more when the backfill
   * first runs out, as most labelled messages only have vectors from then.
   */
  refitDue(did: 'mean' | 'new' | 'backfill' | 'idle'): boolean {
    const caughtUp = did === 'idle' && !this.caughtUp;
    if (caughtUp) this.caughtUp = true;
    return caughtUp || this.now() - this.lastRefit > DAY;
  }

  start() {
    const loop = async () => {
      let next = 20_000;
      try {
        const did = await this.tick();
        next = did === 'new' ? 1_000 : did === 'backfill' ? 4_000 : 20_000;
        if (this.refitDue(did)) await this.refitSoftly();
      } catch (e) {
        // jev down or busy: the features are missing meanwhile, and triage goes on without them.
        console.error(`embeddings: ${(e as Error).message}; trying again in 5 min`);
        jobFailed('embeddings', e);
        next = 5 * MIN;
      }
      if (this.timer) this.timer = setTimeout(loop, next);
    };
    this.timer = setTimeout(loop, 10_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One step: set the mean if there is none, embed new messages, else a batch of older ones. */
  async tick(): Promise<'mean' | 'new' | 'backfill' | 'idle'> {
    const run = this.busy.then(() => this.step());
    this.busy = run.catch(() => {});
    return run;
  }

  private async step(): Promise<'mean' | 'new' | 'backfill' | 'idle'> {
    noteWork('embeddings step');
    const self = selfIdentities(this.hub);
    const since = this.now() - RETENTION_DAYS * DAY;
    if (!this.store.mean()) {
      await this.setMean(self, since);
      return 'mean';
    }
    const top = (this.hub.query('SELECT max(rowid) AS r FROM message').get() as { r: number | null }).r ?? 0;
    if (this.store.get('cursor') === null) {
      // Start following from here; the backfill walks down from the same place.
      this.store.set('cursor', String(top));
      this.store.set('backfill', String(top + 1));
    }
    const cursor = Number(this.store.get('cursor'));
    if (top > cursor) {
      const rows = this.hub.query(`${MESSAGE_SQL} WHERE m.rowid > ? ORDER BY m.rowid LIMIT ?`).all(cursor, this.batch * 4) as MessageRow[];
      await this.embedRows(rows.filter((r) => r.ts >= since && !QUIET_VARIANTS.has(r.variant ?? '')), self, true);
      this.store.set('cursor', String(rows.at(-1)!.rid));
      return 'new';
    }
    const low = Number(this.store.get('backfill') ?? 0);
    if (low > 1) {
      const rows = this.hub.query(`${MESSAGE_SQL} WHERE m.rowid < ? ORDER BY m.rowid DESC LIMIT ?`).all(low, this.batch * 4) as MessageRow[];
      await this.embedRows(rows.filter((r) => r.ts >= since && !QUIET_VARIANTS.has(r.variant ?? '')), self, false);
      this.store.set('backfill', String(rows.length ? rows.at(-1)!.rid : 0));
      return 'backfill';
    }
    return 'idle';
  }

  /** The mean of a random sample of the last 30 days: what chatter looks like here, taken away from every vector. */
  private async setMean(self: ReadonlySet<string>, since: number) {
    const rows = this.hub
      .query(`${MESSAGE_SQL} WHERE m.ts >= ? AND m.deleted = 0 AND length(m.body) > 0 AND c.variant NOT IN ${QUIET_VARIANTS_SQL} ORDER BY random() LIMIT ?`)
      .all(since, this.opts.meanSample ?? 512) as MessageRow[];
    const mine = rows.filter((r) => !r.author_id || !self.has(r.author_id));
    const texts = mine.map((r) => inputFor(this.hub, r, self));
    const raws: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      const chunk = texts.slice(i, i + this.batch).filter((t): t is string => !!t);
      if (chunk.length) for (const v of await this.jev.embed(chunk)) if (v) raws.push(v);
    }
    if (raws.length < 10) throw new Error('too few messages to set the background mean yet');
    this.store.setMean(meanOf(raws));
  }

  /** Embed the messages from others that have something to embed and are not embedded yet. */
  private async embedRows(rows: MessageRow[], self: ReadonlySet<string>, fresh: boolean) {
    const todo: { row: MessageRow; text: string }[] = [];
    for (const r of rows) {
      if (r.author_id && self.has(r.author_id)) continue;
      if (this.store.has(r.id)) continue;
      const text = inputFor(this.hub, r, self);
      if (text) todo.push({ row: r, text });
    }
    for (let i = 0; i < todo.length; i += this.batch) {
      const chunk = todo.slice(i, i + this.batch);
      const vs = await this.jev.embed(chunk.map((c) => c.text));
      this.store.put(chunk.flatMap((c, j) => (vs[j] ? [{ id: c.row.id, conversation: c.row.conversation_id, author: c.row.person_id ?? c.row.author_id, ts: c.row.ts, raw: vs[j]! }] : [])));
    }
    // Older ones too, so training has answers to learn from, but only with the first half of the day's budget.
    if (fresh || this.asked.n < (this.opts.jevPerDay ?? 2000) / 2) await this.askJev(todo.map((t) => t.row.id));
  }

  /**
   * jev's questions for messages in conversations you take part in (you wrote or reacted there in the last 30 days),
   * within the day's budget. They come before triage decides, so the answers can be features of the decision. (The
   * design's gate, "triage was unsure", needed the decision first and passed too few messages to help:
   * docs/embeddings.md.)
   */
  async askJev(ids: readonly string[]) {
    // No questions, nothing to pick for: picking reads every message's conversation, which is seconds on a big hub.
    if (!Object.keys(QUESTIONS).length) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.asked.day !== day) this.asked = { day, n: 0 };
    const budget = (this.opts.jevPerDay ?? 2000) - this.asked.n;
    const pick: { id: string; ts: number; text: string }[] = [];
    const self = selfIdentities(this.hub);
    for (const id of ids) {
      if (pick.length >= budget) break;
      if (Object.keys(this.store.answers(id)).length) continue;
      const row = this.hub.query(`${MESSAGE_SQL} WHERE m.id = ?`).get(id) as MessageRow | null;
      if (!row || !this.takesPart(row.conversation_id, self)) continue;
      const text = inputFor(this.hub, row, self);
      if (text) pick.push({ id, ts: row.ts, text });
    }
    if (!pick.length) return;
    const answers = pick.map(() => ({}) as Record<string, number>);
    for (const [k, question] of Object.entries(QUESTIONS)) {
      const ps = await this.jev.judge(question, pick.map((p) => p.text));
      ps.forEach((p, i) => p !== null && (answers[i][k] = p));
    }
    pick.forEach((p, i) => this.store.setAnswers(p.id, p.ts, answers[i]));
    this.asked.n += pick.length;
  }

  /** You wrote or reacted in this conversation in the last 30 days; remembered for an hour. */
  private takesPart(conversationId: string, self: ReadonlySet<string>): boolean {
    const hit = this.parts.get(conversationId);
    if (hit && this.now() - hit.at < HOUR) return hit.yes;
    const since = this.now() - RETENTION_DAYS * DAY;
    const ids = [...self];
    const marks = ids.map(() => '?').join(',');
    const yes =
      !!ids.length &&
      !!(
        this.hub.query(`SELECT 1 FROM message WHERE conversation_id = ? AND ts >= ? AND author_id IN (${marks}) LIMIT 1`).get(conversationId, since, ...ids) ??
        this.hub.query(`SELECT 1 FROM reaction r JOIN message m ON m.id = r.message_id WHERE m.conversation_id = ? AND m.ts >= ? AND r.identity_id IN (${marks}) LIMIT 1`).get(conversationId, since, ...ids)
      );
    this.parts.set(conversationId, { at: this.now(), yes });
    if (this.parts.size > 5000) this.parts.clear();
    return yes;
  }

  /**
   * Embed these messages now if they are not yet, giving up after `timeoutMs`: for a caller that would rather have
   * the feature for a new message than wait for the background job. Never throws.
   */
  async prepare(ids: readonly string[], timeoutMs = 500): Promise<void> {
    if (!this.store.mean()) return;
    // One at a time, and none for a minute after jev was too slow: the background job embeds the rest, and a hung
    // jev never holds the notification queue up for more than one wait.
    if (this.preparing || this.now() < this.prepareQuietUntil) return;
    const self = selfIdentities(this.hub);
    const rows = ids.map((id) => this.hub.query(`${MESSAGE_SQL} WHERE m.id = ?`).get(id) as MessageRow | null).filter((r): r is MessageRow => !!r);
    if (!rows.length) return;
    const work: Promise<void> = this.embedRows(rows, self, true)
      .then(() => {}, () => {})
      .finally(() => {
        if (this.preparing === work) this.preparing = null;
      });
    this.preparing = work;
    let timer: Timer | undefined;
    const late = await Promise.race([work.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs)))]);
    clearTimeout(timer);
    if (late) this.prepareQuietUntil = this.now() + 60_000;
  }
  private preparing: Promise<void> | null = null;
  private prepareQuietUntil = 0;

  /** Refit in slices (slices.ts), so requests are answered while it runs. */
  private async refitSoftly() {
    this.lastRefit = this.now();
    await this.refit();
    this.store.prune(this.now());
  }

  /**
   * Relearn from the labels: replies and reactions, votes from before the tiers, and "less like this". For importance,
   * given at least ten positives and ten negatives: a probe on top of the conversation's answer rate, cross-fitted logits
   * for the examples themselves, and the kNN examples. Labelled messages are kept past the retention window.
   * Seconds of work on a big hub, so it runs a slice at a time (`o`: a test's clock and pauses).
   */
  async refit(o: SliceOptions = {}) {
    this.heads = await sliced('embeddings refit', this.refitSteps(), o);
    this.lastRefit = this.now();
  }

  private *refitSteps(): Generator<number, Partial<Record<Head, HeadModel>>> {
    const self = selfIdentities(this.hub);
    const since = this.now() - RETENTION_DAYS * DAY;
    const { turns, rows } = yield* loadTurnsSteps(this.hub, since, self);
    const labels = new Map<string, { y: Partial<Record<Head, 0 | 1>>; weight: number }>();
    const ripe = this.now() - ACTIVE_MS;
    for (const [id, o] of outcomes(turns)) if (rows.get(id)!.ts < ripe) labels.set(id, { y: outcomeLabels(o), weight: 0.5 });
    // Work in memory, a few milliseconds: a chance to pause, not rows.
    yield 0;
    const votes = this.hub.query('SELECT t.message_id AS id, t.feedback, t.less_mark FROM triage t WHERE t.feedback IS NOT NULL OR t.less_mark = 1').all() as { id: string; feedback: P.NotifyTier | null; less_mark: number | null }[];
    for (const v of votes) labels.set(v.id, { y: v.less_mark ? { important: 0 } : voteLabels(v.feedback!), weight: 1 });
    yield votes.length + 1;
    const vectors = yield* this.store.manySteps([...labels.keys()]);
    const notified = this.hub.query('SELECT DISTINCT message_id AS id FROM notification WHERE message_id IS NOT NULL').all() as { id: string }[];
    yield* this.store.keepSteps([...labels.keys(), ...notified.map((n) => n.id)]);

    const heads: Partial<Record<Head, HeadModel>> = {};
    // Importance only: nothing you did says a message could not wait.
    for (const h of ['important'] as Head[]) {
      const ex = [...labels].flatMap(([id, l]) => (l.y[h] !== undefined && vectors.has(id) ? [{ id, s: vectors.get(id)!, y: l.y[h]!, weight: l.weight }] : []));
      ex.sort((a, b) => a.s.ts - b.s.ts);
      const pos = ex.filter((e) => e.y).length;
      if (pos < 10 || ex.length - pos < 10) continue;
      // Each example starts from its conversation's answer rate without itself, so the probe learns what is left.
      const prior = pos / ex.length;
      const tally = new Map<string, { p: number; n: number }>();
      for (const e of ex) {
        const t = tally.get(e.s.conversation) ?? tally.set(e.s.conversation, { p: 0, n: 0 }).get(e.s.conversation)!;
        t.p += e.y;
        t.n++;
      }
      const offset = ex.map((e) => {
        const t = tally.get(e.s.conversation)!;
        return rateLogit(t.p - e.y, t.n - 1, prior);
      });
      const X = ex.map((e) => e.s.v);
      const y = ex.map((e) => e.y);
      const weight = ex.map((e) => e.weight);
      const folds = timeFolds(ex.length);
      yield 0;
      const lambda = yield* chooseLambdaSteps(X, y, folds, { offset, weight });
      const oofs = yield* crossFitSteps(X, y, folds, { offset, weight, lambda });
      const probe = yield* fitProbeSteps(X, y, { offset, weight, lambda });
      const oof = new Map<string, number>();
      ex.forEach((e, i) => oofs[i] !== null && oof.set(e.id, oofs[i]!));
      heads[h] = { probe, oof, knn: new KnnIndex(ex.map((e) => ({ id: e.id, conversation: e.s.conversation, author: e.s.author, x: e.s.v, y: e.y as 0 | 1 }))) };
    }
    return heads;
  }

  /**
   * The content features of a message for one head: `{ emb, knn, jev:<q> }`, each present only when known. A
   * labelled example gets its cross-fitted logit and leaves itself out of kNN, so training never sees its own label.
   */
  features(id: string, head: Head = 'important'): Record<string, number> {
    const out: Record<string, number> = {};
    const s = this.store.vector(id);
    const m = this.heads[head];
    if (s && m) {
      const emb = m.oof.get(id) ?? (m.probe ? probeLogit(m.probe, s.v) : undefined);
      if (emb !== undefined) out.emb = Math.round(emb * 1000) / 1000;
      const knn = m.knn?.score(s.v, { author: s.author, conversation: s.conversation }, new Set([id]));
      if (knn !== null && knn !== undefined) out.knn = Math.round(knn * 1000) / 1000;
    }
    // Answers to questions no longer asked are not features.
    for (const [k, v] of Object.entries(jevFeatures(this.store.answers(id)))) if (k.slice(4) in QUESTIONS) out[k] = Math.round(v * 1000) / 1000;
    return out;
  }

  /** Which heads have a model, and how much is embedded: for a status line, never message content. */
  status() {
    return { embedded: this.store.count(), heads: Object.keys(this.heads), backfillLeft: Number(this.store.get('backfill') ?? 0) > 1 };
  }

  close() {
    this.stop();
    this.store.close();
  }
}
