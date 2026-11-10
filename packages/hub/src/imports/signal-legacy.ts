/**
 * Signal's legacy `.backup` (docs/import-signal.md): a plaintext header frame, then frames encrypted with
 * AES-256-CTR under a key stretched from the 30-digit passphrase, each with a 10-byte truncated HMAC
 * (signal-backup.ts has the keys and the census). The frames are SQL: each table's CREATE TABLE, then an INSERT per
 * row, with each attachment's bytes right after its row.
 *
 * Reading is two steps:
 *
 *  1. unpackLegacy replays the statements of the tables an import needs into a private SQLite file, and puts each
 *     attachment into the media store under the SHA-256 of its bytes (the name the new-format reader gives the same
 *     file, so the two meet). Keys, sessions, settings and the rest are never written anywhere.
 *  2. mapLegacy turns that database into the same facts the live adapter and signal-v2.ts make, ids included
 *     ("<author ACI>:<first sent time>", dm:/group: conversations), so an import and live sync meet on the same rows.
 *
 * Molly with keepmsg ("Include kept messages") writes this file with what Molly kept after the network took it back:
 * a disappeared message has keepmsg_expired = 1 and ran out at expire_started + expires_in; a deleted one has
 * deleted_by and, from keepmsg.6, keepmsg_deleted_at. Those come out as facts with `gone`, which the hub stores as kept
 * deleted or disappeared messages, out of sight until adversarial features are shown (docs/history.md). A message you
 * deleted yourself keeps nothing, as live sync does.
 */
import { Database } from 'bun:sqlite';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { fromSignal } from '../../../adapter-signal/src/markdown.ts';
import { groupIdFromMasterKey } from './signal-keys.ts';
import { BadPassphrase, type Field, fields, normalizePassphrase, streamKeys } from './signal-backup.ts';

export const SIGNAL_LEGACY_READER = 'signal-legacy@2';
/** The unpacked database's own version: a new one unpacks again, a new mapping alone does not. */
export const LEGACY_UNPACK = 1;

/** How a message left: deleted by its sender or an admin, or its disappearing timer ran out. */
export interface Gone {
  how: 'deleted' | 'disappeared';
  /** When, where the backup says: a timer's end, or (keepmsg.6 on) the delete's time. */
  at?: number;
}

/** A message fact from a history import, which may also say the network took the message back. */
export type ImportMessageFact = P.MessageFact & { gone?: Gone };

// ------------------------------------------------------------------ frames

class Reader {
  private fd: number;
  pos = 0;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
  }
  read(n: number): Buffer {
    const b = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const r = readSync(this.fd, b, got, n - got, this.pos + got);
      if (r === 0) throw new Error('the backup ends early: it is cut short');
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

/** A SqlParameter: string 1, integer 2 (uint64, two's complement), double 3, blob 4, null 5. Integers exactly. */
function sqlParam(b: Uint8Array): string | number | bigint | Uint8Array | null {
  let i = 0;
  const varint = (): bigint => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const x = b[i++];
      if (x === undefined) throw new Error('truncated varint');
      v |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) return v;
      shift += 7n;
    }
  };
  let out: string | number | bigint | Uint8Array | null = null;
  while (i < b.length) {
    const key = Number(varint());
    const no = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v = varint();
      if (v >= 1n << 63n) v -= 1n << 64n;
      if (no === 2) out = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      else if (no === 5 && v) out = null;
    } else if (wire === 1) {
      if (no === 3) out = Buffer.from(b.buffer, b.byteOffset + i, 8).readDoubleLE(0);
      i += 8;
    } else if (wire === 2) {
      const n = Number(varint());
      const v = b.subarray(i, i + n);
      i += n;
      if (no === 1) out = Buffer.from(v).toString('utf8');
      else if (no === 4) out = new Uint8Array(v);
    } else if (wire === 5) i += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** The tables an import reads; nothing else in the backup (keys, sessions, settings) is written down. */
const TABLES = new Set(['message', 'recipient', 'thread', 'attachment', 'reaction', 'mention', 'groups', 'group_membership', 'poll', 'poll_option', 'poll_vote']);

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'video/mp4': '.mp4',
  'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/x-signal-plain': '.txt',
};
const extOf = (name: string | null | undefined, mime: string | null | undefined) => (name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? MIME_EXT[mime ?? ''] ?? '').toLowerCase();
const mediaPath = (mediaDir: string, sha: string, ext: string) => join(mediaDir, sha.slice(0, 2), sha + ext);

export interface UnpackStats {
  statements: number;
  rows: Record<string, number>;
  attachments: { count: number; bytes: number; stored: number };
}

/**
 * Decrypt the whole backup, checking every MAC, into `dbPath` (made 0600, replaced only when complete) and the media
 * store. Throws BadPassphrase when the first frame does not authenticate.
 */
export function unpackLegacy(path: string, passphrase: string, dbPath: string, mediaDir: string, progress?: (p: number) => void): UnpackStats {
  const size = statSync(path).size;
  const r = new Reader(path);
  const tmp = dbPath + '.tmp';
  rmSync(tmp, { force: true });
  writeFileSync(tmp, '', { mode: 0o600 });
  const db = new Database(tmp);
  const stats: UnpackStats = { statements: 0, rows: {}, attachments: { count: 0, bytes: 0, stored: 0 } };
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec('CREATE TABLE _blob (row_id INTEGER PRIMARY KEY, sha TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL)');
    const putBlob = db.query('INSERT OR REPLACE INTO _blob (row_id, sha, ext, size) VALUES (?, ?, ?, ?)');
    const prepared = new Map<string, ReturnType<Database['query']>>();
    let created = new Set<string>();

    // The header frame, in the clear.
    const hlen = r.read(4).readUInt32BE(0);
    if (hlen === 0 || hlen > 4096) throw new Error('not a legacy Signal backup');
    const h = fields(fields(r.read(hlen)).find((f) => f.no === 1)?.bytes ?? new Uint8Array());
    const iv = h.find((f) => f.no === 1)?.bytes;
    if (!iv || iv.length !== 16) throw new Error('not a legacy Signal backup');
    const salt = h.find((f) => f.no === 2)?.bytes;
    const version = h.find((f) => f.no === 3)?.int ?? 0;
    const { cipherKey, macKey } = streamKeys(normalizePassphrase(passphrase), salt);
    const ivb = Buffer.from(iv);
    let counter = ivb.readUInt32BE(0);
    const nextIv = () => (ivb.writeUInt32BE(counter++ >>> 0, 0), Buffer.from(ivb));

    let first = true;
    let lastReport = 0;
    db.exec('BEGIN');
    let inTx = 0;
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
      if (!top) continue;
      if (top.no === 6) break; // end
      const inner = top.bytes ? fields(top.bytes) : [];

      if (top.no === 2) {
        // A statement: only the tables an import reads.
        const sql = inner.find((f) => f.no === 1)?.bytes ? Buffer.from(inner.find((f) => f.no === 1)!.bytes!).toString('utf8') : '';
        const ins = sql.match(/^INSERT\s+INTO\s+["`]?(\w+)/i);
        const make = sql.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i);
        if (make && TABLES.has(make[1]) && !created.has(make[1])) {
          db.exec(sql);
          created.add(make[1]);
        } else if (ins && TABLES.has(ins[1]) && created.has(ins[1])) {
          let q = prepared.get(sql);
          if (!q) prepared.set(sql, (q = db.query(sql)));
          q.run(...(inner.filter((f) => f.no === 2).map((f) => sqlParam(f.bytes!)) as any[]));
          stats.rows[ins[1]] = (stats.rows[ins[1]] ?? 0) + 1;
          stats.statements++;
          if (++inTx >= 5000) (db.exec('COMMIT; BEGIN'), (inTx = 0));
        }
      } else if (top.no === 4 || top.no === 7 || top.no === 8) {
        // An attachment (rowId 1, length 3), avatar or sticker (length 2): its bytes and their MAC follow the frame.
        const n = (top.no === 4 ? inner.find((f) => f.no === 3)?.int : inner.find((f) => f.no === 2)?.int) ?? 0;
        const biv = nextIv();
        if (top.no !== 4) {
          r.skip(n + 10);
          continue;
        }
        const rowId = inner.find((f) => f.no === 1)?.int;
        const d = createDecipheriv('aes-256-ctr', cipherKey, biv);
        const m = createHmac('sha256', macKey).update(biv);
        const sha = createHash('sha256');
        const parts: Buffer[] = [];
        for (let left = n; left > 0; ) {
          const chunk = r.read(Math.min(left, 1 << 20));
          left -= chunk.length;
          m.update(chunk);
          const plain = d.update(chunk);
          sha.update(plain);
          parts.push(plain);
        }
        const tail = d.final();
        if (tail.length) (sha.update(tail), parts.push(tail));
        if (!m.digest().subarray(0, 10).equals(r.read(10))) throw new Error(`an attachment's MAC does not match at byte ${r.pos}: the file is damaged`);
        const hex = sha.digest('hex');
        const row = rowId === undefined ? null : (db.query('SELECT content_type, file_name FROM attachment WHERE _id = ?').get(rowId) as { content_type: string | null; file_name: string | null } | null);
        const ext = extOf(row?.file_name, row?.content_type);
        const dest = mediaPath(mediaDir, hex, ext);
        if (!existsSync(dest)) {
          mkdirSync(join(mediaDir, hex.slice(0, 2)), { recursive: true, mode: 0o700 });
          const fd = openSync(dest + '.tmp', 'w', 0o600);
          try {
            for (const p of parts) for (let off = 0; off < p.length; ) off += writeSync(fd, p, off);
          } finally {
            closeSync(fd);
          }
          renameSync(dest + '.tmp', dest);
          stats.attachments.stored++;
        }
        stats.attachments.count++;
        stats.attachments.bytes += n;
        if (rowId !== undefined) putBlob.run(rowId, hex, ext, n);
      }
      if (progress && r.pos - lastReport > 32 * 1024 * 1024) progress((lastReport = r.pos) / size);
    }
    db.exec('COMMIT');
    created = new Set();
    db.close();
    renameSync(tmp, dbPath);
    return stats;
  } catch (e) {
    try {
      db.close();
    } catch {}
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    r.close();
  }
}

// ------------------------------------------------------------------ mapping

// MessageTypes (Signal Android): the low 5 bits are the base type; the rest are flags.
const BASE = 0x1f;
const CALLS: Record<number, { video: boolean; dir: 'Incoming' | 'Outgoing' | 'Missed' }> = {
  1: { video: false, dir: 'Incoming' }, 2: { video: false, dir: 'Outgoing' }, 3: { video: false, dir: 'Missed' },
  8: { video: true, dir: 'Missed' }, 10: { video: true, dir: 'Incoming' }, 11: { video: true, dir: 'Outgoing' },
};
const GROUP_CALL = 12;
/** MMS PDU types (message.m_type): sent, a notice of one not yet downloaded, received. */
const MMS_SEND = 128;
const MMS_NOTIFICATION = 130;
const MMS_RETRIEVED = 132;
const OUTGOING = new Set([21, 22, 23, 24, 25, 26, 28, 2, 11]);
/** Base types with no line in the hub, by name. */
const QUIET: Record<number, string> = {
  4: 'joined', 5: 'unsupported', 6: 'invalid', 7: 'profile change', 9: 'group v1 migration', 13: 'bad decrypt', 14: 'number change',
  15: 'donation request', 16: 'thread merge', 17: 'sms export', 18: 'session switchover', 27: 'draft',
};
const SECURE = 0x800000;
const END_SESSION = 0x400000;
const PUSH = 0x200000;
const KEY_EXCHANGE_MASK = 0xff00;
const GROUP_UPDATE = 0x10000;
const TIMER_UPDATE = 0x40000;
const ENCRYPTION_FAILED = 0x10000000 | 0x08000000 | 0x04000000 | 0x02000000;
const SPECIAL_MASK = 0xf00000000;
const SPECIAL: Record<number, string> = {
  0x1: 'story reaction', 0x2: 'gift badge', 0x3: 'payment', 0x4: 'payments request', 0x5: 'reported spam', 0x6: 'message request accepted',
  0x8: 'payments activated', 0x9: 'payment tombstone', 0xa: 'blocked', 0xb: 'unblocked', 0xc: 'poll ended', 0xd: 'pin',
};
const STYLES: Record<number, string> = { 0: 'BOLD', 1: 'ITALIC', 2: 'SPOILER', 3: 'STRIKETHROUGH', 4: 'MONOSPACE' };

const joinName = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(' ').trim() || undefined;

function attachmentKind(mime?: string | null): P.AttachmentKind {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

function describeTimer(seconds: number): string {
  const units: [number, string][] = [[604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [n, name] of units) if (seconds >= n && seconds % n === 0) return `${seconds / n} ${name}${seconds / n === 1 ? '' : 's'}`;
  return `${seconds} seconds`;
}

/** Someone without an ACI, by the number or email SMS reached them at. Short codes stay as they are (no "+"). */
function smsAddress(r: Row): string | null {
  if (typeof r.e164 === 'string' && r.e164.trim()) return `tel:${r.e164.trim()}`;
  if (typeof r.email === 'string' && r.email.trim()) return `mailto:${r.email.trim().toLowerCase()}`;
  return null;
}

const aciText = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s) return null;
  const v = s.replace(/^ACI:/i, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;
};

export interface LegacyReadStats {
  conversations: number;
  messages: number;
  duplicates: number;
  selfMessages: number;
  files: { linked: number; missing: number };
  /** Messages the backup kept after the network took them back, by how. */
  gone: { deleted: number; disappeared: number };
  skipped: Record<string, number>;
}

type Row = Record<string, any>;

/** Turn an unpacked backup into facts: each conversation, then its messages. */
export function mapLegacy(dbPath: string, o: { selfId: string; mediaDir: string; progress?: (p: number) => void }, emit: (line: unknown) => void): LegacyReadStats {
  const self = o.selfId.toLowerCase();
  const db = new Database(dbPath, { readonly: true });
  const stats: LegacyReadStats = { conversations: 0, messages: 0, duplicates: 0, selfMessages: 0, files: { linked: 0, missing: 0 }, gone: { deleted: 0, disappeared: 0 }, skipped: {} };
  const skip = (why: string) => (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);
  const has = (t: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const cols = (t: string) => new Set((db.query(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => c.name as string));
  try {
    if (!has('message') || !has('recipient') || !has('thread')) throw new Error('this backup has no messages, people or chats in it');
    const mcols = cols('message');

    // People and groups. Someone with no ACI (an SMS contact) is known by number or email: "tel:<number>", "mailto:<email>".
    const aciOf = new Map<number, string>();
    const idOf = new Map<number, string>();
    const identities = new Map<string, P.IdentityFact>();
    const names = new Map<string, string>();
    for (const r of db.query('SELECT * FROM recipient').all() as Row[]) {
      if (r.type !== 0 && r.type != null) continue;
      const aci = aciText(r.aci);
      const id = aci ?? smsAddress(r);
      if (!id) continue;
      if (aci) aciOf.set(r._id, aci);
      idOf.set(r._id, id);
      const idf: P.IdentityFact = { nativeId: id };
      const name =
        joinName(r.nickname_given_name, r.nickname_family_name) ??
        joinName(r.system_nickname) ??
        joinName(r.system_given_name, r.system_family_name) ??
        joinName(r.system_joined_name) ??
        joinName(r.profile_given_name, r.profile_family_name) ??
        joinName(r.username);
      if (name) idf.displayName = name;
      if (typeof r.e164 === 'string' && r.e164) idf.handle = aci ? (r.e164.startsWith('+') ? r.e164 : `+${r.e164}`) : r.e164;
      else if (r.username) idf.handle = `@${r.username}`;
      else if (typeof r.email === 'string' && r.email) idf.handle = r.email;
      if (id === self) idf.isSelf = true;
      else if (name) names.set(id, name);
      identities.set(id, idf);
    }
    const nameOf = (aci: string | null) => (aci === self ? 'You' : (aci && names.get(aci)) || 'Someone');

    const conversations = new Map<number, P.ConversationFact>();
    const groups = new Map<number, Row>();
    if (has('groups')) for (const g of db.query('SELECT * FROM groups').all() as Row[]) if (g.recipient_id != null) groups.set(g.recipient_id, g);
    const members = new Map<string, string[]>();
    if (has('group_membership'))
      for (const m of db.query('SELECT group_id, recipient_id FROM group_membership').all() as Row[]) {
        const id = idOf.get(m.recipient_id);
        if (id) (members.get(m.group_id) ?? members.set(m.group_id, []).get(m.group_id)!).push(id);
      }
    for (const r of db.query('SELECT _id, type, aci, group_id FROM recipient').all() as Row[]) {
      const aci = aciText(r.aci);
      if (r.type === 0 && aci) {
        conversations.set(
          r._id,
          aci === self ? { nativeId: `dm:${self}:${self}`, shape: 'self', name: 'Note to Self', participants: [self], encrypted: true } : { nativeId: `dm:${self}:${aci}`, shape: 'direct', participants: [self, aci], encrypted: true },
        );
      } else if (r.type === 0 && idOf.has(r._id)) {
        // SMS with someone not on Signal. Not a conversation Signal can send to: the adapter refuses anything but dm: and group:.
        const peer = idOf.get(r._id)!;
        conversations.set(r._id, { nativeId: `sms:${self}:${peer}`, shape: 'direct', participants: [self, peer], encrypted: false });
      } else if (r.type === 1) {
        // An MMS group: SMS to several people at once.
        const g = groups.get(r._id);
        const hex = typeof r.group_id === 'string' ? r.group_id.match(/^__signal_mms_group__!([0-9a-f]+)$/i)?.[1] : undefined;
        if (!hex) continue;
        const conv: P.ConversationFact = { nativeId: `mms:${hex.toLowerCase()}`, shape: 'group', encrypted: false };
        if (g?.title) conv.name = g.title;
        const ms = g ? members.get(g.group_id) : undefined;
        if (ms?.length) conv.participants = [...new Set([self, ...ms])];
        conversations.set(r._id, conv);
      } else if (r.type === 3) {
        const g = groups.get(r._id);
        const mk = g?.master_key instanceof Uint8Array && g.master_key.length === 32 ? g.master_key : null;
        const hex = typeof r.group_id === 'string' ? r.group_id.match(/^__signal_group__v2__!([0-9a-f]+)$/i)?.[1] : undefined;
        const gid = mk ? groupIdFromMasterKey(mk) : hex ? Buffer.from(hex, 'hex') : null;
        if (!gid) continue;
        const conv: P.ConversationFact = { nativeId: `group:${gid.toString('base64')}`, shape: 'group', encrypted: true };
        if (g?.title) conv.name = g.title;
        const ms = g ? members.get(g.group_id) : undefined;
        if (ms?.length) conv.participants = [...new Set(ms)];
        conversations.set(r._id, conv);
      }
    }
    const chats = new Map<number, { conversation: P.ConversationFact; messages: ImportMessageFact[]; people: Set<string> }>();
    for (const t of db.query('SELECT _id, recipient_id, archived FROM thread').all() as Row[]) {
      const conv = conversations.get(t.recipient_id);
      if (conv) chats.set(t._id, { conversation: { ...conv, ...(t.archived ? { archived: true } : {}) }, messages: [], people: new Set() });
    }

    // What hangs off messages.
    const byMessage = <T>(sql: string, key = 'message_id'): Map<number, T[]> => {
      const out = new Map<number, T[]>();
      for (const r of db.query(sql).all() as Row[]) (out.get(r[key]) ?? out.set(r[key], []).get(r[key])!).push(r as T);
      return out;
    };
    const atts = has('attachment')
      ? byMessage<Row>('SELECT a.*, b.sha, b.ext, b.size AS blob_size FROM attachment a LEFT JOIN _blob b ON b.row_id = a._id ORDER BY a.message_id, a.display_order, a._id')
      : new Map<number, Row[]>();
    const reactions = has('reaction') ? byMessage<Row>('SELECT message_id, author_id, emoji FROM reaction ORDER BY date_sent') : new Map<number, Row[]>();
    const mentions = has('mention') ? byMessage<Row>('SELECT message_id, recipient_id, range_start, range_length FROM mention') : new Map<number, Row[]>();
    const polls = new Map<number, { question: string; multiple: boolean; options: string[] }>();
    if (has('poll') && has('poll_option'))
      for (const p of db.query('SELECT * FROM poll').all() as Row[])
        polls.set(p.message_id, {
          question: p.question ?? 'Poll',
          multiple: !!p.allow_multiple_votes,
          options: (db.query('SELECT option_text FROM poll_option WHERE poll_id = ? ORDER BY option_order').all(p._id) as Row[]).map((x) => x.option_text ?? ''),
        });
    const byId = db.query('SELECT * FROM message WHERE _id = ?');

    const fileFact = (a: Row): P.AttachmentFact | null => {
      if (!a.sha) {
        stats.files.missing++;
        return null;
      }
      const dest = mediaPath(o.mediaDir, a.sha, a.ext);
      if (!existsSync(dest)) {
        stats.files.missing++;
        return null;
      }
      stats.files.linked++;
      const f: P.AttachmentFact = { nativeId: a.sha, kind: attachmentKind(a.content_type), url: `file://${dest}`, name: a.file_name || a.sha + a.ext };
      if (a.content_type) f.mime = a.content_type;
      const size = a.data_size || a.blob_size;
      if (size) f.size = size;
      if (a.width) f.width = a.width;
      if (a.height) f.height = a.height;
      return f;
    };
    const readText = (a: Row): string | null => {
      if (!a.sha) return null;
      const p = mediaPath(o.mediaDir, a.sha, a.ext);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    };

    const rangesOf = (b: Uint8Array | null | undefined) => {
      const styles: { style: string; start: number; length: number }[] = [];
      const ms: { uuid: string; start: number; length: number }[] = [];
      if (!(b instanceof Uint8Array)) return { styles, mentions: ms };
      for (const r of fields(b).filter((f) => f.no === 1)) {
        const fs = fields(r.bytes!);
        const start = fs.find((f) => f.no === 1)?.int ?? 0;
        const length = fs.find((f) => f.no === 2)?.int ?? 0;
        const who = fs.find((f) => f.no === 3)?.bytes;
        const style = fs.find((f) => f.no === 4);
        if (who) {
          const aci = aciText(Buffer.from(who).toString('utf8'));
          if (aci) ms.push({ uuid: aci, start, length });
        } else if (style) {
          const s = STYLES[style.int ?? -1];
          if (s) styles.push({ style: s, start, length });
        }
      }
      return { styles, mentions: ms };
    };

    const reactionFacts = (ids: number[]): P.ReactionFact[] | undefined => {
      const by = new Map<string, Set<string>>();
      for (const id of ids)
        for (const r of reactions.get(id) ?? []) {
          const who = aciOf.get(r.author_id);
          if (!r.emoji || !who) continue;
          (by.get(r.emoji) ?? by.set(r.emoji, new Set()).get(r.emoji)!).add(who);
        }
      return by.size ? [...by].map(([key, authors]) => ({ key, authors: [...authors] })) : undefined;
    };

    const total = (db.query('SELECT COUNT(*) AS n FROM message').get() as Row).n as number;
    const seen = new Set<string>();
    let n = 0;
    const order = mcols.has('latest_revision_id') ? 'WHERE latest_revision_id IS NULL ' : '';
    for (const row of db.query(`SELECT * FROM message ${order}ORDER BY thread_id, _id`).iterate() as Iterable<Row>) {
      if (++n % 2000 === 0) o.progress?.(n / total);
      const chat = chats.get(row.thread_id);
      if (!chat) {
        skip('chat not kept');
        continue;
      }
      const m = mapRow(row);
      if (!m) continue;
      if (seen.has(m.nativeId)) {
        stats.duplicates++;
        continue;
      }
      seen.add(m.nativeId);
      m.conversation = chat.conversation.nativeId;
      chat.messages.push(m);
      chat.people.add(m.author);
      if (m.author === self) stats.selfMessages++;
      if (m.gone) stats.gone[m.gone.how]++;
    }

    function mapRow(row: Row): ImportMessageFact | null {
      const type = Number(row.type ?? 0);
      const base = type & BASE;
      const special = Math.floor(type / 0x100000000) & 0xf;
      if (row.story_type) return (skip('story'), null);
      const sms = base >= 20 && base <= 28 && !(type & (SECURE | PUSH)) && !(type & GROUP_UPDATE) && !(type & TIMER_UPDATE);
      if (row.m_type === MMS_NOTIFICATION) return (skip('mms never downloaded'), null);
      if (QUIET[base]) return (skip(QUIET[base]), null);
      if (type & END_SESSION || type & KEY_EXCHANGE_MASK || type & ENCRYPTION_FAILED) return (skip('session or safety number'), null);
      if (special && special !== 0x2 && special !== 0x3) return (skip(SPECIAL[special] ?? 'other update'), null);

      const outgoing = OUTGOING.has(base);
      const author = outgoing ? self : (idOf.get(row.from_recipient_id) ?? null);
      if (!author) return (skip('author without an ACI or number'), null);
      const orig = row.original_message_id ? (byId.get(row.original_message_id) as Row | null) : null;
      const ts = Number(orig?.date_sent ?? row.date_sent ?? 0);
      const m: ImportMessageFact = { nativeId: `${author}:${ts}`, conversation: '', author, ts, body: '' };
      if (orig && Number(row.date_sent) !== ts) m.editedTs = Number(row.date_sent);
      const extra: Record<string, unknown> = {};
      if (sms) extra.sms = row.m_type === MMS_SEND || row.m_type === MMS_RETRIEVED ? 'mms' : 'sms';
      if (row.expires_in) extra.expiresInSeconds = Math.round(Number(row.expires_in) / 1000);
      const who = nameOf(author);

      // Taken back by the network: kept here only if Molly kept it (keepmsg) and you didn't delete it yourself.
      const deleted = row.deleted_by != null || !!row.remote_deleted;
      if (row.keepmsg_expired) m.gone = { how: 'disappeared', ...(row.expire_started && row.expires_in ? { at: Number(row.expire_started) + Number(row.expires_in) } : {}) };
      else if (deleted) m.gone = { how: 'deleted', ...(row.keepmsg_deleted_at ? { at: Number(row.keepmsg_deleted_at) } : {}) };
      if (m.gone?.how === 'deleted' && author === self) return (skip('deleted by you'), null);

      const own = atts.get(row._id) ?? (orig ? (atts.get(orig._id) ?? []) : []);
      if (row.view_once) {
        // Respect the sender: view-once media stays on the phone, as live sync does.
        m.kind = 'media';
        m.body = '📷 View-once media (open it on your phone)';
        extra.viewOnce = true;
      } else if (type & TIMER_UPDATE) {
        const secs = Math.round(Number(row.expires_in ?? 0) / 1000);
        m.kind = 'system';
        m.body = secs ? `${who} set disappearing messages to ${describeTimer(secs)}.` : `${who} turned off disappearing messages.`;
        delete extra.expiresInSeconds;
      } else if (CALLS[base]) {
        const c = CALLS[base];
        m.kind = 'call';
        m.body = `${c.video ? '📹' : '📞'} ${c.dir} ${c.video ? 'video' : 'voice'} call`;
      } else if (base === GROUP_CALL) {
        m.kind = 'call';
        m.body = `📞 ${who} started a group call`;
      } else if (type & GROUP_UPDATE) {
        m.kind = 'system';
        m.body = `${who} updated the group.`;
      } else if (special === 0x2) m.body = '🎁 Gift badge';
      else if (special === 0x3) m.body = '💸 Payment';
      else if (polls.has(row._id) || (orig && polls.has(orig._id))) {
        const p = polls.get(row._id) ?? polls.get(orig!._id)!;
        m.body = [`📊 **${p.question}**${p.multiple ? ' (multiple choice)' : ''}`, ...p.options.map((x) => `• ${x}`)].join('\n');
        extra.poll = { question: p.question, options: p.options, allowMultiple: p.multiple };
      } else if (row.shared_contacts) {
        m.body = sharedContact(row.shared_contacts);
      } else {
        const sticker = own.find((a) => a.sticker_pack_id);
        if (sticker) {
          m.kind = 'sticker';
          m.body = sticker.sticker_emoji ?? '';
          const a = fileFact(sticker);
          if (a) m.attachments = [{ ...a, name: 'sticker' }];
          extra.sticker = { packId: String(sticker.sticker_pack_id), stickerId: Number(sticker.sticker_id ?? 0) };
        } else {
          const long = own.find((a) => !a.quote && a.content_type === 'text/x-signal-plain');
          const full = long ? readText(long) : null;
          const r = rangesOf(row.message_ranges);
          const ms = [...r.mentions, ...(mentions.get(row._id) ?? []).map((x) => ({ uuid: aciOf.get(x.recipient_id) ?? '', start: x.range_start, length: x.range_length })).filter((x) => x.uuid)];
          let mentionsSelf = false;
          m.body = fromSignal(full ?? row.body ?? '', r.styles, ms, { onMention: (aci) => (mentionsSelf ||= aci.toLowerCase() === self) });
          if (mentionsSelf || row.mentions_self) m.mentionsSelf = true;
          const files = own.filter((a) => !a.quote && a !== long);
          const facts = files.map(fileFact).filter((a): a is P.AttachmentFact => !!a);
          m.kind = facts.length ? 'media' : 'text';
          const used = new Set<string>();
          for (const [i, a] of facts.entries()) {
            if (used.has(a.nativeId!)) a.nativeId = `${a.nativeId}#${i}`;
            used.add(a.nativeId!);
          }
          if (facts.length) m.attachments = facts;
          if (row.parent_story_id) extra.storyReply = true;
          if (row.quote_id) {
            const qa = aciOf.get(row.quote_author) ?? null;
            const qts = Number(row.quote_id);
            if (qa && qts) m.replyTo = `${qa}:${qts}`;
            const qatts = own.filter((a) => a.quote);
            extra.quote = { author: qa, ts: qts || null, text: fromSignal(row.quote_body ?? ''), ...(qatts.length ? { attachments: qatts.map((a) => ({ mime: a.content_type ?? null, name: a.file_name ?? null })) } : {}) };
          }
          if (!m.body && !facts.length) {
            if (files.length) m.body = '📎 Attachment (not in the backup)';
            else if (m.gone) return (skip(`${m.gone.how}, nothing kept`), null);
            else return (skip('empty'), null);
          }
        }
      }
      m.reactions = reactionFacts(orig ? [orig._id, row._id] : [row._id]);
      if (!m.reactions) delete m.reactions;
      if (Object.keys(extra).length) m.extra = extra;
      return m;
    }

    for (const c of chats.values()) {
      if (!c.messages.length) continue;
      stats.conversations++;
      stats.messages += c.messages.length;
      const people = new Set([...c.people, ...(c.conversation.participants ?? [])]);
      emit({ t: 'conversation', conversation: c.conversation, identities: [...people].map((p) => identities.get(p)).filter(Boolean), messages: c.messages.length });
      for (const m of c.messages) emit({ t: 'message', m });
    }
    return stats;
  } finally {
    db.close();
  }
}

/** A shared contact (the message's shared_contacts JSON), worded as live sync words it. */
function sharedContact(json: string): string {
  try {
    const c = (JSON.parse(json) as Row[])[0] ?? {};
    const nm = c.name ?? {};
    const name = joinName(nm.prefix, nm.givenName, nm.middleName, nm.familyName, nm.suffix) ?? nm.nickname ?? c.organization ?? 'Contact';
    const values = [...(c.phoneNumbers ?? []).map((x: Row) => x.number), ...(c.emails ?? []).map((x: Row) => x.email)].filter(Boolean);
    return `👤 ${name}${values.length ? ' · ' + values.join(', ') : ''}`;
  } catch {
    return '👤 Contact';
  }
}

export interface ReadLegacyOptions {
  /** The .backup file. */
  file: string;
  passphrase: string;
  /** Where the unpacked database is kept (the facts' work folder). */
  workDir: string;
  selfId: string;
  mediaDir: string;
  sourceSha: string;
  progress?: (p: number) => void;
}

/** Unpack (unless this source's unpacked database is already there) and map. */
export function readSignalLegacy(o: ReadLegacyOptions, emit: (line: unknown) => void): LegacyReadStats {
  const dbPath = join(o.workDir, '..', 'legacy.sqlite');
  const stamp = join(o.workDir, '..', 'legacy.json');
  const want = { sourceSha: o.sourceSha, unpack: LEGACY_UNPACK };
  let fresh = false;
  try {
    const have = JSON.parse(readFileSync(stamp, 'utf8'));
    fresh = have.sourceSha === want.sourceSha && have.unpack === want.unpack && existsSync(dbPath);
  } catch {}
  if (!fresh) {
    const stats = unpackLegacy(o.file, o.passphrase, dbPath, o.mediaDir, (p) => o.progress?.(p * 0.85));
    writeFileSync(stamp, JSON.stringify({ ...want, stats, at: Date.now() }, null, 2), { mode: 0o600 });
  }
  return mapLegacy(dbPath, { selfId: o.selfId, mediaDir: o.mediaDir, progress: (p) => o.progress?.(0.85 + p * 0.15) }, emit);
}
