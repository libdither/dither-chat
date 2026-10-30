/**
 * Runs one adapter per enabled account and routes commands to it.
 *
 * Out-of-process adapters (matrix, signal, discord) are spawned as
 * `bun packages/adapter-<kind>/src/main.ts` and connect back over the
 * /adapter WebSocket. In-process adapters (the demo) use the same
 * event/command types through a direct callback.
 */

import type { ServerWebSocket, Subprocess } from 'bun';
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { AccountRow, Store } from './store.ts';

export interface InprocAdapter {
  start(emit: (ev: P.AdapterEvent) => void): void;
  command(cmd: P.AdapterCommand): void;
  stop(): void;
}

export type InprocFactory = (acc: AccountRow, dir: string) => InprocAdapter | null;

export interface AdapterSocketData {
  kind: 'adapter';
  accountId: string;
}

interface Running {
  proc?: Subprocess;
  inproc?: InprocAdapter;
  ws?: ServerWebSocket<AdapterSocketData>;
  restarts: number;
  stopping: boolean;
  lastStart: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer };

const BACKOFF = [1, 2, 5, 10, 30, 60];

export class Supervisor {
  private running = new Map<string, Running>();
  private pending = new Map<string, Pending>();

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
    const p = join(this.accountDir(id), 'secret.json');
    writeFileSync(p, JSON.stringify(secret ?? {}, null, 2), { mode: 0o600 });
    chmodSync(p, 0o600);
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
    r.stopping = false;
    r.lastStart = Date.now();
    this.running.set(id, r);
    const dir = this.accountDir(id);

    const inproc = this.opts.inproc(acc, dir);
    if (inproc) {
      r.inproc = inproc;
      inproc.start((ev) => this.handle(id, ev));
      return;
    }

    const entry = join(this.opts.repoRoot, 'packages', `adapter-${acc.adapter}`, 'src', 'main.ts');
    if (!existsSync(entry)) {
      this.store.updateAccount(id, {
        status: 'error',
        attention: JSON.stringify({ kind: 'unknown', message: `No adapter installed for "${acc.adapter}"`, since: Date.now() }),
      });
      return;
    }
    this.store.updateAccount(id, { status: 'connecting' });
    const log = join(dir, 'adapter.log');
    appendFileSync(log, `\n--- ${new Date().toISOString()} starting ${acc.adapter} adapter\n`);
    const proc = Bun.spawn(['bun', entry], {
      cwd: this.opts.repoRoot,
      env: {
        ...process.env,
        DITHER_HUB_URL: this.opts.hubAdapterUrl,
        DITHER_ACCOUNT_ID: id,
        DITHER_ADAPTER_TOKEN: acc.token,
        DITHER_ACCOUNT_DIR: dir,
        DITHER_ACCOUNT_CONFIG: acc.config,
        DITHER_ACCOUNT_LABEL: acc.label,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_p, code, signal) => this.exited(id, code, signal),
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

  private exited(id: string, code: number | null, signal: unknown) {
    const r = this.running.get(id);
    if (!r) return;
    r.proc = undefined;
    appendFileSync(join(this.accountDir(id), 'adapter.log'), `--- exited code=${code} signal=${signal}\n`);
    if (r.stopping) return;
    const acc = this.store.account(id);
    if (!acc?.enabled) return;
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
    this.handle(ws.data.accountId, ev);
  }

  private handle(accountId: string, ev: P.AdapterEvent) {
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
    const acc = this.store.account(accountId);
    if (!acc) return;
    try {
      const fresh = this.store.ingest(acc, ev);
      if (fresh.length) this.opts.onFresh(fresh);
    } catch (e) {
      console.error(`[${accountId}] ingest ${ev.t} failed:`, e);
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
