/**
 * One face for a person (model.ts faceOf, convTitle; docs/chats.md "Names"): an account of a person's is drawn with the
 * person's picture and colour, the network it came from known; an unnamed group is titled by its people's names.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { db, selfIds, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { convTitle, faceOf } = await import('../src/model.ts');

const ident = (id: string, network: P.Network, displayName: string, more: Partial<P.IdentityView> = {}) =>
  ({ id, network, nativeId: id, handle: id, displayName, avatar: null, isBot: false, personId: null, ...more }) as unknown as P.IdentityView;
const person = (id: string, name: string, identityIds: string[], more: Partial<P.PersonView> = {}) =>
  ({ id, name, avatar: null, starred: false, isSelf: false, identityIds, nameSource: 'merge', ...more }) as P.PersonView;

db.identities.set('kd', ident('kd', 'discord', 'kit.exe', { personId: 'pk', avatar: '/m/kd.png' }));
db.identities.set('kt', ident('kt', 'telegram', 'Kit', { personId: 'pk', avatar: '/m/kt.png' }));
db.identities.set('sol', ident('sol', 'discord', 'solo.one', { personId: 'ps' }));
db.identities.set('stray', ident('stray', 'discord', 'stray', { avatar: '/m/stray.png' }));
db.identities.set('me', ident('me', 'discord', 'me', { avatar: '/m/me.png', personId: 'pme' }));
db.persons.set('pk', person('pk', 'Kit', ['kd', 'kt'], { avatar: '/m/kt.png', faceId: 'kt' }));
db.persons.set('ps', person('ps', 'Sol', ['sol']));
db.persons.set('pme', person('pme', 'Me', ['me'], { isSelf: true, avatar: '/m/other.png' }));
selfIds.add('me');

test('every account of a person is drawn with their face, which says the network it came from', () => {
  expect(faceOf('kd')).toEqual({ id: 'pk', url: '/m/kt.png', network: 'telegram' });
  expect(faceOf('kt')).toEqual({ id: 'pk', url: '/m/kt.png', network: 'telegram' });
});

test('no picture anywhere: initials in the person’s colour; no person: the account as it is; you: your account', () => {
  expect(faceOf('sol')).toEqual({ id: 'ps', url: null, network: null });
  expect(faceOf('stray')).toEqual({ id: 'stray', url: '/m/stray.png', network: 'discord' });
  expect(faceOf('me')).toEqual({ id: 'me', url: '/m/me.png', network: 'discord' });
  expect(faceOf(null)).toEqual({ id: '', url: null, network: null });
});

test('a group with no name is titled by its people’s names, as their messages name them', () => {
  const c = { id: 'g', network: 'discord', shape: 'group', name: null, participantIds: ['me', 'kd', 'sol', 'stray'] } as unknown as P.ConversationView;
  expect(convTitle(c)).toBe('Kit, Sol, stray');
});
