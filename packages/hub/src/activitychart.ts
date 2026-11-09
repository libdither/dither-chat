/**
 * When someone is around, for the Activity section of a profile (docs/profile.md, "Activity"): their messages, the
 * reactions they gave and your messages to them, and only while those are logged (adversarial features) their presence
 * and status changes, over the last N local days by local hour. Only what the hub already holds; it asks no network.
 *
 * Hours are wall-clock hours in the zone the page passes, so every day has 24: the hour a clock skips at a DST change
 * stays empty, and the hour it repeats holds both. A zone's offset changes only at its transitions, so the range is cut
 * there and each piece is counted in SQL with its own offset, along message_author_ts.
 */
import type * as P from '@dither-chat/protocol';
import type { Database } from 'bun:sqlite';

export const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;

/** A time zone: an IANA name, or a fixed offset in minutes east of UTC. */
export type Zone = { tz: string } | { offset: number };

/** ?tz= an IANA name, else ?offset= minutes east of UTC, else UTC. null when it is neither. */
export function parseZone(tz: string | null, offset: string | null): Zone | null {
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return { tz };
    } catch {
      return null;
    }
  }
  if (offset !== null && offset !== '') {
    const n = Number(offset);
    return Number.isInteger(n) && Math.abs(n) <= 14 * 60 ? { offset: n } : null;
  }
  return { offset: 0 };
}

/** ?days=, whole days from 1 to 365; 30 when missing or not a number. */
export function clampDays(v: string | null): number {
  const n = v === null || v === '' ? NaN : Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_DAYS, Math.max(1, n)) : DEFAULT_DAYS;
}

export function zoneName(z: Zone): string {
  if ('tz' in z) return z.tz;
  if (!z.offset) return 'UTC';
  const a = Math.abs(z.offset);
  return `UTC${z.offset < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at an instant, in ms. */
export function offsetAt(z: Zone, t: number): number {
  if ('offset' in z) return z.offset * 60_000;
  let f = formats.get(z.tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: z.tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(z.tz, f);
  }
  const s = Math.floor(t / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(s)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
}

export interface Piece {
  from: number;
  to: number;
  offset: number;
}

/** [from, to) cut where the zone's offset changes, each piece with its offset. Transitions are found to the second. */
export function offsetPieces(z: Zone, from: number, to: number): Piece[] {
  if ('offset' in z) return [{ from, to, offset: z.offset * 60_000 }];
  const out: Piece[] = [];
  // No zone changes its offset twice within six hours.
  const STEP = 6 * HOUR;
  let start = from;
  let off = offsetAt(z, from);
  for (let t = from; t < to; ) {
    const next = Math.min(t + STEP, to);
    if (offsetAt(z, next) !== off) {
      // In whole seconds: the last with the old offset, and the first with the new.
      let lo = Math.floor(t / 1000);
      let hi = Math.floor(next / 1000);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(z, mid * 1000) === off) lo = mid;
        else hi = mid;
      }
      const at = hi * 1000;
      if (at > start) out.push({ from: start, to: at, offset: off });
      start = at;
      off = offsetAt(z, at);
    }
    t = next;
  }
  if (to > start) out.push({ from: start, to, offset: off });
  return out;
}

/** The instant a local wall-clock time names; a time a clock skips gives the instant just after the skip. */
export function instantOf(z: Zone, local: number): number {
  let t = local - offsetAt(z, local);
  t = local - offsetAt(z, t);
  return t;
}

export interface LocalRange {
  /** The first day's midnight, as local wall-clock ms (UTC fields read as local). */
  first: number;
  /** The instant of that midnight. */
  from: number;
  days: number;
  hours: number;
  nowHour: number;
  firstDay: string;
  firstWeekday: number;
}

/** `days` whole local days, today last. */
export function localRange(z: Zone, days: number, now: number): LocalRange {
  const localNow = now + offsetAt(z, now);
  const first = Math.floor(localNow / DAY) * DAY - (days - 1) * DAY;
  return {
    first,
    from: instantOf(z, first),
    days,
    hours: days * 24,
    nowHour: Math.min(days * 24 - 1, Math.floor((localNow - first) / HOUR)),
    firstDay: new Date(first).toISOString().slice(0, 10),
    // 1970-01-01 was a Thursday: 3, counting from Monday.
    firstWeekday: (((Math.floor(first / DAY) + 3) % 7) + 7) % 7,
  };
}

/** Pieces covering the range, from a little before its first midnight to just after now. */
export function rangePieces(z: Zone, r: LocalRange, now: number): Piece[] {
  // Clocks a minute ahead still count as now.
  return offsetPieces(z, r.from - 2 * HOUR, now + 60_000)
    .map((p) => ({ ...p, from: Math.max(p.from, r.first - p.offset) }))
    .filter((p) => p.to > p.from);
}

/** Fractional hour of the range an instant falls in, by the piece that holds it. */
export function hourOf(pieces: Piece[], r: LocalRange, t: number): number | null {
  const p = pieces.find((x) => t >= x.from && t < x.to);
  return p ? (t + p.offset - r.first) / HOUR : null;
}

const PRIORITY: Record<P.PresenceState, number> = { online: 3, dnd: 2, idle: 1, offline: 0 };
const STATE_INDEX: Record<P.PresenceState, number> = { online: 0, idle: 1, dnd: 2, offline: 3 };

/** One identity's presence: the state when the range starts (null: not known), then each change in it. */
export interface PresenceInput {
  before: P.PresenceState | null;
  changes: { at: number; state: P.PresenceState }[];
}

/**
 * Presence merged across someone's identities over [from, to): at each moment the most present state any of them
 * shows (online, then do not disturb, then idle, then offline). Stretches where none is known are left out.
 */
export function mergePresence(ids: PresenceInput[], from: number, to: number): { from: number; to: number; state: P.PresenceState }[] {
  const now: (P.PresenceState | null)[] = ids.map((i) => i.before);
  const events = ids.flatMap((i, k) => i.changes.filter((c) => c.at >= from && c.at < to).map((c) => ({ ...c, k }))).sort((a, b) => a.at - b.at);
  const merged = () => now.reduce<P.PresenceState | null>((best, s) => (s && (!best || PRIORITY[s] > PRIORITY[best]) ? s : best), null);
  const out: { from: number; to: number; state: P.PresenceState }[] = [];
  let t = from;
  let cur = merged();
  const close = (at: number) => {
    if (cur && at > t) {
      const last = out.at(-1);
      if (last && last.state === cur && last.to === t) last.to = at;
      else out.push({ from: t, to: at, state: cur });
    }
  };
  for (const e of events) {
    close(e.at);
    t = e.at;
    now[e.k] = e.state;
    cur = merged();
  }
  close(to);
  return out;
}

/**
 * Stretches as fractional hours of the range, cut where the offset changes, and the seconds in each state per hour
 * (online, idle, dnd, offline), only for hours where something was known.
 */
export function presenceHours(stretches: { from: number; to: number; state: P.PresenceState }[], pieces: Piece[], r: LocalRange): NonNullable<P.ActivityChartView['presence']> {
  const out: [number, number, P.PresenceState][] = [];
  const per = new Map<number, [number, number, number, number]>();
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  for (const s of stretches) {
    for (const p of pieces) {
      const a = Math.max(s.from, p.from);
      const b = Math.min(s.to, p.to);
      if (b <= a) continue;
      const pa = Math.max(0, (a + p.offset - r.first) / HOUR);
      const pb = Math.min(r.hours, (b + p.offset - r.first) / HOUR);
      if (pb <= pa) continue;
      const last = out.at(-1);
      if (last && last[2] === s.state && Math.abs(last[1] - round(pa)) < 1e-6) last[1] = round(pb);
      else out.push([round(pa), round(pb), s.state]);
      for (let h = Math.floor(pa); h < pb; h++) {
        const sec = (Math.min(pb, h + 1) - Math.max(pa, h)) * 3600;
        if (sec <= 0) continue;
        const row = per.get(h) ?? [0, 0, 0, 0];
        row[STATE_INDEX[s.state]] += sec;
        per.set(h, row);
      }
    }
  }
  const hours = [...per]
    .sort((a, b) => a[0] - b[0])
    .map(([h, v]): [number, number, number, number, number] => [h, Math.round(v[0]), Math.round(v[1]), Math.round(v[2]), Math.round(v[3])]);
  return { stretches: out, hours };
}

/** Where a conversation's messages are, by its shape. */
export function whereOf(shape: string): P.ActivityWhere {
  return shape === 'direct' || shape === 'self' ? 'dm' : shape === 'group' ? 'group' : 'server';
}

export interface ChartInput {
  /** Their identities. */
  ids: string[];
  /** Your identities; empty on your own page (no back-and-forth to show). */
  selfIds: string[];
  days: number;
  zone: Zone;
  now: number;
  /** Presence and statuses are logged (adversarial features shown, and their switches on). */
  presence: boolean;
  statuses: boolean;
}

type Row = Record<string, any>;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Everything the chart shows, for one person (all their identities). */
export function activityChart(db: Database, x: ChartInput): P.ActivityChartView {
  const r = localRange(x.zone, x.days, x.now);
  const pieces = rangePieces(x.zone, r, x.now);
  const conv = new Map<string, { where: P.ActivityWhere; network: P.Network } | null>();
  const convQ = db.query('SELECT shape, network FROM conversation WHERE id = ?');
  const place = (id: string) => {
    if (!conv.has(id)) {
      const c = convQ.get(id) as Row | null;
      conv.set(id, c ? { where: whereOf(c.shape), network: c.network } : null);
    }
    return conv.get(id)!;
  };
  const clampHour = (b: number) => Math.min(r.hours - 1, Math.max(0, b));
  const bucket = `CAST((ts + ? - ?) / ${HOUR} AS INTEGER)`;

  /** Messages per hour by where and network, a query per piece of the range. */
  const count = (where: string, args: (string | number)[]) => {
    const series = new Map<string, P.ActivitySeries>();
    for (const p of pieces) {
      const rows = db.query(`SELECT conversation_id AS c, ${bucket} AS b, COUNT(*) AS n FROM message WHERE ${where} AND ts >= ? AND ts < ? AND kind != 'system' GROUP BY c, b`).all(p.offset, r.first, ...args, p.from, p.to) as Row[];
      for (const row of rows) {
        const at = place(row.c);
        if (!at) continue;
        const key = `${at.where}:${at.network}`;
        let s = series.get(key);
        if (!s) series.set(key, (s = { where: at.where, network: at.network, count: 0, hours: new Array(r.hours).fill(0) }));
        s.hours[clampHour(row.b)] += row.n;
        s.count += row.n;
      }
    }
    return [...series.values()].sort((a, b) => b.count - a.count);
  };

  const sent = x.ids.length ? count(`author_id IN (${marks(x.ids.length)})`, x.ids) : [];

  // Your messages where they are too: DMs and groups they are in or wrote in.
  let mine: P.ActivitySeries[] | undefined;
  if (x.selfIds.length) {
    const shared = new Set<string>(
      x.ids.length
        ? (db.query(`SELECT DISTINCT p.conversation_id AS id FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE p.identity_id IN (${marks(x.ids.length)}) AND c.shape IN ('direct', 'group')`).all(...x.ids) as Row[]).map((r) => r.id as string)
        : [],
    );
    for (const [id, at] of conv) if (at && at.where !== 'server') shared.add(id);
    const ids = [...shared];
    mine = ids.length ? count(`conversation_id IN (${marks(ids.length)}) AND author_id IN (${marks(x.selfIds.length)})`, [...ids, ...x.selfIds]) : [];
  }

  // Reactions they gave, at the message's hour: the hub keeps who reacted, not when. From the reaction table (a few
  // ms for all of it): led by message_ts instead, SQLite would walk every message in the range.
  const reactions = { count: 0, hours: new Array(r.hours).fill(0) as number[] };
  if (x.ids.length) {
    const rows = db
      .query(`SELECT m.ts AS ts FROM reaction re CROSS JOIN message m ON m.id = re.message_id WHERE re.identity_id IN (${marks(x.ids.length)}) AND m.ts >= ? AND m.ts < ?`)
      .all(...x.ids, r.from - 2 * HOUR, x.now + 60_000) as Row[];
    for (const row of rows) {
      const h = hourOf(pieces, r, row.ts);
      if (h === null || h < 0) continue;
      reactions.hours[clampHour(Math.floor(h))]++;
      reactions.count++;
    }
  }

  // Weekday by hour, Monday first.
  const weekOf = (h: number) => ((r.firstWeekday + Math.floor(h / 24)) % 7) * 24 + (h % 24);
  const week = (series: P.ActivitySeries[]) => {
    const w = new Array(168).fill(0) as number[];
    for (const s of series) s.hours.forEach((n, h) => n && (w[weekOf(h)] += n));
    return w;
  };

  const view: P.ActivityChartView = {
    zone: zoneName(x.zone),
    firstDay: r.firstDay,
    days: r.days,
    firstWeekday: r.firstWeekday,
    nowHour: r.nowHour,
    from: r.from,
    to: x.now,
    sent,
    ...(mine ? { mine } : {}),
    reactions,
    week: { sent: week(sent), ...(mine ? { mine: week(mine) } : {}) },
  };

  if (x.presence && x.ids.length) {
    const lastBefore = db.query(`SELECT new FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'presence' AND at < ? ORDER BY at DESC, id DESC LIMIT 1`);
    const inRange = db.query(`SELECT new, at FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'presence' AND at >= ? AND at < ? ORDER BY at, id`);
    const state = (v: string | null): P.PresenceState | null => {
      try {
        const s = v ? (JSON.parse(v) as P.PresenceView).state : null;
        return s && s in PRIORITY ? s : null;
      } catch {
        return null;
      }
    };
    const start = pieces[0]?.from ?? r.from;
    const inputs: PresenceInput[] = x.ids.map((id) => ({
      before: state(((lastBefore.get(id, start) as Row | null)?.new as string | undefined) ?? null),
      changes: (inRange.all(id, start, x.now + 1) as Row[]).flatMap((c) => {
        const s = state(c.new);
        return s ? [{ at: c.at as number, state: s }] : [];
      }),
    }));
    const presence = presenceHours(mergePresence(inputs, start, x.now), pieces, r);
    view.presence = presence;
    const online = new Array(168).fill(0) as number[];
    const known = new Array(168).fill(0) as number[];
    for (const [h, on, idle, dnd, off] of presence.hours) {
      online[weekOf(h)] += on + dnd;
      known[weekOf(h)] += on + idle + dnd + off;
    }
    view.week.online = online;
    view.week.known = known;
  }

  if (x.statuses && x.ids.length) {
    const nets = new Map((db.query(`SELECT id, network FROM identity WHERE id IN (${marks(x.ids.length)})`).all(...x.ids) as Row[]).map((r) => [r.id as string, r.network as P.Network]));
    const rows = db
      .query(`SELECT target_id AS id, new, at FROM change_log WHERE target_kind = 'identity' AND target_id IN (${marks(x.ids.length)}) AND field = 'status' AND at >= ? AND at < ? ORDER BY at, id`)
      .all(...x.ids, pieces[0]?.from ?? r.from, x.now + 60_000) as Row[];
    view.statuses = rows.flatMap((row) => {
      const h = hourOf(pieces, r, row.at);
      if (h === null || h < 0) return [];
      let v: { text?: string; emoji?: string } | null = null;
      try {
        v = row.new ? JSON.parse(row.new) : null;
      } catch {}
      return [{ at: row.at as number, hour: Math.round(Math.min(h, r.hours) * 10_000) / 10_000, text: v?.text ?? null, emoji: v?.emoji ?? null, network: nets.get(row.id) ?? 'discord' }];
    });
  }
  return view;
}
