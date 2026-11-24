/** A mail list's times (ThreadRow, ThreadList, MailSearch). */
import { clock, sameDay } from '../../format.ts';

/** In a list, short: "10:42" today, "Tue" this week, "Oct 28" this year, "Oct 28, 2025" before. */
export function listTime(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return clock(ts);
  const d = new Date(ts);
  if (now - ts < 6 * 86_400_000 && ts < now) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
