/**
 * Measures what a call costs, in each mode, on the device and on the hub's machine.
 *
 *   bun scripts/measure-call.ts <hub url> <conversation id> <account id> <data dir> [seconds] [wav] [bridge,direct]
 *
 * For each mode: an idle stretch first (the account's sandbox runs either way), then a call of the
 * same length from a headless Chromium with a fake microphone. It reads /proc for CPU time and
 * proportional memory (PSS) of each group of processes, and the device's WebRTC stats for bytes.
 *
 * Groups:
 *   device   the test browser (stands in for the phone)
 *   sandbox  the account's Chromium, Xvfb and x11vnc
 *   hub      the hub (with its voice-socket forwarding)
 *   adapter  the account's adapter process
 *   turn     coturn
 *
 * Everything runs on one machine, so the absolute numbers are this machine's; the comparison is the point.
 * Join only a voice channel the test account owns.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { launch } from './browser.ts';

const [base, conv, accountId, dataDir, secs = '30', wav, modesArg = 'bridge,direct'] = process.argv.slice(2);
if (!base || !conv || !accountId || !dataDir) throw new Error('usage: bun scripts/measure-call.ts <hub url> <conversation id> <account id> <data dir> [seconds] [wav] [modes]');
const seconds = Number(secs);
const TICK = 100; // USER_HZ

type Proc = { pid: number; cmd: string; ppid: number };
function procs(): Proc[] {
  const out: Proc[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      out.push({ pid: Number(d), cmd, ppid });
    } catch {}
  }
  return out;
}
function cpuTicks(pid: number): number {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]); // utime + stime
  } catch {
    return 0;
  }
}
function pssKb(pid: number): number {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
/** A process and everything under it. */
function tree(all: Proc[], roots: number[]): number[] {
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (!out.has(p.pid) && out.has(p.ppid)) (out.add(p.pid), (grew = true));
  }
  return [...out];
}

function groups(deviceDir: string | null): Record<string, number[]> {
  const all = procs();
  const find = (re: RegExp) => all.filter((p) => re.test(p.cmd)).map((p) => p.pid);
  const root = (pids: number[]) => pids.filter((pid) => !all.find((p) => p.pid === pid)?.cmd.includes('--type='));
  // The adapter starts Xvfb, Chromium and x11vnc itself, so the sandbox is everything under it.
  const adapter = find(/adapter-discord\/src\/main\.ts/).filter((pid) => readEnv(pid).includes(accountId));
  return {
    device: deviceDir ? tree(all, root(find(new RegExp(deviceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))))) : [],
    sandbox: tree(all, adapter).filter((pid) => !adapter.includes(pid)),
    hub: find(/hub\/src\/main\.ts/).filter((pid) => readEnv(pid).includes(dataDir)),
    adapter,
    turn: find(/turnserver/),
  };
}
function readEnv(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8') + readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return '';
  }
}

type Sample = Record<string, { cpu: number; pss: number; n: number }>;
function sample(g: Record<string, number[]>): Sample {
  const out: Sample = {};
  for (const [k, pids] of Object.entries(g)) out[k] = { cpu: pids.reduce((a, p) => a + cpuTicks(p), 0), pss: pids.reduce((a, p) => a + pssKb(p), 0), n: pids.length };
  return out;
}
/** CPU as % of one core over the window, and mean PSS in MB. */
function diff(a: Sample, b: Sample, ms: number, pssAvg: Record<string, number>) {
  const out: Record<string, { cpuPct: number; pssMB: number; procs: number }> = {};
  for (const k of Object.keys(b)) out[k] = { cpuPct: Math.round(((b[k]!.cpu - (a[k]?.cpu ?? 0)) / TICK / (ms / 1000)) * 1000) / 10, pssMB: Math.round((pssAvg[k] ?? 0) / 102.4) / 10, procs: b[k]!.n };
  return out;
}

async function hold(deviceDir: string | null, ms: number) {
  const g0 = groups(deviceDir);
  const a = sample(g0);
  const t0 = Date.now();
  const pss: Record<string, number[]> = {};
  while (Date.now() - t0 < ms) {
    await Bun.sleep(Math.min(5000, ms - (Date.now() - t0)));
    const g = groups(deviceDir);
    for (const [k, v] of Object.entries(sample(g))) (pss[k] ??= []).push(v.pss);
  }
  const g1 = groups(deviceDir);
  // Processes that started during the window count from zero.
  const b = sample(g1);
  const avg = Object.fromEntries(Object.entries(pss).map(([k, v]) => [k, v.reduce((x, y) => x + y, 0) / v.length]));
  return diff(a, b, Date.now() - t0, avg);
}

const results: Record<string, unknown> = {};
for (const mode of modesArg.split(',')) {
  const { page, close, profileDir } = await launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : [])],
  });
  try {
    await page.goto(base);
    await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: ${JSON.stringify(mode)} }))`);
    await page.goto(`${base.replace(/\/$/, '')}/?mode=${mode}#/inbox/c/${conv}`); // a new query string reloads, so the saved mode applies
    await page.until(`!!document.querySelector('.call-join')`, 30_000);
    await Bun.sleep(3000);
    const idle = await hold(profileDir, seconds * 1000);
    await page.eval(`document.querySelector('.call-join').click()`);
    const t0 = Date.now();
    await page.until(`document.querySelector('[data-call-phase]')?.dataset.callPhase !== 'connecting'`, 60_000);
    const phase = await page.eval<string>(`document.querySelector('[data-call-phase]')?.dataset.callPhase`);
    const joinMs = Date.now() - t0;
    if (phase !== 'live') {
      results[mode] = { error: await page.eval(`document.querySelector('.call-dock-text small')?.textContent`) };
      continue;
    }
    await Bun.sleep(3000); // let the connections settle
    const before = await page.eval<string | undefined>(`document.querySelector('[data-call-stats]')?.dataset.callStats`);
    const inCall = await hold(profileDir, seconds * 1000);
    const after = await page.eval<string | undefined>(`document.querySelector('[data-call-stats]')?.dataset.callStats`);
    const hubCalls = await fetch(`${base.replace(/\/$/, '')}/api/calls`).then((r) => r.json()).catch(() => []);
    await page.eval(`document.querySelector('.call-btn.leave').click()`);
    await Bun.sleep(2000);
    const s0 = before ? JSON.parse(before) : null;
    const s1 = after ? JSON.parse(after) : null;
    results[mode] = {
      joinMs,
      idle,
      inCall,
      overhead: Object.fromEntries(Object.keys(inCall).map((k) => [k, { cpuPct: Math.round((inCall[k]!.cpuPct - (idle[k]?.cpuPct ?? 0)) * 10) / 10, pssMB: Math.round((inCall[k]!.pssMB - (idle[k]?.pssMB ?? 0)) * 10) / 10 }])),
      deviceMedia: s0 && s1 ? { kbpsUp: Math.round(((s1.sent - s0.sent) * 8) / seconds / 100) / 10, kbpsDown: Math.round(((s1.received - s0.received) * 8) / seconds / 100) / 10, path: s1.path, rttMs: s1.rttMs, codec: s1.codec } : null,
      hubSocket: hubCalls,
    };
  } finally {
    await close();
  }
  console.log(mode, JSON.stringify(results[mode], null, 1));
}
console.log(JSON.stringify(results));
