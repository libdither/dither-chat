/**
 * A message that moved to another conversation (`MessageFact.moved`: a Zulip topic renamed, or messages moved to
 * another topic): it leaves the old one, which falls back to its own newest message, and what points at it follows.
 * Without `moved` a message never changes conversation.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-moved-'));
const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const z = store.createAccount({ network: 'zulip', label: 'z', color: '#6492FE', adapter: 'zulip' });
const cnv = (n: string) => hubId('cnv', 'zulip', n);
const msg = (n: string) => hubId('msg', 'zulip', n);
const where = (n: string) => store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', msg(n))!.conversation_id;
const last = (c: string) => store.one<{ last_message_id: string | null; last_message_at: number | null }>('SELECT last_message_id, last_message_at FROM conversation WHERE id = ?', cnv(c))!;

store.ingest(z, { t: 'conversation', conversation: { nativeId: 'h/s/3', shape: 'channel', variant: 'forum', name: 'general' } });
for (const t of ['plans', 'later']) store.ingest(z, { t: 'conversation', conversation: { nativeId: `h/s/3/t/${t}`, shape: 'thread', name: t, parentConversation: 'h/s/3' } });
store.ingest(z, { t: 'message', message: { nativeId: 'h/m/1', conversation: 'h/s/3/t/plans', author: 'h/u/9', ts: 100, body: 'first' } });
store.ingest(z, { t: 'message', message: { nativeId: 'h/m/2', conversation: 'h/s/3/t/plans', author: 'h/u/9', ts: 200, body: 'second' } });

test('without moved, a fact naming another conversation leaves the message where it was', () => {
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/2', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 200, body: 'second' } });
  expect(where('h/m/2')).toBe(cnv('h/s/3/t/plans'));
});

test('a moved message changes conversation; the old one falls back to its newest left', () => {
  store.ingest(z, { t: 'saved', saved: [{ message: 'h/m/2', conversation: 'h/s/3/t/plans', savedAt: 1 }], complete: true });
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/2', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 200, body: 'second', moved: true } });
  expect(where('h/m/2')).toBe(cnv('h/s/3/t/later'));
  expect(last('h/s/3/t/plans')).toEqual({ last_message_id: msg('h/m/1'), last_message_at: 100 });
  expect(last('h/s/3/t/later')).toEqual({ last_message_id: msg('h/m/2'), last_message_at: 200 });
  expect(store.one<{ conversation_id: string }>('SELECT conversation_id FROM saved_message WHERE message_id = ?', msg('h/m/2'))?.conversation_id).toBe(cnv('h/s/3/t/later'));
  // And the last one out leaves it empty.
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/1', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 100, body: 'first', moved: true } });
  expect(last('h/s/3/t/plans')).toEqual({ last_message_id: null, last_message_at: null });
  expect(last('h/s/3/t/later').last_message_id).toBe(msg('h/m/2'));
});

test("a client's copy of the conversation a message left is answered with a fresh page when it comes back", async () => {
  const { syncResponse } = await import('../src/sync.ts');
  store.ingest(z, { t: 'conversation', conversation: { nativeId: 'h/s/3/t/away', shape: 'thread', name: 'away', parentConversation: 'h/s/3' } });
  for (const [n, ts] of [['h/m/5', 500], ['h/m/6', 600]] as const) store.ingest(z, { t: 'message', message: { nativeId: n, conversation: 'h/s/3/t/away', author: 'h/u/9', ts, body: n } });
  const pos = store.journal.position();
  const ask = (key: string) => ({ key, seq: pos.seq, newest: 600, oldest: 500 });
  const sync = () => syncResponse({ store, usage: {} as any, boot: 'b' }, { v: pos.v, epoch: pos.epoch, timelines: [ask(`c:${cnv('h/s/3/t/away')}`), ask(`c:${cnv('h/s/3/t/later')}`)] }) as Extract<P.SyncResponse, { sync: unknown }>;
  // Nothing moved yet: a delta, empty.
  expect(sync().timelines.map((t) => t.replace)).toEqual([false, false]);
  // Moved while the client was away.
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/6', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 600, body: 'h/m/6', moved: true } });
  const [away, later] = sync().timelines;
  expect(away.replace).toBe(true);
  expect(away.messages.map((m) => m.id)).toEqual([msg('h/m/5')]);
  // Where it went still gets a delta: it holds nothing it should not.
  expect(later.replace).toBe(false);
});
