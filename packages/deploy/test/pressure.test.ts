/**
 * The pressure watch (packages/deploy/src/pressure.ts, docs/deploy.md "Keeping the hub fed"): when a condition starts,
 * lasts and ends, and what its notice says. Readings are made up; nothing here reads the machine.
 */
import { expect, test } from 'bun:test';
import { AGAIN_MS, biggest, type Condition, EVERY_MS, HOLD_MS, level, noticeOf, parsePsi, type Pressures, type Psi, type Sample, Tracker, unitOf } from '../src/pressure.ts';

const psi = (some60 = 0, full60 = 0): Psi => ({ some10: some60, some60, full10: full60, full60 });
const calm = (): Pressures => ({ memory: psi(), io: psi(), cpu: psi() });
const at = (t: number, over: Partial<{ memory: Psi; hubIo: Psi; hub: Pressures | null }> = {}): Sample => ({
  at: t,
  machine: { ...calm(), ...(over.memory ? { memory: over.memory } : {}) },
  units: { 'dither-chat.service': over.hub !== undefined ? over.hub : { ...calm(), ...(over.hubIo ? { io: over.hubIo } : {}) } },
  availableMb: 7 * 1024,
  totalMb: 46 * 1024,
  swapUsedMb: 21 * 1024,
  swapTotalMb: 23 * 1024,
});
const C: Condition[] = ['memory', 'wait:dither-chat.service'];

test('a pressure file: the shares of the last 10 s and minute, some and full', () => {
  expect(parsePsi('some avg10=34.93 avg60=22.81 avg300=6.87 total=23834974\nfull avg10=4.06 avg60=1.45 avg300=1.89 total=12730273987\n')).toEqual({ some10: 34.93, some60: 22.81, full10: 4.06, full60: 1.45 });
  // The machine's cpu.pressure has a full line of zeros on newer kernels, none on older ones.
  expect(parsePsi('some avg10=50.60 avg60=37.23 avg300=23.81 total=171401474536\n')).toEqual({ some10: 50.6, some60: 37.23, full10: 0, full60: 0 });
});

test('levels: over a threshold is on, under half of every one is off, and between keeps what was', () => {
  expect(level('memory', at(0, { memory: psi(15, 0) }))).toBe('on');
  expect(level('memory', at(0, { memory: psi(0, 3) }))).toBe('on');
  expect(level('memory', at(0, { memory: psi(8, 0) }))).toBe('between');
  expect(level('memory', at(0, { memory: psi(7, 1) }))).toBe('off');
  // The hub's own waits: on the disk (2026-11-25: 23% of the minute) or memory, or for a CPU.
  expect(level('wait:dither-chat.service', at(0, { hubIo: psi(23) }))).toBe('on');
  expect(level('wait:dither-chat.service', at(0, { hubIo: psi(12) }))).toBe('between');
  expect(level('wait:dither-chat.service', at(0, { hubIo: psi(9) }))).toBe('off');
  expect(level('wait:dither-chat.service', at(0, { hub: { ...calm(), cpu: psi(40) } }))).toBe('on');
  // A unit that is not running has nothing to wait on.
  expect(level('wait:dither-chat.service', at(0, { hub: null }))).toBe('off');
});

test('a condition is told once it held for HOLD_MS, again every AGAIN_MS, and once when it ends', () => {
  const t = new Tracker();
  const says: string[] = [];
  const run = (from: number, to: number, over: Parameters<typeof at>[1]) => {
    for (let ms = from; ms <= to; ms += EVERY_MS) for (const s of t.observe(at(ms, over), C)) says.push(`${ms / 1000}s ${s.c} ${s.what} ${s.sinceMs / 1000}s`);
  };
  // A minute's burst, then calm: nothing.
  run(0, 60_000, { memory: psi(20) });
  run(70_000, 100_000, {});
  // Over the threshold, dipping between before HOLD_MS: the count starts again.
  run(110_000, 170_000, { memory: psi(20) });
  run(180_000, 180_000, { memory: psi(10) });
  run(190_000, 190_000 + HOLD_MS, { memory: psi(20) });
  expect(says).toEqual([`${(190_000 + HOLD_MS) / 1000}s memory started ${HOLD_MS / 1000}s`]);
  says.length = 0;
  // Once told, readings in between keep it; after AGAIN_MS it is told again; under half ends it.
  const told = 190_000 + HOLD_MS;
  run(told + EVERY_MS, told + AGAIN_MS, { memory: psi(10) });
  run(told + AGAIN_MS + EVERY_MS, told + AGAIN_MS + EVERY_MS, { memory: psi(2) });
  expect(says).toEqual([`${(told + AGAIN_MS) / 1000}s memory still ${(AGAIN_MS + HOLD_MS) / 1000}s`, `${(told + AGAIN_MS + EVERY_MS) / 1000}s memory ended ${(AGAIN_MS + HOLD_MS + EVERY_MS) / 1000}s`]);
});

test('the machine and the hub are told apart', () => {
  const t = new Tracker();
  const out: string[] = [];
  for (let ms = 0; ms <= HOLD_MS; ms += EVERY_MS) for (const s of t.observe(at(ms, { hubIo: psi(30) }), C)) out.push(`${s.c} ${s.what}`);
  expect(out).toEqual(['wait:dither-chat.service started']);
});

test('the biggest memory users, by unit, with their biggest process', () => {
  expect(unitOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-agents.slice/agent-1a2b.scope\n')).toBe('agent-1a2b.scope');
  expect(unitOf('0::/\n')).toBe('the kernel');
  const procs = [
    ...Array.from({ length: 6 }, () => ({ unit: 'agent-1a2b.scope', name: 'ssimulacra2', rssKb: 1500 * 1024, swapKb: 0 })),
    { unit: 'agent-1a2b.scope', name: 'python', rssKb: 200 * 1024, swapKb: 0 },
    { unit: 'lab-emulator.service', name: 'qemu-system-x86', rssKb: 300 * 1024, swapKb: 4300 * 1024 },
    { unit: 'dither-chat.service', name: 'bun', rssKb: 1000 * 1024, swapKb: 30 * 1024 },
  ];
  expect(biggest(procs, 2)).toEqual([
    { unit: 'agent-1a2b.scope', mb: 9200, top: 'ssimulacra2', count: 6 },
    { unit: 'lab-emulator.service', mb: 4600, top: 'qemu-system-x86', count: 1 },
  ]);
});

test('what the notices say', () => {
  const s = at(0, { memory: psi(9.46, 1.45), hubIo: psi(22.81) });
  const big = [{ unit: 'agent-1a2b.scope', mb: 9200, top: 'ssimulacra2', count: 6 }];
  const hub = noticeOf({ c: 'wait:dither-chat.service', what: 'started', sinceMs: HOLD_MS }, s, big);
  expect(hub).toEqual({
    id: 'wait-dither-chat.service',
    title: 'The hub is held up by this machine',
    body: 'The hub waited on the disk 23% of the last minute, on memory 0%, for a CPU 0%.\nThis machine waited on memory 9% of the last minute (1% with everything stalled), on the disk 0%, for a CPU 0%. 7.0 GB of 46.0 GB free, swap 21.0 GB of 23.0 GB used.\nBiggest: agent-1a2b.scope 9.0 GB (ssimulacra2 ×6)',
    urgency: 'high',
  });
  expect(noticeOf({ c: 'memory', what: 'still', sinceMs: 75 * 60_000 }, s, big).title).toBe('This machine is short of memory for 75 min');
  const ended = noticeOf({ c: 'memory', what: 'ended', sinceMs: 14 * 60_000 }, s, []);
  expect([ended.id, ended.title, ended.urgency]).toEqual(['memory', 'Memory is fine again (was short for 14 min)', 'low']);
});
