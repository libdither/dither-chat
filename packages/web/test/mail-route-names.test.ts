/**
 * A person's email route goes from a mail account, which is not among the chat accounts (mail/chats.ts). Your side of
 * it is named by that mail account, never "Unknown", and two mail accounts are told apart (chatroutes.ts YourSide;
 * Pairs.tsx fills it in).
 */
import { expect, test } from 'bun:test';
import { tagTells, tagText, tells, yourAccount, yourName, type RouteKey, type YourSide } from '../src/chatroutes.ts';

const home: YourSide = { chat: null, mail: { id: 'acc_home', label: 'Home mail', address: 'me@home.example' }, identity: null };
const work: YourSide = { chat: null, mail: { id: 'acc_work', label: 'Work mail', address: 'me@work.example' }, identity: null };
const key = (s: YourSide): RouteKey => ({ id: `email:${yourAccount(s)}:sam@x.example`, network: 'email', theirs: 'idn_sam', mine: yourAccount(s) });

test("a mail account's route is named by its label, else its address", () => {
  expect(yourName(home)).toBe('Home mail');
  expect(yourName({ ...home, mail: { ...home.mail!, label: '' } })).toBe('me@home.example');
});

test("a chat account's label comes first; with no account, your identity, else you", () => {
  expect(yourName({ chat: { id: 'acc_d', label: 'main' }, mail: null, identity: 'ann' })).toBe('main');
  expect(yourName({ chat: null, mail: null, identity: 'ann' })).toBe('ann');
  expect(yourName({ chat: null, mail: null, identity: null })).toBe('you');
});

test('two mail accounts to the same address are told apart by yours', () => {
  const keys = [key(home), key(work)];
  expect(keys.map((k) => k.mine)).toEqual(['acc_home', 'acc_work']);
  expect(tells(keys[1]!, keys)).toEqual({ network: false, theirs: false, mine: true });
  expect(tagText(tagTells(keys[1]!, keys, 'theirs'), { network: 'Email', theirs: 'sam@x.example', mine: yourName(work) }, 'theirs')).toBe('via Work mail');
});
