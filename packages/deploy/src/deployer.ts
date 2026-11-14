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
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Candidate, type CodeRestarts, codeRestartsProblem, codeRestartsSettled, deployedNotice, failedNotice, pick, type ProcView, releasesInUse, short } from './plan.ts';

const HOME = homedir();
const ROOT = process.env.DITHER_DEPLOY_ROOT ?? join(HOME, '.local/share/dither-deploy');
const HUB = process.env.DITHER_DEPLOY_HUB ?? 'http://127.0.0.1:8460';
const MANAGER = process.env.DITHER_DEPLOY_MANAGER ?? 'http://127.0.0.1:8486';
const HUB_DATA = process.env.DITHER_DEPLOY_HUB_DATA ?? join(HOME, '.local/share/dither-chat');
const MANAGER_DATA = process.env.DITHER_DEPLOY_MANAGER_DATA ?? join(HOME, '.local/share/dither-accounts');
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
  /** Wait for the service to be up after a restart; throws why not. */
  up: (since: Since) => Promise<void>;
}

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
    up: async (s) => {
      await until(() => health(`${MANAGER}/api/health`), 120_000, 'the manager to answer /api/health');
      // Extractors whose code changed restart one at a time after the manager is up (its docs/supervisor.md): wait
      // until the last has, then (steady's 20 s on) every one of them must be online and none crashed since.
      await until(async () => codeRestartsSettled(await codeRestarts()), 1_800_000, 'dither-accounts to restart the extractors whose code changed');
      await steady('dither-accounts.service', s);
      const problem = codeRestartsProblem(await codeRestarts());
      if (problem) throw new Error(problem);
      // The hub's accounts run under the manager: they come back online.
      await until(async () => (await onlineAccounts()) >= s.online, 300_000, `the hub's accounts to be online again (${s.online} before)`);
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
      await until(async () => (await onlineAccounts()) >= s.online, 180_000, `its accounts to be online again (${s.online} before)`);
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
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return;
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
}

async function health(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return r.ok;
}

/** dither-accounts' restarts for changed code (counts only), or null from a manager that has none. */
async function codeRestarts(): Promise<CodeRestarts | null> {
  const r = await fetch(`${MANAGER}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return ((await r.json()) as { codeRestarts?: CodeRestarts }).codeRestarts ?? null;
}

async function onlineAccounts(): Promise<number> {
  const r = await fetch(`${HUB}/api/bootstrap`, { signal: AbortSignal.timeout(60_000) });
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
  await Bun.sleep(20_000);
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
}
const stateFile = join(ROOT, 'state.json');
function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<State>;
    return { failed: s.failed ?? {}, branchOf: s.branchOf ?? {}, known: s.known ?? {}, toldHeld: s.toldHeld ?? {} };
  } catch {
    return { failed: {}, branchOf: {}, known: {}, toldHeld: {} };
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
  if (existsSync(dest)) {
    git(repoOf(a), 'worktree', 'remove', '--force', tmp);
    return sha;
  }
  git(repoOf(a), 'worktree', 'move', tmp, dest);
  try {
    for (const step of a.build) run(step, dest, 900_000);
  } catch (e) {
    tryRun(['git', '-C', repoOf(a), 'worktree', 'remove', '--force', dest]);
    throw e;
  }
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
  const s = await since(a);
  link(a, 'previous', current);
  link(a, 'current', rel);
  run(['systemctl', '--user', 'restart', a.unit]);
  try {
    await a.up(s);
  } catch (e) {
    const why = (e as Error).message;
    log(`${a.name}: ${short(rel)} did not hold: ${why}; rolling back to ${short(current)}`);
    fail(why);
    link(a, 'current', current);
    run(['systemctl', '--user', 'restart', a.unit]);
    let back = true;
    try {
      await a.up(await since(a));
    } catch (e2) {
      back = false;
      log(`${a.name}: the rollback did not come up either: ${(e2 as Error).message}`);
    }
    const n = failedNotice(a.name, target, why, back ? current : null, true);
    await notice(`${a.key}-failed`, n.title, n.body, 'high', a.name);
    return 'failed';
  }
  log(`${a.name}: ${short(rel)} is up (${Math.round((Date.now() - s.at) / 1000)} s)`);
  if (a.overlay) {
    // The private branch follows what runs, as it did when this was done by hand.
    const pushed = tryRun(['git', '-C', releaseOf(a, rel), 'push', '-q', a.overlay.remote, `HEAD:refs/heads/${a.overlay.branch}`]);
    if (pushed === null) log(`${a.name}: could not push ${short(rel)} to ${a.overlay.remote}/${a.overlay.branch} (moved meanwhile?)`);
  }
  const n = deployedNotice(a.name, target, subjects);
  await notice(a.key, n.title, n.body, 'low', a.name);
  prune(a);
  return 'shipped';
}

// ---------------------------------------------------------------- main

async function main() {
  mkdirSync(ROOT, { recursive: true });
  const args = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const state = loadState();
  if (args[0] === 'init') {
    const a = APPS.find((x) => x.key === args[1]);
    if (!a || !args[2]) throw new Error('init <chat|accounts> <sha>');
    clone(a);
    fetchAll(a);
    const sha = git(repoOf(a), 'rev-parse', args[2]);
    if (!existsSync(releaseOf(a, sha))) {
      git(repoOf(a), 'worktree', 'add', '-q', '--detach', releaseOf(a, sha), sha);
      for (const step of a.build) run(step, releaseOf(a, sha), 900_000);
    }
    if (a.overlay) state.branchOf[sha] = git(repoOf(a), 'merge-base', sha, `origin/${a.branch}`);
    saveState(state);
    link(a, 'current', sha);
    log(`${a.name}: init: current is ${short(sha)} (no restart)`);
    return;
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
