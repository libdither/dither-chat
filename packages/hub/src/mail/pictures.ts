/**
 * Which remote pictures in a mail can tell the sender you opened it (docs/mail.md "Pictures and trackers").
 *
 * Every remote picture is fetched from the sender's side of the internet when it is shown, so any of them can tell
 * the sender the mail was opened. What decides how much it tells is whether the address is the same for everyone the
 * mail went to:
 *
 * - **tracker**: it exists only to report the open: a 1-2 px or hidden picture (sanitize.ts isTracker), or an address
 *   in the shape the big mailing services use for their open pixels.
 * - **personal**: its address carries something only this copy of the mail has: one of your addresses (as written,
 *   URL-encoded, or as its MD5 / SHA-1 / SHA-256), or a long opaque token in the query or the path. Loading it tells
 *   the sender this copy was opened, as a tracker does.
 * - **shared**: anything else: a logo or a product picture at an address every recipient's copy has. Loading it tells
 *   the picture's host that someone opened some copy, not that you did.
 *
 * The rule leans towards personal: a signed CDN address whose signature is the same for everyone is held needlessly,
 * never the other way round. An address seen in two different mails is shared whatever it looks like.
 */
import { createHash } from 'node:crypto';

type PictureClass = 'shared' | 'personal' | 'tracker';

interface PictureVerdict {
  class: PictureClass;
  /** Why, in a few words, for the reader's details ("carries your address", "an open pixel's address"). */
  why: string;
}

/** Hosts whose pictures are open pixels, whatever their path (the big senders' own tracking hosts). */
const TRACKER_HOSTS = [
  'mailtrack.io',
  'mailfoogae.appspot.com',
  'getnotify.com',
  'bananatag.com',
  'yesware.com',
  'mixmax.com',
  'r.superhuman.com',
  'pixel.watch',
  'emltrk.com',
  'pardot.com',
  'mltrk.io',
];

/**
 * The exact paths the big mailing services serve their open pixels at (Mailchimp and Mandrill, SendGrid, Salesforce
 * Marketing Cloud, Constant Contact, Mailgun). Only these: a looser word like "pixel" or "open" in a path would catch
 * real pictures.
 */
const TRACKER_PATH = [/\/track\/open\.php$/i, /\/wf\/open$/i, /\/open\.aspx$/i, /\/on\.jsp$/i, /^\/o\/[A-Za-z0-9_=-]{24,}$/];

const hostIs = (host: string, h: string) => host === h || host.endsWith(`.${h}`);

/** A run that looks random: long, and mixing letters with digits (or base64's -_), not a word or a plain number. */
function opaque(s: string, min: number): boolean {
  if (s.length < min) return false;
  if (!/^[A-Za-z0-9_\-=.%+~]+$/.test(s)) return false;
  const digits = (s.match(/[0-9]/g) ?? []).length;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  // A plain number (an id the same for everyone, like a product's) or a word-ish slug is not a token.
  if (!letters || !digits) return false;
  if (/^[a-z]+(-[a-z]+)+$/i.test(s)) return false;
  return digits >= 3 && letters >= 3;
}

/** The forms an address takes inside a URL: as written, encoded, and hashed the ways mailing services hash it. */
export function addressForms(emails: string[]): string[] {
  const out = new Set<string>();
  for (const raw of emails) {
    const e = raw.trim().toLowerCase();
    if (!e.includes('@')) continue;
    out.add(e);
    out.add(encodeURIComponent(e).toLowerCase());
    out.add(Buffer.from(e).toString('base64').replace(/=+$/, '').toLowerCase());
    out.add(Buffer.from(e).toString('base64url').toLowerCase());
    for (const alg of ['md5', 'sha1', 'sha256']) out.add(createHash(alg).update(e).digest('hex'));
  }
  return [...out];
}

interface ClassifyContext {
  /** addressForms() of the addresses this copy went to that are yours. */
  you: string[];
  /**
   * The address was seen in a mail from another sender: the same for more than one sender's mail, so shared. (Seen
   * again from the same sender proves nothing: a sender can reuse your token in every mail it sends you.)
   */
  seenElsewhere?: (url: string) => boolean;
}

/** One remote picture's class, and why. `shapedLikeTracker`: sanitize.ts isTracker said so from its size or style. */
export function classifyPicture(url: string, ctx: ClassifyContext, shapedLikeTracker = false): PictureVerdict {
  if (shapedLikeTracker) return { class: 'tracker', why: 'a 1-2 px or hidden picture' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { class: 'personal', why: 'an address that could not be read' };
  }
  const host = u.hostname.toLowerCase();
  if (TRACKER_HOSTS.some((h) => hostIs(host, h))) return { class: 'tracker', why: `${host} is an open-tracking service` };
  if (TRACKER_PATH.some((re) => re.test(u.pathname))) return { class: 'tracker', why: 'a mailing service’s open pixel' };
  let decoded = url.toLowerCase();
  try {
    decoded = decodeURIComponent(url).toLowerCase();
  } catch {}
  if (ctx.you.some((f) => f.length >= 6 && (decoded.includes(f) || url.toLowerCase().includes(f)))) return { class: 'personal', why: 'carries your address' };
  if (ctx.seenElsewhere?.(url)) return { class: 'shared', why: 'seen in other mail too' };
  for (const [k, v] of u.searchParams) {
    // Sizes, formats and versions are the same for everyone.
    if (/^(w|h|width|height|q|quality|fit|fm|format|auto|dpr|v|ver|version|crop|size|s?rgb)$/i.test(k)) continue;
    if (opaque(v, 16) || opaque(k, 24)) return { class: 'personal', why: 'a token in its address' };
  }
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const s = segs[i];
    // A file name with a picture's extension is most often a content hash, the same for everyone.
    if (last && /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(s)) continue;
    if (opaque(s, last ? 20 : 24)) return { class: 'personal', why: 'a token in its address' };
  }
  return { class: 'shared', why: 'the same address for every copy' };
}

/** Which pictures load: none, only those unlikely to report an open (shared), or all. */
export type PicturePolicy = 'none' | 'shared' | 'all';

/**
 * What one picture does: load, hold (a placeholder of its size), or drop (gone). Removed trackers are gone; kept ones
 * are pictures that report the open, as personal ones are, so they load only when all pictures do. A picture the hub
 * already has (`cached`) makes no request at all, so it loads whenever shared ones would.
 */
export function pictureAction(c: PictureClass, pictures: PicturePolicy, keepTrackers: boolean, cached = false): 'load' | 'hold' | 'drop' {
  if (c === 'tracker' && !keepTrackers) return 'drop';
  if (pictures === 'all') return 'load';
  if (pictures === 'shared' && (c === 'shared' || (cached && c !== 'tracker'))) return 'load';
  return 'hold';
}
