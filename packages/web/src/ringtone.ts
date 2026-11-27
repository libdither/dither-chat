/**
 * A call ringing you rings aloud on the page you are looking at (docs/calls.md "Ringing"). The ring that goes to your
 * devices is a notification with a sound, but a computer's service worker closes it while a page is in front (sw.js:
 * the page shows the ring card instead), and the Android app skips it while it is on screen; the card itself made no
 * sound, so a call came in as a quiet card in a corner. It rings for a call that may sound (`alerts`: no mute and no
 * quiet hours, as for the devices' ring), while the page is visible, and not while this device is in a call.
 */
import { effect, signal } from '@preact/signals';
import { activeCall } from './call.ts';
import { ringingCalls, ringsAloud } from './ringing.ts';

/** One ring: two tones twice, then a pause, as a phone's. Hz; each tone 400 ms. */
const RING = [660, 520, 660, 520];
const TONE_S = 0.4;
const PERIOD_MS = 3000;

const visible = signal(typeof document === 'undefined' || document.visibilityState === 'visible');

/** For the integration tests: whether the page rings now, and how many rings it played. */
const ringtone = { on: false, rings: 0, blocked: false };

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function ringOnce() {
  try {
    ctx ??= new AudioContext();
  } catch {
    return;
  }
  // A page nobody has clicked yet may not start sound; its card still shows.
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  if (ctx.state !== 'running') {
    ringtone.blocked = true;
    return;
  }
  ringtone.blocked = false;
  ringtone.rings++;
  const t0 = ctx.currentTime + 0.02;
  const g = ctx.createGain();
  g.connect(ctx.destination);
  g.gain.value = 0;
  RING.forEach((hz, i) => {
    const o = ctx!.createOscillator();
    o.frequency.value = hz;
    o.connect(g);
    const at = t0 + i * TONE_S;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.12, at + 0.02);
    g.gain.setValueAtTime(0.12, at + TONE_S - 0.04);
    g.gain.linearRampToValueAtTime(0, at + TONE_S);
    o.start(at);
    o.stop(at + TONE_S);
  });
  setTimeout(() => g.disconnect(), RING.length * TONE_S * 1000 + 200);
}

export function startRingtone() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => (visible.value = document.visibilityState === 'visible'));
  effect(() => {
    const call = activeCall.value;
    const on = ringsAloud(ringingCalls(), visible.value, !!call && call.phase !== 'ended');
    if (on === ringtone.on) return;
    ringtone.on = on;
    if (on) {
      ringOnce();
      timer = setInterval(ringOnce, PERIOD_MS);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  Object.assign(globalThis, { __ringtone: ringtone });
}
