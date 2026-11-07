/**
 * Headers for attachment bytes served from the hub's own origin (server.ts fetchMedia).
 *
 * The bytes and their type come from other people's messages. Opened in a tab, an HTML, SVG or XML attachment would run
 * as script on this origin, with the signed-in session and the whole API. So every response carries `nosniff` and
 * `Content-Security-Policy: sandbox` (no allow-* tokens: no script, no forms, no plugins, an opaque origin), and
 * anything that is not a plain image, video or audio file is a download.
 *
 * Inline is an allowlist, not a denylist: image/*, video/*, audio/* except SVG and other +xml types, which can hold
 * script. PDF is a download too (it can run script in a viewer). A type nobody listed is a download.
 */

const TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** The type as it goes into content-type: as given when it is a plain `type/subtype` (with parameters), else opaque bytes. */
export function safeMime(mime: string | null | undefined): string {
  const m = (mime ?? '').trim();
  const essence = m.split(';')[0].trim().toLowerCase();
  if (!TYPE.test(essence) || !/^[\x20-\x7e]*$/.test(m)) return 'application/octet-stream';
  return m;
}

/** True when a browser may render this type in a top-level tab or as <img>/<video>/<audio> without it being active content. */
export function inlineType(mime: string): boolean {
  const essence = safeMime(mime).split(';')[0].trim().toLowerCase();
  const [top, sub] = essence.split('/');
  if (top !== 'image' && top !== 'video' && top !== 'audio') return false;
  return !sub.includes('xml') && !sub.includes('html');
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

/** Every header of a media response. `raw` is the stored URL, `key` its cache key. */
export function mediaHeaders(raw: string, key: string, mime: string, cache = 'private, max-age=604800, immutable'): Record<string, string> {
  const type = safeMime(mime);
  return {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    ...(inlineType(type) ? {} : { 'content-disposition': attachmentDisposition(raw, key, type) }),
  };
}
