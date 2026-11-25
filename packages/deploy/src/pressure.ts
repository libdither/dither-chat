/**
 * The pressure watch (docs/deploy.md, "Keeping the hub fed"): tells you, through the manager's notices like the
 * deployer, when this machine runs short of memory or when the hub is held up waiting on it, and names what is taking
 * the memory. An agent's batch job can fill memory and swap until the hub's every database write waits seconds on the
 * disk (2026-11-25: holds of 25 and 37 s, pages taking 17 s); by the time the hub's own log shows it, you are already
 * waiting on your phone.
 *
 * It runs as its own small unit, outside the hub, so it still speaks when the hub is the one held up. Every 10 s it
 * reads Linux's pressure stall information (PSI): /proc/pressure/{memory,io,cpu} for the machine, and the same files
 * in each watched unit's cgroup. `avg60` is the share of the last minute that tasks waited on that resource (`some`:
 * at least one; `full`: all of them at once).
 *
 * - **Memory** (the machine): memory `full` avg60 of FULL_ON% or more, or `some` of SOME_ON% or more, held HOLD_MS.
 * - **Waiting** (each watched unit): its threads waited on the disk or on memory UNIT_ON% of the last minute, or for a
 *   CPU UNIT_CPU_ON%, held HOLD_MS.
 * A condition ends when every figure it went on falls under half of its threshold. Each says so once when it starts
 * (with the biggest memory users, by systemd unit), again every AGAIN_MS while it lasts, and once more, quietly, when
 * it ends; each time under the same notice id, so the manager keeps one notice per condition.
 *
 *   bun packages/deploy/src/pressure.ts            # watch (what the unit runs)
 *   bun packages/deploy/src/pressure.ts --once     # one reading: the figures and the biggest users, no notice
 *   bun packages/deploy/src/pressure.ts --dry      # watch, logging the notices instead of sending them
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EVERY_MS = 10_000;
export const HOLD_MS = 2 * 60_000;
export const AGAIN_MS = 60 * 60_000;
export const FULL_ON = 3;
export const SOME_ON = 15;
export const UNIT_ON = 20;
export const UNIT_CPU_ON = 40;

/** One pressure file: the shares (percent) of the last 10 s and minute. `full` is 0 where the file has none (cpu). */
export interface Psi {
  some10: number;
  some60: number;
  full10: number;
  full60: number;
}
export interface Pressures {
  memory: Psi;
  io: Psi;
  cpu: Psi;
}

export function parsePsi(text: string): Psi {
  const line = (kind: 'some' | 'full', avg: 'avg10' | 'avg60') => {
    const m = new RegExp(`^${kind} .*\\b${avg}=([\\d.]+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { some10: line('some', 'avg10'), some60: line('some', 'avg60'), full10: line('full', 'avg10'), full60: line('full', 'avg60') };
}

/** A reading of the machine and of each watched unit (null: not running, or no PSI in its cgroup). */
export interface Sample {
  at: number;
  machine: Pressures;
  units: Record<string, Pressures | null>;
  /** From /proc/meminfo, in MB. */
  availableMb: number;
  totalMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
}

export type Condition = 'memory' | `wait:${string}`;

/** Whether a condition is over its threshold (`on`), under half of every threshold (`off`), or in between. */
export function level(c: Condition, s: Sample): 'on' | 'off' | 'between' {
  if (c === 'memory') {
    const m = s.machine.memory;
    if (m.full60 >= FULL_ON || m.some60 >= SOME_ON) return 'on';
    return m.full60 < FULL_ON / 2 && m.some60 < SOME_ON / 2 ? 'off' : 'between';
  }
  const p = s.units[c.slice(5)];
  if (!p) return 'off';
  const waited = Math.max(p.io.some60, p.memory.some60);
  if (waited >= UNIT_ON || p.cpu.some60 >= UNIT_CPU_ON) return 'on';
  return waited < UNIT_ON / 2 && p.cpu.some60 < UNIT_CPU_ON / 2 ? 'off' : 'between';
}

export type Say = { c: Condition; what: 'started' | 'still' | 'ended'; sinceMs: number };

/**
 * The conditions over time: each `observe` says which to announce. A condition must be over its threshold at every
 * reading for HOLD_MS before it starts (a short burst says nothing); once started, readings in between keep it, and
 * it ends at the first reading under half.
 */
export class Tracker {
  /** When each condition went over its threshold, and when it was last announced (0: not yet). */
  private over = new Map<Condition, { since: number; told: number }>();

  observe(s: Sample, conditions: Condition[]): Say[] {
    const out: Say[] = [];
    for (const c of conditions) {
      const l = level(c, s);
      const o = this.over.get(c);
      if (!o) {
        if (l === 'on') this.over.set(c, { since: s.at, told: 0 });
        continue;
      }
      if (!o.told) {
        // Not yet announced: it has to stay over its threshold the whole time.
        if (l !== 'on') this.over.delete(c);
        else if (s.at - o.since >= HOLD_MS) {
          o.told = s.at;
          out.push({ c, what: 'started', sinceMs: s.at - o.since });
        }
        continue;
      }
      if (l === 'off') {
        this.over.delete(c);
        out.push({ c, what: 'ended', sinceMs: s.at - o.since });
      } else if (s.at - o.told >= AGAIN_MS) {
        o.told = s.at;
        out.push({ c, what: 'still', sinceMs: s.at - o.since });
      }
    }
    return out;
  }
}

/** One process's memory, from /proc/<pid>/status and /proc/<pid>/cgroup. */
export interface Proc {
  unit: string;
  name: string;
  rssKb: number;
  swapKb: number;
}

/** The systemd unit a process runs in: the last part of its cgroup v2 path (`agent-1a2b.scope`). */
export function unitOf(cgroup: string): string {
  const m = /^0::(\/.*)$/m.exec(cgroup);
  const parts = (m?.[1] ?? '/').split('/').filter(Boolean);
  return parts.at(-1) ?? 'the kernel';
}

/** The units holding the most memory (resident and swapped out), each with its biggest process's name and count. */
export function biggest(procs: Proc[], n = 5): { unit: string; mb: number; top: string; count: number }[] {
  const by = new Map<string, { kb: number; names: Map<string, number>; count: Map<string, number> }>();
  for (const p of procs) {
    const u = by.get(p.unit) ?? { kb: 0, names: new Map(), count: new Map() };
    const kb = p.rssKb + p.swapKb;
    u.kb += kb;
    u.names.set(p.name, (u.names.get(p.name) ?? 0) + kb);
    u.count.set(p.name, (u.count.get(p.name) ?? 0) + 1);
    by.set(p.unit, u);
  }
  return [...by]
    .map(([unit, u]) => {
      const top = [...u.names].sort((a, b) => b[1] - a[1])[0]![0];
      return { unit, mb: Math.round(u.kb / 1024), top, count: u.count.get(top)! };
    })
    .sort((a, b) => b.mb - a.mb)
    .slice(0, n);
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const pct = (x: number) => `${Math.round(x)}%`;
const mins = (ms: number) => (ms >= 90 * 60_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);
const NAMES: Record<string, string> = { 'dither-chat.service': 'The hub', 'dither-accounts.service': 'The accounts manager' };
export const named = (unit: string) => NAMES[unit] ?? unit;

/** What a notice says: the figures that matter, and who holds the memory. */
export function noticeOf(say: Say, s: Sample, big: ReturnType<typeof biggest>): { id: string; title: string; body: string; urgency: 'high' | 'normal' | 'low' } {
  const m = s.machine;
  const room = `${gb(s.availableMb)} of ${gb(s.totalMb)} free, swap ${gb(s.swapUsedMb)} of ${gb(s.swapTotalMb)} used.`;
  const machine = `This machine waited on memory ${pct(m.memory.some60)} of the last minute (${pct(m.memory.full60)} with everything stalled), on the disk ${pct(m.io.some60)}, for a CPU ${pct(m.cpu.some60)}.`;
  const users = big.length ? `Biggest: ${big.map((b) => `${b.unit} ${gb(b.mb)} (${b.top}${b.count > 1 ? ` ×${b.count}` : ''})`).join(' · ')}` : '';
  const id = say.c === 'memory' ? 'memory' : `wait-${say.c.slice(5)}`;
  if (say.what === 'ended') {
    const title = say.c === 'memory' ? `Memory is fine again (was short for ${mins(say.sinceMs)})` : `${named(say.c.slice(5))} is no longer held up (was for ${mins(say.sinceMs)})`;
    return { id, title, body: `${machine} ${room}`, urgency: 'low' };
  }
  const still = say.what === 'still' ? ` for ${mins(say.sinceMs)}` : '';
  if (say.c === 'memory') {
    return { id, title: `This machine is short of memory${still}`, body: [`${machine} ${room}`, users].filter(Boolean).join('\n'), urgency: 'normal' };
  }
  const unit = say.c.slice(5);
  const p = s.units[unit]!;
  const own = `${named(unit)} waited on the disk ${pct(p.io.some60)} of the last minute, on memory ${pct(p.memory.some60)}, for a CPU ${pct(p.cpu.some60)}.`;
  return { id, title: `${named(unit)} is held up by this machine${still}`, body: [own, `${machine} ${room}`, users].filter(Boolean).join('\n'), urgency: 'high' };
}

// ---------------------------------------------------------------- reading the machine

const read = (f: string) => readFileSync(f, 'utf8');

/** The three pressure files in `dir`: `memory.pressure` and the rest in a cgroup, `memory` and the rest in /proc/pressure. */
function pressuresIn(dir: string, suffix = '.pressure'): Pressures | null {
  try {
    return { memory: parsePsi(read(`${dir}/memory${suffix}`)), io: parsePsi(read(`${dir}/io${suffix}`)), cpu: parsePsi(read(`${dir}/cpu${suffix}`)) };
  } catch {
    return null;
  }
}

/** A user unit's cgroup folder, asked of systemd; null when it is not running. */
function cgroupOf(unit: string): string | null {
  const r = Bun.spawnSync(['systemctl', '--user', 'show', '-p', 'ControlGroup', '--value', unit]);
  const cg = r.stdout.toString().trim();
  return r.exitCode === 0 && cg ? `/sys/fs/cgroup${cg}` : null;
}

function sample(units: string[]): Sample {
  const info = read('/proc/meminfo');
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? 0);
  const out: Record<string, Pressures | null> = {};
  for (const u of units) {
    const dir = cgroupOf(u);
    out[u] = dir ? pressuresIn(dir) : null;
  }
  return {
    at: Date.now(),
    machine: pressuresIn('/proc/pressure', '')!,
    units: out,
    availableMb: Math.round(kb('MemAvailable') / 1024),
    totalMb: Math.round(kb('MemTotal') / 1024),
    swapUsedMb: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024),
    swapTotalMb: Math.round(kb('SwapTotal') / 1024),
  };
}

/** Every process's memory and unit (about a thousand small reads: only when there is something to say). */
function procs(): Proc[] {
  const out: Proc[] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const st = read(`/proc/${pid}/status`);
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(st)?.[1] ?? 0);
      const rssKb = kb('VmRSS');
      const swapKb = kb('VmSwap');
      if (!rssKb && !swapKb) continue;
      out.push({ unit: unitOf(read(`/proc/${pid}/cgroup`)), name: /^Name:\s+(.*)$/m.exec(st)?.[1] ?? pid, rssKb, swapKb });
    } catch {
      // Gone since the listing.
    }
  }
  return out;
}

// ---------------------------------------------------------------- running

const HOME = homedir();
const MANAGER = process.env.DITHER_DEPLOY_MANAGER ?? 'http://127.0.0.1:8486';
const MANAGER_DATA = process.env.DITHER_DEPLOY_MANAGER_DATA ?? join(HOME, '.local/share/dither-accounts');
/** The user units whose own waits are watched, comma-separated. */
const UNITS = (process.env.DITHER_PRESSURE_UNITS ?? 'dither-chat.service')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** Says it through the manager's notices (dither-accounts notices.ts `local`), as the deployer does. */
async function post(n: ReturnType<typeof noticeOf>) {
  try {
    const token = read(join(MANAGER_DATA, 'cli.token')).trim();
    const r = await fetch(`${MANAGER}/api/notices/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dither-accounts-cli': token },
      body: JSON.stringify({ id: n.id, source: 'pressure', title: n.title, body: n.body, urgency: n.urgency, context: 'this machine' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) log(`  the manager did not take the notice: ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    log(`  no notice: ${(e as Error).message}`);
  }
}

if (import.meta.main) {
  const conditions: Condition[] = ['memory', ...UNITS.map((u) => `wait:${u}` as const)];
  if (process.argv.includes('--once')) {
    const s = sample(UNITS);
    console.log(JSON.stringify(s, null, 1));
    for (const b of biggest(procs())) console.log(`${b.unit} ${gb(b.mb)} (${b.top}${b.count > 1 ? ` ×${b.count}` : ''})`);
    for (const c of conditions) console.log(`${c}: ${level(c, s)}`);
  } else {
    const dry = process.argv.includes('--dry');
    const tracker = new Tracker();
    log(`pressure: watching the machine and ${UNITS.join(', ')} every ${EVERY_MS / 1000} s`);
    const tick = async () => {
      try {
        const s = sample(UNITS);
        const says = tracker.observe(s, conditions);
        if (!says.length) return;
        const big = says.some((x) => x.what !== 'ended') ? biggest(procs()) : [];
        for (const say of says) {
          const n = noticeOf(say, s, big);
          log(`notice ${n.urgency}: ${n.title} | ${n.body.replace(/\n/g, ' | ')}`);
          if (!dry) await post(n);
        }
      } catch (e) {
        log(`pressure: reading failed: ${(e as Error).message}`);
      }
    };
    setInterval(() => void tick(), EVERY_MS);
    void tick();
  }
}
