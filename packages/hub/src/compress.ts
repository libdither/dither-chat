/**
 * Compressing text responses. /api/bootstrap is several megabytes of JSON on a real hub, and a phone fetches it over
 * the tailnet on every start: compressed it is a sixth of that. zstd where the client takes it (Chromium 123+,
 * Firefox 126+), else gzip. Media is already compressed and passes through.
 *
 * The web build's own files are compressed once, hard, and kept (PackedFiles): they are the same bytes on every
 * request, so level 19 costs nothing per request where level 3 cost a little each time and sent a sixth more.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const TEXT = /^(application\/(json|javascript|manifest\+json|xml)|text\/|image\/svg\+xml)/;
const MIN_BYTES = 1024;
/**
 * zstd's window, at most 4 MB: browsers take up to 8 MB in a zstd response (RFC 9659). Its default at level 3 is
 * 2 MB, less than a bootstrap at full size (4.4 to 5.4 MB), so an id or a name repeated further back than that (a
 * conversation's id in `edges`, then again in `conversations`) was sent again in full. With 4 MB the bootstrap goes
 * out 4% smaller for about 3 ms more (docs/perf.md "The bootstrap's window"). zstd fits the window to a smaller
 * answer by itself, so those come out byte for byte as before.
 */
const WINDOW_LOG = 22;
const zstd = promisify((zlib as unknown as { zstdCompress: (b: Uint8Array, o: object, cb: (e: Error | null, r: Buffer) => void) => void }).zstdCompress);
const ZSTD = (zlib as unknown as { constants: Record<string, number> }).constants;
/** zstd at `level` with the window above, on a thread of the pool, not the hub's. */
const zstdAt = (raw: Uint8Array, level: number) => zstd(raw, { params: { [ZSTD.ZSTD_c_compressionLevel]: level, [ZSTD.ZSTD_c_windowLog]: WINDOW_LOG } });

type Encoding = 'zstd' | 'gzip';

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
  // zstd on a thread of the pool, not the hub's: a bootstrap is megabytes, a few hundred ms to compress.
  const body = new Uint8Array(enc === 'zstd' ? await zstdAt(raw, 3) : Bun.gzipSync(raw, { level: 4 }));
  headers.set('content-encoding', enc);
  headers.delete('content-length');
  // What the client reads once unpacked, which no other header says: a first start counts its bootstrap against it.
  headers.set('x-uncompressed-length', String(raw.byteLength));
  return new Response(body, { status: res.status, headers });
}

/**
 * The web build's text files, by extension, and its wasm (the photo packer's jpegtran, a fifth of its size packed):
 * what PackedFiles keeps. Source maps are left to compress(): only DevTools asks.
 */
const PACKABLE = /\.(js|mjs|css|html|json|webmanifest|svg|txt|xml|wasm)$/;
/** zstd's hardest level short of its "ultra" ones: about 300 ms a megabyte here, once a file; the client unpacks it as fast as level 3. */
const PACK_LEVEL = 19;

/**
 * The web build's files, packed once with zstd at level 19 and kept in memory (docs/perf.md "The web build on the
 * wire"): the startup script and stylesheet go out a sixth smaller than at level 3, which over a slow phone link is the
 * longest wait before the app runs. Each is kept with the size and change time it was packed from, so a new build is
 * never answered with an old file's bytes; one not packed yet (just after a start, or changed since) goes out as any
 * other text, through `compress`, and is packed for the next ask.
 */
export class PackedFiles {
  private ready = new Map<string, { size: number; mtime: number; body: Uint8Array<ArrayBuffer> }>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private running: Promise<void> | null = null;

  /** The packed bytes of `file` as it is now on disk, or null (and packed in the background) when there are none yet. */
  get(file: string, size: number, mtime: number): Uint8Array<ArrayBuffer> | null {
    if (!PACKABLE.test(file) || size < MIN_BYTES) return null;
    const r = this.ready.get(file);
    if (r && r.size === size && r.mtime === mtime) return r.body;
    this.add(file);
    return null;
  }

  /**
   * Packs every text file under `root` in the background, one at a time on the thread pool: what index.html loads
   * first (it and the files it names), then the rest. Resolves when all are packed.
   */
  packAll(root: string): Promise<void> {
    const files: string[] = [];
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(dir, n);
        try {
          if (statSync(p).isDirectory()) walk(p);
          else if (PACKABLE.test(p)) files.push(p);
        } catch {}
      }
    };
    walk(root);
    let named = '';
    try {
      named = readFileSync(join(root, 'index.html'), 'utf8');
    } catch {}
    const first = (p: string) => (p === join(root, 'index.html') || named.includes(p.slice(root.length)) ? 0 : 1);
    for (const f of files.sort((a, b) => first(a) - first(b))) this.add(f);
    return this.idle();
  }

  /** Files packed, their bytes, and their bytes packed. */
  stats(): { files: number; bytes: number; packed: number } {
    let bytes = 0;
    let packed = 0;
    for (const r of this.ready.values()) (bytes += r.size), (packed += r.body.byteLength);
    return { files: this.ready.size, bytes, packed };
  }

  /** Resolves once nothing is waiting to be packed. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private add(file: string) {
    if (this.queued.has(file)) return;
    this.queued.add(file);
    this.queue.push(file);
    this.running ??= this.drain();
  }

  /**
   * Packs what is queued, one file at a time. `running` is cleared in the same step that finds the queue empty, so a
   * file added after that starts a new drain: cleared later (a `.finally`), a file added in between was left queued
   * with nothing to pack it.
   */
  private async drain() {
    // Never done before `running` holds it: with only small files queued it would otherwise end synchronously.
    await null;
    for (let file = this.queue.shift(); file; file = this.queue.shift()) {
      try {
        const st = statSync(file);
        const raw = readFileSync(file);
        if (raw.byteLength >= MIN_BYTES) {
          const body = new Uint8Array(await zstdAt(raw, PACK_LEVEL));
          // Changed while it was packed: the next ask packs it again.
          const now = statSync(file);
          if (now.size === st.size && now.mtimeMs === st.mtimeMs) this.ready.set(file, { size: st.size, mtime: st.mtimeMs, body });
        }
      } catch {
        // Gone, or not readable: served (or not) as before.
      } finally {
        this.queued.delete(file);
      }
    }
    this.running = null;
  }
}
