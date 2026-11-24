/**
 * The nightly perf run's history and its trends (docs/perf.md "Nightly trends"). Flags only: it never fails on a number.
 *
 *   bun scripts/perf-trend.ts night --dir <out> [--meta scale=0.25 ...] > night.json
 *   bun scripts/perf-trend.ts report [--history <file.jsonl> | --ref origin/perf-history] [--summary <file.md>] [--html <file.html>]
 *
 * `night` turns every `<name>.json` in a directory (verify-perf's `--out`, or any script that writes
 * `{ metrics: { key: { v, kind, runs? } } }`) into one JSON line: the date, the commit, the runner, and each metric's
 * median with its spread. `perf.json`'s keys stay as they are; any other file's get its name in front (`memory.…`).
 * Nothing in here knows a metric by name: a new key is recorded and charted the night it first appears.
 *
 * `report` reads the history (one night a line; the `history.jsonl` of the perf-history branch by default) and writes
 * a markdown table of the last night against the 7 and 30 nights before it (to GITHUB_STEP_SUMMARY when set, else
 * stdout), and with --html a page of small line charts, one per metric, that needs nothing from the network. It
 * flags a time that moved more than 15% (and 5 ms, or 2 slow frames) from the 7 nights' median, and a count, tally or
 * byte size outside every value the 7 nights' runs came to (for one that never moves: any move). It always exits 0 once it has read the history.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { basename, join } from 'node:path';

type Stat = { kind: string; v: number; lo: number; hi: number; n: number };
type Night = {
  v: 1;
  at: string;
  sha: string;
  ref?: string;
  run?: string;
  runner: Record<string, string | number>;
  meta: Record<string, string>;
  world?: Record<string, number>;
  metrics: Record<string, Stat>;
};

const args = process.argv.slice(2);
const opt = (k: string, d = '') => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const opts = (k: string) => args.flatMap((a, i) => (a === `--${k}` && args[i + 1] !== undefined ? [args[i + 1]] : []));

const isTime = (kind: string) => kind === 'ms' || kind === 'frames';
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sh = (cmd: string, ...a: string[]) => {
  try {
    return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

// ------------------------------------------------------------------ night: this run's outputs as one line

/** Every run's values of a metric: its own `runs`, or verify-perf's per-pass runs ("p4x.open.ms" → runs.p4[i]["open.ms"]). */
function spreadOf(k: string, m: { v: number; runs?: number[] }, runs?: Record<string, Record<string, { v: number }>[]>) {
  if (Array.isArray(m.runs) && m.runs.length) return m.runs;
  const p = k.match(/^([pa]?\d+)x\.(.+)$/);
  const xs = p && runs?.[p[1]] ? runs[p[1]].map((r) => r[p[2]]?.v).filter((x): x is number => typeof x === 'number') : [];
  return xs.length ? xs : [m.v];
}

function night(): Night {
  const dir = opt('dir', 'out');
  const metrics: Record<string, Stat> = {};
  let world: Record<string, number> | undefined;
  // perf.json first, then the rest by name.
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => +(b === 'perf.json') - +(a === 'perf.json') || a.localeCompare(b));
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!j?.metrics) continue;
    const prefix = f === 'perf.json' ? '' : `${basename(f, '.json')}.`;
    if (f === 'perf.json') world = j.world?.counts;
    for (const [k, m] of Object.entries<any>(j.metrics)) {
      if (typeof m?.v !== 'number') continue;
      const xs = spreadOf(k, m, j.runs);
      metrics[prefix + k] = { kind: String(m.kind ?? 'count'), v: m.v, lo: Math.min(...xs), hi: Math.max(...xs), n: xs.length };
    }
  }
  const browser = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].map((b) => sh(b, '--version')).find(Boolean);
  const runner: Night['runner'] = {
    os: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ''}`.trim() : process.platform,
    arch: arch(),
    cpu: cpus()[0]?.model.trim() ?? '',
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    bun: Bun.version,
  };
  if (browser) runner.browser = browser;
  const meta = Object.fromEntries(opts('meta').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  return {
    v: 1,
    at: new Date().toISOString(),
    sha: process.env.GITHUB_SHA || sh('git', 'rev-parse', 'HEAD'),
    ref: process.env.GITHUB_REF_NAME || sh('git', 'rev-parse', '--abbrev-ref', 'HEAD'),
    run: process.env.GITHUB_RUN_ID,
    runner,
    meta,
    world,
    metrics,
  };
}

// ------------------------------------------------------------------ report: the last night against the nights before

type Row = { k: string; kind: string; now: Stat; med7?: number; med30?: number; flag: string };

function load(): Night[] {
  const file = opt('history');
  const text = file ? readFileSync(file, 'utf8') : sh('git', 'show', `${opt('ref', 'origin/perf-history')}:history.jsonl`);
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Night);
}

const pct = (now: number, was?: number) => (was === undefined ? undefined : was === 0 ? (now === 0 ? 0 : Infinity) : (now - was) / was);
const showPct = (d?: number) => (d === undefined ? '' : !isFinite(d) ? 'from 0' : `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`);
/** A time's change as a percentage, a count's as the difference itself (+40 nodes says more than +1%). */
const change = (kind: string, now: number, was?: number) =>
  was === undefined ? '' : isTime(kind) ? showPct(pct(now, was)) : now === was ? '±0' : `${now > was ? '+' : ''}${fmt(now - was)}`;
const fmt = (x?: number) => (x === undefined ? '' : Number.isInteger(x) ? x.toLocaleString('en-US') : x.toLocaleString('en-US', { maximumFractionDigits: 1 }));

/**
 * Its flag, if any. A time: past 15% (and 5 ms, or 2 slow frames) of the 7 nights' median. Anything else: outside every
 * value the 7 nights' runs came to, so a count that never moves flags on any move, and one whose runs spread anyway (the
 * bytes fetching ahead pulls) flags when it leaves that spread.
 */
function flagOf(now: Stat, prior: Stat[], med7?: number) {
  if (med7 === undefined || !prior.length) return '';
  if (isTime(now.kind)) {
    const d = now.v - med7;
    const floor = now.kind === 'frames' ? 2 : 5;
    if (Math.abs(d) < floor || Math.abs(d) <= Math.abs(med7) * 0.15) return '';
    return d > 0 ? 'slower' : 'faster';
  }
  const lo = Math.min(...prior.map((p) => p.lo ?? p.v));
  const hi = Math.max(...prior.map((p) => p.hi ?? p.v));
  return now.v > hi ? 'up' : now.v < lo ? 'down' : '';
}

function rowsOf(nights: Night[]): Row[] {
  const last = nights[nights.length - 1];
  // Nights run the same way (world size, runs) as the last: a change of set-up is not a trend.
  const same = JSON.stringify(last.meta ?? {});
  const before = nights.slice(0, -1).filter((n) => JSON.stringify(n.meta ?? {}) === same);
  return Object.entries(last.metrics).map(([k, now]) => {
    const prior = before.map((n) => n.metrics[k]).filter((m): m is Stat => typeof m?.v === 'number');
    const xs = prior.map((m) => m.v);
    const med7 = xs.length ? median(xs.slice(-7)) : undefined;
    const med30 = xs.length ? median(xs.slice(-30)) : undefined;
    return { k, kind: now.kind, now, med7, med30, flag: flagOf(now, prior.slice(-7), med7) };
  });
}

/** Counts of one step at more than one CPU throttle that came out different ("1x.cold.nodes" against "4x.cold.nodes"). */
function throttleDiffs(last: Night) {
  const groups = new Map<string, { k: string; kind: string; vals: Map<string, number> }>();
  for (const [k, m] of Object.entries(last.metrics)) {
    const p = k.match(/^([pa]?)(\d+)x\.(.+)$/);
    if (!p || isTime(m.kind)) continue;
    const g = `${PASSES[p[1]]} ${p[3]}`; // "phone open.layouts", at every throttle
    if (!groups.has(g)) groups.set(g, { k: g, kind: m.kind, vals: new Map() });
    groups.get(g)!.vals.set(p[2], m.v);
  }
  const cpus = [...new Set([...groups.values()].flatMap((g) => [...g.vals.keys()]))].sort((a, b) => +a - +b);
  const rows = [...groups.values()].filter((g) => g.vals.size > 1 && new Set(g.vals.values()).size > 1);
  return { cpus, rows };
}

const PASSES: Record<string, string> = { '': 'desktop', p: 'phone', a: 'fetching ahead' };

function markdown(nights: Night[], rows: Row[]) {
  const last = nights[nights.length - 1];
  const line = (r: Row) =>
    `| ${r.flag ? `**${r.flag}**` : ''} | \`${r.k}\` | ${r.kind} | ${fmt(r.now.v)} | ${r.now.n > 1 ? `${fmt(r.now.lo)}–${fmt(r.now.hi)}` : ''} | ${fmt(r.med7)} | ${change(r.kind, r.now.v, r.med7)} | ${fmt(r.med30)} | ${change(r.kind, r.now.v, r.med30)} |`;
  const head = '| | metric | kind | last | its runs | 7-night median | change | 30-night median | change |\n|---|---|---|---|---|---|---|---|---|';
  const flagged = rows.filter((r) => r.flag);
  const diffs = throttleDiffs(last);
  const r = last.runner;
  const out = [
    `### Nightly perf, ${last.at.slice(0, 10)} at \`${last.sha.slice(0, 12)}\``,
    '',
    `${nights.length} ${nights.length === 1 ? 'night' : 'nights'} in the history (from ${nights[0].at.slice(0, 10)}). This one: ${Object.entries(last.meta ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'no settings recorded'}; ${r.cores} × ${r.cpu}, ${r.memGB} GB, ${r.os}${r.browser ? `, ${r.browser}` : ''}.`,
    last.world ? `World: ${Object.entries(last.world).map(([k, v]) => `${fmt(v)} ${k}`).join(', ')}.` : '',
    '',
    'Flags only, never a failure: a time past 15% of the median of the 7 nights before (nights run the same way), any other kind outside every value their runs came to.',
    '',
    `#### Moved (${flagged.length})`,
    '',
    ...(flagged.length ? [head, ...flagged.map(line)] : [nights.length > 1 ? 'Nothing moved past its threshold.' : 'The first night: nothing to compare with yet.']),
    '',
  ];
  if (diffs.rows.length)
    out.push(
      `#### Counts that differ between CPU throttles (${diffs.rows.length})`,
      '',
      `| metric | kind | ${diffs.cpus.map((c) => `${c}×`).join(' | ')} |`,
      `|---|---|${diffs.cpus.map(() => '---|').join('')}`,
      ...diffs.rows.map((d) => `| \`${d.k}\` | ${d.kind} | ${diffs.cpus.map((c) => fmt(d.vals.get(c))).join(' | ')} |`),
      '',
    );
  out.push(`<details><summary>Every metric (${rows.length})</summary>`, '', head, ...rows.map(line), '', '</details>', '');
  return out.join('\n');
}

// ------------------------------------------------------------------ the page of charts

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One chart per step and pass (desktop, phone, fetching ahead, hub…), a line per CPU throttle. */
function charts(nights: Night[], rows: Row[]) {
  const flags = new Map(rows.map((r) => [r.k, r]));
  type Chart = { section: string; name: string; kind: string; series: { label: string; key: string }[] };
  const byId = new Map<string, Chart>();
  const keys = [...new Set(nights.flatMap((n) => Object.keys(n.metrics)))];
  for (const key of keys) {
    const kind = [...nights].reverse().find((n) => n.metrics[key])!.metrics[key].kind;
    const p = key.match(/^([pa]?)(\d+)x\.(.+)$/);
    const section = p ? PASSES[p[1]] : key.split('.')[0];
    const name = p ? p[3] : key.split('.').slice(1).join('.') || key;
    const id = `${section}|${name}`;
    if (!byId.has(id)) byId.set(id, { section, name, kind, series: [] });
    byId.get(id)!.series.push({ label: p ? `${p[2]}×` : name, key });
  }
  for (const c of byId.values()) c.series.sort((a, b) => parseFloat(a.label) - parseFloat(b.label));
  const W = 320, H = 132, L = 46, R = 10, T = 8, B = 20;
  const x = (i: number) => (nights.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (nights.length - 1));
  const one = (c: Chart) => {
    const vals = c.series.flatMap((s) => nights.flatMap((n) => (n.metrics[s.key] ? [n.metrics[s.key].lo, n.metrics[s.key].hi, n.metrics[s.key].v] : [])));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) (lo -= Math.max(1, Math.abs(lo) * 0.05)), (hi += Math.max(1, Math.abs(hi) * 0.05));
    const pad = (hi - lo) * 0.08;
    (lo -= pad), (hi += pad);
    const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    const svg = [
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${c.section} ${c.name}`)}">`,
      ...ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="tick" x="${L - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(short(t))}</text>`),
      `<text class="tick" x="${L}" y="${H - 5}">${nights[0].at.slice(5, 10)}</text>`,
      nights.length > 1 ? `<text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${nights[nights.length - 1].at.slice(5, 10)}</text>` : '',
    ];
    c.series.forEach((s, si) => {
      const pts = nights.map((n, i) => ({ i, n, m: n.metrics[s.key] })).filter((p) => p.m);
      const cls = `s${Math.min(si, 7) + 1}`;
      if (pts.length > 1) {
        const band = [...pts.map((p) => `${x(p.i).toFixed(1)},${y(p.m.hi).toFixed(1)}`), ...[...pts].reverse().map((p) => `${x(p.i).toFixed(1)},${y(p.m.lo).toFixed(1)}`)];
        svg.push(`<polygon class="band ${cls}" points="${band.join(' ')}"/>`);
        svg.push(`<polyline class="line ${cls}" points="${pts.map((p) => `${x(p.i).toFixed(1)},${y(p.m.v).toFixed(1)}`).join(' ')}"/>`);
      }
      for (const p of pts) {
        const tip = `${s.label === c.name ? '' : `${s.label}: `}${fmt(p.m.v)}${p.m.n > 1 ? ` (runs ${fmt(p.m.lo)}–${fmt(p.m.hi)})` : ''}\n${p.n.at.slice(0, 10)} ${p.n.sha.slice(0, 12)}`;
        svg.push(`<g class="pt ${cls}"><circle class="hit" cx="${x(p.i).toFixed(1)}" cy="${y(p.m.v).toFixed(1)}" r="8"/><circle class="dot" cx="${x(p.i).toFixed(1)}" cy="${y(p.m.v).toFixed(1)}" r="${pts.length > 60 ? 2 : 3}"/><title>${esc(tip)}</title></g>`);
      }
    });
    svg.push('</svg>');
    const moved = c.series.map((s) => flags.get(s.key)).filter((r): r is Row => !!r?.flag);
    const legend = c.series
      .map((s, si) => {
        const r = flags.get(s.key);
        return `<span class="key"><i class="sw s${Math.min(si, 7) + 1}"></i>${c.series.length > 1 ? `${esc(s.label)} ` : ''}<b>${r ? fmt(r.now.v) : '–'}</b>${r?.flag ? ` <em class="flag">▲ ${r.flag} ${change(r.kind, r.now.v, r.med7)}</em>` : ''}</span>`;
      })
      .join('');
    return `<figure class="chart${moved.length ? ' moved' : ''}" data-name="${esc(`${c.section} ${c.name}`.toLowerCase())}"><figcaption><code>${esc(c.name)}</code> <span class="kind">${esc(c.kind)}</span></figcaption>${svg.join('')}<div class="legend">${legend}</div></figure>`;
  };
  const sections = [...new Set([...byId.values()].map((c) => c.section))];
  return sections.map((s) => `<section><h2>${esc(s)}</h2><div class="grid">${[...byId.values()].filter((c) => c.section === s).map(one).join('')}</div></section>`).join('\n');
}

function short(v: number) {
  const a = Math.abs(v);
  return a >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : a >= 1e4 ? `${+(v / 1e3).toPrecision(3)}k` : a >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

function html(nights: Night[], rows: Row[]) {
  const last = nights[nights.length - 1];
  const table = rows
    .map((r) => `<tr><td>${r.flag ? `<b>${r.flag}</b>` : ''}</td><td><code>${esc(r.k)}</code></td><td>${r.kind}</td><td>${fmt(r.now.v)}</td><td>${r.now.n > 1 ? `${fmt(r.now.lo)}–${fmt(r.now.hi)}` : ''}</td><td>${fmt(r.med7)}</td><td>${change(r.kind, r.now.v, r.med7)}</td><td>${fmt(r.med30)}</td><td>${change(r.kind, r.now.v, r.med30)}</td></tr>`)
    .join('\n');
  const flagged = rows.filter((r) => r.flag).length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nightly perf trends</title>
<style>
:root { --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781; --grid: #e1e0d9; --edge: #c3c2b7;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948; --flag: #d03b3b; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink2: #c3c2b7; --grid: #2c2c2a; --edge: #383835;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767; --flag: #e66767; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
header p { color: var(--ink2); margin: 4px 0; max-width: 70em; }
.controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 12px 0; }
input[type=search] { font: inherit; padding: 6px 8px; border: 1px solid var(--edge); border-radius: 6px; background: var(--surface); color: var(--ink); min-width: 16em; }
h2 { font-size: 15px; margin: 20px 0 8px; } h2::first-letter { text-transform: uppercase; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 10px; }
.chart { margin: 0; padding: 8px 10px; background: var(--surface); border: 1px solid var(--grid); border-radius: 8px; min-width: 0; }
.chart.moved { border-color: var(--flag); }
figcaption { font-size: 13px; overflow-wrap: anywhere; } .kind { color: var(--muted); font-size: 12px; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.grid line, line.grid { stroke: var(--grid); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 10px; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; } .band { stroke: none; opacity: 0.14; }
.dot { stroke: var(--surface); stroke-width: 1.5; } .hit { fill: transparent; } .pt:hover .dot { r: 5; }
${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `.s${i}.line { stroke: var(--s${i}); } .s${i}.band, .s${i} .dot, .sw.s${i} { fill: var(--s${i}); background: var(--s${i}); }`).join('\n')}
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink2); }
.key b { color: var(--ink); font-weight: 600; } .sw { display: inline-block; width: 10px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
.flag { color: var(--flag); font-style: normal; font-weight: 600; }
body.only-moved .chart:not(.moved) { display: none; } .chart.hidden { display: none; }
details { margin-top: 24px; } table { border-collapse: collapse; font-size: 12px; display: block; overflow-x: auto; }
td, th { padding: 3px 8px; border-bottom: 1px solid var(--grid); text-align: right; white-space: nowrap; } td:nth-child(2), th:nth-child(2) { text-align: left; }
</style></head>
<body>
<header>
<h1 style="font-size:18px;margin:0">Nightly perf trends</h1>
<p>${nights.length} ${nights.length === 1 ? 'night' : 'nights'}, ${nights[0].at.slice(0, 10)} to ${last.at.slice(0, 10)} (last at <code>${last.sha.slice(0, 12)}</code>, ${esc(Object.entries(last.meta ?? {}).map(([k, v]) => `${k} ${v}`).join(', '))}; ${esc(`${last.runner.cores} × ${last.runner.cpu}`)}). A dot is a night's median, the band its runs from lowest to highest. ${flagged} moved past their threshold on the last night (a time 15% from the 7 nights before, a count outside what their runs came to): outlined.</p>
</header>
<div class="controls"><input type="search" placeholder="Filter, e.g. cold or typing" aria-label="Filter charts"><label><input type="checkbox" id="moved"> Only what moved</label></div>
${charts(nights, rows)}
<details><summary>The last night as a table (${rows.length})</summary>
<table><thead><tr><th></th><th>metric</th><th>kind</th><th>last</th><th>its runs</th><th>7-night median</th><th>change</th><th>30-night median</th><th>change</th></tr></thead><tbody>
${table}
</tbody></table></details>
<script>
const q = document.querySelector('input[type=search]');
q.addEventListener('input', () => { const s = q.value.trim().toLowerCase(); for (const f of document.querySelectorAll('.chart')) f.classList.toggle('hidden', !!s && !f.dataset.name.includes(s)); });
document.getElementById('moved').addEventListener('change', (e) => document.body.classList.toggle('only-moved', e.target.checked));
</script>
</body></html>
`;
}

// ------------------------------------------------------------------

const cmd = args[0];
if (cmd === 'night') {
  const n = night();
  if (!Object.keys(n.metrics).length) throw new Error(`no metrics in ${opt('dir', 'out')}/*.json`);
  console.log(JSON.stringify(n));
} else if (cmd === 'report') {
  const nights = load();
  if (!nights.length) {
    console.log('no history yet');
    process.exit(0);
  }
  const rows = rowsOf(nights);
  const md = markdown(nights, rows);
  const summary = opt('summary', process.env.GITHUB_STEP_SUMMARY ?? '');
  if (summary) writeFileSync(summary, md + '\n', { flag: 'a' });
  else console.log(md);
  if (opt('html')) writeFileSync(opt('html'), html(nights, rows));
} else {
  console.error('usage: bun scripts/perf-trend.ts night --dir <out> [--meta k=v] | report [--history <file>] [--summary <file>] [--html <file>]');
  process.exit(2);
}
