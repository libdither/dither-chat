/**
 * The people graph's closeness worked out on a thread of its own (closeness.ts): a read-only connection to the hub's
 * database, one run per message, the answer posted back. The hub's thread never waits for it.
 */
import { Database } from 'bun:sqlite';
import { closeness } from './closeness.ts';

declare const self: Worker;

let db: Database | null = null;

self.onmessage = (e: MessageEvent<{ file: string }>) => {
  try {
    db ??= new Database(e.data.file, { readonly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    postMessage({ t: 'done', run: closeness(db) });
  } catch (err) {
    postMessage({ t: 'failed', error: String((err as Error)?.message ?? err) });
  }
};
