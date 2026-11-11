/**
 * Interaction features for triage (docs/research/notification-design.md §3): how you deal with a conversation and
 * an author, as numbers the decision model can weigh, each as of one moment and from only what came before it.
 *
 * Two halves, used alike by the live hub (triage.ts) and the replay (scripts/triage-replay.ts), so training never
 * sees a feature computed with hindsight:
 *  - `Interactions`, a fold over messages in time order: how often you write in a conversation, and after an author,
 *    within half an hour of their message (decayed, Beta-smoothed); whether you are in the middle of talking there.
 *  - `logFeatures`, read from the activity log at a moment: time since you last opened the conversation, another
 *    device in use right now, and how often you open its pushes.
 *
 * Every feature is centred, so 0 means "nothing known" and an unlearned weight changes nothing. Nothing here reads
 * what was said.
 */
import type { Database } from 'bun:sqlite';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A message counts as answered when you write in its conversation within this long. */
export const ANSWER_WINDOW = 30 * MIN;
/** You wrote there this recently: you are already in the conversation. */
export const ENGAGED = 15 * MIN;
/** Alternations (your message right after someone else's) are counted over this long. */
export const ALTERNATION_WINDOW = 30 * MIN;
/** Rates lose half their weight in a month, as in attention.ts. */
export const RATE_HALF_LIFE = 30 * DAY;
/** A visit on any device that was in use this recently: you are at a screen. */
export const DEVICE_ACTIVE = 2 * MIN;
/** Rates start from this many messages' worth of a prior: a new conversation sits at the prior. */
const PRIOR_WEIGHT = 2;
/** The prior chance you answer a message from someone else: logit 0 for a rate of it. */
export const ANSWER_PRIOR = 0.05;
/** An opening: someone else's message after this long without one in its conversation. */
export const OPENING_LULL = 5 * MIN;
/** An opening counts as answered when you write there within this long. */
export const OPENING_ANSWER = 3 * HOUR;
/** Openings' worth of "not answered" every conversation starts with: a new one sits at 0. */
export const OPENING_PRIOR = 5;
/** The prior chance you open a push, and its weight. */
export const OPEN_PRIOR = 0.3;
/** Longest gap that still counts for time since you last looked: 30 days. */
const SINCE_CAP = 30 * 24;

/** The numeric features, by name. Names are `kind:detail`; learn.ts gives each kind its own regularisation. */
export type NumericFeatures = Record<string, number>;

export interface InteractMessage {
  conv: string;
  ts: number;
  /** The author's person, else identity. */
  author: string | null;
  mine: boolean;
}

/** Decayed counts: messages and how many of them you answered, as of `at`. */
interface Rate {
  at: number;
  n: number;
  k: number;
}

interface Pending {
  conv: string;
  author: string | null;
  ts: number;
  done: boolean;
}

interface Opening {
  conv: string;
  ts: number;
  done: boolean;
}

interface ConvState {
  rate: Rate;
  pending: Pending[];
  /** Openings (OPENING_LULL) and how many of them you answered, decayed; those still waiting; the last message of anyone's. */
  open: Rate;
  openings: Opening[];
  lastAny: number | null;
  lastOwn: number | null;
  lastOther: number | null;
  /** Times of your messages that followed someone else's, newest last. */
  alternations: number[];
}

const decay = (from: number, to: number) => 2 ** (-(to - from) / RATE_HALF_LIFE);

function add(r: Rate, when: number, answered: boolean) {
  let w = 1;
  if (when >= r.at) {
    const f = decay(r.at, when);
    r.n *= f;
    r.k *= f;
    r.at = when;
  } else w = decay(when, r.at);
  r.n += w;
  if (answered) r.k += w;
}

const logit = (p: number) => Math.log(p / (1 - p));
const clip = (x: number, lo = -8, hi = 8) => Math.max(lo, Math.min(hi, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** A Beta-smoothed rate as log-odds against its prior: 0 with nothing to go on. */
export function rateLogit(k: number, n: number, prior: number, weight = PRIOR_WEIGHT): number {
  return r3(clip(logit((k + prior * weight) / (n + weight)) - logit(prior)));
}

/** Hours since, squashed: log(1 + hours), capped at 30 days; never seen is the cap. */
export const sinceScale = (ms: number | null) => r3(Math.log1p(Math.min(SINCE_CAP, ms === null ? SINCE_CAP : Math.max(0, ms) / HOUR)));

/**
 * The fold. Feed it every message in time order (`message`), then ask it about a moment (`features`). A message
 * from someone else waits until you write in its conversation (answered, if within ANSWER_WINDOW) or the window
 * passes (not answered); until then it counts for nothing, so a rate never includes what was not yet known.
 */
export class Interactions {
  private convs = new Map<string, ConvState>();
  private authors = new Map<string, Rate>();
  private queue: Pending[] = [];
  private head = 0;
  private openQueue: Opening[] = [];
  private openHead = 0;
  /** The latest time seen. */
  clock = 0;

  private conv(id: string): ConvState {
    let s = this.convs.get(id);
    if (!s) this.convs.set(id, (s = { rate: { at: 0, n: 0, k: 0 }, pending: [], open: { at: 0, n: 0, k: 0 }, openings: [], lastAny: null, lastOwn: null, lastOther: null, alternations: [] }));
    return s;
  }

  private settle(p: Pending, answered: boolean) {
    if (p.done) return;
    p.done = true;
    add(this.conv(p.conv).rate, p.ts, answered);
    if (p.author) {
      let a = this.authors.get(p.author);
      if (!a) this.authors.set(p.author, (a = { at: 0, n: 0, k: 0 }));
      add(a, p.ts, answered);
    }
  }

  /** Everything still waiting from before `t - ANSWER_WINDOW` went unanswered. */
  advance(t: number) {
    if (t > this.clock) this.clock = t;
    const q = this.queue;
    while (this.head < q.length && q[this.head].ts < t - ANSWER_WINDOW) this.settle(q[this.head++], false);
    this.advanceOpenings(t);
    if (this.head > 4096 && this.head * 2 > q.length) {
      this.queue = q.slice(this.head);
      this.head = 0;
    }
  }

  private settleOpening(o: Opening, answered: boolean) {
    if (o.done) return;
    o.done = true;
    const s = this.conv(o.conv);
    add(s.open, o.ts, answered);
    // Settled by time: it no longer waits for your next message there.
    if (!answered && s.openings[0] === o) s.openings.shift();
  }

  /** Openings from before `t - OPENING_ANSWER` went unanswered. */
  private advanceOpenings(t: number) {
    const q = this.openQueue;
    while (this.openHead < q.length && q[this.openHead].ts < t - OPENING_ANSWER) this.settleOpening(q[this.openHead++], false);
    if (this.openHead > 4096 && this.openHead * 2 > q.length) {
      this.openQueue = q.slice(this.openHead);
      this.openHead = 0;
    }
  }

  message(m: InteractMessage) {
    const late = m.ts < this.clock - ANSWER_WINDOW;
    this.advance(m.ts);
    const s = this.conv(m.conv);
    const lull = s.lastAny === null || m.ts - s.lastAny > OPENING_LULL;
    if (m.ts > (s.lastAny ?? 0)) s.lastAny = m.ts;
    if (m.mine) {
      if (!late) {
        for (const p of s.pending) this.settle(p, m.ts - p.ts <= ANSWER_WINDOW && m.ts >= p.ts);
        s.pending = [];
        for (const o of [...s.openings]) this.settleOpening(o, m.ts >= o.ts && m.ts - o.ts <= OPENING_ANSWER);
        s.openings = [];
      }
      if (s.lastOther !== null && (s.lastOwn === null || s.lastOther > s.lastOwn) && m.ts >= s.lastOther) {
        s.alternations.push(m.ts);
        if (s.alternations.length > 50) s.alternations.splice(0, 25);
      }
      s.lastOwn = Math.max(s.lastOwn ?? 0, m.ts);
      return;
    }
    s.lastOther = Math.max(s.lastOther ?? 0, m.ts);
    // History arriving late (a backfill) says nothing about how you answer now.
    if (late) return;
    // An opening: the first message after a lull, when you were not already writing there.
    if (lull && !(s.lastOwn !== null && m.ts >= s.lastOwn && m.ts - s.lastOwn <= ENGAGED)) {
      const o: Opening = { conv: m.conv, ts: m.ts, done: false };
      s.openings.push(o);
      this.openQueue.push(o);
    }
    const p: Pending = { conv: m.conv, author: m.author, ts: m.ts, done: false };
    s.pending.push(p);
    this.queue.push(p);
  }

  /**
   * How often you answer an opening in a conversation, as of `t`: answered / (openings + OPENING_PRIOR), both
   * decayed. 0 where you never wrote. Only openings whose three hours have passed, or that you answered, count.
   */
  answerRate(conv: string, t: number): number {
    this.advance(t);
    const r = this.convs.get(conv)?.open;
    if (!r || !r.k) return 0;
    const f = decay(r.at, Math.max(t, r.at));
    return (r.k * f) / (r.n * f + OPENING_PRIOR);
  }

  /** You last wrote in a conversation, or null. */
  lastOwn(conv: string): number | null {
    return this.convs.get(conv)?.lastOwn ?? null;
  }

  /**
   * The features for a message from `author` in `conv` at `t`, from what was folded before it:
   * - `rr:conv`, `rr:author`: how often you answer here, and after this author anywhere (log-odds against 5%);
   * - `engaged`: you wrote here in the last 15 minutes; `alt`: how many times you answered someone here in the last
   *   half hour, log(1 + n).
   */
  features(conv: string, author: string | null, t: number): NumericFeatures {
    this.advance(t);
    const s = this.convs.get(conv);
    const at = (r: Rate | undefined) => {
      if (!r) return { n: 0, k: 0 };
      const f = decay(r.at, Math.max(t, r.at));
      return { n: r.n * f, k: r.k * f };
    };
    const c = at(s?.rate);
    const a = at(author ? this.authors.get(author) : undefined);
    const engaged = s?.lastOwn != null && s.lastOwn <= t && t - s.lastOwn <= ENGAGED ? 1 : 0;
    const alt = s ? s.alternations.filter((x) => x <= t && t - x <= ALTERNATION_WINDOW).length : 0;
    return {
      'rr:conv': rateLogit(c.k, c.n, ANSWER_PRIOR),
      'rr:author': author ? rateLogit(a.k, a.n, ANSWER_PRIOR) : 0,
      engaged,
      alt: r3(Math.log1p(alt)),
    };
  }
}

/** Identities that are you: the accounts' own, and the identities of the person marked as you. */
export const SELF_SQL = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1)`;

/**
 * What the activity log says at `t` about a conversation (and, for a DM, its peer `person`):
 * - `since:seen`: log(1 + hours) since you last opened it or wrote there (`lastOwn`), capped at 30 days, less a day's
 *   worth, so a conversation looked at a day ago is 0;
 * - `device:active`: a visit on any device was in use in the last two minutes;
 * - `open:rate`: how often you opened its pushes within an hour (log-odds against 30%), from pushes at least an hour old.
 */
export function logFeatures(db: Database, conv: string, person: string | null, t: number, lastOwn: number | null): NumericFeatures {
  const v = db
    .query(
      `SELECT MAX(start_at) AS at FROM visit WHERE start_at <= ? AND view IN ('conversation', 'person')
         AND (conversation_id = ? OR (? IS NOT NULL AND person_id = ?))`,
    )
    .get(t, conv, person, person) as { at: number | null } | null;
  const seen = Math.max(v?.at ?? 0, lastOwn ?? 0) || null;
  const active = db.query('SELECT 1 FROM visit WHERE end_at >= ? AND start_at <= ? LIMIT 1').get(t - DEVICE_ACTIVE, t) ? 1 : 0;
  const pushes = db
    .query(
      `SELECT n.sent_at, n.tapped_at,
              (SELECT MIN(v.start_at) FROM visit v WHERE v.conversation_id = n.conversation_id AND v.start_at >= n.sent_at AND v.start_at <= n.sent_at + ${HOUR}) AS opened
       FROM notification n WHERE n.kind = 'message' AND n.conversation_id = ? AND n.sent_at <= ? ORDER BY n.sent_at DESC LIMIT 200`,
    )
    .all(conv, t - HOUR) as { sent_at: number; tapped_at: number | null; opened: number | null }[];
  const opened = pushes.filter((p) => (p.tapped_at != null && p.tapped_at <= p.sent_at + HOUR) || p.opened != null).length;
  return {
    'since:seen': r3(sinceScale(seen === null ? null : t - seen) - sinceScale(DAY)),
    'device:active': active,
    'open:rate': rateLogit(opened, pushes.length, OPEN_PRIOR),
  };
}

/** The peer person of a DM, else null. */
export function dmPeer(db: Database, conv: string): string | null {
  const r = db
    .query(
      `SELECT i.person_id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id
       LEFT JOIN person p ON p.id = i.person_id
       WHERE c.id = ? AND c.shape = 'direct' AND i.person_id IS NOT NULL AND COALESCE(p.is_self, 0) = 0 AND i.id NOT IN ${SELF_SQL} LIMIT 1`,
    )
    .get(conv) as { person_id: string } | null;
  return r?.person_id ?? null;
}

/**
 * The live hub's fold: catches up from the database by row order before each decision. The first call folds the
 * last two months, about a second on a busy hub.
 */
export class InteractionLog {
  readonly fold = new Interactions();
  private cursor = -1;
  private peers = new Map<string, string | null>();

  constructor(private db: Database) {}

  catchUp(now = Date.now()) {
    const db = this.db;
    if (this.cursor < 0) {
      const since = now - 2 * RATE_HALF_LIFE;
      const top = db.query('SELECT MAX(rowid) AS r FROM message').get() as { r: number | null };
      for (const m of db
        .query(
          `SELECT m.conversation_id AS conv, m.ts, COALESCE(i.person_id, m.author_id) AS author, m.author_id IN ${SELF_SQL} AS mine
           FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.ts >= ? AND m.deleted = 0 AND m.rowid <= ? ORDER BY m.ts`,
        )
        .iterate(since, top.r ?? 0) as Iterable<InteractMessage>)
        this.fold.message({ ...m, mine: !!m.mine });
      this.cursor = top.r ?? 0;
    }
    for (;;) {
      const rows = db
        .query(
          `SELECT m.rowid AS rid, m.conversation_id AS conv, m.ts, m.deleted, COALESCE(i.person_id, m.author_id) AS author, m.author_id IN ${SELF_SQL} AS mine
           FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.rowid > ? ORDER BY m.rowid LIMIT 2000`,
        )
        .all(this.cursor) as (InteractMessage & { rid: number; deleted: number })[];
      for (const m of rows) if (!m.deleted) this.fold.message({ conv: m.conv, ts: m.ts, author: m.author, mine: !!m.mine });
      if (rows.length) this.cursor = rows[rows.length - 1].rid;
      if (rows.length < 2000) break;
    }
  }

  /** Every interaction feature for a message from `author` in `conv` at `t`. */
  features(conv: string, author: string | null, t: number): NumericFeatures {
    this.catchUp();
    if (!this.peers.has(conv)) this.peers.set(conv, dmPeer(this.db, conv));
    if (this.peers.size > 5000) this.peers.clear();
    return { ...this.fold.features(conv, author, t), ...logFeatures(this.db, conv, this.peers.get(conv) ?? null, t, this.fold.lastOwn(conv)) };
  }
}
