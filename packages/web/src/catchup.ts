/**
 * Catch up's queue (docs/inbox.md#catch-up): the inbox rows that need you, with a reply you owe or something unread,
 * in the inbox's own order (the learned one: a reply you owe does not jump ahead). It is taken when the pane opens and
 * kept steady while you work through it: Done takes a card out, Later moves it to the end, and what newly needs you
 * joins the end. Nothing moves by itself. Pure: ui/CatchUp.tsx keeps one queue for the session.
 */

/** What the queue needs to know of an inbox row. */
export interface QueueRow {
  key: string;
  needs: boolean;
  owedSince: number | null;
  unread: boolean;
  /** Its latest message, anyone's. */
  last: number;
}

export interface Queue {
  /** The cards, in order. */
  keys: string[];
  /** Cards that joined the end while the pane was open: the "N new" note. */
  fresh: string[];
}

/**
 * Cards you marked Done, with the latest message each had then. Done on a reply you owe leaves it owed (reading is not
 * answering), so such a card comes back only once something newer arrives.
 */
export type DoneMarks = ReadonlyMap<string, number>;

const none: DoneMarks = new Map();

/** The rows that belong in the queue, in the order given: those that need you, with a reply you owe or something unread. */
export function wanted<R extends QueueRow>(rows: R[], done: DoneMarks = none): R[] {
  return rows.filter((r) => r.needs && (r.owedSince !== null || r.unread) && !(done.has(r.key) && r.last <= done.get(r.key)!));
}

/** A queue taken afresh. */
export const take = (rows: QueueRow[], done: DoneMarks = none): Queue => ({ keys: wanted(rows, done).map((r) => r.key), fresh: [] });

/** While the pane is open: rows that newly need you join the end, in order. Nothing else moves, and nothing leaves. */
export function arrive(q: Queue, rows: QueueRow[], done: DoneMarks = none): Queue {
  const have = new Set(q.keys);
  const add = wanted(rows, done)
    .map((r) => r.key)
    .filter((k) => !have.has(k));
  return add.length ? { keys: [...q.keys, ...add], fresh: [...q.fresh, ...add] } : q;
}

/** Opening the pane again in the same session: what no longer needs you goes, the rest keeps its place (Later too), and what is new joins the end. */
export function reopen(q: Queue, rows: QueueRow[], done: DoneMarks = none): Queue {
  const want = wanted(rows, done).map((r) => r.key);
  const still = new Set(want);
  const kept = q.keys.filter((k) => still.has(k));
  const have = new Set(kept);
  return { keys: [...kept, ...want.filter((k) => !have.has(k))], fresh: [] };
}

/** Later: to the end of this session's queue. */
export function later(q: Queue, key: string): Queue {
  if (!q.keys.includes(key)) return q;
  return { keys: [...q.keys.filter((k) => k !== key), key], fresh: q.fresh.filter((k) => k !== key) };
}

/** Done: out of the queue. */
export function remove(q: Queue, key: string): Queue {
  if (!q.keys.includes(key)) return q;
  return { keys: q.keys.filter((k) => k !== key), fresh: q.fresh.filter((k) => k !== key) };
}

/** A card seen: no longer counted as new. */
export const seen = (q: Queue, key: string): Queue => (q.fresh.includes(key) ? { ...q, fresh: q.fresh.filter((k) => k !== key) } : q);

/**
 * Where focus goes once the card at `key` is out of the way (Done, Later, a reply): the card after it in `before`, the
 * queue as it was, that is still in `after`; else the nearest one before it; else none.
 */
export function focusAfter(before: string[], after: string[], key: string): string | null {
  const still = new Set(after.filter((k) => k !== key));
  const i = before.indexOf(key);
  if (i < 0) return after[0] ?? null;
  for (let j = i + 1; j < before.length; j++) if (still.has(before[j])) return before[j];
  for (let j = i - 1; j >= 0; j--) if (still.has(before[j])) return before[j];
  return null;
}

/** A step of j or k from the focused card, stopping at either end. */
export function step(keys: string[], focused: string | null, by: 1 | -1): string | null {
  if (!keys.length) return null;
  const i = focused ? keys.indexOf(focused) : -1;
  if (i < 0) return keys[0];
  return keys[Math.max(0, Math.min(keys.length - 1, i + by))];
}
