/** src/catchup.ts: Catch up's queue, and how it stays steady while you work through it. */
import { expect, test } from 'bun:test';
import { arrive, focusAfter, later, remove, reopen, seen, step, take, wanted, type QueueRow } from '../src/catchup.ts';

const row = (key: string, x: Partial<QueueRow> = {}): QueueRow => ({ key, needs: true, owedSince: null, unread: true, last: 1000, ...x });

// In the inbox's own order: a DM you owe, a group with something unread, a mail thread you owe, a read DM going on,
// a muted group, and another unread DM.
const rows = [
  row('cnv_a', { owedSince: 10, unread: false }),
  row('cnv_b'),
  row('mth_c', { owedSince: 20 }),
  row('cnv_d', { unread: false }),
  row('cnv_e', { needs: false }),
  row('cnv_f'),
];

test('the rows that need you, owed or unread, in the inbox order: a reply you owe does not jump ahead', () => {
  expect(take(rows).keys).toEqual(['cnv_a', 'cnv_b', 'mth_c', 'cnv_f']);
  // Owed below unread in the inbox stays below it here.
  expect(take([row('cnv_x'), row('cnv_y', { owedSince: 5, unread: false })]).keys).toEqual(['cnv_x', 'cnv_y']);
});

test('mail threads are in it like any row', () => {
  expect(take([row('mth_x'), row('cnv_y', { owedSince: 5 })]).keys).toEqual(['mth_x', 'cnv_y']);
});

test('a row that needs you with nothing unread and nothing owed is not in it, nor one that does not need you', () => {
  const keys = take(rows).keys;
  expect(keys).not.toContain('cnv_d');
  expect(keys).not.toContain('cnv_e');
  // Owing a reply in a place that does not need you (muted) is not enough.
  expect(wanted([row('cnv_m', { needs: false, owedSince: 5 })])).toEqual([]);
});

test('Later moves a card to the end of the queue; nothing else moves', () => {
  const q = later(take(rows), 'cnv_a');
  expect(q.keys).toEqual(['cnv_b', 'mth_c', 'cnv_f', 'cnv_a']);
  expect(later(q, 'nope')).toBe(q);
});

test('Done takes a card out', () => {
  const q = remove(take(rows), 'mth_c');
  expect(q.keys).toEqual(['cnv_a', 'cnv_b', 'cnv_f']);
});

test('while open, a new arrival joins the end and is counted as new; the order does not follow the inbox', () => {
  const q = take(rows);
  // The inbox now ranks a new DM first, and moves cnv_f above cnv_b: the queue keeps its order.
  const now = [row('cnv_new'), rows[0], rows[2], rows[5], rows[1], rows[3], rows[4]];
  const next = arrive(q, now);
  expect(next.keys).toEqual(['cnv_a', 'cnv_b', 'mth_c', 'cnv_f', 'cnv_new']);
  expect(next.fresh).toEqual(['cnv_new']);
  expect(seen(next, 'cnv_new').fresh).toEqual([]);
  // Nothing new: the same queue.
  expect(arrive(next, now)).toBe(next);
});

test('while open, a card that stops needing you stays where it is', () => {
  const q = take(rows);
  const read = rows.map((r) => (r.key === 'cnv_b' ? { ...r, unread: false } : r));
  expect(arrive(q, read).keys).toEqual(q.keys);
});

test('a card marked Done comes back only after a newer message, even while you still owe it a reply', () => {
  const q = remove(take(rows), 'cnv_a');
  const done = new Map([['cnv_a', 1000]]);
  expect(arrive(q, rows, done).keys).toEqual(['cnv_b', 'mth_c', 'cnv_f']);
  const newer = rows.map((r) => (r.key === 'cnv_a' ? { ...r, last: 2000 } : r));
  const back = arrive(q, newer, done);
  expect(back.keys).toEqual(['cnv_b', 'mth_c', 'cnv_f', 'cnv_a']);
  expect(back.fresh).toEqual(['cnv_a']);
});

test('opening the pane again keeps Later where you put it, drops what was handled, and adds what is new at the end', () => {
  let q = later(take(rows), 'cnv_a');
  q = arrive(q, [...rows, row('cnv_g')]);
  const now = [...rows.filter((r) => r.key !== 'cnv_b'), row('cnv_g'), row('cnv_h', { owedSince: 1 })];
  const again = reopen(q, now);
  expect(again.keys).toEqual(['mth_c', 'cnv_f', 'cnv_a', 'cnv_g', 'cnv_h']);
  expect(again.fresh).toEqual([]);
});

test('focus after a card goes: the next one still there, else the one before', () => {
  const before = ['a', 'b', 'c'];
  expect(focusAfter(before, ['a', 'c'], 'b')).toBe('c');
  expect(focusAfter(before, ['a', 'b'], 'c')).toBe('b');
  // Later: the card is still in the queue, at the end, and focus goes on to the next.
  expect(focusAfter(before, ['b', 'c', 'a'], 'a')).toBe('b');
  expect(focusAfter(['a'], [], 'a')).toBe(null);
});

test('j and k step through the cards and stop at the ends', () => {
  const keys = ['a', 'b', 'c'];
  expect(step(keys, null, 1)).toBe('a');
  expect(step(keys, 'a', 1)).toBe('b');
  expect(step(keys, 'c', 1)).toBe('c');
  expect(step(keys, 'a', -1)).toBe('a');
  expect(step(keys, 'gone', -1)).toBe('a');
  expect(step([], 'a', 1)).toBe(null);
});
