/**
 * A Signal Desktop profile (docs/import-signal.md, "Reading a Signal Desktop profile"): what a Desktop linked to the
 * account saw while it ran. Same message identity as live sync, so its messages meet the hub's on the same rows and
 * fill the hub's gaps.
 *
 *   config.json            the database key: `key` (64 hex digits), or `encryptedKey` wrapped by Electron's safeStorage
 *   sql/db.sqlite (-wal)   SQLCipher 4 under that key (sqlcipher.ts)
 *   attachments.noindex/   each attachment at message_attachments.path; version 2 is sealed with its own localKey
 *                          (IV ‖ AES-256-CBC ‖ HMAC-SHA256, padded; trimmed to its size, checked by its plaintext hash)
 *
 * Reading is two steps, like the .backup reader:
 *
 *  1. unpackDesktop decrypts the database (and its write-ahead log) into a private plain copy in the source's work
 *     folder, `desktop.sqlite` (0600), stamped with the source's hash in `desktop.json`. The census does this, and the
 *     reader reuses it.
 *  2. mapDesktop turns `conversations` and `messages` (their `json`) into the live adapter's facts: "<author ACI>:<sent
 *     time>" messages, dm:/group: conversations, Markdown through fromSignal, edits by their newest time, quotes,
 *     reactions, stickers, shared contacts, polls, pins. Attachments go into the media
 *     store under the SHA-256 of their bytes, the name the other Signal readers give the same file.
 */
import { Database } from 'bun:sqlite';
import { createDecipheriv, createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { fromSignal } from '../../../adapter-signal/src/markdown.ts';
import { dmId, groupConvId, LONG_TEXT_MIME, msgId } from '../../../adapter-signal/src/mapping.ts';
import { contactLine, distinctFiles, joinName, pollBody, VIEW_ONCE_BODY } from './signal-common.ts';
import { decryptSqlcipher, parseRawKey } from './sqlcipher.ts';

export const SIGNAL_DESKTOP_READER = 'signal-desktop@1';
/** The plain copy's own version: a new one decrypts again, a new mapping alone does not. */
const DESKTOP_UNPACK = 1;

type Row = Record<string, any>;

// ------------------------------------------------------------------ the profile and its key

/** The profile folder in a source: the one holding sql/db.sqlite (the source's root, or a folder in it). */
export function desktopProfile(root: string): string | null {
  if (existsSync(join(root, 'sql', 'db.sqlite'))) return root;
  if (!existsSync(root)) return null;
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name === 'db.sqlite' && e.parentPath.endsWith('/sql')) {
      const p = dirname(e.parentPath);
      if (relative(root, p).split('/').length <= 3) return p;
    }
  }
  return null;
}

/**
 * Chromium's OSCrypt on Linux, which Electron's safeStorage is: "v10" is AES-128-CBC under a key from the fixed
 * password "peanuts" (the basic_text store, no keyring); "v11" uses the keyring's secret, which is not in the profile.
 * An empty secret is tried too, which is what a keyring that gave none leaves.
 */
function unwrapSafeStorage(hex: string): string | null {
  const b = Buffer.from(hex, 'hex');
  const prefix = b.subarray(0, 3).toString('latin1');
  const passwords = prefix === 'v10' ? ['peanuts'] : prefix === 'v11' ? [''] : [];
  for (const pw of passwords) {
    try {
      const key = pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1');
      const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
      const s = Buffer.concat([d.update(b.subarray(3)), d.final()]).toString('latin1');
      if (parseRawKey(s)) return s;
    } catch {}
  }
  return null;
}

/**
 * The database key from config.json, or why there is none: `keyring` when it is wrapped by a desktop keyring
 * (gnome-libsecret, kwallet), which only that machine can open. Then the key has to be given by hand.
 */
export function desktopKey(profile: string): { key: Buffer } | { missing: 'keyring' | 'config' } {
  let cfg: Row;
  try {
    cfg = JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8'));
  } catch {
    return { missing: 'config' };
  }
  const plain = typeof cfg.key === 'string' ? parseRawKey(cfg.key) : null;
  if (plain) return { key: plain };
  if (typeof cfg.encryptedKey === 'string' && /^[0-9a-f]+$/i.test(cfg.encryptedKey)) {
    const s = unwrapSafeStorage(cfg.encryptedKey);
    if (s) return { key: parseRawKey(s)! };
    return { missing: 'keyring' };
  }
  return { missing: 'config' };
}

// ------------------------------------------------------------------ step 1: the plain copy

interface DesktopUnpack {
  pages: number;
  walPages: number;
}

/** Decrypt the profile's database into `dbPath` unless this source's copy is already there. */
export function unpackDesktop(o: { profile: string; key: Buffer; dbPath: string; sourceSha: string; progress?: (p: number) => void }): DesktopUnpack {
  const stamp = join(dirname(o.dbPath), 'desktop.json');
  const want = { sourceSha: o.sourceSha, unpack: DESKTOP_UNPACK };
  try {
    const have = JSON.parse(readFileSync(stamp, 'utf8'));
    if (have.sourceSha === want.sourceSha && have.unpack === want.unpack && existsSync(o.dbPath)) return have.stats;
  } catch {}
  mkdirSync(dirname(o.dbPath), { recursive: true, mode: 0o700 });
  const s = decryptSqlcipher(join(o.profile, 'sql', 'db.sqlite'), o.key, o.dbPath, o.progress);
  const stats: DesktopUnpack = { pages: s.pages, walPages: s.walPages };
  writeFileSync(stamp, JSON.stringify({ ...want, stats, at: Date.now() }, null, 2), { mode: 0o600 });
  return stats;
}

const aciText = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s) return null;
  const v = s.replace(/^ACI:/i, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;
};

/** The ACI this Desktop is linked as: items.uuid_id is "<aci>.<device>". */
function selfOf(db: Database): string | null {
  const r = db.query(`SELECT json FROM items WHERE id = 'uuid_id'`).get() as Row | null;
  try {
    const v = JSON.parse(r?.json ?? 'null')?.value;
    return typeof v === 'string' ? aciText(v.replace(/\.\d+$/, '')) : null;
  } catch {
    return null;
  }
}

/** The ACI a plain copy's Desktop is linked as, if it says. */
export function desktopSelf(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'`).get() ? selfOf(db) : null;
  } finally {
    db.close();
  }
}

const month = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 7) : null);

/** Counts and shapes of a plain copy, never content. */
export function censusDesktop(dbPath: string, profile: string, unpack: DesktopUnpack): P.ImportCensus {
  const db = new Database(dbPath, { readonly: true });
  try {
    const has = (t: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (!has('messages') || !has('conversations')) throw new Error('this database has no messages or conversations: it is not Signal Desktop’s');
    const types: Record<string, number> = {};
    for (const r of db.query('SELECT type, COUNT(*) AS n FROM messages GROUP BY type').all() as Row[]) types[r.type ?? 'none'] = r.n;
    const range = db.query(`SELECT MIN(sent_at) AS a, MAX(sent_at) AS b FROM messages WHERE type IN ('incoming', 'outgoing')`).get() as Row;
    const convs: Record<string, number> = {};
    for (const r of db.query('SELECT type, COUNT(*) AS n FROM conversations GROUP BY type').all() as Row[]) convs[r.type ?? 'none'] = r.n;
    let attachments = 0;
    let onDisk = 0;
    if (has('message_attachments'))
      for (const r of db.query(`SELECT path FROM message_attachments WHERE attachmentType IN ('attachment', 'long-message', 'sticker')`).all() as Row[]) {
        attachments++;
        if (r.path && existsSync(join(profile, 'attachments.noindex', r.path))) onDisk++;
      }
    const version = (() => {
      try {
        return JSON.parse((db.query(`SELECT json FROM items WHERE id = 'version'`).get() as Row | null)?.json ?? 'null')?.value ?? null;
      } catch {
        return null;
      }
    })();
    return {
      format: 'signal-desktop',
      desktopVersion: typeof version === 'string' ? version : null,
      linked: !!selfOf(db),
      messages: (types.incoming ?? 0) + (types.outgoing ?? 0),
      otherRows: Object.entries(types).reduce((n, [k, v]) => (k === 'incoming' || k === 'outgoing' ? n : n + v), 0),
      firstMonth: month(range?.a),
      lastMonth: month(range?.b),
      conversations: { direct: convs.private ?? 0, group: convs.group ?? 0 },
      attachments: { count: attachments, onDisk },
      walPages: unpack.walPages,
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ step 2: facts

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'video/mp4': '.mp4',
  'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/x-signal-plain': '.txt',
};
const extOf = (name: string | null | undefined, mime: string | null | undefined) => (name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? MIME_EXT[mime ?? ''] ?? '').toLowerCase();

/** BodyRange.Style as Desktop stores it (the protobuf's numbers). */
const STYLES: Record<number, string> = { 1: 'BOLD', 2: 'ITALIC', 3: 'SPOILER', 4: 'STRIKETHROUGH', 5: 'MONOSPACE' };

/** Message types with no line in the hub, counted under these names. */
const QUIET: Record<string, string> = {
  keychange: 'safety number', 'verified-change': 'safety number', 'profile-change': 'profile change', 'message-request-response-event': 'message request',
  'change-number-notification': 'number change', 'chat-session-refreshed': 'session', 'delivery-issue': 'delivery issue', 'joined-signal-notification': 'joined',
  'universal-timer-notification': 'timer hint', 'title-transition-notification': 'name change', 'conversation-merge': 'chat merge', 'phone-number-discovery': 'number found',
  'group-v1-migration': 'group v1 migration', 'contact-removed-notification': 'contact removed', story: 'story',
  // Lines Desktop writes at its own time, seconds off the message live sync got (checked on a real profile): they
  // would meet no hub row and come in a second time beside the live one, so they are left out.
  'group-v2-change': 'group change', 'timer-notification': 'timer change', 'call-history': 'call',
};

function attachmentKind(mime?: string | null): P.AttachmentKind {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

/** A version-2 attachment: IV ‖ AES-256-CBC ‖ HMAC-SHA256 under its 64-byte localKey, padded past `size`. */
export function openLocalAttachment(data: Buffer, localKey: Buffer, size: number, plaintextHash?: string | null): Buffer {
  if (localKey.length !== 64) throw new Error('an attachment key is 64 bytes');
  if (data.length < 16 + 16 + 32) throw new Error('an attachment file is too short');
  const body = data.subarray(0, data.length - 32);
  const mac = createHmac('sha256', localKey.subarray(32)).update(body).digest();
  if (!timingSafeEqual(mac, data.subarray(data.length - 32))) throw new Error('an attachment does not authenticate');
  const d = createDecipheriv('aes-256-cbc', localKey.subarray(0, 32), body.subarray(0, 16));
  const plain = Buffer.concat([d.update(body.subarray(16)), d.final()]).subarray(0, size);
  if (plaintextHash && createHash('sha256').update(plain).digest('hex') !== plaintextHash.toLowerCase()) throw new Error('an attachment does not match its hash');
  return plain;
}

interface DesktopReadStats {
  conversations: number;
  messages: number;
  duplicates: number;
  selfMessages: number;
  files: { linked: number; missing: number };
  skipped: Record<string, number>;
}

interface MapOptions {
  selfId: string;
  /** The profile folder, for attachments.noindex/. */
  profile: string;
  mediaDir: string;
  /**
   * Counts only (scripts/audit-parity.ts): an attachment on disk is a fact without its bytes being opened or copied
   * into mediaDir, and a long message's text file is not read.
   */
  countOnly?: boolean;
  progress?: (p: number) => void;
}

/** Turn the plain copy into facts: each conversation, then its messages. */
export function mapDesktop(dbPath: string, o: MapOptions, emit: (line: unknown) => void): DesktopReadStats {
  const self = o.selfId.toLowerCase();
  const db = new Database(dbPath, { readonly: true });
  const stats: DesktopReadStats = { conversations: 0, messages: 0, duplicates: 0, selfMessages: 0, files: { linked: 0, missing: 0 }, skipped: {} };
  const skip = (why: string) => (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);
  const has = (t: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const attRoot = resolve(o.profile, 'attachments.noindex');
  try {
    if (!has('messages') || !has('conversations')) throw new Error('this database has no messages or conversations: it is not Signal Desktop’s');
    const linked = has('items') ? selfOf(db) : null;
    if (linked && linked !== self) throw new Error('this Signal Desktop is linked to another account');

    // People and chats. A person's conversation row is how reactions name them (fromId).
    const identities = new Map<string, P.IdentityFact>();
    const names = new Map<string, string>();
    const aciOfConv = new Map<string, string>();
    const chats = new Map<string, { conversation: P.ConversationFact; messages: P.MessageFact[]; people: Set<string> }>();
    for (const c of db.query('SELECT id, type, serviceId, groupId, json FROM conversations').all() as Row[]) {
      let j: Row = {};
      try {
        j = JSON.parse(c.json ?? '{}');
      } catch {}
      if (c.type === 'private') {
        const aci = aciText(c.serviceId ?? j.serviceId);
        if (!aci) continue;
        aciOfConv.set(c.id, aci);
        const idf: P.IdentityFact = { nativeId: aci };
        const name =
          joinName(j.nicknameGivenName, j.nicknameFamilyName) ??
          joinName(j.systemGivenName, j.systemFamilyName) ??
          joinName(j.name) ??
          joinName(j.profileName, j.profileFamilyName) ??
          joinName(j.username);
        if (name) idf.displayName = name;
        const e164 = j.e164 ?? null;
        if (typeof e164 === 'string' && e164) idf.handle = e164.startsWith('+') ? e164 : `+${e164}`;
        else if (j.username) idf.handle = `@${j.username}`;
        if (aci === self) idf.isSelf = true;
        else if (name) names.set(aci, name);
        identities.set(aci, idf);
        const conv: P.ConversationFact = aci === self ? { nativeId: dmId(self, self), shape: 'self', name: 'Note to Self', participants: [self], encrypted: true } : { nativeId: dmId(self, aci), shape: 'direct', participants: [self, aci], encrypted: true };
        if (j.isArchived) conv.archived = true;
        chats.set(c.id, { conversation: conv, messages: [], people: new Set() });
      } else if (c.type === 'group') {
        const gid = c.groupId ?? j.groupId;
        if (j.groupVersion !== 2 || typeof gid !== 'string' || Buffer.from(gid, 'base64').length !== 32) continue;
        const conv: P.ConversationFact = { nativeId: groupConvId(gid), shape: 'group', encrypted: true };
        if (typeof j.name === 'string' && j.name) conv.name = j.name;
        const members = (Array.isArray(j.membersV2) ? j.membersV2 : []).map((m: Row) => aciText(m?.aci)).filter((x: string | null): x is string => !!x);
        if (members.length) conv.participants = [...new Set(members)] as string[];
        if (j.isArchived) conv.archived = true;
        chats.set(c.id, { conversation: conv, messages: [], people: new Set() });
      }
    }
    const nameOf = (aci: string | null) => (aci === self ? 'You' : (aci && names.get(aci)) || 'Someone');

    // Attachments, per message, from their own table (Desktop 7.x on) or the message's json (before).
    const attTable = has('message_attachments');
    const attsOf = attTable ? db.query(`SELECT * FROM message_attachments WHERE messageId = ? AND (editHistoryIndex IS NULL OR editHistoryIndex = -1) ORDER BY orderInMessage`) : null;

    const stored = (a: Row): { sha: string; path: string } | null => {
      if (typeof a.path !== 'string' || !a.path) return null;
      const abs = resolve(attRoot, a.path);
      if (!abs.startsWith(attRoot + '/') || !existsSync(abs)) return null;
      if (o.countOnly) return { sha: typeof a.plaintextHash === 'string' && a.plaintextHash ? a.plaintextHash : createHash('sha256').update(a.path).digest('hex'), path: abs };
      let bytes: Buffer;
      try {
        const raw = readFileSync(abs);
        const localKey = typeof a.localKey === 'string' ? Buffer.from(a.localKey, 'base64') : null;
        bytes = Number(a.version) === 2 && localKey ? openLocalAttachment(raw, localKey, Number(a.size ?? raw.length), a.plaintextHash) : raw;
      } catch {
        return null;
      }
      const sha = createHash('sha256').update(bytes).digest('hex');
      const ext = extOf(a.fileName, a.contentType);
      const dir = join(o.mediaDir, sha.slice(0, 2));
      const dest = join(dir, sha + ext);
      if (!existsSync(dest)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const fd = openSync(dest + '.tmp', 'w', 0o600);
        try {
          for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
        } finally {
          closeSync(fd);
        }
        renameSync(dest + '.tmp', dest);
      }
      return { sha, path: dest };
    };
    const fileFact = (a: Row): P.AttachmentFact | null => {
      const s = stored(a);
      if (!s) {
        stats.files.missing++;
        return null;
      }
      stats.files.linked++;
      const f: P.AttachmentFact = { nativeId: s.sha, kind: attachmentKind(a.contentType), url: `file://${s.path}`, name: a.fileName || s.sha + extOf(null, a.contentType) };
      if (a.contentType) f.mime = a.contentType;
      const size = Number(a.size) || statSync(s.path).size;
      if (size) f.size = size;
      if (a.width) f.width = Number(a.width);
      if (a.height) f.height = Number(a.height);
      return f;
    };

    const rangesOf = (ranges: unknown) => {
      const styles: { style: string; start: number; length: number }[] = [];
      const mentions: { uuid: string; start: number; length: number }[] = [];
      for (const r of Array.isArray(ranges) ? (ranges as Row[]) : []) {
        const start = Number(r?.start ?? 0);
        const length = Number(r?.length ?? 0);
        const aci = aciText(r?.mentionAci ?? r?.mentionUuid);
        if (aci) mentions.push({ uuid: aci, start, length });
        else if (STYLES[r?.style]) styles.push({ style: STYLES[r.style], start, length });
      }
      return { styles, mentions };
    };

    const total = (db.query('SELECT COUNT(*) AS n FROM messages').get() as Row).n as number;
    const seen = new Set<string>();
    let n = 0;
    for (const row of db.query('SELECT * FROM messages ORDER BY conversationId, sent_at, id').iterate() as Iterable<Row>) {
      if (++n % 2000 === 0) o.progress?.(n / total);
      if (QUIET[row.type]) {
        skip(QUIET[row.type]);
        continue;
      }
      const chat = chats.get(row.conversationId);
      if (!chat) {
        skip('chat without an ACI or a new-style group id');
        continue;
      }
      let j: Row;
      try {
        j = JSON.parse(row.json ?? '{}');
      } catch {
        skip('unreadable');
        continue;
      }
      // Newer Desktops keep some fields (body, isViewOnce, isErased, …) only in their own columns.
      for (const [k, v] of Object.entries(row)) if (k !== 'json' && j[k] === undefined && v !== null) j[k] = v;
      const m = mapRow(row, j, chat.conversation);
      if (!m) continue;
      if (seen.has(m.nativeId)) {
        stats.duplicates++;
        continue;
      }
      seen.add(m.nativeId);
      chat.messages.push(m);
      chat.people.add(m.author);
      if (m.author === self) stats.selfMessages++;
    }

    function mapRow(row: Row, j: Row, conv: P.ConversationFact): P.MessageFact | null {
      const ts = Number(row.sent_at ?? j.sent_at ?? 0);
      if (!ts) return (skip('no time'), null);
            const fact = (author: string, kind: P.MessageKind, body: string): P.MessageFact => ({ nativeId: msgId(author, ts), conversation: conv.nativeId, author, ts, kind, body });

      if (row.type === 'pinned-message-notification') {
        const author = aciText(row.sourceServiceId);
        if (!author) return (skip('pin without an author'), null);
        const m = fact(author, 'system', `${nameOf(author)} pinned a message.`);
        const target = aciText(j.pinMessage?.targetAuthorAci);
        if (target && j.pinMessage?.targetSentTimestamp) m.replyTo = msgId(target, Number(j.pinMessage.targetSentTimestamp));
        return m;
      }
      if (row.type !== 'incoming' && row.type !== 'outgoing') return (skip(String(row.type ?? 'unknown type')), null);

      const author = row.type === 'outgoing' ? self : aciText(row.sourceServiceId ?? j.sourceServiceId);
      if (!author) return (skip('author without an ACI'), null);
      if (j.deletedForEveryone || j.isErased) return (skip('deleted'), null);
      if (j.storyId && !j.storyReplyContext) return (skip('story'), null);
      const m = fact(author, 'text', '');
      const extra: Record<string, unknown> = {};
      const editedTs = Number(j.editMessageTimestamp ?? 0);
      if (editedTs && editedTs !== ts) m.editedTs = editedTs;
      if (row.expireTimer || j.expireTimer) extra.expiresInSeconds = Number(row.expireTimer ?? j.expireTimer);

      const rows: Row[] = attsOf ? (attsOf.all(row.id) as Row[]) : (Array.isArray(j.attachments) ? j.attachments : []).map((a: Row) => ({ ...a, attachmentType: a.contentType === LONG_TEXT_MIME ? 'long-message' : 'attachment' }));
      const long = rows.find((a) => a.attachmentType === 'long-message') ?? (j.bodyAttachment ? { ...j.bodyAttachment, attachmentType: 'long-message' } : null);
      const files = rows.filter((a) => a.attachmentType === 'attachment');

      if (j.isViewOnce) {
        // Respect the sender: view-once media stays on the phone, as live sync does.
        m.kind = 'media';
        m.body = VIEW_ONCE_BODY;
        extra.viewOnce = true;
      } else if (j.sticker?.packId) {
        m.kind = 'sticker';
        m.body = typeof j.sticker.emoji === 'string' ? j.sticker.emoji : '';
        const data = rows.find((a) => a.attachmentType === 'sticker') ?? (j.sticker.data ? { ...j.sticker.data } : null);
        const a = data ? fileFact(data) : null;
        if (a) m.attachments = [{ ...a, nativeId: `sticker:${j.sticker.packId}:${j.sticker.stickerId}`, kind: 'image', name: 'sticker', mime: a.mime || 'image/webp' }];
        extra.sticker = { packId: String(j.sticker.packId), stickerId: Number(j.sticker.stickerId ?? 0) };
      } else {
        let text: string | null = null;
        if (long) {
          const s = stored(long);
          if (s && !o.countOnly) text = readFileSync(s.path, 'utf8');
        }
        const r = rangesOf(j.bodyRanges);
        let mentionsSelf = false;
        m.body = fromSignal(text ?? j.body ?? '', r.styles, r.mentions, { onMention: (aci) => (mentionsSelf ||= aci.toLowerCase() === self) });
        if (mentionsSelf || row.mentionsMe) m.mentionsSelf = true;
        const facts = files.map(fileFact).filter((a): a is P.AttachmentFact => !!a);
        distinctFiles(facts);
        if (facts.length) {
          m.kind = 'media';
          m.attachments = facts;
        }
        // What live sync adds to the words: a poll, shared contacts, a payment, a gift badge.
        const lines: string[] = [];
        if (j.poll?.question || Array.isArray(j.poll?.options)) {
          const p = j.poll;
          const options = (Array.isArray(p.options) ? p.options : []).map((x: unknown) => (typeof x === 'string' ? x : String((x as Row)?.text ?? '')));
          lines.push(pollBody(p.question ?? 'Poll', options, !!p.allowMultiple));
          extra.poll = { question: p.question, options, allowMultiple: !!p.allowMultiple };
        }
        for (const c of Array.isArray(j.contact) ? (j.contact as Row[]) : []) {
          const nm = c.name ?? {};
          const name = joinName(nm.prefix, nm.givenName, nm.middleName, nm.familyName, nm.suffix) ?? nm.nickname ?? nm.displayName ?? c.organization ?? 'Contact';
          const values = [...(c.number ?? []).map((x: Row) => x?.value), ...(c.email ?? []).map((x: Row) => x?.value)].filter(Boolean);
          lines.push(contactLine(name, values));
        }
        if (j.payment) lines.push(`💸 Payment${j.payment.note ? `: ${j.payment.note}` : ''}`);
        if (j.giftBadge) lines.push('🎁 Gift badge');
        if (lines.length) m.body = [m.body, ...lines].filter(Boolean).join('\n');

        const q = j.quote;
        if (q && (q.id || q.authorAci)) {
          const qa = aciText(q.authorAci ?? q.authorUuid);
          const qts = Number(q.id ?? 0);
          if (qa && qts) m.replyTo = msgId(qa, qts);
          const qr = rangesOf(q.bodyRanges);
          const qatts = Array.isArray(q.attachments) ? (q.attachments as Row[]) : [];
          extra.quote = { author: qa, ts: qts || null, text: fromSignal(q.text ?? '', qr.styles, qr.mentions), ...(qatts.length ? { attachments: qatts.map((a) => ({ mime: a.contentType ?? null, name: a.fileName ?? null })) } : {}) };
        }
        if (j.storyReplyContext) extra.storyReply = { author: aciText(j.storyReplyContext.authorAci) };
        if (!m.body && !facts.length) {
          if (files.length || long) m.body = '📎 Attachment (not in the profile)';
          else return (skip('empty'), null);
        }
      }

      // With when each was sent, as its time (docs/reactions.md "When"). fromId names the reactor's conversation.
      const by = new Map<string, { authors: Set<string>; at: Record<string, number> }>();
      for (const r of Array.isArray(j.reactions) ? (j.reactions as Row[]) : []) {
        const who = aciOfConv.get(r?.fromId) ?? aciText(r?.fromId);
        if (!r?.emoji || !who) continue;
        const e = by.get(r.emoji) ?? by.set(r.emoji, { authors: new Set(), at: {} }).get(r.emoji)!;
        e.authors.add(who);
        if (typeof r.timestamp === 'number' && r.timestamp > 0) e.at[who] = r.timestamp;
      }
      if (by.size) m.reactions = [...by].map(([key, e]) => ({ key, authors: [...e.authors], ...(Object.keys(e.at).length ? { at: e.at } : {}) }));
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

interface ReadDesktopOptions {
  profile: string;
  key: Buffer;
  /** The facts' folder (work/<source>/<reader>); the plain copy is kept one up, with the source's other work. */
  workDir: string;
  selfId: string;
  mediaDir: string;
  sourceSha: string;
  progress?: (p: number) => void;
}

/** Decrypt (unless this source's copy is already there) and map. */
export function readSignalDesktop(o: ReadDesktopOptions, emit: (line: unknown) => void): DesktopReadStats {
  const dbPath = join(o.workDir, '..', 'desktop.sqlite');
  unpackDesktop({ profile: o.profile, key: o.key, dbPath, sourceSha: o.sourceSha, progress: (p) => o.progress?.(p * 0.5) });
  return mapDesktop(dbPath, { selfId: o.selfId, profile: o.profile, mediaDir: o.mediaDir, progress: (p) => o.progress?.(0.5 + p * 0.5) }, emit);
}
