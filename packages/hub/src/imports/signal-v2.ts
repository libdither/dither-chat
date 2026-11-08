/**
 * Signal's new backup format (backup v2) as Molly writes it on the device (docs/import-signal.md):
 *
 *   SignalBackups/signal-backup-<time>/metadata   Metadata{version, backupId{iv, encryptedId}}
 *   SignalBackups/signal-backup-<time>/main       IV ‖ AES-256-CBC(gzip(varint-delimited frames)) ‖ HMAC-SHA256
 *   SignalBackups/files/<2 hex>/<name>            each attachment: IV ‖ AES-256-CBC(padded bytes) ‖ HMAC-SHA256,
 *                                                 name = hex(SHA-256(plaintextHash ‖ localKey)), key = localKey
 *
 * The frames are BackupInfo, then AccountData, Recipients, Chats and ChatItems (Backup.proto). This turns them into
 * the same facts the live Signal adapter makes, ids included (msgId, dmId, group ids from the master key), so an
 * import and live sync meet on the same rows. Only the backup key (from the recovery key) is needed; nothing is
 * read from the network.
 */
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { fromSignal } from '../../../adapter-signal/src/markdown.ts';
import { decryptBackupId, groupIdFromMasterKey, messageBackupKeys } from './signal-keys.ts';
import { type Field, fields } from './signal-backup.ts';

export const SIGNAL_V2_READER = 'signal-v2@1';

export class BadBackupKey extends Error {
  constructor() {
    super('That recovery key does not open this backup.');
  }
}

// ------------------------------------------------------------------ protobuf helpers

const all = (fs: Field[] | null, no: number) => (fs ?? []).filter((f) => f.no === no);
const one = (fs: Field[] | null, no: number) => fs?.find((f) => f.no === no);
const sub = (fs: Field[] | null, no: number): Field[] | null => {
  const f = one(fs, no);
  return f?.bytes ? fields(f.bytes) : null;
};
const str = (fs: Field[] | null, no: number): string | undefined => {
  const f = fs && one(fs, no);
  return f?.bytes ? Buffer.from(f.bytes).toString('utf8') : undefined;
};
const int = (fs: Field[] | null, no: number): number | undefined => (fs ? one(fs, no)?.int : undefined);
const bytes = (fs: Field[] | null, no: number): Uint8Array | undefined => (fs ? one(fs, no)?.bytes : undefined);
const uuid = (b?: Uint8Array): string | null => {
  if (!b || b.length !== 16) return null;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// ------------------------------------------------------------------ finding and opening a snapshot

/** The snapshots in a folder (each a signal-backup-<time> directory with `main` and `metadata`), oldest first. */
export function snapshots(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (e.isDirectory() && /^signal-backup-/.test(e.name) && existsSync(join(e.parentPath, e.name, 'main')) && existsSync(join(e.parentPath, e.name, 'metadata'))) out.push(join(e.parentPath, e.name));
  return out.sort((a, b) => (a.split('/').pop()! < b.split('/').pop()! ? -1 : 1));
}

/** The shared `files` folder beside a snapshot. */
export const filesDir = (snapshot: string) => join(snapshot, '..', 'files');

const MAGIC = Buffer.from('SBACKUP\x01', 'latin1');

/** The frames of a snapshot, decrypted and checked. Throws BadBackupKey when the key is not this backup's. */
export function openSnapshot(snapshot: string, backupKey: Uint8Array): Uint8Array {
  const meta = fields(readFileSync(join(snapshot, 'metadata')));
  const enc = sub(meta, 2);
  const iv = bytes(enc, 1);
  const id = bytes(enc, 2);
  if (!iv || !id) throw new Error('this snapshot has no backup id in its metadata');
  const keys = messageBackupKeys(backupKey, decryptBackupId(backupKey, iv, id));
  let main: Buffer = readFileSync(join(snapshot, 'main'));
  // A backup that went through Signal's servers starts with forward-secrecy data; a local one doesn't, but skip it.
  if (main.subarray(0, 8).equals(MAGIC)) {
    let i = 8;
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = main[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
    }
    main = main.subarray(i + n);
  }
  if (main.length < 16 + 16 + 32) throw new Error('the snapshot is cut short');
  const body = main.subarray(0, main.length - 32);
  const mac = createHmac('sha256', keys.hmacKey).update(body).digest();
  if (!timingSafeEqual(mac, main.subarray(main.length - 32))) throw new BadBackupKey();
  const d = createDecipheriv('aes-256-cbc', keys.aesKey, body.subarray(0, 16));
  return Bun.gunzipSync(Buffer.concat([d.update(body.subarray(16)), d.final()]));
}

/** Each varint-delimited record of a decrypted stream, the BackupInfo first. */
export function* records(b: Uint8Array): Generator<Uint8Array> {
  let i = 0;
  while (i < b.length) {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const x = b[i++];
      if (x === undefined) throw new Error('truncated frame length');
      n += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) break;
    }
    if (i + n > b.length) throw new Error('truncated frame');
    yield b.subarray(i, i + n);
    i += n;
  }
}

/** An attachment from the shared files folder, decrypted and checked against its plaintext hash. Null if absent. */
export function readAttachment(files: string, plaintextHash: Uint8Array, localKey: Uint8Array, size: number): Buffer | null {
  if (localKey.length !== 64) return null;
  const name = createHash('sha256').update(plaintextHash).update(localKey).digest('hex');
  const path = join(files, name.slice(0, 2), name);
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  let data: Buffer;
  try {
    data = Buffer.alloc(fstatSync(fd).size);
    readSync(fd, data, 0, data.length, 0);
  } finally {
    closeSync(fd);
  }
  if (data.length < 16 + 16 + 32) return null;
  const body = data.subarray(0, data.length - 32);
  const mac = createHmac('sha256', localKey.subarray(32)).update(body).digest();
  if (!timingSafeEqual(mac, data.subarray(data.length - 32))) throw new Error(`an attachment's MAC does not match (${name})`);
  const d = createDecipheriv('aes-256-cbc', localKey.subarray(0, 32), body.subarray(0, 16));
  const plain = Buffer.concat([d.update(body.subarray(16)), d.final()]).subarray(0, size);
  if (!createHash('sha256').update(plain).digest().equals(Buffer.from(plaintextHash))) throw new Error(`an attachment does not match its hash (${name})`);
  return plain;
}

// ------------------------------------------------------------------ census

export interface V2Count {
  format: 'signal-v2';
  snapshot: string;
  writtenMonth: string | null;
  recipients: Record<string, number>;
  chats: number;
  chatItems: number;
  firstMonth: string | null;
  lastMonth: string | null;
}

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const RECIPIENT_KINDS: Record<number, string> = { 2: 'contact', 3: 'group', 4: 'distributionList', 5: 'self', 6: 'releaseNotes', 7: 'callLink' };

/** Counts only: what a snapshot holds, read with the key (which this checks). */
export function countSnapshot(snapshot: string, backupKey: Uint8Array): V2Count {
  const b = openSnapshot(snapshot, backupKey);
  const out: V2Count = { format: 'signal-v2', snapshot: snapshot.split('/').pop()!, writtenMonth: null, recipients: {}, chats: 0, chatItems: 0, firstMonth: null, lastMonth: null };
  let first = Infinity;
  let last = 0;
  let header = true;
  for (const r of records(b)) {
    const fs = fields(r);
    if (header) {
      header = false;
      const t = int(fs, 2);
      if (t) out.writtenMonth = month(t);
      continue;
    }
    const f = fs[0];
    if (!f?.bytes) continue;
    if (f.no === 2) {
      const k = RECIPIENT_KINDS[fields(f.bytes).find((x) => x.no !== 1)?.no ?? 0] ?? 'other';
      out.recipients[k] = (out.recipients[k] ?? 0) + 1;
    } else if (f.no === 3) out.chats++;
    else if (f.no === 4) {
      out.chatItems++;
      const t = int(fields(f.bytes), 3);
      if (t) (first = Math.min(first, t)), (last = Math.max(last, t));
    }
  }
  if (last) (out.firstMonth = month(first)), (out.lastMonth = month(last));
  return out;
}

// ------------------------------------------------------------------ mapping

export interface V2ReadStats {
  conversations: number;
  messages: number;
  duplicates: number;
  selfMessages: number;
  files: { linked: number; missing: number };
  /** Chat items left out, by why: sms, deleted, unknown author, and update kinds the hub doesn't show. */
  skipped: Record<string, number>;
}

interface Recipient {
  kind: 'contact' | 'group' | 'self' | 'other';
  aci?: string | null;
  identity?: P.IdentityFact;
  conversation?: P.ConversationFact;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'video/mp4': '.mp4',
  'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/x-signal-plain': '.txt',
};
/** Updates the hub has no line for, by ChatUpdateMessage field. */
const UPDATE_KINDS: Record<number, string> = { 1: 'simple update', 4: 'profile change', 5: 'thread merge', 6: 'session switchover', 9: 'learned profile', 10: 'poll ended', 11: 'pin' };
const STYLES: Record<number, string> = { 1: 'BOLD', 2: 'ITALIC', 3: 'SPOILER', 4: 'STRIKETHROUGH', 5: 'MONOSPACE' };

const joinName = (...parts: (string | undefined)[]) => parts.filter((p) => p && p.trim()).join(' ').trim() || undefined;

function attachmentKind(mime?: string): P.AttachmentKind {
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

export interface ReadV2Options {
  /** The folder holding SignalBackups (or the snapshot's parent). */
  dir: string;
  backupKey: Uint8Array;
  /** The importing account's own ACI. */
  selfId: string;
  /** Where attachments go: <mediaDir>/<sha256[0:2]>/<sha256><ext>, as the Discord reader keeps them. */
  mediaDir: string;
  progress?: (p: number) => void;
}

/** Read the newest snapshot into conversations with their messages, in the order the facts file wants them. */
export function readSignalV2(o: ReadV2Options, emit: (line: unknown) => void): V2ReadStats {
  const snaps = snapshots(o.dir);
  if (!snaps.length) throw new Error('no backup snapshot (SignalBackups/signal-backup-…) in this source');
  const snapshot = snaps.at(-1)!;
  return mapFrames(openSnapshot(snapshot, o.backupKey), filesDir(snapshot), o, emit);
}

/** The mapping itself, over a decrypted stream (BackupInfo, then frames); attachments come from `files`. */
export function mapFrames(b: Uint8Array, files: string, o: Omit<ReadV2Options, 'dir' | 'backupKey'>, emit: (line: unknown) => void): V2ReadStats {
  const self = o.selfId.toLowerCase();
  const stats: V2ReadStats = { conversations: 0, messages: 0, duplicates: 0, selfMessages: 0, files: { linked: 0, missing: 0 }, skipped: {} };
  const skip = (why: string) => (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);
  const recipients = new Map<number, Recipient>();
  const chats = new Map<number, { conversation: P.ConversationFact; messages: P.MessageFact[]; people: Set<string> }>();
  const seen = new Set<string>();

  const keep = (fp: Field[] | null, fallbackMime?: string): P.AttachmentFact | null => {
    const loc = fp && sub(fp, 13);
    const hash = bytes(loc, 10);
    const key = bytes(loc, 9);
    const size = int(loc, 3) ?? 0;
    const mime = str(fp, 4) ?? fallbackMime;
    const name = str(fp, 7);
    if (!hash || !key) {
      stats.files.missing++;
      return null;
    }
    const sha = Buffer.from(hash).toString('hex');
    const ext = (name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? MIME_EXT[mime ?? ''] ?? '').toLowerCase();
    const dir = join(o.mediaDir, sha.slice(0, 2));
    const dest = join(dir, sha + ext);
    if (!existsSync(dest)) {
      const plain = readAttachment(files, hash, key, size);
      if (!plain) {
        stats.files.missing++;
        return null;
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(dest + '.tmp', plain, { mode: 0o600 });
      renameSync(dest + '.tmp', dest);
    }
    stats.files.linked++;
    const a: P.AttachmentFact = { nativeId: sha, kind: attachmentKind(mime), url: `file://${dest}`, name: name || sha + ext };
    if (mime) a.mime = mime;
    if (size) a.size = size;
    const w = int(fp, 8);
    const h = int(fp, 9);
    if (w) a.width = w;
    if (h) a.height = h;
    return a;
  };

  const aciOf = (rid?: number) => (rid === undefined ? null : (recipients.get(rid)?.aci ?? null));
  const names = new Map<string, string>();
  const nameOf = (aci: string | null) => (aci === self ? 'You' : (aci && names.get(aci)) || 'Someone');

  const text = (t: Field[] | null, longText?: Field[] | null): { body: string; mentionsSelf: boolean } => {
    let body = str(t, 1) ?? '';
    if (longText) {
      const loc = sub(longText, 13);
      const hash = bytes(loc, 10);
      const key = bytes(loc, 9);
      const full = hash && key ? readAttachment(files, hash, key, int(loc, 3) ?? 0) : null;
      if (full) body = full.toString('utf8');
    }
    const styles: { style: string; start: number; length: number }[] = [];
    const mentions: { uuid: string; start: number; length: number }[] = [];
    for (const r of all(t ?? [], 2)) {
      const fs = fields(r.bytes!);
      const start = int(fs, 1) ?? 0;
      const length = int(fs, 2) ?? 0;
      const who = uuid(bytes(fs, 3));
      if (who) mentions.push({ uuid: who, start, length });
      const style = STYLES[int(fs, 4) ?? 0];
      if (style) styles.push({ style, start, length });
    }
    let mentionsSelf = false;
    const md = fromSignal(body, styles, mentions, { onMention: (aci) => (mentionsSelf ||= aci.toLowerCase() === self) });
    return { body: md, mentionsSelf };
  };

  const reactions = (fs: Field[] | null, no: number): P.ReactionFact[] | undefined => {
    const by = new Map<string, string[]>();
    for (const r of all(fs ?? [], no)) {
      const x = fields(r.bytes!);
      const emoji = str(x, 1);
      const who = aciOf(int(x, 2));
      if (!emoji || !who) continue;
      (by.get(emoji) ?? by.set(emoji, []).get(emoji)!).push(who);
    }
    return by.size ? [...by].map(([key, authors]) => ({ key, authors })) : undefined;
  };

  const total = b.length;
  let header = true;
  let at = 0;
  let n = 0;
  for (const r of records(b)) {
    at += r.length;
    if (header) {
      header = false;
      continue;
    }
    const frame = fields(r)[0];
    if (!frame?.bytes) continue;
    const fs = fields(frame.bytes);
    if (frame.no === 2) {
      // Recipient
      const id = int(fs, 1)!;
      const contact = sub(fs, 2);
      const group = sub(fs, 3);
      if (contact) {
        const aci = uuid(bytes(contact, 1));
        const rec: Recipient = { kind: 'contact', aci };
        if (aci) {
          const idf: P.IdentityFact = { nativeId: aci };
          const nick = sub(contact, 16);
          const name =
            joinName(str(nick, 1), str(nick, 2)) ??
            joinName(str(contact, 20)) ??
            joinName(str(contact, 18), str(contact, 19)) ??
            joinName(str(contact, 11), str(contact, 12)) ??
            joinName(str(contact, 3));
          if (name) idf.displayName = name;
          const e164 = int(contact, 4);
          const username = str(contact, 3);
          if (e164) idf.handle = `+${e164}`;
          else if (username) idf.handle = `@${username}`;
          if (aci === self) idf.isSelf = true;
          else if (name) names.set(aci, name);
          rec.identity = idf;
          rec.conversation = aci === self ? { nativeId: `dm:${self}:${self}`, shape: 'self', name: 'Note to Self', participants: [self], encrypted: true } : { nativeId: `dm:${self}:${aci}`, shape: 'direct', participants: [self, aci], encrypted: true };
        }
        recipients.set(id, rec);
      } else if (group) {
        const mk = bytes(group, 1);
        if (!mk || mk.length !== 32) {
          recipients.set(id, { kind: 'other' });
          continue;
        }
        const snap = sub(group, 5);
        const conv: P.ConversationFact = { nativeId: `group:${groupIdFromMasterKey(mk).toString('base64')}`, shape: 'group', encrypted: true };
        const title = str(sub(snap, 2), 1);
        const topic = str(sub(snap, 11), 4);
        if (title) conv.name = title;
        if (topic) conv.topic = topic;
        const members = all(snap ?? [], 7)
          .map((m) => uuid(bytes(fields(m.bytes!), 1)))
          .filter((x): x is string => !!x);
        if (members.length) conv.participants = [...new Set(members)];
        if (snap && one(snap, 12)?.int) conv.variant = 'announcement';
        recipients.set(id, { kind: 'group', conversation: conv });
      } else if (one(fs, 5)) recipients.set(id, { kind: 'self', aci: self, conversation: { nativeId: `dm:${self}:${self}`, shape: 'self', name: 'Note to Self', participants: [self], encrypted: true } });
      else recipients.set(id, { kind: 'other' });
    } else if (frame.no === 3) {
      // Chat
      const conv = recipients.get(int(fs, 2) ?? -1)?.conversation;
      if (conv) chats.set(int(fs, 1)!, { conversation: { ...conv, ...(one(fs, 3)?.int ? { archived: true } : {}) }, messages: [], people: new Set() });
    } else if (frame.no === 4) {
      // ChatItem
      n++;
      if (n % 2000 === 0) o.progress?.(at / total);
      const chat = chats.get(int(fs, 1) ?? -1);
      if (!chat) {
        skip('chat not kept');
        continue;
      }
      const m = mapItem(fs);
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
    }
  }

  function mapItem(fs: Field[]): P.MessageFact | null {
    if (one(fs, 7)?.int) return (skip('sms'), null);
    const author = aciOf(int(fs, 2));
    if (!author) return (skip('author without an ACI'), null);
    const revisions = all(fs, 6);
    const sent = int(fs, 3) ?? 0;
    const original = revisions.length ? (int(fields(revisions[0].bytes!), 3) ?? sent) : sent;
    const m: P.MessageFact = { nativeId: `${author}:${original}`, conversation: '', author, ts: original, body: '' };
    if (revisions.length && sent !== original) m.editedTs = sent;
    const extra: Record<string, unknown> = {};
    const expires = int(fs, 5);
    if (expires) extra.expiresInSeconds = Math.round(expires / 1000);
    const who = nameOf(author);

    const standard = sub(fs, 11);
    const sticker = sub(fs, 13);
    const update = sub(fs, 15);
    if (standard) {
      const t = text(sub(standard, 2), sub(standard, 5));
      m.body = t.body;
      if (t.mentionsSelf) m.mentionsSelf = true;
      const atts = all(standard, 3)
        .map((a) => keep(sub(fields(a.bytes!), 1)))
        .filter((a): a is P.AttachmentFact => !!a);
      m.kind = atts.length ? 'media' : 'text';
      if (atts.length) m.attachments = atts;
      const q = sub(standard, 1);
      if (q) {
        const qts = int(q, 1);
        const qa = aciOf(int(q, 2));
        if (qa && qts) m.replyTo = `${qa}:${qts}`;
        const qatts = all(q, 4).map((x) => fields(x.bytes!));
        extra.quote = { author: qa, ts: qts ?? null, text: text(sub(q, 3)).body, ...(qatts.length ? { attachments: qatts.map((x) => ({ mime: str(x, 1) ?? null, name: str(x, 2) ?? null })) } : {}) };
      }
      m.reactions = reactions(standard, 6);
      if (!m.body && !atts.length) {
        if (all(standard, 3).length) m.body = '📎 Attachment (not in the backup)';
        else return (skip('empty'), null);
      }
    } else if (sticker) {
      const s = sub(sticker, 1);
      m.kind = 'sticker';
      m.body = str(s, 4) ?? '';
      const a = keep(sub(s, 5), 'image/webp');
      if (a) m.attachments = [{ ...a, name: 'sticker' }];
      extra.sticker = { packId: Buffer.from(bytes(s, 1) ?? []).toString('hex'), stickerId: int(s, 3) ?? 0 };
      m.reactions = reactions(sticker, 2);
    } else if (one(fs, 14) || one(fs, 22)) return (skip('deleted'), null);
    else if (one(fs, 18)) {
      // Respect the sender: view-once media stays on the phone, as live sync does.
      m.kind = 'media';
      m.body = '📷 View-once media (open it on your phone)';
      extra.viewOnce = true;
      m.reactions = reactions(sub(fs, 18), 2);
    } else if (one(fs, 12)) {
      const c = sub(sub(fs, 12), 1);
      const nm = sub(c, 1);
      // As live sync words it: prefix, given, middle, family, suffix; else the nickname, else the organisation.
      const name = joinName(str(nm, 3), str(nm, 1), str(nm, 5), str(nm, 2), str(nm, 4)) ?? str(nm, 6) ?? str(c, 7) ?? 'Contact';
      const values = [...all(c ?? [], 3), ...all(c ?? [], 4)].map((x) => str(fields(x.bytes!), 1)).filter(Boolean);
      m.body = `👤 ${name}${values.length ? ' · ' + values.join(', ') : ''}`;
      m.reactions = reactions(sub(fs, 12), 2);
    } else if (one(fs, 20)) {
      const p = sub(fs, 20);
      const options = all(p ?? [], 3).map((x) => str(fields(x.bytes!), 1) ?? '');
      const question = str(p, 1) ?? 'Poll';
      const multiple = !!int(p, 2);
      m.body = [`📊 **${question}**${multiple ? ' (multiple choice)' : ''}`, ...options.map((x) => `• ${x}`)].join('\n');
      extra.poll = { question, options, allowMultiple: multiple };
      m.reactions = reactions(p, 5);
    } else if (one(fs, 19)) {
      const r = sub(fs, 19);
      const tr = sub(r, 1);
      m.body = tr ? text(sub(tr, 1), sub(tr, 2)).body : (str(r, 2) ?? '');
      extra.storyReply = true;
      m.reactions = reactions(r, 3);
    } else if (one(fs, 16)) m.body = '💸 Payment';
    else if (one(fs, 17)) m.body = '🎁 Gift badge';
    else if (update) {
      const call = sub(update, 7);
      const groupCall = sub(update, 8);
      const timer = sub(update, 3);
      if (call) {
        const video = int(call, 2) === 2;
        const outgoing = int(call, 3) === 2;
        const state = int(call, 4) ?? 0;
        m.kind = 'call';
        m.body = `${video ? '📹' : '📞'} ${state === 3 || state === 4 ? 'Missed' : outgoing ? 'Outgoing' : 'Incoming'} ${video ? 'video' : 'voice'} call`;
      } else if (groupCall) {
        m.kind = 'call';
        m.body = `📞 ${nameOf(aciOf(int(groupCall, 4)) ?? author)} started a group call`;
      } else if (timer) {
        const secs = Math.round((int(timer, 1) ?? 0) / 1000);
        m.kind = 'system';
        m.body = secs ? `${who} set disappearing messages to ${describeTimer(secs)}.` : `${who} turned off disappearing messages.`;
      } else if (one(update, 2)) {
        m.kind = 'system';
        m.body = `${who} updated the group.`;
      } else return (skip(UPDATE_KINDS[update[0]?.no ?? 0] ?? 'other update'), null);
    } else return (skip('unknown item'), null);
    if (!m.reactions) delete m.reactions;
    if (Object.keys(extra).length) m.extra = extra;
    return m;
  }

  // Conversations with what they hold, each followed by its messages, as the facts file wants them.
  const identities = new Map<string, P.IdentityFact>();
  for (const r of recipients.values()) if (r.identity) identities.set(r.identity.nativeId, r.identity);
  for (const c of chats.values()) {
    if (!c.messages.length) continue;
    stats.conversations++;
    stats.messages += c.messages.length;
    const people = new Set([...c.people, ...(c.conversation.participants ?? [])]);
    emit({ t: 'conversation', conversation: c.conversation, identities: [...people].map((p) => identities.get(p)).filter(Boolean), messages: c.messages.length });
    for (const m of c.messages) emit({ t: 'message', m });
  }
  return stats;
}
