/**
 * What changed, and the signals components read to re-render because of it (docs/perf.md).
 *
 * - `rev`, the list: anything in `db` or the inbox. The sidebars, the rail and the panes read it.
 * - `metaRev`, names and settings: everything but a conversation's last message and unread counts, the inbox
 *   ranking and the inbox itself. What a message or a sidebar row shows beyond its own object reads this, so a
 *   message arriving re-renders its row and not every row.
 * - `timelineRev(key)`, one per timeline: its messages, its loading and what replies in it quote.
 *
 * Changes are counted at once (`dataVersion`, which model.ts memoizes on); the signals move once the task that made
 * them is done.
 */
import { batch, signal, type Signal } from '@preact/signals';

export const rev = signal(0);
export const metaRev = signal(0);
const timelineRevs = new Map<string, Signal<number>>();

let version = 0;
/** Moves on every change to `db` at once, before the signals do: memos keyed on it are never stale. */
export const dataVersion = () => version;

export function timelineRev(key: string): Signal<number> {
  let s = timelineRevs.get(key);
  if (!s) timelineRevs.set(key, (s = signal(0)));
  return s;
}

const dirty = { list: false, meta: false, all: false, keys: new Set<string>() };
let scheduled = false;

/** Something in `db` changed. 'meta': names or settings too, not only a conversation's last message and counts. */
export function changed(kind: 'list' | 'meta') {
  version++;
  dirty.list = true;
  if (kind === 'meta') dirty.meta = true;
  schedule();
}

/** A timeline's messages or loading changed; with no key, every timeline's (what replies quote). */
export function timelineChanged(key?: string) {
  if (key === undefined) dirty.all = true;
  else dirty.keys.add(key);
  schedule();
}

/** Moves the signals now. A timer does this by itself; tests call it. */
export function flush() {
  scheduled = false;
  if (!dirty.list && !dirty.all && !dirty.keys.size) return;
  const { list, meta, all, keys } = dirty;
  dirty.list = dirty.meta = dirty.all = false;
  dirty.keys = new Set();
  batch(() => {
    if (list) rev.value = version;
    if (meta) metaRev.value++;
    if (all) for (const s of timelineRevs.values()) s.value++;
    else for (const k of keys) {
      const s = timelineRevs.get(k);
      if (s) s.value++;
    }
  });
}

/**
 * Once the task that changed things is done: a burst of events, a page and its identities, move each signal once.
 * Not once per frame: a flush in the frame renders in the same task as the layout and paint after it, which made
 * the longest task of a switch twice as long (docs/perf.md), and a hidden page gets no frames.
 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(flush, 0);
}
