/** How long restarts take, kept in the data dir (restarts.ts), and the code a hub runs, read from its checkout. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeBuild, noteListening, noteStopping, readRestarts, usualDown } from '../src/restarts.ts';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'restarts-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('restarts', () => {
  test('a stop and the next start make one restart time; the usual is their middle', () => {
    const d = temp();
    expect(usualDown(readRestarts(d))).toBeUndefined();
    for (const [stop, up] of [
      [0, 9000],
      [100_000, 107_000],
      [200_000, 260_000],
    ]) {
      noteStopping(d, stop);
      noteListening(d, up);
    }
    expect(readRestarts(d)).toEqual({ downs: [9000, 7000, 60_000] });
    expect(usualDown(readRestarts(d))).toBe(9000);
  });

  test('a start with no stop before it, or one long after, is not a restart', () => {
    const d = temp();
    noteListening(d, 5000);
    expect(readRestarts(d).downs).toEqual([]);
    noteStopping(d, 0);
    noteListening(d, 3 * 3600_000);
    expect(readRestarts(d)).toEqual({ downs: [] });
  });

  test('only the last few are kept', () => {
    const d = temp();
    for (let i = 0; i < 12; i++) {
      noteStopping(d, i * 1000_000);
      noteListening(d, i * 1000_000 + 1000 + i);
    }
    expect(readRestarts(d).downs).toHaveLength(7);
    expect(readRestarts(d).downs[6]).toBe(1011);
  });
});

describe('codeBuild', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  test('a detached checkout, a worktree, a branch through packed refs', () => {
    const a = temp();
    mkdirSync(join(a, '.git'));
    writeFileSync(join(a, '.git/HEAD'), `${sha}\n`);
    expect(codeBuild(a)).toBe(sha.slice(0, 12));

    const repo = temp();
    mkdirSync(join(repo, '.git/worktrees/r1'), { recursive: true });
    writeFileSync(join(repo, '.git/worktrees/r1/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git/worktrees/r1/commondir'), '../..\n');
    writeFileSync(join(repo, '.git/packed-refs'), `# pack-refs\n${sha} refs/heads/main\n`);
    const wt = temp();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git/worktrees/r1')}\n`);
    expect(codeBuild(wt)).toBe(sha.slice(0, 12));
  });

  test('no checkout: unknown', () => {
    expect(codeBuild(temp())).toBeUndefined();
  });
});
