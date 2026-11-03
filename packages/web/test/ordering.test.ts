import { describe, expect, test } from 'bun:test';
import { RESORT_EVERY, sameSnapshot, shouldResort, sortKeys, stabilize, type Sortable } from '../src/ordering.ts';
import { IDLE_AFTER, Tracker, VISIT_AFTER } from '../src/tracker.ts';

const p = (key: string, o: Partial<Sortable> = {}): Sortable => ({ key, name: key.split(':')[1], pinned: false, position: null, last: 0, score: 0, ...o });

describe('sort modes', () => {
  const items = [
    p('space:b', { position: 0, last: 10, score: 5 }),
    p('space:a', { position: 1, last: 30, score: 50 }),
    p('space:c', { position: 2, last: 20, score: 1 }),
    p('space:pin2', { pinned: true, position: 4, last: 99, score: 999 }),
    p('space:pin1', { pinned: true, position: 3, last: 0, score: 0 }),
  ];
  test('manual is your order; pinned first in every mode, in your order', () => {
    expect(sortKeys(items, 'manual')).toEqual(['space:pin1', 'space:pin2', 'space:b', 'space:a', 'space:c']);
    expect(sortKeys(items, 'smart')).toEqual(['space:pin1', 'space:pin2', 'space:a', 'space:b', 'space:c']);
    expect(sortKeys(items, 'recent')).toEqual(['space:pin1', 'space:pin2', 'space:a', 'space:c', 'space:b']);
    expect(sortKeys(items, 'az')).toEqual(['space:pin1', 'space:pin2', 'space:a', 'space:b', 'space:c']);
  });
  test('A–Z ignores case and reads numbers as numbers', () => {
    const xs = [p('space:x', { name: 'Server 10' }), p('space:y', { name: 'server 9' }), p('space:z', { name: 'Alpha' })];
    expect(sortKeys(xs, 'az')).toEqual(['space:z', 'space:y', 'space:x']);
  });
  test('smart with no usage at all falls back to the latest message', () => {
    const xs = [p('space:old', { last: 1 }), p('space:new', { last: 2 })];
    expect(sortKeys(xs, 'smart')).toEqual(['space:new', 'space:old']);
  });
  test('a folder sorts as one, by its best member', () => {
    const folder = p('folder:f', { name: 'Work', members: [p('space:m1', { score: 2, last: 1 }), p('space:m2', { score: 80, last: 2 })] });
    const xs = [p('space:a', { score: 50, last: 5 }), folder, p('space:b', { score: 10, last: 9 })];
    expect(sortKeys(xs, 'smart')).toEqual(['folder:f', 'space:a', 'space:b']);
    expect(sortKeys(xs, 'recent')).toEqual(['space:b', 'space:a', 'folder:f']);
    // Its contents sort the same way inside.
    expect(sortKeys(folder.members!, 'smart')).toEqual(['space:m2', 'space:m1']);
  });
});

describe('no reshuffle under the pointer', () => {
  test('the snapshot keeps its order; new places go after it; gone ones go', () => {
    const snap = ['space:a', 'space:b', 'space:c'];
    expect(stabilize(snap, ['space:c', 'space:b', 'space:a'])).toEqual(snap);
    expect(stabilize(snap, ['space:new', 'space:c', 'space:a'])).toEqual(['space:a', 'space:c', 'space:new']);
    expect(stabilize(undefined, ['space:x', 'space:y'])).toEqual(['space:x', 'space:y']);
  });

  const at = 1_000_000;
  test('a timer waits a few minutes and for nobody to be using the list', () => {
    expect(shouldResort({ reason: 'timer', now: at + 60_000, last: at, interacting: false })).toBe(false);
    expect(shouldResort({ reason: 'timer', now: at + RESORT_EVERY, last: at, interacting: false })).toBe(true);
    expect(shouldResort({ reason: 'timer', now: at + RESORT_EVERY, last: at, interacting: true })).toBe(false);
  });
  test('starting and coming back to the front resort, but not during a drag or a menu', () => {
    expect(shouldResort({ reason: 'start', now: at, last: null, interacting: false })).toBe(true);
    expect(shouldResort({ reason: 'foreground', now: at + 1000, last: at, interacting: false })).toBe(true);
    expect(shouldResort({ reason: 'start', now: at, last: null, interacting: true })).toBe(false);
    expect(shouldResort({ reason: 'foreground', now: at, last: at, interacting: true })).toBe(false);
  });
  test('what you ask for happens at once', () => {
    expect(shouldResort({ reason: 'mode', now: at, last: at, interacting: true })).toBe(true);
    expect(shouldResort({ reason: 'asked', now: at, last: at, interacting: true })).toBe(true);
  });
  test('an unchanged order is not a change (nothing animates)', () => {
    expect(sameSnapshot({ rail: ['a', 'b'] }, { rail: ['a', 'b'] })).toBe(true);
    expect(sameSnapshot({ rail: ['a', 'b'] }, { rail: ['b', 'a'] })).toBe(false);
    expect(sameSnapshot({ rail: ['a'] }, { rail: ['a'], people: ['p'] })).toBe(false);
  });
});

describe('measuring', () => {
  test('time goes to the open place, only while in use', () => {
    const t = new Tracker(0);
    t.update(0, ['space:a', 'conversation:c'], true);
    t.update(10_000, ['space:a', 'conversation:c'], true);
    t.update(20_000, ['space:b'], false); // the 10 s before this still count for a and c
    t.update(80_000, ['space:b'], true); // 60 s in the background count for nothing
    t.update(85_000, ['space:b'], true);
    const d = Object.fromEntries(t.take().map((x) => [`${x.kind}:${x.id}`, x]));
    expect(d['space:a'].seconds).toBe(20);
    expect(d['conversation:c'].seconds).toBe(20);
    expect(d['space:b'].seconds).toBe(5);
    expect(t.take()).toEqual([]);
  });
  test('a visit counts after a few seconds, once per stay', () => {
    const t = new Tracker(0);
    t.update(0, ['space:a'], true);
    t.update(1000, ['space:b'], true); // passing through a
    t.update((1 + VISIT_AFTER) * 1000, ['space:b'], true);
    t.update(60_000, ['space:b'], true);
    t.update(61_000, ['space:a'], true);
    t.update(70_000, ['space:b'], true);
    const d = Object.fromEntries(t.take().map((x) => [`${x.kind}:${x.id}`, x]));
    expect(d['space:a'].visits).toBe(1); // 1 s then 9 s: only the second stay
    expect(d['space:b'].visits).toBe(1);
    expect(d['space:b'].lastVisit).toBe((1 + VISIT_AFTER) * 1000);
  });
  test('a laptop that slept does not count the night', () => {
    const t = new Tracker(0);
    t.update(0, ['space:a'], true);
    t.update(8 * 3_600_000, ['space:a'], true);
    expect(t.take()[0].seconds).toBeLessThanOrEqual(30);
    expect(IDLE_AFTER).toBe(5 * 60_000);
  });
  test('coming back after a long time is a new visit', () => {
    const t = new Tracker(0);
    t.update(0, ['space:a'], true);
    t.update(5000, ['space:a'], false);
    t.newStay();
    t.update(4 * 3_600_000, ['space:a'], true);
    t.update(4 * 3_600_000 + 5000, ['space:a'], true);
    expect(t.take()[0].visits).toBe(2);
  });
});
