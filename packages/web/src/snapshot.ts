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
import { db, inbox, loaded, mailTriage, quoted, timelines, type Timeline } from './state.ts';
import { changed, dataVersion, mailChanged, timelineChanged } from './versions.ts';
import { bodies as mailBodies, details as mailDetails } from './mail/held.ts';

declare const __SNAPSHOT_SCHEMA__: string;
const SCHEMA = typeof __SNAPSHOT_SCHEMA__ === 'string' ? __SNAPSHOT_SCHEMA__ : 'dev';

/** Past this the bootstrap is not kept at all: reading it back would cost about what the network does. */
export const MAX_BOOTSTRAP_CHARS = 12_000_000;
/** Conversations whose newest messages are kept, most recently opened first. */
export const MAX_TIMELINES = 12;
export const MAX_MESSAGES = 40;
export const MAX_REST_CHARS = 1_500_000;
export const MAX_INBOX = 100;
/** Mail the reader opened last (docs/mail.md): its threads and bodies, so they open offline too. */
export const MAX_MAIL_THREADS = 20;
export const MAX_MAIL_BODIES = 50;
export const MAX_MAIL_CHARS = 600_000;
/** Threads the bootstrap keeps of mail, newest first. */
export const MAX_MAIL_WINDOW = 300;

export interface CachedTimeline {
  key: string;
  messages: P.MessageView[];
  conversationIds?: string[];
  /** The journal position these messages are current to: opening it again asks only for what changed since (docs/sync.md). */
  sync?: P.SyncPosition;
}

/** Everything but the bootstrap. */
export interface SnapshotRest {
  inbox: P.MessageView[];
  timelines: CachedTimeline[];
  /** Authors and reactors of the messages above, which the bootstrap may not have. */
  identities: P.IdentityView[];
  /** Messages the ones above reply to, when they are not loaded themselves. */
  quoted: P.MessageView[];
  /** The last mail threads and bodies the reader opened. */
  mail?: { details: P.MailThreadDetail[]; bodies: P.MailBodyView[] };
  /** The week's mail decisions (How it sorts' mail), newest first (slice 9). */
  mailTriage?: P.MailTriageItem[];
}

export interface Snapshot {
  schema: string;
  savedAt: number;
  /** JSON text. Parsing text is faster than structured clone for this many small objects. */
  bootstrap: string;
  rest: string;
}

// ------------------------------------------------------------------ building (pure, tested)

export function buildRest(input: {
  inbox: P.MessageView[];
  timelines: (Timeline & { sync?: P.SyncPosition })[];
  identities: Map<string, P.IdentityView>;
  quoted: Map<string, P.MessageView>;
  mail?: { details: P.MailThreadDetail[]; bodies: P.MailBodyView[] };
  mailTriage?: P.MailTriageItem[];
}): string {
  const out: SnapshotRest = { inbox: input.inbox.slice(0, MAX_INBOX), timelines: [], identities: [], quoted: [] };
  let size = JSON.stringify(out.inbox).length;
  for (const t of input.timelines.slice(0, MAX_TIMELINES)) {
    // A window around an old message is not the end anyone reopens at.
    if (t.detached || !t.messages.length) continue;
    const c: CachedTimeline = { key: t.key, messages: t.messages.slice(-MAX_MESSAGES), conversationIds: t.conversationIds, ...(t.sync ? { sync: t.sync } : {}) };
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
  if (input.mail) out.mail = mailRest(input.mail);
  if (input.mailTriage?.length) out.mailTriage = input.mailTriage.slice(0, MAX_INBOX);
  return JSON.stringify(out);
}

/** The newest of what the reader opened, within the caps: the most recent last in, first kept. */
export function mailRest(m: { details: P.MailThreadDetail[]; bodies: P.MailBodyView[] }): { details: P.MailThreadDetail[]; bodies: P.MailBodyView[] } {
  const out = { details: [] as P.MailThreadDetail[], bodies: [] as P.MailBodyView[] };
  let size = 0;
  for (const d of m.details.slice(-MAX_MAIL_THREADS).reverse()) {
    const n = JSON.stringify(d).length;
    if (size + n > MAX_MAIL_CHARS / 3) break;
    size += n;
    out.details.push(d);
  }
  for (const b of m.bodies.slice(-MAX_MAIL_BODIES).reverse()) {
    const n = JSON.stringify(b).length;
    if (size + n > MAX_MAIL_CHARS) continue;
    size += n;
    out.bodies.push(b);
  }
  return out;
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
    ...(db.accountsManager ? { accountsManager: db.accountsManager } : {}),
    rules: db.rules,
    devices: db.devices,
    reactionUsage: db.reactionUsage,
    attention: [...db.attention.values()],
    requests: db.requests,
    now: Date.now(),
    ...(db.sync ? { sync: db.sync } : {}),
    ...(db.mail.access.state !== 'off' || db.mail.accounts.size
      ? {
          mail: {
            access: db.mail.access,
            accounts: [...db.mail.accounts.values()],
            mailboxes: [...db.mail.mailboxes.values()],
            threads: [...db.mail.threads.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_MAIL_WINDOW),
          },
        }
      : {}),
  };
}

// ------------------------------------------------------------------ IndexedDB

const DB_NAME = 'dither-chat';
const STORE = 'snapshot';
const KEY = 'last';
/** The rest alone, written while the app stays open; newer than KEY's rest when its savedAt is. */
const REST_KEY = 'rest';
interface RestRecord {
  schema: string;
  savedAt: number;
  rest: string;
}

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
  const [s, r] = await idb()
    .then(
      (d) =>
        new Promise<[Snapshot | undefined, RestRecord | undefined]>((resolve, reject) => {
          const t = d.transaction(STORE, 'readonly');
          const a = t.objectStore(STORE).get(KEY);
          const b = t.objectStore(STORE).get(REST_KEY);
          t.oncomplete = () => resolve([a.result, b.result]);
          t.onerror = t.onabort = () => reject(t.error);
        }),
    )
    .catch(() => [undefined, undefined] as const);
  if (!s || s.schema !== SCHEMA) return null;
  // savedAt stays the bootstrap's.
  return r && r.schema === SCHEMA && r.savedAt > s.savedAt ? { ...s, rest: r.rest } : s;
}

export const dropSnapshot = () =>
  tx('readwrite', (st) => {
    st.delete(REST_KEY);
    return st.delete(KEY);
  }).catch(() => {});

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
  bootstrapAt = s.savedAt;
  apply(JSON.parse(s.bootstrap) as P.Bootstrap);
  putIdentities(rest.identities);
  rest.quoted.forEach((m) => quoted.set(m.id, m));
  inbox.value = rest.inbox;
  mailTriage.value = rest.mailTriage ?? [];
  for (const d of rest.mail?.details ?? []) mailDetails.set(d.thread.id, d);
  for (const b of rest.mail?.bodies ?? []) mailBodies.set(b.messageId, b);
  fromSnapshot = true;
  changed('meta');
  mailChanged();
  timelineChanged();
  return true;
}

/** The hub's own bootstrap is in. */
export function freshFromHub() {
  fromSnapshot = false;
}

// ------------------------------------------------------------------ saving

/** The data version (versions.ts) the stored bootstrap reflects, and when it was written. */
let savedRev = -1;
let bootstrapAt = 0;
/** How old the stored bootstrap gets while the app stays in sight before a quiet moment writes it again. */
const BOOTSTRAP_EVERY_MS = 10 * 60_000;
let pending: { text: string; rev: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Save once things settle. `bootstrapText` is the hub's own answer, which costs nothing to keep; without it the
 * bootstrap is serialized again from `db`, which is what happens when the app goes out of sight.
 */
export function persistSoon(bootstrapText?: string, ms = 1500) {
  if (bootstrapText) pending = { text: bootstrapText, rev: dataVersion() };
  clearTimeout(timer);
  timer = setTimeout(() => {
    const idle = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    if (idle) idle(() => void persistNow(false), { timeout: 3000 });
    else void persistNow(false);
  }, ms);
}

/**
 * `full`: the bootstrap is written again from `db` if anything changed since it was stored, as when the app goes out of
 * sight. Otherwise (the save after a conversation opens) the stored one stays unless it is old, and only the rest is
 * written: serializing and storing a 4–5 MB bootstrap after every open took a few hundred milliseconds of a phone's
 * main thread (docs/perf.md). The stored bootstrap carries its own sync position, so an older one is caught up as
 * any snapshot is.
 */
export async function persistNow(full = true) {
  clearTimeout(timer);
  if (!loaded.value || fromSnapshot) return;
  let text: string | null = null;
  if (pending) {
    // What the hub sent, as it sent it. Anything since is caught by the save when the app goes out of sight.
    ({ text, rev: savedRev } = pending);
    pending = null;
  } else if (savedRev !== dataVersion() && (full || Date.now() - bootstrapAt > BOOTSTRAP_EVERY_MS)) {
    savedRev = dataVersion();
    text = JSON.stringify(currentBootstrap());
  }
  // What a timeline is current to: a kept copy not yet caught up, its own position; one loaded here, the client's.
  const live = recent
    .map((k) => {
      const t = timelines.get(k);
      if (t) return { ...t, sync: t.from ?? (t.fetchedAt && !t.loading ? (db.sync ?? undefined) : undefined) };
      const c = cached.get(k);
      return c ? { ...c, hasMore: true, loading: false } : undefined;
    })
    .filter((t): t is Timeline & { sync?: P.SyncPosition } => !!t);
  const mail = { details: [...mailDetails.values()].filter((d) => !d.loading && !d.error && d.messages.length), bodies: [...mailBodies.values()] };
  const rest = buildRest({ inbox: inbox.value, timelines: live, identities: db.identities, quoted, mail, mailTriage: mailTriage.value });
  if (text === null) return void (await patchRest(rest));
  if (text.length > MAX_BOOTSTRAP_CHARS) {
    console.warn(`snapshot: the bootstrap is ${text.length} characters, over ${MAX_BOOTSTRAP_CHARS}; not kept`);
    bootstrapAt = 0;
    return void (await dropSnapshot());
  }
  const s: Snapshot = { schema: SCHEMA, savedAt: Date.now(), bootstrap: text, rest };
  bootstrapAt = s.savedAt;
  await tx('readwrite', (st) => {
    st.delete(REST_KEY);
    return st.put(s, KEY);
  }).catch((e) => console.warn('snapshot not saved', e));
}

/** Only the timelines and inbox changed: the stored bootstrap stays, unread and unwritten. */
async function patchRest(rest: string) {
  if (!bootstrapAt) return;
  const r: RestRecord = { schema: SCHEMA, savedAt: Date.now(), rest };
  await tx('readwrite', (st) => st.put(r, REST_KEY)).catch(() => {});
}

if (typeof document !== 'undefined') {
  // Leaving the app is the moment that matters: the next start shows what was on screen now.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void persistNow());
  addEventListener('pagehide', () => void persistNow());
}
