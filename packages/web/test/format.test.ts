import { describe, expect, test } from 'bun:test';
import { ago, clock, dayLabel, fullTime, stamp } from '../src/format.ts';

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
  test('a time to the minute that says which day (reaction times, docs/reactions.md "When")', () => {
    const now = new Date(2026, 10, 7, 15, 0).getTime();
    const at = (y: number, m: number, d: number) => new Date(y, m, d, 10, 5).getTime();
    const t = clock(at(2026, 10, 7));
    expect(stamp(at(2026, 10, 7), now)).toBe(t);
    expect(stamp(at(2026, 10, 6), now)).toBe(`Yesterday ${t}`);
    expect(stamp(at(2026, 10, 4), now)).toBe(`${new Date(at(2026, 10, 4)).toLocaleDateString(undefined, { weekday: 'short' })} ${t}`);
    expect(stamp(at(2026, 9, 1), now)).toBe(`${new Date(at(2026, 9, 1)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${t}`);
    expect(stamp(at(2025, 9, 1), now)).toBe(`${new Date(at(2025, 9, 1)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}, ${t}`);
  });
  test("a list's ages: each day's label kept, the same as formatting every time", () => {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
    const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    const now = new Date(2026, 10, 7, 15, 0).getTime();
    // Every 37 minutes back over 400 days: each weekday and day, twice or more, both sides of midnight and of DST.
    for (let ts = now; ts > now - 400 * 86_400_000; ts -= 37 * 60_000) {
      const d = now - ts;
      const want = d < 60_000 ? 'now' : d < 3_600_000 ? `${Math.floor(d / 60_000)}m` : d < 86_400_000 && new Date(ts).getDate() === new Date(now).getDate() ? `${Math.floor(d / 3_600_000)}h` : d < 6 * 86_400_000 ? weekday.format(ts) : day.format(ts);
      expect(ago(ts, now)).toBe(want);
    }
    expect(ago(null, now)).toBe('');
  });
});
