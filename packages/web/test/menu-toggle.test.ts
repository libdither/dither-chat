/**
 * A menu opened from a button closes when that button opens it again, like a dropdown; another button, or none,
 * opens its own menu as before. The buttons are plain objects: openMenu only compares them.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { signal } from '@preact/signals';
import { stateMock } from './fixtures/state.ts';

// What the menu module draws with needs a browser; none of it is used here.
mock.module('../src/state.ts', stateMock);
mock.module('../src/phone.ts', () => ({ phone: signal(false), useLayer: () => {} }));
mock.module('../src/ui/Reactions.tsx', () => ({ useLongPress: () => ({}) }));
mock.module('../src/ui/Sheet.tsx', () => ({ Sheet: () => null }));
mock.module('../src/clicklog.ts', () => ({ countKey: () => {} }));
const { closeMenu, contextMenu, openMenu } = await import('../src/ui/ContextMenu.tsx');

const spec = (label: string) => ({ label, items: [{ label: 'One', run: () => {} }] });
const button = () => ({ contains: () => false }) as unknown as Element;

afterEach(() => void closeMenu());

test('opening again from the same button closes the menu', () => {
  const b = button();
  openMenu({ x: 0, y: 0 }, spec('Mail accounts'), b);
  expect(contextMenu.value?.label).toBe('Mail accounts');
  openMenu({ x: 0, y: 0 }, spec('Mail accounts'), b);
  expect(contextMenu.value).toBeNull();
  openMenu({ x: 0, y: 0 }, spec('Mail accounts'), b);
  expect(contextMenu.value?.label).toBe('Mail accounts');
});

test('another button opens its own menu in place of the open one', () => {
  openMenu({ x: 0, y: 0 }, spec('Mail accounts'), button());
  openMenu({ x: 10, y: 0 }, spec('Mailboxes'), button());
  expect(contextMenu.value?.label).toBe('Mailboxes');
});

test('a menu opened without a button (right-click) never toggles', () => {
  openMenu({ x: 0, y: 0 }, spec('Message'));
  openMenu({ x: 0, y: 0 }, spec('Message'));
  expect(contextMenu.value?.label).toBe('Message');
});
