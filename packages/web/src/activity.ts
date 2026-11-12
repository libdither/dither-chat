/**
 * The activity log, on this device (docs/activity.md): one record per stay on a screen or place, how the user got
 * there, and what they did; and what became of each notification. Sent to the hub in batches, like usage.ts, and
 * kept only there. Ids, times and counts: never what was said, and never what was typed into search.
 *
 * How the user got somewhere is read from where they clicked (a capture listener: the rail, an inbox row and its
 * rank, a search result, a toast, a link in a timeline) and from history (back, forward). A notification tap
 * arrives as a hash carrying the push's id (`?n=`), from sw.js or the Android app.
 */
import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { placeConv, rootCommunity } from './model.ts';
import { api, apiHooks, db, eventHooks, href, listUnderHooks, parseHash, route, showsHere, type Route } from './state.ts';
import { NEW_VISIT_AFTER } from './tracker.ts';
import { inUse } from './usage.ts';
import { VisitLog, firstTap, samePlace, type Arrival, type Place } from './visits.ts';
import { viewer } from './ui/Viewer.tsx';

const DEVICE_KEY = 'dither-chat:device';
const OUTBOX_KEY = 'dither-chat:activity-outbox';
/** Push ids this device already opened from (visits.ts `firstTap`). */
const TAPPED_KEY = 'dither-chat:tapped';
/** A click this recent decides how the next place was reached. */
const CLICK_WINDOW = 2000;

/** What the hub says about the log: on or off, retention, how much is kept. */
export const activityInfo = signal<P.ActivityInfo | null>(null);

// ------------------------------------------------------------------ this device

const isAndroid = () => !!(globalThis as any).DitherAndroid;

export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) localStorage.setItem(DEVICE_KEY, (id = 'dev-' + Math.random().toString(36).slice(2, 12)));
    return id;
  } catch {
    return 'dev-unknown';
  }
}

/** "Firefox on Linux", "Android app": enough to tell devices apart in an export. */
export function deviceLabel(ua = navigator.userAgent): string {
  if (isAndroid()) return 'Android app';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  return `${browser} on ${os}`;
}

// ------------------------------------------------------------------ where the user is

function convPlace(id: string): Place {
  const c0 = db.conversations.get(id);
  const c = c0 ? placeConv(c0) : null;
  const root = c?.spaceIds.length ? rootCommunity(c.spaceIds[0]) : null;
  return { view: 'conversation', conversationId: id, personId: c?.shape === 'direct' ? (c.peerPersonId ?? null) : null, spaceId: root?.id ?? c?.spaceIds[0] ?? null };
}

export function placeOf(r: Route): Place {
  switch (r.view) {
    case 'inbox':
      return r.conv ? convPlace(r.conv) : { view: 'inbox' };
    case 'search':
      return r.conv ? convPlace(r.conv) : { view: 'search' };
    case 'space':
      return r.conv ? { ...convPlace(r.conv), spaceId: rootCommunity(r.space)?.id ?? r.space } : { view: 'space', spaceId: rootCommunity(r.space)?.id ?? r.space };
    case 'folder':
      return r.conv ? convPlace(r.conv) : r.person ? { view: 'person', personId: r.person } : { view: 'folder' };
    case 'people':
      return r.person ? { view: 'person', personId: r.person } : { view: 'people' };
    case 'profile':
      return r.conv ? convPlace(r.conv) : r.space ? { view: 'space', spaceId: rootCommunity(r.space)?.id ?? r.space } : { view: 'profile', personId: r.person ?? null };
    // How it sorts is triage's own page.
    case 'model':
      return { view: 'triage' };
    default:
      return { view: r.view };
  }
}

/** How a click got the user somewhere, from where it landed. */
export function arrivalOf(el: Element | null): Arrival {
  if (!el) return { source: 'other' };
  if (el.closest('.toast')) return { source: 'toast' };
  if (el.closest('.rail, .tabbar')) return { source: 'rail' };
  if (el.closest('.switcher, .search-pane, .search-place')) return { source: 'search' };
  if (el.closest('.board, .catchup')) return { source: 'triage' };
  const row = el.closest('[data-row]');
  const list = row?.closest('.sidebar-inner');
  // The inbox's list: its rank counts across the sections, top to bottom.
  if (row && list?.classList.contains('inbox-side')) {
    const id = row.getAttribute('data-row')!;
    const a = db.attention.get(id);
    return { source: 'inbox', rank: [...list.querySelectorAll('[data-row]')].indexOf(row), score: a ? Math.round(a.score * 10) / 10 : null, needs: a?.needs ?? null };
  }
  if (row || el.closest('.sidebar')) return { source: 'list' };
  if (el.closest('.timeline-scroll, .conv-head, .details, .pane')) return { source: 'link' };
  return { source: 'other' };
}

/**
 * The deepest inbox row on screen now (0 = top, counted as an inbox row's `rank` is), or null when the inbox's list
 * is not on screen. Numbers only: no row is named.
 */
export function inboxDepth(): number | null {
  if (document.visibilityState !== 'visible') return null;
  const list = document.querySelector('.sidebar-inner.inbox-side');
  const scroll = list?.querySelector('.side-scroll');
  if (!list || !scroll) return null;
  const box = scroll.getBoundingClientRect();
  const bottom = Math.min(box.bottom, window.innerHeight);
  if (box.height <= 0 || box.right <= 0 || box.left >= window.innerWidth || box.top >= bottom) return null;
  const rows = list.querySelectorAll('[data-row]');
  // The last row whose top is above the list's bottom edge.
  let lo = 0;
  let hi = rows.length - 1;
  let deepest = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().top < bottom) {
      deepest = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return deepest >= 0 ? deepest : null;
}

// ------------------------------------------------------------------ state

let log: VisitLog | null = null;
let enabled = true;
let pending: (Arrival & { at: number }) | null = null;
/** The latest in-app notification per conversation ('' for the inbox), for a toast's tap. */
const toastNid = new Map<string, string>();
/** Hashes this tab moved through, to tell back from forward. */
const trail: string[] = [];
/** Snapshots not yet on the hub, by visit id: a later snapshot replaces an earlier one. */
let outbox = new Map<string, P.VisitRecord>();
let events: P.NotificationEvent[] = [];
const sentIds = new Set<string>();

const save = () => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify({ visits: [...outbox.values()], events }));
  } catch {}
};
function load() {
  try {
    const o = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? 'null');
    outbox = new Map((o?.visits ?? []).map((v: P.VisitRecord) => [v.id, v]));
    events = o?.events ?? [];
  } catch {}
}

function collect() {
  if (!log) return;
  for (const v of log.take()) outbox.set(v.id, v);
  save();
}

/** A tap's id from a notification's hash (`…?n=<id>`). */
export const pushIdOf = (hash: string): string | null => new URLSearchParams(hash.split('?')[1] ?? '').get('n');

/** A tap's id, if this device has not opened from that push before; a replayed launch intent gives null. */
function freshTap(id: string | null): string | null {
  if (!id) return null;
  let seen: string[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(TAPPED_KEY) ?? '[]');
    if (!Array.isArray(seen)) seen = [];
  } catch {}
  const t = firstTap(seen, id);
  if (!t.fresh) return null;
  try {
    localStorage.setItem(TAPPED_KEY, JSON.stringify(t.seen));
  } catch {}
  return id;
}

function event(id: string, kind: P.NotificationEventKind) {
  if (!enabled) return;
  events.push({ id, event: kind, device: deviceId(), at: Date.now() });
  save();
}

/**
 * A notification was tapped and the app is about to open `hash` (sw.js's `open` message, the Android app's intent).
 * Call before navigating. Already there, the tap starts a new stay; a stay begun a moment ago by coming to the front
 * is relabelled as the tap.
 */
export function noteOpen(hash: string) {
  if (!log || !enabled) return;
  const id = pushIdOf(hash);
  const pushId = freshTap(id);
  // The same push again is the app replaying how it was launched, not a tap.
  if (id && !pushId) return;
  const arrival: Arrival = { source: 'notification', pushId };
  if (pushId) event(pushId, 'tapped');
  const now = Date.now();
  const place = placeOf(parseHash(hash.startsWith('#') ? hash : `#${hash}`));
  if (log.current && samePlace(log.current, place)) {
    if (!log.relabel(now, arrival, 3000)) log.restart(now, arrival, inUse());
    collect();
    return;
  }
  pending = { ...arrival, at: now };
}

function onRoute(r: Route) {
  if (!log || !enabled) return;
  const now = Date.now();
  const place = placeOf(r);
  let arrival: Arrival = pending && now - pending.at < CLICK_WINDOW ? pending : { source: 'other' };
  if (arrival.source === 'toast') arrival = { ...arrival, pushId: toastNid.get(place.conversationId ?? '') ?? null };
  // A thread opened from the conversation it hangs off.
  const cur = log.current;
  if (cur?.conversationId && place.conversationId && cur.conversationId !== place.conversationId && db.conversations.get(place.conversationId)?.shape === 'thread') log.note('threads');
  if (log.enter(now, place, arrival, inUse())) pending = null;
  // The list as the stay begins, once it has drawn.
  requestAnimationFrame(() => log?.saw(inboxDepth()));
  if (trail[trail.length - 1] !== location.hash) trail.push(location.hash);
  if (trail.length > 100) trail.splice(0, trail.length - 100);
  collect();
}

// ------------------------------------------------------------------ to the hub

let flushing = false;
async function flush(leaving = false) {
  if (!log || flushing) return;
  flushing = true;
  try {
    log.update(Date.now(), inUse());
    collect();
    const post = (path: string, body: unknown) =>
      fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, keepalive: leaving }).then((r) => (r.ok ? r.json() : null));
    if (events.length) {
      const batch = events.slice(0, 200);
      const r = await post('/api/activity/notifications', { events: batch });
      if (r) events = events.filter((e) => !batch.includes(e));
      if (r?.enabled === false) stopRecording();
    }
    if (outbox.size) {
      const batch = [...outbox.values()].slice(0, 300);
      const r = await post('/api/activity/visits', { visits: batch });
      // What changed while this was on its way stays to go again; the hub keeps the latest of each.
      if (r) for (const v of batch) if (outbox.get(v.id) === v) outbox.delete(v.id);
      if (r?.enabled === false) stopRecording();
    }
    save();
  } catch {
    // Offline: it waits, and the hub tells a resend from news by the visits' own ids.
  } finally {
    flushing = false;
  }
}

function stopRecording() {
  enabled = false;
  outbox.clear();
  events = [];
  log?.close(null);
  log?.take();
  save();
}

export async function fetchActivity(): Promise<P.ActivityInfo | null> {
  try {
    const info = await api<P.ActivityInfo>('/api/activity');
    activityInfo.value = info;
    const was = enabled;
    enabled = info.settings.enabled;
    if (!enabled && was) stopRecording();
    if (enabled && !was) onRoute(route.value);
    return info;
  } catch {
    return null;
  }
}

export async function setActivitySettings(p: Partial<P.ActivitySettings>) {
  await api('/api/activity/settings', { method: 'PUT', body: p });
  return fetchActivity();
}

export async function deleteActivity() {
  stopRecording();
  await api('/api/activity', { method: 'DELETE', body: {} });
  return fetchActivity();
}

// ------------------------------------------------------------------ wiring

export function startActivity() {
  if (log || typeof window === 'undefined') return;
  load();
  log = new VisitLog(deviceId(), deviceLabel(), Date.now());
  // Opened by a tap on a notification: the hash carries its id. The address bar does not keep it. The Android app made
  // again after Android stopped it starts from the hash it was first launched with: an old push's id is a start.
  const hashId = pushIdOf(location.hash);
  const nid = freshTap(hashId);
  if (nid) {
    pending = { source: 'notification', pushId: nid, at: Date.now() };
    event(nid, 'tapped');
  } else pending = { source: 'start', at: Date.now() };
  if (hashId) history.replaceState(history.state, '', href(route.value));

  document.addEventListener('click', (e) => (pending = { ...arrivalOf(e.target as Element), at: Date.now() }), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && (e.target as Element)?.closest?.('.switcher')) pending = { source: 'search', at: Date.now() };
    },
    true,
  );
  // A list put under a page in history is an entry too, so back from the page onto it counts as back.
  listUnderHooks.add((list, page) => {
    if (trail[trail.length - 1] === page) trail.splice(trail.length - 1, 0, list);
    else trail.push(list);
  });
  window.addEventListener('popstate', () => {
    const back = trail.length > 1 && trail[trail.length - 2] === location.hash;
    if (back) trail.pop();
    else trail.push(location.hash);
    pending = { source: back ? 'back' : 'forward', at: Date.now() };
  });
  effect(() => onRoute(route.value));

  // What happened during the stay, from the calls the app makes.
  apiHooks.add((path, init) => {
    if (!log || !enabled) return;
    const body = (init?.body ?? {}) as Record<string, any>;
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/send$/))) {
      // A retry of the same send is not another message.
      if (body.clientId && sentIds.has(body.clientId)) return;
      if (body.clientId) sentIds.add(body.clientId);
      log.note('sent', m[1]);
    } else if (/^\/api\/messages\/[\w-]+\/react$/.test(path)) {
      if (!body.remove) log.note('reactions');
    } else if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/read$/))) {
      const last = db.conversations.get(m[1])?.lastMessage;
      if (last) log.read(m[1], last.id, last.ts);
    } else if (/[?&]before=/.test(path)) log.note('history');
    collect();
  });
  let viewing = false;
  effect(() => {
    const open = !!viewer.value;
    if (open && !viewing) log?.note('attachments');
    viewing = open;
  });
  document.addEventListener('click', (e) => (e.target as Element)?.closest?.('.att-file') && log?.note('attachments'), true);

  // The in-app notification, shown instead of a system one while the app is open.
  eventHooks.add((ev) => {
    if (ev.t !== 'notify' || !ev.nid || !showsHere(ev)) return;
    toastNid.set(ev.conversationId ?? '', ev.nid);
    if (document.visibilityState === 'visible') event(ev.nid, 'inapp');
  });

  const tick = () => {
    log?.update(Date.now(), inUse());
    log?.saw(inboxDepth());
  };
  // How far down the inbox you looked: its list scrolled.
  let looking = false;
  document.addEventListener(
    'scroll',
    (e) => {
      if (looking || !(e.target as Element)?.closest?.('.inbox-side')) return;
      looking = true;
      requestAnimationFrame(() => {
        looking = false;
        log?.saw(inboxDepth());
      });
    },
    true,
  );
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    tick();
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      void flush(true);
      return;
    }
    // Back after a long time away: the place still open is a new stay.
    if (hiddenAt && Date.now() - hiddenAt > NEW_VISIT_AFTER && enabled) log?.restart(Date.now(), { source: 'resume' }, inUse());
    if (hiddenAt && Date.now() - hiddenAt > 60_000) void fetchActivity();
    hiddenAt = null;
  });
  window.addEventListener('focus', tick);
  window.addEventListener('blur', tick);
  window.addEventListener('pagehide', () => void flush(true));
  setInterval(tick, 5000);
  setInterval(() => void flush(), 60_000);
  void fetchActivity().then(() => flush());
}
