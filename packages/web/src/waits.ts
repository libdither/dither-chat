/**
 * What opening a chat is waiting on, step by step, for the thin bar over the message box (ui/OpenBar.tsx, docs/sync.md
 * "Opening a chat"): reaching the hub, the hub's page (or what changed since the copy kept here), then the network's
 * latest (Discord and the like keep no copy the hub can trust, so it asks). What is kept shows the whole time; the bar
 * says what is still coming, and once a step is slow, whose step it is.
 *
 * Each step's usual time is the middle of its last few, kept on this device, by network for the network's step: the
 * bar gives each step its share by it, and a step well past it is called slow.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { signal } from '@preact/signals';

export type WaitStep = 'link' | 'hub' | 'network';

export interface Wait {
  /** The step under way. */
  step: WaitStep;
  /** The network the network step asks. */
  network?: P.Network;
  /** When this step began. */
  at: number;
  /** When the open began. */
  began: number;
  /** Every step this open is expected to take, in order, the one under way among them. */
  steps: WaitStep[];
}

/** Opens under way, by timeline key. */
export const waits = signal<ReadonlyMap<string, Wait>>(new Map());

const STORE = 'dither-chat:wait-times';
const KEEP = 15;
/** Before a device has its own: about what the slow-link probe saw at full phone speed. */
const DEFAULT_MS: Record<string, number> = { link: 500, hub: 300, network: 400 };

let times: Record<string, number[]> | null = null;
const load = (): Record<string, number[]> => {
  if (times) return times;
  try {
    times = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, number[]>;
  } catch {
    times = {};
  }
  return times;
};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(times));
    } catch {}
  }, 2000);
};

const nameOf = (step: WaitStep, network?: P.Network) => (step === 'network' && network ? `network:${network}` : step);

/** The middle of this step's last few times here, or a default before there are three. */
export function usualMs(step: WaitStep, network?: P.Network): number {
  const xs = load()[nameOf(step, network)] ?? [];
  if (xs.length < 3) return DEFAULT_MS[step];
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Longer than this was the hub out of reach, not a step's time: not kept. */
const LONGEST = 60_000;

function note(w: Wait, now: number) {
  if (now - w.at > LONGEST) return;
  const t = load();
  const k = nameOf(w.step, w.network);
  t[k] = [...(t[k] ?? []), now - w.at].slice(-KEEP);
  save();
}

function put(key: string, w: Wait | null) {
  const m = new Map(waits.value);
  if (w) m.set(key, w);
  else m.delete(key);
  waits.value = m;
}

/**
 * The open of `key` is at `step` now: the step before it, if any, ends (and its time is kept). `steps`: what the open
 * is expected to take, given where it begins.
 */
export function waitOn(key: string, step: WaitStep, o: { network?: P.Network; steps?: WaitStep[] } = {}, now = Date.now()) {
  const w = waits.value.get(key);
  if (w?.step === step) return;
  if (w) note(w, now);
  const steps = o.steps ?? w?.steps ?? [step];
  put(key, { step, network: o.network ?? w?.network, at: now, began: w?.began ?? now, steps: steps.includes(step) ? steps : [...steps, step] });
}

/** The open of `key` is done, or given up (`kept` false: its last step's time is not kept, it did not finish). */
export function waitDone(key: string, kept = true, now = Date.now()) {
  const w = waits.value.get(key);
  if (!w) return;
  if (kept) note(w, now);
  put(key, null);
}

// ------------------------------------------------------------------ what ui/OpenBar.tsx draws and says

/** A wait longer than this says what it waits on. */
export const SAY_MS = 1500;
/** A step this many times its usual time, and at least SLOW_MS, is slow: said in amber. */
const SLOW_TIMES = 3;
const SLOW_MS = 2000;

const usualOf = (w: Pick<Wait, 'network'>, s: WaitStep) => usualMs(s, s === 'network' ? w.network : undefined);

/**
 * Where the line is in the open: the steps done, then the step under way, each as wide as its usual time. Within the
 * step under way it heads for most of the step's width and slows as it nears it, never claiming the step done.
 */
export function barSpan(w: Wait): { from: number; to: number; ms: number } {
  const ws = w.steps.map((s) => usualOf(w, s));
  const all = ws.reduce((a, b) => a + b, 0) || 1;
  const i = Math.max(0, w.steps.indexOf(w.step));
  const from = ws.slice(0, i).reduce((a, b) => a + b, 0) / all;
  return { from, to: from + (0.85 * ws[i]) / all, ms: ws[i] * 2.5 };
}

const secs = (ms: number) => (ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** What the row over the box says about the open, once it has gone on a while; null before then. */
export function waitLine(w: Wait, now: number, o: { restarting?: boolean } = {}): { text: string; slow: boolean; why?: string } | null {
  if (now - w.began < SAY_MS) return null;
  const took = now - w.at;
  const usual = usualOf(w, w.step);
  const slow = took > Math.max(SLOW_MS, SLOW_TIMES * usual);
  const name = w.network ? (NETWORK_META[w.network]?.name ?? w.network) : 'the network';
  const what = w.step === 'link' ? (o.restarting ? 'Waiting for the hub to restart' : 'Reaching your hub') : w.step === 'hub' ? 'Waiting on your hub' : `Waiting on ${name}`;
  const why =
    w.step === 'network' ? `Your hub has what it stored; ${name} has not answered for the latest yet.` : w.step === 'hub' ? 'Your hub has not answered with this chat yet.' : undefined;
  return { text: `${what} · ${secs(took)}${slow ? `, usually ${secs(usual)}` : ''}`, slow, why };
}

