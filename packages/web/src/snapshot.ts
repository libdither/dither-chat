/**
 * What the last screen needs, kept on this device so the app paints before the hub answers.
 *
 * Without it nothing can show until the live socket opens and /api/bootstrap comes back over the tailnet: on a
 * phone that is seconds. With it, the start is a read from IndexedDB and a JSON.parse, and the hub's answer
 * replaces it a moment later (applyBootstrap replaces the whole `db`, and open timelines are fetched as before).
 *
 * Kept: the bootstrap (every list in the sidebar, unread counts, last messages) and the inbox, in one store, and the
 * newest messages of the conversations opened most recently or fetched ahead, a record each in another (keptpages.ts).
 * Capped, see the limits below and there. The hub stays the only source of truth: nothing here is ever sent back.
 *
 * A snapshot is only read by a build of the same protocol (the vite config hashes packages/protocol into
 * __SNAPSHOT_SCHEMA__), so a deploy that changes the shapes starts once from the network instead of from data
 * the new code does not expect.
 */
import type * as P from '@dither-chat/protocol';
import { INDEX_KEY, PageCache, type IndexRecord, type KeptPage, type PageRecord, type PageWrites } from './keptpages.ts';
import { db, eventHooks, inbox, loaded, mailTriage, quoted, timelines } from './state.ts';
import { calendarLink } from './plans.ts';
import { changed, dataVersion, mailChanged, timelineChanged } from './versions.ts';
import { bodies as mailBodies, details as mailDetails } from './mail/held.ts';

declare const __SNAPSHOT_SCHEMA__: string;
const SCHEMA = typeof __SNAPSHOT_SCHEMA__ === 'string' ? __SNAPSHOT_SCHEMA__ : 'dev';

/** Past this the bootstrap is not kept at all: reading it back would cost about what the network does. */
export const MAX_BOOTSTRAP_CHARS = 12_000_000;
export const MAX_REST_CHARS = 1_500_000;
export const MAX_INBOX = 100;
/** Mail the reader opened last (docs/mail.md): its threads and bodies, so they open offline too. */
export const MAX_MAIL_THREADS = 20;
export const MAX_MAIL_BODIES = 50;
export const MAX_MAIL_CHARS = 600_000;
/** Threads the bootstrap keeps of mail, newest first. */
export const MAX_MAIL_WINDOW = 300;

/** A kept page as a snapshot from before the page store held it (keptpages.ts). */
interface LegacyTimeline {
  key: string;
  messages: P.MessageView[];
  conversationIds?: string[];
  sync?: P.SyncPosition;
}

/** Everything but the bootstrap. */
export interface SnapshotRest {
  inbox: P.MessageView[];
  /** Only in a snapshot of an older build: kept pages are records of their own now (keptpages.ts). */
  timelines?: LegacyTimeline[];
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
  identities: Map<string, P.IdentityView>;
  quoted: Map<string, P.MessageView>;
  mail?: { details: P.MailThreadDetail[]; bodies: P.MailBodyView[] };
  mailTriage?: P.MailTriageItem[];
}): string {
  const out: SnapshotRest = { inbox: input.inbox.slice(0, MAX_INBOX), identities: [], quoted: [] };
  const msgs = out.inbox;
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
    ...(calendarLink.value ? { calendar: calendarLink.value } : {}),
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
/** Kept message pages, one record per timeline, and their index (keptpages.ts). */
const PAGES = 'pages';
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
    // 2: the page store. A build from before it cannot open this database, and starts from the hub.
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(PAGES)) d.createObjectStore(PAGES);
    };
    req.onsuccess = () => {
      // A newer build's tab upgrading the database waits for this one to let go.
      req.result.onversionchange = () => {
        req.result.close();
        dbp = null;
      };
      resolve(req.result);
    };
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

/** The kept message pages (keptpages.ts): read with the snapshot, opened from here. */
export const pages = new PageCache(SCHEMA);

/**
 * A conversation or person gone from the hub (an account removed with them) takes its kept page along. Added at the
 * first read, not when this module loads: state.ts imports this one, so its hooks may not exist yet then.
 */
let listening = false;
function forgetRemoved() {
  if (listening) return;
  listening = true;
  eventHooks.add((ev) => {
    if (ev.t !== 'conversation.removed' && ev.t !== 'person.removed') return;
    pages.forget(`${ev.t === 'conversation.removed' ? 'c' : 'p'}:${ev.id}`);
    persistSoon();
  });
}

/** The snapshot, if one of this schema is kept; the kept pages go to `pages` either way. */
export async function readSnapshot(): Promise<Snapshot | null> {
  forgetRemoved();
  if (typeof indexedDB === 'undefined') return null;
  const [s, r, kept] = await idb()
    .then(
      (d) =>
        new Promise<[Snapshot | undefined, RestRecord | undefined, (PageRecord | IndexRecord)[]]>((resolve, reject) => {
          const t = d.transaction([STORE, PAGES], 'readonly');
          const a = t.objectStore(STORE).get(KEY);
          const b = t.objectStore(STORE).get(REST_KEY);
          const c = t.objectStore(PAGES).getAll();
          t.oncomplete = () => resolve([a.result, b.result, c.result]);
          t.onerror = t.onabort = () => reject(t.error);
        }),
    )
    .catch(() => [undefined, undefined, [] as (PageRecord | IndexRecord)[]] as const);
  pages.adopt(kept);
  if (!s || s.schema !== SCHEMA) return null;
  // savedAt stays the bootstrap's.
  return r && r.schema === SCHEMA && r.savedAt > s.savedAt ? { ...s, rest: r.rest } : s;
}

export const dropSnapshot = () =>
  tx('readwrite', (st) => {
    st.delete(REST_KEY);
    return st.delete(KEY);
  }).catch(() => {});

/** Every kept page too: what a start that could not render drops (main.tsx). */
export const dropPages = () =>
  idb()
    .then(
      (d) =>
        new Promise<void>((resolve, reject) => {
          const t = d.transaction(PAGES, 'readwrite');
          t.objectStore(PAGES).clear();
          t.oncomplete = () => resolve();
          t.onerror = t.onabort = () => reject(t.error);
        }),
    )
    .catch(() => {});

// ------------------------------------------------------------------ restoring

/** Set while what is on screen came from this device, not yet from the hub. */
export let fromSnapshot = false;

/** The kept end of a conversation, given once, to show while its first page loads. */
export function cachedTimeline(key: string): KeptPage | undefined {
  return pages.take(key);
}

/** A timeline was opened: it goes first in what is kept. */
export function touchTimeline(key: string) {
  pages.touch(key);
}

/**
 * Show the last snapshot, unless the hub got here first. `apply` is state.ts's applyBootstrap, `putIdentities` adds
 * to its identity index. Returns whether anything was shown.
 */
export function restore(s: Snapshot, apply: (b: P.Bootstrap) => void, putIdentities: (i: P.IdentityView[]) => void): boolean {
  const rest = JSON.parse(s.rest) as SnapshotRest;
  if (rest.timelines?.length) pages.adoptLegacy(legacyPages(rest));
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

/** An older build's rest kept its pages inside it, with one list of people and quoted messages for all of them. */
function legacyPages(rest: SnapshotRest): KeptPage[] {
  const ids = new Map(rest.identities.map((i) => [i.id, i]));
  const qs = new Map(rest.quoted.map((m) => [m.id, m]));
  return (rest.timelines ?? []).map((t) => {
    const people = new Set(t.messages.flatMap((m) => [m.authorId, ...m.reactions.flatMap((r) => r.identityIds)]));
    const quotedHere = t.messages.map((m) => (m.replyToId ? qs.get(m.replyToId) : undefined)).filter((m): m is P.MessageView => !!m);
    for (const q of quotedHere) people.add(q.authorId);
    return { ...t, identities: [...people].map((p) => (p ? ids.get(p) : undefined)).filter((i): i is P.IdentityView => !!i), quoted: quotedHere };
  });
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
  await savePages();
  const mail = { details: [...mailDetails.values()].filter((d) => !d.loading && !d.error && d.messages.length), bodies: [...mailBodies.values()] };
  const rest = buildRest({ inbox: inbox.value, identities: db.identities, quoted, mail, mailTriage: mailTriage.value });
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

let lastIndex = '';
/** The kept pages that changed, and those that go (keptpages.ts). */
async function savePages() {
  const w: PageWrites = pages.save({
    // What a timeline is current to: a kept copy not yet caught up, its own position; one loaded here, the client's.
    live: (k) => {
      const t = timelines.get(k);
      return t ? { ...t, sync: t.from ?? (t.fetchedAt && !t.loading ? (db.sync ?? undefined) : undefined) } : undefined;
    },
    exists: (k) => (k.startsWith('c:') ? db.conversations.has(k.slice(2)) : k.startsWith('p:') && db.persons.has(k.slice(2))),
    identities: db.identities,
    quoted,
  });
  const index = JSON.stringify(w.index);
  if (!w.put.length && !w.del.length && index === lastIndex) return;
  lastIndex = index;
  await idb()
    .then(
      (d) =>
        new Promise<void>((resolve, reject) => {
          const t = d.transaction(PAGES, 'readwrite');
          const st = t.objectStore(PAGES);
          for (const k of w.del) st.delete(k);
          for (const r of w.put) st.put(r, r.key);
          st.put(w.index, INDEX_KEY);
          t.oncomplete = () => resolve();
          t.onerror = t.onabort = () => reject(t.error);
        }),
    )
    .catch((e) => console.warn('kept pages not saved', e));
}

/** Only the inbox changed: the stored bootstrap stays, unread and unwritten. */
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
