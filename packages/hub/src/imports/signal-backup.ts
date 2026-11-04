/**
 * Signal/Molly backups, read for their shape: which format, and with the passphrase, how much is in them.
 * Nothing here returns a value from inside a backup: no bodies, names, numbers, ids, keys or preferences.
 * Only counts, table and column names, frame kinds and month-granularity dates (docs/import-signal.md).
 *
 * Legacy `.backup` (Molly's BackupRecordInputStream): a plaintext header frame, then frames encrypted with
 * AES-256-CTR under a key stretched from the 30-digit passphrase, each with a 10-byte truncated HMAC.
 */
import { createDecipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

// ------------------------------------------------------------------ minimal protobuf wire reader

export type Field = { no: number; wire: number; int?: number; bytes?: Uint8Array };

function varint(b: Uint8Array, at: { i: number }): number {
  let v = 0;
  let mul = 1;
  for (;;) {
    const x = b[at.i++];
    if (x === undefined) throw new Error('truncated varint');
    v += (x & 0x7f) * mul;
    if (!(x & 0x80)) return v;
    mul *= 128;
  }
}

export function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  const at = { i: 0 };
  while (at.i < b.length) {
    const key = varint(b, at);
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, int: varint(b, at) });
    else if (wire === 1) (out.push({ no, wire, bytes: b.subarray(at.i, at.i + 8) }), (at.i += 8));
    else if (wire === 5) (out.push({ no, wire, bytes: b.subarray(at.i, at.i + 4) }), (at.i += 4));
    else if (wire === 2) {
      const n = varint(b, at);
      if (at.i + n > b.length) throw new Error('truncated field');
      out.push({ no, wire, bytes: b.subarray(at.i, at.i + n) });
      at.i += n;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

const field = (fs: Field[], no: number) => fs.find((f) => f.no === no);
const text = (f?: Field) => (f?.bytes ? new TextDecoder().decode(f.bytes) : undefined);
const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

// ------------------------------------------------------------------ keys

/** FullBackupBase.getBackupKey: SHA-512 over salt, then 250 000 rounds of (hash || passphrase), first 32 bytes. */
export function backupKey(passphrase: string, salt?: Uint8Array): Buffer {
  const input = Buffer.from(passphrase.replace(/ /g, ''));
  let hash: Buffer = input;
  for (let i = 0; i < 250_000; i++) {
    const h = createHash('sha512');
    if (i === 0 && salt) h.update(salt);
    hash = h.update(hash).update(input).digest();
  }
  return hash.subarray(0, 32);
}

export function streamKeys(passphrase: string, salt?: Uint8Array) {
  const derived = Buffer.from(hkdfSync('sha256', backupKey(passphrase, salt), Buffer.alloc(32), 'Backup Export', 64));
  return { cipherKey: derived.subarray(0, 32), macKey: derived.subarray(32, 64) };
}

/** A Signal backup passphrase: 30 digits, shown in groups of five. */
export const normalizePassphrase = (s: string) => s.replace(/[\s-]/g, '');
export const isPassphrase = (s: string) => /^\d{30}$/.test(normalizePassphrase(s));

// ------------------------------------------------------------------ legacy header

class Reader {
  private fd: number;
  pos = 0;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
  }
  read(n: number): Buffer {
    const b = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(this.fd, b, got, n - got, this.pos + got);
      if (r === 0) throw new Error('file ended early');
      got += r;
    }
    this.pos += n;
    return b;
  }
  skip(n: number) {
    this.pos += n;
  }
  close() {
    closeSync(this.fd);
  }
}

export interface LegacyHeader {
  version: number;
  salt: boolean;
  ivBytes: number;
}

function readHeader(r: Reader): { iv?: Uint8Array; salt?: Uint8Array; version: number } {
  const len = r.read(4).readUInt32BE(0);
  if (len === 0 || len > 4096) throw new Error('not a legacy Signal backup');
  const frame = fields(r.read(len));
  const header = field(frame, 1);
  if (!header?.bytes) throw new Error('not a legacy Signal backup');
  const h = fields(header.bytes);
  const iv = field(h, 1)?.bytes;
  if (!iv || iv.length !== 16) throw new Error('not a legacy Signal backup');
  return { iv, salt: field(h, 2)?.bytes, version: field(h, 3)?.int ?? 0 };
}

/** The plaintext header, or null when this is not a legacy backup. Reads a few hundred bytes. */
export function sniffLegacy(path: string): LegacyHeader | null {
  let r: Reader | null = null;
  try {
    r = new Reader(path);
    const h = readHeader(r);
    return { version: h.version, salt: !!h.salt, ivBytes: h.iv!.length };
  } catch {
    return null;
  } finally {
    r?.close();
  }
}

// ------------------------------------------------------------------ legacy census

const FRAME_KINDS: Record<number, string> = { 1: 'header', 2: 'statement', 3: 'preference', 4: 'attachment', 5: 'version', 6: 'end', 7: 'avatar', 8: 'sticker', 9: 'keyValue' };
/** Tables an import reads; their CREATE TABLE column names are reported. */
const SCHEMA_TABLES = new Set(['message', 'recipient', 'thread', 'attachment', 'reaction', 'mention', 'groups', 'sticker', 'poll', 'poll_option', 'poll_vote']);

export interface LegacyCensus {
  format: 'signal-legacy';
  version: number;
  bytes: number;
  databaseVersion: number | null;
  frames: Record<string, number>;
  rows: Record<string, number>;
  blobs: Record<'attachment' | 'sticker' | 'avatar', { count: number; bytes: number }>;
  messages: { total: number; keepmsgExpired: number; deleted: number; editRevisions: number; firstMonth: string | null; lastMonth: string | null };
  keyValueNamespaces: string[];
  schema: Record<string, string[]>;
}

export class BadPassphrase extends Error {
  constructor() {
    super('wrong passphrase');
  }
}

/** Parse "CREATE TABLE name (a INTEGER, b TEXT, UNIQUE(...))" into its column names. Rough: schema only. */
export function createColumns(sql: string): { table: string; columns: string[] } | null {
  const m = sql.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*)\)\s*$/i);
  if (!m) return null;
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[2]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) (parts.push(cur), (cur = ''));
    else cur += ch;
  }
  parts.push(cur);
  const columns = parts
    .map((p) => p.trim())
    .filter((p) => p && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(p))
    .map((p) => p.split(/\s+/)[0].replace(/["`]/g, ''));
  return { table: m[1], columns };
}

/**
 * Decrypt every frame, check every MAC, and count. Throws BadPassphrase if the first frame does not
 * authenticate. Attachment bytes are skipped, not decrypted. `progress` gets the byte position now and then.
 */
export function censusLegacy(path: string, passphrase: string, progress?: (pos: number, total: number) => void): LegacyCensus {
  const size = statSync(path).size;
  const r = new Reader(path);
  try {
    const { iv, salt, version } = readHeader(r);
    const { cipherKey, macKey } = streamKeys(normalizePassphrase(passphrase), salt);
    const ivb = Buffer.from(iv!);
    let counter = ivb.readUInt32BE(0);
    const nextIv = () => (ivb.writeUInt32BE(counter++ >>> 0, 0), Buffer.from(ivb));

    const out: LegacyCensus = {
      format: 'signal-legacy',
      version,
      bytes: size,
      databaseVersion: null,
      frames: {},
      rows: {},
      blobs: { attachment: { count: 0, bytes: 0 }, sticker: { count: 0, bytes: 0 }, avatar: { count: 0, bytes: 0 } },
      messages: { total: 0, keepmsgExpired: 0, deleted: 0, editRevisions: 0, firstMonth: null, lastMonth: null },
      keyValueNamespaces: [],
      schema: {},
    };
    const schema = new Map<string, string[]>();
    const kv = new Set<string>();
    let minSent = Infinity;
    let maxSent = 0;
    let first = true;
    let lastReport = 0;

    for (;;) {
      const lenEnc = r.read(4);
      const decipher = createDecipheriv('aes-256-ctr', cipherKey, nextIv());
      const mac = createHmac('sha256', macKey);
      let len: number;
      if (version >= 1) {
        mac.update(lenEnc);
        len = decipher.update(lenEnc).readUInt32BE(0);
      } else len = lenEnc.readUInt32BE(0);
      if (len <= 10 || len > 64 * 1024 * 1024 || r.pos + len > size) {
        if (first) throw new BadPassphrase();
        throw new Error(`implausible frame length at byte ${r.pos}: the file is damaged`);
      }
      const body = r.read(len);
      mac.update(body.subarray(0, len - 10));
      if (!mac.digest().subarray(0, 10).equals(body.subarray(len - 10))) {
        if (first) throw new BadPassphrase();
        throw new Error(`bad MAC at byte ${r.pos}: the file is damaged`);
      }
      first = false;
      const frame = fields(Buffer.concat([decipher.update(body.subarray(0, len - 10)), decipher.final()]));
      const top = frame[0];
      const kind = FRAME_KINDS[top?.no ?? 0] ?? `field${top?.no}`;
      out.frames[kind] = (out.frames[kind] ?? 0) + 1;
      if (kind === 'end') break;
      const inner = top?.bytes ? fields(top.bytes) : [];

      if (kind === 'version') out.databaseVersion = field(inner, 1)?.int ?? null;
      else if (kind === 'statement') {
        const sql = text(field(inner, 1)) ?? '';
        const ins = sql.match(/^INSERT\s+INTO\s+["`]?(\w+)/i);
        if (ins) {
          out.rows[ins[1]] = (out.rows[ins[1]] ?? 0) + 1;
          if (ins[1] === 'message') {
            const cols = schema.get('message') ?? [];
            const params = inner.filter((f) => f.no === 2).map((f) => fields(f.bytes!));
            const at = (name: string) => params[cols.indexOf(name)];
            const intAt = (name: string) => {
              const p = at(name);
              return p ? field(p, 2)?.int : undefined;
            };
            const isNull = (name: string) => {
              const p = at(name);
              return !p || field(p, 5)?.int === 1;
            };
            const m = out.messages;
            m.total++;
            if (intAt('keepmsg_expired')) m.keepmsgExpired++;
            if (cols.includes('deleted_by') ? !isNull('deleted_by') : intAt('remote_deleted')) m.deleted++;
            if (cols.includes('original_message_id') && !isNull('original_message_id')) m.editRevisions++;
            const sent = intAt('date_sent');
            if (sent && sent > 1e12) (minSent = Math.min(minSent, sent)), (maxSent = Math.max(maxSent, sent));
          }
        } else {
          const c = createColumns(sql);
          if (c) schema.set(c.table, c.columns);
        }
      } else if (kind === 'keyValue') {
        const k = text(field(inner, 1));
        if (k) kv.add(k.split('.')[0]); // the namespace only
      } else if (kind === 'attachment' || kind === 'sticker' || kind === 'avatar') {
        const n = field(inner, kind === 'attachment' ? 3 : 2)?.int ?? 0;
        out.blobs[kind].count++;
        out.blobs[kind].bytes += n;
        nextIv(); // every blob has its own counter; its bytes and 10-byte MAC follow the frame
        r.skip(n + 10);
      }
      if (progress && r.pos - lastReport > 32 * 1024 * 1024) progress((lastReport = r.pos), size);
    }
    if (maxSent) (out.messages.firstMonth = month(minSent)), (out.messages.lastMonth = month(maxSent));
    out.keyValueNamespaces = [...kv].sort();
    for (const [t, cols] of schema) if (SCHEMA_TABLES.has(t)) out.schema[t] = cols;
    return out;
  } finally {
    r.close();
  }
}

// ------------------------------------------------------------------ backup v2 frames (lib/archive Backup.proto)

const V2_FRAMES: Record<number, string> = { 1: 'account', 2: 'recipient', 3: 'chat', 4: 'chatItem', 5: 'stickerPack', 6: 'adHocCall', 7: 'notificationProfile', 8: 'chatFolder' };
const V2_RECIPIENTS: Record<number, string> = { 2: 'contact', 3: 'group', 4: 'distributionList', 5: 'self', 6: 'releaseNotes', 7: 'callLink' };
const V2_ITEMS: Record<number, string> = { 11: 'standard', 12: 'contact', 13: 'sticker', 14: 'remoteDeleted', 15: 'update', 16: 'payment', 17: 'giftBadge', 18: 'viewOnce', 19: 'storyReply', 20: 'poll', 22: 'adminDeleted' };

export interface V2Census {
  format: 'signal-v2-frames';
  version: number | null;
  writtenMonth: string | null;
  frames: Record<string, number>;
  chatItems: Record<string, number>;
  standard: { revisions: number; reactions: number; attachments: number; quotes: number };
}

/** Count the frames of a plaintext (decrypted, optionally gzipped) backup-v2 stream. */
export function censusV2(bytes: Uint8Array): V2Census {
  let b = bytes;
  if (b[0] === 0x1f && b[1] === 0x8b) b = Bun.gunzipSync(b as Uint8Array<ArrayBuffer>);
  const at = { i: 0 };
  const next = () => {
    const n = varint(b, at);
    const f = fields(b.subarray(at.i, at.i + n));
    at.i += n;
    return f;
  };
  const info = next();
  const written = field(info, 2)?.int;
  const out: V2Census = { format: 'signal-v2-frames', version: field(info, 1)?.int ?? null, writtenMonth: written ? month(written) : null, frames: {}, chatItems: {}, standard: { revisions: 0, reactions: 0, attachments: 0, quotes: 0 } };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  while (at.i < b.length) {
    const f = next()[0];
    const kind = V2_FRAMES[f?.no ?? 0] ?? `field${f?.no}`;
    if (kind === 'recipient') bump(out.frames, `recipient.${V2_RECIPIENTS[fields(f.bytes!).find((x) => x.no !== 1)?.no ?? 0] ?? '?'}`);
    else bump(out.frames, kind);
    if (kind !== 'chatItem') continue;
    const ci = fields(f.bytes!);
    out.standard.revisions += ci.filter((x) => x.no === 6).length;
    const item = ci.find((x) => V2_ITEMS[x.no]);
    bump(out.chatItems, item ? V2_ITEMS[item.no] : 'none');
    if (item?.no === 11) {
      const sm = fields(item.bytes!);
      if (field(sm, 1)) out.standard.quotes++;
      out.standard.attachments += sm.filter((x) => x.no === 3).length;
      out.standard.reactions += sm.filter((x) => x.no === 6).length;
    }
  }
  return out;
}
