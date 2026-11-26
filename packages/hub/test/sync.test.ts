/**
 * Delta sync (journal.ts, sync.ts, docs/sync.md) against a real hub over HTTP and a real live socket.
 *
 * The property: a client that applies deltas ends up exactly where a fresh bootstrap puts a new one. Three clients
 * watch the same hub while it goes through every kind of change a client can see:
 *   - `live` applies the socket's frames as they come,
 *   - `step` syncs a delta after every step,
 *   - `late` syncs once, at the end, from where it started,
 *   - `onSocket` catches up after every step on a new socket asked from its position, whose first frame is the delta
 *     (docs/sync.md "On the socket"), and its timelines by POST beside it, as state.ts does.
 * After each step each of them is compared with a fresh bootstrap, through the web app's own reducer (syncmodel.ts),
 * timelines and the inbox and usage included. Then the fallbacks: when the hub refuses a delta, and why.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { LIVE_PROTOCOL, LIVE_RESUME, SYNC_VERSION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Attention } from '../src/attention.ts';
import { Journal } from '../src/journal.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import {
  applyBootstrapTo,
  applyEventTo,
  applySyncTo,
  applyTimelineDelta,
  applyUsageEvent,
  emptyDb,
  indexThreads,
  mergeInbox,
  upsertInto,
  type Db,
  type TimelineCopy,
} from '../../web/src/syncmodel.ts';
import { pageText, type KeptPage } from '../../web/src/keptpages.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-sync-'));
let port = 0;
let base = '';
let store: Store;
let hub: HubServer;
let attention: Attention;
const sent: any[] = [];

const get = async <T = any>(path: string): Promise<T> => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
};
const call = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(base + path, { method, body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
};
const syncReq = (b: P.SyncRequest) => call<P.SyncResponse>('POST', '/api/sync', b);

// ------------------------------------------------------------------ a client

interface Client {
  db: Db;
  timelines: Map<string, TimelineCopy>;
  inbox: P.MessageView[];
  usage: P.UsageState;
  /** Person timelines whose person changed: state.ts catches them up (catchUp). */
  regrouped: Set<string>;
}

async function newClient(keys: string[]): Promise<Client> {
  const c: Client = { db: emptyDb(), timelines: new Map(), inbox: [], usage: await get('/api/usage'), regrouped: new Set() };
  // As the app asks for it (state.ts BOOTSTRAP_PATH): conversations' edges as positions beside them.
  applyBootstrapTo(c.db, await get('/api/bootstrap?edges=spaces'));
  c.inbox = (await get<P.InboxPage>('/api/inbox')).items.map((i) => i.message);
  for (const k of keys) c.timelines.set(k, await page(k));
  return c;
}

async function page(key: string): Promise<TimelineCopy> {
  const id = key.slice(2);
  const p = await get<P.MessagePage & { conversationIds?: string[] }>(key.startsWith('c:') ? `/api/conversations/${id}/messages?limit=60` : `/api/persons/${id}/timeline?limit=60`);
  return { messages: p.messages, hasMore: p.hasMore, conversationIds: p.conversationIds };
}

/** What the live socket does to a client: syncmodel for `db`, state.ts's handling for the rest. */
function applyLive(c: Client, events: P.ClientEvent[]) {
  let threads = false;
  for (const ev of events) {
    threads = applyEventTo(c.db, ev) || threads;
    c.usage = applyUsageEvent(c.usage, ev);
    if (ev.t === 'message') {
      const m = ev.message;
      const t = c.timelines.get('c:' + m.conversationId);
      if (t) upsertInto(t.messages, m);
      const conv = c.db.conversations.get(m.conversationId);
      const pt = conv?.shape === 'direct' && conv.peerPersonId ? c.timelines.get('p:' + conv.peerPersonId) : undefined;
      if (pt) upsertInto(pt.messages, m);
      if (m.triage) c.inbox = mergeInbox(c.inbox, [m]);
    }
    if (ev.t === 'sync' && c.db.sync) c.db.sync = { ...c.db.sync, seq: ev.seq };
    if (ev.t === 'person' || ev.t === 'person.removed') {
      const key = 'p:' + (ev.t === 'person' ? ev.person.id : ev.id);
      if (c.timelines.has(key)) c.regrouped.add(key);
    }
  }
  if (threads) indexThreads(c.db);
}

const timelineReq = (key: string, t: TimelineCopy, seq: number): P.SyncTimelineRequest => ({
  key,
  seq,
  newest: t.messages.at(-1)?.ts ?? 0,
  oldest: t.messages[0]?.ts ?? 0,
  ...(key.startsWith('p:') ? { conversationIds: t.conversationIds ?? [] } : {}),
});

/** What state.ts's catchUp does for timelines the live socket says are behind. */
async function catchUpLive(c: Client) {
  const pos = c.db.sync!;
  const keys = [...c.regrouped];
  c.regrouped.clear();
  if (!keys.length) return;
  const r = await syncReq({ v: pos.v, epoch: pos.epoch, timelines: keys.map((k) => timelineReq(k, c.timelines.get(k)!, pos.seq)) });
  if (r.full) throw new Error(`refused: ${r.reason}`);
  for (const i of r.identities) c.db.identities.set(i.id, i);
  for (const tl of r.timelines) applyTimelineDelta(c.timelines.get(tl.key)!, tl);
}

/** A live socket asked from `pos`, its first frame (the catch-up), and the frames after it. */
async function resumeSocket(pos: P.SyncPosition, protocols: string[] = [LIVE_PROTOCOL, LIVE_RESUME]) {
  const q = `?v=${pos.v}&epoch=${encodeURIComponent(pos.epoch)}&since=${pos.seq}`;
  const sock = new WebSocket(`ws://127.0.0.1:${port}/api/live${q}`, protocols);
  sock.binaryType = 'arraybuffer';
  const frames: { text: string; binary: boolean }[] = [];
  let first: (x: { text: string; binary: boolean }) => void;
  const firstFrame = new Promise<{ text: string; binary: boolean }>((r) => (first = r));
  sock.onmessage = (e) => {
    const binary = typeof e.data !== 'string';
    const f = { text: binary ? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(e.data as ArrayBuffer))) : String(e.data), binary };
    if (frames.push(f) === 1) first(f);
  };
  await new Promise((r) => (sock.onopen = r));
  return { sock, firstFrame, frames };
}

/** What state.ts's resync does when the socket brings the catch-up: timelines by POST beside it. Returns the answer. */
async function resyncOnSocket(c: Client) {
  const pos = c.db.sync!;
  const { sock, firstFrame } = await resumeSocket(pos);
  expect(sock.protocol).toBe(LIVE_RESUME);
  const first = JSON.parse((await firstFrame).text) as P.LiveResume;
  sock.close();
  const r = first.resume;
  if (!r || r.full) throw new Error(`no catch-up on the socket: ${JSON.stringify(r)}`);
  expect(r.timelines).toEqual([]);
  return applyResync(c, r, await syncReq({ v: pos.v, epoch: pos.epoch, timelines: [...c.timelines].map(([key, t]) => timelineReq(key, t, pos.seq)) }));
}

/** What state.ts's resync does. Returns the answer. */
async function resync(c: Client) {
  const pos = c.db.sync!;
  const r = await syncReq({
    v: pos.v,
    epoch: pos.epoch,
    since: pos.seq,
    timelines: [...c.timelines].map(([key, t]) => timelineReq(key, t, pos.seq)),
  });
  return applyResync(c, r);
}

/** `side`: the timelines, asked for apart. */
function applyResync(c: Client, r: P.SyncResponse, side?: P.SyncResponse) {
  if (r.full) throw new Error(`refused: ${r.reason}`);
  if (side?.full) throw new Error(`refused: ${side.reason}`);
  if (side) r = { ...r, timelines: side.timelines, identities: [...r.identities, ...side.identities], quoted: [...r.quoted, ...side.quoted] };
  for (const tl of r.timelines) applyTimelineDelta(c.timelines.get(tl.key)!, tl);
  applySyncTo(c.db, r);
  for (const ev of r.events) c.usage = applyUsageEvent(c.usage, ev);
  if (r.inbox) c.inbox = mergeInbox(c.inbox, r.inbox);
  return r;
}

// ------------------------------------------------------------------ comparing

const sortBy = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const edgeKey = (e: P.SpaceEdgeView) => `${e.parentId}>${e.childKind}:${e.childId}@${e.position}`;

function norm(d: Db) {
  return {
    selfPersonId: d.selfPersonId,
    categoryProvider: d.categoryProvider,
    accounts: sortBy([...d.accounts.values()], (a) => a.id),
    persons: sortBy([...d.persons.values()], (p) => p.id).map((p) => ({ ...p, identityIds: [...p.identityIds].sort() })),
    spaces: sortBy([...d.spaces.values()], (s) => s.id).map((s) => ({ ...s, accountIds: [...s.accountIds].sort() })),
    conversations: sortBy([...d.conversations.values()], (c) => c.id).map((c) => ({
      ...c,
      participantIds: [...c.participantIds].sort(),
      spaceIds: [...c.spaceIds].sort(),
      vantages: sortBy(c.vantages, (v) => v.accountId),
    })),
    children: [...d.children.values()].flat().map(edgeKey).sort(),
    parents: [...d.parents.values()].flat().map(edgeKey).sort(),
    threads: sortBy([...d.threads].map(([k, v]) => [k, [...v].sort()] as const), (x) => x[0]),
    folders: d.folders,
    placePrefs: sortBy([...d.placePrefs.values()], (p) => `${p.kind}:${p.id}`),
    categories: d.categories,
    placeCategories: sortBy([...d.placeCategories.values()].flat(), (p) => `${p.categoryId}:${p.kind}:${p.id}`),
    rules: d.rules,
    reactionUsage: d.reactionUsage,
    attention: sortBy([...d.attention.values()], (a) => a.id),
    presence: sortBy([...d.presence.values()], (p) => p.identityId),
  };
}

async function expectCurrent(name: string, c: Client) {
  const f = await newClient([...c.timelines.keys()]);
  expect({ client: name, ...norm(c.db) }).toEqual({ client: name, ...norm(f.db) });
  // A client keeps identities its messages named; the ones a bootstrap carries must match.
  for (const i of f.db.identities.values()) expect({ client: name, identity: c.db.identities.get(i.id) }).toEqual({ client: name, identity: i });
  for (const [key, t] of f.timelines) {
    const held = c.timelines.get(key)!;
    const from = t.messages[0]?.ts ?? -Infinity;
    expect({ client: name, key, messages: held.messages.filter((m) => m.ts >= from) }).toEqual({ client: name, key, messages: t.messages });
    if (key.startsWith('p:')) expect(held.conversationIds?.sort()).toEqual(t.conversationIds?.sort());
  }
  expect({ client: name, inbox: c.inbox.map((m) => m.id) }).toEqual({ client: name, inbox: f.inbox.map((m) => m.id) });
  expect({ client: name, inbox: c.inbox }).toEqual({ client: name, inbox: f.inbox });
  expect({ client: name, usage: sortBy(c.usage.places, (u) => `${u.kind}:${u.id}`), arrange: c.usage.arrange }).toEqual({
    client: name,
    usage: sortBy(f.usage.places, (u) => `${u.kind}:${u.id}`),
    arrange: f.usage.arrange,
  });
}

// ------------------------------------------------------------------ the hub

let d1: AccountRow;
let d2: AccountRow;
let sig: AccountRow;
let ts = Date.now() - 2 * 86_400_000;
let n = 0;
const cnv = (acc: AccountRow, nid: string) => hubId('cnv', acc.network, nid);
const msg = (acc: AccountRow, nid: string) => hubId('msg', acc.network, nid);
const idn = (acc: AccountRow, nid: string) => hubId('idn', acc.network, nid);
const say = (acc: AccountRow, conversation: string, author: string, extra: Partial<P.MessageFact> = {}, live = true) => {
  const nativeId = extra.nativeId ?? `m${++n}`;
  store.ingest(acc, { t: 'message', live, message: { nativeId, conversation, author, ts: (ts += 1000), body: `message ${n}`, ...extra } });
  return nativeId;
};
const settle = async () => {
  hub.flush();
  await Bun.sleep(40);
};

let live: Client;
let step: Client;
let late: Client;
let onSocket: Client;
let ws: WebSocket;
/**
 * Pages a device kept (keptpages.ts), as stored text: at the start with the start's position, and after the edits with
 * that same older position (a page that did not change keeps its record, and its position, when it is saved again).
 */
const kept: { what: string; key: string; text: string }[] = [];
const keep = (what: string, c: Client, pos: P.SyncPosition) => {
  for (const [key, t] of c.timelines) kept.push({ what, key, text: pageText(key, { ...t, sync: pos }, c.db.identities, new Map()) });
};

beforeAll(async () => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const triage = new Triage(store);
  attention = new Attention(store, triage);
  const sup = {
    authorize: () => null,
    online: () => true,
    stop: async () => {},
    command: async (_id: string, c: any) => {
      sent.push(c);
      await Bun.sleep(30);
      return { nativeId: 'x' };
    },
  } as any;
  hub = new HubServer(store, sup, triage, { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's', attention });
  port = hub.start().port!;
  base = `http://127.0.0.1:${port}`;
  hub.broadcast([{ t: 'attention', items: attention.list(), removed: [], replace: true }]);

  d1 = store.createAccount({ network: 'discord', label: 'one', color: '#111', adapter: 'discord' });
  d2 = store.createAccount({ network: 'discord', label: 'two', color: '#222', adapter: 'discord' });
  sig = store.createAccount({ network: 'signal', label: 'signal', color: '#333', adapter: 'signal' });
  for (const [a, me] of [[d1, 'me1'], [d2, 'me2'], [sig, 'sigme']] as const) {
    store.ingest(a, { t: 'hello', network: a.network, version: '1', capabilities: ['send', 'edit', 'redact', 'react'] });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: me, isSelf: true, displayName: 'Me' } });
  }
  d1 = store.account(d1.id)!;
  d2 = store.account(d2.id)!;
  sig = store.account(sig.id)!;
  for (const a of [d1, d2]) {
    store.ingest(a, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Guild' } });
    store.ingest(a, { t: 'conversation', conversation: { nativeId: 'general', shape: 'channel', name: 'general', spaces: [{ nativeId: 'guild', position: '01' }] } });
  }
  store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'random', shape: 'channel', name: 'random', spaces: [{ nativeId: 'guild', position: '02' }] } });
  store.ingest(d1, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me1', 'ann'] } });
  store.ingest(sig, { t: 'identity', identity: { nativeId: 'ann-sig', displayName: 'Ann (Signal)', contact: true } });
  store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'dm-ann-sig', shape: 'direct', participants: ['sigme', 'ann-sig'] } });
  store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'family', shape: 'group', name: 'Family', participants: ['sigme', 'ann-sig', 'bob'] } });
  for (let i = 0; i < 70; i++) say(d1, 'general', i % 2 ? 'ann' : 'carl', {}, false);
  say(d1, 'dm-ann', 'ann');
  say(sig, 'family', 'bob');
  await settle();

  const annPerson = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn(d1, 'ann'))!.person_id;
  const keys = [`c:${cnv(d1, 'general')}`, `c:${cnv(sig, 'family')}`, `p:${annPerson}`];
  live = await newClient(keys);
  step = await newClient(keys);
  late = await newClient(keys);
  onSocket = await newClient(keys);
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
  await new Promise((r) => (ws.onopen = r));
  // Live from here; the bootstrap above is from before the socket, so the first sync covers the gap.
  ws.onmessage = (e) => applyLive(live, JSON.parse(String(e.data)));
  await resync(live);
  keep('kept at the start', late, late.db.sync!);
});

afterAll(() => {
  ws?.close();
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ every kind of change

const steps: [string, () => void | Promise<unknown>][] = [
  ['live messages, a DM and a backfilled one', () => {
    say(d1, 'general', 'ann', { mentionsSelf: true });
    say(d1, 'dm-ann', 'ann');
    say(sig, 'dm-ann-sig', 'ann-sig');
    say(d1, 'random', 'carl', {}, false);
  }],
  ['edits, deletions, reactions', () => {
    const id = say(d1, 'general', 'carl', { nativeId: 'edit-me' });
    store.ingest(d1, { t: 'message', live: true, message: { nativeId: id, conversation: 'general', author: 'carl', ts, editedTs: ts + 5, body: 'edited' } });
    store.ingest(d1, { t: 'delete', conversation: 'general', nativeId: 'm5' });
    store.ingest(d1, { t: 'reaction', conversation: 'general', message: 'm6', author: 'ann', key: '👍' });
    store.ingest(d1, { t: 'reaction', conversation: 'general', message: 'm6', author: 'me1', key: '🎉' });
    store.ingest(d1, { t: 'reactionsCleared', conversation: 'general', message: 'm6', key: '🎉' });
  }],
  ['read state, from a network and from here', async () => {
    store.ingest(d1, { t: 'read', conversation: 'dm-ann', upToTs: ts, unread: 0, mentions: 0 });
    await call('POST', `/api/conversations/${cnv(d1, 'general')}/read`, { upToTs: ts });
  }],
  ['spaces: a category, a channel moving into it, a rename', () => {
    store.ingest(d1, { t: 'space', space: { nativeId: 'cat', kind: 'section', name: 'Category', parents: [{ nativeId: 'guild', position: '03' }] } });
    store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'random', shape: 'channel', name: 'random-renamed', spaces: [{ nativeId: 'cat', position: '01' }] } });
    store.ingest(d2, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Guild renamed', mute: { muted: true } } });
  }],
  ['identities: a new name, a new contact', () => {
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Annie' } });
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'dee', displayName: 'Dee', contact: true } });
    store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'dm-dee', shape: 'direct', participants: ['me1', 'dee'] } });
  }],
  ['people: a nickname on an account, which renames its person; a note (an old client\'s star, ignored); merge, split', async () => {
    const ann = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn(d1, 'ann'))!.person_id;
    const annSig = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn(sig, 'ann-sig'))!.person_id;
    await call('PATCH', `/api/identities/${idn(d1, 'ann')}`, { nickname: 'Ann A.' });
    await call('PATCH', `/api/persons/${ann}`, { note: 'from the climbing gym', starred: true });
    await call('POST', '/api/persons/merge', { into: ann, from: annSig });
    const dee = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn(d1, 'dee'))!.person_id;
    await call('POST', '/api/persons/merge', { into: dee, from: ann });
    await call('POST', `/api/identities/${idn(d1, 'dee')}/split`, {});
  }],
  ['folders, place preferences, rules', async () => {
    await call('PUT', '/api/folders', { folders: [{ id: '', name: 'Close', icon: 'star', color: null, items: [{ kind: 'conversation', id: cnv(sig, 'family') }] }] });
    await call('PATCH', '/api/place-prefs', { items: [{ kind: 'conversation', id: cnv(d1, 'general'), pinned: true, position: 3 }] });
    await call('PUT', '/api/rules', { scope: 'conversation', target: cnv(d1, 'random'), level: 'none' });
  }],
  ['categories: a new one, an override, scores, one deleted', async () => {
    const { id } = await call('POST', '/api/categories', { name: 'Games', keywords: ['game'] });
    await call('PUT', '/api/category-overrides', { categoryId: id, kind: 'conversation', id: cnv(d1, 'general'), assigned: true });
    store.putScores('space', hubId('spc', 'discord', 'guild'), { [id]: 0.7 }, 'keyword', 'h');
    store.categoriesChanged();
    const other = await call('POST', '/api/categories', { name: 'Work' });
    await call('DELETE', `/api/categories/${other.id}`);
  }],
  ['triage: the inbox gains, marks given and one taken back, a silenced one', async () => {
    const pushed = say(d1, 'dm-ann', 'ann');
    store.setTriage(msg(d1, pushed), { decision: 'push', score: 0.9, reasons: ['A direct message'], decidedBy: 'rules', probs: { alert: 0.7, important: 0.9 } });
    store.dirty.messages.set(msg(d1, pushed), true);
    const listed = say(sig, 'family', 'bob');
    store.setTriage(msg(sig, listed), { decision: 'digest', score: 0.7, reasons: ['A group'], decidedBy: 'rules' });
    store.dirty.messages.set(msg(sig, listed), true);
    await settle();
    // The alert was wrong, and less like it; then the second is taken back.
    await call('POST', `/api/messages/${msg(d1, pushed)}/feedback`, { alert: false, less: true });
    await settle();
    await call('POST', `/api/messages/${msg(d1, pushed)}/feedback`, { less: false });
    await call('POST', `/api/messages/${msg(sig, listed)}/feedback`, { alert: true });
    store.ingest(sig, { t: 'delete', conversation: 'family', nativeId: listed });
  }],
  ['a thread off a channel, a conversation opened here', () => {
    store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'thread-1', shape: 'thread', name: 'A thread', parentConversation: 'general', spaces: [{ nativeId: 'guild' }] } });
    say(d1, 'thread-1', 'carl');
    store.touchConversation(cnv(d1, 'dm-dee'));
  }],
  ['status dots: heard, changed, and gone with the account that heard them stopping', async () => {
    store.ingest(d1, { t: 'presence', who: 'ann', state: 'online', devices: ['desktop'] });
    store.ingest(d1, { t: 'presence', who: 'dee', state: 'idle' });
    store.ingest(sig, { t: 'presence', who: 'ann-sig', state: 'dnd' });
    hub.flush(true);
    await settle();
    store.ingest(d1, { t: 'presence', who: 'dee', state: 'offline' });
    store.ingest(sig, { t: 'status', status: 'offline' });
    hub.flush(true);
  }],
  ['leaving: a space another account still sees, a conversation no one does', () => {
    store.ingest(d2, { t: 'leave', kind: 'space', nativeId: 'guild' });
    store.ingest(sig, { t: 'leave', kind: 'conversation', nativeId: 'dm-ann-sig' });
  }],
  ['accounts: status and attention, a label, one removed with what only it saw', async () => {
    store.ingest(d2, { t: 'status', status: 'attention', attention: { kind: 'captcha', message: 'Solve it' } });
    await call('PATCH', `/api/accounts/${sig.id}`, { label: 'Phone' });
    store.ingest(d2, { t: 'conversation', conversation: { nativeId: 'only-two', shape: 'group', name: 'Only two' } });
    await settle();
    await call('DELETE', `/api/accounts/${d2.id}`);
  }],
  ['time in places and sort settings, from two devices', async () => {
    await call('POST', '/api/usage', { batch: 'b1', deltas: [{ kind: 'conversation', id: cnv(d1, 'general'), seconds: 120, visits: 1, lastVisit: Date.now() }] });
    await call('POST', '/api/usage', { batch: 'b2', deltas: [{ kind: 'person', id: 'per_x', seconds: 30, visits: 1, lastVisit: Date.now() }] });
    await call('PATCH', '/api/arrange', { sort: { rail: 'smart' } });
  }],
  ['usage forgotten for one place, then everywhere, then some again', async () => {
    await call('DELETE', '/api/usage', { kind: 'person', id: 'per_x' });
    await call('DELETE', '/api/usage', {});
    await call('POST', '/api/usage', { batch: 'b3', deltas: [{ kind: 'space', id: hubId('spc', 'discord', 'guild'), seconds: 60, visits: 1, lastVisit: Date.now() }] });
  }],
  ['many new messages in a held timeline: it gets a fresh page', () => {
    for (let i = 0; i < 75; i++) say(d1, 'general', 'carl');
  }],
  ['typing and notifications are of the moment', () => {
    store.ingest(d1, { t: 'typing', conversation: 'general', author: 'ann' });
    hub.notify({ t: 'notify', title: 't', body: 'b', reasons: [] });
  }],
];

describe('a client applying deltas ends up where a fresh bootstrap puts it', () => {
  for (const [name, run] of steps) {
    test(name, async () => {
      const before = step.db.sync!;
      await run();
      await settle();
      await resync(step);
      await expectCurrent('step', step);
      await resyncOnSocket(onSocket);
      await expectCurrent('onSocket', onSocket);
      await catchUpLive(live);
      await expectCurrent('live', live);
      if (name === 'edits, deletions, reactions') keep('kept after the edits, at the position before them', step, before);
    });
  }

  test('one delta from the start covers all of it', async () => {
    const r = await resync(late);
    expect(r.events.length).toBeGreaterThan(10);
    await expectCurrent('late', late);
  });

  test("pages a device kept, caught up from where they were kept, are the hub's pages", async () => {
    expect(kept.length).toBe(6);
    for (const k of kept) {
      const p = JSON.parse(k.text) as KeptPage;
      const t: TimelineCopy = { messages: p.messages, hasMore: true, conversationIds: p.conversationIds };
      const r = await syncReq({ v: p.sync!.v, epoch: p.sync!.epoch, timelines: [timelineReq(k.key, t, p.sync!.seq)] });
      if (r.full) throw new Error(`refused: ${r.reason}`);
      applyTimelineDelta(t, r.timelines[0]);
      const fresh = await page(k.key);
      const from = fresh.messages[0]?.ts ?? -Infinity;
      expect({ kept: k.what, key: k.key, messages: t.messages.filter((m) => m.ts >= from) }).toEqual({ kept: k.what, key: k.key, messages: fresh.messages });
      expect(t.messages.map((m) => m.ts)).toEqual(t.messages.map((m) => m.ts).sort((a, b) => a - b));
      expect(new Set(t.messages.map((m) => m.id)).size).toBe(t.messages.length);
    }
  });

  test('nothing changed: an empty answer', async () => {
    const before = step.db.sync!.seq;
    const r = await resync(step);
    if (r.full) throw new Error('refused');
    expect(r.sync.seq).toBe(before);
    expect(r.events).toEqual([]);
    expect(r.timelines.every((t) => !t.replace && t.messages.length === 0)).toBe(true);
    expect(r.inbox).toEqual([]);
    expect(JSON.stringify(r).length).toBeLessThan(2500);
  });

  test("a bootstrap with conversations' edges beside them reads as the one with every edge, in fewer bytes", async () => {
    await resync(step);
    const full = await get<P.Bootstrap>('/api/bootstrap');
    const short = await get<P.Bootstrap>('/api/bootstrap?edges=spaces');
    expect(full.conversationEdges).toBeUndefined();
    expect(short.edges.every((e) => e.childKind === 'space')).toBe(true);
    expect(short.conversationEdges!.length).toBe(short.conversations.length);
    // Places with conversations in them, and at least one position: the test world has both.
    expect(full.edges.filter((e) => e.childKind === 'conversation' && e.position !== null).length).toBeGreaterThan(0);
    const a = emptyDb();
    const b = emptyDb();
    applyBootstrapTo(a, full);
    applyBootstrapTo(b, short);
    expect(norm(b)).toEqual(norm(a));
    expect(JSON.stringify(short).length).toBeLessThan(JSON.stringify(full).length);
  });

  test('a bootstrap names the hub process as a sync does, so a page that reconnects by either sees a restart', async () => {
    const r = await resync(step);
    if (r.full) throw new Error('refused');
    const b = await get<P.Bootstrap>('/api/bootstrap');
    expect(b.boot).toBeTruthy();
    expect(b.boot).toBe(r.boot);
  });
});

// ------------------------------------------------------------------ the catch-up on the socket

describe('the catch-up on the socket (docs/sync.md "On the socket")', () => {
  const pos = () => store.journal.position();
  const parse = (f: { text: string }) => JSON.parse(f.text);

  test('what comes after it on the socket is newer: applied in order, nothing is lost or doubled', async () => {
    const annPerson = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn(d1, 'ann'))!.person_id;
    const c = await newClient([`c:${cnv(d1, 'general')}`, `p:${annPerson}`]);
    const from = c.db.sync!;
    // Changed before the socket: in its catch-up.
    say(d1, 'general', 'ann');
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann before' } });
    const { sock, firstFrame, frames } = await resumeSocket(from);
    expect(sock.protocol).toBe(LIVE_RESUME);
    const r = (parse(await firstFrame) as P.LiveResume).resume;
    if (!r || r.full) throw new Error('no catch-up');
    expect(r.events.some((e) => e.t === 'identity' && e.identity.displayName === 'Ann before')).toBe(true);
    // Changed after: in the frames after it, each with its position.
    say(d1, 'general', 'carl');
    const edited = say(d1, 'dm-ann', 'ann');
    store.ingest(d1, { t: 'message', live: true, message: { nativeId: edited, conversation: 'dm-ann', author: 'ann', ts, editedTs: ts + 5, body: 'edited after' } });
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann after' } });
    await settle();
    sock.close();
    const live = frames.slice(1).map((f) => parse(f) as P.ClientEvent[]);
    expect(live.length).toBeGreaterThan(0);
    for (const f of live) expect(f.at(-1)).toMatchObject({ t: 'sync' });
    expect((live[0].at(-1) as { seq: number }).seq).toBe(r.sync.seq + 1);
    // As state.ts: the catch-up and the timelines beside it, then the frames held meanwhile.
    applyResync(c, r, await syncReq({ v: from.v, epoch: from.epoch, timelines: [...c.timelines].map(([key, t]) => timelineReq(key, t, from.seq)) }));
    for (const f of live) applyLive(c, f);
    await expectCurrent('caught up on the socket, then live', c);
  });

  test('nothing changed: a short answer, as text', async () => {
    const p = pos();
    const { sock, firstFrame } = await resumeSocket(p);
    const f = await firstFrame;
    sock.close();
    expect(f.binary).toBe(false);
    expect(parse(f)).toMatchObject({ resume: { sync: p, events: [], timelines: [] } });
  });

  test('a long one comes gzip\'d', async () => {
    const { sock, firstFrame } = await resumeSocket({ ...pos(), seq: store.journal.floor });
    const f = await firstFrame;
    sock.close();
    expect(f.binary).toBe(true);
    const r = (parse(f) as P.LiveResume).resume;
    if (!r || r.full) throw new Error('no catch-up');
    expect(r.events.length).toBeGreaterThan(10);
  });

  test('a position the hub cannot vouch for is refused there as by POST', async () => {
    const p = pos();
    for (const bad of [{ ...p, epoch: 'elsewhere' }, { ...p, v: SYNC_VERSION + 1 }, { ...p, seq: p.seq + 100 }]) {
      const { sock, firstFrame } = await resumeSocket(bad);
      expect(sock.protocol).toBe(LIVE_RESUME);
      const f = await firstFrame;
      sock.close();
      expect(parse(f)).toMatchObject({ resume: { full: true } });
    }
  });

  test('a socket that does not offer it, or gives no position, gets no catch-up: an older client, as before', async () => {
    const p = pos();
    const cases: [string, string[] | undefined][] = [
      [`?v=${p.v}&epoch=${p.epoch}&since=${p.seq}`, undefined],
      [`?v=${p.v}&epoch=${p.epoch}&since=${p.seq}`, [LIVE_PROTOCOL]],
      ['', [LIVE_PROTOCOL, LIVE_RESUME]],
      [`?v=${p.v}&epoch=${p.epoch}&since=-1`, [LIVE_PROTOCOL, LIVE_RESUME]],
    ];
    for (const [q, protocols] of cases) {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/api/live${q}`, protocols);
      const first = new Promise<string>((r) => (sock.onmessage = (e) => r(String(e.data))));
      await new Promise((r) => (sock.onopen = r));
      expect(sock.protocol).not.toBe(LIVE_RESUME);
      // The heartbeat's answer is its first frame: nothing came before it.
      sock.send('ping');
      expect(await first).toBe('pong');
      sock.close();
    }
  });
});

// ------------------------------------------------------------------ positions and fallbacks

describe('when the hub refuses a delta', () => {
  const pos = () => store.journal.position();

  test('another version, another epoch, a position from the future', async () => {
    const p = pos();
    expect(await syncReq({ v: SYNC_VERSION + 1, epoch: p.epoch, since: p.seq })).toMatchObject({ full: true });
    expect(await syncReq({ v: SYNC_VERSION, epoch: 'elsewhere', since: p.seq })).toMatchObject({ full: true });
    expect(await syncReq({ v: SYNC_VERSION, epoch: p.epoch, since: p.seq + 100 })).toMatchObject({ full: true });
    expect(await syncReq({ v: SYNC_VERSION, epoch: p.epoch, since: p.seq })).toMatchObject({ sync: p });
  });

  test('a frame that changed something ends with its position', async () => {
    const frames: P.ClientEvent[][] = [];
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    await new Promise((r) => (sock.onopen = r));
    sock.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    const before = pos().seq;
    say(d1, 'general', 'ann');
    store.ingest(d1, { t: 'typing', conversation: 'general', author: 'ann' });
    await settle();
    sock.close();
    expect(frames).toHaveLength(1);
    expect(frames[0].at(-1)).toEqual({ t: 'sync', seq: before + 1 });
    expect(frames[0].some((e) => e.t === 'typing')).toBe(true);
    // A typing indicator alone goes into no journal.
    store.ingest(d1, { t: 'typing', conversation: 'general', author: 'ann' });
    await settle();
    expect(pos().seq).toBe(before + 1);
  });

  test('the heartbeat answers', async () => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    await new Promise((r) => (sock.onopen = r));
    const got = new Promise((r) => (sock.onmessage = (e) => r(e.data)));
    sock.send('ping');
    expect(await got).toBe('pong');
    sock.close();
  });

  test('a timeline older than the journal gets the newest page instead', async () => {
    const p = pos();
    const t = step.timelines.get(`c:${cnv(d1, 'general')}`)!;
    store.journal.prune(Date.now() + 30 * 86_400_000);
    expect(store.journal.floor).toBe(p.seq);
    const r = await syncReq({ v: p.v, epoch: p.epoch, timelines: [{ key: `c:${cnv(d1, 'general')}`, seq: p.seq - 5, newest: t.messages.at(-1)!.ts, oldest: t.messages[0].ts }] });
    if (r.full) throw new Error('refused');
    expect(r.timelines[0]).toMatchObject({ replace: true, hasMore: true });
    expect(r.timelines[0].messages).toHaveLength(60);
    // And a whole client from before it starts over.
    expect(await syncReq({ v: p.v, epoch: p.epoch, since: p.seq - 1 })).toMatchObject({ full: true, reason: 'older than the journal' });
    expect(await syncReq({ v: p.v, epoch: p.epoch, since: p.seq })).toMatchObject({ sync: p });
  });

  test('a journal the disk cannot write to: the frame still goes out, and its changes go in with the next one', async () => {
    const frames: P.ClientEvent[][] = [];
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    await new Promise((r) => (sock.onopen = r));
    sock.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    const p = pos();
    const seen = new Promise<void>((r) => {
      const was = sock.onmessage!;
      sock.onmessage = (e) => {
        (was as (e: MessageEvent) => void)(e);
        if (frames.length === 2) r();
      };
    });
    // Writes into the journal fail as a full disk's do, after the message itself is in (SQLITE_FULL in the live hub).
    const full = ['INSERT', 'UPDATE'].map((op) => `CREATE TEMP TRIGGER full_${op} BEFORE ${op} ON sync_change BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    const first = say(d1, 'general', 'ann');
    for (const t of full) store.db.exec(t);
    try {
      expect(() => hub.flush()).not.toThrow();
    } finally {
      store.db.exec('DROP TRIGGER temp.full_INSERT; DROP TRIGGER temp.full_UPDATE');
    }
    // No position was handed out, and nothing is in the journal yet: a client resuming from before has missed nothing.
    expect(pos()).toEqual(p);
    const second = say(d1, 'random', 'bob');
    hub.flush();
    await seen;
    sock.close();
    // The connected device got the first message at once, in a frame with no position.
    expect(frames[0].some((e) => e.t === 'message' && e.message.id === msg(d1, first))).toBe(true);
    expect(frames[0].some((e) => e.t === 'sync')).toBe(false);
    expect(frames[1].at(-1)).toEqual({ t: 'sync', seq: p.seq + 1 });
    // The next frame carries what was held: a client from before both finds both conversations changed.
    const changed = store.journal.since(p.seq).map((r) => `${r.kind}:${r.id}`);
    expect(changed).toContain(`conversation:${cnv(d1, 'general')}`);
    expect(changed).toContain(`conversation:${cnv(d1, 'random')}`);
    const rows = store.db.query('SELECT id FROM sync_change WHERE kind = ? AND seq = ?').all('message', p.seq + 1) as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual([msg(d1, first), msg(d1, second)].sort());
  });

  test('a reset world starts the journal over', async () => {
    const p = pos();
    hub.broadcast([{ t: 'resync' }]);
    expect(pos().epoch).not.toBe(p.epoch);
    expect(pos().seq).toBeGreaterThanOrEqual(p.seq);
    expect(await syncReq({ v: p.v, epoch: p.epoch, since: p.seq })).toMatchObject({ full: true });
  });
});

describe('the journal across restarts', () => {
  test('a clean stop continues, a crash starts over', () => {
    const db = new Store(join(dir, 'restart.sqlite'), mediaSigner('s'));
    const first = db.journal;
    expect(first.started).toBe('new');
    first.record([{ kind: 'account', id: 'a' }]);
    first.close();
    const again = new Journal(db.db);
    expect(again.started).toBe('continued');
    expect(again.position()).toEqual(first.position());
    // Never closed: the last moment's changes may not be in it.
    const crashed = new Journal(db.db);
    expect(crashed.started).toBe('unclean');
    expect(crashed.epoch).not.toBe(first.epoch);
    expect(crashed.seq).toBe(first.seq);
    expect(crashed.since(0)).toEqual([]);
    db.db.close();
  });

  test('changes a full disk would not take are held: kept through a rolled-back caller, and a stop with them left is unclean', () => {
    const db = new Store(join(dir, 'held.sqlite'), mediaSigner('s'));
    const j = db.journal;
    const fail = (on: boolean) => db.db.exec(on ? `CREATE TEMP TRIGGER full BEFORE INSERT ON sync_change BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END` : 'DROP TRIGGER temp.full');
    fail(true);
    expect(j.record([{ kind: 'account', id: 'a' }])).toBeNull();
    fail(false);
    expect(j.seq).toBe(0);
    // A caller's own transaction writes them, then is rolled back: the journal takes back what it thought written.
    const mark = j.mark();
    expect(() =>
      db.db.transaction(() => {
        expect(j.record([{ kind: 'account', id: 'b' }])).toBe(1);
        throw new Error('the commit failed');
      })(),
    ).toThrow('the commit failed');
    j.undo(mark);
    expect(j.seq).toBe(0);
    expect(j.since(0)).toEqual([]);
    // Still unwritable at the stop: the journal stays open, and the next start is a new epoch.
    fail(true);
    j.close();
    fail(false);
    expect(new Journal(db.db).started).toBe('unclean');
    db.db.close();
    // Written by the next frame instead: both in at its position.
    const db2 = new Store(join(dir, 'held2.sqlite'), mediaSigner('s'));
    const k = db2.journal;
    db2.db.exec(`CREATE TEMP TRIGGER full BEFORE INSERT ON sync_change BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    expect(k.record([{ kind: 'account', id: 'a' }])).toBeNull();
    db2.db.exec('DROP TRIGGER temp.full');
    expect(k.record([{ kind: 'account', id: 'b' }])).toBe(1);
    expect(k.since(0).map((r) => `${r.id}@${r.seq}`)).toEqual(['a@1', 'b@1']);
    k.close();
    expect(new Journal(db2.db).started).toBe('continued');
    db2.db.close();
  });

  test('too many changed objects: the oldest go, and the floor rises', () => {
    const db = new Store(join(dir, 'prune.sqlite'), mediaSigner('s'));
    const j = db.journal;
    for (let i = 0; i < 10; i++) j.record([{ kind: 'identity', id: `i${i}` }]);
    j.prune(Date.now(), 86_400_000, 4);
    expect(j.since(0).map((r) => r.id)).toEqual(['i6', 'i7', 'i8', 'i9']);
    expect(j.floor).toBe(6);
    expect(j.refuse(SYNC_VERSION, j.epoch, 5)).toBe('older than the journal');
    expect(j.refuse(SYNC_VERSION, j.epoch, 6)).toBeNull();
    db.db.close();
  });
});

describe('what is not news', () => {
  test('an adapter announcing the same places and messages again changes nothing', async () => {
    const c = await newClient([...step.timelines.keys()]);
    const facts: P.AdapterEvent[] = [
      { t: 'space', space: { nativeId: 'g2', kind: 'community', name: 'Second guild' } },
      { t: 'space', space: { nativeId: 'g2-cat', kind: 'section', name: 'Cat', parents: [{ nativeId: 'g2', position: '01' }] } },
      { t: 'conversation', conversation: { nativeId: 'g2-chan', shape: 'channel', name: 'chan', spaces: [{ nativeId: 'g2-cat', position: '02' }] } },
      { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Group', participants: ['me1', 'ann', 'eve'] } },
      { t: 'message', live: false, message: { nativeId: 'again-1', conversation: 'g2-chan', author: 'eve', ts: (ts += 1000), body: 'once', reactions: [{ key: '👍', authors: ['ann'], count: 1 }] } },
    ];
    for (const f of facts) store.ingest(d1, f);
    await settle();
    const seq = store.journal.seq;
    for (const f of facts) {
      store.ingest(d1, f);
      const what = JSON.stringify(f).slice(0, 80);
      expect({ what, dirty: [...store.dirty.conversations, ...store.dirty.spaces, ...store.dirty.identities, ...store.dirty.messages.keys()] }).toEqual({ what, dirty: [] });
    }
    await settle();
    expect(store.journal.since(seq).map((r) => `${r.kind}:${r.id}`)).toEqual([]);
    // A real change still is.
    store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'g2-chan', shape: 'channel', name: 'chan', spaces: [{ nativeId: 'g2-cat', position: '03' }] } });
    await settle();
    expect(store.journal.since(seq).map((r) => `${r.kind}:${r.id}`).sort()).toEqual([`conversation:${cnv(d1, 'g2-chan')}`, `space:${hubId('spc', 'discord', 'g2-cat')}`]);
    await resync(c);
    await expectCurrent('after', c);
  });
});

describe('sends', () => {
  test('one retried with the same client id goes out once', async () => {
    const conv = cnv(d1, 'general');
    const before = sent.filter((c) => c.t === 'send').length;
    const body = { body: 'hello', clientId: 'tmp-retry' };
    const [a, b] = await Promise.all([call('POST', `/api/conversations/${conv}/send`, body), call('POST', `/api/conversations/${conv}/send`, body)]);
    const c = await call('POST', `/api/conversations/${conv}/send`, body);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    // The answer names the message the network sent, as the hub will store it (the app's pending copy goes on it).
    expect(a.messageId).toBe(hubId('msg', 'discord', 'x'));
    expect(sent.filter((x) => x.t === 'send').length).toBe(before + 1);
    await call('POST', `/api/conversations/${conv}/send`, { body: 'hello', clientId: 'tmp-other' });
    expect(sent.filter((x) => x.t === 'send').length).toBe(before + 2);
  });

  test('the socket says which message a send became, as soon as the network named it, and journals only the send queue', async () => {
    const conv = cnv(d1, 'general');
    const frames: P.ClientEvent[][] = [];
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    await new Promise((r) => (sock.onopen = r));
    sock.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await settle();
    const seq = store.journal.position().seq;
    const a = await call('POST', `/api/conversations/${conv}/send`, { body: 'quick', clientId: 'tmp-quick~1' });
    // Without a clientId there is no page to tell.
    await call('POST', `/api/conversations/${conv}/send`, { body: 'quick' });
    // A retry gets the first answer, and no second event.
    await call('POST', `/api/conversations/${conv}/send`, { body: 'quick', clientId: 'tmp-quick~1' });
    await settle();
    sock.close();
    const told = frames.flat().filter((e) => e.t === 'sent');
    expect(told).toEqual([{ t: 'sent', conversationId: conv, clientId: 'tmp-quick~1', messageId: a.messageId }]);
    // The `sent` event is of the moment; the send queue's list is kept (sendqueue.ts).
    expect([...new Set(store.journal.since(seq).map((r) => r.kind))]).toEqual(['sends']);
  });
});
