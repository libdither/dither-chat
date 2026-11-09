/**
 * Button counts on this device (docs/button-counts.md): off until switched on here, in Settings → Usage. While on,
 * every click on a control is counted by its key (clicks.ts), the page and the kind of device, and the counts go to
 * the hub every minute and when the app is put away. Off: nothing is counted, and what was waiting is dropped.
 */
import { signal } from '@preact/signals';
import type { ClickCount, ClicksView } from '@dither-chat/protocol';
import { areaOf, ClickTally, fullKey, pageOf, recordClick } from './clicks.ts';
import { phone } from './phone.ts';
import { api, prefs, route, setPrefs } from './state.ts';

const OUTBOX_KEY = 'dither-chat:clicks-outbox';
/** Entries per POST: well inside the hub's limit and a keepalive request's 64 KB. */
const CHUNK = 200;

type Batch = { batch: string; counts: ClickCount[] };

const read = (): { tally: ClickCount[]; batches: Batch[] } => {
  try {
    const o = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? 'null');
    return { tally: Array.isArray(o?.tally) ? o.tally : [], batches: Array.isArray(o?.batches) ? o.batches : [] };
  } catch {
    return { tally: [], batches: [] };
  }
};
const saved = read();
let tally = new ClickTally(saved.tally);
let batches: Batch[] = saved.batches;

function save() {
  try {
    if (!tally.size && !batches.length) localStorage.removeItem(OUTBOX_KEY);
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify({ tally: tally.list(), batches }));
  } catch {}
}

export const countingClicks = () => !!prefs.value.countClicks;
const device = () => (phone.value ? 'phone' : 'desktop');

/** A press that is not a click: a keyboard shortcut or a gesture. `key` is complete ("keys: Ctrl+K (switcher)"). */
export function countKey(key: string) {
  if (!countingClicks()) return;
  tally.add(key, pageOf(route.value), device());
  save();
}

/** A key pressed on `el` (Enter in the composer): the key takes `el`'s area, as a click there would. */
export function countAt(el: Element | null, key: string) {
  if (!countingClicks()) return;
  const page = pageOf(route.value);
  tally.add(fullKey(key, areaOf(el), page), page, device());
  save();
}

function onClick(e: MouseEvent) {
  if (!countingClicks()) return;
  // Before the click's own handler moves anywhere: the page it was pressed on.
  if (recordClick(tally, e.target as Element | null, pageOf(route.value), device())) save();
}

/** Not crypto.randomUUID: a hub reached over plain HTTP is not a secure context. */
const batchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

let sending = false;
/** Everything waiting, to the hub. Resolves once it is there or could not be sent. */
export async function flushClicks(leaving = false) {
  if (!countingClicks()) return dropPending();
  if (sending) return;
  sending = true;
  try {
    const counts = tally.take();
    for (let i = 0; i < counts.length; i += CHUNK) batches.push({ batch: batchId(), counts: counts.slice(i, i + CHUNK) });
    // A hub that keeps refusing does not make this device keep everything.
    if (batches.length > 50) batches.splice(0, batches.length - 50);
    save();
    while (batches.length) {
      const b = batches[0];
      const r = await fetch('/api/usage/clicks', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' }, keepalive: leaving });
      // Refused as it is (it will not get better): dropped. Otherwise it waits for the next try.
      if (!r.ok && r.status !== 400 && r.status !== 413) break;
      batches.shift();
      save();
    }
  } catch {
    // Offline: it goes next time, and the hub counts a resent batch once.
  } finally {
    sending = false;
  }
}

function dropPending() {
  tally = new ClickTally();
  batches = [];
  save();
}

export function setCountingClicks(on: boolean) {
  setPrefs({ countClicks: on });
  if (!on) dropPending();
}

// ------------------------------------------------------------------ what the hub has

export const clickTotals = signal<ClicksView | null>(null);

/** This device's waiting counts first, so the table includes them. */
export async function loadClickTotals(days: number) {
  await flushClicks();
  clickTotals.value = await api<ClicksView>(`/api/usage/clicks?days=${days}&by=device&limit=500`);
}

export async function forgetClicks() {
  dropPending();
  await api('/api/usage/clicks', { method: 'DELETE', body: {} });
  clickTotals.value = clickTotals.value ? { ...clickTotals.value, total: 0, keys: [] } : null;
}

// ------------------------------------------------------------------ wiring

let started = false;
export function startClickLog() {
  if (started || typeof window === 'undefined') return;
  started = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flushClicks(true));
  window.addEventListener('pagehide', () => void flushClicks(true));
  setInterval(() => void flushClicks(), 60_000);
  // Counts left from the last time the app was open.
  if (countingClicks() && (tally.size || batches.length)) void flushClicks();
  else if (!countingClicks()) dropPending();
}
