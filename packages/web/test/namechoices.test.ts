/**
 * The hero's name menu and picture choice on a person's profile (namechoices.ts; docs/profile.md "Which account speaks for
 * them"): which names and pictures they offer, and which is ticked.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { nameChoices, pictureChoices } from '../src/namechoices.ts';

const ident = (id: string, network: P.Network, displayName: string | null, more: Partial<P.IdentityView> = {}) =>
  ({ id, network, nativeId: id, handle: id, displayName, avatar: null, isBot: false, personId: 'pk', ...more }) as unknown as P.IdentityView;
const person = (more: Partial<P.PersonView> = {}) =>
  ({ id: 'pk', name: 'Kit', avatar: null, starred: false, isSelf: false, identityIds: ['kd', 'kw', 'ks'], nameSource: 'merge', ...more }) as P.PersonView;

const kd = ident('kd', 'discord', 'Kit', { handle: 'kit.exe', avatar: '/m/kd.png' });
const kw = ident('kw', 'discord', 'Kit (work)', { handle: 'kit.work', avatar: '/m/kw.png', nickname: 'Work Kit' });
const ks = ident('ks', 'signal', 'Kit', { handle: null, avatar: '/m/kd.png' });

/** The menu as it reads: the main account's name, then each account's heading and names. */
const rows = (r: ReturnType<typeof nameChoices>) => [[r.auto.text, r.auto.detail, r.auto.on], ...r.accounts.flatMap((a) => [a.heading, ...a.names.map((c) => [c.text, c.detail, c.on])])];
const flat = (r: ReturnType<typeof nameChoices>) => [r.auto, ...r.accounts.flatMap((a) => a.names)];

test('names: the main account’s first, then each account’s under its heading: nickname, display name, handle', () => {
  const r = nameChoices([kd, kw, ks], person({ faceId: 'kd' }), 'Kit');
  expect(rows(r)).toEqual([
    ['Kit', 'Follows their main account', true],
    'Discord · kit.exe · main account',
    ['kit.exe', 'Handle', false],
    'Discord · kit.work',
    ['Work Kit', 'Your nickname', false],
    ['Kit (work)', 'Display name', false],
    ['kit.work', 'Handle', false],
    // Another account's name the same as the main one's is still its own to choose.
    'Signal',
    ['Kit', 'Display name', false],
  ]);
  expect(r.auto.from).toBeNull();
  expect(r.accounts[1].names[0].from).toEqual({ identityId: 'kw', field: 'nickname' });
});

test('names: a chosen one is ticked, even when its text is the main account’s', () => {
  const r = nameChoices([kd, kw, ks], person({ faceId: 'kd', nameFrom: { identityId: 'kd', field: 'display' } }), 'Kit');
  expect(r.accounts[0].names.filter((c) => c.on).map((c) => [c.text, c.detail])).toEqual([['Kit', 'Display name']]);
  expect(flat(r).filter((c) => c.on)).toHaveLength(1);
  expect(r.auto).toMatchObject({ from: null, on: false });
});

test('names: one account offers its own names, its nickname first', () => {
  const one = ident('k1', 'telegram', 'Kit T', { handle: 'kitt', nickname: 'Kitty' });
  const r = nameChoices([one], person({ identityIds: ['k1'], name: 'Kitty' }), 'Kitty');
  expect(flat(r).map((c) => c.text)).toEqual(['Kitty', 'Kit T', 'kitt']);
  expect(r.auto.detail).toBe('Follows your nickname, else their name');
  expect(r.accounts[0].heading).toBe('Telegram');
});

test('names: a phone number for a handle is no name', () => {
  const sig = ident('s1', 'signal', 'Kit S', { handle: '+1 555 0144' });
  expect(flat(nameChoices([sig], person({ identityIds: ['s1'], name: 'Kit S' }), 'Kit S')).map((c) => c.text)).toEqual(['Kit S']);
});

test('pictures: one per picture, the main account’s first, the one showing ticked', () => {
  let cs = pictureChoices([kd, kw, ks], person({ faceId: 'kw', avatar: '/m/kw.png' }), kw);
  expect(cs.map((c) => [c.id, c.detail, c.on])).toEqual([
    ['kw', 'Discord · kit.work · main account', true],
    ['kd', 'Discord · kit.exe', false],
  ]);
  cs = pictureChoices([kd, kw, ks], person({ faceId: 'kw', avatar: '/m/kd.png', pictureIdentityId: 'kd' }), kw);
  expect(cs.find((c) => c.on)?.id).toBe('kd');
});

test('names: the main account’s come first, whichever account it is', () => {
  const r = nameChoices([kd, kw, ks], person({ faceId: 'kw' }), 'Work Kit');
  expect(flat(r).map((c) => c.text)).toEqual(['Work Kit', 'Kit (work)', 'kit.work', 'Kit', 'kit.exe', 'Kit']);
  expect(r.accounts.map((a) => a.heading)).toEqual(['Discord · kit.work · main account', 'Discord · kit.exe', 'Signal']);
});

test('names: a chosen name the account no longer has ticks the main account’s, which shows meanwhile', () => {
  const r = nameChoices([kd, kw, ks], person({ faceId: 'kd', nameFrom: { identityId: 'kd', field: 'nickname' } }), 'Kit');
  expect(flat(r).filter((c) => c.on)).toEqual([r.auto]);
  expect(r.auto.from).toBeNull();
});
