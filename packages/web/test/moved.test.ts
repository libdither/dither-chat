/** src/syncmodel.ts leaveOtherTimelines: a message that moved to another conversation (a Zulip topic renamed, or messages moved to another topic) goes from the timeline that held it before. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { leaveOtherTimelines, upsertInto } from '../src/syncmodel.ts';

const msg = (id: string, conversationId: string, ts: number) => ({ id, conversationId, ts }) as unknown as P.MessageView;

test('a moved message leaves the old topic, stays in a person timeline, and is left alone where it now is', () => {
  const plans = { key: 'c:plans', messages: [msg('m1', 'plans', 1), msg('m2', 'plans', 2), msg('m3', 'plans', 3)] };
  const later = { key: 'c:later', messages: [msg('m0', 'later', 0)] };
  const person = { key: 'p:ann', messages: [msg('m2', 'plans', 2)] };
  const all = [plans, later, person];
  const moved = msg('m2', 'later', 2);
  expect(leaveOtherTimelines(all, moved)).toEqual(['c:plans']);
  upsertInto(later.messages, moved);
  expect(plans.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
  expect(later.messages.map((m) => m.id)).toEqual(['m0', 'm2']);
  expect(person.messages.map((m) => m.id)).toEqual(['m2']);
  // Said again (an edit there, or the same move twice): nothing else changes.
  expect(leaveOtherTimelines(all, moved)).toEqual([]);
  // A new message held nowhere: nothing to leave.
  expect(leaveOtherTimelines(all, msg('m9', 'later', 9))).toEqual([]);
});

test("a channel's stream keeps a message moved to another of its topics, and lets one moved to another channel go", () => {
  const stream = { key: 'k:general', messages: [msg('m1', 'plans', 1), msg('m2', 'plans', 2)] };
  const plans = { key: 'c:plans', messages: [msg('m1', 'plans', 1), msg('m2', 'plans', 2)] };
  const all = [stream, plans];
  // Within the channel: the topic's page lets it go, the stream keeps it (the event puts the new copy in).
  expect(leaveOtherTimelines(all, msg('m1', 'later', 1), 'general')).toEqual(['c:plans']);
  expect(stream.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  // To another channel's topic: the stream lets it go too.
  expect(leaveOtherTimelines(all, msg('m2', 'elsewhere', 2), 'random')).toEqual(['k:general', 'c:plans']);
  expect(stream.messages.map((m) => m.id)).toEqual(['m1']);
  // Where the conversation it is in now is not known, a stream keeps what it holds.
  expect(leaveOtherTimelines([{ key: 'k:general', messages: [msg('m3', 'plans', 3)] }], msg('m3', 'nowhere', 3))).toEqual([]);
});
