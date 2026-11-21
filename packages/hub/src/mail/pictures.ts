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
 * The rule leans towards personal: a signed CDN address whose signature is the same for everyone, or a file named by
 * its content's hash, is held needlessly, never the other way round. Personal: a UUID or 16+ hex digits anywhere, a
 * random-looking run of 16+ characters in the path (12+ in a query value), a long number in the query, or an id-like
 * query key (`uid`, `e`, `r`, `id`, `mc_eid`, …) with a value. An address seen in mail from another sender (not one
 * of yours: your Sent copy of a forward proves nothing) is shared whatever it looks like.
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

/** Classes of characters a random token switches between often and a word or a number seldom. */
const charClass = (c: string) => (c >= '0' && c <= '9' ? 0 : c >= 'a' && c <= 'z' ? 1 : 2);

/**
 * A run that looks random: `min`+ letters and digits (base64's -_ between them allowed) that switch between lower
 * case, upper case and digits often, as generated ids do (`Zq81mXc2LpR7`, a hex hash, a UUID), and words, slugs,
 * CamelCase names and plain numbers don't (`summer-sale-2024`, `WinterBanner2`, `20240512`).
 */
function randomRun(s: string, min: number): boolean {
  for (const run of s.match(/[A-Za-z0-9_-]+/g) ?? []) {
    const a = run.replace(/[_-]/g, '');
    if (a.length < min) continue;
    let switches = 0;
    for (let i = 1; i < a.length; i++) if (charClass(a[i]) !== charClass(a[i - 1])) switches++;
    if (switches >= 4 && switches >= a.length * 0.3) return true;
  }
  return false;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** 16+ hex digits with letters and digits both: a hash or an id, as a folder or a file name. */
const LONG_HEX = /(?:^|[^0-9a-f])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{16,}(?:[^0-9a-f]|$)/i;

/** Query keys that are the same for every copy: sizes, formats, versions, cache-busters, campaign names. */
const SAME_FOR_ALL = /^(w|h|width|height|q|quality|fit|fm|format|auto|dpr|v|ver|version|crop|size|s?rgb|t|ts|_|cb|cache|lang|locale|utm_\w+)$/i;
/**
 * Query keys that name a recipient, a subscriber, a contact or one message (`?uid=8812344`, `?e=Zq81mXc2LpR7`,
 * Mailchimp's `mc_eid`, ConvertKit's `ck_subscriber_id`): any value but a tiny one is personal. A short prefix
 * (`mc_`, `_`) is allowed.
 */
const ID_KEYS =
  /^(?:[a-z]{0,4}_)?(u|e|r|id|uid|uuid|guid|user|user_?id|mid|msg_?id|message_?id|sid|sub|subid|subscriber|subscriber_?id|rid|rcpt|recipient|recipient_?id|contact|contact_?id|cust|customer|customer_?id|member|member_?id|mem|eid|enc|enc_?id|email|em|mail|token|tk|hash|hsenc|hsmi)$/i;

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
  const token = { class: 'personal', why: 'a token in its address' } as const;
  if (UUID.test(u.pathname + u.search)) return token;
  for (const [k, v] of u.searchParams) {
    if (SAME_FOR_ALL.test(k)) continue;
    if (ID_KEYS.test(k) && v.length >= 3 && (/\d/.test(v) || v.length >= 8)) return { class: 'personal', why: `an id in its address (${k}=)` };
    if (randomRun(v, 12) || randomRun(k, 16) || /\d{8,}/.test(v)) return token;
  }
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i];
    try {
      seg = decodeURIComponent(seg);
    } catch {}
    // A file name's extension is not part of its token.
    if (i === segs.length - 1) seg = seg.replace(/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i, '');
    if (LONG_HEX.test(seg) || randomRun(seg, 16)) return token;
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
