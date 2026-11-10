/**
 * Size and count budgets (docs/perf.md "Budgets"): ordinary tests measure what the hub sends a client
 * (packages/hub/test/budgets.test.ts) and what the web build weighs (packages/web/test/bundle.test.ts), and hold each
 * number to its budget in budgets.json at the repo root. Sizes and counts only, never times: they are the same on every
 * run and every machine.
 *
 * - Over a budget fails. Well under one prints a hint to lower it.
 * - `bun scripts/budgets.ts --update` (or BUDGETS_UPDATE=1 on one of the tests) writes the measured values and new
 *   budgets: bytes get 2% of headroom, counts none. A budget only goes down that way, unless `--reason "why"`
 *   (BUDGETS_REASON) says why it goes up; the reason is written beside it, so it shows in the diff.
 * - A budget raised since the base commit (BUDGETS_BASE, else HEAD^1 on GitHub Actions, else the merge base with
 *   origin/main) without a new reason fails.
 * - On GitHub Actions each test adds a table to the job summary ($GITHUB_STEP_SUMMARY).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BUDGETS_FILE = join(ROOT, 'budgets.json');
/** The tests that measure, by section. */
const TESTS: Record<string, { cwd: string; file: string }> = {
  hub: { cwd: 'packages/hub', file: 'test/budgets.test.ts' },
  web: { cwd: 'packages/web', file: 'test/bundle.test.ts' },
};
const RERUN = 'bun scripts/budgets.ts --update';
/** Headroom on bytes. Counts get none: the world is the same every run, so any change in a count is a real one. */
const BYTES_HEADROOM = 0.02;

export interface Measure {
  key: string;
  value: number;
  kind: 'bytes' | 'count';
}
export interface Entry {
  measured: number;
  budget: number;
  /** Why the budget was raised; required by the check when it goes up. */
  reason?: string;
}
type Section = Record<string, Entry>;
type File = Record<string, Section | string>;

const allowance = (m: Pick<Measure, 'value' | 'kind'>) => (m.kind === 'bytes' ? Math.ceil(m.value * (1 + BYTES_HEADROOM)) : m.value);

/** Well under: below what --update would set by more than the headroom again (bytes), or below at all (counts). */
const wellUnder = (m: Measure, e: Entry) => (m.kind === 'bytes' ? Math.ceil(m.value * (1 + 2 * BYTES_HEADROOM)) < e.budget : m.value < e.budget);

function readFile(text: string | null): File {
  return text ? (JSON.parse(text) as File) : {};
}

/** One line per entry, so a raised budget is a one-line diff with its reason on it. */
function format(f: File): string {
  const sections = Object.entries(f).map(([name, sec]) => {
    if (typeof sec === 'string') return `  ${JSON.stringify(name)}: ${JSON.stringify(sec)}`;
    const entries = Object.entries(sec).map(([k, e]) => `    ${JSON.stringify(k)}: { "measured": ${e.measured}, "budget": ${e.budget}${e.reason ? `, "reason": ${JSON.stringify(e.reason)}` : ''} }`);
    return `  ${JSON.stringify(name)}: {\n${entries.join(',\n')}\n  }`;
  });
  return `{\n${sections.join(',\n')}\n}\n`;
}

const sectionOf = (f: File, name: string): Section => {
  const s = f[name];
  return s && typeof s === 'object' ? s : {};
};

/** budgets.json as the base commit had it, or null when there is none to compare with (and why). */
function baseFile(): { file: File; ref: string } | { file: null; why: string } {
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  let ref = process.env.BUDGETS_BASE ?? '';
  if (!ref && process.env.GITHUB_ACTIONS) ref = 'HEAD^1';
  if (!ref) {
    const mb = git('merge-base', 'HEAD', 'origin/main');
    if (mb.exitCode !== 0) return { file: null, why: 'no origin/main to compare with' };
    ref = mb.stdout.toString().trim();
  }
  if (git('cat-file', '-e', `${ref}^{commit}`).exitCode !== 0) return { file: null, why: `${ref} is not in this checkout (a shallow clone needs fetch-depth: 2)` };
  const shown = git('show', `${ref}:budgets.json`);
  // No budgets.json there yet: everything is new.
  return { file: shown.exitCode === 0 ? readFile(shown.stdout.toString()) : {}, ref };
}

export interface Report {
  over: string[];
  raisedWithoutReason: string[];
  missing: string[];
  hints: string[];
  notes: string[];
}

/**
 * Compares a section's measures with budgets.json (or, with BUDGETS_UPDATE=1, writes them there first). Returns what
 * failed; the caller's test asserts on it so the failures read as one list.
 */
export function checkBudgets(section: string, measures: Measure[], opts: { title: string }): Report {
  const report: Report = { over: [], raisedWithoutReason: [], missing: [], hints: [], notes: [] };
  const seen = new Set<string>();
  for (const m of measures) {
    if (seen.has(m.key)) throw new Error(`${section}: ${m.key} measured twice`);
    seen.add(m.key);
  }
  const text = (() => {
    try {
      return readFileSync(BUDGETS_FILE, 'utf8');
    } catch {
      return null;
    }
  })();
  const file = readFile(text);
  let budgets = sectionOf(file, section);
  const update = process.env.BUDGETS_UPDATE === '1';
  const reason = process.env.BUDGETS_REASON?.trim() || undefined;
  const fmt = (n: number) => n.toLocaleString('en-US');

  if (update) {
    const next: Section = {};
    const refused: string[] = [];
    for (const m of measures) {
      const old = budgets[m.key];
      const fresh = allowance(m);
      if (!old) next[m.key] = { measured: m.value, budget: fresh };
      else if (m.value <= old.budget) {
        // Down to what the headroom allows, never up while it fits.
        next[m.key] = fresh < old.budget ? { measured: m.value, budget: fresh } : { ...old, measured: m.value };
      } else if (reason) next[m.key] = { measured: m.value, budget: fresh, reason };
      else {
        next[m.key] = old;
        refused.push(`${m.key}: ${fmt(m.value)} is over its budget of ${fmt(old.budget)}`);
      }
    }
    if (refused.length) {
      report.over.push(...refused.map((r) => `${r} (not raised: say why with --reason "…")`));
    }
    const out = format({ '//': 'Sizes and counts the tests hold the hub and the web build to: docs/perf.md, "Budgets".', ...file, [section]: next });
    if (out !== text) {
      writeFileSync(BUDGETS_FILE, out);
      report.notes.push(`wrote ${section} budgets to budgets.json`);
    }
    budgets = next;
  }

  for (const m of measures) {
    const e = budgets[m.key];
    if (!e) {
      report.missing.push(`${m.key} (${fmt(m.value)}) has no budget: add it with ${RERUN}`);
      continue;
    }
    if (m.value > e.budget) {
      if (!update) report.over.push(`${m.key}: ${fmt(m.value)} is over its budget of ${fmt(e.budget)} (+${fmt(m.value - e.budget)})`);
    } else if (wellUnder(m, e)) report.hints.push(`${m.key}: ${fmt(m.value)} is well under its budget of ${fmt(e.budget)}; lower it with ${RERUN}`);
  }
  for (const k of Object.keys(budgets)) if (!seen.has(k)) report.hints.push(`${k} is no longer measured; ${RERUN} drops it`);

  // A raise needs a reason that the base did not have.
  const base = baseFile();
  if (base.file) {
    const was = sectionOf(base.file, section);
    for (const [k, e] of Object.entries(budgets)) {
      const b = was[k];
      if (b && e.budget > b.budget && (!e.reason || e.reason === b.reason))
        report.raisedWithoutReason.push(`${k}: raised from ${fmt(b.budget)} to ${fmt(e.budget)} since ${base.ref.slice(0, 12)} without a new "reason" beside it`);
    }
  } else report.notes.push(`raises not checked: ${base.why}`);

  summary(opts.title, measures, budgets, report);
  for (const h of report.hints) console.log(`budget hint: ${h}`);
  for (const n of report.notes) console.log(`budgets: ${n}`);
  return report;
}

/** Measured against budget, into the GitHub job summary when there is one. */
function summary(title: string, measures: Measure[], budgets: Section, report: Report) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (!out) return;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const rows = measures.map((m) => {
    const e = budgets[m.key];
    const state = !e ? 'no budget' : m.value > e.budget ? '**over**' : `${Math.round((m.value / e.budget) * 1000) / 10}%`;
    return `| \`${m.key}\` | ${fmt(m.value)} | ${e ? fmt(e.budget) : ''} | ${state} |`;
  });
  const failed = report.over.length + report.raisedWithoutReason.length + report.missing.length;
  const lines = [
    `### ${title}: ${failed ? `${failed} failing` : 'within budget'}`,
    '',
    '| | measured | budget | |',
    '|---|---:|---:|---|',
    ...rows,
    '',
    ...[...report.over, ...report.raisedWithoutReason, ...report.missing].map((x) => `- ${x}`),
    ...report.notes.map((n) => `- ${n}`),
    '',
  ];
  appendFileSync(out, lines.join('\n') + '\n');
}

/** Both tests, as CI runs them: `bun scripts/budgets.ts [--update [--reason "why"]]`. */
if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--reason');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (args.includes('--update')) env.BUDGETS_UPDATE = '1';
  if (at >= 0) env.BUDGETS_REASON = args[at + 1] ?? '';
  let failed = false;
  for (const [name, t] of Object.entries(TESTS)) {
    console.log(`\n== ${name}: ${t.cwd}/${t.file}`);
    const p = Bun.spawnSync(['bun', 'test', t.file], { cwd: join(ROOT, t.cwd), env, stdout: 'inherit', stderr: 'inherit' });
    failed ||= p.exitCode !== 0;
  }
  process.exit(failed ? 1 : 0);
}
