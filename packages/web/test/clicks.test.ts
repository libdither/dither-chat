/**
 * Button counts (docs/button-counts.md): which key a click counts as, the page names, and the tally. The elements
 * are plain objects with what keyOf reads, so no browser is needed.
 */
import { expect, test } from 'bun:test';
import { ClickTally, convKind, keyOf, pageOf, recordClick, rowTrack, type ElementLike } from '../src/clicks.ts';

const el = (tag: string, attrs: Record<string, string> = {}, parent: ElementLike | null = null): ElementLike => ({
  tagName: tag.toUpperCase(),
  parentElement: parent,
  getAttribute: (n) => attrs[n] ?? null,
});

// The inbox list: a tagged row with text in it, and an untagged button of its own inside it.
const app = el('div', { class: 'app' });
const list = el('div', { class: 'sidebar-inner', 'data-track-area': 'inbox' }, app);
const row = el('button', { class: 'row conv-row', 'data-track': rowTrack(convKind('direct'), true) }, list);
const title = el('span', { class: 'row-title' }, el('span', { class: 'row-main' }, row));
const inner = el('span', { role: 'button', class: 'row-extra' }, row);
const innerText = el('span', {}, inner);
const NOW = new Date(2026, 10, 9, 15);

test('a click on a tagged row, anywhere in it, counts as the row, under its area', () => {
  expect(keyOf(row, 'inbox')).toBe('inbox: row (DM, unread)');
  expect(keyOf(title, 'conversation')).toBe('inbox: row (DM, unread)');
});

test('an untagged click inside a list row records nothing but "<page>: other"', () => {
  const tally = new ClickTally();
  expect(recordClick(tally, innerText, 'conversation', 'desktop', NOW)).toBe('conversation: other');
  expect(recordClick(tally, inner, 'conversation', 'desktop', NOW)).toBe('conversation: other');
  expect(tally.list()).toEqual([{ day: '2026-11-09', key: 'conversation: other', page: 'conversation', device: 'desktop', n: 2 }]);
});

test('no control, no count: text, empty space, and a label (its control gets the click next)', () => {
  const tally = new ClickTally();
  expect(recordClick(tally, el('p', {}, list), 'inbox', 'phone', NOW)).toBeNull();
  expect(recordClick(tally, null, 'inbox', 'phone', NOW)).toBeNull();
  const label = el('label', { class: 'toggle-row' }, app);
  expect(recordClick(tally, el('b', {}, label), 'settings', 'phone', NOW)).toBeNull();
  expect(tally.size).toBe(0);
  // The checkbox itself is a control like any other.
  expect(keyOf(el('input', { type: 'checkbox' }, label), 'settings')).toBe('settings: other');
});

test('a complete key keeps its own area; without an area a key takes the page', () => {
  expect(keyOf(el('button', { 'data-track': 'pager: back button' }, list), 'conversation')).toBe('pager: back button');
  expect(keyOf(el('button', { 'data-track': 'vote up' }, app), 'triage')).toBe('triage: vote up');
  expect(keyOf(el('a', { href: '#/settings' }, app), 'inbox')).toBe('inbox: other');
  expect(keyOf(el('summary', {}, app), 'triage')).toBe('triage: other');
});

test('pages are kinds of screen, never which one', () => {
  expect(pageOf({ view: 'inbox' })).toBe('inbox');
  expect(pageOf({ view: 'inbox', conv: 'cnv_abc123' })).toBe('conversation');
  expect(pageOf({ view: 'inbox', conv: 'mth_abc' })).toBe('mail thread');
  expect(pageOf({ view: 'people', person: 'per_x' })).toBe('conversation');
  expect(pageOf({ view: 'people', graph: true })).toBe('people graph');
  expect(pageOf({ view: 'space', space: 'spc_x' })).toBe('space');
  expect(pageOf({ view: 'search', q: 'hello there' })).toBe('search');
  expect(pageOf({ view: 'profile', person: 'per_x' })).toBe('profile');
  expect(pageOf({ view: 'requests', request: 'req_x' })).toBe('requests');
  for (const r of [{ view: 'folder', folder: 'fld_1', person: 'per_2' }, { view: 'mail', list: 'inbox', thread: 'mth_9' }, { view: 'accounts', account: 'acc_1' }] as const)
    expect(pageOf(r)).not.toMatch(/_|\d/);
});

test('row keys say the kind and the state', () => {
  expect(rowTrack(convKind('group'), false, true)).toBe('row (group, owes a reply)');
  expect(rowTrack('mail', true, true)).toBe('row (mail, unread)');
  expect(rowTrack(convKind('self'), false)).toBe('row (notes)');
});

test('the tally adds up per day, key, page and device, and empties when taken', () => {
  const t = new ClickTally();
  t.add('inbox: search', 'inbox', 'phone', NOW);
  t.add('inbox: search', 'inbox', 'phone', NOW);
  t.add('inbox: search', 'inbox', 'desktop', NOW);
  t.add('inbox: search', 'inbox', 'phone', new Date(2026, 10, 10, 9));
  expect(t.size).toBe(3);
  const again = new ClickTally(t.take());
  expect(t.size).toBe(0);
  expect(again.list().find((c) => c.day === '2026-11-09' && c.device === 'phone')!.n).toBe(2);
});
