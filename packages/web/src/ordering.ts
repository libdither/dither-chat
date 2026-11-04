/**
 * Automatic order for the rail and the lists, as plain data (docs/organize.md). Pinned places stay first
 * in your order; the rest follow the mode; a folder sorts as one by its best member. The order on screen
 * is a snapshot taken at quiet moments, so nothing moves under your pointer.
 */
import type { SortMode } from '@dither-chat/protocol';

export interface Sortable {
  key: string;
  name: string;
  pinned: boolean;
  /** Where you put it by hand; null follows activity. */
  position: number | null;
  /** Latest message. */
  last: number;
  /** smartScore() of the place; for a folder, see `members`. */
  score: number;
  /** A folder: its contents, which also decide where it goes. */
  members?: Sortable[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A folder counts as its best member: the one you use most, the latest message, the first name. */
export function asUnit(x: Sortable): Sortable {
  const m = x.members;
  if (!m?.length) return x;
  return { ...x, score: Math.max(x.score, ...m.map((y) => y.score)), last: Math.max(x.last, ...m.map((y) => y.last)) };
}

/** Today's order: what you placed, then folders, then by activity. */
const byHand = (a: Sortable, b: Sortable) => {
  if ((a.position === null) !== (b.position === null)) return a.position !== null ? -1 : 1;
  if (a.position !== null && b.position !== null && a.position !== b.position) return a.position - b.position;
  if (!!a.members !== !!b.members) return a.members ? -1 : 1;
  return b.last - a.last;
};

export function comparator(mode: SortMode): (a: Sortable, b: Sortable) => number {
  const name = (a: Sortable, b: Sortable) => collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  switch (mode) {
    case 'manual':
      return (a, b) => byHand(a, b) || name(a, b);
    case 'recent':
      return (a, b) => b.last - a.last || name(a, b);
    case 'az':
      return name;
    case 'smart':
      // Never used anything here: newest message first, so a fresh install still looks sensible.
      return (a, b) => b.score - a.score || b.last - a.last || name(a, b);
  }
}

/** Keys in display order: pinned first in your order, then the rest by `mode`. Folders sort as a unit. */
export function sortKeys(items: Sortable[], mode: SortMode): string[] {
  const units = items.map(asUnit);
  const pinned = units.filter((x) => x.pinned).sort(comparator('manual'));
  const rest = units.filter((x) => !x.pinned).sort(comparator(mode));
  return [...pinned, ...rest].map((x) => x.key);
}

/**
 * The order to show: the snapshot's order for what it knows, then anything new in the fresh order.
 * Pinned places are left to the caller, which always puts them first.
 */
export function stabilize(snapshot: readonly string[] | undefined, fresh: readonly string[]): string[] {
  if (!snapshot) return [...fresh];
  const present = new Set(fresh);
  const known = new Set(snapshot);
  return [...snapshot.filter((k) => present.has(k)), ...fresh.filter((k) => !known.has(k))];
}

/** 'activity': the inbox's ranking changed (docs/inbox.md); it waits for a quiet moment like a start, but not for the timer. */
export type ResortReason = 'start' | 'foreground' | 'timer' | 'mode' | 'asked' | 'activity';
/** At most this often on a timer, and only while nobody is using the list. */
export const RESORT_EVERY = 5 * 60_000;

/**
 * Whether to take a new snapshot now. What you ask for (a new mode, "sort now") happens at once; the rest
 * waits until no drag, menu or pointer is on the list, and a timer never fires more than every few minutes.
 */
export function shouldResort(o: { reason: ResortReason; now: number; last: number | null; interacting: boolean }): boolean {
  if (o.reason === 'mode' || o.reason === 'asked') return true;
  if (o.interacting) return false;
  if (o.last === null || o.reason === 'start' || o.reason === 'foreground' || o.reason === 'activity') return true;
  return o.now - o.last >= RESORT_EVERY;
}

/** A snapshot changed only if some list shows a different order; an unchanged one need not animate. */
export function sameSnapshot(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if ((a[k] ?? []).join('\n') !== (b[k] ?? []).join('\n')) return false;
  return true;
}

// ------------------------------------------------------------------ the inbox (docs/inbox.md)

/** One inbox row as the ranking sees it: the hub's score, and whether it is above the "caught up" line. */
export interface Ranked {
  key: string;
  score: number;
  needs: boolean;
  /** The latest message, anyone's: below the line this is the order. */
  last?: number;
  /** Muted here or on its network: below everything else. */
  muted?: boolean;
}

/**
 * Two orders, one each side of the line. Above it, by how much each needs you; below it, by the latest message, as
 * a chat app would, so the chat you just answered is the first one under the line. Muted places sink to the end.
 * Ties go by key, so the order never flickers.
 */
export function rank(items: readonly Ranked[]): string[] {
  const below = (a: Ranked, b: Ranked) => Number(!!a.muted) - Number(!!b.muted) || (b.last ?? 0) - (a.last ?? 0);
  return [...items]
    .sort((a, b) => Number(b.needs) - Number(a.needs) || (a.needs ? 0 : below(a, b)) || b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.key);
}

/** The inbox's order as last taken: the keys, how many of the first ones needed you, and which were unread then. */
export interface InboxSnapshot {
  keys: string[];
  needs: number;
  unread: string[];
}

/** The open conversation and the snapshot it was shown in: it keeps that place until you leave it. */
export interface Hold {
  key: string;
  prev: InboxSnapshot | null;
}

/**
 * The order to show now. `hold` keeps the conversation you have open where it was, on the same side of the line:
 * reading it or answering it changes its score, and it should not jump away while you are in it. It settles at the
 * first snapshot after you leave.
 */
export function inboxSnapshot(items: readonly (Ranked & { unread: boolean })[], hold?: Hold): InboxSnapshot {
  let keys = rank(items);
  let needs = items.filter((x) => x.needs).length;
  const was = hold?.prev ? hold.prev.keys.indexOf(hold.key) : -1;
  const item = hold && items.find((x) => x.key === hold.key);
  if (hold?.prev && item && was >= 0) {
    const above = was < hold.prev.needs;
    const rest = keys.filter((k) => k !== hold.key);
    const restNeeds = needs - Number(item.needs);
    rest.splice(Math.min(rest.length, above ? Math.min(was, restNeeds) : Math.max(was, restNeeds)), 0, hold.key);
    keys = rest;
    needs = restNeeds + Number(above);
  }
  return { keys, needs, unread: items.filter((x) => x.unread).map((x) => x.key) };
}

/** Whether a fresh ranking would show anything different from the snapshot: an order or the line. */
export function inboxChanged(snap: InboxSnapshot | null, fresh: readonly Ranked[], hold?: Hold): boolean {
  if (!snap) return true;
  const now = inboxSnapshot(fresh.map((x) => ({ ...x, unread: false })), hold);
  return now.needs !== snap.needs || now.keys.join('\n') !== snap.keys.join('\n');
}

/**
 * The inbox on screen: the snapshot's order for what it knows and anything new after it (as `stabilize`), and
 * where the "caught up" line goes: after the snapshot's needs-you rows still there. `keep` is a filter chip; it
 * hides rows without moving any.
 */
export function inboxView(snap: InboxSnapshot | null, fresh: readonly Ranked[], keep: (key: string) => boolean = () => true): { keys: string[]; divider: number } {
  const order = rank(fresh);
  const need = snap ? new Set(snap.keys.slice(0, snap.needs)) : new Set(fresh.filter((x) => x.needs).map((x) => x.key));
  const keys = (snap ? stabilize(snap.keys, order) : order).filter(keep);
  let divider = 0;
  while (divider < keys.length && need.has(keys[divider])) divider++;
  return { keys, divider };
}
