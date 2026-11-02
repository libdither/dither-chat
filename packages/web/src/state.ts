import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { leaveLayerEntry, takeOverLayers } from './phone.ts';

// ------------------------------------------------------------------ data

/** Bumped on every change to `db`; components read rev.value to re-render. */
export const rev = signal(0);
export const connected = signal(false);
export const loaded = signal(false);

export const db = {
  selfPersonId: null as string | null,
  accounts: new Map<string, P.AccountView>(),
  persons: new Map<string, P.PersonView>(),
  identities: new Map<string, P.IdentityView>(),
  spaces: new Map<string, P.SpaceView>(),
  conversations: new Map<string, P.ConversationView>(),
  folders: [] as P.FolderView[],
  placePrefs: new Map<string, P.PlacePrefView>(),
  categories: [] as P.CategoryView[],
  /** `${kind}:${id}` -> what each category says about that place */
  placeCategories: new Map<string, P.PlaceCategoryView[]>(),
  categoryProvider: 'keyword',
  rules: [] as P.RuleView[],
  /** parentId -> child edges */
  children: new Map<string, P.SpaceEdgeView[]>(),
  /** child space or conversation id -> parent edges */
  parents: new Map<string, P.SpaceEdgeView[]>(),
  /** conversation id -> its threads */
  threads: new Map<string, string[]>(),
  identityByNative: new Map<string, string>(),
  reactionUsage: [] as P.ReactionUsage[],
};

export interface Timeline {
  key: string;
  messages: P.MessageView[];
  hasMore: boolean;
  loading: boolean;
  /** person timelines: the direct conversations merged into it */
  conversationIds?: string[];
  /** Jumped to an old message: this window does not reach the latest ones. */
  detached?: boolean;
}
export const timelines = new Map<string, Timeline>();
/** Messages referenced by replies that are outside the loaded page. */
export const quoted = new Map<string, P.MessageView>();
export const inbox = signal<P.MessageView[]>([]);

export interface PendingSend {
  tempId: string;
  conversationId: string;
  body: string;
  ts: number;
  accountId?: string;
  failed?: string;
  files?: string[];
}
export const pending = signal<PendingSend[]>([]);
export const typing = signal<Record<string, { identityId: string; until: number }[]>>({});

export interface Toast {
  id: number;
  title: string;
  body: string;
  conversationId?: string;
  reasons?: string[];
  kind?: 'notify' | 'error' | 'info';
}
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;
export function toast(t: Omit<Toast, 'id'>, ms = 6000) {
  const id = ++toastSeq;
  toasts.value = [...toasts.value.slice(-3), { ...t, id }];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== id)), ms);
}

// ------------------------------------------------------------------ prefs

export type DirectorySort = 'recency' | 'activity' | 'unread' | 'name' | 'network' | 'manual' | 'category';

export interface Prefs {
  theme: 'dark' | 'light' | 'system';
  details: boolean;
  showDemo: boolean;
  collapsed: Record<string, boolean>;
  sendAs: Record<string, string>;
  via: Record<string, string>;
  notifications: boolean;
  /** Index into the emoji catalog's skins; 0 is the default yellow. */
  skinTone: number;
  directorySort: DirectorySort;
  /** This device gets Web Push, so the live socket need not raise its own notification. */
  pushEnabled: boolean;
}
const PREFS_KEY = 'dither-chat:prefs';
const defaults: Prefs = { theme: 'dark', details: false, showDemo: true, collapsed: {}, sendAs: {}, via: {}, notifications: false, skinTone: 0, directorySort: 'recency', pushEnabled: false };
export const prefs = signal<Prefs>({ ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') });
export function setPrefs(p: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...p };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
}

// ------------------------------------------------------------------ routing

export type Route =
  | { view: 'inbox'; conv?: string; msg?: string }
  /** The triage board. On a desktop it is the inbox with nothing open; a phone gives it a tab of its own. */
  | { view: 'triage' }
  | { view: 'people'; person?: string }
  | { view: 'profile'; person?: string; identity?: string }
  | { view: 'groups'; conv?: string }
  | { view: 'spaces' }
  | { view: 'space'; space: string; conv?: string }
  | { view: 'folder'; folder: string; conv?: string; person?: string }
  | { view: 'accounts'; account?: string }
  | { view: 'settings' }
  | { view: 'directory' }
  | { view: 'search'; q: string; conv?: string; msg?: string };

export function parseHash(h = location.hash): Route {
  const [path, query] = h.replace(/^#\/?/, '').split('?');
  const p = path.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query ?? '');
  switch (p[0]) {
    case 'people':
      return { view: 'people', person: p[1] };
    case 'p':
      return { view: 'profile', person: p[1] };
    case 'i':
      return { view: 'profile', identity: p[1] };
    case 'groups':
      return { view: 'groups', conv: p[1] === 'c' ? p[2] : undefined };
    case 'spaces':
      return { view: 'spaces' };
    case 's':
      return { view: 'space', space: p[1], conv: p[2] === 'c' ? p[3] : undefined };
    case 'f':
      return { view: 'folder', folder: p[1], conv: p[2] === 'c' ? p[3] : undefined, person: p[2] === 'p' ? p[3] : undefined };
    case 'accounts':
      return { view: 'accounts', account: p[1] };
    case 'settings':
      return { view: 'settings' };
    case 'triage':
      return { view: 'triage' };
    case 'directory':
      return { view: 'directory' };
    case 'search':
      return { view: 'search', q: q.get('q') ?? '', conv: p[1] === 'c' ? p[2] : undefined, msg: q.get('m') ?? undefined };
    case 'c':
      return { view: 'inbox', conv: p[1], msg: q.get('m') ?? undefined };
    default:
      return { view: 'inbox', conv: p[1] === 'c' ? p[2] : undefined, msg: q.get('m') ?? undefined };
  }
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.view) {
    case 'inbox':
      return r.conv ? `#/inbox/c/${e(r.conv)}${r.msg ? `?m=${e(r.msg)}` : ''}` : '#/inbox';
    case 'people':
      return r.person ? `#/people/${e(r.person)}` : '#/people';
    case 'profile':
      return r.person ? `#/p/${e(r.person)}` : `#/i/${e(r.identity ?? '')}`;
    case 'groups':
      return r.conv ? `#/groups/c/${e(r.conv)}` : '#/groups';
    case 'spaces':
      return '#/spaces';
    case 'space':
      return `#/s/${e(r.space)}${r.conv ? `/c/${e(r.conv)}` : ''}`;
    case 'folder':
      return `#/f/${e(r.folder)}${r.conv ? `/c/${e(r.conv)}` : r.person ? `/p/${e(r.person)}` : ''}`;
    case 'accounts':
      return r.account ? `#/accounts/${e(r.account)}` : '#/accounts';
    case 'settings':
      return '#/settings';
    case 'triage':
      return '#/triage';
    case 'directory':
      return '#/directory';
    case 'search':
      return `#/search${r.conv ? `/c/${e(r.conv)}` : ''}?q=${e(r.q)}${r.msg ? `&m=${e(r.msg)}` : ''}`;
  }
}

export const route = signal<Route>(parseHash());
window.addEventListener('hashchange', () => (route.value = parseHash()));
/**
 * Each entry remembers the one before it, so a back button can tell going back from opening the list fresh.
 * Navigating closes any open sheet or panel, and takes over its history entry rather than stacking on it.
 */
export function go(r: Route, replace = false) {
  const h = href(r);
  const layered = takeOverLayers();
  if (h === location.hash && !replace) {
    if (layered) leaveLayerEntry();
    return void (route.value = parseHash(h));
  }
  if (replace) history.replaceState({ prev: history.state?.prev ?? null }, '', h);
  else if (layered) history.replaceState({ prev: location.hash }, '', h);
  else history.pushState({ prev: location.hash }, '', h);
  route.value = parseHash(h);
}

/** Back where you came from, or to `fallback` when this page was opened directly. */
export function back(fallback: Route) {
  if (history.state?.prev) history.back();
  else go(fallback, true);
}

/** The route a back press would land on, when it is known. */
export const previousRoute = (): Route | null => (history.state?.prev ? parseHash(history.state.prev) : null);

// ------------------------------------------------------------------ http

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  // Not everything here is JSON: the account log and the access gate's refusals are plain text.
  const json = res.headers.get('content-type')?.includes('json');
  const data = json && text ? JSON.parse(text) : text || null;
  if (!res.ok) throw new Error(data?.error ?? (text.slice(0, 200) || `${res.status}`));
  return data as T;
}

// ------------------------------------------------------------------ applying hub data

function indexEdges(edges: P.SpaceEdgeView[]) {
  db.children.clear();
  db.parents.clear();
  for (const e of edges) addEdge(e);
}
function addEdge(e: P.SpaceEdgeView) {
  const c = db.children.get(e.parentId) ?? [];
  if (!c.some((x) => x.childId === e.childId && x.childKind === e.childKind)) c.push(e);
  else c.splice(c.findIndex((x) => x.childId === e.childId && x.childKind === e.childKind), 1, e);
  db.children.set(e.parentId, c);
  const p = db.parents.get(e.childId) ?? [];
  const i = p.findIndex((x) => x.parentId === e.parentId);
  if (i >= 0) p[i] = e;
  else p.push(e);
  db.parents.set(e.childId, p);
}
function removeEdge(parentId: string, childId: string) {
  db.children.set(parentId, (db.children.get(parentId) ?? []).filter((e) => e.childId !== childId));
  db.parents.set(childId, (db.parents.get(childId) ?? []).filter((e) => e.parentId !== parentId));
}
function indexThreads() {
  db.threads.clear();
  for (const c of db.conversations.values()) {
    if (c.parentId) db.threads.set(c.parentId, [...(db.threads.get(c.parentId) ?? []), c.id]);
  }
}
function putIdentity(i: P.IdentityView) {
  db.identities.set(i.id, i);
  db.identityByNative.set(`${i.network}:${i.nativeId}`, i.id);
}

const prefKey = (kind: P.PlaceKind, id: string) => `${kind}:${id}`;
function setPlacePrefs(prefs: P.PlacePrefView[]) {
  db.placePrefs = new Map(prefs.map((x) => [prefKey(x.kind, x.id), x]));
}

function setCategories(cats: P.CategoryView[], place: P.PlaceCategoryView[]) {
  db.categories = cats;
  db.placeCategories = new Map();
  for (const x of place) {
    const k = `${x.kind}:${x.id}`;
    db.placeCategories.set(k, [...(db.placeCategories.get(k) ?? []), x]);
  }
}

export function applyBootstrap(b: P.Bootstrap) {
  db.selfPersonId = b.selfPersonId;
  db.reactionUsage = b.reactionUsage ?? [];
  db.accounts = new Map(b.accounts.map((a) => [a.id, a]));
  db.persons = new Map(b.persons.map((p) => [p.id, p]));
  db.identities.clear();
  db.identityByNative.clear();
  b.identities.forEach(putIdentity);
  db.spaces = new Map(b.spaces.map((s) => [s.id, s]));
  db.conversations = new Map(b.conversations.map((c) => [c.id, c]));
  db.folders = b.folders;
  setPlacePrefs(b.placePrefs ?? []);
  setCategories(b.categories ?? [], b.placeCategories ?? []);
  db.categoryProvider = b.categoryProvider ?? 'keyword';
  db.rules = b.rules;
  indexEdges(b.edges);
  indexThreads();
  loaded.value = true;
  rev.value++;
}

function upsertInto(list: P.MessageView[], m: P.MessageView) {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    list[i] = m;
    return;
  }
  let j = list.length;
  while (j > 0 && list[j - 1].ts > m.ts) j--;
  list.splice(j, 0, m);
}

/** Change every copy of a message the client holds. */
export function patchMessage(id: string, patch: (m: P.MessageView) => P.MessageView) {
  for (const t of timelines.values()) {
    const i = t.messages.findIndex((x) => x.id === id);
    if (i >= 0) t.messages[i] = patch(t.messages[i]);
  }
  const q = quoted.get(id);
  if (q) quoted.set(id, patch(q));
  rev.value++;
}

export function applyEvents(events: P.ClientEvent[]) {
  let threadsDirty = false;
  for (const ev of events) {
    switch (ev.t) {
      case 'account':
        db.accounts.set(ev.account.id, ev.account);
        break;
      case 'account.removed':
        db.accounts.delete(ev.id);
        break;
      case 'identity':
        putIdentity(ev.identity);
        break;
      case 'person':
        db.persons.set(ev.person.id, ev.person);
        break;
      case 'person.removed':
        db.persons.delete(ev.id);
        break;
      case 'space': {
        db.spaces.set(ev.space.id, ev.space);
        for (const e of [...(db.children.get(ev.space.id) ?? [])]) if (e.childKind === 'space') removeEdge(ev.space.id, e.childId);
        for (const e of [...(db.parents.get(ev.space.id) ?? [])]) removeEdge(e.parentId, ev.space.id);
        ev.edges.forEach(addEdge);
        break;
      }
      case 'space.removed':
        db.spaces.delete(ev.id);
        break;
      case 'conversation': {
        const c = ev.conversation;
        const prev = db.conversations.get(c.id);
        db.conversations.set(c.id, c);
        if (prev?.parentId !== c.parentId || !prev) threadsDirty = true;
        for (const e of [...(db.parents.get(c.id) ?? [])]) if (!c.spaceIds.includes(e.parentId)) removeEdge(e.parentId, c.id);
        for (const sid of c.spaceIds)
          if (!(db.parents.get(c.id) ?? []).some((e) => e.parentId === sid)) addEdge({ parentId: sid, childKind: 'conversation', childId: c.id, position: null });
        // A newer message we have not seen: refresh open timelines for it.
        const t = timelines.get('c:' + c.id);
        if (t && !t.detached && c.lastMessage && !t.messages.some((m) => m.id === c.lastMessage!.id) && !t.loading) refreshTimeline(t.key);
        break;
      }
      case 'readProgress':
        readProgress.value = ev;
        break;
      case 'conversation.removed':
        db.conversations.delete(ev.id);
        threadsDirty = true;
        break;
      case 'message': {
        ev.identities.forEach(putIdentity);
        const m = ev.message;
        const t = timelines.get('c:' + m.conversationId);
        // A detached window only takes updates to what it holds: a new message would leave a silent gap.
        if (t && (!t.detached || t.messages.some((x) => x.id === m.id))) upsertInto(t.messages, m);
        const conv = db.conversations.get(m.conversationId);
        if (conv?.shape === 'direct' && conv.peerPersonId) {
          const pt = timelines.get('p:' + conv.peerPersonId);
          if (pt) upsertInto(pt.messages, m);
        }
        if (quoted.has(m.id)) quoted.set(m.id, m);
        if (m.triage && m.triage.decision !== 'silent') {
          const list = inbox.value.filter((x) => x.id !== m.id);
          inbox.value = [m, ...list].sort((a, b) => b.ts - a.ts).slice(0, 300);
        }
        // An echo of something we sent: drop the optimistic copy.
        if (pending.value.length) {
          const mine = isSelfIdentity(m.authorId);
          if (mine) pending.value = pending.value.filter((p) => !(p.conversationId === m.conversationId && (p.files?.length ? m.attachments.length > 0 : p.body.trim() === m.body.trim())));
        }
        break;
      }
      case 'message.deleted':
        break;
      case 'notify':
        onNotify(ev);
        break;
      case 'typing': {
        const cur = typing.value[ev.conversationId] ?? [];
        typing.value = {
          ...typing.value,
          [ev.conversationId]: [...cur.filter((x) => x.identityId !== ev.identityId && x.until > Date.now()), { identityId: ev.identityId, until: Date.now() + 6000 }],
        };
        break;
      }
      case 'folders':
        db.folders = ev.folders;
        break;
      case 'placePrefs':
        setPlacePrefs(ev.prefs);
        break;
      case 'categories':
        setCategories(ev.categories, ev.placeCategories);
        break;
      case 'rules':
        db.rules = ev.rules;
        break;
      case 'resync':
        bootstrap();
        break;
    }
  }
  if (threadsDirty) indexThreads();
  rev.value++;
}

export function isSelfIdentity(id: string | null | undefined): boolean {
  if (!id) return false;
  for (const a of db.accounts.values()) if (a.selfIdentityId === id) return true;
  const i = db.identities.get(id);
  return !!i?.personId && i.personId === db.selfPersonId;
}

// ------------------------------------------------------------------ notifications

function onNotify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
  const r = route.value;
  const viewing = !!ev.conversationId && 'conv' in r && r.conv === ev.conversationId && document.visibilityState === 'visible';
  if (viewing) return;
  toast({ kind: 'notify', title: ev.title, body: ev.body, conversationId: ev.conversationId, reasons: ev.reasons }, 8000);
  if (!prefs.value.pushEnabled && prefs.value.notifications && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const show = (reg?: ServiceWorkerRegistration) => {
      const opts = { body: ev.body, tag: ev.conversationId ?? 'dither-digest', data: { conversationId: ev.conversationId, inbox: !ev.conversationId } };
      if (reg) reg.showNotification(ev.title, opts);
      else new Notification(ev.title, opts).onclick = () => go({ view: 'inbox', conv: ev.conversationId });
    };
    // Not every browser has service workers, and none has them outside a secure context.
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(show, () => show());
    else show();
  }
}

// ------------------------------------------------------------------ timelines

export function timelineKey(kind: 'c' | 'p', id: string) {
  return `${kind}:${id}`;
}

export async function loadTimeline(key: string, older = false): Promise<void> {
  let t = timelines.get(key);
  if (t?.loading) return;
  if (t && !older) return;
  if (!t) {
    t = { key, messages: [], hasMore: true, loading: false };
    timelines.set(key, t);
  }
  if (older && !t.hasMore) return;
  t.loading = true;
  rev.value++;
  const [kind, id] = key.split(':') as ['c' | 'p', string];
  const before = older && t.messages.length ? t.messages[0].ts : undefined;
  const url = kind === 'c' ? `/api/conversations/${id}/messages` : `/api/persons/${id}/timeline`;
  try {
    const page = await api<P.MessagePage & { quoted?: P.MessageView[]; conversationIds?: string[] }>(`${url}?limit=60${before ? `&before=${before}` : ''}`);
    page.identities.forEach(putIdentity);
    page.quoted?.forEach((m) => quoted.set(m.id, m));
    for (const m of page.messages) upsertInto(t.messages, m);
    t.hasMore = page.hasMore;
    if (page.conversationIds) t.conversationIds = page.conversationIds;
    if (kind === 'c' && older) {
      // Stored messages ran out, which is not the start of the conversation: Discord and Matrix can backfill.
      if (!page.hasMore) t.hasMore = await fromNetwork(t, id, t.messages[0]?.ts);
    } else if (kind === 'c') {
      // Large Discord servers push live messages only for channels open in the client, so what is stored may be
      // stale: ask for the latest on open. Show what we have meanwhile, unless that is nothing.
      if (page.messages.length) {
        t.hasMore = true;
        void fromNetwork(t, id).then(() => rev.value++);
      } else t.hasMore = await fromNetwork(t, id);
    }
  } finally {
    t.loading = false;
    rev.value++;
  }
}

/** Ask the conversation's network for messages, then show what the hub stored. Returns whether there may be older ones. */
async function fromNetwork(t: Timeline, conversationId: string, beforeTs?: number): Promise<boolean> {
  const r = await api<{ count?: number; done?: boolean }>(`/api/conversations/${conversationId}/history`, { body: { beforeTs, limit: 50 } }).catch(() => null);
  if (!r?.count) return false;
  const page = await api<P.MessagePage>(`/api/conversations/${conversationId}/messages?limit=60${beforeTs ? `&before=${beforeTs}` : ''}`).catch(() => null);
  page?.identities.forEach(putIdentity);
  for (const m of page?.messages ?? []) upsertInto(t.messages, m);
  return !r.done;
}

/** Make sure a message is loaded, replacing the window around it if it is not. */
export async function jumpTo(conversationId: string, messageId: string) {
  const key = timelineKey('c', conversationId);
  if (timelines.get(key)?.messages.some((m) => m.id === messageId)) return;
  const page = await api<P.MessageContext>(`/api/messages/${messageId}/context`).catch(() => null);
  if (!page) return toast({ kind: 'error', title: 'Message not found', body: 'It may have been deleted.' });
  page.identities.forEach(putIdentity);
  timelines.set(key, { key, messages: page.messages, hasMore: page.hasMore, loading: false, detached: page.hasNewer });
  rev.value++;
}

export async function loadNewer(key: string) {
  const t = timelines.get(key);
  const lastTs = t?.messages[t.messages.length - 1]?.ts;
  if (!t?.detached || t.loading || lastTs === undefined) return;
  t.loading = true;
  const id = key.slice(2);
  try {
    const page = await api<P.MessagePage>(`/api/conversations/${id}/messages?after=${lastTs}&limit=60`);
    page.identities.forEach(putIdentity);
    for (const m of page.messages) upsertInto(t.messages, m);
    t.detached = page.hasMore;
  } finally {
    t.loading = false;
    rev.value++;
  }
}

/** Back to the live end of a conversation. */
export function toLatest(key: string) {
  timelines.delete(key);
  return loadTimeline(key);
}

/** Open a conversation at a message. */
export function openMessage(conversationId: string, messageId: string) {
  const r = route.value;
  go(r.view === 'search' ? { view: 'search', q: r.q, conv: conversationId, msg: messageId } : { view: 'inbox', conv: conversationId, msg: messageId });
}

function refreshTimeline(key: string) {
  const t = timelines.get(key);
  if (!t) return;
  timelines.delete(key);
  loadTimeline(key).then(() => {
    const fresh = timelines.get(key);
    if (fresh) for (const m of t.messages) if (!fresh.messages.some((x) => x.id === m.id)) upsertInto(fresh.messages, m);
    rev.value++;
  });
}

export async function loadInbox() {
  const page = await api<P.InboxPage>('/api/inbox');
  page.identities.forEach(putIdentity);
  inbox.value = page.items.map((i) => i.message);
  // What pinged you is counted from the inbox, behind a memo keyed on rev.
  rev.value++;
}

// ------------------------------------------------------------------ actions

async function upload(file: File): Promise<P.UploadView> {
  const res = await fetch('/api/uploads', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function send(conversationId: string, body: string, opts: { accountId?: string; replyTo?: string; files?: File[] } = {}) {
  const tempId = 'tmp-' + Math.random().toString(36).slice(2);
  const p: PendingSend = { tempId, conversationId, body, ts: Date.now(), accountId: opts.accountId, files: opts.files?.map((f) => f.name) };
  pending.value = [...pending.value, p];
  try {
    const attachments = opts.files?.length ? (await Promise.all(opts.files.map(upload))).map((u) => u.id) : undefined;
    await api(`/api/conversations/${conversationId}/send`, { body: { body, accountId: opts.accountId, replyTo: opts.replyTo, attachments } });
    setTimeout(() => (pending.value = pending.value.filter((x) => x.tempId !== tempId)), 30_000);
  } catch (e: any) {
    pending.value = pending.value.map((x) => (x.tempId === tempId ? { ...x, failed: e.message } : x));
  }
}

/** The dialog for starting a direct conversation; open at a known identity when given one. */
export const newMessage = signal<{ identityId?: string } | null>(null);

export async function openDirect(accountId: string, peer: string): Promise<P.OpenedDirect> {
  const r = await api<P.OpenedDirect>('/api/directs', { body: { accountId, peer } });
  if (r.conversation) applyEvents([{ t: 'conversation', conversation: r.conversation }]);
  return r;
}

/** Whoever this identity is, as far as the hub knows. */
export function openProfile(identityId: string | null | undefined) {
  if (!identityId) return;
  const personId = db.identities.get(identityId)?.personId;
  go(personId ? { view: 'profile', person: personId } : { view: 'profile', identity: identityId });
}

/** The message the composer is rewriting. */
export const editing = signal<P.MessageView | null>(null);

function ownAccount(m: P.MessageView) {
  return [...db.accounts.values()].find((a) => a.selfIdentityId === m.authorId);
}
export const canEdit = (m: P.MessageView) => !m.deleted && m.kind !== 'system' && !!ownAccount(m)?.capabilities.includes('edit');
export const canDelete = (m: P.MessageView) => !m.deleted && !!ownAccount(m)?.capabilities.includes('redact');

export function startEditing(m: P.MessageView) {
  const r = route.value;
  if (!('conv' in r) || r.conv !== m.conversationId) go({ view: 'inbox', conv: m.conversationId });
  editing.value = m;
}
export const editMessage = (m: P.MessageView, body: string) =>
  api(`/api/messages/${m.id}/edit`, { body: { body } }).catch((e) => toast({ kind: 'error', title: 'Could not edit', body: e.message }));
export function deleteMessage(m: P.MessageView) {
  if (!confirm('Delete this message for everyone? This goes to the network and cannot be undone.')) return;
  api(`/api/messages/${m.id}/delete`, { body: {} }).catch((e) => toast({ kind: 'error', title: 'Could not delete', body: e.message }));
}

export const readProgress = signal<{ pending: number; failed: number }>({ pending: 0, failed: 0 });

/** Clears here at once; the hub tells the networks at a pace they accept (readqueue.ts). */
export function markAllRead(convs: P.ConversationView[], where: string) {
  const ids = convs.filter((c) => c.vantages.some((v) => v.unread || v.mentions)).map((c) => c.id);
  if (!ids.length) return toast({ kind: 'info', title: 'Nothing unread', body: where });
  if (!confirm(`Mark ${ids.length} conversation${ids.length === 1 ? '' : 's'} read in ${where}? This also goes to the networks, and read state cannot be taken back.`)) return;
  api<{ marked: number; pending: number }>('/api/read-all', { body: { conversations: ids } })
    .then((r) => (readProgress.value = { pending: r.pending, failed: 0 }))
    .catch((e) => toast({ kind: 'error', title: 'Could not mark read', body: e.message }));
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function markRead(conversationId: string) {
  const c = db.conversations.get(conversationId);
  if (!c || !c.vantages.some((v) => v.unread || v.mentions)) return;
  // Read here means the notification on this device has done its job.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then((reg) => reg?.getNotifications({ tag: conversationId })).then((ns) => ns?.forEach((n) => n.close())).catch(() => {});
  clearTimeout(readTimers.get(conversationId));
  readTimers.set(
    conversationId,
    setTimeout(() => api(`/api/conversations/${conversationId}/read`, { body: {} }).catch(() => {}), 600),
  );
}

export const feedback = (messageId: string, fb: P.TriageView['feedback']) => api(`/api/messages/${messageId}/feedback`, { body: { feedback: fb } });
export const setRule = (scope: P.NotifyScope, target: string | null, level: P.NotifyLevel | null) => api('/api/rules', { method: 'PUT', body: { scope, target, level } });
/** Shown at once; the hub's event confirms it, and a failure resyncs. */
export function saveFolders(folders: P.FolderView[]) {
  db.folders = folders;
  rev.value++;
  return api('/api/folders', { method: 'PUT', body: { folders } }).catch(placeFailed);
}
export function patchPlaces(items: P.PlacePrefPatch[]) {
  for (const i of items) {
    const k = prefKey(i.kind, i.id);
    const cur = db.placePrefs.get(k) ?? { kind: i.kind, id: i.id, position: null, pinned: false, hidden: false, open: false, railed: false };
    db.placePrefs.set(k, { ...cur, ...i });
  }
  rev.value++;
  return api('/api/place-prefs', { method: 'PATCH', body: { items } }).catch(placeFailed);
}
function placeFailed(e: Error) {
  toast({ kind: 'error', title: 'Could not save that', body: e.message });
  bootstrap().catch(() => {});
}

// ------------------------------------------------------------------ live connection

let ws: WebSocket | null = null;
let backoff = 500;
let retry: ReturnType<typeof setTimeout> | undefined;

/** Pull to refresh: reconnect now if the socket is down, else load everything again. */
export async function refresh() {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    clearTimeout(retry);
    backoff = 500;
    connect();
    return;
  }
  await bootstrap();
}

async function bootstrap() {
  const b = await api<P.Bootstrap>('/api/bootstrap');
  applyBootstrap(b);
  loadInbox().catch(() => {});
  // Re-fetch open timelines after a reconnect.
  for (const key of [...timelines.keys()]) refreshTimeline(key);
}

export function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    connected.value = true;
    backoff = 500;
    bootstrap().catch((e) => toast({ kind: 'error', title: 'Could not load', body: String(e.message) }));
  };
  ws.onmessage = (e) => {
    try {
      applyEvents(JSON.parse(String(e.data)));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = () => {
    connected.value = false;
    retry = setTimeout(connect, (backoff = Math.min(backoff * 2, 15_000)));
  };
}
