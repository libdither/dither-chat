import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { countText, countTitle } from '../src/msgcount.ts';

const base: P.MessageCountEstimate = { spaceId: 'spc_x', observed: 123, captured: 3812, shareLow: 0.027, shareHigh: 0.038, method: 'share', asOf: 0, networks: ['discord'] };

describe('countText', () => {
  test('no total: only what was seen', () => expect(countText(base)).toBe('≥123 seen (total unknown)'));
  test('an estimate: rounded, with its range, never below what was seen', () => {
    expect(countText({ ...base, method: 'snowflake-lifetime', estimate: 1437, low: 124, high: 2061 })).toBe('≥123 seen; ~1,400 estimated, 123–2,100');
    expect(countText({ ...base, method: 'snowflake-lifetime', estimate: 1437, low: 912, high: 2061 })).toBe('≥123 seen; ~1,400 estimated, 910–2,100');
  });
  test('some in channels with no estimate: the top is not a ceiling', () => {
    expect(countText({ ...base, method: 'snowflake-lifetime', estimate: 1437, low: 912, high: 2061, unestimated: 40 })).toBe('≥123 seen; ~1,400 estimated, 910–2,100+');
    expect(countText({ ...base, method: 'snowflake-lifetime', estimate: 123, low: 123, high: 123, unestimated: 4 })).toBe('≥123 seen; ~123 estimated or more');
  });
  test('complete: the count itself', () => {
    expect(countText({ ...base, method: 'complete', estimate: 123, low: 123, high: 123 })).toBe('123 messages (all held)');
    expect(countText({ ...base, observed: 1, method: 'complete', estimate: 1, low: 1, high: 1 })).toBe('1 message (all held)');
  });
  test('the tooltip says the share, the reason, and that nothing was asked', () => {
    const t = countTitle({ ...base, reason: 'Because.', asOf: 5 }, () => 'then');
    expect(t).toContain('123 of the 3,812');
    expect(t).toContain('3%–4%');
    expect(t).toContain('Because.');
    expect(t).toContain('as of then');
  });
});
