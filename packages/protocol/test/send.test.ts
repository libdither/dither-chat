import { expect, test } from 'bun:test';
import { sendBlocker } from '../src/send.ts';
import { previewsRemovable } from '../src/sending.ts';
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

test('texts a Signal backup brought in are history: no account sends there', () => {
  const sig = { ...acc, network: 'signal' } as any;
  const dm = { network: 'signal', encrypted: true, variant: 'text', nativeId: 'dm:me:you' } as const;
  expect(sendBlocker(dm, sig)).toBeNull();
  expect(sendBlocker({ ...dm, encrypted: false, nativeId: 'sms:me:tel:+15550100' }, sig)).toBe('History only: Signal can’t send SMS');
  expect(sendBlocker({ ...dm, shape: 'group', encrypted: false, nativeId: 'mms:c0ffee' } as any, null)).toBe('History only: Signal can’t send SMS');
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

test('previews come off by an edit only while the network lets you edit', () => {
  const H = 3_600_000;
  const now = Date.UTC(2026, 10, 15);
  const dm = { shape: 'direct', variant: 'text' } as const;
  expect(previewsRemovable('discord', now - 400 * 24 * H, dm, now)).toBe(true);
  expect(previewsRemovable('signal', now - 23 * H, dm, now)).toBe(true);
  expect(previewsRemovable('signal', now - 25 * H, dm, now)).toBe(false);
  expect(previewsRemovable('signal', now - 25 * H, { shape: 'self' }, now)).toBe(true);
  expect(previewsRemovable('telegram', now - 47 * H, dm, now)).toBe(true);
  expect(previewsRemovable('telegram', now - 49 * H, dm, now)).toBe(false);
  expect(previewsRemovable('telegram', now - 49 * H, { shape: 'group', variant: 'announcement' }, now)).toBe(true);
  // A Signal announcement-only group is still a group: its 24 hours hold.
  expect(previewsRemovable('signal', now - 25 * H, { shape: 'group', variant: 'announcement' }, now)).toBe(false);
});
