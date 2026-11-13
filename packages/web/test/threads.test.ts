/**
 * src/threads.ts: the thread entries of a conversation's and a message's menus are offered only where a connected
 * account has the capability, and only on what they apply to (docs/threads.md).
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { namedTags, postProblem, threadNameProblem } from '@dither-chat/protocol';
import { db, selfIds, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { ableAccount, threadConvEntries, threadMessageEntries } = await import('../src/threads.ts');

const ALL: P.Capability[] = ['followThreads', 'createThreads', 'forumPosts', 'listThreads', 'myThreads', 'crosspost'];
const account = (id: string, caps: P.Capability[], status = 'online') => ({ id, network: 'discord', label: id, status, capabilities: caps, selfIdentityId: `idn_${id}` }) as unknown as P.AccountView;
const conv = (id: string, extra: Partial<P.ConversationView>): P.ConversationView =>
  ({ id, network: 'discord', nativeId: id, shape: 'channel', variant: 'text', name: id, parentId: null, spaceIds: [], participantIds: [], vantages: [{ accountId: 'a1', unread: 0, mentions: 0, lastReadTs: null }], lastMessage: null, lastMessageAt: null, nativeMute: null, ...extra }) as unknown as P.ConversationView;
const msg = (conversationId: string, extra: Partial<P.MessageView> = {}) => ({ id: 'm1', conversationId, authorId: 'idn_a1', body: 'A long question about lifetimes in async closures that goes on', kind: 'text', deleted: false, threadId: null, ...extra }) as unknown as P.MessageView;
const labels = (xs: { label?: string }[]) => xs.map((x) => x.label);

db.accounts.set('a1', account('a1', ALL));
db.accounts.set('off', account('off', ALL, 'offline'));
selfIds.add('idn_a1');

test('only a connected account with the capability counts', () => {
  const c = conv('c', {});
  expect(ableAccount(c, 'createThreads')).toBe('a1');
  expect(ableAccount(conv('c', { vantages: [{ accountId: 'off', unread: 0, mentions: 0, lastReadTs: null }] }), 'createThreads')).toBeNull();
  db.accounts.set('a1', account('a1', ['send']));
  expect(threadConvEntries(c)).toEqual([]);
  db.accounts.set('a1', account('a1', ALL));
});

test("a text channel starts and browses threads; a forum posts and lists its archived posts; voice has neither", () => {
  expect(labels(threadConvEntries(conv('c', {})))).toEqual(['Start Thread', 'Browse Threads']);
  expect(labels(threadConvEntries(conv('f', { variant: 'forum' })))).toEqual(['New Post', 'Archived Posts']);
  expect(labels(threadConvEntries(conv('v', { variant: 'voice' })))).toEqual([]);
});

test('a thread: follow, and once followed its notification setting with the current one ticked', () => {
  const t = conv('t', { shape: 'thread', thread: { following: [], notFollowing: ['a1'], notify: null } as unknown as P.ThreadView });
  expect(labels(threadConvEntries(t))).toEqual(['Follow Thread']);
  const on = conv('t', { shape: 'thread', thread: { following: ['a1'], notFollowing: [], notify: 'mentions' } as unknown as P.ThreadView });
  const entries = threadConvEntries(on);
  expect(labels(entries)).toEqual(['Unfollow Thread', 'Thread Notifications']);
  const sub = (entries[1] as { sub: { label: string; checked?: boolean }[] }).sub;
  expect(sub.map((x) => [x.label, !!x.checked])).toEqual([
    ['All messages', false],
    ['Only @mentions', true],
    ['Nothing', false],
  ]);
});

test('a message: a thread from it in a text channel; publish only your own, in an announcement channel, once', () => {
  db.conversations.set('c', conv('c', {}));
  db.conversations.set('ann', conv('ann', { variant: 'announcement' }));
  db.conversations.set('t', conv('t', { shape: 'thread' }));
  expect(labels(threadMessageEntries(msg('c')))).toEqual(['Create Thread']);
  expect(labels(threadMessageEntries(msg('c', { threadId: 'x' })))).toEqual([]);
  expect(labels(threadMessageEntries(msg('t')))).toEqual([]);
  expect(labels(threadMessageEntries(msg('ann')))).toEqual(['Create Thread', 'Publish']);
  expect(labels(threadMessageEntries(msg('ann', { authorId: 'idn_someone' })))).toEqual(['Create Thread']);
  expect(labels(threadMessageEntries(msg('ann', { rich: { marks: { published: true } } } as Partial<P.MessageView>)))).toEqual(['Create Thread']);
});

test("the checks the forms and the hub share", () => {
  expect(threadNameProblem(' ')).toBe('Give it a name');
  expect(threadNameProblem('x'.repeat(101))).toMatch(/at most 100/);
  const forum = { tags: [{ id: '1', name: 'Solved' }, { id: '2', name: 'Bug' }], tagRequired: true };
  expect(postProblem({ name: 'Help', body: 'x', tags: [] }, forum)).toMatch(/at least one tag/);
  expect(postProblem({ name: 'Help', body: '', tags: ['1'], files: 1 }, forum)).toBeNull();
  expect(postProblem({ name: 'Help', body: 'x', tags: ['1', '2', '3', '4', '5', '6'] }, null)).toMatch(/At most 5/);
  expect(namedTags(forum, ['2', 'gone', '1']).map((t) => t.name)).toEqual(['Solved', 'Bug']);
});
