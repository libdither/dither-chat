/**
 * The calibration feed (docs/notifications.md, "The calibration feed"): the one or two notifications a day most worth
 * asking about, each as it looked, with the three answers you'd tap in one (Sound / Show / Inbox) and what the model
 * gave each. Nothing here pushes: the cards wait on the Notification calibration page until you get to it.
 *
 * Only notifications that reached a device, and sounds the model would have made but did not, are considered: a
 * message that only ever sat in the inbox is not asked about. Each is put on it once what you did with it is known
 * (SETTLE), and scored:
 *
 *   p        = the model's chance of each answer: its loudness, blurred by how few answers it has about the person or
 *              chat (sigmaOf), cut at the bands (inbox below 30, sound from 80)
 *   said     = the band the model gave it
 *   you      = what you did, from strong signals only: an answer or mark of yours on it, a tap on its notification
 *              (within 10 minutes Sound, later Show), a reply in its chat within 5 minutes (Sound), a swipe away
 *              unopened (Inbox). Opening the chat later says nothing about one message: with none of these, null.
 *   regret   = COST[said][you] · (1 − p(you)); with `you` unknown, half the model's own expected cost Σ p(a)·COST[said][a]
 *   worth    = regret × ½^(age / 1 day)
 *
 * COST: a sound you needed and did not get costs most (1), a sound you did not want next (0.5, 0.6), a silent mix-up
 * (shown when the inbox would do, or the other way) barely (0.1, 0.15).
 *
 * No cards at all until the model has enough in-place signals to be sure of anything (FITTED_AT, from answers and
 * marks given in place); then at most CARDS_A_DAY in any 24 hours, the most worth asking, over CARD_OVER. Every other
 * item is kept as a row that is never shown, so it is scored once and may still be picked later while it is fresh. A
 * past answer comes back once, a day later, when the model had given it under 20%.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { bandOf, calAnswerOf } from '@dither-chat/protocol';
import { carrier, seenContext } from './seen.ts';

type Row = Record<string, any>;
type Trio = P.Trio;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A fresh id: `fd_…` for feed items, `ans_…` for answers. */
export const newId = (prefix: string) => `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;

/** A tap on its notification within this is Sound, later Show. */
export const TAP_SOUND_WITHIN = 10 * MIN;
/** A reply of yours in its chat within this is Sound. */
export const REPLY_WITHIN = 5 * MIN;
/** A message goes on the feed once this has passed, or once a strong signal is known. */
const SETTLE = 3 * HOUR;
/** Worth asking halves every this long: you remember the moment less each day. */
export const HALF_LIFE = DAY;
/** Surprise is counted up to this many bits (shown, not ranked by). */
const MAX_BITS = 5;
/** Cards are picked among those worth asking over this: a silent mix-up (0.15 at most) never is. */
export const CARD_OVER = 0.3;
/** Cards in any 24 hours, by your setting (Settings: how often it asks). */
export const CARDS_A_DAY: Record<P.AttentionPrefs['ask'], number> = { never: 0, rarely: 1, often: 2 };
/**
 * In-place signals (answers and marks given on a message, a notification, a notice or mail; not the feed's own) the
 * model needs before any card: at 20, a rate it learns is known to within ±0.22 (95%, the worst case p = ½), enough to
 * tell "mostly wanted" (75%) from "mostly not" (25%); below it the feed would only ask what the model cannot yet use.
 */
export const FITTED_AT = 20;
/** A card waits this long after it was picked; then it goes (you would hardly remember the moment). */
const CARD_FOR = 2 * DAY;
/** With nothing you did known, an item counts this share of its expected regret. */
export const UNKNOWN_SHARE = 0.5;
/** A past answer comes back once when the model had given it under this, this long after. */
const RETURN_UNDER = 0.2;
export const RETURN_AFTER = DAY;
/** Nothing older than this is learned in full (lateWeight); answered items are kept twice this for the scorecard. */
export const EXPIRE_AFTER = 14 * DAY;
/** Messages are put on the feed within this long of coming, at most POOL at a time, at most once an hour. */
const WINDOW = 3 * DAY;
const POOL = 400;
const FILL_EVERY = HOUR;
/** An answer this late (after the message came) or sooner counts in full; then down to LATE_FLOOR at EXPIRE_AFTER. */
const FRESH_FOR = DAY;
export const LATE_FLOOR = 0.5;

/**
 * How much an answer counts in what is learned, by how long after the message it came: memory of the moment fades.
 * Full within a day, then down in a straight line to LATE_FLOOR at EXPIRE_AFTER.
 */
export function lateWeight(delay: number): number {
  if (!(delay > FRESH_FOR)) return 1;
  return Math.max(LATE_FLOOR, 1 - ((1 - LATE_FLOOR) * (delay - FRESH_FOR)) / (EXPIRE_AFTER - FRESH_FOR));
}

/**
 * The weight an answer gets for how it was drawn: a card drawn with chance c counts 0.5/c, between 1 and 3. Cards are
 * picked outright now (chance 1, weight 1); cards drawn at random before keep theirs.
 */
export function ipsWeight(chance: number | null | undefined): number {
  if (typeof chance !== 'number' || !(chance > 0)) return 1;
  return Math.max(1, Math.min(3, 0.5 / chance));
}

// ------------------------------------------------------------------ the numbers

const erf = (x: number) => {
  // Abramowitz and Stegun 7.1.26: within 1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const normal = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const ANSWERS: readonly P.CalAnswer[] = ['sound', 'show', 'inbox'];
const ANSWER_I: Record<P.CalAnswer, number> = { sound: 0, show: 1, inbox: 2 };

/** How few answers are behind it, 1 with none, a half at 5, a seventh at 30. */
export const fewOf = (n: number) => 1 / (1 + Math.max(0, n) / 5);
/** How far the model's loudness may be off, in points of the scale: wide with no answers, narrow with many. */
export const sigmaOf = (n: number) => 4 + 26 * fewOf(n);

/** The model's chance of each answer (Sound, Show, Inbox) from its loudness: blurred by sigmaOf, cut at 30 and 80. */
export function chances(loud: number, n: number): Trio {
  const s = sigmaOf(n);
  const inbox = normal((30 - loud) / s);
  const sound = 1 - normal((80 - loud) / s);
  return [r3(sound), r3(Math.max(0, 1 - inbox - sound)), r3(inbox)];
}

/** How unsure each chance is: a binomial spread over the answers behind it. */
const spreadsOf = (p: Trio, n: number): Trio => p.map((x) => r3(Math.sqrt((x * (1 - x)) / (Math.max(0, n) + 2)))) as Trio;

/** How spread the chances are: their entropy over its most, 0 (sure of one) to 1 (even). */
function spread(p: Trio): number {
  const h = p.reduce((s, x) => (x > 0 ? s - x * Math.log2(x) : s), 0);
  return Math.max(0, Math.min(1, h / Math.log2(3)));
}

/** −log2 of the chance it gave what you did, at most MAX_BITS. */
export const surpriseOf = (p: Trio, you: P.CalAnswer) => r3(Math.min(MAX_BITS, -Math.log2(Math.max(2 ** -MAX_BITS, p[ANSWER_I[you]]))));
export const unsureOf = (p: Trio, n: number) => r3(spread(p) * fewOf(n));

/**
 * What a wrong band costs, by what the model said (rows) and what you needed (columns): a sound you needed and did
 * not get most, a sound you did not want next, a silent mix-up barely.
 */
export const COST: Record<P.CalAnswer, Record<P.CalAnswer, number>> = {
  sound: { sound: 0, show: 0.5, inbox: 0.6 },
  show: { sound: 1, show: 0, inbox: 0.1 },
  inbox: { sound: 1, show: 0.15, inbox: 0 },
};

/** Which kind of mistake it was: a sound missed, a sound not wanted, a silent mix-up, or none. */
export function costKind(said: P.CalAnswer, you: P.CalAnswer | null): P.CalCost {
  if (!you || said === you) return null;
  if (you === 'sound') return 'missed';
  if (said === 'sound') return 'unwanted';
  return 'mixup';
}

/** Cost-weighted regret (above): the cost of the model's band against what you did, by how little it expected it. */
export function regretOf(p: Trio, said: P.CalAnswer, you: P.CalAnswer | null): number {
  if (you) return r3(COST[said][you] * (1 - p[ANSWER_I[you]]));
  return r3(UNKNOWN_SHARE * ANSWERS.reduce((t, a) => t + p[ANSWER_I[a]] * COST[said][a], 0));
}

/** Worth asking: the regret, fading by half every HALF_LIFE. */
export const worthAsking = (regret: number, age: number) => r3(regret * 0.5 ** (Math.max(0, age) / HALF_LIFE));

/** The strong signals about one message: each a delay after it came, or null. */
interface Signals {
  /** An answer or mark of yours on it, as the band it asks for. */
  said?: P.CalAnswer | null;
  tapped: number | null;
  dismissed: number | null;
  replied: number | null;
}

/** What you did, from strong signals only (above); null when none says. */
export function youOf(s: Signals): P.CalAnswer | null {
  if (s.said) return s.said;
  if (s.tapped !== null) return s.tapped <= TAP_SOUND_WITHIN ? 'sound' : 'show';
  if (s.replied !== null && s.replied <= REPLY_WITHIN) return 'sound';
  if (s.dismissed !== null) return 'inbox';
  return null;
}

/** One band louder or quieter than `b`. */
const step = (b: P.CalAnswer, by: 1 | -1): P.CalAnswer => ANSWERS[Math.max(0, Math.min(2, ANSWER_I[b] - by))];

/** An answer or mark given in place, as the band it asks for, given what was done (`did`). */
export function saidOf(answer: string, did: P.CalAnswer): P.CalAnswer | null {
  switch (answer) {
    case 'worth':
    case 'fine':
      return did;
    case 'sooner':
    case 'should_alert':
      return 'sound';
    case 'could_wait':
    case 'alert_wrong':
      return did === 'inbox' ? 'inbox' : 'show';
    case 'shouldnt':
    case 'less':
      return 'inbox';
    case 'louder':
      return step(did, 1);
    case 'quieter':
      return step(did, -1);
    // An old vote kept as a mark: its band.
    case 'sound':
    case 'show':
    case 'inbox':
      return answer;
    default:
      return null;
  }
}

const ago = (ms: number) => (ms < MIN ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < HOUR ? `${Math.round(ms / MIN)} min` : ms < DAY ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / DAY)} d`);

const SAID_WORDS: Record<string, string> = {
  worth: 'Worth it',
  fine: 'Fine where it was',
  sooner: "Wish I'd known sooner",
  could_wait: 'Could have waited',
  shouldnt: "Shouldn't have reached me",
  louder: 'Louder',
  quieter: 'Quieter',
  should_alert: 'Should have alerted',
  alert_wrong: 'Alert was wrong',
  less: 'Less like this',
};

// ------------------------------------------------------------------ the feed

/** What the model says of a message now (loudlearn.ts): its loudness with what is learned, and each part's points. */
interface FeedModel {
  loudNow(messageId: string): number | null;
  points(messageId: string): Record<'person' | 'chat' | 'topic' | 'wait' | 'moment', number> | null;
  /** In-place signals the model has learned from (FITTED_AT). */
  signals(now: number): number;
}

interface Described {
  title: string;
  preview: string;
  conversationId: string | null;
  network: string | null;
  shape: string | null;
  author: string | null;
  chat: string | null;
}

/** What happened to a message: what was done, whether it reached a device, what you did, the answers about its person and chat. */
interface Situation {
  did: P.CalAnswer;
  reached: boolean;
  held: boolean;
  you: P.CalAnswer | null;
  youWhat: string;
  answers: number;
}

interface Scored {
  r: Row;
  s: Situation;
  p: Trio;
  surprise: number;
  unsure: number;
  regret: number;
}

const SELF = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`;
/** Answers given in place: everything but the feed's own. */
export const IN_PLACE = `source != 'feed'`;

export class CalibrationFeed {
  private lastFill: number | null = null;

  constructor(
    private db: Database,
    private describe: (messageId: string) => Described | null,
    private model: FeedModel,
  ) {}

  /** What happened to a message, as the hub's own log says. */
  situation(messageId: string, conv: string, ts: number, author: string | null, loud: number, now: number): Situation {
    const db = this.db;
    const n = carrier(db, messageId, conv, ts);
    const did: P.CalAnswer = !n ? 'inbox' : n.alert === 1 ? 'sound' : 'show';
    const ev = (event: string) => (n ? ((db.query('SELECT MIN(at) AS at FROM notification_event WHERE notification_id = ? AND event = ?').get(n.id, event) as Row)?.at ?? null) : null) as number | null;
    const first = (...xs: (number | null | undefined)[]) => {
      const ok = xs.filter((x): x is number => typeof x === 'number');
      return ok.length ? Math.min(...ok) : null;
    };
    const reached = !!n && (n.accepted > 0 || n.delivered_at != null || n.shown_at != null || n.tapped_at != null || !!db.query(`SELECT 1 FROM notification_event WHERE notification_id = ? AND event IN ('delivered', 'shown', 'tapped', 'inapp') LIMIT 1`).get(n.id) || !!db.query('SELECT 1 FROM notification_device WHERE notification_id = ? AND ok = 1 LIMIT 1').get(n.id));
    const tapped = first(n?.tapped_at, ev('tapped'));
    const dismissed = first(n?.dismissed_at, ev('dismissed'));
    const ownReply = (db.query(`SELECT MIN(ts) AS at FROM message WHERE conversation_id = ? AND ts > ? AND ts <= ? AND author_id IN ${SELF}`).get(conv, ts, ts + REPLY_WITHIN) as Row)?.at as number | null;
    const replied = first(n?.replied_at, ownReply);
    // The latest answer or mark you gave on it in place (the feed's own aside).
    const a = db.query(`SELECT answer, at FROM attn_answer WHERE message_id = ? AND ${IN_PLACE} ORDER BY at DESC LIMIT 1`).get(messageId) as Row | null;
    const said = a ? saidOf(a.answer, did) : null;
    const d = (x: number | null) => (x === null ? null : Math.max(0, x - ts));
    const you = youOf({ said, tapped: d(tapped), dismissed: d(dismissed), replied: d(replied) });
    const youWhat =
      said ? `${SAID_WORDS[a!.answer] ?? 'Answered'}, you said`
      : tapped !== null ? `Tapped ${tapped - ts <= TAP_SOUND_WITHIN ? 'in' : 'after'} ${ago(tapped - ts)}`
      : replied !== null && replied - ts <= REPLY_WITHIN ? `Replied in ${ago(replied - ts)}`
      : dismissed !== null ? `Swiped away in ${ago(dismissed - ts)}`
      : 'Nothing you did says';
    const count = (col: string, v: string | null) => (v ? ((db.query(`SELECT COUNT(*) AS n FROM attn_answer WHERE ${col} = ?`).get(v) as Row).n as number) : 0);
    const answers = Math.max(count('author', author), count('conversation_id', conv));
    return { did, reached, held: loud >= 80 && did !== 'sound', you, youWhat, answers };
  }

  /** Enough in-place signals for the model to be sure of anything (FITTED_AT). */
  fitted(now = Date.now()): { signals: number; need: number } {
    return { signals: this.model.signals(now), need: FITTED_AT };
  }

  /**
   * Put what came in the last days on the feed, once what you did with it is known, and pick the cards: the most
   * worth asking, at most CARDS_A_DAY in 24 hours, none before the model is fitted. At most once an hour (`force`:
   * now). Called when the page asks and on the hub's round.
   */
  fill(prefs: P.AttentionPrefs, now = Date.now(), force = false): number {
    if (!force && this.lastFill !== null && now - this.lastFill < FILL_EVERY && now >= this.lastFill) return 0;
    this.lastFill = now;
    const db = this.db;
    // Those that may have reached a device (a notification of it, or a later one of its chat), or that the model
    // would have sounded.
    const rows = db
      .query(
        `SELECT t.message_id, t.loud, m.ts, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author
         FROM triage t INDEXED BY triage_created JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id
         WHERE t.created_at > ? AND m.ts > ? AND t.decision != 'silent' AND t.loud IS NOT NULL
           AND (t.loud >= 80 OR EXISTS (SELECT 1 FROM notification n WHERE n.message_id = t.message_id)
             OR EXISTS (SELECT 1 FROM notification n WHERE n.conversation_id = m.conversation_id AND n.sent_at >= m.ts AND n.sent_at < m.ts + ${HOUR}))
           AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF})
           AND NOT EXISTS (SELECT 1 FROM cal_item f WHERE f.message_id = t.message_id)
           AND NOT EXISTS (SELECT 1 FROM visit v WHERE v.conversation_id = m.conversation_id AND v.start_at < m.ts AND v.end_at >= m.ts)
         ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(now - WINDOW, now - WINDOW, POOL) as Row[];
    const batch = rows.map((r) => this.scored(r, now)).filter((b): b is Scored => !!b);
    db.transaction(() => {
      for (const b of batch) this.insert(b, 'row', now);
      this.pick(prefs, now);
      // Unanswered ones long past the feed go; answered ones stay for the scorecard.
      db.query('DELETE FROM cal_item WHERE answer IS NULL AND message_ts < ?').run(now - 2 * EXPIRE_AFTER);
    })();
    return batch.length;
  }

  /** The cards: among the rows still fresh, the most worth asking now over CARD_OVER, up to the day's few. */
  private pick(prefs: P.AttentionPrefs, now: number) {
    if (this.fitted(now).signals < FITTED_AT) return;
    const db = this.db;
    const room = (CARDS_A_DAY[prefs.ask] ?? 0) - ((db.query(`SELECT COUNT(*) AS n FROM cal_item WHERE kind = 'card' AND drawn_at > ?`).get(now - DAY) as Row).n as number);
    if (room <= 0) return;
    const fresh = db.query(`SELECT id, score, message_ts FROM cal_item WHERE kind = 'row' AND answer IS NULL AND skipped = 0 AND message_ts > ?`).all(now - CARD_FOR) as Row[];
    const best = fresh
      .map((r) => ({ id: r.id as string, w: worthAsking(r.score, now - r.message_ts) }))
      .filter((r) => r.w > CARD_OVER)
      .sort((a, b) => b.w - a.w)
      .slice(0, room);
    const up = db.query(`UPDATE cal_item SET kind = 'card', chance = 1, drawn_at = ? WHERE id = ?`);
    for (const r of best) up.run(now, r.id);
  }

  /** A message's place on the feed worked out: what happened, the chances, the regret. Null: not one to ask about. */
  private scored(r: Row, now: number, anyway = false): Scored | null {
    const s = this.situation(r.message_id, r.conversation_id, r.ts, r.author, r.loud, now);
    if (!anyway && !s.reached && !s.held) return null;
    // Not settled yet: no strong signal, and too soon to say there will be none.
    if (!anyway && !s.you && now - r.ts < SETTLE) return null;
    const p = chances(r.loud, s.answers);
    const said = calAnswerOf(bandOf(r.loud));
    return { r, s, p, surprise: s.you ? surpriseOf(p, s.you) : 0, unsure: unsureOf(p, s.answers), regret: regretOf(p, said, s.you) };
  }

  private insert(b: Scored, kind: 'card' | 'row', now: number): string {
    const id = newId('fd');
    this.db
      .query(
        `INSERT OR IGNORE INTO cal_item (id, message_id, conversation_id, author, kind, sure_shown, chance, score, surprise, unsure, p, u, loud, did, you, you_what, held, answers, drawn_at, message_ts)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.r.message_id, b.r.conversation_id, b.r.author, kind, b.regret, b.surprise, b.unsure, JSON.stringify(b.p), JSON.stringify(spreadsOf(b.p, b.s.answers)), b.r.loud, b.s.did, b.s.you, b.s.youWhat, +b.s.held, b.s.answers, now, b.r.ts);
    return id;
  }

  /**
   * A demo world's feed (demo-calibration.ts): a message put on it as a given kind, whatever its score or the model's
   * fit, in place of any earlier place it had.
   */
  place(messageId: string, kind: 'card' | 'row', now = Date.now()): string | null {
    const r = this.db
      .query(`SELECT t.message_id, t.loud, m.ts, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author FROM triage t JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id WHERE t.message_id = ? AND t.loud IS NOT NULL`)
      .get(messageId) as Row | null;
    const b = r && this.scored(r, now, true);
    if (!b) return null;
    this.db.query('DELETE FROM cal_item WHERE message_id = ?').run(messageId);
    return this.insert(b, kind, now);
  }

  get(id: string): Row | null {
    return this.db.query('SELECT * FROM cal_item WHERE id = ?').get(id) as Row | null;
  }

  /** Cards waiting and past answers back: the inbox row's count. */
  pendingCount(now = Date.now()): number {
    return (
      this.db
        .query(`SELECT COUNT(*) AS n FROM cal_item WHERE skipped = 0 AND ((kind = 'card' AND answer IS NULL AND drawn_at > ?) OR (answer IS NOT NULL AND returns_at <= ? AND settled IS NULL AND message_ts > ?))`)
        .get(now - CARD_FOR, now, now - EXPIRE_AFTER) as Row
    ).n;
  }

  private dayStart(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  cardsToday(now: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM cal_item WHERE kind = 'card' AND drawn_at >= ?`).get(this.dayStart(now)) as Row).n;
  }
  answeredToday(now: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM cal_item WHERE answered_at >= ?`).get(this.dayStart(now)) as Row).n;
  }

  /** Fill, then the feed: the cards and past answers, most worth asking now first; and how fitted the model is. */
  view(prefs: P.AttentionPrefs, now = Date.now()): P.CalFeedView {
    this.fill(prefs, now);
    const db = this.db;
    const cards = db.query(`SELECT * FROM cal_item WHERE kind = 'card' AND answer IS NULL AND skipped = 0 AND drawn_at > ?`).all(now - CARD_FOR) as Row[];
    const past = db.query(`SELECT * FROM cal_item WHERE answer IS NOT NULL AND returns_at <= ? AND settled IS NULL AND skipped = 0 AND message_ts > ?`).all(now, now - EXPIRE_AFTER) as Row[];
    const now_ = (r: Row) => worthAsking(r.score, now - r.message_ts);
    const items = [...cards, ...past]
      .sort((a, b) => now_(b) - now_(a))
      .map((r) => this.itemView(r, now))
      .filter((v): v is P.CalItem => !!v);
    return { items, fitted: this.fitted(now) };
  }

  /** The model's chances now for an answered item: its loudness moved by what was learned since (loud_base). */
  afterOf(r: Row): Trio | null {
    if (typeof r.loud_base !== 'number') return null;
    const nowLoud = this.model.loudNow(r.message_id);
    if (nowLoud === null) return null;
    return chances(Math.max(0, Math.min(100, r.loud + nowLoud - r.loud_base)), r.answers + 1);
  }

  itemView(r: Row, now: number): P.CalItem | null {
    const d = this.describe(r.message_id);
    if (!d) return null;
    const ctx = seenContext(this.db, r.message_id, { title: d.title, preview: d.preview, at: r.message_ts, network: d.network, shape: d.shape, conversationId: d.conversationId });
    const s = ctx.sent;
    const dev = s?.devices.find((x) => x.tapped || x.shown || x.dismissed) ?? s?.devices[0] ?? null;
    const look: P.CalItem['look'] = !s ? 'row' : dev && (dev.kind === 'page' || dev.surface === 'toast' || dev.surface === 'browser' || !dev.phone) ? 'toast' : 'shade';
    const lv = this.loudView(r.message_id);
    const pts = this.model.points(r.message_id);
    const push = (x: number | undefined) => Math.round(Math.max(-1, Math.min(1, (x ?? 0) / 30)) * 100) / 100;
    const wait = lv?.parts?.wait;
    const waitWord = wait ? ['minutes', 'an hour', 'the day', 'days'][wait.indexOf(Math.max(...wait))] : '—';
    const keys = lv?.moment ?? [];
    const clock = new Date(r.message_ts).toTimeString().slice(0, 5);
    const word = (d.preview.toLowerCase().match(/[\p{L}']{4,}/u) ?? [])[0];
    const deliveryPush = r.held ? -0.6 : ctx.notSent ? -0.4 : 0;
    const deliveryLabel = ctx.notSent === 'watched' ? 'chat open' : ctx.notSent === 'capped' ? 'one just before' : r.held ? 'held back' : dev ? (dev.phone ? 'phone' : 'computer') : '—';
    const parts: P.CalItem['parts'] = [
      { part: 'person', label: d.author ?? '—', push: push(pts?.person) },
      { part: 'chat', label: d.shape === 'direct' ? 'DM' : (d.chat ?? '—'), push: push(pts?.chat) },
      { part: 'topic', label: word ? `"${word}"` : '—', push: push(pts?.topic) },
      { part: 'wait', label: waitWord, push: push(pts?.wait) },
      { part: 'moment', label: lv?.parts?.quiet ? 'quiet hours' : keys.includes('desk') ? 'at a computer' : clock, push: push(pts?.moment) },
      { part: 'delivery', label: deliveryLabel, push: deliveryPush },
    ];
    const answered = r.answer && r.settled === null;
    const after = answered ? (r.after ? (JSON.parse(r.after) as Trio) : null) : null;
    const afterNow = answered && r.returns_at !== null && r.returns_at <= now ? (this.afterOf(r) ?? after) : after;
    const said = calAnswerOf(bandOf(r.loud));
    return {
      id: r.id,
      kind: answered && r.returns_at !== null && r.returns_at <= now ? 'past' : 'card',
      messageId: r.message_id,
      conversationId: d.conversationId,
      network: s?.network ?? d.network,
      icon: s?.icon ?? null,
      who: d.title,
      text: d.preview,
      at: r.message_ts,
      look,
      p: JSON.parse(r.p),
      u: JSON.parse(r.u),
      did: r.did,
      said,
      you: r.you,
      youWhat: r.you_what,
      surprise: r.surprise,
      unsure: r.unsure,
      regret: r.score,
      cost: costKind(said, r.you),
      score: worthAsking(r.score, now - r.message_ts),
      chance: r.chance,
      ...(r.held ? { held: true } : {}),
      ...(r.answer ? { answer: r.answer } : {}),
      ...(afterNow ? { after: afterNow } : {}),
      parts,
      context: contextLine(ctx, dev, r.held),
      reasons: (lv?.reasons ?? []).slice(0, 6),
    };
  }

  private loudView(messageId: string): { parts?: P.LoudParts; moment?: string[]; reasons?: P.LoudReason[] } | null {
    const raw = (this.db.query('SELECT loud_view FROM triage WHERE message_id = ?').get(messageId) as Row | null)?.loud_view;
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ answers (loudlearn.ts learns from them)

  answered(id: string, answer: P.CalAnswer, answerId: string, loudBase: number | null, now: number) {
    this.db.query('UPDATE cal_item SET answer = ?, answer_id = ?, answered_at = ?, loud_base = COALESCE(loud_base, ?), skipped = 0, settled = NULL WHERE id = ?').run(answer, answerId, now, loudBase, id);
  }

  /** The chances after learning; a past answer comes back once when the model had given it under RETURN_UNDER. */
  settleAfter(id: string, after: Trio | null, now: number) {
    const r = this.get(id);
    if (!r || !r.answer) return;
    const before = JSON.parse(r.p) as Trio;
    const back = before[ANSWER_I[r.answer as P.CalAnswer]] < RETURN_UNDER ? now + RETURN_AFTER : null;
    this.db.query('UPDATE cal_item SET after = ?, before = ?, returns_at = ? WHERE id = ?').run(after ? JSON.stringify(after) : null, r.p, back, id);
  }

  setParts(id: string, parts: P.CalPart[]) {
    this.db.query('UPDATE cal_item SET parts = ? WHERE id = ?').run(JSON.stringify(parts), id);
  }

  /** Keep, Only that once, or Undo: a past answer leaves the feed; Undo puts the message back as it was. */
  settle(id: string, how: P.CalSettle) {
    if (how === 'undo') this.db.query(`UPDATE cal_item SET answer = NULL, answer_id = NULL, answered_at = NULL, after = NULL, before = NULL, parts = NULL, returns_at = NULL, settled = 'undo' WHERE id = ?`).run(id);
    else this.db.query('UPDATE cal_item SET settled = ? WHERE id = ?').run(how, id);
  }

  skip(id: string, skipped: boolean) {
    this.db.query('UPDATE cal_item SET skipped = ? WHERE id = ?').run(skipped ? 1 : 0, id);
  }
}

/** Where and how it was seen, in a line: "Android phone · in the shade · silent", "Not sent: its chat was open". */
function contextLine(ctx: P.SeenContext, dev: P.SeenDevice | null, held: boolean): string {
  const s = ctx.sent;
  if (!s) return ctx.notSent === 'watched' ? 'Not sent: its chat was open on a computer' : ctx.notSent === 'capped' ? 'Not sent: one had gone out for this chat minutes before' : 'Not sent: a row in the inbox';
  const where: Record<P.SeenSurface, string> = { heads_up: 'heads-up', shade: 'in the shade', lock: 'lock screen', list_row: 'in the list', browser: 'browser', toast: 'in the open app' };
  const bits = [dev?.label ?? 'No device known'];
  if (dev?.surface) bits.push(where[dev.surface]);
  bits.push(dev?.sound === 'sound' || (!dev?.sound && s.sounded) ? 'sounded' : dev?.sound === 'vibrate' ? 'vibrated' : 'silent');
  if (s.computerInUse) bits.push('a computer in use');
  if (held) bits.push('a sound held back');
  return bits.join(' · ');
}
