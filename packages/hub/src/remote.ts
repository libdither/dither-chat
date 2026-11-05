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
 * The manager's client is loaded from a dither-accounts checkout beside this repo (DITHER_ACCOUNTS_CLIENT overrides
 * the path), only when this mode is on: dither-chat itself does not depend on dither-accounts.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { NETWORKS } from '@dither-chat/protocol';
import type { AccountRow } from './store.ts';
import { Supervisor } from './supervisor.ts';

/** The kinds this hub hands to the manager when they are new. */
export const MANAGED_KINDS = ['discord', 'signal', 'matrix', 'whatsapp'];

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
}
interface Client {
  accounts: AccountView[];
  connected: boolean;
  callRaw(account: string, op: string, input?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  admin(action: Record<string, unknown>, timeoutMs?: number): Promise<any>;
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
}

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
        for (const id of this.saved?.remote ?? []) this.remote.set(id, { id, kind: '', label: '', interfaces: ['chat'], running: false, online: false, enabled: true, grants: {}, dryRun: false });
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
    const before = new Set(this.remote.keys());
    const now = new Map(chat.map((a) => [a.id, a]));
    for (const [id, view] of now) {
      if (before.has(id)) continue;
      // Newly the manager's: anything of ours for it stops (an adapter, a start waiting on the lock).
      void super.stop(id);
      // Already online there, so its snapshot went by before this hub could see it: start it over to get one.
      if (view.online) this.client?.admin({ do: 'restart', account: id }).catch((e) => console.error(`[${id}] restart for a snapshot failed:`, e));
    }
    this.remote = now;
    for (const a of chat) {
      // An account another app added there: the hub shows it too, under its network.
      if (!this.storeRef.account(a.id) && (NETWORKS as readonly string[]).includes(a.kind)) {
        this.storeRef.createAccount({ id: a.id, network: a.kind as P.Network, label: a.label, color: '#9BE15D', adapter: a.kind });
      }
      if (!a.online) this.markOffline(a.id);
    }
    // Gone from the manager (forgotten there, or this hub lost its grant): back to the local supervisor.
    for (const id of before) {
      if (now.has(id)) continue;
      const acc = this.storeRef.account(id);
      if (acc?.enabled && !acc.demo) super.start(id);
    }
    if (this.saved) {
      this.saved.remote = [...now.keys()];
      this.save();
    }
    this.gotFirstList();
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
      for (const a of this.storeRef.accounts()) if (a.enabled && !this.remote.has(a.id)) super.start(a.id);
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

  /** New accounts of the kinds the manager runs go there, under the hub's id, once the manager is reachable. */
  override async created(acc: AccountRow, secret: unknown) {
    if (!this.client?.connected || !MANAGED_KINDS.includes(acc.adapter)) return super.created(acc, secret);
    await this.client.admin({ do: 'create', id: acc.id, kind: acc.adapter, label: acc.label, config: JSON.parse(acc.config || '{}'), secret: secret ?? {} });
    // It is remote from now on (the manager's list follows).
    this.remote.set(acc.id, { id: acc.id, kind: acc.adapter, label: acc.label, interfaces: ['chat'], running: true, online: false, enabled: true, grants: { chat: 'manage' }, dryRun: false });
  }

  override async forget(id: string) {
    if (!this.remote.has(id)) return;
    await this.client?.admin({ do: 'delete', account: id });
    this.remote.delete(id);
  }
}
