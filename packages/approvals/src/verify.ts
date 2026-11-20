/**
 * Whether commits are covered by a device's approval (docs/approvals.md, "What verify-commit and verify-range check"):
 * a merge commit whose trailers carry a signed `merge` approval naming its parents and tree, or a one-parent commit
 * that obeys a signed standing `policy`. Plain git only.
 */
import { checkSigned, type DeviceKey, fromB64u, parsePayload, type PolicyPayload, readMerge, readPolicy } from './statement.ts';

export class GitError extends Error {}

export function git(dir: string, args: string[], input?: string): string {
  const p = Bun.spawnSync(['git', '-C', dir, ...args], { stdin: input === undefined ? 'ignore' : Buffer.from(input), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  if (p.exitCode !== 0) throw new GitError(`git ${args[0]}: ${p.stderr.toString().trim().slice(0, 300)}`);
  return p.stdout.toString();
}

export interface CommitInfo {
  rev: string;
  tree: string;
  parents: string[];
  message: string;
}

export function readCommit(dir: string, rev: string): CommitInfo {
  const full = git(dir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
  const raw = git(dir, ['cat-file', 'commit', full]);
  const split = raw.indexOf('\n\n');
  const head = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? '' : raw.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const l of head.split('\n')) {
    if (l.startsWith('tree ')) tree = l.slice(5);
    else if (l.startsWith('parent ')) parents.push(l.slice(7));
  }
  return { rev: full, tree, parents, message };
}

/** The trailers of a message's last paragraph: `Key: value` lines (a value never wraps here). */
export function trailers(message: string): Map<string, string[]> {
  const paras = message.replace(/\s+$/, '').split(/\n\s*\n/);
  const last = paras[paras.length - 1] ?? '';
  const out = new Map<string, string[]>();
  for (const l of last.split('\n')) {
    const m = /^([A-Za-z0-9-]+):\s*(.*?)\s*$/.exec(l);
    if (!m) continue;
    out.set(m[1]!, [...(out.get(m[1]!) ?? []), m[2]!]);
  }
  return out;
}

export interface Coverage {
  rev: string;
  covered: boolean;
  by?: 'merge' | 'policy';
  device?: string;
  policy?: string;
  reason?: string;
}

export interface VerifyOpts {
  keys: DeviceKey[];
  /** The payload's repo must be this, when given. */
  repo?: string;
  now?: number;
}

const single = (t: Map<string, string[]>, k: string) => {
  const v = t.get(k);
  return v && v.length === 1 ? v[0]! : null;
};

/** One commit: covered by its own trailers or not, and why. */
export async function verifyCommit(dir: string, rev: string, o: VerifyOpts): Promise<Coverage> {
  const c = readCommit(dir, rev);
  const no = (reason: string): Coverage => ({ rev: c.rev, covered: false, reason });
  const t = trailers(c.message);
  const st = single(t, 'Approval-Statement');
  const pl = single(t, 'Approval-Payload');
  const sig = single(t, 'Approval-Signature');
  if (!st && !pl && !sig) return no('no approval trailers');
  if (!st || !pl || !sig) return no('the approval trailers are incomplete (one each of Approval-Statement, Approval-Payload, Approval-Signature)');
  let text: string;
  let payloadText: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(fromB64u(st));
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(fromB64u(pl));
  } catch {
    return no('a trailer is not base64url of UTF-8');
  }
  const policyName = single(t, 'Approval-Policy');
  const checked = await checkSigned(text, sig, o.keys, { payload: payloadText, kind: policyName ? 'policy' : 'merge' });
  if (!checked.ok) return no(checked.reason!);
  const s = checked.statement!;
  if (s.action !== 'approve') return no(`the action signed is ${s.action}, not approve`);
  const payload = parsePayload(payloadText);
  if (typeof payload === 'string') return no(payload);
  const device = s.device;

  if (!policyName) {
    const m = readMerge(payload);
    if (typeof m === 'string') return no(m);
    if (o.repo && m.repo !== o.repo) return no(`approved for repo ${m.repo}, not ${o.repo}`);
    if (c.parents.length !== 2) return no('a merge approval covers only a commit with two parents');
    if (c.parents[0] !== m.base || c.parents[1] !== m.head) return no('its parents are not the approved base and head');
    if (c.tree !== m.tree) return no('its tree is not the approved tree');
    return { rev: c.rev, covered: true, by: 'merge', device };
  }

  const p = readPolicy(payload);
  if (typeof p === 'string') return no(p);
  if (p.name !== policyName) return no(`the policy signed is ${p.name}, not ${policyName}`);
  if (o.repo && p.repo !== o.repo) return no(`the policy is for repo ${p.repo}, not ${o.repo}`);
  if (s.expires <= (o.now ?? Date.now())) return no(`the policy ${p.name} expired`);
  if (c.parents.length !== 1) return no('a policy covers only a commit with one parent');
  const why = obeys(dir, c.parents[0]!, c.rev, p);
  if (why) return no(`against policy ${p.name}: ${why}`);
  return { rev: c.rev, covered: true, by: 'policy', device, policy: p.name };
}

/** Why the change from `parent` to `rev` breaks the policy, or null when it obeys it. */
export function obeys(dir: string, parent: string, rev: string, p: PolicyPayload): string | null {
  const raw = git(dir, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', parent, rev]);
  const parts = raw.split('\0').filter((x, i, a) => !(i === a.length - 1 && x === ''));
  const files: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1];
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(meta);
    if (!m || path === undefined) return 'an unreadable diff';
    if (m[3] !== 'M') return `${path} is ${m[3] === 'A' ? 'added' : m[3] === 'D' ? 'deleted' : 'not just modified'}`;
    if (m[1] !== m[2]) return `${path} changed mode`;
    if (!p.paths.includes(path)) return `${path} is not one of the policy's files`;
    files.push(path);
  }
  if (!files.length) return 'it changes nothing';
  const res = p.lines.map((l) => new RegExp(l));
  let added = 0;
  let removed = 0;
  for (const f of files) {
    const d = git(dir, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-algorithm=myers', parent, rev, '--', f]);
    const lines = d.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i]!.startsWith('@@')) {
      if (lines[i]!.startsWith('Binary files')) return `${f} is binary`;
      i++;
    }
    while (i < lines.length) {
      const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]!);
      if (!h) {
        if (lines[i] === '' && i === lines.length - 1) break;
        return `an unreadable hunk in ${f}`;
      }
      let minus = h[1] === undefined ? 1 : Number(h[1]);
      let plus = h[2] === undefined ? 1 : Number(h[2]);
      i++;
      while (minus > 0 || plus > 0) {
        const l = lines[i++];
        if (l === undefined) return `a cut hunk in ${f}`;
        if (l.startsWith('\\')) continue;
        const sign = l[0];
        const text = l.slice(1);
        if (sign === '-' && minus > 0) minus--, removed++;
        else if (sign === '+' && plus > 0) plus--, added++;
        else return `an unreadable hunk in ${f}`;
        if (!res.some((r) => r.test(text))) return `a changed line in ${f} matches none of the policy's lines: ${JSON.stringify(text.slice(0, 80))}`;
      }
      while (i < lines.length && lines[i]!.startsWith('\\')) i++;
    }
  }
  if (added !== removed) return `${added} lines added but ${removed} removed`;
  if (added + removed > p.maxLines) return `${added + removed} lines changed, more than ${p.maxLines}`;
  return null;
}

export interface RangeResult {
  ok: boolean;
  commits: Coverage[];
  reason?: string;
}

/** Every commit on TIP's first-parent chain back to BASE (not included) covered; BASE must be on that chain. */
export async function verifyRange(dir: string, base: string, tip: string, o: VerifyOpts): Promise<RangeResult> {
  const b = readCommit(dir, base).rev;
  const t = readCommit(dir, tip).rev;
  if (b === t) return { ok: true, commits: [] };
  const revs = git(dir, ['rev-list', '--first-parent', `${b}..${t}`]).split('\n').filter(Boolean);
  const last = revs.length ? readCommit(dir, revs[revs.length - 1]!) : null;
  if (!last || last.parents[0] !== b) return { ok: false, commits: [], reason: `${b.slice(0, 12)} is not on ${t.slice(0, 12)}'s first-parent chain` };
  const commits: Coverage[] = [];
  for (const r of revs.reverse()) commits.push(await verifyCommit(dir, r, o));
  return { ok: commits.every((c) => c.covered), commits };
}

/** The rebuild payload's diff-sha256: the binary diff against `base` (HEAD by default) and the untracked files' names and contents. */
export function diffHash(dir: string, base = 'HEAD'): string {
  const diff = git(dir, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base]);
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const h = new Bun.CryptoHasher('sha256');
  h.update(diff);
  for (const f of untracked) {
    h.update(`\0untracked ${f}\0`);
    h.update(git(dir, ['hash-object', '--no-filters', '--', f]).trim());
  }
  return h.digest('hex');
}

