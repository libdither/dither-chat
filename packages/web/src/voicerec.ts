/**
 * Voice messages recorded in the composer (docs/media-kinds.md): what kind of file to record, a recording's loudness as
 * a waveform, and a browser's WebM recording rewrapped as Ogg Opus, which is what Discord takes as a voice message and
 * what Signal's apps play. Rewrapping keeps the Opus packets as they are: nothing is decoded or encoded again.
 */

/** What to ask MediaRecorder for: Ogg Opus where the browser records it (Firefox), WebM Opus otherwise (Chrome, Android). */
export function voiceType(supported: (type: string) => boolean): string | undefined {
  return ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(supported);
}

/** A tenth of a second's loudness from its samples (-1 to 1): the root mean square, scaled so speech fills the range. */
export function loudness(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** Bars for a preview: `n` of them, each the loudest point it covers. */
export function bars(points: number[], n: number): number[] {
  if (!points.length) return new Array(n).fill(0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * points.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * points.length) / n));
    out.push(Math.max(...points.slice(from, to)));
  }
  return out;
}

/** "0:07", "1:23". */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------------ WebM (Matroska) reading

const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
/** Elements whose children are read; everything else is skipped by its size. */
const MASTERS = new Set([SEGMENT, CLUSTER, TRACKS, TRACK_ENTRY, BLOCK_GROUP]);

function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = b[at];
  if (first === undefined) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** The Opus header and packets of a WebM Opus recording, in order; null when it is not one. */
export function webmOpus(b: Uint8Array): { head: Uint8Array; packets: Uint8Array[] } | null {
  let head: Uint8Array | null = null;
  let opus = false;
  const packets: Uint8Array[] = [];
  const walk = (from: number, to: number) => {
    let at = from;
    while (at < to) {
      const id = vint(b, at, true);
      if (!id) return;
      const size = vint(b, at + id.length, false);
      if (!size) return;
      const start = at + id.length + size.length;
      if (MASTERS.has(id.value)) {
        // A recorder that is still going writes the segment and clusters with an unknown size: their children are
        // read as siblings, up to the end of what holds them.
        if (size.unknown) {
          at = start;
          continue;
        }
        const end = Math.min(to, start + size.value);
        walk(start, end);
        at = end;
        continue;
      }
      const end = Math.min(to, start + size.value);
      if (id.value === CODEC_ID) opus = new TextDecoder().decode(b.subarray(start, end)) === 'A_OPUS';
      else if (id.value === CODEC_PRIVATE) head = b.slice(start, end);
      else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
        const track = vint(b, start, false);
        // Track number, a 16-bit timecode, flags; one track and no lacing is what MediaRecorder writes.
        if (track) packets.push(b.slice(start + track.length + 3, end));
      }
      at = end;
    }
  };
  walk(0, b.length);
  return opus && head && packets.length ? { head, packets } : null;
}

// ------------------------------------------------------------------ Ogg writing

/** Samples at 48 kHz in an Opus packet, from its table-of-contents byte (RFC 6716 3.1). */
export function opusSamples(p: Uint8Array): number {
  if (!p.length) return 0;
  const toc = p[0];
  const config = toc >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 1 || code === 2 ? 2 : p.length > 1 ? p[1] & 0x3f : 0;
  return frame * frames;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
/** Ogg's page checksum (CRC-32, polynomial 0x04c11db7, no reflection). */
export function oggCrc(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c;
}

function page(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const body = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[5] = flags;
  v.setUint32(6, granule % 2 ** 32, true);
  v.setUint32(10, Math.floor(granule / 2 ** 32), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  v.setUint32(22, oggCrc(out), true);
  return out;
}

/** Opus packets as an Ogg Opus file (RFC 7845): the header page, the tags page, then the audio, a page per second. */
export function oggOpus(head: Uint8Array, packets: Uint8Array[], serial = 0x0d17c4a7): Uint8Array {
  const preSkip = head.length >= 12 ? head[10] | (head[11] << 8) : 0;
  const vendor = new TextEncoder().encode('recorder');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [page([head], 0, serial, 0, 0x02), page([tags], 0, serial, 1, 0)];
  let granule = preSkip;
  let seq = 2;
  let batch: Uint8Array[] = [];
  let segs = 0;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    granule += opusSamples(p);
    batch.push(p);
    segs += Math.floor(p.length / 255) + 1;
    const last = i === packets.length - 1;
    if (last || batch.length >= 50 || segs > 200) {
      pages.push(page(batch, granule, serial, seq++, last ? 0x04 : 0));
      batch = [];
      segs = 0;
    }
  }
  const out = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A WebM Opus recording as Ogg Opus, or null when it is not one (the recording is then sent as it is). */
export function webmToOgg(b: Uint8Array): Uint8Array | null {
  const w = webmOpus(b);
  return w ? oggOpus(w.head, w.packets) : null;
}
