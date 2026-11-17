/**
 * The scorecard (docs/scorecard.md) of a copy of a hub's database: every matured day scored as the hub would score it
 * (packages/hub/src/scorecard.ts), printed one table per chart, with the last week against the week before.
 *
 *   bun scripts/scorecard.ts --db <copy>.sqlite [--days 28] [--stored] [--json]
 *
 * It opens the copy read-only and writes nothing. --stored prints what the hub kept in `model_score` instead of
 * scoring again (a copy of a hub that has run the job). Days are the machine's local days: set TZ to the hub's zone
 * when it differs. Counts and rates only: never ids or message text.
 */
import { Database } from 'bun:sqlite';
import { SCORE_CHARTS, formatScore, scoreTrend, type ModelScoresView } from '@dither-chat/protocol/scorecard';
import { scoreAll, viewOf, type ScoreRow } from '../packages/hub/src/scorecard.ts';
import { whole } from '../packages/hub/src/slices.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const path = opt('db');
if (!path) {
  console.error('usage: bun scripts/scorecard.ts --db <copy of hub.sqlite> [--days 28] [--stored] [--json]');
  process.exit(2);
}
const days = Number(opt('days') ?? 28);
const db = new Database(path, { readonly: true });
const now = Date.now();
const t0 = performance.now();
let rows: ScoreRow[];
if (args.includes('--stored')) rows = db.query('SELECT day, metric, value, n FROM model_score ORDER BY day').all() as ScoreRow[];
else rows = whole(scoreAll(db, now));
const all = viewOf(rows, null);
// The last `days` days.
const cut = Math.max(0, all.days.length - days);
const view: ModelScoresView = {
  days: all.days.slice(cut),
  metrics: Object.fromEntries(Object.entries(all.metrics).map(([k, s]) => [k, { v: s.v.slice(cut), n: s.n.slice(cut) }])),
  pending: null,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(view));
  process.exit(0);
}

const pad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);
console.log(`Scorecard of ${view.days.length} days (${view.days[0] ?? '–'} to ${view.days.at(-1) ?? '–'}), ${Math.round(performance.now() - t0)} ms\n`);
for (const c of SCORE_CHARTS) {
  console.log(`## ${c.title}\n${c.about}\n`);
  const cols = c.metrics.map((m) => m.label);
  const w = cols.map((l) => Math.max(l.length, 12));
  console.log(`| day        | ${cols.map((l, i) => pad(l, w[i])).join(' | ')} |`);
  console.log(`| ---------- | ${w.map((x) => '-'.repeat(x - 1) + ':').join(' | ')} |`);
  view.days.forEach((d, i) => {
    const cells = c.metrics.map((m, j) => {
      const s = view.metrics[m.key];
      const v = s?.v[i] ?? null;
      return pad(v === null && !s?.n[i] ? '' : `${formatScore(m.kind, v)} (${s?.n[i] ?? 0})`, w[j]);
    });
    console.log(`| ${d} | ${cells.join(' | ')} |`);
  });
  const trends = c.metrics.map((m) => {
    const t = scoreTrend(view, m);
    return `${m.label}: ${formatScore(m.kind, t.recent.value)} (n ${t.recent.n}) against ${formatScore(m.kind, t.before.value)} (n ${t.before.n})`;
  });
  console.log(`\nLast 7 days against the 7 before: ${trends.join('; ')}\n`);
}
