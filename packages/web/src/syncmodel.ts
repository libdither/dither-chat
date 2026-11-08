/**
 * The client's copy of the hub's state (`db` in state.ts), and how a bootstrap or a live event changes it. Pure: no
 * signals, no DOM, no network, so the hub's tests can check that a client applying deltas ends up where a fresh
 * bootstrap would put it (packages/hub/test/sync.test.ts, docs/sync.md).
 *
 * Timelines, the inbox, notifications and pending sends are state.ts's: they react to events but are not this.
 */
import type * as P from '@dither-chat/protocol';
import { applyMailBootstrap, applyMailEvent, emptyMail } from './mail/model.ts';

export function emptyDb() {
  return {
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
    /** Set when the hub's accounts run in dither-accounts: its page, if the hub knows where. */
    accountsManager: null as { url: string | null } | null,
    rules: [] as P.RuleView[],
    /** Devices and their own notification rules (docs/devices.md). */
    devices: [] as P.DeviceView[],
    /** parentId -> child edges */
    children: new Map<string, P.SpaceEdgeView[]>(),
    /** child space or conversation id -> parent edges */
    parents: new Map<string, P.SpaceEdgeView[]>(),
    /** conversation id -> its threads */
    threads: new Map<string, string[]>(),
    identityByNative: new Map<string, string>(),
    reactionUsage: [] as P.ReactionUsage[],
    /** The hub's inbox ranking, by conversation (docs/inbox.md). */
    attention: new Map<string, P.AttentionView>(),
    /** Where in the hub's change journal this copy stands (docs/sync.md). Null: nowhere a delta can start from. */
    sync: null as P.SyncPosition | null,
    /** Mail (mail/model.ts, docs/mail.md). */
    mail: emptyMail(),
  };
}
export type Db = ReturnType<typeof emptyDb>;

export function indexEdges(db: Db, edges: P.SpaceEdgeView[]) {
  db.children.clear();
  db.parents.clear();
  for (const e of edges) addEdge(db, e);
}

export function addEdge(db: Db, e: P.SpaceEdgeView) {
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

export function removeEdge(db: Db, parentId: string, childId: string) {
  const c = (db.children.get(parentId) ?? []).filter((e) => e.childId !== childId);
  if (c.length) db.children.set(parentId, c);
  else db.children.delete(parentId);
  const p = (db.parents.get(childId) ?? []).filter((e) => e.parentId !== parentId);
  if (p.length) db.parents.set(childId, p);
  else db.parents.delete(childId);
}

/** A space or conversation that is gone takes its edges, both ways, with it. */
function dropEdgesOf(db: Db, id: string) {
  for (const e of [...(db.children.get(id) ?? [])]) removeEdge(db, id, e.childId);
  for (const e of [...(db.parents.get(id) ?? [])]) removeEdge(db, e.parentId, id);
}

export function indexThreads(db: Db) {
  db.threads.clear();
  for (const c of db.conversations.values()) {
    if (c.parentId) db.threads.set(c.parentId, [...(db.threads.get(c.parentId) ?? []), c.id]);
  }
}

let identityEdits = 0;
/** How many times an identity was added or changed: events repeat identities, and an unchanged one is no change. */
export const identityVersion = () => identityEdits;

/** Keeps the object it has when nothing in it changed. Returns whether something did. */
export function putIdentity(db: Db, i: P.IdentityView): boolean {
  db.identityByNative.set(`${i.network}:${i.nativeId}`, i.id);
  const old = db.identities.get(i.id);
  if (old && (old === i || JSON.stringify(old) === JSON.stringify(i))) return false;
  db.identities.set(i.id, i);
  identityEdits++;
  return true;
}

/**
 * Whether a conversation's new copy changes more than its last message and read state: its name, its place, its
 * settings. Those are what other things show of it (docs/perf.md).
 */
export function conversationMetaChanged(prev: P.ConversationView | undefined, next: P.ConversationView): boolean {
  if (!prev) return true;
  for (const k of Object.keys(next) as (keyof P.ConversationView)[]) {
    if (k === 'lastMessage' || k === 'lastMessageAt') continue;
    if (k === 'vantages') {
      if (prev.vantages.length !== next.vantages.length || prev.vantages.some((v, i) => v.accountId !== next.vantages[i].accountId)) return true;
      continue;
    }
    const a = prev[k];
    const b = next[k];
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) return true;
  }
  return Object.keys(prev).length !== Object.keys(next).length;
}

export const prefKey = (kind: P.PlaceKind, id: string) => `${kind}:${id}`;

export function setPlacePrefs(db: Db, prefs: P.PlacePrefView[]) {
  db.placePrefs = new Map(prefs.map((x) => [prefKey(x.kind, x.id), x]));
}

export function setCategories(db: Db, cats: P.CategoryView[], place: P.PlaceCategoryView[]) {
  db.categories = cats;
  db.placeCategories = new Map();
  for (const x of place) {
    const k = `${x.kind}:${x.id}`;
    db.placeCategories.set(k, [...(db.placeCategories.get(k) ?? []), x]);
  }
}

export function applyBootstrapTo(db: Db, b: P.Bootstrap) {
  db.selfPersonId = b.selfPersonId;
  db.reactionUsage = b.reactionUsage ?? [];
  db.accounts = new Map(b.accounts.map((a) => [a.id, a]));
  db.persons = new Map(b.persons.map((p) => [p.id, p]));
  db.identities.clear();
  db.identityByNative.clear();
  for (const i of b.identities) putIdentity(db, i);
  db.spaces = new Map(b.spaces.map((s) => [s.id, s]));
  db.conversations = new Map(b.conversations.map((c) => [c.id, c]));
  db.folders = b.folders;
  setPlacePrefs(db, b.placePrefs ?? []);
  setCategories(db, b.categories ?? [], b.placeCategories ?? []);
  db.categoryProvider = b.categoryProvider ?? 'keyword';
  db.accountsManager = b.accountsManager ?? null;
  db.rules = b.rules;
  db.devices = b.devices ?? [];
  db.attention = new Map((b.attention ?? []).map((a) => [a.id, a]));
  db.sync = b.sync ?? null;
  applyMailBootstrap(db.mail, b.mail);
  indexEdges(db, b.edges);
  indexThreads(db);
}

/** What one event changes in `db`. Returns true when threads need indexing again (indexThreads). */
export function applyEventTo(db: Db, ev: P.ClientEvent): boolean {
  if (applyMailEvent(db.mail, ev)) return false;
  switch (ev.t) {
    case 'account':
      db.accounts.set(ev.account.id, ev.account);
      return false;
    case 'account.removed':
      db.accounts.delete(ev.id);
      return false;
    case 'identity':
      putIdentity(db, ev.identity);
      return false;
    case 'person':
      db.persons.set(ev.person.id, ev.person);
      if (ev.person.isSelf) db.selfPersonId = ev.person.id;
      return false;
    case 'person.removed':
      db.persons.delete(ev.id);
      if (db.selfPersonId === ev.id) db.selfPersonId = null;
      return false;
    case 'space': {
      db.spaces.set(ev.space.id, ev.space);
      for (const e of [...(db.children.get(ev.space.id) ?? [])]) if (e.childKind === 'space') removeEdge(db, ev.space.id, e.childId);
      for (const e of [...(db.parents.get(ev.space.id) ?? [])]) removeEdge(db, e.parentId, ev.space.id);
      for (const e of ev.edges) addEdge(db, e);
      return false;
    }
    case 'space.removed':
      db.spaces.delete(ev.id);
      dropEdgesOf(db, ev.id);
      return false;
    case 'conversation': {
      const c = ev.conversation;
      const prev = db.conversations.get(c.id);
      db.conversations.set(c.id, c);
      for (const e of [...(db.parents.get(c.id) ?? [])]) if (!c.spaceIds.includes(e.parentId)) removeEdge(db, e.parentId, c.id);
      for (const sid of c.spaceIds)
        if (!(db.parents.get(c.id) ?? []).some((e) => e.parentId === sid)) addEdge(db, { parentId: sid, childKind: 'conversation', childId: c.id, position: null });
      return !prev || prev.parentId !== c.parentId;
    }
    case 'conversation.removed':
      db.conversations.delete(ev.id);
      dropEdgesOf(db, ev.id);
      return true;
    case 'message':
      for (const i of ev.identities) putIdentity(db, i);
      return false;
    case 'folders':
      db.folders = ev.folders;
      return false;
    case 'placePrefs':
      setPlacePrefs(db, ev.prefs);
      return false;
    case 'categories':
      setCategories(db, ev.categories, ev.placeCategories);
      return false;
    case 'rules':
      db.rules = ev.rules;
      return false;
    case 'devices':
      db.devices = ev.devices;
      return false;
    case 'attention':
      if (ev.replace) db.attention.clear();
      for (const a of ev.items) db.attention.set(a.id, a);
      for (const id of ev.removed) db.attention.delete(id);
      return false;
    default:
      return false;
  }
}

/** A delta's fields beside its events. */
export function applySyncTo(db: Db, r: Extract<P.SyncResponse, { sync: unknown }>): boolean {
  if (r.selfPersonId !== undefined) db.selfPersonId = r.selfPersonId;
  if (r.categoryProvider !== undefined) db.categoryProvider = r.categoryProvider;
  if (r.accountsManager !== undefined) db.accountsManager = r.accountsManager;
  if (r.reactionUsage) db.reactionUsage = r.reactionUsage;
  for (const i of r.identities) putIdentity(db, i);
  let threads = false;
  for (const ev of r.events) threads = applyEventTo(db, ev) || threads;
  if (threads) indexThreads(db);
  db.sync = r.sync;
  return threads;
}

// ------------------------------------------------------------------ messages and usage

/** Put a message in a list kept in time order, replacing an older copy of it. */
export function upsertInto(list: P.MessageView[], m: P.MessageView) {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    list[i] = m;
    return;
  }
  let j = list.length;
  while (j > 0 && list[j - 1].ts > m.ts) j--;
  list.splice(j, 0, m);
}

export interface TimelineCopy {
  messages: P.MessageView[];
  hasMore: boolean;
  detached?: boolean;
  conversationIds?: string[];
}

/** What a sync answer says about one timeline: new and changed messages, or a fresh page to replace it. */
export function applyTimelineDelta(t: TimelineCopy, tl: P.SyncTimeline) {
  if (tl.replace) {
    t.messages = [...tl.messages];
    t.hasMore = tl.hasMore ?? true;
    t.detached = false;
  } else for (const m of tl.messages) upsertInto(t.messages, m);
  if (tl.conversationIds) t.conversationIds = tl.conversationIds;
}

export const INBOX_MAX = 300;

/** The inbox list, newest first, with these messages in it; a deleted or silenced one leaves. */
export function mergeInbox(list: P.MessageView[], ms: P.MessageView[]): P.MessageView[] {
  const ids = new Set(ms.map((m) => m.id));
  const out = list.filter((x) => !ids.has(x.id));
  for (const m of ms) if (!m.deleted && m.triage && m.triage.decision !== 'silent' && (m.triage.feedback ?? m.triage.decision) !== 'drop') out.push(m);
  return out.sort((a, b) => b.ts - a.ts).slice(0, INBOX_MAX);
}

/** The hub's usage totals after a `usage` or `arrange` event; the same object when the event is about neither. */
export function applyUsageEvent(s: P.UsageState, ev: P.ClientEvent): P.UsageState {
  if (ev.t === 'usage') {
    const m = new Map(ev.replace ? [] : s.places.map((u) => [`${u.kind}:${u.id}`, u] as const));
    for (const r of ev.removed) m.delete(`${r.kind}:${r.id}`);
    for (const u of ev.places) m.set(`${u.kind}:${u.id}`, u);
    return { ...s, places: [...m.values()] };
  }
  if (ev.t === 'arrange') return { ...s, arrange: ev.arrange };
  return s;
}
