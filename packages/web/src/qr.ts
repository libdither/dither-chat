/**
 * QR codes (docs/add.md, "QR codes"): the link that adds or messages you on each network, built from what the hub
 * knows of an account's own identity without asking the network; what a scanned code is; and drawing one. No
 * browser needed, so it can be tested alone.
 */
import type * as P from '@dither-chat/protocol';
import { parseAdd } from '@dither-chat/protocol';
import { renderSVG } from 'uqr';
import { isLink } from './add.ts';
import type { CameraState } from './qrscan.ts';

/** Black on white with a four-module quiet zone and square edges, the way phone scanners want it, in every theme. */
export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: 'M', border: 4, whiteColor: '#ffffff', blackColor: '#000000' }).replace('<svg ', '<svg shape-rendering="crispEdges" ');
}

export interface OwnCode {
  /** The link the code holds. */
  url: string;
  /** What scanning it does, in a sentence. */
  what: string;
  /** The link holds a phone number: hidden until the owner taps to show it. */
  number?: true;
}

/** An account's own code, when one can be built, and plain notes on what it is or why there is none. */
export interface OwnCodes {
  code: OwnCode | null;
  notes: string[];
}

const phoneOf = (s: string | null | undefined): string | null => {
  const p = (s ?? '').replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
};

/** Keep a link only when our own Scan reads it back as someone on that network: parseAdd is the judge. */
const readable = (network: P.Network, url: string) => parseAdd(url).some((r) => r.network === network && r.kind !== 'invite' && r.kind !== 'place');

/** Said before a phone-number code is shown. */
export const NUMBER_WARNING = 'This code is your phone number: anyone who sees it or scans it gets your number.';

/**
 * The link that adds or messages you on a network, from your own identity there: its native id and handle as the
 * adapter gave them. Phone-number links come back with `number` set, for the page to hide until tapped.
 */
export function ownCode(network: P.Network, me: Pick<P.IdentityView, 'nativeId' | 'handle'>, username?: P.PersonAbout['username']): OwnCodes {
  const handle = (me.handle ?? '').trim().replace(/^@/, '');
  const unknown = `This account's ${network === 'matrix' ? 'Matrix ID' : network === 'discord' ? 'user id' : 'name'} does not make a link.`;
  const one = (url: string, what: string): OwnCodes => (readable(network, url) ? { code: { url, what }, notes: [] } : { code: null, notes: [unknown] });
  const byNumber = (url: string | null, what: string, notes: string[]): OwnCodes =>
    url && readable(network, url) ? { code: { url, what, number: true }, notes } : { code: null, notes };
  switch (network) {
    case 'matrix':
      return one(`https://matrix.to/#/${me.nativeId}`, 'Opens your Matrix profile on matrix.to, which hands it to their Matrix app.');
    case 'discord':
      return one(`https://discord.com/users/${me.nativeId}`, 'Opens your Discord profile, where they can send you a friend request.');
    case 'telegram': {
      if (/^[A-Za-z]/.test(handle) && readable(network, `https://t.me/${handle}`)) return one(`https://t.me/${handle}`, 'Opens a chat with you in Telegram.');
      const phone = phoneOf(me.handle);
      const noName = 'You have no Telegram username. Set one in Telegram for a code that does not show your number.';
      return byNumber(phone && `https://t.me/${phone}`, 'Opens a chat with you in Telegram, for people your privacy settings let find you by number.', [noName]);
    }
    case 'whatsapp': {
      const phone = phoneOf(me.handle) ?? phoneOf(`+${/^(\d+)@s\.whatsapp\.net$/.exec(me.nativeId)?.[1] ?? ''}`);
      return byNumber(phone && `https://wa.me/${phone.slice(1)}`, 'Opens a chat with you in WhatsApp.', phone ? [] : ["WhatsApp has not said this account's number, so there is no code to show."]);
    }
    case 'signal': {
      // Your username's link, as the adapter last set it (Signal makes the link; signal-cli shows it only then).
      if (username?.link && readable(network, username.link)) return { code: { url: username.link, what: `Opens a chat with you in Signal, by your username ${username.name}: your number stays hidden.` }, notes: [] };
      const phone = phoneOf(me.handle);
      const note = username
        ? `Your username is ${username.name}, but Signal shows its link only when it is set: set it again on your profile for a code without your number.`
        : 'Set a username on your profile (Signal adds a number after it) for a code that does not show your number.';
      return byNumber(phone && `https://signal.me/#p/${phone}`, 'Opens a chat with you in Signal.', [note]);
    }
    case 'x':
      return handle ? one(`https://x.com/${handle}`, 'Opens your X profile.') : { code: null, notes: ["X has not said this account's handle yet."] };
    case 'instagram':
      return handle ? one(`https://instagram.com/${handle}`, 'Opens your Instagram profile.') : { code: null, notes: ["Instagram has not said this account's username yet."] };
    case 'messenger':
      if (/^[A-Za-z]/.test(handle) && readable(network, `https://m.me/${handle}`)) return one(`https://m.me/${handle}`, 'Opens a chat with you in Messenger.');
      return /^\d{5,20}$/.test(me.nativeId)
        ? one(`https://www.facebook.com/profile.php?id=${me.nativeId}`, 'Opens your Facebook profile, where they can message you.')
        : { code: null, notes: ["Messenger has not said this account's profile yet."] };
    case 'gmessages':
      return { code: null, notes: ['Google Messages has no profile link: people reach you by your phone number.'] };
    default:
      return { code: null, notes: [] };
  }
}

/** What a scanned code is: something the New box reads (a link or an address), or anything else, shown as text. */
export type ScanResult = { kind: 'reading'; text: string } | { kind: 'other'; text: string; hint?: string };

/** A scan fills the New box only with a link or an address parseAdd reads; never a bare word, never an action. */
export function readScan(raw: string): ScanResult {
  const text = raw.trim();
  if ((isLink(text) || /^[@+]/.test(text)) && parseAdd(text).length) return { kind: 'reading', text };
  if (/^tg:\/\/login\b/i.test(text)) {
    return { kind: 'other', text, hint: "It is a Telegram sign-in code. Approve a sign-in only from your Telegram account's page, and only for a device of your own." };
  }
  return { kind: 'other', text };
}

/** What to say for a camera that will not start, in the New box: a picture of the code still works. */
export const SCAN_CAMERA_TEXT: Partial<Record<CameraState, string>> = {
  denied: "The camera is not allowed here. Allow it for this site in the browser's (or the app's) settings, or choose or paste a picture of the code.",
  none: 'There is no camera here. Choose or paste a picture of the code.',
  busy: 'Another app is using the camera. Close it and try again, or choose a picture of the code.',
  insecure: 'The camera only works when this page is open over HTTPS. Choose or paste a picture of the code.',
  error: 'The camera did not start. Choose or paste a picture of the code.',
};
