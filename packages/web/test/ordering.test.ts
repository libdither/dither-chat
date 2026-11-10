import { describe, expect, test } from 'bun:test';
import { filterKeeps, inboxChanged, inboxFilterOf, inboxLift, inboxSections, inboxSnapshot, inboxView, rank, RESORT_EVERY, sameSnapshot, shouldResort, sortKeys, stabilize, switcherOrder, type Candidate, type Ranked, type Sortable } from '../src/ordering.ts';
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
  const r = (key: string, score: number, extra: Partial<Ranked> = {}): Ranked => ({ key, score, ...extra });
  const u = (x: Ranked) => ({ ...x, unread: false });

  test('one order, by score; ties go by the latest message, then never flicker', () => {
    expect(rank([r('a', 5), r('b', 30), r('c', 18), r('d', 5)])).toEqual(['b', 'c', 'a', 'd']);
    expect(rank([r('a', 5, { last: 1 }), r('b', 5, { last: 9 })])).toEqual(['b', 'a']);
  });

  test('muted places go last, however high they score', () => {
    expect(rank([r('n', 40), r('m', 90, { muted: true }), r('z', 2)])).toEqual(['n', 'z', 'm']);
  });

  test('between snapshots nothing moves: new scores wait, new rows go at the end', () => {
    const snap = inboxSnapshot([{ ...r('a', 50), unread: true }, u(r('b', 30)), u(r('c', 5))]);
    expect(snap).toEqual({ keys: ['a', 'b', 'c'], unread: ['a'], waiting: [] });
    // a was read and sank, c got a message and rose, d is new.
    const fresh = [r('a', 3), r('b', 30), r('c', 60), r('d', 70)];
    expect(inboxView(snap, fresh)).toEqual(['a', 'b', 'c', 'd']);
    expect(inboxChanged(snap, fresh)).toBe(true);
    // A row that went away takes nothing else with it.
    expect(inboxView(snap, [r('b', 30), r('c', 5)])).toEqual(['b', 'c']);
    // The next snapshot takes the fresh order.
    const next = inboxSnapshot(fresh.map(u));
    expect(inboxView(next, fresh)).toEqual(['d', 'c', 'b', 'a']);
    expect(inboxChanged(next, fresh)).toBe(false);
  });

  test('the open conversation keeps its place until you leave it', () => {
    const prev = inboxSnapshot([r('a', 60), r('b', 50), r('c', 40), r('d', 5)].map(u));
    // You opened b and answered it: its score changed.
    const fresh = [r('a', 60), r('b', 12), r('c', 40), r('d', 5), r('e', 70)];
    const held = inboxSnapshot(fresh.map(u), { key: 'b', prev });
    expect(held).toEqual({ keys: ['e', 'b', 'a', 'c', 'd'], unread: [], waiting: [] });
    expect(inboxChanged(held, fresh, { key: 'b', prev: held })).toBe(false);
    // However high it scores now.
    const low = inboxSnapshot([r('a', 60), r('b', 50), r('d', 5)].map(u));
    expect(inboxSnapshot([r('a', 60), r('b', 50), r('d', 90)].map(u), { key: 'd', prev: low }).keys).toEqual(['a', 'b', 'd']);
    // Once you leave it, it goes where it belongs: with the hub's "you were here" points, near the top.
    expect(inboxSnapshot(fresh.map(u)).keys).toEqual(['e', 'a', 'c', 'b', 'd']);
    expect(inboxSnapshot([...fresh.filter((x) => x.key !== 'b'), r('b', 12 + 30)].map(u)).keys).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  test('a filter hides rows without moving the others', () => {
    const snap = inboxSnapshot([r('dm1', 50), r('g1', 40), r('dm2', 10), r('g2', 5)].map(u));
    const fresh = [r('dm1', 50), r('g1', 40), r('dm2', 10), r('g2', 5)];
    expect(inboxView(snap, fresh, (k) => k.startsWith('g'))).toEqual(['g1', 'g2']);
    expect(inboxView(snap, fresh, (k) => k.startsWith('dm'))).toEqual(['dm1', 'dm2']);
  });
});

describe('the inbox sections', () => {
  const r = (key: string, score: number, x: { unread?: boolean; waiting?: boolean } = {}) => ({ key, score, unread: !!x.unread, waiting: !!x.waiting });
  const now = (rows: ReturnType<typeof r>[]) => (k: string) => rows.find((x) => x.key === k)!;

  test('waiting on you, then new, then earlier, each in the learned order', () => {
    const rows = [r('a', 90, { unread: true }), r('b', 80, { waiting: true }), r('c', 70), r('d', 60, { waiting: true, unread: true }), r('e', 50, { unread: true }), r('f', 40)];
    const snap = inboxSnapshot(rows);
    expect(snap.waiting).toEqual(['b', 'd']);
    // Unread and waiting is waiting: the turn you owe says more than the badge.
    expect(inboxSections(inboxView(snap, rows), snap, now(rows))).toEqual({ waiting: ['b', 'd'], new: ['a', 'e'], earlier: ['c', 'f'] });
  });

  test('reading or answering a row moves it at the next snapshot, not before', () => {
    const rows = [r('a', 90, { unread: true }), r('b', 80, { waiting: true }), r('c', 70)];
    const snap = inboxSnapshot(rows);
    // a was read, b answered, c got a message: until the next snapshot each stays where it was.
    const fresh = [r('a', 20), r('b', 30), r('c', 85, { unread: true })];
    expect(inboxSections(inboxView(snap, fresh), snap, now(fresh))).toEqual({ waiting: ['b'], new: ['a'], earlier: ['c'] });
    expect(inboxChanged(snap, fresh)).toBe(true);
    const next = inboxSnapshot(fresh);
    expect(inboxSections(inboxView(next, fresh), next, now(fresh))).toEqual({ waiting: [], new: ['c'], earlier: ['b', 'a'] });
    expect(inboxChanged(next, fresh)).toBe(false);
  });

  test('a row read in place, with the order unchanged, still asks for a new snapshot', () => {
    const rows = [r('a', 50, { unread: true }), r('b', 40)];
    const snap = inboxSnapshot(rows);
    expect(inboxChanged(snap, [r('a', 50), r('b', 40)])).toBe(true);
    expect(inboxChanged(snap, rows)).toBe(false);
  });

  test('a row newer than the snapshot goes by what it is now, at the end of its section', () => {
    const rows = [r('a', 90, { waiting: true }), r('b', 50)];
    const snap = inboxSnapshot(rows);
    const fresh = [...rows, r('n', 99, { unread: true }), r('w', 98, { waiting: true })];
    expect(inboxSections(inboxView(snap, fresh), snap, now(fresh))).toEqual({ waiting: ['a', 'w'], new: ['n'], earlier: ['b'] });
  });

  test('the open conversation keeps its section as well as its place', () => {
    const prev = inboxSnapshot([r('a', 90, { waiting: true }), r('b', 80, { unread: true }), r('c', 70)]);
    // You opened b and read it: still under New while it is open.
    const fresh = [r('a', 90, { waiting: true }), r('b', 20), r('c', 70)];
    const held = inboxSnapshot(fresh, { key: 'b', prev });
    expect(held.unread).toEqual(['b']);
    expect(inboxSections(inboxView(held, fresh), held, now(fresh))).toEqual({ waiting: ['a'], new: ['b'], earlier: ['c'] });
    expect(inboxChanged(held, fresh, { key: 'b', prev: held })).toBe(false);
    // Opened a, answered it: still waiting while it is open; once you leave, it goes.
    const answered = [r('a', 40), r('b', 20), r('c', 70)];
    expect(inboxSnapshot(answered, { key: 'a', prev }).waiting).toEqual(['a']);
    expect(inboxSnapshot(answered).waiting).toEqual([]);
  });

  test('a snapshot from before the sections has nothing waiting', () => {
    const old = { keys: ['a', 'b'], unread: ['b'] };
    expect(inboxSections(['a', 'b'], old, () => ({ unread: true, waiting: true }))).toEqual({ waiting: [], new: ['b'], earlier: ['a'] });
  });
});

describe('the inbox filter', () => {
  const dm = { mail: false, direct: true };
  const group = { mail: false, direct: false };
  const mailOne = { mail: true, direct: true };
  const mailMany = { mail: true, direct: false };
  test('direct messages, groups and mail split everything between them', () => {
    for (const x of [dm, group, mailOne, mailMany]) {
      expect(filterKeeps('all', x)).toBe(true);
      expect([filterKeeps('direct', x), filterKeeps('groups', x), filterKeeps('mail', x)].filter(Boolean).length).toBe(1);
    }
    expect(filterKeeps('direct', dm)).toBe(true);
    expect(filterKeeps('direct', mailOne)).toBe(false);
    expect(filterKeeps('groups', group)).toBe(true);
    expect(filterKeeps('mail', mailMany)).toBe(true);
  });
  test('a stored chip from before the menu: People is the DMs, Unread is all (the New section)', () => {
    expect(inboxFilterOf('people')).toBe('direct');
    expect(inboxFilterOf('unread')).toBe('all');
    expect(inboxFilterOf('groups')).toBe('groups');
    expect(inboxFilterOf('mail')).toBe('mail');
    expect(inboxFilterOf(undefined)).toBe('all');
    expect(inboxFilterOf('nonsense')).toBe('all');
  });
});

describe('the switcher', () => {
  const c = (key: string, match: number, score: number | null = null, last = 0): Candidate => ({ key, match, score, last });

  test('the inbox score lifts a match: twice per 50 points, a muted place counts half', () => {
    expect(inboxLift(0)).toBe(1);
    expect(inboxLift(50)).toBe(2);
    expect(inboxLift(-50)).toBe(0.5);
    expect(inboxLift(null)).toBe(1);
  });

  test('match quality times the score', () => {
    // Both start with what you typed: the one you are likelier to want first.
    expect(switcherOrder([c('sam', 997, 5), c('sara', 996, 60)])).toEqual(['sara', 'sam']);
    // A name that starts with it beats one that only contains it, unless the other is far more likely.
    expect(switcherOrder([c('prefix', 990, 10), c('inside', 495, 20)])).toEqual(['prefix', 'inside']);
    expect(switcherOrder([c('prefix', 990, 0), c('inside', 495, 80)])).toEqual(['inside', 'prefix']);
    // Without a score: as well as the name matches, then the latest message.
    expect(switcherOrder([c('a', 500, null, 1), c('b', 500, null, 9), c('c', 800)])).toEqual(['c', 'b', 'a']);
    // A poor match never turns a score upside down.
    expect(switcherOrder([c('x', -40, 50), c('y', -10, -50)])).toEqual(['x', 'y']);
  });
});
