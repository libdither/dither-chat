import { chmodSync, renameSync, rmSync } from 'node:fs';
import { resolvesPrivate } from './webpush.ts';

export type Lookup = (host: string) => Promise<string[]>;

/** The most one media fetch may bring in: DITHER_MEDIA_MAX_MB, 500 MB unless told otherwise. */
export const MEDIA_MAX_BYTES = Math.max(1, Number(process.env.DITHER_MEDIA_MAX_MB) || 500) * 1024 * 1024;

export type PublicFetch = { ok: true; mime: string; bytes: number } | { ok: false; status: number; error: string };

/**
 * GET a URL that someone else chose (an embed's image, an avatar a network named) into a file, for the media proxy:
 * the public internet only, every redirect checked again, at most `maxBytes` written, streamed so memory stays flat.
 * The file appears only when the whole body arrived. DITHER_MEDIA_ALLOW_PRIVATE=1 lifts the address check (a
 * homeserver on this machine in a testbed).
 */
export async function fetchPublicToFile(
  raw: string,
  file: string,
  opts: { maxBytes?: number; timeoutMs?: number; allowPrivate?: boolean; lookup?: Lookup; fetch?: typeof fetch } = {},
): Promise<PublicFetch> {
  const max = opts.maxBytes ?? MEDIA_MAX_BYTES;
  const allowPrivate = opts.allowPrivate ?? process.env.DITHER_MEDIA_ALLOW_PRIVATE === '1';
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const get = opts.fetch ?? fetch;
  let url = raw;
  for (let hop = 0; hop <= 5; hop++) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, status: 400, error: 'not a URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, status: 400, error: 'not http' };
    if (u.username || u.password) return { ok: false, status: 400, error: 'credentials in the URL' };
    if (!allowPrivate && (await resolvesPrivate(u.hostname, opts.lookup)).private) return { ok: false, status: 403, error: 'not a public address' };
    const res = await get(url, { redirect: 'manual', signal });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: 502, error: `upstream ${res.status}` };
    }
    if (Number(res.headers.get('content-length') ?? 0) > max) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: 413, error: 'too large' };
    }
    const mime = res.headers.get('content-type') ?? 'application/octet-stream';
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const sink = Bun.file(tmp).writer();
    let bytes = 0;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > max) {
            await reader.cancel().catch(() => {});
            throw new RangeError('too large');
          }
          sink.write(value);
        }
      }
      await sink.end();
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      return { ok: true, mime, bytes };
    } catch (e) {
      await Promise.resolve(sink.end()).catch(() => {});
      rmSync(tmp, { force: true });
      if (e instanceof RangeError) return { ok: false, status: 413, error: 'too large' };
      throw e;
    }
  }
  return { ok: false, status: 502, error: 'too many redirects' };
}
