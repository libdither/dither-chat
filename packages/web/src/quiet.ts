/**
 * Quiet servers (docs/organize.md, "Quiet shelf"): never opened here, nothing unread, nothing new in half a year. The
 * rail and the Spaces list keep them on a shelf at the end of each list, closed, so a folder shows what is alive.
 * Display only: nothing moves out of your folders, and a quiet server you open comes off the shelf by itself.
 */
import { signal } from '@preact/signals';
import { arrange } from './arrange.ts';
import { activityOfSpace, spaceUnread } from './model.ts';
import { db, route } from './state.ts';
import { usageOf } from './usage.ts';

const QUIET_AFTER = 180 * 86_400_000;
/** Fewer than this many quiet places in a list are shown where they are: a shelf of one hides more than it saves. */
const SHELF_MIN = 2;

export const quietShelfOn = () => arrange.value.quietShelf !== false;

/** A place key ("space:…") is quiet now. Only servers are: a chat or a folder never is. */
function isQuiet(key: string, now = Date.now()): boolean {
  if (!key.startsWith('space:')) return false;
  const id = key.slice('space:'.length);
  const r = route.value;
  if (r.view === 'space' && r.space === id) return false;
  if (db.placePrefs.get(`space:${id}`)?.pinned) return false;
  const u = spaceUnread(id);
  if (u.unread || u.badge) return false;
  if (usageOf('space', id)?.lastVisit) return false;
  return activityOfSpace(id) < now - QUIET_AFTER;
}

/** Shelves opened this session, by list ("rail", "folder:<id>"). */
export const openShelves = signal<ReadonlySet<string>>(new Set());
export function toggleShelf(list: string) {
  const next = new Set(openShelves.value);
  next.has(list) ? next.delete(list) : next.add(list);
  openShelves.value = next;
}

/**
 * A list split into what shows and what sits on its shelf (empty when the shelf is off or would hold too few), and
 * `dim`: every quiet one, on the shelf or left in the list.
 */
export function shelve<T>(items: T[], keyOf: (x: T) => string): { shown: T[]; quiet: T[]; dim: ReadonlySet<T> } {
  if (!quietShelfOn()) return { shown: items, quiet: [], dim: new Set() };
  const now = Date.now();
  const quiet = items.filter((x) => isQuiet(keyOf(x), now));
  const dim = new Set(quiet);
  // Too few to be worth a shelf, or all of them: a list that is only a shelf hides everything it holds.
  if (quiet.length < SHELF_MIN || quiet.length === items.length) return { shown: items, quiet: [], dim };
  return { shown: items.filter((x) => !dim.has(x)), quiet, dim };
}
