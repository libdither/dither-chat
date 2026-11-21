/**
 * Opening an SQLCipher 4 database without SQLCipher (docs/import-signal.md, "Reading a Signal Desktop profile"):
 * decrypt it page by page into a plain SQLite file that bun:sqlite reads. Only what Signal Desktop uses: a raw
 * 32-byte key (`PRAGMA key = "x'…'"`) and SQLCipher 4's default settings.
 *
 *   page        ciphertext ‖ IV (16) ‖ HMAC-SHA512 (64); the last 80 bytes are SQLite's reserved space
 *   page 1      starts with the 16-byte salt instead of "SQLite format 3\0"; the rest is encrypted like any page
 *   cipher      AES-256-CBC, no padding, under the raw key
 *   HMAC        HMAC-SHA512 over ciphertext ‖ IV ‖ page number (4 bytes, little-endian), keyed by
 *               PBKDF2-HMAC-SHA512(key, salt XOR 0x3a, 2 rounds, 32 bytes)
 *
 * The write-ahead log beside it (`-wal`) holds the newest pages until SQLite checkpoints them: its frames are
 * encrypted the same way and checksummed as written. Committed frames are applied over the database, as a
 * checkpoint would, so what Desktop saw last is in the copy too.
 *
 * Every page's HMAC is checked. A key that does not open page 1 is a wrong key (WrongKey); a later page that does not
 * authenticate is a damaged copy, and nothing is written.
 */
import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';

export class WrongKey extends Error {
  constructor() {
    super('That key does not open this database.');
  }
}

const SALT = 16;
const IV = 16;
const MAC = 64;
const RESERVE = IV + MAC;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const PAGE_SIZES = [4096, 1024, 2048, 8192, 16384, 32768, 65536];

/** A raw key as Signal Desktop keeps it: 64 hex digits, alone or as x'…'. */
export function parseRawKey(s: string): Buffer | null {
  const m = s.trim().match(/^(?:x')?([0-9a-fA-F]{64})'?$/);
  return m ? Buffer.from(m[1], 'hex') : null;
}

interface Keys {
  key: Buffer;
  macKey: Buffer;
  pageSize: number;
}

function macOf(k: Keys, page: Buffer, pgno: number, start: number): Buffer {
  const n = Buffer.alloc(4);
  n.writeUInt32LE(pgno, 0);
  return createHmac('sha512', k.macKey).update(page.subarray(start, k.pageSize - MAC)).update(n).digest();
}

/** One page, decrypted in place of its ciphertext: page 1 gets SQLite's header back, the reserved bytes are zeroed. */
function decryptPage(k: Keys, page: Buffer, pgno: number): Buffer {
  const start = pgno === 1 ? SALT : 0;
  const end = k.pageSize - RESERVE;
  if (!timingSafeEqual(macOf(k, page, pgno, start), page.subarray(k.pageSize - MAC))) {
    if (pgno === 1) throw new WrongKey();
    throw new Error(`page ${pgno} does not authenticate: the copy is damaged (copied while Signal was writing it?)`);
  }
  const d = createDecipheriv('aes-256-cbc', k.key, page.subarray(end, end + IV));
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(page.subarray(start, end)), d.final()]);
  const out = Buffer.alloc(k.pageSize);
  if (pgno === 1) SQLITE_HEADER.copy(out, 0);
  plain.copy(out, start);
  if (pgno === 1) {
    // Read and write versions 1: a plain rollback-journal database, so opening the copy needs no -wal or -shm.
    out[18] = 1;
    out[19] = 1;
  }
  return out;
}

function readAt(fd: number, n: number, pos: number): Buffer {
  const b = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const r = readSync(fd, b, got, n - got, pos + got);
    if (r === 0) break;
    got += r;
  }
  return got === n ? b : b.subarray(0, got);
}

/** The keys for this file: the salt is its first 16 bytes; the page size is whichever makes page 1 authenticate. */
function keysFor(fd: number, key: Buffer): Keys {
  if (key.length !== 32) throw new Error('a database key is 32 bytes (64 hex digits)');
  const head = readAt(fd, 65536, 0);
  if (head.length < 1024) throw new Error('this database is too short to be one');
  if (head.subarray(0, 16).equals(SQLITE_HEADER)) throw new Error('this database is not encrypted');
  const salt = head.subarray(0, SALT);
  const macKey = pbkdf2Sync(key, Buffer.from(salt.map((b) => b ^ 0x3a)), 2, 32, 'sha512');
  for (const pageSize of PAGE_SIZES) {
    if (head.length < pageSize) continue;
    const k = { key, macKey, pageSize };
    if (timingSafeEqual(macOf(k, head, 1, SALT), head.subarray(pageSize - MAC, pageSize))) return k;
  }
  throw new WrongKey();
}

/** The WAL's committed frames, newest last, and the database size the last commit left (in pages). */
function walFrames(walPath: string, k: Keys): { frames: Map<number, number>; pages: number | null; fd: number | null } {
  const frames = new Map<number, number>();
  if (!existsSync(walPath)) return { frames, pages: null, fd: null };
  const fd = openSync(walPath, 'r');
  const size = fstatSync(fd).size;
  const head = readAt(fd, 32, 0);
  const magic = head.length === 32 ? head.readUInt32BE(0) : 0;
  if ((magic & 0xfffffffe) !== 0x377f0682 || head.readUInt32BE(8) !== k.pageSize) return (closeSync(fd), { frames, pages: null, fd: null });
  const big = (magic & 1) === 1;
  const word = (b: Buffer, i: number) => (big ? b.readUInt32BE(i) : b.readUInt32LE(i));
  const sum = (b: Buffer, s: [number, number]): [number, number] => {
    let [s0, s1] = s;
    for (let i = 0; i < b.length; i += 8) {
      s0 = (s0 + word(b, i) + s1) >>> 0;
      s1 = (s1 + word(b, i + 4) + s0) >>> 0;
    }
    return [s0, s1];
  };
  let s = sum(head.subarray(0, 24), [0, 0]);
  if (s[0] !== head.readUInt32BE(24) || s[1] !== head.readUInt32BE(28)) return (closeSync(fd), { frames, pages: null, fd: null });
  const salt1 = head.readUInt32BE(16);
  const salt2 = head.readUInt32BE(20);
  const frameSize = 24 + k.pageSize;
  let pending = new Map<number, number>();
  let pages: number | null = null;
  for (let off = 32; off + frameSize <= size; off += frameSize) {
    const f = readAt(fd, frameSize, off);
    if (f.readUInt32BE(8) !== salt1 || f.readUInt32BE(12) !== salt2) break;
    s = sum(f.subarray(24), sum(f.subarray(0, 8), s));
    if (s[0] !== f.readUInt32BE(16) || s[1] !== f.readUInt32BE(20)) break;
    pending.set(f.readUInt32BE(0), off + 24);
    const commit = f.readUInt32BE(4);
    if (commit) {
      for (const [p, at] of pending) frames.set(p, at);
      pending = new Map();
      pages = commit;
    }
  }
  return { frames, pages, fd };
}

interface DecryptStats {
  pageSize: number;
  pages: number;
  /** Pages the write-ahead log brought that the database file did not have yet. */
  walPages: number;
}

/**
 * Decrypt `dbPath` (and its `-wal`, if any) into `outPath`, made 0600 and put in place only when complete.
 * Throws WrongKey when the key does not open it.
 */
export function decryptSqlcipher(dbPath: string, key: Buffer, outPath: string, progress?: (p: number) => void): DecryptStats {
  const fd = openSync(dbPath, 'r');
  const tmp = outPath + '.tmp';
  let out: number | null = null;
  let wal: ReturnType<typeof walFrames> | null = null;
  try {
    const k = keysFor(fd, key);
    const filePages = Math.floor(fstatSync(fd).size / k.pageSize);
    wal = walFrames(dbPath + '-wal', k);
    const pages = wal.pages ?? filePages;
    rmSync(tmp, { force: true });
    out = openSync(tmp, 'w', 0o600);
    for (let pgno = 1; pgno <= pages; pgno++) {
      const at = wal.frames.get(pgno);
      const page = at !== undefined ? readAt(wal.fd!, k.pageSize, at) : readAt(fd, k.pageSize, (pgno - 1) * k.pageSize);
      if (page.length < k.pageSize) throw new Error(`page ${pgno} is missing: the copy is cut short`);
      const plain = decryptPage(k, page, pgno);
      for (let off = 0; off < plain.length; ) off += writeSync(out, plain, off, plain.length - off, (pgno - 1) * k.pageSize + off);
      if (progress && pgno % 2048 === 0) progress(pgno / pages);
    }
    closeSync(out);
    out = null;
    renameSync(tmp, outPath);
    return { pageSize: k.pageSize, pages, walPages: [...wal.frames.keys()].filter((p) => p <= pages).length };
  } catch (e) {
    if (out !== null) closeSync(out);
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    closeSync(fd);
    if (wal?.fd != null) closeSync(wal.fd);
  }
}
