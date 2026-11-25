/**
 * Check-ins (docs/notifications.md, "Asking, without nagging"): questions about single notifications, waiting on the
 * Notification calibration page until you get to them, never a push and never a card in your way. "This sounded at
 * 09:12: worth it, could have waited, shouldn't have reached me?" and "This stayed quiet: wish I'd known sooner, or
 * fine where it was?", each with where and how you came across it (seen.ts).
 *
 *  - Up to three put on the page a day (Settings: never, rarely = one, up to three); one from each side, sounded and
 *    stayed quiet. "Ask me less" halves the rate; three explicit Skips in a row pause it for a week. A question left
 *    waiting is not a skip.
 *  - They wait: at most QUEUE_CAP open at once (the oldest go past it), none older than EXPIRE_AFTER (memory fades).
 *    Each keeps when it was asked and when it was answered, and the page shows its age.
 *  - Half are picked at random among the day's deliveries of that side, with the chance each had kept
 *    (`propensity`), so the scorecard's rates are honest when weighted back by it (scorecard.ts); half where the
 *    model is least sure (a sound whose want is nearest even odds, a quiet one nearest the sound line), so each
 *    answer teaches the most. Dropping unanswered ones does not change those chances: it is the same for every pick.
 *  - For you asks about one card a day, "Glad I saw this / Not for me", picked at random among the page's first ten;
 *    it waits on the same page.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { bandOf } from '@dither-chat/protocol';
import { TIER_BAND } from './loudness.ts';
import { seenContext } from './seen.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A fresh id: `chk_…` for questions, `ans_…` for answers. */
export const newId = (prefix: string) => `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;

/** It sounded where it went: a push of it played a sound (not merely decided an alert: a burst, a computer in use or a watched chat keeps it silent). */
const SOUNDED = `EXISTS (SELECT 1 FROM notification n WHERE n.message_id = t.message_id AND n.alert = 1)`;

/** Questions a day by setting, before "Ask me less". */
const QUOTA: Record<P.AttentionPrefs['ask'], number> = { never: 0, rarely: 1, often: 3 };
/** Skips in a row that pause the check-ins, and for how long. */
export const SKIPS_TO_PAUSE = 3;
export const PAUSE = 7 * DAY;
/** A delivery is asked about once it is this old (you've had time to see it), and while it is younger than a day. */
const SETTLE = 20 * MIN;
/** Questions are picked again at most this often, so they come spread over the day. */
const PICK_EVERY = 2 * HOUR;
/** Open questions kept on the page at most; past it, the oldest go. */
export const QUEUE_CAP = 20;
/** An open question older than this goes: you would hardly remember the moment. */
export const EXPIRE_AFTER = 14 * DAY;
/** An answer this late (after the message came) or sooner counts in full. */
const FRESH_FOR = DAY;
/** The least a late answer counts, at EXPIRE_AFTER and beyond. */
export const LATE_FLOOR = 0.5;

/**
 * How much an answer counts in what is learned, by how long after the message it came: memory of the moment fades.
 * Full within a day, then down in a straight line to LATE_FLOOR at EXPIRE_AFTER. The scorecard's rates leave it out
 * (they count each answer once, weighted only by the chance its question had).
 */
export function lateWeight(delay: number): number {
  if (!(delay > FRESH_FOR)) return 1;
  return Math.max(LATE_FLOOR, 1 - ((1 - LATE_FLOOR) * (delay - FRESH_FOR)) / (EXPIRE_AFTER - FRESH_FOR));
}

/** Open: not answered, skipped or dropped. */
const OPEN = `answer IS NULL AND skipped = 0 AND expired_at IS NULL`;
/** The rate never falls below this: "Ask me less" four times is about one question a week. */
const MIN_RATE = 1 / 8;

export interface CheckinState {
  rate: number;
  skipsInRow: number;
  pausedUntil: number | null;
  lastPick: number | null;
  /** The day the leftover chance was drawn, and whether it came up. */
  extraDay?: number | null;
  extra?: boolean;
}
const START: CheckinState = { rate: 1, skipsInRow: 0, pausedUntil: null, lastPick: null };

export class Checkins {
  /** Random numbers, for the random half (tests set their own). */
  random: () => number = Math.random;

  constructor(
    private db: Database,
    private meta: { get: () => CheckinState | null; set: (s: CheckinState) => void },
    private describe: (messageId: string) => { title: string; preview: string; conversationId: string | null; network?: string | null; shape?: string | null } | null,
  ) {}

  state(): CheckinState {
    return { ...START, ...(this.meta.get() ?? {}) };
  }

  /** Today's quota, after the setting and "Ask me less". */
  quota(prefs: P.AttentionPrefs, now = Date.now()): number {
    const base = QUOTA[prefs.ask] ?? 0;
    if (!base) return 0;
    const want = base * this.state().rate;
    const whole = Math.floor(want + 1e-9);
    const part = want - whole;
    if (part < 1e-9) return whole;
    // The part of a question left over is a chance a day, drawn once a day: at a rate of an eighth, about one a week.
    const st = this.state();
    const day = this.dayStart(now);
    if (st.extraDay !== day) this.meta.set({ ...st, extraDay: day, extra: this.random() < part });
    return whole + (this.state().extra ? 1 : 0);
  }

  private dayStart(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Asked today (For you's card aside, which has its own one a day). */
  askedToday(now: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM checkin WHERE created_at >= ? AND side != 'foryou'`).get(this.dayStart(now)) as Row).n;
  }
  answeredToday(now: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM checkin WHERE created_at >= ? AND answer IS NOT NULL`).get(this.dayStart(now)) as Row).n;
  }

  /**
   * Put new questions on the page when the day's quota and the pace allow, and drop the ones that waited too long or
   * fall past the cap. Called when the app asks how many wait (a look) and on the hub's hourly round; nothing pushes.
   */
  fill(prefs: P.AttentionPrefs, now = Date.now()): void {
    const st = this.state();
    const paused = st.pausedUntil !== null && st.pausedUntil > now;
    if (!paused && QUOTA[prefs.ask]) {
      const left = this.quota(prefs, now) - this.askedToday(now);
      if (left > 0 && (st.lastPick === null || now - st.lastPick >= PICK_EVERY || now < st.lastPick)) {
        const asked = this.db.query(`SELECT side, arm FROM checkin WHERE created_at >= ?`).all(this.dayStart(now)) as Row[];
        const sides: ('sounded' | 'quiet')[] = (['sounded', 'quiet'] as const).filter((s) => !asked.some((a) => a.side === s));
        // One question today: either side, at even odds, so "Rarely" asks about quiet ones too.
        if (left === 1 && sides.length === 2 && this.random() < 0.5) sides.reverse();
        // A third question goes to whichever side the day has more of.
        if (!sides.length) sides.push(this.count('sounded', now) > this.count('quiet', now) / 20 ? 'sounded' : 'quiet');
        let picked = 0;
        for (const side of sides.slice(0, left)) {
          // The arm is a fair coin every time, so the stored chance of a random pick (a half, then one of n) holds.
          const arm: 'random' | 'unsure' = this.random() < 0.5 ? 'random' : 'unsure';
          if (this.pick(side, arm, now)) picked++;
        }
        if (picked) this.meta.set({ ...this.state(), lastPick: now });
      }
    }
    this.expire(now);
  }

  /** Drop open questions older than EXPIRE_AFTER, then the oldest past QUEUE_CAP. Not skips: nothing pauses. */
  expire(now = Date.now()): number {
    let n = this.db.query(`UPDATE checkin SET expired_at = ? WHERE ${OPEN} AND created_at < ?`).run(now, now - EXPIRE_AFTER).changes;
    const open = (this.db.query(`SELECT COUNT(*) AS n FROM checkin WHERE ${OPEN}`).get() as Row).n as number;
    if (open > QUEUE_CAP)
      n += this.db.query(`UPDATE checkin SET expired_at = ? WHERE id IN (SELECT id FROM checkin WHERE ${OPEN} ORDER BY created_at, id LIMIT ?)`).run(now, open - QUEUE_CAP).changes;
    return n;
  }

  /** How many wait on the page: the badge's count. */
  pendingCount(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM checkin WHERE ${OPEN}`).get() as Row).n;
  }

  /** The questions waiting, newest first (the freshest memory first), each with where you came across it. */
  pending(now = Date.now()): P.CheckinView[] {
    const rows = this.db.query(`SELECT * FROM checkin WHERE ${OPEN} ORDER BY created_at DESC, id LIMIT ?`).all(QUEUE_CAP) as Row[];
    return rows.map((r) => this.view(r, now)).filter((v): v is P.CheckinView => !!v);
  }

  /** Fill, then what waits: the page's list. */
  due(prefs: P.AttentionPrefs, now = Date.now()): P.CheckinView[] {
    this.fill(prefs, now);
    return this.pending(now);
  }

  private candidates(side: 'sounded' | 'quiet', now: number): string {
    // Others' messages decided in the last day and settled, not silenced, with a loudness, not asked about already.
    return `FROM triage t INDEXED BY triage_created JOIN message m ON m.id = t.message_id
      WHERE t.created_at > ${now - DAY} AND t.created_at < ${now - SETTLE}
        AND t.decision != 'silent' AND ${side === 'sounded' ? SOUNDED : `NOT ${SOUNDED}`}
        AND t.loud IS NOT NULL AND m.author_id NOT IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM checkin c WHERE c.message_id = t.message_id)`;
  }

  private count(side: 'sounded' | 'quiet', now: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n ${this.candidates(side, now)}`).get() as Row).n;
  }

  /** Pick one of a side's deliveries, by an arm, and keep it with the chance it had. */
  pick(side: 'sounded' | 'quiet', arm: 'random' | 'unsure', now = Date.now()): string | null {
    const n = this.count(side, now);
    if (!n) return null;
    let row: Row | null;
    if (arm === 'random') {
      const k = Math.min(n - 1, Math.floor(this.random() * n));
      row = this.db.query(`SELECT t.message_id, t.decision, t.loud ${this.candidates(side, now)} ORDER BY t.created_at LIMIT 1 OFFSET ?`).get(k) as Row | null;
    } else {
      // Least sure: a sound whose want is nearest even odds; a quiet one whose loudness is nearest the sound line.
      const order = side === 'sounded' ? `ABS(COALESCE(json_extract(t.loud_view, '$.parts.want'), 0.5) - 0.5)` : `ABS(t.loud - 80)`;
      row = this.db.query(`SELECT t.message_id, t.decision, t.loud ${this.candidates(side, now)} ORDER BY ${order}, t.created_at DESC LIMIT 1`).get() as Row | null;
    }
    if (!row) return null;
    const id = newId('chk');
    // The chance of this one: the arm (a half), then one of n at random; the unsure arm's pick is the arm's alone.
    const propensity = arm === 'random' ? 0.5 / n : 0.5;
    this.db
      .query(`INSERT INTO checkin (id, side, message_id, arm, propensity, pool, live_band, shadow_band, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, side, row.message_id, arm, propensity, n, TIER_BAND[row.decision as P.NotifyTier] ?? null, row.loud != null ? bandOf(row.loud) : null, now);
    return id;
  }

  /** For you's one card a day: among the page's first ten, at random. Returns the check-in id, or null. */
  pickForYou(items: { id: string; messageId: string }[], prefs: P.AttentionPrefs, now = Date.now()): { checkinId: string; itemId: string } | null {
    const st = this.state();
    if (!QUOTA[prefs.ask] || (st.pausedUntil !== null && st.pausedUntil > now) || !items.length) return null;
    if (this.db.query(`SELECT 1 FROM checkin WHERE side = 'foryou' AND created_at >= ?`).get(this.dayStart(now))) return null;
    // "Ask me less" thins this as it does the rest.
    if (this.random() >= st.rate) return null;
    const pool = items.slice(0, 10);
    const it = pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
    const id = newId('chk');
    this.db.query(`INSERT INTO checkin (id, side, message_id, item_id, arm, propensity, pool, created_at) VALUES (?, 'foryou', ?, ?, 'random', ?, ?, ?)`).run(id, it.messageId, it.id, st.rate / pool.length, pool.length, now);
    return { checkinId: id, itemId: it.id };
  }

  /** An answer to a check-in; a skip counts toward the pause. Returns the row, or null when there is no such question. */
  answer(id: string, answer: string | null, now = Date.now()): Row | null {
    const r = this.db.query('SELECT * FROM checkin WHERE id = ?').get(id) as Row | null;
    if (!r) return null;
    const st = this.state();
    if (answer === null) {
      this.db.query('UPDATE checkin SET skipped = 1 WHERE id = ?').run(id);
      const skips = st.skipsInRow + 1;
      this.meta.set({ ...st, skipsInRow: skips >= SKIPS_TO_PAUSE ? 0 : skips, pausedUntil: skips >= SKIPS_TO_PAUSE ? now + PAUSE : st.pausedUntil });
    } else {
      this.db.query('UPDATE checkin SET answer = ?, answered_at = ?, skipped = 0 WHERE id = ?').run(answer, now, id);
      this.meta.set({ ...st, skipsInRow: 0 });
    }
    return this.db.query('SELECT * FROM checkin WHERE id = ?').get(id) as Row;
  }

  /** "Ask me less": half as many from now on. What already waits stays, to answer or leave. */
  askLess() {
    const st = this.state();
    this.meta.set({ ...st, rate: Math.max(MIN_RATE, st.rate / 2) });
  }

  private view(r: Row, now: number): P.CheckinView | null {
    const d = this.describe(r.message_id);
    if (!d) return null;
    const m = this.db.query('SELECT ts, conversation_id FROM message WHERE id = ?').get(r.message_id) as Row | null;
    if (!m) return null;
    const answeredAfter = this.db
      .query(`SELECT MIN(ts) AS ts FROM message WHERE conversation_id = ? AND ts > ? AND author_id IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`)
      .get(m.conversation_id, m.ts) as Row;
    const note = r.side === 'quiet' && answeredAfter?.ts ? `you answered it ${ago(answeredAfter.ts - m.ts)} later` : r.side === 'quiet' ? 'it stayed quiet' : undefined;
    void now;
    const context = seenContext(this.db, r.message_id, { title: d.title, preview: d.preview, at: m.ts, network: d.network ?? null, shape: d.shape ?? null, conversationId: d.conversationId });
    if (r.side === 'foryou' && context.forYou && context.forYou.shownAt === null) context.unknown.unshift("No device said this card was on screen on For you, so we don't know if you saw it there.");
    return { id: r.id, side: r.side, messageId: r.message_id, conversationId: d.conversationId, title: d.title, preview: d.preview, at: m.ts, askedAt: r.created_at, ...(note ? { note } : {}), context };
  }
}

function ago(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}
