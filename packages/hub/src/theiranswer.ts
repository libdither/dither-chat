/**
 * When someone is likely to answer you (docs/profile.md "When they answer"): from how long they took to answer your
 * earlier messages in your direct chats with them, on any network, timed in the hours they are usually around
 * (theirclock.ts), so a message sent at their bedtime waits for their morning. A message sent while you were talking
 * weighs most the times you wrote while talking, and one after a quiet spell the times you wrote after one; everyone's
 * answers to you fill in for someone with few. Times and authors only: never what anyone wrote.
 */
import type * as P from '@dither-chat/protocol';
import type { Database } from 'bun:sqlite';
import { HOUR } from './activitychart.ts';
import type { Clocks } from './theirclock.ts';

const MIN = 60_000;
const DAY = 24 * HOUR;
/** An answer later than this did not answer the message: it went unanswered. */
const ANSWER_WINDOW = 7 * DAY;
/** What came longer ago counts for less, halved every half year. */
const HALF_LIFE = 180 * DAY;
/** How far back their answers are read; what is older weighs under a sixteenth. */
const HISTORY = 730 * DAY;
/** How far back everyone's answers are read, and how long they are kept before being read again. */
const EVERYONE = 365 * DAY;
const EVERYONE_KEEP = 12 * HOUR;
/** Their hours around are kept this long. */
const AROUND_KEEP = 30 * MIN;
/** Everyone's answers weigh as this many of theirs. */
const PRIOR = 4;
/** How alike two quiet spells before a message must be to count for each other: a log-normal kernel's width. */
const GAP_WIDTH = 1.5;
/** Their usual day is read from this many days before each message. */
const PROFILE_DAYS = 60;
/** The hours they are never around in still count this much, so a night only slows an answer down. */
const FLOOR = 0.03;
/** The curve: a point every half hour, for a day. */
const STEP = 30 * MIN;
const STEPS = 48;

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** One of your messages (the first of a run of yours) and what came of it. */
interface Turn {
  t0: number;
  /** How long the chat had been quiet before it, ms. */
  gap: number;
  /** How long until they answered; null when they did not within ANSWER_WINDOW. */
  lat: number | null;
}

/**
 * Your turns in a chat's messages, oldest first (`rows`: [author, ts], in time order): each first message of yours
 * after something of theirs or at the start, answered by the next message not yours. `open`: your turn still waiting
 * at `now`, or for a message sent now when the last word is theirs. Turns of the last ANSWER_WINDOW are left out,
 * answered or not: of those, only the quick answers are known yet, and counting them alone would make everyone seem
 * quicker than they are.
 */
export function turnsOf(rows: [string, number][], self: Set<string>, now: number): { turns: Turn[]; open: { t0: number; gap: number; waiting: boolean } } {
  const turns: Turn[] = [];
  let cur: { t0: number; gap: number } | null = null;
  let last: number | null = null;
  for (const [a, ts] of rows) {
    if (self.has(a)) {
      if (!cur) cur = { t0: ts, gap: last === null ? 30 * DAY : ts - last };
    } else if (cur) {
      const lat = ts - cur.t0;
      if (now - cur.t0 > ANSWER_WINDOW) turns.push({ ...cur, lat: lat <= ANSWER_WINDOW ? lat : null });
      cur = null;
    }
    last = ts;
  }
  if (cur && now - cur.t0 > ANSWER_WINDOW) {
    turns.push({ ...cur, lat: null });
    cur = null;
  }
  return { turns, open: cur ? { ...cur, waiting: true } : { t0: now, gap: last === null ? 30 * DAY : now - last, waiting: false } };
}

/**
 * How much they are around in each hour of the UTC day over the PROFILE_DAYS before `at`, from the hours they did
 * anything in (`hours`: hour numbers since 1970): the share of the days seen, floored, scaled to average 1. Flat
 * when nothing was seen.
 */
export function rates(hours: Set<number>, at: number): number[] {
  const end = Math.floor(at / DAY);
  const counts = new Array(24).fill(0) as number[];
  let days = 0;
  for (let d = end - PROFILE_DAYS; d < end; d++) {
    let any = false;
    for (let h = 0; h < 24; h++) if (hours.has(d * 24 + h)) (counts[h]++, (any = true));
    if (any) days++;
  }
  if (!days) return new Array(24).fill(1);
  const r = counts.map((c) => FLOOR + c / days);
  const mean = r.reduce((a, b) => a + b, 0) / 24;
  return r.map((x) => x / mean);
}

/** The time from `t` to `t + d` as they live it: each hour counted at their rate in it (`r`, by UTC hour, average 1). */
export function awake(r: number[], t: number, d: number): number {
  const whole = Math.floor(d / DAY);
  let acc = whole * DAY;
  let x = t + whole * DAY;
  const end = t + d;
  while (x < end) {
    const h = Math.floor(x / HOUR);
    const next = Math.min(end, (h + 1) * HOUR);
    acc += (next - x) * r[mod(h, 24)];
    x = next;
  }
  return acc;
}

/** An answer seen: how long the chat was quiet before the message, how long until it (null: none), how much it counts. */
export interface Seen {
  gap: number;
  v: number | null;
  w: number;
}

const kernel = (a: number, b: number) => {
  const d = Math.log(Math.max(MIN / 2, a)) - Math.log(Math.max(MIN / 2, b));
  return Math.exp(-(d * d) / (2 * GAP_WIDTH * GAP_WIDTH));
};

/**
 * Answers seen, each weighed by how alike its quiet spell is to `gap`, sorted by how long they took (none last), with
 * running sums: so the chance of an answer by `b` given none by `a` is two binary searches, not a pass over them all.
 */
class Curve {
  private v: number[];
  private sum: number[];
  readonly total: number;
  constructor(seen: Seen[], gap: number) {
    const xs = seen.map((s) => ({ v: s.v ?? Infinity, w: s.w * kernel(s.gap, gap) })).sort((a, b) => a.v - b.v);
    this.v = xs.map((x) => x.v);
    this.sum = [0];
    for (const x of xs) this.sum.push(this.sum[this.sum.length - 1] + x.w);
    this.total = this.sum[xs.length];
  }
  /** The weight of answers within `x`. */
  private upTo(x: number): number {
    let lo = 0;
    let hi = this.v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.v[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return this.sum[lo];
  }
  /** P(answered by `b` | not by `a`), and the weight that rests on. */
  after(a: number, b: number): { p: number; n: number } {
    const by = this.upTo(a);
    const n = this.total - by;
    return { p: n > 0 ? (this.upTo(b) - by) / n : 0, n };
  }
}

/** Their answers mixed with everyone's: theirs count by their weight, everyone's as PRIOR of theirs. */
function mixed(t: { p: number; n: number }, e: { p: number; n: number }): number {
  if (!e.n) return t.p;
  return (t.n * t.p + PRIOR * e.p) / (t.n + PRIOR);
}

/** How much their own answers, alike in quiet spell to `gap`, weigh: 0 to 1, against everyone's. */
function ownShare(theirs: Seen[], gap: number): number {
  const w = theirs.reduce((s, x) => s + x.w * kernel(x.gap, gap), 0);
  return w / (w + PRIOR);
}

/**
 * The estimate for a message at `t0` after a quiet spell `gap`, as seen at `now` with no answer yet: the chance of an
 * answer by each half hour for a day, when it reaches a half and 8 in 10, and within the week. Their answers are in
 * their time (awake, by `r`), everyone's in plain time.
 */
export function estimate(theirs: Seen[], everyone: Seen[], r: number[], t0: number, gap: number, now: number): Pick<P.TheirAnswerView, 'by' | 'half' | 'likely' | 'week'> {
  const mine = new Curve(theirs, gap);
  const all = new Curve(everyone, gap);
  const e = Math.max(0, now - t0);
  const a = awake(r, t0, e);
  const at = (d: number) => mixed(mine.after(a, awake(r, t0, e + d)), all.after(e, e + d));
  const left = Math.max(0, ANSWER_WINDOW - e);
  const by = Array.from({ length: STEPS }, (_, i) => Math.round(at(Math.min(left, (i + 1) * STEP)) * 100));
  const week = at(left);
  // When the chance first reaches p, to the minute; null when it does not within the week.
  const when = (p: number) => {
    if (week < p) return null;
    let lo = 0;
    let hi = left;
    while (hi - lo > MIN) {
      const mid = (lo + hi) / 2;
      if (at(mid) >= p) hi = mid;
      else lo = mid;
    }
    return Math.round((now + hi) / MIN) * MIN;
  };
  return { by, half: when(0.5), likely: when(0.8), week: Math.round(week * 100) };
}

interface AnswerDeps {
  db: Database;
  clocks: Clocks;
  now?: () => number;
}

/** Your identities: what you wrote is by one of these (as scorecard.ts selfIds). */
function selfOf(db: Database): Set<string> {
  return new Set((db.query(`SELECT self_identity AS id FROM account WHERE self_identity IS NOT NULL UNION SELECT id FROM identity WHERE person_id IN (SELECT id FROM person WHERE is_self = 1)`).all() as { id: string }[]).map((r) => r.id));
}

/** When people are likely to answer you (GET /api/people/:id/answer), with everyone's answers kept a while. */
export class Answers {
  private everyone: { at: number; seen: Seen[] } | null = null;
  /** Their identities and the hours they were around in, kept a while: their usual day barely moves, and reading it is most of the work. */
  private hoursKept = new Map<string, { at: number; ids: string[]; hours: Set<number> }>();
  constructor(private d: AnswerDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** Everyone's answers to you in direct chats over the last year, in plain time, one chat at a time. */
  private everyones(self: Set<string>): Seen[] {
    const now = this.now();
    if (this.everyone && Math.abs(now - this.everyone.at) < EVERYONE_KEEP) return this.everyone.seen;
    const rows = this.d.db
      .query(`SELECT m.conversation_id, m.author_id, m.ts FROM conversation c CROSS JOIN message m ON m.conversation_id = c.id AND m.ts >= ? AND m.ts <= ? WHERE c.shape = 'direct' AND m.author_id IS NOT NULL AND m.kind != 'system' ORDER BY m.conversation_id, m.ts`)
      .values(now - EVERYONE, now) as [string, string, number][];
    const bots = new Set((this.d.db.query('SELECT id FROM identity WHERE is_bot = 1').all() as { id: string }[]).map((r) => r.id));
    const seen: Seen[] = [];
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j < rows.length && rows[j][0] === rows[i][0]) j++;
      const chat = rows.slice(i, j);
      if (!chat.some(([, a]) => bots.has(a))) for (const t of turnsOf(chat.map(([, a, ts]) => [a, ts]), self, now).turns) seen.push({ gap: t.gap, v: t.lat, w: 1 });
      i = j;
    }
    this.everyone = { at: now, seen };
    return seen;
  }

  private around(ref: string, now: number): { ids: string[]; hours: Set<number> } | null {
    const k = this.hoursKept.get(ref);
    if (k && Math.abs(now - k.at) < AROUND_KEEP) return k;
    const a = this.d.clocks.timesOf(ref, now - HISTORY - PROFILE_DAYS * DAY);
    if (!a) return null;
    if (this.hoursKept.size > 500) this.hoursKept.clear();
    const v = { at: now, ids: a.ids, hours: new Set(a.times.map((t) => Math.floor(t / HOUR))) };
    this.hoursKept.set(ref, v);
    return v;
  }

  /** When they are likely to answer you: your message waiting on them, else one sent now. Null for you, or nobody by that id. */
  answer(ref: string): P.TheirAnswerView | null {
    const now = this.now();
    const around = this.around(ref, now);
    if (!around) return null;
    const self = selfOf(this.d.db);
    const { ids, hours } = around;
    const rows = ids.length
      ? (this.d.db
          .query(
            `SELECT m.author_id, m.ts FROM participant p CROSS JOIN conversation c ON c.id = p.conversation_id AND c.shape = 'direct' CROSS JOIN message m ON m.conversation_id = c.id AND m.ts >= ? AND m.ts <= ? WHERE p.identity_id IN (${marks(ids.length)}) AND m.author_id IS NOT NULL AND m.kind != 'system' ORDER BY m.ts`,
          )
          .values(now - HISTORY, now, ...ids) as [string, number][])
      : [];
    const { turns, open } = turnsOf(rows, self, now);
    // Their usual day changes slowly: worked out once a week back, not once a message.
    const weekly = new Map<number, number[]>();
    const ratesAt = (t: number) => {
      const k = Math.floor(t / (7 * DAY));
      let r = weekly.get(k);
      if (!r) weekly.set(k, (r = rates(hours, k * 7 * DAY)));
      return r;
    };
    const theirs: Seen[] = turns.map((t) => ({ gap: t.gap, v: t.lat === null ? null : awake(ratesAt(t.t0), t.t0, t.lat), w: 2 ** (-(now - t.t0) / HALF_LIFE) }));
    const est = estimate(theirs, this.everyones(self), rates(hours, now), open.t0, open.gap, now);
    const first = turns[0]?.t0;
    return {
      waiting: open.waiting ? open.t0 : null,
      ...est,
      turns: turns.length,
      days: first === undefined ? 0 : Math.ceil((now - first) / DAY),
      own: Math.round(ownShare(theirs, open.gap) * 100) / 100,
    };
  }
}
