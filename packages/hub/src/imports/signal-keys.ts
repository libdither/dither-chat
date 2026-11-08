/**
 * Keys for Signal's new backup format (backup v2), from the account's recovery key, and the group id a group's
 * master key stands for. Ported from libsignal (account-keys, message-backup, poksho, zkgroup) so the hub needs no
 * native library; checked in tests against signal-cli's own group ids and against a backup written to this format.
 *
 *   recovery key (account entropy pool, 64 characters)
 *     → backup key   = HKDF(pool, "20240801_SIGNAL_BACKUP_KEY")                                 32 bytes
 *     → metadata key = HKDF(backup key, "20241011_SIGNAL_LOCAL_BACKUP_METADATA_KEY")             32 bytes
 *       (decrypts the backup id in a local backup's `metadata`: AES-256-CTR, 12-byte nonce, counter from 0)
 *     → HMAC key ‖ AES key = HKDF(backup key, "20241007_SIGNAL_BACKUP_ENCRYPT_MESSAGE_BACKUP:" ‖ backup id)   64 bytes
 */
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';

const hkdf = (ikm: Uint8Array, info: Uint8Array | string, n: number) => Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), typeof info === 'string' ? Buffer.from(info) : info, n));

/**
 * A recovery key as typed: any case, spaces and dashes allowed, and Molly's display swaps ('#' for O, '=' for 0)
 * undone. Null unless it comes to 64 letters and digits.
 */
export function parseRecoveryKey(input: string): string | null {
  const s = input.replace(/#/g, 'O').replace(/=/g, '0').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
  return s.length === 64 ? s : null;
}

export function backupKeyFromRecoveryKey(pool: string): Buffer {
  return hkdf(Buffer.from(pool, 'ascii'), '20240801_SIGNAL_BACKUP_KEY', 32);
}

/** The id a backup of this account has (local backups also carry it, encrypted, in `metadata`). */
export function backupIdFor(backupKey: Uint8Array, aci: string): Buffer {
  return hkdf(backupKey, Buffer.concat([Buffer.from('20241024_SIGNAL_BACKUP_ID:'), Buffer.from(aci.replace(/-/g, ''), 'hex')]), 16);
}

export function localMetadataKey(backupKey: Uint8Array): Buffer {
  return hkdf(backupKey, '20241011_SIGNAL_LOCAL_BACKUP_METADATA_KEY', 32);
}

/** The backup id from a local backup's metadata (Metadata.EncryptedBackupId{iv, encryptedId}). */
export function decryptBackupId(backupKey: Uint8Array, iv: Uint8Array, encrypted: Uint8Array): Buffer {
  const c = createCipheriv('aes-256-ctr', localMetadataKey(backupKey), Buffer.concat([iv, Buffer.alloc(4)]));
  return Buffer.concat([c.update(encrypted), c.final()]);
}

/** The keys a backup's `main` is sealed with (no forward-secrecy token: local backups have none). */
export function messageBackupKeys(backupKey: Uint8Array, backupId: Uint8Array): { hmacKey: Buffer; aesKey: Buffer } {
  const k = hkdf(backupKey, Buffer.concat([Buffer.from('20241007_SIGNAL_BACKUP_ENCRYPT_MESSAGE_BACKUP:'), backupId]), 64);
  return { hmacKey: k.subarray(0, 32), aesKey: k.subarray(32) };
}

// ------------------------------------------------------------------ group ids

/** poksho's ShoHmacSha256, as far as zkgroup's Sho::new + squeeze use it. */
class Sho {
  private cv = Buffer.alloc(32);
  private parts: Buffer[] = [];
  constructor(label: string, data: Uint8Array) {
    this.absorbAndRatchet(Buffer.from(label));
    this.absorbAndRatchet(Buffer.from(data));
  }
  private absorbAndRatchet(input: Buffer) {
    // absorb: an HMAC keyed by the chaining value; ratchet: that HMAC over input ‖ 0x00 is the next one.
    this.cv = createHmac('sha256', this.cv).update(input).update(Buffer.from([0])).digest();
  }
  squeeze(n: number): Buffer {
    const out: Buffer[] = [];
    let i = 0;
    const counter = (k: number) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(k));
      return b;
    };
    for (let have = 0; have < n; have += 32, i++) out.push(createHmac('sha256', this.cv).update(counter(i)).update(Buffer.from([1])).digest());
    this.cv = createHmac('sha256', this.cv).update(counter(i)).update(Buffer.from([2])).digest();
    return Buffer.concat(out).subarray(0, n);
  }
}

/** The 32-byte group id (what signal-cli calls the group id) of a group master key. */
export function groupIdFromMasterKey(masterKey: Uint8Array): Buffer {
  return new Sho('Signal_ZKGroup_20200424_GroupMasterKey_GroupSecretParams_DeriveFromMasterKey', masterKey).squeeze(32);
}
