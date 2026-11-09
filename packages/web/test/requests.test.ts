import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { accountLine, canRemove, peopleFilters, confirmNext, groupRequests, heldRequest, identityRef, linkRows, messageRequestNote, profileLinks, relation, removeQuestion, requestLine, requestsRow, sentence, targetMembers } from '../src/requests.ts';
import { identityPeer } from '../src/direct.ts';

const req = (id: string, kind: P.RequestView['kind'], ts: number, x: Partial<P.RequestView> = {}): P.RequestView => ({
  id,
  accountId: 'acc_d',
  network: 'discord',
  nativeId: id,
  kind,
  from: `idn_${id}`,
  target: null,
  ts,
  answers: ['accept', 'decline'],
  warning: null,
  ...x,
});
const acc = (id: string, network: P.Network, capabilities: P.Capability[], status: P.AccountStatus = 'online') => ({ id, network, status, capabilities }) as P.AccountView;
const who = (network: P.Network, nativeId: string, handle: string | null = null) => ({ id: `idn_${nativeId}`, network, nativeId, handle });

test('grouped by kind in a fixed order, newest first in each, empty groups left out', () => {
  const g = groupRequests([req('a', 'message', 5), req('b', 'friend', 1), req('c', 'friend', 9), req('d', 'invite', 3)]);
  expect(g.map((x) => [x.title, x.requests.map((r) => r.id)])).toEqual([
    ['Friend requests', ['c', 'b']],
    ['Invites', ['d']],
    ['Message requests', ['a']],
  ]);
  expect(groupRequests([])).toEqual([]);
});

test('what each asks, with the place when the network says', () => {
  const room = { kind: 'conversation' as const, id: null, name: 'Nix Hackathon 2026', members: 23 };
  expect(requestLine(req('a', 'friend', 0))).toBe('wants to be friends');
  expect(requestLine(req('a', 'follow', 0))).toBe('wants to follow you');
  expect(requestLine(req('a', 'invite', 0, { target: room }))).toBe('invited you to Nix Hackathon 2026');
  expect(requestLine(req('a', 'invite', 0, { target: { kind: 'space', id: null, name: null, members: null } }))).toBe('invited you to a server');
  expect(requestLine(req('a', 'message', 0))).toBe('sent you a message request');
  expect(requestLine(req('a', 'join', 0, { network: 'telegram', target: { ...room, name: 'Film swap' } }))).toBe('asks to join Film swap');
  expect(targetMembers({ target: room })).toBe('23 members');
  expect(targetMembers({ target: { ...room, members: 1 } })).toBe('1 member');
  expect(targetMembers({ target: null })).toBeNull();
});

test("the inbox's row: how many, who (once each, newest first), and the newest", () => {
  const names: Record<string, string> = { idn_a: 'Nova', idn_b: 'Jules', idn_c: 'Nova' };
  expect(requestsRow([req('a', 'friend', 5), req('b', 'invite', 9), req('c', 'follow', 1)], (id) => names[id!])).toEqual({ count: 3, names: ['Jules', 'Nova'], lastAt: 9 });
  expect(requestsRow([], () => '')).toBeNull();
});

test('the conversation a message request holds, and what the page says about it', () => {
  const m = req('m', 'message', 1, { network: 'signal', target: { kind: 'conversation', id: 'cnv_x', name: null, members: null } });
  expect(heldRequest([req('f', 'friend', 1), m], 'cnv_x')).toBe(m);
  expect(heldRequest([m], 'cnv_y')).toBeUndefined();
  expect(messageRequestNote('signal', 'Jamie')).toBe('Accepting tells Jamie you saw it. On Signal even opening it on another device does; here it does not: dither-chat sends Signal no read receipts and no typing for it until you accept.');
});

test('a reading for someone known by identity, only one parseAdd itself would give', () => {
  expect(identityRef(who('discord', '123456789012345678', 'nova.wav'))).toEqual({ kind: 'person', network: 'discord', handle: '123456789012345678' });
  expect(identityRef(who('telegram', '777', '@lena_k'))).toEqual({ kind: 'name', network: 'telegram', name: 'lena_k' });
  expect(identityRef(who('telegram', '778', '+15550142'))).toEqual({ kind: 'person', network: 'telegram', handle: '+15550142' });
  expect(identityRef(who('x', '44', 'dither_dev'))).toEqual({ kind: 'person', network: 'x', handle: 'dither_dev' });
  expect(identityRef(who('instagram', '45', '@film.cat'))).toEqual({ kind: 'person', network: 'instagram', handle: 'film.cat' });
  expect(identityRef(who('matrix', '@ann:matrix.org'))).toEqual({ kind: 'person', network: 'matrix', handle: '@ann:matrix.org' });
  // Nothing a page could send: no handle X takes.
  expect(identityRef(who('x', '46', null))).toBeNull();
});

test('profile buttons by how you stand: a stranger, someone who asked, a request sent, following', () => {
  const nova = who('discord', '123456789012345678', 'nova.wav');
  const both = [acc('acc_alt', 'discord', ['connect', 'requests']), acc('acc_d', 'discord', ['connect', 'requests'])];
  // Through the account that asked about them, when it can.
  expect(relation({ network: 'discord', relationship: 'stranger', accountId: 'acc_d' }, nova, both, [])).toEqual({ kind: 'connect', action: 'friend', accountId: 'acc_d', ref: { kind: 'person', network: 'discord', handle: nova.nativeId } });
  expect(relation({ network: 'x', relationship: 'stranger', accountId: null }, who('x', '44', 'dither_dev'), [acc('x', 'x', ['connect'])], [])).toMatchObject({ kind: 'connect', action: 'follow' });
  expect(relation({ network: 'telegram', relationship: 'stranger', accountId: null }, who('telegram', '777', '@lena_k'), [acc('t', 'telegram', ['connect'])], [])).toMatchObject({ kind: 'connect', action: 'contact' });
  const asked = req('f', 'friend', 1, { from: nova.id });
  expect(relation({ network: 'discord', relationship: 'requesting', accountId: 'acc_d' }, nova, both, [req('m', 'message', 1), asked])).toEqual({ kind: 'answer', request: asked });
  expect(relation({ network: 'discord', relationship: 'requested', accountId: 'acc_d' }, nova, both, [])).toEqual({ kind: 'state', label: 'Request sent' });
  expect(relation({ network: 'instagram', relationship: 'following', accountId: null }, who('instagram', '45', 'film.cat'), [], [])).toEqual({ kind: 'state', label: 'Following' });
  expect(relation({ network: 'discord', relationship: 'friend', accountId: 'acc_d' }, nova, both, [])).toBeNull();
});

test('nothing where no account can: no capability, offline, no way on that network, no open request', () => {
  const nova = who('discord', '123456789012345678', 'nova.wav');
  const stranger = { network: 'discord' as const, relationship: 'stranger' as const, accountId: 'acc_d' };
  expect(relation(stranger, nova, [acc('acc_d', 'discord', ['send', 'resolve'])], [])).toBeNull();
  expect(relation(stranger, nova, [acc('acc_d', 'discord', ['connect'], 'offline')], [])).toBeNull();
  expect(relation({ network: 'matrix', relationship: 'stranger', accountId: 'm' }, who('matrix', '@ann:matrix.org'), [acc('m', 'matrix', ['connect'])], [])).toBeNull();
  expect(relation({ network: 'discord', relationship: 'requesting', accountId: 'acc_d' }, nova, [acc('acc_d', 'discord', ['connect', 'requests'])], [])).toBeNull();
  // Asked through an account that cannot answer requests.
  expect(relation({ network: 'discord', relationship: 'requesting', accountId: 'acc_d' }, nova, [acc('acc_d', 'discord', ['connect'])], [req('f', 'friend', 1, { from: nova.id })])).toBeNull();
});

test('which account it came to, plainly', () => {
  expect(accountLine('discord', 'main')).toBe('to your Discord account main');
  expect(accountLine('matrix', 'matrix.org')).toBe('to your Matrix account matrix.org');
  // A label that only names the network says nothing more.
  expect(accountLine('telegram', 'Telegram')).toBe('to your Telegram account');
  expect(accountLine('signal', null)).toBe('to your Signal account');
});

test("the confirm step reads right after either of Discord's warnings and after its confirm sentence", () => {
  expect(sentence('Discord filed this request as possible spam')).toBe('Discord filed this request as possible spam.');
  expect(sentence('You must confirm the friend request to add this user.')).toBe('You must confirm the friend request to add this user.');
  for (const w of ['Discord filed this request as possible spam', 'Discord says you share no server or friend with them', 'You must confirm the friend request to add this user.'])
    expect(`${sentence(w)} ${confirmNext('accept', true)}`).toMatch(/^[A-Z][^]*\. Nothing is accepted yet\. Accept it anyway, or message them first to see who they are\.$/);
  expect(confirmNext('accept', false)).toBe('Nothing is accepted yet. Accept it anyway only if you know who they are.');
  expect(confirmNext('add', false)).toBe('No friend request has gone out yet. Add them anyway only if you know who they are.');
});

test('the question before ending each kind, naming the account', () => {
  expect(removeQuestion('friend', 'Nova', 'discord', 'main')).toBe('Remove Nova as a friend on your Discord account main?');
  expect(removeQuestion('requested', 'Mara', 'discord', 'alt')).toBe('Cancel your friend request to Mara on your Discord account alt?');
  expect(removeQuestion('blocked', 'owl', 'discord', 'main')).toBe('Unblock owl on your Discord account main?');
  expect(removeQuestion('contact', 'Noor', 'telegram', 'personal')).toBe('Remove Noor from your contacts on your Telegram account personal?');
  expect(removeQuestion('following', 'Lena', 'x', 'me')).toBe('Unfollow Lena on your X account me?');
});

const link = (accountId: string, identityId: string, relationship: P.LinkRelationship, personId: string | null = null): P.PersonLinkView => ({ accountId, identityId, personId, relationship, since: null });

test("People's rows: one per person across accounts, in the hub's order", () => {
  const rows = linkRows([link('a1', 'i1', 'friend', 'p1'), link('a1', 'i2', 'friend'), link('a2', 'i3', 'friend', 'p1')]);
  expect(rows.map((r) => [r.key, r.links.map((l) => l.accountId)])).toEqual([
    ['p1', ['a1', 'a2']],
    ['i2', ['a1']],
  ]);
});

test("a profile's standing: the lists first, then what a profile said through an account with no list entry", () => {
  const ids = [{ id: 'i1', network: 'discord' as const }, { id: 'i2', network: 'telegram' as const }];
  const out = profileLinks(ids, [link('main', 'i1', 'friend')], {
    i1: { accountId: 'alt', relationship: 'requested' },
    i2: { accountId: 'tg', relationship: 'requesting' },
  });
  expect(out).toEqual([
    { identityId: 'i1', network: 'discord', accountId: 'main', relationship: 'friend' },
    { identityId: 'i1', network: 'discord', accountId: 'alt', relationship: 'requested' },
  ]);
  // The same account's list wins over its profile.
  expect(profileLinks(ids, [link('main', 'i1', 'friend')], { i1: { accountId: 'main', relationship: 'blocked' } })).toHaveLength(1);
  expect(canRemove(acc('a', 'discord', ['disconnect']))).toBe(true);
  expect(canRemove(acc('a', 'discord', ['disconnect'], 'offline'))).toBe(false);
  expect(canRemove(acc('a', 'discord', ['connect']))).toBe(false);
});

test('a DM opens to someone by their native id, else their handle', () => {
  expect(identityPeer({ network: 'discord', nativeId: '123456789012345678', handle: 'nova.wav' })).toBe('123456789012345678');
  expect(identityPeer({ network: 'telegram', nativeId: 'x', handle: '@lena_k' })).toBe('@lena_k');
  expect(identityPeer({ network: 'discord', nativeId: 'nope', handle: null })).toBeNull();
});

test("People's chips: chats, and each kind of list an account here keeps", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  expect(ids(peopleFilters([acc('d', 'discord', ['relationships']), acc('t', 'telegram', ['relationships'])]))).toEqual(['chats', 'friend', 'contact']);
  expect(ids(peopleFilters([acc('x', 'x', ['relationships'])]))).toEqual(['chats', 'following']);
  // No account keeps a list: no chips at all.
  expect(peopleFilters([acc('d', 'discord', ['connect']), acc('m', 'matrix', ['relationships'])])).toEqual([]);
});
