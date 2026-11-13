/** Writing a post (compose.ts, docs/feed.md "Answering"): X's count and counter, Reddit's, from one set of rules. */
import { expect, test } from 'bun:test';
import { composeState, POST_RULES, postLength, REDDIT_RULES } from '../src/compose.ts';

const X = POST_RULES.x;

test('X counts Latin one each, CJK two, each emoji two, every link 23', () => {
  expect(postLength('hello', X)).toBe(5);
  expect(postLength('日本語', X)).toBe(6);
  expect(postLength('ok 👍', X)).toBe(5);
  // A family emoji (a ZWJ sequence) and a flag are one emoji each.
  expect(postLength('👨‍👩‍👧', X)).toBe(2);
  expect(postLength('🇯🇵', X)).toBe(2);
  expect(postLength('see https://example.com/a/very/long/path/that/goes/on', X)).toBe(4 + 23);
  expect(postLength('see dither.link/talk.', X)).toBe(4 + 23 + 1);
  // Curly quotes and dashes are in the light ranges.
  expect(postLength('“a”—b', X)).toBe(5);
});

test("X's counter: a ring until 20 left, then the number; past 280 negative, red, and the ring goes past -10", () => {
  const at = (n: number) => composeState('a'.repeat(n), X);
  expect(at(100)).toMatchObject({ remaining: 180, level: 'ok', showCount: false, showRing: true, sendable: true });
  expect(at(260)).toMatchObject({ remaining: 20, level: 'warn', showCount: true, showRing: true });
  expect(at(280)).toMatchObject({ remaining: 0, level: 'warn', sendable: true });
  expect(at(285)).toMatchObject({ remaining: -5, level: 'over', showRing: true, sendable: false, overFrom: 280 });
  expect(at(291)).toMatchObject({ remaining: -11, showRing: false });
  expect(composeState('   ', X).sendable).toBe(false);
});

test('where it goes over counts in weights: a CJK text goes over at 140 characters', () => {
  const s = composeState('語'.repeat(150), X);
  expect(s.overFrom).toBe(140);
  expect(s.remaining).toBe(-20);
});

test("Reddit's rules: 10,000 characters as read, a line from 1,000 left, Markdown", () => {
  expect(postLength('👨‍👩‍👧 日本', REDDIT_RULES)).toBe(4);
  expect(composeState('a'.repeat(8_999), REDDIT_RULES)).toMatchObject({ level: 'ok', showCount: false });
  expect(composeState('a'.repeat(9_500), REDDIT_RULES)).toMatchObject({ remaining: 500, level: 'warn', showCount: true, showRing: false });
  expect(REDDIT_RULES.markdown).toBe(true);
  expect(REDDIT_RULES.likersVisible).toBe('none');
});
