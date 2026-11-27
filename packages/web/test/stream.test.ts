/**
 * src/stream.ts: which channels have a stream and what they open on, where a thread header goes, and which thread the
 * stream's box sends to when you have not said (docs/threads.md "The channel stream").
 */
import { expect, mock, test } from 'bun:test';
import { signal, type Signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { db, stateMock } from './fixtures/state.ts';

// The page's address, as a signal: a view shown for one visit ends when it moves away. One for the whole process: a
// rerun of this file keeps the stream.ts it loaded first, which watches the first run's.
const g = globalThis as { streamTestRoute?: Signal<{ view: string; conv?: string }> };
const route = (g.streamTestRoute ??= signal({ view: 'inbox' }));
mock.module('../src/state.ts', () => ({ ...stateMock(), route }));
const { channelView, channelViews, chipDefault, headBefore, setChannelView, showCardsOnce, streamConvIds, viewLabel } = await import('../src/stream.ts');

const conv = (id: string, extra: Partial<P.ConversationView>): P.ConversationView => ({ id, network: 'discord', shape: 'channel', variant: 'text', parentId: null, name: id, lastMessageAt: 0, ...extra }) as unknown as P.ConversationView;
const msg = (conversationId: string) => ({ conversationId }) as P.MessageView;

const zulip = conv('z', { network: 'zulip', variant: 'forum' });
const room = conv('r', { network: 'matrix' });
const quietRoom = conv('q', { network: 'matrix' });
const forum = conv('f', { variant: 'forum' });
const text = conv('t', {});
const voice = conv('v', { variant: 'voice' });
for (const [c, threads] of [[room, ['r1']], [forum, ['f1']], [text, ['t1']], [voice, ['v1']]] as const) db.threads.set(c.id, [...threads]);

test('a Zulip channel and a Matrix room with threads open on the stream; Discord keeps its cards and its own messages', () => {
  expect(channelViews(zulip)).toEqual(['stream', 'cards']);
  expect(channelViews(room)).toEqual(['stream', 'cards']);
  expect(channelViews(forum)).toEqual(['cards', 'stream']);
  expect(channelViews(text)).toEqual(['own', 'stream']);
  // Nothing to switch between: a room with no threads, a voice channel, a thread itself.
  expect(channelViews(quietRoom)).toBeNull();
  expect(channelViews(voice)).toBeNull();
  expect(channelViews(conv('r1', { network: 'matrix', shape: 'thread', parentId: 'r' }))).toBeNull();
  expect([zulip, room, forum, text, quietRoom].map(channelView)).toEqual(['stream', 'stream', 'cards', 'own', 'own']);
});

test('the switch picks the view on this device, and one the channel does not offer falls back to its first', () => {
  setChannelView('z', 'cards');
  setChannelView('t', 'stream');
  setChannelView('f', 'own');
  expect([channelView(zulip), channelView(text), channelView(forum)]).toEqual(['cards', 'stream', 'cards']);
  setChannelView('z', 'stream');
  expect(channelView(zulip)).toBe('stream');
  // Back as each opens first, for the next run of these tests in this process.
  setChannelView('t', 'own');
  setChannelView('f', 'cards');
});

test("the switch's words, and what a stream holds", () => {
  expect(viewLabel(zulip, 'cards', 'topics')).toBe('Topics');
  expect(viewLabel(zulip, 'stream', 'topics')).toBe('All messages');
  expect(viewLabel(text, 'stream', 'threads')).toBe('With threads');
  expect(viewLabel(room, 'own', 'threads')).toBe('Room');
  // A Zulip channel takes no messages of its own; a room does.
  db.threads.set('z', ['z1', 'z2']);
  expect(streamConvIds(zulip)).toEqual(['z1', 'z2']);
  expect(streamConvIds(room)).toEqual(['r', 'r1']);
});

test('a header goes first, where the thread changes, and after a new day; not between two of one thread', () => {
  expect(headBefore(null, msg('a'), true)).toBe(true);
  expect(headBefore(msg('a'), msg('a'), false)).toBe(false);
  expect(headBefore(msg('a'), msg('b'), false)).toBe(true);
  expect(headBefore(msg('a'), msg('a'), true)).toBe(true);
});

test("the box's thread: the one picked, else the newest message's, else the latest thread, else the room", () => {
  const threads = [{ id: 'z1', lastMessageAt: 10 }, { id: 'z2', lastMessageAt: 20 }];
  // Picked (a click, a reply), while the stream still has it.
  expect(chipDefault({ channel: 'z', own: false, picked: 'z1', messages: [msg('z2')], threads })).toBe('z1');
  expect(chipDefault({ channel: 'z', own: false, picked: 'gone', messages: [msg('z1'), msg('z2'), msg('z1')], threads })).toBe('z1');
  // Nothing held: the thread with the latest activity.
  expect(chipDefault({ channel: 'z', own: false, messages: [], threads })).toBe('z2');
  // A Zulip channel is never sent to itself; a room is ("no thread").
  expect(chipDefault({ channel: 'z', own: false, messages: [msg('z')], threads: [] })).toBeNull();
  expect(chipDefault({ channel: 'r', own: true, messages: [msg('r1'), msg('r')], threads: [{ id: 'r1', lastMessageAt: 5 }] })).toBe('r');
  expect(chipDefault({ channel: 'r', own: true, picked: 'r', messages: [msg('r1')], threads: [{ id: 'r1', lastMessageAt: 5 }] })).toBe('r');
  expect(chipDefault({ channel: 'r', own: true, messages: [], threads: [] })).toBe('r');
});

test('"N more topics" shows the cards for this visit only: back from a topic keeps them, leaving or the switch ends them', () => {
  const z2 = conv('z2', { network: 'zulip', variant: 'forum' });
  const topic = conv('z2t', { network: 'zulip', shape: 'thread', parentId: 'z2' });
  db.conversations.set(topic.id, topic);
  try {
    route.value = { view: 'conv', conv: 'z2' };
    expect(channelView(z2)).toBe('stream');
    expect(showCardsOnce(z2)).toBe(true);
    expect(channelView(z2)).toBe('cards');
    // A topic opened from the cards, and back.
    route.value = { view: 'conv', conv: 'z2t' };
    route.value = { view: 'conv', conv: 'z2' };
    expect(channelView(z2)).toBe('cards');
    // Somewhere else, then the channel again: its stream, and nothing was kept.
    route.value = { view: 'inbox' };
    route.value = { view: 'conv', conv: 'z2' };
    expect(channelView(z2)).toBe('stream');
    expect(showCardsOnce(z2)).toBe(true);
    setChannelView('z2', 'stream');
    expect(channelView(z2)).toBe('stream');
    // A Discord text channel has no cards: the sidebar opens its thread browser instead.
    expect(showCardsOnce(text)).toBe(false);
    expect(channelView(text)).not.toBe('cards');
  } finally {
    db.conversations.delete(topic.id);
    route.value = { view: 'inbox' };
  }
});
