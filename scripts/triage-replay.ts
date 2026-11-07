/**
 * The triage replay (docs/triage-replay.md, docs/research/notification-design.md §6): replays the hub's history day
 * by day against several decision policies and reports how each would have done, with numbers only.
 *
 *   bun scripts/triage-replay.ts --live ~/path/.data/hub.sqlite --out <scratch dir> [--days 14] [--budget 48]
 *   bun scripts/triage-replay.ts --db <scratch dir>/hub-copy.sqlite --out <scratch dir>   (reuse a copy)
 *   bun scripts/triage-replay.ts ... --tune        (also: implicit-label weights against held-out votes)
 *   bun scripts/triage-replay.ts ... --extra my-features.ts   (more features and policies: see `Extra` below)
 *
 * It never opens the live database for writing: it copies it with VACUUM INTO (read-only) and works on the copy. It
 * writes `replay.md` and `replay.json` to --out: counts, rates and test statistics, never message text, names or ids.
 *
 * For every message from someone else that triage decided on (silenced places aside): its facts (as stored with the
 * decision, else the rules' as of now), its words, interaction features as of then (interact.ts: only from earlier
 * messages and visits), and what happened after (labels.ts: answers, reactions, opens, taps, dismissals). Then a
 * rolling split by day: for each day, policies learn from what was known before it and decide that day.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { HEADS, levelFrom, predict, prior, STOOD, STOOD_PER_PLACE, THRESHOLDS, train, voteWeight, words, type Example, type Facts, type Level, type Model } from '../packages/hub/src/learn.ts';
import { dmPeer, Interactions, logFeatures, SELF_SQL, type NumericFeatures } from '../packages/hub/src/interact.ts';
import { BURST, gatherOutcomes, implicitLabel, LABEL_WEIGHTS, LATE, OPEN_WITHIN, QUICK, type Label, type LabelWeights, type Outcome } from '../packages/hub/src/labels.ts';
import { EXPLORE, explorable } from '../packages/hub/src/shadow.ts';
import { Store } from '../packages/hub/src/store.ts';
import { Triage } from '../packages/hub/src/triage.ts';

type Row = Record<string, any>;
type Head = P.TriageHead;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name: string) => argv.includes(`--${name}`);
const outDir = resolve(opt('out', join(import.meta.dir, '..', '.replay'))!);
const days = Number(opt('days', '14'));
const tzOffset = Number(opt('tz', String(-new Date().getTimezoneOffset() / 60))) * HOUR;
const budgetArg = opt('budget');
/** A day with fewer decisions than this is left out. */
const minPerDay = Number(opt('min-per-day', '500'));

// ------------------------------------------------------------------ the replay's world

/** One message from someone else, as the replay sees it. Never written out. */
export interface ReplayExample {
  id: string;
  conv: string;
  ts: number;
  /** Local day number, for the split. */
  day: number;
  facts: Facts;
  words: string[];
  /** Numeric features as of the decision: interaction features, plus whatever `--extra` adds. */
  x: NumericFeatures;
  outcome: Outcome;
  /** The implicit label with the default weights, or null. */
  label: Label | null;
  /** What triage decided at the time. */
  logged: P.TriageDecision;
  /** Your vote, if any, and when. */
  vote: { level: Level; at: number } | null;
}

export interface Decided {
  level: Level;
  probs?: P.TriageProbs;
}

/** What a policy may learn from: everything, and helpers that keep to what was known before `cut`. */
export interface FitContext {
  cut: number;
  all: ReplayExample[];
  votes(cut: number, x?: (k: string) => boolean): Example[];
  stood(cut: number): Example[];
  implicit(cut: number, w?: LabelWeights, x?: (k: string) => boolean): Example[];
}

/** A decision policy. `fit` runs before each test day with what was known then; `decide` is per message. */
export interface Policy {
  name: string;
  about: string;
  fit?(ctx: FitContext): void;
  decide(e: ReplayExample): Decided;
}

/** More features and policies from outside (embeddings, local-model answers): `--extra path.ts` exporting these. */
export interface Extra {
  /** Add numeric features to each example's `x`, from what was known at its time. */
  features?(examples: ReplayExample[], db: Database): Promise<void> | void;
  policies?(make: typeof learned): Policy[];
}

/** The live loop's training (votes.ts): votes and decisions that stood, no numeric features. */
const stoodAndVotes = (ctx: FitContext) => [...ctx.votes(ctx.cut, () => false), ...ctx.stood(ctx.cut)];

/**
 * A learned policy: the hierarchical model (learn.ts) fitted on `examples` before each day, deciding with the numeric
 * features `x` picks (none for the live model).
 */
export function learned(name: string, about: string, examples: (ctx: FitContext) => Example[], x: (k: string) => boolean = () => false): Policy {
  let model: Model | null = null;
  return {
    name,
    about,
    fit(ctx) {
      model = train(examples(ctx));
    },
    decide(e) {
      const xs = pick(e.x, x);
      const p = predict(model!, e.facts, e.words, undefined, xs);
      return { level: p.level, probs: p.probs };
    },
  };
}

const pick = (x: NumericFeatures, keep: (k: string) => boolean): NumericFeatures | undefined => {
  const out: NumericFeatures = {};
  let any = false;
  for (const [k, v] of Object.entries(x)) if (keep(k)) (out[k] = v), (any = true);
  return any ? out : undefined;
};

/** The interaction features of design §3 (interact.ts). */
export const INTERACTION = (k: string) => /^(rr|engaged|alt|since|device|open)(:|$)/.test(k);

export const BASE_POLICIES = (): Policy[] => [
  { name: 'L', about: 'what triage actually decided then (rules and models changed over the window)', decide: (e) => ({ level: (e.logged === 'silent' ? 'drop' : e.logged) as Level }) },
  { name: 'P0', about: "network prior only: where the networks' own settings put it", decide: (e) => ({ level: levelFrom(prior(e.facts)), probs: prior(e.facts) }) },
  learned('P1', 'the live model: votes and decisions that stood (votes.ts), refitted daily', stoodAndVotes),
  learned('P1+labels', 'P1 with labels from what you did (labels.ts) instead of decisions that stood', (ctx) => [...ctx.votes(ctx.cut, () => false), ...ctx.implicit(ctx.cut)]),
  learned('P2', 'P1+labels with interaction features (interact.ts)', (ctx) => [...ctx.votes(ctx.cut, INTERACTION), ...ctx.implicit(ctx.cut, LABEL_WEIGHTS, INTERACTION)], INTERACTION),
];

// ------------------------------------------------------------------ loading

function copyLive(): string {
  const given = opt('db');
  if (given) return resolve(given);
  const live = resolve(opt('live', join(import.meta.dir, '..', '.data', 'hub.sqlite'))!);
  if (!existsSync(live)) throw new Error(`no database at ${live}: pass --live <hub.sqlite> or --db <copy>`);
  mkdirSync(outDir, { recursive: true });
  const copy = join(outDir, `hub-copy-${Date.now()}.sqlite`);
  const src = new Database(live, { readonly: true });
  src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  src.close();
  return copy;
}

const dayOf = (ts: number) => Math.floor((ts + tzOffset) / DAY);
const dayStart = (d: number) => d * DAY - tzOffset;

async function load(path: string) {
  const store = new Store(path, () => null);
  const db = store.db;
  const triage = new Triage(store);
  const span = db.query(`SELECT MIN(m.ts) AS a, MAX(m.ts) AS b FROM triage t JOIN message m ON m.id = t.message_id`).get() as Row;
  const end = span.b as number;
  const from = Math.max(span.a as number, dayStart(dayOf(end) - days + 1));
  const rows = db
    .query(
      `SELECT t.message_id AS id, m.conversation_id AS conv, m.ts, m.body, COALESCE(i.person_id, m.author_id) AS author, t.decision, t.facts, t.feedback, t.feedback_at
       FROM triage t JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id
       WHERE m.ts >= ? AND t.decision != 'silent' AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF_SQL}) ORDER BY m.ts`,
    )
    .all(from) as Row[];
  console.error(`${rows.length} decisions from ${new Date(from).toISOString().slice(0, 10)} to ${new Date(end).toISOString().slice(0, 10)}`);

  // Facts: kept with the decision, else the rules' as of now.
  const facts = new Map<string, Facts>();
  let rebuilt = 0;
  for (const r of rows) {
    let f: Facts | null = r.facts ? JSON.parse(r.facts) : null;
    if (!f) {
      f = (await triage.rulesFor(r.id))?.facts ?? null;
      rebuilt++;
    }
    if (f) facts.set(r.id, f);
  }
  console.error(`facts: ${rows.length - rebuilt} kept, ${rebuilt} rebuilt from the rules`);

  // Interaction features, folding every message in time order from two months before.
  const xs = new Map<string, NumericFeatures>();
  const fold = new Interactions();
  const wanted = new Map(rows.map((r) => [r.id as string, r]));
  const peers = new Map<string, string | null>();
  for (const m of db
    .query(
      `SELECT m.id, m.conversation_id AS conv, m.ts, COALESCE(i.person_id, m.author_id) AS author, m.author_id IN ${SELF_SQL} AS mine
       FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.ts >= ? AND m.ts <= ? AND m.deleted = 0 ORDER BY m.ts`,
    )
    .iterate(from - 60 * DAY, end) as Iterable<Row>) {
    const w = wanted.get(m.id);
    if (w) {
      if (!peers.has(m.conv)) peers.set(m.conv, dmPeer(db, m.conv));
      xs.set(m.id, { ...fold.features(m.conv, m.author, m.ts), ...logFeatures(db, m.conv, peers.get(m.conv) ?? null, m.ts, fold.lastOwn(m.conv)) });
    }
    fold.message({ conv: m.conv, ts: m.ts, author: m.author, mine: !!m.mine });
  }

  const dataEnd = Math.max(end, (db.query('SELECT MAX(end_at) AS t FROM visit').get() as Row).t ?? 0);
  const outcomes = gatherOutcomes(db, from, end + 1, { now: dataEnd });
  const examples: ReplayExample[] = [];
  for (const r of rows) {
    const f = facts.get(r.id);
    const o = outcomes.get(r.id);
    if (!f || !o) continue;
    examples.push({
      id: r.id,
      conv: r.conv,
      ts: r.ts,
      day: dayOf(r.ts),
      facts: f,
      words: words(r.body ?? ''),
      x: xs.get(r.id) ?? {},
      outcome: o,
      label: implicitLabel(o),
      logged: r.decision,
      vote: r.feedback ? { level: r.feedback, at: r.feedback_at ?? r.ts } : null,
    });
  }
  return { store, db, examples, from, end, dataEnd };
}

// ------------------------------------------------------------------ training sets, as of a cut

function fitContext(all: ReplayExample[]): Omit<FitContext, 'cut'> {
  const voted = all.filter((e) => e.vote);
  const pushedOrQuiet = all.filter((e) => e.logged === 'push' || e.logged === 'quiet');
  const relabel = new Map<LabelWeights, Map<string, Label | null>>();
  return {
    all,
    votes: (cut, x = () => false) =>
      voted
        .filter((e) => e.vote!.at < cut)
        .map((e) => ({ facts: e.facts, words: e.words, label: e.vote!.level, x: pick(e.x, x), weight: voteWeight(e.vote!.at, cut), vote: true, at: e.vote!.at })),
    stood(cut) {
      // votes.ts: Important or Active, not voted on (then), half a day to 30 days old, the newest 10 per conversation.
      const per = new Map<string, number>();
      const out: Example[] = [];
      for (let i = pushedOrQuiet.length - 1; i >= 0; i--) {
        const e = pushedOrQuiet[i];
        if (e.ts >= cut - DAY / 2 || e.ts < cut - 30 * DAY || (e.vote && e.vote.at < cut)) continue;
        const n = per.get(e.conv) ?? 0;
        if (n >= STOOD_PER_PLACE) continue;
        per.set(e.conv, n + 1);
        out.push({ facts: e.facts, words: [], label: e.logged as Level, weight: STOOD, vote: false, at: e.ts });
      }
      return out;
    },
    implicit(cut, w = LABEL_WEIGHTS, x = () => false) {
      let labels = relabel.get(w);
      if (!labels) {
        labels = new Map();
        for (const e of all) labels.set(e.id, w === LABEL_WEIGHTS ? e.label : implicitLabel(e.outcome, w));
        relabel.set(w, labels);
      }
      const out: Example[] = [];
      for (const e of all) {
        if (e.vote && e.vote.at < cut) continue;
        const l = labels.get(e.id);
        if (!l || l.knownAt >= cut) continue;
        out.push({ facts: e.facts, words: e.words, y: l.y, x: pick(e.x, x), weight: l.weight, vote: false, at: e.ts });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ delivery: coalescing

/**
 * Which decisions make a sound (design §7): Important, and the first of a run after a 5-minute lull, or a rise from
 * Active, or it mentions or replies to you. Without coalescing, every Important one does.
 */
function alerts(es: ReplayExample[], levels: Level[], coalesce: boolean): boolean[] {
  const shown = new Map<string, Level | null>();
  return es.map((e, i) => {
    const l = levels[i];
    if (e.outcome.lullFirst) shown.set(e.conv, null);
    if (l !== 'push' && l !== 'quiet') return false;
    const was = shown.get(e.conv) ?? null;
    if (l === 'quiet') {
      if (was === null) shown.set(e.conv, 'quiet');
      return false;
    }
    shown.set(e.conv, 'push');
    return !coalesce || was !== 'push' || e.outcome.addressed;
  });
}

// ------------------------------------------------------------------ metrics

const there = (o: Outcome) => o.engaged || o.seenLive || o.suppressed;
const actedQuick = (o: Outcome) => (o.nextOwn !== null && o.nextOwn <= QUICK) || o.reacted;
const openedQuick = (o: Outcome) => o.opened !== null && o.opened <= QUICK;
/** Reference outcomes per chance, for calibration: the same whatever the label weights. */
const REFERENCE: Record<Head, (o: Outcome) => 0 | 1 | null> = {
  ping: (o) => (there(o) || o.observed < LATE ? null : actedQuick(o) ? 1 : 0),
  active: (o) => (o.observed < LATE ? null : (o.nextOwn !== null && o.nextOwn <= LATE) || o.reacted || (o.opened !== null && o.opened <= OPEN_WITHIN) || o.unprompted ? 1 : 0),
  interesting: (o) => (o.observed < DAY ? null : o.nextOwn !== null || o.reacted || o.opened !== null ? 1 : 0),
};

/** Exact two-sided McNemar on discordant pairs. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let lp = -Infinity;
  const lc = (i: number) => lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) - n * Math.LN2;
  for (let i = 0; i <= k; i++) {
    const v = lc(i);
    lp = lp === -Infinity ? v : Math.max(lp, v) + Math.log1p(Math.exp(-Math.abs(lp - v)));
  }
  return Math.min(1, 2 * Math.exp(lp));
}
function lgamma(x: number): number {
  // Stirling with corrections; exact enough for p-values.
  if (x < 7) {
    let p = 1;
    while (x < 7) p *= x++;
    return lgamma(x) - Math.log(p);
  }
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x) - 1 / (360 * x ** 3);
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};
const r = (x: number | null, d = 3) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

interface Run {
  policy: string;
  coalesce: boolean;
  levels: Level[];
  probs: (P.TriageProbs | undefined)[];
  alert: boolean[];
}

/** Reply events: your quick answer to a message, when you were not there already. Covered: something sounded in that conversation in the half hour before, up to your answer. */
function covered(test: ReplayExample[], sounded: boolean[], events: number[]): boolean[] {
  const byConv = new Map<string, number[]>();
  test.forEach((e, i) => sounded[i] && (byConv.get(e.conv) ?? byConv.set(e.conv, []).get(e.conv)!).push(e.ts));
  return events.map((i) => {
    const e = test[i];
    const end = e.ts + (e.outcome.nextOwn ?? 0);
    return (byConv.get(e.conv) ?? []).some((t) => t >= e.ts - BURST && t <= end);
  });
}

/** Reply events: indices of messages you answered within 15 minutes when you were not already there. */
function replyEvents(es: ReplayExample[]): number[] {
  return es.map((e, i) => (e.outcome.answered && e.outcome.nextOwn !== null && e.outcome.nextOwn <= QUICK && !there(e.outcome) ? i : -1)).filter((i) => i >= 0);
}

function metrics(test: ReplayExample[], run: Run, nDays: number, events: number[]) {
  const n = test.length;
  const notified = run.levels.filter((l) => l === 'push' || l === 'quiet').length;
  const pushes = run.levels.filter((l) => l === 'push').length;
  const alertTimes = test.filter((_, i) => run.alert[i]).map((e) => e.ts);
  let maxHour = 0;
  for (let i = 0, j = 0; i < alertTimes.length; i++) {
    while (alertTimes[i] - alertTimes[j] >= HOUR) j++;
    maxHour = Math.max(maxHour, i - j + 1);
  }
  const counted = test.map((e, i) => (run.alert[i] && !there(e.outcome) && e.outcome.observed >= QUICK ? i : -1)).filter((i) => i >= 0);
  const precisionReply = counted.length ? counted.filter((i) => actedQuick(test[i].outcome)).length / counted.length : null;
  const precisionOpen = counted.length ? counted.filter((i) => openedQuick(test[i].outcome)).length / counted.length : null;
  const cov = covered(test, run.alert, events);
  const unprompted = test.map((e, i) => (e.outcome.unprompted ? i : -1)).filter((i) => i >= 0);
  const notifiedTimes = new Map<string, number[]>();
  test.forEach((e, i) => (run.levels[i] === 'push' || run.levels[i] === 'quiet') && (notifiedTimes.get(e.conv) ?? notifiedTimes.set(e.conv, []).get(e.conv)!).push(e.ts));
  const missed = unprompted.filter((i) => !(notifiedTimes.get(test[i].conv) ?? []).some((t) => t >= test[i].ts && t <= test[i].ts + OPEN_WITHIN)).length;
  const lat = { alerted: [] as number[], not: [] as number[] };
  events.forEach((i, k) => (cov[k] ? lat.alerted : lat.not).push(test[i].outcome.nextOwn!));
  // Calibration: Brier and a reliability table per chance, against the reference outcomes.
  const calibration: Record<string, unknown> = {};
  if (run.probs.some(Boolean))
    for (const h of HEADS) {
      const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
      let brier = 0;
      let m = 0;
      test.forEach((e, i) => {
        const p = run.probs[i]?.[h];
        const y = REFERENCE[h](e.outcome);
        if (p === undefined || y === null) return;
        brier += (p - y) ** 2;
        m++;
        const b = bins[Math.min(9, Math.floor(p * 10))];
        b.n++;
        b.p += p;
        b.y += y;
      });
      calibration[h] = { brier: r(m ? brier / m : null, 4), n: m, base: r(m ? bins.reduce((a, b) => a + b.y, 0) / m : null, 4), bins: bins.filter((b) => b.n).map((b) => ({ predicted: r(b.p / b.n), observed: r(b.y / b.n), n: b.n })) };
    }
  // Where it agrees with what was logged, and where not: the replay's bias shows here (design §6).
  const slice = (keep: (i: number) => boolean) => {
    const xs = counted.filter(keep);
    return { alerts: xs.length, precisionReply: r(xs.length ? xs.filter((i) => actedQuick(test[i].outcome)).length / xs.length : null) };
  };
  // How often exploration (shadow.ts) could draw, with this policy deciding: up, a Digest or Not-interesting message
  // with its Active chance in the band under the threshold; down, Important in a conversation with 10+ pings that day.
  let upEligible = 0;
  let downEligible = 0;
  const pingsPerConvDay = new Map<string, number>();
  test.forEach((e, i) => run.levels[i] === 'push' && pingsPerConvDay.set(`${e.conv}/${e.day}`, (pingsPerConvDay.get(`${e.conv}/${e.day}`) ?? 0) + 1));
  test.forEach((e, i) => {
    const p = run.probs[i];
    if (!p || !explorable({ facts: e.facts, starred: false, keyword: false, quietHours: false, dmAfterLull: e.facts.shape === 'direct' && e.outcome.lullFirst })) return;
    if ((run.levels[i] === 'digest' || run.levels[i] === 'drop') && p.active >= EXPLORE.upBand && p.active < THRESHOLDS.active) upEligible++;
    if (run.levels[i] === 'push' && (pingsPerConvDay.get(`${e.conv}/${e.day}`) ?? 0) >= EXPLORE.downBusy) downEligible++;
  });
  return {
    messages: n,
    exploreEligiblePerDay: run.probs.some(Boolean) ? { up: r(upEligible / nDays, 1), down: r(downEligible / nDays, 1) } : null,
    notifiedPerDay: r(notified / nDays, 1),
    pushesPerDay: r(pushes / nDays, 1),
    alertsPerDay: r(alertTimes.length / nDays, 1),
    maxAlertsPerHour: maxHour,
    precisionReply: r(precisionReply),
    precisionOpen: r(precisionOpen),
    alertsJudged: counted.length,
    replyEvents: events.length,
    recall: r(events.length ? cov.filter(Boolean).length / events.length : null),
    unpromptedBursts: unprompted.length,
    missedUnprompted: missed,
    medianReplyMinutes: { alerted: r(median(lat.alerted) === null ? null : median(lat.alerted)! / MIN, 1), notAlerted: r(median(lat.not) === null ? null : median(lat.not)! / MIN, 1) },
    agreeWithLogged: slice((i) => test[i].logged === 'push'),
    newVsLogged: slice((i) => test[i].logged !== 'push'),
    calibration,
    covered: cov,
  };
}

/** The ping threshold that gives `budget` alerts a day, and the recall there. */
function atBudget(test: ReplayExample[], run: Run, budget: number, nDays: number, events: number[]) {
  if (!run.probs.every(Boolean)) return null;
  const levelAt = (th: number) => run.probs.map((p, i) => (p!.ping >= th ? 'push' : run.levels[i] === 'push' ? 'quiet' : run.levels[i]) as Level);
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    const n = alerts(test, levelAt(mid), run.coalesce).filter(Boolean).length / nDays;
    if (n > budget) lo = mid;
    else hi = mid;
  }
  const a = alerts(test, levelAt(hi), run.coalesce);
  const cov = covered(test, a, events);
  const perDay = a.filter(Boolean).length / nDays;
  // A policy whose chances are a handful of fixed values (P0) cannot be cut at an arbitrary volume.
  return { threshold: r(hi, 4), alertsPerDay: r(perDay, 1), reached: Math.abs(perDay - budget) <= Math.max(1, budget * 0.2), recall: r(events.length ? cov.filter(Boolean).length / events.length : null), covered: cov };
}

// ------------------------------------------------------------------ the run

async function main() {
  const path = copyLive();
  console.error(`replaying ${path}`);
  const { db, examples, dataEnd } = await load(path);
  let extra: Extra = {};
  if (opt('extra')) extra = (await import(resolve(opt('extra')!))) as Extra;
  await extra.features?.(examples, db);
  const ctx0 = fitContext(examples);
  const policies = [...BASE_POLICIES(), ...(extra.policies?.(learned) ?? [])];

  // Days with hardly anything (a stray message decided late) are edges, not days.
  const perDay = new Map<number, number>();
  for (const e of examples) perDay.set(e.day, (perDay.get(e.day) ?? 0) + 1);
  const allDays = [...perDay].filter(([, n]) => n >= minPerDay).map(([d]) => d).sort((a, b) => a - b);
  // The first day has nothing before it to learn from; the last may be partial, and is kept.
  const testDays = allDays.slice(1);
  const test = examples.filter((e) => testDays.includes(e.day));
  const spanOf = (ds: number[]) => ds.reduce((n, d) => n + (Math.min(dataEnd, dayStart(d + 1)) - dayStart(d)) / DAY, 0) || 1;
  const nDays = spanOf(testDays);
  const events = replyEvents(test);

  const runs: Run[] = [];
  const voteChecks: Record<string, { n: number; right: number; logLoss: number }> = {};
  for (const p of policies) {
    const levels: Level[] = [];
    const probs: (P.TriageProbs | undefined)[] = [];
    const vc = (voteChecks[p.name] = { n: 0, right: 0, logLoss: 0 });
    const t0 = performance.now();
    for (const d of testDays) {
      const cut = dayStart(d);
      p.fit?.({ ...ctx0, cut });
      for (const e of test) {
        if (e.day !== d) continue;
        const x = p.decide(e);
        levels.push(x.level);
        probs.push(x.probs);
      }
      // Votes given on this day, on whatever message: held out from the fit above.
      for (const e of examples) {
        if (!e.vote || dayOf(e.vote.at) !== d) continue;
        const x = p.decide(e);
        vc.n++;
        if (x.level === e.vote.level) vc.right++;
        if (x.probs) {
          const want = { push: 'ping', quiet: 'active', digest: 'interesting', drop: 'interesting' }[e.vote.level] as Head;
          const y = e.vote.level === 'drop' ? 0 : 1;
          const q = Math.min(1 - 1e-6, Math.max(1e-6, x.probs[want]));
          vc.logLoss -= y ? Math.log(q) : Math.log(1 - q);
          // Also the chance just above: a vote for Active says ping was wrong.
          if (e.vote.level !== 'push') vc.logLoss -= Math.log(Math.min(1 - 1e-6, Math.max(1e-6, 1 - x.probs[e.vote.level === 'quiet' ? 'ping' : e.vote.level === 'digest' ? 'active' : 'interesting'])));
        }
      }
    }
    console.error(`${p.name}: ${Math.round(performance.now() - t0)} ms`);
    for (const coalesce of [false, true]) runs.push({ policy: p.name, coalesce, levels, probs, alert: alerts(test, levels, coalesce) });
  }

  const budget = budgetArg ? Number(budgetArg) : Math.round(((runs.find((x) => x.policy === 'L' && x.coalesce)!.alert.filter(Boolean).length / nDays) * 10)) / 10;
  const results = runs.map((run) => {
    const m = metrics(test, run, nDays, events);
    return { policy: run.policy, coalesce: run.coalesce, ...m, atBudget: atBudget(test, run, budget, nDays, events) };
  });
  // Paired comparisons on the same reply events, against P1: at each policy's own threshold, and at the budget.
  const paired: { a: string; b: string; at: string; onlyA: number; onlyB: number; p: number }[] = [];
  const pair = (a: string, at: string, ca: boolean[], cb: boolean[]) => {
    const onlyA = ca.filter((c, k) => c && !cb[k]).length;
    const onlyB = ca.filter((c, k) => !c && cb[k]).length;
    paired.push({ a, b: 'P1', at, onlyA, onlyB, p: r(mcnemar(onlyA, onlyB), 4)! });
  };
  for (const coalesce of [false, true]) {
    const b = results.find((x) => x.coalesce === coalesce && x.policy === 'P1');
    if (!b) continue;
    for (const a of results.filter((x) => x.coalesce === coalesce && x.policy !== 'P1')) pair(a.policy, coalesce ? 'own threshold, coalesced' : 'own threshold', a.covered, b.covered);
    if (coalesce && b.atBudget?.reached)
      for (const a of results.filter((x) => x.coalesce && x.policy !== 'P1' && x.atBudget?.reached)) pair(a.policy, `budget ${budget}/day, coalesced`, a.atBudget!.covered, b.atBudget!.covered);
  }

  let tuning: unknown = null;
  if (flag('tune')) tuning = tune(examples, testDays, test, spanOf, budget);

  const summary = {
    generated: new Date().toISOString(),
    window: { days: allDays.length, testDays: testDays.length, testSpanDays: r(nDays, 2), messages: examples.length, testMessages: test.length },
    labels: labelCounts(examples),
    votes: { total: examples.filter((e) => e.vote).length },
    features: featureSummary(test),
    budget,
    policies: policies.map((p) => ({ name: p.name, about: p.about })),
    results: results.map(({ covered, atBudget, ...rest }) => ({ ...rest, atBudget: atBudget && { ...atBudget, covered: undefined } })),
    voteAgreement: Object.fromEntries(Object.entries(voteChecks).map(([k, v]) => [k, { votes: v.n, right: v.right, logLoss: v.n ? r(v.logLoss / v.n) : null }])),
    paired,
    tuning,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'replay.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, 'replay.md'), markdown(summary));
  console.log(markdown(summary));
  db.close();
}

function labelCounts(es: ReplayExample[]) {
  const why: Record<string, number> = {};
  const heads: Record<string, { pos: number; neg: number }> = { ping: { pos: 0, neg: 0 }, active: { pos: 0, neg: 0 }, interesting: { pos: 0, neg: 0 } };
  for (const e of es) {
    if (!e.label) continue;
    for (const w of e.label.why) why[w] = (why[w] ?? 0) + 1;
    for (const [h, y] of Object.entries(e.label.y)) heads[h][y ? 'pos' : 'neg']++;
  }
  return { labelled: es.filter((e) => e.label).length, rules: why, heads };
}

function featureSummary(es: ReplayExample[]) {
  const out: Record<string, { nonzero: number; mean: number }> = {};
  for (const e of es)
    for (const [k, v] of Object.entries(e.x)) {
      const o = (out[k] ??= { nonzero: 0, mean: 0 });
      if (v) o.nonzero++;
      o.mean += v / es.length;
    }
  for (const o of Object.values(out)) o.mean = r(o.mean)!;
  return out;
}

/**
 * The implicit labels' weights against held-out votes: each candidate set of weights trains P1+labels day by day, and
 * is scored on the votes given that day. With a dozen votes this can only rule out the wildly wrong.
 *
 * The test days are split in two: the weights are chosen on the first half (validation) and reported on the second
 * (holdout), so the number quoted for the chosen weights is not the one they were chosen by. `all` is both halves.
 */
function tune(examples: ReplayExample[], testDays: number[], test: ReplayExample[], spanOf: (days: number[]) => number, budget: number) {
  const ctx0 = fitContext(examples);
  const half = Math.ceil(testDays.length / 2);
  const parts = { validation: testDays.slice(0, half), holdout: testDays.slice(half) };
  const grid: { name: string; w: LabelWeights }[] = [];
  for (const scale of [0.5, 1, 2])
    for (const nothing of [0, 0.01, 0.03, 0.1, 0.3]) {
      const w = Object.fromEntries(Object.entries(LABEL_WEIGHTS).map(([k, v]) => [k, k === 'nothing' ? nothing : v * scale])) as unknown as LabelWeights;
      grid.push({ name: `scale ${scale}, nothing ${nothing}`, w });
    }
  const rows = grid.map(({ name, w }) => {
    const p = learned('tune', name, (ctx) => [...ctx.votes(ctx.cut, INTERACTION), ...ctx.implicit(ctx.cut, w, INTERACTION)], INTERACTION);
    const decided = new Map<ReplayExample, { level: Level; probs: P.TriageProbs }>();
    const voted = new Map<number, { n: number; right: number; loss: number }>();
    for (const d of testDays) {
      p.fit!({ ...ctx0, cut: dayStart(d) });
      for (const e of test) if (e.day === d) {
        const x = p.decide(e);
        decided.set(e, { level: x.level, probs: x.probs! });
      }
      const v = { n: 0, right: 0, loss: 0 };
      for (const e of examples) {
        if (!e.vote || dayOf(e.vote.at) !== d) continue;
        const x = p.decide(e);
        v.n++;
        if (x.level === e.vote.level) v.right++;
        const q = Math.min(1 - 1e-6, Math.max(1e-6, x.probs!.ping));
        v.loss -= e.vote.level === 'push' ? Math.log(q) : Math.log(1 - q);
      }
      voted.set(d, v);
    }
    const score = (days: number[]) => {
      const sub = test.filter((e) => days.includes(e.day));
      const levels = sub.map((e) => decided.get(e)!.level);
      const probs = sub.map((e) => decided.get(e)!.probs);
      const run: Run = { policy: 'tune', coalesce: true, levels, probs, alert: alerts(sub, levels, true) };
      const span = spanOf(days);
      const events = replyEvents(sub);
      const m = metrics(sub, run, span, events);
      const v = days.reduce((a, d) => ({ n: a.n + (voted.get(d)?.n ?? 0), right: a.right + (voted.get(d)?.right ?? 0), loss: a.loss + (voted.get(d)?.loss ?? 0) }), { n: 0, right: 0, loss: 0 });
      return { days: days.length, votes: v.n, right: v.right, pingLogLoss: v.n ? r(v.loss / v.n) : null, alertsPerDay: m.alertsPerDay, recall: m.recall, precisionReply: m.precisionReply, atBudget: atBudget(sub, run, budget, span, events) };
    };
    return { weights: name, all: score(testDays), validation: score(parts.validation), holdout: score(parts.holdout) };
  });
  // Chosen on validation only: most votes right, then the lower ping log loss, then recall at the budget.
  const key = (x: (typeof rows)[number]['validation']) => [x.right, -(x.pingLogLoss ?? Infinity), x.atBudget?.recall ?? -1];
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  const chosen = rows.reduce((best, x) => (better(key(x.validation), key(best.validation)) ? x : best), rows[0]);
  return { split: { validationDays: parts.validation.length, holdoutDays: parts.holdout.length }, chosen: chosen?.weights ?? null, rows };
}

function markdown(s: any): string {
  const L: string[] = [];
  L.push(`# Triage replay, ${s.generated.slice(0, 10)}`, '');
  L.push(`${s.window.messages} decisions over ${s.window.days} days; ${s.window.testMessages} in ${s.window.testDays} test days (${s.window.testSpanDays} days of data). ${s.votes.total} votes. Reply events (your answer within 15 min, not already there): ${s.results[0].replyEvents}.`, '');
  L.push('Policies:', ...s.policies.map((p: any) => `- **${p.name}**: ${p.about}`), '');
  L.push('| Policy | Coalesced | Notified/day | Pings/day | Alerts/day | Max alerts/h | Precision (reply ≤15m) | Precision (open ≤15m) | Recall | Missed unprompted | Median reply min (alerted / not) |');
  L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const x of s.results)
    L.push(`| ${x.policy} | ${x.coalesce ? 'yes' : 'no'} | ${x.notifiedPerDay} | ${x.pushesPerDay} | ${x.alertsPerDay} | ${x.maxAlertsPerHour} | ${x.precisionReply ?? '–'} | ${x.precisionOpen ?? '–'} | ${x.recall ?? '–'} | ${x.missedUnprompted}/${x.unpromptedBursts} | ${x.medianReplyMinutes.alerted ?? '–'} / ${x.medianReplyMinutes.notAlerted ?? '–'} |`);
  L.push('', `At a budget of **${s.budget} alerts/day** (coalesced; the ping threshold chosen per policy on the test days to hit it):`, '');
  L.push('| Policy | Threshold | Alerts/day | Recall |', '| --- | ---: | ---: | ---: |');
  for (const x of s.results.filter((x: any) => x.coalesce && x.atBudget))
    L.push(x.atBudget.reached ? `| ${x.policy} | ${x.atBudget.threshold} | ${x.atBudget.alertsPerDay} | ${x.atBudget.recall} |` : `| ${x.policy} | – | cannot reach it (no ranking within a level) | – |`);
  L.push('', 'Agree / disagree with what was logged (uncoalesced alerts, not already there): precision where the logged decision also pinged, and where it did not.', '');
  L.push('| Policy | Agree: alerts | precision | New: alerts | precision |', '| --- | ---: | ---: | ---: | ---: |');
  for (const x of s.results.filter((x: any) => !x.coalesce)) L.push(`| ${x.policy} | ${x.agreeWithLogged.alerts} | ${x.agreeWithLogged.precisionReply ?? '–'} | ${x.newVsLogged.alerts} | ${x.newVsLogged.precisionReply ?? '–'} |`);
  L.push('', 'Exploration (shadow.ts) with each policy deciding: messages a day it could draw on. Up draws at 2% (at most 3 a day), down at 5% (once per conversation a day).', '');
  L.push('| Policy | Up-eligible/day | Down-eligible/day |', '| --- | ---: | ---: |');
  for (const x of s.results.filter((x: any) => !x.coalesce && x.exploreEligiblePerDay)) L.push(`| ${x.policy} | ${x.exploreEligiblePerDay.up} | ${x.exploreEligiblePerDay.down} |`);
  L.push('', 'Held-out votes (each scored by the model fitted before the day it was given):', '');
  L.push('| Policy | Votes | Right | Log loss |', '| --- | ---: | ---: | ---: |');
  for (const [k, v] of Object.entries<any>(s.voteAgreement)) L.push(`| ${k} | ${v.votes} | ${v.right} | ${v.logLoss ?? '–'} |`);
  L.push('', 'Calibration (Brier; base rate of the reference outcome), uncoalesced:', '');
  L.push('| Policy | ping | active | interesting |', '| --- | --- | --- | --- |');
  for (const x of s.results.filter((x: any) => !x.coalesce && Object.keys(x.calibration).length))
    L.push(`| ${x.policy} | ${HEADS.map((h) => (x.calibration[h] ? `${x.calibration[h].brier} (base ${x.calibration[h].base}, n ${x.calibration[h].n})` : '–')).join(' | ')} |`);
  L.push('', 'Paired against P1 on the same reply events (McNemar, exact): covered only by A, only by P1.', '');
  L.push('| A | At | Only A | Only P1 | p |', '| --- | --- | ---: | ---: | ---: |');
  for (const p of s.paired) L.push(`| ${p.a} | ${p.at} | ${p.onlyA} | ${p.onlyB} | ${p.p} |`);
  L.push('', `Labels from what you did: ${s.labels.labelled} messages. Rules: ${Object.entries(s.labels.rules).map(([k, v]) => `${k} ${v}`).join(', ')}. By chance (positive/negative): ${Object.entries<any>(s.labels.heads).map(([h, v]) => `${h} ${v.pos}/${v.neg}`).join(', ')}.`);
  L.push('', `Interaction features on test messages (share non-zero, mean): ${Object.entries<any>(s.features).map(([k, v]) => `${k} ${r(v.nonzero / s.window.testMessages, 3)}, ${v.mean}`).join('; ')}.`);
  if (s.tuning) {
    const t = s.tuning;
    L.push('', `Tuning the implicit-label weights (P2 shape): chosen on the first ${t.split.validationDays} test days (validation), reported on the last ${t.split.holdoutDays} (holdout). Chosen: **${t.chosen}**.`, '');
    L.push('| Weights | Validation: votes right | Ping log loss | Recall at budget | Holdout: votes right | Alerts/day | Recall | Precision | Recall at budget |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const cell = (x: any) => x ?? '–';
    for (const row of t.rows) {
      const v = row.validation;
      const h = row.holdout;
      L.push(`| ${row.weights === t.chosen ? `**${row.weights}**` : row.weights} | ${v.right} / ${v.votes} | ${cell(v.pingLogLoss)} | ${cell(v.atBudget?.recall)} | ${h.right} / ${h.votes} | ${h.alertsPerDay} | ${cell(h.recall)} | ${cell(h.precisionReply)} | ${cell(h.atBudget?.recall)} |`);
    }
  }
  return L.join('\n') + '\n';
}

if (import.meta.main) await main();
