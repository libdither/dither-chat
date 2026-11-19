/** A call tried again later (src/retrylater.ts), as the device hello uses it. Timers are passed in, so nothing waits. */
import { expect, test } from 'bun:test';
import { RetryLater } from '../src/retrylater.ts';

function fakeTimers() {
  const waiting = new Map<number, { f: () => void; ms: number }>();
  let next = 0;
  return {
    waiting,
    later: (f: () => void, ms: number) => {
      waiting.set(++next, { f, ms });
      return next;
    },
    cancel: (t: unknown) => void waiting.delete(t as number),
    /** Run the one waiting call and say how long it waited. */
    fire() {
      expect(waiting.size).toBe(1);
      const [id, w] = [...waiting][0]!;
      waiting.delete(id);
      w.f();
      return w.ms;
    },
  };
}

test('waits longer after each failure, up to the most, and starts over once it worked', () => {
  const t = fakeTimers();
  const r = new RetryLater(5, 30, t.later, t.cancel);
  let runs = 0;
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    r.schedule(() => runs++);
    waits.push(t.fire());
  }
  expect(waits).toEqual([5, 10, 20, 30, 30]);
  expect(runs).toBe(5);
  r.reset();
  r.schedule(() => runs++);
  expect(t.fire()).toBe(5);
});

test('scheduling again replaces the call waiting, and reset cancels it', () => {
  const t = fakeTimers();
  const r = new RetryLater(5, 30, t.later, t.cancel);
  const ran: string[] = [];
  r.schedule(() => ran.push('first'));
  r.schedule(() => ran.push('second'));
  t.fire();
  expect(ran).toEqual(['second']);
  r.schedule(() => ran.push('third'));
  r.reset();
  expect(t.waiting.size).toBe(0);
  expect(ran).toEqual(['second']);
});
