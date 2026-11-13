import { expect, test } from 'bun:test';
import { renderMarkdown } from '../src/markdown.ts';

const md = (s: string) => renderMarkdown(s, { network: 'discord', user: () => null, room: () => null });

test('lines of text are joined with <br>', () => {
  expect(md('a\nb')).toBe('a<br>b');
});

test('consecutive "- " or "* " lines are a list, as in Discord', () => {
  expect(md('- one\n* two')).toBe('<ul><li>one</li><li>two</li></ul>');
  expect(md('intro\n- one\n- two\nafter')).toBe('intro<ul><li>one</li><li>two</li></ul>after');
});

test('a quote and a list stay apart, and a blank line between blocks shows', () => {
  expect(md('> a\n> b\n\n- x')).toBe('<blockquote>a<br>b</blockquote><br><ul><li>x</li></ul>');
  expect(md('> a\n- x')).toBe('<blockquote>a</blockquote><ul><li>x</li></ul>');
});

test('emphasis is not mistaken for a list, and a list item can be emphasised', () => {
  expect(md('*soft*')).toBe('<em>soft</em>');
  expect(md('- **bold** item')).toBe('<ul><li><strong>bold</strong> item</li></ul>');
});

test('numbered lists keep their first number, and two spaces nest a list in the item before', () => {
  expect(md('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  expect(md('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  expect(md('- a\n  - a1\n  - a2\n- b')).toBe('<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
  expect(md('1. a\n  - x\n2. b')).toBe('<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>');
  expect(md('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  expect(md('intro\n1. one\nafter')).toBe('intro<ol><li>one</li></ol>after');
  // A year at the start of a sentence is not a list without its dot and space.
  expect(md('2026 was long')).toBe('2026 was long');
});

test('masked links link their text, http(s) only', () => {
  expect(md('[docs](https://example.org/a)')).toBe('<a href="https://example.org/a" target="_blank" rel="noreferrer noopener">docs</a>');
  expect(md('[x](javascript:alert(1))')).not.toContain('<a');
});

test("role mentions say the role's name and colour from the message; without one, @role", () => {
  const ctx = { network: 'discord' as const, user: () => null, room: () => null, role: (id: string) => (id === '42' ? { name: 'Helpers', color: '#5c7cfa' } : null) };
  expect(renderMarkdown('hi <@&42>', ctx)).toBe('hi <span class="mention role" style="color:#5c7cfa">@Helpers</span>');
  expect(renderMarkdown('<@&7>', ctx)).toBe('<span class="mention role">@role</span>');
  expect(renderMarkdown('<@&42>', { ...ctx, role: () => ({ name: '<b>', color: 'red;x' }) })).toBe('<span class="mention role">@&lt;b&gt;</span>');
});

test("a server's own pages read as Discord names them", () => {
  expect(md('see <id:guide> and <id:customize>')).toBe('see <span class="mention room">#Server Guide</span> and <span class="mention room">#Channels &amp; Roles</span>');
  expect(md('<id:nothing>')).toBe('&lt;id:nothing&gt;');
});

test('timestamps are written out in the style asked for, relative ones against now', () => {
  const now = Date.UTC(2026, 10, 12, 12);
  const ctx = { network: 'discord' as const, user: () => null, room: () => null, now };
  const sec = now / 1000;
  expect(renderMarkdown(`<t:${sec + 7200}:R>`, ctx)).toContain('>in 2 hours</time>');
  expect(renderMarkdown(`<t:${sec - 3 * 86400}:R>`, ctx)).toContain('>3 days ago</time>');
  expect(renderMarkdown(`<t:${sec}>`, ctx)).toMatch(/^<time class="md-time" title="[^"]+">[^<]*2026[^<]*<\/time>$/);
  expect(renderMarkdown(`<t:${sec}:D>`, ctx)).toContain('2026');
  expect(renderMarkdown('<t:abc:R>', ctx)).toBe('&lt;t:abc:R&gt;');
});
