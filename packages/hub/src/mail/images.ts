/**
 * Remote images in mail, through the hub (docs/mail-design.md §7). The sanitiser rewrites each image URL of a message
 * whose images you allowed to `/api/mail/img/<token>`; the token is an HMAC (the hub's media key) of the message id
 * and the URL, so the proxy fetches only URLs that appear in a message you allowed.
 *
 * The fetch goes to the public internet only: every address the name resolves to is checked, the request is sent to
 * the address that was checked (so the name cannot be pointed at this machine in between), and every redirect is
 * checked again (fetchsafe.ts). No cookies, no Referer, a generic User-Agent, at most 10 MB, and the answer is kept
 * only if its bytes are an image. It is served with the sandbox CSP and nosniff, from the media cache for 7 days.
 *
 * Images are fetched when a page shows them, never on arrival: fetching ahead would tell senders the address is
 * read. A pixel fetched through the hub still reports the open; the sanitiser drops pixel-shaped images always.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fetchPublicToFile, type Lookup } from '../fetchsafe.ts';
import { SANDBOX_CSP } from '../mediaheaders.ts';
import { isPrivateAddress } from '../webpush.ts';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_KEEP_MS = 7 * 86_400_000;
/** What the proxy says it is: a browser, not this hub. */
export const PROXY_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (key: string, messageId: string, url: string) => createHmac('sha256', key).update(`mail-img\n${messageId}\n${url}`).digest('base64url').slice(0, 22);

/** `/api/mail/img/<message>.<url>.<signature>` for one image of one message. */
export function imageToken(key: string, messageId: string, url: string): string {
  return `${messageId}.${b64(url)}.${sign(key, messageId, url)}`;
}

/** The message and URL a token was made for, or null when it was not made here. */
export function readImageToken(key: string, token: string): { messageId: string; url: string } | null {
  const m = token.match(/^([\w-]+)\.([\w-]+)\.([\w-]{22})$/);
  if (!m) return null;
  const url = Buffer.from(m[2], 'base64url').toString('utf8');
  const want = Buffer.from(sign(key, m[1], url));
  const got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { messageId: m[1], url };
}

/** An image's type by its bytes; null when they are not one a browser shows (SVG is not let through). */
export function imageType(head: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  if (ascii(0, 2) === 'BM' && head.length > 14) return 'image/bmp';
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return 'image/x-icon';
  return null;
}

async function defaultLookup(h: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  return (await lookup(h, { all: true })).map((r) => r.address);
}

/** Thrown when a name points anywhere but the public internet. */
export class PrivateAddressError extends Error {
  status = 403;
}

/**
 * fetch(), but to the address the name was checked at: every address it resolves to must be public, and the request
 * is sent to the first of them, with the name in Host and in TLS's server name. A name that resolves to something
 * else by the time the request goes out (DNS rebinding) changes nothing. Redirects are left to the caller.
 */
export function pinnedFetch(o: { lookup?: Lookup; fetch?: typeof fetch; headers?: Record<string, string> } = {}): typeof fetch {
  const lookup = o.lookup ?? defaultLookup;
  const base = o.fetch ?? fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PrivateAddressError('not http');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [host] : host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : await lookup(host).catch(() => [] as string[]);
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new PrivateAddressError(`${host} is not a public address`);
    const ip = addrs[0];
    const at = new URL(u.href);
    at.hostname = ip.includes(':') ? `[${ip}]` : ip;
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(o.headers ?? {})) headers.set(k, v);
    headers.set('host', u.host);
    return base(at.href, {
      ...init,
      headers,
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      proxy: false,
      ...(u.protocol === 'https:' && !isIP(host) ? { tls: { serverName: host } } : {}),
    } as RequestInit);
  }) as typeof fetch;
}

export interface ImageProxyOpts {
  /** The media cache (DATA/media-cache): kept images go there, under keys of their own. */
  dir: string;
  lookup?: Lookup;
  /** What reaches the internet (tests and the demo put their own here). It is given the checked address. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Fetches, keeps and serves remote images for mail. */
export class ImageProxy {
  private inflight = new Map<string, Promise<Response>>();
  constructor(private o: ImageProxyOpts) {}

  private file(url: string) {
    return join(this.o.dir, `mailimg-${new Bun.CryptoHasher('sha256').update(url).digest('hex')}`);
  }

  /** The image behind `url`: from the cache, else fetched now. Errors are plain answers (403, 413, 415, 502). */
  async serve(url: string): Promise<Response> {
    const file = this.file(url);
    const now = (this.o.now ?? Date.now)();
    if (existsSync(file) && existsSync(file + '.mime')) {
      if (now - statSync(file + '.mime').mtimeMs < IMAGE_KEEP_MS) return this.answer(file, readFileSync(file + '.mime', 'utf8'));
      rmSync(file, { force: true });
      rmSync(file + '.mime', { force: true });
    }
    // One fetch for a URL at a time: a mail with the same logo twice asks once.
    let p = this.inflight.get(url);
    if (!p) {
      p = this.fetchInto(url, file).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    const r = await p;
    return r.ok ? this.answer(file, readFileSync(file + '.mime', 'utf8')) : r.clone();
  }

  private async fetchInto(url: string, file: string): Promise<Response> {
    if (!existsSync(this.o.dir)) mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.fetch`;
    const get = pinnedFetch({ lookup: this.o.lookup, fetch: this.o.fetch, headers: { 'user-agent': PROXY_UA, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8', 'accept-language': 'en' } });
    let r;
    try {
      r = await fetchPublicToFile(url, tmp, { maxBytes: IMAGE_MAX_BYTES, timeoutMs: 20_000, allowPrivate: false, lookup: this.o.lookup, fetch: get });
    } catch (e) {
      rmSync(tmp, { force: true });
      if (e instanceof PrivateAddressError) return new Response('not a public address', { status: 403 });
      return new Response('the image could not be fetched', { status: 502 });
    }
    if (!r.ok) return new Response(r.error, { status: r.status });
    const head = new Uint8Array(readFileSync(tmp).subarray(0, 32));
    const type = imageType(head);
    if (!type) {
      rmSync(tmp, { force: true });
      return new Response('not an image', { status: 415 });
    }
    renameSync(tmp, file);
    writeFileSync(file + '.mime', type, { mode: 0o600 });
    return new Response(null, { status: 204 });
  }

  private answer(file: string, type: string): Response {
    return new Response(Bun.file(file), {
      headers: {
        'content-type': type,
        'cache-control': 'private, max-age=604800',
        'x-content-type-options': 'nosniff',
        'content-security-policy': SANDBOX_CSP,
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  }
}
