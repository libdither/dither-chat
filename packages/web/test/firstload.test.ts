/** A first start's orb (firstload.ts): it fills with the bytes, then runs to full while the page sets the inbox up. */
import { describe, expect, test } from 'bun:test';
import { bootFill, bootStatus } from '../src/firstload.ts';

const MB = 1 << 20;

describe('bootFill', () => {
  test('empty until the socket is up, a sliver while the hub is asked', () => {
    expect(bootFill({ phase: 'reach', got: 0, total: null }, false).fill).toBe(0);
    expect(bootFill({ phase: 'reach', got: 0, total: null }, true).fill).toBeCloseTo(0.06);
  });

  test('downloading: in step with the bytes, short of full', () => {
    const half = bootFill({ phase: 'download', got: 2 * MB, total: 4 * MB }, true).fill;
    const all = bootFill({ phase: 'download', got: 4 * MB, total: 4 * MB }, true).fill;
    expect(half).toBeCloseTo(0.08 + 0.36);
    expect(all).toBeCloseTo(0.8);
  });

  test('without a total it creeps and never fills', () => {
    const a = bootFill({ phase: 'download', got: 1 * MB, total: null }, true).fill;
    const b = bootFill({ phase: 'download', got: 40 * MB, total: null }, true).fill;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(0.6);
  });

  test('setting up runs to full over about a quarter second a megabyte, within bounds', () => {
    expect(bootFill({ phase: 'draw', got: 4 * MB, total: 4 * MB }, true)).toEqual({ fill: 1, ms: 1000 });
    expect(bootFill({ phase: 'draw', got: 0.1 * MB, total: null }, true).ms).toBe(400);
    expect(bootFill({ phase: 'draw', got: 90 * MB, total: 90 * MB }, true).ms).toBe(4000);
  });
});

test('bootStatus says each step', () => {
  expect(bootStatus({ phase: 'reach', got: 0, total: null }, false)).toBe('Connecting to your hub…');
  expect(bootStatus({ phase: 'download', got: 1.5 * MB, total: 4 * MB }, true)).toBe('Downloading your inbox · 1.5 of 4.0 MB');
  expect(bootStatus({ phase: 'download', got: 40 * 1024, total: 240 * 1024 }, true)).toBe('Downloading your inbox · 40 of 240 KB');
  expect(bootStatus({ phase: 'download', got: 1.5 * MB, total: null }, true)).toBe('Downloading your inbox · 1.5 MB');
  expect(bootStatus({ phase: 'draw', got: 4 * MB, total: 4 * MB }, true)).toBe('Setting it up on this device…');
});
