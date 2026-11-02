import { expect, test } from 'bun:test';
import { clampDrag, commits, lockAxis, rubber, settleMs, velocity } from '../src/gesture.ts';

test('a touch has no axis until it moves past the slop, and sideways must clearly win', () => {
  expect(lockAxis(4, 3)).toBeNull();
  expect(lockAxis(30, 5)).toBe('x');
  expect(lockAxis(-30, 5)).toBe('x');
  expect(lockAxis(12, 11)).toBe('y');
  expect(lockAxis(2, -20)).toBe('y');
});

test('velocity spans the samples', () => {
  expect(velocity([{ x: 0, t: 0 }, { x: 50, t: 100 }])).toBe(0.5);
  expect(velocity([{ x: 0, t: 0 }])).toBe(0);
});

test('past the middle commits, a flick commits early, a flick back cancels late', () => {
  expect(commits(0, 300, 160, 0)).toBe(true);
  expect(commits(0, 300, 140, 0)).toBe(false);
  expect(commits(0, 300, 40, 0.8)).toBe(true);
  expect(commits(0, 300, 250, -0.8)).toBe(false);
  // The same for moves to the left.
  expect(commits(300, 0, 100, 0)).toBe(true);
  expect(commits(300, 0, 280, -0.6)).toBe(true);
});

test('settling is quicker after a fast flick, and stays within bounds', () => {
  expect(settleMs(0, 1)).toBe(0);
  expect(settleMs(300, 3)).toBeLessThan(settleMs(300, 0.2));
  expect(settleMs(300, 100)).toBe(120);
  expect(settleMs(3000, 0)).toBe(320);
});

test('rubber band follows one to one, then resists', () => {
  expect(rubber(40, 60)).toBe(40);
  expect(rubber(-40, 60)).toBe(-40);
  expect(rubber(200, 60)).toBeGreaterThan(60);
  expect(rubber(200, 60)).toBeLessThan(90);
  expect(rubber(-200, 60)).toBe(-rubber(200, 60));
});

test('a drag past its ends gives a little, never more than the give', () => {
  expect(clampDrag(50, 0, 100)).toBe(50);
  expect(clampDrag(130, 0, 100)).toBeGreaterThan(100);
  expect(clampDrag(10_000, 0, 100)).toBeLessThan(124);
  expect(clampDrag(-10_000, 0, 100)).toBeGreaterThan(-24);
});
