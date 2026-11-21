/** The visit recorder behind activity.ts (docs/activity.md): stays, how they began, what happened, what gets sent. */
import { describe, expect, test } from 'bun:test';
import { firstTap, shadowRankOf, TAPS_KEPT, VisitLog } from '../src/visits.ts';

const T0 = Date.UTC(2026, 9, 1, 9);
const S = 1000;
let n = 0;
const fresh = () => new VisitLog('dev1', 'Firefox on Linux', T0, () => `v${++n}`);
const dm = { view: 'conversation' as const, conversationId: 'c1', personId: 'p1' };

test('a stay counts time only while in use, by the same rules as usage', () => {
  const log = fresh();
  log.enter(T0, dm, { source: 'inbox', rank: 2, score: 41.5, needs: true }, true);
  log.update(T0 + 10 * S, true);
  // In the background for a minute: nothing.
  log.update(T0 + 20 * S, false);
  log.update(T0 + 80 * S, true);
  // One tick never counts for more than 30 s (a laptop that slept).
  log.update(T0 + 10 * 60 * S, true);
  const v = log.current!;
  expect(v.active).toBe(10 + 10 + 30);
  expect(v.end).toBe(T0 + 10 * 60 * S);
  expect(v).toMatchObject({ source: 'inbox', rank: 2, score: 41.5, needs: true, device: 'dev1', deviceLabel: 'Firefox on Linux', personId: 'p1' });
});

test('moving on closes the stay and names where the user went; the same place goes on', () => {
  const log = fresh();
  log.enter(T0, dm, { source: 'rail' }, true);
  expect(log.enter(T0 + 2 * S, { ...dm }, { source: 'link' }, true)).toBe(false);
  log.enter(T0 + 10 * S, { view: 'inbox' }, { source: 'rail' }, true);
  const [first, second] = log.take();
  expect(first).toMatchObject({ view: 'conversation', closed: true, next: 'inbox', active: 10, source: 'rail' });
  // The inbox stay is under 3 s so far: not sent yet.
  expect(second).toBeUndefined();
  log.update(T0 + 20 * S, true);
  expect(log.take()).toMatchObject([{ view: 'inbox', closed: false }]);
});

test('passing through is not kept, unless a notification led there or something was done', () => {
  const log = fresh();
  log.enter(T0, { view: 'space', spaceId: 's1' }, { source: 'rail' }, true);
  log.enter(T0 + S, dm, { source: 'notification', pushId: 'n1' }, true);
  log.enter(T0 + 2 * S, { view: 'conversation', conversationId: 'c2' }, { source: 'list' }, true);
  log.note('sent', 'c2');
  log.enter(T0 + 3 * S, { view: 'settings' }, { source: 'rail' }, true);
  expect(log.take().map((v) => [v.conversationId ?? v.view, v.source])).toEqual([
    ['c1', 'notification'],
    ['c2', 'list'],
  ]);
});

test('what the stay could see and left behind: the newest on screen, the reply owed as it began, typing, a draft and how it ended', () => {
  const drafts = new Set<string>();
  const log = new VisitLog('dev1', 'Firefox on Linux', T0, () => `v${++n}`, (c) => drafts.has(c), (c) => (c === 'c1' ? { since: T0 - 3600 * S, shown: true } : null));
  log.enter(T0, dm, { source: 'inbox' }, true);
  expect(log.current).toMatchObject({ owedSince: T0 - 3600 * S, owedShown: true, typed: 0, seenToTs: null, exit: null });
  log.seen(['c1', 'c9'], T0 + 7);
  log.seen(['c1'], T0 + 3);
  log.seen(['other'], T0 + 99);
  log.typed('c1');
  log.typed('c1');
  log.typed('other');
  drafts.add('c1');
  // Hidden for a moment, then back: how it ends is not known yet.
  log.away('hidden');
  expect(log.current).toMatchObject({ exit: 'hidden', draftLeft: true });
  log.away(null);
  log.update(T0 + 10 * S, true);
  log.enter(T0 + 10 * S, { view: 'conversation', conversationId: 'c2' }, { source: 'list' }, true);
  const [v] = log.take();
  expect(v).toMatchObject({ seenToTs: T0 + 7, typed: 2, draftLeft: true, exit: 'route', next: 'conversation' });
  expect(log.current).toMatchObject({ owedSince: null, owedShown: null });
  // Back after a long time away: the stay before ended with the app hidden.
  log.restart(T0 + 3600 * S, { source: 'resume' }, true);
  log.update(T0 + 3610 * S, true);
  expect(log.take()[0]).toMatchObject({ conversationId: 'c2', exit: 'hidden', draftLeft: false });
});

test('what happened during the stay, only for the conversation that is open', () => {
  const log = fresh();
  log.enter(T0, dm, { source: 'inbox' }, true);
  log.note('sent', 'c1');
  log.note('sent', 'elsewhere');
  log.note('reactions');
  log.note('history');
  log.note('history');
  log.note('attachments');
  log.read('c1', 'm5', T0 + 5);
  log.read('c1', 'm4', T0 + 4);
  log.read('other', 'm9', T0 + 9);
  expect(log.current).toMatchObject({ sent: 1, reactions: 1, history: 2, attachments: 1, readToId: 'm5', readToTs: T0 + 5 });
});

test('a notification tapped while already there starts a new stay; one that came a moment after the app came forward relabels it', () => {
  const log = fresh();
  log.enter(T0, dm, { source: 'inbox' }, true);
  log.update(T0 + 60 * S, true);
  log.restart(T0 + 60 * S, { source: 'notification', pushId: 'n1' }, true);
  expect(log.take().map((v) => [v.source, v.pushId, v.closed, v.next])).toEqual([
    ['inbox', null, true, 'conversation'],
    ['notification', 'n1', false, null],
  ]);

  const back = fresh();
  back.enter(T0, dm, { source: 'resume' }, true);
  expect(back.relabel(T0 + 500, { source: 'notification', pushId: 'n2' }, 3000)).toBe(true);
  expect(back.current).toMatchObject({ source: 'notification', pushId: 'n2' });
  // Too late to be the same arrival.
  expect(back.relabel(T0 + 10 * S, { source: 'notification', pushId: 'n3' }, 3000)).toBe(false);
});

test('a snapshot sent while the stay lasts is a copy: later changes do not alter what was sent', () => {
  const log = fresh();
  log.enter(T0, dm, { source: 'inbox' }, true);
  log.update(T0 + 5 * S, true);
  const [snap] = log.take();
  log.update(T0 + 9 * S, true);
  expect(snap.active).toBe(5);
  expect(log.current!.active).toBe(9);
  expect(snap.id).toBe(log.current!.id);
});

test('how far down the inbox was on screen: the deepest row of the stay, none when the list was not there', () => {
  const log = fresh();
  log.enter(T0, dm, { source: 'inbox', rank: 3 }, true);
  log.saw(null);
  expect(log.current!.depth).toBeNull();
  log.saw(9);
  log.saw(4);
  log.saw(null);
  expect(log.current!.depth).toBe(9);
  // A new stay starts over.
  log.enter(T0 + 10 * S, { view: 'inbox' }, { source: 'rail' }, true);
  expect(log.current!.depth).toBeNull();
});

test('a push opened from again is not a tap: the Android app made again starts from the intent that first launched it', () => {
  let seen: string[] = [];
  const open = (id: string) => {
    const t = firstTap(seen, id);
    seen = t.seen;
    return t.fresh;
  };
  expect(open('n1')).toBe(true);
  expect(open('n2')).toBe(true);
  // Android stopped the app; opened again later, it replays n1's hash.
  expect(open('n1')).toBe(false);
  expect(open('n1')).toBe(false);
  expect(seen).toEqual(['n1', 'n2']);
  // Bounded: the oldest go first.
  for (let i = 0; i < TAPS_KEPT; i++) open(`x${i}`);
  expect(seen).toHaveLength(TAPS_KEPT);
  expect(open('n1')).toBe(true);
});

describe('where an inbox row would stand in the shadow order', () => {
  const row = (shadow: number | null, score: number, muted = false) => ({ shadow, score, muted });
  test('by the shadow score, muted last, ties in the list’s order; the score where a row has none', () => {
    const rows = [row(10, 90), row(50, 80), row(null, 70), row(99, -50, true), row(50, 60)];
    expect(shadowRankOf(rows, 0)).toBe(3);
    expect(shadowRankOf(rows, 1)).toBe(1);
    // No shadow of its own: its score, 70, stands above 50 and 10.
    expect(shadowRankOf(rows, 2)).toBe(0);
    expect(shadowRankOf(rows, 3)).toBe(4);
    expect(shadowRankOf(rows, 4)).toBe(2);
  });

  test('null when the hub works out no shadow order, or there is no such row', () => {
    expect(shadowRankOf([row(null, 1), row(null, 2)], 1)).toBeNull();
    expect(shadowRankOf([row(3, 1)], 5)).toBeNull();
  });
});

test('a mail thread opened from an inbox row keeps its id, its row, and where the shadow order had it', () => {
  const log = fresh();
  log.enter(T0, { view: 'mail', conversationId: 'mth_1' }, { source: 'inbox', rank: 4, score: 30, needs: true, shadowRank: 1 }, true);
  log.update(T0 + 10 * S, true);
  expect(log.take()[0]).toMatchObject({ view: 'mail', conversationId: 'mth_1', source: 'inbox', rank: 4, shadowRank: 1 });
});
