/**
 * src/model.ts: what depends only on names, settings and what is where is worked out again when those change
 * (`changed('meta')`), not for a message or a read (`changed('list')`); what changes with those is up to date either way.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { changed } from '../src/versions.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { activityOfSpace, allCommunities, convsUnder, effectiveLevel, railEntries, spaceUnread } = await import('../src/model.ts');

const acc = { id: 'acc', network: 'discord', label: 'me' } as unknown as P.AccountView;
const space = (id: string, name: string): P.SpaceView => ({ id, network: 'discord', nativeId: id, kind: 'community', name, topic: null, icon: null, accountIds: ['acc'], nativeMute: null });
const conv = (id: string, at: number, unread = 0, extra: Partial<P.ConversationView> = {}): P.ConversationView =>
  ({ id, network: 'discord', shape: 'channel', spaceIds: [], parentId: null, name: id, lastMessageAt: at, lastMessage: null, nativeMute: null, vantages: [{ accountId: 'acc', unread, mentions: unread, lastReadTs: null }], ...extra }) as unknown as P.ConversationView;
const edge = (parentId: string, childId: string, childKind: 'space' | 'conversation' = 'conversation'): P.SpaceEdgeView => ({ parentId, childId, childKind, position: null });
function link(e: P.SpaceEdgeView) {
  db.children.set(e.parentId, [...(db.children.get(e.parentId) ?? []), e]);
  db.parents.set(e.childId, [...(db.parents.get(e.childId) ?? []), e]);
}

db.accounts.set('acc', acc);
db.spaces.set('s1', space('s1', 'One'));
db.spaces.set('s2', space('s2', 'Two'));
for (const [id, sid, at] of [['a', 's1', 100], ['b', 's1', 200], ['c', 's2', 300]] as const) {
  db.conversations.set(id, conv(id, at, 0, { spaceIds: [sid] }));
  link(edge(sid, id));
}
changed('meta');

test('a message or a read changes counts and order at once, with the same walk', () => {
  expect(convsUnder('s1').map((c) => c.id).sort()).toEqual(['a', 'b']);
  expect(allCommunities().map((s) => s.id)).toEqual(['s2', 's1']);
  expect(spaceUnread('s1').unread).toBe(0);
  // A message in a: newer than anything in s2, and unread. Only the counts and the last message: changed('list').
  const before = convsUnder('s1');
  db.conversations.set('a', conv('a', 400, 3, { spaceIds: ['s1'] }));
  changed('list');
  const after = convsUnder('s1');
  expect(after).not.toBe(before);
  expect(after.find((c) => c.id === 'a')!.lastMessageAt).toBe(400);
  expect(spaceUnread('s1').unread).toBe(3);
  expect(activityOfSpace('s1')).toBe(400);
  expect(allCommunities().map((s) => s.id)).toEqual(['s1', 's2']);
  expect(railEntries().map((e) => e.key)).toEqual(['space:s1', 'space:s2']);
});

test('what is where is walked again only when it may have changed', () => {
  // A conversation joins s2 without a meta change: not seen, as no real change does that.
  db.conversations.set('d', conv('d', 500, 0, { spaceIds: ['s2'] }));
  link(edge('s2', 'd'));
  changed('list');
  expect(convsUnder('s2').map((c) => c.id)).toEqual(['c']);
  // The hub's event for it is a meta change (state.ts applyEvents): now it is.
  changed('meta');
  expect(convsUnder('s2').map((c) => c.id).sort()).toEqual(['c', 'd']);
  expect(activityOfSpace('s2')).toBe(500);
  // And a thread under one of them counts too.
  db.conversations.set('t', conv('t', 600, 2, { shape: 'thread', parentId: 'c', spaceIds: [] } as Partial<P.ConversationView>));
  db.threads.set('c', ['t']);
  changed('meta');
  expect(convsUnder('s2').map((c) => c.id).sort()).toEqual(['c', 'd', 't']);
  expect(spaceUnread('s2').unread).toBe(2);
});

test('a notification level holds until a rule or a place changes, or a native mute runs out', () => {
  const now = Date.now();
  db.conversations.set('m', conv('m', 1, 0, { spaceIds: ['s1'], nativeMute: { level: 'none', until: now + 60_000 } } as Partial<P.ConversationView>));
  link(edge('s1', 'm'));
  changed('meta');
  expect(effectiveLevel(db.conversations.get('m')!).level).toBe('digest');
  // A read leaves it alone.
  changed('list');
  expect(effectiveLevel(db.conversations.get('m')!).level).toBe('digest');
  // The mute runs out: worked out again on the next read of it, though nothing changed.
  db.conversations.set('m', conv('m', 1, 0, { spaceIds: ['s1'], nativeMute: { level: 'none', until: now - 1 } } as Partial<P.ConversationView>));
  const real = Date.now;
  Date.now = () => now + 61_000;
  try {
    expect(effectiveLevel(db.conversations.get('m')!).level).toBe('mentions');
  } finally {
    Date.now = real;
  }
  // A rule on the server: a meta change, and it holds at once.
  db.rules = [{ id: 'r', scope: 'space', target: 's1', level: 'all' } as P.RuleView];
  changed('meta');
  expect(effectiveLevel(db.conversations.get('m')!).level).toBe('all');
});
