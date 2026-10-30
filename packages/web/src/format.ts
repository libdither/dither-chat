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
  if (d < 6 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(n) - startOf(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 6) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
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

/** Stable pleasant colour for avatars without images. */
export function hueOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 42% 42%)`;
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
