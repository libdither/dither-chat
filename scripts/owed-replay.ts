/**
 * The owed replay (docs/inbox.md, "What you owe"): folds every conversation with the hub's own fold, collects each
 * turn addressed to you and what came of it, fits the owed table (packages/hub/src/owed.ts) on the turns before
 * --split, and measures it against the formula it replaced (`60 × rate × owedCurve(age)`) on the turns after: in
 * 2025-26 before the hub, and in the hub era. Numbers only.
 *
 *   bun scripts/owed-replay.ts --db ~/.local/share/dither-chat/hub.sqlite [--split 2025-01-01] [--hub-era 2026-10-29] [--table]
 *
 * It opens the database read-only and prints counts, hours, rates and scores: never message text, names or ids.
 * `--table` also prints the table fitted on the turns before --split, as owed.ts's DEFAULT_OWED_TABLE takes it.
 *
 * Measures, per shape (DMs, everything else), on turns with a known answer time (a reaction has none):
 *  - hours above the line: how long each turn's owed points stay at or over the "needs you" line (20) on its own,
 *    up to your answer, for turns you answered in time and for turns you never did. "Wasted" is the share on the latter.
 *  - log loss and AUC at 1 h, 6 h and 1 d: among turns still open then, the weight (as a chance) against "answered in time".
 *  - late answers: turns answered after 3 h, and how many were still above the line at 3 h and at 12 h.
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { foldMessage, freshState, emptyTally, owedCurve, WEIGHTS, type ConvState, type FoldMessage, type Tally } from '../packages/hub/src/attention.ts';
import { answeredInTime, fitOwedTable, openFor, OWED_AGES, owedChance, owedShape, RATE_EDGES, rateTurns, settled, type OwedShape, type OwedTable, type OwedTurn, type RatedTurn } from '../packages/hub/src/owed.ts';
import { SELF_SQL } from '../packages/hub/src/rankhistory.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const path = resolve(opt('db', `${process.env.HOME}/.local/share/dither-chat/hub.sqlite`)!);
const SPLIT = Date.parse(`${opt('split', '2025-01-01')}T00:00:00Z`);
const HUB_ERA = Date.parse(`${opt('hub-era', '2026-10-29')}T00:00:00Z`);
const NOW = Date.now();

// ------------------------------------------------------------------ the turns, from the hub's own fold

function collect(db: Database): OwedTurn[] {
  const self = new Set((db.query(`SELECT * FROM ${SELF_SQL}`).all() as Row[]).map((r) => Object.values(r)[0] as string));
  const selfPerson = (db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null)?.id ?? null;
  const mine = (id: string | null, person?: string | null) => (!!id && self.has(id)) || (!!person && person === selfPerson);
  const convs = db.query(`SELECT c.id, c.shape, (SELECT COUNT(*) FROM participant p WHERE p.conversation_id = c.id) AS members FROM conversation c WHERE c.shape IN ('direct', 'group', 'channel', 'thread')`).all() as Row[];
  // attention.ts FOLD_SQL, from the start.
  const q = db.query(`
    SELECT m.id, m.ts, m.author_id, m.mentions_self, m.mentions_all, m.kind, m.deleted, i.is_bot, i.person_id, r.author_id AS reply_author,
           EXISTS (SELECT 1 FROM reaction x JOIN identity xi ON xi.id = x.identity_id LEFT JOIN person xp ON xp.id = xi.person_id
                   WHERE x.message_id = m.id AND (xp.is_self = 1 OR xi.id IN (SELECT self_identity FROM account))) AS reacted,
           t.decision IN ('push', 'quiet', 'digest') AS pushed, t.reasons LIKE '%asks a question%' AS question
    FROM message m LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id LEFT JOIN triage t ON t.message_id = m.id
    WHERE m.conversation_id = ? ORDER BY m.ts, m.rowid`);
  const out: OwedTurn[] = [];
  for (const c of convs) {
    const place = { shape: c.shape, members: c.members };
    const s: ConvState = freshState();
    const tallies = new Map<string, Tally>();
    const tallyOf = (k: string) => tallies.get(k) ?? tallies.set(k, emptyTally()).get(k)!;
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
      };
      foldMessage(s, tallyOf, m, place, (t) => out.push({ conversationId: c.id, shape: c.shape, authorKey: t.authorKey, addressed: t.addressed, answeredAt: t.answeredAt, timed: t.timed }));
    }
    if (s.turn?.addressed != null) out.push({ conversationId: c.id, shape: c.shape, authorKey: s.turn.authorKey, addressed: s.turn.addressed, answeredAt: null, timed: true });
  }
  return out;
}

// ------------------------------------------------------------------ the two weightings

type Weigh = { name: string; chance: (t: RatedTurn, age: number) => number };
const before: Weigh = { name: 'before: rate × owedCurve', chance: (t, age) => t.rate * owedCurve(age) };
const tableOf = (table: OwedTable): Weigh => ({ name: 'owed table', chance: (t, age) => owedChance(table, t.shape, t.rate, age) });

/** How long the weight stays at or over the line (it never rises with age in either weighting): searched in 5-minute steps. */
function lineTime(w: Weigh, t: RatedTurn): number {
  const line = WEIGHTS.needs / WEIGHTS.owed;
  if (w.chance(t, 0) < line) return 0;
  let a = 0;
  while (a < 30 * DAY && w.chance(t, a + 5 * MIN) >= line) a += 5 * MIN;
  return a + 5 * MIN;
}

const auc = (xs: { s: number; y: boolean }[]) => {
  const sorted = [...xs].sort((a, b) => a.s - b.s);
  let rank = 0;
  let sumPos = 0;
  let pos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].s === sorted[i].s) j++;
    const mid = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (sorted[k].y) (sumPos += mid), pos++;
    rank = j;
    i = j;
  }
  const neg = rank - pos;
  return pos && neg ? (sumPos - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
};
const logLoss = (xs: { s: number; y: boolean }[]) => {
  const c = (p: number) => Math.min(0.99, Math.max(0.01, p));
  return xs.reduce((a, x) => a - Math.log(x.y ? c(x.s) : 1 - c(x.s)), 0) / Math.max(1, xs.length);
};
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

function measure(label: string, ts: RatedTurn[], ws: Weigh[]) {
  const answered = ts.filter(answeredInTime).length;
  console.log(`\n== ${label}: ${ts.length} turns, ${ts.length - answered} not answered in time`);
  if (!ts.length) return;
  const hours = new Map<string, { yes: number; no: number }>();
  for (const w of ws) {
    const line = new Map<string, number>();
    let yes = 0;
    let no = 0;
    for (const t of ts) {
      const key = `${owedShape(t.shape)}:${t.rate.toFixed(4)}`;
      const T = line.get(key) ?? line.set(key, lineTime(w, t)).get(key)!;
      const h = Math.min(T, openFor(t)) / HOUR;
      if (answeredInTime(t)) yes += h;
      else no += h;
    }
    hours.set(w.name, { yes, no });
    console.log(`  ${w.name.padEnd(26)} hours above the line: answered ${yes.toFixed(0)}, never answered ${no.toFixed(0)} (${pct(no / (yes + no || 1))} wasted)`);
  }
  const [a, b] = ws.map((w) => hours.get(w.name)!);
  if (a && b) console.log(`  kept on answered turns: ${pct(b.yes / (a.yes || 1))} of the hours before; wasted hours ${pct(b.no / (a.no || 1))} of before`);
  for (const age of [HOUR, 6 * HOUR, DAY]) {
    const open = ts.filter((t) => openFor(t) > age);
    const line = ws.map((w) => {
      const xs = open.map((t) => ({ s: w.chance(t, age), y: answeredInTime(t) }));
      return `${w.name}: log loss ${f(logLoss(xs))}, AUC ${f(auc(xs))}`;
    });
    console.log(`  open at ${age / HOUR} h (${open.length}, ${pct(open.filter(answeredInTime).length / (open.length || 1))} answered): ${line.join(' | ')}`);
  }
  const late = ts.filter((t) => answeredInTime(t) && openFor(t) > 3 * HOUR);
  const above = (w: Weigh, t: RatedTurn, age: number) => w.chance(t, age) * WEIGHTS.owed >= WEIGHTS.needs;
  console.log(`  answered after 3 h: ${late.length}; above the line at 3 h / 12 h: ${ws.map((w) => `${w.name} ${pct(late.filter((t) => above(w, t, 3 * HOUR)).length / (late.length || 1))} / ${pct(late.filter((t) => openFor(t) > 12 * HOUR).filter((t) => above(w, t, 12 * HOUR)).length / (late.filter((t) => openFor(t) > 12 * HOUR).length || 1))}`).join(' | ')}`);
}

// ------------------------------------------------------------------ run

const db = new Database(path, { readonly: true });
const t0 = performance.now();
const turns = collect(db);
console.log(`folded: ${turns.length} turns in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const t1 = performance.now();
const edges = opt('edges')?.split(',').map(Number) ?? [...RATE_EDGES];
const table = fitOwedTable(turns, { now: NOW, until: SPLIT, edges });
const t2 = performance.now();
fitOwedTable(turns, { now: NOW, edges });
console.log(`fit on turns before the split: ${(t2 - t1).toFixed(0)} ms; on all of them, as the hub does: ${(performance.now() - t2).toFixed(0)} ms`);
console.log(`turns per bucket (edges ${edges.join(', ')}): DMs ${table.turns.direct.join(' / ')}, others ${table.turns.group.join(' / ')}`);
const rated = rateTurns(turns).filter((t) => settled(t, NOW));
const ws = [before, tableOf(table)];
for (const shape of ['direct', 'group'] as OwedShape[]) {
  const mine = rated.filter((t) => owedShape(t.shape) === shape);
  const name = shape === 'direct' ? 'DMs' : 'groups and channels';
  measure(`${name}, ${new Date(SPLIT).getUTCFullYear()} to the hub era`, mine.filter((t) => t.addressed >= SPLIT && t.addressed < HUB_ERA), ws);
  measure(`${name}, hub era`, mine.filter((t) => t.addressed >= HUB_ERA), ws);
}
// --try "0.8,0.9;0.7,0.85,0.95": other bucket edges, on DMs from the split to the hub era only.
for (const set of opt('try')?.split(';') ?? []) {
  const e = set.split(',').map(Number);
  const t = fitOwedTable(turns, { now: NOW, until: SPLIT, edges: e });
  measure(`edges ${set}`, rated.filter((x) => owedShape(x.shape) === 'direct' && x.addressed >= SPLIT && x.addressed < HUB_ERA), [before, tableOf(t)]);
}
if (argv.includes('--table')) {
  console.log(`  rateEdges: [${table.rateEdges.join(', ')}],`);
  console.log(`  rateMids: { direct: [${table.rateMids.direct.map((x) => x.toFixed(3)).join(', ')}], group: [${table.rateMids.group.map((x) => x.toFixed(3)).join(', ')}] },`);
  const rows = (s: OwedShape) => table.chance[s].map((r) => `      [${r.map((x) => String(Math.round(x * 100) / 100)).join(', ')}],`).join('\n');
  console.log(`\nages (h): ${OWED_AGES.map((a) => +(a / HOUR).toFixed(2)).join(', ')}\n  chance: {\n    direct: [\n${rows('direct')}\n    ],\n    group: [\n${rows('group')}\n    ],\n  },`);
}
