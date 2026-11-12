/**
 * Headers for attachment bytes served from the hub's own origin (server.ts fetchMedia), and for other bytes someone
 * else chose (an account's log, an export).
 *
 * The bytes and their type come from other people's messages. Opened in a tab, an HTML, SVG or XML attachment would run
 * as script on this origin, with the signed-in session and the whole API. So every response carries `nosniff` and a
 * CSP with `sandbox` (an opaque origin, no script, no forms, no plugins) that loads nothing but the file itself, and
 * anything a browser could run as a page is a download.
 *
 * Inline is an allowlist, not a denylist (protocol showsInline): images other than SVG, video, audio, PDF and plain
 * text. A type nobody listed is a download. Chromium's and Firefox's PDF viewers show a PDF under the sandbox, and run
 * its script, if any, in their own origin.
 */
import { showsInline } from '@dither-chat/protocol';
import { genericType } from './fileinfo.ts';

/** Every response: a document opened in a tab gets an opaque origin and no script, and loads only the file itself. */
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
/**
 * Video and audio opened in a tab: the browser's own player loads the file again in CORS mode, which fails from an
 * opaque origin, so these keep the hub's. Still no script, and the page is one the browser built, not the file.
 */
export const PLAYER_CSP = SANDBOX_CSP.replace('sandbox;', 'sandbox allow-same-origin;');

/** For other text someone else chose (an account's log, an export). */
export const SAFE_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': SANDBOX_CSP } as const;

const TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** The type as it goes into content-type: as given when it is a plain `type/subtype` (with parameters), else opaque bytes. */
export function safeMime(mime: string | null | undefined): string {
  const m = (mime ?? '').trim();
  const essence = m.split(';')[0].trim().toLowerCase();
  if (!TYPE.test(essence) || !/^[\x20-\x7e]*$/.test(m)) return 'application/octet-stream';
  return m;
}

/** True when a browser may show this type in a top-level tab or as <img>/<video>/<audio> without it being active content. */
export function inlineType(mime: string): boolean {
  return showsInline(safeMime(mime));
}

const EXT: Record<string, string> = { 'text/html': 'html', 'application/xhtml+xml': 'xhtml', 'image/svg+xml': 'svg', 'application/xml': 'xml', 'text/xml': 'xml', 'application/pdf': 'pdf', 'text/plain': 'txt' };

/** A name safe inside a header and a filesystem: no control characters, slashes or quotes, no leading dots, short. */
export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\\/"';<>|:*?%]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return Array.from(n).slice(0, 100).join('').trim();
}

/** The file name a media URL carries, if it carries one. */
function urlName(raw: string): string {
  try {
    if (raw.startsWith('file://')) return decodeURIComponent(raw.slice('file://'.length)).split('/').pop() ?? '';
    if (/^https?:\/\//i.test(raw)) return decodeURIComponent(new URL(raw).pathname.split('/').pop() ?? '');
  } catch {}
  return '';
}

/** `attachment; filename="..."; filename*=UTF-8''...` (RFC 6266 / 5987). `key`: the cache key, for a name when the URL has none. */
export function attachmentDisposition(raw: string, key: string, mime: string): string {
  const essence = safeMime(mime).split(';')[0].trim().toLowerCase();
  const name = safeFilename(urlName(raw)) || `attachment-${key.slice(0, 12)}.${EXT[essence] ?? 'bin'}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * How long a device keeps media. A signed path stands for one stored URL (server.ts mediaSigner), whose bytes the hub
 * keeps once fetched, an expired Discord link's included (fetchMedia): the same path never means other bytes. So a
 * year, and no revalidation on reload; the browser's own eviction comes first.
 */
export const MEDIA_CACHE = 'private, max-age=31536000, immutable';
/**
 * Bytes of no stated type are served as what they are once the hub has looked (mediainfo.ts, docs/files.md), under the
 * same path: a day, so a device that fetched them before then gets the type within one.
 */
export const UNTYPED_CACHE = 'private, max-age=86400';

/** Every header of a media response. `raw` is the stored URL, `key` its cache key. */
export function mediaHeaders(raw: string, key: string, mime: string): Record<string, string> {
  const type = safeMime(mime);
  const inline = inlineType(type);
  return {
    'content-type': type,
    'cache-control': genericType(type) ? UNTYPED_CACHE : MEDIA_CACHE,
    'x-content-type-options': 'nosniff',
    'content-security-policy': inline && /^(video|audio)\//i.test(type) ? PLAYER_CSP : SANDBOX_CSP,
    ...(inline ? {} : { 'content-disposition': attachmentDisposition(raw, key, type) }),
  };
}

/** A type for a file on disk with none recorded and no telling name: by its first bytes, for the kinds a browser shows. */
export function sniffMime(head: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  return null;
}
