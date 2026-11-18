/**
 * What pushes brought while the app was closed, shown before the hub answers (docs/notifications.md, "A copy in the
 * push"). The service worker (public/sw.js), or the Android app (Arrived.kt), keeps each push's copy of its message
 * and each read elsewhere; a start from the snapshot lays them over it, so tapping a notification opens a chat that
 * already has the message, offline too.
 *
 * It is a layer, never data: nothing of it is saved (the snapshot is not written while it shows), and it is taken
 * away whole right before the hub's own answer is applied (state.ts `resync`, `bootstrap`), in the same task, so the
 * hub's state replaces it without a flicker and nothing is counted twice. Each conversation it changed gets its
 * object from before back, unless something else replaced it meanwhile; its messages leave the timelines and the
 * inbox, unless the hub's copy replaced them already. Kept pages never see it: their catch-up asks from their newest
 * message the hub sent (`heldEnds`), not from a copy.
 *
 * Only what is newer than the snapshot is shown. A copy is marked in the timeline (`isArrivedCopy`), with a line above
 * the first that says earlier messages may be missing: only messages that notify are pushed, so the ones between
 * may not be here yet.
 */
import type * as P from '@dither-chat/protocol';
import { db, inbox, timelines, type Timeline } from './store.ts';
import { mergeInbox, upsertInto } from './syncmodel.ts';
import { changed, timelineChanged } from './versions.ts';

/** As public/sw.js and Arrived.kt keep them. */
export type ArrivedRecord = { key: string; at: number; conv: string } & ({ kind: 'message'; arrived: P.PushArrived } | { kind: 'clear'; upTo?: number });

interface ConvState {
  lastMessage: P.MessagePreview | null;
  lastMessageAt: number | null;
  vantages: P.VantageView[];
}

interface OverlayPlan {
  /** Each conversation's row as the newest push left it. */
  convs: Map<string, ConvState>;
  /** The messages to show, oldest first. */
  messages: P.MessageView[];
}

const isRecord = (r: any): r is ArrivedRecord =>
  !!r && typeof r.key === 'string' && typeof r.at === 'number' && typeof r.conv === 'string' && (r.kind === 'clear' || (r.kind === 'message' && typeof r.arrived?.message?.id === 'string' && r.arrived.message.conversationId === r.conv && Array.isArray(r.arrived.vantages)));

const readAll = (v: P.VantageView[], upTo: number | undefined): P.VantageView[] => v.map((x) => ({ ...x, unread: 0, mentions: 0, lastReadTs: upTo === undefined ? x.lastReadTs : Math.max(x.lastReadTs ?? 0, upTo) }));

/**
 * What to show over the snapshot (pure). `conv` is the conversation as the snapshot has it. A message no newer than
 * the snapshot's last one is left out; a conversation's row takes the newest push's state when it is newer than the
 * snapshot's. A read elsewhere that came after that push, up to or past its last message, leaves it read.
 */
export function planOverlay(records: unknown[], conv: (id: string) => P.ConversationView | undefined): OverlayPlan {
  const convs = new Map<string, ConvState>();
  const messages: P.MessageView[] = [];
  const valid = records.filter(isRecord).sort((a, b) => a.at - b.at);
  const newest = new Map<string, { at: number; s: ConvState }>();
  for (const r of valid) {
    const c = conv(r.conv);
    if (!c || r.kind !== 'message') continue;
    const a = r.arrived;
    const m = a.message;
    const known = c.lastMessageAt ?? -Infinity;
    if (m.ts < known || (m.ts === known && c.lastMessage?.id === m.id)) continue;
    messages.push(a.cut ? { ...m, body: `${m.body}…` } : m);
    if ((a.lastMessageAt ?? -Infinity) > known && (a.lastMessageAt ?? -Infinity) >= (newest.get(r.conv)?.s.lastMessageAt ?? -Infinity))
      newest.set(r.conv, { at: r.at, s: { lastMessage: a.lastMessage, lastMessageAt: a.lastMessageAt, vantages: a.vantages } });
  }
  for (const [id, n] of newest) convs.set(id, n.s);
  for (const r of valid) {
    if (r.kind !== 'clear') continue;
    const c = conv(r.conv);
    if (!c) continue;
    const n = newest.get(r.conv);
    const state = convs.get(r.conv) ?? { lastMessage: c.lastMessage, lastMessageAt: c.lastMessageAt, vantages: c.vantages };
    // A read from before the newest push, or up to a time before its last message, leaves that message unread.
    if (n && r.at < n.at) continue;
    if (r.upTo !== undefined && state.lastMessageAt !== null && r.upTo < state.lastMessageAt) continue;
    convs.set(r.conv, { ...state, vantages: readAll(state.vantages, r.upTo) });
  }
  // One copy per message, oldest first.
  const seen = new Set<string>();
  const out = messages.reverse().filter((m) => !seen.has(m.id) && !!seen.add(m.id)).reverse();
  out.sort((a, b) => a.ts - b.ts);
  return { convs, messages: out };
}

// ------------------------------------------------------------------ the layer

type Phase = 'waiting' | 'open' | 'closed';
let phase: Phase = 'waiting';
/** Every record this start was given; each batch plans again from all of them. */
let records: unknown[] = [];
/** Each conversation it changed: the object before, and the one it put in. */
const swapped = new Map<string, { before: P.ConversationView; put: P.ConversationView }>();
const copies = new WeakSet<P.MessageView>();
let shown: P.MessageView[] = [];
/** When this start began asking the hub: records kept before then are covered by its answer. */
let caughtUpTo = 0;

/** A message on screen that is a push's copy, not yet the hub's. */
export const isArrivedCopy = (m: P.MessageView) => copies.has(m);

/** Records came (the worker's store, or the Android app's hello): shown if the snapshot is up and the hub is not. */
export function addArrived(more: unknown[]) {
  if (phase === 'closed' || !more.length) return;
  records.push(...more);
  if (phase === 'open') apply();
}

/** The snapshot is on screen (main.tsx): what came so far shows; or there is none, and nothing will. */
export function openArrived(fromSnapshot: boolean) {
  if (phase !== 'waiting') return;
  if (!fromSnapshot) return void close();
  phase = 'open';
  apply();
}

function apply() {
  const before = (id: string) => swapped.get(id)?.before ?? db.conversations.get(id);
  const plan = planOverlay(records, before);
  // Rows: as the plan says now, and those it no longer changes as they were.
  for (const [id, { before: b, put }] of swapped) {
    if (plan.convs.has(id)) continue;
    if (db.conversations.get(id) === put) db.conversations.set(id, b);
    swapped.delete(id);
  }
  for (const [id, st] of plan.convs) {
    const b = before(id);
    if (!b) continue;
    const put = { ...b, ...st };
    db.conversations.set(id, put);
    swapped.set(id, { before: b, put });
  }
  const fresh = plan.messages.filter((m) => !shown.some((x) => x.id === m.id));
  for (const m of fresh) copies.add(m);
  shown = [...shown, ...fresh];
  // Not over a copy the inbox already has from the hub.
  const inboxed = fresh.filter((m) => !inbox.value.some((x) => x.id === m.id));
  if (inboxed.length) inbox.value = mergeInbox(inbox.value, inboxed);
  for (const t of timelines.values()) arrivedInto(t);
  changed('list');
}

/** The copies that belong in a timeline, put in it: one opened while the layer shows (state.ts fillTimeline). */
export function arrivedInto(t: Timeline) {
  if (phase !== 'open' || !shown.length || t.detached) return;
  const convIds = t.key.startsWith('c:') ? [t.key.slice(2)] : (t.conversationIds ?? [...db.conversations.values()].filter((c) => c.shape === 'direct' && `p:${c.peerPersonId}` === t.key).map((c) => c.id));
  let added = false;
  for (const m of shown) {
    if (!convIds.includes(m.conversationId) || t.messages.some((x) => x.id === m.id)) continue;
    upsertInto(t.messages, m);
    added = true;
  }
  if (added) timelineChanged(t.key);
}

/**
 * The hub's answer is about to be applied: the layer goes, in this same task. Returns when this start began catching up,
 * for `doneArrived`.
 */
export function dropArrived() {
  if (phase === 'closed') return;
  close();
  for (const [id, { before, put }] of swapped) if (db.conversations.get(id) === put) db.conversations.set(id, before);
  swapped.clear();
  if (shown.length) {
    for (const t of timelines.values()) {
      const n = t.messages.length;
      t.messages = t.messages.filter((m) => !copies.has(m));
      if (t.messages.length !== n) timelineChanged(t.key);
    }
    if (inbox.value.some((m) => copies.has(m))) inbox.value = inbox.value.filter((m) => !copies.has(m));
    changed('list');
  }
  shown = [];
}

function close() {
  phase = 'closed';
  records = [];
}

/** The newest and oldest of a timeline's messages that came from the hub, not from a push (state.ts timelineRequest). */
export function heldEnds(messages: P.MessageView[]): { newest: number; oldest: number } {
  let i = messages.length - 1;
  while (i >= 0 && copies.has(messages[i])) i--;
  let j = 0;
  while (j < messages.length && copies.has(messages[j])) j++;
  return { newest: messages[i]?.ts ?? 0, oldest: messages[j]?.ts ?? 0 };
}

/** This start began asking the hub now: what was kept before it is covered by the answer. */
export function markCatchingUp(now = Date.now()) {
  caughtUpTo ||= now;
}

// ------------------------------------------------------------------ where they are kept

const DB = 'dither-arrived';

/** The records the worker kept (public/sw.js). */
export function readKept(): Promise<unknown[]> {
  if (typeof indexedDB === 'undefined') return Promise.resolve([]);
  return new Promise((resolve) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('arrived');
    q.onerror = q.onblocked = () => resolve([]);
    q.onsuccess = () => {
      const d = q.result;
      try {
        const r = d.transaction('arrived', 'readonly').objectStore('arrived').getAll();
        r.onsuccess = () => (d.close(), resolve(r.result));
        r.onerror = () => (d.close(), resolve([]));
      } catch {
        d.close();
        resolve([]);
      }
    };
  });
}

let tellApp: ((upTo: number) => void) | null = null;
/** The Android app keeps its own records (android.ts): it is told which go. */
export function onArrivedDone(fn: (upTo: number) => void) {
  tellApp = fn;
}

/**
 * The hub caught this copy up: the records kept before it began asking go, from the worker's store and the Android
 * app's (`android` sends `arrived.done`). One that came while it was asking stays for the next start, which leaves it
 * out as no newer than its snapshot.
 */
export function doneArrived() {
  const upTo = caughtUpTo;
  if (!upTo) return;
  tellApp?.(upTo);
  if (typeof indexedDB === 'undefined') return;
  const q = indexedDB.open(DB, 1);
  q.onupgradeneeded = () => q.result.createObjectStore('arrived');
  q.onsuccess = () => {
    const d = q.result;
    try {
      const t = d.transaction('arrived', 'readwrite');
      const st = t.objectStore('arrived');
      const c = st.openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        if ((cur.value as { at?: number })?.at !== undefined && (cur.value as { at: number }).at <= upTo) cur.delete();
        cur.continue();
      };
      t.oncomplete = t.onerror = t.onabort = () => d.close();
    } catch {
      d.close();
    }
  };
}

/** For tests: back to a fresh start. */
export function resetArrived() {
  phase = 'waiting';
  records = [];
  swapped.clear();
  shown = [];
  caughtUpTo = 0;
}
