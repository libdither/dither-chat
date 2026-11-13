/**
 * Another process with the hub's database open (a backup's VACUUM INTO, the sqlite3 shell) can hold a lock for a moment.
 * The hub's writes wait for it (busy_timeout, store.ts) instead of failing; an adapter event the database stayed locked
 * for waits with everything after it and is applied again, in order; one that fails for another reason is skipped and
 * the rest of its batch goes on (supervisor.ts); and a flush whose attention part fails still sends what the store
 * gave up (server.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { HubServer } from '../src/server.ts';
import { BUSY_MS, Store, type AccountRow } from '../src/store.ts';
import { Supervisor } from '../src/supervisor.ts';
import { Triage } from '../src/triage.ts';

let dir: string;
let store: Store;
let acc: AccountRow;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-busy-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  acc = store.createAccount({ network: 'matrix', label: 'm', color: '#000', adapter: 'matrix' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'room', shape: 'group', name: 'Room' } });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const msg = (n: string): P.AdapterEvent => ({ t: 'message', message: { nativeId: n, conversation: 'room', author: 'ann', ts: 1_700_000_000_000 + n.length, body: n } });
const have = (n: string) => !!store.one('SELECT 1 AS x FROM message WHERE native_id = ?', n);

/** Another process takes the write lock, says so, and lets go after `holdMs`. */
async function lockFromAnotherProcess(file: string, holdMs: number) {
  const script = `import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); console.log('released'); }, Number(process.argv[2]));`;
  const proc = Bun.spawn(['bun', '-e', script, file, String(holdMs)], { stdout: 'pipe', stderr: 'inherit' });
  const reader = proc.stdout.getReader();
  let out = '';
  while (!out.includes('locked')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the locking process ended first');
    out += new TextDecoder().decode(value);
  }
  return { proc, done: proc.exited };
}

describe('a lock held by another process', () => {
  test("the hub's writes wait for it and go in, instead of failing", async () => {
    expect(BUSY_MS).toBeGreaterThanOrEqual(1000);
    const lock = await lockFromAnotherProcess(join(dir, 'hub.sqlite'), 300);
    // The lock is held now: this write waits for it.
    store.ingest(acc, msg('while-locked'));
    expect(have('while-locked')).toBe(true);
    await lock.done;
  });

  test('without the wait the same lock fails a write: what the live hub saw during a backup', async () => {
    store.db.exec('PRAGMA busy_timeout = 0');
    try {
      const lock = await lockFromAnotherProcess(join(dir, 'hub.sqlite'), 300);
      let code: string | undefined;
      try {
        store.ingest(acc, msg('no-wait'));
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe('SQLITE_BUSY');
      await lock.done;
      expect(have('no-wait')).toBe(false);
    } finally {
      store.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    }
  });
});

describe("an adapter's events", () => {
  const sup = () => new Supervisor(store, { hubAdapterUrl: '', dataDir: dir, repoRoot: dir, inproc: () => null, onFresh: () => {} });

  test('one that fails is skipped, and the events after it in the batch still go in', () => {
    const s = sup();
    const ingest = store.ingest.bind(store);
    store.ingest = (a, ev) => {
      if (ev.t === 'message' && ev.message.nativeId === 'bad') throw new Error('something else went wrong');
      return ingest(a, ev);
    };
    try {
      s.apply(acc.id, [msg('a1'), msg('bad'), msg('a3')]);
    } finally {
      store.ingest = ingest;
    }
    expect([have('a1'), have('bad'), have('a3')]).toEqual([true, false, true]);
    expect(s.heldEvents).toBe(0);
  });

  test('one the database stayed locked for waits, with all that came after it, and goes in again in order', () => {
    const s = sup();
    const ingest = store.ingest.bind(store);
    const order: string[] = [];
    let locked = true;
    store.ingest = (a, ev) => {
      if (ev.t === 'message' && ev.message.nativeId === 'b2' && locked) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      if (ev.t === 'message') order.push(ev.message.nativeId);
      return ingest(a, ev);
    };
    try {
      s.apply(acc.id, [msg('b1'), msg('b2'), msg('b3')]);
      expect([have('b1'), have('b2'), have('b3')]).toEqual([true, false, false]);
      expect(s.heldEvents).toBe(2);
      // A later batch waits behind them.
      s.apply(acc.id, [msg('b4')]);
      expect(s.heldEvents).toBe(3);
      expect(have('b4')).toBe(false);
      locked = false;
      s.retryHeld();
      expect(s.heldEvents).toBe(0);
      expect(order).toEqual(['b1', 'b2', 'b3', 'b4']);
    } finally {
      store.ingest = ingest;
    }
  });
});

test("a flush whose attention part fails still sends what the store gave up", () => {
  const sent: P.ClientEvent[][] = [];
  const attention = {
    sync: () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    },
  };
  const hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', attention: attention as any });
  // A device on the live socket: what it is sent.
  (hub as unknown as { clients: Set<{ send(f: string): void }> }).clients.add({ send: (f) => void sent.push(JSON.parse(f)) });
  store.flush();
  store.ingest(acc, msg('flushed'));
  hub.flush();
  // The conversation's new last message: what attention would have scored, sent though attention failed.
  const room = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'room'`)!.id;
  expect(sent.flat().some((e) => e.t === 'conversation' && e.conversation.id === room)).toBe(true);
});
