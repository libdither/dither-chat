/**
 * Big mailboxes (docs/mail-design.md §3.3, §3.5, §2.5; docs/mail.md). After the first sync, each account lists its
 * older mail in the background, a page of MAIL_LIMITS.backfillPage at a time, in this order:
 *
 *   1. Inbox, then Sent, back to the horizon (MAIL_LIMITS.syncDays: a year)
 *   2. All mail (Gmail, Proton), else Archive, back to the horizon
 *   3. the rest of Inbox, to its end (§14 Q2: a year plus all of Inbox)
 *
 * It stops at MAIL_LIMITS.maxPerAccount. Older mail comes when a page asks for it (listPage): the next page of the
 * mailbox behind the list, at user priority. A mailbox the hub does not follow is listed the first time it is opened,
 * and kept up from then on ('open').
 *
 * Budget: the queue's P2 (prefetch) and P3 (backfill) work, one call each, start at most
 * MAIL_LIMITS.backgroundPerSec a second, on at most MAIL_LIMITS.backgroundSlots of the queue's two slots, and not at
 * all for MAIL_LIMITS.userPauseMs after any P0 call. Keep-up (P1) and what a page waits for (P0) are not held back.
 *
 * Live window: a changed thread goes to the pages as it is when it is among the newest MAIL_LIMITS.liveWindow of a
 * mailbox it is in, listed in the one-list inbox, opened lately, or asked for by a page. The others (the backfill's,
 * mostly) make the lists they are in stale (`mail.lists`); a page loads such a list again when it next shows it.
 */
import type * as P from '@dither-chat/protocol';
import { mailboxList, parseMailList, viewList } from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { sleep } from '../clock.ts';
import { asMailError } from './backend.ts';
import { Bodies } from './bodies.ts';
import { BodyCache } from './cache.ts';
import { Headerless } from './headerless.ts';
import type { MailHub } from './index.ts';
import { MAIL_LIMITS, syncHorizon } from './limits.ts';
import { P0, P2, P3, type MailQueue, type Priority } from './queue.ts';
import type { MailStore } from './store.ts';
import type { AccountSync } from './sync.ts';

type Row = Record<string, any>;

// ---------------------------------------------------------------- the budget

/** P2 and P3 together: a few calls a second, one slot, a pause after a page waited on the server (§3.5). */
export class Budget {
  private starts: number[] = [];
  private lastUser = -Infinity;
  private inFlight = 0;

  constructor(q: MailQueue) {
    q.gate = (p, now) => this.gate(p, now);
    q.onStart = (p, now) => {
      if (p === P0) this.lastUser = now;
      else if (p >= P2) {
        this.starts.push(now);
        this.inFlight++;
      }
    };
    q.onEnd = (p) => {
      if (p >= P2) this.inFlight--;
    };
  }

  gate(p: Priority, now: number): number {
    if (p < P2) return 0;
    // The queue pumps again when one ends.
    if (this.inFlight >= MAIL_LIMITS.backgroundSlots) return 1_000;
    while (this.starts.length && this.starts[0] <= now - 1_000) this.starts.shift();
    const rate = this.starts.length >= MAIL_LIMITS.backgroundPerSec ? this.starts[0] + 1_000 - now : 0;
    return Math.max(0, rate, this.lastUser + MAIL_LIMITS.userPauseMs - now);
  }
}

// ---------------------------------------------------------------- one account's backfill

interface Leg {
  mailboxId: string;
  /** Back to this receivedAt; null: to the end. */
  until: number | null;
}

export class Backfill {
  /** Legs are left: the account's phase is 'backfill'. */
  active = false;
  private loop: Promise<void> | null = null;
  /** Pages a page asked for, on their way. */
  private asked = new Map<string, Promise<string[]>>();
  /** One listing of a mailbox at a time: a page asked for meanwhile waits for the one under way. */
  private paging = new Map<string, Promise<string[]>>();
  /** Mailboxes whose listing reached the horizon: their leg to it is done. */
  private reached = new Set<string>();
  private progressAt = 0;

  constructor(private s: AccountSync) {}

  private get store() {
    return this.s.store;
  }

  /** The loop is going (it stops when nothing is left, at the cap, or when the account cannot work). */
  get running() {
    return !!this.loop;
  }

  /** Starts (or goes on with) the backfill, unless it is running or nothing is left. */
  start() {
    if (this.loop || !this.s.workable) return;
    if (!this.store.account(this.s.accountId)?.synced_at) return;
    this.loop = this.run()
      .catch((e) => {
        // Stopping (the hub, or access to the account) is not worth a line.
        if (this.s.workable) this.s.log(`backfill: ${asMailError(e).message}; it goes on at the next minute's check`);
      })
      .finally(() => {
        this.loop = null;
        this.active = false;
        if (this.s.phase === 'backfill') this.s.setPhase('idle');
      });
  }

  /** What is left to list, in order. */
  legs(): Leg[] {
    const boxes = this.store.followed(this.s.accountId).filter((b) => b.follow === 'always');
    const of = (role: string) => boxes.find((b) => b.role === role);
    const inbox = of('inbox');
    const sent = of('sent');
    const all = of('all') ?? of('archive');
    const h = syncHorizon(this.s.now);
    const legs: (Leg | null)[] = [inbox ? { mailboxId: inbox.id, until: h } : null, sent ? { mailboxId: sent.id, until: h } : null, all ? { mailboxId: all.id, until: h } : null, inbox ? { mailboxId: inbox.id, until: null } : null];
    return legs.filter((l): l is Leg => !!l && !this.done(l));
  }

  private done(l: Leg): boolean {
    const b = this.store.mailbox(l.mailboxId);
    if (!b || b.complete) return true;
    if (l.until === null) return false;
    return (b.horizon !== null && b.horizon < l.until) || this.reached.has(b.id);
  }

  held(): number {
    return this.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE account_id = ?', this.s.accountId)?.n ?? 0;
  }

  private async run() {
    for (;;) {
      if (!this.s.workable) return;
      const leg = this.legs()[0];
      if (!leg || this.held() >= MAIL_LIMITS.maxPerAccount) return;
      this.active = true;
      if (this.s.phase === 'idle' || this.s.phase === 'first') this.s.setPhase('backfill');
      await this.s.queue.run(P3, `page:${leg.mailboxId}`, () => this.page(leg.mailboxId, leg.until));
      this.progress();
    }
  }

  /** The progress line moves, at most once a second (`mail.progress`, not journaled). */
  private progress() {
    const now = this.s.now;
    if (now - this.progressAt < 1_000) return;
    this.progressAt = now;
    this.store.dirty.progress.add(this.s.accountId);
  }

  /**
   * The next page of a mailbox, as a page asked for it (P0): a mailbox the hub does not follow yet is followed from now
   * on ('open'), with a state taken before it is listed. Returns the threads it touched.
   */
  more(mailboxId: string): Promise<string[]> {
    // A page asked again while the last is on its way (a slow server) waits for that one.
    const going = this.asked.get(mailboxId);
    if (going) return going;
    const run = this.s.queue
      .run(P0, `page:${mailboxId}`, async () => {
        const b = this.store.mailbox(mailboxId);
        if (!b) return [];
        if (!b.follow) this.store.db.query(`UPDATE mailbox SET follow = 'open' WHERE id = ? AND follow IS NULL`).run(mailboxId);
        try {
          if (!b.state) await this.s.takeState(b);
          return await this.page(mailboxId, null);
        } catch (e) {
          // One that only holds others (IMAP \Noselect, Gmail's `[Gmail]`) cannot be listed: it is not followed after all.
          if (!b.follow && asMailError(e).status === 404) this.store.db.query(`UPDATE mailbox SET follow = NULL WHERE id = ? AND follow = 'open'`).run(mailboxId);
          throw e;
        }
      })
      .finally(() => this.asked.delete(mailboxId));
    this.asked.set(mailboxId, run);
    return run;
  }

  /** One page of a mailbox below where its listing got to. `until`: what is older is left for later. */
  page(mailboxId: string, until: number | null): Promise<string[]> {
    const prev = this.paging.get(mailboxId);
    const run = (prev ? prev.catch(() => []) : Promise.resolve([])).then(() => this.listPage(mailboxId, until));
    this.paging.set(mailboxId, run);
    return run.finally(() => {
      if (this.paging.get(mailboxId) === run) this.paging.delete(mailboxId);
    });
  }

  private async listPage(mailboxId: string, until: number | null): Promise<string[]> {
    const b = this.store.mailbox(mailboxId);
    if (!b || b.complete) return [];
    let r: { messages: M.MailSummary[]; next: string | null };
    try {
      r = await this.s.call('mail.list', { mailboxId: b.native_id, limit: MAIL_LIMITS.backfillPage, ...(b.list_next ? { before: b.list_next } : {}) });
    } catch (e) {
      // A rebuilt mailbox (IMAP: a new UIDVALIDITY) does not know the cursor: its changes pass relists it, and the
      // listing starts over from the top.
      if (asMailError(e).status === 410) {
        this.restart(mailboxId);
        void this.s.changes(mailboxId);
      }
      throw e;
    }
    const row = this.store.mailbox(mailboxId);
    if (!row) return [];
    let list = r.messages;
    let crossed = false;
    if (until !== null) {
      list = list.filter((m) => m.receivedAt >= until);
      crossed = list.length < r.messages.length;
    }
    const ing = this.store.ingest(this.s.accountId, row, list);
    this.s.stored(ing, false);
    const oldest = list.length ? Math.min(...list.map((m) => m.receivedAt)) : null;
    const horizon = oldest === null ? row.horizon : Math.min(oldest, row.horizon ?? oldest);
    if (crossed) {
      // The listing stays where it was: going further lists this page again, whole.
      this.reached.add(mailboxId);
      this.store.setListed(mailboxId, { next: row.list_next, horizon, complete: false });
    } else this.store.setListed(mailboxId, { next: r.next, horizon, complete: !r.next || !r.messages.length });
    return [...ing.threads];
  }

  /** The listing of a mailbox starts over from the top (its cursors are no longer good). */
  private restart(mailboxId: string) {
    this.store.db.query('UPDATE mailbox SET list_next = NULL, horizon = NULL, complete = 0 WHERE id = ?').run(mailboxId);
    this.store.db.query('DELETE FROM mail_page WHERE mailbox_id = ?').run(mailboxId);
    this.reached.delete(mailboxId);
  }
}

// ---------------------------------------------------------------- pages on demand

/** The mailboxes a list is drawn from, which can be listed further: the ones a page beyond them can fetch. */
function sources(hub: MailHub, key: string): Row[] {
  const l = parseMailList(key);
  if (!l) return [];
  if ('mailbox' in l) {
    const b = hub.store.mailbox(l.mailbox);
    return b ? [b] : [];
  }
  if (l.view !== 'inbox' && l.view !== 'sent') return [];
  return hub.store.all(`SELECT b.* FROM mailbox b JOIN mail_account a ON a.id = b.account_id WHERE b.role = ? AND a.hidden = 0 ${l.accountId ? 'AND a.id = ?' : ''}`, l.view, ...(l.accountId ? [l.accountId] : []));
}

/**
 * GET /api/mail/threads (§3.3): a page of a list from what the hub holds. When it runs short and a mailbox behind the
 * list has more on the server, the next page of that mailbox is fetched first, at user priority, for up to
 * MAIL_LIMITS.pageWaitMs; past that the answer is `pending`, and its threads come as `mail.threads` when they do.
 * A list's first page also fetches its first rows' bodies ahead (previews).
 */
export async function pageOnDemand(hub: MailHub, key: string, before: string | null, limit: number): Promise<P.MailThreadPage | null> {
  const st = hub.store;
  let page = st.listThreads(key, before, limit);
  if (!page) return null;
  const boxes = sources(hub, key);
  const now = hub.clock.now();
  for (const b of boxes) if (b.id && key.startsWith('mb:')) st.db.query('UPDATE mailbox SET opened_at = ? WHERE id = ?').run(now, b.id);
  if (!before) bigOf(hub)?.rows(page.threads);
  if (page.next || page.complete) return page;
  const fetch = boxes
    .filter((b) => !b.complete)
    .map((b) => ({ b, s: hub.sync(b.account_id) }))
    // During the first sync its own listing brings these pages.
    .filter((x) => x.s?.workable && x.s.phase !== 'first')
    .map(({ b, s }) =>
      s!.backfill.more(b.id).then(
        (threads) => bigOf(hub)?.window.want(threads),
        (e) => s!.log(`a page of ${b.name}: ${asMailError(e).message}`),
      ),
    );
  if (!fetch.length) return page;
  const done = await Promise.race([Promise.all(fetch).then(() => true), sleep(hub.clock, MAIL_LIMITS.pageWaitMs).then(() => false)]);
  page = st.listThreads(key, before, limit) ?? page;
  return done ? page : { ...page, next: null, complete: false, pending: true };
}

// ---------------------------------------------------------------- the live window

const VIEWS: P.MailView[] = ['inbox', 'unread', 'starred', 'sent', 'people', 'updates'];

/** Which changed threads go to the pages as they are, and which only make their lists stale. */
export class LiveWindow {
  /** Per mailbox: the lastAt of its MAIL_LIMITS.liveWindow-th newest thread (what is older is outside). */
  private cuts = new Map<string, number>();
  private cutsAt = 0;
  /** Threads a page asked for or acted on, until when. */
  private wanted = new Map<string, number>();

  constructor(
    private store: MailStore,
    private now: () => number = Date.now,
  ) {}

  want(ids: string[], ms = 10 * 60_000) {
    const until = this.now() + ms;
    for (const id of ids) this.wanted.set(id, until);
  }

  private cut(mailboxId: string, accountId: string): number {
    const hit = this.cuts.get(mailboxId);
    if (hit !== undefined) return hit;
    const r = this.store.one<{ last_at: number }>(
      'SELECT last_at FROM mail_thread WHERE account_id = ? AND EXISTS (SELECT 1 FROM json_each(mailboxes) WHERE value = ?) ORDER BY last_at DESC LIMIT 1 OFFSET ?',
      accountId,
      mailboxId,
      MAIL_LIMITS.liveWindow - 1,
    );
    // Fewer than that: all of it is in, until more comes (not kept, so the next flush asks again).
    if (!r) return -Infinity;
    this.cuts.set(mailboxId, r.last_at);
    return r.last_at;
  }

  /** Of these changed threads: those held back (outside the window), and the lists that makes stale. */
  split(ids: string[]): { held: Set<string>; stale: string[] } {
    const held = new Set<string>();
    const stale = new Set<string>();
    const now = this.now();
    if (now - this.cutsAt > 2_000) {
      this.cuts.clear();
      this.cutsAt = now;
      for (const [id, until] of this.wanted) if (until < now) this.wanted.delete(id);
    }
    if (!ids.length) return { held, stale: [] };
    const rows = this.store.all<{ id: string; account_id: string; last_at: number; mailboxes: string; listed: number; opened_at: number | null }>(
      'SELECT id, account_id, last_at, mailboxes, listed, opened_at FROM mail_thread WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(ids),
    );
    for (const t of rows) {
      if (t.listed || (t.opened_at ?? 0) > now - 3_600_000 || (this.wanted.get(t.id) ?? 0) >= now) continue;
      const boxes: string[] = JSON.parse(t.mailboxes || '[]');
      if (!boxes.length || boxes.some((b) => t.last_at >= this.cut(b, t.account_id))) continue;
      held.add(t.id);
      // Mail with someone (slice 6): every such list, rather than one for each person on it.
      stale.add('w:*');
      for (const b of boxes) stale.add(mailboxList(b));
      for (const v of VIEWS) {
        stale.add(viewList(v, t.account_id));
        stale.add(viewList(v, null));
      }
    }
    return { held, stale: [...stale] };
  }
}

// ---------------------------------------------------------------- the cap

/**
 * Past MAIL_LIMITS.maxPerAccount summaries, the oldest go: never Inbox's, starred ones, or those of a thread opened in
 * the last week. Each mailbox they leave goes back to the deepest point of its listing above them, so paging further
 * lists them again. Returns the messages deleted.
 */
export function trimToCap(store: MailStore, accountId: string, now = Date.now(), max = MAIL_LIMITS.maxPerAccount): string[] {
  const n = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE account_id = ?', accountId)?.n ?? 0;
  if (n <= max) return [];
  const victims = store.all<{ id: string }>(
    `SELECT m.id FROM mail_message m WHERE m.account_id = ? AND m.flagged = 0
       AND NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = m.id AND b.role = 'inbox')
       AND NOT EXISTS (SELECT 1 FROM mail_thread t WHERE t.id = m.thread_id AND t.opened_at > ?)
     ORDER BY m.received_at, m.id LIMIT ?`,
    accountId,
    now - 7 * 86_400_000,
    n - max,
  ).map((r) => r.id);
  if (!victims.length) return [];
  const json = JSON.stringify(victims);
  let gone: string[] = [];
  store.db.transaction(() => {
    const boxes = store.all<{ mailbox_id: string; newest: number }>(
      'SELECT l.mailbox_id, MAX(m.received_at) AS newest FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.message_id IN (SELECT value FROM json_each(?)) GROUP BY l.mailbox_id',
      json,
    );
    for (const b of boxes) {
      const p = store.one<{ cursor: string; above: number }>('SELECT cursor, above FROM mail_page WHERE mailbox_id = ? AND above > ? ORDER BY above LIMIT 1', b.mailbox_id, b.newest);
      if (p) {
        store.db.query('UPDATE mailbox SET list_next = ?, horizon = ?, complete = 0 WHERE id = ?').run(p.cursor, p.above, b.mailbox_id);
        store.db.query('DELETE FROM mail_page WHERE mailbox_id = ? AND above < ?').run(b.mailbox_id, p.above);
      } else {
        store.db.query('UPDATE mailbox SET list_next = NULL, horizon = NULL, complete = 0 WHERE id = ?').run(b.mailbox_id);
        store.db.query('DELETE FROM mail_page WHERE mailbox_id = ?').run(b.mailbox_id);
      }
    }
    store.db.query('DELETE FROM mail_location WHERE message_id IN (SELECT value FROM json_each(?))').run(json);
    gone = store.deleteOrphans(victims);
  })();
  return gone;
}

// ---------------------------------------------------------------- per hub

/** What slice 2 keeps per hub (bigRoutes makes it). */
export interface BigMail {
  window: LiveWindow;
  /** A list's first rows: their bodies, ahead. */
  rows(threads: P.MailThreadView[]): void;
  /** These messages' bodies, in the background (P2): `body` fires as each comes. */
  prefetch(messageIds: string[]): void;
  /** Accounts whose summaries carry no headers: their one-time steps (headerless.ts). */
  headerless: Headerless;
}

const BIG = new WeakMap<MailHub, BigMail>();
export const bigOf = (hub: MailHub) => BIG.get(hub);
export const setBig = (hub: MailHub, b: BigMail) => BIG.set(hub, b);

/**
 * Slice 2's router (routes.ts ROUTERS): no routes of its own (GET /api/mail/threads goes through pageOnDemand), but it
 * wires the hub: the live window into the store's flush, bodies fetched ahead, the caps checked.
 */
export const bigRoutes = (hub: MailHub): [] => {
  const window = new LiveWindow(hub.store);
  const cache = new BodyCache(hub.store);
  const bodies = new Bodies(hub, cache);
  const headerless = new Headerless(hub, bodies);
  setBig(hub, { window, rows: (t) => bodies.rows(t), prefetch: (ids) => bodies.prefetch(ids), headerless });
  hub.store.window = (ids) => window.split(ids);
  hub.on('ingested', (e) => (e.live ? bodies.arrived(e.messageIds) : bodies.later(e.accountId)));
  hub.on('body', () => cache.stored());
  hub.on('opened', (e) => window.want([e.threadId]));
  hub.on('read', (e) => window.want(e.threadIds));
  const sweep = setInterval(() => {
    try {
      bigSweep(hub, cache);
    } catch {
      // The hub is gone.
      clearInterval(sweep);
    }
  }, 3_600_000);
  sweep.unref?.();
  hub.stopping.push(() => {
    clearInterval(sweep);
    cache.stop();
    bodies.stop();
    headerless.stop();
  });
  return [];
};

/** The hourly sweep: each account past its cap trimmed, then the body cache and the search text. */
export function bigSweep(hub: MailHub, cache = new BodyCache(hub.store)) {
  for (const a of hub.store.accounts()) {
    const gone = trimToCap(hub.store, a.id);
    if (gone.length) hub.emit('deleted', { accountId: a.id, messageIds: gone });
  }
  cache.sweep();
}
