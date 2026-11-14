/** Opening a server goes back to its last channel (lastchannel.ts, docs/servers.md "Opening a server"). */
import { expect, test } from 'bun:test';
import { noteChannel, withLastChannel, type LastChannels } from '../src/lastchannel.ts';

const under: Record<string, string[]> = { srv: ['general', 'memes'], sub: ['memes'], other: ['news'] };
const serverOf = (space: string) => (space === 'sub' ? 'srv' : space);
const isUnder = (space: string, conv: string) => !!under[space]?.includes(conv);

test('a server opened with no channel gets the one last opened there', () => {
  const m = noteChannel({}, 'srv', 'memes')!;
  expect(withLastChannel({ view: 'space', space: 'srv' }, m, serverOf, isUnder)).toEqual({ view: 'space', space: 'srv', conv: 'memes' });
  // A subspace (Matrix) shares its top server's memory.
  expect(withLastChannel({ view: 'space', space: 'sub' }, m, serverOf, isUnder)).toEqual({ view: 'space', space: 'sub', conv: 'memes' });
});

test('a channel asked for, another view, a server never opened, or a channel gone: the route as it was', () => {
  const m: LastChannels = { srv: 'gone', other: 'news' };
  expect(withLastChannel({ view: 'space', space: 'other', conv: 'x' }, m, serverOf, isUnder)).toEqual({ view: 'space', space: 'other', conv: 'x' });
  expect(withLastChannel({ view: 'inbox' }, m, serverOf, isUnder)).toEqual({ view: 'inbox' });
  expect(withLastChannel({ view: 'space', space: 'new' }, m, serverOf, isUnder)).toEqual({ view: 'space', space: 'new' });
  expect(withLastChannel({ view: 'space', space: 'srv' }, m, serverOf, isUnder)).toEqual({ view: 'space', space: 'srv' });
});

test('the latest open wins; nothing to write when it is already the latest; the oldest go past 500', () => {
  let m = noteChannel({}, 'srv', 'general')!;
  m = noteChannel(m, 'other', 'news')!;
  m = noteChannel(m, 'srv', 'memes')!;
  expect(m).toEqual({ other: 'news', srv: 'memes' });
  expect(Object.keys(m)).toEqual(['other', 'srv']);
  expect(noteChannel(m, 'srv', 'memes')).toBeNull();
  let big: LastChannels = {};
  for (let i = 0; i < 520; i++) big = noteChannel(big, `s${i}`, 'c')!;
  expect(Object.keys(big).length).toBe(500);
  expect(big.s0).toBeUndefined();
  expect(big.s519).toBe('c');
});
