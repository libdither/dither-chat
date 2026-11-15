/**
 * A space fact without a name (Discord's client sends some servers with theirs only under `properties`): it keeps the
 * name the hub has, and a new place still goes in, rather than the event failing on space.name's NOT NULL.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol/adapter';
import { hubId } from '@dither-chat/protocol/ids';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-space-name-'));
const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const nameless = (nativeId: string, extra: Partial<P.SpaceFact> = {}) => ({ nativeId, kind: 'community', ...extra }) as unknown as P.SpaceFact;
const nameOf = (nativeId: string) => store.one<{ name: string }>('SELECT name FROM space WHERE id = ?', hubId('spc', 'discord', nativeId))?.name;

test('a space told again without its name keeps the name, and takes what else changed', () => {
  const acc = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'space', space: { nativeId: '1', kind: 'community', name: 'Garden club' } });
  expect(() => store.ingest(acc, { t: 'space', space: nameless('1', { topic: 'Seeds and soil' }) })).not.toThrow();
  expect(nameOf('1')).toBe('Garden club');
  expect(store.one<{ topic: string }>('SELECT topic FROM space WHERE id = ?', hubId('spc', 'discord', '1'))!.topic).toBe('Seeds and soil');
  store.ingest(acc, { t: 'space', space: { nativeId: '1', kind: 'community', name: 'Garden society' } });
  expect(nameOf('1')).toBe('Garden society');
});

test('a new space without a name goes in, and its channels with it', () => {
  const acc = store.createAccount({ network: 'discord', label: 'e', color: '#000', adapter: 'discord' });
  expect(() => store.ingest(acc, { t: 'space', space: nameless('2') })).not.toThrow();
  expect(nameOf('2')).toBe('');
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: '3', shape: 'channel', name: 'general', spaces: [{ nativeId: '2' }] } });
  expect(store.one('SELECT 1 FROM space_edge WHERE parent_id = ?', hubId('spc', 'discord', '2'))).not.toBeNull();
  store.ingest(acc, { t: 'space', space: { nativeId: '2', kind: 'community', name: 'Book swap' } });
  expect(nameOf('2')).toBe('Book swap');
});
