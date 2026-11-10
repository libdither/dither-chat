/**
 * The inbox replay (docs/inbox.md): replays the activity log in time order and asks, at every moment you opened a
 * conversation, where each ordering would have put the one you opened. Numbers only.
 *
 *   bun scripts/inbox-replay.ts --live ~/path/.data/hub.sqlite --out <scratch dir> [--holdout 3]
 *   bun scripts/inbox-replay.ts --db <scratch dir>/hub-copy.sqlite --out <scratch dir>   (reuse a copy)
 *   bun scripts/inbox-replay.ts ... --grid      (also: the "you were here" weight and half-life)
 *   bun scripts/inbox-replay.ts ... --model-grid   (also: the learned order's regularisation, position correction and its cap, horizon and window)
 *   bun scripts/inbox-replay.ts ... --curve        (also: the examination curve fitted to your opens; --model-grid has it too)
 *   bun scripts/inbox-replay.ts ... --triage       (also: the learned order with triage's level and your votes as features)
 *   bun scripts/inbox-replay.ts ... --calibrate    (the learned order's prior: open chance against the formula alone)
 *
 * It never opens the live database for writing: it copies it with VACUUM INTO (read-only) and works on the copy. It
 * writes `inbox-replay.md` and `inbox-replay.json` to --out: counts, ranks and rates, never message text, names or ids.
 *
 * The world at each moment is rebuilt from the copy: every listed conversation's features folded up to then
 * (attention.ts's fold), what was unread (messages from others since you last wrote or stayed there), where you had
 * been (the visit log), and the mutes as they are now. Days split in two: the earlier ones for choosing, the last
 * `--holdout` days to report.
 *
 * The learned order (rank.ts) is replayed as the hub runs it: refitted each day on the opens before that day whose
 * horizon had passed, starting from the prior, and asked at every open of the day. `sectioned` is the same model in the
 * three sections the inbox had on 2026-11-09 (a reply you owe that needs you, then unread, then the rest), to measure
 * what hard sections cost against the one order.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scoreConversation, WEIGHTS } from '../packages/hub/src/attention.ts';
import { EXAM_AT, EXAMINATION_ETA, FEATURES, FIT, fitRank, GUESSED_CURVE, TRIAGE_FEATURES, HORIZON, LAMBDA, MAX_IPW, predict, PRIOR, rankFeatures, type Feature, type Features, type FitOptions, type Moment, type RankModel } from '../packages/hub/src/rank.ts';
import { isChoice, loadWorld, momentOf, mutedBy, Rebuild, seenAt, type Seen, type World } from '../packages/hub/src/rankhistory.ts';
import { Store } from '../packages/hub/src/store.ts';
import { Triage } from '../packages/hub/src/triage.ts';

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
const holdoutDays = Number(opt('holdout', '3'));
const tzOffset = Number(opt('tz', String(-new Date().getTimezoneOffset() / 60))) * HOUR;
const dayOf = (ts: number) => Math.floor((ts + tzOffset) / DAY);
const dayStart = (d: number) => d * DAY - tzOffset;

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

// ------------------------------------------------------------------ the world, rebuilt (rankhistory.ts)

function load(path: string): World & { db: Database } {
  const store = new Store(path, () => null);
  return { ...loadWorld(store.db, mutedBy(new Triage(store))), db: store.db };
}

// ------------------------------------------------------------------ orderings

/** A policy turns the candidates at a moment into an order (best first), as conversation ids. */
export type Policy = { id: string; what: string; order: (seen: Seen[], t: number) => string[] };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const scored = (s: Seen, visited = true) => {
  const r = scoreConversation(s.input);
  const v = r.parts.visited ?? 0;
  return { score: visited ? r.score : r.score - v, needs: r.needs, muted: !!s.input.muted && s.conv.shape !== 'self' };
};

/** Before one list: what needs you by score, then the latest message, muted last (the "caught up" line between). */
const twoLists: Policy = {
  id: 'two-lists',
  what: 'needs you by score, then "caught up" by the latest message (before one list)',
  order: (seen) =>
    seen
      .map((s) => ({ id: s.conv.id, last: s.input.lastMessageAt ?? 0, ...scored(s, false) }))
      .sort((a, b) => Number(b.needs) - Number(a.needs) || (a.needs ? 0 : Number(a.muted) - Number(b.muted) || b.last - a.last) || b.score - a.score || byKey(a.id, b.id))
      .map((x) => x.id),
};

/** One list by the hub's score with "you were here" (ordering.ts rank), weights as given. */
const oneList = (id = 'one-list', weights?: { visited: number; visitedHalfLife: number }): Policy => ({
  id,
  what: weights ? `one list, "you were here" ${weights.visited} halving every ${weights.visitedHalfLife / HOUR} h` : 'one list by the score, with "you were here" (ordering.ts)',
  order: (seen) => {
    const saved = { visited: WEIGHTS.visited, visitedHalfLife: WEIGHTS.visitedHalfLife };
    if (weights) Object.assign(WEIGHTS, weights);
    try {
      return seen
        .map((s) => ({ id: s.conv.id, last: s.input.lastMessageAt ?? 0, ...scored(s) }))
        .sort((a, b) => Number(a.muted) - Number(b.muted) || b.score - a.score || b.last - a.last || byKey(a.id, b.id))
        .map((x) => x.id);
    } finally {
      Object.assign(WEIGHTS, saved);
    }
  },
});

const latest: Policy = {
  id: 'latest',
  what: 'the latest message first, as a chat app',
  order: (seen) => [...seen].sort((a, b) => (b.input.lastMessageAt ?? 0) - (a.input.lastMessageAt ?? 0) || byKey(a.conv.id, b.conv.id)).map((s) => s.conv.id),
};

const lastVisited: Policy = {
  id: 'last-visited',
  what: 'where you were last first, then the latest message',
  order: (seen) =>
    [...seen].sort((a, b) => (b.lastThere ?? 0) - (a.lastThere ?? 0) || (b.input.lastMessageAt ?? 0) - (a.input.lastMessageAt ?? 0) || byKey(a.conv.id, b.conv.id)).map((s) => s.conv.id),
};

// ------------------------------------------------------------------ measuring

/** One open: where each policy put it (0 = top), and what it was. */
export interface Open {
  t: number;
  day: number;
  source: string;
  listLength: number;
  /** You had been there within the last 2 hours: going back to a chat you were just in. */
  back: boolean;
  /** You wrote during the stay. */
  sent: boolean;
  ranks: Record<string, number>;
}

/** What the learned order needs from one open: every candidate's features then, and what you opened. */
interface Snap {
  t: number;
  targets: string[];
  sent: boolean;
  /** `section`: where the sectioned inbox put it: 0 a reply you owe that needs you, 1 unread, 2 the rest. */
  cands: { id: string; x: Features; muted: boolean; section: number }[];
}

export interface Summary {
  n: number;
  mrr: number;
  recall5: number;
  recall10: number;
  medianRank: number;
}

export function summarize(ranks: number[]): Summary {
  const n = ranks.length;
  if (!n) return { n, mrr: 0, recall5: 0, recall10: 0, medianRank: 0 };
  const s = [...ranks].sort((a, b) => a - b);
  const median = n % 2 ? s[n >> 1] : (s[(n >> 1) - 1] + s[n >> 1]) / 2;
  return {
    n,
    mrr: ranks.reduce((a, r) => a + 1 / (r + 1), 0) / n,
    recall5: ranks.filter((r) => r < 5).length / n,
    recall10: ranks.filter((r) => r < 10).length / n,
    medianRank: median + 1,
  };
}

/**
 * Replay `policies` over every open: the rank of what you opened under each, and what the learned order learns from.
 * `wide`: moments built with a longer horizon too, for the grid to try shorter ones on.
 */
function measure(l: ReturnType<typeof load>, policies: Policy[], wideHorizon = 0): { opens: Open[]; snaps: Snap[]; moments: Moment[]; wide: Moment[]; skipped: Record<string, number> } {
  const choices = l.stays.filter(isChoice);
  const opens: Open[] = [];
  const snaps: Snap[] = [];
  const moments: Moment[] = [];
  const wide: Moment[] = [];
  const skipped: Record<string, number> = { notListed: 0, noTarget: 0 };
  let i = 0;
  new Rebuild(
    l.db,
    l,
    choices.map((s) => s.start),
    (t, w) => {
      const stay = choices[i++];
      if (!stay.targets.length) return void skipped.noTarget++;
      // Where you had been until just before this open; the stay itself is not yet known.
      const seen = seenAt(w, t);
      const ids = new Set(seen.map((s) => s.conv.id));
      if (!stay.targets.some((x) => ids.has(x))) return void skipped.notListed++;
      const ranks: Record<string, number> = {};
      for (const p of policies) {
        const order = p.order(seen, t);
        ranks[p.id] = Math.min(...stay.targets.map((x) => order.indexOf(x)).filter((r) => r >= 0));
      }
      const back = seen.some((s) => stay.targets.includes(s.conv.id) && s.lastThere !== null && t - s.lastThere <= 2 * HOUR);
      opens.push({ t, day: dayOf(t), source: stay.source, listLength: seen.length, back, sent: stay.sent > 0, ranks });
      snaps.push({
        t,
        targets: stay.targets.filter((x) => ids.has(x)),
        sent: stay.sent > 0,
        cands: seen.map((s) => {
          const r = scoreConversation(s.input);
          return { id: s.conv.id, x: rankFeatures(s.input, r), muted: !!s.input.muted && s.conv.shape !== 'self', section: r.needs && r.owedSince !== null ? 0 : s.input.unread > 0 ? 1 : 2 };
        }),
      });
      // As the hub learns: a sample of the candidates (rankhistory.ts).
      moments.push(momentOf(w, stay, t, seen)!);
      if (wideHorizon) wide.push(momentOf(w, stay, t, seen, wideHorizon)!);
    },
  ).run();
  return { opens, snaps, moments, wide, skipped };
}

// ------------------------------------------------------------------ the learned order

/**
 * Where a model puts what you opened, muted places last as on screen. `sectioned`: in the sections of 2026-11-09 first
 * (ordering.ts inboxSections then), each in the model's order.
 */
function modelRank(m: RankModel, s: Snap, sectioned = false): number {
  const order = s.cands
    .map((c) => ({ id: c.id, v: predict(m, c.x).value, muted: c.muted, section: sectioned ? c.section : 0 }))
    .sort((a, b) => a.section - b.section || Number(a.muted) - Number(b.muted) || b.v - a.v || (a.id < b.id ? -1 : 1))
    .map((c) => c.id);
  return Math.min(...s.targets.map((x) => order.indexOf(x)).filter((r) => r >= 0));
}

/** A setting of the learned order to replay: the fit's options, and `window`, how far back it learns from. */
type Setting = FitOptions & { window?: number };

/**
 * Replay the learned order as the hub runs it: refitted each day on what had matured before it. Adds `ranks[id]`, and
 * with `sectionedId` the same models in the old sections as `ranks[sectionedId]`.
 */
function learned(ms: Moment[], opens: Open[], snaps: Snap[], id: string, o: Setting, sectionedId?: string): Record<number, RankModel> {
  const models: Record<number, RankModel> = {};
  const horizon = o.horizon ?? HORIZON;
  for (const d of [...new Set(opens.map((x) => x.day))]) {
    const cut = dayStart(d);
    const known = ms.filter((m) => m.at + horizon <= cut && m.at >= cut - (o.window ?? Infinity));
    models[d] = known.length ? fitRank(known, cut, o) : PRIOR;
  }
  opens.forEach((x, i) => {
    x.ranks[id] = modelRank(models[x.day], snaps[i]);
    if (sectionedId) x.ranks[sectionedId] = modelRank(models[x.day], snaps[i], true);
  });
  return models;
}

// ------------------------------------------------------------------ the report

/** How far down the inbox's list was on screen in the stays that say (`visit.depth`, recorded since 2026-11-10). */
function onScreen(db: Database): string {
  const rows = db.query('SELECT depth FROM visit WHERE depth IS NOT NULL').all() as Row[];
  if (!rows.length) return '- on screen: no stay has recorded how far down the list was yet';
  return `- on screen in ${rows.length} stays, by first position: ${EXAM_AT.map((p) => `${p + 1}: ${(rows.filter((r) => r.depth >= p).length / rows.length).toFixed(2)}`).join(', ')}`;
}

const fmt = (x: number) => x.toFixed(3);

/** The difference in MRR between two orderings on the same opens, with a 95% interval from resampling the opens. */
export function mrrGap(opens: Open[], a: string, b: string, draws = 4000): { gap: number; lo: number; hi: number; better: number; worse: number } {
  const d = opens.map((o) => 1 / (o.ranks[a] + 1) - 1 / (o.ranks[b] + 1));
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const means: number[] = [];
  for (let i = 0; i < draws; i++) means.push(mean(d.map(() => d[Math.floor(rand() * d.length)])));
  means.sort((x, y) => x - y);
  return { gap: mean(d), lo: means[Math.floor(draws * 0.025)], hi: means[Math.floor(draws * 0.975)], better: d.filter((x) => x > 1e-9).length, worse: d.filter((x) => x < -1e-9).length };
}
const gapText = (o: Open[], a: string, b: string) => {
  const g = mrrGap(o, a, b);
  return `${g.gap >= 0 ? '+' : ''}${fmt(g.gap)} (${fmt(g.lo)} to ${fmt(g.hi)}, n=${o.length})`;
};
const gapLine = (what: string, o: Open[], a = 'learned', b = 'one-list') => {
  const g = mrrGap(o, a, b);
  return `- ${what} (n=${o.length}): ${g.gap >= 0 ? '+' : ''}${fmt(g.gap)}, 95% interval ${fmt(g.lo)} to ${fmt(g.hi)}; higher for ${g.better} opens, lower for ${g.worse}`;
};

function table(title: string, policies: Policy[], groups: [string, Open[]][]): string {
  const lines = [`### ${title}`, '', `| ordering | ${groups.map(([g, o]) => `${g} (n=${o.length}) MRR · R@5 · R@10 · median`).join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`];
  for (const p of policies) {
    const cells = groups.map(([, o]) => {
      const s = summarize(o.map((x) => x.ranks[p.id]));
      return `${fmt(s.mrr)} · ${fmt(s.recall5)} · ${fmt(s.recall10)} · ${s.medianRank}`;
    });
    lines.push(`| ${p.id} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const path = copyLive();
  mkdirSync(outDir, { recursive: true });
  const t0 = performance.now();
  const l = load(path);
  const policies: Policy[] = [twoLists, oneList(), latest, lastVisited];
  if (flag('grid'))
    for (const v of [15, 30, 45, 60]) for (const h of [1, 2, 4]) policies.push(oneList(`here-${v}-${h}h`, { visited: v, visitedHalfLife: h * HOUR }));
  const grid = flag('model-grid');
  const { opens, snaps, moments, wide, skipped } = measure(l, policies, grid ? 6 * HOUR : 0);
  const days = [...new Set(opens.map((o) => o.day))].sort((a, b) => a - b);
  const holdout = new Set(days.slice(-holdoutDays));
  // The learned order, as shipped; and with --model-grid, other settings to choose from on the choosing days.
  const shipped: Setting = { ...FIT, cap: MAX_IPW, horizon: HORIZON };
  const models = learned(moments, opens, snaps, 'learned', shipped, 'sectioned');
  policies.push({ id: 'learned', what: 'the learned order (rank.ts) as shipped, refitted daily on the days before', order: () => [] });
  policies.push({ id: 'sectioned', what: 'the learned order in the sections of 2026-11-09: a reply you owe that needs you, then unread, then the rest', order: () => [] });
  const at = (lam: number): Record<Feature, number> => Object.fromEntries(FEATURES.map((f) => [f, f === 'bias' || f === 'formula' || LAMBDA[f] === Infinity ? LAMBDA[f] : lam])) as Record<Feature, number>;
  const gridIds: string[] = [];
  const fitted: Record<string, Record<number, RankModel>> = { learned: models };
  const tryIt = (id: string, what: string, o: Setting, ms = moments) => {
    fitted[id] = learned(ms, opens, snaps, id, { ...shipped, ...o });
    policies.push({ id, what, order: () => [] });
    gridIds.push(id);
  };
  if (grid) {
    for (const lam of [3, 10, 30, 100, 300])
      for (const eta of [0, 0.5, 1]) tryIt(`learned-${lam}-${eta}`, `learned, pulled back to the prior by ${lam}, position correction ${eta}`, { eta, lambda: at(lam) });
    // From the wider moments: what was opened up to 6 hours later is kept in full, so a shorter horizon is exact.
    for (const h of [0.5, 1, 3, 6]) tryIt(`horizon-${h}h`, `learned, an open within ${h} h counts`, { horizon: h * HOUR }, wide);
    for (const cap of [2, 3, 10, 30]) tryIt(`cap-${cap}`, `learned, an open from far down counts at most ${cap} times`, { cap });
    for (const d of [2, 3, 5]) tryIt(`window-${d}d`, `learned from the last ${d} days only`, { window: d * DAY });
  }
  if (grid || flag('triage')) {
    // Learned like the rest, where the hub keeps them at 0.
    const withTriage = { ...LAMBDA, ...Object.fromEntries(TRIAGE_FEATURES.map((f) => [f, 30])) } as Record<Feature, number>;
    tryIt('with-triage', 'learned with where triage put the newest unread message and your votes as features', { lambda: withTriage });
  }
  if (grid || flag('curve')) {
    tryIt('guess', 'learned with the guessed examination curve, (1 + position)^-0.5, as until 2026-11-10', { curve: undefined });
    tryIt('curve-em', 'learned with the curve fitted by regression-EM: a row not opened may be one you did not see', { curve: 'em' });
  }
  if (flag('calibrate')) {
    const ms = moments.filter((m) => !holdout.has(dayOf(m.at)));
    const only = Object.fromEntries(FEATURES.map((f) => [f, f === 'bias' || f === 'formula' ? 0 : Infinity])) as Record<Feature, number>;
    console.log('prior, fitted on the choosing days:', JSON.stringify(fitRank(ms, Date.now(), { lambda: only, eta: 0 }).open), 'shipped:', JSON.stringify(PRIOR.open));
  }
  const val = opens.filter((o) => !holdout.has(o.day));
  const hold = opens.filter((o) => holdout.has(o.day));
  const fromInbox = (o: Open) => o.source === 'inbox';
  const later = opens.filter((o) => o.day > days[0]);
  const gridGaps = gridIds.length
    ? [
        'Each setting minus the learned order as shipped, MRR on the same opens (choosing days; held-out days; every day after the first; held out, opened from elsewhere):',
        '',
        ...gridIds.map((id) => `- \`${id}\`: ${gapText(val, id, 'learned')}; ${gapText(hold, id, 'learned')}; ${gapText(later, id, 'learned')}; ${gapText(hold.filter((o) => !fromInbox(o)), id, 'learned')}`),
        '',
      ]
    : [];
  const report = [
    '# Inbox replay',
    '',
    `${opens.length} opens of a listed conversation over ${days.length} days (${val.length} for choosing, ${hold.length} held out: the last ${holdout.size} days). Skipped: ${skipped.notListed} not in the inbox then, ${skipped.noTarget} with no conversation. Median list length ${summarize(opens.map((o) => o.listLength)).medianRank - 1}.`,
    '',
    'Positions count from 1 at the top. MRR is the mean of 1/position; R@k the share opened from the first k rows; the median is a position.',
    '"From the inbox" opens were clicks on an inbox row, so they favour the order that was on screen then; "elsewhere" are taps on a notification, the switcher, search, the rail and lists.',
    '',
    '"Back" are opens of a conversation you had been in within the last 2 hours.',
    '',
    '"Wrote" are opens where you sent a message.',
    '',
    table('Choosing days', policies, [['all', val], ['from the inbox', val.filter(fromInbox)], ['elsewhere', val.filter((o) => !fromInbox(o))], ['back', val.filter((o) => o.back)], ['wrote', val.filter((o) => o.sent)]]),
    '',
    table('Held-out days', policies, [['all', hold], ['from the inbox', hold.filter(fromInbox)], ['elsewhere', hold.filter((o) => !fromInbox(o))], ['back', hold.filter((o) => o.back)], ['wrote', hold.filter((o) => o.sent)]]),
    '',
    'Learned order minus one list, MRR on the same opens:',
    '',
    gapLine('choosing days', val),
    gapLine('held-out days', hold),
    gapLine('held out, opened from elsewhere', hold.filter((o) => !fromInbox(o))),
    '',
    'Every day after the first, where each day\'s model learned only from the days before (learned minus one list):',
    '',
    gapLine('all', later),
    gapLine('from the inbox (clicks favour the order then on screen: the learned order since 2026-11-07)', later.filter(fromInbox)),
    gapLine('elsewhere', later.filter((o) => !fromInbox(o))),
    gapLine('back within 2 h', later.filter((o) => o.back)),
    gapLine('not back', later.filter((o) => !o.back)),
    gapLine('wrote', later.filter((o) => o.sent)),
    '',
    ...gridGaps,
    'Sectioned minus the learned order (what hard sections cost), MRR on the same opens:',
    '',
    gapLine('choosing days', val, 'sectioned', 'learned'),
    gapLine('held-out days', hold, 'sectioned', 'learned'),
    gapLine('held out, opened from elsewhere', hold.filter((o) => !fromInbox(o)), 'sectioned', 'learned'),
    '',
    'Sectioned minus one list (the formula), MRR on the same opens:',
    '',
    gapLine('choosing days', val, 'sectioned', 'one-list'),
    gapLine('held-out days', hold, 'sectioned', 'one-list'),
    '',
    'The learned order as it stood at the start of the last day, change from the prior in log-odds (positive: likelier):',
    '',
    ...(['open', 'send'] as const).map((k) => {
      const m = models[days[days.length - 1]];
      const d = FEATURES.map((f) => [f, (m[k][f] ?? 0) - (PRIOR[k][f] ?? 0)] as const).filter(([, v]) => Math.abs(v) >= 0.01).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      return `- ${k} (from ${m.moments} opens): ${d.map(([f, v]) => `${f} ${v > 0 ? '+' : ''}${v.toFixed(2)}`).join(', ') || 'the prior'}`;
    }),
    '',
    ...Object.entries(fitted)
      .filter(([, ms]) => ms[days[days.length - 1]]?.curve)
      .map(([id, ms]) => {
        const m = ms[days[days.length - 1]];
        return `- \`${id}\` examination curve at the start of the last day (from ${m.curveFrom} rows opened from the inbox), by first position: ${EXAM_AT.map((p, b) => `${p + 1}: ${m.curve![b].toFixed(2)}`).join(', ')}`;
      }),
    `- the guess, (1 + position)^-${EXAMINATION_ETA}: ${EXAM_AT.map((p, b) => `${p + 1}: ${GUESSED_CURVE[b].toFixed(2)}`).join(', ')}`,
    onScreen(l.db),
    '',
    'Orderings:',
    ...policies.map((p) => `- \`${p.id}\`: ${p.what}`),
    '',
    `Took ${Math.round((performance.now() - t0) / 1000)} s.`,
  ].join('\n');
  writeFileSync(join(outDir, 'inbox-replay.md'), report + '\n');
  const agg = (o: Open[]) => Object.fromEntries(policies.map((p) => [p.id, summarize(o.map((x) => x.ranks[p.id]))]));
  writeFileSync(join(outDir, 'inbox-replay.json'), JSON.stringify({ opens: opens.length, skipped, days: days.length, holdoutDays: holdout.size, choosing: agg(val), holdout: agg(hold) }, null, 2));
  console.log(report);
}
