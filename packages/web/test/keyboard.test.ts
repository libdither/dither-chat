// The app's height around the keyboard and the panel in its place (phone.ts appHeight, docs/phone.md).
import { describe, expect, test } from 'bun:test';
import { appHeight, clampPanel } from '../src/keyboardroom.ts';

const base = { inner: 800, visible: 800, typing: false, app: false, ime: 0, panel: 0 };

describe('in a browser, which resizes the page for the keyboard', () => {
  test('nothing open: the full height', () => {
    expect(appHeight(base)).toEqual({ h: null, kb: false });
  });
  test('the panel takes its room from the bottom', () => {
    expect(appHeight({ ...base, panel: 300 })).toEqual({ h: 500, kb: true });
  });
  test("iOS: what the visual viewport leaves while typing, and the panel's room on top of it", () => {
    expect(appHeight({ ...base, visible: 480, typing: true })).toEqual({ h: 480, kb: false });
    expect(appHeight({ ...base, visible: 480, typing: false })).toEqual({ h: null, kb: false });
  });
});

describe('in the Android app, which leaves the room to the page', () => {
  const app = { ...base, app: true };
  test('the keyboard frame by frame', () => {
    expect(appHeight({ ...app, ime: 0 })).toEqual({ h: null, kb: false });
    expect(appHeight({ ...app, ime: 120 })).toEqual({ h: 680, kb: true });
    expect(appHeight({ ...app, ime: 295 })).toEqual({ h: 505, kb: true });
  });
  test('swapping the keyboard for a panel of its height never moves the box', () => {
    const heights = [295, 240, 150, 60, 0].map((ime) => appHeight({ ...app, ime, panel: 295 }).h);
    expect(new Set(heights)).toEqual(new Set([505]));
  });
  test('and back: the keyboard rises over the panel', () => {
    const heights = [0, 90, 200, 295].map((ime) => appHeight({ ...app, ime, panel: 295 }).h);
    expect(new Set(heights)).toEqual(new Set([505]));
  });
  test("the browser's own shrinking is not counted twice", () => {
    expect(appHeight({ ...app, visible: 500, typing: true, ime: 300 })).toEqual({ h: 500, kb: true });
  });
});

test("the panel: the keyboard's height, 40% of the screen before one was seen, never under 200 or over 60%", () => {
  expect(clampPanel(295, 800)).toBe(295);
  expect(clampPanel(0, 800)).toBe(320);
  expect(clampPanel(100, 800)).toBe(200);
  expect(clampPanel(700, 800)).toBe(480);
});
