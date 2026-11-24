import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, fileBatches, LIVE_PROTOCOL, LIVE_RESUME, splitsFiles, SYNC_VERSION } from '@dither-chat/protocol';
import { leaveLayerEntry, takeOverLayers } from './phone.ts';
import { cachedTimeline, freshFromHub, persistSoon, touchTimeline } from './snapshot.ts';
import { arrivedInto, carryArrived, doneArrived, dropArrived, heldEnds, isArrivedCopy, stripArrived } from './arrived.ts';
import { applyBootstrapTo, applyEventTo, applySyncTo, applyTimelineDelta, conversationMetaChanged, identityVersion, indexThreads, onlyOpens, leaveOtherTimelines, mergeInbox as merged, streamChannelOf, prefKey, putIdentity as put, upsertInto } from './syncmodel.ts';
import { changed, mailChanged, presenceRev, timelineChanged, timelineRev } from './versions.ts';
import { applyTyping, type TypingState } from './typers.ts';
import { ECHO_SKEW, mayBeOut, openOutbox, settled, type Echo, type OutboxEntry, type SendMedia } from './outbox.ts';
import { hubTransport, UploadJob } from './upload.ts';
import { href, parseHash, type Route } from './routes.ts';
import { inboxFilterOf, type InboxFilter } from './ordering.ts';
import { applyPlanEvent, calendarAt, calendarFromBootstrap, loadPlans } from './plans.ts';
import { api, hedged, hubFetch } from './api.ts';
import { isLoginRefusal, login, needLogin } from './login.ts';
import { db, eventHooks, inbox, loaded, mailTriage, quoted, timelines, type Timeline } from './store.ts';
import { convById, holdsMail, isMailPlace, isMailThread, mailPageUrl } from './mail/chats.ts';
import { applyCalls, applyVoice, loadCalls } from './ringing.ts';
import { closeCleared, closeNotifications, readIn, tidyNotifications } from './shade.ts';
import { sized } from './perf.ts';

// ------------------------------------------------------------------ data

/** What components read to re-render: `rev` for the lists, `metaRev` for names and settings, one per timeline (versions.ts). */
export { changed, dataVersion, mailRev, metaRev, readMinute, rev, timelineRev } from './versions.ts';
export { db, eventHooks, inbox, loaded, mailTriage, quoted, timelines,  } from './store.ts';
export const connected = signal(false);
/** Notices on this hub (docs/notices.md): whether it may read them; null when it has none. */
export const noticesBoot = signal<P.NoticesBoot | null>(null);
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

interface PendingSend {
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
  /** The chat it is about (`openChat()` when it was made): it goes when you leave that chat, its Undo with it. */
  chat?: string;
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

interface Prefs {
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
  /** This device's microphone and camera for calls (a deviceId; absent: the browser's default). */
  callMicId?: string;
  callCameraId?: string;
  /** Call sounds on this device: someone joins or leaves, you mute (default on). */
  callSounds?: boolean;
  /** The inbox's filter (its menu beside the search box). */
  inboxFilter: InboxFilter;
  /** How Mail's Inbox sorts on this device (docs/mail.md "Ranked"): absent is ranked. */
  mailOrder?: 'ranked' | 'newest';
  /** People's filter chip: chats, or one kind of list (docs/add.md "Relationships"). */
  peopleFilter?: 'chats' | 'friend' | 'contact' | 'following';
  /** How People's friends, contacts and follows sort: when you last talked (the default), or by name. */
  peopleLinkSort?: 'recent' | 'az';
  /** This device counts which buttons are pressed (clicklog.ts, docs/button-counts.md). Off unless switched on here. */
  countClicks?: boolean;
  /**
   * GIFs drawn as just the GIF (docs/media-kinds.md "GIFs"): a Discord GIF link with no link text or card, and the
   * networks' GIF videos looping with no player. On unless switched off.
   */
  plainGifs?: boolean;
  /** What a channel with threads shows on this device: its stream, its thread cards, or its own messages (stream.ts). */
  channelViews?: Record<string, import('./stream.ts').ChannelView>;
}
export type { InboxFilter };
const PREFS_KEY = 'dither-chat:prefs';
const defaults: Prefs = { theme: 'dither-dark', themeDark: 'dither-dark', themeLight: 'dither-light', details: false, collapsed: {}, sendAs: {}, via: {}, notifications: false, skinTone: 0, directorySort: 'recency', pushEnabled: false, callMode: 'bridge', inboxFilter: 'all' };
function storedPrefs(): Prefs {
  const p = { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  // The chips before the filter menu: People became Direct messages, and Unread is the New section, under All.
  return { ...p, inboxFilter: inboxFilterOf(p.inboxFilter) };
}
/**
 * Every setting in one signal, kept to this file: a component that read it whole would render again on every
 * setPrefs, whatever it changed. Opening the details panel drew every message, the list and the rail again that way,
 * and set the theme's colours again (docs/perf.md, "One setting at a time"). Read a setting with pref().
 */
const prefs = signal<Prefs>(storedPrefs());
const prefFields = new Map<keyof Prefs, ReadonlySignal<unknown>>();
/** One setting. What reads it while it renders renders again when this setting changes, and for no other. */
export function pref<K extends keyof Prefs>(k: K): Prefs[K] {
  let s = prefFields.get(k);
  if (!s) prefFields.set(k, (s = computed(() => prefs.value[k])));
  return s.value as Prefs[K];
}
export function setPrefs(p: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...p };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
}

// ------------------------------------------------------------------ routing

export { href, parseHash, type Route };

export const route = signal<Route>(parseHash());
/** The chat open now, by the route's `conv`: what a toast about it is tied to (`Toast.chat`). */
export const openChat = (): string | undefined => {
  const r = route.value;
  return 'conv' in r ? r.conv : undefined;
};
// Leaving a chat closes the toasts that belong to it: an Undo there must not act from another chat.
effect(() => {
  const here = openChat();
  const list = toasts.peek();
  if (list.some((t) => t.chat && t.chat !== here)) toasts.value = list.filter((t) => !t.chat || t.chat === here);
});
/** An old link (`#/groups/…`) shows its new address, in place. */
function canonicalHash() {
  const h = href(route.value);
  if (location.hash.startsWith('#/groups') && h !== location.hash) history.replaceState(history.state, '', h);
}
canonicalHash();
// The entry the app opened on. adoptOpened shapes it once the app has its data, as a page's list may need it.
if (history.state === null) history.replaceState({ prev: null, opened: true }, '');
window.addEventListener('hashchange', (e) => {
  // An address from outside go() (typed, or a script's) makes an entry with no state yet. It gets what go() would have
  // written: the entry before it remembered, and a page's list under it.
  if (history.state === null) write(location.hash, new URL(e.oldURL).hash || null, true, null);
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
 * The entry the app opened on (from a link or a notification), once there is data to say where its page lives: it
 * gets what go() would have written, a page's list under it. Only that entry: one an address typed in made before
 * then has no state until its hashchange, a task later, which writes it with the entry before it; written here first,
 * it would lose that, and Escape and back from it would go to its list instead of where you came from.
 */
export function adoptOpened() {
  if (history.state?.opened) write(location.hash, null, true, null);
}

/** Back where you came from, or to `fallback` when this page was opened directly. */
export function back(fallback: Route) {
  if (history.state?.prev) history.back();
  else go(fallback, true);
}

/** The route a back press would land on, when it is known. */
export const previousRoute = (): Route | null => (history.state?.prev ? parseHash(history.state.prev) : null);

// ------------------------------------------------------------------ http

// api() and apiHooks live in api.ts (no import of this file), so modules this file imports can call the hub.
export { api, apiHooks } from './api.ts';

// ------------------------------------------------------------------ applying hub data

const putIdentity = (i: P.IdentityView) => void (put(db, i) && changed('shown'));
/** People a page brought that the client may not know yet (For you's items). */
export const adoptIdentities = (list: P.IdentityView[]) => list.forEach(putIdentity);

export function applyBootstrap(b: P.Bootstrap) {
  applyBootstrapTo(db, b);
  presenceRev.value++;
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
      const next = patch(t.messages[i]);
      carryArrived(t.messages[i], next);
      t.messages[i] = next;
      timelineChanged(t.key);
    }
  }
  const q = quoted.get(id);
  if (q) {
    quoted.set(id, patch(q));
    timelineChanged();
  }
}

/** Events that change nothing in `db` the lists show: typing, toasts, read progress and status dots have signals of their own. */
const NOT_DB = new Set<P.ClientEvent['t']>(['typing', 'notify', 'cleared', 'sync', 'readProgress', 'resync', 'sent', 'plans', 'calendar', 'presence']);
/** Events that change what lists show but no names or settings: `metaRev` stays. */
const LIST_ONLY = new Set<P.ClientEvent['t']>(['message', 'message.deleted', 'identity', 'attention', 'usage', 'arrange', 'requests', 'accountsManager']);
/** Events that change names (`metaRev` moves) but not what is where (versions.ts `changed('shown')`): people. */
const SHOWN_ONLY = new Set<P.ClientEvent['t']>(['person', 'person.removed']);

export function applyEvents(events: P.ClientEvent[]) {
  let threadsDirty = false;
  /** Timelines a newer message may be missing from, and that message's id. */
  const behind = new Map<string, string>();
  const regrouped = new Set<string>();
  const ids = identityVersion();
  let list = false;
  let meta = false;
  let shown = false;
  let mail = false;
  let opened = false;
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
      // A folder opened or closed (here or on another device): nothing a message or a row shows.
      else if (ev.t === 'placePrefs' && onlyOpens(db, ev.prefs)) opened = true;
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
        const last = ev.conversation.lastMessage;
        const t = timelines.get('c:' + ev.conversation.id);
        if (t && !t.detached && last) behind.set(t.key, last.id);
        // And the stream of its channel (a thread new since too: it is in `db` now).
        const ch = streamChannelOf(db, ev.conversation.id);
        const kt = ch && timelines.get('k:' + ch);
        // Only a message newer than the stream holds: a thread's older last message is simply further back.
        if (kt && !kt.detached && last && last.ts >= (kt.messages[kt.messages.length - 1]?.ts ?? 0)) behind.set(kt.key, last.id);
        break;
      }
      case 'readProgress':
        readProgress.value = ev;
        break;
      case 'presence':
        presenceRev.value++;
        break;
      case 'message': {
        const m = ev.message;
        const t = timelines.get('c:' + m.conversationId);
        const held = !!t && t.messages.some((x) => x.id === m.id);
        // Moved here from another conversation (MessageFact.moved, a Zulip topic renamed or messages moved to another
        // topic): whatever timeline still holds it from before lets it go, even where a page loaded since holds it here.
        const ch = streamChannelOf(db, m.conversationId);
        for (const k of leaveOtherTimelines(timelines.values(), m, ch)) timelineChanged(k);
        // A detached window only takes updates to what it holds: a new message would leave a silent gap.
        if (t && (!t.detached || held)) {
          upsertInto(t.messages, m);
          timelineChanged(t.key);
        }
        // Its channel's stream, every thread's messages together (docs/threads.md "The channel stream").
        const kt = ch && timelines.get('k:' + ch);
        if (kt && (!kt.detached || kt.messages.some((x) => x.id === m.id))) {
          upsertInto(kt.messages, m);
          if (kt.conversationIds && !kt.conversationIds.includes(m.conversationId)) kt.conversationIds = [...kt.conversationIds, m.conversationId];
          timelineChanged(kt.key);
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
      // Read on some device since the hub notified about it: its notification here goes, unless it shows something
      // newer than the read (docs/notifications.md, "Read elsewhere, gone here").
      case 'cleared':
        void closeCleared(ev.reads, readHere);
        break;
      case 'mail.threads':
        mergeMailTriage(ev.threads);
        // Mail as chats: a thread's own chat, and the people on it, whose chats show it (mail/chats.ts).
        mailMoved(ev.threads.flatMap((x) => [`c:${x.id}`, ...x.personIds.map((p) => `p:${p}`)]));
        break;
      case 'mail.chats':
        // Who has an email route moves people's directs and the inbox's rows (model.ts), as a conversation does.
        list = true;
        mailMoved(ev.chats.flatMap((c) => [`c:${c.id}`, `p:${c.personId}`]));
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
  for (const [key, last] of behind) {
    const t = timelines.get(key);
    if (t && !t.loading && !t.messages.some((m) => m.id === last)) void catchUp(key);
  }
  for (const key of regrouped) if (!timelines.get(key)?.loading) void catchUp(key);
  settle();
  if (meta) changed('meta');
  else {
    if (opened) changed('open');
    if (shown || identityVersion() !== ids) changed('shown');
    else if (list) changed('list');
  }
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
function quietHere(ev: { quiet?: string[] }): boolean {
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

/** Whether the page holds what a notification shows as read (shade.ts). */
const readHere = readIn(db);

/**
 * After each catch-up with the hub (a start, a reconnect): notices.ts checks its own. Notifications of what was read
 * while this page was away go here (shade.ts), whether this browser was closed or only offline; `dither:tidied` marks
 * when (scripts/verify-clear.ts waits for it).
 */
export const freshHooks = new Set<() => void>([() => void tidyNotifications(readHere).then(() => performance.mark('dither:tidied'))]);

function onNotify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
  if (!showsHere(ev)) return;
  const r = route.value;
  const here = (!!ev.conversationId && 'conv' in r && r.conv === ev.conversationId) || (!!ev.mailThreadId && 'conv' in r && r.conv === ev.mailThreadId) || (!!ev.noticeId && r.view === 'notices');
  const viewing = here && document.visibilityState === 'visible';
  if (viewing) return;
  // A calendar reminder (docs/calendar.md) opens the calendar where it is.
  const cal = ev.calendar;
  // A notice (docs/notices.md) opens under Notices; its conversation is its group, not a chat.
  const notice = ev.noticeId;
  const open = cal ? () => go({ view: 'calendar', at: calendarAt(cal.open) }) : notice ? () => go({ view: 'notices', notice }) : undefined;
  const conversationId = notice ? undefined : ev.conversationId;
  toast({ kind: 'notify', title: ev.title, body: ev.body, conversationId, reasons: ev.reasons, icon: ev.icon, network: ev.network, ...(open ? { action: open } : {}) }, 8000);
  if (!pref('pushEnabled') && pref('notifications') && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    // A group's own picture goes over the sender's, as in a push (delivery.ts conv).
    const c = ev.conversationId ? db.conversations.get(ev.conversationId) : undefined;
    const conv = c && c.shape !== 'direct' && c.avatar ? { shape: c.shape === 'channel' || c.shape === 'thread' ? 'channel' : 'group', icon: c.avatar } : undefined;
    const show = (reg?: ServiceWorkerRegistration) => {
      // The worker draws the picture and the network's badge, as it does for a push (sw.js).
      // `keep`: a reminder or a held summary, which no read closes (shade.ts).
      if (reg?.active) return reg.active.postMessage({ t: 'notify', d: { title: ev.title, body: ev.body, conversationId: ev.conversationId, inbox: !ev.conversationId && !cal, icon: ev.icon, network: ev.network, nid: ev.nid, ...(conv ? { conv } : {}), ...(cal ? { calendar: cal } : {}), ...(notice ? { noticeId: notice } : {}), ...(ev.keep ? { keep: true } : {}) } });
      const opts = { body: ev.body, tag: cal ? `calendar:${cal.eventKey}` : (ev.conversationId ?? 'dither-inbox'), icon: conv?.icon ?? ev.icon, data: { conversationId: ev.conversationId, inbox: !ev.conversationId && !cal, calendar: cal, notice, ...(ev.keep ? { keep: true } : {}) } };
      if (reg) reg.showNotification(ev.title, opts);
      else new Notification(ev.title, opts).onclick = open ?? (() => go({ view: 'inbox', conv: ev.conversationId }));
    };
    // Not every browser has service workers, and none has them outside a secure context.
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(show, () => show());
    else show();
  }
}

// ------------------------------------------------------------------ timelines

/** `c:` a conversation, `p:` a person's chat, `k:` a channel's stream: its own messages and every thread's. */
export function timelineKey(kind: 'c' | 'p' | 'k', id: string) {
  return `${kind}:${id}`;
}

/** Glances still loading, so that opening one meanwhile can go on once it is in. */
const glancing = new Map<string, Promise<void>>();

/**
 * Where a timeline opened came from (prefetch.ts counts them): already in memory, a glance (Catch up's, or one fetched
 * ahead), a page kept on this device (keptpages.ts), or nothing until the hub answers.
 */
type OpenedFrom = 'memory' | 'glance' | 'kept' | 'hub';
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
    // What pushes brought since, while the hub has not answered (arrived.ts).
    arrivedInto(t);
    if (!o.glance && !older) servedFrom(key, c ? 'kept' : 'hub');
    if (o.glance) t.glance = true;
    else touchTimeline(key);
  }
  if (older && !t.hasMore) return;
  t.loading = true;
  timelineChanged(key);
  const [kind, id] = key.split(':') as ['c' | 'p' | 'k', string];
  // A person's timeline and a channel's stream span conversations, where two messages can share a time: their cursor
  // names the message too.
  const oldest = older ? t.messages[0] : undefined;
  // Mail as chats (mail/chats.ts): an email route or a thread pages from the hub's mail, by time and id as a person's.
  const mail = kind === 'c' && isMailPlace(id);
  const before = oldest ? (kind !== 'c' || mail ? `${oldest.ts}:${encodeURIComponent(oldest.id)}` : oldest.ts) : undefined;
  const url = mail ? mailPageUrl(id) : kind === 'c' ? `/api/conversations/${id}/messages` : kind === 'k' ? `/api/conversations/${id}/stream` : `/api/chats/person:${id}/messages`;
  try {
    // After the socket, so nothing can fall between this page and the live events.
    if (!older) {
      await socketOpen();
      t.fetchedAt = Date.now();
    }
    // A kept copy needs only what changed since it was kept: messages after its newest, and edits inside it.
    const from = t.from;
    // The hub's sync of timelines knows chat only: one with mail is asked for again.
    const caught = !older && !!from && t.messages.length > 0 && !holdsMail(key) ? await syncTimelines([t], () => from) : 'refused';
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
      if (page.elsewhere) t.elsewhere = mergeElsewhere(t.elsewhere, page.elsewhere);
      t.hasMore = page.hasMore;
      got = page.messages.length;
      if (page.conversationIds) t.conversationIds = page.conversationIds;
    }
    // The hub's page came: pushes' copies left here while it loaded go, if the hub has caught up (arrived.ts).
    stripArrived(t);
    if (mail) {
      // Mail has no network to ask for more: the hub holds it, or asks its server itself.
    } else if (kind === 'c' && older) {
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
    } else if (kind === 'k' && ownMessages(id)) {
      // A Matrix room's stream: the room's own latest from the network, as the room alone asks (above), then the
      // stream's own page again, so what is held stays one unbroken span of every thread. Its threads' come with the
      // room's sync; a Zulip channel has none of its own.
      if (older && !t.hasMore) t.hasMore = await streamFromNetwork(t, id, t.messages[0]);
      else if (!older && !t.glance) void streamFromNetwork(t, id).then(() => timelineChanged(key));
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

/** A channel that takes messages of its own (a Matrix room, a Discord text channel): not a forum of threads. */
const ownMessages = (id: string) => {
  const c = db.conversations.get(id);
  return !!c && c.variant !== 'forum' && c.variant !== 'media';
};

/** Ask the conversation's network for messages, then show what the hub stored. Returns whether there may be older ones. */
async function fromNetwork(t: Timeline, conversationId: string, beforeTs?: number): Promise<boolean> {
  const r = await api<{ count?: number; done?: boolean }>(`/api/conversations/${conversationId}/history`, { body: { beforeTs, limit: 50 } }).catch(() => null);
  if (!r?.count) return false;
  const page = await api<P.MessagePage>(`/api/conversations/${conversationId}/messages?limit=60${beforeTs ? `&before=${beforeTs}` : ''}`).catch(() => null);
  page?.identities.forEach(putIdentity);
  for (const m of page?.messages ?? []) upsertInto(t.messages, m);
  return !r.done;
}

/**
 * A stream's room asked of its network (`before`: the oldest held, for older ones), then the stream's page from there:
 * the room's page alone could reach further back than the threads' messages held. Whether there may be older ones.
 */
async function streamFromNetwork(t: Timeline, channelId: string, before?: P.MessageView): Promise<boolean> {
  const r = await api<{ count?: number; done?: boolean }>(`/api/conversations/${channelId}/history`, { body: { beforeTs: before?.ts, limit: 50 } }).catch(() => null);
  if (!r?.count) return false;
  const cursor = before ? `&before=${before.ts}:${encodeURIComponent(before.id)}` : '';
  const page = await api<P.MessagePage>(`/api/conversations/${channelId}/stream?limit=60${cursor}`).catch(() => null);
  page?.identities.forEach(putIdentity);
  for (const m of page?.messages ?? []) upsertInto(t.messages, m);
  return !r.done || !!page?.hasMore;
}

/** Make sure a message is loaded, replacing the window around it if it is not. */
export async function jumpTo(conversationId: string, messageId: string) {
  const key = timelineKey('c', conversationId);
  if (timelines.get(key)?.messages.some((m) => m.id === messageId)) return;
  // A mail place has no page around a message (its messages are mail, not the hub's): page back to it instead.
  if (isMailPlace(conversationId)) {
    if (!(await jumpInChat(key, messageId))) toast({ kind: 'error', title: 'Message not found', body: 'It may have been moved or deleted.' });
    return;
  }
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
 * Open a person's chat (`p:` timeline) or a channel's stream (`k:`) at a message: page back through every route or
 * thread until it is held, so it shows interleaved like any other. The hub has no page around a message across
 * conversations, so a message more than CHAT_JUMP_PAGES pages back is not reached: false, and the page shows its
 * route alone (Timeline.tsx PersonChat), or its thread alone (StreamPane).
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
/** What they wrote elsewhere, by message: newer copies replace older ones. */
function mergeElsewhere(had: P.ElsewhereView[] | undefined, got: P.ElsewhereView[]): P.ElsewhereView[] {
  const by = new Map((had ?? []).map((e) => [e.messageId, e]));
  for (const e of got) by.set(e.messageId, e);
  return [...by.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * A timeline with mail, brought up to date after mail moved (a message, a read, a send): its newest page again, laid
 * over what it holds, so nothing it shows goes away meanwhile.
 */
async function refreshMail(key: string) {
  const t = timelines.get(key);
  if (!t || t.loading || t.detached) return;
  const [kind, id] = [key.slice(0, 1), key.slice(2)];
  const url = kind === 'p' ? `/api/chats/person:${id}/messages` : mailPageUrl(id);
  const page = await api<P.MessagePage>(`${url}?limit=60`).catch(() => null);
  if (!page || timelines.get(key) !== t) return;
  page.identities.forEach(putIdentity);
  for (const m of page.messages) upsertInto(t.messages, m);
  if (page.elsewhere) t.elsewhere = mergeElsewhere(t.elsewhere, page.elsewhere);
  timelineChanged(key);
}

/** Timelines to bring up to date once a burst of mail events is over. */
const mailStale = new Set<string>();
let mailStaleTimer: ReturnType<typeof setTimeout> | undefined;
function mailMoved(keys: string[]) {
  for (const k of keys) if (timelines.has(k)) mailStale.add(k);
  if (!mailStale.size || mailStaleTimer) return;
  mailStaleTimer = setTimeout(() => {
    mailStaleTimer = undefined;
    const ks = [...mailStale];
    mailStale.clear();
    for (const k of ks) void catchUp(k);
  }, 150);
}

function reload(key: string) {
  const t = timelines.get(key);
  if (!t) return Promise.resolve();
  timelines.delete(key);
  // A glance stays one: only opening it asks the network.
  return loadTimeline(key, false, { glance: t.glance }).then(() => {
    const fresh = timelines.get(key);
    if (fresh) for (const m of t.messages) if (!isArrivedCopy(m) && !fresh.messages.some((x) => x.id === m.id)) upsertInto(fresh.messages, m);
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
    if (holdsMail(key)) await refreshMail(key);
    else if (!pos || (await syncTimelines([t], () => pos)) === 'refused') await reload(key);
  } finally {
    catching.delete(key);
    timelineChanged(key);
  }
}

function timelineRequest(t: Timeline, seq: number): P.SyncTimelineRequest {
  // A push's copy (arrived.ts) is not what the timeline holds: the hub is asked from the newest it sent.
  const { newest, oldest } = heldEnds(t.messages);
  return {
    key: t.key,
    seq,
    newest,
    oldest,
    ...(t.detached ? { newer: false } : {}),
    ...(t.key.startsWith('p:') || t.key.startsWith('k:') ? { conversationIds: t.conversationIds ?? [] } : {}),
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
    // One that moved here while away goes from the timeline that held it before.
    if (tl.key.startsWith('c:') || tl.key.startsWith('k:')) for (const m of tl.messages) for (const k of leaveOtherTimelines(timelines.values(), m, streamChannelOf(db, m.conversationId))) timelineChanged(k);
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

async function loadInbox() {
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
    const body = { body: o.body, accountId: o.accountId, replyTo: o.replyTo, attachments: o.attachments, clientId, ...o.media, ...(o.silent ? { silent: true } : {}), ...(o.mentionReplied === false ? { mentionReplied: false } : {}) };
    // Given up with its socket, when that is found dead: its connection likely died too. The retry after the next
    // catch-up carries the same clientId, so the hub answers it with the first one's answer rather than sending twice.
    return api<P.SendResult>(`/api/conversations/${o.conversationId}/send`, { body, signal: link.signal });
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

/**
 * Clears here at once; the hub tells the networks at a pace they accept (readqueue.ts). `ask`: a confirm first, for a
 * server, a folder or everything; a channel and its threads go without one.
 */
export function markAllRead(convs: P.ConversationView[], where: string, ask = true) {
  const ids = convs.filter((c) => c.vantages.some((v) => v.unread || v.mentions)).map((c) => c.id);
  if (!ids.length) return toast({ kind: 'info', title: 'Nothing unread', body: where });
  if (ask && !confirm(`Mark ${ids.length} conversation${ids.length === 1 ? '' : 's'} read in ${where}? This also goes to the networks, and read state cannot be taken back.`)) return;
  // Their notifications on this device have done their job, as markRead's.
  void closeNotifications(ids);
  api<{ marked: number; pending: number }>('/api/read-all', { body: { conversations: ids } })
    .then((r) => (readProgress.value = { pending: r.pending, failed: 0 }))
    .catch((e) => toast({ kind: 'error', title: 'Could not mark read', body: e.message }));
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** When markRead last closed each chat's notification: at the bottom of a chat, every scroll calls it. */
const closedAt = new Map<string, number>();
export function markRead(conversationId: string) {
  // Read here means the notification on this device has done its job, also when the page already held the chat as
  // read: read on another device first, its notification here stays until something closes it.
  const now = Date.now();
  if (now - (closedAt.get(conversationId) ?? 0) > 1000) {
    closedAt.set(conversationId, now);
    void closeNotifications([conversationId]);
  }
  const c = convById(conversationId);
  if (!c || !c.vantages.some((v) => v.unread || v.mentions)) return;
  clearTimeout(readTimers.get(conversationId));
  readTimers.set(
    conversationId,
    setTimeout(() => {
      // Mail as chats: an email route reads its threads, a thread itself (mail/chats.ts).
      if (isMailPlace(conversationId)) {
        const threadIds = isMailThread(conversationId) ? [conversationId] : (db.mail.chats.get(conversationId)?.threadIds ?? []);
        if (threadIds.length) api('/api/mail/flag', { body: { threadIds, seen: true, clientId: `read-${conversationId}-${Date.now()}` } }).catch(() => {});
        return;
      }
      api(`/api/conversations/${conversationId}/read`, { body: {} }).catch(() => {});
    }, 600),
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
    // null takes a mention or pictures setting away: inherited again.
    if (i.mentionScope === null) delete next.mentionScope;
    if (i.mentionSameNetwork === null) delete next.mentionSameNetwork;
    if (i.pictures === null) delete next.pictures;
    db.placePrefs.set(k, next);
  }
  changed(items.every((i) => Object.keys(i).every((k) => k === 'kind' || k === 'id' || k === 'open')) ? 'open' : 'meta');
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
/**
 * The heartbeat: a ping this often while in sight. A socket that does not answer within PONG_WAIT is raced against a
 * new one (probe); with neither the pong nor the new socket within SPARE_WAIT more, it is dead.
 */
const PING_EVERY = 25_000;
const PONG_WAIT = 3000;
const SPARE_WAIT = 5000;
/** A catch-up or bootstrap with nothing coming for this long is given up, as no answer (api.ts hubFetch). */
const SYNC_QUIET = 20_000;
/**
 * A catch-up not answering is asked again on another connection after this many times the round trip the socket took
 * to open, at least HEDGE_MIN, HEDGE_TRIES times in all (api.ts hedged).
 */
const HEDGE_ROUNDS = 4;
const HEDGE_MIN = 1000;
const HEDGE_TRIES = 8;
/** How long the socket in use took to open: the link's round trip as it is now, queues included. */
let openMs = 0;

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
/** Aborts what was asked over the socket in use (its catch-up, bootstrap and sends) once it is found dead or replaced. */
let link = new AbortController();
/** The hub process last synced with; a new one may serve a new build (pwa.ts). */
let hubBoot: string | null = null;
/** Waited for before the first sync: the snapshot read, so a cold start resumes from it rather than from nothing. */
export const beforeSync = { wait: Promise.resolve() as Promise<unknown> };

/** Since when the hub has not answered; null while it does. A start counts as not answering yet. */
let downSince: number | null = Date.now();
/** The same, for the notice's "Since 6:01 PM" (ui/Offline.tsx). */
export const offlineSince = () => downSince;

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
    const early = takeEarly(gen);
    // When this was asked: pushes kept before then are in the answer (arrived.ts doneArrived). One index.html asked for
    // goes by when its socket began, before it was asked: a push kept in between stays for the next start.
    const asked = early?.at ?? Date.now();
    try {
      // As text too: the snapshot keeps the hub's answer as it came, without serializing it again.
      const { res, text } = await hubFetch('/api/bootstrap', { quiet: SYNC_QUIET, signal: link.signal, early });
      if (res.status === 401) {
        let body: { setup?: boolean } | null = null;
        try {
          body = JSON.parse(text);
        } catch {}
        if (isLoginRefusal(res.status, body)) return void needLogin(!!body?.setup);
      }
      if (!res.ok) throw new Error(text.slice(0, 200) || `${res.status}`);
      const b = JSON.parse(text) as P.Bootstrap;
      // What pushes laid over the snapshot goes in the same task as the hub's state comes (arrived.ts).
      dropArrived();
      applyBootstrap(b);
      synced = !!b.sync && ws?.readyState === WebSocket.OPEN && gen === socketGen;
      sawHub(b.boot);
      freshFromHub();
      doneArrived(asked);
      performance.mark('dither:fresh');
      for (const h of freshHooks) h();
      loadInbox().catch(() => {});
      void loadCalls();
      // Timelines asked for before this socket may have missed anything: their newest pages again.
      for (const [key, t] of [...timelines]) if (!t.fetchedAt || t.fetchedAt < since) void reload(key);
      persistSoon(text);
      void flushOutgoing();
    } catch (e: any) {
      // No answer: on the socket it was for, start again with a new one (the next sync asks again); one already
      // replaced has its own on the way.
      if (e instanceof TypeError) noAnswer(gen);
      else toast({ kind: 'error', title: 'Could not load', body: String(e.message) });
    } finally {
      release();
    }
  });
}

/**
 * The socket's catch-up (`Resume`), or null: not one (an older hub), or not come within `every` of the socket opening,
 * the wait after which a catch-up by POST is asked again on another connection (api.ts hedged). A socket that opens
 * and then says nothing is caught up by POST, as before.
 */
function resumeAnswer(sr: Resume, every: number): Promise<P.SyncResponse | null> {
  return new Promise((done) => {
    const t = setTimeout(() => done(null), Math.max(0, openedAt + every - Date.now()));
    void sr.answer.then((r) => (clearTimeout(t), done(r)));
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
    // A snapshot after all (index.html could not tell): the bootstrap it asked for is not wanted.
    takeEarly(gen)?.abort();
    // Timelines in memory are as current as `db`, or as their kept copy when it has not been caught up yet. One
    // kept under another epoch loads afresh; those loading now catch up on their own.
    const mine = [...timelines.values()].filter((t) => !t.loading && (t.fetchedAt || t.from));
    const tls = mine.filter((t) => !t.from || (t.from.v === pos.v && t.from.epoch === pos.epoch));
    let r: P.SyncResponse | null = null;
    let asked = Date.now();
    let onSocket = false;
    const every = Math.max(HEDGE_MIN, HEDGE_ROUNDS * openMs);
    const ask = (body: P.SyncRequest) => hedged((o) => api<P.SyncResponse>('/api/sync', { body, quiet: SYNC_QUIET, ...o }), { every, tries: HEDGE_TRIES, signal: link.signal });
    const tlAsk = tls.map((t) => timelineRequest(t, t.from?.seq ?? pos.seq));
    try {
      // The socket's own catch-up, asked from this copy's position or one before it, came as its first frame (docs/sync.md
      // "On the socket"): no request, no round trip. Timelines are not in it; they are asked for beside it.
      const sr = resume?.gen === gen && resume.from.v === pos.v && resume.from.epoch === pos.epoch && resume.from.seq <= pos.seq ? resume : null;
      let side: Promise<P.SyncResponse> | null = null;
      if (sr) {
        if (tlAsk.length) (side = ask({ v: pos.v, epoch: pos.epoch, timelines: tlAsk })).catch(() => {});
        r = await resumeAnswer(sr, every);
        // An answer older than this copy, or a refusal of a position older than its own: asked by POST, from its own.
        if (r && (r.full ? sr.from.seq < pos.seq : r.sync.epoch !== pos.epoch || r.sync.seq < pos.seq)) r = null;
        if (r) (asked = sr.startedAt), (onSocket = true);
        else side = null;
      }
      r ??= await ask({ v: pos.v, epoch: pos.epoch, since: pos.seq, timelines: tlAsk });
      if (side && !r.full) {
        const t = await side;
        // Refused (another epoch since): those timelines load afresh below.
        r = t.full ? { ...r, timelines: [] } : { ...r, timelines: t.timelines, identities: [...r.identities, ...t.identities], quoted: [...r.quoted, ...t.quoted] };
        if (t.full) tls.length = 0;
      }
    } catch (e) {
      release();
      // No answer (or given up): the next socket tries again. An answer that is an error (a hub without /api/sync)
      // means starting over.
      if (e instanceof TypeError) noAnswer(gen);
      else void bootstrap();
      return;
    }
    if (r.full) {
      release();
      void bootstrap();
      return;
    }
    // What pushes laid over the snapshot goes in the same task as the hub's answer comes (arrived.ts).
    dropArrived();
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
    doneArrived(asked);
    // Which way the catch-up came, for verify-sync.ts.
    performance.mark('dither:fresh', { detail: { socket: onSocket } });
    for (const h of freshHooks) h();
    release();
    persistSoon();
    void flushOutgoing();
  });
}

/**
 * A catch-up for socket `gen` got no answer. Still the socket in use: it answers pings but its catch-up did not come
 * (a connection that died under the request), so it goes, and a new one after the backoff asks again. Without that the
 * app would stay uncaught-up on a socket that looks fine.
 */
function noAnswer(gen: number) {
  if (gen === socketGen && ws) dropped();
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

/** Called each time the live socket opens: what the hub held about this page went with the old one. */
export const socketOpenHooks = new Set<() => void>();

/** Says something to the hub over the live socket (`P.ClientWatching`); false when it is not open. */
export function sayLive(msg: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(msg);
    return true;
  } catch {
    return false;
  }
}

const liveUrl = (from?: P.SyncPosition | null) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live${from ? `?v=${from.v}&epoch=${encodeURIComponent(from.epoch)}&since=${from.seq}` : ''}`;


/**
 * What a socket asked from a position brings as its first frame: the catch-up from `from`, which `answer` settles
 * with; null when it does not come (an older hub, the socket gone). `startedAt`: the socket was asked for then, so
 * the answer covers what was kept before it (arrived.ts).
 */
interface Resume {
  sock: WebSocket;
  gen: number;
  from: P.SyncPosition;
  startedAt: number;
  answer: Promise<P.SyncResponse | null>;
  settle: (r: P.SyncResponse | null) => void;
  /** Its first frame has come. */
  seen: boolean;
}
let resume: Resume | null = null;

/** The catch-up frame: text, or gzip'd when long. */
async function readResume(data: unknown): Promise<P.SyncResponse | null> {
  const text =
    typeof data === 'string'
      ? data
      : await new Response((data instanceof Blob ? data : new Blob([data as ArrayBuffer])).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return (JSON.parse(text) as P.LiveResume).resume ?? null;
}

/**
 * What index.html started before this script came (its first inline script): the live socket, the frames it got
 * meanwhile, and on a device that keeps no snapshot, the bootstrap, asked for once that socket was open.
 */
interface Early {
  ws: WebSocket | null;
  /** The position it asked to be caught up from, kept by snapshot.ts where index.html can read it. */
  from?: P.SyncPosition | null;
  at: number;
  openedAt: number;
  frames: unknown[];
  boot: Promise<Response> | null;
  abort: (() => void) | null;
  /** Set here once the app has asked for its own (or decided it wants none): index.html asks for nothing after. */
  taken: boolean;
}
let early: Early | null = (globalThis as { __ditherEarly?: Early }).__ditherEarly ?? null;
/** The early socket's generation, while its bootstrap is not taken: it is the bootstrap of that socket only. */
let earlyOf: { e: Early; gen: number } | null = null;

/** The bootstrap index.html asked for, if it belongs to socket `gen`; asked for once, so taken once. */
function takeEarly(gen: number): { res: Promise<Response>; abort: () => void; at: number } | undefined {
  const o = earlyOf;
  if (!o) return undefined;
  earlyOf = null;
  o.e.taken = true;
  if (!o.e.boot) return undefined;
  const abort = o.e.abort ?? (() => {});
  if (o.gen !== gen) return void abort();
  return { res: o.e.boot, abort, at: o.e.at };
}

export function connect() {
  clearTimeout(retry);
  const e = early;
  early = null;
  // Signed out: nothing to connect to until the sign-in screen has reloaded the page (login.ts).
  if (login.value) {
    if (e) (e.taken = true), e.abort?.(), e.ws?.close();
    return;
  }
  if (!connected.value) setConnected(false);
  if (e?.ws && e.ws.readyState <= WebSocket.OPEN) {
    socketStartedAt = e.at;
    use(e.ws, e.at, e, e.from ?? null);
    // No sync is asked for before the snapshot is read, so the socket's own catch-up finds this here.
    earlyOf = { e, gen: socketGen };
  } else {
    if (e) (e.taken = true), e.abort?.();
    socketStartedAt = Date.now();
    // Asked from this copy's position, once there is one: a hub that can answers LIVE_RESUME and sends the catch-up as
    // its first frame (docs/sync.md "On the socket"). Only where a long one can be read (gzip'd: DecompressionStream).
    const from = loaded.value && db.sync?.v === SYNC_VERSION && typeof DecompressionStream === 'function' ? db.sync : null;
    use(from ? new WebSocket(liveUrl(from), [LIVE_PROTOCOL, LIVE_RESUME]) : new WebSocket(liveUrl()), socketStartedAt, undefined, from);
  }
  // The socket gets its own connection; this one opens the HTTP connection the sync will use, at the same time.
  fetch('/api/health', { cache: 'no-store' }).catch(() => {});
}

/**
 * `sock` is the live socket from now: a new one, a spare that won its race (probe), already open, or the one index.html
 * opened (`e`), with the frames that came before this script did.
 */
function use(sock: WebSocket, startedAt: number, e?: Early, from: P.SyncPosition | null = null) {
  ws = sock;
  synced = false;
  socketGen++;
  link.abort();
  link = new AbortController();
  resume?.settle(null);
  resume = null;
  if (from) {
    let settle!: (r: P.SyncResponse | null) => void;
    const answer = new Promise<P.SyncResponse | null>((r) => (settle = r));
    resume = { sock, gen: socketGen, from, startedAt, answer, settle, seen: false };
  }
  // A bootstrap of a socket no longer in use: its frames will not come to this page.
  if (earlyOf) takeEarly(-1);
  const onopen = () => {
    if (ws !== sock) return;
    // An older hub: no catch-up will come on it.
    if (resume?.sock === sock && sock.protocol !== LIVE_RESUME) resume.settle(null);
    setConnected(true);
    backoff = 500;
    openedAt = lastPong = Date.now();
    openMs = (e?.openedAt || openedAt) - startedAt;
    markOpen?.();
    opened = markOpen = null;
    held ??= [];
    void resync();
    void loadPlans();
    for (const h of socketOpenHooks) h();
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    // The catch-up it asked for, before any live frame (docs/sync.md "On the socket"); resync takes it.
    const r = resume?.sock === sock && !resume.seen && sock.protocol === LIVE_RESUME ? resume : null;
    if (r && (typeof e.data !== 'string' || e.data.startsWith('{"resume"'))) {
      r.seen = true;
      return void readResume(e.data).then(r.settle, () => r.settle(null));
    }
    if (e.data === 'pong') {
      lastPong = Date.now();
      clearTimeout(pongTimer);
      // Late, but here before a new socket was: a busy link, not a dead socket.
      endRace();
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
    if (ws !== sock) return;
    // Refused before it opened: maybe this device is not signed in (the hub answers the upgrade with 401, which a
    // socket cannot read). /api/login says.
    if (sock.readyState === WebSocket.CLOSED && openedAt < socketStartedAt) void checkSignedIn();
    dropped();
  };
  sock.onopen = onopen;
  if (sock.readyState === WebSocket.OPEN) onopen();
  // Held behind the catch-up onopen began, as any frame that comes while it is on its way.
  for (const data of e?.frames.splice(0) ?? []) sock.onmessage?.call(sock, new MessageEvent('message', { data }));
}

let socketStartedAt = 0;
/** Whether this device still has a session; the sign-in screen when not (login.ts). */
async function checkSignedIn() {
  try {
    const r = await fetch('/api/login', { cache: 'no-store' });
    if (!r.ok) return;
    const b = (await r.json()) as { signedIn?: boolean; passwordSet?: boolean };
    if (b.signedIn === false) needLogin(!b.passwordSet);
  } catch {}
}

/** The socket is gone, or as good as: forget it now rather than wait for its close to time out. */
function dropped(since = Date.now()) {
  retire(ws);
  ws = null;
  synced = false;
  link.abort();
  resume?.settle(null);
  endRace();
  setConnected(false, since);
  clearTimeout(retry);
  retry = setTimeout(connect, (backoff = Math.min(backoff * 2, 15_000)));
}

/** A socket no longer the app's: closed without a word to its handlers. */
function retire(old: WebSocket | null) {
  clearTimeout(pongTimer);
  if (!old) return;
  old.onopen = old.onmessage = old.onclose = null;
  try {
    old.close();
  } catch {}
}

/** Back on the network or back in front of the user while disconnected: try now rather than at the end of the backoff. */
function reconnectNow() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  clearTimeout(retry);
  backoff = 500;
  connect();
}

/**
 * The notice's Try now (ui/Offline.tsx): a new socket at once, even over one still trying, rather than at the end of
 * the backoff. Says whether that socket opened, once it has opened or failed.
 */
export function tryNow(): Promise<boolean> {
  if (ws && ws.readyState !== WebSocket.OPEN) dropped();
  reconnectNow();
  const sock = ws;
  if (!sock) return Promise.resolve(false);
  if (sock.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((done) => {
    sock.addEventListener('open', () => done(true), { once: true });
    sock.addEventListener('close', () => done(false), { once: true });
    // A network that drops packets without a word can hold a socket half-open for a long while: no answer yet, after 5 s.
    setTimeout(() => done(false), 5000);
  });
}

/**
 * Is the socket alive? A phone that slept or switched networks can hold one that looks open and is not. Without an
 * answer within PONG_WAIT, a new socket races the pong: on a dead socket the new one opens first and takes its place,
 * with nothing shown; on a link busy with a download the pong was queued first and comes first, and the socket stays.
 * A fixed wait cannot tell the two apart: behind a router's queue of 4 s at 1.5 Mbit/s a pong takes 4 s and more
 * (scripts/verify-link.ts). Neither within SPARE_WAIT: the socket is dropped, and the notice shows.
 */
function probe() {
  if (!ws || ws.readyState === WebSocket.CLOSED) return reconnectNow();
  if (ws.readyState !== WebSocket.OPEN || race) return;
  const sock = ws;
  const sent = Date.now();
  try {
    sock.send('ping');
  } catch {
    return dropped();
  }
  clearTimeout(pongTimer);
  pongTimer = setTimeout(() => {
    if (ws === sock && lastPong < sent && !race) startRace(sock, sent);
  }, PONG_WAIT);
}

/** A new socket racing the pong of `old`'s ping at `sent` (probe). */
let race: { spare: WebSocket; deadline: ReturnType<typeof setTimeout> } | null = null;

function startRace(old: WebSocket, sent: number) {
  const spare = new WebSocket(liveUrl());
  const startedAt = Date.now();
  const lost = () => {
    if (race?.spare !== spare) return;
    endRace();
    if (ws !== old) return;
    dropped(sent);
    reconnectNow();
  };
  race = { spare, deadline: setTimeout(lost, SPARE_WAIT) };
  spare.onopen = () => {
    if (race?.spare !== spare) return;
    if (ws !== old) return endRace();
    clearTimeout(race.deadline);
    race = null;
    // The old one is dead: this one takes its place, and catches up with a delta like any new socket.
    retire(old);
    use(spare, startedAt);
  };
  // Refused or unreachable: the hub is out of reach.
  spare.onclose = lost;
}

function endRace() {
  if (!race) return;
  const { spare, deadline } = race;
  race = null;
  clearTimeout(deadline);
  spare.onopen = spare.onclose = null;
  try {
    spare.close();
  } catch {}
}

if (typeof window !== 'undefined') {
  const wake = () => document.visibilityState === 'visible' && probe();
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  setInterval(() => document.visibilityState === 'visible' && probe(), PING_EVERY);
}

// ------------------------------------------------------------------ translation (docs/translate.md)

/** The hub's translation settings and the networks that translate their own posts; null until first asked. */
export const translation = signal<{ settings: P.TranslateSettings; networks: P.Network[] } | null>(null);
let translationAsked: Promise<void> | null = null;
/** Asks the hub once (again when `fresh`): what a post's text needs to know to translate itself. */
export function loadTranslation(fresh = false): Promise<void> {
  if (!translationAsked || fresh)
    translationAsked = api<{ settings: P.TranslateSettings; networks: P.Network[] }>('/api/translate/settings').then(
      (v) => void (translation.value = v),
      () => void (translationAsked = null),
    );
  return translationAsked;
}
/** Changes some settings on the hub (Settings → Translation); the page follows at once. */
export async function setTranslation(patch: Partial<P.TranslateSettings>): Promise<void> {
  translation.value = await api<{ settings: P.TranslateSettings; networks: P.Network[] }>('/api/translate/settings', { method: 'PUT', body: patch });
}

// The maps above that live as long as the page, for verify-memory.ts (docs/perf.md "Memory"): read under ?perf=1 only.
sized('readTimers', () => readTimers.size);
sized('readClosedAt', () => closedAt.size);
sized('glancing', () => glancing.size);
sized('outgoing', () => outgoing.size);
sized('sendUploads', () => sendUploads.size);
sized('editDrafts', () => editDrafts.size);
