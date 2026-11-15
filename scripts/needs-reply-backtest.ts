/**
 * The needs-reply backtest (docs/inbox.md, "Needs a reply"): which signals tell whether you will answer a turn addressed
 * to you. Folds every conversation with the hub's own fold, and for each turn still open at an age (15 min .. 2 d)
 * asks each candidate for the chance it is answered in time, then scores them forward in time: every model is fitted
 * only on turns whose outcome was known before the period it is tested on.
 *
 *   bun scripts/needs-reply-backtest.ts --db <copy of hub.sqlite> [--jev] [--json out.json]
 *
 * Candidates:
 *   table      the owed table (owed.ts), fitted before the period: what the hub used before needsreply.ts
 *   platt      the table's chance, recalibrated (a logistic fit on it and the age)
 *   rates      the table, plus how you answer this person and this conversation once a turn is this old
 *              (needsreply.ts `lateRate`, from the same tallies the hub keeps) and Beta-smoothed counts
 *              shape → person → conversation (not decayed)
 *   message    all of the above, plus the turn's messages (needsreply.ts) and the hour and weekday
 *   hub        the model the hub runs (needsreply.ts `needsFeatures`), recent turns counting more, without and with
 *              its calibration step
 * and, where they reach: stays left without answering, from the visit log (hub era), and jev's answer to a yes/no
 * question on the newest message (--jev; the local model on this machine, never a hosted one).
 *
 * Target: answered within 3 days of the turn's first message for you; also within 1 day. Turns a reaction answered
 * carry no time, so, as for the owed table, they count toward the rates and are not examples.
 * Prints counts, rates and scores only: never message text, names or ids. jev reads text locally and its answers stay
 * in jev's own cache.
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { foldMessage, freshState, emptyTally, type ConvState, type FoldMessage, type Tally } from '../packages/hub/src/attention.ts';
import { fitOwedTable, owedChance, owedShape, turnRate, type OwedShape, type OwedTable, type OwedTurn } from '../packages/hub/src/owed.ts';
import { record, tallyAt } from '../packages/hub/src/tally.ts';
import { SELF_SQL } from '../packages/hub/src/rankhistory.ts';
import { foldMark } from '../packages/hub/src/replymarks.ts';
import { CALIBRATE_FOR, FACTS_SQL, factsOf, fitLogistic, predict, needsFeatures, NEEDS_FEATURES, NEEDS_HALF_LIFE, platt, applyPlatt, type MessageFacts, type TurnFacts } from '../packages/hub/src/needsreply.ts';
import { auc, logLoss, brier, reliability } from '../packages/hub/src/calibration.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 3 * DAY;

const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const path = resolve(opt('db', '')!);
const HUB_ERA = Date.parse(`${opt('hub-era', '2026-10-29')}T00:00:00Z`);
const NOW = Date.now();
const useJev = argv.includes('--jev');
const JEV = opt('jev-url', 'http://127.0.0.1:7862')!;
// Message text goes to the model on this machine only.
if (useJev && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(JEV).hostname)) throw new Error(`refusing to send message text to ${JEV}: not this machine`);

/** Ages a turn is trained at; EVAL_AGES are those reported. */
const TRAIN_AGES = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 1.5 * DAY, 2 * DAY];
const EVAL_AGES = [15 * MIN, HOUR, 6 * HOUR, DAY];
const EVAL_AGES_1D = [15 * MIN, HOUR, 6 * HOUR, 12 * HOUR];

const PERIODS: { name: string; from: number; to: number }[] = [
  { name: '2022', from: Date.UTC(2022, 0, 1), to: Date.UTC(2023, 0, 1) },
  { name: '2023', from: Date.UTC(2023, 0, 1), to: Date.UTC(2024, 0, 1) },
  { name: '2024', from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) },
  { name: '2025', from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) },
  { name: '2026 before the hub', from: Date.UTC(2026, 0, 1), to: HUB_ERA },
  { name: 'hub era', from: HUB_ERA, to: NOW - WINDOW },
];

// ------------------------------------------------------------------ the turns, with their messages' features

interface Msg extends MessageFacts {
  id: string;
  ts: number;
}
interface Turn extends OwedTurn {
  kind: string | null;
  members: number;
  msgs: Msg[];
}

function collect(db: Database): Turn[] {
  const self = new Set((db.query(`SELECT * FROM ${SELF_SQL}`).all() as Row[]).map((r) => Object.values(r)[0] as string));
  const selfPerson = (db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null)?.id ?? null;
  const mine = (id: string | null, person?: string | null) => (!!id && self.has(id)) || (!!person && person === selfPerson);
  const convs = db.query(`SELECT c.id, c.shape, (SELECT COUNT(*) FROM participant p WHERE p.conversation_id = c.id) AS members FROM conversation c WHERE c.shape IN ('direct', 'group', 'channel', 'thread')`).all() as Row[];
  const q = db.query(`
    SELECT m.id, m.ts, m.author_id, m.mentions_self, m.mentions_all, m.kind, m.deleted, i.is_bot, i.person_id, r.author_id AS reply_author, ${FACTS_SQL},
           EXISTS (SELECT 1 FROM reaction x JOIN identity xi ON xi.id = x.identity_id LEFT JOIN person xp ON xp.id = xi.person_id
                   WHERE x.message_id = m.id AND (xp.is_self = 1 OR xi.id IN (SELECT self_identity FROM account))) AS reacted,
           t.decision IN ('push', 'quiet', 'digest') AS pushed, t.reasons LIKE '%asks a question%' AS question,
           (SELECT rm.mark || ':' || rm.at FROM reply_mark rm WHERE rm.message_id = m.id AND rm.undone_at IS NULL) AS reply_mark
    FROM message m LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id LEFT JOIN triage t ON t.message_id = m.id
    WHERE m.conversation_id = ? ORDER BY m.ts, m.rowid`);
  const out: Turn[] = [];
  for (const c of convs) {
    const place = { shape: c.shape, members: c.members };
    const s: ConvState = freshState();
    const tallies = new Map<string, Tally>();
    const tallyOf = (k: string) => tallies.get(k) ?? tallies.set(k, emptyTally()).get(k)!;
    // Messages from others since your last one, from the open turn's first for you.
    let buf: Msg[] = [];
    const turnOf = (t: { addressed: number; kind: string | null; authorKey: string | null; answeredAt: number | null; timed: boolean; dismissed?: boolean }): Turn => ({
      conversationId: c.id,
      shape: c.shape,
      members: c.members,
      authorKey: t.authorKey,
      addressed: t.addressed,
      answeredAt: t.answeredAt,
      timed: t.timed,
      kind: t.kind,
      ...(t.dismissed ? { dismissed: true } : {}),
      msgs: buf.filter((x) => x.ts >= t.addressed && x.ts <= t.addressed + 2 * DAY),
    });
    for (const r of q.all(c.id) as Row[]) {
      const m: FoldMessage = {
        id: r.id,
        ts: r.ts,
        author: r.author_id,
        authorKey: r.person_id ?? r.author_id,
        mine: mine(r.author_id, r.person_id),
        bot: !!r.is_bot,
        mentionsMe: !!r.mentions_self && !r.mentions_all,
        repliesToMe: mine(r.reply_author),
        question: !!r.question,
        pushed: !!r.pushed,
        ignore: !!r.deleted || r.kind === 'system',
        reactedByMe: !!r.reacted,
        ...foldMark(r.reply_mark),
      };
      foldMessage(s, tallyOf, m, place, (t) => out.push(turnOf(t)));
      // As the hub reads them (needsreply.ts turnMessagesQuery): up to 60, from the turn's first message for you.
      const turn = s.turn?.addressed ?? null;
      if (m.mine || turn === null) buf = [];
      else if (!m.ignore) {
        if (buf.length && buf[0].ts < turn) buf = buf.filter((x) => x.ts >= turn);
        if (buf.length < 60 && r.ts <= turn + 2 * DAY) buf.push({ id: r.id, ts: r.ts, ...factsOf(r as any, m.mentionsMe || m.repliesToMe, m.authorKey) });
      }
    }
    if (s.turn?.addressed != null) out.push(turnOf({ addressed: s.turn.addressed, kind: s.turn.kind, authorKey: s.turn.authorKey, answeredAt: null, timed: true }));
  }
  return out;
}

// ------------------------------------------------------------------ examples: a turn still open at an age

interface Example {
  turn: Turn;
  age: number;
  at: number;
  y3: boolean;
  y1: boolean;
  /** Feature vectors by candidate. */
  x: Record<string, number[]>;
  table?: number;
  jev?: number;
  visits?: { left: number; active: number } | null;
}

const answeredWithin = (t: OwedTurn, w: number) => t.answeredAt !== null && t.answeredAt - t.addressed <= w;
const openAt = (t: OwedTurn, age: number) => t.answeredAt === null || t.answeredAt - t.addressed > age;

/** Beta-smoothed answer counts once a turn is this old, shape → person → conversation; not decayed. */
class Counts {
  private m = new Map<string, { n: number[]; y: number[] }>();
  add(key: string, t: OwedTurn) {
    const c = this.m.get(key) ?? this.m.set(key, { n: TRAIN_AGES.map(() => 0), y: TRAIN_AGES.map(() => 0) }).get(key)!;
    const y = answeredWithin(t, WINDOW);
    TRAIN_AGES.forEach((a, i) => {
      if (openAt(t, a)) {
        c.n[i]++;
        if (y) c.y[i]++;
      }
    });
  }
  rate(key: string, i: number, prior: number, k: number): [number, number] {
    const c = this.m.get(key);
    return [((c?.y[i] ?? 0) + k * prior) / ((c?.n[i] ?? 0) + k), c?.n[i] ?? 0];
  }
}

const logit = (p: number) => Math.log(Math.min(0.995, Math.max(0.005, p)) / (1 - Math.min(0.995, Math.max(0.005, p))));

/**
 * Every (turn, age) with the turn still open, its features as of then: tallies built from the turns that were over by
 * that time, as the hub's are. `tables`: the owed table for each period, fitted before it.
 */
function examples(turns: Turn[], tableFor: (at: number) => OwedTable): Example[] {
  const usable = turns.filter((t) => t.timed && !t.dismissed);
  const events: { t: Turn; age: number; at: number; i: number }[] = [];
  for (const t of usable) TRAIN_AGES.forEach((age, i) => openAt(t, age) && t.addressed + age < NOW && events.push({ t, age, at: t.addressed + age, i }));
  events.sort((a, b) => a.at - b.at);
  // Turns in the order they were over (answered, or the window ran out), to add to the tallies before each event.
  const over = turns.filter((t) => !t.dismissed).map((t) => ({ t, at: t.answeredAt !== null && t.answeredAt - t.addressed <= WINDOW ? t.answeredAt : t.addressed + WINDOW })).sort((a, b) => a.at - b.at);
  const conv = new Map<string, Tally>();
  const person = new Map<string, Tally>();
  const get = (m: Map<string, Tally>, k: string) => m.get(k) ?? m.set(k, emptyTally()).get(k)!;
  const shapeC = new Counts();
  const personC = new Counts();
  const convC = new Counts();
  const out: Example[] = [];
  let j = 0;
  for (const e of events) {
    for (; j < over.length && over[j].at <= e.at; j++) {
      const d = over[j].t;
      const latency = d.answeredAt === null ? null : d.answeredAt - d.addressed;
      record(get(conv, d.conversationId), over[j].at, latency, d.timed);
      if (d.authorKey) record(get(person, d.authorKey), over[j].at, latency, d.timed);
      if (d.timed) {
        shapeC.add(owedShape(d.shape), d);
        if (d.authorKey) personC.add(d.authorKey, d);
        convC.add(d.conversationId, d);
      }
    }
    const t = e.t;
    const c = conv.get(t.conversationId);
    const p = t.authorKey ? person.get(t.authorKey) : undefined;
    const ct = c ? tallyAt(c, e.at) : null;
    const pt = p ? tallyAt(p, e.at) : null;
    const table = tableFor(e.at);
    const rate = turnRate(ct, pt);
    const chance = owedChance(table, t.shape, rate, e.age);
    const facts: TurnFacts = {
      shape: t.shape,
      kind: t.kind,
      age: e.age,
      tableChance: chance,
      conv: ct,
      person: pt,
      messages: t.msgs.filter((m) => m.ts <= e.at),
      authorKey: t.authorKey,
    };
    const hub = needsFeatures(facts);
    const [sr] = shapeC.rate(owedShape(t.shape), e.i, chance, 1);
    const [pr, pn] = t.authorKey ? personC.rate(t.authorKey, e.i, sr, 5) : [sr, 0];
    const [cr, cn] = convC.rate(t.conversationId, e.i, pr, 5);
    const beta = [logit(pr), logit(cr), Math.log1p(pn), Math.log1p(cn)];
    // The first NEEDS_FEATURES rate features of the hub's model, then its message features.
    const rateCount = NEEDS_FEATURES.indexOf('msg:question');
    out.push({
      turn: t,
      age: e.age,
      at: e.at,
      y3: answeredWithin(t, WINDOW),
      y1: answeredWithin(t, DAY),
      table: chance,
      x: {
        platt: [logit(chance), Math.log1p(e.age / HOUR)],
        rates: [...hub.slice(0, rateCount), ...beta],
        message: [...hub, ...beta, ...extraMessage(facts)],
        hub,
      },
    });
  }
  return out;
}

/** Message features the hub's model leaves out (hour of day, weekend), tried here. */
function extraMessage(f: TurnFacts): number[] {
  const last = f.messages[f.messages.length - 1] as Msg | undefined;
  const d = last ? new Date(last.ts) : null;
  const h = d ? d.getHours() + d.getMinutes() / 60 : 12;
  return [Math.sin((2 * Math.PI * h) / 24), Math.cos((2 * Math.PI * h) / 24), d && (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0];
}

// ------------------------------------------------------------------ jev, on the newest message at 1 h

const JEV_QUESTION = 'Is this message a question or request the reader is expected to answer, meaning the sender is waiting for a reply?';

async function askJev(db: Database, exs: Example[]) {
  const want = exs.filter((e) => e.age === HOUR && e.turn.msgs.some((m) => m.ts <= e.at));
  const ids = want.map((e) => e.turn.msgs.filter((m) => m.ts <= e.at).at(-1)!.id);
  const body = db.query('SELECT body FROM message WHERE id = ?');
  console.log(`jev: ${ids.length} messages`);
  for (let i = 0; i < ids.length; i += 200) {
    const texts = ids.slice(i, i + 200).map((id) => ((body.get(id) as Row | null)?.body ?? '').slice(0, 1000) || '(no text)');
    const res = await fetch(`${JEV}/v1/judge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: JEV_QUESTION, texts }) });
    const p = ((await res.json()) as { p: (number | null)[] }).p;
    p.forEach((x, k) => (want[i + k].jev = x ?? 0));
    if (i % 2000 === 0) process.stdout.write(`  ${i}/${ids.length}\n`);
  }
}

// ------------------------------------------------------------------ visits: opened and left

function addVisits(db: Database, exs: Example[]) {
  const first = (db.query('SELECT MIN(start_at) AS at FROM visit').get() as Row).at as number | null;
  if (!first) return 0;
  const q = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(active), 0) AS active FROM visit WHERE conversation_id = ? AND start_at >= ? AND end_at <= ? AND sent = 0 AND reactions = 0`);
  let n = 0;
  for (const e of exs) {
    if (e.turn.addressed < first) continue;
    const r = q.get(e.turn.conversationId, e.turn.addressed, e.at) as Row;
    e.visits = { left: r.n, active: r.active };
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ scoring

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

type Pred = { p: number; y: boolean };
type Model = { name: string; pred: (e: Example) => number };

function fitFor(train: Example[], key: string, y: (e: Example) => boolean, calibrateFrom?: number, halfLife?: number): (e: Example) => number {
  const end = Math.max(...train.map((e) => e.turn.addressed));
  const w = fitLogistic(
    train.map((e) => e.x[key]),
    train.map(y),
    { l2: 1, ...(halfLife ? { weights: train.map((e) => 2 ** (-(end - e.turn.addressed) / halfLife)) } : {}) },
  );
  if (calibrateFrom === undefined) return (e) => predict(w, e.x[key]);
  // Platt on the most recent turns that are over: the hub's calibration step.
  const recent = train.filter((e) => e.turn.addressed >= calibrateFrom);
  const c = platt(recent.map((e) => predict(w, e.x[key])), recent.map(y));
  return (e) => applyPlatt(c, predict(w, e.x[key]));
}

interface Result {
  period: string;
  shape: OwedShape;
  target: string;
  age: number | 'all';
  n: number;
  rate: number;
  models: Record<string, { auc: number; logLoss: number; brier: number }>;
}

const results: Result[] = [];
const pooled = new Map<string, Pred[]>();

function score(period: string, shape: OwedShape, target: string, ages: number[], test: Example[], models: Model[], y: (e: Example) => boolean) {
  for (const age of [...ages, 'all' as const]) {
    const xs = test.filter((e) => (age === 'all' ? ages.includes(e.age) : e.age === age));
    if (!xs.length) continue;
    const r: Result = { period, shape, target, age, n: xs.length, rate: xs.filter(y).length / xs.length, models: {} };
    for (const m of models) {
      const ps = xs.map((e) => ({ p: m.pred(e), y: y(e) }));
      r.models[m.name] = { auc: auc(ps), logLoss: logLoss(ps), brier: brier(ps) };
      if (age === 'all') {
        const k = `${target}|${shape}|${m.name}|${period === 'hub era' ? 'hub era' : 'before the hub'}`;
        pooled.set(k, [...(pooled.get(k) ?? []), ...ps]);
      }
    }
    results.push(r);
  }
}

// ------------------------------------------------------------------ run

const db = new Database(path, { readonly: true });
let t0 = performance.now();
const turns = collect(db);
console.log(`folded: ${turns.length} turns in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const tables = new Map<number, OwedTable>();
for (const p of PERIODS) tables.set(p.from, fitOwedTable(turns, { now: p.from, until: p.from }));
const tableFor = (at: number) => {
  let best = PERIODS[0].from;
  for (const p of PERIODS) if (p.from <= at) best = p.from;
  return tables.get(best)!;
};
t0 = performance.now();
const exs = examples(turns, tableFor);
console.log(`examples: ${exs.length} (turn, age) pairs in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const visited = addVisits(db, exs);
console.log(`visit log covers ${visited} of them`);
if (useJev) await askJev(db, exs.filter((e) => e.turn.addressed >= Date.UTC(2024, 0, 1)));

for (const shape of ['direct', 'group'] as OwedShape[]) {
  const mine = exs.filter((e) => owedShape(e.turn.shape) === shape);
  for (const p of PERIODS) {
    // Fitted on turns whose 3 days were over before the period began, as the hub would have had them.
    const train = mine.filter((e) => e.turn.addressed + WINDOW <= p.from);
    const test = mine.filter((e) => e.turn.addressed >= p.from && e.turn.addressed < p.to);
    if (train.length < 200 || !test.length) continue;
    for (const [target, y, ages] of [
      ['3 d', (e: Example) => e.y3, EVAL_AGES],
      ['1 d', (e: Example) => e.y1, EVAL_AGES_1D],
    ] as const) {
      const tr = target === '1 d' ? train.filter((e) => e.age < DAY) : train;
      const models: Model[] = [];
      if (target === '3 d') models.push({ name: 'table', pred: (e) => e.table! });
      models.push({ name: 'platt', pred: fitFor(tr, 'platt', y) });
      models.push({ name: 'rates', pred: fitFor(tr, 'rates', y) });
      models.push({ name: 'message', pred: fitFor(tr, 'message', y) });
      models.push({ name: 'hub, no calibration', pred: fitFor(tr, 'hub', y, undefined, NEEDS_HALF_LIFE) });
      // As the hub fits it (needsreply.ts fitShapeSteps): recent turns count more, then the calibration step.
      models.push({ name: 'hub', pred: fitFor(tr, 'hub', y, p.from - CALIBRATE_FOR, NEEDS_HALF_LIFE) });
      score(p.name, shape, target, ages as unknown as number[], test, models, y);
    }
  }
}

// ------------------------------------------------------------------ print

const MODELS = ['table', 'platt', 'rates', 'message', 'hub, no calibration', 'hub'];
const ageName = (a: number | 'all') => (a === 'all' ? 'all ages' : a < HOUR ? `${a / MIN} min` : a < DAY ? `${a / HOUR} h` : `${a / DAY} d`);
for (const target of ['3 d', '1 d']) {
  for (const shape of ['direct', 'group'] as OwedShape[]) {
    console.log(`\n### Answered within ${target}, ${shape === 'direct' ? 'DMs' : 'groups and channels'}: AUC / log loss by period (all ages pooled)\n`);
    console.log(`| period | n | answered | ${MODELS.filter((m) => target === '3 d' || m !== 'table').join(' | ')} |`);
    console.log(`|---|---|---|${MODELS.filter((m) => target === '3 d' || m !== 'table').map(() => '---').join('|')}|`);
    for (const r of results.filter((r) => r.target === target && r.shape === shape && r.age === 'all')) {
      console.log(`| ${r.period} | ${r.n} | ${pct(r.rate)} | ${MODELS.filter((m) => r.models[m]).map((m) => `${f3(r.models[m].auc)} / ${f3(r.models[m].logLoss)}`).join(' | ')} |`);
    }
  }
}
console.log(`\n### By age, 2025 to the hub era and the hub era, answered within 3 d: AUC / log loss\n`);
console.log(`| shape | period | age | n | answered | ${MODELS.join(' | ')} |`);
console.log(`|---|---|---|---|---|${MODELS.map(() => '---').join('|')}|`);
for (const r of results.filter((r) => r.target === '3 d' && r.age !== 'all' && ['2025', '2026 before the hub', 'hub era'].includes(r.period))) {
  console.log(`| ${r.shape} | ${r.period} | ${ageName(r.age)} | ${r.n} | ${pct(r.rate)} | ${MODELS.map((m) => (r.models[m] ? `${f3(r.models[m].auc)} / ${f3(r.models[m].logLoss)}` : '')).join(' | ')} |`);
}

// Pooled over every period: Brier and calibration tables.
for (const [k, ps] of pooled) {
  const [target, shape, model, era] = k.split('|');
  if (target !== '3 d' || !['table', 'hub'].includes(model)) continue;
  const rel = reliability(ps, 10);
  console.log(`\n#### Calibration, answered within 3 d, ${shape === 'direct' ? 'DMs' : 'groups'}, ${model}, ${era}: n ${ps.length}, Brier ${f3(brier(ps))}, AUC ${f3(auc(ps))}`);
  console.log(`| predicted | n | mean predicted | answered |\n|---|---|---|---|`);
  for (const b of rel) if (b.n) console.log(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${pct(b.predicted)} | ${pct(b.actual)} |`);
}

// ------------------------------------------------------------------ the visit log, and jev, where they reach

{
  const v = exs.filter((e) => e.visits && e.turn.addressed + WINDOW <= NOW);
  if (v.length) {
    console.log(`\n### Opened and left (visit log, ${v.length} turn-ages)\n\n| shape | stays left without answering | n | answered within 3 d |\n|---|---|---|---|`);
    for (const shape of ['direct', 'group'] as OwedShape[])
      for (const [lo, hi, name] of [[0, 0, 'none'], [1, 1, 'one'], [2, 99, 'two or more']] as const) {
        const xs = v.filter((e) => owedShape(e.turn.shape) === shape && e.visits!.left >= lo && e.visits!.left <= hi);
        if (xs.length) console.log(`| ${shape} | ${name} | ${xs.length} | ${pct(xs.filter((e) => e.y3).length / xs.length)} |`);
      }
    // Does it add to the hub's model? Leave-one-day-out within the covered stretch.
    for (const shape of ['direct', 'group'] as OwedShape[]) {
      const xs = v.filter((e) => owedShape(e.turn.shape) === shape);
      const prior = exs.filter((e) => owedShape(e.turn.shape) === shape && e.turn.addressed + WINDOW <= Math.min(...xs.map((x) => x.turn.addressed)));
      if (xs.length < 30 || prior.length < 200) continue;
      const base = fitFor(prior, 'hub', (e) => e.y3);
      const days = [...new Set(xs.map((e) => Math.floor(e.turn.addressed / DAY)))];
      const a: Pred[] = [];
      const b: Pred[] = [];
      for (const d of days) {
        const tr = xs.filter((e) => Math.floor(e.turn.addressed / DAY) !== d);
        const te = xs.filter((e) => Math.floor(e.turn.addressed / DAY) === d);
        const w = fitLogistic(tr.map((e) => [logit(base(e)), Math.log1p(e.visits!.left), Math.log1p(e.visits!.active / 60)]), tr.map((e) => e.y3), { l2: 1 });
        for (const e of te) {
          a.push({ p: base(e), y: e.y3 });
          b.push({ p: predict(w, [logit(base(e)), Math.log1p(e.visits!.left), Math.log1p(e.visits!.active / 60)]), y: e.y3 });
        }
      }
      console.log(`  ${shape}: hub model AUC ${f3(auc(a))}, log loss ${f3(logLoss(a))}; with stays left (leave one day out) AUC ${f3(auc(b))}, log loss ${f3(logLoss(b))} (n ${a.length}, ${a.filter((x) => !x.y).length} not answered)`);
    }
  }
}
if (useJev) {
  console.log(`\n### jev on the newest message, at 1 h: fitted on 2024, tested on 2025 on\n`);
  for (const shape of ['direct', 'group'] as OwedShape[]) {
    const xs = exs.filter((e) => e.jev !== undefined && owedShape(e.turn.shape) === shape);
    const tr = xs.filter((e) => e.turn.addressed + WINDOW <= Date.UTC(2025, 0, 1));
    const te = xs.filter((e) => e.turn.addressed >= Date.UTC(2025, 0, 1) && e.turn.addressed + WINDOW <= NOW);
    if (tr.length < 100 || !te.length) continue;
    const prior = exs.filter((e) => owedShape(e.turn.shape) === shape && e.turn.addressed + WINDOW <= Date.UTC(2024, 0, 1));
    const base = fitFor(prior, 'hub', (e) => e.y3);
    const feats = (e: Example, j: boolean) => (j ? [logit(base(e)), logit(e.jev!)] : [logit(base(e))]);
    const w0 = fitLogistic(tr.map((e) => feats(e, false)), tr.map((e) => e.y3), { l2: 1 });
    const w1 = fitLogistic(tr.map((e) => feats(e, true)), tr.map((e) => e.y3), { l2: 1 });
    const alone = te.map((e) => ({ p: e.jev!, y: e.y3 }));
    const a = te.map((e) => ({ p: predict(w0, feats(e, false)), y: e.y3 }));
    const b = te.map((e) => ({ p: predict(w1, feats(e, true)), y: e.y3 }));
    console.log(`  ${shape} (train ${tr.length}, test ${te.length}, ${te.filter((e) => !e.y3).length} not answered): jev alone AUC ${f3(auc(alone))}; hub model AUC ${f3(auc(a))}, log loss ${f3(logLoss(a))}; with jev AUC ${f3(auc(b))}, log loss ${f3(logLoss(b))}`);
  }
}

const json = opt('json');
if (json) await Bun.write(json, JSON.stringify({ results, calibration: [...pooled].map(([k, ps]) => ({ key: k, brier: brier(ps), auc: auc(ps), bins: reliability(ps, 10) })) }, null, 1));
