/**
 * The chance a turn addressed to you needs a reply (docs/inbox.md, "Needs a reply"): P(you answer it within the reply
 * window | it is still open at its age), from the owed table's chance (owed.ts), how you answer this person and this
 * conversation once a turn is that old (the fold's tallies), and a few facts about its messages. A logistic model,
 * fitted on your own turns, then calibrated on the recent ones (Platt), so "72%" means about 72 of 100 such turns were
 * answered. Explicit marks override it (replymarks.ts). Measured in scripts/needs-reply-backtest.ts.
 *
 * Message facts are counts and flags only (a question mark, a link, its length), worked out from the text and never
 * kept with it.
 */
import type * as P from '@dither-chat/protocol';
import type { Database } from 'bun:sqlite';
import { emptyTally, LATENCY_EDGES, record, REPLY_WINDOW, tallyAt, type Tally } from './tally.ts';
import { owedChance, owedShape, turnRate, type OwedShape, type OwedTable, type OwedTurn } from './owed.ts';
import { auc, brier, logLoss, reliability, type Pred } from './calibration.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ message facts

/** What the model reads of one message from someone else: flags and a length, never the text. */
export interface MessageFacts {
  /** Characters of text. */
  len: number;
  /** It asks something: a question mark. */
  q: boolean;
  /** A link. */
  link: boolean;
  /** Media or a sticker. */
  media: boolean;
  /** A short closer that seldom wants an answer: "thanks", "ok", "lol", an emoji. */
  closer: boolean;
  /** It mentions you, or replies to a message of yours. */
  atMe: boolean;
  authorKey?: string | null;
}

const CLOSER = /^(ok(ay)?|k+|kk|cool|nice|thanks?( you)?|thx|ty(sm)?|lol+|lmao+|ha(ha)+h?|he(he)+|yes|yeah|yep|yup|no|nope|np|sure|alright|good|great|gn|good ?night|night|bye|cya|same|true|fr|bet|ikr|xd+|rip|nice one|sounds good|will do|got it|perfect|awesome|:\)|:d|<3)[\s!.]*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]+$/u;
/** At most this long (trimmed), a message can be a closer: the SQL below hands JavaScript only texts this short. */
const CLOSER_LEN = 24;
const isCloser = (short: string | null) => !!short && short.length <= CLOSER_LEN && (CLOSER.test(short) || EMOJI_ONLY.test(short));

/**
 * The columns a message's facts are read from, worked out in SQLite so no text but a closer's few characters reaches
 * JavaScript (`m` is the message). `factsOf` reads a row of them.
 */
export const FACTS_SQL = `length(m.body) AS f_len, instr(m.body, '?') > 0 AS f_q, (m.body LIKE '%http://%' OR m.body LIKE '%https://%') AS f_link,
  CASE WHEN length(trim(m.body)) <= ${CLOSER_LEN} THEN trim(m.body) END AS f_short, m.kind AS f_kind`;

export function factsOf(r: { f_len: number | null; f_q: number | null; f_link: number | null; f_short: string | null; f_kind: string }, atMe: boolean, authorKey?: string | null): MessageFacts {
  return { len: r.f_len ?? 0, q: !!r.f_q, link: !!r.f_link, media: r.f_kind === 'media' || r.f_kind === 'sticker', closer: isCloser(r.f_short), atMe, ...(authorKey !== undefined ? { authorKey } : {}) };
}

/** The same facts from a message's text (tests, and anything that has the text at hand). */
export function messageFeatures(m: { body: string; kind: string; atMe: boolean; authorKey?: string | null }): MessageFacts {
  const body = m.body ?? '';
  const t = body.trim();
  return factsOf({ f_len: [...body].length, f_q: +body.includes('?'), f_link: +/https?:\/\//i.test(body), f_short: [...t].length <= CLOSER_LEN ? t : null, f_kind: m.kind }, m.atMe, m.authorKey);
}

// ------------------------------------------------------------------ features

/** What a turn is, as the model sees it at one moment. */
export interface TurnFacts {
  shape: P.Shape;
  kind: string | null;
  /** How long it has been open. */
  age: number;
  /** The owed table's chance at this age (owed.ts `owedChance`). */
  tableChance: number;
  /** Your tallies here and with its author everywhere, as of now. */
  conv: Tally | null;
  person: Tally | null;
  /** Its messages so far, oldest first (from its first message for you). */
  messages: readonly MessageFacts[];
  authorKey: string | null;
}

/** The model's inputs, in order (a fitted model's weights follow it; a model of other names is not used). */
export const NEEDS_FEATURES = [
  'table',
  'age',
  'person:late',
  'conv:late',
  'person:n',
  'conv:n',
  'kind:mention',
  'kind:reply',
  'kind:small',
  'msg:question',
  'msg:anyQuestion',
  'msg:atMe',
  'msg:len',
  'msg:link',
  'msg:media',
  'msg:closer',
  'msg:count',
  'msg:inARow',
  'msg:otherAuthor',
] as const;

const logit = (p: number) => {
  const q = Math.min(0.995, Math.max(0.005, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Of a tally's answered turns, how many were answered by `age`: reactions (no time) first, then the latency histogram, drawn straight within a bucket. */
function answeredBy(t: Tally, age: number): number {
  const timed = t.latency.reduce((a, b) => a + b, 0);
  let by = Math.max(0, t.replied - timed);
  let lo = 0;
  for (let i = 0; i < LATENCY_EDGES.length; i++) {
    const hi = LATENCY_EDGES[i];
    if (age >= hi) by += t.latency[i];
    else {
      if (age > lo) by += (t.latency[i] * (age - lo)) / (hi - lo);
      break;
    }
    lo = hi;
  }
  return Math.min(t.replied, by);
}

/** How often turns still open at `age` were answered, from a tally, pulled toward `prior` as if `k` turns said so. */
export function lateRate(t: Tally | null, age: number, prior: number, k = 3): number {
  if (!t) return prior;
  const by = answeredBy(t, age);
  return (Math.max(0, t.replied - by) + k * prior) / (Math.max(0, t.addressed - by) + k);
}

/** The model's inputs for one turn at one moment (NEEDS_FEATURES' order). */
export function needsFeatures(f: TurnFacts): number[] {
  const person = lateRate(f.person, f.age, f.tableChance);
  const conv = lateRate(f.conv, f.age, person);
  const ms = f.messages;
  const last = ms[ms.length - 1];
  let run = 0;
  for (let i = ms.length - 1; i >= 0 && (ms[i].authorKey ?? null) === (last?.authorKey ?? null); i--) run++;
  const group = f.shape !== 'direct';
  return [
    logit(f.tableChance),
    Math.log1p(f.age / HOUR),
    logit(person),
    logit(conv),
    Math.log1p(f.person?.addressed ?? 0),
    Math.log1p(f.conv?.addressed ?? 0),
    group && f.kind === 'mention' ? 1 : 0,
    group && f.kind === 'reply' ? 1 : 0,
    group && (f.kind === 'question' || f.kind === 'answer') ? 1 : 0,
    last?.q ? 1 : 0,
    ms.some((m) => m.q) ? 1 : 0,
    ms.some((m) => m.atMe) ? 1 : 0,
    Math.log1p(last?.len ?? 0),
    last?.link ? 1 : 0,
    last?.media ? 1 : 0,
    last?.closer ? 1 : 0,
    Math.log1p(ms.length),
    Math.log1p(run),
    last && f.authorKey && last.authorKey && last.authorKey !== f.authorKey ? 1 : 0,
  ];
}

// ------------------------------------------------------------------ the logistic model

interface Logistic {
  /** Inputs are centred and scaled by these before the weights apply. */
  mean: number[];
  scale: number[];
  w: number[];
  b: number;
}

/** The chance a fitted model gives. */
export function predict(m: Logistic, x: readonly number[]): number {
  let z = m.b;
  for (let i = 0; i < m.w.length; i++) z += (m.w[i] * ((x[i] ?? 0) - m.mean[i])) / m.scale[i];
  return sigmoid(z);
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A is small and symmetric positive definite here). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

interface FitOptions {
  /** L2 penalty on the (scaled) weights, not the intercept. */
  l2?: number;
  iterations?: number;
  /** Per-example weights (recent turns count more, say); 1 each by default. */
  weights?: readonly number[];
}

/**
 * Fit a logistic model by Newton's method (IRLS), as a generator that yields after every few thousand rows so the hub
 * can run it in slices (slices.ts). `xs` is read again on each of a few passes.
 */
function* fitLogisticSteps(xs: readonly (readonly number[])[], ys: readonly boolean[], o: FitOptions = {}): Generator<number, Logistic> {
  const n = xs.length;
  const d = xs[0]?.length ?? 0;
  const l2 = o.l2 ?? 1;
  const wt = (i: number) => o.weights?.[i] ?? 1;
  const mean = new Array(d).fill(0);
  const sq = new Array(d).fill(0);
  let W = 0;
  for (let i = 0; i < n; i++) {
    const w = wt(i);
    W += w;
    for (let k = 0; k < d; k++) mean[k] += w * xs[i][k];
    if (i % 4096 === 4095) yield 4096;
  }
  for (let k = 0; k < d; k++) mean[k] /= W || 1;
  for (let i = 0; i < n; i++) {
    const w = wt(i);
    for (let k = 0; k < d; k++) sq[k] += w * (xs[i][k] - mean[k]) ** 2;
    if (i % 4096 === 4095) yield 4096;
  }
  const scale = sq.map((s) => Math.sqrt(s / (W || 1)) || 1);
  const pos = ys.reduce((a, y, i) => a + (y ? wt(i) : 0), 0);
  const m: Logistic = { mean, scale, w: new Array(d).fill(0), b: Math.log((pos + 0.5) / (W - pos + 0.5)) };
  const z = new Array(d + 1).fill(0);
  for (let it = 0; it < (o.iterations ?? 12); it++) {
    // Gradient and Hessian of the penalised log likelihood, intercept last.
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < d; k++) z[k] = (xs[i][k] - mean[k]) / scale[k];
      z[d] = 1;
      let s = m.b;
      for (let k = 0; k < d; k++) s += m.w[k] * z[k];
      const p = sigmoid(s);
      const w = wt(i);
      const r = w * ((ys[i] ? 1 : 0) - p);
      const h = w * Math.max(1e-6, p * (1 - p));
      for (let a = 0; a <= d; a++) {
        g[a] += r * z[a];
        const hz = h * z[a];
        for (let c = a; c <= d; c++) H[a][c] += hz * z[c];
      }
      if (i % 2048 === 2047) yield 2048;
    }
    for (let a = 0; a <= d; a++) for (let c = 0; c < a; c++) H[a][c] = H[c][a];
    for (let k = 0; k < d; k++) {
      g[k] -= l2 * m.w[k];
      H[k][k] += l2;
    }
    const step = solve(H, g);
    for (let k = 0; k < d; k++) m.w[k] += step[k];
    m.b += step[d];
    if (Math.max(...step.map(Math.abs)) < 1e-5) break;
  }
  return m;
}

/** fitLogisticSteps straight through. */
export function fitLogistic(xs: readonly (readonly number[])[], ys: readonly boolean[], o: FitOptions = {}): Logistic {
  const g = fitLogisticSteps(xs, ys, o);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

// ------------------------------------------------------------------ calibration (Platt)

/** chance → sigmoid(a · logit(chance) + b). */
interface Platt {
  a: number;
  b: number;
}
export const IDENTITY_PLATT: Platt = { a: 1, b: 0 };

/** A Platt step is pulled toward leaving the chances as they are, as if this many examples said so. */
const PLATT_PRIOR = 20;

/**
 * Fit a Platt step on chances and what happened, pulled toward the identity (a = 1, b = 0) so a short or lopsided
 * stretch moves it little; the identity with too few of either outcome.
 */
export function platt(ps: readonly number[], ys: readonly boolean[]): Platt {
  const pos = ys.filter(Boolean).length;
  if (pos < 5 || ys.length - pos < 5) return IDENTITY_PLATT;
  const zs = ps.map(logit);
  let a = 1;
  let b = 0;
  for (let it = 0; it < 25; it++) {
    let ga = -PLATT_PRIOR * (a - 1);
    let gb = -PLATT_PRIOR * b;
    let haa = PLATT_PRIOR;
    let hab = 0;
    let hbb = PLATT_PRIOR;
    for (let i = 0; i < zs.length; i++) {
      const p = sigmoid(a * zs[i] + b);
      const r = (ys[i] ? 1 : 0) - p;
      const w = Math.max(1e-6, p * (1 - p));
      ga += r * zs[i];
      gb += r;
      haa += w * zs[i] * zs[i];
      hab += w * zs[i];
      hbb += w;
    }
    const det = haa * hbb - hab * hab || 1e-12;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-6) break;
  }
  return { a, b };
}
export const applyPlatt = (c: Platt, p: number) => sigmoid(c.a * logit(p) + c.b);

// ------------------------------------------------------------------ the fitted model

/** One shape's model: the logistic part, then its calibration. */
export interface ShapeModel {
  model: Logistic;
  platt: Platt;
  /** Examples (a turn at an age) it was fitted on, and turns. */
  examples: number;
  turns: number;
}

/** What the hub keeps (meta `needs_model`): a model per shape, or none where there were too few turns. */
export interface NeedsModel {
  /** NEEDS_FEATURES as it was fitted: a model of other features is not used. */
  features: string[];
  shapes: Partial<Record<OwedShape, ShapeModel>>;
  fittedAt: number;
}

export function validNeedsModel(m: unknown): m is NeedsModel {
  const x = m as NeedsModel;
  return !!x && typeof x === 'object' && Array.isArray(x.features) && x.features.join() === NEEDS_FEATURES.join() && !!x.shapes && typeof x.fittedAt === 'number';
}

/**
 * The chance this turn needs a reply: the model's, calibrated, where there is one for its shape; else the owed table's.
 * Nothing past the reply window, as the table has it.
 */
export function needsChance(m: NeedsModel | null | undefined, f: TurnFacts): number {
  if (f.tableChance <= 0) return 0;
  const s = m?.shapes[owedShape(f.shape)];
  if (!s) return f.tableChance;
  return applyPlatt(s.platt, predict(s.model, needsFeatures(f)));
}

/** The ages a turn is learned from: each turn still open then is one example. */
const NEEDS_AGES: readonly number[] = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 1.5 * DAY, 2 * DAY];
/** The most recent turns over (answered, or out of time) the model is fitted on. */
const NEEDS_TURNS = 20_000;
/** Fewer turns of a shape than this, and that shape keeps the owed table. */
const MIN_TURNS = 300;
/** Older turns count less: half after this long. */
export const NEEDS_HALF_LIFE = 365 * DAY;
/** The calibration step is fitted on the turns of this last stretch. */
export const CALIBRATE_FOR = 90 * DAY;

const answeredWithin = (t: OwedTurn, w: number) => t.answeredAt !== null && t.answeredAt - t.addressed <= w;
const openAt = (t: OwedTurn, age: number) => t.answeredAt === null || t.answeredAt - t.addressed > age;

/** A turn's first message for you and what followed, as the model reads them. */
export interface TurnMessages {
  kind: string | null;
  messages: (MessageFacts & { ts: number })[];
}

interface NeedsExample {
  turn: OwedTurn;
  age: number;
  at: number;
  x: number[];
  y: boolean;
  table: number;
}

/**
 * Every (turn, age) with the turn still open then, with its features as of that moment: the tallies built from the
 * turns that were over by then, in time order, as the fold has them. Only turns `pick` keeps become examples; all
 * of them count toward the tallies. A generator, for the hub's slices.
 */
export function* needsExamplesSteps(
  turns: readonly OwedTurn[],
  o: { now: number; table: OwedTable; pick: (t: OwedTurn) => boolean; messages: (t: OwedTurn) => TurnMessages | null },
): Generator<number, NeedsExample[]> {
  const events: { t: OwedTurn; age: number; at: number }[] = [];
  for (const t of turns) {
    if (!t.timed || t.dismissed || !o.pick(t)) continue;
    for (const age of NEEDS_AGES) if (openAt(t, age) && t.addressed + age < o.now) events.push({ t, age, at: t.addressed + age });
  }
  events.sort((a, b) => a.at - b.at);
  yield events.length;
  const over = turns
    .filter((t) => !t.dismissed)
    .map((t) => ({ t, at: answeredWithin(t, REPLY_WINDOW) ? t.answeredAt! : t.addressed + REPLY_WINDOW }))
    .sort((a, b) => a.at - b.at);
  yield over.length;
  const conv = new Map<string, Tally>();
  const person = new Map<string, Tally>();
  const get = (m: Map<string, Tally>, k: string) => m.get(k) ?? m.set(k, emptyTally()).get(k)!;
  const read = new Map<OwedTurn, TurnMessages | null>();
  const out: NeedsExample[] = [];
  let j = 0;
  let n = 0;
  for (const e of events) {
    for (; j < over.length && over[j].at <= e.at; j++) {
      const d = over[j].t;
      const latency = d.answeredAt === null ? null : d.answeredAt - d.addressed;
      record(get(conv, d.conversationId), over[j].at, latency, d.timed);
      if (d.authorKey) record(get(person, d.authorKey), over[j].at, latency, d.timed);
    }
    const t = e.t;
    let ms = read.get(t);
    if (ms === undefined) {
      read.set(t, (ms = o.messages(t)));
      n += 8;
    }
    if (!ms) continue;
    const c = conv.get(t.conversationId);
    const p = t.authorKey ? person.get(t.authorKey) : undefined;
    const ct = c ? tallyAt(c, e.at) : null;
    const pt = p ? tallyAt(p, e.at) : null;
    const table = owedChance(o.table, t.shape, turnRate(ct, pt), e.age);
    const x = needsFeatures({ shape: t.shape, kind: ms.kind, age: e.age, tableChance: table, conv: ct, person: pt, messages: ms.messages.filter((m) => m.ts <= e.at), authorKey: t.authorKey });
    out.push({ turn: t, age: e.age, at: e.at, x, y: answeredWithin(t, REPLY_WINDOW), table });
    if (++n >= 512) {
      yield n;
      n = 0;
    }
  }
  return out;
}

/** Fit one shape's model on its examples: recent turns count more, then calibrated on the last stretch. */
export function* fitShapeSteps(exs: readonly NeedsExample[], now: number): Generator<number, ShapeModel | null> {
  const turns = new Set(exs.map((e) => e.turn)).size;
  if (turns < MIN_TURNS || exs.every((e) => e.y) || exs.every((e) => !e.y)) return null;
  const end = Math.max(...exs.map((e) => e.turn.addressed));
  const model = yield* fitLogisticSteps(
    exs.map((e) => e.x),
    exs.map((e) => e.y),
    { l2: 1, weights: exs.map((e) => 2 ** (-(end - e.turn.addressed) / NEEDS_HALF_LIFE)) },
  );
  const recent = exs.filter((e) => e.turn.addressed >= Math.min(end, now) - CALIBRATE_FOR);
  return { model, platt: platt(recent.map((e) => predict(model, e.x)), recent.map((e) => e.y)), examples: exs.length, turns };
}

// ------------------------------------------------------------------ in the hub: reading a turn's messages

/**
 * A turn's messages from others from its first for you, up to two days on (60 at most), as facts: one indexed read
 * (message_conv_ts). `mine` says whether an identity is yours.
 */
export function turnMessagesQuery(db: Database, mine: (identityId: string | null, personId: string | null) => boolean) {
  const q = db.query(`
    SELECT m.ts, m.author_id, m.mentions_self, m.mentions_all, i.person_id, r.author_id AS reply_author, ${FACTS_SQL}
    FROM message m LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id
    WHERE m.conversation_id = ? AND m.ts >= ? AND m.ts <= ? AND m.deleted = 0 AND m.kind != 'system'
    ORDER BY m.ts, m.rowid LIMIT 60`);
  return (conversationId: string, shape: P.Shape, from: number, to: number): TurnMessages => {
    const rows = q.all(conversationId, from, to) as Record<string, any>[];
    const messages: TurnMessages['messages'] = [];
    let kind: string | null = null;
    for (const r of rows) {
      if (mine(r.author_id, r.person_id)) continue;
      const mention = !!r.mentions_self && !r.mentions_all;
      const reply = mine(r.reply_author, null);
      if (!messages.length) kind = shape === 'direct' ? 'direct' : mention ? 'mention' : reply ? 'reply' : 'question';
      messages.push({ ts: r.ts, ...factsOf(r as any, mention || reply, r.person_id ?? r.author_id) });
    }
    return { kind, messages };
  };
}

/**
 * Fit the model on the hub's turns (attention.ts `owedTurns`): the NEEDS_TURNS most recent that are over, each at the
 * ages it was still open, with its messages read one turn at a time. A generator, for the hub's slices.
 */
export function* fitNeedsModelSteps(
  db: Database,
  turns: readonly OwedTurn[],
  o: { now: number; table: OwedTable; mine: (identityId: string | null, personId: string | null) => boolean },
): Generator<number, NeedsModel> {
  const over = turns.filter((t) => t.timed && !t.dismissed && (t.answeredAt !== null || o.now - t.addressed >= REPLY_WINDOW)).sort((a, b) => b.addressed - a.addressed);
  const picked = new Set(over.slice(0, NEEDS_TURNS));
  const read = turnMessagesQuery(db, o.mine);
  const exs = yield* needsExamplesSteps(turns, { now: o.now, table: o.table, pick: (t) => picked.has(t), messages: (t) => read(t.conversationId, t.shape, t.addressed, t.addressed + 2 * DAY) });
  const out: NeedsModel = { features: [...NEEDS_FEATURES], shapes: {}, fittedAt: o.now };
  for (const shape of ['direct', 'group'] as OwedShape[]) {
    const m = yield* fitShapeSteps(
      exs.filter((e) => owedShape(e.turn.shape) === shape),
      o.now,
    );
    if (m) out.shapes[shape] = m;
  }
  return out;
}

// ------------------------------------------------------------------ calibration over time

/** The ages a prediction is kept at, for the calibration record: each open turn once at each. */
export const RECORD_AGES: readonly number[] = [15 * MIN, HOUR, 6 * HOUR, DAY];

/** The calibration record as the API sends it (protocol NeedsReplyCalibration). */
export type CalibrationReport = P.NeedsReplyCalibration;

/** Score kept predictions against outcomes: `outcome` is null while a turn's window is still running. */
export function calibrationReport(rows: { addressed: number; p: number; table: number; y: boolean | null }[], model: NeedsModel | null): CalibrationReport {
  const done = rows.filter((r): r is typeof r & { y: boolean } => r.y !== null);
  const byDay = new Map<string, typeof done>();
  for (const r of done) {
    const d = new Date(r.addressed).toISOString().slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const ps = (xs: typeof done, k: 'p' | 'table'): Pred[] => xs.map((r) => ({ p: r[k], y: r.y }));
  const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
  const days = [...byDay]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, xs]) => ({
      day,
      n: xs.length,
      answered: xs.filter((r) => r.y).length,
      predicted: r3(xs.reduce((a, r) => a + r.p, 0) / xs.length),
      brier: r3(brier(ps(xs, 'p'))),
      logLoss: r3(logLoss(ps(xs, 'p'))),
      tableBrier: r3(brier(ps(xs, 'table'))),
    }));
  return {
    days,
    n: done.length,
    brier: r3(brier(ps(done, 'p'))),
    logLoss: r3(logLoss(ps(done, 'p'))),
    auc: r3(auc(ps(done, 'p'))),
    tableBrier: r3(brier(ps(done, 'table'))),
    tableAuc: r3(auc(ps(done, 'table'))),
    bins: reliability(ps(done, 'p'), 10).map((b) => ({ ...b, predicted: r3(b.predicted), actual: r3(b.actual) })),
    model: { fittedAt: model?.fittedAt ?? null, turns: Object.fromEntries(Object.entries(model?.shapes ?? {}).map(([k, v]) => [k, v!.turns])) },
  };
}
