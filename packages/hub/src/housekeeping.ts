/**
 * The data directory's upkeep (docs/deploy.md, "Backups and upkeep"): who may read it, a nightly copy of the
 * database, the media cache kept under a size, adapter logs rotated, and triage rows nobody learns from let go.
 */

import { chmodSync, existsSync, mkdirSync, opendirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { whole } from './slices.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Everything the hub keeps is private to its user: the database holds every message. Files other users could read
 * (the database and its WAL, backups, the log, from before the hub set its umask) are closed to them.
 */
export function tightenPermissions(dataDir: string): string[] {
  const fixed: string[] = [];
  const fix = (p: string, mode: number) => {
    try {
      const st = statSync(p);
      if ((st.mode & 0o077) === 0) return;
      chmodSync(p, mode);
      fixed.push(p);
    } catch {}
  };
  if (!existsSync(dataDir)) return fixed;
  fix(dataDir, 0o700);
  for (const name of readdirSync(dataDir)) {
    const p = join(dataDir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      fix(p, 0o700);
      if (name === 'backups') for (const f of readdirSync(p)) fix(join(p, f), 0o600);
    } else fix(p, 0o600);
  }
  return fixed;
}

export interface BackupOpts {
  dataDir: string;
  /** The database to copy. */
  db: string;
  /** Local hour of the day to take it (DITHER_BACKUP_HOUR, default 4). */
  hour?: number;
  /** Nightly copies to keep (DITHER_BACKUP_KEEP, default 7). Copies you made yourself are never removed. */
  keep?: number;
  now?: () => number;
  /** Runs the copy; replaced in tests. Default: a child process, so the hub's event loop never waits on it. */
  copy?: (from: string, to: string) => Promise<void>;
}

/** A nightly `VACUUM INTO` of the database into backups/auto-<date>.sqlite, the newest `keep` of them kept. */
export class NightlyBackup {
  private timer?: Timer;
  private running = false;
  readonly dir: string;
  constructor(private o: BackupOpts) {
    this.dir = join(o.dataDir, 'backups');
  }

  private get now() {
    return this.o.now?.() ?? Date.now();
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The newest nightly copy's time (from its name, auto-<ISO time>.sqlite), or 0. */
  last(): number {
    const name = this.list().at(-1);
    const iso = name?.match(/^auto-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.sqlite$/);
    return iso ? Date.parse(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}.${iso[5]}Z`) : 0;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => /^auto-.*\.sqlite$/.test(f)).sort();
  }

  /** Copy when the hour has come and no copy was made in the last 20 hours; or when none was in the last 36 (downtime). */
  due(): boolean {
    const hour = this.o.hour ?? (Number.isInteger(Number(process.env.DITHER_BACKUP_HOUR)) && process.env.DITHER_BACKUP_HOUR ? Number(process.env.DITHER_BACKUP_HOUR) : 4);
    const since = this.now - this.last();
    return (new Date(this.now).getHours() === hour && since > 20 * HOUR) || since > 36 * HOUR;
  }

  async tick(force = false): Promise<string | null> {
    if (this.running || (!force && !this.due())) return null;
    this.running = true;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const stamp = new Date(this.now).toISOString().replace(/[:.]/g, '-');
      const to = join(this.dir, `auto-${stamp}.sqlite`);
      const part = `${to}.part`;
      await (this.o.copy ?? vacuumInto)(this.o.db, part);
      chmodSync(part, 0o600);
      renameSync(part, to);
      const keep = this.o.keep ?? (Number(process.env.DITHER_BACKUP_KEEP) || 7);
      const all = this.list();
      for (const f of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(this.dir, f), { force: true });
      return to;
    } catch (e) {
      console.error('backup failed', e);
      return null;
    } finally {
      this.running = false;
      for (const f of existsSync(this.dir) ? readdirSync(this.dir) : []) if (f.endsWith('.sqlite.part')) rmSync(join(this.dir, f), { force: true });
    }
  }
}

/** A consistent copy of a WAL database from a second, read-only connection in a child process. */
async function vacuumInto(from: string, to: string) {
  const script = `import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1], { readonly: true }); db.exec("PRAGMA busy_timeout = 10000"); db.exec("VACUUM INTO '" + process.argv[2].replace(/'/g, "''") + "'"); db.close();`;
  const proc = Bun.spawn(['bun', '-e', script, from, to], { stdout: 'ignore', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`VACUUM INTO exited ${code}: ${(await new Response(proc.stderr).text()).trim()}`);
}

/**
 * The media cache is kept indefinitely: it holds every attachment the archiver fetched (mediaarchive.ts), and
 * Discord's links expire, so anything evicted may never come back. Only leftover partial downloads go. Setting
 * DITHER_MEDIA_CACHE_MB caps it again: past that, the least recently shown files go first (server.ts touches a file
 * each time it serves it).
 */
export function pruneMediaCache(dir: string, maxBytes = mediaCacheCap(), now = Date.now()): { removed: number; bytes: number } {
  return whole(pruneMediaCacheSteps(dir, maxBytes, now));
}

const mediaCacheCap = () => (Number(process.env.DITHER_MEDIA_CACHE_MB) > 0 ? Number(process.env.DITHER_MEDIA_CACHE_MB) * 1024 * 1024 : Infinity);

/** The directory's names in its own order, a few at a time (the live cache is tens of thousands). */
function* entries(dir: string): Generator<number, string[]> {
  const d = opendirSync(dir);
  const out: string[] = [];
  try {
    for (let e = d.readSync(); e; e = d.readSync()) {
      out.push(e.name);
      if (out.length % CACHE_STEP === 0) yield CACHE_STEP;
    }
  } finally {
    d.closeSync();
  }
  return out;
}

/** Files looked at between turns of the event loop when upkeep walks the media cache. */
export const CACHE_STEP = 512;

/**
 * `pruneMediaCache` as steps (slices.ts): on the live hub the cache is 80k names, every one stat'ed and every .mime
 * checked, 3 s of the hub's thread in one go. The same files go, in the same order.
 */
export function* pruneMediaCacheSteps(dir: string, maxBytes = mediaCacheCap(), now = Date.now()): Generator<number, { removed: number; bytes: number }> {
  if (!existsSync(dir)) return { removed: 0, bytes: 0 };
  const files: { name: string; size: number; at: number }[] = [];
  let removed = 0;
  let done = 0;
  for (const name of yield* entries(dir)) {
    if (++done >= CACHE_STEP) {
      done = 0;
      yield CACHE_STEP;
    }
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (name.endsWith('.tmp')) {
      if (now - st.mtimeMs > HOUR) rmSync(p, { force: true }), removed++;
      continue;
    }
    if (name.endsWith('.mime')) continue;
    files.push({ name, size: st.size, at: st.mtimeMs });
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  files.sort((a, b) => a.at - b.at);
  for (const f of files) {
    if (total <= maxBytes) break;
    rmSync(join(dir, f.name), { force: true });
    rmSync(join(dir, f.name + '.mime'), { force: true });
    total -= f.size;
    removed++;
    if (++done >= CACHE_STEP) {
      done = 0;
      yield CACHE_STEP;
    }
  }
  // A .mime whose file is gone answers nothing.
  for (const name of yield* entries(dir)) {
    if (name.endsWith('.mime') && !existsSync(join(dir, name.slice(0, -5)))) rmSync(join(dir, name), { force: true });
    if (++done >= CACHE_STEP) {
      done = 0;
      yield CACHE_STEP;
    }
  }
  return { removed, bytes: total };
}

/** Each account's adapter.log past `maxBytes` becomes adapter.log.1 (the one before that goes). */
export function rotateAdapterLogs(accountsDir: string, maxBytes = 10 * 1024 * 1024): number {
  if (!existsSync(accountsDir)) return 0;
  let n = 0;
  for (const id of readdirSync(accountsDir)) {
    const log = join(accountsDir, id, 'adapter.log');
    try {
      if (statSync(log).size <= maxBytes) continue;
      renameSync(log, log + '.1');
      n++;
    } catch {}
  }
  return n;
}

export { DAY, HOUR };
