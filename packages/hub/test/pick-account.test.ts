/**
 * Which account sends, reacts or fetches history in a conversation (server.ts pickAccount). With one account there it
 * must not read the conversation's messages: finding the last one you wrote in a channel you never wrote in reads all
 * of them, a second or more for one of 100k on the live hub, on every open and every push.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pickAccount } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';

describe('pickAccount', () => {
  let store: Store;
  let a: AccountRow;
  let b: AccountRow;
  const reads: string[] = [];
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;

  beforeAll(() => {
    store = new Store(':memory:', () => null);
    a = store.createAccount({ network: 'discord', label: 'a', color: '#000', adapter: 'discord' });
    b = store.createAccount({ network: 'discord', label: 'b', color: '#111', adapter: 'discord' });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: 'me-a', displayName: 'Me', isSelf: true } });
    store.ingest(b, { t: 'status', status: 'online', self: { nativeId: 'me-b', displayName: 'Me too', isSelf: true } });
    // Seen by a only, and nothing of yours in it.
    store.ingest(a, { t: 'conversation', conversation: { nativeId: 'big', shape: 'channel', name: 'big' } });
    store.db.transaction(() => {
      for (let i = 0; i < 500; i++) store.ingest(a, { t: 'message', message: { nativeId: `big${i}`, conversation: 'big', author: 'someone', body: 'hi', ts: 1000 + i }, live: false });
    })();
    // Seen by both; you last wrote from b.
    for (const acc of [a, b]) store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'both', shape: 'channel', name: 'both' } });
    store.ingest(a, { t: 'message', message: { nativeId: 'x1', conversation: 'both', author: 'me-a', body: 'from a', ts: 1000 }, live: false });
    store.ingest(b, { t: 'message', message: { nativeId: 'x2', conversation: 'both', author: 'me-b', body: 'from b', ts: 2000 }, live: false });
    store.ingest(a, { t: 'message', message: { nativeId: 'x3', conversation: 'both', author: 'someone', body: 'later', ts: 3000 }, live: false });
    const one = store.one.bind(store);
    store.one = ((sql: string, ...p: any[]) => (reads.push(sql), one(sql, ...p))) as typeof store.one;
  });
  afterAll(() => store.db.close());

  test('one account there: it, without reading the messages', () => {
    reads.length = 0;
    expect(pickAccount(store, () => true, cid('big'))).toBe(a.id);
    expect(pickAccount(store, () => false, cid('big'))).toBe(a.id);
    expect(reads.some((s) => s.includes('FROM message'))).toBe(false);
  });

  test('several: the requested one, else the one you last wrote from while it is connected, else the first connected', () => {
    const both = cid('both');
    const online = new Set([a.id, b.id]);
    const on = (id: string) => online.has(id);
    expect(pickAccount(store, on, both)).toBe(b.id);
    expect(pickAccount(store, on, both, a.id)).toBe(a.id);
    online.delete(b.id);
    reads.length = 0;
    // Only a is connected: nothing to choose, nothing read.
    expect(pickAccount(store, on, both)).toBe(a.id);
    expect(reads.some((s) => s.includes('FROM message'))).toBe(false);
    online.clear();
    expect([a.id, b.id]).toContain(pickAccount(store, on, both));
    expect(pickAccount(store, on, 'cnv_nowhere')).toBeNull();
  });
});
