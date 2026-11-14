/**
 * The sounds a call makes on this device (docs/calls.md "Sounds"): someone joins or leaves, you mute or deafen, a camera
 * or a stream starts. They are named as Discord names its own; the hub serves Discord's recordings when its updater
 * copied them (/voice/sounds/<name>.mp3), and the device makes a short chime of its own otherwise. Played through the
 * call's AudioContext (started by the click that started the call, so it may play), never sent to anyone.
 */
import type { CallSoundName } from '@dither-chat/protocol';

/** Which of Discord's recordings the hub has: asked once per page. */
let available: Promise<Set<string>> | null = null;
const decoded = new Map<string, Promise<AudioBuffer | null>>();

function hubSounds(): Promise<Set<string>> {
  available ??= fetch('/api/voice/sounds', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { sounds: [] }))
    .then((j: { sounds?: string[] }) => new Set(j.sounds ?? []))
    .catch(() => new Set<string>());
  return available;
}

function buffer(ctx: AudioContext, name: string): Promise<AudioBuffer | null> {
  let p = decoded.get(name);
  if (!p) {
    p = hubSounds().then(async (have) => {
      if (!have.has(name)) return null;
      try {
        const r = await fetch(`/voice/sounds/${name}.mp3`, { credentials: 'same-origin' });
        if (!r.ok) return null;
        return await ctx.decodeAudioData(await r.arrayBuffer());
      } catch {
        return null;
      }
    });
    decoded.set(name, p);
  }
  return p;
}

/** Fetch and decode the common ones ahead, so the first join or mute plays at once. */
export function preloadCallSounds(ctx: AudioContext) {
  for (const n of ['user_join', 'user_leave', 'mute', 'unmute', 'disconnect'] as const) void buffer(ctx, n);
}

/** The device's own chimes: notes in Hz, each 90 ms, rising for on and falling for off. */
const CHIMES: Record<CallSoundName, number[]> = {
  user_join: [660, 880],
  user_leave: [880, 660],
  user_moved: [740, 740],
  disconnect: [660, 520, 400],
  mute: [440],
  unmute: [660],
  deafen: [440, 330],
  undeafen: [330, 440],
  camera_on: [700, 1050],
  camera_off: [1050, 700],
  stream_started: [520, 660, 880],
  stream_ended: [880, 660, 520],
  stream_user_joined: [990, 1320],
  stream_user_left: [1320, 990],
  reconnect: [520, 780],
  call_calling: [480, 620],
  call_ringing: [620, 480],
};

function chime(ctx: AudioContext, notes: number[], volume: number) {
  const t0 = ctx.currentTime + 0.01;
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(ctx.destination);
  notes.forEach((hz, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz;
    o.connect(g);
    const at = t0 + i * 0.09;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.18 * volume, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 0.085);
    o.start(at);
    o.stop(at + 0.09);
  });
  setTimeout(() => g.disconnect(), notes.length * 90 + 200);
}

/** The last time each sound played: a burst of the same news (five people joining at once) plays once. */
const lastPlayed = new Map<string, number>();

/** Play one call sound, unless it played in the last 400 ms. Resolves once it started (or was skipped). */
export async function playCallSound(ctx: AudioContext | null, name: CallSoundName, volume = 0.6): Promise<'recording' | 'chime' | 'skipped'> {
  if (!ctx || ctx.state === 'closed') return 'skipped';
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -1e9) < 400) return 'skipped';
  lastPlayed.set(name, now);
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const buf = await buffer(ctx, name);
  if ((ctx.state as string) === 'closed') return 'skipped';
  if (!buf) {
    chime(ctx, CHIMES[name], volume);
    return 'chime';
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(ctx.destination);
  src.start();
  src.onended = () => g.disconnect();
  return 'recording';
}

/** For the integration tests: what each sound played as, in order (window.__callSounds). */
export const soundLog: { name: CallSoundName; as: string; at: number }[] = [];
