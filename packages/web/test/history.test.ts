/** What Settings → Message history says is kept (docs/history.md): the not-kept note and Forget follow keeping(). */
import { expect, test } from 'bun:test';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { ADVERSARIAL_KINDS, keeping } from '../src/keeping.ts';

const ADV = { ...DEFAULT_RETENTION, adversarial: true };

test('by default nothing adversarial is kept; edits, reactions, receipts and changes are', () => {
  expect(ADVERSARIAL_KINDS.filter((k) => keeping(DEFAULT_RETENTION, k))).toEqual([]);
  expect((['edits', 'reactions', 'receipts', 'changes'] as const).every((k) => keeping(DEFAULT_RETENTION, k))).toBe(true);
});

test('shown after the warning, each still off until its own switch', () => {
  expect(ADVERSARIAL_KINDS.filter((k) => keeping(ADV, k))).toEqual([]);
  expect(keeping({ ...ADV, deleted: true }, 'deleted')).toBe(true);
  expect(keeping({ ...ADV, disappearing: true }, 'disappeared')).toBe(true);
  expect(keeping({ ...ADV, members: true }, 'members')).toBe(true);
});

test('hidden, deleted and disappearing messages go on being kept as their switches say; nothing is logged', () => {
  const all = { ...DEFAULT_RETENTION, deleted: true, disappearing: true, statuses: true, presence: true, members: true };
  expect(ADVERSARIAL_KINDS.filter((k) => keeping(all, k))).toEqual(['deleted', 'disappeared']);
  expect(keeping({ ...DEFAULT_RETENTION, sources: { signal: { deleted: true } } }, 'deleted')).toBe(true);
});

test('one network keeping them counts; statuses and presence need changes kept too', () => {
  expect(keeping({ ...ADV, sources: { signal: { deleted: true } } }, 'deleted')).toBe(true);
  expect(keeping({ ...ADV, sources: { signal: { deleted: false } } }, 'deleted')).toBe(false);
  expect(keeping({ ...ADV, statuses: true }, 'statuses')).toBe(true);
  expect(keeping({ ...ADV, statuses: true, presence: true, changes: false }, 'statuses')).toBe(false);
  expect(keeping({ ...ADV, presence: true, changes: false }, 'presence')).toBe(false);
  expect(keeping({ ...DEFAULT_RETENTION, edits: false, sources: { matrix: { edits: true } } }, 'edits')).toBe(true);
});
