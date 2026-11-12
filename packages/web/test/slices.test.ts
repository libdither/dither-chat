/** src/slices.ts: how much of a timeline is drawn when it shows, and how the rest follows a slice at a time. */
import { expect, test } from 'bun:test';
import { FIRST, SLICE, Slices } from '../src/slices.ts';

/** Every start a timeline asking for messages `start` to `end` goes through, slice by slice, from the first draw. */
function walk(s: Slices, start: number, end: number): number[] {
  const seen = [s.start(start, end)];
  while (s.start(start, end) > start) {
    s.next(start, end);
    seen.push(s.start(start, end));
  }
  return seen;
}

test('a timeline shows its newest FIRST, then SLICE more a time, up to what it asks for', () => {
  const s = new Slices();
  s.begin('c:1');
  // A first page of 60: 15, then 30, 45, all.
  expect(walk(s, 0, 60)).toEqual([60 - FIRST, 60 - FIRST - SLICE, 60 - FIRST - 2 * SLICE, 0]);
  expect(s.n).toBeNull();
  // Done: a message arriving is drawn with the rest.
  expect(s.start(0, 61)).toBe(0);
});

test('a short timeline is drawn whole at once', () => {
  const s = new Slices();
  s.begin('c:1');
  expect(s.start(0, FIRST)).toBe(0);
  expect(s.start(0, 3)).toBe(0);
});

test('the window of a long one (its newest 150 of 400) comes in slices too, and only to its own start', () => {
  const s = new Slices();
  s.begin('c:big');
  const starts = walk(s, 250, 400);
  expect(starts[0]).toBe(400 - FIRST);
  expect(starts.at(-1)).toBe(250);
  expect(starts.length).toBe(Math.ceil((150 - FIRST) / SLICE) + 1);
});

test('counted from the newest end: a message arriving or an older page coming in leaves what is drawn alone', () => {
  const s = new Slices();
  s.begin('c:1');
  expect(s.start(0, 60)).toBe(45);
  // An older page of 60 comes in above: the same 15 newest are drawn.
  expect(s.start(0, 120)).toBe(105);
  // One arrives at the bottom: the 15 newest, the oldest of them going until the next slice.
  expect(s.start(0, 121)).toBe(106);
});

test('the same timeline again keeps its place; another one starts over', () => {
  const s = new Slices();
  s.begin('c:1');
  s.next(0, 60);
  s.begin('c:1');
  expect(s.start(0, 60)).toBe(60 - FIRST - SLICE);
  s.begin('c:2');
  expect(s.start(0, 60)).toBe(60 - FIRST);
});

test('whole draws everything asked for at once (a message linked to); extend asks for more above in slices', () => {
  const s = new Slices();
  s.begin('c:1');
  s.whole();
  expect(s.start(250, 400)).toBe(250);
  // Scrolled near the top of the 150 drawn (250 to 400), asking for 100 more held above: one slice at once, then
  // the rest.
  s.extend(150);
  expect(s.start(150, 400)).toBe(400 - 150 - SLICE);
  expect(walk(s, 150, 400).at(-1)).toBe(150);
  // Fewer held than a slice: all of them at once.
  s.extend(150);
  expect(s.start(240, 400)).toBe(240);
});
