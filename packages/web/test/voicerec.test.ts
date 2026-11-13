/** Voice messages recorded in the composer (src/voicerec.ts): the type asked for, loudness, and WebM rewrapped as Ogg Opus. */
import { describe, expect, test } from 'bun:test';
import { bars, clock, loudness, oggCrc, oggOpus, opusSamples, voiceType, webmOpus, webmToOgg } from '../src/voicerec.ts';

// A WebM as MediaRecorder writes one while recording: EBML header, a segment and clusters of unknown size.
const id = (n: number) => {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
};
const size = (n: number) => [0x01, ...[0, 0, 0, 0, 0, 0, 0].map((_, i) => Math.floor(n / 256 ** (6 - i)) & 0xff)];
const el = (i: number, body: number[]) => [...id(i), ...size(body.length), ...body];
const unknown = (i: number) => [...id(i), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const text = (s: string) => [...new TextEncoder().encode(s)];
const HEAD = [...text('OpusHead'), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
/** A 20 ms CELT packet (config 31, one frame), then some bytes. */
const packet = (n: number) => [0xf8, ...new Array(n).fill(n & 0xff)];
const block = (p: number[]) => el(0xa3, [0x81, 0, 0, 0x80, ...p]);
function webm(packets: number[][]): Uint8Array {
  const tracks = el(0x1654ae6b, el(0xae, [...el(0xd7, [1]), ...el(0x86, text('A_OPUS')), ...el(0x63a2, HEAD)]));
  const clusters = packets.reduce<number[]>((acc, p, i) => [...acc, ...(i % 3 === 0 ? [...unknown(0x1f43b675), ...el(0xe7, [i])] : []), ...block(p)], []);
  return new Uint8Array([...el(0x1a45dfa3, el(0x4282, text('webm'))), ...unknown(0x18538067), ...el(0x1549a966, [0]), ...tracks, ...clusters]);
}

/** The pages of an Ogg file: header fields, CRC checked, and the packets put back together. */
function readOgg(b: Uint8Array) {
  const pages: { flags: number; granule: number; seq: number; crcOk: boolean; packets: Uint8Array[] }[] = [];
  let at = 0;
  let carry: number[] = [];
  while (at < b.length) {
    expect(new TextDecoder().decode(b.subarray(at, at + 4))).toBe('OggS');
    const v = new DataView(b.buffer, b.byteOffset + at);
    const n = b[at + 26];
    const lacing = [...b.subarray(at + 27, at + 27 + n)];
    const len = 27 + n + lacing.reduce((s, x) => s + x, 0);
    const copy = b.slice(at, at + len);
    new DataView(copy.buffer).setUint32(22, 0, true);
    const packets: Uint8Array[] = [];
    let off = at + 27 + n;
    for (const l of lacing) {
      carry.push(...b.subarray(off, off + l));
      off += l;
      if (l < 255) {
        packets.push(new Uint8Array(carry));
        carry = [];
      }
    }
    pages.push({ flags: b[at + 5], granule: v.getUint32(6, true) + v.getUint32(10, true) * 2 ** 32, seq: v.getUint32(18, true), crcOk: v.getUint32(22, true) === oggCrc(copy), packets });
    at += len;
  }
  return pages;
}

describe('recording', () => {
  test('Ogg where the browser records it, WebM Opus otherwise', () => {
    expect(voiceType((t) => t.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus');
    expect(voiceType((t) => t === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(voiceType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(voiceType(() => false)).toBeUndefined();
  });

  test('loudness, bars and the clock', () => {
    expect(loudness([])).toBe(0);
    expect(loudness([0.1, -0.1])).toBeCloseTo(0.4);
    expect(loudness([1, -1])).toBe(1);
    expect(bars([0, 1, 0.5, 0.2], 2)).toEqual([1, 0.5]);
    expect(bars([], 3)).toEqual([0, 0, 0]);
    expect(clock(7.9)).toBe('0:07');
    expect(clock(83)).toBe('1:23');
  });

  test("an Opus packet's samples from its first byte", () => {
    expect(opusSamples(new Uint8Array([0xf8]))).toBe(960); // CELT 20 ms
    expect(opusSamples(new Uint8Array([0xf9]))).toBe(1920); // two frames
    expect(opusSamples(new Uint8Array([0x18]))).toBe(2880); // SILK 60 ms
    expect(opusSamples(new Uint8Array([0xfb, 0x03]))).toBe(2880); // code 3, three frames
  });
});

describe('WebM to Ogg Opus', () => {
  const sizes = [10, 300, 20, 600, 5];
  const rec = webm(sizes.map(packet));

  test('reads the Opus header and every packet, through clusters of unknown size', () => {
    const w = webmOpus(rec)!;
    expect([...w.head]).toEqual(HEAD);
    expect(w.packets.map((p) => p.length)).toEqual(sizes.map((n) => n + 1));
  });

  test('writes the header page, the tags page and the audio with granule positions, each page checksummed', () => {
    const pages = readOgg(webmToOgg(rec)!);
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages.map((p) => p.seq)).toEqual([0, 1, 2]);
    expect(pages[0].flags).toBe(0x02);
    expect([...pages[0].packets[0]]).toEqual(HEAD);
    expect(new TextDecoder().decode(pages[1].packets[0].subarray(0, 8))).toBe('OpusTags');
    expect(pages[2].flags).toBe(0x04);
    // Pre-skip 312 plus five 20 ms packets.
    expect(pages[2].granule).toBe(312 + 5 * 960);
    expect(pages[2].packets.map((p) => p.length)).toEqual(sizes.map((n) => n + 1));
  });

  test('a long recording goes on several pages', () => {
    const pages = readOgg(oggOpus(new Uint8Array(HEAD), Array.from({ length: 120 }, () => new Uint8Array(packet(40)))));
    expect(pages.length).toBe(2 + 3);
    expect(pages.at(-1)!.granule).toBe(312 + 120 * 960);
    expect(pages.slice(2, -1).every((p) => p.flags === 0)).toBe(true);
  });

  test('anything but WebM Opus is left alone', () => {
    expect(webmToOgg(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(webmToOgg(new TextEncoder().encode('OggS....'))).toBeNull();
  });
});
