/** Same person? in the page: picture hashes from drawn cells, and ticked pairs grouped into merges. */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { hashOf } from '../src/same/hash.ts';
import { components } from '../src/same/merge.ts';

/** A 9×8 RGBA image from a brightness per cell. */
const img = (f: (x: number, y: number) => number) => {
  const d: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) d.push(f(x, y), f(x, y), f(x, y), 255);
  return d;
};

describe('picture hashes', () => {
  test('a cell brighter than the next sets its bit; scaling brightness changes nothing', () => {
    expect(hashOf(img((x) => 255 - x * 20))).toBe('ffffffffffffffff');
    expect(hashOf(img((x) => x * 20))).toBe('0000000000000000');
    const a = hashOf(img((x, y) => ((x * 7 + y * 13) % 17) * 10));
    const b = hashOf(img((x, y) => ((x * 7 + y * 13) % 17) * 12 + 3));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('merging several pairs', () => {
  const side = (id: string): P.MatchSide => ({ id, name: id, identities: [] });
  const pair = (a: string, b: string): P.MatchSuggestion => ({ key: `${a}+${b}`, a: side(a), b: side(b), p: 0.95, evidence: [] });
  test('pairs that share someone become one merge; others stay apart', () => {
    const c = components([pair('per_a', 'idn_b'), pair('idn_b', 'idn_c'), pair('per_d', 'idn_e')]);
    expect(c.map((x) => x.sides.sort())).toEqual([['idn_b', 'idn_c', 'per_a'], ['idn_e', 'per_d']]);
    expect(c[0].keys).toHaveLength(2);
  });
});
