const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact age for lists: "now", "5m", "3h", "Tue", "Oct 12". */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = now - ts;
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY && new Date(ts).getDate() === new Date(now).getDate()) return `${Math.floor(d / HOUR)}h`;
  if (d < 6 * DAY) return (weekdayFmt ??= new Intl.DateTimeFormat(undefined, { weekday: 'short' })).format(ts);
  return (dayFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })).format(ts);
}
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
