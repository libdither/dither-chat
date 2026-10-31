import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Switcher.tsx needs a browser; the ranking is small enough to read from source and test alone.
const src = await Bun.file(resolve(import.meta.dir, '../src/ui/Switcher.tsx')).text();
const body = src.slice(src.indexOf('export function fuzzyScore'), src.indexOf('interface Item')).replace('export function', 'function').replace(/: string|: number \| null/g, '');
const fuzzyScore = new Function(`${body}; return fuzzyScore;`)();

test('prefix beats word start beats middle beats scattered', () => {
  const name = 'rust help';
  expect(fuzzyScore(name, 'ru')).toBeGreaterThan(fuzzyScore(name, 'he'));
  expect(fuzzyScore(name, 'he')).toBeGreaterThan(fuzzyScore(name, 'us'));
  expect(fuzzyScore(name, 'us')).toBeGreaterThan(fuzzyScore(name, 'rhp'));
});
test('letters out of order do not match', () => expect(fuzzyScore('rust', 'tr')).toBeNull());
