/**
 * Unpacking an uploaded .zip (a Molly backup folder zipped on the phone, where a browser can't pick a folder).
 * Reads the central directory, Zip64 included, so archives past 4 GB and with more than 65,535 entries work; each entry
 * is streamed out, stored or deflated, and checked against its CRC-32. Paths are cleaned like an upload's
 * (never absolute, never ".."), links and encrypted entries are refused, and the unpacked total is capped.
 */
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readSync, fstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  dir: boolean;
  link: boolean;
}

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return got === len ? b : b.subarray(0, got);
}

/** The entries of a zip, from its central directory. Throws when it isn't one. */
export function zipEntries(path: string): ZipEntry[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 65_535 + 20);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (u32(tail, i) === 0x06054b50) {
        e = i;
        break;
      }
    if (e < 0) throw new Error('this is not a zip file');
    let count = u16(tail, e + 10);
    let cdSize = u32(tail, e + 12);
    let cdOffset = u32(tail, e + 16);
    // Zip64: the locator sits right before the end record and points at the real counts.
    if (e >= 20 && u32(tail, e - 20) === 0x07064b50) {
      const z = readAt(fd, u64(tail, e - 20 + 8), 56);
      if (u32(z, 0) !== 0x06064b50) throw new Error('a broken Zip64 record');
      count = u64(z, 32);
      cdSize = u64(z, 40);
      cdOffset = u64(z, 48);
    }
    if (cdOffset + cdSize > size) throw new Error('the zip is cut short (its directory is past the end)');
    const cd = readAt(fd, cdOffset, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new Error('a broken zip directory');
      const madeBy = u16(cd, p + 4) >> 8;
      const flags = u16(cd, p + 8);
      const method = u16(cd, p + 10);
      const crc = u32(cd, p + 16);
      let compressed = u32(cd, p + 20);
      let size = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const attrs = u32(cd, p + 38);
      let offset = u32(cd, p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
      // Zip64 sizes and offset, for the fields that overflowed, in this order.
      let x = p + 46 + nameLen;
      const end = x + extraLen;
      while (x + 4 <= end) {
        const id = u16(cd, x);
        const len = u16(cd, x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
          if (compressed === 0xffffffff) (compressed = u64(cd, q)), (q += 8);
          if (offset === 0xffffffff) offset = u64(cd, q);
        }
        x += 4 + len;
      }
      const mode = madeBy === 3 ? attrs >>> 16 : 0;
      out.push({ name, method, flags, crc, compressed, size, offset, dir: name.endsWith('/'), link: (mode & 0o170000) === 0o120000 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Unpack `zip` into `outDir`, each entry at `clean(entry name)` (empty: skipped). `onBytes` hears the compressed bytes
 * read so far. Returns the number of files and bytes written.
 */
export async function unzip(
  zip: string,
  outDir: string,
  o: { clean: (name: string) => string; maxBytes: number; onBytes?: (n: number) => void },
): Promise<{ files: number; bytes: number }> {
  const entries = zipEntries(zip);
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > o.maxBytes) throw new Error('the zip unpacks to more than the hub takes');
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  let read = 0;
  const fd = openSync(zip, 'r');
  try {
    for (const e of entries) {
      const rel = o.clean(e.name);
      if (!rel) continue;
      if (e.dir) {
        mkdirSync(join(outDir, rel), { recursive: true, mode: 0o700 });
        continue;
      }
      if (e.link) throw new Error(`${rel} is a link; zip the folder without links`);
      if (e.flags & 1) throw new Error(`${rel} is encrypted in the zip; zip it without a password`);
      if (e.method !== 0 && e.method !== 8) throw new Error(`${rel} is packed a way the hub can't unpack (method ${e.method})`);
      if (seen.has(rel)) throw new Error(`${rel} is in the zip twice`);
      seen.add(rel);
      const head = readAt(fd, e.offset, 30);
      if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw new Error(`a broken entry (${rel})`);
      const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
      const dest = join(outDir, rel);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      let crc = 0;
      let n = 0;
      const check = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          crc = crc32(chunk, crc);
          n += chunk.length;
          if (n > e.size) return cb(new Error(`${rel} unpacks to more than the zip says`));
          cb(null, chunk);
        },
      });
      const src = e.compressed ? createReadStream(zip, { start, end: start + e.compressed - 1 }) : null;
      src?.on('data', (c) => o.onBytes?.((read += c.length)));
      const out = createWriteStream(dest, { mode: 0o600 });
      if (!src) out.end();
      else if (e.method === 8) await pipeline(src, createInflateRaw(), check, out);
      else await pipeline(src, check, out);
      if (src === null) await new Promise((r) => out.on('close', r));
      if (n !== e.size || (crc >>> 0) !== e.crc) throw new Error(`${rel} came out damaged (its checksum doesn't match)`);
      files++;
      bytes += n;
    }
  } finally {
    closeSync(fd);
  }
  return { files, bytes };
}
