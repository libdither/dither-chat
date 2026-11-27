/**
 * Runs one adapter per enabled account and routes commands to it.
 *
 * Out-of-process adapters (matrix, signal, discord, whatsapp) are spawned from
 * adapterEntry() and connect back over the /adapter WebSocket. In-process adapters (the demo) use the same
 * event/command types through a direct callback.
 */

import type { ServerWebSocket, Subprocess } from 'bun';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import type { AccountRow, Store } from './store.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { sliced, type SliceOptions } from './slices.ts';
import { timedWrite } from './stalls.ts';
import { span } from './trace.ts';
import { jobFailed, reportError } from './errors.ts';
import type { EventWatch } from './catchup.ts';

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

type InprocFactory = (acc: AccountRow, dir: string) => InprocAdapter | null;

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

interface CallSink {
  onAdapterEvent(accountId: string, ev: Extract<P.AdapterEvent, { t: 'call' }>): void;
  onAdapterGone(accountId: string): void;
}

/** Another connection held the database past busy_timeout (SQLITE_BUSY). */
const isBusy = (e: unknown) => (e as { code?: string } | null)?.code === 'SQLITE_BUSY';
/**
 * Why a write failed for a reason outside the event itself, or null for a fault of the event's own (a bad record).
 * Locked (SQLITE_BUSY), the disk full (SQLITE_FULL), a file that could not be opened or written (SQLITE_CANTOPEN,
 * SQLITE_IOERR_*), or no memory: the same event goes in once that passes, so it is held, never skipped. On most of
 * these SQLite may roll the whole transaction back by itself, so nothing after it in the batch is applied either.
 */
function heldFor(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  if (code === 'SQLITE_BUSY') return 'the database is locked';
  if (code === 'SQLITE_FULL' || code === 'SQLITE_NOMEM' || code === 'SQLITE_CANTOPEN' || code.startsWith('SQLITE_IOERR')) return `the database could not be written (${(e as Error).message})`;
  return null;
}
/** Adapter events applied in one transaction, and between turns of the event loop when a batch is long. */
export const EVENTS_STEP = 32;
/** The hub's own marker among an account's events (`settled`): never an adapter's, and nothing to store. */
const BARRIER = 'hub.settled';
/** How long held events wait before they are tried again, and how many times in a row. */
const HELD_RETRY_MS = 1000;
const HELD_TRIES = 60;
/** After HELD_TRIES, how long held events wait between tries: they are kept, never dropped. */
const HELD_SLOW_MS = 30_000;
/** At a stop or a start, how many times in a row held events are tried again (busy_timeout waits in each). */
const SETTLE_TRIES = 5;
/**
 * Events a stop could not apply, carried over to the next start (`settle`, `resume`): one line per account batch,
 * `{"account": id, "events": [...]}`, in the order they go in.
 */
export const PENDING_EVENTS = 'pending-events.ndjson';

type Batch = { account: string; events: P.AdapterEvent[] };

/** `n events (message×3, reaction)`: a count and its kinds, for the log. */
function summary(batches: Batch[]): string {
  const kinds = new Map<string, number>();
  let n = 0;
  for (const b of batches)
    for (const e of b.events) {
      n++;
      kinds.set(e.t, (kinds.get(e.t) ?? 0) + 1);
    }
  return `${n} events (${[...kinds].map(([k, c]) => (c > 1 ? `${k}×${c}` : k)).join(', ')})`;
}
const count = (batches: Batch[]) => batches.reduce((n, b) => n + b.events.length, 0);

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
    span(`adapter event ${ev.t}`, { account: ws.data.accountId }, () => this.apply(ws.data.accountId, [ev]));
  }

  /** Events held after the database was locked, by account, with all that came after them for that account. */
  private held = new Map<string, P.AdapterEvent[]>();
  private heldTries = 0;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;

  /** Batches not applied yet, in the order they came: a long one, and whatever came behind it. */
  private inbox: Batch[] = [];
  private applying: Promise<void> | null = null;
  /** PENDING_EVENTS holds events still queued here: removed once nothing is (`tidyPending`). */
  private pendingOnDisk = false;
  /** How a long batch shares the hub's thread (slices.ts); a test's clock and pauses. */
  slices: SliceOptions = {};
  /** Told how many events each transaction applied (a test's). */
  onApplied?: (events: number) => void;
  /** Told what comes, waits and is lost, so missing messages can be found and fetched (catchup.ts). */
  watch?: EventWatch;

  /**
   * An account's events, from its socket, an in-process adapter, or (remote.ts) dither-accounts' manager, in order.
   * A few, with nothing waiting: applied now, in one transaction (one commit: on a busy disk each commit is most of
   * what an event costs). More (a history page, a snapshot, a member list: hundreds or thousands), or behind others:
   * queued, and applied EVENTS_STEP at a time, each slice one transaction, with a turn of the event loop between.
   * One that fails is logged with its type and skipped; the rest go on. One the database was locked for (another
   * process held it past busy_timeout, store.ts), or whose commit failed (a full disk), is held with everything after
   * it, and tried again a second later. A stop applies what is still queued or held, and carries over to the next start
   * what it could not (`settle`, `resume`).
   */
  apply(accountId: string, events: P.AdapterEvent[]) {
    this.tell((w) => w.heard(accountId));
    this.enqueue(accountId, events, true);
  }

  /** Applied now, or behind what waits for the account (`tell`: the watch hears they wait). */
  private enqueue(accountId: string, events: P.AdapterEvent[], tell: boolean) {
    const waiting = this.held.get(accountId);
    if (waiting) {
      waiting.push(...events);
      if (tell) this.tell((w) => w.queued(accountId, events));
      return;
    }
    if (!this.inbox.length && events.length <= EVENTS_STEP) return this.applyNow(accountId, events);
    this.inbox.push({ account: accountId, events: [...events] });
    if (tell) this.tell((w) => w.queued(accountId, events));
    this.work();
  }

  /** Barriers waiting their turn (`settled`), by id. */
  private barriers = new Map<number, () => void>();
  private barrierSeq = 0;

  /**
   * Once every event this account sent before now is applied (stored and committed) or lost: true; false if that
   * takes longer than `timeoutMs` (a database held locked). A marker goes into the account's events behind what came
   * before it, in their order, and is passed once the transaction that applied it commits. A history page's messages
   * come before its answer (an adapter's socket keeps its order; dither-accounts' manager sends a call's events
   * before its result), so a page read through historypage.ts waits on this to know they are in.
   */
  settled(accountId: string, timeoutMs = 120_000): Promise<boolean> {
    return new Promise((resolve) => {
      const id = ++this.barrierSeq;
      const timer = setTimeout(() => {
        this.barriers.delete(id);
        resolve(false);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.barriers.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.enqueue(accountId, [{ t: BARRIER, id } as unknown as P.AdapterEvent], false);
    });
  }

  /** Tells the watch (catchup.ts), which never stops an event: whatever it throws is logged and dropped. */
  private tell(fn: (w: EventWatch) => void) {
    if (!this.watch) return;
    try {
      fn(this.watch);
    } catch (e) {
      console.error('catch-up watch failed', e);
    }
  }

  /** The queue's worker, in slices, if it is not running already. */
  private work() {
    this.applying ??= sliced('adapter events: backlog', this.applySteps(), this.slices)
      .catch((e) => (console.error('applying adapter events failed', e), jobFailed('adapter events: backlog', e)))
      .finally(() => {
        this.applying = null;
        this.tidyPending();
        // A batch that came after the last slice looked and before this (the worker still counted as running): its
        // own run now, rather than waiting for the next event to start one.
        if (this.inbox.length) this.work();
      });
  }

  /** Once what is queued is applied (held events aside): a test's wait. */
  drained(): Promise<void> {
    return this.applying ?? Promise.resolve();
  }

  private *applySteps(): Generator<number, void> {
    while (this.inbox.length) {
      const n = this.step();
      if (n) yield n;
    }
  }

  /** The inbox's next slice, in one transaction; how many events it took (0: it only moved a batch behind held ones). */
  private step(): number {
    const b = this.inbox[0];
    // Its account is held for a locked database: this waits behind what is held.
    const waiting = this.held.get(b.account);
    if (waiting) {
      waiting.push(...b.events);
      this.inbox.shift();
      return 0;
    }
    const part = b.events.splice(0, EVENTS_STEP);
    if (!b.events.length) this.inbox.shift();
    this.applyNow(b.account, part);
    return part.length;
  }

  /** These events in one transaction; from the first the database was locked for, held. Never throws. */
  private applyNow(accountId: string, events: P.AdapterEvent[]) {
    let busyAt = -1;
    let why = 'the database is locked';
    try {
      timedWrite(`adapter events (${events.length})`, () => this.store.db.transaction(() => {
        for (let i = 0; i < events.length; i++) {
          let r: { held: string } | void;
          try {
            r = this.handle(accountId, events[i]);
          } catch (e) {
            console.error(`[${accountId}] ${events[i].t} failed:`, e);
            jobFailed('adapter event', e, { account: accountId, event: events[i].t });
            this.tell((w) => w.lost(accountId, [events[i]], String((e as Error)?.message ?? e).slice(0, 200)));
            continue;
          }
          if (r) {
            busyAt = i;
            why = r.held;
            return;
          }
        }
      })());
    } catch (e) {
      // The transaction itself failed (the lock at its commit, a full disk): none of them is in. Held, not lost.
      busyAt = 0;
      if (!isBusy(e)) {
        why = `their commit failed (${(e as Error)?.message ?? e})`;
        console.error(`[${accountId}] applying ${events.length} events failed:`, e);
      }
    }
    const applied = busyAt < 0 ? events.length : busyAt;
    this.onApplied?.(applied);
    // Committed: the barriers among them are passed (one in a transaction that failed is held with it).
    if (this.barriers.size)
      for (let i = 0; i < applied; i++) {
        const e = events[i] as { t: string; id?: unknown };
        if (e.t === BARRIER && typeof e.id === 'number') {
          this.barriers.get(e.id)?.();
          this.barriers.delete(e.id);
        }
      }
    if (busyAt < 0) return;
    // After anything already held for it (none: a held account's events wait in `held` and never reach here).
    const held = events.slice(busyAt);
    this.held.set(accountId, [...(this.held.get(accountId) ?? []), ...held]);
    this.tell((w) => w.queued(accountId, held));
    console.warn(`[${accountId}] ${why}: ${held.length} events wait to be applied again`);
    reportError({ source: 'job', where: 'adapter events', name: 'SQLiteError', message: `${why}: events wait to be applied again`, extra: { account: accountId, events: held.length } });
    this.heldTimer ??= setTimeout(() => this.retryHeld(), HELD_RETRY_MS);
    (this.heldTimer as { unref?: () => void }).unref?.();
  }

  /** Held events back to the front of the inbox, each account's before what it has queued there. */
  private requeueHeld() {
    const held = [...this.held].map(([account, events]) => ({ account, events }));
    this.held.clear();
    this.inbox.unshift(...held);
  }

  /**
   * The held events, again (a timer's, or a test's). After HELD_TRIES in a row the database is taken to be stuck: they
   * are said loudly, written to PENDING_EVENTS so that a crash cannot lose them, kept, and tried every HELD_SLOW_MS.
   */
  retryHeld() {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    const held = [...this.held];
    this.held.clear();
    for (const [id, evs] of held) {
      // What came for the account while it was held and is still queued comes after it.
      for (const b of this.inbox) if (b.account === id) evs.push(...b.events.splice(0));
      this.inbox = this.inbox.filter((b) => b.events.length);
      this.enqueue(id, evs, true);
    }
    if (!this.held.size) {
      this.heldTries = 0;
      return this.tidyPending();
    }
    if (++this.heldTries < HELD_TRIES) return;
    const left = this.queued();
    console.error(`adapter events: the database stayed locked for ${HELD_TRIES} tries: ${summary(left)} kept, tried again every ${HELD_SLOW_MS / 1000} s, and saved to ${PENDING_EVENTS}`);
    reportError({ source: 'job', where: 'adapter events', name: 'SQLiteError', message: 'the database stayed locked: events kept and saved for the next start', extra: { events: count(left) } });
    this.savePending(left);
    this.heldTries = 0;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = setTimeout(() => this.retryHeld(), HELD_SLOW_MS);
    (this.heldTimer as { unref?: () => void }).unref?.();
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

  /** What is held and queued, as batches in the order they go in: each account's held events before its queued ones. */
  private queued(): Batch[] {
    const out: Batch[] = [];
    for (const [account, events] of this.held) if (events.length) out.push({ account, events: [...events] });
    for (const b of this.inbox) if (b.events.length) out.push({ account: b.account, events: [...b.events] });
    return out;
  }

  private pendingPath() {
    return join(this.opts.dataDir, PENDING_EVENTS);
  }

  /**
   * `batches` to PENDING_EVENTS, in place of what it held: a new file, fsynced, then renamed over it, so the file is
   * either the old one or the whole new one. Private to the hub's user (it holds messages). False, said loudly, if it
   * could not be written: those events are then lost.
   */
  private savePending(batches: Batch[]): boolean {
    const p = this.pendingPath();
    const tmp = `${p}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        for (const b of batches) writeSync(fd, `${JSON.stringify(b)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, p);
      this.pendingOnDisk = true;
      return true;
    } catch (e) {
      rmSync(tmp, { force: true });
      console.error(`adapter events: LOST ${summary(batches)}: they could not be saved to ${PENDING_EVENTS}:`, e);
      reportError({ source: 'job', where: 'adapter events', name: 'EventsLost', message: `adapter events lost: they could not be saved for the next start (${(e as Error)?.message ?? e})`, extra: { events: count(batches), accounts: new Set(batches.map((b) => b.account)).size } });
      return false;
    }
  }

  /** Once nothing is queued or held, PENDING_EVENTS holds nothing that is not in the database: it goes. */
  private tidyPending() {
    if (!this.pendingOnDisk || this.backlog) return;
    rmSync(this.pendingPath(), { force: true });
    this.pendingOnDisk = false;
  }

  /**
   * Everything queued and held, applied straight through on this thread until `untilMs` (on `now`'s clock), held ones
   * tried again up to SETTLE_TRIES times. How many events went through (a failed one, logged, counts too).
   */
  private drainNow(untilMs: number, now: () => number): number {
    const before = this.backlog;
    let tries = 0;
    while (now() < untilMs) {
      if (this.inbox.length) {
        this.step();
        continue;
      }
      if (!this.held.size || ++tries > SETTLE_TRIES) break;
      this.requeueHeld();
    }
    return before - this.backlog;
  }

  /**
   * At a stop (main.ts), once nothing new can come (adapters stopped, the manager's client closed): what is queued and
   * held goes in now, straight through, until `untilMs`. What is left (time ran out, the database stayed locked) is
   * written to PENDING_EVENTS, for the next start to apply first (`resume`). Said in the log, with counts, either way.
   */
  settle(untilMs: number, now: () => number = Date.now): { applied: number; carried: number; lost: number } {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    const queued = this.backlog;
    let applied = 0;
    try {
      applied = this.drainNow(untilMs, now);
    } catch (e) {
      // drainNow does not throw (applyNow holds what fails); if it did, what is left is still saved below.
      console.error('adapter events: applying what was queued at the stop failed', e);
      jobFailed('adapter events: stop', e);
    }
    const left = this.queued();
    if (!left.length) {
      if (queued) console.log(`adapter events: applied the ${applied} queued at the stop`);
      this.tidyPending();
      return { applied, carried: 0, lost: 0 };
    }
    const saved = this.savePending(left);
    if (saved) console.warn(`adapter events: applied ${applied} at the stop; ${summary(left)} for ${new Set(left.map((b) => b.account)).size} accounts carried over to the next start in ${PENDING_EVENTS}`);
    return { applied, carried: saved ? count(left) : 0, lost: saved ? 0 : count(left) };
  }

  /**
   * At a start, before any adapter or the manager can send anything: the events the last run carried over
   * (PENDING_EVENTS) are applied first, straight through until `untilMs`, then the file goes. What is still left
   * (the database is locked) stays queued and held in front of anything newer for the same account, and stays in the
   * file until it is in. How many events the file had.
   */
  resume(untilMs = Date.now() + 30_000, now: () => number = Date.now): number {
    const p = this.pendingPath();
    if (!existsSync(p)) return 0;
    const batches: Batch[] = [];
    let bad = 0;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const b = JSON.parse(line) as Batch;
        if (typeof b.account !== 'string' || !Array.isArray(b.events)) throw new Error('not a batch');
        batches.push({ account: b.account, events: b.events });
      } catch {
        bad++;
      }
    }
    if (bad) {
      // Kept beside it as it was, for a person to look at: the rest is applied.
      const aside = `${p}.unreadable-${Date.now()}`;
      renameSync(p, aside);
      console.error(`adapter events: ${bad} lines of ${PENDING_EVENTS} could not be read: NOT applied, kept in ${aside}`);
      reportError({ source: 'job', where: 'adapter events', name: 'EventsLost', message: `carried-over adapter events could not be read: ${bad} lines not applied`, extra: { lines: bad } });
    }
    // Nothing is queued yet at a start; were it, the carried-over events still go first.
    this.inbox.unshift(...batches);
    this.pendingOnDisk = true;
    const n = count(batches);
    console.log(`adapter events: applying ${summary(batches)} carried over from the last run`);
    const applied = this.drainNow(untilMs, now);
    const left = this.queued();
    if (!left.length) {
      this.tidyPending();
      console.log(`adapter events: the ${applied} carried over are in`);
      return n;
    }
    this.savePending(left);
    console.warn(`adapter events: ${applied} carried over are in; ${summary(left)} still wait, in front of anything newer for their accounts`);
    if (this.inbox.length) this.work();
    if (this.held.size) {
      this.heldTimer ??= setTimeout(() => this.retryHeld(), HELD_RETRY_MS);
      (this.heldTimer as { unref?: () => void }).unref?.();
    }
    return n;
  }

  /** One event. `held`: the database could not take it for now (locked, disk full) and nothing of it was applied. */
  protected handle(accountId: string, ev: P.AdapterEvent): { held: string } | void {
    // A barrier (`settled`): passed once its transaction commits, in applyNow.
    if ((ev as { t: string }).t === BARRIER) return;
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
    if (ev.t === 'gap') {
      this.tell((w) => w.gap(accountId, ev));
      return;
    }
    const acc = this.store.account(accountId);
    if (!acc) return;
    let fresh: string[];
    try {
      // One transaction: on a throw, nothing of the event is in.
      fresh = this.store.ingest(acc, ev);
    } catch (e) {
      const held = heldFor(e);
      if (held) return { held };
      console.error(`[${accountId}] ingest ${ev.t} failed:`, e);
      jobFailed('ingest', e, { account: accountId, event: ev.t });
      this.tell((w) => w.lost(accountId, [ev], String((e as Error)?.message ?? e).slice(0, 200)));
      return;
    }
    if (ev.t === 'conversation') this.tell((w) => w.conversation(accountId, ev.conversation));
    try {
      if (fresh.length) this.opts.onFresh(fresh);
    } catch (e) {
      console.error(`[${accountId}] triage of ${fresh.length} new messages could not start:`, e);
      jobFailed('triage: start', e, { account: accountId });
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
    return span(`command ${cmd.t}`, { account: accountId, op: cmd.t, via: r?.inproc ? 'in-process' : 'socket' }, () => new Promise<T>((resolve, reject) => {
      if (!r?.ws && !r?.inproc) return reject(new Error('adapter is not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`adapter timed out on ${cmd.t}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (r.inproc) queueMicrotask(() => r.inproc!.command(full));
      else r.ws!.send(JSON.stringify(full));
    }));
  }
}
