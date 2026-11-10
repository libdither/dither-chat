/**
 * What CI must run for a set of changed paths. Docs-only changes (any *.md, anything under docs/) and changes only to
 * the Android app skip typecheck, tests and the web build; anything else, or a list that is empty, runs everything.
 *
 *   bun scripts/ci-changes.ts README.md docs/sync.md        # paths as arguments
 *   git diff --name-only origin/main... | bun scripts/ci-changes.ts
 *   bun scripts/ci-changes.ts --github                       # in CI: writes code=true|false to $GITHUB_OUTPUT
 *
 * With --github, a pull request is judged by what its merge commit changes (checkout with fetch-depth: 2); a push or
 * a manual run always runs everything.
 */
import { appendFileSync } from 'node:fs';

/** Paths that cannot change what typecheck, tests or the web build see. */
const SKIPPABLE: [string, RegExp][] = [
  ['docs', /^docs\/|\.md$/],
  ['android', /^apps\/android\/|^\.github\/workflows\/android\.yml$/],
];

/** Whether typecheck, tests and the web build must run, and why. */
export function decide(paths: string[]): { code: boolean; reason: string } {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  if (!files.length) return { code: true, reason: 'no changed paths known: running everything' };
  const kinds = new Set<string>();
  for (const f of files) {
    const kind = SKIPPABLE.find(([, re]) => re.test(f))?.[0];
    if (!kind) return { code: true, reason: `${f} may affect the code: running everything` };
    kinds.add(kind);
  }
  return { code: false, reason: `only ${[...kinds].join(' and ')} changed: skipping typecheck, tests and the web build` };
}

function git(...args: string[]): string | null {
  const r = Bun.spawnSync(['git', ...args], { stderr: 'pipe' });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let result: { code: boolean; reason: string };
  if (args[0] === '--github') {
    const event = process.env.GITHUB_EVENT_NAME;
    if (event !== 'pull_request') result = { code: true, reason: `${event ?? 'unknown'} event: running everything` };
    else {
      // The checkout is the PR's merge commit; its first parent is the base branch it would merge into.
      const out = git('diff', '--name-only', 'HEAD^1', 'HEAD');
      result = out === null ? { code: true, reason: 'could not diff the merge commit: running everything' } : decide(out.split('\n'));
      if (out !== null) console.log(out.trim() || '(no changed paths)');
    }
    const file = process.env.GITHUB_OUTPUT;
    if (file) appendFileSync(file, `code=${result.code}\n`);
  } else {
    const paths = args.length ? args : process.stdin.isTTY ? [] : (await Bun.stdin.text()).split('\n');
    result = decide(paths);
  }
  console.log(`code=${result.code}: ${result.reason}`);
}
