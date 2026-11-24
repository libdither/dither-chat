/**
 * One loudness scale (docs/notifications.md): how much of your attention a message is worth right now, 0 to 100, and
 * the band the devices draw from it (sound, show now silent, next look, inbox, unread only).
 *
 * Three things are estimated for each message, each by its own small model, each trained only by the answers that
 * concern it (checkin.ts, attnanswers.ts):
 *  - want: the chance you'd be glad you saw it at all. It starts from today's importance (learn.ts) plus the
 *    Conversation rule's reasons (tiers.ts) as features with strong starting weights.
 *  - can-wait: how fast it goes stale, as four half-life buckets (minutes, an hour, today, whenever), an ordinal
 *    logistic model on one urgency score. It starts from today's alert chance: the local model's answer to the
 *    stop-now question (triage.ts STOP_QUESTION) against its bar, moved by your marks.
 *  - owed: a person waiting on your reply (people only, never channels, bots or mail lists).
 * And the cost of interrupting you at this moment, learned per kind of moment (a computer in use, the hour, minutes
 * since the last sound), moved by "bad moment", "I was free then", "could have waited" and "wish I'd known sooner".
 * There is no budget or cap: on a day full of things you want it sounds more.
 *
 *   lost(delay) = want · Σ wait_k (1 − 2^(−delay / halfLife_k)) + owed · delay / 1 day
 *   value(band) = lost(unread's delay) − lost(band's delay) − cost(band, moment)
 *   the band is the one of largest value; the loudness is where it sits between its neighbours, on the band's stretch.
 *
 * Learning keeps learn.ts's broad-to-narrow pooling: one weight per feature (network, server, chat, person, flags,
 * words), each held at its start the more firmly the broader it is. An answer that names a part (this chat, this
 * person, this topic, the moment) moves only that part.
 */
import type * as P from '@dither-chat/protocol';
import { BAND_NAME, BAND_RANGE, LOUD_BANDS } from '@dither-chat/protocol';
import { describe, features, lambda, voteWeight, type Facts, type Namer } from './learn.ts';
import { CONVERSING_REASON } from './tiers.ts';

type Band = P.LoudBand;
type Why = keyof typeof CONVERSING_REASON;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Which decides (DITHER_ATTENTION): shadow unless it says otherwise. */
export function attentionMode(v: string | undefined): P.AttentionMode {
  return v === 'tiers' || v === 'on' ? v : 'shadow';
}

/** How long each band keeps you from a message, roughly: the next look is when you next open the app or unlock. */
const DELAY: Record<Band, number> = { sound: 3 * MIN, show: 20 * MIN, next: 3 * HOUR, inbox: 8 * HOUR, unread: 24 * HOUR };
/**
 * What each band costs you before the moment is counted, against what a message is worth (want 1 is "surely glad").
 * The inbox's is what a message that keeps for days at your list level (0.6) gains by being ranked: so the inbox band
 * starts where the list did. Chosen by the replay (docs/notifications.md, "The numbers").
 */
const INTERRUPT: Record<Band, number> = { sound: 0.3, show: 0.15, next: 0.06, inbox: 0.036, unread: 0 };
/** The can-wait buckets' half-lives. */
const HALF_LIFE = [10 * MIN, HOUR, 6 * HOUR, 7 * DAY] as const;
/** P(needed within bucket k) = sigmoid(urgency + CUTS[k]); urgency is the log-odds of "needed within the hour". */
const CUTS = [-1.5, 0, 2] as const;
/** The alert chance of a message the local model was not asked about (learn.ts UNJUDGED). */
const UNJUDGED = 0.02;
/**
 * A Conversation message it did not answer for in time: not known to keep for days, so it starts near the share of
 * Conversation messages the local model says cannot wait.
 */
const UNREAD_CONVERSATION = 0.1;
const startAlert = (alert: number | undefined, why: readonly string[]) => alert ?? (why.length ? UNREAD_CONVERSATION : UNJUDGED);

/** The Conversation reasons' starting weights on want and on urgency, in log-odds. */
const WANT_START: Record<Why, number> = { dm: 1.2, followed: 0.8, about: 1.2, keyword: 0.8, wrote: 0.6, answers: 0.6 };
const WAIT_START: Record<Why, number> = { dm: 1.2, followed: 0.5, about: 1.2, keyword: 0.8, wrote: 1, answers: 0.8 };
/** You wrote there in the half hour before: a talk in progress goes stale in minutes. */
const ACTIVE_WAIT = 2;
/** How firmly a reason's weight is held at its start: a few answers move it. */
const WHY_LAMBDA = 5;

/** A sound's cost multipliers, in log, by kind of moment, before anything is learned. */
const MOMENT_START: Record<string, number> = { all: 0, desk: Math.log(3), 'hour:night': Math.log(1.5), 'hour:morning': 0, 'hour:day': 0, 'hour:evening': 0, burst5: Math.log(4), burst30: Math.log(1.5) };
/** How far your answers may move a moment's cost from its start, in log. */
const MOMENT_REACH = 1.5;
/** Your nudge (Settings: how readily it sounds), on the cost of a sound. */
const NUDGE: Record<P.AttentionPrefs['readily'], number> = { less: 1.6, learned: 1, more: 0.6 };

/** The moment a message arrives in. */
export interface Moment {
  /** A computer is in use (and you said it comes first). */
  desk: boolean;
  /** The local hour, 0-23. */
  hour: number;
  /** Since the last sound, or null. */
  sinceSound: number | null;
  /** Quiet hours are on: nothing sounds. */
  quiet: boolean;
}

const hourKey = (h: number) => (h < 7 || h >= 23 ? 'hour:night' : h < 12 ? 'hour:morning' : h < 18 ? 'hour:day' : 'hour:evening');
/** The moment's kinds, as model keys. */
export function momentKeys(m: Pick<Moment, 'desk' | 'hour' | 'sinceSound'>): string[] {
  const out = ['all', hourKey(m.hour)];
  if (m.desk) out.push('desk');
  if (m.sinceSound !== null && m.sinceSound < 5 * MIN) out.push('burst5');
  else if (m.sinceSound !== null && m.sinceSound < 30 * MIN) out.push('burst30');
  return out;
}

/** What a message's loudness is worked out from. */
export interface LoudInput {
  facts: Facts;
  words: readonly string[];
  /** Today's importance (learn.ts `important`). */
  importance: number;
  /** Today's alert chance (learn.ts `alert`); absent: the local model was not asked. */
  alert?: number;
  /** The Conversation rule's reasons that hold (tiers.ts conversingAll). */
  why: readonly Why[];
  /** The needs-reply chance where the inbox knows it (attention.ts); else worked out from the message. */
  owed?: number | null;
  moment: Moment;
  /** A rule of yours: Always alert (100), List only (at most the next look). */
  rule?: 'always' | 'list';
}

/** What the answers taught each part (attnanswers.ts trains it). Weights in log-odds, by feature (learn.ts features). */
export interface AttnModel {
  v: 1;
  want: Record<string, number>;
  wait: Record<string, number>;
  /** Per person, on the owed part. */
  owed: Record<string, number>;
  /** Per kind of moment, on a sound's cost, added to MOMENT_START. */
  moment: Record<string, number>;
  /** Answers it learned from. */
  answers?: number;
  learnedAt?: number | null;
}
export const emptyAttnModel = (): AttnModel => ({ v: 1, want: {}, wait: {}, owed: {}, moment: {} });
export const validAttnModel = (m: unknown): m is AttnModel => !!m && typeof m === 'object' && (m as AttnModel).v === 1 && ['want', 'wait', 'owed', 'moment'].every((k) => typeof (m as any)[k] === 'object');

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clampP = (p: number) => Math.max(0.001, Math.min(0.999, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));

/** The features of a message for the want and can-wait models: learn.ts's, and the reasons that hold. */
function attnFeatures(f: Facts, ws: readonly string[], why: readonly string[]): [string, number][] {
  return [...features(f, ws), ...why.map((w) => [`why:${w}`, 1] as [string, number])];
}
const attnLambda = (k: string) => (k.startsWith('why:') ? WHY_LAMBDA : lambda(k));

/** A person, not a channel, a bot or a mail list: owed is about people only. */
const isPerson = (f: Pick<Facts, 'shape' | 'bot' | 'author' | 'known' | 'mention' | 'reply'>) => !f.bot && !!f.author && (f.shape === 'direct' || (f.shape === 'group' && (!!f.known || !!f.mention || !!f.reply)));

/** Where the parts stand for a message, in log-odds and costs, before the bands. */
interface Resolved {
  wantZ: number;
  urgZ: number;
  owed: number;
  /** log-multiplier of a sound's cost, and of a silent row's (a computer in use only). */
  soundLog: number;
  showLog: number;
  quiet: boolean;
  rule?: 'always' | 'list';
}

interface Scored {
  loudness: number;
  band: Band;
  want: number;
  wait: [number, number, number, number];
}

/** The bands' values, and where the best one sits. */
function score(r: Resolved): Scored {
  const want = sigmoid(r.wantZ);
  const cum = CUTS.map((c) => sigmoid(r.urgZ + c));
  const wait: [number, number, number, number] = [cum[0], Math.max(0, cum[1] - cum[0]), Math.max(0, cum[2] - cum[1]), Math.max(0, 1 - cum[2])];
  const lost = (d: number) => want * wait.reduce((s, p, k) => s + p * (1 - 2 ** (-d / HALF_LIFE[k])), 0) + (r.owed * Math.min(d, DAY)) / DAY;
  const cost = (b: Band) => (b === 'sound' ? (r.quiet ? Infinity : INTERRUPT.sound * Math.exp(r.soundLog)) : b === 'show' ? INTERRUPT.show * Math.exp(r.showLog) : INTERRUPT[b]);
  const base = lost(DELAY.unread);
  const v = LOUD_BANDS.map((b) => base - lost(DELAY[b]) - cost(b));
  let i = 0;
  for (let k = 1; k < v.length; k++) if (v[k] > v[i]) i = k;
  if (r.rule === 'list' && i > 2) i = 2;
  const band = LOUD_BANDS[i];
  const [lo, hi] = BAND_RANGE[band];
  const down = i > 0 ? v[i] - v[i - 1] : null;
  const up = i < v.length - 1 ? v[i] - v[i + 1] : null;
  let pos: number;
  if (down !== null && up !== null) pos = down + up > 0 && Number.isFinite(up) ? down / (down + up) : 0;
  else if (down !== null) pos = 1 - Math.exp(-down / 0.2);
  else pos = up !== null && Number.isFinite(up) ? Math.exp(-up / 0.02) : 0;
  pos = Math.max(0, Math.min(0.999, Number.isFinite(pos) ? pos : 0));
  let loudness = Math.round((lo + pos * (hi - lo)) * 10) / 10;
  if (r.rule === 'always') loudness = 100;
  return { loudness, band: r.rule === 'always' ? 'sound' : band, want, wait };
}

/** The owed part before what was learned: the inbox's needs-reply chance where it knows it, else from the message. */
function owedStart(i: LoudInput): number {
  if (!isPerson(i.facts)) return 0;
  if (typeof i.owed === 'number') return i.owed;
  const f = i.facts;
  const base = f.shape === 'direct' ? (f.question ? 0.5 : 0.25) : f.question && (f.mention || f.reply) ? 0.35 : f.mention || f.reply ? 0.15 : 0;
  return base;
}

interface LoudOut {
  loudness: number;
  band: Band;
  parts: P.LoudParts;
  reasons: P.LoudReason[];
}

/** One message's loudness, its parts, and what moved it, by how many points (each part taken away in turn). */
export function loudness(i: LoudInput, m: AttnModel, readily: P.AttentionPrefs['readily'] = 'learned', namer?: Namer | null): LoudOut {
  const fs = attnFeatures(i.facts, i.words, i.why);
  const sum = (w: Record<string, number>, only?: (k: string) => boolean) => fs.reduce((s, [k, x]) => s + (only && !only(k) ? 0 : (w[k] ?? 0) * x), 0);
  const wantStart = i.why.reduce((s, w) => s + WANT_START[w], 0);
  const waitStart = i.why.reduce((s, w) => s + WAIT_START[w], 0) + (i.facts.active ? ACTIVE_WAIT : 0);
  const alert = startAlert(i.alert, i.why);
  const author = i.facts.author ? `author:${i.facts.author}` : null;
  const owedMult = author ? 2 * sigmoid(m.owed[author] ?? 0) : 1;
  const keys = momentKeys(i.moment);
  const mom = (k: string) => (MOMENT_START[k] ?? 0) + Math.max(-MOMENT_REACH, Math.min(MOMENT_REACH, m.moment[k] ?? 0));
  const deskLog = i.moment.desk ? mom('desk') : 0;
  const nudge = Math.log(NUDGE[readily] ?? 1);
  const r: Resolved = {
    wantZ: logit(i.importance) + wantStart + sum(m.want),
    urgZ: logit(alert) + waitStart + sum(m.wait),
    owed: Math.min(1, owedStart(i) * owedMult),
    soundLog: keys.reduce((s, k) => s + mom(k), 0) + nudge,
    // A silent row costs the same at a desk: the computer coming first is about sounds.
    showLog: nudge / 2,
    quiet: i.moment.quiet,
    ...(i.rule ? { rule: i.rule } : {}),
  };
  const s = score(r);
  const parts: P.LoudParts = {
    want: round3(s.want),
    wait: s.wait.map(round3) as P.LoudParts['wait'],
    owed: round3(r.owed),
    moment: round3(Math.exp(r.soundLog)),
    ...(r.quiet ? { quiet: true } : {}),
  };
  if (r.rule === 'always') return { loudness: 100, band: 'sound', parts, reasons: [{ text: 'A rule of yours: always alert', by: 100 }] };

  // What moved it: each part taken away in turn.
  const reasons: P.LoudReason[] = [];
  const by = (alt: Partial<Resolved>) => Math.round(s.loudness - score({ ...r, ...alt }).loudness);
  const add = (text: string, n: number, key?: string) => {
    if (Math.abs(n) >= 1) reasons.push({ text, by: n, ...(key ? { key } : {}) });
  };
  if (i.alert !== undefined) add(alert >= 0.5 ? "Can't wait an hour (local model: yes)" : 'Can wait an hour or more (local model)', by({ urgZ: r.urgZ - logit(alert) + logit(startAlert(undefined, i.why)) }));
  if (i.facts.active) add('You were talking there just now', by({ urgZ: r.urgZ - ACTIVE_WAIT }));
  for (const w of i.why) add(CONVERSING_REASON[w], by({ wantZ: r.wantZ - WANT_START[w], urgZ: r.urgZ - WAIT_START[w] }), `why:${w}`);
  const learned = fs
    .flatMap(([k, x]) => [
      { k, head: 'want' as const, z: (m.want[k] ?? 0) * x },
      { k, head: 'wait' as const, z: (m.wait[k] ?? 0) * x },
    ])
    .filter((e) => Math.abs(e.z) >= 0.2)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3);
  for (const e of learned) {
    const what = namer ? describe(e.k, namer) : e.k;
    const n = by(e.head === 'want' ? { wantZ: r.wantZ - e.z } : { urgZ: r.urgZ - e.z });
    add(`${what}: ${e.head === 'want' ? (e.z > 0 ? 'you said it matters' : 'you said it does not matter') : e.z > 0 ? 'you said it could not wait' : 'you said it could wait'}`, n, e.k);
  }
  if (r.owed > 0.05) add(`${namer && i.facts.author ? namer.person(i.facts.author) : 'They'} may be waiting on your reply`, by({ owed: 0 }), author ?? undefined);
  if (i.moment.desk) add('A computer is in use', by({ soundLog: r.soundLog - deskLog }));
  if (keys.includes('burst5') || keys.includes('burst30')) add('A sound only minutes ago', by({ soundLog: r.soundLog - mom(keys.includes('burst5') ? 'burst5' : 'burst30') }));
  const hk = hourKey(i.moment.hour);
  if (Math.abs(mom(hk)) >= 0.1) add(hk === 'hour:night' ? 'Late at night' : `At this time of day`, by({ soundLog: r.soundLog - mom(hk) }));
  if (Math.abs(mom('all')) >= 0.1) add(mom('all') > 0 ? 'Your answers: sounds have often been more than needed' : 'Your answers: you wanted to know sooner', by({ soundLog: r.soundLog - mom('all') }));
  if (nudge) add(readily === 'less' ? 'You asked it to sound less readily' : 'You asked it to sound more readily', by({ soundLog: r.soundLog - nudge, showLog: r.showLog - nudge / 2 }));
  if (r.quiet) add('Quiet hours: anything that would sound waits for the next look', by({ quiet: false }));
  if (r.rule === 'list') reasons.push({ text: 'A rule of yours: List only, at most the next look', by: 0 });
  reasons.sort((a, b) => Math.abs(b.by) - Math.abs(a.by));
  reasons.unshift({ text: `${BAND_NAME[s.band]}: wanted ${pct(s.want)}, ${staleWords(s.wait)}`, by: 0 });
  return { loudness: s.loudness, band: s.band, parts, reasons };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;
function staleWords(w: readonly number[]): string {
  const k = w.indexOf(Math.max(...w));
  return ['goes stale in minutes', 'keeps for about an hour', 'keeps for the day', 'keeps for days'][k];
}

/** The decision code a band is stored as, so older apps keep working: sound push, show quiet, next look and inbox digest, unread drop. */
export const BAND_DECISION: Record<Band, P.NotifyTier> = { sound: 'push', show: 'quiet', next: 'digest', inbox: 'digest', unread: 'drop' };
/** The band today's tiers amount to, for comparing (shadow.ts). */
export const TIER_BAND: Record<P.NotifyTier, Band> = { push: 'sound', quiet: 'show', digest: 'inbox', drop: 'unread' };

// ------------------------------------------------------------------ learning

/**
 * One thing it learns from: a message's facts as decided, and what an answer or what you did says of each part. A
 * part left out is not learned from it. `only` keeps the example to the features of one scope (an answer that named
 * this chat, this person, this topic).
 */
export interface AttnExample {
  facts: Facts;
  words: readonly string[];
  why: readonly string[];
  /** Where want and urgency started for it (today's importance and alert chance, as stored). */
  importance: number;
  alert?: number;
  want?: 0 | 1;
  /** Labels for the cuts: needed within 10 minutes, an hour, the day. */
  wait?: [(0 | 1)?, (0 | 1)?, (0 | 1)?];
  /** The person matters (1) or not (0), on the owed part. */
  owed?: 0 | 1;
  only?: 'conv' | 'author' | 'words';
  /** On a sound's cost at the moment it came: + dearer, − cheaper, by this much in log. */
  moment?: { keys: string[]; by: number };
  weight: number;
  at: number;
}

/** The weight of each kind of label (docs/notifications.md, "What it learns from"). */
export const ATTN_WEIGHTS = { answer: 1, mark: 1, replied: 0.3, opened: 0.1, swiped: 0.05, afterSound: 0 } as const;

/** Fit every part to its examples. A few hundred answers and a few thousand behaviour labels: well under a second. */
export function trainAttn(examples: readonly AttnExample[], rejected: ReadonlySet<string> = new Set(), now = Date.now()): AttnModel {
  const m = emptyAttnModel();
  // `rejected` holds "head|feature" (learnedList's keys): what you told it to forget, for that part only.
  const scoped = (e: AttnExample) => (k: string) => !e.only || (e.only === 'conv' ? k === `conv:${e.facts.conversation}` : e.only === 'author' ? k === `author:${e.facts.author}` : k.startsWith('w:'));
  const rowsWant: Row[] = [];
  const rowsWait: Row[] = [];
  const rowsOwed: Row[] = [];
  for (const e of examples) {
    const all = attnFeatures(e.facts, e.words, e.why).filter(([k]) => scoped(e)(k));
    const why = e.why as Why[];
    const wantFs = all.filter(([k]) => !rejected.has(`want|${k}`));
    const waitFs = all.filter(([k]) => !rejected.has(`wait|${k}`));
    if (e.want !== undefined && wantFs.length) rowsWant.push({ fs: wantFs, z0: logit(e.importance) + why.reduce((s, w) => s + (WANT_START[w] ?? 0), 0), y: e.want, c: e.weight });
    if (e.wait && waitFs.length) {
      const z0 = logit(startAlert(e.alert, e.why)) + why.reduce((s, w) => s + (WAIT_START[w] ?? 0), 0) + (e.facts.active ? ACTIVE_WAIT : 0);
      e.wait.forEach((y, c) => y !== undefined && rowsWait.push({ fs: waitFs, z0: z0 + CUTS[c], y, c: e.weight }));
    }
    const a = e.facts.author ? `author:${e.facts.author}` : null;
    if (e.owed !== undefined && a && !rejected.has(`owed|${a}`)) rowsOwed.push({ fs: [[a, 1]], z0: 0, y: e.owed, c: e.weight });
    if (e.moment) for (const k of e.moment.keys) if (!rejected.has(`moment|${k}`)) m.moment[k] = (m.moment[k] ?? 0) + e.moment.by * e.weight;
  }
  m.want = fit(rowsWant, attnLambda);
  m.wait = fit(rowsWait, attnLambda);
  m.owed = fit(rowsOwed, () => 1);
  for (const k of Object.keys(m.moment)) m.moment[k] = round4(Math.max(-MOMENT_REACH, Math.min(MOMENT_REACH, m.moment[k])));
  m.answers = examples.filter((e) => e.weight >= 0.5).length;
  m.learnedAt = now;
  return m;
}

interface Row {
  fs: [string, number][];
  z0: number;
  y: 0 | 1;
  c: number;
}

/** Weighted L2 logistic regression by cyclic coordinate Newton steps, as learn.ts train. */
function fit(rows: Row[], lam: (k: string) => number, sweeps = 12): Record<string, number> {
  const index = new Map<string, number>();
  const names: string[] = [];
  const ids = rows.map((r) => r.fs.map(([k]) => index.get(k) ?? (index.set(k, names.push(k) - 1), names.length - 1)));
  const at: { i: number; x: number }[][] = names.map(() => []);
  rows.forEach((r, i) => ids[i].forEach((f, j) => at[f].push({ i, x: r.fs[j][1] })));
  const L = names.map(lam);
  const w = new Float64Array(names.length);
  const z = rows.map((r) => r.z0);
  for (let s = 0; s < sweeps; s++) {
    let moved = 0;
    for (let f = 0; f < names.length; f++) {
      let g = L[f] * w[f];
      let H = L[f];
      for (const { i, x } of at[f]) {
        const p = sigmoid(z[i]);
        g += rows[i].c * (p - rows[i].y) * x;
        H += rows[i].c * p * (1 - p) * x * x;
      }
      const d = Math.max(-2, Math.min(2, -g / H));
      if (!d) continue;
      w[f] += d;
      for (const { i, x } of at[f]) z[i] += d * x;
      moved = Math.max(moved, Math.abs(d));
    }
    if (moved < 1e-4) break;
  }
  const out: Record<string, number> = {};
  for (let f = 0; f < names.length; f++) if (Math.abs(w[f]) >= 1e-3) out[names[f]] = round4(w[f]);
  return out;
}
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Older answers count less, as marks do (learn.ts voteWeight). */
export const answerWeight = voteWeight;

/** The biggest things learned, in words, for "What it learned" (with Forget). */
export function learnedList(m: AttnModel, n: Namer | null, max = 12): { key: string; text: string; by: number }[] {
  const out: { key: string; text: string; by: number }[] = [];
  const name = (k: string) => (k.startsWith('why:') ? (CONVERSING_REASON[k.slice(4) as Why] ?? k) : n ? describe(k, n) : k);
  for (const [k, w] of Object.entries(m.want)) if (Math.abs(w) >= 0.15) out.push({ key: `want|${k}`, text: `${name(k)}: ${w > 0 ? 'matters more' : 'matters less'}`, by: w });
  for (const [k, w] of Object.entries(m.wait)) if (Math.abs(w) >= 0.15) out.push({ key: `wait|${k}`, text: `${name(k)}: ${w > 0 ? 'can wait less' : 'can wait longer'}`, by: w });
  for (const [k, w] of Object.entries(m.owed)) if (Math.abs(w) >= 0.15) out.push({ key: `owed|${k}`, text: `${name(k)}: ${w > 0 ? 'waiting on you counts more' : 'waiting on you counts less'}`, by: w });
  const MOMENT_WORDS: Record<string, string> = { all: 'Any sound', desk: 'A sound while a computer is in use', 'hour:night': 'A sound at night', 'hour:morning': 'A sound in the morning', 'hour:day': 'A sound in the afternoon', 'hour:evening': 'A sound in the evening', burst5: 'A sound minutes after another', burst30: 'A sound within half an hour of another' };
  for (const [k, w] of Object.entries(m.moment)) if (Math.abs(w) >= 0.1) out.push({ key: `moment|${k}`, text: `${MOMENT_WORDS[k] ?? k}: ${w > 0 ? 'costs more' : 'costs less'}`, by: w });
  return out.sort((a, b) => Math.abs(b.by) - Math.abs(a.by)).slice(0, max);
}
