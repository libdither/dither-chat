/** src/foryou.ts: when an item counts as shown, how its time on screen sums, and when the snapshot is taken afresh. */
import { describe, expect, test } from 'bun:test';
import { burstLine, Impressions, onScreen, RESEND_MS, SESSION_GAP, wantsFresh } from '../src/foryou.ts';

describe('on screen', () => {
  test('half of the item, or half the pane for a tall one', () => {
    expect(onScreen(0.5, 100, 800)).toBe(true);
    expect(onScreen(0.49, 100, 800)).toBe(false);
    expect(onScreen(0.3, 420, 800)).toBe(true);
  });
});

describe('impressions', () => {
  test('time counts only while on screen and the page in use; shown is when both first held', () => {
    const s = new Impressions(0);
    s.set('a', true, 0, false);
    s.tick(2000, false);
    expect(s.shownMs('a')).toBeNull();
    s.tick(3000, true);
    s.tick(4500, true);
    expect(s.shownMs('a')).toBe(1500);
    s.set('a', false, 5000, true);
    s.tick(9000, true);
    expect(s.shownMs('a')).toBe(2000);
    const [e] = s.due('dev-1');
    expect(e).toEqual({ itemId: 'a', device: 'dev-1', kind: 'shown', at: 3000, ms: 2000 });
  });

  test('a shown item is sent once, then again as its time grows by a second; a long sleep counts a few seconds at most', () => {
    const s = new Impressions(0);
    s.set('a', true, 0, true);
    expect(s.due('d').map((e) => e.ms)).toEqual([0]);
    s.tick(RESEND_MS - 1, true);
    expect(s.due('d')).toEqual([]);
    expect(s.due('d', true).map((e) => e.ms)).toEqual([RESEND_MS - 1]);
    s.tick(10 * 60_000, true);
    expect(s.shownMs('a')!).toBeLessThan(10_000);
  });

  test('never seen, nothing to send', () => {
    const s = new Impressions(0);
    s.set('a', false, 0, true);
    s.tick(5000, true);
    expect(s.due('d', true)).toEqual([]);
  });
});

test('a fresh snapshot with none yet, or after a while away', () => {
  expect(wantsFresh({ epoch: null, closedAt: null }, 0)).toBe(true);
  expect(wantsFresh({ epoch: 'e', closedAt: null }, 0)).toBe(false);
  expect(wantsFresh({ epoch: 'e', closedAt: 0 }, SESSION_GAP)).toBe(false);
  expect(wantsFresh({ epoch: 'e', closedAt: 0 }, SESSION_GAP + 1)).toBe(true);
});

test('the burst line', () => {
  expect(burstLine(1, '#general')).toBeNull();
  expect(burstLine(7, '#general')).toBe('+6 more in #general');
});
