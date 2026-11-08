/**
 * A synthetic Molly on-device backup in the new format (backup v2), made from scratch: made-up people and messages,
 * sealed with the keys a made-up recovery key gives, laid out as Molly writes it (SignalBackups/signal-backup-<time>/
 * {metadata,main} and SignalBackups/files/<2 hex>/<name>). Nothing in it comes from a real backup.
 */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupIdFor, backupKeyFromRecoveryKey, localMetadataKey, messageBackupKeys } from '../../src/imports/signal-keys.ts';

/** libsignal's own example pool: public test data. */
export const RECOVERY_KEY = 'dtjs 858a sj6t v0jz sqrs mj0u bp33 5pis j98e 9ssn ss8m yoc0 8drh tckt yawv x45l';
export const SELF = '11111111-1111-4111-8111-111111111111';
export const ALICE = 'a11ce000-0000-4000-8000-000000000001';
export const BOB = '0b0b0000-0000-4000-8000-000000000002';
export const MASTER_KEY = Buffer.alloc(32, 7);
export const T = Date.UTC(2024, 2, 1);
export const PICTURE = Buffer.from('not really a png, but bytes all the same '.repeat(40));

// ------------------------------------------------------------------ a protobuf writer, enough for this

type V = number | string | Uint8Array | boolean | Msg | V[];
type Msg = [number, V][];
function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
export function enc(m: Msg): Uint8Array {
  const out: number[] = [];
  const put = (no: number, v: V) => {
    if (Array.isArray(v) && (v.length === 0 || Array.isArray(v[0]))) {
      // A nested message.
      const b = enc(v as Msg);
      out.push(...varint(no * 8 + 2), ...varint(b.length), ...b);
    } else if (typeof v === 'number' || typeof v === 'boolean') out.push(...varint(no * 8), ...varint(Number(v)));
    else {
      const b = typeof v === 'string' ? new TextEncoder().encode(v) : (v as Uint8Array);
      out.push(...varint(no * 8 + 2), ...varint(b.length), ...b);
    }
  };
  for (const [no, v] of m) put(no, v);
  return new Uint8Array(out);
}
const delimited = (msgs: Msg[]) => Buffer.concat(msgs.map((m) => enc(m)).map((b) => Buffer.concat([Buffer.from(varint(b.length)), b])));
const id16 = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');

// ------------------------------------------------------------------ the backup

export function writeSyntheticV2(dir: string, o: { snapshot?: string } = {}) {
  const pool = RECOVERY_KEY.replace(/ /g, '');
  const bk = backupKeyFromRecoveryKey(pool);
  const backupId = backupIdFor(bk, SELF);
  const keys = messageBackupKeys(bk, backupId);
  const root = join(dir, 'SignalBackups');
  const snap = join(root, o.snapshot ?? 'signal-backup-2026-11-06-11-56-10');
  const files = join(root, 'files');
  mkdirSync(snap, { recursive: true });

  // One attachment, sealed with its own local key, named as Molly names it.
  const localKey = randomBytes(64);
  const plaintextHash = createHash('sha256').update(PICTURE).digest();
  const name = createHash('sha256').update(plaintextHash).update(localKey).digest('hex');
  const padded = Buffer.concat([PICTURE, Buffer.alloc(100)]); // Molly pads before sealing
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', localKey.subarray(0, 32), iv);
  const sealed = Buffer.concat([iv, c.update(padded), c.final()]);
  mkdirSync(join(files, name.slice(0, 2)), { recursive: true });
  writeFileSync(join(files, name.slice(0, 2), name), Buffer.concat([sealed, createHmac('sha256', localKey.subarray(32)).update(sealed).digest()]));
  const pointer: Msg = [[4, 'image/png'], [7, 'cat.png'], [8, 64], [9, 48], [13, [[3, PICTURE.length], [9, localKey], [10, plaintextHash]]]];

  const text = (body: string, ranges: Msg[] = []): Msg => [[1, body], ...ranges.map((r) => [2, r] as [number, V])];
  const frames: Msg[] = [
    [[1, 1], [2, T]], // BackupInfo
    [[1, [[1, 'self']]]], // AccountData
    [[2, [[1, 1], [5, []]]]], // Recipient: self
    [[2, [[1, 2], [2, [[1, id16(ALICE)], [4, 15550100001], [11, 'Alice'], [12, 'Liddell']]]]]],
    [[2, [[1, 3], [2, [[1, id16(BOB)], [3, 'bob.01'], [16, [[1, 'Bobby']]]]]]]],
    [[2, [[1, 4], [2, [[4, 15550100009]]]]]], // a contact known only by number
    [[2, [[1, 5], [3, [[1, MASTER_KEY], [5, [[2, [[1, 'Tea club']]], [7, [[1, id16(SELF)]]], [7, [[1, id16(ALICE)]]], [7, [[1, id16(BOB)]]]]]]]]]],
    [[3, [[1, 10], [2, 2]]]], // Chat with Alice
    [[3, [[1, 11], [2, 5]]]], // the group
    [[3, [[1, 12], [2, 1]]]], // Note to Self
    [[3, [[1, 13], [2, 4]]]], // the number-only contact
    // Alice: text with bold and a mention of me.
    [[4, [[1, 10], [2, 2], [3, T + 1000], [8, [[1, T + 1001]]], [11, [[2, text('hey you, look', [[[1, 0], [2, 3], [4, 1]], [[1, 4], [2, 3], [3, id16(SELF)]]])]]]]]],
    // Me: a reply with the picture, Alice reacts.
    [[4, [[1, 10], [2, 1], [3, T + 2000], [9, []], [11, [[1, [[1, T + 1000], [2, 2], [3, text('hey you, look')]]], [2, text('a cat')], [3, [[1, pointer]]], [6, [[1, '❤️'], [2, 2], [3, T + 2500]]]]]]]],
    // Alice, edited once: the outer item is the latest, revisions the earlier ones.
    [[4, [[1, 10], [2, 2], [3, T + 3500], [6, [[1, 10], [2, 2], [3, T + 3000], [11, [[2, text('teh')]]]]], [11, [[2, text('the')]]]]]],
    // Deleted, and an SMS: left out.
    [[4, [[1, 10], [2, 2], [3, T + 4000], [14, []]]]],
    [[4, [[1, 10], [2, 2], [3, T + 4100], [7, true], [11, [[2, text('sms')]]]]]],
    // The group: Bob writes, a missed call, a timer change.
    [[4, [[1, 11], [2, 3], [3, T + 5000], [11, [[2, text('hello club')]]]]]],
    [[4, [[1, 10], [2, 2], [3, T + 6000], [15, [[7, [[2, 1], [3, 1], [4, 3]]]]]]]],
    [[4, [[1, 11], [2, 1], [3, T + 7000], [15, [[2, [[1, []]]]]]]]],
    // Note to Self.
    [[4, [[1, 12], [2, 1], [3, T + 8000], [11, [[2, text('remember milk')]]]]]],
    // From someone with no ACI: left out.
    [[4, [[1, 13], [2, 4], [3, T + 9000], [11, [[2, text('who')]]]]]],
  ];
  const gz = Bun.gzipSync(delimited(frames));
  const mainIv = randomBytes(16);
  const mc = createCipheriv('aes-256-cbc', keys.aesKey, mainIv);
  const body = Buffer.concat([mainIv, mc.update(gz), mc.final()]);
  writeFileSync(join(snap, 'main'), Buffer.concat([body, createHmac('sha256', keys.hmacKey).update(body).digest()]));

  const nonce = randomBytes(12);
  const ic = createCipheriv('aes-256-ctr', localMetadataKey(bk), Buffer.concat([nonce, Buffer.alloc(4)]));
  writeFileSync(join(snap, 'metadata'), enc([[1, 1], [2, [[1, nonce], [2, Buffer.concat([ic.update(backupId), ic.final()])]]]]));
  writeFileSync(join(snap, 'files'), new Uint8Array());
  return { snapshot: snap, attachmentSha: plaintextHash.toString('hex') };
}
