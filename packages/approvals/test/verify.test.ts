import { describe, expect, test } from 'bun:test';
import { type Ask, approvalTrailers, displayHash, mergePayload, newId, parseKeys, parseStatement, policyPayload, sha256hex, statementText, verifySignature, keysLine, checkSigned } from '../src/statement.ts';
import { diffHash, verifyCommit, verifyRange } from '../src/verify.ts';
import { commitFile, FakeDevice, sh, tempRepo } from './helpers.ts';

const ask = (kind: Ask['kind'], payload: string, expires = Date.now() + 3_600_000): Ask => ({
  id: newId(),
  kind,
  asker: 'review',
  created: Date.now(),
  expires,
  payloadSha256: sha256hex(payload),
  displaySha256: displayHash('A title', 'A body'),
});

describe('statement', () => {
  test('round trips and signs', async () => {
    const d = await FakeDevice.make();
    const a = ask('merge', 'dither-merge-v1\n');
    const { statement, signature } = await d.answer(a, 'approve', 'looks good');
    const s = parseStatement(statement);
    expect(typeof s).toBe('object');
    expect(statementText(s as any)).toBe(statement);
    expect(await verifySignature(d.spki, statement, signature)).toBe(true);
    expect(await verifySignature(d.spki, statement.replace('approve', 'deny\n'.slice(0, 7)), signature)).toBe(false);
    const other = await FakeDevice.make('dev_Other');
    expect(await verifySignature(other.spki, statement, signature)).toBe(false);
  });

  test('refuses anything not canonical', () => {
    const base = statementText({ ...ask('merge', ''), action: 'approve', messageSha256: sha256hex(''), device: 'dev_X', signed: 5 });
    expect(typeof parseStatement(base)).toBe('object');
    expect(parseStatement(base.slice(0, -1))).toBeString();
    expect(parseStatement(base.replace('signed 5', 'signed 05'))).toBeString();
    expect(parseStatement(base + 'extra x\n')).toBeString();
    expect(parseStatement(base.replace('kind merge', 'kind other'))).toBeString();
    expect(parseStatement(base.replace('action approve', 'action Approve'))).toBeString();
  });

  test('checkSigned holds the answer to its request and payload', async () => {
    const d = await FakeDevice.make();
    const a = ask('rebuild', 'p\n');
    const { statement, signature } = await d.answer(a, 'approve');
    expect((await checkSigned(statement, signature, [d.key()], { ask: a, payload: 'p\n' })).ok).toBe(true);
    expect((await checkSigned(statement, signature, [d.key()], { payload: 'q\n' })).reason).toContain('payload');
    expect((await checkSigned(statement, signature, [d.key()], { ask: { ...a, id: newId() } })).reason).toContain('another request');
    expect((await checkSigned(statement, signature, [], {})).reason).toContain('not in the keys');
  });

  test('keys files check their fingerprints', async () => {
    const d = await FakeDevice.make();
    const line = keysLine(d.key());
    expect(parseKeys(`# a comment\n${line}\n`)).toEqual([d.key()]);
    expect(parseKeys(line.replace(/ [0-9a-f:]{23} /, ' 00:00:00:00:00:00:00:00 '))).toBeString();
  });
});

/** A merge commit as the bot makes it, approved (or not) by `d`. */
async function approvedMerge(dir: string, d: FakeDevice, base: string, head: string, o: { repo?: string; tree?: string; action?: string } = {}) {
  const tree = o.tree ?? sh(dir, ['merge-tree', '--write-tree', base, head]).split('\n')[0]!;
  const payload = mergePayload({ repo: o.repo ?? 'sys', target: 'main', branch: 'review/x', base, head, tree });
  const a = ask('merge', payload);
  const { statement, signature } = await d.answer(a, o.action ?? 'approve', 'ok');
  const msg = `Merge review/x\n\nThe user's message: ok\n\n${approvalTrailers({ statement, payload, signature })}`;
  const rev = sh(dir, ['commit-tree', tree, '-p', base, '-p', head, '-F', '-'], msg);
  sh(dir, ['update-ref', 'refs/heads/main', rev]);
  sh(dir, ['reset', '-q', '--hard', 'main']);
  return rev;
}

describe('verify', () => {
  test('an approved merge is covered; a plain commit is not', async () => {
    const dir = tempRepo();
    const d = await FakeDevice.make();
    const keys = [d.key()];
    const base = await commitFile(dir, 'a.txt', 'one\n', 'start');
    sh(dir, ['checkout', '-q', '-b', 'review/x']);
    const head = await commitFile(dir, 'b.txt', 'two\n', 'agent work');
    sh(dir, ['checkout', '-q', 'main']);
    const merge = await approvedMerge(dir, d, base, head);
    expect(await verifyCommit(dir, merge, { keys, repo: 'sys' })).toMatchObject({ covered: true, by: 'merge', device: d.id });
    expect((await verifyCommit(dir, merge, { keys, repo: 'other' })).covered).toBe(false);
    expect((await verifyCommit(dir, merge, { keys: [] })).covered).toBe(false);
    const range = await verifyRange(dir, base, merge, { keys });
    expect(range.ok).toBe(true);
    // Second-parent commits are covered by the merge; a direct commit after it is not.
    const direct = await commitFile(dir, 'c.txt', 'sneaky\n', 'direct to main');
    const r2 = await verifyRange(dir, base, direct, { keys });
    expect(r2.ok).toBe(false);
    expect(r2.commits.map((c) => c.covered)).toEqual([true, false]);
  });

  test('a merge whose tree or parents differ from the approval is not covered', async () => {
    const dir = tempRepo();
    const d = await FakeDevice.make();
    const base = await commitFile(dir, 'a.txt', 'one\n', 'start');
    sh(dir, ['checkout', '-q', '-b', 'review/x']);
    const head = await commitFile(dir, 'b.txt', 'two\n', 'agent work');
    sh(dir, ['checkout', '-q', 'main']);
    const otherTree = sh(dir, ['rev-parse', `${base}^{tree}`]);
    const bad = await approvedMerge(dir, d, base, head, { tree: otherTree });
    // Same approval, but the commit's real tree isn't the one approved: forge by reusing trailers on another tree.
    const msg = sh(dir, ['log', '-1', '--format=%B', bad]);
    const realTree = sh(dir, ['merge-tree', '--write-tree', base, head]).split('\n')[0]!;
    const forged = sh(dir, ['commit-tree', realTree, '-p', base, '-p', head, '-F', '-'], msg + '\n');
    expect((await verifyCommit(dir, forged, { keys: [d.key()] })).reason).toContain('tree');
    const swapped = sh(dir, ['commit-tree', otherTree, '-p', head, '-p', base, '-F', '-'], msg + '\n');
    expect((await verifyCommit(dir, swapped, { keys: [d.key()] })).reason).toContain('parents');
    const denied = await approvedMerge(dir, d, base, head, { action: 'deny' });
    expect((await verifyCommit(dir, denied, { keys: [d.key()] })).reason).toContain('deny');
  });

  test('a range whose base is not on the first-parent chain fails', async () => {
    const dir = tempRepo();
    const d = await FakeDevice.make();
    const a = await commitFile(dir, 'a.txt', '1\n', 'a');
    sh(dir, ['checkout', '-q', '-b', 'side']);
    const side = await commitFile(dir, 's.txt', 's\n', 'side');
    sh(dir, ['checkout', '-q', 'main']);
    const b = await commitFile(dir, 'a.txt', '2\n', 'b');
    expect((await verifyRange(dir, side, b, { keys: [d.key()] })).ok).toBe(false);
    expect((await verifyRange(dir, a, a, { keys: [] })).ok).toBe(true);
  });

  test('a standing policy covers only the changes it allows', async () => {
    const dir = tempRepo();
    const d = await FakeDevice.make();
    const keys = [d.key()];
    const file = (v: string, h: string) => `{ pkgs }: let\n  version = "${v}";\nin {\n  src = fetchurl {\n    hash = "sha256-${h}=";\n  };\n}\n`;
    const base = await commitFile(dir, 'pkgs/app.nix', file('1.0', 'AAAA'), 'start');
    const payload = policyPayload({ name: 'app-bump', repo: 'sys', target: 'main', paths: ['pkgs/app.nix'], lines: ['^ *version = "[0-9A-Za-z.+-]+";$', '^ *hash = "sha256-[A-Za-z0-9+/]+=*";$'], maxLines: 4 });
    const a = ask('policy', payload);
    const { statement, signature } = await d.answer(a, 'approve');
    const trailers = approvalTrailers({ statement, payload, signature, policy: 'app-bump' });
    const bump = async (content: string, path = 'pkgs/app.nix') => {
      await Bun.write(`${dir}/${path}`, content);
      sh(dir, ['add', '-A']);
      sh(dir, ['commit', '-q', '-F', '-'], `app: bump\n\n${trailers}`);
      return sh(dir, ['rev-parse', 'HEAD']);
    };
    const good = await bump(file('1.1', 'BBBB'));
    expect(await verifyCommit(dir, good, { keys, repo: 'sys' })).toMatchObject({ covered: true, by: 'policy', policy: 'app-bump' });
    const sneaky = await bump(file('1.2', 'CCCC').replace('in {', 'in { inherit (builtins) exec;'));
    expect((await verifyCommit(dir, sneaky, { keys })).reason).toContain('matches none');
    sh(dir, ['reset', '-q', '--hard', good]);
    const other = await bump('x\n', 'other.nix');
    expect((await verifyCommit(dir, other, { keys })).reason).toContain('added');
    expect((await verifyRange(dir, base, good, { keys })).ok).toBe(true);
    // Expired: no longer covers.
    expect((await verifyCommit(dir, good, { keys, now: Date.now() + 2 * 3_600_000 })).reason).toContain('expired');
  });

  test('diff-hash changes with the tree and with untracked files', async () => {
    const dir = tempRepo();
    await commitFile(dir, 'a.txt', '1\n', 'a');
    const clean = diffHash(dir);
    await Bun.write(`${dir}/a.txt`, '2\n');
    const edited = diffHash(dir);
    await Bun.write(`${dir}/new.txt`, 'n\n');
    const untracked = diffHash(dir);
    expect(new Set([clean, edited, untracked]).size).toBe(3);
    expect(diffHash(dir)).toBe(untracked);
  });
});
