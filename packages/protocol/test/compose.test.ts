/** Writing a post (compose.ts, docs/feed.md "Answering"): X's count and counter, Reddit's, from one set of rules. */
import { describe, expect, test } from 'bun:test';
import { composeState, POST_RULES, postLength, postRulesFor, REDDIT_RULES, splitThread } from '../src/compose.ts';

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

test("what X does not link counts as written: emails, @handles, a bare country ending without a path", () => {
  expect(postLength('user@example.com', X)).toBe(16);
  expect(postLength('@foo.com', X)).toBe(8);
  expect(postLength('Read.me now', X)).toBe(11);
  expect(postLength('e.g. file.txt', X)).toBe(13);
  // .co and .tv bare are links; any country ending with a path is.
  expect(postLength('t.co', X)).toBe(23);
  expect(postLength('youtu.be/abc', X)).toBe(23);
  expect(postLength('see redd.it/x and amzn.to/x', X)).toBe(4 + 23 + 5 + 23);
});

test('a bracket the link opened stays in it; © and ® alone are one each; only invisible characters are nothing to send', () => {
  expect(postLength('http://x.com/a_(b)', X)).toBe(23);
  expect(postLength('(see http://x.com/a)', X)).toBe(1 + 4 + 23 + 1);
  expect(postLength('© ®', X)).toBe(3);
  expect(postLength('©️', X)).toBe(2);
  expect(composeState('​', X).sendable).toBe(false);
  expect(composeState('​ hi', X).sendable).toBe(true);
});

describe('splitThread', () => {
  const x = postRulesFor('x')!;
  const sentence = 'Routing on a sheaf keeps each hop local, and the global picture falls out of the gluing.';
  test('text that fits is one part, trimmed; nothing is no parts', () => {
    expect(splitThread('  hello  ', x)).toEqual(['hello']);
    expect(splitThread('   ', x)).toEqual([]);
  });
  test('paragraphs stay whole, each in its own post when two do not fit together', () => {
    const paras = [1, 2, 3].map((n) => `Paragraph ${n}. ${sentence} ${sentence}`);
    const parts = splitThread(paras.join('\n\n'), x);
    expect(parts).toEqual(paras);
  });
  test('short paragraphs share a post', () => {
    const parts = splitThread(['One.', 'Two.', 'x'.repeat(279)].join('\n\n'), x);
    expect(parts).toEqual(['One.\n\nTwo.', 'x'.repeat(279)]);
  });
  test('a paragraph too long for one post is cut between sentences, every part fitting', () => {
    const para = Array.from({ length: 8 }, () => sentence).join(' ');
    const parts = splitThread(para, x);
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(composeState(p, x).remaining).toBeGreaterThanOrEqual(0);
      expect(p.endsWith('gluing.')).toBe(true);
    }
    expect(parts.join(' ')).toBe(para);
  });
  test('a word longer than a post is cut where it must', () => {
    const parts = splitThread('a'.repeat(700), x);
    expect(parts.join('')).toBe('a'.repeat(700));
    for (const p of parts) expect(composeState(p, x).remaining).toBeGreaterThanOrEqual(0);
  });
});
