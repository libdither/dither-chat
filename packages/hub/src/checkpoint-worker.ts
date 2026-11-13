/**
 * The checkpointer's thread (checkpoint.ts): a connection of its own to the hub's database that copies the write-ahead
 * log back into the database file, as SQLite would inside some commit of the hub's. A passive checkpoint waits for
 * nobody and nobody waits for it.
 */
import { Database } from 'bun:sqlite';

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ file: string; everyMs: number }>) => {
  const { file, everyMs } = e.data;
  const db = new Database(file);
  db.exec('PRAGMA busy_timeout = 5000');
  // A checkpoint syncs the log before it copies and the database file after (unless `synchronous` is OFF): with the
  // hub's commits at NORMAL (store.ts), this is when they reach the disk.
  const timer = setInterval(() => {
    const t = performance.now();
    try {
      const r = db.query('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number };
      postMessage({ t: 'done', log: r.log, checkpointed: r.checkpointed, ms: performance.now() - t });
    } catch (err) {
      postMessage({ t: 'failed', error: String((err as Error)?.message ?? err) });
    }
  }, everyMs);
  self.addEventListener('close', () => {
    clearInterval(timer);
    db.close();
  });
};
