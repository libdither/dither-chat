import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadQueue } from '../src/readqueue.ts';
import { Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let d: AccountRow;
let m: AccountRow;
const PACE = { discord: 1500, matrix: 300, signal: 300 };

const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
const unread = (native: string) => store.one<{ unread: number }>(`SELECT unread FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, cid(native))!.unread;
function seed(acc: AccountRow, native: string) {
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: native, shape: 'group', name: native } });
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'them' } });
  store.ingest(acc, { t: 'message', message: { nativeId: `${native}-1`, conversation: native, author: 'them', ts: 1000, body: 'hi' }, live: true });
}
function fakeLink(online = () => true, fail: (conv: string) => boolean = () => false) {
  const sent: { account: string; conversation: string; upTo: string }[] = [];
  return {
    sent,
    online,
    command: async (account: string, c: { conversation: string; upTo: string }) => {
      if (fail(c.conversation)) throw new Error('rate limited');
      sent.push({ account, conversation: c.conversation, upTo: c.upTo });
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-readq-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  m = store.createAccount({ network: 'matrix', label: 'm', color: '#111', adapter: 'matrix' });
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const clear = () => store.db.query('DELETE FROM read_queue').run();

describe('mark all read', () => {
  test('clears here at once, skips what is already read, and tells the network later', async () => {
    clear();
    seed(d, 'a1');
    seed(d, 'a2');
    const link = fakeLink();
    const q = new ReadQueue(store, link, PACE);
    expect(unread('a1')).toBeGreaterThan(0);
    expect(q.add([cid('a1'), cid('a2')])).toBe(2);
    expect(unread('a1')).toBe(0);
    expect(link.sent).toHaveLength(0);
    expect(q.pending()).toBe(2);
    expect(q.add([cid('a1')])).toBe(0);
    expect(q.pending()).toBe(2);
  });

  test('paces one account and runs accounts side by side', async () => {
    clear();
    seed(d, 'b1');
    seed(d, 'b2');
    seed(m, 'b3');
    const link = fakeLink();
    const q = new ReadQueue(store, link, PACE);
    q.add([cid('b1'), cid('b2'), cid('b3')]);
    await q.tick(10_000);
    expect(link.sent.map((s) => s.conversation).sort()).toEqual(['b1', 'b3']);
    await q.tick(10_100);
    expect(link.sent).toHaveLength(2); // Discord's pace has not passed
    await q.tick(11_500);
    expect(link.sent.map((s) => s.conversation).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(link.sent.find((s) => s.conversation === 'b2')?.upTo).toBe('b2-1');
    expect(q.pending()).toBe(0);
  });

  test('an offline account waits, and a new queue picks up after a restart', async () => {
    clear();
    seed(d, 'c1');
    const offline = fakeLink(() => false);
    const q = new ReadQueue(store, offline, PACE);
    q.add([cid('c1')]);
    await q.tick(20_000);
    expect(offline.sent).toHaveLength(0);
    const back = fakeLink();
    const q2 = new ReadQueue(store, back, PACE);
    expect(q2.pending()).toBe(1);
    await q2.tick(20_000);
    expect(back.sent).toHaveLength(1);
  });

  test('a failure backs off, holds that account, and gives up after a few tries without losing the rest', async () => {
    clear();
    seed(d, 'e1');
    seed(d, 'e2');
    const link = fakeLink(() => true, (c) => c === 'e1');
    const q = new ReadQueue(store, link, PACE);
    q.add([cid('e1'), cid('e2')]);
    let t = 100_000;
    await q.tick(t);
    expect(store.one<{ attempts: number }>('SELECT attempts FROM read_queue WHERE conversation_id = ?', cid('e1'))!.attempts).toBe(1);
    await q.tick(t + 2000);
    expect(link.sent).toHaveLength(0); // backing off, not hammering with the next one
    for (let i = 0; i < 12; i++) {
      t += 500_000;
      await q.tick(t);
    }
    expect(link.sent.map((s) => s.conversation)).toEqual(['e2']);
    expect(q.pending()).toBe(0);
    const reported = store.dirty.extra.filter((e) => e.t === 'readProgress').at(-1) as { failed: number };
    expect(reported.failed).toBe(1);
  });
});
