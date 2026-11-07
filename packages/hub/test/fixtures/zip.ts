/**
 * A minimal zip writer for tests: deflated or stored entries, and optionally Zip64 records throughout (as a phone's
 * file manager writes for a big folder), so the reader's Zip64 path runs without a 4 GB file.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export function makeZip(entries: { name: string; bytes: Uint8Array; store?: boolean; mode?: number }[], o: { zip64?: boolean } = {}): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  const z64 = !!o.zip64;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.store ? Buffer.from(e.bytes) : deflateRawSync(e.bytes);
    const crc = crc32(e.bytes) >>> 0;
    const method = e.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(z64 ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const extra = z64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (z64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.bytes.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(off), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 45, 4);
    c.writeUInt16LE(z64 ? 45 : 20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(z64 ? 0xffffffff : data.length, 20);
    c.writeUInt32LE(z64 ? 0xffffffff : e.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(z64 ? 0xffffffff : off, 42);
    central.push(c, name, extra);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (z64) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(45, 12);
    r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(entries.length), 24);
    r.writeBigUInt64LE(BigInt(entries.length), 32);
    r.writeBigUInt64LE(BigInt(cd.length), 40);
    r.writeBigUInt64LE(BigInt(off), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeBigUInt64LE(BigInt(off + cd.length), 8);
    l.writeUInt32LE(1, 16);
    tail.push(r, l);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(z64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(z64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(z64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(z64 ? 0xffffffff : off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, ...tail, end]));
}
