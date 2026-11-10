/**
 * The stress run (.github/workflows/stress.yml, nightly; docs/testing.md "Flaky tests"): the hub's suite many times over
 * on parallel workers, to find the tests that fail now and then. It lists each failing test with how many of its runs
 * failed, and on GitHub Actions writes that table to the job summary. Exits 1 when any run failed.
 *
 *   bun scripts/stress.ts                                    # --rerun-each=15 --parallel=4
 *   bun scripts/stress.ts --rerun-each=3 --parallel=8        # fewer runs, more workers
 *   bun scripts/stress.ts --rerun-each=50 -- test/sync.test.ts  # after --: more for bun test (files, -t)
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const own = dash < 0 ? args : args.slice(0, dash);
const extra = dash < 0 ? [] : args.slice(dash + 1);
const opt = (name: string, fallback: number) => {
  const a = own.find((x) => x.startsWith(`--${name}=`));
  const n = a ? Number(a.split('=')[1]) : fallback;
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} wants a whole number, got ${a}`);
  return n;
};
const runs = opt('rerun-each', 15);
const workers = opt('parallel', 4);

const cmd = ['bun', 'test', `--rerun-each=${runs}`, `--parallel=${workers}`, ...extra];
const cwd = join(import.meta.dir, '../packages/hub');
console.log(`== packages/hub: ${cmd.join(' ')}`);
const start = performance.now();
// bun test reports on stderr: both, in the order written, shown as they come and kept.
const proc = Bun.spawn(['sh', '-c', 'exec "$@" 2>&1', 'sh', ...cmd], { cwd, stdout: 'pipe' });
let out = '';
const dec = new TextDecoder();
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const s = dec.decode(value, { stream: true });
  process.stdout.write(s);
  out += s;
}
const code = await proc.exited;
const mins = ((performance.now() - start) / 60_000).toFixed(1);

/** Failing tests by file and name, with how many runs failed; a hook that timed out is said so. */
function failures(log: string): Map<string, number> {
  const found = new Map<string, number>();
  let file = '';
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^(\S+\.test\.tsx?):(?: \(run #\d+\))?$/);
    if (header) file = header[1];
    const m = lines[i].match(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/);
    if (!m) continue;
    const hook = /hook timed out/.test(lines[i + 1] ?? '') ? ' (a hook timed out)' : '';
    const key = `${file ? `${file}: ` : ''}${m[1]}${hook}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  return found;
}

const failed = [...failures(out)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const total = (word: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${word}$`, 'm'))?.[1] ?? 0);
const head = `${runs} runs of each hub test file on ${workers} workers: ${total('pass')} passed, ${total('fail')} failed, ${total('skip')} skipped, in ${mins} min`;
const table = failed.length ? ['| Failed runs | Test |', '|---:|---|', ...failed.map(([t, n]) => `| ${n} of ${runs} | ${t.replace(/\|/g, '\\|')} |`)].join('\n') : '';
const verdict =
  code === 0 ? 'No test failed.' : failed.length ? `${failed.length} test(s) failed at least once. Fix each (docs/testing.md); never retry.` : `bun test exited ${code} with no failing test named: see the log.`;

console.log(`\n${head}\n${verdict}${table ? `\n\n${table}` : ''}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Stress run\n\n${head}.\n\n${verdict}\n\n${table}\n`);
process.exit(code === 0 ? 0 : 1);
