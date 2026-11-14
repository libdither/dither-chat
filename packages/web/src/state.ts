import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, fileBatches, splitsFiles, SYNC_VERSION } from '@dither-chat/protocol';
import { leaveLayerEntry, takeOverLayers } from './phone.ts';
import { cachedTimeline, freshFromHub, persistSoon, touchTimeline } from './snapshot.ts';
import { applyBootstrapTo, applyEventTo, applySyncTo, applyTimelineDelta, conversationMetaChanged, emptyDb, identityVersion, indexThreads, mergeInbox as merged, prefKey, putIdentity as put, upsertInto } from './syncmodel.ts';
import { changed, mailChanged, timelineChanged, timelineRev } from './versions.ts';
import { applyTyping, type TypingState } from './typers.ts';
import { ECHO_SKEW, mayBeOut, openOutbox, settled, type Echo, type OutboxEntry, type SendMedia } from './outbox.ts';
import { hubTransport, UploadJob } from './upload.ts';
import { href, parseHash, type Route } from './routes.ts';
import { inboxFilterOf, type InboxFilter } from './ordering.ts';
import { applyPlanEvent, calendarAt, calendarFromBootstrap, loadPlans } from './plans.ts';
import { reportApiFailure } from './errors.ts';
import { applyCalls, applyVoice, loadCalls } from './ringing.ts';

// ------------------------------------------------------------------ data

/** What components read to re-render: `rev` for the lists, `metaRev` for names and settings, one per timeline (versions.ts). */
export { changed, dataVersion, mailRev, metaRev, rev, timelineChanged, timelineRev } from './versions.ts';
export const connected = signal(false);
/** Notices on this hub (docs/notices.md): whether it may read them; null when it has none. */
export const noticesBoot = signal<P.NoticesBoot | null>(null);
export const loaded = signal(false);

/** The hub's state as this client knows it; syncmodel.ts says how bootstraps and events change it. */
export const db = emptyDb();

export interface Timeline {
  key: string;
  messages: P.MessageView[];
  hasMore: boolean;
  loading: boolean;
  /** person timelines: the direct conversations merged into it */
  conversationIds?: string[];
  /** Jumped to an old message: this window does not reach the latest ones. */
  detached?: boolean;
  /** When its first page was asked of the hub. A reconnect catches up the ones that have it. */
  fetchedAt?: number;
  /** A copy kept on this device: the journal position it is current to, until the hub has caught it up. */
  from?: P.SyncPosition;
  /** Loaded for a glance (Catch up's cards) from what the hub stored: opening it asks the network, as a first open does. */
  glance?: boolean;
}
export const timelines = new Map<string, Timeline>();
/** Messages referenced by replies that are outside the loaded page. */
export const quoted = new Map<string, P.MessageView>();
export const inbox = signal<P.MessageView[]>([]);
/** How it sorts' mail (docs/mail.md): what triage decided on new mail this week, newest first. */
export const mailTriage = signal<P.MailTriageItem[]>([]);

/** The week's mail decisions afresh (asked when Catch up or How it sorts opens: a page resumed from its snapshot holds an older list). */
export async function loadMailTriage() {
  if (db.mail.access.state === 'off') return;
  const page = await api<P.MailTriagePage>('/api/mail/triage').catch(() => null);
  if (!page) return;
  mailTriage.value = page.items;
  changed('list');
}

/** Thread views carry their newest decision: the week's mail decisions follow them (new mail, a read, a mark elsewhere). */
function mergeMailTriage(threads: P.MailThreadView[]) {
  const fresh = threads.map((t) => t.triage).filter((x): x is P.MailTriageItem => !!x);
  if (!fresh.length) return;
  const by = new Map(mailTriage.value.map((x) => [x.id, x]));
  let moved = false;
  for (const x of fresh) {
    const was = by.get(x.id);
    if (was && was.unread === x.unread && !!was.triage.marks?.less === !!x.triage.marks?.less && was.triage.decision === x.triage.decision) continue;
    by.set(x.id, x);
    moved = true;
  }
  if (!moved) return;
  mailTriage.value = [...by.values()].sort((a, b) => b.ts - a.ts);
  changed('list');
}

export interface PendingSend {
  tempId: string;
  conversationId: string;
  body: string;
  ts: number;
  accountId?: string;
  failed?: string;
  files?: string[];
  /** Waiting for the hub to be reachable again; it goes out then, by itself. */
  queued?: boolean;
  /** Its files are still uploading (uploadsOf has their progress). */
  uploading?: boolean;
  /** The hub took it; the copy stays until its message is here (outbox.ts). */
  acked?: boolean;
  /** The hub's id for the message it became, when its answer (or its `sent` event) said. */
  messageId?: string;
  /** When it last went to the hub: from then on it may be out on the network. */
  postedAt?: number;
  /** Its message is here before the hub's answer: not shown, and gone when the answer comes. */
  echoed?: boolean;
}
export const pending = signal<PendingSend[]>([]);
/** Who is typing where, live only (typing.ts). */
export const typing = signal<TypingState>({});

export interface Toast {
  id: number;
  title: string;
  body: string;
  conversationId?: string;
  reasons?: string[];
  kind?: 'notify' | 'error' | 'info';
  /** A notification's sender picture (a hub media path) and network. */
  icon?: string;
  network?: P.Network;
  /** Where a tap goes, for a toast that is not about a conversation. */
  action?: () => void;
  /** What the tap does, shown on the toast ("Undo"). */
  actionLabel?: string;
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
  /** A theme id from themes.ts, or 'system' to follow the device with themeDark and themeLight. ('dark' and 'light' are older names for the Dither ones.) */
  theme: string;
  themeDark: string;
  themeLight: string;
  details: boolean;
  collapsed: Record<string, boolean>;
  sendAs: Record<string, string>;
  /** Person -> conversation: the route this browser kept before the hub kept routes (chats.ts); moved there once, then gone. */
  via: Record<string, string>;
  notifications: boolean;
  /** Index into the emoji catalog's skins; 0 is the default yellow. */
  skinTone: number;
  directorySort: DirectorySort;
  /** This device gets Web Push, so the live socket need not raise its own notification. */
  pushEnabled: boolean;
  /** How this device carries calls: through the account's own client (bridge), or by itself (direct). */
  callMode: 'bridge' | 'direct';
  /** This device's microphone in calls: noise suppression and sensitivity (Settings → Calls). Absent: CALL_INPUT_DEFAULT. */
  callInput?: import('@dither-chat/protocol').CallInput;
  /** The inbox's filter (its menu beside the search box). */
  inboxFilter: InboxFilter;
  /** People's filter chip: chats, or one kind of list (docs/add.md "Relationships"). */
  peopleFilter?: 'chats' | 'friend' | 'contact' | 'following';
  /** How People's friends, contacts and follows sort: when you last talked (the default), or by name. */
  peopleLinkSort?: 'recent' | 'az';
  /** This device counts which buttons are pressed (clicklog.ts, docs/button-counts.md). Off unless switched on here. */
  countClicks?: boolean;
}
export type { InboxFilter };
const PREFS_KEY = 'dither-chat:prefs';
const defaults: Prefs = { theme: 'dither-dark', themeDark: 'dither-dark', themeLight: 'dither-light', details: false, collapsed: {}, sendAs: {}, via: {}, notifications: false, skinTone: 0, directorySort: 'recency', pushEnabled: false, callMode: 'bridge', inboxFilter: 'all' };
function storedPrefs(): Prefs {
  const p = { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  // The chips before the filter menu: People became Direct messages, and Unread is the New section, under All.
  return { ...p, inboxFilter: inboxFilterOf(p.inboxFilter) };
}
export const prefs = signal<Prefs>(storedPrefs());
export function setPrefs(p: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...p };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
}

// ------------------------------------------------------------------ routing

export { href, parseHash, type Route };

export const route = signal<Route>(parseHash());
/** An old link (`#/groups/…`) shows its new address, in place. */
function canonicalHash() {
  const h = href(route.value);
  if (location.hash.startsWith('#/groups') && h !== location.hash) history.replaceState(history.state, '', h);
}
canonicalHash();
// The entry the app opened on. adoptEntry shapes it once the app has its data, as a page's list may need it.
if (history.state === null) history.replaceState({ prev: null, opened: true }, '');
window.addEventListener('hashchange', (e) => {
  // An address from outside go() (typed, or a script's) makes an entry with no state yet.
  if (history.state === null) adoptEntry(new URL(e.oldURL).hash || null);
  route.value = parseHash();
  canonicalHash();
});

let listUnder: (to: Route, from: Route | null) => Route | null = () => null;
/** Which list to write under a page in history, going there `from` a route: App says, from pages.ts, on a phone. */
export const setListUnder = (f: (to: Route, from: Route | null) => Route | null) => void (listUnder = f);
let fill: (r: Route) => Route = (r) => r;
/** What go() adds to a route before going: App fills in a server's last channel (lastchannel.ts). */
export const setRouteFill = (f: (r: Route) => Route) => void (fill = f);
/** Told of a list entry put under page `page`, which no route change announces (activity.ts keeps a trail of entries). */
export const listUnderHooks = new Set<(list: string, page: string) => void>();

/** Writes an entry for `h`, over the current one or after it, with the list it keeps under it first if it needs one. */
function write(h: string, prev: string | null, replace: boolean, from: Route | null) {
  const list = listUnder(parseHash(h), from);
  const under = list && href(list);
  if (under) {
    if (replace) history.replaceState({ prev }, '', under);
    else history.pushState({ prev }, '', under);
    for (const f of listUnderHooks) f(under, h);
    history.pushState({ prev: under }, '', h);
  } else if (replace) history.replaceState({ prev }, '', h);
  else history.pushState({ prev }, '', h);
}

/**
 * Each entry remembers the one before it, so a back button can tell going back from opening the list fresh.
 * Navigating closes any open sheet or panel, and takes over its history entry rather than stacking on it. On a
 * phone a list's page goes on top of that list, so back from it, by any way, shows the list (pages.ts).
 */
export function go(r: Route, replace = false) {
  r = fill(r);
  const h = href(r);
  const layered = takeOverLayers();
  if (h === location.hash && !replace) {
    if (layered) leaveLayerEntry();
    return void (route.value = parseHash(h));
  }
  if (replace) history.replaceState({ prev: history.state?.prev ?? null }, '', h);
  else write(h, location.hash, layered, parseHash());
  route.value = parseHash(h);
}

/**
 * An entry made outside go(): the one the app opened on (from a link or a notification), or one an address typed
 * in made. It gets what go() would have written: the entry before it remembered, and a page's list under it.
 */
export function adoptEntry(prev: string | null = null) {
  if (history.state !== null && !history.state.opened) return;
  write(location.hash, prev, true, null);
}

/** Back where you came from, or to `fallback` when this page was opened directly. */
export function back(fallback: Route) {
  if (history.state?.prev) history.back();
  else go(fallback, true);
}

/** The route a back press would land on, when it is known. */
export const previousRoute = (): Route | null => (history.state?.prev ? parseHash(history.state.prev) : null);

// ------------------------------------------------------------------ http

/** Told of every call before it goes out: the activity log counts sends, reactions and reads from these (activity.ts). */
export const apiHooks = new Set<(path: string, init?: { method?: string; body?: unknown }) => void>();

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  for (const h of apiHooks) h(path, init);
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    });
  } catch (e) {
    // The hub not reached (not an abort, not while offline): to traces/errors.ndjson (errors.ts).
    reportApiFailure(method, path, e);
    throw e;
  }
  const text = await res.text();
  // Not everything here is JSON: the account log and the access gate's refusals are plain text.
  const json = res.headers.get('content-type')?.includes('json');
  const data = json && text ? JSON.parse(text) : text || null;
  if (!res.ok) {
    const e = Object.assign(new Error(data?.error ?? (text.slice(0, 200) || `${res.status}`)), { status: res.status });
    if (res.status >= 500) reportApiFailure(method, path, e, res.status);
    throw e;
  }
  return data as T;
}

// ------------------------------------------------------------------ applying hub data

const putIdentity = (i: P.IdentityView) => void (put(db, i) && changed('shown'));

export function applyBootstrap(b: P.Bootstrap) {
  applyBootstrapTo(db, b);
  // A calendar account on the hub (plans.ts, docs/calendar.md): its plans once the socket is up (now, if it is).
  if (calendarFromBootstrap(b) && ws?.readyState === WebSocket.OPEN) void loadPlans();
  noticesBoot.value = b.notices ?? null;
  loaded.value = true;
  changed('meta');
  mailChanged();
}

/** Change every copy of a message the client holds. */
export function patchMessage(id: string, patch: (m: P.MessageView) => P.MessageView) {
  for (const t of timelines.values()) {
    const i = t.messages.findIndex((x) => x.id === id);
    if (i >= 0) {
      t.messages[i] = patch(t.messages[i]);
      timelineChanged(t.key);
    }
  }
  const q = quoted.get(id);
  if (q) {
    quoted.set(id, patch(q));
    timelineChanged();
  }
}

/** Events that change nothing in `db`: typing, toasts and read progress have signals of their own. */
const NOT_DB = new Set<P.ClientEvent['t']>(['typing', 'notify', 'sync', 'readProgress', 'resync', 'sent', 'plans', 'calendar']);
/** Events that change what lists show but no names or settings: `metaRev` stays. */
const LIST_ONLY = new Set<P.ClientEvent['t']>(['message', 'message.deleted', 'identity', 'attention', 'usage', 'arrange', 'requests', 'accountsManager']);
/** Events that change names (`metaRev` moves) but not what is where (versions.ts `changed('shown')`): people. */
const SHOWN_ONLY = new Set<P.ClientEvent['t']>(['person', 'person.removed']);

/** Others react to events too (usage.ts: time spent in places, sort settings), without state.ts knowing them. */
export const eventHooks = new Set<(ev: P.ClientEvent) => void>();

export function applyEvents(events: P.ClientEvent[]) {
  let threadsDirty = false;
  const behind = new Set<string>();
  const regrouped = new Set<string>();
  const ids = identityVersion();
  let list = false;
  let meta = false;
  let shown = false;
  let mail = false;
  for (const ev of events) {
    // Mail has its own signal: chat's lists do not draw again for it.
    if (ev.t.startsWith('mail.')) mail = true;
    else if (!NOT_DB.has(ev.t)) {
      list = true;
      // What only moves a conversation's last message and counts, or the inbox's order, leaves names alone. An
      // identity that changed moves them (identityVersion, below).
      if (ev.t === 'conversation') meta ||= conversationMetaChanged(db.conversations.get(ev.conversation.id), ev.conversation);
      // An account already here changing its status or name: the set of accounts, which decides what is shown, stays.
      else if (SHOWN_ONLY.has(ev.t) || (ev.t === 'account' && db.accounts.has(ev.account.id))) shown = true;
      else if (!LIST_ONLY.has(ev.t)) meta = true;
    }
    threadsDirty = applyEventTo(db, ev) || threadsDirty;
    switch (ev.t) {
      case 'person':
      case 'person.removed': {
        // People merged or split: a person timeline may now span other conversations.
        const key = 'p:' + (ev.t === 'person' ? ev.person.id : ev.id);
        if (timelines.has(key)) regrouped.add(key);
        break;
      }
      case 'conversation': {
        // A newer message this timeline has not seen: once the frame is applied, it may still be missing.
        const t = timelines.get('c:' + ev.conversation.id);
        if (t && !t.detached && ev.conversation.lastMessage) behind.add(t.key);
        break;
      }
      case 'readProgress':
        readProgress.value = ev;
        break;
      case 'message': {
        const m = ev.message;
        const t = timelines.get('c:' + m.conversationId);
        // A detached window only takes updates to what it holds: a new message would leave a silent gap.
        if (t && (!t.detached || t.messages.some((x) => x.id === m.id))) {
          upsertInto(t.messages, m);
          timelineChanged(t.key);
        }
        const conv = db.conversations.get(m.conversationId);
        if (conv?.shape === 'direct' && conv.peerPersonId) {
          const pt = timelines.get('p:' + conv.peerPersonId);
          if (pt) {
            upsertInto(pt.messages, m);
            timelineChanged(pt.key);
          }
        }
        if (quoted.has(m.id)) {
          quoted.set(m.id, m);
          timelineChanged();
        }
        if (m.triage && m.triage.decision !== 'silent' && m.triage.decision !== 'drop') mergeInbox([m]);
        // Perhaps the message a pending copy became: matched below, once the frame is applied.
        if (pending.value.length && isSelfIdentity(m.authorId)) noteEcho(m);
        break;
      }
      case 'notify':
        onNotify(ev);
        break;
      case 'mail.threads':
        mergeMailTriage(ev.threads);
        break;
      case 'typing':
        typing.value = applyTyping(typing.value, ev, Date.now(), isSelfIdentity);
        break;
      // Calls ringing you and voice channels (ringing.ts).
      case 'calls':
        applyCalls(ev.calls);
        break;
      case 'voice':
        applyVoice(ev.channels);
        break;
      case 'sent': {
        // Which message a send of this page's became, ahead of the answer to its POST: settled below by id.
        const tempId = ev.clientId.replace(/~\d+$/, '');
        if (pending.value.some((p) => p.tempId === tempId && !p.messageId)) setPending(tempId, { messageId: ev.messageId });
        break;
      }
      case 'resync':
        void bootstrap();
        void loadPlans();
        break;
      // The calendar's plans and whether it answers (plans.ts): signals of their own, nothing in `db`.
      case 'plans':
      case 'calendar':
        // A calendar account that came (back): its plans too.
        if (applyPlanEvent(ev)) void loadPlans();
        break;
    }
    if (eventHooks.size) for (const h of eventHooks) h(ev);
  }
  if (threadsDirty) indexThreads(db);
  for (const key of behind) {
    const t = timelines.get(key);
    const last = db.conversations.get(key.slice(2))?.lastMessage;
    if (t && last && !t.loading && !t.messages.some((m) => m.id === last.id)) void catchUp(key);
  }
  for (const key of regrouped) if (!timelines.get(key)?.loading) void catchUp(key);
  settle();
  if (meta) changed('meta');
  else if (shown || identityVersion() !== ids) changed('shown');
  else if (list) changed('list');
  if (mail) mailChanged();
}

function mergeInbox(ms: P.MessageView[]) {
  if (!ms.length) return;
  inbox.value = merged(inbox.value, ms);
  changed('list');
}

export function isSelfIdentity(id: string | null | undefined): boolean {
  if (!id) return false;
  for (const a of db.accounts.values()) if (a.selfIdentityId === id) return true;
  const i = db.identities.get(id);
  return !!i?.personId && i.personId === db.selfPersonId;
}

// ------------------------------------------------------------------ notifications

/** Kept off this device by its own rules (docs/devices.md). The id is activity.ts's deviceId(), read here without importing it. */
export function quietHere(ev: { quiet?: string[] }): boolean {
  if (!ev.quiet?.length) return false;
  try {
    return ev.quiet.includes(localStorage.getItem('dither-chat:device') ?? '');
  } catch {
    return false;
  }
}

/**
 * Only an alert shows on a page, as a toast or a system notification. A Conversation or a list row is a silent
 * notification on a phone (the hub sends it there): here its message only moves the lists and the badges.
 */
export const showsHere = (ev: Extract<P.ClientEvent, { t: 'notify' }>) => (!ev.level || ev.level === 'push') && !quietHere(ev);

function onNotify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
  if (!showsHere(ev)) return;
  const r = route.value;
  const here = (!!ev.conversationId && 'conv' in r && r.conv === ev.conversationId) || (!!ev.mailThreadId && r.view === 'mail' && r.thread === ev.mailThreadId) || (!!ev.noticeId && r.view === 'notices');
  const viewing = here && document.visibilityState === 'visible';
  if (viewing) return;
  // A calendar reminder (docs/calendar.md) opens the calendar where it is.
  const cal = ev.calendar;
  // A notice (docs/notices.md) opens under Notices; its conversation is its group, not a chat.
  const notice = ev.noticeId;
  const open = cal ? () => go({ view: 'calendar', at: calendarAt(cal.open) }) : notice ? () => go({ view: 'notices', notice }) : undefined;
  const conversationId = notice ? undefined : ev.conversationId;
  toast({ kind: 'notify', title: ev.title, body: ev.body, conversationId, reasons: ev.reasons, icon: ev.icon, network: ev.network, ...(open ? { action: open } : {}) }, 8000);
  if (!prefs.value.pushEnabled && prefs.value.notifications && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    // A group's own picture goes over the sender's, as in a push (delivery.ts conv).
    const c = ev.conversationId ? db.conversations.get(ev.conversationId) : undefined;
    const conv = c && c.shape !== 'direct' && c.avatar ? { shape: c.shape === 'channel' || c.shape === 'thread' ? 'channel' : 'group', icon: c.avatar } : undefined;
    const show = (reg?: ServiceWorkerRegistration) => {
      // The worker draws the picture and the network's badge, as it does for a push (sw.js).
      if (reg?.active) return reg.active.postMessage({ t: 'notify', d: { title: ev.title, body: ev.body, conversationId: ev.conversationId, inbox: !ev.conversationId && !cal, icon: ev.icon, network: ev.network, nid: ev.nid, ...(conv ? { conv } : {}), ...(cal ? { calendar: cal } : {}), ...(notice ? { noticeId: notice } : {}) } });
      const opts = { body: ev.body, tag: cal ? `calendar:${cal.eventKey}` : (ev.conversationId ?? 'dither-inbox'), icon: conv?.icon ?? ev.icon, data: { conversationId: ev.conversationId, inbox: !ev.conversationId && !cal, calendar: cal, notice } };
      if (reg) reg.showNotification(ev.title, opts);
      else new Notification(ev.title, opts).onclick = open ?? (() => go({ view: 'inbox', conv: ev.conversationId }));
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

/** Glances still loading, so that opening one meanwhile can go on once it is in. */
const glancing = new Map<string, Promise<void>>();

/**
 * Where a timeline opened came from (prefetch.ts counts them): already in memory, a glance (Catch up's, or one fetched
 * ahead), a page kept on this device (keptpages.ts), or nothing until the hub answers.
 */
export type OpenedFrom = 'memory' | 'glance' | 'kept' | 'hub';
export const openHooks = new Set<(key: string, from: OpenedFrom) => void>();
const servedFrom = (key: string, from: OpenedFrom) => {
  for (const h of openHooks) h(key, from);
};

/**
 * `glance`: for a look at the newest messages without opening it (Catch up's cards): what the hub stored, not asking
 * the network for more, and not a timeline this device keeps for its next start. Opening it later does both.
 */
export function loadTimeline(key: string, older = false, o: { glance?: boolean } = {}): Promise<void> {
  const t = timelines.get(key);
  if (t?.loading && t.glance && !o.glance && !older) return (glancing.get(key) ?? Promise.resolve()).then(() => loadTimeline(key));
  const p = fillTimeline(key, older, o);
  if (o.glance && !t) {
    glancing.set(key, p);
    void p.finally(() => glancing.delete(key));
  }
  return p;
}

async function fillTimeline(key: string, older: boolean, o: { glance?: boolean }): Promise<void> {
  let t = timelines.get(key);
  if (t?.loading) return;
  if (t && !older) {
    if (!o.glance) servedFrom(key, t.glance ? 'glance' : 'memory');
    if (t.glance && !o.glance) {
      t.glance = false;
      touchTimeline(key);
      if (key.startsWith('c:')) void fromNetwork(t, key.slice(2)).then(() => timelineChanged(key));
    }
    return;
  }
  let stale: Set<string> | null = null;
  if (!t) {
    // What this device kept from last time shows at once; the hub brings it up to date. Who wrote it and what it
    // quotes come along where the client holds no copies of its own, without moving `metaRev`: only this timeline
    // shows them, and it draws again below.
    const c = cachedTimeline(key);
    stale = c ? new Set(c.messages.map((m) => m.id)) : null;
    if (c) {
      for (const i of c.identities ?? []) if (!db.identities.has(i.id)) put(db, i);
      for (const m of c.quoted ?? []) if (!quoted.has(m.id)) quoted.set(m.id, m);
    }
    t = { key, messages: c?.messages ?? [], hasMore: true, loading: false, conversationIds: c?.conversationIds, from: c?.sync };
    timelines.set(key, t);
    if (!o.glance && !older) servedFrom(key, c ? 'kept' : 'hub');
    if (o.glance) t.glance = true;
    else touchTimeline(key);
  }
  if (older && !t.hasMore) return;
  t.loading = true;
  timelineChanged(key);
  const [kind, id] = key.split(':') as ['c' | 'p', string];
  // A person's timeline spans conversations, where two messages can share a time: its cursor names the message too.
  const oldest = older ? t.messages[0] : undefined;
  const before = oldest ? (kind === 'p' ? `${oldest.ts}:${encodeURIComponent(oldest.id)}` : oldest.ts) : undefined;
  const url = kind === 'c' ? `/api/conversations/${id}/messages` : `/api/chats/person:${id}/messages`;
  try {
    // After the socket, so nothing can fall between this page and the live events.
    if (!older) {
      await socketOpen();
      t.fetchedAt = Date.now();
    }
    // A kept copy needs only what changed since it was kept: messages after its newest, and edits inside it.
    const from = t.from;
    const caught = !older && !!from && t.messages.length > 0 ? await syncTimelines([t], () => from) : 'refused';
    // No network: what is shown stays, and the sync after the next connection brings it up to date, or a try of its
    // own when the socket outlived the blip.
    if (caught === 'failed') return void retryKept(key);
    if (!older) t.from = undefined;
    let got = t.messages.length;
    if (caught === 'refused') {
      const page = await api<P.MessagePage & { quoted?: P.MessageView[]; conversationIds?: string[] }>(`${url}?limit=60${before ? `&before=${before}` : ''}`);
      // A glance (Catch up's, or fetched ahead) is shown nowhere else: people the client did not know yet go in without
      // moving `metaRev`, which would draw every row of the lists again. One it knew and that changed still does.
      page.identities.forEach(t.glance ? (i) => (db.identities.has(i.id) ? putIdentity(i) : void put(db, i)) : putIdentity);
      if (page.quoted?.length) {
        page.quoted.forEach((m) => quoted.set(m.id, m));
        timelineChanged();
      }
      if (stale) {
        // Kept messages the hub no longer has in this range were deleted meanwhile.
        const got = new Set(page.messages.map((m) => m.id));
        const from = page.hasMore ? (page.messages[0]?.ts ?? Infinity) : -Infinity;
        t.messages = t.messages.filter((m) => !stale!.has(m.id) || got.has(m.id) || m.ts < from);
      }
      for (const m of page.messages) upsertInto(t.messages, m);
      t.hasMore = page.hasMore;
      got = page.messages.length;
      if (page.conversationIds) t.conversationIds = page.conversationIds;
    }
    if (kind === 'c' && older) {
      // Stored messages ran out, which is not the start of the conversation: Discord and Matrix can backfill.
      if (!t.hasMore) t.hasMore = await fromNetwork(t, id, t.messages[0]?.ts);
    } else if (kind === 'c') {
      // Large Discord servers push live messages only for channels open in the client, so what is stored may be
      // stale: ask for the latest on open. Show what we have meanwhile, unless that is nothing. A glance asks only
      // when nothing is stored.
      if (got && t.glance) t.hasMore = true;
      else if (got) {
        t.hasMore = true;
        void fromNetwork(t, id).then(() => timelineChanged(key));
      } else t.hasMore = await fromNetwork(t, id);
    }
  } catch (e) {
    // The page did not come (the network, most likely): the timeline keeps what it shows and catches up later.
    console.warn('timeline not loaded', key, e);
  } finally {
    t.loading = false;
    settle();
    timelineChanged(key);
    persistSoon();
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
  timelineChanged(key);
}

/** Pages a person's chat may go back to reach a message linked to (60 each), before its route alone shows it. */
const CHAT_JUMP_PAGES = 10;

/** Once a timeline is not loading. */
function timelineIdle(key: string): Promise<void> {
  return new Promise((done) => {
    let stop: (() => void) | undefined;
    stop = effect(() => {
      timelineRev(key).value;
      if (timelines.get(key)?.loading) return;
      queueMicrotask(() => stop?.());
      done();
    });
  });
}

/**
 * Open a person's chat (`p:` timeline) at a message: page back through every route until it is held, so it shows
 * interleaved like any other. The hub has no page around a message across conversations, so a message more than
 * CHAT_JUMP_PAGES pages back is not reached: false, and the page shows its route alone (Timeline.tsx PersonChat).
 */
export async function jumpInChat(key: string, messageId: string): Promise<boolean> {
  await loadTimeline(key);
  await timelineIdle(key);
  for (let i = 0; ; i++) {
    const t = timelines.get(key);
    if (t?.messages.some((m) => m.id === messageId)) return true;
    if (!t?.hasMore || i >= CHAT_JUMP_PAGES) return false;
    await loadTimeline(key, true);
    await timelineIdle(key);
  }
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
    timelineChanged(key);
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

/** Load a timeline's newest page again, keeping what it held. */
function reload(key: string) {
  const t = timelines.get(key);
  if (!t) return Promise.resolve();
  timelines.delete(key);
  // A glance stays one: only opening it asks the network.
  return loadTimeline(key, false, { glance: t.glance }).then(() => {
    const fresh = timelines.get(key);
    if (fresh) for (const m of t.messages) if (!fresh.messages.some((x) => x.id === m.id)) upsertInto(fresh.messages, m);
    timelineChanged(key);
  });
}

/**
 * A kept copy whose catch-up got no answer (fillTimeline), tried again a few times, waiting longer each time,
 * unless a reconnect's sync caught it up first (that clears `from`). Where the hub cannot say, it loads afresh.
 */
function retryKept(key: string, wait = 2000) {
  setTimeout(async () => {
    const t = timelines.get(key);
    const from = t?.from;
    if (!t || !from || t.loading) return;
    const r = await syncTimelines([t], () => from);
    if (r === 'ok') {
      if (t.from === from) t.from = undefined;
      timelineChanged(key);
      persistSoon();
    } else if (r === 'refused') {
      timelines.delete(key);
      void loadTimeline(key);
    } else if (wait < 30_000) retryKept(key, wait * 2);
  }, wait);
}

const catching = new Set<string>();
/** A timeline missed something (a message stored without a live event): ask for what is newer than it holds. */
async function catchUp(key: string) {
  const t = timelines.get(key);
  const pos = db.sync;
  if (!t || catching.has(key)) return;
  catching.add(key);
  try {
    if (!pos || (await syncTimelines([t], () => pos)) === 'refused') await reload(key);
  } finally {
    catching.delete(key);
    timelineChanged(key);
  }
}

function timelineRequest(t: Timeline, seq: number): P.SyncTimelineRequest {
  return {
    key: t.key,
    seq,
    newest: t.messages[t.messages.length - 1]?.ts ?? 0,
    oldest: t.messages[0]?.ts ?? 0,
    ...(t.detached ? { newer: false } : {}),
    ...(t.key.startsWith('p:') ? { conversationIds: t.conversationIds ?? [] } : {}),
  };
}

/** What a sync answer says about timelines: new and changed messages, or a fresh page where the held one was too far behind. */
function applyTimelines(r: Extract<P.SyncResponse, { sync: unknown }>) {
  r.identities.forEach(putIdentity);
  r.quoted.forEach((m) => quoted.set(m.id, m));
  if (r.quoted.length) timelineChanged();
  for (const tl of r.timelines) {
    const t = timelines.get(tl.key);
    if (t) {
      applyTimelineDelta(t, tl);
      timelineChanged(t.key);
    }
  }
  settle();
}

/**
 * Bring timelines up to date from the journal position each is current to. 'refused' when the hub cannot say
 * (another epoch, too old, an old hub): the caller loads them afresh. 'failed' when there was no answer.
 */
async function syncTimelines(list: Timeline[], posOf: (t: Timeline) => P.SyncPosition): Promise<'ok' | 'refused' | 'failed'> {
  const byEpoch = new Map<string, Timeline[]>();
  for (const t of list) {
    const p = posOf(t);
    if (p.v !== SYNC_VERSION) return 'refused';
    (byEpoch.get(p.epoch) ?? byEpoch.set(p.epoch, []).get(p.epoch)!).push(t);
  }
  for (const [epoch, ts] of byEpoch) {
    let r: P.SyncResponse;
    try {
      r = await api<P.SyncResponse>('/api/sync', { body: { v: SYNC_VERSION, epoch, timelines: ts.map((t) => timelineRequest(t, posOf(t).seq)) } satisfies P.SyncRequest });
    } catch (e) {
      return e instanceof TypeError ? 'failed' : 'refused';
    }
    if (r.full) return 'refused';
    applyTimelines(r);
  }
  return 'ok';
}

export async function loadInbox() {
  const [page] = await Promise.all([api<P.InboxPage>('/api/inbox'), loadMailTriage()]);
  page.identities.forEach(putIdentity);
  inbox.value = page.items.map((i) => i.message);
  // The badge is counted from the inbox, behind a memo keyed on the data version.
  changed('list');
}

// ------------------------------------------------------------------ actions

/** A file attached in the composer starts uploading at once, a piece at a time (upload.ts, docs/uploads.md). */
export const startUpload = (f: File) => new UploadJob(f, f.name, f.type || 'application/octet-stream');
/** The uploads of sends not yet through, by tempId, for their progress on the pending copy. */
const sendUploads = new Map<string, UploadJob[]>();
export const uploadsOf = (tempId: string): UploadJob[] => sendUploads.get(tempId) ?? [];

/** `uploads`: the composer's uploads of `files`, one each, already under way. */
type SendOpts = { accountId?: string; replyTo?: string; files?: File[]; uploads?: UploadJob[]; media?: SendMedia; /** docs/sending.md */ silent?: boolean; mentionReplied?: boolean };
/** Sends kept on this device until the hub has them (outbox.ts): a reload or the app being closed does not lose them. */
const outbox = openOutbox(typeof indexedDB === 'undefined' ? undefined : indexedDB);
/** Sends not yet through, by tempId: what they need to go out again. The outbox keeps the same. */
const outgoing = new Map<string, OutboxEntry>();
/** On their way now: a send goes out once at a time, whoever asks. */
const delivering = new Set<string>();
const setPending = (tempId: string, patch: Partial<PendingSend>) => (pending.value = pending.value.map((x) => (x.tempId === tempId ? { ...x, ...patch } : x)));
const pendingOf = (e: OutboxEntry): PendingSend => ({ tempId: e.tempId, conversationId: e.conversationId, body: e.body, ts: e.ts, accountId: e.accountId, files: e.files?.map((f) => f.name), failed: e.failed });

/**
 * Shown at once as pending. Without the hub it waits, and goes out when the hub is back (flushOutgoing).
 *
 * More files than the network takes in one message go as several sends, each with as many as it takes, in order: the
 * words and the reply with the first (docs/uploads.md, "More files than a message takes"). Each is a send of its own,
 * with its own pending copy and retry, so a batch that fails does not send the others twice.
 */
export async function send(conversationId: string, body: string, opts: SendOpts = {}) {
  const network = db.conversations.get(conversationId)?.network;
  const per = network && splitsFiles(network) ? ATTACHMENT_LIMITS[network].files : 0;
  const files = opts.files ?? [];
  if (!per || files.length <= per) return sendOne(conversationId, body, opts, Date.now());
  const fileRuns = fileBatches(files, per);
  const uploadRuns = opts.uploads ? fileBatches(opts.uploads, per) : [];
  const now = Date.now();
  // All shown at once, a millisecond apart so they keep their order; then each goes once the one before is through.
  const ids = await Promise.all(
    fileRuns.map((run, k) =>
      queueSend(conversationId, k ? '' : body, { ...opts, files: run, uploads: uploadRuns[k], ...(k ? { replyTo: undefined, mentionReplied: undefined } : {}) }, now + k),
    ),
  );
  for (const id of ids) if (id) await deliver(id);
}

async function sendOne(conversationId: string, body: string, opts: SendOpts, ts: number) {
  const tempId = await queueSend(conversationId, body, opts, ts);
  if (tempId) await deliver(tempId);
}

/** Kept and shown as pending; the tempId to deliver now, or null when it waits for the hub. */
async function queueSend(conversationId: string, body: string, opts: SendOpts, ts: number): Promise<string | null> {
  const tempId = 'tmp-' + Math.random().toString(36).slice(2);
  const e: OutboxEntry = { tempId, conversationId, body, ts, accountId: opts.accountId, replyTo: opts.replyTo, files: opts.files?.map((f) => ({ name: f.name, type: f.type, blob: f })), ...(opts.media ? { media: opts.media } : {}), ...(opts.silent ? { silent: true } : {}), ...(opts.mentionReplied === false ? { mentionReplied: false } : {}) };
  pending.value = [...pending.value, pendingOf(e)];
  outgoing.set(tempId, e);
  if (opts.uploads?.length) {
    sendUploads.set(tempId, opts.uploads);
    // Their ids go with the send as soon as the hub gives them, so a reload carries on rather than starting again.
    const ids = (e.uploads = opts.uploads.map((j) => j.id));
    opts.uploads.forEach((j, i) => (j.onId = (id) => ((ids[i] = id), void outbox.put(e))));
  }
  // Kept before it goes, so that closing the app meanwhile cannot lose it; a slow IndexedDB does not hold it up long.
  await Promise.race([outbox.put(e), new Promise((r) => setTimeout(r, 500))]);
  if (!connected.value) {
    setPending(tempId, { queued: true });
    probe();
    return null;
  }
  return tempId;
}

async function deliver(tempId: string) {
  const o = outgoing.get(tempId);
  if (!o || delivering.has(tempId)) return;
  delivering.add(tempId);
  setPending(tempId, { queued: false, failed: undefined });
  // Each file's upload: the composer's, still going or done, or one carrying on from what the hub has. `again`:
  // the hub let them expire, so each begins anew.
  const uploadAll = async (again = false) => {
    const ids = (o.uploads ??= []);
    const had = sendUploads.get(tempId) ?? [];
    const jobs = o.files!.map((f, i) => {
      const prev = had[i];
      const j = !again && prev && prev.status.value !== 'cancelled' ? prev : new UploadJob(f.blob, f.name, f.type || 'application/octet-stream', { id: again ? undefined : ids[i] });
      if (prev && j !== prev) prev.cancel();
      ids[i] = j.id;
      j.onId = (id) => ((ids[i] = id), void outbox.put(o));
      return j;
    });
    sendUploads.set(tempId, jobs);
    void outbox.put(o);
    if (jobs.some((j) => j.status.value !== 'done')) setPending(tempId, { uploading: true });
    try {
      o.attachments = (await Promise.all(jobs.map((j) => j.settle()))).map((u) => u.id);
    } finally {
      setPending(tempId, { uploading: false });
    }
    void outbox.put(o);
  };
  // clientId: a retry after a lost answer, or after a reload, goes out once (server.ts).
  const clientId = o.attempt ? `${tempId}~${o.attempt}` : tempId;
  const post = () => {
    // A message of ours that comes after this may be this send's (settle).
    setPending(tempId, { postedAt: Date.now() });
    return api<P.SendResult>(`/api/conversations/${o.conversationId}/send`, { body: { body: o.body, accountId: o.accountId, replyTo: o.replyTo, attachments: o.attachments, clientId, ...o.media, ...(o.silent ? { silent: true } : {}), ...(o.mentionReplied === false ? { mentionReplied: false } : {}) } });
  };
  try {
    if (o.files?.length && !o.attachments) await uploadAll();
    let r: P.SendResult;
    try {
      r = await post();
    } catch (e: any) {
      // The hub let the uploads expire while this waited: make them again from the files, once.
      if (e?.status !== 410 || !o.files?.length) throw e;
      await uploadAll(true);
      r = await post();
    }
    forget(tempId);
    setPending(tempId, { acked: true, ...(r?.messageId ? { messageId: r.messageId } : {}) });
    settle();
    // A message that never comes back (a network that does not echo it) leaves no copy behind for long.
    setTimeout(() => (pending.value = pending.value.filter((x) => x.tempId !== tempId)), 30_000);
  } catch (e: any) {
    // The hub refused it before it reached the network: a message that looked like its own was another send.
    if (!mayBeOut(e)) setPending(tempId, { postedAt: undefined, echoed: undefined });
    // Its message is here, so it went out, whatever the answer says (504, or no answer at all): nothing to retry.
    else if (pending.value.some((x) => x.tempId === tempId && x.echoed)) {
      forget(tempId);
      pending.value = pending.value.filter((x) => x.tempId !== tempId);
      return;
    }
    // No answer at all is the network, not a refusal: wait for the hub.
    if (e instanceof TypeError || !connected.value) {
      setPending(tempId, { queued: true });
      probe();
    } else {
      o.failed = e.message;
      // 504: the network took it and went quiet, so it may be out. Trying again is then your call (retrySend).
      o.unsure = e?.status === 504;
      void outbox.put(o);
      setPending(tempId, { failed: e.message });
    }
  } finally {
    delivering.delete(tempId);
  }
}

/** A send that is through: nothing of it is kept any more but its copy, until its message is here. */
function forget(tempId: string) {
  outgoing.delete(tempId);
  sendUploads.delete(tempId);
  void outbox.remove(tempId);
}

/** One at a time, oldest first: the batches of one send (and sends in a row) arrive in the order they were made. */
let flushing = false;
async function flushOutgoing() {
  if (flushing) return;
  flushing = true;
  try {
    for (let next; (next = pending.value.filter((p) => p.queued && !delivering.has(p.tempId)).sort((a, b) => a.ts - b.ts)[0]); ) {
      await deliver(next.tempId);
      // Still queued: the hub went away again, and its coming back flushes the rest.
      if (pending.value.some((p) => p.tempId === next.tempId && p.queued)) break;
    }
  } finally {
    flushing = false;
  }
}

/** A refused send, again. */
export function retrySend(tempId: string) {
  const o = outgoing.get(tempId);
  if (!o) return;
  o.failed = undefined;
  // After "it may have been sent", trying again is a new send: the hub answers the old id with the same doubt.
  if (o.unsure) (o.attempt = (o.attempt ?? 0) + 1), (o.unsure = false);
  void outbox.put(o);
  if (connected.value) return void deliver(tempId);
  setPending(tempId, { failed: undefined, queued: true });
  probe();
}

/** A refused send, thrown away, and its files with it. */
export function discardSend(tempId: string) {
  const o = outgoing.get(tempId);
  for (const j of uploadsOf(tempId)) j.cancel();
  for (const id of o?.uploads ?? []) if (id) void hubTransport.cancel(id);
  sendUploads.delete(tempId);
  outgoing.delete(tempId);
  void outbox.remove(tempId);
  pending.value = pending.value.filter((x) => x.tempId !== tempId);
}

/**
 * Sends kept from before this start (a reload, the app closed meanwhile): shown again where they were, and sent once
 * the hub is caught up with, as before the reload.
 */
export async function restoreOutbox() {
  const kept = (await outbox.all()).filter((e) => !outgoing.has(e.tempId));
  if (!kept.length) return;
  for (const e of kept) outgoing.set(e.tempId, e);
  pending.value = [...pending.value, ...kept.map((e) => ({ ...pendingOf(e), queued: !e.failed }))].sort((a, b) => a.ts - b.ts);
  // The sync after connecting sends them; if it is already done, now.
  if (connected.value && synced && !held) void flushOutgoing();
  else if (!connected.value) probe();
}

/** Messages already matched to a pending copy. */
const claimed = new Set<string>();
/** Our own messages that came lately on the socket, and when, for a copy whose answer comes after its message. */
let echoes: Echo[] = [];
const echoOf = (m: P.MessageView, seen?: number): Echo => ({ id: m.id, conversationId: m.conversationId, body: m.body, ts: m.ts, attachments: m.attachments.length, accountId: ownAccount(m)?.id, ...(seen ? { seen } : {}) });

function noteEcho(m: P.MessageView) {
  const now = Date.now();
  // An edit or a reaction brings it again: when it first came is what counts.
  const seen = echoes.find((e) => e.id === m.id)?.seen ?? now;
  echoes = [...echoes.filter((e) => e.id !== m.id && now - e.ts < 5 * 60_000).slice(-99), echoOf(m, seen)];
}

/**
 * The pending copies whose message is here now (outbox.ts says which). One the hub answered goes; one still waiting
 * for its answer is hidden, and deliver lets it go when the answer comes; one that failed or waits for the hub went out
 * after all, so it goes, and nothing of it is kept.
 */
function settle() {
  const sent = pending.value.filter((p) => p.acked || p.messageId || p.postedAt !== undefined);
  if (!sent.length) return;
  const ids = new Set(sent.map((p) => p.messageId).filter(Boolean));
  const convs = new Set(sent.map((p) => p.conversationId));
  const since = Math.min(...sent.map((p) => p.ts)) - ECHO_SKEW;
  const known = new Map<string, Echo>();
  for (const t of timelines.values())
    for (const m of t.messages) if (ids.has(m.id) || (m.ts >= since && convs.has(m.conversationId) && isSelfIdentity(m.authorId))) known.set(m.id, echoOf(m));
  for (const e of echoes) known.set(e.id, e);
  const gone = new Set(settled(sent, [...known.values()], claimed));
  for (const id of claimed) if (claimed.size > 500) claimed.delete(id);
  if (!gone.size) return;
  const was = pending.value;
  let next = was;
  for (const p of was) {
    if (!gone.has(p.tempId) || (p.echoed && !p.acked)) continue;
    if (!p.acked && delivering.has(p.tempId)) next = next.map((x) => (x === p ? { ...p, echoed: true } : x));
    else {
      if (!p.acked) forget(p.tempId);
      next = next.filter((x) => x !== p);
    }
  }
  if (next !== was) pending.value = next;
}

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

export function ownAccount(m: P.MessageView) {
  return [...db.accounts.values()].find((a) => a.selfIdentityId === m.authorId);
}
export const canEdit = (m: P.MessageView) => !m.deleted && m.kind !== 'system' && !!ownAccount(m)?.capabilities.includes('edit');
export const canDelete = (m: P.MessageView) => !m.deleted && !!ownAccount(m)?.capabilities.includes('redact');

export function startEditing(m: P.MessageView) {
  const r = route.value;
  if (!('conv' in r) || r.conv !== m.conversationId) go({ view: 'inbox', conv: m.conversationId });
  editing.value = m;
}
/** What you wrote in an edit the hub refused, by message: editing it again starts from there, not from the old text. */
export const editDrafts = new Map<string, string>();
export async function editMessage(m: P.MessageView, body: string) {
  try {
    await api(`/api/messages/${m.id}/edit`, { body: { body } });
    editDrafts.delete(m.id);
  } catch (e: any) {
    editDrafts.set(m.id, body);
    toast({ kind: 'error', title: 'Could not edit', body: `${e.message}. What you wrote is kept: edit the message again to retry.` });
    // Back to the edit, with your text, unless you are editing something else by now.
    if (!editing.value) editing.value = m;
  }
}
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

/** A rule on a place, a person or a keyword: Always alert, List only or Mute; null takes it away (Automatic). */
export const setRule = (scope: P.NotifyScope, target: string | null, level: P.RuleLevel | null) => api('/api/rules', { method: 'PUT', body: { scope, target, level } });
/** Shown at once; the hub's event confirms it, and a failure resyncs. */
export function saveFolders(folders: P.FolderView[]) {
  db.folders = folders;
  changed('meta');
  return api('/api/folders', { method: 'PUT', body: { folders } }).catch(placeFailed);
}
export function patchPlaces(items: P.PlacePrefPatch[]) {
  for (const i of items) {
    const k = prefKey(i.kind, i.id);
    const cur = db.placePrefs.get(k) ?? { kind: i.kind, id: i.id, position: null, pinned: false, hidden: false, open: false, railed: false };
    const next: P.PlacePrefView = { ...cur, ...(i as Partial<P.PlacePrefView>) };
    // null takes a mention setting away: inherited again.
    if (i.mentionScope === null) delete next.mentionScope;
    if (i.mentionSameNetwork === null) delete next.mentionSameNetwork;
    db.placePrefs.set(k, next);
  }
  changed('meta');
  return api('/api/place-prefs', { method: 'PATCH', body: { items } }).catch(placeFailed);
}
function placeFailed(e: Error) {
  toast({ kind: 'error', title: 'Could not save that', body: e.message });
  bootstrap().catch(() => {});
}

// ------------------------------------------------------------------ live connection
//
// One socket for live events. Coming back (a new socket after a drop, or a cold start from the snapshot) asks the hub
// for what changed since this copy's journal position (POST /api/sync) instead of loading everything again; only when
// the hub cannot say (another epoch, too old) does it take a full bootstrap. Short drops are not shown at all: the
// app keeps showing what it has, and a small notice appears only after the hub has been out of reach for a while, or
// when a send is waiting for it. docs/sync.md.

/** The hub has been out of reach for a while: a small notice, never a screen in the way. */
export const unreachable = signal(false);
/** How long a drop goes unmentioned. */
const NOTICE_AFTER = 4000;
/** The heartbeat: a ping this often while in sight, and a socket that does not answer within PONG_WAIT is dead. */
const PING_EVERY = 25_000;
const PONG_WAIT = 3000;

let ws: WebSocket | null = null;
let backoff = 500;
let retry: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let lastPong = 0;
/** This socket's events are applied on top of a synced copy: each frame's position is ours. */
let synced = false;
/** Which socket a sync was for: one that finishes after its socket was replaced does not vouch for the new one. */
let socketGen = 0;
/**
 * Frames that came while a sync was in flight, applied after its answer, in order, so the answer cannot undo them.
 * Each carries whole objects, so one the answer already covers only sets the same thing again.
 */
let held: P.ClientEvent[][] | null = null;
/** The hub process last synced with; a new one may serve a new build (pwa.ts). */
let hubBoot: string | null = null;
/** Waited for before the first sync: the snapshot read, so a cold start resumes from it rather than from nothing. */
export const beforeSync = { wait: Promise.resolve() as Promise<unknown> };

/** Since when the hub has not answered; null while it does. A start counts as not answering yet. */
let downSince: number | null = Date.now();

/** `since`: when the hub was last known to answer. Going down again while down keeps the first time. */
function setConnected(v: boolean, since = Date.now()) {
  connected.value = v;
  if (v) {
    downSince = null;
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    unreachable.value = false;
    return;
  }
  downSince ??= since;
  if (!noticeTimer && !unreachable.value) noticeTimer = setTimeout(() => (unreachable.value = true), Math.max(0, NOTICE_AFTER - (Date.now() - downSince)));
}

/** Pull to refresh: reconnect now if the socket is down, else load everything again. */
export async function refresh() {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    reconnectNow();
    return;
  }
  await bootstrap();
}

/** One sync at a time, in order. */
let chain: Promise<unknown> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const frameSeq = (f: P.ClientEvent[]) => {
  const last = f[f.length - 1];
  return last?.t === 'sync' ? last.seq : null;
};

function applyFrame(f: P.ClientEvent[]) {
  applyEvents(f);
  const seq = frameSeq(f);
  if (seq !== null && synced && db.sync && seq > db.sync.seq) db.sync = { ...db.sync, seq };
}

function release() {
  const h = held ?? [];
  held = null;
  for (const f of h) applyFrame(f);
}

function bootstrap() {
  return serial(async () => {
    held ??= [];
    const since = openedAt;
    const gen = socketGen;
    try {
      // As text too: the snapshot keeps the hub's answer as it came, without serializing it again.
      const res = await fetch('/api/bootstrap');
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 200) || `${res.status}`);
      const b = JSON.parse(text) as P.Bootstrap;
      applyBootstrap(b);
      synced = !!b.sync && ws?.readyState === WebSocket.OPEN && gen === socketGen;
      sawHub(b.boot);
      freshFromHub();
      performance.mark('dither:fresh');
      loadInbox().catch(() => {});
      void loadCalls();
      // Timelines asked for before this socket may have missed anything: their newest pages again.
      for (const [key, t] of [...timelines]) if (!t.fetchedAt || t.fetchedAt < since) void reload(key);
      persistSoon(text);
      void flushOutgoing();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not load', body: String(e.message) });
    } finally {
      release();
    }
  });
}

/** Catch up from this copy's position; a full bootstrap where that cannot be done. */
function resync() {
  return serial(async () => {
    held ??= [];
    const gen = socketGen;
    // A cold start resumes from the snapshot, once it is read; IndexedDB can be slow, but not this slow.
    await Promise.race([beforeSync.wait, new Promise((r) => setTimeout(r, 1500))]);
    const pos = db.sync;
    if (!loaded.value || !pos || pos.v !== SYNC_VERSION) return void (release(), bootstrap());
    // Timelines in memory are as current as `db`, or as their kept copy when it has not been caught up yet. One
    // kept under another epoch loads afresh; those loading now catch up on their own.
    const mine = [...timelines.values()].filter((t) => !t.loading && (t.fetchedAt || t.from));
    const tls = mine.filter((t) => !t.from || (t.from.v === pos.v && t.from.epoch === pos.epoch));
    let r: P.SyncResponse;
    try {
      r = await api<P.SyncResponse>('/api/sync', { body: { v: pos.v, epoch: pos.epoch, since: pos.seq, timelines: tls.map((t) => timelineRequest(t, t.from?.seq ?? pos.seq)) } satisfies P.SyncRequest });
    } catch (e) {
      release();
      // No answer: the socket is likely gone too, and the next one tries again. An answer that is an error (a hub
      // without /api/sync) means starting over.
      if (e instanceof TypeError) probe();
      else void bootstrap();
      return;
    }
    if (r.full) {
      release();
      void bootstrap();
      return;
    }
    applyTimelines(r);
    for (const t of tls) t.from = undefined;
    for (const t of mine) if (!tls.includes(t)) void reload(t.key);
    applySyncTo(db, { ...r, events: [] });
    changed('meta');
    applyEvents(r.events);
    if (r.inbox) mergeInbox(r.inbox);
    synced = ws?.readyState === WebSocket.OPEN && gen === socketGen;
    sawHub(r.boot);
    freshFromHub();
    performance.mark('dither:fresh');
    release();
    persistSoon();
    void flushOutgoing();
  });
}

function sawHub(boot: string | undefined) {
  if (!boot) return;
  // A new hub process may have brought a new build: pwa.ts checks.
  if (hubBoot && boot !== hubBoot) window.dispatchEvent(new Event('dither:reconnected'));
  hubBoot = boot;
}

let openedAt = 0;
let opened: Promise<void> | null = null;
let markOpen: (() => void) | null = null;
/** Resolves once the live socket is open. */
function socketOpen(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  return (opened ??= new Promise((r) => (markOpen = r)));
}

/** A promise that settles once the hub has been caught up with (or a few seconds have passed). For usage.ts. */
export function afterSync(): Promise<void> {
  const settle = new Promise<void>((r) => setTimeout(r, 4000));
  return Promise.race([settle, socketOpen().then(() => chain).then(() => {})]);
}

export function connect() {
  clearTimeout(retry);
  if (!connected.value) setConnected(false);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`;
  const sock = new WebSocket(url);
  ws = sock;
  synced = false;
  socketGen++;
  // The socket gets its own connection; this one opens the HTTP connection the sync will use, at the same time.
  fetch('/api/health', { cache: 'no-store' }).catch(() => {});
  sock.onopen = () => {
    if (ws !== sock) return;
    setConnected(true);
    backoff = 500;
    openedAt = lastPong = Date.now();
    markOpen?.();
    opened = markOpen = null;
    held ??= [];
    void resync();
    void loadPlans();
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    if (e.data === 'pong') {
      lastPong = Date.now();
      clearTimeout(pongTimer);
      return;
    }
    try {
      const f = JSON.parse(String(e.data)) as P.ClientEvent[];
      if (held) held.push(f);
      else applyFrame(f);
    } catch (err) {
      console.error(err);
    }
  };
  sock.onclose = () => {
    if (ws === sock) dropped();
  };
}

/** The socket is gone, or as good as: forget it now rather than wait for its close to time out. */
function dropped(since = Date.now()) {
  const old = ws;
  ws = null;
  synced = false;
  clearTimeout(pongTimer);
  if (old) {
    old.onopen = old.onmessage = old.onclose = null;
    try {
      old.close();
    } catch {}
  }
  setConnected(false, since);
  clearTimeout(retry);
  retry = setTimeout(connect, (backoff = Math.min(backoff * 2, 15_000)));
}

/** Back on the network or back in front of the user while disconnected: try now rather than at the end of the backoff. */
function reconnectNow() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  clearTimeout(retry);
  backoff = 500;
  connect();
}

/**
 * Is the socket alive? A phone that slept or switched networks can hold one that looks open and is not: without an
 * answer within PONG_WAIT it is dropped and a new one opens at once.
 */
function probe() {
  if (!ws || ws.readyState === WebSocket.CLOSED) return reconnectNow();
  if (ws.readyState !== WebSocket.OPEN) return;
  const sock = ws;
  const sent = Date.now();
  try {
    sock.send('ping');
  } catch {
    return dropped();
  }
  clearTimeout(pongTimer);
  pongTimer = setTimeout(() => {
    if (ws === sock && lastPong < sent) {
      dropped(sent);
      reconnectNow();
    }
  }, PONG_WAIT);
}

if (typeof window !== 'undefined') {
  const wake = () => document.visibilityState === 'visible' && probe();
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  setInterval(() => document.visibilityState === 'visible' && probe(), PING_EVERY);
}
