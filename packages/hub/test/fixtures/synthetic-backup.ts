/**
 * A made-up legacy Signal backup, written with the same framing Molly's BackupFrameOutputStream uses.
 * Its only content is the word "synthetic" and small integers. It shows the reader agrees with this writer;
 * agreement with a real Molly backup is checked by running the census on one (docs/import-signal.md).
 */
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { streamKeys } from '../../src/imports/signal-backup.ts';

export const SYNTHETIC_PASSPHRASE = '000000000000000000000000000000';

function pb(no: number, v: number | string | Uint8Array): Buffer {
  const vi = (n: number) => {
    const out: number[] = [];
    while (n >= 128) (out.push((n % 128) | 128), (n = Math.floor(n / 128)));
    out.push(n);
    return Buffer.from(out);
  };
  if (typeof v === 'number') return Buffer.concat([vi(no * 8), vi(v)]);
  const bytes = Buffer.from(v);
  return Buffer.concat([vi(no * 8 + 2), vi(bytes.length), bytes]);
}

/** Five messages in 2023-06..2023-11: one hidden by keepmsg, one deleted, one an edit revision; one attachment (1000 bytes). */
export function syntheticBackup(passphrase = SYNTHETIC_PASSPHRASE, attachmentBytes = 1000): Buffer {
  const iv = randomBytes(16);
  const salt = randomBytes(32);
  const { cipherKey, macKey } = streamKeys(passphrase, salt);
  let counter = iv.readUInt32BE(0);
  const nextIv = () => (iv.writeUInt32BE(counter++ >>> 0, 0), Buffer.from(iv));
  const chunks: Buffer[] = [];
  const header = pb(1, Buffer.concat([pb(1, iv), pb(2, salt), pb(3, 1)]));
  const hl = Buffer.alloc(4);
  hl.writeUInt32BE(header.length);
  chunks.push(hl, header);
  const frame = (plain: Buffer) => {
    const c = createCipheriv('aes-256-ctr', cipherKey, nextIv());
    const len = Buffer.alloc(4);
    len.writeUInt32BE(plain.length + 10);
    const encLen = c.update(len);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    chunks.push(encLen, ct, createHmac('sha256', macKey).update(encLen).update(ct).digest().subarray(0, 10));
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
  stmt('CREATE INDEX message_thread ON message (thread_id)');
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
  frame(pb(4, Buffer.concat([pb(1, 1), pb(2, 1), pb(3, attachmentBytes)])));
  blob(randomBytes(attachmentBytes));
  frame(pb(6, 1));
  return Buffer.concat(chunks);
}

/** A plaintext backup-v2 stream: BackupInfo, a self recipient, a contact, a chat and one standard message with a reaction. */
export function syntheticV2(): Buffer {
  const vi = (n: number) => {
    const out: number[] = [];
    while (n >= 128) (out.push((n % 128) | 128), (n = Math.floor(n / 128)));
    out.push(n);
    return Buffer.from(out);
  };
  const delim = (b: Buffer) => Buffer.concat([vi(b.length), b]);
  const info = Buffer.concat([pb(1, 1), pb(2, Date.UTC(2025, 0, 15))]);
  const self = pb(2, Buffer.concat([pb(1, 1), pb(5, Buffer.alloc(0))]));
  const contact = pb(2, Buffer.concat([pb(1, 2), pb(2, pb(1, Buffer.alloc(16)))]));
  const chat = pb(3, Buffer.concat([pb(1, 1), pb(2, 2)]));
  const std = pb(11, Buffer.concat([pb(2, pb(1, 'synthetic')), pb(6, Buffer.concat([pb(1, '+1'), pb(2, 1), pb(3, 5)]))]));
  const item = pb(4, Buffer.concat([pb(1, 1), pb(2, 2), pb(3, Date.UTC(2025, 0, 1)), std]));
  return Buffer.concat([info, self, contact, chat, item].map(delim));
}
