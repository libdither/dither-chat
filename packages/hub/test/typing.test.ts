/**
 * Typing, both ways (docs/typing.md): relayed live, never journaled or stored, expired by its TTL, never about you;
 * and your own typing sent through the account that would send, as the privacy setting allows, throttled.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { TYPING_MIN_GAP, TYPING_TTL } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TypingGate, TypingRelay, typingTtl } from '../src/typing.ts';

describe('the relay remembers starts only for their TTL', () => {
  test('a stop is news only while the start lasts', () => {
    let now = 1000;
    const r = new TypingRelay(() => now);
    r.start('c', 'i', TYPING_TTL);
    expect(r.typing('c', 'i')).toBe(true);
    expect(r.stop('c', 'i')).toBe(true);
    expect(r.stop('c', 'i')).toBe(false);
    r.start('c', 'i', TYPING_TTL);
    now += TYPING_TTL;
    expect(r.typing('c', 'i')).toBe(false);
    expect(r.stop('c', 'i')).toBe(false);
  });

  test('an adapter TTL is kept within reason', () => {
    expect(typingTtl(undefined)).toBe(TYPING_TTL);
    expect(typingTtl(15_000)).toBe(15_000);
    expect(typingTtl(5)).toBe(1_000);
    expect(typingTtl(3_600_000)).toBe(60_000);
  });
});

describe('the outgoing gate', () => {
  test('one start per account and conversation every few seconds; a stop only after a start', () => {
    let now = 0;
    const g = new TypingGate(() => now);
    expect(g.allow('a', 'c', true)).toBe(false);
    expect(g.allow('a', 'c', false)).toBe(true);
    expect(g.allow('a', 'c', false)).toBe(false);
    expect(g.allow('b', 'c', false)).toBe(true); // another account
    now += TYPING_MIN_GAP;
    expect(g.allow('a', 'c', false)).toBe(true);
    expect(g.allow('a', 'c', true)).toBe(true);
    expect(g.allow('a', 'c', true)).toBe(false);
    expect(g.allow('a', 'c', false)).toBe(true); // typing again right after a send
  });
});

// ------------------------------------------------------------------ a hub

const dir = mkdtempSync(join(tmpdir(), 'dither-typing-'));
const port = 20460 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let store: Store;
let hub: HubServer;
let d1: AccountRow;
let d2: AccountRow;
let mx: AccountRow;
const commands: { account: string; cmd: any }[] = [];
const online = new Set<string>();
let ws: WebSocket;
const frames: P.ClientEvent[][] = [];

const post = async (path: string, body: unknown, method = 'POST') => {
  const r = await fetch(base + path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const cnv = (a: AccountRow, n: string) => hubId('cnv', a.network, n);
const idn = (a: AccountRow, n: string) => hubId('idn', a.network, n);
/** What the next flush sends to clients. */
const flushed = async () => {
  const n = frames.length;
  hub.flush();
  await Bun.sleep(30);
  return frames.slice(n).flat();
};
const typingIn = (evs: P.ClientEvent[]) => evs.filter((e) => e.t === 'typing');

beforeAll(async () => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const sup = {
    authorize: () => null,
    online: (id: string) => online.has(id),
    stop: async () => {},
    command: async (account: string, cmd: any) => {
      commands.push({ account, cmd });
      return {};
    },
  } as any;
  hub = new HubServer(store, sup, new Triage(store), { port, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  hub.start();
  d1 = store.createAccount({ network: 'discord', label: 'one', color: '#111', adapter: 'discord' });
  d2 = store.createAccount({ network: 'discord', label: 'two', color: '#222', adapter: 'discord' });
  mx = store.createAccount({ network: 'matrix', label: 'mx', color: '#333', adapter: 'matrix' });
  for (const [a, me, caps] of [
    [d1, 'me1', ['send', 'typing']],
    [d2, 'me2', ['send', 'typing']],
    [mx, '@me:x.org', ['send']],
  ] as const) {
    store.ingest(a, { t: 'hello', network: a.network, version: '1', capabilities: [...caps] });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: me, isSelf: true, displayName: 'Me' } });
    online.add(a.id);
  }
  for (const a of [d1, d2]) {
    store.ingest(a, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Guild' } });
    store.ingest(a, { t: 'conversation', conversation: { nativeId: 'general', shape: 'channel', name: 'general', spaces: [{ nativeId: 'guild', position: '01' }] } });
  }
  store.ingest(d1, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me1', 'ann'] } });
  store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!room:x.org', shape: 'group', name: 'Room', participants: ['@me:x.org', '@bo:x.org'] } });
  hub.flush();
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (Array.isArray(f)) frames.push(f);
  };
});

afterAll(() => {
  ws?.close();
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('someone typing reaches clients live', () => {
  test('relayed with its TTL, and never journaled', async () => {
    const before = store.journal.position().seq;
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann' });
    store.ingest(mx, { t: 'typing', conversation: '!room:x.org', author: '@stranger:x.org', ttl: 30_000, name: 'Stranger' });
    const evs = await flushed();
    expect(typingIn(evs)).toEqual([
      { t: 'typing', conversationId: cnv(d1, 'dm-ann'), identityId: idn(d1, 'ann'), ttl: TYPING_TTL },
      // Never heard of: the name comes along, and no identity is stored for them.
      { t: 'typing', conversationId: cnv(mx, '!room:x.org'), identityId: idn(mx, '@stranger:x.org'), ttl: 30_000, name: 'Stranger' },
    ]);
    expect(evs.some((e) => e.t === 'sync')).toBe(false);
    expect(store.journal.position().seq).toBe(before);
    expect(store.one('SELECT 1 FROM identity WHERE id = ?', idn(mx, '@stranger:x.org'))).toBeNull();
    // A participant the hub has no name for gets one too.
    store.ingest(mx, { t: 'typing', conversation: '!room:x.org', author: '@bo:x.org', name: 'Bo' });
    expect(typingIn(await flushed())[0]).toMatchObject({ identityId: idn(mx, '@bo:x.org'), name: 'Bo' });
    // A known name is not repeated.
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann', name: 'Ann W.' });
    expect(typingIn(await flushed())[0]).not.toHaveProperty('name');
  });

  test('a bootstrap or a delta knows nothing of it', async () => {
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann' });
    await flushed();
    const boot = await (await fetch(base + '/api/bootstrap')).text();
    expect(boot).not.toContain('"t":"typing"');
    const p = store.journal.position();
    const delta = await post('/api/sync', { v: (await (await fetch(base + '/api/bootstrap')).json()).sync.v, epoch: p.epoch, since: 0, timelines: [] });
    expect(JSON.stringify(delta)).not.toContain('"t":"typing"');
  });

  test("a network's stop, or their message, ends it; a stop for someone not typing is not news", async () => {
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann' });
    await flushed();
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann', stop: true });
    expect(typingIn(await flushed())).toEqual([{ t: 'typing', conversationId: cnv(d1, 'dm-ann'), identityId: idn(d1, 'ann'), stop: true }]);
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann', stop: true });
    expect(typingIn(await flushed())).toEqual([]);

    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann' });
    await flushed();
    store.ingest(d1, { t: 'message', live: true, message: { nativeId: 'm1', conversation: 'dm-ann', author: 'ann', ts: Date.now(), body: 'hi' } });
    const evs = await flushed();
    expect(evs.map((e) => e.t)).toContain('message');
    expect(typingIn(evs)).toEqual([{ t: 'typing', conversationId: cnv(d1, 'dm-ann'), identityId: idn(d1, 'ann'), stop: true }]);
    // Backfill is not someone finishing a message.
    store.ingest(d1, { t: 'typing', conversation: 'dm-ann', author: 'ann' });
    await flushed();
    store.ingest(d1, { t: 'message', live: false, message: { nativeId: 'm0', conversation: 'dm-ann', author: 'ann', ts: 1, body: 'old' } });
    expect(typingIn(await flushed())).toEqual([]);
  });

  test('you are never shown typing: your other accounts, and identities merged into you', async () => {
    // d2's own identity, seen typing in a channel d1 shares.
    store.ingest(d1, { t: 'typing', conversation: 'general', author: 'me2' });
    store.ingest(d2, { t: 'typing', conversation: 'general', author: 'me2' });
    expect(typingIn(await flushed())).toEqual([]);
    // An old account of yours the hub merged into your person.
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'old-me', displayName: 'Me (old)' } });
    const self = store.one<{ id: string }>('SELECT id FROM person WHERE is_self = 1')!;
    store.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(self.id, idn(d1, 'old-me'));
    store.ingest(d1, { t: 'typing', conversation: 'general', author: 'old-me' });
    expect(typingIn(await flushed())).toEqual([]);
  });
});

describe('your typing goes out through the account that would send', () => {
  const sent = () => commands.splice(0).map((c) => ({ account: c.account, ...c.cmd }));

  test('start, the send-as choice, the throttle, and the stop', async () => {
    const general = cnv(d1, 'general');
    expect(await post(`/api/conversations/${general}/typing`, { accountId: d2.id })).toEqual({ sent: true, accountId: d2.id });
    expect(await post(`/api/conversations/${general}/typing`, { accountId: d2.id })).toMatchObject({ sent: false, why: 'throttled' });
    // Another account is another typer.
    expect(await post(`/api/conversations/${general}/typing`, { accountId: d1.id })).toMatchObject({ sent: true, accountId: d1.id });
    expect(await post(`/api/conversations/${general}/typing`, { accountId: d2.id, stop: true })).toMatchObject({ sent: true });
    await Bun.sleep(10);
    expect(sent()).toEqual([
      { account: d2.id, t: 'typing', conversation: 'general' },
      { account: d1.id, t: 'typing', conversation: 'general' },
      { account: d2.id, t: 'typing', conversation: 'general', stop: true },
    ]);
  });

  test('nothing where it cannot go: a network without typing, an account offline, an unknown place', async () => {
    expect(await post(`/api/conversations/${cnv(mx, '!room:x.org')}/typing`, {})).toMatchObject({ sent: false, why: 'not on this network' });
    online.delete(d1.id);
    expect(await post(`/api/conversations/${cnv(d1, 'dm-ann')}/typing`, {})).toMatchObject({ sent: false });
    online.add(d1.id);
    expect(await post('/api/conversations/cnv_nope/typing', {})).toMatchObject({ sent: false });
    await Bun.sleep(10);
    expect(sent()).toEqual([]);
  });

  test('"Show others when I\'m typing" off: no start leaves the hub, a stop still may', async () => {
    expect(await (await fetch(base + '/api/privacy')).json()).toEqual({ shareTyping: true });
    const dm = cnv(d1, 'dm-ann');
    expect(await post(`/api/conversations/${dm}/typing`, {})).toMatchObject({ sent: true });
    expect(await post('/api/privacy', { shareTyping: false }, 'PUT')).toEqual({ shareTyping: false });
    expect(await post(`/api/conversations/${dm}/typing`, {})).toMatchObject({ sent: false, why: 'off' });
    expect(await post(`/api/conversations/${dm}/typing`, { stop: true })).toMatchObject({ sent: true });
    await Bun.sleep(10);
    expect(sent()).toEqual([
      { account: d1.id, t: 'typing', conversation: 'dm-ann' },
      { account: d1.id, t: 'typing', conversation: 'dm-ann', stop: true },
    ]);
    expect((await fetch(base + '/api/privacy', { method: 'PUT', body: '{"shareTyping":"no"}', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    await post('/api/privacy', { shareTyping: true }, 'PUT');
  });
});
