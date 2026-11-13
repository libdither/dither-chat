/**
 * The calendar account (docs/calendar.md "The calendar account"). A calendar service beside the hub (dither-calendar)
 * is an account of kind `calendar` whose one setting is the service's address. While an enabled one exists, the
 * calendar is on: its pane, tab and Ctrl+K entries, the plans under messages (calendar.ts CalendarLink), and its own
 * chats, which come in through the account like any network's. Removing the account or turning it off turns all of it
 * off.
 *
 * Nothing here knows what a calendar does. The bridge relays the adapter protocol (adapter.ts) to
 * `<url>/api/chat-adapter` and back, and CalendarLink reads the same address, so another service that answers the same
 * contract replaces dither-calendar by changing the account. Reminders are the service's messages (`extra.reminder`),
 * which triage makes alerts.
 */
import type * as P from '@dither-chat/protocol';
import { CALENDAR_URL_DEFAULT, calendarAccountUrl } from '@dither-chat/protocol';
import { CalendarLink, calendarUrl } from './calendar.ts';
import type { AccountRow, Store } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

/** Where the service speaks the adapter protocol, under its address. */
export const CHAT_ADAPTER_PATH = '/api/chat-adapter';
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60_000;
/** Not answering for this long, the account says so (attention); shorter gaps (a restart) only show it offline. */
const DOWN_MS = 60_000;

const parse = (config: string) => {
  try {
    return JSON.parse(config || '{}');
  } catch {
    return {};
  }
};
/** A calendar account's service address, or null when its config has none that works. */
export const accountUrl = (acc: Pick<AccountRow, 'config'>) => calendarAccountUrl(parse(acc.config));

export interface BridgeOpts {
  url: string;
  /** A WebSocket constructor (tests). */
  WebSocket?: typeof WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * One calendar account's link to its service: a socket the hub dials, the adapter protocol over it both ways. Events
 * from the service go to the hub as an adapter's would; the hub's commands go to the service, and one the service
 * cannot be asked (not connected, or the socket went before it answered) is answered with an error at once.
 */
export class CalendarBridge implements InprocAdapter {
  private ws: WebSocket | null = null;
  private emit: ((ev: P.AdapterEvent) => void) | null = null;
  private running = false;
  private open = false;
  private backoff = BACKOFF_MIN;
  private retry?: ReturnType<typeof setTimeout>;
  private downSince: number | null = null;
  private flagged = false;
  /** Commands sent and not answered yet. */
  private inflight = new Set<string>();

  constructor(private opts: BridgeOpts) {}

  get connected() {
    return this.open;
  }

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    this.running = true;
    emit({ t: 'status', status: 'connecting' });
    this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    try {
      ws?.close(1000, 'stopped');
    } catch {}
    this.failInflight('the calendar account was stopped');
  }

  command(cmd: P.AdapterCommand) {
    if (cmd.t === 'shutdown') return;
    const id = cmd.id;
    if (!this.open || !this.ws) return this.fail(id, 'the calendar is not connected');
    this.inflight.add(id);
    try {
      this.ws.send(JSON.stringify(cmd));
    } catch (e) {
      this.inflight.delete(id);
      this.fail(id, `the calendar could not be asked: ${(e as Error)?.message ?? e}`);
    }
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private log(msg: string) {
    (this.opts.log ?? ((m: string) => console.warn(m)))(`calendar account: ${msg}`);
  }

  private fail(id: string, error: string) {
    queueMicrotask(() => this.emit?.({ t: 'reply', id, ok: false, error }));
  }

  private failInflight(error: string) {
    for (const id of this.inflight) this.fail(id, error);
    this.inflight.clear();
  }

  private connect() {
    if (!this.running) return;
    const url = this.opts.url.replace(/^http/, 'ws') + CHAT_ADAPTER_PATH;
    let ws: WebSocket;
    try {
      ws = new (this.opts.WebSocket ?? WebSocket)(url);
    } catch (e) {
      return this.down(String((e as Error)?.message ?? e));
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.backoff = BACKOFF_MIN;
      if (this.downSince !== null && this.flagged) this.log(`${this.opts.url} answers again`);
      this.downSince = null;
      this.flagged = false;
      // The service says hello and its status itself.
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let ev: P.AdapterEvent;
      try {
        ev = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object' || typeof (ev as { t?: unknown }).t !== 'string') return;
      if (ev.t === 'reply') this.inflight.delete(ev.id);
      this.emit?.(ev);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.open = false;
      this.failInflight('the calendar went away before it answered');
      this.down('the socket closed');
    };
    ws.onerror = () => {};
  }

  /** Not connected: offline at once, and after DOWN_MS an account that needs looking at. Tried again on a backoff. */
  private down(why: string) {
    if (!this.running) return;
    const now = this.now();
    if (this.downSince === null) {
      this.downSince = now;
      this.emit?.({ t: 'status', status: 'offline' });
    } else if (!this.flagged && now - this.downSince >= DOWN_MS) {
      this.flagged = true;
      this.log(`${this.opts.url} does not answer (${why})`);
      this.emit?.({ t: 'status', status: 'error', attention: { kind: 'unknown', message: `The calendar at ${this.opts.url} is not answering. Is it running?` } });
    }
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
  }
}

/** An account whose config has no usable address: it says so and does nothing else. */
class NoAddress implements InprocAdapter {
  start(emit: (ev: P.AdapterEvent) => void) {
    emit({ t: 'status', status: 'error', attention: { kind: 'unknown', message: 'This calendar account has no address. Remove it and add it again with one.' } });
    this.emit = emit;
  }
  private emit: ((ev: P.AdapterEvent) => void) | null = null;
  command(cmd: P.AdapterCommand) {
    if (cmd.t !== 'shutdown') this.emit?.({ t: 'reply', id: cmd.id, ok: false, error: 'this calendar account has no address' });
  }
  stop() {}
}

export interface CalendarAccountsOpts {
  /** To open pages (server.broadcast). */
  broadcast: (evs: P.ClientEvent[]) => void;
  /** A demo hub never has a calendar. */
  demo: boolean;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** CalendarLink's wait after a change (tests: 0). */
  debounceMs?: number;
}

/**
 * Which calendar account is on, and the CalendarLink to its address: everything calendar in the hub follows it. The
 * first enabled calendar account with an address is the one (the API lets you add only one). `sync()` after any
 * change to the accounts; `factory` is the supervisor's in-process adapter for kind `calendar`.
 */
export class CalendarAccounts {
  private cur: { accountId: string; url: string; link: CalendarLink } | null = null;
  private started = false;

  constructor(
    private store: Store,
    private opts: CalendarAccountsOpts,
  ) {}

  /** The link to the calendar that is on, or undefined: the proxy, the plans, the bootstrap's `calendar`. */
  link(): CalendarLink | undefined {
    return this.cur?.link;
  }

  /** The address of the calendar that is on. */
  url(): string | null {
    return this.cur?.url ?? null;
  }

  /** The calendar account that should be on, now. */
  private wanted(): { acc: AccountRow; url: string } | null {
    if (this.opts.demo) return null;
    for (const acc of this.store.accounts()) {
      if (acc.network !== 'calendar' || !acc.enabled) continue;
      const url = accountUrl(acc);
      if (url) return { acc, url };
    }
    return null;
  }

  /** Follow the accounts: the calendar on (or moved) for an enabled calendar account, off without one. */
  sync() {
    const want = this.wanted();
    if (this.cur && want && this.cur.accountId === want.acc.id && this.cur.url === want.url) return;
    const was = this.cur;
    if (was) {
      was.link.stop();
      this.cur = null;
    }
    if (want) {
      const link = new CalendarLink({ url: want.url, broadcast: (evs) => this.opts.broadcast(evs), fetch: this.opts.fetch, debounceMs: this.opts.debounceMs });
      this.cur = { accountId: want.acc.id, url: want.url, link };
      if (this.started) {
        link.start();
        // Pages turn the calendar on (and ask for its plans); the link says when it answers.
        this.opts.broadcast([{ t: 'calendar', reachable: false, waiting: 0 }]);
      }
    } else if (was && this.started) this.opts.broadcast([{ t: 'calendar', reachable: false, waiting: 0, off: true }]);
  }

  /** Once the server answers: the link reads the calendar from now on. */
  start() {
    this.started = true;
    this.cur?.link.start();
  }

  stop() {
    this.started = false;
    this.cur?.link.stop();
  }

  /** The supervisor's in-process adapter for a calendar account (never on a demo hub). */
  factory = (acc: AccountRow): InprocAdapter | null => {
    if (acc.network !== 'calendar' || this.opts.demo) return null;
    const url = accountUrl(acc);
    return url ? new CalendarBridge({ url, WebSocket: this.opts.WebSocket }) : new NoAddress();
  };
}

/** Meta key: a calendar account was added on this hub once (by hand or by the first start's seed). */
export const CALENDAR_ADDED = 'calendar_account_added';

export function markCalendarAdded(store: Store) {
  store.db.query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`).run(CALENDAR_ADDED, String(Date.now()));
}

/**
 * The first start with calendar accounts: a hub that had a calendar beside it by DITHER_CALENDAR_URL (or its default)
 * gets an account for it, once. Never on a demo hub, never with DITHER_CALENDAR_URL=off, and never again once a
 * calendar account was added here, so removing it sticks.
 */
export function seedCalendarAccount(store: Store, env: Record<string, string | undefined>, demo: boolean, color = '#7E57C2'): AccountRow | null {
  if (demo) return null;
  if (store.db.query(`SELECT 1 FROM meta WHERE key = ?`).get(CALENDAR_ADDED)) return null;
  if (store.accounts().some((a) => a.network === 'calendar')) {
    markCalendarAdded(store);
    return null;
  }
  const url = calendarUrl(env, demo);
  if (!url) return null;
  const acc = store.createAccount({ network: 'calendar', label: 'Calendar', color, adapter: 'calendar', config: { url: calendarAccountUrl({ url }) ?? CALENDAR_URL_DEFAULT } });
  markCalendarAdded(store);
  return acc;
}
