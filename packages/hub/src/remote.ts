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
import { NETWORKS } from '@dither-chat/protocol';
import { ACCOUNT_COLORS, type AccountRow } from './store.ts';
import { Supervisor } from './supervisor.ts';

/** The kinds this hub hands to the manager when they are new. */
export const MANAGED_KINDS = ['discord', 'signal', 'matrix', 'whatsapp'];

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
  callRaw(account: string, op: string, input?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
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

export class RoutedSupervisor extends Supervisor {
  private client: Client | null = null;
  /** Accounts the manager lists for this hub. */
  private remote = new Map<string, AccountView>();
  private firstList: Promise<void>;
  private gotFirstList!: () => void;
  private saved: Saved | null = null;
  private storeRef: ConstructorParameters<typeof Supervisor>[0];
  /** Accounts the manager ran (last time, or until they left its list): never started here without a session here. */
  private wasRemote = new Set<string>();

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
      setTimeout(() => void this.connectOrRetry(), 30_000);
    }
  }

  /** Register once (or again, if the manager forgot this hub), then connect. */
  async connect(): Promise<void> {
    const mod = (await import(process.env.DITHER_ACCOUNTS_CLIENT ?? resolve(this.remoteOpts.repoRoot, '../dither-accounts/packages/client/src/index.ts'))) as ClientModule;
    const url = this.remoteOpts.url;
    let known = this.saved && this.saved.url === url ? await mod.self(url, this.saved.app, this.saved.token).then(() => true, (e) => !/\b401\b/.test(String(e))) : false;
    if (!known) {
      const reg = await mod.register(url, {
        name: 'dither-chat',
        describe: 'The chat hub: reads and answers your chats on every network, and manages the chat accounts it adds.',
        requests: [
          { interface: 'chat', level: 'manage', accounts: '*', reason: 'Show your chats, send what you write, and manage chats and servers as you ask' },
          { interface: 'accounts', level: 'manage', kinds: MANAGED_KINDS, reason: 'Add, sign in and remove the chat accounts you set up in the hub' },
        ],
      });
      this.saved = { app: reg.app, token: reg.token, url, remote: [] };
      this.save();
      console.log(`dither-accounts: registered as ${reg.app}; approve its requests on the manager's page`);
    }
    this.client = new mod.AccountsClient({
      url,
      app: this.saved!.app,
      token: this.saved!.token,
      onAccounts: (list) => this.accountsChanged(list),
      onEvents: (account, events) => {
        if (!this.remote.has(account)) return;
        for (const ev of events) this.handle(account, ev as P.AdapterEvent);
      },
      onGap: (account, dropped) => {
        console.warn(`[${account}] the manager dropped ${dropped} events while the hub was away; restarting the adapter for a fresh snapshot`);
        this.client?.admin({ do: 'restart', account }).catch((e) => console.error(`[${account}] restart after a gap failed:`, e));
      },
      onConnection: (up) => {
        if (up) return;
        for (const id of this.remote.keys()) this.markOffline(id);
      },
    });
  }

  private accountsChanged(list: AccountView[]) {
    const chat = list.filter((a) => a.interfaces.includes('chat') && a.grants.chat);
    const prev = this.remote;
    const before = new Set(prev.keys());
    const now = new Map(chat.map((a) => [a.id, a]));
    for (const [id, view] of now) {
      if (before.has(id)) continue;
      // Newly the manager's: anything of ours for it stops (an adapter, a start waiting on the lock).
      void super.stop(id);
      // Already online there, so its snapshot went by before this hub could see it: start it over to get one.
      if (view.online) this.client?.admin({ do: 'restart', account: id }).catch((e) => console.error(`[${id}] restart for a snapshot failed:`, e));
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
    this.client?.admin({ do: 'update', account: id, enabled: true }).catch((e) => console.error(`[${id}] start through the manager failed:`, e));
  }

  override async stop(id: string) {
    if (!this.remote.has(id)) return super.stop(id);
    // Disabled in the hub: disabled in the manager, so it stays off across the manager's restarts. Otherwise a stop.
    const disabled = this.storeRef.account(id)?.enabled === 0;
    await this.client?.admin(disabled ? { do: 'update', account: id, enabled: false } : { do: 'stop', account: id }).catch((e) => console.error(`[${id}] stop through the manager failed:`, e));
  }

  override async restart(id: string) {
    if (!this.remote.has(id)) return super.restart(id);
    await this.client?.admin({ do: 'restart', account: id });
  }

  /** Local adapters stop with the hub; the manager's keep running, and their events wait for the hub to return. */
  override async stopAll() {
    await super.stopAll();
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
    return this.client.callRaw(accountId, t, input, timeoutMs) as Promise<T>;
  }

  override writeSecret(id: string, secret: unknown) {
    if (!this.remote.has(id)) return super.writeSecret(id, secret);
    this.client?.admin({ do: 'secret', account: id, secret }).catch((e) => console.error(`[${id}] secret through the manager failed:`, e));
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
    await this.client?.admin({ do: 'update', account: id, label }).catch((e) => console.error(`[${id}] rename through the manager failed:`, e));
  }

  /** The manager keeps the log where the account lives, which for one it made is not here. */
  override async log(id: string): Promise<string> {
    if (!this.remote.has(id)) return super.log(id);
    if (!this.client) throw new Error('dither-accounts is not reachable');
    const r = (await this.client.admin({ do: 'log', account: id, lines: 400 })) as { lines: string[] };
    return r.lines.join('\n').slice(-20_000);
  }

  /** The manager's socket for it, on this hub's token: the hub carries it on to the page's live view. */
  override liveViewUrl(id: string): string | null {
    const v = this.remote.get(id);
    return v?.liveView && v.manages && this.client ? this.client.liveViewUrl(id) : null;
  }
}
