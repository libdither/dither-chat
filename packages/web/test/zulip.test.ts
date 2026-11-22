/**
 * A Zulip organization's presentation (docs/threads.md "Zulip"): Zulip's own narrow links from native ids, a resolved
 * topic's name and words, the thread menus in Zulip's words, and a profile's local time. Made-up ids only.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { convTitle, deepLink, externalProfile, resolvedTopic, spaceLink, threadWords, topicForum, zulipHash, zulipMessageLink } = await import('../src/model.ts');
const { threadConvEntries } = await import('../src/threads.ts');
const { localTime } = await import('../src/format.ts');

const H = 'chat.example.org';
db.accounts.set('z1', { id: 'z1', network: 'zulip', label: 'lab', status: 'online', capabilities: ['followThreads', 'forumPosts', 'listThreads'], selfIdentityId: 'idn_z1' } as unknown as P.AccountView);
const conv = (id: string, extra: Partial<P.ConversationView>): P.ConversationView => {
  const c = { id, network: 'zulip', nativeId: id, shape: 'channel', variant: 'forum', name: id, parentId: null, spaceIds: [], participantIds: [], vantages: [{ accountId: 'z1', unread: 0, mentions: 0, lastReadTs: null }], lastMessage: null, lastMessageAt: null, nativeMute: null, ...extra } as unknown as P.ConversationView;
  db.conversations.set(id, c);
  return c;
};
const design = conv('cnv_design', { nativeId: `${H}/s/10`, name: 'design team' });
const topic = (name: string, nativeTopic: string) => conv(`cnv_${nativeTopic}`, { nativeId: `${H}/s/10/t/${nativeTopic}`, shape: 'thread', variant: 'text', parentId: design.id, name });

test("Zulip's hash encoding is its web client's: dots for percent signs, and the characters Markdown would take", () => {
  expect(zulipHash('Color tokens')).toBe('Color.20tokens');
  expect(zulipHash("v2.4 (beta)! it's *done*")).toBe('v2.2E4.20.28beta.29.21.20it.27s.20.2Adone.2A');
  expect(zulipHash('ü')).toBe('.C3.BC');
});

test('a channel, a topic by the name it has now, a resolved one with its ✔, and the empty topic', () => {
  expect(deepLink(design)).toBe(`https://${H}/#narrow/channel/10-design-team`);
  // The native id is lowercased; the link keeps the name as written.
  expect(deepLink(topic('Color Tokens', 'color%20tokens'))).toBe(`https://${H}/#narrow/channel/10-design-team/topic/Color.20Tokens`);
  expect(deepLink(topic('✔ Icon sizes', 'icon%20sizes'))).toBe(`https://${H}/#narrow/channel/10-design-team/topic/.E2.9C.94.20Icon.20sizes`);
  expect(deepLink(topic('general chat', ''))).toBe(`https://${H}/#narrow/channel/10-design-team/topic/`);
  // A name whose encoding would be long is left to the bare id, as Zulip does.
  expect(deepLink(conv('cnv_jp', { nativeId: `${H}/s/11`, name: 'デザイン' }))).toBe(`https://${H}/#narrow/channel/11`);
});

test("direct messages as Zulip's permalinks: -dm for two, -group for more; a local server over http", () => {
  expect(deepLink(conv('cnv_dm', { nativeId: `${H}/dm/8,12`, shape: 'direct', variant: 'text' }))).toBe(`https://${H}/#narrow/dm/8,12-dm`);
  expect(deepLink(conv('cnv_g', { nativeId: `${H}/dm/8,12,13`, shape: 'group', variant: 'text' }))).toBe(`https://${H}/#narrow/dm/8,12,13-group`);
  expect(deepLink(conv('cnv_local', { nativeId: 'localhost:9991/s/3', name: 'x' }))).toBe('http://localhost:9991/#narrow/channel/3-x');
  // Only this machine: a host that merely starts so is served over https.
  expect(deepLink(conv('cnv_lookalike', { nativeId: 'localhost.example.org/s/3', name: 'x' }))).toBe('https://localhost.example.org/#narrow/channel/3-x');
});

test('a message near its place, a person, and the organization', () => {
  expect(zulipMessageLink(topic('Color Tokens', 'color%20tokens'), `${H}/m/1042`)).toBe(`https://${H}/#narrow/channel/10-design-team/topic/Color.20Tokens/near/1042`);
  expect(zulipMessageLink(design, 'not-a-message')).toBeNull();
  expect(externalProfile({ network: 'zulip', nativeId: `${H}/u/11` } as P.IdentityView)).toBe(`https://${H}/#user/11`);
  expect(externalProfile({ network: 'zulip', nativeId: `${H}/g/2` } as P.IdentityView)).toBeNull();
  expect(spaceLink({ network: 'zulip', kind: 'community', nativeId: H } as P.SpaceView)).toBe(`https://${H}/`);
  expect(spaceLink({ network: 'zulip', kind: 'section', nativeId: `${H}/f/1` } as P.SpaceView)).toBeNull();
});

test('a resolved topic shows its name without the ✔, and Zulip says topics and Resolved', () => {
  const done = topic('✔ Icon sizes', 'icon%20sizes');
  expect(resolvedTopic(done)).toBe(true);
  expect(convTitle(done)).toBe('Icon sizes');
  // Only a Zulip topic: elsewhere a ✔ is part of the name.
  expect(convTitle({ ...done, network: 'discord' })).toBe('✔ Icon sizes');
  expect(topicForum(design)).toBe(true);
  expect(threadWords(design)).toMatchObject({ one: 'topic', many: 'topics', archived: 'Resolved' });
  expect(threadWords(done)).toMatchObject({ one: 'topic', archive: 'Resolve' });
  expect(threadWords({ ...design, network: 'discord' })).toMatchObject({ one: 'post', archived: 'Archived' });
});

test("a Zulip channel's and topic's menus say topics", () => {
  expect(threadConvEntries(design).map((e) => e.label)).toEqual(['New Topic', 'Resolved Topics']);
  const followed = { ...topic('Color Tokens', 'color%20tokens'), thread: { following: ['z1'], notFollowing: [], notify: 'all' } as unknown as P.ThreadView };
  expect(threadConvEntries(followed).map((e) => e.label)).toEqual(['Unfollow Topic', 'Topic Notifications']);
});

test("local time: in their zone, with how far it is from yours; nothing for a zone the browser does not know", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0);
  const berlin = localTime('Europe/Berlin', now)!;
  expect(berlin).toContain('Europe/Berlin');
  expect(berlin).toContain(new Intl.DateTimeFormat(undefined, { timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit' }).format(now));
  const gap = 60 + new Date(now).getTimezoneOffset();
  const span = (d: number) => (d % 60 ? `${Math.floor(Math.abs(d) / 60) ? `${Math.floor(Math.abs(d) / 60)} h ` : ''}${Math.abs(d) % 60} min` : `${Math.abs(d) / 60} hour${Math.abs(d) === 60 ? '' : 's'}`);
  expect(berlin).toEndWith(gap === 0 ? 'your time' : `${span(gap)} ${gap > 0 ? 'ahead' : 'behind'}`);
  // A zone a quarter of an hour off: hours and minutes, not "5.8 hours".
  const kathmandu = 345 + new Date(now).getTimezoneOffset();
  expect(localTime('Asia/Kathmandu', now)).toEndWith(kathmandu === 0 ? 'your time' : `${span(kathmandu)} ${kathmandu > 0 ? 'ahead' : 'behind'}`);
  expect(localTime('Asia/Kathmandu', now)).not.toContain('.');
  expect(localTime('Not/AZone', now)).toBeNull();
});
