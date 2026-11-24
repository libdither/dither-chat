/**
 * src/model.ts: what depends only on names, settings and what is where is worked out again when those change
 * (`changed('meta')`), not for a message or a read (`changed('list')`); what changes with those is up to date either way.
 * The places, their counts and order are not worked out again for identities, the inbox or the devices list.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { changed } from '../src/versions.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { activityOfSpace, allCommunities, channelsUnder, convsUnder, effectiveLevel, firstChannel, railEntries, spaceUnread, totalUnread } = await import('../src/model.ts');

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

test("identities arriving, the inbox and the hub's devices leave the places, their counts and order as they were", () => {
  const under = convsUnder('s1');
  const rail = railEntries();
  const total = totalUnread();
  for (const kind of ['identity', 'inbox', 'devices'] as const) {
    changed(kind);
    expect(convsUnder('s1')).toBe(under);
    expect(railEntries()).toBe(rail);
    expect(totalUnread()).toBe(total);
  }
  // A message or a read: worked out again.
  changed('list');
  expect(convsUnder('s1')).not.toBe(under);
  expect(railEntries()).not.toBe(rail);
  expect(totalUnread()).not.toBe(total);
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

test('a Zulip mute (muted: true, no level) on a channel or a topic keeps it to the list, as a Discord mute does', () => {
  const zconv = (id: string, extra: Partial<P.ConversationView>) => conv(id, 1, 0, { network: 'zulip', spaceIds: ['zs'], ...extra } as Partial<P.ConversationView>);
  db.spaces.set('zs', { ...space('zs', 'Org'), network: 'zulip' });
  db.conversations.set('zc1', zconv('zc1', { variant: 'forum', nativeMute: { muted: true } } as Partial<P.ConversationView>));
  db.conversations.set('zt1', zconv('zt1', { shape: 'thread', parentId: 'zc1' } as Partial<P.ConversationView>));
  db.conversations.set('zc2', zconv('zc2', { variant: 'forum' } as Partial<P.ConversationView>));
  db.conversations.set('zt2', zconv('zt2', { shape: 'thread', parentId: 'zc2', nativeMute: { muted: true } } as Partial<P.ConversationView>));
  db.conversations.set('zt3', zconv('zt3', { shape: 'thread', parentId: 'zc2' } as Partial<P.ConversationView>));
  // Unmuted in the muted channel: Zulip sends the topic { level: 'all' }.
  db.conversations.set('zt4', zconv('zt4', { shape: 'thread', parentId: 'zc1', nativeMute: { level: 'all' } } as Partial<P.ConversationView>));
  for (const id of ['zc1', 'zt1', 'zc2', 'zt2', 'zt3', 'zt4']) link(edge('zs', id));
  db.rules = [];
  changed('meta');
  for (const id of ['zc1', 'zt1', 'zt2']) expect(effectiveLevel(db.conversations.get(id)!)).toMatchObject({ level: 'digest', rule: null, source: 'Muted in Zulip: kept to the list' });
  expect(effectiveLevel(db.conversations.get('zt3')!)).toMatchObject({ level: 'mentions', source: 'Zulip notifies only mentions here' });
  // With a rule above it, the Zulip mute still holds it down.
  db.rules = [{ id: 'r', scope: 'network', target: 'zulip', level: 'all' } as P.RuleView];
  changed('meta');
  expect(effectiveLevel(db.conversations.get('zt2')!)).toMatchObject({ level: 'digest', source: 'muted in Zulip' });
  expect(effectiveLevel(db.conversations.get('zt3')!).level).toBe('all');
  // The topic's own setting is its answer over its channel's mute.
  expect(effectiveLevel(db.conversations.get('zt4')!).level).toBe('all');
  expect(effectiveLevel(db.conversations.get('zt1')!).level).toBe('digest');
  db.rules = [];
  changed('meta');
});

test('a server opens on its first channel of messages, past forums; a space of forums only opens on its first forum', () => {
  const at = (id: string, position: string) => ({ ...edge(id.startsWith('d') ? 'ds' : 'zo', id), position });
  db.spaces.set('ds', space('ds', 'Server'));
  db.spaces.set('zo', { ...space('zo', 'Org'), network: 'zulip' });
  for (const [id, variant, position] of [['d-forum', 'forum', '1'], ['d-voice', 'voice', '2'], ['d-text', 'text', '3'], ['z-voice', 'voice', '1'], ['z-general', 'forum', '2'], ['z-random', 'forum', '3']] as const) {
    db.conversations.set(id, conv(id, 1, 0, { variant, spaceIds: [id.startsWith('d') ? 'ds' : 'zo'] } as Partial<P.ConversationView>));
    link(at(id, position));
  }
  changed('meta');
  expect(firstChannel('ds')).toBe('d-text');
  expect(firstChannel('zo')).toBe('z-general');
  expect(firstChannel('nothing-here')).toBeUndefined();
});

test("a space's channels are its channels only, not the threads or topics under them, latest first", () => {
  db.spaces.set('zc', { ...space('zc', 'Counted'), network: 'zulip' });
  for (const [id, shape, parentId, at] of [['q-old', 'channel', null, 0], ['q-new', 'channel', null, 0], ['q-t1', 'thread', 'q-old', 50], ['q-t2', 'thread', 'q-new', 90], ['q-t3', 'thread', 'q-new', 10]] as const) {
    db.conversations.set(id, conv(id, at, 0, { network: 'zulip', shape, parentId, variant: shape === 'channel' ? 'forum' : 'text', spaceIds: shape === 'channel' ? ['zc'] : [] } as Partial<P.ConversationView>));
    if (shape === 'channel') link(edge('zc', id));
    else db.threads.set(parentId!, [...(db.threads.get(parentId!) ?? []), id]);
  }
  changed('meta');
  expect(convsUnder('zc')).toHaveLength(5);
  expect(channelsUnder('zc').map((c) => c.id)).toEqual(['q-new', 'q-old']);
});
