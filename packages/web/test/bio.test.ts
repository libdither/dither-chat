import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { bioEditor, bioLeft } from '../src/bio.ts';

const acc = (id: string, network: P.Network, self: string, capabilities: P.Capability[]) => ({ id, network, selfIdentityId: self, capabilities }) as P.AccountView;

test('the editor shows only on your own identity, and only where the adapter says it can', () => {
  const all = [acc('d', 'discord', 'idn_d', ['profile', 'editProfile']), acc('m', 'matrix', 'idn_m', ['profile']), acc('s', 'signal', 'idn_s', ['profile'])];
  expect(bioEditor(all, 'idn_d')?.id).toBe('d');
  expect(bioEditor(all, 'idn_m')).toBeNull();
  expect(bioEditor(all, 'idn_s')).toBeNull();
  expect(bioEditor(all, 'idn_someone')).toBeNull();
});

test("each network's limit, an emoji counting once", () => {
  expect(bioLeft('discord', 'x'.repeat(180))).toEqual({ limit: 190, left: 10 });
  expect(bioLeft('signal', '🧗'.repeat(141))).toEqual({ limit: 140, left: -1 });
  expect(bioLeft('whatsapp', '')).toEqual({ limit: 139, left: 139 });
  expect(bioLeft('matrix', 'x')).toBeNull();
});
