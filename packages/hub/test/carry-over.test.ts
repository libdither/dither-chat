/**
 * Adapter events still queued when the hub stops (supervisor.ts `settle`, `resume`). dither-accounts' manager keeps no
 * copy of what it has handed over, so a stop in the middle of a backlog applies what it can and carries the rest over
 * to the next start in pending-events.ndjson, which that start applies before anything newer, then removes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Store, type AccountRow } from '../src/store.ts';
import { EVENTS_STEP, PENDING_EVENTS, Supervisor } from '../src/supervisor.ts';

let dir: string;
let store: Store;
let ann: AccountRow;
let bob: AccountRow;
let realIngest: Store['ingest'];
let logged: string[];
const quiet = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-carry-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  realIngest = store.ingest.bind(store);
  for (const label of ['ann', 'bob']) {
    const a = store.createAccount({ network: 'matrix', label, color: '#000', adapter: 'matrix' });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: `${label}-self`, displayName: label } });
    store.ingest(a, { t: 'conversation', conversation: { nativeId: `${label}-room`, shape: 'group', name: 'Room' } });
    if (label === 'ann') ann = a;
    else bob = a;
  }
  logged = [];
  const keep = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  console.log = keep;
  console.warn = keep;
  console.error = keep;
});
afterEach(() => {
  Object.assign(console, quiet);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const room = (a: AccountRow) => `${a.label}-room`;
const msg = (a: AccountRow, n: number): P.AdapterEvent => ({ t: 'message', message: { nativeId: `${a.label}-${n}`, conversation: room(a), author: 'someone', ts: 1_700_000_000_000 + n, body: `${n}` } });
const msgs = (a: AccountRow, from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(a, from + i));
const stored = (a: AccountRow) => store.one<{ n: number }>(`SELECT count(*) AS n FROM message WHERE native_id LIKE ?`, `${a.label}-%`)!.n;
const pending = () => join(dir, PENDING_EVENTS);
/** A run of the hub: a supervisor of its own on the same data. */
const run = () => new Supervisor(store, { hubAdapterUrl: '', dataDir: dir, repoRoot: dir, inproc: () => null, onFresh: () => {} });
/** A backlog part-way through, as the live hub's was at its restart: the first slice in, the next one's turn never comes. */
function stuckMidBacklog(s: Supervisor) {
  s.slices = { clock: () => 0, budgetMs: 0, pause: () => new Promise(() => {}) };
}
/** Order the store saw messages in, from here on. */
function watchOrder(locked: () => boolean = () => false): string[] {
  const order: string[] = [];
  store.ingest = (a, ev) => {
    if (locked()) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    if (ev.t === 'message') order.push(ev.message.nativeId);
    return realIngest(a, ev);
  };
  return order;
}

describe('a stop in the middle of a backlog', () => {
  test('applies everything queued, and leaves no file behind', () => {
    const s = run();
    stuckMidBacklog(s);
    s.apply(ann.id, msgs(ann, 0, 200));
    s.apply(bob.id, msgs(bob, 0, 3));
    expect(stored(ann)).toBe(EVENTS_STEP);
    expect(s.backlog).toBe(200 - EVENTS_STEP + 3);

    const r = s.settle(Number.POSITIVE_INFINITY);
    expect(r).toEqual({ applied: 200 - EVENTS_STEP + 3, carried: 0, lost: 0 });
    expect([stored(ann), stored(bob)]).toEqual([200, 3]);
    expect(s.backlog).toBe(0);
    expect(existsSync(pending())).toBe(false);
  });

  test('out of time: carries the rest over, and the next start applies it before anything newer, then removes the file', () => {
    const order = watchOrder();
    const s = run();
    stuckMidBacklog(s);
    s.apply(ann.id, msgs(ann, 0, 100));
    s.apply(bob.id, msgs(bob, 0, 40));
    s.apply(ann.id, msgs(ann, 100, 110));
    // No time left: nothing more goes in now.
    const r = s.settle(0);
    expect(r).toEqual({ applied: 0, carried: 100 - EVENTS_STEP + 40 + 10, lost: 0 });
    expect(stored(ann)).toBe(EVENTS_STEP);
    expect(logged.some((l) => l.includes(`${r.carried} events`) && l.includes('carried over'))).toBe(true);
    // Private to the hub's user, one line per batch, in the order they came.
    expect(statSync(pending()).mode & 0o777).toBe(0o600);
    const lines = readFileSync(pending(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { account: string; events: P.AdapterEvent[] });
    expect(lines.map((l) => [l.account, l.events.length])).toEqual([[ann.id, 100 - EVENTS_STEP], [bob.id, 40], [ann.id, 10]]);

    // The next start.
    const next = run();
    expect(next.resume()).toBe(r.carried);
    next.apply(ann.id, [msg(ann, 999)]);
    expect([stored(ann), stored(bob)]).toEqual([111, 40]);
    expect(next.backlog).toBe(0);
    expect(existsSync(pending())).toBe(false);
    const annOrder = order.filter((n) => n.startsWith('ann-'));
    expect(annOrder).toEqual([...msgs(ann, 0, 110), msg(ann, 999)].map((e) => (e as Extract<P.AdapterEvent, { t: 'message' }>).message.nativeId));
  });
});

describe('a locked database at the stop', () => {
  test('carries the held events over; the next start applies them once the lock is gone', () => {
    let locked = false;
    const order = watchOrder(() => locked);
    const s = run();
    s.apply(ann.id, msgs(ann, 0, 5));
    locked = true;
    s.apply(ann.id, msgs(ann, 5, 10));
    expect(s.heldEvents).toBe(5);
    // Still locked at the stop: tried again a few times, then carried over.
    const r = s.settle(Number.POSITIVE_INFINITY);
    expect(r).toEqual({ applied: 0, carried: 5, lost: 0 });
    expect(stored(ann)).toBe(5);

    locked = false;
    const next = run();
    expect(next.resume()).toBe(5);
    expect(stored(ann)).toBe(10);
    expect(existsSync(pending())).toBe(false);
    expect(order).toEqual(msgs(ann, 0, 10).map((e) => (e as Extract<P.AdapterEvent, { t: 'message' }>).message.nativeId));
  });

  test('locked at the next start too: the file stays, newer events wait behind the carried ones, and the file goes once they are in', () => {
    let locked = false;
    const order = watchOrder(() => locked);
    const s = run();
    locked = true;
    s.apply(ann.id, msgs(ann, 0, 3));
    s.settle(Number.POSITIVE_INFINITY);
    expect(existsSync(pending())).toBe(true);

    const next = run();
    next.resume();
    expect(stored(ann)).toBe(0);
    expect(existsSync(pending())).toBe(true);
    next.apply(ann.id, [msg(ann, 3)]);
    expect(next.heldEvents).toBe(4);
    locked = false;
    next.retryHeld();
    expect(stored(ann)).toBe(4);
    expect(order).toEqual(['ann-0', 'ann-1', 'ann-2', 'ann-3']);
    expect(existsSync(pending())).toBe(false);
  });

  test('a commit that fails (a full disk) holds the events instead of losing them', () => {
    const s = run();
    const tx = store.db.transaction.bind(store.db);
    let full = true;
    store.db.transaction = ((fn: () => void) => {
      const t = tx(fn);
      return () => {
        if (full) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
        return t();
      };
    }) as typeof store.db.transaction;
    try {
      s.apply(ann.id, msgs(ann, 0, 3));
      expect(s.heldEvents).toBe(3);
      full = false;
      s.retryHeld();
    } finally {
      store.db.transaction = tx;
    }
    expect(stored(ann)).toBe(3);
  });
});

test('an event the full disk refuses is held, not skipped as a bad record, even when the batch around it commits', () => {
  let full = false;
  const order: string[] = [];
  store.ingest = (a, ev) => {
    if (ev.t === 'message' && ev.message.nativeId === 'ann-1' && full) throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
    if (ev.t === 'message') order.push(ev.message.nativeId);
    return realIngest(a, ev);
  };
  const s = run();
  full = true;
  s.apply(ann.id, msgs(ann, 0, 3));
  // The one before it is in; it and the one after wait, in order.
  expect(stored(ann)).toBe(1);
  expect(s.heldEvents).toBe(2);
  expect(logged.some((l) => l.includes('could not be written') && l.includes('2 events wait'))).toBe(true);
  full = false;
  s.retryHeld();
  expect(stored(ann)).toBe(3);
  expect(order).toEqual(['ann-0', 'ann-1', 'ann-2']);
});

test('a database locked past every try keeps its events and saves them, instead of dropping them', () => {
  let locked = true;
  watchOrder(() => locked);
  const s = run();
  s.apply(ann.id, msgs(ann, 0, 4));
  for (let i = 0; i < 60; i++) s.retryHeld();
  expect(s.heldEvents).toBe(4);
  expect(existsSync(pending())).toBe(true);
  expect(logged.some((l) => l.includes('stayed locked') && l.includes('4 events'))).toBe(true);
  locked = false;
  s.retryHeld();
  expect(stored(ann)).toBe(4);
  expect(existsSync(pending())).toBe(false);
});

test('events that cannot be saved are logged as lost, with their count', () => {
  const s = new Supervisor(store, { hubAdapterUrl: '', dataDir: join(dir, 'gone', 'away'), repoRoot: dir, inproc: () => null, onFresh: () => {} });
  stuckMidBacklog(s);
  s.apply(ann.id, msgs(ann, 0, 50));
  const r = s.settle(0);
  expect(r).toEqual({ applied: 0, carried: 0, lost: 50 - EVENTS_STEP });
  expect(logged.some((l) => l.includes(`LOST ${50 - EVENTS_STEP} events`))).toBe(true);
});

describe('the queue between runs', () => {
  test('a batch that comes after the last slice, while the worker is still finishing, is applied without waiting for another', async () => {
    const s = run();
    // The first batch is applied in one slice (a clock that never moves); the next comes before the worker has said
    // it is done.
    s.slices = { clock: () => 0 };
    s.apply(ann.id, msgs(ann, 0, 3 * EVENTS_STEP));
    s.apply(ann.id, msgs(ann, 1000, 1000 + 2 * EVENTS_STEP));
    expect(await s.settled(ann.id, 5000)).toBe(true);
    expect(stored(ann)).toBe(5 * EVENTS_STEP);
  });

  test("an account's barrier passes once everything it sent before is in, not another account's", async () => {
    const s = run();
    s.apply(bob.id, msgs(bob, 0, 4 * EVENTS_STEP));
    s.apply(ann.id, msgs(ann, 0, 2 * EVENTS_STEP));
    const at = s.settled(ann.id).then(() => stored(ann));
    expect(await at).toBe(2 * EVENTS_STEP);
    await s.drained();
    expect(stored(bob)).toBe(4 * EVENTS_STEP);
  });
});
