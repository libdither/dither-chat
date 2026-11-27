/**
 * The calibration feed (docs/notifications.md, "The calibration feed"): recent notifications, each as it looked, with
 * the three answers you'd tap in one (Sound / Show / Inbox) and what the model gave each. Nothing here pushes: the
 * feed waits on the Notification calibration page until you get to it.
 *
 * Every message that reached you (or would have: loudness 10 or more) is put on it once what you did with it is known
 * (SETTLE), and scored:
 *
 *   p          = the model's chance of each answer: its loudness, blurred by how few answers it has about the
 *                person or chat (sigmaOf), cut at the bands (inbox below 30, sound from 80)
 *   you        = what you did: opened or answered within 10 minutes is Sound, within 3 hours Show, else Inbox
 *   surprise   = −log2 p(you), at most 5 bits
 *   unsure     = how spread p is (its entropy, 0 to 1) × how few answers are behind it
 *   worth      = (0.6 · surprise / 5 + 0.4 · unsure) × ½^(age / 3 days)
 *
 * Those worth asking over 0.5 may open as cards, about three a day (your setting): each is drawn at random in
 * proportion to its worth, and the chance it had is stored, so what is learned from it can be weighted back by it
 * (ipsWeight). The rest are compact rows. A past answer comes back once, a day later, when the model had given it
 * under 20%.
 *
 * Hidden as sure, very conservatively: only when p(you) ≥ 95%, there are 30 or more answers about that person or that
 * chat, none of them against what the model did in the last 30 days, and it is not a sound that was held back. Even
 * then one in twenty is shown, at random.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { carrier, seenContext } from './seen.ts';

type Row = Record<string, any>;
type Trio = P.Trio;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A fresh id: `fd_…` for feed items, `ans_…` for answers. */
export const newId = (prefix: string) => `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;

/** What you did, by how soon you opened or answered it: Sound within this… */
const SOUND_WITHIN = 10 * MIN;
/** …Show within this, Inbox after it or never. A message goes on the feed once this has passed, or once you opened it. */
const SETTLE = 3 * HOUR;
/** Worth asking halves every this long. */
const HALF_LIFE = 3 * DAY;
/** Surprise is counted up to this many bits. */
const MAX_BITS = 5;
/** Cards are drawn from those worth asking over this. */
const CARD_OVER = 0.5;
/** Cards a day, by your setting (Settings: how often it asks). */
const CARDS_A_DAY: Record<P.AttentionPrefs['ask'], number> = { never: 0, rarely: 1, often: 3 };
/** Hidden as sure: the model gave what you did at least this… */
const SURE_P = 0.95;
/** …with at least this many answers about the person or the chat… */
export const SURE_ANSWERS = 30;
/** …none against it in this long… */
const SURE_CLEAN = 30 * DAY;
/** …and even then this share is shown, at random. */
export const SURE_SHOWN = 1 / 20;
/** A past answer comes back once when the model had given it under this, this long after. */
const RETURN_UNDER = 0.2;
export const RETURN_AFTER = DAY;
/** Nothing older than this is on the feed: you would hardly remember the moment. */
export const EXPIRE_AFTER = 14 * DAY;
/** Messages are put on the feed within this long of coming, at most POOL at a time, at most once an hour. */
const WINDOW = 3 * DAY;
const POOL = 400;
const FILL_EVERY = HOUR;
/** Rows listed, by worth asking now; sure ones listed under their fold. */
const ROWS_SHOWN = 40;
const SURE_LISTED = 30;
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
 * The weight an answer gets for how it was drawn: a card drawn with chance c counts 0.5/c (a sure one shown one time
 * in twenty counts most), between 1 and 3 so no single answer runs away with the model.
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
/** Worth asking: surprise and unsure mixed, fading by half every HALF_LIFE. */
export const worthAsking = (surprise: number, unsure: number, age: number) => r3((0.6 * (surprise / MAX_BITS) + 0.4 * unsure) * 0.5 ** (Math.max(0, age) / HALF_LIFE));

/**
 * The chance a message opens as a card: none at CARD_OVER or below; else in proportion to its worth, so that about
 * `perDay` open over a day whose worth (over CARD_OVER) adds up to `dayWorth`.
 */
export function cardChance(worth: number, perDay: number, dayWorth: number): number {
  if (!(worth > CARD_OVER) || perDay <= 0) return 0;
  return r3(Math.min(1, (perDay * worth) / Math.max(dayWorth, worth)));
}

/** Hidden as sure: every condition, conservatively (above). */
export function isSure(x: { p: Trio; you: P.CalAnswer; answers: number; against: boolean; held: boolean }): boolean {
  return x.p[ANSWER_I[x.you]] >= SURE_P && x.answers >= SURE_ANSWERS && !x.against && !x.held;
}

/** What you did, from how soon you opened or answered it (null: not yet known). */
export function youOf(delay: number | null, age: number): P.CalAnswer | null {
  if (delay !== null) return delay <= SOUND_WITHIN ? 'sound' : delay <= SETTLE ? 'show' : 'inbox';
  return age >= SETTLE ? 'inbox' : null;
}

const ago = (ms: number) => (ms < MIN ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < HOUR ? `${Math.round(ms / MIN)} min` : ms < DAY ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / DAY)} d`);

// ------------------------------------------------------------------ the feed

/** What the model says of a message now (loudlearn.ts): its loudness with what is learned, and each part's points. */
interface FeedModel {
  loudNow(messageId: string): number | null;
  points(messageId: string): Record<'person' | 'chat' | 'topic' | 'wait' | 'moment', number> | null;
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

/** What happened to a message: what the model did, what you did, and what the answers say of its person and chat. */
interface Situation {
  did: P.CalAnswer;
  held: boolean;
  you: P.CalAnswer | null;
  youWhat: string;
  answers: number;
  against: boolean;
}

interface Scored {
  r: Row;
  s: Situation;
  p: Trio;
  surprise: number;
  unsure: number;
  worth: number;
}

const SELF = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`;

export class CalibrationFeed {
  /** Random numbers, for the draws (tests and the demo set their own). */
  random: () => number = Math.random;
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
    const at = (event: string) => (n ? ((db.query('SELECT MIN(at) AS at FROM notification_event WHERE notification_id = ? AND event = ?').get(n.id, event) as Row)?.at ?? null) : null) as number | null;
    const opened = (db.query('SELECT MIN(start_at) AS at FROM visit WHERE conversation_id = ? AND start_at >= ?').get(conv, ts) as Row)?.at as number | null;
    const tapped = at('tapped');
    const dismissed = at('dismissed');
    const replied = (db.query(`SELECT MIN(ts) AS at FROM message WHERE conversation_id = ? AND ts > ? AND author_id IN ${SELF}`).get(conv, ts) as Row)?.at as number | null;
    const seen = [opened, tapped].filter((x): x is number => typeof x === 'number');
    const first = seen.length ? Math.min(...seen) : null;
    const acted = [first, replied].filter((x): x is number => typeof x === 'number');
    const delay = acted.length ? Math.min(...acted) - ts : null;
    const you = youOf(delay, now - ts);
    const lead = dismissed && (!first || dismissed < first) ? `Dismissed in ${ago(dismissed - ts)}, ` : '';
    const when = (d: number) => (d <= SOUND_WITHIN ? `in ${ago(d)}` : `${ago(d)} later`);
    const youWhat =
      replied !== null && (first === null || replied <= first) ? `${lead}answered ${when(replied - ts)}`
      : first !== null ? `${lead}opened ${when(first - ts)}`
      : dismissed ? `Dismissed in ${ago(dismissed - ts)}, not opened`
      : 'Not opened';
    const count = (col: string, v: string | null) => (v ? ((db.query(`SELECT COUNT(*) AS n FROM attn_answer WHERE ${col} = ?`).get(v) as Row).n as number) : 0);
    const answers = Math.max(count('author', author), count('conversation_id', conv));
    // Against what the model did: Louder, Quieter and the old answers that said so, or a feed answer not its band.
    const against = !!db
      .query(
        `SELECT 1 FROM attn_answer WHERE (author = ? OR conversation_id = ?) AND at > ? AND (answer IN ('louder', 'quieter', 'could_wait', 'shouldnt', 'sooner')
           OR (answer IN ('sound', 'show', 'inbox') AND band IS NOT NULL AND answer != CASE band WHEN 'sound' THEN 'sound' WHEN 'show' THEN 'show' ELSE 'inbox' END)) LIMIT 1`,
      )
      .get(author ?? '', conv, now - SURE_CLEAN);
    return { did, held: loud >= 80 && did !== 'sound', you, youWhat: youWhat[0].toUpperCase() + youWhat.slice(1), answers, against };
  }

  /**
   * Put what came in the last days on the feed, once what you did with it is known: scored, and drawn as a card, a
   * row, or hidden as sure. At most once an hour (`force`: now). Called when the page asks and on the hub's round.
   */
  fill(prefs: P.AttentionPrefs, now = Date.now(), force = false): number {
    if (!force && this.lastFill !== null && now - this.lastFill < FILL_EVERY && now >= this.lastFill) return 0;
    this.lastFill = now;
    const db = this.db;
    const rows = db
      .query(
        `SELECT t.message_id, t.loud, m.ts, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author
         FROM triage t INDEXED BY triage_created JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id
         WHERE t.created_at > ? AND m.ts > ? AND t.decision != 'silent' AND t.loud IS NOT NULL
           AND (t.loud >= 10 OR EXISTS (SELECT 1 FROM notification n WHERE n.message_id = t.message_id))
           AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF})
           AND NOT EXISTS (SELECT 1 FROM cal_item f WHERE f.message_id = t.message_id)
           AND NOT EXISTS (SELECT 1 FROM visit v WHERE v.conversation_id = m.conversation_id AND v.start_at < m.ts AND v.end_at >= m.ts)
         ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(now - WINDOW, now - WINDOW, POOL) as Row[];
    const batch = rows.map((r) => this.scored(r, now)).filter((b): b is Scored => !!b);
    if (!batch.length) return 0;
    const perDay = CARDS_A_DAY[prefs.ask] ?? 0;
    const drawnDay = (db.query(`SELECT COALESCE(SUM(score), 0) AS s FROM cal_item WHERE drawn_at > ? AND score > ?`).get(now - DAY, CARD_OVER) as Row).s as number;
    const dayWorth = drawnDay + batch.filter((b) => b.worth > CARD_OVER).reduce((t, b) => t + b.worth, 0);
    db.transaction(() => {
      for (const b of batch) {
        if (isSure({ p: b.p, you: b.s.you!, answers: b.s.answers, against: b.s.against, held: b.s.held })) {
          // One in twenty shown anyway, as a row.
          const shown = this.random() < SURE_SHOWN;
          this.insert(b, shown ? 'row' : 'sure', shown ? SURE_SHOWN : 1 - SURE_SHOWN, shown, now);
        } else {
          const c = cardChance(b.worth, perDay, dayWorth);
          const card = c > 0 && this.random() < c;
          this.insert(b, card ? 'card' : 'row', card ? c : r3(1 - c), false, now);
        }
      }
      // Unanswered ones long past the feed go; answered ones stay for the scorecard.
      db.query('DELETE FROM cal_item WHERE answer IS NULL AND message_ts < ?').run(now - 2 * EXPIRE_AFTER);
    })();
    return batch.length;
  }

  /** A message's place on the feed worked out: what happened, the chances, how surprised and unsure, worth asking. */
  private scored(r: Row, now: number): Scored | null {
    const s = this.situation(r.message_id, r.conversation_id, r.ts, r.author, r.loud, now);
    if (!s.you) return null;
    const p = chances(r.loud, s.answers);
    const surprise = surpriseOf(p, s.you);
    const unsure = unsureOf(p, s.answers);
    return { r, s, p, surprise, unsure, worth: worthAsking(surprise, unsure, now - r.ts) };
  }

  private insert(b: Scored, kind: 'card' | 'row' | 'sure', chance: number, shown: boolean, now: number): string {
    const id = newId('fd');
    this.db
      .query(
        `INSERT OR IGNORE INTO cal_item (id, message_id, conversation_id, author, kind, sure_shown, chance, score, surprise, unsure, p, u, loud, did, you, you_what, held, answers, drawn_at, message_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.r.message_id, b.r.conversation_id, b.r.author, kind, +shown, chance, b.worth, b.surprise, b.unsure, JSON.stringify(b.p), JSON.stringify(spreadsOf(b.p, b.s.answers)), b.r.loud, b.s.did, b.s.you, b.s.youWhat, +b.s.held, b.s.answers, now, b.r.ts);
    return id;
  }

  /**
   * A demo world's feed (demo-calibration.ts): a message put on it as a given kind, whatever its draw would have been,
   * in place of any earlier place it had. `sure` is put as a sure one shown at random when it is not sure after all.
   */
  place(messageId: string, kind: 'card' | 'row' | 'sure', now = Date.now()): string | null {
    const r = this.db
      .query(`SELECT t.message_id, t.loud, m.ts, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author FROM triage t JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id WHERE t.message_id = ? AND t.loud IS NOT NULL`)
      .get(messageId) as Row | null;
    const b = r && this.scored(r, now);
    if (!b) return null;
    this.db.query('DELETE FROM cal_item WHERE message_id = ?').run(messageId);
    const sure = kind === 'sure' && isSure({ p: b.p, you: b.s.you!, answers: b.s.answers, against: b.s.against, held: b.s.held });
    if (kind === 'sure') return this.insert(b, sure ? 'sure' : 'row', sure ? 1 - SURE_SHOWN : SURE_SHOWN, !sure, now);
    return this.insert(b, kind, kind === 'card' ? Math.max(cardChance(b.worth, 3, b.worth), 0.5) : 1, false, now);
  }

  get(id: string): Row | null {
    return this.db.query('SELECT * FROM cal_item WHERE id = ?').get(id) as Row | null;
  }

  /** Cards waiting and past answers back: the inbox row's count. */
  pendingCount(now = Date.now()): number {
    return (
      this.db
        .query(`SELECT COUNT(*) AS n FROM cal_item WHERE skipped = 0 AND message_ts > ? AND ((kind = 'card' AND answer IS NULL) OR (answer IS NOT NULL AND returns_at <= ? AND settled IS NULL))`)
        .get(now - EXPIRE_AFTER, now) as Row
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

  /** Fill, then the feed: cards and past answers by worth asking now, then rows, then the sure ones apart. */
  view(prefs: P.AttentionPrefs, now = Date.now()): P.CalFeedView {
    this.fill(prefs, now);
    const db = this.db;
    const since = now - EXPIRE_AFTER;
    const cards = db.query(`SELECT * FROM cal_item WHERE kind = 'card' AND answer IS NULL AND skipped = 0 AND message_ts > ?`).all(since) as Row[];
    const past = db.query(`SELECT * FROM cal_item WHERE answer IS NOT NULL AND returns_at <= ? AND settled IS NULL AND skipped = 0 AND message_ts > ?`).all(now, since) as Row[];
    const rows = db.query(`SELECT * FROM cal_item WHERE kind = 'row' AND answer IS NULL AND skipped = 0 AND message_ts > ? ORDER BY score DESC LIMIT 200`).all(since) as Row[];
    const sure = db.query(`SELECT * FROM cal_item WHERE kind = 'sure' AND answer IS NULL AND skipped = 0 AND message_ts > ? ORDER BY message_ts DESC LIMIT ?`).all(now - WINDOW, SURE_LISTED) as Row[];
    const now_ = (r: Row) => worthAsking(r.surprise, r.unsure, now - r.message_ts);
    const top = [...cards, ...past].sort((a, b) => now_(b) - now_(a));
    const rest = rows.sort((a, b) => now_(b) - now_(a)).slice(0, ROWS_SHOWN);
    const items = [...top, ...rest].map((r) => this.itemView(r, now)).filter((v): v is P.CalItem => !!v);
    return { items, sure: sure.map((r) => this.itemView(r, now)).filter((v): v is P.CalItem => !!v) };
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
    return {
      id: r.id,
      kind: answered && r.returns_at !== null && r.returns_at <= now ? 'past' : (r.kind as P.CalItem['kind']),
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
      you: r.you,
      youWhat: r.you_what + (r.sure_shown ? ' · one it was sure of, shown at random' : ''),
      surprise: r.surprise,
      unsure: r.unsure,
      score: worthAsking(r.surprise, r.unsure, now - r.message_ts),
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

