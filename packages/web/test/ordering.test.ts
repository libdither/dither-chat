import { describe, expect, test } from 'bun:test';
import { inboxChanged, inboxSnapshot, inboxView, rank, RESORT_EVERY, sameSnapshot, shouldResort, sortKeys, stabilize, type Ranked, type Sortable } from '../src/ordering.ts';
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
  test('a change in the inbox ranking waits for a quiet moment, but not for the timer', () => {
    expect(shouldResort({ reason: 'activity', now: at + 1000, last: at, interacting: false })).toBe(true);
    expect(shouldResort({ reason: 'activity', now: at + 1000, last: at, interacting: true })).toBe(false);
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

describe('the inbox', () => {
  const r = (key: string, score: number, needs = score >= 20): Ranked => ({ key, score, needs });

  test('what needs you comes first, then by score; ties never flicker', () => {
    expect(rank([r('a', 5), r('b', 30), r('c', 18, true), r('d', 5)])).toEqual(['b', 'c', 'a', 'd']);
  });

  test('the "caught up" line goes after what needs you', () => {
    expect(inboxView(null, [r('a', 5), r('b', 30), r('c', 40)])).toEqual({ keys: ['c', 'b', 'a'], divider: 2 });
    expect(inboxView(null, [r('a', 5)]).divider).toBe(0);
    expect(inboxView(null, [r('a', 50)]).divider).toBe(1);
  });

  test('between snapshots nothing moves: new scores wait, new rows go at the end, the line stays put', () => {
    const snap = inboxSnapshot([{ ...r('a', 50), unread: true }, { ...r('b', 30), unread: false }, { ...r('c', 5), unread: false }]);
    expect(snap).toEqual({ keys: ['a', 'b', 'c'], needs: 2, unread: ['a'] });
    // a was read and sank, c got a message and rose, d is new and needs you.
    const fresh = [r('a', 3), r('b', 30), r('c', 60), r('d', 70)];
    expect(inboxView(snap, fresh)).toEqual({ keys: ['a', 'b', 'c', 'd'], divider: 2 });
    expect(inboxChanged(snap, fresh)).toBe(true);
    // A row that went away takes nothing else with it.
    expect(inboxView(snap, [r('b', 30), r('c', 5)])).toEqual({ keys: ['b', 'c'], divider: 1 });
    // The next snapshot takes the fresh order.
    const next = inboxSnapshot(fresh.map((x) => ({ ...x, unread: false })));
    expect(inboxView(next, fresh)).toEqual({ keys: ['d', 'c', 'b', 'a'], divider: 3 });
    expect(inboxChanged(next, fresh)).toBe(false);
  });

  test('the open conversation keeps its place, on its side of the line, until you leave it', () => {
    const u = (x: Ranked) => ({ ...x, unread: false });
    const prev = inboxSnapshot([r('a', 60), r('b', 50), r('c', 40), r('d', 5)].map(u));
    // You opened b and answered it: it no longer needs you and would sink below the line.
    const fresh = [r('a', 60), r('b', 12), r('c', 40), r('d', 5), r('e', 70)];
    const held = inboxSnapshot(fresh.map(u), { key: 'b', prev });
    expect(held).toEqual({ keys: ['e', 'b', 'a', 'c', 'd'], needs: 4, unread: [] });
    expect(inboxChanged(held, fresh, { key: 'b', prev: held })).toBe(false);
    // A row below the line stays below it, however high it scores now.
    const low = inboxSnapshot([r('a', 60), r('b', 50), r('d', 5)].map(u));
    expect(inboxSnapshot([r('a', 60), r('b', 50), r('d', 90)].map(u), { key: 'd', prev: low })).toMatchObject({ keys: ['a', 'b', 'd'], needs: 2 });
    // Once you leave it, it goes where it belongs.
    expect(inboxSnapshot(fresh.map(u)).keys).toEqual(['e', 'a', 'c', 'b', 'd']);
  });

  test('a filter hides rows without moving the others or the line', () => {
    const snap = inboxSnapshot([r('dm1', 50), r('g1', 40), r('dm2', 10), r('g2', 5)].map((x) => ({ ...x, unread: false })));
    const fresh = [r('dm1', 50), r('g1', 40), r('dm2', 10), r('g2', 5)];
    expect(inboxView(snap, fresh, (k) => k.startsWith('g'))).toEqual({ keys: ['g1', 'g2'], divider: 1 });
    expect(inboxView(snap, fresh, (k) => k.startsWith('dm'))).toEqual({ keys: ['dm1', 'dm2'], divider: 1 });
  });
});
