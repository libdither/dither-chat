/** The hub's restarts after a gap, one at a time with a pause (src/stagger.ts). */
import { expect, test } from 'bun:test';
import { Stagger } from '../src/stagger.ts';

test('gap restarts go one at a time, a pause between, each account once while it waits', async () => {
  const log: string[] = [];
  let release: () => void = () => {};
  const s = new Stagger(
    async (k) => {
      log.push(`start ${k}`);
      await new Promise<void>((r) => (release = r));
      log.push(`done ${k}`);
    },
    1000,
    async (ms) => {
      log.push(`pause ${ms}`);
    },
  );
  for (const k of ['a', 'b', 'a', 'c']) s.add(k);
  await Bun.sleep(1);
  expect(log).toEqual(['start a']);
  expect(s.waiting).toEqual(['b', 'c']);
  for (let i = 0; i < 3; i++) {
    release();
    await Bun.sleep(1);
  }
  expect(log).toEqual(['start a', 'done a', 'pause 1000', 'start b', 'done b', 'pause 1000', 'start c', 'done c']);
  // A failed restart does not stop the rest.
  const t = new Stagger(async (k) => {
    if (k === 'x') throw new Error('no');
    log.push(`ran ${k}`);
  }, 0);
  t.add('x');
  t.add('y');
  await Bun.sleep(5);
  expect(log.at(-1)).toBe('ran y');
});
