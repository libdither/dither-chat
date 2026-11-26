/**
 * Restarts as the pages see them (docs/sync.md "Restarts"). A stopping hub tells every socket so at once, with how long
 * its last few restarts took from the stop to answering again, kept in the data dir: the page says "Hub restarting,
 * back in about 9 s" rather than waiting 4 s to call it offline. Once back, the hub's code (its git commit) tells a page
 * whether this was a new release or the same one again.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILE = 'restarts.json';
/** How many restarts the usual time is taken from. */
const KEEP = 7;
/** A stop longer ago than this was not a restart (the hub was off, or the machine): not counted. */
const LONGEST = 30 * 60_000;

interface Restarts {
  /** When the last stop began, until the next start counts it. */
  stoppedAt?: number;
  /** Stop to answering again, ms, newest last. */
  downs: number[];
}

export function readRestarts(dataDir: string): Restarts {
  try {
    const r = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')) as Partial<Restarts>;
    return { stoppedAt: typeof r.stoppedAt === 'number' ? r.stoppedAt : undefined, downs: Array.isArray(r.downs) ? r.downs.filter((x) => typeof x === 'number' && x >= 0) : [] };
  } catch {
    return { downs: [] };
  }
}

function write(dataDir: string, r: Restarts) {
  const path = join(dataDir, FILE);
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(r));
    renameSync(`${path}.tmp`, path);
  } catch (e) {
    console.error('restarts: could not write', e);
  }
}

/** The middle of the last few restarts' times; undefined before the first. */
export function usualDown(r: Restarts): number | undefined {
  if (!r.downs.length) return undefined;
  const s = [...r.downs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The stop begins: kept, so the next start can count how long it was down. */
export function noteStopping(dataDir: string, now = Date.now()) {
  write(dataDir, { ...readRestarts(dataDir), stoppedAt: now });
}

/** Answering again: the time since the stop goes into the usual time. */
export function noteListening(dataDir: string, now = Date.now()) {
  const r = readRestarts(dataDir);
  if (r.stoppedAt === undefined) return;
  const down = now - r.stoppedAt;
  write(dataDir, { downs: down >= 0 && down <= LONGEST ? [...r.downs, down].slice(-KEEP) : r.downs });
}

/** The commit the code at `root` is checked out at (a release folder is a git worktree, docs/deploy.md), read without git. */
export function codeBuild(root: string): string | undefined {
  try {
    let git = join(root, '.git');
    if (statSync(git).isFile()) git = resolve(root, readFileSync(git, 'utf8').trim().replace(/^gitdir:\s*/, ''));
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 12);
    const ref = head.replace(/^ref:\s*/, '');
    const common = existsSync(join(git, 'commondir')) ? resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()) : git;
    for (const dir of [git, common])
      try {
        return readFileSync(join(dir, ref), 'utf8').trim().slice(0, 12);
      } catch {}
    const line = readFileSync(join(common, 'packed-refs'), 'utf8')
      .split('\n')
      .find((l) => l.endsWith(` ${ref}`));
    return line?.slice(0, 12);
  } catch {
    return undefined;
  }
}
