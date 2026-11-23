/**
 * One inbox row per channel for its threads (docs/inbox.md "One row per channel"): the fold in channelrows.ts, and
 * model.ts making the inbox's rows of it, with the keys the ranking, the snapshot and the hold on the open row use.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { channelKey, groupChannels, mergeChannel, subThreads, type ChannelPart } from '../src/channelrows.ts';
import { inboxSnapshot, inboxView, rank, type Ranked } from '../src/ordering.ts';
import { changed } from '../src/versions.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { inboxKeyOf, inboxRows, rowConvs, rowLast, rowMuted, unreadThreadsOf } = await import('../src/model.ts');

const NOW = 1_800_000_000_000;
const part = (key: string, o: Partial<ChannelPart> = {}): ChannelPart => ({ key, score: 10, needs: false, reasons: [`${key} reason`], owedSince: null, last: NOW, unread: 0, badge: 0, muted: false, ...o });

// ------------------------------------------------------------------ the fold

test("a channel's row: the highest score, needs you if any part does, unread and mentions summed, muted only if all are", () => {
  const m = mergeChannel([part('t1', { score: 20, unread: 3, last: NOW - 5000 }), part('t2', { score: 55, needs: true, owedSince: NOW - 3000, unread: 2, badge: 1, last: NOW - 1000 }), part('t3', { score: 30, unread: 4, last: NOW })]);
  expect(m).toMatchObject({ score: 55, needs: true, owedSince: NOW - 3000, unread: 9, badge: 1, muted: false, reasons: ['t2 reason'], last: NOW });
  expect(m.top.key).toBe('t2');
  expect(m.latest.key).toBe('t3');
  expect(mergeChannel([part('a', { muted: true }), part('b', { muted: true })]).muted).toBe(true);
});

test('a muted thread does not lift the row: not its score, its ↩, its time or its unread, only its mentions', () => {
  const m = mergeChannel([
    part('quiet', { score: 90, needs: true, owedSince: NOW - 9000, unread: 40, last: NOW, muted: true }),
    part('loud', { score: 12, unread: 1, last: NOW - 60_000 }),
    part('pinged', { score: 80, unread: 2, badge: 1, last: NOW - 1000, muted: true }),
  ]);
  expect(m).toMatchObject({ score: 12, needs: false, owedSince: null, last: NOW - 60_000, muted: false });
  expect(m.latest.key).toBe('loud');
  // The muted topic's 40 are left out; the muted one that mentions you counts, as a place's sum does (sumUnread).
  expect(m.unread).toBe(3);
  expect(m.badge).toBe(1);
  // Every part muted: the row is muted, and ranks by them all.
  const all = mergeChannel([part('a', { score: 5, muted: true }), part('b', { score: 7, muted: true, last: NOW + 1 })]);
  expect(all).toMatchObject({ score: 7, muted: true, last: NOW + 1 });
});

test('threads fold under channel:<parent>, with the channel’s own row where it has one; the rest stay as they are', () => {
  const parents: Record<string, string> = { zt1: 'zc', zt2: 'zc', mt1: 'room', dt1: 'gone' };
  const rows = [part('zt1', { score: 40, last: NOW - 100 }), part('dm', { score: 50 }), part('zt2', { score: 20, last: NOW }), part('room', { score: 60, last: NOW - 50 }), part('mt1', { score: 10, last: NOW - 10 }), part('chan', { score: 5 })];
  const g = groupChannels(rows, (r) => (parents[r.key] && parents[r.key] !== 'gone' ? parents[r.key] : null), (r) => r.key);
  expect(g.rows.map((r) => r.key)).toEqual(['dm', 'chan']);
  expect(g.channels.map((c) => c.key)).toEqual(['channel:zc', 'channel:room']);
  expect(channelKey('zc')).toBe('channel:zc');
  const zc = g.channels[0];
  expect(zc.parts.map((p) => p.key)).toEqual(['zt2', 'zt1']);
  expect(zc.score).toBe(40);
  // The Matrix room listed on its own and its thread are one row, scored by the room.
  const room = g.channels[1];
  expect(room.parts.map((p) => p.key)).toEqual(['mt1', 'room']);
  expect(room.score).toBe(60);
  // Ranked as one, by its key.
  const ranked: Ranked[] = [...g.rows, ...g.channels].map((r) => ({ key: r.key, score: r.score, last: r.last, muted: r.muted }));
  expect(rank(ranked)).toEqual(['channel:room', 'dm', 'channel:zc', 'chan']);
  // The open channel row keeps its place by its one key, whichever thread of it is open.
  const snap = inboxSnapshot(ranked, undefined);
  const later = ranked.map((x) => (x.key === 'channel:zc' ? { ...x, score: 1 } : x));
  const held = inboxSnapshot(later, { key: 'channel:zc', prev: snap });
  expect(inboxView(held, later, () => true).indexOf('channel:zc')).toBe(2);
});

test('an open channel row lists its unread threads, those that mention you first, then the latest; a muted one only for a mention', () => {
  const t = (id: string, o: Partial<{ unread: number; badge: number; muted: boolean; last: number }>) => ({ id, unread: 0, badge: 0, muted: false, last: NOW, ...o });
  const shown = subThreads([t('read', { last: NOW + 9 }), t('new', { unread: 2, last: NOW + 5 }), t('older', { unread: 1, last: NOW + 1 }), t('ping', { unread: 1, badge: 1, last: NOW }), t('muted', { unread: 7, muted: true, last: NOW + 8 }), t('muted-ping', { unread: 1, badge: 1, muted: true, last: NOW + 2 })]);
  expect(shown.map((x) => x.id)).toEqual(['muted-ping', 'ping', 'new', 'older']);
});

// ------------------------------------------------------------------ the inbox's rows

const acc = { id: 'accz', network: 'zulip', label: 'me' } as unknown as P.AccountView;
const conv = (id: string, o: Partial<P.ConversationView> & { unread?: number; mentions?: number } = {}): P.ConversationView => {
  const { unread = 0, mentions = 0, ...rest } = o;
  return { id, network: 'zulip', shape: 'thread', variant: 'text', spaceIds: [], parentId: null, name: id, lastMessageAt: NOW, lastMessage: null, nativeMute: null, vantages: [{ accountId: 'accz', unread, mentions, lastReadTs: null }], ...rest } as unknown as P.ConversationView;
};
const score = (id: string, s: number): P.AttentionView => ({ id, score: s, needs: false, reasons: [`${s} points`], owedSince: null, at: NOW });

function world() {
  db.accounts.set('accz', acc);
  db.spaces.set('org', { id: 'org', network: 'zulip', nativeId: 'org', kind: 'community', name: 'Org', topic: null, icon: null, accountIds: ['accz'], nativeMute: null } as P.SpaceView);
  db.conversations.set('zc', conv('zc', { shape: 'channel', variant: 'forum', spaceIds: ['org'], lastMessageAt: null }));
  db.conversations.set('zt1', conv('zt1', { parentId: 'zc', unread: 3, lastMessageAt: NOW - 1000 }));
  db.conversations.set('zt2', conv('zt2', { parentId: 'zc', unread: 1, mentions: 1, lastMessageAt: NOW - 5000 }));
  db.conversations.set('zt3', conv('zt3', { parentId: 'zc', lastMessageAt: NOW - 100 }));
  db.threads.set('zc', ['zt1', 'zt2', 'zt3']);
  db.conversations.set('room', conv('room', { network: 'matrix', shape: 'group', unread: 1, lastMessageAt: NOW - 300 }));
  db.conversations.set('mt', conv('mt', { network: 'matrix', parentId: 'room', unread: 2, lastMessageAt: NOW - 200 }));
  db.conversations.set('lone', conv('lone', { network: 'matrix', shape: 'group', lastMessageAt: NOW - 50 }));
  // A room listed on its own whose one thread is unread but not listed: a channel's row too, to open on that thread.
  db.conversations.set('room2', conv('room2', { network: 'matrix', shape: 'group', lastMessageAt: NOW - 70 }));
  db.conversations.set('mt2', conv('mt2', { network: 'matrix', parentId: 'room2', unread: 4, lastMessageAt: NOW - 60 }));
  db.threads.set('room2', ['mt2']);
  // zt3 is not listed: the hub scores only zt1 and zt2 of the channel.
  for (const a of [score('zt1', 40), score('zt2', 30), score('room', 20), score('mt', 50), score('lone', 10), score('room2', 15)]) db.attention.set(a.id, a);
  changed('meta');
}
/** The one db is every test file's (fixtures/state.ts): this world goes when each test is done. */
const MINE = ['zc', 'zt1', 'zt2', 'zt3', 'room', 'mt', 'lone', 'room2', 'mt2'];
afterEach(() => {
  for (const id of MINE) {
    db.conversations.delete(id);
    db.attention.delete(id);
  }
  db.threads.delete('zc');
  db.threads.delete('room2');
  db.spaces.delete('org');
  db.accounts.delete('accz');
  changed('meta');
});
/** The rows of this world, whatever other tests left in the db. */
const mine = () => inboxRows().filter((r) => r.kind === 'conv' && rowConvs(r).every((c) => MINE.includes(c.id)));

test('the inbox holds one row per channel: summed, keyed channel:<id>, opening the channel, and every part maps to it', () => {
  world();
  const rows = mine();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  expect([...byKey.keys()].sort()).toEqual(['channel:room', 'channel:room2', 'channel:zc', 'lone']);
  const zc = byKey.get('channel:zc')!;
  if (zc.kind !== 'conv' || !zc.channel) throw new Error('not a channel row');
  // The click opens the channel; the preview is the latest listed thread; the score is the best thread's.
  expect(zc.conv.id).toBe('zc');
  expect(zc.score).toBe(40);
  expect(zc.channel.latest.id).toBe('zt1');
  expect(zc.channel.threads.map((t) => t.id)).toEqual(['zt1', 'zt2']);
  expect(rowConvs(zc).map((c) => c.id)).toEqual(['zt1', 'zt2']);
  expect(rowLast(zc)).toBe(NOW - 1000);
  expect(rowMuted(zc)).toBe(false);
  // The Matrix room listed on its own and its thread are one row.
  const room = byKey.get('channel:room')!;
  if (room.kind !== 'conv' || !room.channel) throw new Error('not a channel row');
  expect(room.channel.parts.map((c) => c.id)).toEqual(['mt', 'room']);
  expect(room.channel.threads.map((c) => c.id)).toEqual(['mt']);
  expect(room.score).toBe(50);
  // The hold on the open row and the active row: a thread, listed or not, and the channel map to the row's key.
  expect(inboxKeyOf('zt2')).toBe('channel:zc');
  expect(inboxKeyOf('zt3')).toBe('channel:zc');
  expect(inboxKeyOf('room')).toBe('channel:room');
  expect(inboxKeyOf('lone')).toBe('lone');
  const room2 = byKey.get('channel:room2')!;
  if (room2.kind !== 'conv' || !room2.channel) throw new Error('not a channel row');
  expect(room2.channel.parts.map((c) => c.id)).toEqual(['room2']);
  expect(room2.score).toBe(15);
  expect(inboxKeyOf('room2')).toBe('channel:room2');
  expect(inboxKeyOf('mt2')).toBe('channel:room2');
  // What the row counts and opens on: every thread of the channel with something unread, listed or not.
  expect(unreadThreadsOf('zc').map((t) => t.id).sort()).toEqual(['zt1', 'zt2']);
  expect(unreadThreadsOf('room2').map((t) => t.id)).toEqual(['mt2']);
});

test('a channel row is muted only when every thread in it is', () => {
  world();
  db.conversations.set('zt1', conv('zt1', { parentId: 'zc', unread: 3, nativeMute: { muted: true } } as Partial<P.ConversationView>));
  changed('meta');
  const zc = () => mine().find((r) => r.key === 'channel:zc')!;
  expect(rowMuted(zc())).toBe(false);
  db.conversations.set('zt2', conv('zt2', { parentId: 'zc', unread: 1, nativeMute: { muted: true } } as Partial<P.ConversationView>));
  changed('meta');
  expect(rowMuted(zc())).toBe(true);
});
