/**
 * Measures where you spend your time, on this device, and sends it to the hub in batches so every device
 * sorts the same way (docs/organize.md). Counted only while the app is in front, focused and in use, and
 * only for the place that is open. Ids, seconds and times: never what was said.
 */
import { effect, signal } from '@preact/signals';
import { addDecayed, type UsageDelta, type UsageKind, type UsageState, type UsageView } from '@dither-chat/protocol';
import { IDLE_AFTER, NEW_VISIT_AFTER, Tracker, type Acc } from './tracker.ts';
import { placeConv, rootCommunity } from './model.ts';
import { api, db, route, type Route } from './state.ts';

/** The usage keys a conversation counts for: the person for a DM; else the conversation and its community. */
export function keysOfConv(convId: string): string[] {
  const c0 = db.conversations.get(convId);
  if (!c0) return [];
  const c = placeConv(c0);
  if (c.shape === 'direct' && c.peerPersonId) return [`person:${c.peerPersonId}`];
  const out = [`conversation:${c.id}`];
  const root = c.spaceIds.length ? rootCommunity(c.spaceIds[0]) : null;
  if (root) out.push(`space:${root.id}`);
  return out;
}

export function keysOfRoute(r: Route): string[] {
  const out = new Set<string>();
  if ('conv' in r && r.conv) keysOfConv(r.conv).forEach((k) => out.add(k));
  if (r.view === 'space') out.add(`space:${rootCommunity(r.space)?.id ?? r.space}`);
  if ((r.view === 'people' || r.view === 'folder') && r.person) out.add(`person:${r.person}`);
  return [...out];
}

// ------------------------------------------------------------------ what the hub knows

const OUTBOX_KEY = 'dither-chat:usage-outbox';
const PENDING_KEY = 'dither-chat:usage-pending';

/** The hub's totals, fetched at start and when the app comes back to the front. */
export const usageState = signal<UsageState | null>(null);
export const usageLoaded = signal(false);

type Batch = { batch: string; deltas: UsageDelta[] };
const read = <T>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '') ?? d;
  } catch {
    return d;
  }
};
let outbox: Batch[] = typeof localStorage !== 'undefined' ? read<Batch[]>(OUTBOX_KEY, []) : [];

/** Usage as the hub has it plus what this device has not sent yet. */
export function usageOf(kind: UsageKind, id: string): Pick<UsageView, 'score' | 'visitScore' | 'at' | 'lastVisit'> | null {
  const k = `${kind}:${id}`;
  return local().get(k) ?? null;
}

let localCache: { state: UsageState | null; stamp: number; map: Map<string, Pick<UsageView, 'score' | 'visitScore' | 'at' | 'lastVisit'>> } | null = null;
let stamp = 0;
function local() {
  if (localCache && localCache.state === usageState.value && localCache.stamp === stamp) return localCache.map;
  const map = new Map<string, Pick<UsageView, 'score' | 'visitScore' | 'at' | 'lastVisit'>>();
  for (const u of usageState.value?.places ?? []) map.set(`${u.kind}:${u.id}`, u);
  const add = (d: UsageDelta) => {
    const k = `${d.kind}:${d.id}`;
    const cur = map.get(k);
    const next = addDecayed(cur ?? null, d);
    map.set(k, { ...next, lastVisit: Math.max(cur?.lastVisit ?? 0, d.lastVisit ?? 0) || null });
  };
  for (const b of outbox) b.deltas.forEach(add);
  for (const [k, a] of tracker?.pending ?? []) {
    const i = k.indexOf(':');
    add({ kind: k.slice(0, i) as UsageKind, id: k.slice(i + 1), ...a });
  }
  localCache = { state: usageState.value, stamp, map };
  return map;
}

export async function fetchUsage(): Promise<UsageState | null> {
  try {
    const s = await api<UsageState>('/api/usage');
    usageState.value = s;
    return s;
  } catch {
    return null;
  } finally {
    usageLoaded.value = true;
  }
}

async function flush(leaving = false) {
  if (!tracker) return;
  tick();
  const deltas = tracker.take();
  if (deltas.length) outbox.push({ batch: Math.random().toString(36).slice(2) + Date.now().toString(36), deltas });
  outbox = outbox.slice(-50);
  save();
  for (const b of [...outbox]) {
    try {
      const res = await fetch('/api/usage', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' }, keepalive: leaving });
      if (!res.ok) break;
      outbox = outbox.filter((x) => x !== b);
      save();
    } catch {
      // Offline: the batch waits, with its id, so the hub can tell a resend from a new one.
      break;
    }
  }
}

function save() {
  stamp++;
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    localStorage.setItem(PENDING_KEY, JSON.stringify([...(tracker?.pending ?? [])]));
  } catch {}
}

/** Forget everything measured, on every device. */
export async function resetUsage() {
  tracker?.take();
  outbox = [];
  save();
  await api('/api/usage', { method: 'DELETE', body: {} });
  usageState.value = usageState.value ? { ...usageState.value, places: [] } : null;
}

// ------------------------------------------------------------------ wiring

let tracker: Tracker | null = null;
let lastInput = Date.now();
let hiddenAt: number | null = null;
/** Called when the app comes back to the front, after the hub's totals are fresh. */
export const onForeground = new Set<() => void>();

const inUse = () => document.visibilityState === 'visible' && document.hasFocus() && Date.now() - lastInput < IDLE_AFTER;
const tick = () => {
  tracker?.update(Date.now(), keysOfRoute(route.value), inUse());
  save();
};

export function startUsage() {
  if (tracker || typeof window === 'undefined') return;
  tracker = new Tracker(Date.now());
  // What was measured but not yet sent when the app last closed.
  for (const [k, a] of read<[string, Acc][]>(PENDING_KEY, [])) tracker.pending.set(k, a);
  effect(() => {
    route.value;
    tick();
  });
  const input = () => {
    const was = Date.now() - lastInput >= IDLE_AFTER;
    if (was) tick();
    lastInput = Date.now();
    if (was) tick();
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(ev, input, { passive: true, capture: true });
  window.addEventListener('focus', tick);
  window.addEventListener('blur', tick);
  document.addEventListener('visibilitychange', () => {
    tick();
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      flush(true);
      return;
    }
    lastInput = Date.now();
    if (hiddenAt && Date.now() - hiddenAt > NEW_VISIT_AFTER) tracker?.newStay();
    hiddenAt = null;
    tick();
    fetchUsage().then(() => onForeground.forEach((f) => f()));
  });
  window.addEventListener('pagehide', () => flush(true));
  setInterval(tick, 5000);
  setInterval(() => flush(), 60_000);
  flush();
  fetchUsage();
}

/** For the Organize view: decayed minutes over roughly the last week, and the last visit. */
export function usageSummary(kind: UsageKind, id: string, now = Date.now()): { minutes: number; lastVisit: number | null } {
  const u = usageOf(kind, id);
  if (!u) return { minutes: 0, lastVisit: null };
  return { minutes: (u.score * 2 ** (-(now - u.at) / (usageState.value?.halfLife ?? 7 * 86_400_000))) / 60, lastVisit: u.lastVisit };
}

