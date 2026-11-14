import { expect, test } from 'bun:test';
import { sendBlocker } from '../src/send.ts';
import { fileBatches, splitsFiles } from '../src/ontology.ts';

const acc = { network: 'matrix', label: 'mx', status: 'online', capabilities: ['send'] } as const;
const room = { network: 'matrix', encrypted: false, variant: 'text' } as const;

test('the rules, shared by composer and hub', () => {
  expect(sendBlocker(room, acc as any)).toBeNull();
  expect(sendBlocker(room, null)).toBe('No account can send here');
  expect(sendBlocker(room, { ...acc, status: 'connecting' } as any)).toBeNull();
  expect(sendBlocker(room, { ...acc, status: 'offline' } as any)).toBe('Matrix · mx is offline');
  expect(sendBlocker(room, { ...acc, status: 'attention' } as any)).toContain('waiting for you');
  expect(sendBlocker({ ...room, variant: 'forum' }, acc as any)).toBe('Open a post to reply');
});

test('an encrypted Matrix room takes an adapter that can encrypt; Signal always encrypts itself', () => {
  const secret = { ...room, encrypted: true };
  expect(sendBlocker(secret, acc as any)).toContain('Set up encryption');
  expect(sendBlocker(secret, { ...acc, capabilities: ['send', 'e2ee'] } as any)).toBeNull();
  expect(sendBlocker({ ...secret, network: 'signal' }, { ...acc, network: 'signal' } as any)).toBeNull();
});

test('more files than a message takes: runs of the network\'s count, in order; mail and words-only places do not split', () => {
  expect(fileBatches([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  expect(fileBatches([], 10)).toEqual([[]]);
  expect(fileBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(fileBatches([1, 2], 0)).toEqual([[1, 2]]);
  expect(splitsFiles('discord')).toBe(true);
  expect(splitsFiles('x')).toBe(true);
  expect(splitsFiles('email')).toBe(false);
  expect(splitsFiles('calendar')).toBe(false);
});
