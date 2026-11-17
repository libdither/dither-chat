/** A feed's orders (mix.ts): the same posts, by time, taking turns by share, by likes against age, or spread out. */
import { describe, expect, test } from 'bun:test';
import { engagement, orderMix, SPREAD_MS, type MixItem } from '../src/mix.ts';

const H = 3_600_000;
const NOW = 1_000 * H;
/** A timeline's posts, newest first: `<source><n>` keys, an hour apart from `start` hours ago. */
const line = (source: number, n: number, start = 0, author = (i: number) => `p${source}-${i}`): MixItem[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${source}:${i}`, source, rank: i, ts: NOW - (start + i) * H, author: author(i) }));

describe('newest first', () => {
  test('every timeline that is on, by time, a post in two timelines once', () => {
    const items = [...line(0, 3), ...line(1, 3, 0.5), { key: '0:1', source: 1, rank: 3, ts: NOW - 1 * H }];
    const o = orderMix(items, 'newest', [1, 1], [false, false], NOW);
    expect(o.keys).toEqual(['0:0', '1:0', '0:1', '1:1', '0:2', '1:2']);
    expect(o.cut).toBe(false);
  });
  test('a timeline with no share is left out, whatever its share does not matter', () => {
    expect(orderMix([...line(0, 2), ...line(1, 2)], 'newest', [0, 4], [false, false], NOW).keys).toEqual(['1:0', '1:1']);
  });
  test('stops at the oldest post held of a timeline with more at the network', () => {
    // Timeline 1 holds 2 posts (0 and 1 hours ago) and has more: posts older than 1 hour wait for its next page.
    const o = orderMix([...line(0, 5), ...line(1, 2)], 'newest', [1, 1], [false, true], NOW);
    expect(o.keys).toEqual(['0:0', '1:0', '0:1', '1:1']);
    expect(o.cut).toBe(true);
  });
  test('a timeline with more that holds nothing yet holds everything back', () => {
    expect(orderMix(line(0, 3), 'newest', [1, 1], [false, true], NOW)).toEqual({ keys: [], from: [], cut: true });
  });
});

describe('taking turns', () => {
  test('even shares alternate, each timeline in its own order', () => {
    const o = orderMix([...line(0, 3), ...line(1, 3)], 'turns', [1, 1], [false, false], NOW);
    expect(o.keys).toEqual(['0:0', '1:0', '0:1', '1:1', '0:2', '1:2']);
  });
  test('a share twice another gets twice the places, however busy each is', () => {
    const o = orderMix([...line(0, 30), ...line(1, 30)], 'turns', [2, 1], [false, false], NOW);
    const first = o.keys.slice(0, 30);
    expect(first.filter((k) => k.startsWith('0:')).length).toBe(20);
    expect(first.filter((k) => k.startsWith('1:')).length).toBe(10);
  });
  test('its own order, not time: a For you as the network ranked it', () => {
    const ranked: MixItem[] = [
      { key: 'a', source: 0, rank: 0, ts: NOW - 50 * H },
      { key: 'b', source: 0, rank: 1, ts: NOW },
    ];
    expect(orderMix(ranked, 'turns', [1], [false], NOW).keys).toEqual(['a', 'b']);
  });
  test('a post already shown through another timeline is skipped, not given a turn', () => {
    const items = [...line(0, 2), { key: '0:0', source: 1, rank: 0, ts: NOW }, { key: 'x', source: 1, rank: 1, ts: NOW }];
    const o = orderMix(items, 'turns', [1, 1], [false, false], NOW);
    expect(o.keys).toEqual(['0:0', 'x', '0:1']);
    expect(o.from).toEqual([0, 1, 0]);
  });
  test('a timeline that runs out with more at the network stops the list there; one with no more lets the rest go on', () => {
    expect(orderMix([...line(0, 5), ...line(1, 1)], 'turns', [1, 1], [false, true], NOW)).toEqual({ keys: ['0:0', '1:0', '0:1'], from: [0, 1, 0], cut: true });
    expect(orderMix([...line(0, 3), ...line(1, 1)], 'turns', [1, 1], [false, false], NOW).keys).toEqual(['0:0', '1:0', '0:1', '0:2']);
  });
});

describe('most liked', () => {
  test('what people did with a post, against its age', () => {
    const items: MixItem[] = [
      { key: 'old-big', source: 0, rank: 0, ts: NOW - 48 * H, engagement: 500 },
      { key: 'new-small', source: 0, rank: 1, ts: NOW, engagement: 2 },
      { key: 'new-big', source: 0, rank: 2, ts: NOW - H, engagement: 300 },
    ];
    expect(orderMix(items, 'liked', [1], [false], NOW).keys).toEqual(['new-big', 'old-big', 'new-small']);
  });
  test('a larger share lifts a timeline’s posts', () => {
    const items: MixItem[] = [
      { key: 'a', source: 0, rank: 0, ts: NOW, engagement: 10 },
      { key: 'b', source: 1, rank: 0, ts: NOW, engagement: 10 },
    ];
    expect(orderMix(items, 'liked', [1, 4], [false, false], NOW).keys).toEqual(['b', 'a']);
  });
  test('replies and reposts count more than likes', () => {
    expect(engagement({ likes: 2 })).toBeLessThan(engagement({ replies: 2 }));
    expect(engagement(undefined)).toBe(0);
  });
});

describe('spread out', () => {
  test('one busy person’s posts are spaced apart', () => {
    // Ann posts four times in the newest hour; Ben once, two hours ago.
    const items: MixItem[] = [
      ...[0, 1, 2, 3].map((i) => ({ key: `ann${i}`, source: 0, rank: i, ts: NOW - i * 60_000, author: 'ann' })),
      { key: 'ben', source: 0, rank: 4, ts: NOW - 2 * H, author: 'ben' },
    ];
    const o = orderMix(items, 'spread', [1], [false], NOW);
    expect(o.keys.slice(0, 2)).toEqual(['ann0', 'ben']);
    expect(o.keys).toEqual(['ann0', 'ben', 'ann1', 'ann2', 'ann3']);
    expect(SPREAD_MS).toBeGreaterThan(2 * H);
  });
  test('no author: just newest first', () => {
    const items = line(0, 3, 0, () => undefined as unknown as string).map(({ author: _, ...i }) => i);
    expect(orderMix(items, 'spread', [1], [false], NOW).keys).toEqual(['0:0', '0:1', '0:2']);
  });
});
