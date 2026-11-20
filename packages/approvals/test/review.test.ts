/**
 * The review watcher and merge bot (review.ts) against a plain git remote in a temp dir and an in-memory hub: a review
 * branch is asked about once its CI has a result, an approval merges it with its trailers and the bot's signature, a
 * denial sends it back, a newer head or a moved target asks again, a conflict says so.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionSpec, RequestView } from '../src/client.ts';
import { type ReviewHub, Reviewer } from '../src/review.ts';
import { type Ask, askText, cleanTitle, displayHash, keysLine, newId, sha256hex, type Kind } from '../src/statement.ts';
import { verifyCommit } from '../src/verify.ts';
import { FakeDevice, sh } from './helpers.ts';

/** Just enough of the hub: keeps requests; a test answers them as the phone. */
class FakeHub implements ReviewHub {
  items = new Map<string, RequestView & { askObj: Ask }>();
  async create(b: { kind: Kind; title: string; body?: string; payload?: string; actions?: ActionSpec[]; topic?: string }): Promise<RequestView> {
    const now = Date.now();
    const askObj: Ask = { id: newId(), kind: b.kind, asker: 'review', created: now, expires: now + 3_600_000, payloadSha256: sha256hex(b.payload ?? ''), displaySha256: displayHash(cleanTitle(b.title), b.body ?? '') };
    const v = { id: askObj.id, kind: b.kind, asker: 'review', title: cleanTitle(b.title), body: b.body ?? '', payload: b.payload ?? '', actions: b.actions ?? [], topic: b.topic ?? null, created: now, expires: askObj.expires, state: b.kind === 'alert' ? 'sent' : 'waiting', action: null, message: null, signed: false, device: null, via: null, statement: null, signature: null, cancelReason: null, ask: askText(askObj), askObj } as RequestView & { askObj: Ask };
    this.items.set(v.id, v);
    return v;
  }
  async get(id: string) {
    return this.items.get(id)!;
  }
  async cancel(id: string, reason?: string) {
    const v = this.items.get(id)!;
    if (v.state === 'waiting') Object.assign(v, { state: 'cancelled', cancelReason: reason ?? null });
    return v;
  }
  waiting() {
    return [...this.items.values()].filter((v) => v.state === 'waiting');
  }
  async answer(id: string, d: FakeDevice, action: string, message: string | null = null) {
    const v = this.items.get(id)!;
    const { statement, signature } = await d.answer(v.askObj, action, message);
    Object.assign(v, { state: 'answered', action, message, signed: action !== 'deny', statement: action !== 'deny' ? statement : null, signature: action !== 'deny' ? signature : null, device: { id: d.id, name: 'Test phone', kind: 'phone' }, via: 'device' });
  }
}

let root: string;
let remote: string;
let work: string;
let hub: FakeHub;
let phone: FakeDevice;
let bot: Reviewer;
const logs: string[] = [];

const commit = async (path: string, content: string, msg: string) => {
  writeFileSync(join(work, path), content);
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-q', '-m', msg]);
  return sh(work, ['rev-parse', 'HEAD']);
};
const remoteRef = (ref: string) => {
  const p = Bun.spawnSync(['git', '--git-dir', remote, 'rev-parse', '--verify', '-q', ref], { stdout: 'pipe' });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'review-'));
  remote = join(root, 'remote.git');
  work = join(root, 'work');
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', remote]);
  Bun.spawnSync(['git', 'clone', '-q', remote, work], { stderr: 'pipe' });
  for (const [k, v] of [['user.name', 'Agent'], ['user.email', 'agent@localhost'], ['commit.gpgsign', 'false']]) sh(work, ['config', k!, v!]);
  sh(work, ['checkout', '-q', '-b', 'main']);
  await commit('a.txt', 'one\n', 'start');
  sh(work, ['push', '-q', 'origin', 'main']);
  phone = await FakeDevice.make();
  writeFileSync(join(root, 'keys'), `${keysLine(phone.key())}\n`);
  // The bot's own SSH key.
  Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'review bot', '-f', join(root, 'bot')]);
  writeFileSync(join(root, 'ci.sh'), `#!/bin/sh\n[ -f "${root}/ci-$1" ] || exit 75\necho "host-a ok /nix/store/x"\n`, { mode: 0o755 });
  hub = new FakeHub();
  logs.length = 0;
  bot = new Reviewer(
    { keys: join(root, 'keys'), botKey: join(root, 'bot'), stateDir: join(root, 'state'), repos: [{ name: 'sys', remote, target: 'main', ci: { kind: 'command', command: [join(root, 'ci.sh'), '{rev}'] } }] },
    hub,
    (s) => logs.push(s),
  );
});

/** Push a review branch from the agent's clone. */
const pushReview = async (name: string, path: string, content: string) => {
  sh(work, ['checkout', '-q', '-B', `review/${name}`, 'main']);
  const head = await commit(path, content, `agent: ${name}`);
  sh(work, ['push', '-q', '-f', 'origin', `review/${name}`]);
  sh(work, ['checkout', '-q', 'main']);
  return head;
};
const ciPasses = (rev: string) => writeFileSync(join(root, `ci-${rev}`), '');

describe('review', () => {
  test('asks once CI has a result, merges on a signed approval, and the merge verifies', async () => {
    const head = await pushReview('fix', 'b.txt', 'two\n');
    await bot.tick();
    expect(hub.waiting()).toEqual([]);
    ciPasses(head);
    await bot.tick();
    const [req] = hub.waiting();
    expect(req!.title).toBe('Merge review/fix into main (sys)');
    expect(req!.body).toContain('host-a ok');
    expect(req!.payload).toContain(`head ${head}`);
    expect(req!.topic).toBe('sys:review/fix');
    await hub.answer(req!.id, phone, 'approve', 'nice');
    await bot.tick();
    const main = remoteRef('refs/heads/main')!;
    expect(remoteRef('refs/heads/review/fix')).toBeNull();
    const c = await verifyCommit(remote, main, { keys: [phone.key()], repo: 'sys' });
    expect(c).toMatchObject({ covered: true, by: 'merge' });
    const raw = Bun.spawnSync(['git', '--git-dir', remote, 'cat-file', 'commit', main], { stdout: 'pipe' }).stdout.toString();
    expect(raw).toContain('gpgsig -----BEGIN SSH SIGNATURE-----');
    expect(raw).toContain("The user's message: nice");
    expect(bot.snapshot().sys!['review/fix']!.state).toBe('merged');
  });

  test('a denial sends it back and asks nothing more until a new head', async () => {
    const head = await pushReview('bad', 'b.txt', 'two\n');
    ciPasses(head);
    await bot.tick();
    const first = hub.waiting()[0]!;
    await hub.answer(first.id, phone, 'deny', 'add a test');
    await bot.tick();
    expect(bot.snapshot().sys!['review/bad']).toMatchObject({ state: 'denied', note: 'add a test' });
    await bot.tick();
    expect(hub.waiting()).toEqual([]);
    const head2 = await pushReview('bad', 'b.txt', 'two, tested\n');
    ciPasses(head2);
    await bot.tick();
    expect(hub.waiting().map((v) => v.payload.includes(head2))).toEqual([true]);
  });

  test('a newer head cancels the request for the older one', async () => {
    const h1 = await pushReview('x', 'b.txt', '1\n');
    ciPasses(h1);
    await bot.tick();
    const first = hub.waiting()[0]!;
    const h2 = await pushReview('x', 'b.txt', '2\n');
    ciPasses(h2);
    await bot.tick();
    expect(hub.items.get(first.id)!.state).toBe('cancelled');
    expect(hub.waiting().length).toBe(1);
    // Approving the old one now does nothing.
    expect(remoteRef('refs/heads/main')).not.toContain(h1);
  });

  test('a target that moved after the approval is asked about again, never merged on the old approval', async () => {
    const head = await pushReview('y', 'b.txt', 'b\n');
    ciPasses(head);
    await bot.tick();
    const req = hub.waiting()[0]!;
    await hub.answer(req.id, phone, 'approve');
    // Someone else moves main first.
    await commit('c.txt', 'c\n', 'elsewhere');
    sh(work, ['push', '-q', 'origin', 'main']);
    const moved = remoteRef('refs/heads/main');
    await bot.tick();
    expect(remoteRef('refs/heads/main')).toBe(moved);
    expect(bot.snapshot().sys!['review/y']!.state).toBe('ci-wait');
    await bot.tick();
    expect(hub.waiting()[0]!.payload).toContain(`base ${moved}`);
  });

  test('an approval signed by a key the bot does not trust is not merged', async () => {
    const head = await pushReview('z', 'b.txt', 'b\n');
    ciPasses(head);
    await bot.tick();
    const stranger = await FakeDevice.make(phone.id);
    await hub.answer(hub.waiting()[0]!.id, stranger, 'approve');
    const before = remoteRef('refs/heads/main');
    await bot.tick();
    expect(remoteRef('refs/heads/main')).toBe(before);
    expect(bot.snapshot().sys!['review/z']!.state).toBe('failed');
  });

  test('a conflict is said as an alert, with nothing to approve', async () => {
    const head = await pushReview('c', 'a.txt', 'theirs\n');
    await commit('a.txt', 'ours\n', 'main changes a');
    sh(work, ['push', '-q', 'origin', 'main']);
    ciPasses(head);
    await bot.tick();
    const alert = [...hub.items.values()].find((v) => v.kind === 'alert')!;
    expect(alert.title).toContain('conflicts');
    expect(hub.waiting()).toEqual([]);
  });
});
