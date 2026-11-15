/**
 * Quiet hours: whether they are on at a moment, and whether a setting is one. Its own module, so the account's own
 * status (accountself.ts) can ask without importing triage.ts, which imports it back (docs/testing.md "Import cycles");
 * triage.ts re-exports both.
 */
import type * as P from '@dither-chat/protocol';

/** Local weekday and minutes since midnight in a time zone. */
function localTime(tz: string, now: number): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minutes: +get('hour') * 60 + +get('minute') };
}

const toMinutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

/** Are these quiet hours on right now? A window past midnight belongs to the day it started on. */
export function inQuietHours(q: P.QuietHours | null, now: number): boolean {
  if (!q?.enabled) return false;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  const { day, minutes } = localTime(q.timezone, now);
  const startedOn = (d: number) => !q.days?.length || q.days.includes(d);
  if (start < end) return minutes >= start && minutes < end && startedOn(day);
  if (minutes >= start) return startedOn(day);
  return minutes < end && startedOn((day + 6) % 7);
}

export function validQuietHours(q: Partial<P.QuietHours>): q is P.QuietHours {
  const time = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (!time(q.start) || !time(q.end) || typeof q.timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: q.timezone });
    return true;
  } catch {
    return false;
  }
}
