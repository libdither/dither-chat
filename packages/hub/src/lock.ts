/**
 * One process per account's session, whoever supervises it. The hub and dither-accounts' manager both take
 * `<account dir>/extractor.lock` ({ pid, owner, at }) before they start an adapter, and both refuse while any live
 * process already runs the account (DITHER_ACCOUNT_ID=<id> in its environment), so an account moved to the manager
 * cannot also be started here, and the other way round. Two Signal or WhatsApp sessions on one store corrupt it.
 * The same rules as dither-accounts' packages/manager/src/supervisor.ts.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK = 'extractor.lock';

/** Live processes, other than this one and `except`, that run this account. */
export function accountProcesses(accountId: string, except: number[] = []): number[] {
  const out: number[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const needle = `DITHER_ACCOUNT_ID=${accountId}`;
  for (const d of pids) {
    const pid = Number(d);
    if (pid === process.pid || except.includes(pid)) continue;
    try {
      // The adapter itself (bun …/src/main.ts), not what it started (Chromium, signal-cli, the WhatsApp bridge
      // inherit its environment, and may outlive it for a moment).
      if (!readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(needle)) continue;
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a.endsWith('/src/main.ts'))) out.push(pid);
    } catch {}
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Take the lock, or say who runs the account. A lock whose process is gone is stale and taken over. */
export function acquireLock(dir: string, owner: string, accountId: string): string | null {
  const running = accountProcesses(accountId);
  if (running.length) return `pid ${running.join(', ')} already runs this account`;
  const p = join(dir, LOCK);
  if (existsSync(p)) {
    try {
      const l = JSON.parse(readFileSync(p, 'utf8')) as { pid: number; owner: string };
      if (l.pid !== process.pid && alive(l.pid)) return `${l.owner} (pid ${l.pid}) runs this account`;
    } catch {}
  }
  writeFileSync(p, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() }), { mode: 0o600 });
  return null;
}

export function releaseLock(dir: string) {
  const p = join(dir, LOCK);
  try {
    if (JSON.parse(readFileSync(p, 'utf8')).pid === process.pid) unlinkSync(p);
  } catch {}
}
