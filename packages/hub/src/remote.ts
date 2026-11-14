/**
 * Remote accounts: dither-accounts' manager runs some accounts' adapters, and this hub is one of its apps
 * (docs/accounts.md). With DITHER_ACCOUNTS_URL set, every account the manager lists for this hub is remote: its
 * adapter's events reach the hub through the manager and go the same way a local adapter's do (ingest, triage, calls),
 * and the hub's commands go out as the manager's calls. Every other account stays on the local supervisor, exactly as
 * without the manager, so accounts move one at a time. Without DITHER_ACCOUNTS_URL nothing here runs: that is the
 * rollback.
 *
 * The manager keeps nothing: while the hub restarts, the remote adapters keep running and their events wait in the
 * manager's memory. If too many wait, the manager drops them and says so (a gap); the hub then restarts that account's
 * adapter, whose fresh snapshot fills the hole.
 *
 * Everything the hub does to a remote account goes through the manager: its log, its live view (the manager's socket
 * on this hub's token), renames, enabling, removing (with its directory if asked). The hub follows what the manager
 * says back: a rename or a disable on its page, and why it cannot run an account. An account that leaves the list goes
 * back to the local supervisor only if its session is here (one imported in place); one the manager made has nothing
 * here to run.
 *
 * The manager's client is loaded from a dither-accounts checkout beside this repo (DITHER_ACCOUNTS_CLIENT overrides
 * the path), only when this mode is on: dither-chat itself does not depend on dither-accounts.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { kindAsk, NETWORKS } from '@dither-chat/protocol';
import { ACCOUNT_COLORS, type AccountRow, type Store } from './store.ts';
import { timedWork } from './stalls.ts';
import { span } from './trace.ts';
import { Supervisor } from './supervisor.ts';
import type { MailSink } from './mail/backend.ts';
import { ASK_LEVEL, ASK_REASON, type ManagerLink, publishManager } from './accounts-manager.ts';
import type { NoticeSink } from './notices/index.ts';
import { jobFailed } from './errors.ts';
import { Stagger } from './stagger.ts';

/** A batch's event kinds with how many of each, for its span: `message×3,typing`. */
function kindsOf(events: { t: string }[]): string {
  const n = new Map<string, number>();
  for (const e of events) n.set(e.t, (n.get(e.t) ?? 0) + 1);
  return [...n].map(([k, c]) => (c > 1 ? `${k}×${c}` : k)).join(',');
}

/** The kinds this hub hands to the manager when they are new. */
export const MANAGED_KINDS = ['discord', 'signal', 'matrix', 'whatsapp', 'telegram', 'gmessages', 'messenger', 'instagram', 'x', 't3'];

/**
 * The kinds this hub asks to add and run: its chat kinds, and Proton Mail, which Add account adds through the manager
 * (docs/accounts.md, "Adding mail"). Others (imap, google, github) are asked for one at a time from Add account.
 */
export const ASKED_KINDS = [...MANAGED_KINDS, 'proton'];

/** The attention an account gets while the manager cannot run it, and when the manager no longer has it. */
const NOT_RUNNING = 'Not running in dither-accounts: ';
const GONE = 'Removed from dither-accounts, and its session is not on this hub. Remove it here too, or add it again.';

/** What this file uses of dither-accounts' AccountsClient and its spec (packages/client, packages/spec). */
export interface AccountView {
  id: string;
  kind: string;
  label: string;
  interfaces: string[];
  running: boolean;
  online: boolean;
  enabled: boolean;
  grants: Record<string, 'read' | 'write' | 'manage'>;
  dryRun: boolean;
  /** Why the manager is not running it. (Optional: managers before these fields did not say.) */
  error?: string | null;
  /** This hub may run it (start, stop, its log, its live view). */
  manages?: boolean;
  liveView?: boolean;
  /** Who made it: this hub, another app, the manager's page, or an import from this hub's data. */
  origin?: 'self' | 'app' | 'page' | 'import';
}
interface Client {
  accounts: AccountView[];
  connected: boolean;
  /** `trace` (a W3C traceparent) is carried to the manager, which makes its spans children of the hub's; a client
   * before it leaves it out. */
  callRaw(account: string, op: string, input?: Record<string, unknown>, timeoutMs?: number, o?: { trace?: string }): Promise<unknown>;
  admin(action: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  liveViewUrl(account: string): string;
  close(): void;
}
interface ClientModule {
  AccountsClient: new (opts: {
    url: string;
    app: string;
    token: string;
    onAccounts?: (a: AccountView[]) => void;
    onEvents?: (account: string, events: { t: string; [k: string]: unknown }[]) => void;
    onGap?: (account: string, dropped: number) => void;
    onConnection?: (connected: boolean) => void;
  }) => Client;
  register(url: string, req: unknown): Promise<{ app: string; token: string }>;
  self(url: string, app: string, token: string): Promise<unknown>;
  /** Missing from managers before it: then the hub does not ask for kinds added since it registered. */
  requestAccess?(url: string, app: string, token: string, requests: unknown[]): Promise<unknown>;
}

/** What the manager says of this app (AppInfo), as much as kindsToAsk, mailAccessOf and asksOf read. */
interface AppSelf {
  grants?: { interface: string; kinds: string[] | null }[];
  requests?: { interface: string; kinds?: string[] | null; accounts?: '*' | string[]; state?: string }[];
}

/** This hub's requests that wait on the manager's page or were declined there (the page's dim icons and Add account). */
export function asksOf(info: AppSelf | null | undefined): P.AccessAsk[] {
  return (info?.requests ?? [])
    .filter((r) => r.state === 'pending' || r.state === 'denied')
    .map((r) => ({ interface: r.interface, accounts: Array.isArray(r.accounts) ? r.accounts : '*', kinds: r.kinds ?? null, state: r.state as 'pending' | 'denied' }));
}

/** The manager's account, as the page reads it (accounts.ts ManagedAccountView). */
export function managedViewOf(a: AccountView): P.ManagedAccountView {
  return {
    id: a.id,
    kind: a.kind,
    label: a.label,
    interfaces: a.interfaces,
    grants: a.grants,
    manages: !!a.manages,
    liveView: !!a.liveView,
    online: a.online,
    running: a.running,
    enabled: a.enabled,
    error: a.error ?? null,
    origin: a.origin ?? null,
  };
}

/** The hub's request for mail (docs/mail.md): read and write, every account, added on the manager's page (§14 Q5). */
export const MAIL_REQUEST = { interface: 'mail', level: 'write', accounts: '*', reason: 'Show your email beside your chats; mark, file and send mail as you ask' } as const;

/** Whether the hub may read mail: a grant, a request waiting for you, or your no. */
export function mailAccessOf(info: AppSelf | null | undefined): 'granted' | 'pending' | 'denied' | null {
  if (info?.grants?.some((g) => g.interface === 'mail')) return 'granted';
  const asked = (info?.requests ?? []).filter((r) => r.interface === 'mail');
  if (asked.some((r) => r.state === 'pending')) return 'pending';
  if (asked.some((r) => r.state === 'denied')) return 'denied';
  return null;
}

/** Ask for mail once: not when it has a grant, or a request is waiting or was declined. */
export const mailToAsk = (info: AppSelf | null | undefined): boolean => mailAccessOf(info) === null;

/**
 * The hub's request for notices (docs/notices.md): what your accounts and services tell you, on every account that
 * has the `notifications` interface (GitHub, dither-accounts' own), at write so reading one here reads it there.
 */
export const NOTICES_REQUEST = { interface: 'notifications', level: 'write', accounts: '*', reason: 'Notify you of what your accounts and services tell you, ranked with your chats; mark them read as you read them' } as const;

/** Whether the hub may read notices, as mailAccessOf. */
export function noticesAccessOf(info: AppSelf | null | undefined): 'granted' | 'pending' | 'denied' | null {
  if (info?.grants?.some((g) => g.interface === 'notifications')) return 'granted';
  const asked = (info?.requests ?? []).filter((r) => r.interface === 'notifications');
  if (asked.some((r) => r.state === 'pending')) return 'pending';
  if (asked.some((r) => r.state === 'denied')) return 'denied';
  return null;
}

/** Ask for notices once, as mail. */
export const noticesToAsk = (info: AppSelf | null | undefined): boolean => noticesAccessOf(info) === null;

/**
 * The chat kinds this hub runs that it has neither a grant for nor asked about: an open request waits for you, and a
 * denied one is your answer, so neither is asked again.
 */
export function kindsToAsk(info: AppSelf | null | undefined, kinds: readonly string[] = ASKED_KINDS): string[] {
  const covered = new Set<string>();
  const add = (k: string[] | null | undefined) => (k == null ? kinds.forEach((x) => covered.add(x)) : k.forEach((x) => covered.add(x)));
  for (const g of info?.grants ?? []) if (g.interface === 'accounts') add(g.kinds);
  for (const r of info?.requests ?? []) if (r.interface === 'accounts') add(r.kinds);
  return kinds.filter((k) => !covered.has(k));
}

export interface RemoteOpts {
  /** The manager: http://127.0.0.1:8486 */
  url: string;
  /** Where accounts-app.json is kept (the hub's data dir). */
  dataDir: string;
  repoRoot: string;
  /** How long startAll waits for the manager's first account list before starting what is plainly local. */
  firstListMs?: number;
  /** The manager's page as the user's browser reaches it (DITHER_ACCOUNTS_PUBLIC_URL), for links to an account there. */
  publicUrl?: string | null;
}

/** POST /api/accounts answers this status when the error from created() carries it. */
export const UNREACHABLE = 'dither-accounts is not reachable, so the account was not added. Try again once it is running.';

type SupOpts = ConstructorParameters<typeof Supervisor>[1];

interface Saved {
  app: string;
  token: string;
  url: string;
  /** The accounts the manager ran last time, so a hub that starts while the manager is down does not run them too. */
  remote?: string[];
}

export class RoutedSupervisor extends Supervisor implements ManagerLink {
  private client: Client | null = null;
  /**
   * Restarts after a gap, one at a time per kind (stagger.ts): a manager that went without handing over gaps every
   * account. One removed meanwhile is dropped without a word.
   */
  private gapRestarts = new Stagger((account) => {
    if (!this.remote.has(account) || !this.client) return Promise.resolve();
    return this.client.admin({ do: 'restart', account }).catch((e) => {
      if (!this.remote.has(account)) return;
      console.error(`[${account}] restart after a gap failed:`, e);
      jobFailed('dither-accounts: restart after a gap', e, { account });
    });
  });

  /** Restarts after a gap waiting or under way (the hub's /api/health; the deployer waits for them). */
  gapRestartsWaiting(): number {
    return this.gapRestarts.size;
  }
  /** The chat accounts the manager lists for this hub (the ones it runs for the chat side). */
  private remote = new Map<string, AccountView>();
  /** Every account the manager lists for this hub, chat or not: the page's one list (accounts-manager.ts). */
  private all = new Map<string, AccountView>();
  /** This hub's requests waiting on the manager's page, or declined there. */
  private asks: P.AccessAsk[] = [];
  private kindsCache: { at: number; kinds: P.ManagedKindView[] } | null = null;
  private firstList: Promise<void>;
  private gotFirstList!: () => void;
  private saved: Saved | null = null;
  private storeRef: ConstructorParameters<typeof Supervisor>[0];
  /** Accounts the manager ran (last time, or until they left its list): never started here without a session here. */
  private wasRemote = new Set<string>();
  /** Mail (mail/backend.ts ManagerMailBackend): its accounts' list and events go there, not to the chat side. */
  mail?: MailSink;
  /** Notices (notices/index.ts): the notifications interface's accounts and events; a chat account's still go to chat too. */
  notices?: NoticeSink;
  private mod: ClientModule | null = null;
  private mailTimer: Timer | null = null;

  constructor(
    store: ConstructorParameters<typeof Supervisor>[0],
    opts: SupOpts,
    private remoteOpts: RemoteOpts,
  ) {
    super(store, opts);
    this.storeRef = store;
    this.firstList = new Promise((r) => (this.gotFirstList = r));
    const p = this.savedPath();
    if (existsSync(p)) {
      try {
        this.saved = JSON.parse(readFileSync(p, 'utf8'));
        for (const id of this.saved?.remote ?? []) {
          this.remote.set(id, { id, kind: '', label: '', interfaces: ['chat'], running: false, online: false, enabled: true, grants: {}, dryRun: false });
          this.wasRemote.add(id);
        }
      } catch {}
    }
  }

  private savedPath() {
    return join(this.remoteOpts.dataDir, 'accounts-app.json');
  }
  private save() {
    if (!this.saved) return;
    const p = this.savedPath();
    writeFileSync(p, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  isRemote(id: string): boolean {
    return this.remote.has(id);
  }

  /** The account's session is in this hub's data (it was imported in place, or never left): the local supervisor can run it. */
  private sessionHere(id: string): boolean {
    const dir = join(this.remoteOpts.dataDir, 'accounts', id);
    try {
      return readdirSync(dir).some((n) => n !== 'adapter.log' && n !== 'extractor.lock');
    } catch {
      return false;
    }
  }
  /** Whether the local supervisor may start it: not if the manager ran it and its session is not here. */
  private mayRunHere(id: string): boolean {
    return !this.wasRemote.has(id) || this.sessionHere(id);
  }

  /** Connect now if the manager answers; else keep trying in the background (local accounts run meanwhile). */
  async connectOrRetry(): Promise<void> {
    try {
      await this.connect();
    } catch (e) {
      console.error(`dither-accounts at ${this.remoteOpts.url} is not reachable (${(e as Error)?.message ?? e}); trying again in 30 s`);
      jobFailed('dither-accounts: connect', e);
      setTimeout(() => void this.connectOrRetry(), 30_000);
    }
  }

  /** Register once (or again, if the manager forgot this hub), then connect. */
  async connect(): Promise<void> {
    const mod = (await import(process.env.DITHER_ACCOUNTS_CLIENT ?? resolve(this.remoteOpts.repoRoot, '../dither-accounts/packages/client/src/index.ts'))) as ClientModule;
    this.mod = mod;
    const url = this.remoteOpts.url;
    let info: AppSelf | null = null;
    let known =
      this.saved && this.saved.url === url
        ? await mod.self(url, this.saved.app, this.saved.token).then(
            (x) => ((info = x as AppSelf), true),
            (e) => !/\b401\b/.test(String(e)),
          )
        : false;
    // Registered before some kinds existed (telegram, gmessages): ask for those now, for you to approve on its page.
    const missing = known && info ? kindsToAsk(info) : [];
    if (missing.length && mod.requestAccess)
      await mod
        .requestAccess(url, this.saved!.app, this.saved!.token, [{ interface: 'accounts', level: 'manage', kinds: missing, reason: `Add, sign in and remove ${missing.join(' and ')} accounts too` }])
        .then(
          () => console.log(`dither-accounts: asked to manage ${missing.join(', ')} accounts as well; approve it on the manager's page`),
          (e) => (console.error('dither-accounts: asking for the new kinds failed:', e), jobFailed('dither-accounts: ask for kinds', e)),
        );
    // Registered before mail (docs/mail.md): ask for it once, for you to approve on its page.
    if (known && info && this.mail && mailToAsk(info) && mod.requestAccess)
      await mod.requestAccess(url, this.saved!.app, this.saved!.token, [MAIL_REQUEST]).then(
        () => ((info = { ...info, requests: [...(info?.requests ?? []), { interface: 'mail', state: 'pending' }] }), console.log("dither-accounts: asked to read and send your mail; approve it on the manager's page")),
        (e) => (console.error('dither-accounts: asking for mail failed:', e), jobFailed('dither-accounts: ask for mail', e)),
      );
    // Registered before notices (docs/notices.md): ask for them once too.
    if (known && info && this.notices && noticesToAsk(info) && mod.requestAccess)
      await mod.requestAccess(url, this.saved!.app, this.saved!.token, [NOTICES_REQUEST]).then(
        () => ((info = { ...info, requests: [...(info?.requests ?? []), { interface: 'notifications', state: 'pending' }] }), console.log("dither-accounts: asked to read your accounts' notifications; approve it on the manager's page")),
        (e) => (console.error('dither-accounts: asking for notices failed:', e), jobFailed('dither-accounts: ask for notices', e)),
      );
    if (!known) {
      const reg = await mod.register(url, {
        name: 'dither-chat',
        describe: 'The chat hub: reads and answers your chats on every network, and manages the chat accounts it adds.',
        requests: [
          { interface: 'chat', level: 'manage', accounts: '*', reason: 'Show your chats, send what you write, and manage chats and servers as you ask' },
          { interface: 'accounts', level: 'manage', kinds: ASKED_KINDS, reason: 'Add, sign in and remove the chat and mail accounts you set up in the hub' },
          ...(this.mail ? [MAIL_REQUEST] : []),
          ...(this.notices ? [NOTICES_REQUEST] : []),
        ],
      });
      info = { requests: [...(this.mail ? [{ interface: 'mail', state: 'pending' }] : []), ...(this.notices ? [{ interface: 'notifications', state: 'pending' }] : [])] };
      this.saved = { app: reg.app, token: reg.token, url, remote: [] };
      this.save();
      console.log(`dither-accounts: registered as ${reg.app}; approve its requests on the manager's page`);
    }
    this.mailAccess(mailAccessOf(info) ?? 'pending');
    this.noticesAccess(noticesAccessOf(info) ?? 'pending');
    this.asks = asksOf(info);
    this.publish();
    this.client = new mod.AccountsClient({
      url,
      app: this.saved!.app,
      token: this.saved!.token,
      onAccounts: (list) => {
        this.accountsChanged(list);
        this.mail?.accounts(list);
        this.notices?.accounts(list);
        // A new list may answer a request (a grant approved): read the requests again.
        void this.readMailAccess();
      },
      onEvents: (account, events) =>
        span(
          'adapter events',
          { account, events: events.length, kinds: kindsOf(events) },
          () => {
            try {
              if (this.mail) timedWork('mail: events', () => this.mail!.events(account, events));
            } catch (e) {
              // Mail catches up by itself (mail.changes); the chat events below must not wait on it.
              console.error(`[${account}] mail events failed:`, e);
              jobFailed('mail: events', e, { account });
            }
            try {
              if (this.notices) timedWork('notices: events', () => this.notices!.events(account, events));
            } catch (e) {
              // Notices catch up by themselves (notify.list); the chat events below must not wait on them.
              console.error(`[${account}] notices events failed:`, e);
              jobFailed('notices: events', e, { account });
            }
            if (!this.remote.has(account)) return;
            void this.apply(account, events as P.AdapterEvent[]);
          },
          { note: `adapter events (${events.length})` },
        ),
      onGap: (account, dropped) => {
        // A mail account catches up with mail.changes, and notices with notify.list; nothing restarts, unless it is
        // a chat account too.
        const notices = this.notices?.gap(account) ?? false;
        if (this.mail?.gap(account)) return;
        if (notices && !this.remote.has(account)) return;
        console.warn(`[${account}] the manager dropped ${dropped} events while the hub was away; restarting the adapter for a fresh snapshot (one of a kind at a time: ${this.gapRestarts.size} waiting)`);
        this.gapRestarts.add(account, this.remote.get(account)?.kind ?? '');
      },
      onConnection: (up) => {
        this.mail?.connection(up);
        this.notices?.connection(up);
        this.kindsCache = null;
        this.publish();
        if (up) return;
        for (const id of this.remote.keys()) this.markOffline(id);
      },
    });
  }

  // ---------------------------------------------------------- mail's grant

  private mailState: 'granted' | 'pending' | 'denied' | 'unreachable' = 'unreachable';
  private get mailWaiting() {
    return this.mailState === 'pending' || this.mailState === 'denied';
  }
  private mailAccess(state: RoutedSupervisor['mailState']) {
    this.mailState = state;
    this.mail?.setAccess(state);
    this.waitTimer();
  }
  /** While a grant waits for you: the manager is asked every minute (and on each account list) whether you answered. */
  private waitTimer() {
    const waiting = (this.mailWaiting && !!this.mail) || (this.noticesWaiting && !!this.notices) || this.asks.some((a) => a.state === 'pending');
    if (waiting && !this.mailTimer) this.mailTimer = setInterval(() => void this.readMailAccess(), 60_000);
    if (!waiting && this.mailTimer) {
      clearInterval(this.mailTimer);
      this.mailTimer = null;
    }
  }
  /** Mail's grant and notices', and this hub's waiting requests, as the manager says them now. */
  private async readMailAccess() {
    if (!this.mod || !this.saved) return;
    const info = (await this.mod.self(this.remoteOpts.url, this.saved.app, this.saved.token).catch(() => null)) as AppSelf | null;
    if (!info) return;
    const asks = asksOf(info);
    if (JSON.stringify(asks) !== JSON.stringify(this.asks)) this.kindsCache = null;
    this.asks = asks;
    this.publish();
    this.mailAccess(mailAccessOf(info) ?? 'pending');
    this.noticesAccess(noticesAccessOf(info) ?? 'pending');
  }

  // ---------------------------------------------------------- the page's one list (accounts-manager.ts)

  view(): P.AccountsManagerView {
    return { url: this.remoteOpts.publicUrl ?? null, reachable: !!this.client?.connected, accounts: [...this.all.values()].map(managedViewOf), asks: this.asks };
  }

  private publish() {
    publishManager(this.storeRef as Store, this.view());
  }

  async kinds(): Promise<P.ManagedKindView[] | null> {
    if (!this.client?.connected) return null;
    if (this.kindsCache && Date.now() - this.kindsCache.at < 30_000) return this.kindsCache.kinds;
    // A manager before the `kinds` action answers it as an account action with no account: then null.
    const r = (await this.client.admin({ do: 'kinds' }, 10_000).catch(() => null)) as { kinds?: Omit<P.ManagedKindView, 'asked'>[] } | null;
    if (!Array.isArray(r?.kinds)) return null;
    const kinds = r.kinds.map((k) => {
      const ask = !k.manages ? kindAsk(this.asks, k.kind) : undefined;
      return { kind: k.kind, name: k.name, interfaces: k.interfaces, add: k.add ?? null, manages: !!k.manages, ...(ask ? { asked: ask.state } : {}) };
    });
    this.kindsCache = { at: Date.now(), kinds };
    return kinds;
  }

  private async request(requests: unknown[]) {
    if (!this.mod?.requestAccess || !this.saved) throw Object.assign(new Error('dither-accounts is not reachable'), { status: 503 });
    await this.mod.requestAccess(this.remoteOpts.url, this.saved.app, this.saved.token, requests);
    this.kindsCache = null;
    await this.readMailAccess();
    this.waitTimer();
  }

  async ask(accountId: string, iface: string) {
    const level = ASK_LEVEL[iface];
    if (!level) throw Object.assign(new Error(`dither-chat does not use ${iface}`), { status: 400 });
    await this.request([{ interface: iface, level, accounts: [accountId], reason: ASK_REASON[iface] }]);
  }

  async askKind(kind: string) {
    await this.request([{ interface: 'accounts', level: 'manage', kinds: [kind], reason: `Add, sign in and remove ${kind} accounts from dither-chat` }]);
  }

  async create(kind: string, label: string, form: Record<string, string>): Promise<string> {
    if (!this.client?.connected) throw Object.assign(new Error(UNREACHABLE), { status: 503 });
    // `form` goes through the kind's own add form there (a manager before it ignores it: fine for a kind with no fields).
    const r = (await this.client.admin({ do: 'create', kind, label, form, config: {} })) as { id: string };
    return r.id;
  }

  managedOnly(id: string): P.ManagedAccountView | null {
    const v = this.all.get(id);
    return v && !this.remote.has(id) && !this.storeRef.account(id) ? managedViewOf(v) : null;
  }

  private managing(id: string): boolean {
    return !!this.all.get(id)?.manages && !!this.client;
  }

  async remove(id: string, purge: boolean) {
    if (!this.managing(id)) throw Object.assign(new Error('dither-chat may not remove this account; do it on dither-accounts’ page'), { status: 403 });
    await this.client!.admin({ do: 'delete', account: id, purge });
  }

  async setEnabled(id: string, enabled: boolean) {
    if (!this.managing(id)) throw Object.assign(new Error('dither-chat may not run this account; do it on dither-accounts’ page'), { status: 403 });
    await this.client!.admin({ do: 'update', account: id, enabled });
  }

  // ---------------------------------------------------------- notices' grant (as mail's)

  private noticesState: 'granted' | 'pending' | 'denied' | 'unreachable' = 'unreachable';
  private get noticesWaiting() {
    return this.noticesState === 'pending' || this.noticesState === 'denied';
  }
  private noticesAccess(state: RoutedSupervisor['noticesState']) {
    this.noticesState = state;
    this.notices?.setAccess(state);
    this.waitTimer();
  }

  /** "Ask again" for notices after you declined. */
  async askNoticesAgain(): Promise<void> {
    if (!this.mod?.requestAccess || !this.saved) throw new Error('dither-accounts is not reachable');
    await this.mod.requestAccess(this.remoteOpts.url, this.saved.app, this.saved.token, [NOTICES_REQUEST]);
    this.noticesAccess('pending');
  }

  /** "Ask again" after you declined: a new request on the manager's page. */
  async askMailAgain(): Promise<void> {
    if (!this.mod?.requestAccess || !this.saved) throw new Error('dither-accounts is not reachable');
    await this.mod.requestAccess(this.remoteOpts.url, this.saved.app, this.saved.token, [MAIL_REQUEST]);
    this.mailAccess('pending');
  }

  /** A mail call (mail/backend.ts). */
  callMail(account: string, op: string, input: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.client) return Promise.reject(Object.assign(new Error('dither-accounts is not reachable'), { code: 'offline' }));
    return this.client.callRaw(account, op, input, timeoutMs);
  }

  /** A notices call (notices/index.ts): the same path as mail's. */
  callNotices(account: string, op: string, input: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return this.callMail(account, op, input, timeoutMs);
  }

  private accountsChanged(list: AccountView[]) {
    this.all = new Map(list.map((a) => [a.id, a]));
    this.publish();
    const chat = list.filter((a) => a.interfaces.includes('chat') && a.grants.chat);
    const prev = this.remote;
    const before = new Set(prev.keys());
    const now = new Map(chat.map((a) => [a.id, a]));
    for (const [id, view] of now) {
      if (before.has(id)) continue;
      // Newly the manager's: anything of ours for it stops (an adapter, a start waiting on the lock).
      void super.stop(id);
      // Already online there, so its snapshot went by before this hub could see it: start it over to get one.
      if (view.online) this.client?.admin({ do: 'restart', account: id }).catch((e) => (console.error(`[${id}] restart for a snapshot failed:`, e), jobFailed('dither-accounts: restart for a snapshot', e, { account: id })));
    }
    this.remote = now;
    // Views say who runs an account and who made it (managedBy): send again those that changed.
    for (const id of new Set([...before, ...now.keys()])) {
      const was = prev.get(id);
      const is = now.get(id);
      if (!was !== !is || was?.origin !== is?.origin) this.storeRef.accountChanged?.(id);
    }
    for (const a of chat) {
      this.wasRemote.add(a.id);
      // An account another app added there (or the manager's page): the hub shows it too, under its network.
      if (!this.storeRef.account(a.id) && (NETWORKS as readonly string[]).includes(a.kind)) {
        const used = new Set(this.storeRef.accounts().map((x) => x.color));
        this.storeRef.createAccount({ id: a.id, network: a.kind as P.Network, label: a.label, color: ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[0], adapter: a.kind });
      }
      this.follow(a, prev.get(a.id));
      if (!a.online) this.markOffline(a.id);
    }
    // Gone from the manager (forgotten there, or this hub lost its grant): back to the local supervisor if its session
    // is here; one the manager made has none here, so it says so instead of starting empty.
    for (const id of before) {
      if (now.has(id)) continue;
      const acc = this.storeRef.account(id);
      if (!acc?.enabled || acc.demo) continue;
      if (this.mayRunHere(id)) super.start(id);
      else this.storeRef.updateAccount(id, { status: 'error', attention: JSON.stringify({ kind: 'unknown', message: GONE, since: Date.now() }) });
    }
    if (this.saved) {
      this.saved.remote = [...now.keys()];
      this.save();
    }
    this.gotFirstList();
  }

  /** What the manager says about an account that the hub shows too: a rename or a disable on its page, why it is not running. */
  private follow(a: AccountView, was: AccountView | undefined) {
    const acc = this.storeRef.account(a.id);
    if (!acc) return;
    if (was?.label && a.label !== was.label && a.label !== acc.label) this.storeRef.updateAccount(a.id, { label: a.label });
    if (!a.enabled && acc.enabled) this.storeRef.updateAccount(a.id, { enabled: 0, status: 'disabled' });
    else if (a.enabled && !acc.enabled && was && !was.enabled) this.storeRef.updateAccount(a.id, { enabled: 1, status: 'connecting' });
    const ours = (() => {
      try {
        return (JSON.parse(acc.attention ?? 'null')?.message ?? '').startsWith(NOT_RUNNING);
      } catch {
        return false;
      }
    })();
    if (a.error && !a.running) this.storeRef.updateAccount(a.id, { status: 'error', attention: JSON.stringify({ kind: 'unknown', message: NOT_RUNNING + a.error, since: Date.now() }) });
    else if (ours) this.storeRef.updateAccount(a.id, { attention: null });
  }

  private markOffline(id: string) {
    const acc = this.storeRef.account(id);
    if (acc && acc.status !== 'attention' && acc.status !== 'error' && acc.status !== 'disabled') this.storeRef.updateAccount(id, { status: 'offline' });
    this.calls?.onAdapterGone(id);
  }

  // ---------------------------------------------------------- the supervisor surface

  override startAll() {
    // Wait (briefly) for the manager's list, so an account it runs is never started here too.
    const wait = Promise.race([this.firstList, Bun.sleep(this.remoteOpts.firstListMs ?? 10_000)]);
    void wait.then(() => {
      for (const a of this.storeRef.accounts()) if (a.enabled && !this.remote.has(a.id) && this.mayRunHere(a.id)) super.start(a.id);
    });
  }

  override start(id: string) {
    if (!this.remote.has(id)) return super.start(id);
    this.client?.admin({ do: 'update', account: id, enabled: true }).catch((e) => (console.error(`[${id}] start through the manager failed:`, e), jobFailed('dither-accounts: start', e, { account: id })));
  }

  override async stop(id: string) {
    if (!this.remote.has(id)) return super.stop(id);
    // Disabled in the hub: disabled in the manager, so it stays off across the manager's restarts. Otherwise a stop.
    const disabled = this.storeRef.account(id)?.enabled === 0;
    await this.client?.admin(disabled ? { do: 'update', account: id, enabled: false } : { do: 'stop', account: id }).catch((e) => (console.error(`[${id}] stop through the manager failed:`, e), jobFailed('dither-accounts: stop', e, { account: id })));
  }

  override async restart(id: string) {
    if (!this.remote.has(id) && !this.managedOnly(id)) return super.restart(id);
    await this.client?.admin({ do: 'restart', account: id });
  }

  /** Local adapters stop with the hub; the manager's keep running, and their events wait for the hub to return. */
  override async stopAll() {
    await super.stopAll();
    this.gapRestarts.stop();
    if (this.mailTimer) clearInterval(this.mailTimer);
    this.mailTimer = null;
    this.client?.close();
  }

  override online(id: string): boolean {
    if (!this.remote.has(id)) return super.online(id);
    return !!this.client?.connected && !!this.remote.get(id)?.online;
  }

  override command<T = unknown>(accountId: string, cmd: Parameters<Supervisor['command']>[1], timeoutMs = 30_000): Promise<T> {
    if (!this.remote.has(accountId)) return super.command<T>(accountId, cmd, timeoutMs);
    if (!this.client) return Promise.reject(new Error('adapter is not connected'));
    const { t, ...input } = cmd as { t: string; [k: string]: unknown };
    const client = this.client;
    return span(`command ${t}`, { account: accountId, op: t, via: 'manager' }, (s) => client.callRaw(accountId, t, input, timeoutMs, s.traceparent ? { trace: s.traceparent } : undefined) as Promise<T>);
  }

  override writeSecret(id: string, secret: unknown) {
    if (!this.remote.has(id)) return super.writeSecret(id, secret);
    this.client?.admin({ do: 'secret', account: id, secret }).catch((e) => (console.error(`[${id}] secret through the manager failed:`, e), jobFailed('dither-accounts: secret', e, { account: id })));
  }

  /** managedBy for the account's view: set while the manager lists it. */
  managed(id: string): P.AccountManaged | undefined {
    const r = this.remote.get(id);
    if (!r) return undefined;
    const base = this.remoteOpts.publicUrl?.replace(/\/$/, '');
    return { url: base ? `${base}/#/accounts/${encodeURIComponent(id)}` : null, origin: r.origin ?? null };
  }

  /**
   * New accounts of the kinds the manager runs go there, under the hub's id. While it is not reachable they are
   * refused (status 503) rather than run here, since the manager is where accounts live (docs/accounts.md).
   */
  override async created(acc: AccountRow, secret: unknown) {
    if (!MANAGED_KINDS.includes(acc.adapter)) return super.created(acc, secret);
    if (!this.client?.connected) throw Object.assign(new Error(UNREACHABLE), { status: 503 });
    await this.client.admin({ do: 'create', id: acc.id, kind: acc.adapter, label: acc.label, config: JSON.parse(acc.config || '{}'), secret: secret ?? {} });
    // It is remote from now on (the manager's list follows).
    this.remote.set(acc.id, { id: acc.id, kind: acc.adapter, label: acc.label, interfaces: ['chat'], running: true, online: false, enabled: true, grants: { chat: 'manage' }, dryRun: false, origin: 'self' });
  }

  override async forget(id: string, purge = false) {
    if (!this.remote.has(id)) return;
    await this.client?.admin({ do: 'delete', account: id, purge });
    this.remote.delete(id);
  }

  override async renamed(id: string, label: string) {
    if (!this.remote.has(id)) return;
    await this.client?.admin({ do: 'update', account: id, label }).catch((e) => (console.error(`[${id}] rename through the manager failed:`, e), jobFailed('dither-accounts: rename', e, { account: id })));
  }

  /** The manager keeps the log where the account lives, which for one it made is not here. */
  override async log(id: string): Promise<string> {
    if (!this.remote.has(id) && this.managedOnly(id)) {
      if (!this.client) throw new Error('dither-accounts is not reachable');
      return ((await this.client.admin({ do: 'log', account: id, lines: 400 })) as { lines: string[] }).lines.join('\n').slice(-20_000);
    }
    if (!this.remote.has(id)) return super.log(id);
    if (!this.client) throw new Error('dither-accounts is not reachable');
    const r = (await this.client.admin({ do: 'log', account: id, lines: 400 })) as { lines: string[] };
    // What the owner did through it from here (Supervisor.note) is in the hub's own log for it.
    const mine = (await super.log(id)).split('\n').filter((l) => / \[add\] /.test(l));
    return [...r.lines, ...mine].join('\n').slice(-20_000);
  }

  /** The manager's socket for it, on this hub's token: the hub carries it on to the page's live view. */
  override liveViewUrl(id: string): string | null {
    const v = this.remote.get(id) ?? this.all.get(id);
    return v?.liveView && v.manages && this.client ? this.client.liveViewUrl(id) : null;
  }
}
