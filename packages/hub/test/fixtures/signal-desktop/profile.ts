/**
 * A made-up Signal Desktop profile (docs/import-signal.md, "Reading a Signal Desktop profile"). The database is
 * db.sqlite + db.sqlite-wal beside this file: SQLCipher 4 under KEY, built from ROWS by build.ts with the `sqlcipher`
 * binary, which tests don't need. WAL_ROWS are only in the write-ahead log. Attachments are sealed here, at test time,
 * the way Desktop seals them (IV ‖ AES-256-CBC ‖ HMAC-SHA256 under each one's localKey).
 *
 * Everything is invented: ids, names, words.
 */
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const KEY = Buffer.alloc(32, 0x5a);
export const SELF = '11111111-1111-4111-8111-111111111111';
export const PEER = '22222222-2222-4222-8222-222222222222';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const GROUP_ID = Buffer.alloc(32, 0xab).toString('base64');
export const T = Date.UTC(2026, 0, 10);

interface Att {
  messageId: string;
  type: 'attachment' | 'long-message' | 'sticker' | 'quote' | 'preview';
  bytes: Buffer;
  contentType: string;
  fileName: string | null;
  path: string;
  localKey: Buffer;
}
export const ATTACHMENTS: Att[] = [
  { messageId: 'm2', type: 'attachment', bytes: Buffer.from('synthetic photo bytes'), contentType: 'image/jpeg', fileName: 'photo.jpg', path: 'aa/photo-file', localKey: Buffer.alloc(64, 1) },
  { messageId: 'm2', type: 'preview', bytes: Buffer.from('a link preview picture'), contentType: 'image/png', fileName: null, path: 'aa/preview-file', localKey: Buffer.alloc(64, 2) },
  { messageId: 'm7', type: 'sticker', bytes: Buffer.from('synthetic sticker'), contentType: 'image/webp', fileName: null, path: 'bb/sticker-file', localKey: Buffer.alloc(64, 3) },
  { messageId: 'm8', type: 'long-message', bytes: Buffer.from('A long message, in full, past what the body column holds.'), contentType: 'text/x-signal-plain', fileName: null, path: 'cc/long-file', localKey: Buffer.alloc(64, 4) },
];

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const sha256 = sha;

/** Seal bytes as Desktop does for an attachment at rest: padded to a block, IV ‖ AES-256-CBC ‖ HMAC-SHA256. */
export function seal(plain: Buffer, localKey: Buffer, iv = Buffer.alloc(16, 9)): Buffer {
  const padded = Buffer.concat([plain, Buffer.alloc(48)]);
  const c = createCipheriv('aes-256-cbc', localKey.subarray(0, 32), iv);
  const body = Buffer.concat([iv, c.update(padded), c.final()]);
  return Buffer.concat([body, createHmac('sha256', localKey.subarray(32)).update(body).digest()]);
}

/** Electron safeStorage's basic_text wrapping ("v10", the fixed password), as config.json's encryptedKey holds it. */
export function wrapBasicText(text: string): string {
  const key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(text, 'latin1'), c.final()]).toString('hex');
}

/** Write the profile into `dir`: config.json (as given), sql/ from the committed database, sealed attachments. */
export function writeProfile(dir: string, config: Record<string, unknown> = { key: KEY.toString('hex') }) {
  mkdirSync(join(dir, 'sql'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  for (const f of ['db.sqlite', 'db.sqlite-wal']) copyFileSync(join(import.meta.dir, f), join(dir, 'sql', f));
  for (const a of ATTACHMENTS) {
    const p = join(dir, 'attachments.noindex', a.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, seal(a.bytes, a.localKey));
  }
}

const j = (x: unknown) => JSON.stringify(x);

/** The schema, as much of Desktop 8's as the reader looks at. */
export const SCHEMA = [
  'CREATE TABLE items (id TEXT PRIMARY KEY, json TEXT)',
  'CREATE TABLE conversations (id TEXT PRIMARY KEY, json TEXT, type TEXT, serviceId TEXT, groupId TEXT, e164 TEXT, name TEXT, profileName TEXT)',
  'CREATE TABLE messages (rowid INTEGER PRIMARY KEY ASC, id TEXT UNIQUE, json TEXT, type TEXT, conversationId TEXT, sent_at INTEGER, sourceServiceId TEXT, body TEXT, expireTimer INTEGER, isViewOnce INTEGER, isErased INTEGER, mentionsMe INTEGER)',
  'CREATE TABLE message_attachments (messageId TEXT, editHistoryIndex INTEGER, attachmentType TEXT, orderInMessage INTEGER, contentType TEXT, fileName TEXT, size INTEGER, width INTEGER, height INTEGER, path TEXT, localKey TEXT, plaintextHash TEXT, version INTEGER)',
];

type Msg = { id: string; conv: string; type: string; at: number; from?: string | null; body?: string | null; json?: Record<string, unknown>; expireTimer?: number; viewOnce?: boolean };

const MESSAGES: Msg[] = [
  { id: 'm1', conv: 'c-pat', type: 'incoming', at: 1000, from: PEER, body: 'hello there', json: { bodyRanges: [{ start: 0, length: 5, style: 1 }] } },
  {
    id: 'm2', conv: 'c-pat', type: 'outgoing', at: 2000, body: 'a photo back',
    json: { quote: { id: T + 1000, authorAci: PEER, text: 'hello there', attachments: [], bodyRanges: [] }, reactions: [{ emoji: '👍', fromId: 'c-pat', targetTimestamp: T + 2000, timestamp: T + 2500 }] },
  },
  { id: 'm3', conv: 'c-pat', type: 'incoming', at: 3000, from: PEER, body: 'final words', json: { editMessageTimestamp: T + 3500, editHistory: [{ body: 'final words', timestamp: T + 3500 }, { body: 'first words', timestamp: T + 3000 }] } },
  { id: 'm4', conv: 'c-grp', type: 'incoming', at: 4000, from: PEER, body: '￼ look at this', json: { bodyRanges: [{ start: 0, length: 1, mentionAci: SELF }] } },
  { id: 'm5', conv: 'c-pat', type: 'incoming', at: 5000, from: PEER, body: '', json: { deletedForEveryone: true }, expireTimer: 0 },
  { id: 'm6', conv: 'c-grp', type: 'group-v2-change', at: 6000, json: { groupV2Change: { from: PEER, details: [{ type: 'title', newTitle: 'Synthetic group' }] } } },
  { id: 'm7', conv: 'c-pat', type: 'incoming', at: 7000, from: PEER, json: { sticker: { packId: 'deadbeef', stickerId: 3, emoji: '🙂' } } },
  { id: 'm8', conv: 'c-pat', type: 'outgoing', at: 8000, body: 'A long message, in full', expireTimer: 3600 },
  { id: 'm9', conv: 'c-pat', type: 'story', at: 9000, from: PEER, body: 'a story' },
  { id: 'm10', conv: 'c-pni', type: 'incoming', at: 10_000, from: 'PNI:44444444-4444-4444-8444-444444444444', body: 'from someone known by number only' },
  { id: 'm11', conv: 'c-grp', type: 'pinned-message-notification', at: 11_000, from: PEER, json: { pinMessage: { targetAuthorAci: PEER, targetSentTimestamp: T + 4000 } } },
  { id: 'm12', conv: 'c-pat', type: 'incoming', at: 12_000, from: PEER, viewOnce: true },
  { id: 'm13', conv: 'c-pat', type: 'keychange', at: 13_000 },
  { id: 'm15', conv: 'c-self', type: 'outgoing', at: 15_000, body: 'a note to myself' },
];
/** Written after a checkpoint, so only the write-ahead log has them. */
const WAL_MESSAGES: Msg[] = [{ id: 'm14', conv: 'c-grp', type: 'incoming', at: 14_000, from: OTHER, body: 'only in the log' }];

const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insertMsg = (m: Msg) =>
  `INSERT INTO messages (id, json, type, conversationId, sent_at, sourceServiceId, body, expireTimer, isViewOnce, isErased, mentionsMe) VALUES (${[
    m.id, j({ id: m.id, ...(m.json ?? {}) }), m.type, m.conv, T + m.at, m.from ?? null, m.body ?? null, m.expireTimer ?? null, m.viewOnce ? 1 : 0, 0, 0,
  ].map(q).join(', ')})`;

/** The SQL build.ts runs: everything but WAL_SQL, a checkpoint, then WAL_SQL. */
export function rowsSql(): string[] {
  const out: string[] = [];
  out.push(`INSERT INTO items VALUES ('uuid_id', ${q(j({ id: 'uuid_id', value: `${SELF}.2` }))})`);
  out.push(`INSERT INTO items VALUES ('version', ${q(j({ id: 'version', value: '8.0.0' }))})`);
  const conv = (id: string, type: string, serviceId: string | null, groupId: string | null, json: Record<string, unknown>) =>
    out.push(`INSERT INTO conversations (id, json, type, serviceId, groupId) VALUES (${[id, j({ id, type, ...json }), type, serviceId, groupId].map(q).join(', ')})`);
  conv('c-self', 'private', SELF, null, { serviceId: SELF, profileName: 'Me' });
  conv('c-pat', 'private', PEER, null, { serviceId: PEER, profileName: 'Patricia', nicknameGivenName: 'Pat', e164: '+15550101' });
  conv('c-other', 'private', OTHER, null, { serviceId: OTHER, profileName: 'Oli' });
  conv('c-pni', 'private', 'PNI:44444444-4444-4444-8444-444444444444', null, {});
  conv('c-grp', 'group', null, GROUP_ID, { groupId: GROUP_ID, groupVersion: 2, name: 'Synthetic group', membersV2: [{ aci: SELF }, { aci: PEER }, { aci: OTHER }] });
  for (const m of MESSAGES) out.push(insertMsg(m));
  ATTACHMENTS.forEach((a, i) =>
    out.push(
      `INSERT INTO message_attachments VALUES (${[a.messageId, -1, a.type, i, a.contentType, a.fileName, a.bytes.length, a.type === 'attachment' ? 640 : null, a.type === 'attachment' ? 480 : null, a.path, a.localKey.toString('base64'), sha(a.bytes), 2].map(q).join(', ')})`,
    ),
  );
  return out;
}

export function walSql(): string[] {
  return [...WAL_MESSAGES.map(insertMsg), `UPDATE conversations SET json = ${q(j({ id: 'c-grp', type: 'group', groupId: GROUP_ID, groupVersion: 2, name: 'Renamed group', membersV2: [{ aci: SELF }, { aci: PEER }, { aci: OTHER }] }))} WHERE id = 'c-grp'`];
}
