/**
 * Keeping one mail account's copy here up to date (docs/mail-design.md §3.3, §3.4): the first sync, then keeping up
 * through the extractor's events and mail.changes, and a relist when a state is too old (410).
 *
 * First sync: the mailboxes; Inbox's mail.changes state and its newest page (the screen fills after three calls), then
 * Sent's state and newest page, the other followed mailboxes' states, then Inbox and Sent down to
 * MAIL_LIMITS.firstSync. A mailbox's state is always taken before it is listed, so nothing that arrives meanwhile is
 * missed. Going further back (to MAIL_LIMITS.syncDays, and all of Inbox) is backfill.ts, once the first sync is done.
 *
 * Keeping up: `mail.arrived` is stored at once; `mail.changed` with a new state queues a changes pass for that
 * mailbox; a timer is insurance; the manager coming back, a gap, the account coming online and the hub starting each
 * run a changes pass on every followed mailbox. A message removed from one mailbox may have moved to another: before it
 * is deleted, the other followed mailboxes are asked what changed, so a move keeps the hub's message.
 */
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { type Clock, realClock } from '../clock.ts';
import { asMailError, type MailBackend } from './backend.ts';
import { Backfill, Budget } from './backfill.ts';
import { storeBody } from './cache.ts';
import { MAIL_LIMITS } from './limits.ts';
import { MailQueue, P0, P1, type Priority } from './queue.ts';
import type { Ingested, MailStore } from './store.ts';

type Row = Record<string, any>;

export interface SyncContext {
  store: MailStore;
  backend: MailBackend;
  /** New messages stored: MailHub passes them on as its `ingested` event. */
  ingested(accountId: string, messageIds: string[], live: boolean): void;
  /** Messages deleted because the server no longer has them. */
  deleted(accountId: string, messageIds: string[]): void;
  log(msg: string): void;
  now?: () => number;
  /** Timers: the queue's waits, the retry of a first sync (default: the real ones). */
  clock?: Clock;
}

export class AccountSync {
  phase: P.MailAccountView['sync']['phase'] = 'idle';
  readonly queue: MailQueue;
  /** Older mail, in the background (backfill.ts). */
  readonly backfill: Backfill;
  private stopped = false;
  private first: Promise<void> | null = null;
  private orphans = new Set<string>();
  private settling: Promise<void> | null = null;
  private timer: Timer | null = null;
  private retry: unknown = null;
  private clock: Clock;

  constructor(
    readonly accountId: string,
    private ctx: SyncContext,
  ) {
    this.clock = ctx.clock ?? realClock;
    this.queue = new MailQueue(2, ctx.now ?? (() => this.clock.now()), this.clock);
    new Budget(this.queue);
    this.backfill = new Backfill(this);
  }

  get store() {
    return this.ctx.store;
  }
  get now() {
    return (this.ctx.now ?? Date.now)();
  }
  log(msg: string) {
    this.ctx.log(`[${this.accountId}] ${msg}`);
  }
  call<T>(op: string, input: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.ctx.backend.call<T>(this.accountId, op, input, timeoutMs);
  }
  /** Background work waits for the manager and for the account to be online. */
  get workable(): boolean {
    return !this.stopped && this.ctx.backend.connected && !!this.store.account(this.accountId)?.online;
  }

  setPhase(p: AccountSync['phase']) {
    if (this.phase === p) return;
    this.phase = p;
    this.store.dirty.accounts.add(this.accountId);
  }

  /** The first sync if it has not finished, else a catch-up; then the timer. */
  start() {
    if (this.stopped) return;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 60_000);
    if (!this.store.account(this.accountId)?.synced_at) void this.firstSync();
    else void this.catchUp();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) this.clock.clearTimeout(this.retry);
    this.queue.stop();
  }

  /** Done when the first sync is (tests and scripts wait on it). */
  whenSynced(): Promise<void> {
    return this.first ?? Promise.resolve();
  }

  // ---------------------------------------------------------- first sync

  firstSync(): Promise<void> {
    if (this.first) return this.first;
    if (!this.workable) return Promise.resolve();
    this.setPhase('first');
    this.first = this.runFirst()
      .then(() => {
        this.store.markSynced(this.accountId);
        return this.catchUp();
      })
      // The backfill took over, or there was nothing left to list.
      .then(() => {
        if (this.phase === 'first') this.setPhase('idle');
      })
      .catch((e) => {
        this.setPhase('idle');
        this.ctx.log(`[${this.accountId}] first sync stopped: ${asMailError(e).message}; trying again in a minute`);
        if (!this.stopped) this.retry = this.clock.setTimeout(() => ((this.first = null), this.start()), 60_000);
      });
    return this.first;
  }

  private async runFirst() {
    await this.queue.run(P1, 'mailboxes', () => this.refreshMailboxes());
    const followed = this.store.followed(this.accountId);
    const inbox = followed.find((b) => b.role === 'inbox');
    const sent = followed.find((b) => b.role === 'sent');
    // Each state before its list: whatever changes while the lists come is in the next changes pass.
    const state = async (b: Row) => {
      const now = this.store.mailbox(b.id);
      if (now && !now.state) await this.queue.run(P1, `state:${b.id}`, () => this.takeState(now));
    };
    for (const b of [inbox, sent]) {
      if (!b) continue;
      await state(b);
      await this.queue.run(P1, `list:${b.id}`, () => this.listTop(b, MAIL_LIMITS.firstPage));
    }
    for (const b of followed) await state(b);
    for (const b of [inbox, sent]) if (b) await this.queue.run(P1, `list:${b.id}`, () => this.listDown(b, MAIL_LIMITS.firstSync));
  }

  async refreshMailboxes() {
    const r = await this.call<{ mailboxes: M.Mailbox[] }>('mail.mailboxes');
    this.orphan(this.store.putMailboxes(this.accountId, r.mailboxes));
    await this.settle();
  }

  async takeState(b: Row) {
    const r = await this.call<M.MailChanges>('mail.changes', { mailboxId: b.native_id });
    this.store.setState(b.id, r.state);
  }

  stored(ing: Ingested, live: boolean) {
    if (ing.added.length) this.ctx.ingested(this.accountId, ing.added, live);
    this.orphan(ing.orphans);
  }

  /** The newest `n` of a mailbox. */
  private async listTop(b: Row, n: number) {
    const r = await this.call<{ messages: M.MailSummary[]; next: string | null }>('mail.list', { mailboxId: b.native_id, limit: n });
    const row = this.store.mailbox(b.id);
    if (!row) return;
    this.stored(this.store.ingest(this.accountId, row, r.messages), false);
    const oldest = r.messages.length ? Math.min(...r.messages.map((m) => m.receivedAt)) : null;
    this.store.setListed(b.id, { next: r.next, horizon: oldest, complete: !r.next });
  }

  /** Further down from where the list got to, until `max` are held or it ends. */
  private async listDown(b: Row, max: number) {
    for (;;) {
      const row = this.store.mailbox(b.id);
      if (!row || row.complete || !row.list_next || this.stopped) return;
      const held = this.store.mailboxHeld(b.id).n;
      if (held >= max) return;
      const r = await this.call<{ messages: M.MailSummary[]; next: string | null }>('mail.list', { mailboxId: row.native_id, limit: Math.min(MAIL_LIMITS.page, max - held), before: row.list_next });
      this.stored(this.store.ingest(this.accountId, row, r.messages), false);
      const oldest = r.messages.length ? Math.min(...r.messages.map((m) => m.receivedAt)) : row.horizon;
      this.store.setListed(b.id, { next: r.next, horizon: oldest === null ? row.horizon : Math.min(oldest, row.horizon ?? oldest), complete: !r.next });
      if (!r.messages.length) return;
    }
  }

  // ---------------------------------------------------------- keeping up

  /** A changes pass on every followed mailbox. */
  async catchUp(): Promise<void> {
    if (!this.workable) return;
    if (!this.store.account(this.accountId)?.synced_at) return void this.firstSync();
    await Promise.all(this.store.followed(this.accountId).map((b) => this.changes(b.id)));
    this.backfill.start();
  }

  /** `mail.arrived`: stored now, without a call. */
  arrived(m: M.MailSummary) {
    if (this.stopped || !m?.id) return;
    const b = this.store.mailboxByNative(this.accountId, m.mailboxId);
    if (!b) {
      // A mailbox the hub has not heard of: the list again, then the message.
      void this.queue
        .run(P1, 'mailboxes', () => this.refreshMailboxes())
        .then(() => {
          const row = this.store.mailboxByNative(this.accountId, m.mailboxId);
          if (row) this.stored(this.store.ingest(this.accountId, row, [m]), true);
        })
        .catch((e) => this.ctx.log(`[${this.accountId}] mailboxes: ${asMailError(e).message}`));
      return;
    }
    this.stored(this.store.ingest(this.accountId, b, [m]), true);
  }

  /** `mail.changed`: a changes pass when it is a followed mailbox and the state is new to the hub. */
  changed(mailboxNative: string, state: string) {
    const b = this.store.mailboxByNative(this.accountId, mailboxNative);
    if (!b?.follow || b.state === state) return;
    void this.changes(b.id);
  }

  /**
   * Insurance: Inbox every 5 minutes and the rest every 15 without an event (30 for a big mailbox on a server that
   * syncs by comparing flags); a mailbox a page showed in the last 2 minutes every minute. A backfill that stopped
   * goes on.
   */
  private tick() {
    if (!this.workable) return;
    if (!this.store.account(this.accountId)?.synced_at) {
      if (!this.first) void this.firstSync();
      return;
    }
    const now = this.now;
    // dither-accounts' imap says 'UID + flags diff' when the server has neither QRESYNC nor CONDSTORE.
    const diff = /diff/i.test(this.store.account(this.accountId)?.sync_mode ?? '');
    for (const b of this.store.followed(this.accountId)) {
      const every =
        now - (b.opened_at ?? 0) < 2 * 60_000 ? 60_000 : b.role === 'inbox' ? MAIL_LIMITS.inboxEveryMs : diff && (b.total ?? 0) > 10_000 ? 2 * MAIL_LIMITS.otherEveryMs : MAIL_LIMITS.otherEveryMs;
      if (now - (b.state_at ?? 0) >= every) void this.changes(b.id);
    }
    this.backfill.start();
  }

  /**
   * What changed in a mailbox since its state, until no more is waiting; 410 relists it. `nested`: part of settling
   * removals, which must not start settling again.
   */
  changes(mailboxId: string, nested = false): Promise<void> {
    return this.queue
      .run(P1, `changes:${mailboxId}`, async () => {
        let b = this.store.mailbox(mailboxId);
        if (!b?.follow) return;
        if (!b.state) return this.takeState(b);
        for (let i = 0; i < 50; i++) {
          let r: M.MailChanges;
          try {
            r = await this.call<M.MailChanges>('mail.changes', { mailboxId: b.native_id, state: b.state });
          } catch (e) {
            if (asMailError(e).status === 410) return this.relist(b);
            throw e;
          }
          b = this.store.mailbox(mailboxId);
          if (!b) return;
          this.stored(this.store.ingest(this.accountId, b, r.added), true);
          this.store.changeFlags(b.id, r.changed);
          this.orphan(this.store.dropLocations(b.id, r.removed));
          this.store.setState(b.id, r.state);
          b = { ...b, state: r.state };
          if (!r.more) break;
        }
      })
      .then(
        () => (nested ? undefined : this.settle()),
        (e) => this.ctx.log(`[${this.accountId}] changes: ${asMailError(e).message}`),
      );
  }

  /**
   * The state is too old (410): a fresh state, then the list from the newest down to the oldest the hub held,
   * marking what it sees; locations it did not see go. Rows stay on screen meanwhile.
   */
  private async relist(b: Row) {
    this.setPhase('relist');
    try {
      const gen = this.store.bumpRelist(b.id);
      const fresh = await this.call<M.MailChanges>('mail.changes', { mailboxId: b.native_id });
      const held = this.store.mailboxHeld(b.id);
      let next: string | null = null;
      let listed = 0;
      let oldest = Infinity;
      let ended = false;
      const cap = Math.max(MAIL_LIMITS.firstSync, held.n * 2 + MAIL_LIMITS.page);
      for (;;) {
        const r: { messages: M.MailSummary[]; next: string | null } = await this.call('mail.list', { mailboxId: b.native_id, limit: MAIL_LIMITS.page, ...(next ? { before: next } : {}) });
        const row = this.store.mailbox(b.id);
        if (!row) return;
        this.stored(this.store.ingest(this.accountId, row, r.messages, gen), true);
        listed += r.messages.length;
        for (const m of r.messages) oldest = Math.min(oldest, m.receivedAt);
        next = r.next;
        if (!next || !r.messages.length) {
          ended = true;
          break;
        }
        if (held.oldest !== null && oldest < held.oldest) break;
        if (held.oldest === null && listed >= MAIL_LIMITS.firstSync) break;
        if (listed >= cap) break;
      }
      // Below where the listing stopped, nothing was looked at: those stay.
      this.orphan(this.store.dropUnseen(b.id, gen, ended ? null : oldest));
      this.store.setState(b.id, fresh.state);
      this.store.setListed(b.id, { next, horizon: Number.isFinite(oldest) ? oldest : null, complete: ended });
    } finally {
      this.setPhase(this.backfill.active ? 'backfill' : 'idle');
    }
  }

  // ---------------------------------------------------------- removals

  private orphan(ids: string[]) {
    for (const id of ids) this.orphans.add(id);
  }

  /**
   * Messages that lost their last location: the other followed mailboxes are asked what changed first (an IMAP move
   * is a removal here and an addition there), then those still nowhere are deleted.
   */
  private settle(): Promise<void> {
    if (!this.orphans.size) return Promise.resolve();
    if (this.settling) return this.settling;
    this.settling = (async () => {
      for (let round = 0; round < 3 && this.orphans.size; round++) {
        const ids = [...this.orphans];
        this.orphans.clear();
        if (this.workable) await Promise.all(this.store.followed(this.accountId).map((b) => this.changes(b.id, true)));
        const gone = this.store.deleteOrphans(ids);
        if (gone.length) this.ctx.deleted(this.accountId, gone);
      }
    })().finally(() => (this.settling = null));
    return this.settling;
  }

  // ---------------------------------------------------------- for the page

  /** A message's body from the server: for a page ahead of background work (P0), or fetched ahead (P2, bodies.ts). */
  fetchBody(messageId: string, p: Priority = P0): Promise<void> {
    return this.queue.run(p, `body:${messageId}`, async () => {
      const at = this.store.nativeOf(messageId);
      if (!at) throw asMailError(Object.assign(new Error('the server no longer has this message'), { status: 404 }));
      const m = await this.call<M.MailMessage>('mail.get', { id: at.id }, 65_000);
      storeBody(this.store, messageId, m);
    });
  }

  /** Pull to refresh: a changes pass on every followed mailbox now. */
  refresh(): Promise<void> {
    return this.catchUp();
  }
}
