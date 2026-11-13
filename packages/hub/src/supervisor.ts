/**
 * Runs one adapter per enabled account and routes commands to it.
 *
 * Out-of-process adapters (matrix, signal, discord, whatsapp) are spawned from
 * adapterEntry() and connect back over the /adapter WebSocket. In-process adapters (the demo) use the same
 * event/command types through a direct callback.
 */

import type { ServerWebSocket, Subprocess } from 'bun';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import type { AccountRow, Store } from './store.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { sliced, type SliceOptions } from './slices.ts';

export interface InprocAdapter {
  start(emit: (ev: P.AdapterEvent) => void): void;
  command(cmd: P.AdapterCommand): void;
  stop(): void;
}

/**
 * The entry of an adapter kind. dither-accounts' extractors are where the adapters live now (docs/accounts.md), so a
 * checkout of it next to this one comes first, and an account this hub runs itself (a rollback, a manager that is
 * down) runs the same code the manager would. Then DITHER_ADAPTERS_DIR (`<dir>/<kind>/src/main.ts`, colon-separated),
 * then this repo's own copy, packages/adapter-<kind>. A kind is a plain name, never a path.
 */
export function adapterEntry(repoRoot: string, kind: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) return null;
  const dirs = [...(env.DITHER_ADAPTERS_DIR ?? '').split(':').filter(Boolean), ...(env.DITHER_ADAPTERS_DIR ? [] : [join(repoRoot, '..', 'dither-accounts', 'extractors')])];
  for (const d of dirs) {
    const entry = join(resolve(d), kind, 'src', 'main.ts');
    if (existsSync(entry)) return entry;
  }
  const own = join(repoRoot, 'packages', `adapter-${kind}`, 'src', 'main.ts');
  return existsSync(own) ? own : null;
}

/**
 * The hub's environment without its own secrets (the TURN secret, push tokens and the like): an adapter gets what
 * it needs through its account directory and DITHER_ACCOUNT_*.
 */
export function adapterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL/i.test(k)) out[k] = v;
  return out;
}

export type InprocFactory = (acc: AccountRow, dir: string) => InprocAdapter | null;

export interface AdapterSocketData {
  kind: 'adapter';
  accountId: string;
}

interface Running {
  retry?: Timer;
  proc?: Subprocess;
  inproc?: InprocAdapter;
  ws?: ServerWebSocket<AdapterSocketData>;
  restarts: number;
  stopping: boolean;
  lastStart: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer };

const BACKOFF = [1, 2, 5, 10, 30, 60];
/** How often an account another process runs is looked at again. */
const LOCK_RETRY_MS = 15_000;

export interface CallSink {
  onAdapterEvent(accountId: string, ev: Extract<P.AdapterEvent, { t: 'call' }>): void;
  onAdapterGone(accountId: string): void;
}

/** Another connection held the database past busy_timeout (SQLITE_BUSY). */
export const isBusy = (e: unknown) => (e as { code?: string } | null)?.code === 'SQLITE_BUSY';
/** Adapter events applied in one transaction, and between turns of the event loop when a batch is long. */
export const EVENTS_STEP = 32;
/** How long held events wait before they are tried again, and how many times in a row. */
const HELD_RETRY_MS = 1000;
const HELD_TRIES = 60;

export class Supervisor {
  protected running = new Map<string, Running>();
  private pending = new Map<string, Pending>();
  /** Where call events go (the server's Calls). */
  calls?: CallSink;

  constructor(
    private store: Store,
    private opts: {
      hubAdapterUrl: string;
      dataDir: string;
      repoRoot: string;
      inproc: InprocFactory;
      /** Called after each ingested batch with ids of new live messages. */
      onFresh: (messageIds: string[]) => void;
    },
  ) {}

  accountDir(id: string): string {
    const dir = join(this.opts.dataDir, 'accounts', id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  writeSecret(id: string, secret: unknown) {
    writeSecretFile(join(this.accountDir(id), 'secret.json'), secret ?? {});
  }

  /** A new account from the API: its secret, then its adapter. remote.ts gives it to the manager instead. */
  async created(acc: AccountRow, secret: unknown) {
    this.writeSecret(acc.id, secret ?? {});
    this.start(acc.id);
  }

  /**
   * The account is being deleted from the hub (after stop). remote.ts removes it from the manager too, with its
   * directory if `purge` and the manager made it. Here the directory stays, as it always has.
   */
  async forget(_id: string, _purge = false) {}

  /** The hub renamed an account. remote.ts tells the manager, so its page and the adapter's label follow. */
  async renamed(_id: string, _label: string) {}

  /** Something the owner did through the account (add.ts: a join, a friend request), in its log on the hub. */
  note(id: string, line: string) {
    appendFileSync(join(this.accountDir(id), 'adapter.log'), `--- ${new Date().toISOString()} ${line}\n`);
  }

  /** The end of an account's adapter log. remote.ts asks the manager, which keeps the log where the account lives. */
  async log(id: string): Promise<string> {
    const p = join(this.opts.dataDir, 'accounts', id, 'adapter.log');
    if (!existsSync(p)) return '';
    // The tail only: the file is rotated at 10 MB (housekeeping.ts) and need not be read whole.
    const f = Bun.file(p);
    return (await f.slice(Math.max(0, f.size - 24_000)).text()).slice(-20_000);
  }

  /** Where an account's live view is when another process runs it (remote.ts: the manager's socket); null: its VNC socket here. */
  liveViewUrl(_id: string): string | null {
    return null;
  }

  startAll() {
    for (const a of this.store.accounts()) if (a.enabled) this.start(a.id);
  }

  start(id: string) {
    const acc = this.store.account(id);
    if (!acc || !acc.enabled) return;
    const cur = this.running.get(id);
    if (cur && !cur.stopping && (cur.proc || cur.inproc)) return;
    const r: Running = cur ?? { restarts: 0, stopping: false, lastStart: 0 };
    clearTimeout(r.retry);
    r.stopping = false;
    r.lastStart = Date.now();
    this.running.set(id, r);
    const dir = this.accountDir(id);

    const inproc = this.opts.inproc(acc, dir);
    if (inproc) {
      r.inproc = inproc;
      inproc.start((ev) => this.apply(id, [ev]));
      return;
    }

    const entry = adapterEntry(this.opts.repoRoot, acc.adapter);
    if (!entry) {
      this.store.updateAccount(id, {
        status: 'error',
        attention: JSON.stringify({ kind: 'unknown', message: `No adapter installed for "${acc.adapter}"`, since: Date.now() }),
      });
      return;
    }
    // Someone else (dither-accounts' manager, an orphaned adapter) runs this account: not a second session. Look
    // again later, so an orphan's account comes back once it is gone.
    const held = acquireLock(dir, 'dither-chat', id);
    if (held) {
      r.retry = setTimeout(() => this.start(id), LOCK_RETRY_MS);
      // An adapter from before a crash that found its way back to this hub: it is the account's session; leave it be.
      if (r.ws) return;
      this.store.updateAccount(id, { status: 'error', attention: JSON.stringify({ kind: 'unknown', message: `Not started here: ${held}`, since: Date.now() }) });
      appendFileSync(join(dir, 'adapter.log'), `--- ${new Date().toISOString()} not started: ${held}\n`);
      return;
    }
    this.store.updateAccount(id, { status: 'connecting' });
    const log = join(dir, 'adapter.log');
    appendFileSync(log, `\n--- ${new Date().toISOString()} starting ${acc.adapter} adapter\n`);
    const proc = Bun.spawn(['bun', entry], {
      cwd: this.opts.repoRoot,
      env: {
        ...adapterEnv(process.env),
        DITHER_HUB_URL: this.opts.hubAdapterUrl,
        DITHER_ACCOUNT_ID: id,
        DITHER_ADAPTER_TOKEN: acc.token,
        DITHER_ACCOUNT_DIR: dir,
        DITHER_ACCOUNT_CONFIG: acc.config,
        DITHER_ACCOUNT_LABEL: acc.label,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (p, code, signal) => this.exited(id, p, code, signal),
    });
    r.proc = proc;
    for (const stream of [proc.stdout, proc.stderr]) {
      (async () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          appendFileSync(log, value);
        }
      })().catch(() => {});
    }
  }

  private exited(id: string, proc: Subprocess, code: number | null, signal: unknown) {
    const r = this.running.get(id);
    // A stale process can exit after restart() has already started its
    // replacement (onExit and `await proc.exited` are not ordered). Ignore it,
    // or we'd clear the live handle and spawn a second adapter for this account.
    if (!r || (r.proc && r.proc !== proc)) return;
    r.proc = undefined;
    appendFileSync(join(this.accountDir(id), 'adapter.log'), `--- exited code=${code} signal=${signal}\n`);
    const acc = this.store.account(id);
    if (r.stopping || !acc?.enabled) {
      releaseLock(this.accountDir(id));
      return;
    }
    // A process that ran for a while gets a fresh backoff.
    if (Date.now() - r.lastStart > 120_000) r.restarts = 0;
    const delay = BACKOFF[Math.min(r.restarts, BACKOFF.length - 1)];
    r.restarts++;
    if (acc.status !== 'attention') this.store.updateAccount(id, { status: 'error' });
    setTimeout(() => this.start(id), delay * 1000);
  }

  async stop(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.stopping = true;
    clearTimeout(r.retry);
    if (r.inproc) {
      r.inproc.stop();
      r.inproc = undefined;
    }
    if (r.ws) {
      try {
        r.ws.send(JSON.stringify({ t: 'shutdown' } satisfies P.AdapterCommand));
      } catch {}
    }
    if (r.proc) {
      const p = r.proc;
      const killer = setTimeout(() => p.kill('SIGKILL'), 8000);
      p.kill('SIGTERM');
      await p.exited.catch(() => {});
      clearTimeout(killer);
      releaseLock(this.accountDir(id));
    }
    this.running.delete(id);
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  async restart(id: string) {
    await this.stop(id);
    this.start(id);
  }

  // ---------------------------------------------------------- socket plumbing

  /** Validate an /adapter upgrade. Returns the account id or null. */
  authorize(accountId: string | null, token: string | null): string | null {
    if (!accountId || !token) return null;
    const acc = this.store.account(accountId);
    return acc && acc.token === token ? acc.id : null;
  }

  attach(ws: ServerWebSocket<AdapterSocketData>) {
    const r = this.running.get(ws.data.accountId) ?? { restarts: 0, stopping: false, lastStart: Date.now() };
    if (r.ws && r.ws !== ws) {
      try {
        r.ws.close(4000, 'replaced');
      } catch {}
    }
    r.ws = ws;
    this.running.set(ws.data.accountId, r);
  }

  detach(ws: ServerWebSocket<AdapterSocketData>) {
    const r = this.running.get(ws.data.accountId);
    if (r?.ws === ws) r.ws = undefined;
    this.calls?.onAdapterGone(ws.data.accountId);
    const acc = this.store.account(ws.data.accountId);
    if (acc && acc.status !== 'attention' && acc.status !== 'error') this.store.updateAccount(acc.id, { status: 'offline' });
  }

  receive(ws: ServerWebSocket<AdapterSocketData>, raw: string | Buffer) {
    let ev: P.AdapterEvent;
    try {
      ev = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    this.apply(ws.data.accountId, [ev]);
  }

  /** Events held after the database was locked, by account, with all that came after them for that account. */
  private held = new Map<string, P.AdapterEvent[]>();
  private heldTries = 0;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;

  /** Batches not applied yet, in the order they came: a long one, and whatever came behind it. */
  private inbox: { account: string; events: P.AdapterEvent[] }[] = [];
  private applying: Promise<void> | null = null;
  /** How a long batch shares the hub's thread (slices.ts); a test's clock and pauses. */
  slices: SliceOptions = {};
  /** Told how many events each transaction applied (a test's). */
  onApplied?: (events: number) => void;

  /**
   * An account's events, from its socket, an in-process adapter, or (remote.ts) dither-accounts' manager, in order.
   * A few, with nothing waiting: applied now, in one transaction (one commit: on a busy disk each commit is most of
   * what an event costs). More (a history page, a snapshot, a member list: hundreds or thousands), or behind others:
   * queued, and applied EVENTS_STEP at a time, each slice one transaction, with a turn of the event loop between.
   * One that fails is logged with its type and skipped; the rest go on. One the database was locked for (another
   * process held it past busy_timeout, store.ts) is held with everything after it, and tried again a second later.
   */
  apply(accountId: string, events: P.AdapterEvent[]) {
    const waiting = this.held.get(accountId);
    if (waiting) {
      waiting.push(...events);
      return;
    }
    if (!this.inbox.length && events.length <= EVENTS_STEP) return this.applyNow(accountId, events);
    this.inbox.push({ account: accountId, events: [...events] });
    this.applying ??= sliced('adapter events: backlog', this.applySteps(), this.slices)
      .catch((e) => console.error('applying adapter events failed', e))
      .finally(() => (this.applying = null));
  }

  /** Once what is queued is applied (held events aside): a test's wait. */
  drained(): Promise<void> {
    return this.applying ?? Promise.resolve();
  }

  private *applySteps(): Generator<number, void> {
    while (this.inbox.length) {
      const b = this.inbox[0];
      // Its account is held for a locked database: this waits behind what is held.
      const waiting = this.held.get(b.account);
      if (waiting) {
        waiting.push(...b.events);
        this.inbox.shift();
        continue;
      }
      const part = b.events.splice(0, EVENTS_STEP);
      if (!b.events.length) this.inbox.shift();
      this.applyNow(b.account, part);
      yield part.length;
    }
  }

  /** These events in one transaction; from the first the database was locked for, held. */
  private applyNow(accountId: string, events: P.AdapterEvent[]) {
    let busyAt = -1;
    try {
      this.store.db.transaction(() => {
        for (let i = 0; i < events.length; i++) {
          let r: 'busy' | void;
          try {
            r = this.handle(accountId, events[i]);
          } catch (e) {
            console.error(`[${accountId}] ${events[i].t} failed:`, e);
            continue;
          }
          if (r === 'busy') {
            busyAt = i;
            return;
          }
        }
      })();
    } catch (e) {
      // The commit itself met the lock: none of them is in.
      if (!isBusy(e)) throw e;
      busyAt = 0;
    }
    this.onApplied?.(busyAt < 0 ? events.length : busyAt);
    if (busyAt < 0) return;
    this.held.set(accountId, events.slice(busyAt));
    console.warn(`[${accountId}] the database is locked: ${events.length - busyAt} events wait to be applied again`);
    this.heldTimer ??= setTimeout(() => this.retryHeld(), HELD_RETRY_MS);
    (this.heldTimer as { unref?: () => void }).unref?.();
  }

  /** The held events, again (a timer's, or a test's). After HELD_TRIES in a row the database is taken to be stuck. */
  retryHeld() {
    this.heldTimer = null;
    const held = [...this.held];
    this.held.clear();
    if (++this.heldTries > HELD_TRIES) {
      for (const [id, evs] of held) console.error(`[${id}] the database stayed locked: ${evs.length} events not applied (${[...new Set(evs.map((e) => e.t))].join(', ')})`);
      this.heldTries = 0;
      return;
    }
    for (const [id, evs] of held) {
      // What came for the account while it was held and is still queued comes after it.
      for (const b of this.inbox) if (b.account === id) evs.push(...b.events.splice(0));
      this.inbox = this.inbox.filter((b) => b.events.length);
      this.apply(id, evs);
    }
    if (!this.held.size) this.heldTries = 0;
  }

  /** Events queued to be applied, held ones included (a test waits for 0). */
  get backlog(): number {
    return this.inbox.reduce((n, b) => n + b.events.length, 0) + this.heldEvents;
  }

  /** Events waiting for the database (a test's). */
  get heldEvents(): number {
    let n = 0;
    for (const evs of this.held.values()) n += evs.length;
    return n;
  }

  /** One event. 'busy': the database was locked and nothing of it was applied. */
  protected handle(accountId: string, ev: P.AdapterEvent): 'busy' | void {
    if (ev.t === 'reply') {
      const p = this.pending.get(ev.id);
      if (!p) return;
      this.pending.delete(ev.id);
      clearTimeout(p.timer);
      if (ev.ok) p.resolve(ev.result);
      else p.reject(new Error(ev.error));
      return;
    }
    if (ev.t === 'log') {
      const line = `[${ev.level}] ${ev.msg}${ev.data !== undefined ? ' ' + JSON.stringify(ev.data) : ''}\n`;
      appendFileSync(join(this.accountDir(accountId), 'adapter.log'), line);
      if (ev.level === 'warn' || ev.level === 'error') console.warn(`[${accountId}] ${line.trim()}`);
      return;
    }
    if (ev.t === 'call') {
      this.calls?.onAdapterEvent(accountId, ev);
      return;
    }
    const acc = this.store.account(accountId);
    if (!acc) return;
    let fresh: string[];
    try {
      // One transaction: on a throw, nothing of the event is in.
      fresh = this.store.ingest(acc, ev);
    } catch (e) {
      if (isBusy(e)) return 'busy';
      console.error(`[${accountId}] ingest ${ev.t} failed:`, e);
      return;
    }
    try {
      if (fresh.length) this.opts.onFresh(fresh);
    } catch (e) {
      console.error(`[${accountId}] triage of ${fresh.length} new messages could not start:`, e);
    }
  }

  online(id: string): boolean {
    const r = this.running.get(id);
    return !!(r?.ws || r?.inproc);
  }

  command<T = unknown>(accountId: string, cmd: P.AdapterCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : C) : never, timeoutMs = 30_000): Promise<T> {
    const r = this.running.get(accountId);
    const id = crypto.randomUUID();
    const full = { ...cmd, id } as P.AdapterCommand;
    return new Promise<T>((resolve, reject) => {
      if (!r?.ws && !r?.inproc) return reject(new Error('adapter is not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`adapter timed out on ${cmd.t}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (r.inproc) queueMicrotask(() => r.inproc!.command(full));
      else r.ws!.send(JSON.stringify(full));
    });
  }
}
