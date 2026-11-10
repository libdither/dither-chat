/**
 * Test hygiene (docs/testing.md "Flaky tests"), cheap enough for every CI run: bun run check:tests.
 *
 * Over every package's tests (*.test.ts and *.test.tsx, and whatever else is under a test/ directory):
 * - no `.only` (test.only, it.only, describe.only, under any name they are imported as);
 * - no retries: `{ retry: N }` in a test, `retry` in a bunfig.toml, `--retry` in a package.json, a workflow or a script;
 * - a `.skip` needs `// quarantine: <reason or issue>` on its line or the line above; skipIf(cond) is fine;
 * - a ratchet on real-time waits and wall-clock measurement, per file and kind, against scripts/test-waits.json:
 *     sleep        Bun.sleep(…) and Bun.sleepSync(…), but not Bun.sleep(0)
 *     setTimeout   setTimeout used as a wait: a resolver handed to it, or inside a new Promise
 *     performance  performance.now()
 *     dateNow      Date.now() less a variable (an elapsed time) or compared with one (a deadline)
 *   A count may go down (`--update` writes the lower one) but never up; a new file starts at 0. A line ending in
 *   `// wall-clock: <reason>` is not counted.
 *
 *   bun scripts/check-tests.ts            # check
 *   bun scripts/check-tests.ts --update   # write the counts that went down (never one that went up)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(ROOT, 'scripts/test-waits.json');
const SELF = 'scripts/check-tests.ts';
const KINDS = ['sleep', 'setTimeout', 'performance', 'dateNow'] as const;
type Kind = (typeof KINDS)[number];
type Counts = Partial<Record<Kind, number>>;

// ------------------------------------------------------------------ files

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split('\\').join('/');
const all = walk(join(ROOT, 'packages')).map(rel);
const testFiles = all.filter((p) => /\.(test\.tsx?)$/.test(p) || (/(^|\/)test\//.test(p) && /\.tsx?$/.test(p))).sort();
/** Where a `--retry` could be passed to bun test. */
const runFiles = [
  'package.json',
  ...all.filter((p) => /(^|\/)package\.json$/.test(p)),
  ...(existsSync(join(ROOT, '.github/workflows')) ? readdirSync(join(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`) : []),
  ...readdirSync(join(ROOT, 'scripts'))
    .filter((f) => /\.(ts|sh)$/.test(f))
    .map((f) => `scripts/${f}`)
    .filter((f) => f !== SELF),
];
const bunfigs = ['bunfig.toml', ...all.filter((p) => /(^|\/)bunfig\.toml$/.test(p))].filter((p) => existsSync(join(ROOT, p)));

// ------------------------------------------------------------------ reading code

/**
 * The code with comments and the insides of strings blanked out (template literals keep their `${…}`), line breaks
 * kept, so a match's line is the line it is on and nothing in a comment or a string counts.
 */
export function codeOnly(src: string): string {
  const out = src.split('');
  // What we are inside of: code (and how many braces deep), or a template literal.
  const stack: ('code' | 'tpl')[] = ['code'];
  const depth: number[] = [0];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (stack[stack.length - 1] === 'tpl') {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        depth.pop();
        i++;
      } else if (c === '$' && src[i + 1] === '{') {
        stack.push('code');
        depth.push(0);
        i += 2;
      } else {
        blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const to = end < 0 ? src.length : end;
      blank(i, to);
      i = to;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const to = end < 0 ? src.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '`') {
      stack.push('tpl');
      depth.push(0);
      i++;
    } else if (c === '{') {
      depth[depth.length - 1]++;
      i++;
    } else if (c === '}') {
      if (stack.length > 1 && depth[depth.length - 1] === 0) {
        // The end of a template's ${…}.
        stack.pop();
        depth.pop();
      } else depth[depth.length - 1]--;
      i++;
    } else i++;
  }
  return out.join('');
}

/** The names test, it and describe go by in this file: their own, and any `x as y` from bun:test. */
function testNames(src: string): string[] {
  const names = new Set(['test', 'it', 'describe']);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]bun:test['"]/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (alias && ['test', 'it', 'describe'].includes(orig)) names.add(alias.trim());
    }
  }
  return [...names];
}

const COUNTERS: Record<Kind, (code: string) => number> = {
  sleep: (code) => [...code.matchAll(/\bBun\.sleep(?:Sync)?\(\s*([^),]*)/g)].filter((m) => m[1].trim() !== '0').length,
  setTimeout: (code) => {
    let n = 0;
    // The global setTimeout only: a fake clock's clock.setTimeout(…) moves when the test moves it, so it is no wait.
    for (const m of code.matchAll(/(?<![\w$.])setTimeout\(\s*([^,]*?)\s*,/g)) {
      const arg = m[1];
      // A resolver handed over (setTimeout(r, 20)), or a timer inside a new Promise on the same line.
      if (/^[A-Za-z_$][\w$]*$/.test(arg) || /\bnew Promise\b/.test(code)) n++;
    }
    return n;
  },
  performance: (code) => code.match(/\bperformance\.now\(\)/g)?.length ?? 0,
  dateNow: (code) =>
    (code.match(/\bDate\.now\(\)\s*-\s*[a-z_$][\w$.]*\b(?!\s*[*/(])/g)?.length ?? 0) +
    (code.match(/\b[a-z_$][\w$.]*\s*-\s*Date\.now\(\)/g)?.length ?? 0) +
    (code.match(/\bDate\.now\(\)\s*[<>]=?\s*[a-z_$]/g)?.length ?? 0),
};

interface Problem {
  file: string;
  line: number;
  what: string;
}

/** Everything one test file breaks, and its counts. */
export function scan(file: string, src: string): { problems: Problem[]; counts: Counts } {
  const problems: Problem[] = [];
  const counts: Counts = {};
  const raw = src.split('\n');
  const code = codeOnly(src).split('\n');
  const names = testNames(src).map((n) => n.replace(/\$/g, '\\$')).join('|');
  const only = new RegExp(`\\b(?:${names})\\s*\\.\\s*only\\b`);
  const skip = new RegExp(`\\b(?:${names})\\s*\\.\\s*skip\\b(?!If)`);
  const quarantined = (i: number) => [raw[i], raw[i - 1] ?? ''].some((l) => /\/\/\s*quarantine:\s*\S/.test(l));
  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    if (only.test(line)) problems.push({ file, line: i + 1, what: '.only: it would run this test alone and skip the rest' });
    if (skip.test(line) && !quarantined(i)) problems.push({ file, line: i + 1, what: '.skip without a `// quarantine: <reason or issue>` comment (on its line or the line above)' });
    if (/\bretry\s*:\s*[^\s,}]/.test(line)) problems.push({ file, line: i + 1, what: 'a retry: fix the test, or quarantine it' });
    if (/\/\/\s*wall-clock:\s*\S/.test(raw[i])) continue;
    for (const k of KINDS) {
      const n = COUNTERS[k](line);
      if (n) counts[k] = (counts[k] ?? 0) + n;
    }
  }
  return { problems, counts };
}

// ------------------------------------------------------------------ the check

const update = process.argv.includes('--update');
const problems: Problem[] = [];
const current: Record<string, Counts> = {};
for (const f of testFiles) {
  const r = scan(f, readFileSync(join(ROOT, f), 'utf8'));
  problems.push(...r.problems);
  if (Object.keys(r.counts).length) current[f] = r.counts;
}
for (const f of runFiles) {
  const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
  lines.forEach((l, i) => /--retry\b/.test(l) && problems.push({ file: f, line: i + 1, what: '--retry: fix the test, or quarantine it' }));
}
for (const f of bunfigs) {
  const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
  lines.forEach((l, i) => /^\s*retry\s*=/.test(l) && problems.push({ file: f, line: i + 1, what: 'retry in bunfig: fix the test, or quarantine it' }));
}

// No baseline yet: --update starts one from what there is.
const first = !existsSync(BASELINE);
const baseline: Record<string, Counts> = first ? (update ? current : {}) : (JSON.parse(readFileSync(BASELINE, 'utf8')).files ?? {});
const up: string[] = [];
const down: string[] = [];
for (const f of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
  for (const k of KINDS) {
    const now = current[f]?.[k] ?? 0;
    const was = baseline[f]?.[k] ?? 0;
    if (now > was) up.push(`${f}: ${k} ${was} -> ${now}`);
    else if (now < was) down.push(`${f}: ${k} ${was} -> ${now}`);
  }
}

if (update) {
  // Down only: what went up stays at the baseline (and still fails below).
  const next: Record<string, Counts> = {};
  for (const f of Object.keys(current).sort()) {
    const c: Counts = {};
    for (const k of KINDS) {
      const n = Math.min(current[f][k] ?? 0, baseline[f]?.[k] ?? 0);
      if (n) c[k] = n;
    }
    if (Object.keys(c).length) next[f] = c;
  }
  // One line a file, so a change reads as one line in the diff.
  const lines = Object.entries(next).map(([f, c]) => `    ${JSON.stringify(f)}: ${JSON.stringify(c).replace(/":/g, '": ').replace(/,"/g, ', "')}`);
  const about = 'Real-time waits and wall-clock measurement in tests, per file: a count may go down, never up (scripts/check-tests.ts, docs/testing.md).';
  writeFileSync(BASELINE, `{\n  "about": ${JSON.stringify(about)},\n  "files": {\n${lines.join(',\n')}\n  }\n}\n`);
  console.log(`wrote ${rel(BASELINE)}: ${down.length} count(s) lowered`);
}

const total = (m: Record<string, Counts>) => Object.fromEntries(KINDS.map((k) => [k, Object.values(m).reduce((n, c) => n + (c[k] ?? 0), 0)]));
for (const p of problems) console.error(`${p.file}:${p.line}: ${p.what}`);
if (first && !update) console.error(`no baseline yet (${rel(BASELINE)}): bun run check:tests --update writes one`);
for (const u of up) console.error(`more real-time waits than allowed: ${u}. Wait on the event instead (docs/testing.md), or end the line with \`// wall-clock: <reason>\`.`);
if (down.length && !update) console.log(`fewer than the baseline (good): ${down.join('; ')}\n  lower it: bun run check:tests --update`);
console.log(`${testFiles.length} test files; real-time waits and clock reads: ${JSON.stringify(total(current))}`);
if (problems.length || up.length) {
  console.error(`check:tests failed: ${problems.length} problem(s), ${up.length} count(s) over the baseline`);
  process.exit(1);
}
console.log('check:tests passed');
