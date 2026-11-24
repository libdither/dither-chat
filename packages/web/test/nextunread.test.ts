/**
 * src/nextunread.ts: where "Next unread topic" goes (docs/threads.md "Next unread"). The same channel first (a
 * mention first, then latest activity), then the next channel in sidebar order, then the next space, round to the
 * start; a muted thread only for a mention. And src/threads.ts readScope: what a channel's Mark As Read covers.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { nextUnread, type Lane, type Slot } from '../src/nextunread.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { readScope } = await import('../src/threads.ts');

const s = (id: string, unread: number, lastAt: number, extra: Partial<Slot> = {}): Slot => ({ id, unread, mentions: 0, muted: false, lastAt, ...extra });

// Space A: #design (three topics), #general; space B: #ops, #random. Sidebar order as listed.
const lanes: Lane[] = [
  { channel: 'design', space: 'A' },
  { channel: 'general', space: 'A' },
  { channel: 'ops', space: 'B' },
  { channel: 'random', space: 'B' },
];

function world(slots: Record<string, Slot[]>) {
  const asked: string[] = [];
  return { asked, of: (ch: string) => (asked.push(ch), slots[ch] ?? []) };
}

test('the same channel first: a mention first, then latest activity, never the one you are in', () => {
  const w = world({
    design: [s('tokens', 2, 100), s('spacing', 1, 300), s('icons', 1, 50, { mentions: 1 })],
    general: [s('lunch', 1, 900)],
  });
  expect(nextUnread(lanes, { channel: 'design', thread: 'spacing' }, w.of)?.id).toBe('icons');
  // Without the mention: the latest active, skipping the open one.
  const w2 = world({ design: [s('tokens', 2, 100), s('spacing', 1, 300), s('icons', 1, 50)] });
  expect(nextUnread(lanes, { channel: 'design', thread: 'spacing' }, w2.of)?.id).toBe('tokens');
  expect(nextUnread(lanes, { channel: 'design', thread: 'tokens' }, w2.of)?.id).toBe('spacing');
});

test("a channel's own messages are one more thing to read in it, but not from the channel itself", () => {
  const w = world({ general: [s('general', 3, 500), s('lunch', 1, 100)] });
  const from = nextUnread(lanes, { channel: 'general', thread: 'lunch' }, w.of);
  expect(from).toEqual({ id: 'general', channel: 'general', space: 'A', unread: 3, mentions: 0 });
  expect(nextUnread(lanes, { channel: 'general', thread: null }, w.of)?.id).toBe('lunch');
});

test('then the next channel in sidebar order, in the same space; only as far as needed', () => {
  const w = world({ design: [s('tokens', 0, 100)], general: [s('lunch', 1, 900)], ops: [s('deploys', 4, 999)] });
  expect(nextUnread(lanes, { channel: 'design', thread: 'tokens' }, w.of)).toEqual({ id: 'lunch', channel: 'general', space: 'A', unread: 1, mentions: 0 });
  expect(w.asked).toEqual(['design', 'general']);
});

test("the rest of the space first, round to its first channels; then the next space; round to the first", () => {
  const w = world({ ops: [s('deploys', 4, 999)], design: [s('tokens', 2, 100)] });
  // From #general, the last of A: A's #design comes before B's #ops.
  expect(nextUnread(lanes, { channel: 'general', thread: 'lunch' }, w.of)?.id).toBe('tokens');
  const w2 = world({ ops: [s('deploys', 4, 999)] });
  expect(nextUnread(lanes, { channel: 'general', thread: 'lunch' }, w2.of)).toEqual({ id: 'deploys', channel: 'ops', space: 'B', unread: 4, mentions: 0 });
  // From the last channel of the last space: round to the first space.
  const w3 = world({ design: [s('tokens', 2, 100)] });
  expect(nextUnread(lanes, { channel: 'random', thread: null }, w3.of)?.id).toBe('tokens');
});

test('a muted thread is skipped unless it mentions you', () => {
  const w = world({ design: [s('nightly', 3, 999, { muted: true })], general: [s('lunch', 1, 10)] });
  expect(nextUnread(lanes, { channel: 'design', thread: 'tokens' }, w.of)?.id).toBe('lunch');
  const w2 = world({ design: [s('nightly', 3, 999, { muted: true, mentions: 1 })], general: [s('lunch', 1, 10)] });
  expect(nextUnread(lanes, { channel: 'design', thread: 'tokens' }, w2.of)?.id).toBe('nightly');
});

test('none left: null, and the open thread alone does not count', () => {
  const w = world({ design: [s('tokens', 2, 100)], ops: [s('quiet', 5, 100, { muted: true })] });
  expect(nextUnread(lanes, { channel: 'design', thread: 'tokens' }, w.of)).toBeNull();
  expect(nextUnread([], { channel: 'x', thread: null }, w.of)).toBeNull();
});

test("from a channel's stream: the next channel with anything unread, its counts summed", () => {
  const w = world({
    design: [s('tokens', 2, 100)],
    general: [s('lunch', 1, 900, { muted: true })],
    ops: [s('ops', 2, 50), s('deploys', 4, 999, { mentions: 1 }), s('noise', 7, 10, { muted: true })],
  });
  expect(nextUnread(lanes, { channel: 'design', thread: null }, w.of, 'channel')).toEqual({ id: 'ops', channel: 'ops', space: 'B', unread: 6, mentions: 1 });
});

test('a place in no space looks through its own threads, then every channel from the top', () => {
  const w = world({ room: [s('room', 0, 0), s('t1', 2, 5)], general: [s('lunch', 1, 10)] });
  expect(nextUnread(lanes, { channel: 'room', thread: null }, w.of)?.id).toBe('t1');
  expect(nextUnread(lanes, { channel: 'room', thread: 't1' }, w.of)).toEqual({ id: 'lunch', channel: 'general', space: 'A', unread: 1, mentions: 0 });
});

test('a channel listed under two spaces goes on from the one you are looking at', () => {
  const w = world({ general: [s('lunch', 1, 1)], ops: [s('deploys', 1, 1)] });
  const twice: Lane[] = [...lanes, { channel: 'design', space: 'B' }];
  // Seen under B: the rest of B (round to #ops) before A's #general.
  expect(nextUnread(twice, { channel: 'design', thread: 't', space: 'B' }, w.of)?.id).toBe('deploys');
  expect(nextUnread(twice, { channel: 'design', thread: 't', space: 'A' }, w.of)?.id).toBe('lunch');
  expect(nextUnread(twice, { channel: 'design', thread: 't', space: 'elsewhere' }, w.of)?.id).toBe('lunch');
});

test('a channel listed under two spaces is looked at once', () => {
  const w = world({ design: [s('tokens', 1, 1)] });
  const twice: Lane[] = [...lanes, { channel: 'design', space: 'B' }];
  // From #general in A, its listing under A comes first.
  expect(nextUnread(twice, { channel: 'general', thread: null }, w.of)?.space).toBe('A');
  expect(w.asked.filter((c) => c === 'design')).toHaveLength(1);
});

// ------------------------------------------------------------------ Mark As Read on a channel

const conv = (id: string, extra: Partial<P.ConversationView>): P.ConversationView =>
  ({ id, network: 'discord', nativeId: id, shape: 'channel', variant: 'text', name: id, parentId: null, spaceIds: [], participantIds: [], vantages: [{ accountId: 'a1', unread: 1, mentions: 0, lastReadTs: null }], lastMessage: null, lastMessageAt: null, nativeMute: null, ...extra }) as unknown as P.ConversationView;
const ids = (xs: P.ConversationView[]) => xs.map((x) => x.id);

// What these tests add to the shared fixture db, taken out again for the files after this one.
const added: string[] = [];
afterAll(() => {
  for (const id of added) db.conversations.delete(id), db.threads.delete(id);
});

test("a channel's Mark As Read covers the channel and every thread of it, on every network", () => {
  const add = (c: P.ConversationView) => (added.push(c.id), db.conversations.set(c.id, c));
  // A Discord text channel and its threads, an archived one too.
  add(conv('dev', {}));
  add(conv('dev-t1', { shape: 'thread', parentId: 'dev' }));
  add(conv('dev-t2', { shape: 'thread', parentId: 'dev', archived: true }));
  db.threads.set('dev', ['dev-t1', 'dev-t2']);
  expect(ids(readScope(db.conversations.get('dev')!))).toEqual(['dev', 'dev-t1', 'dev-t2']);
  // A Zulip channel (a forum of topics).
  add(conv('zc', { network: 'zulip', variant: 'forum' }));
  add(conv('zc-a', { network: 'zulip', shape: 'thread', parentId: 'zc' }));
  db.threads.set('zc', ['zc-a', 'gone']);
  expect(ids(readScope(db.conversations.get('zc')!))).toEqual(['zc', 'zc-a']);
  // A Matrix private room with a thread.
  add(conv('room', { network: 'matrix', shape: 'group' }));
  add(conv('room-t', { network: 'matrix', shape: 'thread', parentId: 'room' }));
  db.threads.set('room', ['room-t']);
  expect(ids(readScope(db.conversations.get('room')!))).toEqual(['room', 'room-t']);
  // A thread, and a channel with no threads: themselves alone.
  expect(ids(readScope(db.conversations.get('dev-t1')!))).toEqual(['dev-t1']);
  add(conv('plain', {}));
  expect(ids(readScope(db.conversations.get('plain')!))).toEqual(['plain']);
});
