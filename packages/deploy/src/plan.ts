/**
 * What the deployer (deployer.ts, docs/deploy.md "Deploying itself") decides, with no git, network or systemd in it:
 * which commit of a branch to ship, and what to tell you about it.
 */

/** A commit on the branch, newest first, with its CI `check` run. */
export interface Candidate {
  sha: string;
  /** The `check` run on this commit: success, failure (or cancelled), still running, or none at all yet. */
  check: 'success' | 'failure' | 'pending' | 'none';
  /** The pull request it came from, when that has the `hold-deploy` label: it, and all after it, wait for a hand. */
  held?: number;
}

export type Pick = { ship: string } | { wait: string } | { none: string; held?: number };

/**
 * The commit to ship: the newest one whose `check` passed, if it is newer than what runs and has not failed here
 * before. `branch` is newest first and stops at (excludes) the deployed commit, or holds the whole recent history when
 * the deployed one is not on it. A newer commit still in CI is waited for only when nothing newer than the deployed one
 * has passed: a passed commit ships at once, and the next one follows when its CI is done. A pull request labelled
 * `hold-deploy` holds its commit and every one after it (they contain it) for a deploy by hand (deployer.ts ship).
 */
export function pick(all: Candidate[], failed: ReadonlySet<string>): Pick {
  if (!all.length) return { none: 'nothing new' };
  let oldestHeld = -1;
  for (let i = all.length - 1; i >= 0 && oldestHeld < 0; i--) if (all[i].held !== undefined) oldestHeld = i;
  const branch = oldestHeld >= 0 ? all.slice(oldestHeld + 1) : all;
  if (oldestHeld >= 0 && !branch.some((c) => c.check === 'success' && !failed.has(c.sha))) return { none: `#${all[oldestHeld].held} has the hold-deploy label`, held: all[oldestHeld].held };
  if (!branch.length) return { none: 'nothing new' };
  const ok = branch.find((c) => c.check === 'success' && !failed.has(c.sha));
  if (ok) return { ship: ok.sha };
  if (branch.some((c) => c.check === 'pending' || c.check === 'none')) return { wait: `${short(branch[0].sha)}'s CI has not finished` };
  return { none: branch.every((c) => failed.has(c.sha)) ? 'every new commit failed here before' : 'no new commit passed CI' };
}

export const short = (sha: string) => sha.slice(0, 7);

/** The pull requests in these commit subjects (a squash merge ends "(#123)"), oldest first, each once. */
export function pullsOf(subjects: string[]): { number: number; title: string }[] {
  const out: { number: number; title: string }[] = [];
  for (const s of [...subjects].reverse()) {
    const m = s.match(/^(.*?)\s*\(#(\d+)\)\s*$/);
    if (!m || out.some((p) => p.number === Number(m[2]))) continue;
    out.push({ number: Number(m[2]), title: m[1] });
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/**
 * A commit subject's first clause, short: up to its first "; ", or its second ": " (the first ends the area,
 * "Chats: …"): "Chats: where you came from guesses the route only when they are there".
 */
function gist(title: string): string {
  const first = title.split('; ')[0];
  const parts = first.split(': ');
  return clip((parts.length > 2 ? parts.slice(0, 2).join(': ') : first).trim(), 90);
}

/** What the notice says after a deploy: the app, the commit, and what came with it. */
export function deployedNotice(app: string, to: string, subjects: string[]): { title: string; body: string } {
  const pulls = pullsOf(subjects);
  const rest = subjects.length - pulls.length;
  const lines = pulls.map((p) => `#${p.number} ${gist(p.title)}`);
  if (rest > 0) lines.push(`${rest} other commit${rest === 1 ? '' : 's'}`);
  return { title: `Deployed ${app} ${short(to)}`, body: lines.join('\n') || 'No new commits on its branch.' };
}

/** What the notice says when a deploy did not hold: what was tried, why, and what runs now. */
export function failedNotice(app: string, tried: string, why: string, runs: string | null, rolledBack: boolean): { title: string; body: string } {
  const now = runs ? `${app} runs ${short(runs)}${rolledBack ? ' again' : ''}.` : `${app} may be down: check its service.`;
  return {
    title: rolledBack ? `Rolled back ${app} from ${short(tried)}` : `Did not deploy ${app} ${short(tried)}`,
    body: `${clip(why, 300)}\n${now} It will not try ${short(tried)} again; the next commit that passes CI is tried.`,
  };
}

/** A process as /proc shows it: its working directory and command line. */
export interface ProcView {
  cwd: string | null;
  cmdline: string[];
}

/**
 * The releases in `releasesDir` that a running process uses: its working directory or an argument of its command line
 * is inside one. dither-accounts' extractors outlive the manager's restarts (its docs/supervisor.md), so one started
 * many deploys ago still runs, and loads files, from the release it started in.
 */
export function releasesInUse(releasesDir: string, procs: ProcView[]): Set<string> {
  const base = releasesDir.replace(/\/+$/, '') + '/';
  const used = new Set<string>();
  const add = (p: string | null) => {
    if (!p || !p.startsWith(base)) return;
    const name = p.slice(base.length).split('/')[0];
    if (name && !name.startsWith('.')) used.add(name);
  };
  for (const p of procs) {
    add(p.cwd);
    for (const a of p.cmdline) add(a);
  }
  return used;
}
