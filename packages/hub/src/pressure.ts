/**
 * What the hub's own processes waited on (docs/tracing.md, "The stall record"): Linux's pressure stall information
 * (PSI) for the hub's cgroup, `memory.pressure`, `io.pressure` and `cpu.pressure` beside it under /sys/fs/cgroup. Each
 * file's `some` line counts, in µs since the cgroup began, the time at least one of its threads was stalled on that
 * resource. Two reads around a hold of the event loop say how much of the hold was spent waiting on the disk, on
 * memory being reclaimed or paged back in, or for a CPU, and so whether the hub held itself or the machine held it.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Time, in ms since the cgroup began, that at least one of the hub's threads waited on each. */
export interface Waits {
  memoryMs: number;
  ioMs: number;
  cpuMs: number;
}

/** The `total=` of a pressure file's `some` line, in µs; null when there is none. */
export function someTotal(text: string): number | null {
  const m = /^some .*\btotal=(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** The cgroup v2 folder this process runs in, from /proc/self/cgroup's `0::/path`; null off Linux or without PSI. */
export function ownCgroup(read: (f: string) => string = (f) => readFileSync(f, 'utf8'), exists: (f: string) => boolean = existsSync): string | null {
  try {
    const m = /^0::(\/.*)$/m.exec(read('/proc/self/cgroup'));
    if (!m) return null;
    const dir = `/sys/fs/cgroup${m[1] === '/' ? '' : m[1]}`;
    return exists(`${dir}/io.pressure`) ? dir : null;
  } catch {
    return null;
  }
}

/** A reader of the waits of the cgroup in `dir` (three small reads, a few µs each); null when it has no PSI. */
export function waitsOf(dir: string | null, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): (() => Waits | null) | null {
  if (!dir) return null;
  const one = (what: string) => {
    const us = someTotal(read(`${dir}/${what}.pressure`));
    if (us === null) throw new Error(`no ${what} pressure`);
    return us / 1000;
  };
  return () => {
    try {
      return { memoryMs: one('memory'), ioMs: one('io'), cpuMs: one('cpu') };
    } catch {
      return null;
    }
  };
}

/** The share of `heldMs` spent waiting on each, from two reads: `disk 35%, memory 0%, CPU 2%`. */
export function waitShares(was: Waits, now: Waits, heldMs: number): { disk: number; memory: number; cpu: number } {
  const pct = (a: number, b: number) => (heldMs > 0 ? Math.min(100, Math.max(0, Math.round(((b - a) / heldMs) * 100))) : 0);
  return { disk: pct(was.ioMs, now.ioMs), memory: pct(was.memoryMs, now.memoryMs), cpu: pct(was.cpuMs, now.cpuMs) };
}
