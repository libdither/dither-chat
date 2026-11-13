/**
 * Keeping all mail (docs/mail.md "Keeping all mail"): every message of an account and its whole text held here, until
 * a search of the server would find nothing the hub's own search cannot. On for every account when MailHub's
 * `keepAll` says so (main.ts), with a switch per account (mail_keep).
 *
 * For a kept account:
 *
 *   - The walk (backfill.ts) lists every mailbox to its end after the year it lists for any account: All mail (else
 *     Archive), Inbox, Sent, Trash, Junk, Drafts and each label or folder (walkBoxes), kept up from then on. The cap on
 *     summaries and its hourly sweep do not apply.
 *   - Bodies: every message's, newest first, at P4 (below the bodies fetched ahead and the walk, in the same budget of
 *     2 calls a second that waits 10 s after a page's call: backfill.ts Budget). Never evicted, outside the body cache's
 *     cap; the search text holds all of each body's text up to MAIL_LIMITS.keepTextBytes, outside the index's cap
 *     (cache.ts). A body already here whose text was cut at the old 16 KB is cut again from it, with no call.
 *   - Its mailbox counts (mail.mailboxes) are asked again every MAIL_LIMITS.keepCountsMs, and once its walk is done:
 *     they are how much the server holds.
 *   - Disk guard: no body is fetched while the disk holding the data dir has under MAIL_LIMITS.keepFreeGb free.
 *
 * Archive reads (the walk's pages, these bodies, the audits' searches and gets) say `background: true` when the
 * account's status says it has a lane for them (details.backgroundLane), never otherwise; a page's reads never do. When
 * the status says background reads stopped (details.backgroundStopped: 'challenge', 'signedOut', 'quota'), or one
 * answers 503 `paused`, all of this stops for the account at once and nothing is tried again until a status no longer
 * says so (AccountSync.archiveGoes).
 *
 * A Google account (dither-accounts' google kind: Gmail through its own web page, under the owner's real sign-in) whose
 * status has not said it has a lane keeps only what any account keeps (a year, all of Inbox, the bodies fetched ahead,
 * the cap): none of the above, so the hub's two calls a second never go through that session. Its row says 'waiting',
 * it is not searched locally, and its archive starts by itself once a status says `backgroundLane: true`. One gate,
 * MailStore.keeping, holds all three (the walk's legs, the bodies, the audits); the owner's Resume does not lift it,
 * and it does not touch mail_keep.
 *
 * Coverage, per account (GET /api/mail/keep, Settings → Indexing):
 *
 *   - each walked mailbox's server count against the hub's locations there, and whether it is listed to its end;
 *   - bodies held against messages held;
 *   - the search measure: each server search a page asked (search.ts) is a mail_search_measure row: its hits, how
 *     many the hub held before, how many with body text, how many its own search found;
 *   - Gmail's audits (its search takes dates): once the walk is done, month windows searched on the server with
 *     operators only (`after:<epoch s> before:<epoch s>`), their ids compared with what the hub holds (by native id,
 *     Message-ID or emailId, as store.ts identifies messages); what the hub lacks is stored. At most
 *     MAIL_LIMITS.auditPerHour searches an hour an account, at P5, the lowest. Today mail.search answers at most 50,
 *     so a window that comes back full is split in halves, down to an hour (`splitSearch`); where the status says
 *     search pages by ids (details.searchIds), a window is paged whole by cursor with Gmail's estimate
 *     (`idsSearch`), and the splitting is not used. Re-checked: the current month daily, the last three weekly, the
 *     last year monthly, older twice a year.
 *
 * Searched locally: the walk is done, every message has its text, every audited window matches (Gmail) or every
 * mailbox holds at least what its server counts (other servers), and the last LOCAL_SEARCHES server searches found
 * nothing the hub did not hold. Then server=auto does not ask that account's server (search.ts); server=1 does, and
 * measures. Worked out each time it is asked, so a condition lost (a server search finding something new, a count
 * growing) turns it off at once.
 */
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import type * as M from '@dither-chat/protocol/mail-iface';
import { unref } from '../clock.ts';
import { timedWork } from '../stalls.ts';
import { asMailError } from './backend.ts';
import { walkBoxes } from './backfill.ts';
import { putText, storeBody, TEXT_KEPT } from './cache.ts';
import type { MailHub } from './index.ts';
import { DAY, MAIL_LIMITS } from './limits.ts';
import { P4, P5 } from './queue.ts';
import type { MailRouter } from './routes.ts';
import type { AccountSync } from './sync.ts';

type Row = Record<string, any>;

/** A kept account's bodies on their way at once: one in the background slot, one waiting for it. */
const BODIES_AT_ONCE = 2;
/** Bodies already here cut again from their own text, at most this many a turn (no call). */
const RECUT_AT_ONCE = 100;
/** How often each account is looked at: the walk goes on, bodies are fed, audits are due. */
const TICK_MS = 30_000;
/** mail.search answers at most this many today: a window that comes back with as many is split. */
export const AUDIT_LIMIT = 50;
/** An ids-only search's page (details.searchIds). */
export const AUDIT_IDS_PAGE = 500;
/** The smallest window a full one is split to: an hour (after: and before: take epoch seconds). */
export const AUDIT_MIN_MS = 3_600_000;
/** Searched locally once at least this many server searches, the last this many, found nothing the hub lacked. */
export const LOCAL_SEARCHES = 20;
/** The search measure the page shows: this many days. */
export const MEASURE_DAYS = 30;
/** Why a Google account's mail is not all here yet while it waits for a lane (MailStore.laneWaits). */
export const LANE_WAIT = "Waiting for dither-accounts' slow lane for Gmail";
const GB = 1024 ** 3;

/** An ids-only search's answer (details.searchIds): native ids, the next page's cursor, Gmail's estimate. */
interface IdsAnswer {
  ids: string[];
  next: string | null;
  estimate: number | null;
}

/** Where a kept account's newest-first pass over its bodies has got to. */
interface Feed {
  /** The last message looked at: [received_at, id]; null: from the top. */
  cursor: [number, string] | null;
  going: Set<string>;
  /** Fetches that failed: not asked again until then. */
  failed: Map<string, number>;
  /** Nothing left to fetch, until then or new mail. */
  idleUntil: number;
}

/** A window's server search, as one of the two ways goes: what it found, and how. */
interface WindowFound {
  server: number;
  held: number;
  /** Summaries the hub lacked (split search), or native ids (ids-only). */
  missing: M.MailSummary[];
  missingIds: string[];
  full: boolean;
  estimate: number | null;
  searches: number;
}

/** Gmail's search operators for a window, epoch seconds: `after:` from its start (none for the first), `before:` its end. */
export const auditQuery = (start: number, end: number) => [start > 0 ? `after:${Math.floor(start / 1000)}` : '', `before:${Math.floor(end / 1000)}`].filter(Boolean).join(' ');

/** How long a matched window waits before it is searched again: the current month daily, then less and less often. */
export function recheckMs(w: { start: number; end: number; state: string }, now: number): number {
  const age = now - w.end;
  const every = w.end > now ? DAY : age < 92 * DAY ? 7 * DAY : age < 365 * DAY ? 30 * DAY : 182 * DAY;
  return w.state === 'full' ? Math.min(every, 7 * DAY) : every;
}

/** The start of the month `t` is in, local time. */
const monthOf = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};
const nextMonth = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
};

export class Keeper {
  private feeds = new Map<string, Feed>();
  private audits = new Map<string, Promise<void>>();
  /** When each account's last audit search started (the hourly pace). */
  private searchedAt = new Map<string, number>();
  private countsAt = new Map<string, number>();
  private walked = new Set<string>();
  private timer: unknown = null;
  private stopped = false;
  private disk = { at: -Infinity, free: null as number | null };

  constructor(private hub: MailHub) {}

  private get store() {
    return this.hub.store;
  }
  private get now() {
    return this.hub.clock.now();
  }

  start() {
    const loop = () => {
      if (this.stopped) return;
      try {
        this.tick();
      } catch {
        // The database closed: the hub is gone.
        return;
      }
      this.timer = this.hub.clock.setTimeout(loop, TICK_MS);
      unref(this.timer);
    };
    this.timer = this.hub.clock.setTimeout(loop, 1_000);
    unref(this.timer);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.hub.clock.clearTimeout(this.timer);
  }

  /** The disk guard's floor, in bytes. */
  get floor(): number {
    return MAIL_LIMITS.keepFreeGb * GB;
  }

  /** Bytes free where the hub keeps its data, asked at most once a minute; null: not known. */
  free(): number | null {
    if (this.now - this.disk.at > 60_000) this.disk = { at: this.now, free: this.hub.freeBytes() };
    return this.disk.free;
  }

  /** The disk guard holds: no body is fetched. */
  diskLow(): boolean {
    const f = this.free();
    return f !== null && f < this.floor;
  }

  /** Every account looked at. */
  tick() {
    for (const a of this.store.accounts()) this.kick(a.id);
  }

  /** An account's work goes on where it may: the walk, its counts, its bodies, its audits. */
  kick(accountId: string) {
    const s = this.hub.sync(accountId);
    if (!s || this.stopped) return;
    if (!this.store.keeping(accountId) || !s.archiveGoes) return;
    s.backfill.start();
    this.counts(accountId, s);
    this.pump(accountId, s);
    this.audit(accountId, s);
  }

  /** New mail for an account: its bodies are looked for again. */
  arrived(accountId: string) {
    const f = this.feeds.get(accountId);
    if (f) f.idleUntil = 0;
  }

  // ---------------------------------------------------------- the walk and the counts

  /** Every mailbox the walk lists is listed to its end. */
  walkDone(accountId: string): boolean {
    const boxes = walkBoxes(this.store, accountId);
    return boxes.length > 0 && boxes.every((b) => b.complete);
  }

  /** The mailboxes' counts asked again: every so often, and once when the walk is done. */
  private counts(accountId: string, s: AccountSync) {
    const done = this.walkDone(accountId);
    const fresh = done && !this.walked.has(accountId);
    if (done) this.walked.add(accountId);
    else this.walked.delete(accountId);
    const at = this.countsAt.get(accountId) ?? 0;
    if (!fresh && this.now - at < MAIL_LIMITS.keepCountsMs) return;
    this.countsAt.set(accountId, this.now);
    s.queue.run(P4, 'counts', () => s.refreshMailboxes()).catch((e) => s.log(`counts: ${asMailError(e).message}`));
  }

  // ---------------------------------------------------------- bodies

  private feed(accountId: string): Feed {
    let f = this.feeds.get(accountId);
    if (!f) this.feeds.set(accountId, (f = { cursor: null, going: new Set(), failed: new Map(), idleUntil: 0 }));
    return f;
  }

  /** Bodies on their way for a kept account, up to BODIES_AT_ONCE, newest first, unless the disk guard holds. */
  private pump(accountId: string, s: AccountSync) {
    const f = this.feed(accountId);
    const now = this.now;
    if (f.idleUntil > now || this.diskLow()) return;
    for (const [id, until] of f.failed) if (until <= now) f.failed.delete(id);
    let recut = 0;
    while (f.going.size < BODIES_AT_ONCE) {
      const id = this.next(accountId, f, now);
      if (!id) {
        f.idleUntil = now + 5 * 60_000;
        return;
      }
      // Its body is here: its text cut again from it (it was cut at the old cap), no call.
      const here = this.store.one<{ text: string | null }>('SELECT text FROM mail_body WHERE message_id = ?', id);
      if (here) {
        putText(this.store, id, here.text, true);
        if (++recut >= RECUT_AT_ONCE) {
          // The rest a moment later: the event loop breathes.
          unref(this.hub.clock.setTimeout(() => this.kick(accountId), 50));
          return;
        }
        continue;
      }
      f.going.add(id);
      s.fetchBody(id, P4, true)
        .then(
          () => this.hub.emit('body', { messageId: id }),
          (e) => {
            const err = asMailError(e);
            f.failed.set(id, this.now + (err.status === 404 ? DAY : 3_600_000));
            if (err.status !== 404 && err.code !== 'paused' && !/stopped/.test(err.message)) s.log(`keep: a body: ${err.message}`);
          },
        )
        .finally(() => {
          f.going.delete(id);
          if (!this.stopped) this.kick(accountId);
        });
    }
  }

  /** The next message whose text a kept account lacks, newest first from where the pass got to; null: none. */
  private next(accountId: string, f: Feed, now: number): string | null {
    let wrapped = false;
    for (;;) {
      const c = f.cursor;
      const rows = this.store.all<{ id: string; received_at: number }>(
        `SELECT m.id, m.received_at FROM mail_message m WHERE m.account_id = ? ${c ? 'AND (m.received_at < ? OR (m.received_at = ? AND m.id < ?))' : ''}
           AND NOT EXISTS (SELECT 1 FROM mail_text t INDEXED BY mail_text_kept WHERE t.message_id = m.id AND ${TEXT_KEPT})
         ORDER BY m.received_at DESC, m.id DESC LIMIT 20`,
        accountId,
        ...(c ? [c[0], c[0], c[1]] : []),
      );
      if (!rows.length) {
        if (!c || wrapped) return null;
        // The bottom: from the top again, once.
        f.cursor = null;
        wrapped = true;
        continue;
      }
      for (const r of rows) {
        f.cursor = [r.received_at, r.id];
        if (f.going.has(r.id) || (f.failed.get(r.id) ?? 0) > now) continue;
        return r.id;
      }
    }
  }

  // ---------------------------------------------------------- audits (Gmail)

  /** Gmail's month windows are searched once the walk is done, one account's at a time. */
  private audit(accountId: string, s: AccountSync) {
    if (this.audits.has(accountId) || !this.mayAudit(accountId, s)) return;
    const run = this.auditLoop(accountId, s)
      .catch((e) => {
        const err = asMailError(e);
        if (err.code !== 'paused' && !/stopped/.test(err.message)) s.log(`audit: ${err.message}`);
      })
      .finally(() => this.audits.delete(accountId));
    this.audits.set(accountId, run);
  }

  private mayAudit(accountId: string, s: AccountSync): boolean {
    return !this.stopped && this.store.keeping(accountId) && s.archiveGoes && this.store.gmail(accountId) && this.walkDone(accountId);
  }

  /** Windows due, one after another, until none is (the next tick looks again). */
  private async auditLoop(accountId: string, s: AccountSync) {
    this.windows(accountId);
    for (;;) {
      if (!this.mayAudit(accountId, s)) return;
      const w = this.due(accountId);
      if (!w) return;
      const found = await this.searchWindow(accountId, s, w);
      if (!found) return;
      await this.settleWindow(accountId, s, w, found);
    }
  }

  /**
   * The account's windows: one a month from the month of the oldest mail held to this one, and one before all that
   * (start 0), which ends where the months begin (and is checked again when they reach further back).
   */
  windows(accountId: string) {
    const oldest = this.store.one<{ t: number | null }>('SELECT MIN(received_at) AS t FROM mail_message WHERE account_id = ?', accountId)?.t;
    if (oldest === null || oldest === undefined) return;
    const first = monthOf(oldest);
    const add = this.store.db.query(`INSERT OR IGNORE INTO mail_audit (account_id, start, end) VALUES (?, ?, ?)`);
    this.store.db.transaction(() => {
      for (let t = first; t <= this.now; t = nextMonth(t)) add.run(accountId, t, nextMonth(t));
      const before = this.store.one<{ end: number }>('SELECT end FROM mail_audit WHERE account_id = ? AND start = 0', accountId);
      if (!before) add.run(accountId, 0, first);
      else if (before.end !== first) this.store.db.query(`UPDATE mail_audit SET end = ?, state = 'todo' WHERE account_id = ? AND start = 0`).run(first, accountId);
    })();
  }

  /** The window to search next: one never searched or that found mail missing here, newest first; else the most overdue. */
  private due(accountId: string): Row | null {
    const rows = this.store.all<Row & { start: number; end: number; state: string; checked_at: number | null }>('SELECT * FROM mail_audit WHERE account_id = ? ORDER BY start DESC', accountId);
    const open = rows.find((r) => r.state === 'todo' || r.state === 'missed');
    if (open) return open;
    const now = this.now;
    let best: Row | null = null;
    let over = -1;
    for (const r of rows) {
      const late = now - (r.checked_at ?? 0) - recheckMs(r, now);
      if (late >= 0 && late > over) (best = r), (over = late);
    }
    return best;
  }

  /** Waits for the account's next audit search (MAIL_LIMITS.auditPerHour); false when it may not go on meanwhile. */
  private async pace(accountId: string, s: AccountSync): Promise<boolean> {
    const gap = 3_600_000 / MAIL_LIMITS.auditPerHour;
    const wait = (this.searchedAt.get(accountId) ?? -Infinity) + gap - this.now;
    if (wait > 0) await new Promise<void>((r) => unref(this.hub.clock.setTimeout(r, wait)));
    if (!this.mayAudit(accountId, s)) return false;
    this.searchedAt.set(accountId, this.now);
    return true;
  }

  /**
   * A window searched on the server. Where the status says search pages by ids (details.searchIds), paged whole;
   * otherwise split while it comes back full (today's mail.search answers at most AUDIT_LIMIT). Null: stopped.
   *
   * The seam: once every Gmail extractor has ids-only search, `splitSearch` and AUDIT_MIN_MS can go.
   */
  private searchWindow(accountId: string, s: AccountSync, w: Row): Promise<WindowFound | null> {
    return this.store.account(accountId)?.search_ids ? this.idsSearch(accountId, s, w) : this.splitSearch(accountId, s, w);
  }

  private async idsSearch(accountId: string, s: AccountSync, w: Row): Promise<WindowFound | null> {
    const query = auditQuery(w.start, w.end);
    const ids: string[] = [];
    let cursor: string | null = null;
    let estimate: number | null = null;
    let searches = 0;
    do {
      if (!(await this.pace(accountId, s))) return null;
      const input: Record<string, unknown> = { query, limit: AUDIT_IDS_PAGE, idsOnly: true, ...(cursor ? { cursor } : {}) };
      const r: IdsAnswer = await s.queue.run(P5, `audit:${w.start}:${cursor ?? ''}`, () => s.background<IdsAnswer>('mail.search', input, 60_000));
      searches++;
      ids.push(...(Array.isArray(r?.ids) ? r.ids : []));
      if (estimate === null && typeof r?.estimate === 'number') estimate = r.estimate;
      cursor = r?.next ?? null;
    } while (cursor);
    const unique = [...new Set(ids)];
    const missingIds = unique.filter((id) => !this.heldNative(accountId, id));
    return { server: unique.length, held: unique.length - missingIds.length, missing: [], missingIds, full: false, estimate, searches };
  }

  private async splitSearch(accountId: string, s: AccountSync, w: Row): Promise<WindowFound | null> {
    const out: WindowFound = { server: 0, held: 0, missing: [], missingIds: [], full: false, estimate: null, searches: 0 };
    const stack: [number, number][] = [[w.start, w.end]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      if (!(await this.pace(accountId, s))) return null;
      const input = { query: auditQuery(a, b), limit: AUDIT_LIMIT };
      const r = await s.queue.run(P5, `audit:${a}:${b}`, () => s.background<{ messages: M.MailSummary[] }>('mail.search', input, 60_000));
      out.searches++;
      const list = Array.isArray(r?.messages) ? r.messages : [];
      if (list.length >= AUDIT_LIMIT && b - a > AUDIT_MIN_MS) {
        // Full: the server may have more than it said. In halves, on whole seconds, newer half first.
        const mid = a + Math.max(1_000, Math.floor((b - a) / 2_000) * 1_000);
        stack.push([a, mid], [mid, b]);
        continue;
      }
      if (list.length >= AUDIT_LIMIT) out.full = true;
      out.server += list.length;
      for (const m of list) {
        if (this.heldSummary(accountId, m)) out.held++;
        else out.missing.push(m);
      }
    }
    return out;
  }

  /** What the hub lacked is stored now (summaries as listed; by id, through mail.get, with its body); the window's row. */
  private async settleWindow(accountId: string, s: AccountSync, w: Row, f: WindowFound) {
    let caught = 0;
    if (f.missing.length) caught += await this.storeSummaries(accountId, s, f.missing);
    for (const id of f.missingIds) {
      if (!s.archiveGoes) break;
      const m = await s.queue.run(P5, `audit-get:${id}`, () => s.background<M.MailMessage>('mail.get', { id }, 65_000)).catch((e) => {
        if (asMailError(e).code === 'paused') throw e;
        return null;
      });
      if (m && (await this.storeSummaries(accountId, s, [m]))) {
        caught++;
        const hid = this.heldNative(accountId, m.id);
        if (hid) {
          timedWork('mail: a body (archive)', () => storeBody(this.store, hid, m));
          this.hub.emit('body', { messageId: hid });
        }
      }
    }
    const missed = f.missing.length + f.missingIds.length;
    const state = missed ? 'missed' : f.full ? 'full' : 'match';
    this.store.db
      .query('UPDATE mail_audit SET state = ?, server = ?, held = ?, caught = caught + ?, estimate = ?, searches = ?, checked_at = ? WHERE account_id = ? AND start = ?')
      .run(state, f.server, f.held, caught, f.estimate, f.searches, this.now, accountId, w.start);
    if (missed) s.log(`audit: ${missed} message(s) in a window were not here; stored`);
  }

  /** Summaries stored as listed (a mailbox not known yet: the list again first). Returns how many were new here. */
  private async storeSummaries(accountId: string, s: AccountSync, list: M.MailSummary[]): Promise<number> {
    if (list.some((m) => !this.store.mailboxByNative(accountId, m.mailboxId))) await s.refreshMailboxes().catch(() => {});
    let n = 0;
    const by = new Map<string, M.MailSummary[]>();
    for (const m of list) by.set(m.mailboxId, [...(by.get(m.mailboxId) ?? []), m]);
    for (const [native, ms] of by) {
      const box = this.store.mailboxByNative(accountId, native);
      if (!box) continue;
      const ing = timedWork(`mail: ${ms.length} summaries (archive)`, () => {
        const ing = this.store.ingest(accountId, box, ms);
        s.stored(ing, false);
        return ing;
      });
      n += ing.added.length;
    }
    return n;
  }

  /** The hub's message at this native id in any of the account's mailboxes. */
  private heldNative(accountId: string, nativeId: string): string | null {
    return this.store.one<{ message_id: string }>('SELECT message_id FROM mail_location WHERE native_id = ? AND mailbox_id IN (SELECT id FROM mailbox WHERE account_id = ?) LIMIT 1', nativeId, accountId)?.message_id ?? null;
  }

  /** The hub holds this summary's message: at its place, by its Message-ID, or by its emailId (store.ts identify). */
  private heldSummary(accountId: string, m: M.MailSummary): boolean {
    const box = this.store.mailboxByNative(accountId, m.mailboxId);
    if (box && this.store.one('SELECT 1 FROM mail_location WHERE mailbox_id = ? AND native_id = ?', box.id, m.id)) return true;
    if (m.messageId && this.store.one('SELECT 1 FROM mail_message WHERE id = ?', mailId('mml', accountId, `m:${m.messageId}`))) return true;
    return !!(m.emailId && this.store.one('SELECT 1 FROM mail_message WHERE account_id = ? AND email_id = ?', accountId, m.emailId));
  }

  // ---------------------------------------------------------- coverage

  /** server=auto may leave this account's server out (search.ts): its mail is all here. The cheap answers first. */
  searchedLocally(accountId: string): boolean {
    const a = this.store.account(accountId);
    if (!a || !this.store.kept(accountId) || this.store.laneWaits(accountId)) return false;
    const last = this.store.all<{ found: number; held: number }>('SELECT found, held FROM mail_search_measure WHERE account_id = ? ORDER BY n DESC LIMIT ?', accountId, LOCAL_SEARCHES);
    if (last.length < LOCAL_SEARCHES || last.some((r) => r.held < r.found)) return false;
    return this.view(a).local.on;
  }

  /** One account measured against its server. */
  view(a: Row): P.MailKeepView {
    const st = this.store;
    const id = a.id as string;
    const k = st.keepState(id);
    const s = this.hub.sync(id);
    const gmail = st.gmail(id);
    const held = st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE account_id = ?', id)!.n;
    // Through the indexes that hold `cut` and `bytes` (schema-keep.sql): the rows would mean reading every text.
    const t = st.one<{ n: number; kept: number | null; bytes: number | null }>(
      `SELECT COUNT(*) AS n, SUM(${TEXT_KEPT}) AS kept, SUM(t.bytes) AS bytes FROM mail_message m CROSS JOIN mail_text t INDEXED BY mail_text_kept ON t.message_id = m.id WHERE m.account_id = ?`,
      id,
    )!;
    const bodies = k.keep ? (t.kept ?? 0) : t.n;
    const bytes = {
      bodies: st.one<{ n: number | null }>('SELECT SUM(b.bytes) AS n FROM mail_message m CROSS JOIN mail_body b INDEXED BY mail_body_bytes ON b.message_id = m.id WHERE m.account_id = ?', id)!.n ?? 0,
      text: t.bytes ?? 0,
    };
    const heldIn = new Map(st.all<{ b: string; n: number }>('SELECT l.mailbox_id AS b, COUNT(*) AS n FROM mail_location l JOIN mailbox x ON x.id = l.mailbox_id WHERE x.account_id = ? GROUP BY l.mailbox_id', id).map((r) => [r.b, r.n]));
    const walked = walkBoxes(st, id);
    const boxes: P.MailKeepBox[] = walked.map((b) => ({ id: b.id, name: b.name, role: b.role ?? null, total: b.total ?? null, held: heldIn.get(b.id) ?? 0, complete: !!b.complete }));
    const total = serverTotal(boxes);
    const legs = s?.backfill.legs() ?? [];
    const on = legs.length ? st.mailbox(legs[0].mailboxId) : null;
    const walkComplete = k.keep ? boxes.length > 0 && boxes.every((b) => b.complete) : legs.length === 0;
    const walk = { complete: walkComplete, mailbox: walkComplete ? null : (on?.name ?? null), back: walkComplete ? null : (on?.horizon ?? null), done: boxes.filter((b) => b.complete).length, mailboxes: boxes.length };

    let audit: P.MailKeepView['audit'] = null;
    if (gmail) {
      const r = st.one<Row>(
        `SELECT COUNT(*) AS windows, SUM(state = 'match') AS matched, SUM(state = 'missed') AS missed, SUM(checked_at IS NOT NULL) AS checked, SUM(caught) AS caught, SUM(estimate) AS estimate, COUNT(estimate) AS estimated FROM mail_audit WHERE account_id = ?`,
        id,
      )!;
      audit = { windows: r.windows, matched: r.matched ?? 0, missed: r.missed ?? 0, checked: r.checked ?? 0, caught: r.caught ?? 0, estimate: r.estimated ? r.estimate : null };
    }

    const since = this.now - MEASURE_DAYS * DAY;
    const m = st.one<Row>('SELECT COUNT(*) AS searches, SUM(found) AS found, SUM(held) AS held, SUM(bodies) AS bodies, SUM(local) AS local FROM mail_search_measure WHERE account_id = ? AND at >= ?', id, since)!;
    const measure = { searches: m.searches, found: m.found ?? 0, held: m.held ?? 0, bodies: m.bodies ?? 0, local: m.local ?? 0 };

    const waits = st.laneWaits(id);
    const missing: string[] = [];
    if (!k.keep) missing.push('Not kept: turn on Keep all mail');
    else {
      if (waits) missing.push(LANE_WAIT);
      if (!walkComplete) missing.push('The walk through its mailboxes is not done');
      if (bodies < held) missing.push(`${(held - bodies).toLocaleString('en')} messages without their text here`);
      if (gmail) {
        if (!audit?.windows || audit.matched < audit.windows) missing.push(`${((audit?.windows ?? 0) - (audit?.matched ?? 0)).toLocaleString('en')} of ${(audit?.windows ?? 0).toLocaleString('en')} months not searched on Gmail yet, or not matching`);
      } else {
        const short = boxes.filter((b) => b.total !== null && b.held < b.total);
        if (short.length) missing.push(`${short.map((b) => b.name).join(', ')}: fewer here than the server counts`);
      }
      const last = st.all<{ found: number; held: number }>('SELECT found, held FROM mail_search_measure WHERE account_id = ? ORDER BY n DESC LIMIT ?', id, LOCAL_SEARCHES);
      if (last.length < LOCAL_SEARCHES) missing.push(`${last.length} of ${LOCAL_SEARCHES} server searches measured`);
      else if (last.some((r) => r.held < r.found)) missing.push(`A server search in the last ${LOCAL_SEARCHES} found mail not held here`);
    }

    const stopped = st.backgroundStopped(id);
    const left = !walkComplete || bodies < held || this.audits.has(id) || (this.feeds.get(id)?.going.size ?? 0) > 0;
    const state: P.MailKeepView['state'] = !k.keep
      ? 'off'
      : !s?.workable
        ? 'offline'
        : stopped
          ? 'stopped'
          : waits
            ? 'waiting'
            : k.paused
              ? 'paused'
              : this.diskLow() && bodies < held
                ? 'disk'
                : left
                  ? 'running'
                  : 'idle';
    return {
      accountId: id,
      keep: k.keep,
      paused: k.paused,
      state,
      stopped,
      backgroundLane: !!a.background_lane,
      messages: { held, total },
      bodies,
      bytes,
      walk,
      boxes,
      audit,
      measure,
      local: { on: missing.length === 0, missing },
      storage: a.storage ? JSON.parse(a.storage) : null,
    };
  }

  page(): P.MailKeepPage {
    return { accounts: this.store.accounts().filter((a) => !a.hidden && !a.gone_at).map((a) => this.view(a)), disk: { free: this.free(), floor: this.floor } };
  }
}

/**
 * How many messages the server holds, from its mailboxes' counts: All mail (else Archive) with Trash and Junk where
 * there is one (a label is a view of All mail), else every mailbox walked. Null when it gives no counts.
 */
export function serverTotal(boxes: P.MailKeepBox[]): number | null {
  const all = boxes.find((b) => b.role === 'all');
  const pick = all ? [all, ...boxes.filter((b) => b.role === 'trash' || b.role === 'junk')] : boxes;
  const counted = pick.filter((b) => b.total !== null);
  return counted.length ? counted.reduce((n, b) => n + b.total!, 0) : null;
}

const KEEPERS = new WeakMap<MailHub, Keeper>();
/** The hub's Keeper, as its router made it. */
export const keepOf = (hub: MailHub) => KEEPERS.get(hub) ?? null;

/** GET /api/mail/keep, PUT /api/mail/keep/:accountId (P.MailKeepChange). */
export const keepRoutes: MailRouter = (hub) => {
  const k = new Keeper(hub);
  KEEPERS.set(hub, k);
  hub.on('ingested', (e) => k.arrived(e.accountId));
  hub.on('account', (e) => {
    if (e.state === 'added' || e.state === 'changed') k.kick(e.accountId);
  });
  // A Google account's archive waited for its lane (MailStore.laneWaits): it starts now, not at the next tick.
  hub.on('lane', (e) => k.kick(e.accountId));
  k.start();
  hub.stopping.push(() => k.stop());
  return [
    {
      method: 'GET',
      path: /^\/api\/mail\/keep$/,
      handle: () => Response.json(k.page() satisfies P.MailKeepPage),
    },
    {
      method: 'PUT',
      path: /^\/api\/mail\/keep\/([\w-]+)$/,
      handle: async ({ params, body }) => {
        const a = hub.store.account(params[0]);
        if (!a) return Response.json({ error: 'no such mail account' }, { status: 404 });
        const b = await body<P.MailKeepChange>();
        const change: P.MailKeepChange = {};
        if (typeof b.keep === 'boolean') change.keep = b.keep;
        if (typeof b.paused === 'boolean') change.paused = b.paused;
        if (!Object.keys(change).length) return Response.json({ error: 'keep or paused, as true or false' }, { status: 400 });
        hub.store.setKeep(a.id, change);
        hub.store.dirty.progress.add(a.id);
        k.arrived(a.id);
        k.kick(a.id);
        return Response.json(k.view(hub.store.account(a.id)!) satisfies P.MailKeepView);
      },
    },
  ];
};
