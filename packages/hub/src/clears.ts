/**
 * Read anywhere, gone everywhere (docs/notifications.md, "Read elsewhere, gone here"). Every few seconds the hub takes
 * the chats, mail threads and groups of notices read since it notified about them (delivery.ts `read`) off every
 * device: open pages hear it at once (`cleared`, which closes their notifications), the Android app gets a `{ clear }`
 * push for each, and a desktop browser gets one push for all it was alerted about, as its browser allows.
 *
 * A browser must show something for every push (`userVisibleOnly`), and a push that only closes a notification
 * shows nothing. While another of the app's notifications is still showing there, that costs nothing; otherwise:
 * - Chrome (an FCM endpoint) spends 2 points of a budget that earns 12/24 × engagement/100 an hour, at most 12 a day
 *   on a site used all the time. Spent, it shows its own "updated in the background" notification. So at most
 *   CHROME_COSTLY_PER_DAY of those in 24 hours (4 points: a site of engagement 33 earns that), and CHROME_PER_DAY
 *   clears in all, since "another is still showing" is the hub's guess (`push_shown` rows younger than SHOWING_MS).
 * - Firefox (Mozilla's push service) takes 1 from the subscription's quota; at 0 it drops the subscription without
 *   telling the site. A push that arrives while a tab of the site is open sets the quota to 16; the first push after a
 *   visit in its history sets it to min(16, round(8 * days since that visit ^ -0.8)). The hub cannot see a
 *   notification swiped away, nor which of its visits Firefox's history holds (a tab restored with the session is
 *   none), so every clear counts, and only a refill it is sure of resets the count: a push that reached the
 *   subscription while its page was in use (`refilled_at`), or the subscription being made. At most
 *   `firefoxAllowance` (8, fewer as that gets older) since then.
 * - Safari drops every subscription of a site after 3 pushes that show nothing, so it never gets one. Nor does any
 *   other push service, nor a phone's browser: only the Android app (`clears = 1`) clears a phone.
 *
 * Only what the hub sent there is cleared: what each browser registration was sent is kept (`push_shown`) until it is
 * cleared, tapped, swiped or three days old, and each clear (`push_clear`) for the caps.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { FORGET_MS, type Delivery, type Read } from './delivery.ts';
import type { PhoneList } from './phonelist.ts';
import type { PushService } from './push.ts';

type Row = Record<string, any>;

/** A clear waits this long (seconds) at the push server for a browser that is away; after that a page start tidies up. */
export const CLEAR_TTL = 600;
/**
 * One topic for every clear to a registration (topics are per subscription): a clear waiting at the push server is
 * replaced by the next, which carries everything the replaced one did (`carried`), so a browser that comes back gets
 * one push, not one per chat, and at most one of them costs anything.
 */
export const CLEAR_TOPIC = 'clear';
/** Clears to one Chrome in 24 hours, free or not. */
export const CHROME_PER_DAY = 6;
/** Of those, clears that close the last notification there, which spend Chrome's budget. */
export const CHROME_COSTLY_PER_DAY = 2;
/**
 * A notification sent longer ago than this no longer counts as still showing, for whether a clear is free: the system
 * may have let it go, or "clear all" closed it, and neither tells the hub. A clear can still close it for three days.
 */
export const SHOWING_MS = 4 * 3_600_000;
/** A clear carries at most this many notifications, its own first: well inside a push's 4 KB. */
const MAX_TAGS = 40;
/** Clears are kept this long for the caps: past it Firefox's allowance is 0 anyway. */
const KEEP_MS = 14 * 86_400_000;
const DAY = 86_400_000;
/** A page whose last stay ended this recently, and is not over, is open there (delivery.ts ACTIVE_MS). */
const IN_USE_MS = 2 * 60_000;
const PHONE = /android|iphone|ipad|\bios\b/i;
/** Activity events that mean a notification no longer shows on the device that sent them (sw.js `outcome`). */
const GONE = new Set(['tapped', 'dismissed', 'suppressed', 'replied', 'blocked']);

type ClearRelay = 'chrome' | 'firefox';

/** Which browser's rules a registration's clears follow; null: it never gets one. */
export function clearRelay(endpoint: string, label: string | null | undefined): ClearRelay | null {
  if (PHONE.test(label ?? '') || /safari/i.test(label ?? '')) return null;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.hostname === 'fcm.googleapis.com') return 'chrome';
  if (/(^|\.)push\.services\.mozilla\.com$/.test(u.hostname)) return 'firefox';
  return null;
}

/** Clears Firefox may take since a visit this many days ago: at least one point of its quota is always left. */
export function firefoxAllowance(days: number): number {
  const quota = Math.min(16, Math.round(8 * Math.pow(Math.max(days, 1e-3), -0.8)));
  return Math.max(0, Math.min(8, quota - 1));
}

interface ClearPlan {
  /** What this clear closes: the reads it is for first, then what earlier clears within CLEAR_TTL carried. */
  tags: Read[];
  /** Another notification will still be showing there, as far as the hub knows. */
  free: boolean;
}

/** What each desktop browser was sent, and its clears (`push_shown`, `push_clear`). */
export class BrowserClears {
  constructor(private db: Database) {}

  /** A push went to this registration: what it shows now, under this tag (sw.js `show`), up to `ts`. */
  shown(r: Row, tag: string, ts: number, now = Date.now()) {
    if (r.clears === 1 || !clearRelay(r.endpoint, r.label)) return;
    this.db.query('INSERT INTO push_shown (sub_id, tag, ts, at) VALUES (?, ?, ?, ?) ON CONFLICT (sub_id, tag) DO UPDATE SET ts = excluded.ts, at = excluded.at').run(r.id, tag, ts, now);
  }

  /**
   * What a device said happened to a notification (activity.ts `noted`): tapped, swiped, replied to, or closed at once
   * because the app was in sight, it no longer shows there. `device` is the registration's id, or its page's.
   */
  noted(w: { event: string; conversationId: string | null; device: string }) {
    if (!GONE.has(w.event) || !w.conversationId || !w.device) return;
    this.db.query('DELETE FROM push_shown WHERE tag = ? AND (sub_id = ? OR sub_id IN (SELECT id FROM push_subscription WHERE device = ?))').run(w.conversationId, w.device, w.device);
  }

  /**
   * The clear this registration should get for these reads, or null: nothing of them shows there, its cap is spent, or
   * its page is open (`inUse`). An open page closes them itself, on the hub's `cleared` or on its own read, so they are
   * no longer counted as showing there: most reads at a computer are made in its open page, and would otherwise spend
   * the cap that is there for reads on another device.
   */
  plan(r: Row, reads: Read[], now = Date.now()): ClearPlan | null {
    if (r.clears === 1) return null;
    const relay = clearRelay(r.endpoint, r.label);
    if (!relay) return null;
    const shown = this.db.query('SELECT tag, ts, at FROM push_shown WHERE sub_id = ? AND at > ?').all(r.id, now - FORGET_MS) as { tag: string; ts: number; at: number }[];
    const own = reads.filter((x) => shown.some((s) => s.tag === x.id && s.ts <= x.upTo));
    if (!own.length) return null;
    if (this.inUse(r, now)) {
      this.forget(r.id, own);
      return null;
    }
    const upTo = new Map<string, number>();
    for (const x of [...own, ...this.carried(r.id, now)]) if (upTo.size < MAX_TAGS || upTo.has(x.id)) upTo.set(x.id, Math.max(upTo.get(x.id) ?? 0, x.upTo));
    const tags = [...upTo].map(([id, u]) => ({ id, upTo: u }));
    // Free while one sent lately is left showing; one sent hours ago may be gone without a word.
    const free = shown.some((s) => s.at > now - SHOWING_MS && !(s.ts <= (upTo.get(s.tag) ?? -Infinity)));
    return this.allowed(r, relay, free, now) ? { tags, free } : null;
  }

  /**
   * A push reached this registration (push.ts `deliver`). With its page in use, Firefox's tab is open, so Firefox has
   * just set the subscription's quota back to 16: the count of its clears starts again from here (`allowed`).
   */
  reached(r: Row, now = Date.now()) {
    if (r.clears === 1 || clearRelay(r.endpoint, r.label) !== 'firefox' || !this.inUse(r, now)) return;
    this.db.query('UPDATE push_subscription SET refilled_at = ? WHERE id = ?').run(now, r.id);
  }

  /** Clears to this registration that may still be waiting at the push server: the next one takes their place. */
  private carried(sub: string, now: number): Read[] {
    const rows = this.db.query('SELECT tags FROM push_clear WHERE sub_id = ? AND at > ? ORDER BY at DESC').all(sub, now - CLEAR_TTL * 1000) as Row[];
    return rows.flatMap((x) => JSON.parse(x.tags) as Read[]);
  }

  /** The device's latest stay in the app (activity.ts visits), along the index visit_device. */
  private lastVisit(r: Row): { start: number; end: number; closed: number } | null {
    if (!r.device) return null;
    return this.db.query('SELECT start_at AS start, end_at AS end, closed FROM visit WHERE device = ? ORDER BY start_at DESC LIMIT 1').get(r.device) as { start: number; end: number; closed: number } | null;
  }

  /** Its page is open and was in use in the last two minutes (as delivery.ts `elsewhere` reads a computer in use). */
  private inUse(r: Row, now: number): boolean {
    const v = this.lastVisit(r);
    return !!v && !v.closed && v.end >= now - IN_USE_MS;
  }

  private forget(sub: string, reads: Read[]) {
    for (const t of reads) this.db.query('DELETE FROM push_shown WHERE sub_id = ? AND tag = ? AND ts <= ?').run(sub, t.id, t.upTo);
  }

  /**
   * Chrome: CHROME_PER_DAY in 24 hours, of them CHROME_COSTLY_PER_DAY that close the last notification there.
   * Firefox: every clear since the last refill the hub is sure of, within `firefoxAllowance` of its age. Not since the
   * device's last visit: a visit Firefox's history does not hold (a tab restored with the session) sets nothing back,
   * and one it does hold sets the quota by days since that visit, which only lowers the allowance of an older refill.
   */
  private allowed(r: Row, relay: ClearRelay, free: boolean, now: number): boolean {
    const count = (since: number, costly: boolean) => (this.db.query(`SELECT COUNT(*) AS n FROM push_clear WHERE sub_id = ? AND at > ?${costly ? ' AND free = 0' : ''}`).get(r.id, since) as Row).n as number;
    if (relay === 'chrome') return count(now - DAY, false) < CHROME_PER_DAY && (free || count(now - DAY, true) < CHROME_COSTLY_PER_DAY);
    const since = Math.max(r.refilled_at ?? 0, r.created_at ?? 0);
    return count(since, false) < firefoxAllowance((now - since) / DAY);
  }

  /** Counted before it goes, so a slow push server cannot let two clears past one cap; `undo` if it was not taken. */
  sending(sub: string, plan: ClearPlan, now = Date.now()): { done(): void; undo(): void } {
    const id = this.db.query('INSERT INTO push_clear (sub_id, at, free, tags) VALUES (?, ?, ?, ?)').run(sub, now, plan.free ? 1 : 0, JSON.stringify(plan.tags)).lastInsertRowid;
    return {
      done: () => this.forget(sub, plan.tags),
      undo: () => void this.db.query('DELETE FROM push_clear WHERE rowid = ?').run(id),
    };
  }

  prune(now = Date.now()) {
    this.db.query('DELETE FROM push_shown WHERE at <= ?').run(now - FORGET_MS);
    this.db.query('DELETE FROM push_clear WHERE at <= ?').run(now - KEEP_MS);
  }
}

/**
 * One round (main.ts, every five seconds): open pages, the Android app and desktop browsers lose the notifications of
 * what was read. Resolves once every push has been answered; a failed one goes to `failed`.
 */
export function clearRead(
  d: {
    delivery: Pick<Delivery, 'read'>;
    phone: Pick<PhoneList, 'read'>;
    push: Pick<PushService, 'clear' | 'clearBrowsers'>;
    /** To open pages, with the next flush (store.ts `dirty.extra`). */
    live: (ev: P.ClientEvent) => void;
    failed: (e: unknown) => void;
  },
  now = Date.now(),
): Promise<unknown> {
  const reads = d.delivery.read(now);
  if (!reads.length) return Promise.resolve();
  // Of the moment, like typing: a page that was away tidies up when it comes back (web state.ts). `upTo`, as in a
  // clear push: an alert that reached the device after the read stays.
  d.live({ t: 'cleared', reads: reads.map((r) => ({ id: r.id, upTo: r.upTo })) });
  for (const r of reads) d.phone.read(r.id);
  return Promise.all([...reads.map((r) => d.push.clear(r.id, r.upTo).catch(d.failed)), d.push.clearBrowsers(reads, now).catch(d.failed)]);
}
