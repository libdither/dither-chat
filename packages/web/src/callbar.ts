/**
 * The call bar's choices, pure so they are unit-tested (docs/calls.md "The call bar"): which of the call's buttons
 * it shows for your role, whether the bar shows at all where you are, and whose faces it shows while nobody talks.
 */
import type { CallControl, CallControlKind } from './callmarks.ts';

/** A computer's list at or under this width is too narrow for the dock: the bar takes its place. */
export const BAR_UNDER = 260;

/**
 * The bar's buttons, out of the ones your role gives you (callmarks.ts controlsFor). Never Leave: it sits behind the
 * expand, away from the thumb. A speaker gets mute and one more: the camera or the screen while one is on (so it can be
 * turned off from anywhere), else deafen. With no microphone, deafen alone. The audience gets deafen and its hand, or
 * Speak once invited.
 */
export function barKinds(controls: readonly Pick<CallControl, 'kind' | 'on'>[], listenOnly: boolean): CallControlKind[] {
  const has = (k: CallControlKind) => controls.find((c) => c.kind === k);
  if (has('mute')) {
    if (listenOnly) return has('deafen') ? ['deafen'] : [];
    const second: CallControlKind = has('camera')?.on ? 'camera' : has('share')?.on ? 'share' : 'deafen';
    return has(second) ? ['mute', second] : ['mute'];
  }
  const out: CallControlKind[] = [];
  if (has('deafen')) out.push('deafen');
  if (has('speak')) out.push('speak');
  else if (has('hand')) out.push('hand');
  return out;
}

/**
 * Does the bar show? On a phone wherever the call's own chat isn't the page on screen (`here`). On a computer where
 * the dock has no room: the list hidden, or dragged to BAR_UNDER or narrower.
 */
export function barShows(o: { inCall: boolean; phone: boolean; here: boolean; listHidden: boolean; listWidth: number }): boolean {
  if (!o.inCall) return false;
  return o.phone ? !o.here : o.listHidden || o.listWidth <= BAR_UNDER;
}

/** While nobody talks: up to `max` of the others in the call, in the call's order (you are never one). */
export function idleFaces(participants: readonly string[], self: string | null | undefined, max = 3): string[] {
  return participants.filter((id) => id !== self).slice(0, max);
}
