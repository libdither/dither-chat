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

test('names: the main account’s first, then each account’s nickname, display name and handle, each text once', () => {
  const cs = nameChoices([kd, kw, ks], person({ faceId: 'kd' }), 'Kit');
  expect(cs.map((c) => [c.text, c.detail, c.on])).toEqual([
    ['Kit', 'Main account’s name, as it changes', true],
    ['kit.exe', 'Handle · Discord', false],
    ['Work Kit', 'Your nickname · Discord (kit.work)', false],
    ['Kit (work)', 'Display name · Discord (kit.work)', false],
    ['kit.work', 'Handle · Discord', false],
  ]);
  expect(cs[0].from).toBeNull();
  expect(cs[2].from).toEqual({ identityId: 'kw', field: 'nickname' });
});

test('names: a chosen one is ticked, even when its text is the main account’s', () => {
  const cs = nameChoices([kd, kw, ks], person({ faceId: 'kd', nameFrom: { identityId: 'kd', field: 'display' } }), 'Kit');
  expect(cs.filter((c) => c.on).map((c) => [c.text, c.detail])).toEqual([['Kit', 'Display name · Discord (kit.exe)']]);
  expect(cs[0]).toMatchObject({ from: null, on: false });
});

test('names: one account offers its own names, its nickname first', () => {
  const one = ident('k1', 'telegram', 'Kit T', { handle: 'kitt', nickname: 'Kitty' });
  const cs = nameChoices([one], person({ identityIds: ['k1'], name: 'Kitty' }), 'Kitty');
  expect(cs.map((c) => c.text)).toEqual(['Kitty', 'Kit T', 'kitt']);
  expect(cs[0].detail).toBe('Its name as you see it, as it changes');
});

test('names: a phone number for a handle is no name', () => {
  const sig = ident('s1', 'signal', 'Kit S', { handle: '+1 555 0144' });
  expect(nameChoices([sig], person({ identityIds: ['s1'], name: 'Kit S' }), 'Kit S').map((c) => c.text)).toEqual(['Kit S']);
});

test('pictures: one per picture, the main account’s first, the one showing ticked', () => {
  let cs = pictureChoices([kd, kw, ks], person({ faceId: 'kw', avatar: '/m/kw.png' }), kw);
  expect(cs.map((c) => [c.id, c.detail, c.on])).toEqual([
    ['kw', 'Discord · main account', true],
    ['kd', 'Discord', false],
  ]);
  cs = pictureChoices([kd, kw, ks], person({ faceId: 'kw', avatar: '/m/kd.png', pictureIdentityId: 'kd' }), kw);
  expect(cs.find((c) => c.on)?.id).toBe('kd');
});
