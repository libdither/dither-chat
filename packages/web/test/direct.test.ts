import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { directNote, openers } from '../src/direct.ts';

const acc = (id: string, network: P.Network, status: P.AccountStatus, capabilities: P.Capability[]) => ({ id, network, status, capabilities }) as P.AccountView;

test('only connected accounts that advertise it can start a conversation, so nothing else gets a button', () => {
  const all = [acc('a', 'matrix', 'online', ['send', 'openDirect']), acc('b', 'matrix', 'online', ['send']), acc('c', 'matrix', 'offline', ['openDirect']), acc('d', 'signal', 'online', ['openDirect'])];
  expect(openers(all, 'matrix').map((a) => a.id)).toEqual(['a']);
  expect(openers(all, 'discord')).toEqual([]);
});

test('Signal says plainly that nothing happens until the first message', () => {
  expect(directNote('signal', 'Ann')).toContain('sees nothing until you send your first message');
  expect(directNote('matrix', 'Ann')).toContain('not end-to-end encrypted');
});
