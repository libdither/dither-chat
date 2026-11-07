import { describe, expect, test } from 'bun:test';
import { clock, dayLabel, fullTime } from '../src/format.ts';

// The formatters are made once (format.ts); they must say exactly what the per-call toLocale*String did.
describe('dates and times', () => {
  const times = [Date.UTC(2026, 0, 3, 9, 5), Date.UTC(2026, 10, 7, 23, 59), Date.UTC(2025, 6, 14, 12, 0)];
  test('clock and fullTime', () => {
    for (const ts of times) {
      expect(clock(ts)).toBe(new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
      expect(fullTime(ts)).toBe(new Date(ts).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    }
  });
  test('day lines', () => {
    const now = new Date(2026, 10, 7, 15, 0).getTime();
    const day = (y: number, m: number, d: number) => new Date(y, m, d, 10, 0).getTime();
    expect(dayLabel(day(2026, 10, 7), now)).toBe('Today');
    expect(dayLabel(day(2026, 10, 6), now)).toBe('Yesterday');
    expect(dayLabel(day(2026, 10, 4), now)).toBe(new Date(day(2026, 10, 4)).toLocaleDateString(undefined, { weekday: 'long' }));
    expect(dayLabel(day(2026, 9, 1), now)).toBe(new Date(day(2026, 9, 1)).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric' }));
    expect(dayLabel(day(2025, 9, 1), now)).toBe(new Date(day(2025, 9, 1)).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }));
  });
});
