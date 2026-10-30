import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';

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
  rules: [] as P.RuleView[],
  /** parentId -> child edges */
  children: new Map<string, P.SpaceEdgeView[]>(),
  /** child space or conversation id -> parent edges */
  parents: new Map<string, P.SpaceEdgeView[]>(),
  /** conversation id -> its threads */
  threads: new Map<string, string[]>(),
  identityByNative: new Map<string, string>(),
};

export interface Timeline {
  key: string;
  messages: P.MessageView[];
  hasMore: boolean;
  loading: boolean;
  /** person timelines: the direct conversations merged into it */
  conversationIds?: string[];
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

export interface Prefs {
  theme: 'dark' | 'light' | 'system';
  details: boolean;
  showDemo: boolean;
  collapsed: Record<string, boolean>;
  sendAs: Record<string, string>;
  via: Record<string, string>;
  notifications: boolean;
}
const PREFS_KEY = 'dither-chat:prefs';
const defaults: Prefs = { theme: 'dark', details: false, showDemo: true, collapsed: {}, sendAs: {}, via: {}, notifications: false };
export const prefs = signal<Prefs>({ ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') });
export function setPrefs(p: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...p };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
}

// ------------------------------------------------------------------ routing

export type Route =
  | { view: 'inbox'; conv?: string }
  | { view: 'people'; person?: string }
  | { view: 'groups'; conv?: string }
  | { view: 'spaces' }
  | { view: 'space'; space: string; conv?: string }
  | { view: 'folder'; folder: string; conv?: string; person?: string }
  | { view: 'accounts'; account?: string }
  | { view: 'settings' }
  | { view: 'search'; q: string; conv?: string };

export function parseHash(h = location.hash): Route {
  const [path, query] = h.replace(/^#\/?/, '').split('?');
  const p = path.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query ?? '');
  switch (p[0]) {
    case 'people':
      return { view: 'people', person: p[1] };
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
    case 'search':
      return { view: 'search', q: q.get('q') ?? '', conv: p[1] === 'c' ? p[2] : undefined };
    case 'c':
      return { view: 'inbox', conv: p[1] };
    default:
      return { view: 'inbox', conv: p[1] === 'c' ? p[2] : undefined };
  }
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.view) {
    case 'inbox':
      return r.conv ? `#/inbox/c/${e(r.conv)}` : '#/inbox';
    case 'people':
      return r.person ? `#/people/${e(r.person)}` : '#/people';
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
    case 'search':
      return `#/search${r.conv ? `/c/${e(r.conv)}` : ''}?q=${e(r.q)}`;
  }
}

export const route = signal<Route>(parseHash());
window.addEventListener('hashchange', () => (route.value = parseHash()));
export function go(r: Route, replace = false) {
  const h = href(r);
  if (replace) history.replaceState(null, '', h);
  else location.hash = h;
  route.value = parseHash(h);
}

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

export function applyBootstrap(b: P.Bootstrap) {
  db.selfPersonId = b.selfPersonId;
  db.accounts = new Map(b.accounts.map((a) => [a.id, a]));
  db.persons = new Map(b.persons.map((p) => [p.id, p]));
  db.identities.clear();
  db.identityByNative.clear();
  b.identities.forEach(putIdentity);
  db.spaces = new Map(b.spaces.map((s) => [s.id, s]));
  db.conversations = new Map(b.conversations.map((c) => [c.id, c]));
  db.folders = b.folders;
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
        if (t && c.lastMessage && !t.messages.some((m) => m.id === c.lastMessage!.id) && !t.loading) refreshTimeline(t.key);
        break;
      }
      case 'conversation.removed':
        db.conversations.delete(ev.id);
        threadsDirty = true;
        break;
      case 'message': {
        ev.identities.forEach(putIdentity);
        const m = ev.message;
        const t = timelines.get('c:' + m.conversationId);
        if (t) upsertInto(t.messages, m);
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
          if (mine) pending.value = pending.value.filter((p) => !(p.conversationId === m.conversationId && p.body.trim() === m.body.trim()));
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
  const viewing = 'conv' in r && r.conv === ev.conversationId && document.visibilityState === 'visible';
  if (viewing) return;
  toast({ kind: 'notify', title: ev.title, body: ev.body, conversationId: ev.conversationId, reasons: ev.reasons }, 8000);
  if (prefs.value.notifications && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const show = (reg?: ServiceWorkerRegistration) => {
      const opts = { body: ev.body, tag: ev.conversationId, data: { conversationId: ev.conversationId } };
      if (reg) reg.showNotification(ev.title, opts);
      else new Notification(ev.title, opts).onclick = () => go({ view: 'inbox', conv: ev.conversationId });
    };
    navigator.serviceWorker?.getRegistration().then(show, () => show());
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
}

// ------------------------------------------------------------------ actions

export async function send(conversationId: string, body: string, opts: { accountId?: string; replyTo?: string } = {}) {
  const tempId = 'tmp-' + Math.random().toString(36).slice(2);
  const p: PendingSend = { tempId, conversationId, body, ts: Date.now(), accountId: opts.accountId };
  pending.value = [...pending.value, p];
  try {
    await api(`/api/conversations/${conversationId}/send`, { body: { body, accountId: opts.accountId, replyTo: opts.replyTo } });
    setTimeout(() => (pending.value = pending.value.filter((x) => x.tempId !== tempId)), 30_000);
  } catch (e: any) {
    pending.value = pending.value.map((x) => (x.tempId === tempId ? { ...x, failed: e.message } : x));
  }
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function markRead(conversationId: string) {
  const c = db.conversations.get(conversationId);
  if (!c || !c.vantages.some((v) => v.unread || v.mentions)) return;
  clearTimeout(readTimers.get(conversationId));
  readTimers.set(
    conversationId,
    setTimeout(() => api(`/api/conversations/${conversationId}/read`, { body: {} }).catch(() => {}), 600),
  );
}

export const react = (messageId: string, key: string, remove = false) => api(`/api/messages/${messageId}/react`, { body: { key, remove } });
export const feedback = (messageId: string, fb: P.TriageView['feedback']) => api(`/api/messages/${messageId}/feedback`, { body: { feedback: fb } });
export const setRule = (scope: P.NotifyScope, target: string | null, level: P.NotifyLevel | null) => api('/api/rules', { method: 'PUT', body: { scope, target, level } });
export const saveFolders = (folders: P.FolderView[]) => api('/api/folders', { method: 'PUT', body: { folders } });

// ------------------------------------------------------------------ live connection

let ws: WebSocket | null = null;
let backoff = 500;
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
    setTimeout(connect, (backoff = Math.min(backoff * 2, 15_000)));
  };
}
