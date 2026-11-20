// Keys to the places (placekeys.ts, docs/desktop.md "Keys to the places").
import { describe, expect, test } from 'bun:test';
import { PLACES, readKey, type KeyIn, type Place } from '../src/placekeys.ts';

const k = (key: string, more: Partial<KeyIn> = {}): KeyIn => ({ key, code: '', alt: false, ctrl: false, meta: false, shift: false, repeat: false, composing: false, typing: false, covered: false, ...more });
const all = () => true;
const noMail = (p: Place) => p !== 'mail';

describe('G then a letter', () => {
  test('G waits, and each letter goes to its place', () => {
    expect(readKey(k('g'), false, all)).toEqual({ kind: 'wait' });
    for (const p of PLACES) expect(readKey(k(p.letter), true, all)).toEqual({ kind: 'go', place: p.place, how: 'g' });
  });
  test('a capital letter after G, with Shift held, still goes', () => {
    expect(readKey(k('Shift'), true, all)).toBeNull();
    expect(readKey(k('P', { shift: true }), true, all)).toEqual({ kind: 'go', place: 'people', how: 'g' });
  });
  test('any other key after G stops waiting, and goes on to the page', () => {
    expect(readKey(k('x'), true, all)).toEqual({ kind: 'cancel' });
    expect(readKey(k('Escape'), true, all)).toEqual({ kind: 'cancel' });
    expect(readKey(k('i', { ctrl: true }), true, all)).toEqual({ kind: 'cancel' });
  });
  test("a place the hub doesn't offer is not a letter", () => {
    expect(readKey(k('m'), true, noMail)).toEqual({ kind: 'cancel' });
  });
  test('G is a letter like any other while typing, under a menu, held down or with a modifier', () => {
    expect(readKey(k('g', { typing: true }), false, all)).toBeNull();
    expect(readKey(k('g', { covered: true }), false, all)).toBeNull();
    expect(readKey(k('g', { repeat: true }), false, all)).toBeNull();
    expect(readKey(k('G', { shift: true }), false, all)).toBeNull();
    expect(readKey(k('g', { ctrl: true }), false, all)).toBeNull();
  });
  test('a letter with no G before it does nothing', () => {
    expect(readKey(k('i'), false, all)).toBeNull();
  });
  test('an input method composing stops the wait', () => {
    expect(readKey(k('i', { composing: true }), true, all)).toEqual({ kind: 'cancel' });
    expect(readKey(k('g', { composing: true }), false, all)).toBeNull();
  });
});

describe('Ctrl+Shift and a number', () => {
  const cs = { ctrl: true, shift: true };
  test("each numbered place's number on the rail, read from the physical key", () => {
    for (const p of PLACES.filter((x) => x.digit)) expect(readKey(k('!', { ...cs, code: `Digit${p.digit}` }), false, all)).toEqual({ kind: 'go', place: p.place, how: 'chord' });
  });
  test('works while typing in the message box', () => {
    expect(readKey(k('!', { ...cs, code: 'Digit1', typing: true }), false, all)).toEqual({ kind: 'go', place: 'inbox', how: 'chord' });
  });
  test('the numbers stay put when a place is missing', () => {
    expect(readKey(k('#', { ...cs, code: 'Digit3' }), false, noMail)).toBeNull();
    expect(readKey(k('$', { ...cs, code: 'Digit4' }), false, noMail)).toEqual({ kind: 'go', place: 'calendar', how: 'chord' });
  });
  test("Alt is the window manager's: Alt+number does nothing", () => {
    expect(readKey(k('1', { alt: true, code: 'Digit1' }), false, all)).toBeNull();
  });
  test('not with Alt or Meta too, Ctrl or Shift alone, a number past the places, under a menu, or held down', () => {
    expect(readKey(k('!', { ...cs, alt: true, code: 'Digit1' }), false, all)).toBeNull();
    expect(readKey(k('!', { ...cs, meta: true, code: 'Digit1' }), false, all)).toBeNull();
    expect(readKey(k('1', { ctrl: true, code: 'Digit1' }), false, all)).toBeNull();
    expect(readKey(k('!', { shift: true, code: 'Digit1' }), false, all)).toBeNull();
    expect(readKey(k('(', { ...cs, code: 'Digit9' }), false, all)).toBeNull();
    expect(readKey(k('!', { ...cs, code: 'Digit1', covered: true }), false, all)).toBeNull();
    expect(readKey(k('!', { ...cs, code: 'Digit1', repeat: true }), false, all)).toBeNull();
  });
});
