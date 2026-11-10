/**
 * MailHub: mail in the hub (docs/mail.md). It follows the backend's account list, runs one AccountSync per account,
 * answers the page's routes (routes.ts) and hands the server its events to broadcast (flush).
 *
 * Later slices plug in without editing this file's insides: they listen to its events (`hub.on('ingested', …)`) from
 * their router in routes.ts's table, which MailHub calls once when it is made. The events:
 *
 *   ingested  new messages stored (not ones that only moved): classify, people, triage
 *   deleted   messages the server no longer has
 *   opened    you opened a thread ("you were here")
 *   read      threads the page read (a second in view): kept here; slice 4 tells the server
 *   body      a body arrived from the server: previews, search text
 *   account   an account was added, changed, lost its access, or was deleted
 *   sent      the outbox sent a message (slice 5): `replyTo` is the hub message it answered
 *
 * Access to an account ends when it leaves the manager's list or its grant goes: its mail stays readable for
 * MAIL_LIMITS.goneMs (24 h), then goes; "Delete now" goes at once (§14 Q6).
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { type Clock, realClock } from '../clock.ts';
import { asMailError, MailCallError, type MailBackend, type MailBackendAccount, type MailBackendEvent } from './backend.ts';
import { MAIL_LIMITS } from './limits.ts';
import { MailOutbox } from './outbox.ts';
import { mountRouters, type MailRoute } from './routes.ts';
import { MailStore } from './store.ts';
import { AccountSync } from './sync.ts';

export interface MailHubEvents {
  ingested: { accountId: string; messageIds: string[]; live: boolean };
  deleted: { accountId: string; messageIds: string[] };
  opened: { threadId: string };
  read: { threadIds: string[] };
  body: { messageId: string };
  account: { accountId: string; state: 'added' | 'changed' | 'ended' | 'deleted' };
  sent: { accountId: string; outboxId: string; messageId: string | null; replyTo: string | null; threadId: string | null; dryRun: boolean };
}
export type MailHubEvent = keyof MailHubEvents;

export interface MailHubOpts {
  db: Database;
  /** Null: mail is off (no DITHER_ACCOUNTS_URL, not a demo). */
  backend: MailBackend | null;
  /** The manager's page as the browser reaches it, for links to it. */
  managerUrl?: string | null;
  log?: (msg: string) => void;
  /** The time the store records (default: the clock's). */
  now?: () => number;
  /** Timers and pacing: the queues' budgets and backoffs, retries, pauses (tests pass a fake one). */
  clock?: Clock;
  /** The hub's data dir: the outbox keeps files there until they are sent (slice 5). */
  dataDir?: string;
  /** How long a send waits for Undo (MAIL_LIMITS.holdMs). */
  holdMs?: number;
  /** Files and images (slice 3, parts.ts): where they are kept, and the key image tokens are signed with. */
  media?: MailMediaOpts;
}

export interface MailMediaOpts {
  /** The hub's media cache (DATA/media-cache). */
  dir: string;
  /** The hub's media key (hub-secret). */
  key: string;
  /** What fetches remote images (tests and the demo), and how names resolve. */
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
}

export class MailHub {
  readonly store: MailStore;
  readonly backend: MailBackend | null;
  readonly routes: MailRoute[];
  /** Sending and drafts (slice 5, outbox.ts). */
  readonly outbox: MailOutbox;
  readonly media: MailMediaOpts | null;
  private syncs = new Map<string, AccountSync>();
  /** Each account's latest status event, kept for when it comes before the account list does. */
  private statuses = new Map<string, MailBackendEvent>();
  private listeners = new Map<MailHubEvent, Set<(e: any) => void>>();
  private sweepTimer: Timer | null = null;
  /** What later slices stop with the hub: their timers and background steps (routes.ts routers push here). */
  readonly stopping: (() => void)[] = [];
  private started = false;
  private log: (msg: string) => void;
  private now: () => number;
  /** What the slices pace their work and set their timers by. */
  readonly clock: Clock;

  constructor(private opts: MailHubOpts) {
    this.clock = opts.clock ?? realClock;
    this.now = opts.now ?? (() => this.clock.now());
    this.log = opts.log ?? ((m) => console.warn(`mail: ${m}`));
    this.store = new MailStore(opts.db, this.now);
    this.backend = opts.backend;
    const base = opts.managerUrl?.replace(/\/$/, '') ?? null;
    this.store.managedUrl = (id) => (base ? `${base}/#/accounts/${encodeURIComponent(id)}` : null);
    this.store.syncOf = (id) => this.syncs.get(id)?.phase ?? 'idle';
    this.outbox = new MailOutbox(this, { dir: opts.dataDir ? `${opts.dataDir}/mail-outbox` : null, holdMs: opts.holdMs, now: this.now, log: this.log });
    this.media = opts.media ?? null;
    this.routes = mountRouters(this);
  }

  // ---------------------------------------------------------- events

  on<K extends MailHubEvent>(event: K, fn: (e: MailHubEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  emit<K extends MailHubEvent>(event: K, e: MailHubEvents[K]) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(e);
      } catch (err) {
        this.log(`a ${event} listener failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  // ---------------------------------------------------------- life

  start() {
    if (this.started) return;
    this.started = true;
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), 15 * 60_000);
    const b = this.backend;
    if (!b) return;
    b.onAccess(() => (this.store.dirty.access = true));
    b.onConnection((up) => {
      this.store.dirty.access = true;
      if (up) for (const s of this.syncs.values()) void s.catchUp();
    });
    b.onAccounts((list) => this.accountsChanged(list));
    b.onEvents((account, events) => this.events(account, events));
    b.onGap((account) => void this.syncs.get(account)?.catchUp());
    this.outbox.start();
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const f of this.stopping) f();
    this.outbox.stop();
    for (const s of this.syncs.values()) s.stop();
    this.syncs.clear();
  }

  access(): P.MailAccess {
    const b = this.backend;
    const state = !b ? 'off' : !b.connected && b.access() === 'granted' ? 'unreachable' : b.access();
    return { state, managerUrl: this.opts.managerUrl ?? null };
  }

  sync(accountId: string): AccountSync | undefined {
    return this.syncs.get(accountId);
  }

  /** The manager's list of mail accounts this hub may read. One that is not in it any more has lost its access. */
  private accountsChanged(list: MailBackendAccount[]) {
    const now = new Set(list.map((a) => a.id));
    for (const a of list) {
      const change = this.store.upsertAccount(a);
      const st = this.statuses.get(a.id);
      if (change === 'added' && st) this.store.setStatus(a.id, st);
      if (change) this.emit('account', { accountId: a.id, state: change });
      let s = this.syncs.get(a.id);
      if (!s) {
        s = new AccountSync(a.id, {
          store: this.store,
          backend: this.backend!,
          ingested: (accountId, messageIds, live) => this.emit('ingested', { accountId, messageIds, live }),
          deleted: (accountId, messageIds) => this.emit('deleted', { accountId, messageIds }),
          log: this.log,
          now: this.now,
          clock: this.clock,
        });
        this.syncs.set(a.id, s);
        s.start();
      } else if (change && a.online) s.start();
    }
    for (const r of this.store.accounts()) {
      if (now.has(r.id) || r.gone_at) continue;
      this.syncs.get(r.id)?.stop();
      this.syncs.delete(r.id);
      if (this.store.accessEnded(r.id, this.now())) {
        this.log(`[${r.id}] access ended: its mail here goes in ${Math.round(MAIL_LIMITS.goneMs / 3_600_000)} h`);
        this.emit('account', { accountId: r.id, state: 'ended' });
      }
    }
  }

  private events(account: string, events: MailBackendEvent[]) {
    for (const ev of events) if (ev.t === 'status') this.statuses.set(account, ev);
    const s = this.syncs.get(account);
    if (!s) return;
    for (const ev of events) {
      switch (ev.t) {
        case 'status': {
          const was = !!this.store.account(account)?.online;
          this.store.setStatus(account, ev);
          // Back online: whatever happened meanwhile.
          if (!was && this.store.account(account)?.online) s.start();
          break;
        }
        case 'mail.arrived':
          s.arrived(ev.message as M.MailSummary);
          break;
        case 'mail.changed':
          s.changed(String(ev.mailboxId), String(ev.state));
          break;
      }
    }
  }

  /** Accounts whose access ended a day ago go, with everything of them. */
  private sweep() {
    for (const id of this.store.goneBefore(this.now() - MAIL_LIMITS.goneMs)) this.deleteAccount(id);
  }

  private deleteAccount(id: string) {
    this.syncs.get(id)?.stop();
    this.syncs.delete(id);
    this.store.deleteAccount(id);
    this.log(`[${id}] its mail was deleted from this hub`);
    this.emit('account', { accountId: id, state: 'deleted' });
  }

  // ---------------------------------------------------------- for the server

  /** What changed since the last flush, as the page's events (server.ts flush). */
  flush(): P.ClientEvent[] {
    return [...this.store.flush(() => this.access()), ...this.outbox.flush()];
  }

  bootstrap(): P.MailBootstrap {
    return { ...this.store.bootstrap(this.access()), outbox: this.outbox.views() };
  }

  // ---------------------------------------------------------- for the routes

  threadDetail(id: string): P.MailThreadDetail | null {
    const t = this.store.thread(id);
    if (!t) return null;
    this.store.opened(id, this.now());
    this.emit('opened', { threadId: id });
    return { thread: this.store.threadView(t), messages: this.store.messageViews(id) };
  }

  /** A message's body, from the server when it is not here yet. Throws MailCallError with a status. */
  async body(messageId: string): Promise<P.MailBodyView> {
    const have = this.store.bodyView(messageId);
    if (have) {
      this.store.touchBody(messageId);
      return have;
    }
    const m = this.store.one<{ account_id: string }>('SELECT account_id FROM mail_message WHERE id = ?', messageId);
    if (!m) throw new MailCallError('no such message', 404);
    const acc = this.store.account(m.account_id);
    const s = this.syncs.get(m.account_id);
    if (!acc || acc.gone_at) throw new MailCallError('this account is no longer shared with the hub, and this message was not kept here', 410);
    if (!this.backend?.connected || !s) throw new MailCallError('dither-accounts is not reachable', 503);
    if (!acc.online) throw new MailCallError(JSON.parse(acc.problem ?? 'null')?.message ?? 'the account is offline', 503);
    try {
      await s.fetchBody(messageId);
    } catch (e) {
      throw asMailError(e);
    }
    this.emit('body', { messageId });
    const v = this.store.bodyView(messageId);
    if (!v) throw new MailCallError('the body did not come', 502);
    return v;
  }

  /**
   * The page says these threads were read (a second in view). Kept here (seen_local); `read` goes out for each that
   * exists, changed here or not, for slice 4 to tell the server. Returns the threads whose count changed.
   */
  readHere(threadIds: string[]): string[] {
    const changed = this.store.markReadHere(threadIds);
    const known = threadIds.filter((id) => this.store.thread(id));
    if (known.length) this.emit('read', { threadIds: known });
    return changed;
  }

  /** "Delete now" for an account whose access ended. */
  deleteNow(id: string): 'deleted' | 'active' | 'unknown' {
    const a = this.store.account(id);
    if (!a) return 'unknown';
    if (!a.gone_at) return 'active';
    this.deleteAccount(id);
    return 'deleted';
  }

  /** Pull to refresh. */
  async refresh(accountId: string | null) {
    const ids = accountId ? [accountId] : [...this.syncs.keys()];
    await Promise.all(ids.map((id) => this.syncs.get(id)?.refresh()));
  }

  async askAgain() {
    if (!this.backend?.askAgain) throw new MailCallError('mail is off on this hub', 404);
    await this.backend.askAgain();
    this.store.dirty.access = true;
  }

  /** Answer a /api/mail request, or null when no route matches. */
  async route(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.path);
      if (!m) continue;
      try {
        // A group that matched nothing is '' (decodeURIComponent would make it "undefined").
        return await r.handle({ req, url, params: m.slice(1).map((x) => (x === undefined ? '' : decodeURIComponent(x))), body: () => req.json().catch(() => ({})) });
      } catch (e) {
        const err = asMailError(e);
        return Response.json({ error: err.message }, { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 500 });
      }
    }
    return null;
  }
}

export { MailCallError } from './backend.ts';
export { FakeMailBackend } from './fake.ts';
export { ManagerMailBackend } from './backend.ts';
