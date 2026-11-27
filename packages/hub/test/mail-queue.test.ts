/**
 * The mail queue's order (src/mail/queue.ts): work asked for sooner than it was queued. Its budgets, backoffs and
 * priorities under a whole account are in mail-sync.test.ts and mail-keep.test.ts.
 */
import { expect, test } from 'bun:test';
import { MailQueue, P0, P2 } from '../src/mail/queue.ts';
import { FakeClock } from './fixtures/clock.ts';

test('work a page asks for while it waits behind the background gate starts at once, as the one piece of work', async () => {
  const clock = new FakeClock(0);
  const q = new MailQueue(2, clock.now, clock);
  // As backfill.ts sets it after a page's call: the background (P2 and lower) starts nothing for ten seconds.
  q.gate = (p, now) => (p >= P2 ? Math.max(0, 10_000 - now) : 0);
  const ran: string[] = [];
  const ahead = q.run(P2, 'body:a', async () => void ran.push('fetched ahead'));
  expect(ran).toEqual([]);
  // The page opens that mail. The clock never moves here: only the queue starting it can let this settle.
  const asked = q.run(P0, 'body:a', async () => void ran.push('fetched again'));
  await asked;
  await ahead;
  expect(ran).toEqual(['fetched ahead']);
  expect(q.size).toBe(0);
});

test('work asked for at the priority it has, or a lower one, stays where it is', async () => {
  const clock = new FakeClock(0);
  const q = new MailQueue(2, clock.now, clock);
  q.gate = (p, now) => (p >= P2 ? Math.max(0, 10_000 - now) : 0);
  const ran: string[] = [];
  const ahead = q.run(P2, 'body:a', async () => void ran.push('a'));
  const again = q.run(P2, 'body:a', async () => void ran.push('a twice'));
  expect(again).toBe(ahead);
  await clock.settle();
  expect(ran).toEqual([]);
  // The gate's own timer starts it once its wait is over.
  await clock.advance(10_000);
  await ahead;
  expect(ran).toEqual(['a']);
});
