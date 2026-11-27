/**
 * IdentityFact.sameAs (store.ts sameAccount): a network saying two of its ids are one account. Partiful files a chat's
 * people under the chat service's ids (`stream:<id>`) beside their user ids; the hub puts each pair with one person
 * the first time it hears it, keeps a split made after, and takes your own other id as you, across a restart.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import { mediaSigner } from '../src/server.ts';
import { type AccountRow, Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-same-account-'));
const file = join(dir, 'hub.sqlite');
let store: Store;
let acc: AccountRow;
const idn = (id: string) => hubId('idn', 'partiful', id);
const personOf = (id: string) => store.one<{ person_id: string | null }>('SELECT person_id FROM identity WHERE id = ?', idn(id))?.person_id ?? null;

beforeAll(() => {
  store = new Store(file, mediaSigner('s'));
  const a = store.createAccount({ network: 'partiful', label: 'Partiful', color: '#000', adapter: 'partiful' });
  store.ingest(a, { t: 'hello', network: 'partiful', version: '1', capabilities: [] as any });
  store.ingest(a, { t: 'status', status: 'online', self: { nativeId: 'meUser0001', isSelf: true, displayName: 'Quinn Doe' } });
  acc = store.account(a.id)!;
  // As the extractor filed a direct chat before it knew who its people were: both sides by their chat ids, unnamed.
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'stream:sAnn' } });
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'stream:sMe' } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'chat:dm1', shape: 'direct', participants: ['stream:sAnn', 'stream:sMe'] } });
  store.ingest(acc, { t: 'message', message: { nativeId: 's:m1', conversation: 'chat:dm1', author: 'stream:sAnn', ts: 1000, body: 'hi' } });
  store.ingest(acc, { t: 'message', message: { nativeId: 's:m2', conversation: 'chat:dm1', author: 'stream:sMe', ts: 2000, body: 'hello' } });
  // Then by user id, as it does now.
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'annUser0001', displayName: 'Ann Lee' } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'chat:dm1', shape: 'direct', participants: ['annUser0001', 'meUser0001'] } });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a chat id said to be the same account as a user id goes with that person, named by them', () => {
  const before = personOf('stream:sAnn');
  expect(before).toBeTruthy();
  expect(personOf('annUser0001')).toBeTruthy();
  expect(personOf('annUser0001')).not.toBe(before);
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'stream:sAnn', displayName: 'Ann Lee', sameAs: 'annUser0001' } });
  expect(personOf('stream:sAnn')).toBe(personOf('annUser0001'));
  // The stranger person the chat id had is gone.
  expect(store.one('SELECT 1 FROM person WHERE id = ?', before)).toBeNull();
  expect(store.one<{ name: string }>('SELECT name FROM person WHERE id = ?', personOf('annUser0001'))?.name).toBe('Ann Lee');
});

test('said again after you split them, they stay split', () => {
  store.splitIdentity(idn('stream:sAnn'));
  const split = personOf('stream:sAnn');
  expect(split).not.toBe(personOf('annUser0001'));
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'stream:sAnn', displayName: 'Ann Lee', sameAs: 'annUser0001' } });
  expect(personOf('stream:sAnn')).toBe(split);
});

test('an id of a person not heard of yet is kept as a stub and joined', () => {
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'stream:sBen', displayName: 'Ben Ortiz', sameAs: 'benUser0001' } });
  expect(personOf('benUser0001')).toBeTruthy();
  expect(personOf('stream:sBen')).toBe(personOf('benUser0001'));
});

test('your own chat id is you: your person, your messages, and still after a restart', () => {
  expect(store.isSelf(idn('stream:sMe'))).toBe(false);
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'stream:sMe', displayName: 'Quinn Doe', sameAs: 'meUser0001' } });
  expect(store.isSelf(idn('stream:sMe'))).toBe(true);
  expect(personOf('stream:sMe')).toBe(personOf('meUser0001'));
  // The account's own identity is still the user id.
  expect(store.account(acc.id)!.self_identity).toBe(idn('meUser0001'));
  store.db.close();
  store = new Store(file, mediaSigner('s'));
  expect(store.isSelf(idn('stream:sMe'))).toBe(true);
  expect(store.isSelf(idn('stream:sAnn'))).toBe(false);
});
