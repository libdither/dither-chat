/**
 * JPEG XL on the hub (docs/files.md "JPEG XL").
 *
 * - Kept pictures are stored as JPEG XL (MediaPacker): a JPEG is repacked losslessly and comes back byte for byte, a
 *   PNG is stored lossless and comes back with the same pixels. On disk a packed file is `<key>.jxl` beside its
 *   `<key>.mime`, which still names the type it came as.
 * - A device that shows JPEG XL (the app says so with the `dither_jxl` cookie, or the browser's Accept header) gets
 *   the `.jxl`; any other (an older browser, the Android app's notification fetch, the hub itself sending a file on)
 *   gets the file rebuilt as it came (JxlServe).
 * - A JPEG XL someone sent is shown the same way: as is where it can be, else as a JPEG or PNG.
 * - Pictures going out to a network that would not show a JPEG XL go as a JPEG or PNG (uploads.ts compat).
 *
 * The work is done by libjxl's own cjxl and djxl, found on PATH, in DITHER_JXL_DIR, or built with nix. Without them
 * nothing is packed and every file goes as it is. DITHER_JXL=0 turns it all off.
 */
import { existsSync, openSync, readSync, closeSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isJxl, repackedJpeg } from './jxlformat.ts';
import type { Store } from './store.ts';
import { noteWork } from './stalls.ts';


/** The cookie the web app sets when its browser shows JPEG XL (web jxl.ts). */
const JXL_COOKIE = 'dither_jxl';

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function readHead(path: string, n: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const b = new Uint8Array(n);
    return b.subarray(0, readSync(fd, b, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

/** PNG's width, height and whether it has alpha (colour type 4 or 6, or a tRNS chunk before the image). */
function pngHeader(b: Uint8Array): { width: number; height: number; alpha: boolean } | null {
  if (b.length < 33 || b[0] !== 0x89 || ascii(b, 1, 4) !== 'PNG' || ascii(b, 12, 16) !== 'IHDR') return null;
  const idat = ascii(b, 0, Math.min(b.length, 65536)).indexOf('IDAT');
  const trns = ascii(b, 0, idat > 0 ? idat : Math.min(b.length, 65536)).includes('tRNS');
  return { width: u32be(b, 16), height: u32be(b, 20), alpha: b[25] === 4 || b[25] === 6 || trns };
}

// ------------------------------------------------------------------ the tools

export interface JxlTools {
  cjxl: string;
  djxl: string;
}

const both = (dir: string): JxlTools | null => (existsSync(join(dir, 'cjxl')) && existsSync(join(dir, 'djxl')) ? { cjxl: join(dir, 'cjxl'), djxl: join(dir, 'djxl') } : null);

/**
 * cjxl and djxl: from DITHER_JXL_DIR, else PATH, else (`nix`) libjxl built with nix, as the Signal adapter finds
 * signal-cli. Null when there are none, or DITHER_JXL=0.
 */
export async function findJxl(o: { nix?: boolean } = {}): Promise<JxlTools | null> {
  if (process.env.DITHER_JXL === '0') return null;
  if (process.env.DITHER_JXL_DIR) return both(process.env.DITHER_JXL_DIR);
  const cjxl = Bun.which('cjxl');
  const djxl = Bun.which('djxl');
  if (cjxl && djxl) return { cjxl, djxl };
  if (!o.nix) return null;
  const nix = Bun.which('nix') ?? (existsSync('/run/current-system/sw/bin/nix') ? '/run/current-system/sw/bin/nix' : null);
  if (!nix) return null;
  try {
    const p = Bun.spawn([nix, 'build', 'nixpkgs#libjxl.bin', '--no-link', '--print-out-paths'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 600_000 });
    const out = (await new Response(p.stdout).text()).trim().split('\n').pop() ?? '';
    if ((await p.exited) !== 0 || !out) return null;
    return both(join(out, 'bin'));
  } catch {
    return null;
  }
}

/** Runs a tool; true when it exited 0. `low`: at a low priority, for work in the background. */
async function run(argv: string[], o: { low?: boolean; ms?: number } = {}): Promise<boolean> {
  const nice = o.low ? Bun.which('nice') : null;
  try {
    const p = Bun.spawn(nice ? [nice, '-n', '15', ...argv] : argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: o.ms ?? 120_000 });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

/** A name beside `base` for a tool's output: djxl and cjxl go by the extension. Swept as `*.tmp.<ext>` (housekeeping.ts). */
const scratch = (base: string, ext: string) => `${base}.${randomBytes(6).toString('hex')}.tmp.${ext}`;

// ------------------------------------------------------------------ packing and rebuilding

/** Types the packer stores as JPEG XL. */
export const PACKED_TYPES = new Set(['image/jpeg', 'image/png']);
/** Smaller files stay as they are: the gain is a few hundred bytes. */
const PACK_MIN = 4096;
/** A file is kept packed only when that saves a tenth or more. */
const PACK_GAIN = 0.9;

/**
 * Stores `file` (a JPEG or PNG, `mime`) as `<file>.jxl` and removes it, when that comes back as it was and is smaller.
 * A JPEG must come back byte for byte; a PNG with the same size (cjxl -d 0 is lossless). An animated PNG stays.
 */
export async function pack(t: JxlTools, file: string, mime: string): Promise<{ packed: boolean; before: number; after: number }> {
  const st = statSync(file);
  const none = { packed: false, before: st.size, after: st.size };
  const head = readHead(file, 65536);
  const jpeg = mime === 'image/jpeg';
  if (jpeg ? !(head[0] === 0xff && head[1] === 0xd8) : !pngHeader(head)) return none;
  if (!jpeg && ascii(head, 0, head.length).indexOf('acTL') >= 0) return none;
  const tmp = scratch(file, 'jxl');
  const back = scratch(file, jpeg ? 'jpg' : 'png');
  try {
    const args = jpeg ? ['--lossless_jpeg=1'] : ['-d', '0'];
    if (!(await run([t.cjxl, file, tmp, '-e', '7', '--num_threads=1', ...args], { low: true }))) return none;
    const after = statSync(tmp).size;
    if (after > st.size * PACK_GAIN) return { ...none, after };
    if (!(await run([t.djxl, tmp, back, '--num_threads=1'], { low: true }))) return none;
    if (jpeg) {
      if (!Buffer.from(readFileSync(back)).equals(readFileSync(file))) return none;
    } else {
      const a = pngHeader(head);
      const b = pngHeader(readHead(back, 65536));
      if (!a || !b || a.width !== b.width || a.height !== b.height) return none;
    }
    renameSync(tmp, file + '.jxl');
    // The cache is trimmed least recently used first (housekeeping.ts): packing is not a use.
    utimesSync(file + '.jxl', st.atime, st.mtime);
    rmSync(file, { force: true });
    return { packed: true, before: st.size, after };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(back, { force: true });
  }
}

/** A packed file as it came: the JPEG it was repacked from, else the PNG. */
export async function rebuild(t: JxlTools, jxl: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const jpeg = repackedJpeg(readHead(jxl, 1024 * 1024));
  const out = scratch(jxl, jpeg ? 'jpg' : 'png');
  try {
    return (await run([t.djxl, jxl, out])) ? { bytes: new Uint8Array(readFileSync(out)), mime: jpeg ? 'image/jpeg' : 'image/png' } : null;
  } finally {
    rmSync(out, { force: true });
  }
}

/** A PNG past this, of a picture with no transparency, goes as a JPEG instead: a photo as PNG is many megabytes. */
const PNG_MAX = 4 * 1024 * 1024;

/**
 * A JPEG XL file as something every device and network shows: the JPEG it was repacked from, else a PNG, else (a large
 * picture with no transparency) a JPEG. Written to `outBase` plus the extension; null when `src` is no JPEG XL or
 * djxl failed.
 */
export async function toCommon(t: JxlTools, src: string, outBase: string): Promise<{ path: string; mime: string } | null> {
  const head = readHead(src, 1024 * 1024);
  if (!isJxl(head)) return null;
  if (repackedJpeg(head) && (await run([t.djxl, src, outBase + '.jpg']))) return { path: outBase + '.jpg', mime: 'image/jpeg' };
  const png = outBase + '.png';
  if (!(await run([t.djxl, src, png]))) return null;
  const h = pngHeader(readHead(png, 65536));
  if (statSync(png).size > PNG_MAX && h && !h.alpha && (await run([t.djxl, src, outBase + '.jpg', '--jpeg_quality=92']))) {
    rmSync(png, { force: true });
    return { path: outBase + '.jpg', mime: 'image/jpeg' };
  }
  return { path: png, mime: 'image/png' };
}

/** Whether a request comes from a device that shows JPEG XL: the app's cookie, or the browser's Accept header. */
export function takesJxl(req: Request): boolean {
  const cookie = req.headers.get('cookie') ?? '';
  if (new RegExp(`(?:^|;\\s*)${JXL_COOKIE}=1(?:;|$)`).test(cookie)) return true;
  return /(?:^|,)\s*image\/jxl\s*(?:[,;]|$)/i.test(req.headers.get('accept') ?? '');
}

// ------------------------------------------------------------------ serving

/** Rebuilt files kept in memory, so a list drawn again does not run djxl again. */
const KEEP_BYTES = 64 * 1024 * 1024;
/** djxl runs at once for serving at most. */
const AT_ONCE = 2;

/** Packed files rebuilt and JPEG XL turned into JPEG or PNG, for devices that don't show JPEG XL. */
export class JxlServe {
  private kept = new Map<string, { bytes: Uint8Array; mime: string }>();
  private keptBytes = 0;
  private inflight = new Map<string, Promise<{ bytes: Uint8Array; mime: string } | null>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private tools: () => Promise<JxlTools | null>) {}

  /** A packed `<file>.jxl` as it came. */
  rebuilt(key: string, jxl: string) {
    return this.once(`r:${key}`, (t) => rebuild(t, jxl));
  }

  /** A JPEG XL someone sent, as a JPEG or PNG. */
  common(key: string, file: string) {
    return this.once(`c:${key}`, async (t) => {
      const r = await toCommon(t, file, `${file}.${randomBytes(6).toString('hex')}.tmp`);
      if (!r) return null;
      try {
        return { bytes: new Uint8Array(readFileSync(r.path)), mime: r.mime };
      } finally {
        rmSync(r.path, { force: true });
      }
    });
  }

  private async once(id: string, make: (t: JxlTools) => Promise<{ bytes: Uint8Array; mime: string } | null>) {
    const hit = this.kept.get(id);
    if (hit) {
      this.kept.delete(id);
      this.kept.set(id, hit);
      return hit;
    }
    let p = this.inflight.get(id);
    if (!p) {
      p = this.limited(make).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    const r = await p;
    if (r && !this.kept.has(id) && r.bytes.length <= KEEP_BYTES / 4) {
      this.kept.set(id, r);
      this.keptBytes += r.bytes.length;
      for (const [k, v] of this.kept) {
        if (this.keptBytes <= KEEP_BYTES) break;
        this.kept.delete(k);
        this.keptBytes -= v.bytes.length;
      }
    }
    return r;
  }

  private async limited(make: (t: JxlTools) => Promise<{ bytes: Uint8Array; mime: string } | null>) {
    const t = await this.tools();
    if (!t) return null;
    while (this.running >= AT_ONCE) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await make(t);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

// ------------------------------------------------------------------ the packer

/** Files packed per run of the packer, and how long one run may take. */
const BATCH = 50;
const RUN_MS = 20_000;
/** After a walk over every picture, the next one starts this much later. */
const WALK_AGAIN_MS = 60 * 60_000;

/**
 * Walks the pictures media_info knows (mediainfo.ts) and packs the JPEGs and PNGs among them, one at a time at a low
 * priority. Only files under a media_info key: the mail parts and mail images in the same folder are named otherwise.
 */
export class MediaPacker {
  private timer?: Timer;
  private busy = false;
  private stopped = false;
  private nextWalk = 0;
  /** Since start, for the log and tests. */
  packed = 0;
  saved = 0;

  constructor(
    private store: Store,
    private dir: string,
    private tools: () => Promise<JxlTools | null>,
    private log: (msg: string) => void = () => {},
  ) {}

  start(everyMs = 60_000, firstAfterMs = 5 * 60_000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    setTimeout(() => void this.tick(), firstAfterMs);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private meta(k: string): string | null {
    return (this.store.db.query('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | null)?.value ?? null;
  }
  private setMeta(k: string, v: string) {
    this.store.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, v);
  }

  /** One run: up to BATCH files past the cursor, within RUN_MS. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy || this.stopped || now < this.nextWalk) return;
    this.busy = true;
    try {
      const t = await this.tools();
      if (!t) return;
      const until = Date.now() + RUN_MS;
      const cursor = this.meta('media_pack_cursor') ?? '';
      const rows = this.store.db.query(`SELECT key, mime FROM media_info WHERE key > ? AND kind = 'image' AND mime IN ('image/jpeg', 'image/png') ORDER BY key LIMIT ?`).all(cursor, BATCH) as { key: string; mime: string }[];
      if (!rows.length) {
        this.setMeta('media_pack_cursor', '');
        this.nextWalk = now + WALK_AGAIN_MS;
        return;
      }
      for (const r of rows) {
        if (this.stopped || Date.now() > until) return;
        const file = join(this.dir, r.key);
        try {
          if (/^[0-9a-f]{64}$/.test(r.key) && existsSync(file) && existsSync(file + '.mime') && !existsSync(file + '.jxl') && statSync(file).size >= PACK_MIN) {
            noteWork('media pack');
            const p = await pack(t, file, r.mime);
            if (p.packed) {
              this.packed++;
              this.saved += p.before - p.after;
            }
          }
        } catch (e: any) {
          this.log(`media pack: ${e?.message ?? e}`);
        }
        this.setMeta('media_pack_cursor', r.key);
      }
    } finally {
      this.busy = false;
    }
  }
}
