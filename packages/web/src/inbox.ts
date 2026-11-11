/**
 * The inbox's order on screen (docs/inbox.md). The hub ranks conversations by how much they need you; this shows
 * that ranking as a snapshot, taken by the same rule as the sidebar's automatic orders (`shouldResort`): never
 * while a pointer, a finger, a menu or the keyboard is on a list. Unlike those, any change in the ranking asks for
 * a new snapshot at once ('activity'), so the inbox stays as current as a chat app's while you are not touching it.
 */
import { effect, signal } from '@preact/signals';
import { isInteracting } from './arrange.ts';
import { inboxKeyOf, inboxRows, mailRowsWaiting, rowDirect, rowLast, rowMuted, type InboxRow } from './model.ts';
import { filterKeeps, inboxChanged, inboxSnapshot, inboxView, sameInbox, shouldResort, type Hold, type InboxSnapshot, type Ranked, type ResortReason } from './ordering.ts';
import { loaded, mailRev, rev, route, type InboxFilter } from './state.ts';
import { onForeground } from './usage.ts';

const KEY = 'dither-chat:inbox-snapshot';
function stored(): InboxSnapshot | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '');
    return Array.isArray(s?.keys) ? s : null;
  } catch {
    return null;
  }
}

/** The order last taken; this device's last one until the first of this session. Bumping `v` animates the change. */
export const inboxSnap = signal<{ v: number; at: number | null; snap: InboxSnapshot | null }>({ v: 0, at: null, snap: stored() });

/** The row open in the inbox keeps its place while it is open: a person's chat by any of their DMs. */
const openHere = () => {
  const r = route.value;
  return r.view === 'inbox' && r.conv ? inboxKeyOf(r.conv) : undefined;
};
const hold = (): Hold | undefined => {
  const key = openHere();
  return key ? { key, prev: inboxSnap.value.snap } : undefined;
};

/** Chats and mail from people rank as one (docs/mail.md); notes to self rank like any other row. */
const ranked = (rows: InboxRow[]): Ranked[] => rows.map((r) => ({ key: r.key, score: r.score, last: rowLast(r), muted: rowMuted(r) }));

let waiting: ReturnType<typeof setTimeout> | undefined;
/** Take a new snapshot if now is a good moment; otherwise as soon as it is. */
export function resortInbox(reason: ResortReason) {
  clearTimeout(waiting);
  const now = Date.now();
  if (!shouldResort({ reason, now, last: inboxSnap.value.at, interacting: isInteracting() })) {
    if (reason !== 'timer') waiting = setTimeout(() => resortInbox(reason), 1500);
    return;
  }
  const snap = inboxSnapshot(ranked(inboxRows()), hold());
  const prev = inboxSnap.value;
  const same = sameInbox(prev.snap, snap);
  inboxSnap.value = { v: same ? prev.v : prev.v + 1, at: now, snap };
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {}
}

/** The rows the filter shows, in order: one list, in the snapshot's order (docs/inbox.md). */
export function shownInbox(filter: InboxFilter): InboxRow[] {
  const rows = inboxRows();
  const byId = new Map(rows.map((r) => [r.key, r]));
  const snap = inboxSnap.value.snap;
  const keep = (id: string) => {
    const r = byId.get(id)!;
    return filterKeeps(filter, { mail: r.kind === 'mail', direct: rowDirect(r) });
  };
  return inboxView(snap, ranked(rows), keep).map((k) => byId.get(k)!);
}

let started = false;
export function startInbox() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const first = () => (loaded.value ? resortInbox('start') : setTimeout(first, 300));
  first();
  onForeground.add(() => resortInbox('foreground'));
  // A new score, a new conversation, a read one: take the order again once nothing is in use.
  let soon: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    rev.value;
    // A listed mail thread whose view has not come yet: the mail event that brings it is a change of order.
    if (mailRowsWaiting()) mailRev.value;
    if (!loaded.value) return;
    clearTimeout(soon);
    soon = setTimeout(() => inboxChanged(inboxSnap.value.snap, ranked(inboxRows()), hold()) && resortInbox('activity'), 600);
  });
  // Leaving a conversation lets it settle where it now belongs, once nothing is in use.
  let open = openHere();
  effect(() => {
    const now = openHere();
    if (now === open) return;
    open = now;
    if (loaded.value) resortInbox('activity');
  });
  setInterval(() => document.visibilityState === 'visible' && resortInbox('timer'), 60_000);
}
