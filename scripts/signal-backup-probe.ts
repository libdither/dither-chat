/**
 * Shape of a Signal/Molly backup, without its content. Prototype for docs/import-signal.md.
 *
 *   bun scripts/signal-backup-probe.ts legacy <file.backup>
 *       The plaintext header only: format version, salt and IV present, file size.
 *   SIGNAL_BACKUP_PASSPHRASE_FILE=<file> bun scripts/signal-backup-probe.ts legacy <file.backup>
 *       Also decrypts the frame stream and counts: frames by type, statements by table, attachment
 *       bytes, message rows hidden by keepmsg or deleted, and the columns of the tables an import reads.
 *   bun scripts/signal-backup-probe.ts v2 <plaintext frames>
 *       Counts frames of a decrypted backup-v2 stream (or Signal's .binproto test vectors).
 *   bun scripts/signal-backup-probe.ts selftest
 *       Writes a synthetic legacy backup with a made-up passphrase and probes it.
 *
 * It never prints a value: no bodies, names, numbers, ids, keys or preference values. Only counts,
 * table and column names, frame kinds and month-granularity date ranges. The passphrase is read from a
 * file so it stays out of shell history and the process list.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ------------------------------------------------------------------ minimal protobuf wire reader

type Field = { no: number; wire: number; int?: number; bytes?: Uint8Array };

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

function fields(b: Uint8Array): Field[] {
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
      out.push({ no, wire, bytes: b.subarray(at.i, at.i + n) });
      at.i += n;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

const field = (fs: Field[], no: number) => fs.find((f) => f.no === no);
const text = (f?: Field) => (f?.bytes ? new TextDecoder().decode(f.bytes) : undefined);

// ------------------------------------------------------------------ legacy .backup (Backups.proto BackupFrame)

const FRAME_KINDS: Record<number, string> = { 1: 'header', 2: 'statement', 3: 'preference', 4: 'attachment', 5: 'version', 6: 'end', 7: 'avatar', 8: 'sticker', 9: 'keyValue' };
/** Tables an import reads; their CREATE TABLE columns are printed (names only). */
const SCHEMA_TABLES = new Set(['message', 'recipient', 'thread', 'attachment', 'reaction', 'mention', 'groups', 'sticker', 'poll', 'poll_option', 'poll_vote']);

/** FullBackupBase.getBackupKey: SHA-512 over salt, then 250 000 rounds of (hash || passphrase). */
function backupKey(passphrase: string, salt?: Uint8Array): Buffer {
  const input = Buffer.from(passphrase.replace(/ /g, ''));
  let hash: Buffer = input;
  for (let i = 0; i < 250_000; i++) {
    const h = createHash('sha512');
    if (i === 0 && salt) h.update(salt);
    hash = h.update(hash).update(input).digest();
  }
  return hash.subarray(0, 32);
}

function streamKeys(passphrase: string, salt?: Uint8Array) {
  const derived = Buffer.from(hkdfSync('sha256', backupKey(passphrase, salt), Buffer.alloc(32), 'Backup Export', 64));
  return { cipherKey: derived.subarray(0, 32), macKey: derived.subarray(32, 64) };
}

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

function readHeader(r: Reader) {
  const len = r.read(4).readUInt32BE(0);
  const frame = fields(r.read(len));
  const header = field(frame, 1);
  if (!header?.bytes) throw new Error('does not start with a header frame: not a legacy Signal backup');
  const h = fields(header.bytes);
  return { iv: field(h, 1)?.bytes, salt: field(h, 2)?.bytes, version: field(h, 3)?.int ?? 0 };
}

/** Parse "CREATE TABLE name (a INTEGER, b TEXT, UNIQUE(...))" into its column names. Rough, schema only. */
function createColumns(sql: string): { table: string; columns: string[] } | null {
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

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

function probeLegacy(path: string, passphrase?: string) {
  const size = statSync(path).size;
  const r = new Reader(path);
  const { iv, salt, version } = readHeader(r);
  console.log(`legacy backup: ${(size / 1e6).toFixed(1)} MB, format version ${version}, salt ${salt ? 'yes' : 'no'}, iv ${iv?.length ?? 0} bytes`);
  if (!passphrase) {
    console.log('(set SIGNAL_BACKUP_PASSPHRASE_FILE to count frames)');
    return r.close();
  }
  if (!iv || iv.length !== 16) throw new Error('bad IV');
  const { cipherKey, macKey } = streamKeys(passphrase, salt);
  const ivb = Buffer.from(iv);
  let counter = ivb.readUInt32BE(0);
  const nextIv = () => (ivb.writeUInt32BE(counter++ >>> 0, 0), Buffer.from(ivb));

  const kinds = new Map<string, number>();
  const statements = new Map<string, number>();
  const schema = new Map<string, string[]>();
  const keyValueKeys = new Set<string>();
  const blobs = { attachment: [0, 0], sticker: [0, 0], avatar: [0, 0] } as Record<string, [number, number]>;
  const msg = { rows: 0, keepmsgExpired: 0, deleted: 0, edits: 0, minSent: Infinity, maxSent: 0 };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (;;) {
    const lenEnc = r.read(4);
    const decipher = createDecipheriv('aes-256-ctr', cipherKey, nextIv());
    const mac = createHmac('sha256', macKey);
    let len: number;
    if (version >= 1) {
      mac.update(lenEnc);
      len = decipher.update(lenEnc).readUInt32BE(0);
    } else len = lenEnc.readUInt32BE(0);
    if (len <= 10 || len > 64 * 1024 * 1024) throw new Error(`implausible frame length at byte ${r.pos}: wrong passphrase?`);
    const body = r.read(len);
    mac.update(body.subarray(0, len - 10));
    if (!mac.digest().subarray(0, 10).equals(body.subarray(len - 10))) throw new Error(`bad MAC at byte ${r.pos}: wrong passphrase or corrupt file`);
    const frame = fields(Buffer.concat([decipher.update(body.subarray(0, len - 10)), decipher.final()]));
    const top = frame[0];
    const kind = FRAME_KINDS[top?.no ?? 0] ?? `field${top?.no}`;
    bump(kinds, kind);
    if (kind === 'end') break;
    const inner = top?.bytes ? fields(top.bytes) : [];

    if (kind === 'statement') {
      const sql = text(field(inner, 1)) ?? '';
      const ins = sql.match(/^INSERT\s+INTO\s+["`]?(\w+)/i);
      if (ins) {
        bump(statements, `insert ${ins[1]}`);
        if (ins[1] === 'message') {
          const cols = schema.get('message') ?? [];
          const params = inner.filter((f) => f.no === 2).map((f) => fields(f.bytes!));
          const intAt = (name: string) => {
            const p = params[cols.indexOf(name)];
            return p ? field(p, 2)?.int : undefined;
          };
          const isNull = (name: string) => {
            const p = params[cols.indexOf(name)];
            return !p || field(p, 5)?.int === 1;
          };
          msg.rows++;
          if (intAt('keepmsg_expired')) msg.keepmsgExpired++;
          if (cols.includes('deleted_by') ? !isNull('deleted_by') : intAt('remote_deleted')) msg.deleted++;
          if (cols.includes('original_message_id') && !isNull('original_message_id')) msg.edits++;
          const sent = intAt('date_sent');
          if (sent && sent > 1e12) (msg.minSent = Math.min(msg.minSent, sent)), (msg.maxSent = Math.max(msg.maxSent, sent));
        }
      } else {
        const c = createColumns(sql);
        if (c) {
          bump(statements, 'create table');
          schema.set(c.table, c.columns);
        } else bump(statements, (sql.match(/^\s*(\w+(?:\s+\w+)?)/)?.[1] ?? '?').toLowerCase());
      }
    } else if (kind === 'keyValue') {
      const k = text(field(inner, 1));
      if (k) keyValueKeys.add(k.split('.')[0]); // namespace only
    } else if (kind === 'attachment' || kind === 'sticker' || kind === 'avatar') {
      const lengthField = kind === 'attachment' ? 3 : 2;
      const n = field(inner, lengthField)?.int ?? 0;
      blobs[kind][0]++;
      blobs[kind][1] += n;
      nextIv(); // each blob has its own counter; its bytes and 10-byte MAC follow the frame
      r.skip(n + 10);
    }
  }
  r.close();

  console.log('\nframes:', Object.fromEntries(kinds));
  console.log('rows per table:', Object.fromEntries([...statements].filter(([k]) => k.startsWith('insert ')).map(([k, v]) => [k.slice(7), v])));
  console.log('other statements:', Object.fromEntries([...statements].filter(([k]) => !k.startsWith('insert '))));
  for (const [k, [n, bytes]] of Object.entries(blobs)) console.log(`${k} blobs: ${n} (${(bytes / 1e6).toFixed(1)} MB)`);
  console.log('message rows:', {
    total: msg.rows,
    keepmsgExpired: msg.keepmsgExpired,
    deleted: msg.deleted,
    editRevisions: msg.edits,
    sent: msg.maxSent ? `${month(msg.minSent)} .. ${month(msg.maxSent)}` : 'n/a',
  });
  console.log('key-value namespaces:', [...keyValueKeys].sort().join(', '));
  console.log('\nschema of the tables an import reads:');
  for (const [t, cols] of schema) if (SCHEMA_TABLES.has(t)) console.log(`  ${t}(${cols.join(', ')})`);
}

// ------------------------------------------------------------------ backup v2 frames (lib/archive Backup.proto)

const V2_FRAMES: Record<number, string> = { 1: 'account', 2: 'recipient', 3: 'chat', 4: 'chatItem', 5: 'stickerPack', 6: 'adHocCall', 7: 'notificationProfile', 8: 'chatFolder' };
const V2_RECIPIENTS: Record<number, string> = { 2: 'contact', 3: 'group', 4: 'distributionList', 5: 'self', 6: 'releaseNotes', 7: 'callLink' };
const V2_ITEMS: Record<number, string> = { 11: 'standard', 12: 'contact', 13: 'sticker', 14: 'remoteDeleted', 15: 'update', 16: 'payment', 17: 'giftBadge', 18: 'viewOnce', 19: 'storyReply', 20: 'poll', 22: 'adminDeleted' };

function probeV2(path: string) {
  let b: Uint8Array = readFileSync(path);
  if (b[0] === 0x1f && b[1] === 0x8b) b = Bun.gunzipSync(b);
  const at = { i: 0 };
  const next = () => {
    const n = varint(b, at);
    const f = fields(b.subarray(at.i, at.i + n));
    at.i += n;
    return f;
  };
  const info = next();
  console.log(`backup v2 stream: version ${field(info, 1)?.int}, written ${month(field(info, 2)?.int ?? 0)}`);
  const frames = new Map<string, number>();
  const items = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const extra = { revisions: 0, reactions: 0, attachments: 0, quotes: 0 };
  while (at.i < b.length) {
    const f = next()[0];
    const kind = V2_FRAMES[f?.no ?? 0] ?? `field${f?.no}`;
    if (kind === 'recipient') bump(frames, `recipient.${V2_RECIPIENTS[fields(f.bytes!).find((x) => x.no !== 1)?.no ?? 0] ?? '?'}`);
    else bump(frames, kind);
    if (kind !== 'chatItem') continue;
    const ci = fields(f.bytes!);
    extra.revisions += ci.filter((x) => x.no === 6).length;
    const item = ci.find((x) => V2_ITEMS[x.no]);
    bump(items, item ? V2_ITEMS[item.no] : 'none');
    if (item?.no === 11) {
      const sm = fields(item.bytes!);
      if (field(sm, 1)) extra.quotes++;
      extra.attachments += sm.filter((x) => x.no === 3).length;
      extra.reactions += sm.filter((x) => x.no === 6).length;
    }
  }
  console.log('frames:', Object.fromEntries(frames));
  console.log('chat items:', Object.fromEntries(items));
  console.log('in standard messages:', extra);
}

// ------------------------------------------------------------------ selftest: a synthetic legacy backup

function pb(no: number, v: number | string | Uint8Array): Buffer {
  const vi = (n: number) => {
    const out: number[] = [];
    while (n >= 128) (out.push((n % 128) | 128), (n = Math.floor(n / 128)));
    out.push(n);
    return Buffer.from(out);
  };
  if (typeof v === 'number') return Buffer.concat([vi(no * 8), vi(v)]);
  const bytes = typeof v === 'string' ? Buffer.from(v) : Buffer.from(v);
  return Buffer.concat([vi(no * 8 + 2), vi(bytes.length), bytes]);
}

function selftest() {
  const pass = '000000000000000000000000000000'; // made up; a real one is 30 random digits
  const iv = randomBytes(16);
  const salt = randomBytes(32);
  const { cipherKey, macKey } = streamKeys(pass, salt);
  let counter = iv.readUInt32BE(0);
  const nextIv = () => (iv.writeUInt32BE(counter++ >>> 0, 0), Buffer.from(iv));
  const chunks: Buffer[] = [];
  const header = pb(1, Buffer.concat([pb(1, iv), pb(2, salt), pb(3, 1)]));
  chunks.push(Buffer.alloc(4), header);
  chunks[0].writeUInt32BE(header.length);
  const frame = (plain: Buffer) => {
    const c = createCipheriv('aes-256-ctr', cipherKey, nextIv());
    const len = Buffer.alloc(4);
    len.writeUInt32BE(plain.length + 10);
    const encLen = c.update(len);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const mac = createHmac('sha256', macKey).update(encLen).update(ct).digest().subarray(0, 10);
    chunks.push(encLen, ct, mac);
  };
  const blob = (data: Buffer) => {
    const v = nextIv();
    const c = createCipheriv('aes-256-ctr', cipherKey, v);
    const ct = Buffer.concat([c.update(data), c.final()]);
    chunks.push(ct, createHmac('sha256', macKey).update(v).update(ct).digest().subarray(0, 10));
  };
  const param = (p: { s?: string; i?: number; nul?: boolean }) => pb(2, p.nul ? pb(5, 1) : p.s !== undefined ? pb(1, p.s) : pb(2, p.i!));
  const stmt = (sql: string, ps: Buffer[] = []) => frame(pb(2, Buffer.concat([pb(1, sql), ...ps])));

  frame(pb(5, pb(1, 300)));
  stmt('CREATE TABLE message (_id INTEGER PRIMARY KEY, date_sent INTEGER, thread_id INTEGER, from_recipient_id INTEGER, body TEXT, original_message_id INTEGER DEFAULT NULL, deleted_by INTEGER DEFAULT NULL, keepmsg_expired INTEGER DEFAULT 0)');
  stmt('CREATE TABLE recipient (_id INTEGER PRIMARY KEY, aci TEXT UNIQUE, e164 TEXT, group_id TEXT)');
  const t0 = Date.UTC(2023, 4, 1);
  for (let i = 1; i <= 5; i++) {
    stmt('INSERT INTO message VALUES (?,?,?,?,?,?,?,?)', [
      param({ i }),
      param({ i: t0 + i * 86_400_000 * 40 }),
      param({ i: 1 }),
      param({ i: 2 }),
      param({ s: 'synthetic' }),
      i === 5 ? param({ i: 4 }) : param({ nul: true }),
      i === 3 ? param({ i: 2 }) : param({ nul: true }),
      param({ i: i === 2 ? 1 : 0 }),
    ]);
  }
  stmt('INSERT INTO recipient VALUES (?,?,?,?)', [param({ i: 2 }), param({ nul: true }), param({ nul: true }), param({ nul: true })]);
  frame(pb(9, Buffer.concat([pb(1, 'account.synthetic'), pb(7, 'x')])));
  frame(pb(4, Buffer.concat([pb(1, 1), pb(2, 1), pb(3, 1000)])));
  blob(randomBytes(1000));
  frame(pb(6, 1));

  const dir = mkdtempSync(join(tmpdir(), 'signal-probe-'));
  const file = join(dir, 'synthetic.backup');
  writeFileSync(file, Buffer.concat(chunks));
  probeLegacy(file, pass);
}

// ------------------------------------------------------------------ main

const [mode, path] = process.argv.slice(2);
if (mode === 'legacy' && path) {
  const pf = process.env.SIGNAL_BACKUP_PASSPHRASE_FILE;
  probeLegacy(path, pf ? readFileSync(pf, 'utf8').trim() : undefined);
} else if (mode === 'v2' && path) probeV2(path);
else if (mode === 'selftest') selftest();
else {
  console.error('usage: bun scripts/signal-backup-probe.ts legacy <file.backup> | v2 <frames> | selftest');
  process.exit(2);
}
