/**
 * Approving a Telegram sign-in on another device from here (docs/accounts.md, "Approving a Telegram sign-in"): which
 * scanned or pasted text is a sign-in code, and the steps from reading one to approving it. No browser needed.
 */

/** A session as the account action `approveLogin` answers it (dither-accounts extractors/telegram/src/sessions.ts). */
export interface ApprovedSession {
  /** A 64-bit number as a string, only for `endSession`. */
  hash: string;
  device: string;
  platform: string;
  app: string;
  appVersion: string;
  country: string | null;
  region: string | null;
  /** ms epoch */
  createdAt: number;
}

/** A session as the account action `sessions` lists it. */
export interface SessionInfo extends ApprovedSession {
  /** The account's own session: the one this hub signs in with. */
  current: boolean;
  /** ms epoch */
  activeAt: number;
}

export const NOT_A_SIGN_IN = 'That is not a Telegram sign-in code. On the other device, choose to log in by QR code, and scan the code it shows.';

/**
 * The link to approve, from what a QR code or the paste field gave: only `tg://login?token=<base64url>`, trimmed,
 * without anything after the token. Null for anything else.
 */
export function loginLink(text: string): string | null {
  const m = text.trim().match(/^tg:\/\/login\?token=([^&#\s]+)(?:&[^#\s]*)?$/i);
  if (!m) return null;
  let token: string;
  try {
    token = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  // Telegram's tokens are 32 bytes or so; the extractor takes 8 to 1024.
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token) || token.replace(/=+$/, '').length < 11 || token.length > 1400) return null;
  return `tg://login?token=${token}`;
}

/** "Utrecht, Netherlands", or null where Telegram gives no place. */
export function sessionPlace(s: Pick<ApprovedSession, 'country' | 'region'>): string | null {
  const parts = [s.region, s.country].filter((x): x is string => !!x && !!x.trim());
  return parts.length ? parts.join(', ') : null;
}

/** "Telegram Web 2.2 K · Web" */
export function sessionApp(s: Pick<ApprovedSession, 'app' | 'appVersion' | 'platform'>): string {
  const app = [s.app, s.appVersion].filter(Boolean).join(' ');
  return [app, s.platform].filter(Boolean).join(' · ') || 'An unnamed app';
}

const DAY_MS = 86_400_000;

/**
 * Until when Telegram would refuse to sign a wrong approval out again: it lets only a session a day old end others,
 * and this account's own session (the current one) is younger. Null when it is older, or not known.
 */
export function undoBlockedUntil(list: readonly SessionInfo[] | null, now = Date.now()): number | null {
  const own = list?.find((s) => s.current);
  if (!own || !own.createdAt) return null;
  const until = own.createdAt + DAY_MS;
  return until > now ? until : null;
}

/** "about 21 hours", "under an hour" */
export function roughlyIn(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h < 1 ? 'under an hour' : `about ${h} hour${h === 1 ? '' : 's'}`;
}

/** This account's own session: Telegram gives it hash 0, and endSession refuses it. */
export const isOwnSession = (s: Pick<SessionInfo, 'current' | 'hash'>) => s.current || s.hash === '0';

/** An account action's refusal, as the extractor wrote it. */
export const actionError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^action failed: /, '');

/** How long the approve button stays disarmed after the warning shows, so a tap meant for the step before cannot land on it. */
export const ARM_MS = 1000;

/** Where the approve dialog is. */
export type Step =
  | { at: 'scan'; refused?: string }
  | { at: 'confirm'; link: string; armedAt: number }
  | { at: 'approving'; link: string }
  | { at: 'approved'; session: ApprovedSession; ending?: boolean; ended?: boolean; error?: string }
  | { at: 'failed'; error: string };

export type StepEvent =
  /** Text from the camera, a picture or the paste field. */
  | { t: 'read'; text: string; now: number }
  /** The approve button, pressed. */
  | { t: 'approve'; now: number }
  | { t: 'approved'; session: ApprovedSession }
  | { t: 'failed'; error: string }
  | { t: 'again' }
  | { t: 'ending' }
  | { t: 'ended' }
  | { t: 'endFailed'; error: string };

/**
 * The next step. A read code only ever leads to the warning: approving takes the approve button, pressed once it is
 * armed, and nothing else.
 */
export function step(s: Step, e: StepEvent): Step {
  switch (e.t) {
    case 'read': {
      if (s.at !== 'scan') return s;
      const link = loginLink(e.text);
      return link ? { at: 'confirm', link, armedAt: e.now + ARM_MS } : { at: 'scan', refused: NOT_A_SIGN_IN };
    }
    case 'approve':
      return s.at === 'confirm' && e.now >= s.armedAt ? { at: 'approving', link: s.link } : s;
    case 'approved':
      return s.at === 'approving' ? { at: 'approved', session: e.session } : s;
    case 'failed':
      return s.at === 'approving' ? { at: 'failed', error: e.error } : s;
    case 'again':
      return { at: 'scan' };
    case 'ending':
      return s.at === 'approved' && !s.ending && !s.ended ? { ...s, ending: true, error: undefined } : s;
    case 'ended':
      return s.at === 'approved' ? { ...s, ending: false, ended: true } : s;
    case 'endFailed':
      return s.at === 'approved' ? { ...s, ending: false, error: e.error } : s;
  }
}
