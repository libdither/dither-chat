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

/** One inbox row as the ranking sees it: the hub's score. */
export interface Ranked {
  key: string;
  score: number;
  /** The latest message, anyone's: breaks ties. */
  last?: number;
  /** Muted here or on its network: below everything else. */
  muted?: boolean;
}

/**
 * One order: by the hub's score, which already counts what needs you, a conversation going on and where you were
 * just now. Muted places sink to the end. Ties go by the latest message, then by key, so the order never flickers.
 */
export function rank(items: readonly Ranked[]): string[] {
  return [...items]
    .sort((a, b) => Number(!!a.muted) - Number(!!b.muted) || b.score - a.score || (b.last ?? 0) - (a.last ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.key);
}

/** The inbox's order as last taken: the keys, and which were unread then. */
export interface InboxSnapshot {
  keys: string[];
  unread: string[];
}

/** The open conversation and the snapshot it was shown in: it keeps that place until you leave it. */
export interface Hold {
  key: string;
  prev: InboxSnapshot | null;
}

/**
 * The order to show now. `hold` keeps the conversation you have open where it was: reading it or answering it
 * changes its score, and it should not jump away while you are in it. It settles at the first snapshot after you
 * leave.
 */
export function inboxSnapshot(items: readonly (Ranked & { unread: boolean })[], hold?: Hold): InboxSnapshot {
  let keys = rank(items);
  const was = hold?.prev ? hold.prev.keys.indexOf(hold.key) : -1;
  if (hold && was >= 0 && items.some((x) => x.key === hold.key)) {
    keys = keys.filter((k) => k !== hold.key);
    keys.splice(Math.min(was, keys.length), 0, hold.key);
  }
  return { keys, unread: items.filter((x) => x.unread).map((x) => x.key) };
}

/** Whether a fresh ranking would show a different order from the snapshot. */
export function inboxChanged(snap: InboxSnapshot | null, fresh: readonly Ranked[], hold?: Hold): boolean {
  if (!snap) return true;
  return inboxSnapshot(fresh.map((x) => ({ ...x, unread: false })), hold).keys.join('\n') !== snap.keys.join('\n');
}

/**
 * The inbox on screen: the snapshot's order for what it knows and anything new after it (as `stabilize`). `keep`
 * is a filter chip; it hides rows without moving any.
 */
export function inboxView(snap: InboxSnapshot | null, fresh: readonly Ranked[], keep: (key: string) => boolean = () => true): string[] {
  const order = rank(fresh);
  return (snap ? stabilize(snap.keys, order) : order).filter(keep);
}

/** What a filter chip asks of an inbox row (docs/inbox.md): one other person on it, and something unread. */
export interface Chipped {
  key: string;
  /** A DM, or a mail thread between you and one other (docs/mail.md). */
  direct: boolean;
  unread: boolean;
}

/**
 * Whether a filter chip shows a row: People one other person, Groups the rest, Unread what is unread or was when the
 * order was taken (`wasUnread`), so reading it does not pull it out from under you.
 */
export function chipKeeps(chip: 'all' | 'people' | 'groups' | 'unread', r: Chipped, wasUnread: ReadonlySet<string>): boolean {
  if (chip === 'people') return r.direct;
  if (chip === 'groups') return !r.direct;
  if (chip === 'unread') return r.unread || wasUnread.has(r.key);
  return true;
}

/**
 * How much the inbox's score lifts a match in the switcher: twice per 50 points. So among names that match about
 * as well, the one you are likelier to want comes first, and a muted place (about -50) counts half.
 */
export function inboxLift(score: number | null | undefined): number {
  return 2 ** (Math.max(-100, Math.min(150, score ?? 0)) / 50);
}

/** One switcher candidate: how well its name matches (fuzzyScore), its inbox score if it has one, its latest message. */
export interface Candidate {
  key: string;
  match: number;
  score: number | null;
  last: number;
}

/** The switcher's order: match quality times the inbox's lift, then the latest message, then key. */
export function switcherOrder(found: readonly Candidate[]): string[] {
  const w = (c: Candidate) => Math.max(1, c.match) * inboxLift(c.score);
  return [...found].sort((a, b) => w(b) - w(a) || b.last - a.last || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((c) => c.key);
}
