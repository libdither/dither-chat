/**
 * The marks on a person in a call (docs/calls.md "Who is speaking"): who counts as speaking once the flicker between
 * words is held out, and which one state their badge shows. No app state here, so the tests can drive it alone.
 */
import type * as P from '@dither-chat/protocol';

/** How long someone still counts as speaking after the network last said they were. The fade after it is CSS's. */
export const SPEAKING_HOLD_MS = 250;

/** When to do something later, and calling it off: the browser's timers, or a test's own clock. */
export interface HoldTimers {
  after(fn: () => void, ms: number): unknown;
  cancel(handle: any): void;
}

const realTimers: HoldTimers = { after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) };

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
export function speakingHold(onChange: (on: ReadonlySet<string>) => void, holdMs = SPEAKING_HOLD_MS, timers: HoldTimers = realTimers): SpeakingHold {
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
          timers.cancel(t);
          leaving.delete(id);
        }
        if (!on.has(id)) (added ??= new Set(on)).add(id);
      }
      if (added) set(added);
      for (const id of on) {
        if (now.has(id) || leaving.has(id)) continue;
        leaving.set(
          id,
          timers.after(() => {
            leaving.delete(id);
            const next = new Set(on);
            next.delete(id);
            set(next);
          }, holdMs),
        );
      }
    },
    clear() {
      for (const t of leaving.values()) timers.cancel(t);
      leaving.clear();
      if (on.size) set(new Set());
    },
  };
}

/** The one state a person's badge shows, the most important first. */
type CallBadge = 'serverDeafened' | 'serverMuted' | 'deafened' | 'muted' | 'hand' | 'mutedForYou';

export function callBadge(p: Pick<P.CallParticipant, 'muted' | 'deafened' | 'serverMuted' | 'serverDeafened' | 'stage' | 'localMute'>): CallBadge | null {
  if (p.serverDeafened) return 'serverDeafened';
  if (p.serverMuted) return 'serverMuted';
  if (p.deafened) return 'deafened';
  if (p.muted) return 'muted';
  if (p.stage === 'hand') return 'hand';
  if (p.localMute) return 'mutedForYou';
  return null;
}

export const BADGE_WORDS: Record<CallBadge, string> = {
  serverDeafened: 'Deafened by a moderator',
  serverMuted: 'Muted by a moderator',
  deafened: 'Deafened',
  muted: 'Muted',
  hand: 'Asking to speak',
  mutedForYou: 'Muted for you',
};

/** A level from the browser (linear audioLevel, 0 to 1) as the eye reads it: -60 dBFS to 0 as 0 to 1. */
export function levelShown(audioLevel: number): number {
  return Math.max(0, Math.min(1, (20 * Math.log10(audioLevel + 1e-9) + 60) / 60));
}

/** A level that jumps up and sinks back slowly, so a ring that follows it does not shimmer. */
export function smoothLevel(prev: number, next: number): number {
  return next >= prev ? next : prev * 0.6 + next * 0.4;
}
