/**
 * The demo world's Zulip organization (src/demo-zulip.ts, DITHER_DEMO_SCENARIO=zulip): what it says lands in a store as
 * an organization of forums whose topics hold the messages, with unread topics, a muted one, a resolved one shown, a
 * moved message, and a profile with a time zone; resolving a topic through it shows as archived.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DemoZulip, ZULIP_HOST, zulipTopic } from '../src/demo-zulip.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-demo-zulip-'));
const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const acc = store.createAccount({ network: 'zulip', label: 'lab', color: '#6492FE', adapter: 'demo', demo: true, config: { epoch: Date.now() } });
const replies: Extract<P.AdapterEvent, { t: 'reply' }>[] = [];
const adapter = new DemoZulip(acc, dir);
adapter.start((ev) => (ev.t === 'reply' ? replies.push(ev) : store.ingest(acc, ev)));
const cnv = (n: string) => hubId('cnv', 'zulip', n);
const view = (n: string) => store.conversationViews([cnv(n)])[0]!;

test('channels are forums with no messages of their own; topics hold them, with their unread counts', () => {
  const design = view(`${ZULIP_HOST}/s/10`);
  expect(design.variant).toBe('forum');
  expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?', design.id)?.n).toBe(0);
  const tokens = view(zulipTopic(10, 'Color tokens'));
  expect(tokens.parentId).toBe(design.id);
  expect(tokens.vantages[0]).toMatchObject({ unread: 2, mentions: 1 });
  expect(view(zulipTopic(12, 'Nightly builds')).vantages[0]?.unread).toBe(3);
  expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM conversation WHERE parent_id = ?', design.id)?.n).toBe(9);
});

test('a resolved topic keeps its ✔ name, is archived and not hidden; a moved message says when', () => {
  const done = view(zulipTopic(10, '✔ Icon sizes'));
  expect(done).toMatchObject({ name: '✔ Icon sizes', archived: true });
  expect(store.placePrefs().some((p) => p.id === done.id && p.hidden)).toBe(false);
  const moved = store.one<{ id: string }>(`SELECT id FROM message WHERE conversation_id = ? AND json_extract(extra, '$.movedAt') IS NOT NULL`, cnv(zulipTopic(12, 'v2.4')));
  expect(store.messageView(moved!.id)?.movedAt).toBeGreaterThan(0);
});

test('a profile gives its time zone; resolving a topic renames it with the ✔', () => {
  adapter.command({ t: 'profile', id: 'p1', who: `${ZULIP_HOST}/u/11` });
  expect(replies.find((r) => r.id === 'p1')).toMatchObject({ ok: true, result: { timeZone: 'Europe/Berlin' } });
  adapter.command({ t: 'threadState', id: 's1', conversation: zulipTopic(10, 'Spacing scale'), archived: true });
  expect(replies.find((r) => r.id === 's1')?.ok).toBe(true);
  expect(view(zulipTopic(10, 'Spacing scale'))).toMatchObject({ name: '✔ Spacing scale', archived: true });
});
