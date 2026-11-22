/**
 * Which status dot an avatar shows (presence.ts, docs/profile.md "Status dots"): a person is as present as their most
 * present account, the tooltip names where, and unknown is no dot.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { applyPresence, dotOf, groupDot, identityDot, personDot, type PresenceDb } from '../src/presence.ts';

const ident = (id: string, network: P.Network, personId: string | null = null) => ({ id, network, personId });
function world(presence: [string, P.PresenceNowView['state'], number?][]): PresenceDb {
  return {
    presence: new Map(presence.map(([identityId, state, at = 1]) => [identityId, { identityId, state, at }])),
    identities: new Map(
      [ident('ann-dc', 'discord', 'ann'), ident('ann-zu', 'zulip', 'ann'), ident('ann-mx', 'matrix', 'ann'), ident('bo-dc', 'discord', 'bo'), ident('cy-tg', 'telegram')].map((i) => [i.id, i]),
    ),
    persons: new Map([
      ['ann', { id: 'ann', name: 'Ann', identityIds: ['ann-dc', 'ann-zu', 'ann-mx'] }],
      ['bo', { id: 'bo', name: 'Bo', identityIds: ['bo-dc'] }],
    ]),
  };
}

describe('the dot', () => {
  test('unknown everywhere: no dot', () => {
    const db = world([]);
    expect(personDot(db, 'ann')).toBeNull();
    expect(identityDot(db, 'cy-tg')).toBeNull();
    expect(identityDot(db, null)).toBeNull();
    expect(personDot(db, 'nobody')).toBeNull();
  });

  test('the most present account wins: online, then do not disturb, then idle, then offline', () => {
    expect(personDot(world([['ann-dc', 'offline'], ['ann-zu', 'idle']]), 'ann')).toEqual({ state: 'idle', networks: ['zulip'], title: 'Idle on Zulip' });
    expect(personDot(world([['ann-dc', 'dnd'], ['ann-zu', 'idle']]), 'ann')?.title).toBe('Do not disturb on Discord');
    expect(personDot(world([['ann-dc', 'dnd'], ['ann-zu', 'online']]), 'ann')?.title).toBe('Online on Zulip');
    expect(personDot(world([['ann-mx', 'offline']]), 'ann')?.title).toBe('Offline on Matrix');
  });

  test('the same state on several networks names them all, the latest heard first', () => {
    const d = personDot(
      world([
        ['ann-dc', 'online', 5],
        ['ann-zu', 'online', 9],
        ['ann-mx', 'online', 7],
      ]),
      'ann',
    );
    expect(d).toEqual({ state: 'online', networks: ['zulip', 'matrix', 'discord'], title: 'Online on Zulip, Matrix and Discord' });
  });

  test('one identity is merged with the rest of its person; one with no person is itself', () => {
    const db = world([
      ['ann-zu', 'online'],
      ['cy-tg', 'idle'],
    ]);
    expect(identityDot(db, 'ann-dc')?.title).toBe('Online on Zulip');
    expect(identityDot(db, 'cy-tg')?.title).toBe('Idle on Telegram');
    expect(dotOf(db, ['ann-dc'])).toBeNull();
  });

  test('a group shows who is around, once a person, and nothing when all are away', () => {
    const name = (id: string) => ({ 'ann-dc': 'Ann', 'ann-zu': 'Ann', 'bo-dc': 'Bo', 'cy-tg': 'Cy' })[id] ?? id;
    const members = ['ann-dc', 'ann-zu', 'bo-dc', 'cy-tg'];
    expect(groupDot(world([['bo-dc', 'offline']]), members, name)).toBeNull();
    const d = groupDot(
      world([
        ['ann-zu', 'idle'],
        ['bo-dc', 'online'],
        ['cy-tg', 'offline'],
      ]),
      members,
      name,
    );
    expect(d).toEqual({ state: 'online', networks: ['discord'], title: 'Around: Bo (online), Ann (idle)' });
  });
});

describe('applying frames', () => {
  test('items, removals and a whole list; the same again is no change', () => {
    const m = new Map<string, P.PresenceNowView>();
    expect(applyPresence(m, { items: [{ identityId: 'a', state: 'online', at: 1 }], removed: [] })).toBe(true);
    expect(applyPresence(m, { items: [{ identityId: 'a', state: 'online', at: 1 }], removed: [] })).toBe(false);
    expect(applyPresence(m, { items: [{ identityId: 'b', state: 'idle', at: 2 }], removed: ['a'] })).toBe(true);
    expect([...m.keys()]).toEqual(['b']);
    expect(applyPresence(m, { items: [{ identityId: 'c', state: 'dnd', at: 3 }], removed: [], replace: true })).toBe(true);
    expect([...m.keys()]).toEqual(['c']);
    expect(applyPresence(m, { items: [], removed: ['zz'] })).toBe(false);
  });
});
