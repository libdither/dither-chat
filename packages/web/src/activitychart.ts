/**
 * The arithmetic behind a profile's Activity chart (ui/ActivityChart.tsx, docs/profile.md "Activity"): bars from the
 * hub's local hours, axis ticks, heat levels and the summary in words. Pure, so tests can import it.
 */
import type * as P from '@dither-chat/protocol';

/** The ranges the chart offers, in days. */
export const RANGES = [7, 30, 90] as const;
/** Hours per bar the chart picks from. */
export const STEPS = [1, 2, 3, 4, 6, 8, 12, 24];
const MIN_BAR = 4;

/** Series added hour by hour. */
export function sumHours(series: { hours: number[] }[] | undefined, n: number): number[] {
  const out = new Array(n).fill(0) as number[];
  for (const s of series ?? []) for (let i = 0; i < n; i++) out[i] += s.hours[i] ?? 0;
  return out;
}

/** Hours per bar: the fewest that leave each bar at least 4 px; whole days from 30 days up. */
export function barHours(days: number, width: number): number {
  if (days >= 30) return 24;
  return STEPS.find((s) => width / ((days * 24) / s) >= MIN_BAR) ?? 24;
}

/** Hours added up in runs of `step`. */
export function group(hours: number[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < hours.length; i += step) {
    let n = 0;
    for (let j = i; j < i + step && j < hours.length; j++) n += hours[j];
    out.push(n);
  }
  return out;
}

/** The busiest part of the day: the shortest run of hours (past midnight too) holding half of all, at most 8 hours. */
export function usualHours(byHour: number[]): { start: number; len: number } | null {
  const total = byHour.reduce((a, b) => a + b, 0);
  if (!total) return null;
  for (let len = 1; len <= 8; len++) {
    let best = -1;
    let bestStart = 0;
    for (let s = 0; s < 24; s++) {
      let n = 0;
      for (let k = 0; k < len; k++) n += byHour[(s + k) % 24];
      if (n > best) {
        best = n;
        bestStart = s;
      }
    }
    if (best * 2 >= total) return { start: bestStart, len };
  }
  return null;
}

/** 0 → "12am", 13 → "1pm". */
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  return `${x % 12 || 12}${x < 12 ? 'am' : 'pm'}`;
}

/** "9pm–1am". */
export const spanLabel = (start: number, len: number) => `${hourLabel(start)}–${hourLabel(start + len)}`;

/** Their messages by hour of the day, from the weekday-by-hour grid. */
export function byHourOfDay(week: number[]): number[] {
  const out = new Array(24).fill(0) as number[];
  week.forEach((n, i) => (out[i % 24] += n));
  return out;
}

const WHERE_WORDS: Record<P.ActivityWhere, string> = { dm: 'DMs', group: 'groups', server: 'servers' };
const n = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Where most of their messages were, in words: "mostly in DMs", "all in servers", "in DMs and groups". */
export function whereWords(series: P.ActivitySeries[]): string {
  const by = new Map<P.ActivityWhere, number>();
  for (const s of series) by.set(s.where, (by.get(s.where) ?? 0) + s.count);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const order = (['dm', 'group', 'server'] as const).filter((w) => by.get(w));
  if (!total || !order.length) return '';
  if (order.length === 1) return `all in ${WHERE_WORDS[order[0]]}`;
  const top = order.reduce((a, b) => (by.get(b)! > by.get(a)! ? b : a));
  if (by.get(top)! / total >= 0.6) return `mostly in ${WHERE_WORDS[top]}`;
  return order.length === 3 ? 'across DMs, groups and servers' : `in ${list(order.map((w) => WHERE_WORDS[w]))}`;
}

/** Share of the logged time they showed as online or do not disturb, or null when none was logged. */
export function onlineShare(v: P.ActivityChartView): number | null {
  const known = v.week.known?.reduce((a, b) => a + b, 0) ?? 0;
  if (!known) return null;
  return (v.week.online ?? []).reduce((a, b) => a + b, 0) / known;
}

/** Fewer than this many messages say nothing about when someone is usually around. */
const ENOUGH = 8;

/** One line in words: "Usually around 9pm–1am; 412 messages in 30 days, mostly in DMs. You sent 230 messages where they are." */
export function activitySummary(v: P.ActivityChartView, self = false): string {
  const sent = v.sent.reduce((a, s) => a + s.count, 0);
  const mine = v.mine?.reduce((a, s) => a + s.count, 0);
  const span = `${v.days} day${v.days === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (!sent) parts.push(`No messages from ${self ? 'you' : 'them'} in ${span}.`);
  else {
    const usual = sent >= ENOUGH ? usualHours(byHourOfDay(v.week.sent)) : null;
    const lead = sent < ENOUGH ? '' : usual ? `Usually around ${spanLabel(usual.start, usual.len)}; ` : 'Spread across the day; ';
    const reacts = v.reactions.count ? ` and ${n(v.reactions.count, 'reaction')}` : '';
    const words = `${lead}${n(sent, 'message')}${reacts} in ${span}, ${whereWords(v.sent)}.`;
    parts.push(words.charAt(0).toUpperCase() + words.slice(1));
  }
  if (mine !== undefined) parts.push(mine ? `You sent ${n(mine, 'message')} where they are.` : 'You sent none where they are.');
  const on = onlineShare(v);
  if (on !== null) parts.push(`Online ${Math.round(on * 100)}% of the time logged.`);
  return parts.join(' ');
}

/** The first day's date plus `d` days, as a Date whose UTC fields are that local day. */
export function dayDate(firstDay: string, d: number): Date {
  const [y, m, day] = firstDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + d));
}

/** Days that get a label on the axis, today's last, so labels sit at least `gap` px apart. */
export function dayTicks(days: number, width: number, gap = 52): number[] {
  const every = [1, 2, 7, 14, 28, 56].find((k) => (width / days) * k >= gap) ?? 56;
  const out: number[] = [];
  for (let d = days - 1; d >= 0; d -= every) out.unshift(d);
  return out;
}

/** 0 for nothing, else 1 to 5; a square root, so a quiet hour still shows beside a busy one. */
export function heatLevel(v: number, max: number): number {
  if (!(v > 0) || !(max > 0)) return 0;
  return Math.min(5, Math.max(1, Math.ceil(Math.sqrt(v / max) * 5)));
}

/** A share (0 to 1) as a level: 0 for none, 1 to 5 for some; -1 when nothing was logged. */
export function shareLevel(share: number | null): number {
  if (share === null) return -1;
  if (!(share > 0)) return 0;
  return Math.min(5, Math.max(1, Math.ceil(share * 5)));
}

/** Rounded seconds as "40m", "1h 5m". */
export function duration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}
