/**
 * Change review without a forge's API (docs/approvals.md, "Change review without GitHub's API"): agents push
 * `review/<name>` to a plain git remote; this watches each configured repository, asks a signed `merge` approval for
 * each new head once its CI has a result, and on an approval merges it into the target with the approval in the merge
 * commit's trailers, signed with the bot's own SSH key, and pushes without force.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type ActionSpec, expandHome, type Hub, readKeys, type RequestView, verifyAnswer } from './client.ts';
import { approvalTrailers, type DeviceKey, mergePayload, NAME_RE } from './statement.ts';
import { verifyCommit } from './verify.ts';

interface CiSource {
  kind: 'command' | 'none';
  /** argv; `{rev}` is replaced by the commit. */
  command?: string[];
}

interface RepoConfig {
  name: string;
  /** A git URL or path; whatever `git fetch` and `git push` take. */
  remote: string;
  target: string;
  ci: CiSource;
}

interface ReviewConfig {
  hub?: string;
  tokenFile?: string;
  /** The keys an approval must verify against before the bot merges. */
  keys: string;
  botKey?: string;
  botName?: string;
  botEmail?: string;
  stateDir?: string;
  /** Seconds a merge request waits (default 7 days). */
  expiresIn?: number;
  repos: RepoConfig[];
}

/** What the bot remembers per branch. */
interface BranchState {
  head: string;
  base?: string;
  id?: string;
  state: 'ci-wait' | 'asked' | 'merged' | 'denied' | 'conflict' | 'failed';
  note?: string;
}

/** As much of Hub as the watcher uses (a test's fake has the same). */
export type ReviewHub = Pick<Hub, 'create' | 'get' | 'cancel'>;

const PREFIX = 'review/';
const ACTIONS: ActionSpec[] = [
  { id: 'approve', label: 'Merge', needs: 'signed' },
  { id: 'deny', label: 'Send back', needs: 'any' },
];

function run(args: string[], o: { cwd?: string; input?: string; env?: Record<string, string>; ok?: number[] } = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(args, { cwd: o.cwd, stdin: o.input === undefined ? 'ignore' : Buffer.from(o.input), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...o.env } });
  const r = { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
  if (o.ok && !o.ok.includes(r.code)) throw new Error(`${args.slice(0, 3).join(' ')}: ${r.err.trim().slice(0, 300) || `exit ${r.code}`}`);
  return r;
}

export class Reviewer {
  private stateFile: string;
  private state: Record<string, Record<string, BranchState>>;
  private keys: DeviceKey[];
  private dir: string;

  constructor(
    private cfg: ReviewConfig,
    private hub: ReviewHub,
    private log: (s: string) => void = (s) => console.log(s),
  ) {
    this.dir = expandHome(cfg.stateDir ?? join(homedir(), '.local/share/dither-review'));
    mkdirSync(join(this.dir, 'repos'), { recursive: true, mode: 0o700 });
    this.stateFile = join(this.dir, 'state.json');
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {};
    this.keys = readKeys(cfg.keys);
    for (const r of cfg.repos) if (!NAME_RE.test(r.name)) throw new Error(`repo name ${r.name}: a-z, 0-9 and -`);
  }

  private save() {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  private git(repo: RepoConfig, args: string[], o: { input?: string; env?: Record<string, string>; ok?: number[] } = {}) {
    return run(['git', '--git-dir', this.mirror(repo), ...args], { ...o, ok: o.ok ?? [0] });
  }

  private mirror(repo: RepoConfig) {
    return join(this.dir, 'repos', `${repo.name}.git`);
  }

  /** The target's tip and every review branch's head, fetched now. */
  private fetch(repo: RepoConfig): { target: string; branches: Map<string, string> } {
    if (!existsSync(this.mirror(repo))) run(['git', 'init', '-q', '--bare', this.mirror(repo)], { ok: [0] });
    this.git(repo, ['fetch', '-q', '--prune', '--no-tags', repo.remote, `+refs/heads/${repo.target}:refs/heads/${repo.target}`, `+refs/heads/${PREFIX}*:refs/heads/${PREFIX}*`]);
    const target = this.git(repo, ['rev-parse', `refs/heads/${repo.target}`]).out.trim();
    const branches = new Map<string, string>();
    for (const l of this.git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/heads/${PREFIX}`]).out.split('\n').filter(Boolean)) {
      const [sha, ref] = l.split(' ');
      branches.set(ref!.slice('refs/heads/'.length), sha!);
    }
    return { target, branches };
  }

  /** The CI's lines for a commit, or null while it has none. */
  private ci(repo: RepoConfig, rev: string): { lines: string[]; failed: boolean } | null {
    if (repo.ci.kind === 'none' || !repo.ci.command?.length) return { lines: [], failed: false };
    const r = run(repo.ci.command.map((x) => x.replaceAll('{rev}', rev)));
    if (r.code !== 0) return null;
    const lines = r.out.split('\n').filter((l) => l.trim());
    // Result lines are "<check> <ok|FAILED|pending> [details]"; others (a header) are only shown.
    const results = lines.map((l) => l.trim().split(/\s+/)[1]?.toLowerCase()).filter((x) => x === 'ok' || x === 'failed' || x === 'pending');
    if (!results.length || results.includes('pending')) return null;
    return { lines, failed: results.includes('failed') };
  }

  /** One pass over every repository. */
  async tick(): Promise<void> {
    for (const repo of this.cfg.repos) {
      try {
        await this.repo(repo);
      } catch (e) {
        this.log(`[${repo.name}] ${(e as Error).message}`);
      }
    }
    this.save();
  }

  private async repo(repo: RepoConfig) {
    const { target, branches } = this.fetch(repo);
    const st = (this.state[repo.name] ??= {});
    // Gone branches: their waiting request is cancelled.
    for (const [branch, s] of Object.entries(st)) {
      if (branches.has(branch)) continue;
      if (s.state === 'asked' && s.id) await this.hub.cancel(s.id, 'the branch was deleted').catch(() => {});
      delete st[branch];
    }
    for (const [branch, head] of branches) {
      let s: BranchState | undefined = st[branch];
      if (s && s.head !== head) {
        if (s.state === 'asked' && s.id) await this.hub.cancel(s.id, 'a newer head was pushed').catch(() => {});
        s = undefined;
      }
      if (!s) s = st[branch] = { head, state: 'ci-wait' };
      if (s.state === 'ci-wait') await this.ask(repo, branch, s, target);
      else if (s.state === 'asked') await this.check(repo, branch, s, target);
    }
  }

  private topic(repo: RepoConfig, branch: string) {
    return `${repo.name}:${branch}`;
  }

  private async ask(repo: RepoConfig, branch: string, s: BranchState, base: string) {
    const ci = this.ci(repo, s.head);
    if (!ci) return;
    const m = this.git(repo, ['merge-tree', '--write-tree', '--no-messages', base, s.head], { ok: [0, 1] });
    const tree = m.out.split('\n')[0]!.trim();
    const log = this.git(repo, ['log', '--oneline', '--no-decorate', '-n', '50', `${base}..${s.head}`]).out.trim();
    if (m.code === 1) {
      const v = await this.hub.create({ kind: 'alert', title: `${branch} conflicts with ${repo.target} (${repo.name})`, body: `Rebase or merge ${repo.target} into it and push again.\n\n${log}`, urgency: 'low', topic: this.topic(repo, branch) });
      Object.assign(s, { state: 'conflict', id: v.id, base, note: 'conflicts' });
      return this.log(`[${repo.name}] ${branch}: conflicts with ${repo.target}`);
    }
    const stat = this.git(repo, ['diff', '--stat=100', base, tree]).out.trimEnd();
    const body = [`${branch} → ${repo.target} in ${repo.name}`, `base ${base.slice(0, 12)}, head ${s.head.slice(0, 12)}`, '', 'Commits:', log || '(none)', '', 'Changes:', stat || '(none)', '', `CI${ci.failed ? ' (FAILED)' : ''}:`, ...(ci.lines.length ? ci.lines : ['(no CI for this repository)'])].join('\n');
    const payload = mergePayload({ repo: repo.name, target: repo.target, branch, base, head: s.head, tree });
    const v = await this.hub.create({
      kind: 'merge',
      title: `${ci.failed ? '[CI failed] ' : ''}Merge ${branch} into ${repo.target} (${repo.name})`,
      body: body.slice(0, 30_000),
      payload,
      actions: ACTIONS,
      urgency: 'normal',
      expiresIn: this.cfg.expiresIn ?? 7 * 86_400,
      topic: this.topic(repo, branch),
    });
    Object.assign(s, { state: 'asked', id: v.id, base });
    this.log(`[${repo.name}] ${branch}: asked ${v.id}`);
  }

  private async check(repo: RepoConfig, branch: string, s: BranchState, target: string) {
    const v = await this.hub.get(s.id!);
    if (v.state === 'waiting') {
      // The target moved: the approval would cover a tree that is no longer the merge's result. Ask again.
      if (target !== s.base) {
        await this.hub.cancel(v.id, `${repo.target} moved; asking again`).catch(() => {});
        Object.assign(s, { state: 'ci-wait', id: undefined });
      }
      return;
    }
    if (v.state === 'expired' || v.state === 'cancelled') return void Object.assign(s, { state: 'ci-wait', id: undefined });
    if (v.state !== 'answered') return;
    if (v.action === 'deny') return void Object.assign(s, { state: 'denied', note: v.message ?? undefined }, this.log(`[${repo.name}] ${branch}: sent back${v.message ? `: ${v.message}` : ''}`));
    const ok = await verifyAnswer(v, this.keys, { kind: 'merge', payload: v.payload, actions: ACTIONS });
    if (!ok.ok) return void Object.assign(s, { state: 'failed', note: ok.reason }, this.log(`[${repo.name}] ${branch}: the approval does not verify (${ok.reason}); not merging`));
    if (target !== s.base) {
      this.log(`[${repo.name}] ${branch}: approved, but ${repo.target} moved since; asking again`);
      return void Object.assign(s, { state: 'ci-wait', id: undefined });
    }
    await this.merge(repo, branch, s, v);
  }

  private async merge(repo: RepoConfig, branch: string, s: BranchState, v: RequestView) {
    const tree = /^tree ([0-9a-f]{40})$/m.exec(v.payload)?.[1];
    if (!tree) throw new Error('an approved payload without a tree');
    const log = this.git(repo, ['log', '--oneline', '--no-decorate', '-n', '50', `${s.base}..${s.head}`]).out.trim();
    const msg = `Merge ${branch} into ${repo.target}\n\n${log}\n\n${v.message ? `The user's message: ${v.message}\n\n` : ''}Approved on ${v.device?.name ?? v.device?.id ?? 'a device'}.\n\n${approvalTrailers({ statement: v.statement!, payload: v.payload, signature: v.signature! })}`;
    const who = { GIT_AUTHOR_NAME: this.cfg.botName ?? 'dither review bot', GIT_AUTHOR_EMAIL: this.cfg.botEmail ?? 'review-bot@localhost', GIT_COMMITTER_NAME: this.cfg.botName ?? 'dither review bot', GIT_COMMITTER_EMAIL: this.cfg.botEmail ?? 'review-bot@localhost' };
    const sign = this.cfg.botKey ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${expandHome(this.cfg.botKey)}`] : [];
    const commit = run(['git', '--git-dir', this.mirror(repo), ...sign, 'commit-tree', ...(this.cfg.botKey ? ['-S'] : []), tree, '-p', s.base!, '-p', s.head, '-F', '-'], { input: msg, env: who, ok: [0] }).out.trim();
    // The bot checks its own work as the deploy will.
    const c = await verifyCommit(this.mirror(repo), commit, { keys: this.keys, repo: repo.name });
    if (!c.covered) return void Object.assign(s, { state: 'failed', note: c.reason }, this.log(`[${repo.name}] ${branch}: the merge would not verify (${c.reason}); not pushed`));
    const push = this.git(repo, ['push', '-q', repo.remote, `${commit}:refs/heads/${repo.target}`], { ok: [0, 1] });
    if (push.code !== 0) return this.refused(repo, branch, s, push.err);
    this.git(repo, ['update-ref', `refs/heads/${repo.target}`, commit]);
    this.git(repo, ['push', '-q', repo.remote, `:refs/heads/${branch}`], { ok: [0, 1] });
    Object.assign(s, { state: 'merged', note: commit });
    this.log(`[${repo.name}] ${branch}: merged as ${commit.slice(0, 12)}`);
  }

  /**
   * The remote refused the merge. Only a target that moved since is worth a new question (on the new base); any other
   * refusal (a protected branch, a hook, a signature rule) would refuse the same merge again, so the branch fails and
   * the user is told once, on the branch's topic, until a new head is pushed.
   */
  private async refused(repo: RepoConfig, branch: string, s: BranchState, err: string) {
    const reason = pushRefusal(err);
    const { target } = this.fetch(repo);
    if (target !== s.base) {
      this.log(`[${repo.name}] ${branch}: the push was refused (${reason}); ${repo.target} moved, asking again on the new ${repo.target}`);
      return void Object.assign(s, { state: 'ci-wait', id: undefined });
    }
    // Failed first: an alert the hub won't take must not leave the approval to be pushed again every pass.
    Object.assign(s, { state: 'failed', id: undefined, note: reason });
    this.log(`[${repo.name}] ${branch}: ${repo.target} refused the push (${reason}); not asking again until a new head`);
    const v = await this.hub.create({
      kind: 'alert',
      title: refusedTitle(branch, repo.target, reason),
      body: `The approved merge of ${branch} into ${repo.target} (${repo.name}) was not pushed. ${repo.target} has not moved, so asking again would be refused the same way: nothing more is asked for this head. Fix the cause, then push a new head to ${branch} to be asked again.\n\n${err.trim().slice(0, 4000)}`,
      urgency: 'normal',
      topic: this.topic(repo, branch),
    });
    s.id = v.id;
  }

  /** For tests and `status`: what the bot remembers. */
  snapshot() {
    return structuredClone(this.state);
  }
}

/**
 * A refused push in one line: the remote's own words when it said any (GitHub's "GH006: Protected branch update failed
 * for refs/heads/main. Commits must have verified signatures."), else git's "! [rejected]" line, else its first line.
 */
export function pushRefusal(err: string): string {
  const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
  const remote = lines.filter((l) => l.startsWith('remote:')).map((l) => l.slice('remote:'.length).trim().replace(/^error:\s*/i, '')).filter(Boolean);
  const said = remote.length ? remote.slice(0, 2).join(' ') : (lines.find((l) => l.startsWith('! ')) ?? lines.find((l) => !/^(To |hint:)/.test(l)) ?? 'no reason given');
  return said.replace(/\s+/g, ' ').slice(0, 300);
}

const REFUSED = " refused the bot's push: ";
const refusedTitle = (branch: string, target: string, reason: string) => `${branch}: ${target}${REFUSED}${reason}`;

/** What the bot's alert on a branch's topic says, for `review status`: a conflict, or a merge the target refused. */
function alertOutcome(title: string, branch: string): { outcome: 'failed' | 'conflict'; reason: string } | null {
  if (title.startsWith(`${branch} conflicts with `)) return { outcome: 'conflict', reason: title.slice(branch.length + 1) };
  const at = title.indexOf(REFUSED);
  if (title.startsWith(`${branch}: `) && at > 0) return { outcome: 'failed', reason: title.slice(at + REFUSED.length) };
  return null;
}

function readConfig(file: string): ReviewConfig {
  const c = JSON.parse(readFileSync(expandHome(file), 'utf8')) as ReviewConfig;
  if (!c.keys || !Array.isArray(c.repos)) throw new Error('the config needs keys and repos');
  return c;
}

/** `dither-ask review status BRANCH --repo R` and `review watch --config F [--once]`. */
export async function reviewCommand(args: string[], o: { repo?: string; config?: string; once?: boolean; hub: () => Hub }): Promise<number> {
  const [sub, branch] = args;
  if (sub === 'status') {
    if (!branch || !o.repo) throw new Error('review status BRANCH --repo R');
    const name = branch.startsWith(PREFIX) ? branch : `${PREFIX}${branch}`;
    const { items } = await o.hub().byTopic(`${o.repo}:${name}`);
    const v = items[0];
    if (!v) return console.error(`nothing asked for ${name} in ${o.repo} yet`), 75;
    // The bot's alert says the branch can't go on as it is: a conflict, or the target refused the approved merge.
    const said = v.kind === 'alert' ? alertOutcome(v.title, name) : null;
    console.log(JSON.stringify({ id: v.id, kind: v.kind, title: v.title, state: v.state, action: v.action, message: v.message, created: v.created, ...(said ?? {}) }, null, 2));
    if (v.message) console.error(`The user's message: ${v.message}`);
    if (said) console.error(`${name}: ${said.outcome}: ${said.reason}; push a new head to be asked again`);
    if (v.kind === 'alert') return 75;
    return v.state !== 'answered' ? 75 : v.action === 'deny' ? 77 : 0;
  }
  if (sub === 'watch') {
    if (!o.config) throw new Error('review watch --config F');
    const cfg = readConfig(o.config);
    const { Hub } = await import('./client.ts');
    const r = new Reviewer(cfg, Hub.from({ url: cfg.hub, tokenFile: cfg.tokenFile }));
    for (;;) {
      await r.tick();
      if (o.once) return 0;
      await Bun.sleep(60_000);
    }
  }
  throw new Error('review status BRANCH --repo R | review watch --config F [--once]');
}
