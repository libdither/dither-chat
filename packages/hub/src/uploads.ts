/**
 * Files on their way out (docs/uploads.md): uploaded from a client, handed to an adapter by path, deleted once sent.
 *
 * Each is two files in the folder: `<id>`, the bytes that have arrived, and `<id>.json`, what it is (name, type,
 * size, when last used). The bytes go to disk as they come, never whole into memory. An upload made a piece at a
 * time carries on where it stopped after a dropped connection, since what is on disk is what has arrived. Both
 * survive a restart, so a send waiting on a device, or one a remote adapter is still reading, finds its files
 * afterwards. One unused for an hour goes, and so does anything in the folder that is not an upload.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { attachmentKind, jpegCut, MAX_UPLOAD } from '@dither-chat/protocol';
import { toCommon, type JxlTools } from './jxl.ts';
import { isJxl } from './jxlformat.ts';

/** The end marker a cut picture is closed with (sendqueue.ts, files still coming). */
const JPEG_END = new Uint8Array([0xff, 0xd9]);

/** How long an upload waits unused. */
export const KEEP = 60 * 60_000;


interface Meta {
  v: 1;
  name: string;
  mime: string;
  size: number;
  /** Made, or last written or sent. */
  at: number;
  /** Cut after its last whole layer by a send whose phone stopped (sendqueue.ts): `size` is the cut's, this what the phone had begun. */
  cut?: { from: number; quality: P.CutQuality };
}

/** A name for humans and for the network. Never part of a path here. `decode`: it came URI-encoded (a header). */
export function cleanFileName(raw: string | null, decode = true): string {
  let name = raw ?? '';
  if (decode) {
    try {
      name = decodeURIComponent(name);
    } catch {}
  }
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') return 'file';
  return name.length > 200 ? name.slice(name.length - 200) : name;
}

/** A path inside a picked folder, each part cleaned like a file name; never absolute, never "..". */
export function cleanRelPath(p: string): string {
  return p
    .split(/[\\/]+/)
    .filter((x) => x && x !== '.' && x !== '..')
    .map((x) => cleanFileName(x))
    .join('/');
}

const cleanMime = (mime: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream');
const refuse = (message: string, status: number, extra: object = {}) => Object.assign(new Error(message), { status, ...extra });
const valid = (m: any): m is Meta =>
  !!m && typeof m.name === 'string' && typeof m.mime === 'string' && Number.isSafeInteger(m.size) && m.size > 0 && m.size <= MAX_UPLOAD && typeof m.at === 'number';

function writeAll(fd: number, b: Uint8Array) {
  for (let off = 0; off < b.length; ) off += writeSync(fd, b, off, b.length - off);
}

export class Uploads {
  private items = new Map<string, Meta>();
  /** Pieces being written now: one at a time per upload. */
  private writing = new Set<string>();

  constructor(
    private dir: string,
    now = Date.now(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.load(now);
  }

  /** What the last run left: uploads used within the hour stay, whole or half-made. Everything else goes. */
  private load(now: number) {
    for (const f of readdirSync(this.dir)) {
      const id = f.match(/^([0-9a-f]{24})\.json$/)?.[1];
      if (!id) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
        if (valid(meta) && now - meta.at <= KEEP && statSync(this.path(id)).size <= meta.size) this.items.set(id, meta);
      } catch {}
    }
    for (const f of readdirSync(this.dir)) if (!this.items.has(f.replace(/\.json$/, ''))) rmSync(join(this.dir, f), { recursive: true, force: true });
  }

  private path(id: string) {
    return join(this.dir, id);
  }

  private save(id: string, meta: Meta) {
    const p = join(this.dir, `${id}.json`);
    writeFileSync(p + '.tmp', JSON.stringify(meta), { mode: 0o600 });
    renameSync(p + '.tmp', p);
    this.items.set(id, meta);
  }

  private received(id: string): number {
    try {
      return statSync(this.path(id)).size;
    } catch {
      return 0;
    }
  }

  /** A file already in memory (a forwarded message's). */
  put(bytes: Uint8Array, name: string, mime: string, now = Date.now()): P.UploadView {
    if (bytes.length > MAX_UPLOAD) throw refuse('file too large', 413);
    this.sweep(now);
    const id = randomBytes(12).toString('hex');
    writeFileSync(this.path(id), bytes, { mode: 0o600 });
    this.save(id, { v: 1, name, mime: cleanMime(mime), size: bytes.length, at: now });
    return this.view(id)!;
  }

  /**
   * A whole file in one request, written as it streams in and refused as soon as it passes `cap`. Nothing is kept of
   * one that was too large, empty, or cut off (short of `length`, when the request said how long it is).
   */
  async receive(body: ReadableStream<Uint8Array> | null, name: string, mime: string, o: { cap?: number; length?: number; now?: number } = {}): Promise<P.UploadView> {
    const { cap = MAX_UPLOAD, length, now = Date.now() } = o;
    this.sweep(now);
    const id = randomBytes(12).toString('hex');
    const path = this.path(id);
    const fd = openSync(path, 'wx', 0o600);
    let size = 0;
    let whole = false;
    try {
      if (body) {
        for await (const chunk of body) {
          size += chunk.length;
          if (size > cap) throw refuse('that file is too large', 413);
          writeAll(fd, chunk);
        }
      }
      if (!size) throw refuse('empty file', 400);
      if (length !== undefined && size !== length) throw refuse('the upload was cut off', 400);
      whole = true;
    } finally {
      closeSync(fd);
      if (!whole) rmSync(path, { force: true });
    }
    this.save(id, { v: 1, name, mime: cleanMime(mime), size, at: now });
    return this.view(id)!;
  }

  /** A new upload of `size` bytes, to come a piece at a time (write). */
  start(name: string, mime: string, size: number, now = Date.now()): P.UploadState {
    if (!Number.isSafeInteger(size) || size < 0) throw refuse('how large is it?', 400);
    if (!size) throw refuse('empty file', 400);
    if (size > MAX_UPLOAD) throw refuse(`the hub takes files up to ${MAX_UPLOAD / 1024 / 1024} MB`, 413);
    this.sweep(now);
    const id = randomBytes(12).toString('hex');
    writeFileSync(this.path(id), '', { mode: 0o600 });
    this.save(id, { v: 1, name, mime: cleanMime(mime), size, at: now });
    return this.state(id)!;
  }

  /**
   * The next piece of an upload, at `offset`, which must be how much has arrived: otherwise 409 with { received },
   * where to carry on from. A piece cut off midway keeps what came of it.
   */
  async write(id: string, offset: number, body: ReadableStream<Uint8Array> | null, now = Date.now()): Promise<P.UploadState> {
    const meta = this.items.get(id);
    if (this.sentAlready(id)) throw refuse('it was sent as far as it had come', 410, { sent: true });
    if (!meta) throw refuse('no such upload: it may have expired', 404);
    const have = this.received(id);
    if (this.writing.has(id)) throw refuse('another piece is still being written', 409, { received: have });
    if (offset !== have) throw refuse(`expected offset ${have}`, 409, { received: have });
    this.writing.add(id);
    const fd = openSync(this.path(id), 'a');
    let n = have;
    try {
      if (body) {
        for await (const chunk of body) {
          if (n + chunk.length > meta.size) throw refuse('more bytes than the file has', 413);
          writeAll(fd, chunk);
          n += chunk.length;
        }
      }
    } finally {
      closeSync(fd);
      this.writing.delete(id);
      // Last used now: a slow upload is not swept while it comes. Unless it was cancelled meanwhile.
      if (this.items.has(id)) this.save(id, { ...meta, at: now });
    }
    const st = this.state(id);
    if (!st) throw refuse('that upload was cancelled', 404);
    if (st.received === st.size) this.onWhole?.(id);
    return st;
  }

  /**
   * Sent already with a held send, cut as far as it had come or gone with it (sendqueue.ts, files still coming): a phone asking after it
   * or sending more of it is told so (410 `sent`), and stops, rather than beginning it again.
   */
  sentAlready(id: string): boolean {
    const meta = this.items.get(id);
    return !!meta?.cut || (!meta && !!this.sent?.(id));
  }

  /** Told when an upload has all of its bytes (a send waiting on it goes, sendqueue.ts). */
  onWhole: ((id: string) => void) | null = null;
  /** Whether an upload no longer here went with a send (sendqueue.ts, files still coming): its next piece is 410, not 404. */
  sent: ((id: string) => boolean) | null = null;

  /** How long since this upload was last written to (or made, or sent). */
  idle(id: string, now = Date.now()): number {
    const m = this.items.get(id);
    return m ? now - m.at : Infinity;
  }

  private cuts = new Map<string, { received: number; cut: ReturnType<typeof jpegCut> }>();
  /** Where what has come of this upload could be cut (a progressive JPEG after its last whole layer), worked out once per size. */
  private cutOf(id: string) {
    const m = this.items.get(id);
    if (!m || this.writing.has(id)) return null;
    const received = this.received(id);
    const kept = this.cuts.get(id);
    if (kept?.received === received) return kept.cut;
    let cut: ReturnType<typeof jpegCut> = null;
    if (m.mime === 'image/jpeg' && received > 0 && received < m.size) {
      try {
        cut = jpegCut(new Uint8Array(readFileSync(this.path(id))), m.size);
      } catch {}
    }
    this.cuts.set(id, { received, cut });
    return cut;
  }

  /** How good this upload would be if cut now; null when it cannot be (not a progressive JPEG, or not even its first picture). */
  cuttable(id: string): P.CutQuality | null {
    return this.cutOf(id)?.quality ?? null;
  }

  /** Cut it after its last whole layer, with an end marker: a whole JPEG from now on, which goes as the file. */
  cut(id: string, now = Date.now()): boolean {
    const m = this.items.get(id);
    const c = this.cutOf(id);
    if (!m || !c) return false;
    // In place: what came stays up to the cut, and the end marker goes after it.
    truncateSync(this.path(id), c.keep);
    appendFileSync(this.path(id), JPEG_END);
    this.save(id, { ...m, size: c.keep + JPEG_END.length, at: now, cut: { from: m.size, quality: c.quality } });
    this.cuts.delete(id);
    return true;
  }

  state(id: string): P.UploadState | null {
    const m = this.items.get(id);
    return m ? { id, name: m.name, mime: m.mime, size: m.size, received: this.received(id) } : null;
  }

  private view(id: string): P.UploadView | null {
    const st = this.state(id);
    if (!st) return null;
    const { received: _r, ...v } = st;
    return v;
  }

  /** The files behind these ids, or null if any of them is gone or has not all arrived. Each counts as used now. */
  get(ids: string[], now = Date.now()): P.OutgoingAttachment[] | null {
    const out: P.OutgoingAttachment[] = [];
    for (const id of ids) {
      const m = this.items.get(id);
      if (!m || this.writing.has(id) || this.received(id) !== m.size) return null;
      out.push({ path: this.path(id), name: m.name, mime: m.mime, size: m.size, kind: attachmentKind(m.mime) });
    }
    for (const id of ids) this.save(id, { ...this.items.get(id)!, at: now });
    return out;
  }

  /** The names of these uploads, or null if any is gone or has not all arrived. Not counted as a use. */
  names(ids: string[]): string[] | null {
    const out: string[] = [];
    for (const id of ids) {
      const m = this.items.get(id);
      if (!m || this.writing.has(id) || this.received(id) !== m.size) return null;
      out.push(m.name);
    }
    return out;
  }

  remove(ids: string[]) {
    for (const id of ids) {
      this.cuts.delete(id);
      if (!this.items.delete(id)) continue;
      rmSync(this.path(id), { force: true });
      rmSync(join(this.dir, `${id}.json`), { force: true });
      for (const ext of ['jpg', 'png']) rmSync(`${this.path(id)}.common.${ext}`, { force: true });
    }
  }

  /**
   * The files as a network that doesn't show JPEG XL takes them (docs/files.md "JPEG XL"): a JPEG XL goes as the JPEG
   * it was repacked from, else a PNG or JPEG (jxl.ts toCommon), written beside its upload and removed with it. Anything
   * else, or everything when there are no tools, as it is.
   */
  async common(files: P.OutgoingAttachment[], tools: JxlTools | null): Promise<P.OutgoingAttachment[]> {
    if (!tools) return files;
    return Promise.all(
      files.map(async (f) => {
        const head = new Uint8Array(12);
        const fd = openSync(f.path, 'r');
        try {
          readSync(fd, head, 0, 12, 0);
        } finally {
          closeSync(fd);
        }
        if (!isJxl(head)) return f;
        const out = await toCommon(tools, f.path, `${f.path}.common`).catch(() => null);
        if (!out) return f;
        const ext = out.mime === 'image/jpeg' ? 'jpg' : 'png';
        const name = /\.jxl$/i.test(f.name) ? f.name.replace(/\.jxl$/i, `.${ext}`) : `${f.name}.${ext}`;
        return { ...f, path: out.path, name, mime: out.mime, size: statSync(out.path).size, kind: 'image' as const };
      }),
    );
  }

  /** Uploads something else still waits to send (a message to send later, sendlater.ts; a send whose files are still coming, sendqueue.ts): the sweep leaves them. */
  held: (() => Set<string>) | null = null;

  sweep(now = Date.now()) {
    const held = this.held?.() ?? null;
    for (const [id, m] of this.items) if (now - m.at > KEEP && !this.writing.has(id) && !held?.has(id)) this.remove([id]);
  }
}
