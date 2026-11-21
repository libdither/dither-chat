/**
 * Escape is the back button of a keyboard (docs/desktop.md "Escape and back", escape.ts): what nothing else took closes
 * the top layer, or with none open leaves the page, but never from where a message is being written.
 */
import { describe, expect, test } from 'bun:test';
import { escapeAct } from '../src/escape.ts';

const base = { handled: false, layers: 0, field: 'none' as const, canLeave: true };

describe('an Escape nothing took', () => {
  test('leaves a page with somewhere to go back to', () => {
    expect(escapeAct(base)).toBe('page');
  });
  test('stays on a list, which has nowhere to go', () => {
    expect(escapeAct({ ...base, canLeave: false })).toBe('none');
  });
  test('closes the top layer first, wherever the cursor is', () => {
    expect(escapeAct({ ...base, layers: 2 })).toBe('layer');
    expect(escapeAct({ ...base, layers: 1, field: 'text' })).toBe('layer');
  });
  test('leaves from a one-line box (search), not from where text is written', () => {
    expect(escapeAct({ ...base, field: 'line' })).toBe('page');
    expect(escapeAct({ ...base, field: 'text' })).toBe('none');
  });
});

describe('an Escape something took', () => {
  test('goes no further: no layer closed, no page left', () => {
    expect(escapeAct({ ...base, handled: true })).toBe('none');
    expect(escapeAct({ ...base, handled: true, layers: 1 })).toBe('none');
  });
});
