/**
 * A conversation reads the same whether the hub sends it alone (an event's conversationView) or among many
 * (bootstrap, and conversationViews). The app compares the two to tell a change of names from one of counts
 * (syncmodel.ts conversationMetaChanged): members in another order read as new names, and every message and row on
 * the screen drew again when a chat was read.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { hubId } from '@dither-chat/protocol/ids';
import { Store, type AccountRow } from '../src/store.ts';

let store: Store;
let acc: AccountRow;
beforeAll(() => {
  store = new Store(':memory:', (raw) => raw ?? null);
  acc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me', isSelf: true } });
  // Members arrive in an order of their own, not their ids'.
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Group', participants: ['zed', 'me', 'ann', 'kim', 'bo'] } });
  for (let i = 0; i < 60; i++) store.ingest(acc, { t: 'conversation', conversation: { nativeId: `c${i}`, shape: 'group', name: `C${i}`, participants: ['zed', `p${i}`, 'me', 'ann'] } });
});
afterAll(() => store.db.close());

test('one conversation, many and bootstrap list its members in the same order', () => {
  const ids = ['g', ...Array.from({ length: 60 }, (_, i) => `c${i}`)].map((n) => hubId('cnv', 'discord', n));
  const many = store.conversationViews(ids);
  const boot = store.bootstrap().conversations;
  expect(many.length).toBe(ids.length);
  for (const id of ids) {
    const alone = store.conversationView(id)!;
    expect(alone.participantIds.length).toBeGreaterThan(2);
    expect(many.find((c) => c.id === id)!.participantIds).toEqual(alone.participantIds);
    expect(boot.find((c) => c.id === id)!.participantIds).toEqual(alone.participantIds);
  }
});
