/** src/update.ts: when a new build may replace the page. In Chromium: scripts/verify-update.ts. */
import { expect, test } from 'bun:test';
import { busyReasons, nextStep, type BusyInput, type UpdateState } from '../src/update.ts';

const s = (x: Partial<UpdateState>): UpdateState => ({ waiting: false, stale: false, asked: false, hidden: false, busy: false, ...x });

test('nothing new, nothing to do', () => {
  expect(nextStep(s({}))).toBe('none');
  expect(nextStep(s({ hidden: true }))).toBe('none');
  expect(nextStep(s({ asked: true }))).toBe('none');
});

test('a page in sight never takes a new build by itself, busy or not: it offers the bar', () => {
  expect(nextStep(s({ waiting: true }))).toBe('offer');
  expect(nextStep(s({ waiting: true, busy: true }))).toBe('offer');
});

test('out of sight and idle, it lets the new worker in; out of sight but busy, it waits', () => {
  expect(nextStep(s({ waiting: true, hidden: true }))).toBe('apply');
  expect(nextStep(s({ waiting: true, hidden: true, busy: true }))).toBe('offer');
});

test('the bar applies it at once, whatever is open', () => {
  expect(nextStep(s({ waiting: true, asked: true, busy: true }))).toBe('apply');
  expect(nextStep(s({ stale: true, asked: true, busy: true }))).toBe('reload');
});

test('a tab another tab updated reloads only out of sight and idle, else it shows the bar', () => {
  // In sight: the controller changed under it, and it keeps running.
  expect(nextStep(s({ stale: true }))).toBe('offer');
  expect(nextStep(s({ stale: true, busy: true }))).toBe('offer');
  // Out of sight, but with something open: still not.
  expect(nextStep(s({ stale: true, hidden: true, busy: true }))).toBe('offer');
  // Out of sight and idle: now.
  expect(nextStep(s({ stale: true, hidden: true }))).toBe('reload');
  // The tab that let it in from out of sight, back in sight by the time the worker took over: it waits too.
  expect(nextStep(s({ stale: true, waiting: false, hidden: false }))).toBe('offer');
});

test('a stale page with yet another build waiting reloads into the one in control', () => {
  expect(nextStep(s({ stale: true, waiting: true, hidden: true }))).toBe('reload');
});

const idle: BusyInput = { typed: false, call: false, verifying: false, layers: 0, menus: 0, detached: false, sending: 0 };

test('busy: everything a reload would lose', () => {
  expect(busyReasons(idle)).toEqual([]);
  expect(busyReasons({ ...idle, typed: true })).toEqual(['text typed']);
  expect(busyReasons({ ...idle, call: true })).toEqual(['a call']);
  expect(busyReasons({ ...idle, verifying: true })).toEqual(['a device verification']);
  expect(busyReasons({ ...idle, layers: 1 })).toEqual(['something open']);
  expect(busyReasons({ ...idle, menus: 2 })).toEqual(['something open']);
  expect(busyReasons({ ...idle, detached: true })).toEqual(['an older message on screen']);
  expect(busyReasons({ ...idle, sending: 1 })).toEqual(['a message sending']);
  expect(busyReasons({ ...idle, typed: true, layers: 1, sending: 3 })).toHaveLength(3);
});
