/**
 * A message that moved to another conversation (`MessageFact.moved`: a Zulip topic renamed, or messages moved to
 * another topic): it leaves the old one, which falls back to its own newest message, and what points at it follows.
 * Without `moved` a message never changes conversation.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a moved message says when (extra.movedAt, or zulip.movedAt from an older extractor); one never moved says nothing', () => {
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/3', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 300, body: 'third', extra: { movedAt: 5_000 }, moved: true } });
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/4', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 400, body: 'fourth', extra: { zulip: { movedAt: 6_000 } } } });
  store.ingest(z, { t: 'message', message: { nativeId: 'h/m/5', conversation: 'h/s/3/t/later', author: 'h/u/9', ts: 500, body: 'fifth', extra: { movedAt: 'soon' } } });
  expect(store.messageView(msg('h/m/3'))?.movedAt).toBe(5_000);
  expect(store.messageView(msg('h/m/4'))?.movedAt).toBe(6_000);
  expect(store.messageView(msg('h/m/5'))?.movedAt).toBeUndefined();
  expect(store.messageView(msg('h/m/2'))?.movedAt).toBeUndefined();
});

test("resolving a Zulip topic (archived here) leaves it shown; another network's archived thread is hidden", () => {
  const hidden = (id: string) => !!store.placePrefs().find((p) => p.kind === 'conversation' && p.id === id)?.hidden;
  store.ingest(z, { t: 'conversation', conversation: { nativeId: 'h/s/3/t/plans', shape: 'thread', name: '✔ plans', parentConversation: 'h/s/3', archived: true } });
  expect(store.one<{ archived: number }>('SELECT archived FROM conversation WHERE id = ?', cnv('h/s/3/t/plans'))?.archived).toBe(1);
  expect(hidden(cnv('h/s/3/t/plans'))).toBe(false);
  const d = store.createAccount({ network: 'discord', label: 'd', color: '#5865f2', adapter: 'discord' });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: '91', shape: 'thread', name: 'done', archived: false } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: '91', shape: 'thread', name: 'done', archived: true } });
  expect(hidden(hubId('cnv', 'discord', '91'))).toBe(true);
});

test('resolved Zulip topics an older hub hid are shown again, once, when the hub starts; nothing else is', () => {
  const at = mkdtempSync(join(tmpdir(), 'dither-resolved-'));
  try {
    const first = new Store(join(at, 'hub.sqlite'), (raw) => raw ?? null);
    const zz = first.createAccount({ network: 'zulip', label: 'z', color: '#6492FE', adapter: 'zulip' });
    const dd = first.createAccount({ network: 'discord', label: 'd', color: '#5865f2', adapter: 'discord' });
    first.ingest(zz, { t: 'conversation', conversation: { nativeId: 'h/s/3/t/done', shape: 'thread', name: '✔ done', parentConversation: 'h/s/3', archived: true } });
    first.ingest(zz, { t: 'conversation', conversation: { nativeId: 'h/s/3/t/open', shape: 'thread', name: 'open', parentConversation: 'h/s/3' } });
    first.ingest(dd, { t: 'conversation', conversation: { nativeId: '92', shape: 'thread', name: 'old', archived: true } });
    // As an older hub left it: each archived thread hidden, and a topic you hid yourself.
    const ids = [cnv('h/s/3/t/done'), cnv('h/s/3/t/open'), hubId('cnv', 'discord', '92')];
    for (const id of ids) first.db.query(`INSERT INTO place_pref (kind, id, hidden) VALUES ('conversation', ?, 1) ON CONFLICT (kind, id) DO UPDATE SET hidden = 1`).run(id);
    first.db.query(`DELETE FROM meta WHERE key = 'zulip_resolved_shown'`).run();
    first.db.close();
    const again = new Store(join(at, 'hub.sqlite'), (raw) => raw ?? null);
    const hidden = (id: string) => !!again.placePrefs().find((p) => p.kind === 'conversation' && p.id === id)?.hidden;
    expect(ids.map(hidden)).toEqual([false, true, true]);
    again.db.close();
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});
