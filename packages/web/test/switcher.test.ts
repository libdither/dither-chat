import { expect, test } from 'bun:test';
import { fuzzyScore } from '../src/palette.ts';

// The palette's name match (palette.ts), which the root, New and the group list rank by.
test('prefix beats word start beats middle beats scattered', () => {
  const name = 'rust help';
  expect(fuzzyScore(name, 'ru')!).toBeGreaterThan(fuzzyScore(name, 'he')!);
  expect(fuzzyScore(name, 'he')!).toBeGreaterThan(fuzzyScore(name, 'us')!);
  expect(fuzzyScore(name, 'us')!).toBeGreaterThan(fuzzyScore(name, 'rhp')!);
});
test('letters out of order do not match', () => expect(fuzzyScore('rust', 'tr')).toBeNull());
