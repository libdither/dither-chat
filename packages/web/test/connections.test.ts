import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { connectionLine, connections, connectionTags, linkKind, linksLine } from '../src/connections.ts';

const link = (accountId: string, identityId: string, relationship: P.LinkRelationship, x: Partial<P.PersonLinkView> = {}): P.PersonLinkView => ({ accountId, identityId, personId: 'per_a', relationship, since: null, ...x });
const ids: Pick<P.IdentityView, 'id' | 'network'>[] = [
  { id: 'i_d', network: 'discord' },
  { id: 'i_t', network: 'telegram' },
  { id: 'i_s', network: 'signal' },
  { id: 'i_x', network: 'x' },
];

test('one vocabulary: a Discord friend and an X follow both ways are Friends, address books are Contacts', () => {
  const list = connections(ids, [link('main', 'i_d', 'friend', { since: 5 }), link('alt', 'i_d', 'friend'), link('tg', 'i_t', 'contact')], {
    i_s: { accountId: 'sig', relationship: 'contact' },
    i_x: { accountId: 'xa', relationship: 'following', followsYou: true },
  });
  expect(list.map((c) => [c.kind, c.network, c.accountId, c.ends])).toEqual([
    ['friend', 'discord', 'main', 'friend'],
    ['friend', 'discord', 'alt', 'friend'],
    ['friend', 'x', 'xa', 'following'],
    ['contact', 'telegram', 'tg', 'contact'],
    ['contact', 'signal', 'sig', 'contact'],
  ]);
  expect(list[0].since).toBe(5);
  expect(list.map(connectionLine)).toEqual(['Friends on Discord', 'Friends on Discord', 'You follow each other on X', 'In your Telegram contacts', 'In your Signal contacts']);
  expect(connectionTags(list).map((t) => [t.label, t.networks.join()])).toEqual([
    ['Friend', 'discord,x'],
    ['Contact', 'telegram,signal'],
  ]);
});

test('one way: You follow, Follows you (nothing to end), a request sent, blocked', () => {
  const x = [{ id: 'i_x', network: 'x' as const }];
  expect(connections(x, [], { i_x: { accountId: 'xa', relationship: 'following', followsYou: false } }).map((c) => [c.kind, connectionLine(c)])).toEqual([['following', 'You follow them on X']]);
  const back = connections(x, [], { i_x: { accountId: 'xa', relationship: 'stranger', followsYou: true } });
  expect(back.map((c) => [c.kind, c.ends, connectionLine(c)])).toEqual([['follower', null, 'Follows you on X']]);
  expect(connectionTags(back)[0].label).toBe('Follows you');
  const d = [{ id: 'i_d', network: 'discord' as const }];
  expect(connections(d, [link('alt', 'i_d', 'requested')], {}).map(connectionLine)).toEqual(['Friend request sent on Discord']);
  expect(connections(d, [link('main', 'i_d', 'blocked')], {}).map((c) => [c.kind, connectionLine(c)])).toEqual([['blocked', 'Blocked on Discord']]);
  // Someone asking you is a request, not a connection: the hero has Accept.
  expect(connections(d, [], { i_d: { accountId: 'main', relationship: 'requesting' } })).toEqual([]);
});

test("a follow on an account's list is mutual when its profile or the hub's list says they follow back", () => {
  const x = [{ id: 'i_x', network: 'x' as const }];
  expect(connections(x, [link('xa', 'i_x', 'following', { followsYou: true })], {})[0].kind).toBe('friend');
  expect(connections(x, [link('xa', 'i_x', 'following')], { i_x: { accountId: 'xa', relationship: 'following', followsYou: true } })[0].kind).toBe('friend');
  // Followed back through another account of yours: one-way here, and that account's follower.
  const two = connections(x, [link('xa', 'i_x', 'following')], { i_x: { accountId: 'xb', relationship: 'stranger', followsYou: true } });
  expect(two.map((c) => [c.kind, c.accountId])).toEqual([
    ['following', 'xa'],
    ['follower', 'xb'],
  ]);
});

test("People's rows: a mutual follow is a friend, and a row says what it is when there is no talk to tell", () => {
  expect(linkKind({ relationship: 'following', followsYou: true })).toBe('friend');
  expect(linkKind({ relationship: 'following' })).toBe('following');
  expect(linkKind({ relationship: 'contact' })).toBe('contact');
  const net = (id: string) => ({ main: 'discord', alt: 'discord', xa: 'x', tg: 'telegram', sig: 'signal' })[id] as P.Network | undefined;
  expect(linksLine([link('xa', 'i', 'following', { followsYou: true })], net)).toBe('You follow each other on X');
  expect(linksLine([link('main', 'i', 'friend'), link('alt', 'i', 'friend')], net)).toBe('Friends on Discord');
  expect(linksLine([link('main', 'i', 'friend'), link('xa', 'i', 'following', { followsYou: true })], net)).toBe('Friends on Discord and X');
  expect(linksLine([link('tg', 'i', 'contact'), link('sig', 'i', 'contact')], net)).toBe('Contacts on Telegram and Signal');
  expect(linksLine([link('main', 'i', 'friend'), link('tg', 'i', 'contact')], net)).toBe('On Discord and Telegram');
  expect(linksLine([link('gone', 'i', 'friend')], net)).toBe('');
});
