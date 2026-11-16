/** How wide a dragged panel may be (panes.ts, docs/desktop.md "Panel widths"). */
import { expect, test } from 'bun:test';
import { CENTER_MIN, clampPane } from '../src/panes.ts';

test('a width within bounds stays as dragged, rounded to a pixel', () => {
  expect(clampPane('sidebar', 400.4, 1600, 0)).toBe(400);
  expect(clampPane('details', 300, 1600, 332)).toBe(300);
});

test('each panel has a narrowest and a widest', () => {
  expect(clampPane('sidebar', 40, 1600, 0)).toBe(220);
  expect(clampPane('sidebar', 2000, 3000, 0)).toBe(640);
  expect(clampPane('details', 10, 1600, 332)).toBe(260);
});

test('the conversation keeps its room beside both panels', () => {
  // 1200 wide, details 320 open: the list may take what is left after the rail, the details and the conversation.
  expect(clampPane('sidebar', 600, 1200, 320)).toBe(1200 - 72 - 320 - CENTER_MIN);
});

test('a window too narrow for both still gets a usable panel', () => {
  expect(clampPane('sidebar', 500, 600, 320)).toBe(220);
});
