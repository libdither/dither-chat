/**
 * src/model.ts: the threads the sidebar shows under a channel, one rule for every network (docs/servers.md, "Threads
 * under a channel"), and a channel's count with its threads', which a space's and a folder's agree with.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { changed } from '../src/versions.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { channelUnread, folderConvs, LATEST_THREADS_SHOWN, shownThreads, spaceUnread, sumUnread, threadWords, totalUnread, UNREAD_THREADS_SHOWN } = await import('../src/model.ts');

const NOW = 1_800_000_000_000;
type Net = 'discord' | 'zulip' | 'matrix';

db.accounts.set('acc-d', { id: 'acc-d', network: 'discord', label: 'me' } as unknown as P.AccountView);
db.accounts.set('acc-z', { id: 'acc-z', network: 'zulip', label: 'me' } as unknown as P.AccountView);
db.accounts.set('acc-m', { id: 'acc-m', network: 'matrix', label: 'me' } as unknown as P.AccountView);
const accOf = (n: Net) => (n === 'discord' ? 'acc-d' : n === 'zulip' ? 'acc-z' : 'acc-m');

function space(id: string, network: Net) {
  db.spaces.set(id, { id, network, nativeId: id, kind: 'community', name: id, topic: null, icon: null, accountIds: [accOf(network)], nativeMute: null });
}
function channel(id: string, network: Net, sid: string, extra: Partial<P.ConversationView> & { unread?: number; mentions?: number } = {}) {
  const { unread = 0, mentions = 0, ...rest } = extra;
  db.conversations.set(id, { id, network, shape: 'channel', variant: 'text', spaceIds: [sid], parentId: null, name: id, lastMessageAt: NOW, lastMessage: null, nativeMute: null, archived: false, vantages: [{ accountId: accOf(network), unread, mentions, lastReadTs: null }], ...rest } as unknown as P.ConversationView);
  const e: P.SpaceEdgeView = { parentId: sid, childId: id, childKind: 'conversation', position: null };
  // Each test sets up its own, again on a rerun: once each.
  db.children.set(sid, [...(db.children.get(sid) ?? []).filter((x) => x.childId !== id), e]);
  db.parents.set(id, [e]);
}
/** A thread `age` minutes old under `parent`. */
function thread(id: string, parent: string, age: number, extra: Partial<P.ConversationView> & { unread?: number; mentions?: number } = {}) {
  const p = db.conversations.get(parent)!;
  const { unread = 0, mentions = 0, ...rest } = extra;
  db.conversations.set(id, { id, network: p.network, shape: 'thread', variant: 'text', spaceIds: [], parentId: parent, name: id, lastMessageAt: NOW - age * 60_000, lastMessage: null, nativeMute: null, archived: false, vantages: [{ accountId: accOf(p.network as Net), unread, mentions, lastReadTs: null }], ...rest } as unknown as P.ConversationView);
  db.threads.set(parent, [...(db.threads.get(parent) ?? []).filter((x) => x !== id), id]);
}
const ids = (s: { shown: P.ConversationView[] }) => s.shown.map((t) => t.id);
const MUTED: P.NativeMute = { muted: true };

test('the open thread, then unread ones with a mention first, then the latest three, then how many more', () => {
  space('zorg', 'zulip');
  channel('zchan', 'zulip', 'zorg', { variant: 'forum' });
  for (let i = 0; i < 10; i++) thread(`z${i}`, 'zchan', i);
  // Older ones, unread: one with a mention, one muted with a mention, one muted without.
  thread('zu', 'zchan', 100, { unread: 2 });
  thread('zm', 'zchan', 200, { unread: 1, mentions: 1 });
  thread('zmuted-mention', 'zchan', 300, { unread: 1, mentions: 1, nativeMute: MUTED });
  thread('zmuted', 'zchan', 400, { unread: 5, nativeMute: MUTED });
  thread('zold', 'zchan', 500);
  changed('meta');

  const s = shownThreads(db.conversations.get('zchan')!);
  // Mentions first (latest first among them), then the unread, then the three latest; the muted one without a mention is left out.
  expect(ids(s)).toEqual(['zm', 'zmuted-mention', 'zu', 'z0', 'z1', 'z2']);
  expect(LATEST_THREADS_SHOWN).toBe(3);
  // 15 topics, 6 shown.
  expect(s.more).toBe(9);

  // An open topic comes first, out of the rest.
  const open = shownThreads(db.conversations.get('zchan')!, 'zold');
  expect(ids(open)).toEqual(['zold', 'zm', 'zmuted-mention', 'zu', 'z0', 'z1', 'z2']);
  expect(open.more).toBe(8);
  // One already shown stays where it is, so it does not jump from under the pointer.
  expect(shownThreads(db.conversations.get('zchan')!, 'z2')).toBe(s);
  // The channel itself open, or a thread of another: as it was.
  expect(shownThreads(db.conversations.get('zchan')!, 'zchan')).toBe(s);

  // The words for the "more" row.
  expect(threadWords(db.conversations.get('zchan')!).many).toBe('topics');
});

test('an unread thread opened, and so read, stays where it was clicked', () => {
  space('zorg5', 'zulip');
  channel('zstay', 'zulip', 'zorg5', { variant: 'forum' });
  for (let i = 0; i < 5; i++) thread(`zs${i}`, 'zstay', i);
  thread('zs-unread', 'zstay', 100, { unread: 2 });
  changed('meta');
  const c = db.conversations.get('zstay')!;
  expect(ids(shownThreads(c))).toEqual(['zs-unread', 'zs0', 'zs1', 'zs2']);
  // Opened: it is read, so the rule alone would leave it out; it keeps its place.
  thread('zs-unread', 'zstay', 100);
  changed('list');
  const open = shownThreads(c, 'zs-unread');
  expect(ids(open)).toEqual(['zs-unread', 'zs0', 'zs1', 'zs2']);
  expect(open.more).toBe(2);
  // Another of its threads opened: the rule again.
  expect(ids(shownThreads(c, 'zs1'))).toEqual(['zs0', 'zs1', 'zs2']);
  // One opened from the rest, never shown: first.
  expect(ids(shownThreads(c, 'zs4'))).toEqual(['zs4', 'zs0', 'zs1', 'zs2']);
});

test('unread threads are capped: a channel with hundreds shows a few, the rest are counted', () => {
  space('zorg2', 'zulip');
  channel('zbig', 'zulip', 'zorg2', { variant: 'forum' });
  for (let i = 0; i < 300; i++) thread(`zb${i}`, 'zbig', i, { unread: 1 });
  thread('zb-mention', 'zbig', 1000, { unread: 1, mentions: 1 });
  changed('meta');
  const s = shownThreads(db.conversations.get('zbig')!);
  // The mention, the latest unread ones, then the latest not shown yet (more unread ones).
  expect(s.shown[0].id).toBe('zb-mention');
  expect(s.shown.length).toBe(1 + UNREAD_THREADS_SHOWN + LATEST_THREADS_SHOWN);
  expect(ids(s).slice(1, 1 + UNREAD_THREADS_SHOWN)).toEqual(Array.from({ length: UNREAD_THREADS_SHOWN }, (_, i) => `zb${i}`));
  expect(s.more).toBe(301 - s.shown.length);
  // Every one still counts in the channel's badge.
  expect(channelUnread(db.conversations.get('zbig')!).unread).toBe(301);
});

test('a Discord text channel: archived threads show only open or unread, and are not in the more count', () => {
  space('dsrv', 'discord');
  channel('dtext', 'discord', 'dsrv', { unread: 3 });
  thread('dt-live', 'dtext', 10);
  for (let i = 0; i < 200; i++) thread(`dt-old${i}`, 'dtext', 20 + i, { archived: true });
  thread('dt-old-unread', 'dtext', 5000, { archived: true, unread: 4 });
  changed('meta');
  const c = db.conversations.get('dtext')!;
  const s = shownThreads(c);
  expect(ids(s)).toEqual(['dt-old-unread', 'dt-live']);
  expect(s.more).toBe(0);
  // Open, an archived one shows too.
  expect(ids(shownThreads(c, 'dt-old7'))).toEqual(['dt-old7', 'dt-old-unread', 'dt-live']);
  // A thread of another channel open: as it was.
  expect(shownThreads(c, 'zold')).toBe(s);
  expect(shownThreads(c, 'dt-old7').more).toBe(0);
  expect(threadWords(c).many).toBe('threads');
  // Its badge: its own messages and its threads', added (a thread's messages are its own).
  const u = channelUnread(c);
  expect(u.unread).toBe(7);
});

test('a Zulip resolved topic is listed like the rest, a Discord forum post archived is not', () => {
  space('zorg3', 'zulip');
  channel('zres', 'zulip', 'zorg3', { variant: 'forum' });
  thread('zr1', 'zres', 1, { archived: true, name: '✔ done' });
  thread('zr2', 'zres', 2);
  space('dsrv2', 'discord');
  channel('dforum', 'discord', 'dsrv2', { variant: 'forum' });
  thread('df1', 'dforum', 1, { archived: true });
  for (let i = 2; i < 7; i++) thread(`df${i}`, 'dforum', i);
  changed('meta');
  expect(ids(shownThreads(db.conversations.get('zres')!))).toEqual(['zr1', 'zr2']);
  const f = shownThreads(db.conversations.get('dforum')!);
  expect(ids(f)).toEqual(['df2', 'df3', 'df4']);
  expect(f.more).toBe(2);
  expect(threadWords(db.conversations.get('dforum')!).many).toBe('posts');
});

test('a Matrix room: its threads by the same rule, a muted one left out of the latest', () => {
  space('msp', 'matrix');
  channel('mroom', 'matrix', 'msp');
  thread('mt1', 'mroom', 1, { nativeMute: MUTED });
  thread('mt2', 'mroom', 2);
  thread('mt3', 'mroom', 3, { unread: 1 });
  thread('mt4', 'mroom', 4);
  thread('mt5', 'mroom', 5);
  changed('meta');
  const s = shownThreads(db.conversations.get('mroom')!);
  expect(ids(s)).toEqual(['mt3', 'mt2', 'mt4', 'mt5']);
  expect(s.more).toBe(1);
});

test('a muted channel still lists its latest threads, dimmed, but not its unread ones', () => {
  space('zorg4', 'zulip');
  channel('zquiet', 'zulip', 'zorg4', { variant: 'forum', nativeMute: MUTED });
  thread('zq1', 'zquiet', 1);
  thread('zq2', 'zquiet', 2, { unread: 3 });
  thread('zq3', 'zquiet', 3, { unread: 1, mentions: 1 });
  thread('zq4', 'zquiet', 4);
  changed('meta');
  const s = shownThreads(db.conversations.get('zquiet')!);
  expect(ids(s)).toEqual(['zq3', 'zq1', 'zq2', 'zq4']);
  expect(channelUnread(db.conversations.get('zquiet')!).muted).toBe(true);
});

test('counts: a channel with its threads, a space and a folder agree, nothing counted twice', () => {
  space('dsrv3', 'discord');
  // A text channel: own 2 unread, a thread with 3 (one a mention).
  channel('ctext', 'discord', 'dsrv3', { unread: 2 });
  thread('ct1', 'ctext', 1, { unread: 3, mentions: 1 });
  // A Discord forum whose own read state already holds its posts' (4 = 1 + 3): the larger, never both.
  channel('cforum', 'discord', 'dsrv3', { variant: 'forum', unread: 4, mentions: 1 });
  thread('cf1', 'cforum', 1, { unread: 1 });
  thread('cf2', 'cforum', 2, { unread: 3, mentions: 1 });
  changed('meta');
  const text = channelUnread(db.conversations.get('ctext')!);
  expect([text.unread, text.mentions, text.badge]).toEqual([5, 1, 1]);
  const forum = channelUnread(db.conversations.get('cforum')!);
  expect([forum.unread, forum.mentions, forum.badge]).toEqual([4, 1, 1]);
  // The server: the two rows added, not every conversation under it.
  const s = spaceUnread('dsrv3');
  expect([s.unread, s.mentions, s.badge]).toEqual([9, 2, 2]);
  // A folder holding the server: the same.
  db.folders = db.folders.filter((x) => x.id !== 'fold1');
  db.folders.push({ id: 'fold1', name: 'F', items: [{ kind: 'space', id: 'dsrv3' }] } as unknown as P.FolderView);
  changed('meta');
  const f = sumUnread(folderConvs(db.folders.find((x) => x.id === 'fold1')!));
  expect([f.unread, f.mentions, f.badge]).toEqual([9, 2, 2]);
  // A folder holding the channels themselves: with their threads, as their rows count.
  db.folders = db.folders.filter((x) => x.id !== 'fold2');
  db.folders.push({ id: 'fold2', name: 'G', items: [{ kind: 'conversation', id: 'ctext' }, { kind: 'conversation', id: 'cforum' }] } as unknown as P.FolderView);
  changed('meta');
  const g = sumUnread(folderConvs(db.folders.find((x) => x.id === 'fold2')!));
  expect([g.unread, g.mentions, g.badge]).toEqual([9, 2, 2]);
  // A forum's own count of nothing (Zulip's): its posts'.
  db.conversations.set('cforum', { ...db.conversations.get('cforum')!, vantages: [{ accountId: 'acc-d', unread: 0, mentions: 0, lastReadTs: null }] });
  changed('list');
  expect(channelUnread(db.conversations.get('cforum')!).unread).toBe(4);
  expect(spaceUnread('dsrv3').unread).toBe(9);
  // And the app's whole count is its spaces', each once: every conversation in this file is under one.
  const spaces = [...db.spaces.keys()];
  expect(totalUnread().unread).toBe(spaces.reduce((n, id) => n + spaceUnread(id).unread, 0));
});
