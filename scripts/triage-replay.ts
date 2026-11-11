/**
 * The triage replay (docs/triage-replay.md): replays the hub's history day by day through the three tiers and
 * reports what each way of learning would have done, with numbers only.
 *
 *   bun scripts/triage-replay.ts --live ~/path/.data/hub.sqlite --out <scratch dir> [--days 14] [--level 0.5]
 *   bun scripts/triage-replay.ts --db <scratch dir>/hub-copy.sqlite --out <scratch dir>   (reuse a copy)
 *   bun scripts/triage-replay.ts ... --no-judge      (do not ask the local model: nothing alerts by chance)
 *
 * It never opens the live database for writing: it copies it with VACUUM INTO (read-only) and works on the copy,
 * which the hub's own Store then opens, so a copy from before a schema change is migrated first: the replay is also
 * the migration's dry run. It writes `replay.md` and `replay.json` to --out: counts and rates, never message text,
 * names or ids. Message text goes to the local model (jev, on this machine) for the alert question, as the hub sends
 * it, and nowhere else.
 *
 * For every message from someone else that triage decided on (silenced places aside): its facts (as stored with the
 * decision, else the rules' as of now), whether the Conversation rule held then (tiers.ts, from a fold of who wrote
 * when: only earlier messages), the local model's answer if it is one, its words, and what happened after
 * (labels.ts). Then a rolling split by day: for each day, each policy learns from what was known before it and
 * decides that day.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ALERT_BAR, emptyModel, labelsOf, OLD_VOTE, predict, prior, THRESHOLDS, tierFrom, train, voteWeight, words, type Example, type Facts, type Level, type Model } from '../packages/hub/src/learn.ts';
import { Interactions, SELF_SQL, type NumericFeatures } from '../packages/hub/src/interact.ts';
import { gatherOutcomes, implicitLabel, IGNORED_AFTER, LABEL_WEIGHTS, type Label, type LabelWeights, type Outcome } from '../packages/hub/src/labels.ts';
import { Jev } from '../packages/hub/src/embeddings.ts';
import { LIST_EVERY } from '../packages/hub/src/delivery.ts';
import { Store } from '../packages/hub/src/store.ts';
import { conversing, type Conversing } from '../packages/hub/src/tiers.ts';
import { JUDGE_CHARS, STOP_QUESTION, Triage } from '../packages/hub/src/triage.ts';
import { IMPLICIT_PER_PLACE, IMPLICIT_WINDOW, LIST_LEVELS } from '../packages/hub/src/votes.ts';

type Row = Record<string, any>;
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
const LEVEL = Number(opt('level', String(THRESHOLDS.important)));
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
  /** Why it is a Conversation, or null. */
  why: Conversing;
  words: string[];
  x: NumericFeatures;
  outcome: Outcome;
  /** What it says of importance, or null. */
  label: Label | null;
  /** What triage decided at the time, by the level it had then. */
  logged: string;
  vote: { level: Level; at: number } | null;
}

export interface Policy {
  name: string;
  about: string;
  /** The model as of `cut`, from what was known before it. */
  fit(cut: number, all: readonly ReplayExample[]): Model;
}

const votesBefore = (all: readonly ReplayExample[], cut: number): Example[] =>
  all.filter((e) => e.vote && e.vote.at < cut).map((e) => ({ id: e.id, facts: e.facts, words: e.words, label: e.vote!.level, weight: OLD_VOTE * voteWeight(e.vote!.at, cut), vote: true, at: e.vote!.at }));

/** What you did, known before `cut`, from the two weeks before it; `perPlace`: at most that many per conversation, the newest. */
function implicitBefore(all: readonly ReplayExample[], cut: number, perPlace: number, w: LabelWeights = LABEL_WEIGHTS): Example[] {
  const out: Example[] = [];
  const per = new Map<string, number>();
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.ts >= cut || e.ts < cut - IMPLICIT_WINDOW || (e.vote && e.vote.at < cut)) continue;
    const label = w === LABEL_WEIGHTS ? e.label : implicitLabel(e.outcome, w);
    if (!label || label.knownAt >= cut) continue;
    const n = per.get(e.conv) ?? 0;
    if (n >= perPlace) continue;
    per.set(e.conv, n + 1);
    out.push({ id: e.id, facts: e.facts, words: e.words, y: label.y, weight: label.weight, vote: false, at: e.ts });
  }
  return out;
}

/** `live` with other weights for what you did, to see which kind of label earns its place. */
const withWeights = (name: string, about: string, w: Partial<LabelWeights>): Policy => ({
  name,
  about,
  fit: (cut, all) => train([...votesBefore(all, cut), ...implicitBefore(all, cut, IMPLICIT_PER_PLACE, { ...LABEL_WEIGHTS, ...w })]),
});

export const POLICIES: Policy[] = [
  { name: 'start', about: 'no learning: the network as the start for importance, the local model against the bars for alerts', fit: () => emptyModel() },
  { name: 'votes', about: 'the start plus the votes from before the tiers', fit: (cut, all) => train(votesBefore(all, cut)) },
  {
    name: 'live',
    about: `as the hub learns: the votes, and what you did (labels.ts), the newest ${IMPLICIT_PER_PLACE} in each conversation`,
    fit: (cut, all) => train([...votesBefore(all, cut), ...implicitBefore(all, cut, IMPLICIT_PER_PLACE)]),
  },
  { name: 'all you did', about: 'as live, with everything you did in each conversation, not only the newest', fit: (cut, all) => train([...votesBefore(all, cut), ...implicitBefore(all, cut, Infinity)]) },
  ...(flag('labels')
    ? [
        withWeights('with swipes', 'as live, with a list row swiped away and not opened as a no', { dismissed: 0.3 }),
        withWeights('with nothing', 'as live, with "nothing happened after it" as a no', { nothing: 0.03 }),
        withWeights('opens only', 'as live, without answers: only opens', { answered: 0 }),
      ]
    : []),
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
  const t0 = performance.now();
  const store = new Store(path, () => null);
  const migrated = Math.round(performance.now() - t0);
  const db = store.db;
  const triage = new Triage(store);
  const span = db.query(`SELECT MIN(m.ts) AS a, MAX(m.ts) AS b FROM triage t JOIN message m ON m.id = t.message_id`).get() as Row;
  const end = span.b as number;
  const from = Math.max(span.a as number, dayStart(dayOf(end) - days + 1));
  const rows = db
    .query(
      `SELECT t.message_id AS id, m.conversation_id AS conv, m.ts, m.body, COALESCE(i.person_id, m.author_id) AS author, COALESCE(t.was, t.decision) AS logged, t.facts, t.feedback, t.feedback_at
       FROM triage t JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id
       WHERE m.ts >= ? AND t.decision != 'silent' AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF_SQL}) ORDER BY m.ts`,
    )
    .all(from) as Row[];
  console.error(`${rows.length} decisions from ${new Date(from).toISOString().slice(0, 10)} to ${new Date(end).toISOString().slice(0, 10)}; the copy opened (and migrated, if it needed it) in ${migrated} ms`);

  // Facts: kept with the decision, else the rules' as of now. Whether a place is kept to the list is as of now.
  const facts = new Map<string, Facts>();
  const capped = new Map<string, boolean>();
  let rebuilt = 0;
  for (const r of rows) {
    let f: Facts | null = r.facts ? JSON.parse(r.facts) : null;
    if (!f) {
      f = triage.rulesFor(r.id)?.facts ?? null;
      rebuilt++;
    }
    if (!f) continue;
    if (!capped.has(r.conv)) capped.set(r.conv, triage.effectiveLevel(r.conv).level === 'digest');
    delete f.judge;
    f.cap = capped.get(r.conv) || undefined;
    facts.set(r.id, f);
  }
  console.error(`facts: ${rows.length - rebuilt} kept, ${rebuilt} rebuilt from the rules`);

  // The Conversation rule as of each message, folding every message in time order from two months before.
  const fold = new Interactions();
  const whys = new Map<string, Conversing>();
  const wanted = new Set(rows.map((r) => r.id as string));
  for (const m of db
    .query(
      `SELECT m.id, m.conversation_id AS conv, m.ts, COALESCE(i.person_id, m.author_id) AS author, m.author_id IN ${SELF_SQL} AS mine
       FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.ts >= ? AND m.ts <= ? AND m.deleted = 0 ORDER BY m.ts`,
    )
    .iterate(from - 60 * DAY, end) as Iterable<Row>) {
    const f = wanted.has(m.id) ? facts.get(m.id) : undefined;
    if (f) {
      const why = conversing(f, { lastOwn: fold.lastOwn(m.conv), answerRate: fold.answerRate(m.conv, m.ts) }, m.ts);
      whys.set(m.id, why);
      f.conv = !!why;
    }
    fold.message({ conv: m.conv, ts: m.ts, author: m.author, mine: !!m.mine });
  }

  // The local model's answer for every Conversation message (jev caches by the text).
  const ask = rows.filter((r) => whys.get(r.id) && (r.body ?? '').trim());
  let judged = 0;
  if (!flag('no-judge') && ask.length) {
    const jev = new Jev(opt('jev', process.env.DITHER_JEV_URL ?? 'http://127.0.0.1:7862'), 600_000);
    const t1 = performance.now();
    for (let i = 0; i < ask.length; i += 250) {
      const part = ask.slice(i, i + 250);
      const ps = await jev.judge(STOP_QUESTION, part.map((r) => (r.body as string).slice(0, JUDGE_CHARS).trim()));
      ps.forEach((p, k) => {
        if (p === null) return;
        facts.get(part[k].id)!.judge = Math.round(p * 1000) / 1000;
        judged++;
      });
    }
    console.error(`the local model read ${judged} of ${ask.length} Conversation messages in ${Math.round((performance.now() - t1) / 1000)} s`);
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
      why: whys.get(r.id) ?? null,
      words: words(r.body ?? ''),
      x: {},
      outcome: o,
      label: implicitLabel(o),
      logged: r.logged,
      vote: r.feedback ? { level: r.feedback, at: r.feedback_at ?? r.ts } : null,
    });
  }
  const visitsFrom = (db.query('SELECT MIN(start_at) AS t FROM visit').get() as Row).t as number | null;
  return { store, db, examples, from, end, dataEnd, visitsFrom, judged, migrated };
}

// ------------------------------------------------------------------ deciding a day

interface Decided {
  e: ReplayExample;
  probs: P.TriageProbs;
  tier: Level;
}

function decideDay(model: Model, day: readonly ReplayExample[], t: P.TriageProbs, bars = ALERT_BAR): Decided[] {
  return day.map((e) => {
    const p = predict(model, e.facts, e.words, bars === ALERT_BAR ? undefined : startWith(e.facts, bars)).probs;
    const conv = !!e.facts.conv;
    return { e, probs: p, tier: tierFrom(p, { conv, eligible: conv, judged: e.facts.judge !== undefined, listOnly: !!e.facts.cap }, t) };
  });
}

/** The start with other bars, for the grid. */
function startWith(f: Facts, bars: { direct: number; other: number }): P.TriageProbs {
  const p = prior(f);
  if (f.judge === undefined) return p;
  const bar = f.shape === 'direct' || f.mention || f.reply ? bars.direct : bars.other;
  const j = Math.max(0.001, Math.min(0.999, f.judge));
  const z = Math.log(j / (1 - j)) - Math.log(bar / (1 - bar));
  return { ...p, alert: Math.max(0.001, Math.min(0.999, 1 / (1 + Math.exp(-z)))) };
}

/** You were not already there: not writing in the chat, not watching it arrive. */
const away = (o: Outcome) => !o.engaged && !o.seenLive;

interface DayNumbers {
  alerts: number;
  /** One an hour per conversation at most. */
  alertSounds: number;
  alertsBy: Record<string, number>;
  convChats: number;
  convUpdates: number;
  listChats: number;
  listPushes: number;
  below: number;
}

function numbers(ds: readonly Decided[]): DayNumbers {
  const out: DayNumbers = { alerts: 0, alertSounds: 0, alertsBy: {}, convChats: 0, convUpdates: 0, listChats: 0, listPushes: 0, below: 0 };
  const lastSound = new Map<string, number>();
  const lastList = new Map<string, number>();
  const conv = new Set<string>();
  const list = new Set<string>();
  for (const d of ds) {
    const { e } = d;
    if (d.tier === 'push' || d.tier === 'quiet') {
      conv.add(e.conv);
      if (away(e.outcome) && e.outcome.lullFirst) out.convUpdates++;
    }
    if (d.tier === 'push' && away(e.outcome)) {
      out.alerts++;
      out.alertsBy[e.why ?? 'marked'] = (out.alertsBy[e.why ?? 'marked'] ?? 0) + 1;
      if (e.ts - (lastSound.get(e.conv) ?? -Infinity) >= HOUR) {
        out.alertSounds++;
        lastSound.set(e.conv, e.ts);
      }
    }
    if (d.tier === 'digest') {
      list.add(e.conv);
      if (away(e.outcome) && e.ts - (lastList.get(e.conv) ?? -Infinity) >= LIST_EVERY) {
        out.listPushes++;
        lastList.set(e.conv, e.ts);
      }
    }
    if (d.tier === 'drop') out.below++;
  }
  out.convChats = conv.size;
  out.listChats = list.size;
  return out;
}

/** A chat on a day, outside the Conversation tier: its best importance, whether it reached the list, whether you opened it within a day. */
interface ChatDay {
  best: number;
  listed: boolean;
  opened: boolean;
  /** The first open came from a notification or the inbox's list, not from going there yourself. */
  prompted: boolean;
}

function chatDays(ds: readonly Decided[]): ChatDay[] {
  const by = new Map<string, ChatDay>();
  for (const d of ds) {
    if (d.tier === 'push' || d.tier === 'quiet') continue;
    const o = d.e.outcome;
    const c = by.get(d.e.conv) ?? by.set(d.e.conv, { best: 0, listed: false, opened: false, prompted: false }).get(d.e.conv)!;
    c.best = Math.max(c.best, d.probs.important);
    if (d.tier === 'digest') c.listed = true;
    if (away(o) && o.opened !== null && o.opened <= IGNORED_AFTER) {
      c.opened = true;
      if (o.tapped !== null || o.notified) c.prompted = true;
    }
  }
  return [...by.values()];
}

function auc(score: number[], y: boolean[]): number | null {
  const pos = y.filter(Boolean).length;
  const neg = y.length - pos;
  if (!pos || !neg) return null;
  const order = score.map((s, i) => i).sort((a, b) => score[a] - score[b]);
  let rankSum = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && score[order[j + 1]] === score[order[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[order[k]]) rankSum += rank;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

// ------------------------------------------------------------------ the run

async function main() {
  const path = copyLive();
  const w = await load(path);
  const all = w.examples;
  const byDay = new Map<number, ReplayExample[]>();
  for (const e of all) (byDay.get(e.day) ?? byDay.set(e.day, []).get(e.day)!).push(e);
  const allDays = [...byDay.keys()].sort((a, b) => a - b).filter((d) => byDay.get(d)!.length >= minPerDay);
  // The first day only teaches; the last is left out while its outcomes are still coming in.
  const testDays = allDays.slice(1).filter((d) => dayStart(d + 1) + IGNORED_AFTER <= w.dataEnd || d < allDays[allDays.length - 1]);
  const t: P.TriageProbs = { alert: THRESHOLDS.alert, important: LEVEL };
  const report: Record<string, any> = {
    days: { all: allDays.length, tested: testDays.length },
    decisions: all.length,
    level: LEVEL,
    bars: ALERT_BAR,
    judged: w.judged,
    migratedInMs: w.migrated,
    votes: all.filter((e) => e.vote).length,
    policies: {},
  };

  // What the four levels did, for the same days.
  const logged = testDays.map((d) => {
    const day = byDay.get(d)!;
    const sound = new Map<string, number>();
    let sounds = 0;
    for (const e of day)
      if (e.logged === 'push' && away(e.outcome) && e.ts - (sound.get(e.conv) ?? -Infinity) >= HOUR) {
        sounds++;
        sound.set(e.conv, e.ts);
      }
    return {
      important: day.filter((e) => e.logged === 'push' && away(e.outcome)).length,
      sounds,
      notifiedChats: new Set(day.filter((e) => e.logged === 'push' || e.logged === 'quiet').map((e) => e.conv)).size,
    };
  });
  report.before = { importantPerDay: r1(mean(logged.map((l) => l.important))), soundsPerDay: r1(mean(logged.map((l) => l.sounds))), notifiedChatsPerDay: r1(mean(logged.map((l) => l.notifiedChats))) };

  const decidedBy = new Map<string, Map<number, Decided[]>>();
  for (const pol of POLICIES) {
    const per = new Map<number, Decided[]>();
    for (const d of testDays) per.set(d, decideDay(pol.fit(dayStart(d), all), byDay.get(d)!, t));
    decidedBy.set(pol.name, per);
    const ns = testDays.map((d) => numbers(per.get(d)!));
    const cds = testDays.flatMap((d) => chatDays(per.get(d)!));
    const opened = cds.filter((c) => c.opened);
    // Votes cast on or after the day they are tested on were not learned from.
    const held = testDays.flatMap((d) => per.get(d)!.filter((x) => x.e.vote && x.e.vote.at >= dayStart(d)));
    const agree = held.filter((x) => (x.tier !== 'drop') === (labelsOf({ label: x.e.vote!.level }).important === 1)).length;
    const by: Record<string, number> = {};
    for (const n of ns) for (const [k, v] of Object.entries(n.alertsBy)) by[k] = (by[k] ?? 0) + v;
    report.policies[pol.name] = {
      about: pol.about,
      alertsPerDay: r1(mean(ns.map((n) => n.alerts))),
      alertSoundsPerDay: r1(mean(ns.map((n) => n.alertSounds))),
      alertSoundsMost: Math.max(0, ...ns.map((n) => n.alertSounds)),
      alertsBy: by,
      convChatsPerDay: { median: median(ns.map((n) => n.convChats)), most: Math.max(0, ...ns.map((n) => n.convChats)) },
      convUpdatesPerDay: r1(mean(ns.map((n) => n.convUpdates))),
      listChatsPerDay: { median: median(ns.map((n) => n.listChats)), most: Math.max(0, ...ns.map((n) => n.listChats)) },
      listPushesPerDay: r1(mean(ns.map((n) => n.listPushes))),
      belowPerDay: Math.round(mean(ns.map((n) => n.below))),
      opened: { chatDays: opened.length, onList: opened.filter((c) => c.listed).length, unprompted: opened.filter((c) => !c.prompted).length, unpromptedOnList: opened.filter((c) => !c.prompted && c.listed).length },
      listOpened: { listed: cds.filter((c) => c.listed).length, opened: cds.filter((c) => c.listed && c.opened).length },
      auc: r3(auc(cds.map((c) => c.best), cds.map((c) => c.opened))),
      votes: { held: held.length, agree },
      levels: LIST_LEVELS.map((level) => {
        const on = cds.filter((c) => c.best >= level);
        return { level, chatsPerDay: r1(on.length / testDays.length), openedOnList: on.filter((c) => c.opened).length, opened: opened.length };
      }),
    };
  }

  // The bars, with nothing learned: sounds a day (one an hour per conversation), and how many of them are DMs or about you.
  const start = POLICIES[0].fit(0, all);
  report.barGrid = [0.03, 0.05, 0.1].flatMap((direct) =>
    [0.1, 0.2, 0.3].map((other) => {
      const ns = testDays.map((d) => numbers(decideDay(start, byDay.get(d)!, t, { direct, other })));
      const by: Record<string, number> = {};
      for (const n of ns) for (const [k, v] of Object.entries(n.alertsBy)) by[k] = (by[k] ?? 0) + v;
      return { direct, other, soundsPerDay: r1(mean(ns.map((n) => n.alertSounds))), most: Math.max(0, ...ns.map((n) => n.alertSounds)), direct_or_about: (by.dm ?? 0) + (by.about ?? 0), taking_part: (by.wrote ?? 0) + (by.answers ?? 0) };
    }),
  );
  // Why messages are Conversations, over the tested days.
  const whys: Record<string, number> = {};
  for (const d of testDays) for (const e of byDay.get(d)!) if (e.why) whys[e.why] = (whys[e.why] ?? 0) + 1;
  report.conversing = Object.fromEntries(Object.entries(whys).map(([k, v]) => [k, r1(v / Math.max(1, testDays.length))]));
  report.visitDays = w.visitsFrom ? r1((w.dataEnd - w.visitsFrom) / DAY) : 0;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'replay.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'replay.md'), markdown(report));
  console.log(markdown(report));
  w.store.db.close();
}

function markdown(r: Record<string, any>): string {
  const out: string[] = [];
  out.push(`# Triage replay`, '');
  out.push(`${r.decisions} decisions over ${r.days.all} days, ${r.days.tested} of them tested (each policy learns from the days before). ${r.votes} votes from before the tiers. The local model read ${r.judged} Conversation messages. The visit log covers ${r.visitDays} days. List level ${r.level}; bars ${r.bars.direct} (DMs, about you) and ${r.bars.other} (elsewhere).`, '');
  out.push(`Before the tiers, on the same days: ${r.before.importantPerDay} Important messages a day, ${r.before.soundsPerDay} sounds a day (one an hour per conversation), ${r.before.notifiedChatsPerDay} chats a day with a notification.`, '');
  out.push('## The tiers, by policy', '');
  out.push('| Policy | Alert sounds a day (most) | Alerts: DM or about you / taking part | Conversation chats a day (most) | Silent Conversation updates a day | List chats a day (most) | List pushes a day |');
  out.push('|---|---|---|---|---|---|---|');
  for (const [name, p] of Object.entries<any>(r.policies)) {
    const by = p.alertsBy;
    out.push(`| ${name} | ${p.alertSoundsPerDay} (${p.alertSoundsMost}) | ${(by.dm ?? 0) + (by.about ?? 0)} / ${(by.wrote ?? 0) + (by.answers ?? 0)} | ${p.convChatsPerDay.median} (${p.convChatsPerDay.most}) | ${p.convUpdatesPerDay} | ${p.listChatsPerDay.median} (${p.listChatsPerDay.most}) | ${p.listPushesPerDay} |`);
  }
  out.push('', '## The list against what you opened', '', 'A chat on a day, outside the Conversation tier. "Opened": you opened it within a day of one of its messages. "Unprompted": no notification had gone out for it.', '');
  out.push('| Policy | Opened chat-days on the list | Unprompted ones on the list | Listed chat-days you opened | AUC of importance | Held-out votes it agrees with |');
  out.push('|---|---|---|---|---|---|');
  for (const [name, p] of Object.entries<any>(r.policies))
    out.push(`| ${name} | ${p.opened.onList} of ${p.opened.chatDays} | ${p.opened.unpromptedOnList} of ${p.opened.unprompted} | ${p.listOpened.opened} of ${p.listOpened.listed} | ${p.auc ?? 'n/a'} | ${p.votes.agree} of ${p.votes.held} |`);
  out.push('', '## The list at each level', '');
  out.push(`| Level | ${Object.keys(r.policies).map((n) => `${n}: chats a day (opened on it)`).join(' | ')} |`);
  out.push(`|---|${Object.keys(r.policies).map(() => '---').join('|')}|`);
  for (let i = 0; i < LIST_LEVELS.length; i++)
    out.push(`| ${LIST_LEVELS[i]} | ${Object.values<any>(r.policies).map((p) => `${p.levels[i].chatsPerDay} (${p.levels[i].openedOnList} of ${p.levels[i].opened})`).join(' | ')} |`);
  out.push('', '## The alert bars, nothing learned', '', '| Bar: DMs and about you | Bar: elsewhere | Sounds a day (most) | Alerts in DMs or about you | Alerts where you take part |', '|---|---|---|---|---|');
  for (const g of r.barGrid) out.push(`| ${g.direct} | ${g.other} | ${g.soundsPerDay} (${g.most}) | ${g.direct_or_about} | ${g.taking_part} |`);
  out.push('', '## Why messages are Conversations (a day)', '', Object.entries<number>(r.conversing).map(([k, v]) => `${k}: ${v}`).join(', '), '');
  out.push('## Policies', '');
  for (const [name, p] of Object.entries<any>(r.policies)) out.push(`- **${name}**: ${p.about}`);
  return out.join('\n') + '\n';
}

if (import.meta.main) await main();
