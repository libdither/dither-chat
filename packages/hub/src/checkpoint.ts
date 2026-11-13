/**
 * Checkpoints off the hub's thread (docs/perf.md, "Checkpoints"). In WAL mode SQLite copies the log back into the
 * database file now and then. By default the connection whose commit takes the log past 1,000 pages does it, inside
 * that commit, with an fsync of the database file; on the live hub (1.4 GB, a busy disk) that held the hub's one
 * thread for 2 to 10 s after a burst of writes, under whatever happened to commit next (an adapter event, a flush).
 *
 * So the hub's connection does none (wal_autocheckpoint = 0), and a worker thread with a connection of its own runs a
 * passive checkpoint every `everyMs`: it copies what it can without waiting for anyone, and the log is written from
 * its start again once all of it is in. Nothing about what is kept or how safely changes: commits are as before. If
 * the worker stops, the hub's connection checkpoints again as SQLite would by default.
 */
import type { Database } from 'bun:sqlite';

export interface Checkpointer {
  /** Checkpoints done, and the longest one (ms, on the worker's thread). */
  readonly stats: { done: number; longestMs: number; failed: number };
  stop(): void;
}

/** SQLite's own default: a checkpoint once the log passes this many pages. */
const DEFAULT_PAGES = 1000;

export function startCheckpointer(db: Database, file: string, o: { everyMs?: number; log?: (line: string) => void; onDone?: (r: { log: number; checkpointed: number }) => void } = {}): Checkpointer {
  const log = o.log ?? ((l) => console.error(l));
  const stats = { done: 0, longestMs: 0, failed: 0 };
  let stopped = false;
  db.exec('PRAGMA wal_autocheckpoint = 0');
  const worker = new Worker(new URL('./checkpoint-worker.ts', import.meta.url).href);
  const fallBack = (why: string) => {
    if (stopped) return;
    stopped = true;
    db.exec(`PRAGMA wal_autocheckpoint = ${DEFAULT_PAGES}`);
    log(`checkpoints: the worker ${why}; the hub's connection checkpoints again`);
    reportError({ source: 'job', where: 'checkpoint worker', name: 'Error', message: `the worker ${why}` });
  };
  worker.onmessage = (e: MessageEvent<{ t: 'done' | 'failed'; ms?: number; log?: number; checkpointed?: number; error?: string }>) => {
    if (e.data.t === 'done') {
      stats.done++;
      stats.longestMs = Math.max(stats.longestMs, e.data.ms ?? 0);
      o.onDone?.({ log: e.data.log ?? 0, checkpointed: e.data.checkpointed ?? 0 });
    } else {
      if (++stats.failed % 60 === 1) log(`checkpoints: ${e.data.error}`);
      reportError({ source: 'job', where: 'checkpoint', name: 'SQLiteError', message: e.data.error ?? 'failed' });
    }
  };
  worker.onerror = (e) => fallBack(`failed (${e.message})`);
  worker.addEventListener('close', () => fallBack('stopped'));
  worker.postMessage({ file, everyMs: o.everyMs ?? 1000 });
  (worker as { unref?: () => void }).unref?.();
  return {
    stats,
    stop() {
      if (stopped) return;
      stopped = true;
      worker.terminate();
      db.exec(`PRAGMA wal_autocheckpoint = ${DEFAULT_PAGES}`);
    },
  };
}
