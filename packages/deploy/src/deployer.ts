/**
 * The deployer (docs/deploy.md "Deploying itself"): ships dither-chat and dither-accounts from their default branches
 * soon after each merge. The user timer dither-deploy.timer runs it about once a minute; one run looks at both apps and
 * ships what is new, dither-accounts first.
 *
 * Each app runs from a release folder of its own, `<root>/<app>/releases/<sha>`, a git worktree of the deployer's own
 * clone, through the `current` link its service's WorkingDirectory names. Nobody edits a release, so the files a service
 * runs are always the commit it started on (2026-11-13: an agent reset the shared checkout under the running hub).
 *
 * A run, per app: fetch; pick the newest commit whose CI `check` passed (plan.ts pick); build its release (bun install,
 * the web build); wait while a call is on; back up the hub's database; point `current` at the release and restart the
 * service; then the checks. If they fail, `current` goes back to the release before and the service restarts on it; the
 * commit is marked failed and never tried again. Either way the manager's notices say what happened (POST
 * /api/notices/local), and so your phone does.
 *
 * dither-accounts runs its public `master` with one private commit on top (the private remote's `live`): its release is
 * `live` with the picked `master` merged in, and once that holds, it is pushed back as `live`.
 *
 *   bun packages/deploy/src/deployer.ts            # one run (what the timer does)
 *   bun packages/deploy/src/deployer.ts --dry      # what it would do, changing nothing
 *   bun packages/deploy/src/deployer.ts init <app> <sha>   # make <sha> the app's current release without a restart
 *   bun packages/deploy/src/deployer.ts ship <app> <sha>   # deploy that branch commit now (checks and rollback as ever)
 *   touch <root>/<app>/hold                               # pause an app's deploys (write why in it)
 */
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Candidate, type CodeRestarts, codeRestartsOffline, codeRestartsProblem, codeRestartsSettled, codeRestartsUnfinished, deadlines, deployedNotice, failedNotice, interrupted, lockHeld, type Pending, pick, type ProcView, reexecFrom, releasesInUse, ROLLBACK_MS, short, timeToShip, unmarkedRelease } from './plan.ts';

const HOME = homedir();
const ROOT = process.env.DITHER_DEPLOY_ROOT ?? join(HOME, '.local/share/dither-deploy');
const HUB = process.env.DITHER_DEPLOY_HUB ?? 'http://127.0.0.1:8460';
const MANAGER = process.env.DITHER_DEPLOY_MANAGER ?? 'http://127.0.0.1:8486';
const HUB_DATA = process.env.DITHER_DEPLOY_HUB_DATA ?? join(HOME, '.local/share/dither-chat');
const MANAGER_DATA = process.env.DITHER_DEPLOY_MANAGER_DATA ?? join(HOME, '.local/share/dither-accounts');
/** Written in a release folder once its build is done: one without it is half built. */
const BUILT = '.deploy-built';
/** Releases kept besides the current and the one before it. */
const KEEP = 3;
/** How far back on the branch a commit to ship is looked for. */
const DEPTH = 30;
const dry = process.argv.includes('--dry');
/** dither-accounts' private remote (its `live` branch is master plus private commits); none: public master alone. */
const ACCOUNTS_PRIVATE = process.env.DITHER_DEPLOY_ACCOUNTS_PRIVATE?.trim() || null;

interface App {
  key: 'chat' | 'accounts';
  name: string;
  /** owner/name on GitHub, for the CI check. */
  repo: string;
  url: string;
  branch: string;
  /** A private branch the release is the branch merged into (dither-accounts' `live`). */
  overlay?: { remote: string; url: string; branch: string };
  unit: string;
  build: string[][];
  /**
   * Wait for the service to be up after a restart; throws why not. Every wait in it ends by the check's deadline
   * (`until`). `rollback`: the release before is back, so only that it runs is checked, not dither-accounts' restarts
   * for changed code.
   */
  up: (since: Since, o: { rollback: boolean }) => Promise<string | void>;
}

/** This run's time (plan.ts deadlines): set when it starts. */
const RUN = deadlines(Date.now());
/** When the check under way must be done by; every `until` in it stops there. */
let checkBy = RUN.check;

/** What the checks compare with: taken just before a restart. */
interface Since {
  at: number;
  restarts: number;
  online: number;
  hubLogSize: number;
}

const bun = process.execPath;
const APPS: App[] = [
  {
    key: 'accounts',
    name: 'dither-accounts',
    repo: 'libdither/dither-accounts',
    url: 'https://github.com/libdither/dither-accounts.git',
    branch: 'master',
    ...(ACCOUNTS_PRIVATE ? { overlay: { remote: 'private', url: ACCOUNTS_PRIVATE, branch: 'live' } } : {}),
    unit: 'dither-accounts.service',
    build: [[bun, 'install', '--frozen-lockfile'], [bun, 'run', 'web:build']],
    up: async (s, o) => {
      await until(() => health(`${MANAGER}/api/health`), 120_000, 'the manager to answer /api/health');
      // Extractors whose code changed restart one at a time per kind after the manager is up (its docs/supervisor.md).
      // Waited for while this check has time (leaving room for what follows); still restarting then is no failure: it
      // is said in the notice, and later crashes reach you through the manager's own notices.
      const settled = !o.rollback && (await untilOr(async () => codeRestartsSettled(await codeRestarts()), 1_800_000, checkBy - 7 * 60_000));
      await steady('dither-accounts.service', s);
      // A restarted extractor that crashed on the new code rolls the deploy back.
      if (!o.rollback) await codeRestartsHeld();
      // All done in time: each restarted one must be online, a minute's grace on (the manager stopped restarting a kind
      // whose restarted extractor did not come up: new code that does not run).
      if (settled) {
        let offline: string | null = null;
        const up = await untilOr(async () => !(offline = codeRestartsOffline(await codeRestarts())), 60_000);
        if (!up && offline) throw new Error(offline);
      }
      // The hub's accounts run under the manager: they come back online, but for those still restarting.
      const unfinished = o.rollback ? 0 : codeRestartsUnfinished(await codeRestarts().catch(() => null));
      await until(async () => (await onlineAccounts()) >= s.online - unfinished, 300_000, `the hub's accounts to be online again (${s.online} before${unfinished ? `, ${unfinished} still restarting` : ''})`);
      const still = o.rollback ? 0 : codeRestartsUnfinished(await codeRestarts().catch(() => null));
      if (still) return `${still} extractor${still === 1 ? ' was' : 's were'} still restarting for changed code when the check ended.`;
    },
  },
  {
    key: 'chat',
    name: 'dither-chat',
    repo: 'libdither/dither-chat',
    url: 'https://github.com/libdither/dither-chat.git',
    branch: 'main',
    unit: 'dither-chat.service',
    build: [[bun, 'install', '--frozen-lockfile'], [bun, 'run', 'web:build']],
    up: async (s) => {
      // A schema change copies the database first (about 20 s on a 2 GB database), then the hub says it is ready.
      await until(async () => (await hubLogSince(s.hubLogSize)).includes('startup: ready'), 300_000, 'the hub to log "startup: ready"');
      await until(() => health(`${HUB}/api/health`), 60_000, 'the hub to answer /api/health');
      await steady('dither-chat.service', s);
      // Linked to the manager: a hub that cannot reach it still lists its accounts online from before (2026-11-13: it
      // could not load the manager's client from a release folder, and nothing else showed it). A fresh hub's notices
      // say "unreachable" until it has connected and read its grants.
      await until(hubLinked, 120_000, 'the hub to connect to dither-accounts (its notices access to leave "unreachable")');
      // Accounts it restarts after gaps (one per kind at a time) come back first; those still waiting are not counted.
      await untilOr(async () => (await hubGapRestarts()) === 0, 180_000);
      const gaps = await hubGapRestarts().catch(() => 0);
      await until(async () => (await onlineAccounts()) >= s.online - gaps, 180_000, `its accounts to be online again (${s.online} before${gaps ? `, ${gaps} still restarting after gaps` : ''})`);
      if (gaps) return `${gaps} account${gaps === 1 ? ' was' : 's were'} still being restarted after gaps when the check ended.`;
    },
  },
];

// ---------------------------------------------------------------- small helpers

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    appendFileSync(join(ROOT, 'deploy.log'), `${line}\n`);
  } catch {}
}

function run(cmd: string[], cwd?: string, timeoutMs = 600_000): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, env: process.env });
  if (r.exitCode !== 0) {
    const err = `${r.stderr.toString()}\n${r.stdout.toString()}`.trim().split('\n').slice(-8).join('\n');
    throw new Error(`${cmd.map((c) => c.replace(HOME, '~')).join(' ')} failed (${r.exitCode ?? 'timed out'}): ${err}`);
  }
  return r.stdout.toString().trim();
}
const tryRun = (cmd: string[], cwd?: string) => {
  try {
    return run(cmd, cwd);
  } catch {
    return null;
  }
};
const git = (dir: string, ...args: string[]) => run(['git', '-C', dir, ...args]);

async function until(f: () => boolean | Promise<boolean>, ms: number, what: string) {
  // Never past the check's deadline: the unit kills a run that takes too long (plan.ts deadlines).
  ms = Math.max(1000, Math.min(ms, checkBy - Date.now()));
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return;
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
}

/** Like `until`, but running out of time (by `by` at the latest) is an answer, not a failure: false. */
async function untilOr(f: () => boolean | Promise<boolean>, ms: number, by = checkBy): Promise<boolean> {
  const end = Math.min(Date.now() + ms, by, checkBy);
  for (;;) {
    try {
      if (await f()) return true;
    } catch {}
    if (Date.now() + 2000 > end) return false;
    await Bun.sleep(2000);
  }
}

/** Restarts the hub still has to do after gaps (its /api/health; 0 from a hub before them). */
async function hubGapRestarts(): Promise<number> {
  const r = await fetch(`${HUB}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return Number(((await r.json()) as { gapRestarts?: number }).gapRestarts ?? 0) || 0;
}

/** At most `ms`, and never past the check's deadline. */
const capped = (ms: number) => Math.max(1000, Math.min(ms, checkBy - Date.now()));

async function health(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return r.ok;
}

/**
 * No extractor restarted for changed code crashed since: asked again for up to 90 s (a moment of not answering is no
 * code problem; neither is one still restarting), then the last thing heard is why not.
 */
async function codeRestartsHeld() {
  let last = 'dither-accounts did not answer /api/health';
  try {
    await until(async () => {
      try {
        const problem = codeRestartsProblem(await codeRestarts());
        if (!problem) return true;
        last = problem;
      } catch (e) {
        last = `dither-accounts did not answer /api/health (${(e as Error).message})`;
      }
      return false;
    }, 90_000, 'the restarted extractors to hold');
  } catch {
    throw new Error(last);
  }
}

/** dither-accounts' restarts for changed code (counts only), or null from a manager that has none. */
async function codeRestarts(): Promise<CodeRestarts | null> {
  const r = await fetch(`${MANAGER}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return ((await r.json()) as { codeRestarts?: CodeRestarts }).codeRestarts ?? null;
}

async function onlineAccounts(): Promise<number> {
  const r = await fetch(`${HUB}/api/bootstrap`, { signal: AbortSignal.timeout(capped(60_000)) });
  if (!r.ok) throw new Error(`bootstrap ${r.status}`);
  const b = (await r.json()) as { accounts: { status?: string }[] };
  return b.accounts.filter((a) => a.status === 'online').length;
}

/** Whether the hub is connected to the manager: its notices' access is known (granted, pending or denied). */
async function hubLinked(): Promise<boolean> {
  const r = await fetch(`${HUB}/api/notices?limit=1`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return true; // notices off on this hub: nothing to tell by
  return ((await r.json()) as { access?: string }).access !== 'unreachable';
}

async function callsOn(): Promise<number> {
  try {
    const r = await fetch(`${HUB}/api/calls`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as unknown[]).length : 0;
  } catch {
    return 0;
  }
}

const restarts = (unit: string) => Number(tryRun(['systemctl', '--user', 'show', '-p', 'NRestarts', '--value', unit]) ?? 0);
const active = (unit: string) => tryRun(['systemctl', '--user', 'is-active', unit]) === 'active';

/** Up, and not crashing: still active and not restarted by systemd since, 20 s on. */
async function steady(unit: string, s: Since) {
  await Bun.sleep(Math.max(0, Math.min(20_000, checkBy - Date.now())));
  if (!active(unit)) throw new Error(`${unit} is not active`);
  if (restarts(unit) > s.restarts) throw new Error(`${unit} crashed and restarted ${restarts(unit) - s.restarts} times`);
}

const hubLog = join(HUB_DATA, 'hub.log');
const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
async function hubLogSince(offset: number): Promise<string> {
  const f = Bun.file(hubLog);
  return f.size > offset ? await f.slice(offset).text() : '';
}

/** Says it through the manager's notices (dither-accounts notices.ts local), so it reaches the inbox and the phone. */
async function notice(id: string, title: string, body: string, urgency: 'high' | 'normal' | 'low', context: string) {
  log(`notice ${urgency}: ${title} | ${body.replace(/\n/g, ' | ')}`);
  if (dry) return;
  await postNotice(id, title, body, urgency, context);
  // Right after the hub restarts, a notice can come between its catch-up and its live connection, and never reach it
  // (2026-11-13). The same id again replaces it at the manager and reaches the hub as new.
  const reached = async () => {
    const r = await fetch(`${HUB}/api/notices?limit=30`, { signal: AbortSignal.timeout(10_000) });
    const b = (await r.json()) as { items?: { title?: string }[] };
    return (b.items ?? []).some((n) => n.title === title);
  };
  try {
    await until(reached, 45_000, 'the notice in the hub');
  } catch {
    log('  the notice did not reach the hub: posting it again');
    await postNotice(id, title, body, urgency, context);
  }
}

async function postNotice(id: string, title: string, body: string, urgency: 'high' | 'normal' | 'low', context: string) {
  try {
    const token = readFileSync(join(MANAGER_DATA, 'cli.token'), 'utf8').trim();
    const r = await fetch(`${MANAGER}/api/notices/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dither-accounts-cli': token },
      body: JSON.stringify({ id, source: 'deployer', title, body, urgency, context }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) log(`  the manager did not take the notice: ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    log(`  no notice: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- state

interface State {
  /** Commits that failed here (built, or ran), by app: never tried again. */
  failed: Record<string, Record<string, string>>;
  /** dither-accounts: the `master` commit each release was made of (its own sha is the merge onto `live`). */
  branchOf: Record<string, string>;
  /** What GitHub said of a commit once it was final (its CI done, its pull request's labels), so it is asked once. */
  known: Record<string, { check: 'success' | 'failure'; held: number }>;
  /** The hold already told about, by app (one notice per held pull request). */
  toldHeld: Record<string, number>;
  /** A release whose check is under way, by app (plan.ts Pending): one left here by a killed run is rolled back. */
  pending: Record<string, Pending>;
}
const stateFile = join(ROOT, 'state.json');
function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<State>;
    return { failed: s.failed ?? {}, branchOf: s.branchOf ?? {}, known: s.known ?? {}, toldHeld: s.toldHeld ?? {}, pending: s.pending ?? {} };
  } catch {
    return { failed: {}, branchOf: {}, known: {}, toldHeld: {}, pending: {} };
  }
}
function saveState(s: State) {
  if (dry) return;
  // The newest 300 commits known are plenty: older ones are never candidates again.
  const known = Object.entries(s.known);
  if (known.length > 300) s.known = Object.fromEntries(known.slice(-300));
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}

// ---------------------------------------------------------------- releases

const dirOf = (a: App) => join(ROOT, a.key);
const repoOf = (a: App) => join(dirOf(a), 'repo');
const releaseOf = (a: App, sha: string) => join(dirOf(a), 'releases', sha);
function linked(a: App, name: 'current' | 'previous'): string | null {
  const l = join(dirOf(a), name);
  try {
    return lstatSync(l).isSymbolicLink() ? readlinkSync(l).split('/').pop()! : null;
  } catch {
    return null;
  }
}
/** Points a link at a release, atomically (a rename over the old link). */
function link(a: App, name: 'current' | 'previous', sha: string) {
  const l = join(dirOf(a), name);
  rmSync(`${l}.new`, { force: true });
  symlinkSync(join('releases', sha), `${l}.new`);
  renameSync(`${l}.new`, l);
}

/** The deployer's own clone of the app, made once, with the private remote where the app has one. */
function clone(a: App) {
  mkdirSync(join(dirOf(a), 'releases'), { recursive: true });
  if (!existsSync(join(repoOf(a), '.git'))) run(['git', 'clone', '-q', '--no-checkout', a.url, repoOf(a)], undefined, 900_000);
  if (a.overlay && !tryRun(['git', '-C', repoOf(a), 'remote', 'get-url', a.overlay.remote])) git(repoOf(a), 'remote', 'add', a.overlay.remote, a.overlay.url);
}

function fetchAll(a: App) {
  git(repoOf(a), 'fetch', '-q', 'origin', `+refs/heads/${a.branch}:refs/remotes/origin/${a.branch}`);
  if (a.overlay) git(repoOf(a), 'fetch', '-q', a.overlay.remote, `+refs/heads/${a.overlay.branch}:refs/remotes/${a.overlay.remote}/${a.overlay.branch}`);
}

/** The CI `check` run of a commit. */
function ciOf(a: App, sha: string): Candidate['check'] {
  const out = tryRun(['gh', 'api', `repos/${a.repo}/commits/${sha}/check-runs?check_name=check`, '-q', '[.check_runs[] | .status + ":" + (.conclusion // "")] | join(",")']);
  if (out === null || out === '') return 'none';
  const runs = out.split(',');
  if (runs.some((r) => r === 'completed:success')) return 'success';
  if (runs.some((r) => !r.startsWith('completed'))) return 'pending';
  return 'failure';
}

/** The pull request a commit came from, if it has the `hold-deploy` label: its number, else 0. */
function heldOf(a: App, sha: string): number {
  const out = tryRun(['gh', 'api', `repos/${a.repo}/commits/${sha}/pulls`, '-q', '[.[] | select(any(.labels[]; .name == "hold-deploy")) | .number][0] // 0']);
  return Number(out ?? 0) || 0;
}

/** A commit as the pick needs it: its CI and its hold, asked of GitHub until the CI is final, then remembered. */
function candidate(a: App, sha: string, state: State): Candidate {
  const k = state.known[sha];
  if (k) return { sha, check: k.check, ...(k.held ? { held: k.held } : {}) };
  const check = ciOf(a, sha);
  const held = heldOf(a, sha);
  if (check === 'success' || check === 'failure') state.known[sha] = { check, held };
  return { sha, check, ...(held ? { held } : {}) };
}

/** The branch's commits newer than the one deployed (the recent ones when it is not on the branch), newest first. */
function candidates(a: App, deployedBranchSha: string | null, state: State): Candidate[] {
  const range = deployedBranchSha && tryRun(['git', '-C', repoOf(a), 'merge-base', '--is-ancestor', deployedBranchSha, `origin/${a.branch}`]) !== null ? `${deployedBranchSha}..origin/${a.branch}` : `origin/${a.branch}`;
  const shas = git(repoOf(a), 'rev-list', '--first-parent', `-n${DEPTH}`, range).split('\n').filter(Boolean);
  return shas.map((sha) => candidate(a, sha, state));
}

/**
 * Makes the release for a branch commit and builds it; its sha (for dither-accounts, the merge onto `live`). `running`:
 * the release that runs now. dither-accounts' release is built on `live`, unless `live` holds branch commits newer than
 * the picked one (someone merged master into it by hand before CI passed): then on what runs, so nothing ships ahead
 * of its CI (2026-11-13, the first run shipped c5c3dbb that way).
 */
function makeRelease(a: App, branchSha: string, running: string): string {
  const tmp = join(dirOf(a), 'releases', `.new-${short(branchSha)}`);
  rmSync(tmp, { recursive: true, force: true });
  tryRun(['git', '-C', repoOf(a), 'worktree', 'prune']);
  let sha = branchSha;
  if (a.overlay) {
    const live = `${a.overlay.remote}/${a.overlay.branch}`;
    const liveHas = git(repoOf(a), 'merge-base', live, `origin/${a.branch}`);
    const ahead = tryRun(['git', '-C', repoOf(a), 'merge-base', '--is-ancestor', liveHas, branchSha]) === null;
    const base = ahead ? running : live;
    if (ahead) log(`${a.name}: ${live} holds ${a.branch} ${short(liveHas)}, newer than ${short(branchSha)}: building on what runs (${short(running)})`);
    git(repoOf(a), 'worktree', 'add', '-q', '--detach', tmp, base);
    try {
      git(tmp, 'merge', '-q', '--no-edit', '-m', `Merge ${a.branch} ${short(branchSha)} into ${a.overlay.branch} (deployer)`, branchSha);
    } catch (e) {
      tryRun(['git', '-C', tmp, 'merge', '--abort']);
      git(repoOf(a), 'worktree', 'remove', '--force', tmp);
      throw new Error(`${a.branch} ${short(branchSha)} does not merge into ${base === live ? live : short(base)}: ${(e as Error).message.slice(0, 300)}`);
    }
    sha = git(tmp, 'rev-parse', 'HEAD');
  } else git(repoOf(a), 'worktree', 'add', '-q', '--detach', tmp, branchSha);
  const dest = releaseOf(a, sha);
  if (existsSync(join(dest, BUILT))) {
    git(repoOf(a), 'worktree', 'remove', '--force', tmp);
    return sha;
  }
  if (existsSync(dest)) {
    // No marker: a release from before it (what runs now, the one before, one an outlived extractor runs from, or with
    // its dependencies installed) is marked, never removed; a half-built one nothing uses is made again.
    const inUse = [linked(a, 'current'), linked(a, 'previous')].includes(sha) || releasesInUse(join(dirOf(a), 'releases'), processes()).has(sha);
    if (unmarkedRelease(inUse, existsSync(join(dest, 'node_modules'))) === 'mark') {
      writeFileSync(join(dest, BUILT), `${new Date().toISOString()} (marked: built before the marker)\n`);
      git(repoOf(a), 'worktree', 'remove', '--force', tmp);
      return sha;
    }
    tryRun(['git', '-C', repoOf(a), 'worktree', 'remove', '--force', dest]);
  }
  rmSync(dest, { recursive: true, force: true });
  git(repoOf(a), 'worktree', 'move', tmp, dest);
  try {
    for (const step of a.build) run(step, dest, 900_000);
  } catch (e) {
    tryRun(['git', '-C', repoOf(a), 'worktree', 'remove', '--force', dest]);
    throw e;
  }
  writeFileSync(join(dest, BUILT), `${new Date().toISOString()}\n`);
  return sha;
}

/** This user's processes: where each runs and its command line (processes it cannot read are left out). */
function processes(): ProcView[] {
  const out: ProcView[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const pid of pids) {
    try {
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {}
      out.push({ cwd, cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) });
    } catch {}
  }
  return out;
}

/**
 * Old releases go, keeping the current, the one before it, the newest few others, and every one a running process
 * still uses (an extractor of dither-accounts that outlived the manager's restarts runs from the release it started in).
 */
function prune(a: App) {
  const dir = join(dirOf(a), 'releases');
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  const procs = processes();
  const used = new Set([...releasesInUse(dir, procs), ...releasesInUse(real, procs)]);
  const links = [linked(a, 'current'), linked(a, 'previous')].filter(Boolean) as string[];
  const keep = new Set([...links, ...used]);
  const older = [...used].filter((d) => !links.includes(d));
  if (older.length) log(`${a.name}: keeping older releases still in use: ${older.map(short).join(', ')}`);
  const rels = readdirSync(dir)
    .filter((d) => !d.startsWith('.') && !keep.has(d))
    .map((d) => ({ d, t: statSync(join(dir, d)).mtimeMs }))
    .sort((x, y) => y.t - x.t);
  for (const { d } of rels.slice(KEEP)) tryRun(['git', '-C', repoOf(a), 'worktree', 'remove', '--force', join(dir, d)]);
  tryRun(['git', '-C', repoOf(a), 'worktree', 'prune']);
}

/**
 * The hub's database, copied before a restart when the last copy is older than BACKUP_EVERY (one rolling file, as by
 * hand: VACUUM INTO from the sqlite3 shell). Not at every merge: 2 GB each time, and a rollback changes the code, not
 * the database. A schema change is copied by the hub itself first (backups/pre-migrate-*), and ZFS snapshots hourly.
 */
const BACKUP_EVERY = 6 * 3_600_000;
function backup() {
  const db = join(HUB_DATA, 'hub.sqlite');
  const out = join(HUB_DATA, 'backups', 'pre-deploy.sqlite');
  if (existsSync(out) && Date.now() - statSync(out).mtimeMs < BACKUP_EVERY) return;
  rmSync(`${out}.new`, { force: true });
  run(['sqlite3', db, `PRAGMA busy_timeout=5000; VACUUM INTO '${out}.new'`], undefined, 600_000);
  renameSync(`${out}.new`, out);
}

async function since(a: App): Promise<Since> {
  return { at: Date.now(), restarts: restarts(a.unit), online: await onlineAccounts().catch(() => 0), hubLogSize: size(hubLog) };
}

// ---------------------------------------------------------------- one app

/**
 * One app: what is new, and ship it. `by hand`: a commit named by a person (`ship`), shipped whatever its CI, a hold or
 * an earlier failure say; the checks and the rollback are the same.
 */
async function deploy(a: App, state: State, byHand?: string): Promise<'shipped' | 'nothing' | 'waiting' | 'failed'> {
  clone(a);
  fetchAll(a);
  const current = linked(a, 'current');
  if (!current) {
    log(`${a.name}: no current release: run "init ${a.key} <sha>" first`);
    return 'nothing';
  }
  const deployedBranch = a.overlay ? (state.branchOf[current] ?? null) : current;
  let target: string;
  if (byHand) target = git(repoOf(a), 'rev-parse', '--verify', `${byHand}^{commit}`);
  else {
    // A hold file stops this app's deploys until it goes (what it says is why): for a deploy that needs hands.
    const hold = join(dirOf(a), 'hold');
    if (existsSync(hold)) {
      log(`${a.name}: held by ${hold}: ${readFileSync(hold, 'utf8').trim().slice(0, 200)}`);
      return 'waiting';
    }
    const failed = new Set(Object.keys(state.failed[a.key] ?? {}));
    const p = pick(candidates(a, deployedBranch, state), failed);
    saveState(state);
    if ('none' in p) {
      if (p.held && state.toldHeld[a.key] !== p.held) {
        state.toldHeld[a.key] = p.held;
        saveState(state);
        await notice(`${a.key}-held`, `${a.name} #${p.held} waits for a deploy by hand`, `It has the hold-deploy label, so it and what merged after it do not deploy by themselves. Ship it with: bun packages/deploy/src/deployer.ts ship ${a.key} <sha>`, 'normal', a.name);
      }
      return 'nothing';
    }
    if ('wait' in p) {
      log(`${a.name}: waiting: ${p.wait}`);
      return 'waiting';
    }
    target = p.ship;
  }
  if (!timeToShip(Date.now(), RUN)) {
    log(`${a.name}: ${short(target)} waits for the next run: too little of this one's time is left for its check`);
    return 'waiting';
  }
  const calls = await callsOn();
  if (calls) {
    log(`${a.name}: ${short(target)} waits: ${calls} call${calls === 1 ? '' : 's'} on`);
    return 'waiting';
  }
  log(`${a.name}: shipping ${a.branch} ${short(target)} (runs ${short(current)})`);
  if (dry) return 'shipped';
  const fail = (why: string) => {
    (state.failed[a.key] ??= {})[target] = why.slice(0, 500);
    saveState(state);
  };
  let rel: string;
  try {
    rel = makeRelease(a, target, current);
  } catch (e) {
    const why = (e as Error).message;
    log(`${a.name}: build failed: ${why}`);
    fail(why);
    const n = failedNotice(a.name, target, `The build failed: ${why}`, current, false);
    await notice(`${a.key}-failed`, n.title, n.body, 'normal', a.name);
    return 'failed';
  }
  if (a.overlay) state.branchOf[rel] = target;
  saveState(state);
  if (rel === current) {
    log(`${a.name}: ${a.branch} ${short(target)} is already in what runs (${short(current)})`);
    return 'nothing';
  }
  // What came with it, for the notice: the branch's commits since the one that ran.
  const range = deployedBranch && tryRun(['git', '-C', repoOf(a), 'merge-base', '--is-ancestor', deployedBranch, target]) !== null ? `${deployedBranch}..${target}` : `${target}~1..${target}`;
  const subjects = git(repoOf(a), 'log', '--first-parent', '--format=%s', range).split('\n').filter(Boolean);

  if (a.key === 'chat') backup();
  // The build took this run's time too: a check that could not finish waits for the next run (the release is built).
  if (!timeToShip(Date.now(), RUN)) {
    log(`${a.name}: ${short(rel)} is built; its restart waits for the next run (too little of this one's time is left)`);
    return 'waiting';
  }
  const s = await since(a);
  // Saved before the restart: if this run is killed before the check ends, the next one rolls it back (resolvePending).
  const pending: Pending = { rel, previous: current, target, at: new Date().toISOString(), phase: 'restarting' };
  state.pending[a.key] = pending;
  saveState(state);
  link(a, 'previous', current);
  link(a, 'current', rel);
  pending.phase = 'checking';
  saveState(state);
  run(['systemctl', '--user', 'restart', a.unit]);
  let note: string | void;
  try {
    checkBy = RUN.check;
    note = await a.up(s, { rollback: false });
  } catch (e) {
    const why = (e as Error).message;
    log(`${a.name}: ${short(rel)} did not hold: ${why}; rolling back to ${short(current)}`);
    fail(why);
    pending.phase = 'rolling-back';
    saveState(state);
    await rollBack(a, current, target, why);
    delete state.pending[a.key];
    saveState(state);
    return 'failed';
  }
  delete state.pending[a.key];
  saveState(state);
  log(`${a.name}: ${short(rel)} is up (${Math.round((Date.now() - s.at) / 1000)} s)`);
  if (a.overlay) {
    // The private branch follows what runs, as it did when this was done by hand.
    const pushed = tryRun(['git', '-C', releaseOf(a, rel), 'push', '-q', a.overlay.remote, `HEAD:refs/heads/${a.overlay.branch}`]);
    if (pushed === null) log(`${a.name}: could not push ${short(rel)} to ${a.overlay.remote}/${a.overlay.branch} (moved meanwhile?)`);
  }
  const n = deployedNotice(a.name, target, subjects);
  // Something still under way when the check ended (restarts for changed code, after gaps): said, at normal urgency.
  if (note) log(`${a.name}: ${note}`);
  await notice(a.key, n.title, note ? `${n.body}\n${note}` : n.body, note ? 'normal' : 'low', a.name);
  prune(a);
  return 'shipped';
}

/** `current` back to the release before, the service restarted on it and checked as a rollback, and the notice. */
async function rollBack(a: App, to: string, target: string, why: string) {
  if (linked(a, 'current') !== to) link(a, 'current', to);
  run(['systemctl', '--user', 'restart', a.unit]);
  let back = true;
  try {
    // Its own time, from what this run has left (ROLLBACK_MS was kept for it): never the forward check's 30 minutes.
    checkBy = Math.min(Date.now() + ROLLBACK_MS, RUN.end);
    await a.up(await since(a), { rollback: true });
  } catch (e2) {
    back = false;
    log(`${a.name}: the rollback did not come up either: ${(e2 as Error).message}`);
  }
  const n = failedNotice(a.name, target, why, back ? to : null, true);
  await notice(`${a.key}-failed`, n.title, n.body, 'high', a.name);
}

/**
 * A check a killed run left unfinished (state.pending): it counts as failed, never tried again, and the release before
 * comes back, checked as a rollback, with its notice. A run killed during a rollback leaves the same, and it is done
 * again.
 */
async function resolvePending(a: App, state: State) {
  const p = state.pending[a.key];
  const r = interrupted(p, linked(a, 'current'));
  if (!p || !r) return;
  if (r.drop) {
    // Killed before `current` moved: the release never ran, its commit is not failed; the next pick may ship it.
    log(`${a.name}: ${short(p.rel)} was saved for a check but never started: forgotten`);
    delete state.pending[a.key];
    saveState(state);
    return;
  }
  log(`${a.name}: ${short(p.rel)}: ${r.why}; rolling back to ${short(p.previous)}`);
  (state.failed[a.key] ??= {})[p.target] = r.why;
  saveState(state);
  if (!dry) await rollBack(a, p.previous, p.target, r.why);
  delete state.pending[a.key];
  saveState(state);
}

// ---------------------------------------------------------------- main

/** The release folder name this deployer runs from (chat's), or null. */
function ownRelease(): string | null {
  try {
    const m = realpathSync(import.meta.dir).match(/\/releases\/([^/]+)\/packages\/deploy\/src$/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** A process's start time (/proc/<pid>/stat field 22), so a pid handed on is not taken for it. */
function startOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * One run at a time (the timer's, `ship` by hand): `<root>/deploy.lock` names the run that holds it, by pid and start
 * time. A second run says so and goes; a lock whose run has ended is taken over.
 */
const LOCK_FILE = join(ROOT, 'deploy.lock');
function takeLock(): number | null {
  // Made whole beside it, then linked into place: a link fails when the lock exists, so two runs never both take it.
  const mine = `${LOCK_FILE}.${process.pid}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, start: startOf(process.pid), at: new Date().toISOString() }));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(mine, LOCK_FILE);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
      }
      let lock: { pid?: unknown; start?: unknown } | null = null;
      try {
        lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      } catch {}
      const held = lockHeld(lock, process.pid, (pid, start) => startOf(pid) !== null && (start === undefined || startOf(pid) === start));
      if (held) return held;
      // Its run has ended: taken over (once; a run that takes it meanwhile wins).
      rmSync(LOCK_FILE, { force: true });
    }
  } catch (e) {
    let pid = -1;
    try {
      pid = Number(JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid) || -1;
    } catch {}
    log(`could not take ${LOCK_FILE}: ${(e as Error).message}`);
    return pid;
  } finally {
    rmSync(mine, { force: true });
  }
  process.on('exit', () => {
    try {
      if (JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) rmSync(LOCK_FILE, { force: true });
    } catch {}
  });
  return null;
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  const args = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const state = loadState();
  // A chat check a killed run left is about the release this deployer runs from: the one before judges it.
  const chat = APPS.find((x) => x.key === 'chat')!;
  const prevDeployer = state.pending.chat ? join(releaseOf(chat, state.pending.chat.previous), 'packages/deploy/src/deployer.ts') : '';
  const canResolve = !!prevDeployer && existsSync(prevDeployer) && readFileSync(prevDeployer, 'utf8').includes('resolvePending');
  const from = reexecFrom(state.pending.chat, ownRelease(), canResolve, process.env.DITHER_DEPLOY_REEXEC === '1');
  if (from && !dry) {
    log(`dither-chat: ${short(state.pending.chat!.rel)}, which this deployer runs from, was left unchecked: handing the run to ${short(from)}'s deployer`);
    const p = Bun.spawn([process.execPath, prevDeployer, ...process.argv.slice(2)], { env: { ...process.env, DITHER_DEPLOY_REEXEC: '1' }, stdio: ['inherit', 'inherit', 'inherit'] });
    process.exit(await p.exited);
  }
  // A dry run changes nothing, so it takes no lock.
  const held = dry ? null : takeLock();
  if (held) {
    log(`another deployer run (pid ${held}) is under way: this one goes`);
    if (args[0] === 'ship') process.exitCode = 1;
    return;
  }
  if (args[0] === 'init') {
    const a = APPS.find((x) => x.key === args[1]);
    if (!a || !args[2]) throw new Error('init <chat|accounts> <sha>');
    clone(a);
    fetchAll(a);
    const sha = git(repoOf(a), 'rev-parse', args[2]);
    if (!existsSync(join(releaseOf(a, sha), BUILT))) {
      if (!existsSync(releaseOf(a, sha))) git(repoOf(a), 'worktree', 'add', '-q', '--detach', releaseOf(a, sha), sha);
      for (const step of a.build) run(step, releaseOf(a, sha), 900_000);
      writeFileSync(join(releaseOf(a, sha), BUILT), `${new Date().toISOString()}\n`);
    }
    if (a.overlay) state.branchOf[sha] = git(repoOf(a), 'merge-base', sha, `origin/${a.branch}`);
    saveState(state);
    link(a, 'current', sha);
    log(`${a.name}: init: current is ${short(sha)} (no restart)`);
    return;
  }
  // What a killed run left half-checked comes first, before anything new ships.
  for (const a of APPS) {
    try {
      await resolvePending(a, state);
    } catch (e) {
      log(`${a.name}: resolving an unfinished check: ${(e as Error).message}`);
    }
  }
  if (args[0] === 'ship') {
    const a = APPS.find((x) => x.key === args[1]);
    if (!a || !args[2]) throw new Error(`ship <chat|accounts> <sha on ${APPS.map((x) => x.branch).join(' / ')}>`);
    const r = await deploy(a, state, args[2]);
    log(`${a.name}: ship ${args[2]}: ${r}`);
    if (r === 'failed') process.exitCode = 1;
    return;
  }
  for (const a of APPS) {
    try {
      await deploy(a, state);
    } catch (e) {
      log(`${a.name}: ${(e as Error).message}`);
    }
  }
}

if (import.meta.main) await main();
