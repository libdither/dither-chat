/**
 * The inbox's order on screen (docs/inbox.md). The hub ranks conversations by how much they need you; this shows
 * that ranking as a snapshot, taken by the same rule as the sidebar's automatic orders (`shouldResort`): never
 * while a pointer, a finger, a menu or the keyboard is on a list. Unlike those, any change in the ranking asks for
 * a new snapshot at once ('activity'), so the inbox stays as current as a chat app's while you are not touching it.
 */
import { effect, signal } from '@preact/signals';
import { isInteracting } from './arrange.ts';
import { inboxRows, unreadOf, type InboxRow } from './model.ts';
import { inboxChanged, inboxSnapshot, inboxView, shouldResort, type Hold, type InboxSnapshot, type Ranked, type ResortReason } from './ordering.ts';
import { loaded, rev, route, type InboxFilter } from './state.ts';
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

/** The conversation open in the inbox keeps its place while it is open. */
const openHere = () => (route.value.view === 'inbox' ? route.value.conv : undefined);
const hold = (): Hold | undefined => {
  const key = openHere();
  return key ? { key, prev: inboxSnap.value.snap } : undefined;
};

/** Notes to self notify nobody, which is not the same as muted: they keep their place by date. */
const ranked = (rows: InboxRow[]): Ranked[] =>
  rows.map((r) => ({ key: r.conv.id, score: r.score, needs: r.needs, last: r.conv.lastMessageAt ?? 0, muted: r.conv.shape !== 'self' && unreadOf(r.conv).muted }));

let waiting: ReturnType<typeof setTimeout> | undefined;
/** Take a new snapshot if now is a good moment; otherwise as soon as it is. */
export function resortInbox(reason: ResortReason) {
  clearTimeout(waiting);
  const now = Date.now();
  if (!shouldResort({ reason, now, last: inboxSnap.value.at, interacting: isInteracting() })) {
    if (reason !== 'timer') waiting = setTimeout(() => resortInbox(reason), 1500);
    return;
  }
  const rows = inboxRows();
  const snap = inboxSnapshot(
    ranked(rows).map((x, i) => ({ ...x, unread: unreadOf(rows[i].conv).unread > 0 })),
    hold(),
  );
  const prev = inboxSnap.value;
  const same = !!prev.snap && prev.snap.needs === snap.needs && prev.snap.keys.join('\n') === snap.keys.join('\n');
  inboxSnap.value = { v: same ? prev.v : prev.v + 1, at: now, snap };
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {}
}

/** The rows a filter chip shows, in order, and how many of the first ones need you (where the "caught up" line goes). */
export function shownInbox(filter: InboxFilter): { rows: InboxRow[]; divider: number } {
  const rows = inboxRows();
  const byId = new Map(rows.map((r) => [r.conv.id, r]));
  const snap = inboxSnap.value.snap;
  // What was unread when the order was taken stays under Unread until the next one, so reading it does not pull it out from under you.
  const wasUnread = new Set(snap?.unread ?? []);
  const keep = (id: string) => {
    const c = byId.get(id)!.conv;
    if (filter === 'people') return c.shape === 'direct';
    if (filter === 'groups') return c.shape !== 'direct';
    if (filter === 'unread') return unreadOf(c).unread > 0 || wasUnread.has(id);
    return true;
  };
  const v = inboxView(snap, ranked(rows), keep);
  return { rows: v.keys.map((k) => byId.get(k)!), divider: v.divider };
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
