/**
 * tsc on every project at once (each package with a tsconfig.json, and scripts/), as CI runs it: bun run typecheck.
 * Each project's output is printed whole when it finishes; fails if any project fails.
 *
 *   bun scripts/typecheck.ts              # every project
 *   bun scripts/typecheck.ts hub web      # some of them (a package name, or scripts)
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const all = [...readdirSync(join(root, 'packages')).filter((p) => existsSync(join(root, 'packages', p, 'tsconfig.json'))).sort().map((p) => `packages/${p}`), 'scripts'];
const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !all.some((p) => p === w || p === `packages/${w}`));
if (unknown.length) {
  console.error(`no such project: ${unknown.join(', ')} (have: ${all.join(', ')})`);
  process.exit(2);
}
const projects = wanted.length ? all.filter((p) => wanted.some((w) => p === w || p === `packages/${w}`)) : all;

const start = performance.now();
const results = await Promise.all(
  projects.map(async (p) => {
    const t = performance.now();
    const proc = Bun.spawn(['bunx', 'tsc', '-p', p, '--noEmit', ...(process.stdout.isTTY ? ['--pretty'] : [])], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const secs = ((performance.now() - t) / 1000).toFixed(1);
    console.log(`== ${p} ${code === 0 ? 'ok' : 'FAILED'} (${secs} s)`);
    if (out.trim() || err.trim()) console.log((out + err).trimEnd());
    return { p, code };
  }),
);
const failed = results.filter((r) => r.code !== 0).map((r) => r.p);
console.log(`\n${projects.length} projects in ${((performance.now() - start) / 1000).toFixed(1)} s`);
if (failed.length) {
  console.error(`typecheck failed: ${failed.join(', ')}`);
  process.exit(1);
}
