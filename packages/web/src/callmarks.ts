/**
 * What a call shows about itself and its people (docs/calls.md "Who is speaking"), the same on every surface that shows
 * a call (the dock, the call bar, a room, the video window): who counts as speaking once the flicker between words is
 * held out, who to feature, when you are talking into a muted microphone, which one state a person's badge shows, which
 * buttons your role gets, and the call's status line. No app state here, and every clock can be a test's own.
 */
import type * as P from '@dither-chat/protocol';
import { stageRights } from '@dither-chat/protocol';

/** Now, later, and calling off later: the browser's own, or a test's hand-moved clock. */
export interface Clock {
  now(): number;
  after(fn: () => void, ms: number): unknown;
  cancel(handle: any): void;
}

const realClock: Clock = { now: () => Date.now(), after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) };

// ------------------------------------------------------------------ speaking, held

/** How long someone still counts as speaking after the network last said they were. The 180 ms fade after it is CSS's (.speak-ring). */
export const SPEAKING_HOLD_MS = 250;

interface SpeakingHold {
  /** Who the network says is speaking now. On at once; off only once someone has been quiet for the hold. */
  update(raw: Iterable<string>): void;
  /** Who counts as speaking now. */
  readonly on: ReadonlySet<string>;
  /** Everyone off at once (the call ended). */
  clear(): void;
}

/**
 * Voice activity switches off between words, so a mark that follows it blinks several times a second. This holds each
 * person on for `holdMs` after the last word; `onChange` gets a new set whenever who counts changes.
 */
export function speakingHold(onChange: (on: ReadonlySet<string>) => void, holdMs = SPEAKING_HOLD_MS, clock: Clock = realClock): SpeakingHold {
  let on = new Set<string>();
  const leaving = new Map<string, unknown>();
  const set = (next: Set<string>) => {
    on = next;
    onChange(on);
  };
  return {
    get on() {
      return on;
    },
    update(raw) {
      const now = new Set(raw);
      let added: Set<string> | null = null;
      for (const id of now) {
        const t = leaving.get(id);
        if (t !== undefined) {
          clock.cancel(t);
          leaving.delete(id);
        }
        if (!on.has(id)) (added ??= new Set(on)).add(id);
      }
      if (added) set(added);
      for (const id of on) {
        if (now.has(id) || leaving.has(id)) continue;
        leaving.set(
          id,
          clock.after(() => {
            leaving.delete(id);
            const next = new Set(on);
            next.delete(id);
            set(next);
          }, holdMs),
        );
      }
    },
    clear() {
      for (const t of leaving.values()) clock.cancel(t);
      leaving.clear();
      if (on.size) set(new Set());
    },
  };
}

// ------------------------------------------------------------------ who to feature

/** The least time one person stays featured before another takes their place. */
export const FEATURE_KEEP_MS = 1500;

interface FeaturedPicker {
  /** Who is speaking now (held), and you, who is never featured. */
  update(speaking: Iterable<string>, self?: string | null): void;
  /** Who is featured now: null when nobody else speaks. */
  readonly shown: string | null;
  clear(): void;
}

/**
 * Whose face to feature (the call bar's, the video window's Speaker): the latest person to start talking, never you,
 * kept at least `keepMs` before switching to someone else (or to nobody), so a quick "yeah" doesn't snatch it.
 * `onChange` gets each new pick, including a switch that waited out the keep.
 */
export function featuredPicker(onChange: (id: string | null) => void, keepMs = FEATURE_KEEP_MS, clock: Clock = realClock): FeaturedPicker {
  let shown: string | null = null;
  let since = 0;
  let wait: unknown;
  let seq = 0;
  /** Who is speaking, with the order they started in. */
  const started = new Map<string, number>();
  const decide = () => {
    if (wait !== undefined) clock.cancel(wait);
    wait = undefined;
    let want: string | null = null;
    let latest = -1;
    for (const [id, n] of started) if (n > latest) (want = id), (latest = n);
    if (want === shown) return;
    const left = since + keepMs - clock.now();
    if (shown !== null && left > 0) {
      wait = clock.after(decide, left);
      return;
    }
    shown = want;
    since = clock.now();
    onChange(shown);
  };
  return {
    get shown() {
      return shown;
    },
    update(speaking, self) {
      const now = new Set(speaking);
      if (self) now.delete(self);
      for (const id of [...started.keys()]) if (!now.has(id)) started.delete(id);
      for (const id of now) if (!started.has(id)) started.set(id, seq++);
      decide();
    },
    clear() {
      if (wait !== undefined) clock.cancel(wait);
      wait = undefined;
      started.clear();
      if (shown !== null) {
        shown = null;
        onChange(null);
      }
    },
  };
}

// ------------------------------------------------------------------ talking into a muted microphone

/** The automatic speaking gate, in dB (RMS, dBFS): direct mode's own level gate (voice/discord.ts, 0.015 RMS) is about this, and the muted-talking note uses it. */
export const AUTO_GATE_DB = -36;
/** Talking while muted shows after about this much speech, and clears after this much quiet. */
export const MUTED_TALK = { onMs: 500, offMs: 3000, gapMs: SPEAKING_HOLD_MS } as const;

interface TalkGate {
  /** One reading of the microphone: loud enough to count as talking or not. */
  update(loud: boolean): void;
  readonly on: boolean;
  clear(): void;
}

/**
 * "You're muted" only for real talk: on once you have talked for `onMs` (gaps between words shorter than `gapMs` don't
 * restart it), off once you have been quiet for `offMs`. Driven by the readings themselves, no timers of its own.
 */
export function talkGate(onChange: (on: boolean) => void, opts: { onMs: number; offMs: number; gapMs: number } = MUTED_TALK, clock: Pick<Clock, 'now'> = realClock): TalkGate {
  let on = false;
  let from: number | null = null;
  let last = -Infinity;
  const set = (v: boolean) => {
    if (v === on) return;
    on = v;
    onChange(on);
  };
  return {
    get on() {
      return on;
    },
    update(loud) {
      const now = clock.now();
      if (loud) {
        if (from === null || now - last > opts.gapMs) from = now;
        last = now;
        if (now - from >= opts.onMs) set(true);
      } else {
        if (from !== null && now - last > opts.gapMs) from = null;
        if (now - last >= opts.offMs) set(false);
      }
    },
    clear() {
      from = null;
      last = -Infinity;
      set(false);
    },
  };
}

// ------------------------------------------------------------------ the badge

/** The one state a person's badge shows. */
export type CallBadge = 'serverDeafened' | 'serverMuted' | 'deafened' | 'muted' | 'hand' | 'invited' | 'mutedForYou';

type BadgeOf = Pick<P.CallParticipant, 'muted' | 'deafened'> & Partial<Pick<P.CallParticipant, 'serverMuted' | 'serverDeafened' | 'stage' | 'localMute'>>;

/**
 * The most important way someone differs from what their role has by default. In a stage's audience muted is the
 * default, so only a hand up or an invitation shows; a speaker, or anyone in a call without an audience: muted or
 * deafened by a moderator, deafened, muted, a hand up, muted for you.
 */
export function callBadge(p: BadgeOf): CallBadge | null {
  if (p.stage && p.stage !== 'speaker') return p.stage === 'hand' ? 'hand' : p.stage === 'invited' ? 'invited' : null;
  if (p.serverDeafened) return 'serverDeafened';
  if (p.serverMuted) return 'serverMuted';
  if (p.deafened) return 'deafened';
  if (p.muted) return 'muted';
  if (p.localMute) return 'mutedForYou';
  return null;
}

export const BADGE_WORDS: Record<CallBadge, string> = {
  serverDeafened: 'deafened by a moderator',
  serverMuted: 'muted by a moderator',
  deafened: 'deafened',
  muted: 'muted',
  hand: 'asking to speak',
  invited: 'invited to speak',
  mutedForYou: 'muted for you',
};

/** The badge's size for a picture this big: about a third of it, readable on a 64–88 px face and not crowding an 18 px one. */
export function badgeSize(size: number): number {
  return Math.max(10, Math.min(28, Math.round(size * 0.36)));
}

// ------------------------------------------------------------------ levels

/** A level from the browser (linear audioLevel, 0 to 1) as the eye reads it: -60 dBFS to 0 as 0 to 1. */
export function levelShown(audioLevel: number): number {
  return Math.max(0, Math.min(1, (20 * Math.log10(audioLevel + 1e-9) + 60) / 60));
}

/** A level that jumps up and sinks back slowly, so a ring that follows it does not shimmer. */
export function smoothLevel(prev: number, next: number): number {
  return next >= prev ? next : prev * 0.6 + next * 0.4;
}

// ------------------------------------------------------------------ the status line and the buttons

/** How long a call has gone: 4:05, or 1:15:03 past the hour. */
export function callTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** What the status line and the buttons read from a call (call.ts ActiveCall has all of it). */
interface CallLike {
  mode: P.CallMode;
  phase: 'connecting' | 'live' | 'ended';
  muted: boolean;
  deafened: boolean;
  since: number;
  note?: string;
  self?: Pick<P.CallSelf, 'connected' | 'muted'>;
  stage?: Pick<P.CallStage, 'can' | 'canOn'>;
  camera: boolean;
  screen: boolean;
  listenOnly?: boolean;
}

export interface CallStatus {
  /** Connecting…, the time it has gone, or why it ended. */
  text: string;
  /** connecting; reaching: bridge mode is live but the account's own client isn't in yet; live; ended. */
  phase: 'connecting' | 'reaching' | 'live' | 'ended';
  /** A word on something wrong you can fix: the account's client is still muted after you unmuted. */
  hint?: string;
}

export function statusFor(call: CallLike, now: number, networkName: string): CallStatus {
  if (call.phase === 'connecting') return { text: 'Connecting…', phase: 'connecting' };
  if (call.phase === 'ended') return { text: call.note ?? 'Call ended', phase: 'ended' };
  // Bridge mode: live once the bridge is, but people hear you only once the account's own client has connected.
  if (call.mode === 'bridge' && call.self && !call.self.connected) return { text: `Connecting to ${networkName}…`, phase: 'reaching' };
  const hint = call.self?.muted && !call.muted && !call.listenOnly ? 'The account is still muted: tap to try again' : undefined;
  return { text: callTime(now - call.since), phase: 'live', ...(hint ? { hint } : {}) };
}

export type CallControlKind = 'mute' | 'deafen' | 'camera' | 'share' | 'hand' | 'speak' | 'listen' | 'leave';

export interface CallControl {
  kind: CallControlKind;
  /** What it does now, said as a button says it ("Unmute", "Ask to speak"). */
  label: string;
  /** Its hover text, when it says more than the label. */
  title?: string;
  /** Something of yours is off: muted, deafened. */
  off?: boolean;
  /** Something of yours is on: camera, sharing, a hand up. */
  on?: boolean;
  disabled?: boolean;
}

/** What the account can do here, beyond the call itself. */
interface CallAbilities {
  /** Your role on a stage, or null in a call without an audience. */
  role: P.StageRole | null;
  /** Your rank on a stage (host, co-host, moderator), when it has one for you. */
  rank?: P.StageRank;
  /** Video goes through this call (bridge mode, an account that sends it). */
  video: boolean;
  /** This browser can share a screen. */
  share: boolean;
  /** The account can raise a hand, speak and invite (capability 'stage'). */
  stage: boolean;
}

/**
 * What you may do on this stage now (protocol stageRights): what the room says, else what your role and rank give.
 * Nothing without the capability 'stage' or outside a stage. The one rule every surface's buttons and menus read.
 */
export function stageCan(call: Pick<CallLike, 'stage'>, can: Pick<CallAbilities, 'role' | 'rank' | 'stage'>): { can: P.StageSelfAction[]; canOn: P.StageMove[] } {
  if (!can.stage || !can.role || !call.stage) return { can: [], canOn: [] };
  return stageRights(call.stage, can.role, can.rank);
}

/**
 * The buttons your role and the call's state give you, in order. A speaker (or anyone in a call without an audience)
 * gets mute, deafen, camera and share where video goes, and leave. On a stage the rest are what you may do there
 * (stageCan): a hand to raise or lower, Speak, Move to the audience (Stay in the audience, when invited). The audience
 * never gets the microphone, a camera or a screen, and leaves quietly.
 */
export function controlsFor(call: CallLike, can: CallAbilities): CallControl[] {
  const ended = call.phase === 'ended';
  const role = can.role;
  const may = new Set(stageCan(call, can).can);
  const speaking = role === null || role === 'speaker';
  const out: CallControl[] = [];
  if (speaking)
    out.push({
      kind: 'mute',
      label: call.muted ? 'Unmute' : 'Mute',
      ...(call.listenOnly ? { title: 'No microphone: listening only' } : call.self?.muted && !call.muted ? { title: 'The account is still muted: tap to try again' } : {}),
      off: call.muted,
      disabled: ended || !!call.listenOnly,
    });
  out.push({ kind: 'deafen', label: call.deafened ? 'Undeafen' : 'Deafen', off: call.deafened, disabled: ended });
  if (speaking && can.video) out.push({ kind: 'camera', label: call.camera ? 'Turn camera off' : 'Turn camera on', on: call.camera, disabled: ended });
  if (speaking && can.video && can.share) out.push({ kind: 'share', label: call.screen ? 'Stop sharing' : 'Share your screen or a window', on: call.screen, disabled: ended });
  if (may.has('lowerHand')) out.push({ kind: 'hand', label: 'Lower hand', on: true, disabled: ended });
  else if (may.has('raiseHand')) out.push({ kind: 'hand', label: 'Ask to speak', on: false, disabled: ended });
  if (may.has('speak')) out.push({ kind: 'speak', label: 'Speak', disabled: ended });
  if (may.has('listen')) out.push({ kind: 'listen', label: role === 'invited' ? 'Stay in the audience' : 'Move to the audience', disabled: ended });
  out.push({ kind: 'leave', label: speaking ? 'Leave' : 'Leave quietly', title: 'Leave the call', disabled: ended });
  return out;
}
