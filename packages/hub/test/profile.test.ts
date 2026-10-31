import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import { Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let d: AccountRow;
let s: AccountRow;
const idn = (a: AccountRow, n: string) => hubId('idn', a.network, n);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-prof-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  s = store.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'al', displayName: 'Alice', contact: true } });
  store.ingest(s, { t: 'identity', identity: { nativeId: '+1', displayName: 'Alice C', contact: true } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'stranger', displayName: 'Stranger' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'ch', shape: 'channel', name: 'general' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'gm', shape: 'group', name: 'Gang', participants: ['al', 'me'] } });
  store.ingest(s, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['+1'] } });
  store.ingest(d, { t: 'message', message: { nativeId: 'a1', conversation: 'ch', author: 'al', ts: 100, body: 'one' } });
  store.ingest(s, { t: 'message', message: { nativeId: 'a2', conversation: 'dm', author: '+1', ts: 200, body: 'two' } });
  store.ingest(d, { t: 'message', message: { nativeId: 's1', conversation: 'ch', author: 'stranger', ts: 300, body: 'hi' } });
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const personOf = (id: string) => store.one<{ person_id: string | null }>('SELECT person_id FROM identity WHERE id = ?', id)!.person_id!;

test('someone seen only in a channel still has a profile, without becoming a contact', () => {
  const p = store.profile({ identityId: idn(d, 'stranger') })!;
  expect(p.personId).toBeNull();
  expect(p.totalMessages).toBe(1);
  expect(p.conversations.map((c) => c.messages)).toEqual([1]);
  expect(personOf(idn(d, 'stranger'))).toBeNull();
});

test('merged identities give one profile across networks', () => {
  const into = personOf(idn(d, 'al'));
  store.mergePersons(into, personOf(idn(s, '+1')));
  const p = store.profile({ personId: into })!;
  expect(p.identities.map((i) => i.network).sort()).toEqual(['discord', 'signal']);
  expect(p.recent.map((m) => m.nativeId)).toEqual(['a2', 'a1']);
  expect(p.totalMessages).toBe(2);
  expect(p.firstSeenTs).toBe(100);
  // Member of a group without having posted in it.
  expect(p.conversations.find((c) => c.id === hubId('cnv', 'discord', 'gm'))).toMatchObject({ messages: 0 });
  expect(p.conversations.length).toBe(3);
});

test('unmerging works from either side, including the identity the merged person grew from', () => {
  const into = personOf(idn(d, 'al'));
  expect(into).toBe('per_' + idn(d, 'al').slice(4));
  const newId = store.splitIdentity(idn(d, 'al'));
  expect(newId).not.toBe(into);
  expect(personOf(idn(d, 'al'))).toBe(newId!);
  expect(personOf(idn(s, '+1'))).toBe(into);
  // The last identity leaving empties and removes its person.
  store.mergePersons(newId!, into);
  const other = store.splitIdentity(idn(s, '+1'))!;
  expect(personOf(idn(s, '+1'))).toBe(other);
  expect(store.one('SELECT 1 FROM person WHERE id = ?', into)).toBeNull();
  // A person with one identity splitting returns to the same state.
  const again = store.splitIdentity(idn(s, '+1'))!;
  expect(personOf(idn(s, '+1'))).toBe(again);
  expect(store.one('SELECT 1 FROM person WHERE id = ?', again)).not.toBeNull();
});

test('a note is kept', () => {
  const pid = personOf(idn(d, 'al'));
  store.updatePerson(pid, { note: 'met at rustconf' });
  expect(store.profile({ personId: pid })!.note).toBe('met at rustconf');
});

test('nobody is null', () => {
  expect(store.profile({ personId: 'per_nope' })).toBeNull();
  expect(store.profile({ identityId: 'idn_nope' })).toBeNull();
});
