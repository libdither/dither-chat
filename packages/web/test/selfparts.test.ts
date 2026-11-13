/** An account's own self on the profile and account pages (selfparts.ts, docs/account-self.md). */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { clearsAt, selfOffers } from '../src/selfparts.ts';

const acc = (id: string, network: P.Network, capabilities: P.Capability[], status: P.AccountStatus = 'online') => ({ id, network, status, capabilities }) as P.AccountView;
const who = (network: P.Network, nativeId: string) => ({ id: `idn_${nativeId}`, network, nativeId, handle: null }) as P.IdentityView;

test('Ignore only where a connected account of yours can, and not once you blocked them', () => {
  const ann = who('discord', 'ann');
  const sig = who('signal', 'ann-s');
  const accounts = [acc('a', 'discord', ['block', 'ignore']), acc('b', 'signal', ['send'])];
  expect(selfOffers([ann, sig], undefined, [], accounts)).toEqual([{ identity: ann, ignored: false }]);
  expect(selfOffers([ann], [{ accountId: 'a', identityId: ann.id }], [], accounts)[0].ignored).toBe(true);
  expect(selfOffers([ann], undefined, [{ accountId: 'a', identityId: ann.id, personId: null, relationship: 'blocked', since: null }], accounts)).toEqual([]);
  expect(selfOffers([ann], undefined, [], [acc('a', 'discord', ['block', 'ignore'], 'offline')])).toEqual([]);
});

test('a status clears when it was set to', () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  expect(clearsAt(0, now)).toBeUndefined();
  expect(clearsAt(2, now)).toBe(now + 3_600_000);
  expect(new Date(clearsAt(4, now)!).getHours()).toBe(23);
});
