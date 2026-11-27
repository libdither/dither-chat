/**
 * Message search on a thread of its own (search-thread.ts, docs/search.md "On a thread of its own"): a read-only Store
 * on the hub's database runs each search the hub's thread hands it and posts the page back. A search the hub has called
 * off since (a newer one from the same device, or its request gone) is skipped: `states` says which.
 */
import { mediaSigner } from './mediasign.ts';
import { Store } from './store.ts';
import type { WorkerIn } from './search-thread.ts';

declare const self: Worker;

let store: Store | null = null;
let states: Int32Array | null = null;

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.t === 'open') {
    try {
      store = new Store(m.file, mediaSigner(m.secret), { reader: true });
      states = new Int32Array(m.states);
      postMessage({ t: 'opened' });
    } catch (err) {
      postMessage({ t: 'broken', error: String((err as Error)?.message ?? err) });
    }
    return;
  }
  if (m.t === 'hold') {
    // Busy until the hub lets go (tests: a search queued behind a slow one).
    postMessage({ t: 'holding' });
    Atomics.wait(new Int32Array(m.gate), 0, 0);
    return;
  }
  if (!store || !states) return;
  // The writes the hub reported come before anything else, a skipped search's too: none is lost.
  store.peopleChanged(m.people);
  if (m.t === 'warm') {
    // People search's list, loaded before the first search needs it.
    for (const _ of store.loadPeopleSteps());
    return;
  }
  // Queued (its id) to running (minus its id), unless the hub called it off first (0).
  if (Atomics.compareExchange(states, m.id % states.length, m.id, -m.id) !== m.id) {
    postMessage({ t: 'skipped', id: m.id });
    return;
  }
  const s = store;
  try {
    // One read transaction: every query of the search sees the database as it was at its start.
    const page = s.db.transaction(() => {
      s.beforeRead();
      return s.search(m.q, m.limit, m.cursor, m.context, { typing: m.typing });
    })();
    postMessage({ t: 'done', id: m.id, page });
  } catch (err) {
    postMessage({ t: 'failed', id: m.id, error: String((err as Error)?.message ?? err) });
  }
};
