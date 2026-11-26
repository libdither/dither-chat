const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact age for lists: "now", "5m", "3h", "Tue", "Oct 12". */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = now - ts;
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  const at = new Date(ts);
  if (d < DAY && at.getDate() === new Date(now).getDate()) return `${Math.floor(d / HOUR)}h`;
  // A day's label depends on its local date alone, so each is formatted once: a list draws hundreds of rows, and a
  // formatter's call costs more than the rest of this together (docs/perf.md "Times in lists").
  if (d < 6 * DAY) return (weekdayLabels[at.getDay()] ??= (weekdayFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'short' })).format(ts));
  const key = at.getFullYear() * 512 + at.getMonth() * 32 + at.getDate();
  let s = dayLabels.get(key);
  if (s === undefined) dayLabels.set(key, (s = (dayFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })).format(ts)));
  return s;
}
const weekdayLabels: string[] = [];
const dayLabels = new Map<number, string>();
/** How long, compactly: "now", "20m", "5h", "3d". */
export function since(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / DAY)}d`;
}
// Made once: toLocale*String builds a formatter per call, which a long list or timeline pays thousands of times per render.
let weekdayFmt: Intl.DateTimeFormat | undefined;
let dayFmt: Intl.DateTimeFormat | undefined;
let clockFmt: Intl.DateTimeFormat | undefined;
let fullFmt: Intl.DateTimeFormat | undefined;
let longDayFmt: Intl.DateTimeFormat | undefined;
let dateFmt: Intl.DateTimeFormat | undefined;
let yearDateFmt: Intl.DateTimeFormat | undefined;

export function clock(ts: number): string {
  return (clockFmt ??= new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })).format(ts);
}

/** A time to the minute that still says which day, as short as it can: "3:41 PM", "Yesterday 3:41 PM", "Tue 3:41 PM", "Nov 2, 3:41 PM", "Nov 2, 2025, 3:41 PM". */
export function stamp(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / DAY);
  const t = clock(ts);
  if (days === 0) return t;
  if (days === 1) return `Yesterday ${t}`;
  if (days > 1 && days < 6) return `${(weekdayFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'short' })).format(ts)} ${t}`;
  if (d.getFullYear() === n.getFullYear()) return `${(dayFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })).format(ts)}, ${t}`;
  return `${(yearDayFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })).format(ts)}, ${t}`;
}
let yearDayFmt: Intl.DateTimeFormat | undefined;

/** Minutes a time zone is ahead of UTC at that moment, or null for a zone this browser does not know. */
export function zoneOffset(zone: string, ts: number): number | null {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ts);
    const n = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return Math.round((Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - Math.floor(ts / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
}

/**
 * Someone's local time from their IANA time zone, with how far it is from yours: "Tue 3:41 PM · Europe/Berlin, 7 hours
 * ahead". Null for a zone this browser does not know.
 */
export function localTime(zone: string, now = Date.now()): string | null {
  const theirs = zoneOffset(zone, now);
  if (theirs === null) return null;
  const t = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(now);
  const d = theirs + new Date(now).getTimezoneOffset();
  const h = Math.floor(Math.abs(d) / 60);
  const m = Math.abs(d) % 60;
  const span = m ? `${h ? `${h} h ` : ''}${m} min` : `${h} hour${h === 1 ? '' : 's'}`;
  const gap = d === 0 ? 'your time' : `${span} ${d > 0 ? 'ahead' : 'behind'}`;
  return `${t} · ${zone.replace(/_/g, ' ')}, ${gap}`;
}

export function fullTime(ts: number): string {
  return (fullFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })).format(ts);
}

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(n) - startOf(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 6) return (longDayFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'long' })).format(d);
  if (d.getFullYear() === n.getFullYear()) return (dateFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'long', day: 'numeric' })).format(d);
  return (yearDateFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })).format(d);
}

export function sameDay(a: number, b: number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Lightness and chroma of avatars without images: even across hues, and white initials read on all of them (test/themes.test.ts). */
export const AVATAR_L = 0.5;
export const AVATAR_C = 0.1;

/** Stable pleasant colour for avatars without images. */
export function hueOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `oklch(${AVATAR_L * 100}% ${AVATAR_C} ${hue})`;
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}
