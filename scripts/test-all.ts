/**
 * Every package's tests, as CI runs them: bun scripts/test-all.ts (or bun run test). The packages run at the same time,
 * each one's output printed whole when it finishes, and the hub's files spread over --parallel workers.
 *
 *   bun scripts/test-all.ts                              # every package
 *   bun scripts/test-all.ts hub web                      # some of them
 *   bun scripts/test-all.ts --except hub                 # all but these
 *   bun scripts/test-all.ts hub -- --parallel=8 -t sync  # flags after -- go to each package's bun test
 *
 * One package alone streams its output. For the hub in one process: cd packages/hub && bun test.
 */
const packages = ['hub', 'protocol', 'web', 'adapter-discord', 'adapter-matrix', 'adapter-signal', 'adapter-whatsapp', 'desk'];
/** The hub's suite is the longest by far; its files are independent, so it runs them on worker processes. */
const HUB_FLAGS = ['--parallel=4'];

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const names = dash < 0 ? args : args.slice(0, dash);
const flags = dash < 0 ? [] : args.slice(dash + 1);
const except: string[] = [];
const wanted: string[] = [];
for (let i = 0; i < names.length; i++) {
  if (names[i] === '--except') except.push(...(names[++i] ?? '').split(','));
  else wanted.push(names[i]);
}
const unknown = [...wanted, ...except].filter((n) => !packages.includes(n));
if (unknown.length) {
  console.error(`no such package: ${unknown.join(', ')} (have: ${packages.join(', ')})`);
  process.exit(2);
}
const run = packages.filter((p) => (!wanted.length || wanted.includes(p)) && !except.includes(p));
const alone = run.length === 1;

const start = performance.now();
const results = await Promise.all(
  run.map(async (p) => {
    const t = performance.now();
    const own = p === 'hub' && !flags.some((f) => f.startsWith('--parallel')) ? HUB_FLAGS : [];
    const cmd = ['bun', 'test', ...own, ...flags];
    if (alone) console.log(`== packages/${p}: ${cmd.join(' ')}`);
    const cwd = new URL(`../packages/${p}/`, import.meta.url).pathname;
    // Several at once: each one's output is kept, stdout and stderr in the order written, and printed when it ends.
    const proc = alone ? Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' }) : Bun.spawn(['sh', '-c', 'exec "$@" 2>&1', 'sh', ...cmd], { cwd, stdout: 'pipe' });
    const [out, code] = await Promise.all([alone ? '' : new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    const secs = ((performance.now() - t) / 1000).toFixed(1);
    if (!alone) console.log(`\n== packages/${p}: ${cmd.join(' ')}\n${out.trimEnd()}`);
    console.log(`== packages/${p} ${code === 0 ? 'passed' : 'FAILED'} (${secs} s)`);
    return { p, code };
  }),
);
const failed = results.filter((r) => r.code !== 0).map((r) => r.p);
const secs = ((performance.now() - start) / 1000).toFixed(1);
if (failed.length) {
  console.error(`\nfailed: ${failed.join(', ')} (${secs} s)`);
  process.exit(1);
}
console.log(`\n${run.length === packages.length ? 'all packages' : run.join(', ')} passed (${secs} s)`);
