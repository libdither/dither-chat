/**
 * A channel's stream (docs/threads.md "The channel stream"): the channel's own messages and every thread's, by time,
 * through the hub's route and through sync's `k:<channel>` key; a thread that starts later joins it, and a message
 * moved to another channel's topic leaves it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { syncResponse } from '../src/sync.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-stream-'));
let store: Store;
let hub: HubServer;
let url = '';
let z: AccountRow;
let mx: AccountRow;
const zc = (n: string) => hubId('cnv', 'zulip', n);
const zm = (n: string) => hubId('msg', 'zulip', n);
const mc = (n: string) => hubId('cnv', 'matrix', n);
const mm = (n: string) => hubId('msg', 'matrix', n);
const get = async <T = any>(path: string): Promise<{ status: number; json: T }> => {
  const res = await fetch(url + path);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
};
const say = (a: AccountRow, conversation: string, nativeId: string, ts: number) =>
  store.ingest(a, { t: 'message', message: { nativeId, conversation, author: 'u/9', ts, body: nativeId } });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  hub = new HubServer(store, { authorize: () => null, online: () => true, command: async () => ({}) } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's' });
  url = `http://127.0.0.1:${hub.start().port}`;
  z = store.createAccount({ network: 'zulip', label: 'z', color: '#000', adapter: 'zulip' });
  mx = store.createAccount({ network: 'matrix', label: 'm', color: '#000', adapter: 'matrix' });
  // A Zulip channel of two topics, and another channel beside it.
  for (const ch of ['s/1', 's/2']) store.ingest(z, { t: 'conversation', conversation: { nativeId: ch, shape: 'channel', variant: 'forum', name: ch } });
  for (const [t, ch] of [['s/1/t/plans', 's/1'], ['s/1/t/lunch', 's/1'], ['s/2/t/other', 's/2']]) store.ingest(z, { t: 'conversation', conversation: { nativeId: t, shape: 'thread', name: t, parentConversation: ch } });
  say(z, 's/1/t/plans', 'm/1', 100);
  say(z, 's/1/t/lunch', 'm/2', 200);
  say(z, 's/1/t/plans', 'm/3', 300);
  say(z, 's/2/t/other', 'm/4', 250);
  // A Matrix room with a thread: the room's own messages are in its stream too.
  store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!r', shape: 'channel', variant: 'text', name: 'room' } });
  store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!r|$root', shape: 'thread', variant: 'text', name: 'a thread', parentConversation: '!r' } });
  say(mx, '!r', '$root', 100);
  say(mx, '!r|$root', '$in', 150);
  say(mx, '!r', '$after', 200);
});

afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a Zulip channel's stream is its topics' messages by time, and nothing of the channel beside it", async () => {
  const r = await get<P.MessagePage & { conversationIds: string[] }>(`/api/conversations/${zc('s/1')}/stream`);
  expect(r.status).toBe(200);
  expect(r.json.messages.map((m) => m.id)).toEqual([zm('m/1'), zm('m/2'), zm('m/3')]);
  expect([...r.json.conversationIds].sort()).toEqual([zc('s/1'), zc('s/1/t/lunch'), zc('s/1/t/plans')].sort());
  expect(r.json.hasMore).toBe(false);
});

test('a page goes back from the oldest held, by time and id', async () => {
  const first = await get<P.MessagePage>(`/api/conversations/${zc('s/1')}/stream?limit=2`);
  expect(first.json.messages.map((m) => m.id)).toEqual([zm('m/2'), zm('m/3')]);
  expect(first.json.hasMore).toBe(true);
  const oldest = first.json.messages[0];
  const next = await get<P.MessagePage>(`/api/conversations/${zc('s/1')}/stream?limit=2&before=${oldest.ts}:${encodeURIComponent(oldest.id)}`);
  expect(next.json.messages.map((m) => m.id)).toEqual([zm('m/1')]);
  expect(next.json.hasMore).toBe(false);
});

test("a Matrix room's stream holds the room's own messages and its threads'", async () => {
  const r = await get<P.MessagePage>(`/api/conversations/${mc('!r')}/stream`);
  expect(r.json.messages.map((m) => m.id)).toEqual([mm('$root'), mm('$in'), mm('$after')]);
  expect((await get(`/api/conversations/cnv_nothing/stream`)).status).toBe(404);
});

test('sync of a stream: a new thread and its message come as a delta; a message moved to another channel asks for a fresh page', () => {
  const pos = store.journal.position();
  const key = `k:${zc('s/1')}`;
  const ask = (): P.SyncTimelineRequest => ({ key, seq: pos.seq, newest: 300, oldest: 100, conversationIds: store.channelStream(zc('s/1')) });
  const sync = () => (syncResponse({ store, usage: {} as any, boot: 'b' }, { v: pos.v, epoch: pos.epoch, timelines: [ask()] }) as Extract<P.SyncResponse, { sync: unknown }>).timelines[0];
  expect(sync()).toMatchObject({ key, replace: false, messages: [] });
  // A topic started since: its message is newer than what is held, so the delta carries it.
  store.ingest(z, { t: 'conversation', conversation: { nativeId: 's/1/t/new', shape: 'thread', name: 'new', parentConversation: 's/1' } });
  say(z, 's/1/t/new', 'm/5', 400);
  const d = sync();
  expect(d.replace).toBe(false);
  expect(d.messages.map((m) => m.id)).toEqual([zm('m/5')]);
  expect(d.conversationIds).toContain(zc('s/1/t/new'));
  // A message moved to another channel's topic: a delta cannot take it away, a fresh page does.
  store.ingest(z, { t: 'message', message: { nativeId: 'm/3', conversation: 's/2/t/other', author: 'u/9', ts: 300, body: 'm/3', moved: true } });
  const fresh = sync();
  expect(fresh.replace).toBe(true);
  expect(fresh.messages.map((m) => m.id)).toEqual([zm('m/1'), zm('m/2'), zm('m/5')]);
});
