/**
 * Reading pace (docs/indexing.md "Reading pace"): bulk fetches through an account (index jobs, the gap fill after an
 * import) go the way a person reads back through a chat, not the way an exporter pages it.
 *
 * - Only in the account owner's usual hours (local time, `hours`, default 9:00 to 1:00), starting a little after the
 *   hour rather than on it.
 * - In sessions of 5 to 20 minutes, with a break of 10 to 45 minutes after each.
 * - A page is "read" before the next one: a pause that grows with the messages on it.
 * - At most `dailyCap` messages a day per account; a day runs from the start of the hours to the next start.
 * - One reader per account at a time: a second (the gap fill while a job runs) waits its turn.
 *
 * Its state is kept in `meta` (`pace:<account>`), so a hub restart neither starts a fresh day's cap nor cuts a break short.
 */
import type { Clock } from './clock.ts';
import type { Store } from './store.ts';

type Range = readonly [number, number];

export interface PaceConfig {
  /** Local hours [start, end): 9 to 1 runs past midnight. start === end: all day. */
  hours: Range;
  /** Messages a day per account. */
  dailyCap: number;
  /** How long a session lasts, ms. */
  session: Range;
  /** The break after a session, ms. */
  rest: Range;
  /** A page's pause: this, ms, */
  page: Range;
  /** plus this per message on it, ms. */
  perMessage: Range;
  /** Moving on to another conversation, ms on top. */
  switch: Range;
  /** How late after the start of the hours the first session starts, ms. */
  lateStart: Range;
}

const MIN = 60_000;

/** A person reading back: the defaults. */
export const READING: PaceConfig = {
  hours: [9, 1],
  dailyCap: 3000,
  session: [5 * MIN, 20 * MIN],
  rest: [10 * MIN, 45 * MIN],
  page: [2500, 5000],
  perMessage: [250, 700],
  switch: [3000, 10_000],
  lateStart: [0, 40 * MIN],
};

/** No pacing beyond a short pause (tests, and a hub told so): all day, no cap, no breaks. */
export const BRISK: PaceConfig = {
  hours: [0, 0],
  dailyCap: Infinity,
  session: [Infinity, Infinity],
  rest: [0, 0],
  page: [1500, 1500],
  perMessage: [0, 0],
  switch: [0, 0],
  lateStart: [0, 0],
};

/** `DITHER_INDEX_HOURS` ("9-1", "0-0" for all day), `DITHER_INDEX_DAILY` (messages), `DITHER_INDEX_PACE=brisk`. */
export function paceFromEnv(env: Record<string, string | undefined> = process.env): PaceConfig {
  if (env.DITHER_INDEX_PACE === 'brisk') return BRISK;
  const c: PaceConfig = { ...READING };
  const h = env.DITHER_INDEX_HOURS?.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (h && +h[1] < 24 && +h[2] < 24) c.hours = [+h[1], +h[2]];
  const cap = Number(env.DITHER_INDEX_DAILY);
  if (env.DITHER_INDEX_DAILY && Number.isFinite(cap) && cap > 0) c.dailyCap = Math.floor(cap);
  return c;
}

export type RestReason = 'hours' | 'cap' | 'break';

interface State {
  /** The reading day (its start's local date) the count is for. */
  day: string;
  count: number;
  /** The session under way ends then; 0: none. */
  sessionEnd: number;
  /** Not before then: a break, or a late start. */
  until: number;
  why: RestReason | null;
  /** Who read last and when (one reader at a time). */
  reader: string | null;
  readAt: number;
}

/** A reader that has not read for this long gives up its turn. */
const TURN_MS = 3 * MIN;

export class ReadingPace {
  private cache = new Map<string, State>();

  constructor(
    private store: Store,
    readonly config: PaceConfig,
    private clock: Clock,
    private random: () => number = Math.random,
  ) {}

  private pick([lo, hi]: Range): number {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return lo;
    // The mean of two draws: around the middle more often than at the ends, as people are.
    return lo + ((this.random() + this.random()) / 2) * (hi - lo);
  }

  private allDay() {
    return this.config.hours[0] === this.config.hours[1];
  }

  /** Inside the hours at `t`. */
  inHours(t: number): boolean {
    if (this.allDay()) return true;
    const [s, e] = this.config.hours;
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    return s < e ? h >= s && h < e : h >= s || h < e;
  }

  /** The next start of the hours after `t`. */
  nextStart(t: number): number {
    const d = new Date(t);
    d.setHours(this.config.hours[0], 0, 0, 0);
    if (d.getTime() <= t) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /** The reading day `t` is in: the local date the hours last started on. */
  dayOf(t: number): string {
    const d = new Date(t);
    if (!this.allDay() && d.getHours() < this.config.hours[0]) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private load(accountId: string): State {
    let s = this.cache.get(accountId);
    if (!s) {
      const row = this.store.db.query('SELECT value FROM meta WHERE key = ?').get(`pace:${accountId}`) as { value: string } | null;
      try {
        s = row ? (JSON.parse(row.value) as State) : undefined;
      } catch {
        s = undefined;
      }
      s ??= { day: '', count: 0, sessionEnd: 0, until: 0, why: null, reader: null, readAt: 0 };
      this.cache.set(accountId, s);
    }
    return s;
  }

  private save(accountId: string, s: State) {
    this.store.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`pace:${accountId}`, JSON.stringify(s));
  }

  /**
   * How long `reader` must wait before the account's next page, ms; 0: read now (a session starts if none is under
   * way). Call it again after the wait: nothing is promised.
   */
  wait(accountId: string, reader: string): number {
    const now = this.clock.now();
    const s = this.load(accountId);
    const was = JSON.stringify(s);
    const done = (ms: number, why: RestReason | null) => {
      s.why = ms > 0 ? why : null;
      if (JSON.stringify(s) !== was) this.save(accountId, s);
      return ms;
    };
    // Another reader's turn: nothing changes, so its reason (a break, the hours) stays what it is.
    if (s.reader && s.reader !== reader && now - s.readAt < TURN_MS) return Math.max(1000, s.readAt + TURN_MS - now);
    const day = this.dayOf(now);
    if (s.day !== day) {
      s.day = day;
      s.count = 0;
    }
    if (!this.inHours(now)) {
      // Out of hours: the session is over; the next starts a little after the hours do.
      s.sessionEnd = 0;
      if (s.until < now || s.why !== 'hours') s.until = this.nextStart(now) + this.pick(this.config.lateStart);
      return done(s.until - now, 'hours');
    }
    if (s.count >= this.config.dailyCap) {
      s.sessionEnd = 0;
      const next = this.nextStart(now);
      if (s.until < next) s.until = next + this.pick(this.config.lateStart);
      return done(s.until - now, 'cap');
    }
    if (s.until > now) return done(s.until - now, s.why === 'hours' || s.why === 'cap' ? s.why : 'break');
    if (s.sessionEnd && now >= s.sessionEnd) {
      // The session ran out: a break.
      s.sessionEnd = 0;
      s.until = now + this.pick(this.config.rest);
      return done(s.until - now, 'break');
    }
    if (!s.sessionEnd) s.sessionEnd = now + this.pick(this.config.session);
    s.reader = reader;
    s.readAt = now;
    return done(0, null);
  }

  /** A page of `messages` was read: counted, and the pause before the next page, ms. `switched`: the next is another conversation. */
  read(accountId: string, reader: string, messages: number, switched = false): number {
    const now = this.clock.now();
    const s = this.load(accountId);
    s.day = this.dayOf(now);
    s.count += Math.max(0, messages);
    s.reader = reader;
    s.readAt = now;
    this.save(accountId, s);
    const pause = this.pick(this.config.page) + Math.max(0, messages) * this.pick(this.config.perMessage) + (switched ? this.pick(this.config.switch) : 0);
    // The turn is kept through the pause.
    s.readAt = now + pause;
    return pause;
  }

  /** The reader is done for now: another may read at once. */
  release(accountId: string, reader: string) {
    const s = this.load(accountId);
    if (s.reader !== reader) return;
    s.reader = null;
    this.save(accountId, s);
  }

  /** Why the account is not reading, and until when; null while it may. */
  resting(accountId: string): { until: number; why: RestReason } | null {
    const s = this.load(accountId);
    const now = this.clock.now();
    if (s.why && s.until > now) return { until: s.until, why: s.why };
    return null;
  }

  /** Messages read in the account's current reading day. */
  today(accountId: string): number {
    const s = this.load(accountId);
    return s.day === this.dayOf(this.clock.now()) ? s.count : 0;
  }
}
