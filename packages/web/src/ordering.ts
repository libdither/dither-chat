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

/** The inbox's order as last taken: the keys, which were unread then, and which waited on a reply from you. */
export interface InboxSnapshot {
  keys: string[];
  unread: string[];
  /** Absent in a snapshot from before the sections: none. */
  waiting?: string[];
}

/** The open conversation and the snapshot it was shown in: it keeps that place until you leave it. */
export interface Hold {
  key: string;
  prev: InboxSnapshot | null;
}

/**
 * The order to show now. `hold` keeps the conversation you have open where it was, in the section it was in:
 * reading it or answering it changes its score, and it should not jump away while you are in it. It settles at the
 * first snapshot after you leave.
 */
export function inboxSnapshot(items: readonly (Ranked & { unread: boolean; waiting?: boolean })[], hold?: Hold): InboxSnapshot {
  let keys = rank(items);
  let unread = items.filter((x) => x.unread).map((x) => x.key);
  let waiting = items.filter((x) => x.waiting).map((x) => x.key);
  const was = hold?.prev ? hold.prev.keys.indexOf(hold.key) : -1;
  if (hold && was >= 0 && items.some((x) => x.key === hold.key)) {
    keys = keys.filter((k) => k !== hold.key);
    keys.splice(Math.min(was, keys.length), 0, hold.key);
    const keep = (now: string[], before: string[] | undefined) => [...now.filter((k) => k !== hold.key), ...(before?.includes(hold.key) ? [hold.key] : [])];
    unread = keep(unread, hold.prev!.unread);
    waiting = keep(waiting, hold.prev!.waiting);
  }
  return { keys, unread, waiting };
}

/** Two snapshots show the same: the same order, and each row in the same section. */
export function sameInbox(a: InboxSnapshot | null, b: InboxSnapshot): boolean {
  const set = (x: string[] | undefined) => [...(x ?? [])].sort().join('\n');
  return !!a && a.keys.join('\n') === b.keys.join('\n') && set(a.unread) === set(b.unread) && set(a.waiting) === set(b.waiting);
}

/** Whether a fresh ranking would show a different order from the snapshot, or move a row to another section. */
export function inboxChanged(snap: InboxSnapshot | null, fresh: readonly (Ranked & { unread?: boolean; waiting?: boolean })[], hold?: Hold): boolean {
  return !sameInbox(snap, inboxSnapshot(fresh.map((x) => ({ ...x, unread: !!x.unread })), hold));
}

/**
 * The inbox on screen: the snapshot's order for what it knows and anything new after it (as `stabilize`). `keep`
 * is the filter; it hides rows without moving any.
 */
export function inboxView(snap: InboxSnapshot | null, fresh: readonly Ranked[], keep: (key: string) => boolean = () => true): string[] {
  const order = rank(fresh);
  return (snap ? stabilize(snap.keys, order) : order).filter(keep);
}

/** The inbox's filter (docs/inbox.md): everything, chats with one other person, the other chats, or mail. */
export type InboxFilter = 'all' | 'direct' | 'groups' | 'mail';
export const INBOX_FILTERS: { id: InboxFilter; label: string; short: string }[] = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'direct', label: 'Direct messages', short: 'DMs' },
  { id: 'groups', label: 'Groups', short: 'Groups' },
  { id: 'mail', label: 'Mail', short: 'Mail' },
];

/** A stored filter, from before the menu too: People was the DMs, and Unread is now the New section. */
export function inboxFilterOf(stored: unknown): InboxFilter {
  if (stored === 'people') return 'direct';
  return INBOX_FILTERS.some((f) => f.id === stored) ? (stored as InboxFilter) : 'all';
}

/** What the filter asks of an inbox row. */
export interface Filtered {
  /** A thread of mail (docs/mail.md), not a chat. */
  mail: boolean;
  /** A DM: one other person. */
  direct: boolean;
}

/** Whether the filter shows a row: Direct messages the DMs, Groups the other chats, Mail the mail. */
export function filterKeeps(filter: InboxFilter, r: Filtered): boolean {
  if (filter === 'mail') return r.mail;
  if (filter === 'direct') return !r.mail && r.direct;
  if (filter === 'groups') return !r.mail && !r.direct;
  return true;
}

/** The inbox's sections, top to bottom (docs/inbox.md). */
export type InboxSection = 'waiting' | 'new' | 'earlier';
export const INBOX_SECTIONS: { id: InboxSection; label: string }[] = [
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'new', label: 'New' },
  { id: 'earlier', label: 'Earlier' },
];

/**
 * Splits rows shown in order into the sections, each keeping that order. A row the snapshot knows goes where it was
 * when the order was taken, so reading it or answering it moves it at the next snapshot, never under you; a row
 * newer than the snapshot goes by what it is `now`. Waiting on you: a turn you owe (the row's ↩). New: unread, and
 * not waiting. Earlier: the rest.
 */
export function inboxSections(keys: readonly string[], snap: InboxSnapshot | null, now: (key: string) => { unread: boolean; waiting: boolean }): Record<InboxSection, string[]> {
  const out: Record<InboxSection, string[]> = { waiting: [], new: [], earlier: [] };
  const known = new Set(snap?.keys ?? []);
  const unread = new Set(snap?.unread ?? []);
  const waiting = new Set(snap?.waiting ?? []);
  for (const k of keys) {
    const x = known.has(k) ? { unread: unread.has(k), waiting: waiting.has(k) } : now(k);
    out[x.waiting ? 'waiting' : x.unread ? 'new' : 'earlier'].push(k);
  }
  return out;
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
