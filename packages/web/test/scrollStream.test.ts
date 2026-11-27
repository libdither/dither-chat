/** src/scrollStream.ts and syncmodel.ts mergeMessages: proactive upward scroll streaming and bulk page merging. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { DRAW_RUNWAY_MIN, PREFETCH_BUFFER, PREFETCH_RUNWAY_MIN, ScrollStream, URGENT_PX, type ScrollSample } from '../src/scrollStream.ts';
import { mergeMessages } from '../src/syncmodel.ts';

function sample(over: Partial<ScrollSample> = {}): ScrollSample {
  return {
    scrollTop: 0,
    scrollHeight: 4000,
    clientHeight: 800,
    now: 1000,
    more: false,
    start: 0,
    hasMore: true,
    loading: false,
    prefetching: false,
    offline: false,
    ...over,
  };
}

test('at rest at the newest end, nothing is drawn or prefetched', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  expect(s.plan(sample({ scrollTop: 0, now: 100 }))).toEqual({ draw: 'none', fetch: 'none' });
  expect(s.plan(sample({ scrollTop: 0, now: 200 }))).toEqual({ draw: 'none', fetch: 'none' });
});

test('scrolling up triggers silent prefetch well before hitting the top edge', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  s.plan(sample({ scrollTop: -200, now: 100 }));
  // Top remaining = 4000 - 1400 - 800 = 1800 -> just under prefetch runway (2.5 * 800 = 2000).
  const p = s.plan(sample({ scrollTop: -1400, now: 150, start: 0 }));
  expect(p.fetch).toBe('prefetch');
  expect(p.draw).toBe('none');
});

test('prefetch does not fire while a full buffer of older messages sits undrawn in memory', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  s.plan(sample({ scrollTop: -1200, now: 100, start: PREFETCH_BUFFER }));
  const p = s.plan(sample({ scrollTop: -2200, now: 150, start: PREFETCH_BUFFER }));
  expect(p.fetch).toBe('none');
  // Top remaining = 4000 - 2200 - 800 = 1000 < DRAW_RUNWAY_MIN -> streams a slice per frame.
  expect(p.draw).toBe('frame');
});

test('jumping straight to the top edge requests an urgent load (or immediate draw if buffered)', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  // No buffered messages: urgent fetch.
  expect(s.plan(sample({ scrollTop: -3200, now: 100, start: 0 }))).toEqual({ draw: 'none', fetch: 'urgent' });
  // Buffered messages available: immediate draw, no fetch yet.
  expect(s.plan(sample({ scrollTop: -3200, now: 120, start: 30 }))).toEqual({ draw: 'immediate', fetch: 'none' });
  // Already prefetching silently when user hits top wall: promote to urgent visible load.
  expect(s.plan(sample({ scrollTop: -3200, now: 140, start: 0, loading: true, prefetching: true }))).toEqual({ draw: 'none', fetch: 'urgent' });
  // Already visibly loading: do not re-trigger.
  expect(s.plan(sample({ scrollTop: -3200, now: 160, start: 0, loading: true, prefetching: false }))).toEqual({ draw: 'none', fetch: 'none' });
});

test('scrolling down resets upward velocity and does not speculatively prefetch or stream', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  s.plan(sample({ scrollTop: -1800, now: 100, start: 20 }));
  s.plan(sample({ scrollTop: -2200, now: 150, start: 20 }));
  expect(s.velocity).toBeGreaterThan(0);
  // Reverse direction (scrolling down toward newest): scrollTop becomes less negative.
  const p = s.plan(sample({ scrollTop: -2100, now: 200, start: 20 }));
  expect(s.velocity).toBe(0);
  expect(p).toEqual({ draw: 'none', fetch: 'none' });
});

test('faster upward velocity expands draw and prefetch runways', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  // 5000 px/s upward scroll -> draw runway scales up to ~2500px, prefetch runway ~4500px.
  s.plan(sample({ scrollTop: -500, scrollHeight: 8000, now: 100, start: 30 }));
  const p = s.plan(sample({ scrollTop: -750, scrollHeight: 8000, now: 150, start: 30 }));
  // Top remaining = 8000 - 750 - 800 = 6450 (still beyond runway).
  expect(p).toEqual({ draw: 'none', fetch: 'none' });
  // Now at topRemaining = 2100 (< 2500 velocity-scaled draw runway, > DRAW_RUNWAY_MIN).
  const p2 = s.plan(sample({ scrollTop: -5100, scrollHeight: 8000, now: 200, start: 30 }));
  expect(p2.draw).toBe('frame');
  expect(p2.fetch).toBe('prefetch');
  expect(DRAW_RUNWAY_MIN).toBeLessThan(PREFETCH_RUNWAY_MIN);
  expect(URGENT_PX).toBeLessThan(DRAW_RUNWAY_MIN);
});

test('offline suppresses fetches while still streaming buffered messages', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  s.plan(sample({ scrollTop: -2000, now: 100, start: 10, offline: true }));
  const p = s.plan(sample({ scrollTop: -2600, now: 150, start: 10, offline: true }));
  expect(p.draw).toBe('frame');
  expect(p.fetch).toBe('none');
});

test('stationary post-settle check after an older page loads does not trigger an unsolicited prefetch', () => {
  const s = new ScrollStream();
  s.begin('c:1');
  s.plan(sample({ scrollTop: 0, scrollHeight: 4000, now: 100 }));
  // Jump to top edge -> urgent load.
  expect(s.plan(sample({ scrollTop: -3200, scrollHeight: 4000, now: 150 }))).toEqual({ draw: 'none', fetch: 'urgent' });
  // Page loads (scrollHeight grows to 6400), 300 ms later post-settle check fires at the same scrollTop.
  expect(s.plan(sample({ scrollTop: -3200, scrollHeight: 6400, now: 450 }))).toEqual({ draw: 'none', fetch: 'none' });
  expect(s.velocity).toBe(0);
});

const msg = (id: string, ts: number, body = id): P.MessageView => ({ id, ts, body } as unknown as P.MessageView);

test('mergeMessages prepends older pages, updates duplicates, and keeps time order', () => {
  const list = [msg('m4', 400), msg('m5', 500)];
  mergeMessages(list, [msg('m1', 100), msg('m2', 200), msg('m3', 300)]);
  expect(list.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

  // Interleaved timestamps + duplicate replacement.
  mergeMessages(list, [msg('m3', 300, 'edited'), msg('m2b', 250), msg('m6', 600)]);
  expect(list.map((m) => `${m.id}:${m.body}`)).toEqual(['m1:m1', 'm2:m2', 'm2b:m2b', 'm3:edited', 'm4:m4', 'm5:m5', 'm6:m6']);
});
