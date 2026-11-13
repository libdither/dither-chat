/**
 * What the hub's trace says (docs/tracing.md). Reads traces/hub.trace.ndjson and its rotated files, and
 * traces/event-loop-stalls.ndjson, straight from the data directory, so it works while the hub is stuck or stopped.
 *
 *   bun scripts/trace-summary.ts                       # per span name: count, rate, p50, p90, p99, max, failed (last hour)
 *   bun scripts/trace-summary.ts --since 6h --name command
 *   bun scripts/trace-summary.ts --slow 20             # the 20 slowest spans, with their trace ids
 *   bun scripts/trace-summary.ts --failed              # every failed span
 *   bun scripts/trace-summary.ts --trace <traceId>     # one trace as a tree, each span at its offset
 *   bun scripts/trace-summary.ts --stalls              # holds of the event loop: what was on the thread, CPU or waiting
 *   bun scripts/trace-summary.ts --json ...            # the same as JSON, for a script or an agent
 *
 * The data directory is --data, else $DITHER_DATA, else the repo's .data. --since takes 90s, 30m, 6h, 2d or "all".
 * dither-accounts' manager writes its spans and stalls the same way (with the Discord extractor's spans in them, children
 * of the hub's): its traces directory is read too, from --accounts-data, else $DITHER_ACCOUNTS_DATA, else
 * ~/.local/share/dither-accounts when it is there, so one trace shows hub, manager and adapter together.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { SpanRecord } from '../packages/hub/src/trace.ts';
import type { StallRecord } from '../packages/hub/src/stalls.ts';

/** Every line of `path` and its rotated files (path.1 is the newest of them) whose time is at or after `sinceMs`. */
export function readNdjson<T>(path: string, sinceMs: number, time: (r: T) => number): T[] {
  const files = [path];
  for (let i = 1; existsSync(`${path}.${i}`); i++) files.push(`${path}.${i}`);
  const out: T[] = [];
  for (const f of files.reverse()) {
    if (!existsSync(f) || statSync(f).mtimeMs < sinceMs) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as T;
        if (time(r) >= sinceMs) out.push(r);
      } catch {}
    }
  }
  return out;
}

/** The live files in a traces directory whose names end in `suffix` (their rotated ones are read with them). */
const named = (dir: string, suffix: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(suffix)).map((n) => join(dir, n)) : []);

/** Every span in these traces directories: the hub's, the manager's. */
export const readSpans = (dirs: string | string[], sinceMs: number) =>
  [dirs].flat().flatMap((d) => named(d, '.trace.ndjson').flatMap((f) => readNdjson<SpanRecord>(f, sinceMs, (r) => r.startMs)));
/** Every stall in them, each with the process it held (`hub`, `manager`: its data directory's name). */
export const readStalls = (dirs: string | string[], sinceMs: number) =>
  [dirs].flat().flatMap((d) => named(d, 'stalls.ndjson').flatMap((f) => readNdjson<StallRecord>(f, sinceMs, (r) => r.atMs).map((r) => ({ ...r, from: basename(dirname(d)) }))));

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0);

export interface NameSummary {
  name: string;
  count: number;
  perMin: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  totalMs: number;
  failed: number;
}

/** Per span name, the most time spent in all first. */
export function summarize(spans: SpanRecord[], minutes: number): NameSummary[] {
  const by = new Map<string, SpanRecord[]>();
  for (const s of spans) (by.get(s.name) ?? by.set(s.name, []).get(s.name)!).push(s);
  return [...by]
    .map(([name, xs]) => {
      const d = xs.map((x) => x.durationMs).sort((a, b) => a - b);
      return {
        name,
        count: xs.length,
        perMin: xs.length / Math.max(minutes, 1 / 60),
        p50: pct(d, 50),
        p90: pct(d, 90),
        p99: pct(d, 99),
        max: d[d.length - 1] ?? 0,
        totalMs: d.reduce((a, b) => a + b, 0),
        failed: xs.filter((x) => x.status === 'error').length,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** One trace as indented lines: offset from its first span, duration, name, attributes, events. */
export function traceTree(spans: SpanRecord[], traceId: string): string[] {
  const mine = spans.filter((s) => s.traceId === traceId).sort((a, b) => a.startMs - b.startMs);
  if (!mine.length) return [];
  const t0 = mine[0]!.startMs;
  const ids = new Set(mine.map((s) => s.spanId));
  const kids = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const s of mine) {
    if (s.parentSpanId && ids.has(s.parentSpanId)) (kids.get(s.parentSpanId) ?? kids.set(s.parentSpanId, []).get(s.parentSpanId)!).push(s);
    else roots.push(s);
  }
  const out: string[] = [];
  const walk = (s: SpanRecord, depth: number) => {
    const attrs = Object.entries(s.attrs).map(([k, v]) => `${k}=${v}`).join(' ');
    out.push(`${'  '.repeat(depth)}+${ms(s.startMs - t0)}  ${ms(s.durationMs)}  ${s.name}${s.status === 'error' ? ` FAILED: ${s.error}` : ''}${attrs ? `  ${attrs}` : ''}`);
    for (const e of s.events ?? []) out.push(`${'  '.repeat(depth + 1)}· +${ms(e.atMs)} ${e.name}`);
    for (const k of kids.get(s.spanId) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

export function parseSince(s: string, now = Date.now()): number {
  if (s === 'all') return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!m) throw new Error(`--since takes 90s, 30m, 6h, 2d or all, not ${s}`);
  return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

function main() {
  const args = process.argv.slice(2);
  const val = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (n: string) => args.includes(`--${n}`);
  const data = resolve(val('data') ?? process.env.DITHER_DATA ?? join(import.meta.dir, '../.data'));
  const dir = join(data, 'traces');
  const accountsData = val('accounts-data') ?? process.env.DITHER_ACCOUNTS_DATA ?? join(homedir(), '.local/share/dither-accounts');
  const dirs = [dir, ...(existsSync(join(accountsData, 'traces')) && resolve(accountsData) !== data ? [join(accountsData, 'traces')] : [])];
  const now = Date.now();
  const since = parseSince(val('since') ?? (has('trace') ? 'all' : '1h'), now);
  const minutes = (now - Math.max(since, 0)) / 6e4;
  const json = has('json');
  const name = val('name');
  const print = (x: unknown, lines: () => string[]) => console.log(json ? JSON.stringify(x, null, 1) : lines().join('\n'));

  if (!existsSync(dir)) {
    console.error(`no traces in ${dir} (is DITHER_TRACE=0, or is --data wrong?)`);
    process.exit(1);
  }

  if (has('stalls')) {
    const st = readStalls(dirs, since).sort((a, b) => b.heldMs - a.heldMs);
    const total = st.reduce((a, s) => a + s.heldMs, 0);
    print(st, () => [
      `${st.length} holds of the event loop, ${ms(total)} in all${since ? '' : ' (all kept)'}`,
      ...st.slice(0, Number(val('top') ?? 25)).map((s) => {
        const cpu = s.cpuUserMs !== undefined ? s.cpuUserMs + (s.cpuSystemMs ?? 0) : undefined;
        const kind = cpu === undefined ? '' : cpu >= s.heldMs * 0.7 ? ' cpu' : cpu <= s.heldMs * 0.3 ? ' waiting' : ' mixed';
        const faults = s.majorFaults ? ` ${s.majorFaults} major faults` : '';
        return `${new Date(s.atMs).toISOString()}  ${dirs.length > 1 ? `${s.from} ` : ''}${lpad(ms(s.heldMs), 8)}${kind}${cpu !== undefined ? ` (cpu ${ms(cpu)})` : ''}${faults}  ${s.work}${s.spans.length ? `  [${s.spans.map((x) => `${x.name} ${x.traceId.slice(0, 8)}`).join(', ')}]` : ''}`;
      }),
    ]);
    return;
  }

  let spans = readSpans(dirs, since);
  if (name) spans = spans.filter((s) => s.name.includes(name));

  const id = val('trace');
  if (id) {
    const full = spans.find((s) => s.traceId.startsWith(id))?.traceId ?? id;
    const tree = traceTree(spans, full);
    print(spans.filter((s) => s.traceId === full), () => (tree.length ? tree : [`no spans of trace ${id}`]));
    return;
  }

  if (has('failed') || has('slow')) {
    const list = has('failed') ? spans.filter((s) => s.status === 'error').sort((a, b) => b.startMs - a.startMs) : [...spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, Number(val('slow') ?? 20) || 20);
    print(list, () =>
      list.map((s) => {
        const attrs = Object.entries(s.attrs).map(([k, v]) => `${k}=${v}`).join(' ');
        return `${new Date(s.startMs).toISOString()}  ${lpad(ms(s.durationMs), 8)}  ${s.name}${s.status === 'error' ? ` FAILED: ${s.error}` : ''}  ${attrs}  trace ${s.traceId}`;
      }),
    );
    return;
  }

  const rows = summarize(spans, minutes).slice(0, Number(val('top') ?? 40));
  print(rows, () => [
    `${spans.length} spans${name ? ` named *${name}*` : ''} in ${minutes >= 120 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`}, by total time`,
    `${pad('name', 44)} ${lpad('count', 7)} ${lpad('/min', 7)} ${lpad('p50', 8)} ${lpad('p90', 8)} ${lpad('p99', 8)} ${lpad('max', 8)} ${lpad('total', 9)} ${lpad('failed', 6)}`,
    ...rows.map((r) => `${pad(r.name, 44)} ${lpad(String(r.count), 7)} ${lpad(r.perMin.toFixed(1), 7)} ${lpad(ms(r.p50), 8)} ${lpad(ms(r.p90), 8)} ${lpad(ms(r.p99), 8)} ${lpad(ms(r.max), 8)} ${lpad(ms(r.totalMs), 9)} ${lpad(String(r.failed || ''), 6)}`),
  ]);
}

if (import.meta.main) main();
