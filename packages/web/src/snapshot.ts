/**
 * What the last screen needs, kept on this device so the app paints before the hub answers.
 *
 * Without it nothing can show until the live socket opens and /api/bootstrap comes back over the tailnet: on a
 * phone that is seconds. With it, the start is a read from IndexedDB and a JSON.parse, and the hub's answer
 * replaces it a moment later (applyBootstrap replaces the whole `db`, and open timelines are fetched as before).
 *
 * Kept: the bootstrap (every list in the sidebar, unread counts, last messages), the inbox, and the newest messages
 * of the conversations opened most recently, with the people who wrote them. Capped, see the limits below.
 * The hub stays the only source of truth: nothing here is ever sent back.
 *
 * A snapshot is only read by a build of the same protocol (the vite config hashes packages/protocol into
 * __SNAPSHOT_SCHEMA__), so a deploy that changes the shapes starts once from the network instead of from data
 * the new code does not expect.
 */
import type * as P from '@dither-chat/protocol';
import { db, inbox, loaded, quoted, rev, timelines, type Timeline } from './state.ts';

declare const __SNAPSHOT_SCHEMA__: string;
const SCHEMA = typeof __SNAPSHOT_SCHEMA__ === 'string' ? __SNAPSHOT_SCHEMA__ : 'dev';

/** Past this the bootstrap is not kept at all: reading it back would cost about what the network does. */
export const MAX_BOOTSTRAP_CHARS = 12_000_000;
/** Conversations whose newest messages are kept, most recently opened first. */
export const MAX_TIMELINES = 12;
export const MAX_MESSAGES = 40;
export const MAX_REST_CHARS = 1_500_000;
export const MAX_INBOX = 100;

export interface CachedTimeline {
  key: string;
  messages: P.MessageView[];
  conversationIds?: string[];
}

/** Everything but the bootstrap. */
export interface SnapshotRest {
  inbox: P.MessageView[];
  timelines: CachedTimeline[];
  /** Authors and reactors of the messages above, which the bootstrap may not have. */
  identities: P.IdentityView[];
  /** Messages the ones above reply to, when they are not loaded themselves. */
  quoted: P.MessageView[];
}

export interface Snapshot {
  schema: string;
  savedAt: number;
  /** JSON text. Parsing text is faster than structured clone for this many small objects. */
  bootstrap: string;
  rest: string;
}

// ------------------------------------------------------------------ building (pure, tested)

export function buildRest(input: { inbox: P.MessageView[]; timelines: Timeline[]; identities: Map<string, P.IdentityView>; quoted: Map<string, P.MessageView> }): string {
  const out: SnapshotRest = { inbox: input.inbox.slice(0, MAX_INBOX), timelines: [], identities: [], quoted: [] };
  let size = JSON.stringify(out.inbox).length;
  for (const t of input.timelines.slice(0, MAX_TIMELINES)) {
    // A window around an old message is not the end anyone reopens at.
    if (t.detached || !t.messages.length) continue;
    const c: CachedTimeline = { key: t.key, messages: t.messages.slice(-MAX_MESSAGES), conversationIds: t.conversationIds };
    const n = JSON.stringify(c).length;
    if (size + n > MAX_REST_CHARS) break;
    size += n;
    out.timelines.push(c);
  }
  const msgs = [...out.inbox, ...out.timelines.flatMap((t) => t.messages)];
  const have = new Set(msgs.map((m) => m.id));
  const people = new Set<string>();
  for (const m of msgs) {
    if (m.authorId) people.add(m.authorId);
    for (const r of m.reactions) for (const i of r.identityIds) people.add(i);
    const q = m.replyToId && !have.has(m.replyToId) ? input.quoted.get(m.replyToId) : undefined;
    if (q) {
      have.add(q.id);
      out.quoted.push(q);
      if (q.authorId) people.add(q.authorId);
    }
  }
  for (const id of people) {
    const i = input.identities.get(id);
    if (i) out.identities.push(i);
  }
  return JSON.stringify(out);
}

/** The bootstrap again, from what the client holds now: newer than the one it started from. */
export function currentBootstrap(): P.Bootstrap {
  return {
    selfPersonId: db.selfPersonId,
    accounts: [...db.accounts.values()],
    persons: [...db.persons.values()],
    identities: [...db.identities.values()],
    spaces: [...db.spaces.values()],
    edges: [...db.children.values()].flat(),
    conversations: [...db.conversations.values()],
    folders: db.folders,
    placePrefs: [...db.placePrefs.values()],
    categories: db.categories,
    placeCategories: [...db.placeCategories.values()].flat(),
    categoryProvider: db.categoryProvider,
    rules: db.rules,
    reactionUsage: db.reactionUsage,
    now: Date.now(),
  };
}

// ------------------------------------------------------------------ IndexedDB

const DB_NAME = 'dither-chat';
const STORE = 'snapshot';
const KEY = 'last';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp: Promise<IDBDatabase> | null = null;
function idb() {
  return (dbp ??= open().catch((e) => ((dbp = null), Promise.reject(e))));
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = t.onabort = () => reject(t.error);
      }),
  );
}

export async function readSnapshot(): Promise<Snapshot | null> {
  if (typeof indexedDB === 'undefined') return null;
  const s = await tx<Snapshot | undefined>('readonly', (st) => st.get(KEY)).catch(() => undefined);
  return s && s.schema === SCHEMA ? s : null;
}

export const dropSnapshot = () => tx('readwrite', (st) => st.delete(KEY)).catch(() => {});

// ------------------------------------------------------------------ restoring

/** Most recently opened first. */
const recent: string[] = [];
const cached = new Map<string, CachedTimeline>();
/** Set while what is on screen came from this device, not yet from the hub. */
export let fromSnapshot = false;

/** The cached end of a conversation, given once, to show while its first page loads. */
export function cachedTimeline(key: string): CachedTimeline | undefined {
  const c = cached.get(key);
  cached.delete(key);
  return c;
}

/** A timeline was opened: it goes first in the next snapshot. */
export function touchTimeline(key: string) {
  const i = recent.indexOf(key);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(key);
  if (recent.length > MAX_TIMELINES * 2) recent.length = MAX_TIMELINES * 2;
}

/**
 * Show the last snapshot, unless the hub got here first. `apply` is state.ts's applyBootstrap, `putIdentities` adds
 * to its identity index. Returns whether anything was shown.
 */
export function restore(s: Snapshot, apply: (b: P.Bootstrap) => void, putIdentities: (i: P.IdentityView[]) => void): boolean {
  const rest = JSON.parse(s.rest) as SnapshotRest;
  for (const t of rest.timelines) {
    cached.set(t.key, t);
    recent.push(t.key);
  }
  if (loaded.value) return false;
  apply(JSON.parse(s.bootstrap) as P.Bootstrap);
  putIdentities(rest.identities);
  rest.quoted.forEach((m) => quoted.set(m.id, m));
  inbox.value = rest.inbox;
  fromSnapshot = true;
  rev.value++;
  return true;
}

/** The hub's own bootstrap is in. */
export function freshFromHub() {
  fromSnapshot = false;
}

// ------------------------------------------------------------------ saving

/** The `rev` the stored bootstrap reflects. */
let savedRev = -1;
let pending: { text: string; rev: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Save once things settle. `bootstrapText` is the hub's own answer, which costs nothing to keep; without it the
 * bootstrap is serialized again from `db`, which is what happens when the app goes out of sight.
 */
export function persistSoon(bootstrapText?: string, ms = 1500) {
  if (bootstrapText) pending = { text: bootstrapText, rev: rev.value };
  clearTimeout(timer);
  timer = setTimeout(() => {
    const idle = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    if (idle) idle(() => void persistNow(), { timeout: 3000 });
    else void persistNow();
  }, ms);
}

export async function persistNow() {
  clearTimeout(timer);
  if (!loaded.value || fromSnapshot) return;
  let text: string | null = null;
  if (pending) {
    // What the hub sent, as it sent it. Anything since is caught by the save when the app goes out of sight.
    ({ text, rev: savedRev } = pending);
    pending = null;
  } else if (savedRev !== rev.value) {
    savedRev = rev.value;
    text = JSON.stringify(currentBootstrap());
  }
  const live = recent.map((k) => timelines.get(k) ?? (cached.has(k) ? ({ ...cached.get(k)!, hasMore: true, loading: false } as Timeline) : undefined)).filter((t): t is Timeline => !!t);
  const rest = buildRest({ inbox: inbox.value, timelines: live, identities: db.identities, quoted });
  if (text === null) return void (await patchRest(rest));
  if (text.length > MAX_BOOTSTRAP_CHARS) {
    console.warn(`snapshot: the bootstrap is ${text.length} characters, over ${MAX_BOOTSTRAP_CHARS}; not kept`);
    return void (await dropSnapshot());
  }
  const s: Snapshot = { schema: SCHEMA, savedAt: Date.now(), bootstrap: text, rest };
  await tx('readwrite', (st) => st.put(s, KEY)).catch((e) => console.warn('snapshot not saved', e));
}

/** Only the timelines and inbox changed: keep the stored bootstrap. */
async function patchRest(rest: string) {
  const s = await readSnapshot();
  if (s) await tx('readwrite', (st) => st.put({ ...s, savedAt: Date.now(), rest }, KEY)).catch(() => {});
}

if (typeof document !== 'undefined') {
  // Leaving the app is the moment that matters: the next start shows what was on screen now.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void persistNow());
  addEventListener('pagehide', () => void persistNow());
}
