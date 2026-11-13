/** src/sendtimes.ts: the reply's ping remembered per account, the times Send later and Remind Me offer, and their words. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { fromLocalInput, laterChoices, rememberReplyMentions, remindChoices, replyMentions, toLocalInput, waitingIn, whenWords } from '../src/sendtimes.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("a reply pings unless you turned it off with that account, as Discord's reply bar remembers it", () => {
  const s = memory();
  expect(replyMentions('acc_a', s)).toBe(true);
  rememberReplyMentions('acc_a', false, s);
  expect(replyMentions('acc_a', s)).toBe(false);
  expect(replyMentions('acc_b', s)).toBe(true);
  rememberReplyMentions('acc_a', true, s);
  expect(replyMentions('acc_a', s)).toBe(true);
  expect(replyMentions(undefined, s)).toBe(true);
});

test('Send later offers the next 9:00 and 13:00, and Monday 9:00, all ahead', () => {
  // Wednesday 12 Nov 2026, 10:30 local.
  const now = new Date(2026, 10, 12, 10, 30).getTime();
  const c = laterChoices(now);
  expect(c.map((x) => x.label)).toEqual(['In 1 hour', 'Tomorrow at 9:00', 'Today at 13:00', 'Monday at 9:00']);
  expect(new Date(c[1].at).getDate()).toBe(13);
  expect(new Date(c[3].at).getDay()).toBe(1);
  expect(new Date(c[3].at).getDate()).toBe(16);
  for (const x of c) expect(x.at).toBeGreaterThan(now);
  // Early in the morning, 9:00 is still today; on a Monday, Monday is next week's.
  const early = new Date(2026, 10, 16, 7, 0).getTime();
  expect(laterChoices(early)[1].label).toBe('Today at 9:00');
  expect(new Date(laterChoices(early)[3].at).getDate()).toBe(23);
});

test('Remind Me: half an hour to next week, all ahead', () => {
  const now = new Date(2026, 10, 12, 22, 0).getTime();
  const c = remindChoices(now);
  expect(c.map((x) => x.label)).toEqual(['In 30 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow', 'Next week']);
  for (const x of c) expect(x.at).toBeGreaterThan(now);
});

test('when, in words, and the time input both ways', () => {
  const now = new Date(2026, 10, 12, 10, 30).getTime();
  expect(whenWords(new Date(2026, 10, 12, 14, 5).getTime(), now)).toBe('today at 14:05');
  expect(whenWords(new Date(2026, 10, 13, 9, 0).getTime(), now)).toBe('tomorrow at 9:00');
  expect(whenWords(new Date(2026, 10, 11, 9, 0).getTime(), now)).toBe('yesterday at 9:00');
  const t = new Date(2026, 10, 20, 8, 7).getTime();
  expect(toLocalInput(t)).toBe('2026-11-20T08:07');
  expect(fromLocalInput('2026-11-20T08:07')).toBe(t);
  expect(fromLocalInput('nonsense')).toBeNull();
});

test('what waits here: this conversation, not yet sent', () => {
  const v = (id: string, conversationId: string, state: P.ScheduledState) => ({ id, conversationId, state }) as P.ScheduledSendView;
  expect(waitingIn([v('a', 'c1', 'waiting'), v('b', 'c1', 'sent'), v('c', 'c2', 'held'), v('d', 'c1', 'failed')], 'c1').map((x) => x.id)).toEqual(['a', 'd']);
  expect(waitingIn(null, 'c1')).toEqual([]);
});
