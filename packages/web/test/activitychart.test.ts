import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { activitySummary, barHours, dayDate, dayTicks, duration, group, heatLevel, hourLabel, shareLevel, spanLabel, sumHours, usualHours, whereWords } from '../src/activitychart.ts';

const series = (where: P.ActivityWhere, count: number, network: P.Network = 'discord'): P.ActivitySeries => ({ where, network, count, hours: [] });
/** A view with these messages at these hours of the day, over `days`. */
function view(at: Record<number, number>, x: Partial<P.ActivityChartView> = {}): P.ActivityChartView {
  const week = new Array(168).fill(0);
  let total = 0;
  for (const [h, c] of Object.entries(at)) {
    week[Number(h)] += c;
    total += c;
  }
  return {
    zone: 'UTC',
    firstDay: '2026-10-11',
    days: 30,
    firstWeekday: 6,
    nowHour: 700,
    from: 0,
    to: 0,
    sent: total ? [series('dm', total)] : [],
    reactions: { count: 0, hours: [] },
    week: { sent: week },
    ...x,
  };
}

describe('bars', () => {
  test('hours per bar: the fewest that leave a bar 4 px wide; days from 30 days up', () => {
    expect(barHours(7, 330)).toBe(3);
    expect(barHours(7, 700)).toBe(1);
    expect(barHours(7, 560)).toBe(2);
    expect(barHours(30, 2000)).toBe(24);
    expect(barHours(90, 330)).toBe(24);
    expect(barHours(1, 120)).toBe(1);
    expect(barHours(1, 40)).toBe(3);
  });
  test('series add up hour by hour, and runs of hours into bars', () => {
    expect(sumHours([{ hours: [1, 2, 3] }, { hours: [0, 5, 0] }], 3)).toEqual([1, 7, 3]);
    expect(sumHours(undefined, 2)).toEqual([0, 0]);
    expect(group([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([6, 15, 7]);
  });
  test('ticks: today last, far enough apart', () => {
    expect(dayTicks(7, 400)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(dayTicks(7, 330)).toEqual([0, 2, 4, 6]);
    expect(dayTicks(30, 330)).toEqual([1, 8, 15, 22, 29]);
    expect(dayTicks(90, 330)).toEqual([5, 33, 61, 89]);
    expect(dayTicks(90, 600)).toEqual([5, 19, 33, 47, 61, 75, 89]);
    expect(dayDate('2026-10-30', 3).toISOString().slice(0, 10)).toBe('2026-11-02');
  });
});

describe('words', () => {
  test('hours as a clock says them', () => {
    expect([0, 1, 11, 12, 13, 23, 24, 25].map(hourLabel)).toEqual(['12am', '1am', '11am', '12pm', '1pm', '11pm', '12am', '1am']);
    expect(spanLabel(21, 4)).toBe('9pm–1am');
  });

  test('the usual hours: the shortest run holding half, past midnight too', () => {
    const h = new Array(24).fill(0);
    h[21] = 10;
    h[22] = 10;
    h[23] = 10;
    h[0] = 10;
    h[9] = 5;
    expect(usualHours(h)).toEqual({ start: 21, len: 3 });
    expect(usualHours(new Array(24).fill(1))).toBeNull();
    expect(usualHours(new Array(24).fill(0))).toBeNull();
  });

  test('where, in words', () => {
    expect(whereWords([series('dm', 9), series('server', 1)])).toBe('mostly in DMs');
    expect(whereWords([series('server', 4, 'discord'), series('server', 2, 'matrix')])).toBe('all in servers');
    expect(whereWords([series('dm', 5), series('group', 5)])).toBe('in DMs and groups');
    expect(whereWords([series('dm', 3), series('group', 3), series('server', 3)])).toBe('across DMs, groups and servers');
  });

  test('the summary: when, how many, where; your side; presence when logged', () => {
    // Mondays 9pm to midnight, and a busy 9am.
    const v = view({ 21: 80, 22: 90, 23: 80, 24: 60, 9: 102 }, { sent: [series('dm', 300), series('server', 112)], mine: [series('dm', 230)], reactions: { count: 37, hours: [] } });
    expect(activitySummary(v)).toBe('Usually around 9pm–12am; 412 messages and 37 reactions in 30 days, mostly in DMs. You sent 230 messages where they are.');
    const p = { ...v, week: { ...v.week, online: new Array(168).fill(0).map((_, i) => (i === 0 ? 3600 : 0)), known: new Array(168).fill(0).map((_, i) => (i < 4 ? 2400 : 0)) } };
    expect(activitySummary(p)).toEndWith('Online 38% of the time logged.');
  });

  test('a few messages say nothing about when; none at all says so', () => {
    expect(activitySummary(view({ 21: 3 }, { days: 7 }))).toBe('3 messages in 7 days, all in DMs.');
    expect(activitySummary(view({}, { mine: [] }))).toBe('No messages from them in 30 days. You sent none where they are.');
    const flat = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i, 2]));
    expect(activitySummary(view(flat))).toStartWith('Spread across the day; 48 messages');
  });

  test('heat levels and durations', () => {
    expect([0, 1, 4, 25, 100, 200].map((v) => heatLevel(v, 100))).toEqual([0, 1, 1, 3, 5, 5]);
    expect(heatLevel(3, 0)).toBe(0);
    expect([null, 0, 0.1, 0.5, 1].map(shareLevel)).toEqual([-1, 0, 1, 3, 5]);
    expect([0, 59, 600, 3600, 3900].map(duration)).toEqual(['0m', '1m', '10m', '1h', '1h 5m']);
  });
});
