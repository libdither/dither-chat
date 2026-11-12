/**
 * The phone's list (docs/notifications.md, "The phone's list"): which List-tier messages become a row on the phones.
 *
 * Triage still decides the tier, and the inbox still lists what is on the list. This decides only what reaches the
 * phones, per chat and per episode: a chat's row from its first push until it is tapped, swiped away, read anywhere,
 * replaced by a Conversation or an alert, or 12 hours old.
 *
 * - **The gate.** A list row goes to the phones when the start alone puts it on the list: the network itself would
 *   have notified you, or it is to you (a mention, a reply to you, a DM). Or the chat has a "keep" mark: a message in
 *   it marked "should have alerted" in the last 90 days, the one mark that says "more from here". What learning
 *   alone lifted onto the list (mostly from what you opened, anywhere) stays off the phones.
 * - **Trials.** At most three a day, so a chat the gate holds can still show it is worth a row: one coin per chat per
 *   day, at its first held message, with the chance `TRIALS_PER_DAY / expected chats held a day`. Each coin and its
 *   chance are kept (`phone_episode`), so a later replay can weigh what the trials found.
 * - **At most eight** list rows open on the phones at once, by the hub's count; at eight a new chat's row waits.
 * - **A swipe snoozes** the chat's list rows for six hours, or until a Conversation or an alert comes there. A
 *   clear-all (dismissals from one device within two seconds) ends the episodes and snoozes the same, and is kept as
 *   `cleared`, never as a "no" about the chat.
 * - **Twelve hours** and a row goes: a `{ clear }` push to the registrations that take one.
 *
 * `DITHER_PHONE_LIST`: `on` (the default), `shadow` (rows go out as before; the log says what the gate would have
 * done), `off` (as before, nothing kept).
 */
import type { Database } from 'bun:sqlite';
import type { Facts } from './learn.ts';

type Row = Record<string, any>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** List rows open on the phones at once. */
export const LIST_CAP = 8;
/** After a swipe, the chat's list rows wait this long, unless something above the list comes. */
export const SNOOZE_MS = 6 * HOUR;
/** A list row this old leaves the phones. */
export const EXPIRE_MS = 12 * HOUR;
/** Trials a day, at most. */
export const TRIALS_PER_DAY = 3;
/** Dismissals from one device this close together are a clear-all. */
export const BULK_MS = 2_000;
/** How many earlier days the expected number of held chats is read from. */
const HISTORY_DAYS = 7;
/** Episodes kept this long. */
const KEEP_MS = 90 * DAY;
const PHONE = /android|iphone|ipad|\bios\b/i;

export type PhoneListMode = 'off' | 'shadow' | 'on';
export const phoneListMode = (v: string | undefined): PhoneListMode => (v === 'off' || v === 'shadow' ? v : 'on');

/** Why an episode is on the phones (or, `gated`, is not). */
export type Arm = 'prior' | 'keep' | 'trial' | 'gated';
export type Outcome = 'tapped' | 'dismissed' | 'cleared' | 'read' | 'expired' | 'superseded';
/** What kept a row off the phones. */
export type Held = 'gated' | 'snoozed' | 'cap';

export interface Verdict {
  /** Its row goes to the phones (in shadow, always). */
  send: boolean;
  arm: Arm | null;
  /** What held it (in shadow: what would have). */
  held: Held | null;
  /** The coin's chance, when one was tossed now. */
  propensity?: number;
}

/**
 * The start alone puts it on the list: the network would have notified you (facts from before `notify` was kept say
 * so by their base), or it is to you. Without facts nothing is known against it.
 */
export function listByPrior(f: Partial<Pick<Facts, 'notify' | 'base' | 'mention' | 'reply' | 'shape'>> | null | undefined): boolean {
  if (!f) return true;
  const notify = f.notify ?? (f.base === 'push' || f.base === 'quiet');
  return !!notify || !!f.mention || !!f.reply || f.shape === 'direct';
}

/** The hub's local day, YYYY-MM-DD. */
export function dayOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight at the start of `t`'s day. */
const midnight = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

export interface PhoneListOptions {
  mode: PhoneListMode;
  /** Chats with a "keep" mark (triage.ts `marked`: "should have alerted" in the last 90 days). */
  kept: (now: number) => Set<string>;
  /** Read up to this time, anywhere (delivery.ts `readTs`). */
  readTs: (conversationId: string) => number;
  random?: () => number;
}

/** What the activity log heard from a device about a notification (activity.ts `noted`). */
export interface DeviceWord {
  event: string;
  conversationId: string | null;
  device: string;
  at: number;
}

export class PhoneList {
  readonly mode: PhoneListMode;
  private random: () => number;
  private expected: { day: string; n: number } | null = null;
  /** What was asked and answered since the last log line. */
  private tally = new Map<string, number>();
  private tallyAt = Date.now();

  constructor(
    private db: Database,
    private o: PhoneListOptions,
  ) {
    this.mode = o.mode;
    this.random = o.random ?? Math.random;
  }

  /**
   * May this list message's row go to the phones now? Asked only when a push would go out (not within the list's ten
   * minutes). `prior`: `listByPrior` of its facts. `ts`: the message's time.
   */
  list(conversationId: string, prior: boolean, ts: number, now = Date.now()): Verdict {
    if (this.mode === 'off') return { send: true, arm: null, held: null };
    const v = this.decide(conversationId, prior, ts, now);
    const k = v.send ? `sent ${v.arm}` : `held ${v.held}`;
    this.tally.set(k, (this.tally.get(k) ?? 0) + 1);
    return this.mode === 'shadow' ? { ...v, send: true } : v;
  }

  private decide(cid: string, prior: boolean, ts: number, now: number): Verdict {
    const open = this.db.query(`SELECT id, arm, sent FROM phone_episode WHERE conversation_id = ? AND ended_at IS NULL AND mode = ?`).get(cid, this.mode) as Row | null;
    if (open) {
      if (!open.sent) return { send: false, arm: open.arm, held: 'gated' };
      this.db.query('UPDATE phone_episode SET posts = posts + 1, last_at = ? WHERE id = ?').run(now, open.id);
      return { send: true, arm: open.arm, held: null };
    }
    const arm: Arm | null = prior ? 'prior' : this.o.kept(now).has(cid) ? 'keep' : null;
    if (this.snoozed(cid, now)) return { send: false, arm, held: 'snoozed' };
    if (this.openRows() >= LIST_CAP) return { send: false, arm, held: 'cap' };
    if (arm) {
      this.begin(cid, arm, null, true, ts, now);
      return { send: true, arm, held: null };
    }
    // Held by the gate. Its first held message today tosses the day's coin; a coin already tossed holds the rest.
    const day = dayOf(now);
    if (this.db.query(`SELECT 1 FROM phone_episode WHERE conversation_id = ? AND day = ? AND arm IN ('trial', 'gated') AND mode = ?`).get(cid, day, this.mode)) return { send: false, arm: 'gated', held: 'gated' };
    const p = this.propensity(day, now);
    const trial = p > 0 && this.random() < p;
    this.begin(cid, trial ? 'trial' : 'gated', p, trial, ts, now);
    return trial ? { send: true, arm: 'trial', held: null, propensity: p } : { send: false, arm: 'gated', held: 'gated', propensity: p };
  }

  private begin(cid: string, arm: Arm, propensity: number | null, sent: boolean, ts: number, now: number) {
    this.db
      .query(`INSERT INTO phone_episode (conversation_id, day, mode, arm, propensity, sent, first_ts, started_at, last_at, posts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cid, dayOf(now), this.mode, arm, propensity, sent ? 1 : 0, ts, now, now, sent ? 1 : 0);
  }

  /** List rows the hub sent and has not seen go. */
  openRows(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM phone_episode WHERE ended_at IS NULL AND sent = 1 AND mode = ?`).get(this.mode) as Row).n;
  }

  private snoozed(cid: string, now: number): boolean {
    return !!this.db.query('SELECT 1 FROM phone_snooze WHERE conversation_id = ? AND until > ?').get(cid, now);
  }

  /**
   * The chance of a trial for a chat held now: the day's budget over the chats held on a day, as the last days had
   * them; nothing once the day's trials are spent. Exact: it is the chance the coin is tossed with.
   */
  propensity(day: string, now: number): number {
    const done = (this.db.query(`SELECT COUNT(*) AS n FROM phone_episode WHERE day = ? AND arm = 'trial' AND mode = ?`).get(day, this.mode) as Row).n;
    if (done >= TRIALS_PER_DAY) return 0;
    return Math.min(1, TRIALS_PER_DAY / Math.max(1, this.expectedChats(day, now)));
  }

  /**
   * Chats held on a day: from the coins of the days before, once there are two days of them; before that, from the
   * list decisions of the three days before today that the gate would have held.
   */
  expectedChats(day: string, now: number): number {
    if (this.expected?.day === day) return this.expected.n;
    const days = this.db
      .query(`SELECT day, COUNT(DISTINCT conversation_id) AS n FROM phone_episode WHERE arm IN ('trial', 'gated') AND day < ? AND started_at >= ? GROUP BY day`)
      .all(day, midnight(now) - HISTORY_DAYS * DAY) as Row[];
    const n = days.length >= 2 ? days.reduce((s, r) => s + r.n, 0) / days.length : this.heldBefore(now);
    this.expected = { day, n };
    return n;
  }

  /** Chats a day the gate would have held, from the decisions of the three days before today. */
  private heldBefore(now: number): number {
    const to = midnight(now);
    const from = to - 3 * DAY;
    const kept = this.o.kept(now);
    const seen = new Set<string>();
    for (const r of this.db
      .query(
        `SELECT m.conversation_id AS cid, t.created_at AS at, t.facts FROM triage t INDEXED BY triage_created JOIN message m ON m.id = t.message_id
         WHERE t.created_at >= ? AND t.created_at < ? AND t.decision = 'digest'`,
      )
      .iterate(from, to) as Iterable<Row>) {
      if (kept.has(r.cid) || listByPrior(r.facts ? JSON.parse(r.facts) : null)) continue;
      seen.add(`${r.cid} ${dayOf(r.at)}`);
    }
    return seen.size / 3;
  }

  /** A Conversation or an alert in this chat: its list episode is over, and a swipe's snooze is lifted. */
  higher(cid: string, now = Date.now()) {
    if (this.mode === 'off') return;
    this.end(cid, 'superseded', now);
    this.db.query('DELETE FROM phone_snooze WHERE conversation_id = ?').run(cid);
  }

  /** Read anywhere since its row went out (delivery.ts `read`). */
  read(cid: string, now = Date.now()) {
    if (this.mode === 'off') return;
    this.end(cid, 'read', now);
  }

  /**
   * A tap or a swipe, as the activity log heard it. Only a phone's word counts: its push registration, or the page of
   * the app that registered it (`push_subscription.device`), so a computer's toast says nothing here.
   */
  noted(w: DeviceWord) {
    if (this.mode === 'off' || !w.conversationId || (w.event !== 'tapped' && w.event !== 'dismissed')) return;
    if (!this.onPhone(w.device)) return;
    if (w.event === 'tapped') return this.end(w.conversationId, 'tapped', w.at);
    const bulk = (this.db.query(`SELECT COUNT(*) AS n FROM notification_event WHERE event = 'dismissed' AND device = ? AND at BETWEEN ? AND ?`).get(w.device, w.at - BULK_MS, w.at + BULK_MS) as Row).n >= 2;
    this.end(w.conversationId, bulk ? 'cleared' : 'dismissed', w.at);
    // The first of a clear-all looked like one swipe when it came.
    if (bulk) this.db.query(`UPDATE phone_episode SET outcome = 'cleared' WHERE outcome = 'dismissed' AND outcome_at BETWEEN ? AND ?`).run(w.at - BULK_MS, w.at + BULK_MS);
    this.db
      .query('INSERT INTO phone_snooze (conversation_id, until) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET until = MAX(until, excluded.until)')
      .run(w.conversationId, w.at + SNOOZE_MS);
  }

  private onPhone(device: string): boolean {
    if (!device) return false;
    const rows = this.db.query('SELECT label FROM push_subscription WHERE id = ? OR device = ?').all(device, device) as Row[];
    return rows.some((r) => PHONE.test(r.label ?? ''));
  }

  private end(cid: string, outcome: Outcome, at: number) {
    this.db.query('UPDATE phone_episode SET ended_at = ?, outcome = ?, outcome_at = ? WHERE conversation_id = ? AND ended_at IS NULL AND mode = ?').run(at, outcome, at, cid, this.mode);
  }

  /**
   * Every few seconds: held episodes whose chat was read anywhere end; episodes 12 hours old end. Returns the chats
   * whose rows should now leave the phones (none in shadow, where rows go out as before).
   */
  sweep(now = Date.now()): string[] {
    if (this.mode === 'off') return [];
    for (const r of this.db.query(`SELECT conversation_id AS cid, first_ts FROM phone_episode WHERE ended_at IS NULL AND sent = 0 AND mode = ?`).all(this.mode) as Row[]) {
      if (this.o.readTs(r.cid) >= r.first_ts) this.end(r.cid, 'read', now);
    }
    const old = this.db.query(`SELECT conversation_id AS cid, sent FROM phone_episode WHERE ended_at IS NULL AND started_at <= ? AND mode = ?`).all(now - EXPIRE_MS, this.mode) as Row[];
    for (const r of old) this.end(r.cid, 'expired', now);
    if (now - this.tallyAt >= HOUR) this.logLine(now);
    return this.mode === 'on' ? old.filter((r) => r.sent).map((r) => r.cid) : [];
  }

  /** Once an hour, when anything was asked: what went and what was held, for the log after a deploy. */
  private logLine(now: number) {
    const t = this.tally;
    this.tally = new Map();
    this.tallyAt = now;
    this.db.query('DELETE FROM phone_snooze WHERE until <= ?').run(now);
    this.db.query('DELETE FROM phone_episode WHERE started_at < ? AND ended_at IS NOT NULL').run(now - KEEP_MS);
    if (!t.size) return;
    const part = (prefix: string) => [...t].filter(([k]) => k.startsWith(prefix)).map(([k, n]) => `${n} ${k.slice(prefix.length)}`);
    const sent = part('sent ');
    const held = part('held ');
    const would = this.mode === 'shadow' ? 'would have held' : 'held';
    console.log(`phone list (${this.mode}): in the last hour ${sent.length ? `sent ${sent.join(', ')}` : 'sent none'}; ${would} ${held.length ? held.join(', ') : 'none'}; ${this.openRows()} of ${LIST_CAP} rows open`);
  }
}
