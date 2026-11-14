/** The hub's restarts after a gap: one at a time per kind, kinds side by side, a pause between (src/stagger.ts). */
import { expect, test } from 'bun:test';
import { Stagger } from '../src/stagger.ts';

/** Lets every promise that can settle now settle. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A Stagger whose restarts and pauses end when the test says, with what happened in order. */
function harness() {
  const log: string[] = [];
  const restarts = new Map<string, () => void>();
  const pauses: (() => void)[] = [];
  const s = new Stagger(
    (k) => {
      log.push(`start ${k}`);
      return new Promise<void>((r) => restarts.set(k, () => (log.push(`done ${k}`), r())));
    },
    5000,
    (ms) => {
      log.push(`pause ${ms}`);
      return new Promise<void>((r) => pauses.push(r));
    },
  );
  return { s, log, end: (k: string) => restarts.get(k)!(), pause: () => pauses.shift()!() };
}

test('one at a time per kind, a pause between; kinds side by side; each account once while it waits or runs', async () => {
  const { s, log, end, pause } = harness();
  for (const [k, g] of [['a1', 'discord'], ['a2', 'discord'], ['a1', 'discord'], ['b1', 'telegram']] as const) s.add(k, g);
  await settle();
  expect(log).toEqual(['start a1', 'start b1']);
  expect(s.size).toBe(3);
  end('a1');
  await settle();
  expect(log.slice(2)).toEqual(['done a1', 'pause 5000']);
  // Queued again while it runs: not twice.
  s.add('a2', 'discord');
  pause();
  await settle();
  expect(log.at(-1)).toBe('start a2');
  end('a2');
  end('b1');
  await settle();
  expect(s.size).toBe(0);
});

test('a failed restart does not stop the rest; stop() drops what waits and takes nothing new', async () => {
  const log: string[] = [];
  const t = new Stagger(
    async (k) => {
      if (k === 'x') throw new Error('no');
      log.push(`ran ${k}`);
    },
    0,
    async () => {},
  );
  t.add('x');
  t.add('y');
  await settle();
  expect(log).toEqual(['ran y']);

  const { s, log: l2, end } = harness();
  s.add('p', 'g');
  s.add('q', 'g');
  await settle();
  s.stop();
  expect(s.size).toBe(1); // the one under way finishes
  s.add('r', 'g');
  end('p');
  await settle();
  expect(l2).toEqual(['start p', 'done p']);
  expect(s.size).toBe(0);
});

test('one loop per kind, pauses included: an account added during the pause waits its turn, and the count stays right', async () => {
  const { s, log, end, pause } = harness();
  let running = 0;
  let most = 0;
  const watch = (k: string) => {
    running++;
    most = Math.max(most, running);
    end(k);
    running--;
  };
  s.add('a', 'discord');
  s.add('b', 'discord');
  await settle();
  expect(log).toEqual(['start a']);
  watch('a');
  await settle();
  expect(log.at(-1)).toBe('pause 5000');
  // Added during the pause: no second loop, so it does not start beside b.
  s.add('c', 'discord');
  await settle();
  expect(log.filter((l) => l.startsWith('start'))).toEqual(['start a']);
  expect(s.size).toBe(2);
  pause();
  await settle();
  expect(log.at(-1)).toBe('start b');
  expect(s.size).toBe(2);
  watch('b');
  await settle();
  pause();
  await settle();
  expect(log.at(-1)).toBe('start c');
  expect(s.size).toBe(1);
  watch('c');
  await settle();
  expect(s.size).toBe(0);
  expect(log.filter((l) => l.startsWith('start'))).toEqual(['start a', 'start b', 'start c']);
  expect(most).toBe(1);
});
