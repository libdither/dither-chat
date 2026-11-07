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
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { attachmentKind, MAX_UPLOAD } from '@dither-chat/protocol';

/** How long an upload waits unused. */
export const KEEP = 60 * 60_000;

/** An upload's id: also its file name here. */
export const UPLOAD_ID = /^[0-9a-f]{24}$/;

interface Meta {
  v: 1;
  name: string;
  mime: string;
  size: number;
  /** Made, or last written or sent. */
  at: number;
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
    return st;
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

  remove(ids: string[]) {
    for (const id of ids) {
      if (!this.items.delete(id)) continue;
      rmSync(this.path(id), { force: true });
      rmSync(join(this.dir, `${id}.json`), { force: true });
    }
  }

  sweep(now = Date.now()) {
    for (const [id, m] of this.items) if (now - m.at > KEEP && !this.writing.has(id)) this.remove([id]);
  }
}
