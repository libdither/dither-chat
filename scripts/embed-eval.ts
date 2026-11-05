/**
 * Do message embeddings help triage? An offline evaluation on a copy of the hub database (docs/embeddings.md).
 *
 *   bun scripts/embed-eval.ts --db <live hub.sqlite> --scratch <dir> [--days 30] [--engaged] [--fresh]
 *
 * It copies the database with VACUUM INTO (read-only on the live one), embeds the messages from others in the
 * conversations where you wrote or reacted, with jev (cached in <scratch>/eval-embeddings.sqlite, so a second run is
 * quick), asks jev's three questions about each, and labels each message with the reply/reaction-within-15-minutes
 * rule (notification-design.md §3), leaving out messages you were already engaged with (--engaged keeps them).
 *
 * A rolling time split: for each day, everything is learned from messages whose label was known before the day
 * began, and the day's messages are scored. The headline metric is PR-AUC within each conversation, averaged over
 * the conversations with at least 5 positives: how well it picks the messages you answer out of a chat's stream.
 * It prints aggregate numbers only, never a message, a name or an id, and writes them to <scratch>/embed-eval.json.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  averagePrecision,
  crossFit,
  dot,
  EmbeddingStore,
  fitProbe,
  inputFor,
  Jev,
  jevFeatures,
  KnnIndex,
  loadTurns,
  meanOf,
  needsJev,
  outcomes,
  PING_MS,
  probeLogit,
  QUESTIONS,
  rateLogit,
  rocAuc,
  selfIdentities,
  timeFolds,
  unit,
  type MessageRow,
} from '../packages/hub/src/embeddings.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const live = resolve(opt('db', join(import.meta.dir, '../.data/hub.sqlite')));
const scratch = resolve(opt('scratch', ''));
if (!opt('scratch', '')) throw new Error('--scratch <dir> is required: the copy and the cache go there');
const days = Number(opt('days', '30'));
const keepEngaged = args.includes('--engaged');
mkdirSync(scratch, { recursive: true });

// ------------------------------------------------------------------ the copy

const copy = join(scratch, 'hub-copy.sqlite');
if (args.includes('--fresh') || !existsSync(copy)) {
  if (existsSync(copy)) (await import('node:fs')).rmSync(copy);
  const src = new Database(live, { readonly: true });
  src.query('VACUUM INTO ?').run(copy);
  src.close();
}
const hub = new Database(copy, { readonly: true });
const self = selfIdentities(hub);
const end = (hub.query('SELECT max(ts) AS t FROM message').get() as { t: number }).t;
const since = end - days * 86_400_000;

// ------------------------------------------------------------------ examples and labels

const { turns, rows } = loadTurns(hub, since, self);
const outs = outcomes(turns);
type Ex = { id: string; conv: string; author: string | null; ts: number; y: 0 | 1; x?: Float32Array; raw?: Float32Array; jev: Record<string, number>; gated: boolean };
let examples: Ex[] = [];
for (const [id, o] of outs) {
  const r = rows.get(id)!;
  if (r.ts > end - PING_MS) continue; // its label is not known yet
  if (o.engaged && !keepEngaged) continue;
  examples.push({ id, conv: r.conversation, author: r.author, ts: r.ts, y: o.delay !== null && o.delay <= PING_MS ? 1 : 0, jev: {}, gated: false });
}

// ------------------------------------------------------------------ vectors and answers (jev, cached)

const jev = new Jev(process.env.DITHER_JEV_URL ?? 'http://127.0.0.1:7862', 600_000);
const store = new EmbeddingStore(join(scratch, 'eval-embeddings.sqlite'));
const MESSAGE_SQL = `
  SELECT m.id, m.rowid AS rid, m.conversation_id, m.author_id, i.person_id, m.ts, m.body, m.extra, c.shape, r.body AS reply_body, r.author_id AS reply_author
  FROM message m JOIN conversation c ON c.id = m.conversation_id LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id
  WHERE m.id = ?`;
const text = (id: string) => {
  const row = hub.query(MESSAGE_SQL).get(id) as MessageRow | null;
  return row ? inputFor(hub, row, self) : null;
};
const t0 = performance.now();
if (!store.mean()) {
  // The background: a random sample of everything in the window, not only the conversations you take part in.
  const ids = (hub.query('SELECT id FROM message WHERE ts >= ? AND deleted = 0 AND length(body) > 0 ORDER BY random() LIMIT 1024').all(since) as { id: string }[]).map((r) => r.id);
  const texts = ids.map(text).filter((t): t is string => !!t);
  const raws: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) for (const v of await jev.embed(texts.slice(i, i + 64))) if (v) raws.push(v);
  store.setMean(meanOf(raws));
}
const todo = examples.filter((e) => !store.has(e.id)).map((e) => ({ e, t: text(e.id) })).filter((x): x is { e: Ex; t: string } => !!x.t);
for (let i = 0; i < todo.length; i += 64) {
  const chunk = todo.slice(i, i + 64);
  const vs = await jev.embed(chunk.map((c) => c.t));
  store.put(chunk.flatMap((c, j) => (vs[j] ? [{ id: c.e.id, conversation: c.e.conv, author: c.e.author, ts: c.e.ts, raw: vs[j]! }] : [])));
}
const embedSeconds = (performance.now() - t0) / 1000;
const vecs = store.many(examples.map((e) => e.id));
examples = examples.filter((e) => vecs.has(e.id));
for (const e of examples) {
  e.x = vecs.get(e.id)!.v;
  e.raw = store.raw(vecs.get(e.id)!);
}
const t1 = performance.now();
const unasked = examples.filter((e) => !Object.keys(store.answers(e.id)).length);
for (let i = 0; i < unasked.length; i += 256) {
  const chunk = unasked.slice(i, i + 256);
  const texts = chunk.map((e) => text(e.id) ?? '');
  const answers = chunk.map(() => ({}) as Record<string, number>);
  for (const [k, q] of Object.entries(QUESTIONS)) (await jev.judge(q, texts)).forEach((p, j) => p !== null && (answers[j][k] = p));
  chunk.forEach((e, j) => store.setAnswers(e.id, e.ts, answers[j]));
}
const jevSeconds = (performance.now() - t1) / 1000;
const probsOf = hub.query('SELECT probs FROM triage WHERE message_id = ?');
for (const e of examples) {
  e.jev = jevFeatures(store.answers(e.id));
  const p = probsOf.get(e.id) as { probs: string | null } | null;
  e.gated = !!p?.probs && needsJev(JSON.parse(p.probs));
}
examples.sort((a, b) => a.ts - b.ts);

// ------------------------------------------------------------------ point-in-time conversation answer rate

/** Each example's conversation rate from the examples whose label was known by its time; the prior from those too. */
const rate = new Map<string, number>();
{
  const known: Ex[] = [];
  let k = 0;
  const tally = new Map<string, { p: number; n: number }>();
  let P = 0;
  for (const e of examples) {
    while (k < examples.length && examples[k].ts + PING_MS <= e.ts) {
      const x = examples[k++];
      known.push(x);
      const t = tally.get(x.conv) ?? tally.set(x.conv, { p: 0, n: 0 }).get(x.conv)!;
      t.p += x.y;
      t.n++;
      P += x.y;
    }
    const t = tally.get(e.conv) ?? { p: 0, n: 0 };
    rate.set(e.id, rateLogit(t.p, t.n, known.length ? Math.max(P, 1) / known.length : 0.1));
  }
}

// ------------------------------------------------------------------ the rolling split

const LAMBDA = Number(opt('lambda', '10'));
const QS = Object.keys(QUESTIONS);
type Method = { name: string; score: (tr: Ex[], te: Ex[]) => number[] };

/** Out-of-fold scores on the training set from a scorer fitted on the other folds. */
function oof(tr: Ex[], fit: (part: Ex[]) => (e: Ex) => number): number[] {
  const folds = timeFolds(tr.length, 5);
  const out = tr.map(() => 0);
  for (let f = 0; f < 5; f++) {
    const rest = tr.filter((_, i) => folds[i] !== f);
    if (!rest.some((e) => e.y) || !rest.some((e) => !e.y)) continue;
    const s = fit(rest);
    tr.forEach((e, i) => folds[i] === f && (out[i] = s(e)));
  }
  return out;
}

const probeScorer = (part: Ex[], lambda = LAMBDA) => {
  const p = fitProbe(part.map((e) => e.x!), part.map((e) => e.y), { offset: part.map((e) => rate.get(e.id)!), lambda });
  return (e: Ex) => probeLogit(p, e.x!);
};
const knnScorer = (part: Ex[]) => {
  const k = new KnnIndex(part.map((e) => ({ id: e.id, conversation: e.conv, author: e.author, x: e.x!, y: e.y })));
  return (e: Ex) => k.score(e.x!, { author: e.author, conversation: e.conv }) ?? 0;
};
const centroidScorer = (centred: boolean) => (part: Ex[]) => {
  const c = unit(meanOf(part.filter((e) => e.y).map((e) => (centred ? e.x! : e.raw!))));
  return (e: Ex) => dot(centred ? e.x! : e.raw!, c);
};
const jevOf = (gated: boolean) => (e: Ex) => QS.map((q) => (gated && !e.gated ? 0 : (e.jev[`jev:${q}`] ?? 0)));

/** Logistic regression on a few columns (the rate first), fitted on out-of-fold columns of the training days. */
function stack(cols: { fit?: (part: Ex[]) => (e: Ex) => number; fixed?: (e: Ex) => number[] }[]): Method['score'] {
  return (tr, te) => {
    const trainCols = cols.map((c) => (c.fit ? oof(tr, c.fit).map((v) => [v]) : tr.map((e) => c.fixed!(e))));
    const full = cols.map((c) => (c.fit ? c.fit(tr) : null));
    const row = (parts: number[][]) => [...parts.flat()];
    const X = tr.map((e, i) => row([[rate.get(e.id)!], ...trainCols.map((c) => c[i])]));
    const m = fitProbe(X, tr.map((e) => e.y), { lambda: 0.1 });
    return te.map((e) => probeLogit(m, row([[rate.get(e.id)!], ...cols.map((c, j) => (c.fit ? [full[j]!(e)] : c.fixed!(e)))])));
  };
}

const methods: Method[] = [
  { name: 'conversation reply rate', score: (_, te) => te.map((e) => rate.get(e.id)!) },
  { name: 'rate + probe (emb)', score: (tr, te) => (s => te.map((e) => rate.get(e.id)! + s(e)))(probeScorer(tr)) },
  { name: 'rate + probe, λ=1', score: (tr, te) => (s => te.map((e) => rate.get(e.id)! + s(e)))(probeScorer(tr, 1)) },
  { name: 'rate + probe, λ=100', score: (tr, te) => (s => te.map((e) => rate.get(e.id)! + s(e)))(probeScorer(tr, 100)) },
  { name: 'rate + kNN', score: stack([{ fit: knnScorer }]) },
  { name: 'rate + probe + kNN', score: stack([{ fit: probeScorer }, { fit: knnScorer }]) },
  { name: 'rate + jev answers', score: stack([{ fixed: jevOf(false) }]) },
  { name: 'rate + jev answers (gated)', score: stack([{ fixed: jevOf(true) }]) },
  { name: 'rate + probe + kNN + jev', score: stack([{ fit: probeScorer }, { fit: knnScorer }, { fixed: jevOf(false) }]) },
  { name: 'rate + probe + kNN + jev (gated)', score: stack([{ fit: probeScorer }, { fit: knnScorer }, { fixed: jevOf(true) }]) },
  { name: 'centroid of answered, raw', score: (tr, te) => te.map(centroidScorer(false)(tr)) },
  { name: 'centroid of answered, centred', score: (tr, te) => te.map(centroidScorer(true)(tr)) },
  { name: 'rate + centroid, centred', score: stack([{ fit: centroidScorer(true) }]) },
];

const DAY = 86_400_000;
const firstDay = Math.floor(examples[0].ts / DAY) * DAY;
const WARMUP = Number(opt('warmup', '2'));
const scores = new Map<string, Map<string, number>>(methods.map((m) => [m.name, new Map()]));
const folds: { day: string; train: number; trainPos: number; test: number; testPos: number }[] = [];
for (let d = firstDay + WARMUP * DAY; d <= end; d += DAY) {
  const tr = examples.filter((e) => e.ts + PING_MS <= d);
  const te = examples.filter((e) => e.ts >= d && e.ts < d + DAY);
  if (!te.length || tr.filter((e) => e.y).length < 10) continue;
  folds.push({ day: new Date(d).toISOString().slice(0, 10), train: tr.length, trainPos: tr.filter((e) => e.y).length, test: te.length, testPos: te.filter((e) => e.y).length });
  for (const m of methods) m.score(tr, te).forEach((s, i) => scores.get(m.name)!.set(te[i].id, s));
}

// ------------------------------------------------------------------ metrics

const tested = examples.filter((e) => scores.get(methods[0].name)!.has(e.id));
const byConv = new Map<string, Ex[]>();
for (const e of tested) (byConv.get(e.conv) ?? byConv.set(e.conv, []).get(e.conv)!).push(e);
const qualifying = [...byConv.values()].filter((l) => l.filter((e) => e.y).length >= 5);
const results = methods.map((m) => {
  const s = scores.get(m.name)!;
  const aps = qualifying.map((l) => averagePrecision(l.map((e) => s.get(e.id)!), l.map((e) => e.y)));
  const base = qualifying.map((l) => averagePrecision(l.map((e) => rate.get(e.id)!), l.map((e) => e.y)));
  return {
    method: m.name,
    withinPrAuc: aps.reduce((a, b) => a + b, 0) / aps.length,
    beatsRateIn: aps.filter((a, i) => a > base[i] + 1e-9).length,
    pooledPrAuc: averagePrecision(tested.map((e) => s.get(e.id)!), tested.map((e) => e.y)),
    pooledRocAuc: rocAuc(tested.map((e) => s.get(e.id)!), tested.map((e) => e.y)),
  };
});
const chance = qualifying.map((l) => l.filter((e) => e.y).length / l.length).reduce((a, b) => a + b, 0) / Math.max(1, qualifying.length);
const gatedShare = tested.filter((e) => e.gated).length / Math.max(1, tested.length);

const summary = {
  window: { days, examples: examples.length, positives: examples.filter((e) => e.y).length, conversations: new Set(examples.map((e) => e.conv)).size, engagedKept: keepEngaged },
  tested: { examples: tested.length, positives: tested.filter((e) => e.y).length, folds: folds.length, qualifyingConversations: qualifying.length, chanceWithinPrAuc: chance, jevGatedShare: gatedShare },
  cost: { embedSeconds, jevSeconds, embedded: todo.length, judged: unasked.length * QS.length },
  folds,
  results,
};
writeFileSync(join(scratch, keepEngaged ? 'embed-eval-engaged.json' : 'embed-eval.json'), JSON.stringify(summary, null, 2));
console.log(`window ${days} d: ${summary.window.examples} examples (${summary.window.positives} answered ≤15 min) in ${summary.window.conversations} conversations${keepEngaged ? ', engaged kept' : ''}`);
console.log(`tested ${summary.tested.examples} (${summary.tested.positives} positive) over ${folds.length} days; ${qualifying.length} conversations with ≥5 positives; chance PR-AUC ${chance.toFixed(3)}; jev gate lets through ${(gatedShare * 100).toFixed(0)}%`);
console.log(`jev: embedded ${todo.length} in ${embedSeconds.toFixed(1)} s, ${summary.cost.judged} judgments in ${jevSeconds.toFixed(1)} s`);
console.log('\n| Method | Within-conversation PR-AUC | Beats rate in | Pooled PR-AUC | Pooled ROC-AUC |\n| --- | ---: | ---: | ---: | ---: |');
for (const r of results) console.log(`| ${r.method} | ${r.withinPrAuc.toFixed(3)} | ${r.beatsRateIn}/${qualifying.length} | ${r.pooledPrAuc.toFixed(3)} | ${r.pooledRocAuc.toFixed(3)} |`);
store.close();
hub.close();
