/** src/prefetch.ts: what is fetched ahead, how often, on which connections, and which pictures. The page itself: verify-perf's ahead pass. */
import { expect, test } from 'bun:test';
import { AHEAD, Budget, linkAllows, PICTURES, picturesOf, wanted } from '../src/prefetch.ts';

const msg = (id: string, ts: number, extra: Record<string, unknown> = {}): any => ({ id, conversationId: 'c', ts, authorId: `idn_${id}`, body: 'x', replyToId: null, reactions: [], attachments: [], embeds: [], ...extra });

test('the first rows of the inbox, in its order, less what is held', () => {
  const keys = Array.from({ length: 30 }, (_, i) => `c:${i}`);
  expect(wanted(keys, () => false)).toEqual(keys.slice(0, AHEAD));
  expect(wanted(keys, (k) => k === 'c:0' || k === 'c:3', 5)).toEqual(['c:1', 'c:2', 'c:4']);
  expect(wanted([], () => false)).toEqual([]);
});

test('at most so many in any window, counted from each one', () => {
  const b = new Budget(3, 1000);
  expect([b.take(0), b.take(10), b.take(20), b.take(30)]).toEqual([true, true, true, false]);
  expect(b.nextAt(30)).toBe(1000);
  expect(b.take(999)).toBe(false);
  expect(b.take(1000)).toBe(true);
  expect(b.take(1005)).toBe(false);
  expect(b.take(1010)).toBe(true);
});

test('never where data is dear: Save-Data, a cellular network, 2G; anything else, or a browser that does not say, yes', () => {
  expect(linkAllows(undefined)).toBe(true);
  expect(linkAllows({ type: 'wifi', effectiveType: '4g' })).toBe(true);
  expect(linkAllows({ effectiveType: '3g' })).toBe(true);
  expect(linkAllows({ saveData: true, type: 'wifi' })).toBe(false);
  expect(linkAllows({ type: 'cellular', effectiveType: '4g' })).toBe(false);
  expect(linkAllows({ effectiveType: '2g' })).toBe(false);
  expect(linkAllows({ effectiveType: 'slow-2g' })).toBe(false);
});

test("a page's pictures: its newest authors' avatars, then small images, only the hub's own, at most a few", () => {
  const avatars: Record<string, string | null> = { 'idn_a': '/media/s/av-a', 'idn_b': 'data:image/svg+xml,x', 'idn_c': '/media/s/av-c', 'idn_d': null };
  const ms = [
    msg('a', 1, { attachments: [{ kind: 'image', url: '/media/s/small', size: 20_000 }] }),
    msg('b', 2, { attachments: [{ kind: 'image', url: '/media/s/big', size: 2_000_000 }, { kind: 'video', url: '/media/s/vid', size: 10 }] }),
    msg('c', 3, { attachments: [{ kind: 'file', url: '/media/s/pic-as-file', size: 5_000, info: { kind: 'image' } }, { kind: 'image', url: 'https://elsewhere.example/x.png', size: 1 }] }),
    msg('d', 4),
  ];
  expect(picturesOf(ms, (id) => avatars[id])).toEqual(['/media/s/av-c', '/media/s/av-a', '/media/s/pic-as-file', '/media/s/small']);
  const many = Array.from({ length: 40 }, (_, i) => msg(`m${i}`, i, { attachments: [{ kind: 'image', url: `/media/s/${i}`, size: 1 }] }));
  expect(picturesOf(many, () => null)).toHaveLength(PICTURES);
});
