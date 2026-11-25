/**
 * For you (docs/foryou.md): single messages from channels, threads and groups of seven or more that are not to you,
 * ranked, one per burst, served as a snapshot that never reorders under the reader. Not the X notifications feed
 * (feed.ts, docs/feed.md).
 *
 * Candidates are what triage decided in the last two days at the List or below (`digest`, `drop`), read from
 * `triage_created` a page at a time and kept in memory: after the first read only what triage decided since is read.
 * Of those, the best few thousand by importance are looked up (their message, chat and author), so a snapshot never
 * walks the 60-odd thousand a busy hub decides in two days. Everything that reads many rows runs in slices
 * (slices.ts), so a request waits at most a slice behind it.
 *
 * Order (v1): triage's importance times a freshness decay (half-life eight hours), bursts folded into their best
 * message, a reply shown with what it answers (and that message dropped), the same post in several chats once, and at
 * most two items per chat and one per author in any ten. In each ten, slots 4 and 9 are exploration: a draw from
 * outside the top 30, weighted by importance and by how little that chat has been shown, logged with its exact
 * chance. Ranked slots log a chance of 1. Seeing an item marks nothing read.
 *
 * What was served (foryou_item) and what each device said of it (foryou_event) are part of the activity log: ids
 * and numbers only, written only while the log is on (activity.ts prunes and clears them).
 */
import type * as P from '@dither-chat/protocol';
import { FORYOU_EVENTS } from '@dither-chat/protocol';
import { QUIET_VARIANTS } from './feed.ts';
import { requestHeld } from './add.ts';
import { SELF_SQL } from './interact.ts';
import { sliced, whole, type SliceOptions } from './slices.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Candidates are this recent. */
const WINDOW = 2 * DAY;
/** Importance below this is never a candidate. */
const MIN_SCORE = 0.1;
/** Of the candidates, at most this many of the most important are looked up for a snapshot... */
const POOL = 3000;
/** ...and at most this many lookups made for it (a lookup can be refused: a DM, a small group, a muted chat). */
const LOOKUPS = 3 * POOL;
/** Rows read from triage between yields. */
const PAGE = 2048;
/** Freshness halves the score every this long. */
export const HALF_LIFE = 8 * HOUR;
/** Messages from others closer together than this are one burst (labels.ts BURST)... */
export const BURST_GAP = 30 * MIN;
/** ...and a burst is cut after this long, so a channel busy all day is not one item. */
export const BURST_SPAN = 2 * HOUR;
/** The same author and text in several chats within this long is one item. */
const CROSSPOST = 10 * MIN;
/** A group of this many members or more is in For you; a smaller one stays in the inbox. */
const BIG_GROUP = 7;
/** Items in a snapshot, at most. */
const SNAPSHOT = 200;
/** In each ten, these positions (from 0) are exploration slots: the plan's slots 4 and 9. */
export const EXPLORE_AT: readonly number[] = [3, 8];
/** Exploration draws from outside this many of the best. */
export const EXPLORE_OUTSIDE = 30;
/** Exploration's temperature on the score. */
const TAU = 0.25;
/** Diversity in any ten consecutive items. */
const PER_CHAT = 2;
const PER_AUTHOR = 1;
const SPREAD = 10;
/** Shown items per chat are counted this far back, for novelty. */
const NOVELTY_WINDOW = 14 * DAY;
/** Snapshots kept for paging, the newest. */
const SNAPSHOTS_KEPT = 8;
/** The pool is read again after this long, at most (what triage decided since). */
const FRESH_AFTER = 20_000;

/** A message that could be an item. */
export interface Candidate {
  id: string;
  conv: string;
  author: string | null;
  ts: number;
  /** Triage's importance, and when it decided (about when the message came). */
  prior: number;
  decided: number;
  replyTo: string | null;
  chars: number;
  /** A short hash of the first of its text, for the same post in several chats (never stored). */
  text: string;
}

/** An item as the snapshot places it. */
interface Placed {
  c: Candidate;
  /** What ordered it: importance times freshness. */
  score: number;
  position: number;
  slot: P.ForYouSlot;
  propensity: number;
  burst: { from: number; to: number; n: number };
  also: string[];
}

interface Snapshot {
  epoch: string;
  at: number;
  items: Placed[];
  /** Burst counts worked out at serve time. */
  counts: Map<number, number>;
}

export const freshness = (ageMs: number) => Math.pow(0.5, Math.max(0, ageMs) / HALF_LIFE);

/** Candidates of one chat into bursts: a gap of BURST_GAP, or a burst longer than BURST_SPAN, starts another. */
export function bursts(cands: Candidate[]): Candidate[][] {
  const sorted = [...cands].sort((a, b) => a.ts - b.ts);
  const out: Candidate[][] = [];
  let cur: Candidate[] = [];
  for (const c of sorted) {
    if (cur.length && (c.ts - cur[cur.length - 1].ts > BURST_GAP || c.ts - cur[0].ts > BURST_SPAN)) {
      out.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface Scored {
  c: Candidate;
  score: number;
  burst: { from: number; to: number; n: number };
  also: string[];
}

/**
 * The candidates folded and scored, best first: one per burst (its best by score, the latest on a tie), a reply's
 * original dropped when both are in, and a post in several chats kept once with the others in `also`.
 */
export function fold(cands: Candidate[], now: number): Scored[] {
  const byConv = new Map<string, Candidate[]>();
  for (const c of cands) {
    const l = byConv.get(c.conv);
    if (l) l.push(c);
    else byConv.set(c.conv, [c]);
  }
  const score = (c: Candidate) => c.prior * freshness(now - c.ts);
  let items: Scored[] = [];
  for (const list of byConv.values()) {
    for (const b of bursts(list)) {
      const best = b.reduce((x, y) => (score(y) > score(x) || (score(y) === score(x) && y.ts > x.ts) ? y : x));
      items.push({ c: best, score: score(best), burst: { from: b[0].ts, to: b[b.length - 1].ts, n: b.length }, also: [] });
    }
  }
  // A reply in, with what it answers: the reply stays and shows the original quoted.
  const answered = new Set(items.map((i) => i.c.replyTo).filter((x): x is string => !!x));
  items = items.filter((i) => !answered.has(i.c.id));
  items.sort((a, b) => b.score - a.score || b.c.ts - a.c.ts || (a.c.id < b.c.id ? -1 : 1));
  // The same author and text in several chats, close together: the best one, naming the others.
  const kept: Scored[] = [];
  const seen = new Map<string, Scored[]>();
  for (const i of items) {
    if (i.c.author && i.c.text) {
      const k = `${i.c.author}\n${i.c.text}`;
      const twin = (seen.get(k) ?? []).find((o) => Math.abs(o.c.ts - i.c.ts) <= CROSSPOST && o.c.conv !== i.c.conv);
      if (twin) {
        if (!twin.also.includes(i.c.conv)) twin.also.push(i.c.conv);
        continue;
      }
      seen.set(k, [...(seen.get(k) ?? []), i]);
    }
    kept.push(i);
  }
  return kept;
}

/** Whether `s` may go next after `placed`, by the caps on chats and authors in any ten. */
function fits(placed: { c: Candidate }[], s: { c: Candidate }): boolean {
  const recent = placed.slice(-(SPREAD - 1));
  if (recent.filter((p) => p.c.conv === s.c.conv).length >= PER_CHAT) return false;
  if (s.c.author && recent.filter((p) => p.c.author === s.c.author).length >= PER_AUTHOR) return false;
  return true;
}

/**
 * The snapshot's order. Ranked slots take the best that fits the diversity caps (the best at all when nothing does).
 * Exploration slots draw from what is outside the best EXPLORE_OUTSIDE and fits the caps, each with weight
 * exp(score / TAU) × novelty, and log the exact chance of what they drew; with nothing to draw from, the slot is
 * ranked. `novelty` is per chat, 1 for a chat never shown.
 */
export function place(scored: Scored[], o: { random: () => number; novelty: (conv: string) => number; size?: number }): Placed[] {
  const size = Math.min(o.size ?? SNAPSHOT, scored.length);
  const outside = new Set(scored.slice(EXPLORE_OUTSIDE).map((s) => s.c.id));
  const left = [...scored];
  const out: Placed[] = [];
  const take = (i: number, slot: P.ForYouSlot, propensity: number) => {
    const [s] = left.splice(i, 1);
    out.push({ ...s, position: out.length, slot, propensity });
  };
  while (out.length < size && left.length) {
    if (EXPLORE_AT.includes(out.length % 10)) {
      const pool = left.map((s, i) => ({ s, i })).filter(({ s }) => outside.has(s.c.id) && fits(out, s));
      if (pool.length) {
        const w = pool.map(({ s }) => Math.exp(s.score / TAU) * o.novelty(s.c.conv));
        const total = w.reduce((a, b) => a + b, 0);
        let r = o.random() * total;
        let k = 0;
        while (k < pool.length - 1 && r >= w[k]) r -= w[k++];
        take(pool[k].i, 'explore', w[k] / total);
        continue;
      }
    }
    const i = left.findIndex((s) => fits(out, s));
    take(i < 0 ? 0 : i, 'rank', 1);
  }
  return out;
}

/** Why an item is here, in words. */
function reasons(p: Placed, now: number): string[] {
  const out = [`Importance ${p.c.prior.toFixed(2)}`];
  const h = (now - p.c.ts) / HOUR;
  out.push(h < 1 ? 'Less than an hour old' : `${Math.round(h)} h old: counts ${Math.round(freshness(now - p.c.ts) * 100)}%`);
  if (p.burst.n > 1) out.push(`Best of ${p.burst.n} picks in its burst`);
  if (p.slot === 'explore') out.push(`Trying: new to you (a ${Math.round(p.propensity * 100)}% draw)`);
  return out;
}

const shortHash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

const randomId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('base64url');

interface ForYouOptions {
  /** Whether the activity log is on: served items and events are written only then. */
  logging?: () => boolean;
  /** A chat's notification level by your rules (triage.ts effectiveLevel): 'none' is muted, and stays out. */
  levelOf?: (conversationId: string) => string;
  now?: () => number;
  random?: () => number;
  slices?: SliceOptions;
  /** Straight through, not in slices: for tests. */
  whole?: boolean;
  /**
   * What your "worth seeing" answers taught, as a factor on a candidate's score (loudlearn.ts; only while the loudness
   * decides, DITHER_ATTENTION=on). Absent: 1.
   */
  worth?: (c: { conv: string; author: string | null }) => number;
  /** One card a day is asked about, "Glad I saw this / Not for me", on the Notification calibration page (checkin.ts). */
  ask?: (items: { id: string; messageId: string }[]) => { checkinId: string; itemId: string } | null;
}

export class ForYou {
  /** Candidates from triage: message id → importance and when it was decided. */
  private raw = new Map<string, { score: number; at: number }>();
  /** Where the last read of triage stopped. */
  private cursor: { at: number; rowid: number } = { at: 0, rowid: 0 };
  private readAt = 0;
  /** Looked-up candidates (null: never one), forgotten with their raw row. */
  private details = new Map<string, Candidate | null>();
  private snaps = new Map<string, Snapshot>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private store: Store,
    private o: ForYouOptions = {},
  ) {}

  private get db() {
    return this.store.db;
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }
  private run<T>(name: string, g: Generator<number | undefined, T>): Promise<T> {
    return this.o.whole ? Promise.resolve(whole(g)) : sliced(name, g, this.o.slices);
  }
  /** One at a time: a page waits for a snapshot another request is taking. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => {});
    return p;
  }

  // ---------------------------------------------------------------- candidates

  /** What triage decided since the last read, in pages; then what is older than the window goes. */
  *read(now: number): Generator<number, void> {
    const since = now - WINDOW;
    if (this.cursor.at < since) this.cursor = { at: since, rowid: 0 };
    const q = this.db.query(
      `SELECT rowid, message_id, decision, score, created_at FROM triage
       WHERE (created_at, rowid) > (?, ?) AND created_at <= ? ORDER BY created_at, rowid LIMIT ${PAGE}`,
    );
    for (;;) {
      const rows = q.all(this.cursor.at, this.cursor.rowid, now) as Row[];
      for (const r of rows) {
        if ((r.decision === 'digest' || r.decision === 'drop') && r.score !== null && r.score >= MIN_SCORE) this.raw.set(r.message_id, { score: r.score, at: r.created_at });
      }
      if (rows.length) this.cursor = { at: rows[rows.length - 1].created_at, rowid: rows[rows.length - 1].rowid };
      yield rows.length;
      if (rows.length < PAGE) break;
    }
    let n = 0;
    for (const [id, r] of this.raw) {
      if (r.at < since) {
        this.raw.delete(id);
        this.details.delete(id);
      }
      if (++n % PAGE === 0) yield PAGE;
    }
    this.readAt = now;
  }

  /** The candidate behind one message id, or null when it can never be one (looked up once). */
  private detail(id: string, prior: number, decided: number): Candidate | null {
    const known = this.details.get(id);
    if (known !== undefined) return known ? { ...known, prior, decided } : null;
    const r = this.db
      .query(
        `SELECT m.id, m.conversation_id, m.author_id, m.ts, m.reply_to_id, m.mentions_self, m.mentions_all, m.deleted, length(m.body) AS chars, substr(m.body, 1, 160) AS head,
                c.shape, c.variant,
                (SELECT r.author_id FROM message r WHERE r.id = m.reply_to_id) AS reply_author
         FROM message m CROSS JOIN conversation c ON c.id = m.conversation_id WHERE m.id = ?`,
      )
      .get(id) as Row | null;
    let out: Candidate | null = null;
    const toYou = !!r && (r.mentions_self || (r.reply_author && this.store.isSelf(r.reply_author)));
    if (r && !r.deleted && !toYou && !this.store.isSelf(r.author_id) && !QUIET_VARIANTS.has(r.variant) && r.variant !== 'follow' && (r.shape === 'channel' || r.shape === 'thread' || (r.shape === 'group' && this.bigGroup(r.conversation_id)))) {
      out = { id: r.id, conv: r.conversation_id, author: r.author_id ?? null, ts: r.ts, prior, decided, replyTo: r.reply_to_id ?? null, chars: r.chars ?? 0, text: r.head ? shortHash(String(r.head).trim().toLowerCase()) : '' };
    }
    this.details.set(id, out);
    return out;
  }

  private groups = new Map<string, boolean>();
  private bigGroup(conv: string): boolean {
    let b = this.groups.get(conv);
    if (b === undefined) {
      b = ((this.db.query('SELECT COUNT(*) AS n FROM participant WHERE conversation_id = ?').get(conv) as Row).n as number) >= BIG_GROUP;
      this.groups.set(conv, b);
    }
    return b;
  }

  /** Per chat, now: muted, hidden, a request, and what you have read up to. */
  private chatState(conv: string, levels: Map<string, { out: boolean; read: number }>) {
    let s = levels.get(conv);
    if (!s) {
      const c = this.db.query('SELECT parent_id FROM conversation WHERE id = ?').get(conv) as Row | null;
      const hidden = !!this.db.query(`SELECT 1 FROM place_pref WHERE kind = 'conversation' AND id IN (?, ?) AND hidden = 1`).get(conv, c?.parent_id ?? conv);
      const read = ((this.db.query(`SELECT MAX(COALESCE(last_read_ts, 0)) AS r FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).get(conv) as Row | null)?.r as number | null) ?? 0;
      const out = hidden || requestHeld(this.db, conv) || this.o.levelOf?.(conv) === 'none';
      s = { out, read };
      levels.set(conv, s);
    }
    return s;
  }

  /** The candidates as of now, best by importance first looked up, the unwanted and the read left out. */
  *candidates(now: number): Generator<number, Candidate[]> {
    if (now - this.readAt >= FRESH_AFTER || !this.readAt) yield* this.read(now);
    // Only the best LOOKUPS or so are sorted: a histogram of importance finds where they start.
    const hist = new Array<number>(101).fill(0);
    for (const r of this.raw.values()) hist[Math.min(100, Math.floor(r.score * 100))]++;
    let floor = 0;
    for (let b = 100, sum = 0; b >= 0; b--) {
      sum += hist[b];
      if (sum >= LOOKUPS) {
        floor = b / 100;
        break;
      }
    }
    yield this.raw.size;
    const order = [...this.raw].filter(([, r]) => r.score >= floor).sort((a, b) => b[1].score - a[1].score || b[1].at - a[1].at);
    yield order.length;
    const out: Candidate[] = [];
    const chats = new Map<string, { out: boolean; read: number }>();
    let looked = 0;
    let i = 0;
    for (const [id, r] of order) {
      if (out.length >= POOL || looked >= LOOKUPS) break;
      if (!this.details.has(id)) looked++;
      const c = this.detail(id, r.score, r.at);
      if (c) {
        const s = this.chatState(c.conv, chats);
        // Read already (in the app or on the network): not for you any more.
        if (!s.out && c.ts > s.read) out.push(c);
      }
      if (++i % 256 === 0) yield 256;
    }
    return out;
  }

  // ---------------------------------------------------------------- snapshots

  /** Shown items per chat lately, for exploration's novelty. */
  private novelty(now: number): (conv: string) => number {
    const n = new Map<string, number>();
    for (const r of this.db
      .query(`SELECT i.conversation_id AS c, COUNT(*) AS n FROM foryou_event e CROSS JOIN foryou_item i ON i.id = e.item_id WHERE e.kind = 'shown' AND e.at >= ? GROUP BY i.conversation_id`)
      .all(now - NOVELTY_WINDOW) as Row[])
      n.set(r.c, r.n);
    return (conv) => 1 / Math.sqrt(1 + (n.get(conv) ?? 0));
  }

  private *snapshot(now: number): Generator<number, Snapshot> {
    const cands = yield* this.candidates(now);
    let scored = fold(cands, now);
    const worth = this.o.worth;
    if (worth) scored = scored.map((x) => ({ ...x, score: x.score * worth({ conv: x.c.conv, author: x.c.author }) })).sort((a, b) => b.score - a.score);
    yield scored.length;
    const items = place(scored, { random: this.o.random ?? Math.random, novelty: this.novelty(now) });
    const snap: Snapshot = { epoch: randomId(), at: now, items, counts: new Map() };
    this.snaps.set(snap.epoch, snap);
    while (this.snaps.size > SNAPSHOTS_KEPT) this.snaps.delete(this.snaps.keys().next().value!);
    return snap;
  }

  /**
   * A page of a snapshot: `epoch` null (or one the hub no longer has) takes a fresh one. Each item served is logged
   * once, while the activity log is on.
   */
  page(epoch: string | null, from = 0, limit = 20): Promise<P.ForYouPage> {
    return this.serial(async () => {
      const now = this.now();
      let snap = epoch ? this.snaps.get(epoch) : undefined;
      const reset = !!epoch && !snap;
      if (!snap) snap = await this.run('foryou.snapshot', this.snapshot(now));
      const n = Math.min(Math.max(0, limit), 50);
      const slice = snap.items.slice(from, from + n);
      const served = this.serve(snap, slice, now);
      // The first page of a snapshot may pick the day's one "worth seeing" question: it waits on the Notification
      // calibration page, not on the card.
      if (from === 0) this.o.ask?.(served.items.map((i) => ({ id: i.id, messageId: i.message.id })));
      return { ...served, epoch: snap.epoch, at: snap.at, next: from + n < snap.items.length ? from + n : null, ...(reset ? { reset: true } : {}) };
    });
  }

  private serve(snap: Snapshot, slice: Placed[], now: number): Pick<P.ForYouPage, 'items' | 'quoted' | 'identities'> {
    const rows = slice.length ? (this.db.query(`SELECT * FROM message WHERE id IN (${slice.map(() => '?').join(',')})`).all(...slice.map((p) => p.c.id)) as Row[]) : [];
    const views = new Map(this.store.messageViews(rows).map((m) => [m.id, m]));
    const replies = slice.map((p) => p.c.replyTo).filter((x): x is string => !!x);
    const qrows = replies.length ? (this.db.query(`SELECT * FROM message WHERE id IN (${replies.map(() => '?').join(',')})`).all(...replies) as Row[]) : [];
    const quoted = this.store.messageViews(qrows);
    const count = this.db.query(`SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND ts >= ? AND ts <= ? AND deleted = 0 AND (author_id IS NULL OR author_id NOT IN ${SELF_SQL})`);
    const items: P.ForYouItem[] = [];
    const log = this.o.logging?.() ?? false;
    const put = this.db.query(
      `INSERT OR IGNORE INTO foryou_item (id, epoch, message_id, conversation_id, author_id, position, slot, propensity, score, prior, age_ms, burst_n, chars, reply, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = () => {
      for (const p of slice) {
        const m = views.get(p.c.id);
        if (!m || m.deleted) continue;
        let burst = snap.counts.get(p.position);
        if (burst === undefined) {
          burst = Math.max(1, ((count.get(p.c.conv, p.burst.from, p.burst.to) as Row).n as number) || 1);
          snap.counts.set(p.position, burst);
        }
        const id = `${snap.epoch}.${p.position}`;
        items.push({
          id,
          message: m,
          position: p.position,
          slot: p.slot,
          propensity: p.propensity,
          burst: { count: burst, from: p.burst.from, to: p.burst.to },
          ...(p.also.length ? { also: p.also } : {}),
          reasons: reasons(p, snap.at),
        });
        if (log) put.run(id, snap.epoch, p.c.id, p.c.conv, p.c.author, p.position, p.slot, p.propensity, p.score, p.c.prior, snap.at - p.c.ts, burst, p.c.chars, p.c.replyTo ? 1 : 0, now);
      }
    };
    if (log) this.db.transaction(write)();
    else write();
    return { items, quoted, identities: this.store.identitiesOf([...items.map((i) => i.message), ...quoted]) };
  }

  /** How many items a fresh snapshot would bring that this one has not got: new bursts since it was taken. */
  fresh(epoch: string): Promise<{ fresh: number; known: boolean }> {
    return this.serial(async () => {
      const snap = this.snaps.get(epoch);
      if (!snap) return { fresh: 0, known: false };
      const now = this.now();
      const cands = await this.run('foryou.fresh', this.candidates(now));
      // Decided since the snapshot (a late message too), folded as a snapshot would be: one per new burst.
      const have = new Set(snap.items.map((p) => p.c.id));
      return { fresh: fold(cands.filter((c) => c.decided > snap.at && !have.has(c.id)), now).length, known: true };
    });
  }

  // ---------------------------------------------------------------- what the devices say

  /** Events from a device. Only items the hub served (and logged) count; each device's first of a kind stays, a shown's time on screen grows. */
  events(list: Partial<P.ForYouEvent>[], now = this.now()): number {
    if (!(this.o.logging?.() ?? false)) return 0;
    const known = this.db.query('SELECT created_at FROM foryou_item WHERE id = ?');
    const put = this.db.query(
      `INSERT INTO foryou_event (item_id, device, kind, at, ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id, device, kind) DO UPDATE SET at = MIN(at, excluded.at), ms = MAX(COALESCE(ms, 0), COALESCE(excluded.ms, 0))`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const e of list.slice(0, 500)) {
        const id = typeof e?.itemId === 'string' && e.itemId.length <= 80 ? e.itemId : null;
        const device = typeof e?.device === 'string' && e.device && e.device.length <= 64 ? e.device : null;
        if (!id || !device || !FORYOU_EVENTS.includes(e.kind as P.ForYouEventKind)) continue;
        const item = known.get(id) as Row | null;
        if (!item) continue;
        const at = Math.min(Math.max(Number(e.at) || now, item.created_at), now + MIN);
        const ms = e.kind === 'shown' ? Math.min(Math.max(Math.floor(Number(e.ms) || 0), 0), DAY) : null;
        n += put.run(id, device, e.kind!, at, ms).changes;
      }
    })();
    return n;
  }

  /** Served, shown and clicked since a time: the click rate on shown items is the scorecard's measure. */
  stats(since: number): P.ForYouStats {
    const one = (sql: string) => ((this.db.query(sql).get(since) as Row).n as number) ?? 0;
    const served = one('SELECT COUNT(*) AS n FROM foryou_item WHERE created_at >= ?');
    const shown = one(`SELECT COUNT(DISTINCT item_id) AS n FROM foryou_event WHERE kind = 'shown' AND at >= ?`);
    const clicked = one(`SELECT COUNT(DISTINCT e.item_id) AS n FROM foryou_event e WHERE e.kind = 'clicked' AND e.at >= ? AND EXISTS (SELECT 1 FROM foryou_event s WHERE s.item_id = e.item_id AND s.kind = 'shown')`);
    const explored = one(`SELECT COUNT(DISTINCT e.item_id) AS n FROM foryou_event e CROSS JOIN foryou_item i ON i.id = e.item_id WHERE e.kind = 'shown' AND e.at >= ? AND i.slot = 'explore'`);
    return { since, served, shown, clicked, clickRate: shown ? clicked / shown : null, exploreShare: shown ? explored / shown : null };
  }
}
