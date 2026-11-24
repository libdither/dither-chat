/**
 * JPEG XL's bytes (jxl.ts, docs/files.md "JPEG XL"): what is one, its size, and whether it is a JPEG repacked
 * losslessly. Pure, like fileinfo.ts, which uses it.
 */

export const JXL = 'image/jxl';

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** A bare codestream (FF 0A) or the ISO box container (`JXL ` signature box). */
export function isJxl(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return true;
  return b.length >= 12 && u32be(b, 0) === 12 && ascii(b, 4, 8) === 'JXL ' && b[8] === 0x0d && b[9] === 0x0a && b[10] === 0x87 && b[11] === 0x0a;
}

/** A container's boxes found in `b`: type and payload. Stops at the end of `b` or at a box running past it. */
function boxes(b: Uint8Array): { type: string; payload: Uint8Array }[] {
  const out: { type: string; payload: Uint8Array }[] = [];
  let at = 0;
  for (let n = 0; n < 64 && at + 8 <= b.length; n++) {
    let size = u32be(b, at);
    const type = ascii(b, at + 4, at + 8);
    let head = 8;
    if (size === 1) {
      if (at + 16 > b.length) break;
      size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12);
      head = 16;
    } else if (size === 0) size = b.length - at;
    if (size < head) break;
    out.push({ type, payload: b.subarray(at + head, Math.min(b.length, at + size)) });
    at += size;
  }
  return out;
}

/** The start of the codestream: the file itself, or the payload of the first jxlc or jxlp box. */
function codestream(b: Uint8Array): Uint8Array | null {
  if (b[0] === 0xff && b[1] === 0x0a) return b;
  for (const x of boxes(b)) {
    if (x.type === 'jxlc') return x.payload;
    if (x.type === 'jxlp') return x.payload.subarray(4);
  }
  return null;
}

/** True when the file is a JPEG repacked losslessly (its `jbrd` box), which djxl gives back byte for byte. */
export function repackedJpeg(head: Uint8Array): boolean {
  return !(head[0] === 0xff && head[1] === 0x0a) && boxes(head).some((x) => x.type === 'jbrd');
}

const RATIO: [number, number][] = [
  [1, 1],
  [12, 10],
  [4, 3],
  [3, 2],
  [16, 9],
  [5, 4],
  [2, 1],
];

/** Width and height from the codestream's SizeHeader, turned for an orientation that swaps them. */
export function jxlDims(b: Uint8Array): { width?: number; height?: number } {
  const cs = codestream(b);
  if (!cs || cs.length < 4 || cs[0] !== 0xff || cs[1] !== 0x0a) return {};
  let pos = 16;
  const bit = () => {
    const byte = cs[pos >> 3];
    if (byte === undefined) throw new RangeError('short');
    return (byte >> (pos++ & 7)) & 1;
  };
  const u = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v += bit() * 2 ** i;
    return v;
  };
  const size = () => 1 + u([9, 13, 18, 30][u(2)]);
  try {
    const small = bit();
    const height = small ? (u(5) + 1) * 8 : size();
    const ratio = u(3);
    const width = ratio ? Math.floor((height * RATIO[ratio - 1][0]) / RATIO[ratio - 1][1]) : small ? (u(5) + 1) * 8 : size();
    // ImageMetadata: all_default, then extra_fields, then the orientation (5 to 8 are turned a quarter).
    let orientation = 1;
    if (!bit() && bit()) orientation = 1 + u(3);
    return orientation > 4 ? { width: height, height: width } : { width, height };
  } catch {
    return {};
  }
}

