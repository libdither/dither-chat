/**
 * The words beside "Inbox" (ui/InboxStatus.tsx, docs/sync.md "What the inbox says"), worked out from the connection's
 * state at one moment: pure, for statusline.test.ts.
 */
import { clock } from './format.ts';

/** A wait shorter than this shows nothing (as Loader.tsx's LOADING_DELAY_MS). */
const QUIET_MS = 180;
/** How long a finished catch-up's line stays; longer after a restart or a new version, which the user may be waiting on. */
const DONE_MS = 1600;
const DONE_AFTER_MS = 3200;

export interface StatusLine {
  icon: 'turn' | 'offline' | 'done';
  title: string;
  more?: string;
  /** Said before `more` where there is room: since when (styles.css drops it in a narrow header). */
  aside?: string;
  /** A tap tries the hub now. */
  tap?: boolean;
  amber?: boolean;
}

export interface StatusInput {
  now: number;
  connected: boolean;
  offline: boolean;
  catching: number | null;
  caught: { at: number; took: number; fresh: number; after?: 'updated' | 'restarted' | 'app' } | null;
  restarting: { at: number; usualMs?: number } | null;
  nextTry: number | null;
  from: { at: number; saved: boolean } | null;
}

const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** The line for this moment, or null for none. */
export function statusLine(s: StatusInput): StatusLine | null {
  const r = s.restarting;
  if (r) {
    if (s.connected && s.catching !== null) return { icon: 'turn', title: 'Catching up…', more: 'hub restarted' };
    const gone = s.now - r.at;
    const left = r.usualMs !== undefined ? r.usualMs - gone : null;
    const more = left === null ? secs(gone) : left >= 1000 ? `back in about ${secs(left)}` : `${secs(gone)} · longer than usual`;
    return { icon: 'turn', title: 'Hub restarting', more };
  }
  if (s.offline) {
    const aside = s.from ? `${s.from.saved ? 'saved' : 'since'} ${clock(s.from.at)}` : undefined;
    const more = s.nextTry !== null ? `next try ${secs(s.nextTry - s.now)}` : 'trying…';
    return { icon: 'offline', title: 'Offline', aside, more, tap: true, amber: true };
  }
  if (s.catching !== null && s.now - s.catching >= QUIET_MS) return { icon: 'turn', title: 'Catching up…' };
  const c = s.caught;
  if (c && (c.took >= QUIET_MS || c.after) && s.now - c.at < (c.after ? DONE_AFTER_MS : DONE_MS)) {
    if (c.after === 'updated') return { icon: 'done', title: 'Hub updated', more: 'up to date' };
    if (c.after === 'restarted') return { icon: 'done', title: 'Hub restarted', more: 'up to date' };
    if (c.after === 'app') return { icon: 'done', title: 'New version', more: 'up to date' };
    return c.fresh ? { icon: 'done', title: `${c.fresh} new`, more: 'up to date' } : { icon: 'done', title: 'Up to date' };
  }
  return null;
}

/** Whether a line can show now or soon, so the clock keeps ticking: no timer at all while all is well. */
export const statusLive = (s: StatusInput) => s.restarting !== null || s.offline || s.catching !== null || (s.caught !== null && s.now - s.caught.at < DONE_AFTER_MS);

