/**
 * When a new build may replace the page (pwa.ts), as pure decisions, so they can be tested without a browser.
 *
 * A page in sight never reloads by itself: that would take away where you were (the scroll, an old message you jumped
 * to, an open picture, a menu or a sheet) and the user deploys several times a day. A new build goes in when the page
 * goes out of sight with nothing in progress, or when you tap the bar. That holds for every tab: a tab that another
 * one updated keeps running its build and shows the bar, unless it is out of sight and idle.
 */

export interface UpdateState {
  /** A new worker is installed and waiting to take over (registration.waiting). */
  waiting: boolean;
  /** A new worker already controls this page, which still runs the old build (another tab let it in). */
  stale: boolean;
  /** You tapped the bar in this page. */
  asked: boolean;
  /** Out of sight: the app is in the background, or the tab is not shown. */
  hidden: boolean;
  /** Something a reload would lose (busyReasons). */
  busy: boolean;
}

export type UpdateStep =
  /** Ask the waiting worker to take over (sw.js 'skipWaiting'); the controller change comes next. */
  | 'apply'
  /** Load the page again: the worker in control already serves the new build. */
  | 'reload'
  /** Show the bar, and wait for a tap or for the page to go out of sight. */
  | 'offer'
  | 'none';

export function nextStep(s: UpdateState): UpdateStep {
  if (!s.waiting && !s.stale) return 'none';
  if (s.asked || (s.hidden && !s.busy)) return s.stale ? 'reload' : 'apply';
  return 'offer';
}

export interface BusyInput {
  /** Text in a text box: a half-written message, note or key. */
  typed: boolean;
  /** A call on this device. */
  call: boolean;
  /** A device verification on screen. */
  verifying: boolean;
  /** Open sheets, dialogs, menus, the picture viewer, the phone's details panel (phone.ts layers). */
  layers: number;
  /** Desktop menus, which are not layers. */
  menus: number;
  /** The conversation on screen is a window around an old message. */
  detached: boolean;
  /** Messages not yet through to the hub: waiting for it, or on their way. */
  sending: number;
}

/** What a reload would lose now, in words; nothing means it may reload. */
export function busyReasons(b: BusyInput): string[] {
  const out: string[] = [];
  if (b.typed) out.push('text typed');
  if (b.call) out.push('a call');
  if (b.verifying) out.push('a device verification');
  if (b.layers > 0 || b.menus > 0) out.push('something open');
  if (b.detached) out.push('an older message on screen');
  if (b.sending > 0) out.push('a message sending');
  return out;
}
