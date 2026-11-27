/**
 * The hero's name picker and picture choice on a person's profile (namechoices.ts; docs/profile.md "Which account speaks for
 * them"): which names and pictures they offer, and which is ticked.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { alsoNames, nameEntries, nameRows, pictureChoices, whereFrom } from '../src/namechoices.ts';

const ident = (id: string, network: P.Network, displayName: string | null, more: Partial<P.IdentityView> = {}) =>
  ({ id, network, nativeId: id, handle: id, displayName, avatar: null, isBot: false, personId: 'pk', ...more }) as unknown as P.IdentityView;
const person = (more: Partial<P.PersonView> = {}) =>
  ({ id: 'pk', name: 'Kit', avatar: null, starred: false, isSelf: false, identityIds: ['kd', 'kw', 'ks'], nameSource: 'merge', ...more }) as P.PersonView;

const kd = ident('kd', 'discord', 'Kit', { handle: 'kit.exe', avatar: '/m/kd.png' });
const kw = ident('kw', 'discord', 'Kit (work)', { handle: 'kit.work', avatar: '/m/kw.png', nickname: 'Work Kit' });
const ks = ident('ks', 'signal', 'Kit', { handle: null, avatar: '/m/kd.png' });

/** The picker as it reads: text, what it is, the accounts' networks, ticked. */
const read = (rs: ReturnType<typeof nameRows>) => rs.map((r) => [r.text, r.detail, r.refs.map((x) => x.i.network).join(' '), r.on]);

test('names: each text once with every account that has it, names before handles, the main account’s first', () => {
  const es = nameEntries([kd, kw, ks], 'kd');
  expect(es.map((e) => [e.text, e.refs.map((r) => `${r.i.id}:${r.field}`)])).toEqual([
    ['Kit', ['kd:display', 'ks:display']],
    ['Work Kit', ['kw:nickname']],
    ['Kit (work)', ['kw:display']],
    ['kit.exe', ['kd:handle']],
    ['kit.work', ['kw:handle']],
  ]);
});

test('names: the line under the name leaves out the one shown and handles', () => {
  const es = nameEntries([kd, kw, ks], 'kd');
  expect(alsoNames(es, 'Kit').map((e) => e.text)).toEqual(['Work Kit', 'Kit (work)']);
  expect(alsoNames(es, 'Work Kit').map((e) => e.text)).toEqual(['Kit', 'Kit (work)']);
});

test('names: the picker has the main account’s name once, with the accounts that share it', () => {
  const es = nameEntries([kd, kw, ks], 'kd');
  const rs = nameRows(es, person({ faceId: 'kd' }), 'Kit', true);
  expect(read(rs)).toEqual([
    ['Kit', "Main account's", 'discord signal', true],
    ['Work Kit', 'Account nickname', 'discord', false],
    ['Kit (work)', '', 'discord', false],
    ['kit.exe', 'Handle', 'discord', false],
    ['kit.work', 'Handle', 'discord', false],
  ]);
  expect(rs[0].from).toBeNull();
  expect(rs[1].from).toEqual({ identityId: 'kw', field: 'nickname' });
});

test('names: a chosen one is ticked; one with the main account’s text ticks the first row', () => {
  const es = nameEntries([kd, kw, ks], 'kd');
  let rs = nameRows(es, person({ faceId: 'kd', name: 'Kit (work)', nameFrom: { identityId: 'kw', field: 'display' } }), 'Kit', true);
  expect(rs.filter((r) => r.on).map((r) => r.text)).toEqual(['Kit (work)']);
  rs = nameRows(es, person({ faceId: 'kd', nameFrom: { identityId: 'ks', field: 'display' } }), 'Kit', true);
  expect(rs.filter((r) => r.on).map((r) => r.text)).toEqual(['Kit']);
});

test('names: one account offers its own names, its nickname first', () => {
  const one = ident('k1', 'telegram', 'Kit T', { handle: 'kitt', nickname: 'Kitty' });
  const rs = nameRows(nameEntries([one], 'k1'), person({ identityIds: ['k1'], name: 'Kitty' }), 'Kitty', false);
  expect(read(rs)).toEqual([
    ['Kitty', '', 'telegram', true],
    ['Kit T', '', 'telegram', false],
    ['kitt', 'Handle', 'telegram', false],
  ]);
});

test('names: a phone number for a handle is no name', () => {
  const sig = ident('s1', 'signal', 'Kit S', { handle: '+1 555 0144' });
  expect(nameEntries([sig], 's1').map((e) => e.text)).toEqual(['Kit S']);
  expect(whereFrom(nameEntries([sig, kd], 's1')[0])).toBe('Signal');
});

test('names: the mark’s tooltip names each account by network and handle', () => {
  expect(whereFrom(nameEntries([kd, kw, ks], 'kd')[0])).toBe('Discord kit.exe, Signal');
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
  const rs = nameRows(nameEntries([kd, kw, ks], 'kw'), person({ faceId: 'kw', name: 'Work Kit' }), 'Work Kit', true);
  expect(rs.map((r) => r.text)).toEqual(['Work Kit', 'Kit (work)', 'Kit', 'kit.work', 'kit.exe']);
});

test('names: a chosen name the account no longer has ticks the main account’s, which shows meanwhile', () => {
  const rs = nameRows(nameEntries([kd, kw, ks], 'kd'), person({ faceId: 'kd', nameFrom: { identityId: 'kd', field: 'nickname' } }), 'Kit', true);
  expect(rs.filter((r) => r.on)).toEqual([rs[0]]);
});

test('names: your nickname for the person comes first and ticked; the main account’s row puts theirs back', () => {
  const rs = nameRows(nameEntries([kd, kw, ks], 'kd'), person({ faceId: 'kd', name: 'Kit the Tester', nickname: 'Kit the Tester', nameFrom: { identityId: 'kw', field: 'display' } }), 'Kit', true);
  expect(read(rs).slice(0, 2)).toEqual([
    ['Kit the Tester', 'Your nickname', '', true],
    ['Kit', "Main account's", 'discord signal', false],
  ]);
  expect(rs.filter((r) => r.on).length).toBe(1);
  expect(rs[0].nick).toBe(true);
  expect(rs[1].from).toBeNull();
  // And the line under it shows every name of theirs, the main account's too.
  expect(alsoNames(nameEntries([kd, kw, ks], 'kd'), 'Kit the Tester').map((e) => e.text)).toEqual(['Kit', 'Work Kit', 'Kit (work)']);
});

test('names: ones that differ only in case are two names', () => {
  const lower = ident('kl', 'telegram', 'kit', { handle: 'kitl' });
  const es = nameEntries([kd, lower], 'kd');
  expect(es.filter((e) => e.text.toLowerCase() === 'kit').map((e) => [e.text, e.refs.length])).toEqual([
    ['Kit', 1],
    ['kit', 1],
  ]);
  expect(alsoNames(es, 'Kit').map((e) => e.text)).toEqual(['kit']);
});
