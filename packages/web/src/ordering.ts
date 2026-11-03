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

export type ResortReason = 'start' | 'foreground' | 'timer' | 'mode' | 'asked';
/** At most this often on a timer, and only while nobody is using the list. */
export const RESORT_EVERY = 5 * 60_000;

/**
 * Whether to take a new snapshot now. What you ask for (a new mode, "sort now") happens at once; the rest
 * waits until no drag, menu or pointer is on the list, and a timer never fires more than every few minutes.
 */
export function shouldResort(o: { reason: ResortReason; now: number; last: number | null; interacting: boolean }): boolean {
  if (o.reason === 'mode' || o.reason === 'asked') return true;
  if (o.interacting) return false;
  if (o.last === null || o.reason === 'start' || o.reason === 'foreground') return true;
  return o.now - o.last >= RESORT_EVERY;
}

/** A snapshot changed only if some list shows a different order; an unchanged one need not animate. */
export function sameSnapshot(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if ((a[k] ?? []).join('\n') !== (b[k] ?? []).join('\n')) return false;
  return true;
}
