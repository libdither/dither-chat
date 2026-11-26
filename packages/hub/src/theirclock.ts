/**
 * What time it is for someone, and when they are usually around (docs/profile.md "Their time"): a zone you set for
 * them, else the zone a profile of theirs states (Zulip, Matrix), else a whole-hour offset guessed from the hours they
 * write in; and their usual day, by hour, with how sure each hour is. Only what the hub holds; the one thing it asks a network is a profile, for a
 * zone, on networks whose profiles carry one.
 */
import type * as P from '@dither-chat/protocol';
import type { Database } from 'bun:sqlite';
import { HOUR, offsetAt, offsetPieces, zoneName, type Zone } from './activitychart.ts';

const MIN = 60_000;
const DAY = 24 * HOUR;
/** How far back their day is read from. */
const DAY_WINDOW = 90;
/** Networks whose profiles say a zone (`PersonAbout.timeZone`): worth asking when none is kept. */
const ZONE_NETWORKS = new Set<P.Network>(['zulip', 'matrix']);
/** A profile asked this recently is not asked again for a zone. */
const ASKED_FRESH = 7 * DAY;
/** A guess is shown only when the offset is this likely to be within an hour of it, from at least this many days. */
const SHOW_SURE = 0.65;
const SHOW_DAYS = 10;

/** Where most adults' nights are centred, in local hours after midnight, and how far one person's may be from it (one standard deviation). */
const NIGHT_MIDDLE = 4;
const NIGHT_SPREAD = 1.2;
/** A night is the hours they write in at most this share of their usual hour's rate. */
const QUIET = 0.3;
/** A quiet stretch longer than a night (a day they don't write in, as well as the night) holds the night somewhere in it. */
const NIGHT_HOURS = 8;

type Row = Record<string, any>;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** A zone's IANA name, if this runtime knows it. */
function knownZone(z: unknown): string | null {
  if (typeof z !== 'string' || !z) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

/** The zone a kept profile of theirs states: its `timeZone`, else a "Time zone" fact (older extractors). */
function statedZone(db: Database, ids: string[]): { zone: string; network: P.Network } | null {
  if (!ids.length) return null;
  const rows = db.query(`SELECT a.data, i.network FROM about a CROSS JOIN identity i ON i.id = a.target_id WHERE a.target_id IN (${marks(ids.length)}) ORDER BY a.fetched_at DESC`).all(...ids) as Row[];
  for (const r of rows) {
    let a: P.PersonAbout;
    try {
      a = JSON.parse(r.data);
    } catch {
      continue;
    }
    const zone = knownZone(a.timeZone) ?? knownZone(a.facts?.find((f) => f.label === 'Time zone')?.value);
    if (zone) return { zone, network: r.network };
  }
  return null;
}

/**
 * The offset (whole hours, as minutes east of UTC) their nights put them at, from message times. What places someone
 * is where they never write: work leaves a gap on weekdays that weekends fill, but nothing fills a night. So: the
 * share of their days with a message in each UTC hour (recent days counting more, halved every three weeks back, so a
 * change of clocks for summer or winter is soon outweighed); the stretch of hours around the quietest that stays
 * under a third of their usual rate; its middle taken as about 4 in the morning for them. How sure that is comes from
 * how far people's nights differ, how much longer than a night the stretch is (someone who writes only in the evening,
 * or only at work, has a long one, and could be anywhere in it), how few days there are, and how quiet it really is.
 * `near`: your own offset, a little likelier, as the people you talk to tend to be near you. The answer's `sure` is
 * the chance the true offset is within an hour of `offset`; `post` the chance of each offset from -11 to +12 hours.
 */
export function guessOffset(ts: number[], near: number | null): { offset: number; sure: number; days: number; post: number[] } | null {
  if (!ts.length) return null;
  const newest = Math.floor(Math.max(...ts) / DAY);
  const perDay = new Map<number, Set<number>>();
  for (const t of ts) {
    const d = Math.floor(t / DAY);
    let s = perDay.get(d);
    if (!s) perDay.set(d, (s = new Set()));
    s.add(Math.floor((t - d * DAY) / HOUR));
  }
  const rate = new Array(24).fill(0) as number[];
  let weight = 0;
  for (const [d, hs] of perDay) {
    const w = 0.5 ** ((newest - d) / 21);
    weight += w;
    for (const h of hs) rate[h] += w;
  }
  for (let h = 0; h < 24; h++) rate[h] /= weight;
  const usual = rate.reduce((a, b) => a + b, 0) / 24;
  // The quietest five hours; then the stretch around their middle that stays quiet.
  let low = 0;
  let lowSum = Infinity;
  for (let h = 0; h < 24; h++) {
    const sum = [0, 1, 2, 3, 4].reduce((n, k) => n + rate[mod(h + k, 24)], 0);
    if (sum < lowSum) (lowSum = sum), (low = h);
  }
  const quiet = (h: number) => rate[mod(h, 24)] <= QUIET * usual;
  let from = low + 2;
  let to = low + 2;
  while (quiet(from - 1) && to - from < 23) from--;
  while (quiet(to + 1) && to - from < 23) to++;
  const span = quiet(low + 2) ? to - from + 1 : 0;
  const middle = span ? from + span / 2 : low + 2.5;
  // How plainly it is a night: 1 when its hours have under 15% of their usual hour's rate (a night with the odd late
  // message), down to 0 at half of it.
  const contrast = Math.max(0, Math.min(1, (0.5 - lowSum / 5 / usual) / 0.35));
  const spread = Math.sqrt(NIGHT_SPREAD ** 2 + (Math.max(0, span - NIGHT_HOURS) / 2.5) ** 2 + 0.25 * (14 / perDay.size));
  const offsets = Array.from({ length: 24 }, (_, i) => i - 11);
  const nearH = near === null ? null : Math.round(near / 60);
  const prior = (o: number) => (nearH === null ? 1 : o === nearH ? 3 : Math.abs(o - nearH) === 1 ? 1.5 : 1);
  // Their night's middle, in UTC, is 4 in the morning for them: offset 4 - middle, give or take `spread`, round the clock.
  const want = NIGHT_MIDDLE - middle;
  const fit = offsets.map((o) => [-24, 0, 24].reduce((n, k) => n + Math.exp(-((o - want + k) ** 2) / (2 * spread ** 2)), 0));
  const fitSum = fit.reduce((a, b) => a + b, 0);
  const raw = offsets.map((o, i) => prior(o) * (contrast * (fit[i] / fitSum) + (1 - contrast) / 24));
  const total = raw.reduce((a, b) => a + b, 0);
  const post = raw.map((x) => x / total);
  const best = post.indexOf(Math.max(...post));
  const sure = post[best] + post[mod(best - 1, 24)] + post[mod(best + 1, 24)];
  return { offset: offsets[best] * 60, sure: Math.round(sure * 100) / 100, days: perDay.size, post };
}

/** Their messages' times (not system lines), oldest first, from `from` on. */
function messageTimes(db: Database, ids: string[], from: number): number[] {
  if (!ids.length) return [];
  return (db.query(`SELECT ts FROM message WHERE author_id IN (${marks(ids.length)}) AND ts >= ? AND kind != 'system' ORDER BY ts`).all(...ids, from) as Row[]).map((r) => r.ts as number);
}

/** A share of n with its 80% Wilson interval, in whole percent. */
function share(k: number, n: number): [number, number, number] {
  if (!n) return [0, 0, 100];
  const z = 1.2816;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const pc = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100);
  return [pc(p), pc(mid - half), pc(mid + half)];
}

/** The middle of values on a clock face (minutes of a day) around `about`, and their spread (1.4826 × MAD), unwrapped there. */
function clockMedian(xs: number[], about: number): { at: number; spread: number } {
  const rel = xs.map((x) => mod(x - about + 720, 1440) - 720).sort((a, b) => a - b);
  const med = (v: number[]) => (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2);
  const m = med(rel);
  const mad = med(rel.map((r) => Math.abs(r - m)).sort((a, b) => a - b));
  const round5 = (x: number) => Math.round(x / 5) * 5;
  return { at: mod(round5(about + m), 1440), spread: Math.max(5, round5(1.4826 * mad)) };
}

/**
 * Their usual day in `zone`, from message times over [now - days, now]: per hour and per weekday-hour, the share of
 * the days observed that had a message then; and their usual night, from the gaps of 3 to 20 hours that cover the
 * quietest part of their day.
 */
export function usualDay(ts: number[], zone: Zone, now: number, days = DAY_WINDOW): Omit<P.TheirDayView, 'clock' | 'frame'> {
  const start = now - days * DAY;
  const times = ts.filter((t) => t >= start && t <= now + MIN);
  const pieces = offsetPieces(zone, start - DAY, now + HOUR);
  const offset = (t: number) => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid].from <= t) lo = mid;
      else hi = mid - 1;
    }
    return pieces[lo]?.offset ?? 0;
  };
  // Local days as whole numbers; 1970-01-01 (day 0) was a Thursday, weekday 3 counting from Monday.
  const localDay = (t: number) => Math.floor((t + offset(t)) / DAY);
  const weekday = (d: number) => mod(d + 3, 7);
  const today = localDay(now);
  const firstDay = times.length ? localDay(times[0]) : today;
  const observed = Math.max(1, today - Math.max(firstDay, localDay(start)) + 1);
  const weekDays = new Array(7).fill(0) as number[];
  for (let d = today - observed + 1; d <= today; d++) weekDays[weekday(d)]++;

  const seen = new Set<number>();
  for (const t of times) {
    const local = t + offset(t);
    seen.add(Math.floor(local / DAY) * 24 + Math.floor(mod(local, DAY) / HOUR));
  }
  const byHour = new Array(24).fill(0) as number[];
  const byWeek = new Array(168).fill(0) as number[];
  for (const k of seen) {
    const h = mod(k, 24);
    byHour[h]++;
    byWeek[weekday(Math.floor(k / 24)) * 24 + h]++;
  }
  const hours = byHour.map((k) => share(k, observed));
  const week = byWeek.map((k, i) => share(k, weekDays[Math.floor(i / 24)]));

  const out: Omit<P.TheirDayView, 'clock' | 'frame'> = { days: observed, messages: times.length, hours, week, weekDays };
  if (times.length < 2) return out;
  // The quietest six hours of their day; its middle is the night every gap counted has to cover.
  let low = 0;
  let lowSum = Infinity;
  for (let h = 0; h < 24; h++) {
    const s = [0, 1, 2, 3, 4, 5].reduce((n, k) => n + byHour[mod(h + k, 24)], 0);
    if (s < lowSum) (lowSum = s), (low = h);
  }
  const center = (low * 60 + 180) % 1440;
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1];
    const b = times[i];
    if (b - a < 3 * HOUR || b - a > 20 * HOUR) continue;
    const la = a + offset(a);
    const lb = b + offset(b);
    // The first local `center` at or after the gap's start: is it before the gap's end?
    const c = Math.floor(la / DAY) * DAY + center * MIN;
    if (!((c >= la && c <= lb) || (c + DAY >= la && c + DAY <= lb))) continue;
    from.push(Math.floor(mod(la, DAY) / MIN));
    to.push(Math.floor(mod(lb, DAY) / MIN));
  }
  if (from.length >= 7) {
    const f = clockMedian(from, center);
    const t = clockMedian(to, center);
    out.quiet = { from: f.at, to: t.at, fromSpread: f.spread, toSpread: t.spread, nights: from.length };
  }
  return out;
}

/** An identity's person's identities, or the identity alone, and the id a zone set by hand is kept under; null for an unknown id. */
function identitiesOf(db: Database, ref: string): { ids: string[]; self: boolean; key: string } | null {
  if (ref.startsWith('idn_')) {
    const r = db.query('SELECT i.person_id AS person, p.is_self AS self FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?').get(ref) as Row | null;
    if (!r) return null;
    const ids = r.person ? (db.query('SELECT id FROM identity WHERE person_id = ?').all(r.person) as Row[]).map((x) => x.id as string) : [ref];
    const own = db.query(`SELECT 1 FROM account WHERE self_identity IN (${marks(ids.length)}) LIMIT 1`).get(...ids);
    return { ids, self: !!r.self || !!own, key: r.person ?? ref };
  }
  const p = db.query('SELECT is_self FROM person WHERE id = ?').get(ref) as Row | null;
  if (!p) return null;
  return { ids: (db.query('SELECT id FROM identity WHERE person_id = ?').all(ref) as Row[]).map((x) => x.id as string), self: !!p.is_self, key: ref };
}

interface ClockDeps {
  db: Database;
  /** Zones set by hand, by person id or identity id (store.ts zonePins). */
  pins?: { get: () => Record<string, string>; set: (m: Record<string, string>) => void };
  /** Ask a network for an identity's profile, which keeps its zone (people.ts). */
  askProfile?: (identityId: string) => Promise<unknown>;
  now?: () => number;
}

/** Clocks, kept a while per person: a chat's authors are asked for as it opens, and the answer barely moves. */
export class Clocks {
  private kept = new Map<string, { at: number; clock: P.TheirClock | null; ids: string[] }>();
  private asked = new Set<string>();
  private queue: string[] = [];
  /** Queued or being asked. */
  private pending = new Set<string>();
  private inFlight = 0;

  constructor(private d: ClockDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** One author's clock; `asking` when a profile is being asked for a zone. Keyed by the ids' first, so a person is worked out once. */
  clock(ref: string, near: number | null): { clock: P.TheirClock | null; asking: boolean } {
    const who = identitiesOf(this.d.db, ref);
    if (!who || who.self) return { clock: null, asking: false };
    const pinned = knownZone(this.d.pins?.get()[who.key]);
    if (pinned) return { clock: { source: 'pinned', zone: pinned }, asking: false };
    const key = `${who.key}|${near}`;
    const k = this.kept.get(key);
    if (k && this.now() - k.at < 30 * MIN) return { clock: k.clock, asking: false };
    const stated = statedZone(this.d.db, who.ids);
    let clock: P.TheirClock | null = stated ? { source: 'profile', zone: stated.zone, network: stated.network } : null;
    const asking = !stated && this.askForZone(who.ids);
    if (!clock) {
      const g = guessOffset(messageTimes(this.d.db, who.ids, this.now() - DAY_WINDOW * DAY), near);
      if (g && g.sure >= SHOW_SURE && g.days >= SHOW_DAYS) clock = { source: 'rhythm', offset: g.offset, sure: g.sure, days: g.days };
    }
    if (!asking) this.kept.set(key, { at: this.now(), clock, ids: who.ids });
    return { clock, asking };
  }

  /** Several authors at once (GET /api/people/clocks). */
  clocks(refs: string[], near: number | null): P.TheirClocksView {
    const clocks: Record<string, P.TheirClock | null> = {};
    const asking: string[] = [];
    for (const r of refs) {
      const c = this.clock(r, near);
      clocks[r] = c.clock;
      if (c.asking) asking.push(r);
    }
    return { clocks, ...(asking.length ? { asking } : {}) };
  }

  /** Their usual day (GET /api/people/:id/day), in their zone when known, else in `yours`. */
  day(ref: string, yours: Zone): P.TheirDayView | null {
    const who = identitiesOf(this.d.db, ref);
    if (!who) return null;
    const now = this.now();
    const near = offsetAt(yours, now) / MIN;
    const { clock } = who.self ? { clock: null } : this.clock(ref, near);
    const zone: Zone = clock ? (clock.source === 'rhythm' ? { offset: clock.offset } : { tz: clock.zone }) : yours;
    const day = usualDay(messageTimes(this.d.db, who.ids, now - (DAY_WINDOW + 1) * DAY), zone, now);
    return { clock, frame: { theirs: !!clock, zone: zoneName(zone), offsetNow: offsetAt(zone, now) / MIN }, ...day };
  }

  /** Set their zone by hand, or clear it (null). False for an unknown person or zone. */
  pin(ref: string, zone: string | null): boolean {
    const who = identitiesOf(this.d.db, ref);
    if (!who || !this.d.pins || (zone !== null && !knownZone(zone))) return false;
    const m = { ...this.d.pins.get() };
    if (zone) m[who.key] = zone;
    else delete m[who.key];
    this.d.pins.set(m);
    return true;
  }

  /**
   * Ask for a profile of theirs on a network whose profiles say a zone, unless one was kept lately: two at a time, each
   * identity once per hub run. Whether one is on its way.
   */
  private askForZone(ids: string[]): boolean {
    const ask = this.d.askProfile;
    if (!ask) return false;
    const nets = this.d.db.query(`SELECT id, network FROM identity WHERE id IN (${marks(ids.length)})`).all(...ids) as Row[];
    let any = false;
    for (const r of nets) {
      if (!ZONE_NETWORKS.has(r.network)) continue;
      if (this.asked.has(r.id)) {
        any ||= this.pending.has(r.id);
        continue;
      }
      const kept = this.d.db.query('SELECT MAX(fetched_at) AS at FROM about WHERE target_id = ?').get(r.id) as Row | null;
      if (kept?.at && this.now() - kept.at < ASKED_FRESH) continue;
      this.asked.add(r.id);
      this.queue.push(r.id);
      this.pending.add(r.id);
      any = true;
    }
    this.pump();
    return any;
  }

  private pump() {
    while (this.inFlight < 2 && this.queue.length) {
      const id = this.queue.shift()!;
      this.inFlight++;
      void this.d.askProfile!(id)
        .catch(() => {})
        .finally(() => {
          this.inFlight--;
          this.pending.delete(id);
          for (const [k, v] of this.kept) if (v.ids.includes(id)) this.kept.delete(k);
          this.pump();
        });
    }
  }
}
