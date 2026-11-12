/**
 * Compressing text responses. /api/bootstrap is several megabytes of JSON on a real hub, and a phone fetches it over
 * the tailnet on every start: compressed it is a sixth of that. zstd where the client takes it (Chromium 123+,
 * Firefox 126+), else gzip. Media is already compressed and passes through.
 */

const TEXT = /^(application\/(json|javascript|manifest\+json|xml)|text\/|image\/svg\+xml)/;
const MIN_BYTES = 1024;

export type Encoding = 'zstd' | 'gzip';

/** The first of zstd, gzip that the client accepts. Order of preference is ours, not the header's. */
export function pickEncoding(accept: string | null): Encoding | null {
  if (!accept) return null;
  const ok = new Set<string>();
  for (const part of accept.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    ok.add(name.trim());
  }
  if (ok.has('zstd')) return 'zstd';
  if (ok.has('gzip') || ok.has('*')) return 'gzip';
  return null;
}

export async function compress(req: Request, res: Response | undefined): Promise<Response | undefined> {
  if (!res || res.status !== 200 || !res.body || req.method === 'HEAD') return res;
  if (res.headers.has('content-encoding') || res.headers.has('content-range') || /no-transform/.test(res.headers.get('cache-control') ?? '')) return res;
  const type = res.headers.get('content-type') ?? '';
  // An event stream (the calendar's, through /calendar/) never ends: reading it whole would hold it forever.
  if (type.startsWith('text/event-stream') || !TEXT.test(type)) return res;
  const enc = pickEncoding(req.headers.get('accept-encoding'));
  if (!enc) return res;
  const raw = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.append('vary', 'accept-encoding');
  if (raw.byteLength < MIN_BYTES) return new Response(raw, { status: res.status, headers });
  const body = new Uint8Array(enc === 'zstd' ? Bun.zstdCompressSync(raw, { level: 3 }) : Bun.gzipSync(raw, { level: 4 }));
  headers.set('content-encoding', enc);
  headers.delete('content-length');
  return new Response(body, { status: res.status, headers });
}
