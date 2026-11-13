/**
 * A Telegram forum moving from a group with topic threads to a space with topic channels (dither-accounts #32): the
 * topics keep their messages and lose their old parent, the forum's conversation goes, and the labels name a topic
 * without Discord's #.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-forum-'));
const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a forum becomes a space: its topics become channels in it, keep their messages and drop their parent', () => {
  const tg = store.createAccount({ network: 'telegram', label: 't', color: '#000', adapter: 'telegram' });
  const cnv = (n: string) => hubId('cnv', 'telegram', n);
  // As before: the forum a group, a topic a thread of it.
  store.ingest(tg, { t: 'conversation', conversation: { nativeId: 'channel:9', shape: 'group', variant: 'forum', name: 'Nock' } });
  store.ingest(tg, { t: 'conversation', conversation: { nativeId: 'channel:9/5', shape: 'thread', name: 'Trading', parentConversation: 'channel:9' } });
  store.ingest(tg, { t: 'message', message: { nativeId: 'channel:9#6', conversation: 'channel:9/5', author: '1', ts: 100, body: 'hi' } });
  // Now: the space, the topic a channel in it, the forum's conversation left.
  store.ingest(tg, { t: 'space', space: { nativeId: 'channel:9', kind: 'community', name: 'Nock' } });
  store.ingest(tg, { t: 'leave', kind: 'conversation', nativeId: 'channel:9' });
  store.ingest(tg, { t: 'conversation', conversation: { nativeId: 'channel:9/5', shape: 'channel', name: 'Trading', spaces: [{ nativeId: 'channel:9', position: '1:000000000005' }] } });
  const topic = store.one<{ shape: string; parent_id: string | null }>('SELECT shape, parent_id FROM conversation WHERE id = ?', cnv('channel:9/5'))!;
  expect(topic).toEqual({ shape: 'channel', parent_id: null });
  expect(store.one('SELECT 1 FROM conversation WHERE id = ?', cnv('channel:9'))).toBeNull();
  expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?', cnv('channel:9/5'))!.n).toBe(1);
  expect(store.one<{ parent_id: string }>(`SELECT parent_id FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`, cnv('channel:9/5'))!.parent_id).toBe(hubId('spc', 'telegram', 'channel:9'));
  // Named as a topic is, not as Discord's #channel.
  expect(new Triage(store).placeName(store.one('SELECT * FROM conversation WHERE id = ?', cnv('channel:9/5'))!)).toBe('Trading · Nock');
});

test('a thread sent again without its parent keeps it', () => {
  const d = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'ch', shape: 'channel', name: 'general' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'th', shape: 'thread', name: 'A thread', parentConversation: 'ch' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'th', shape: 'thread', name: 'A thread, renamed' } });
  expect(store.one<{ parent_id: string }>('SELECT parent_id FROM conversation WHERE id = ?', hubId('cnv', 'discord', 'th'))!.parent_id).toBe(hubId('cnv', 'discord', 'ch'));
});
