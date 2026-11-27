/**
 * The layers of a progressive JPEG (docs/uploads.md "Pictures that sharpen"): where each scan ends, so a phone can
 * upload a picture by quality, and a hub can send what it has of one as a valid, whole (if blurry) JPEG.
 *
 * A progressive JPEG sends the whole picture coarse to fine: the first scan (the DC of every component) is the
 * picture at 1:8 detail, and every scan after it sharpens all of it. Cut just after any whole scan, with an end marker
 * (FFD9) put after it, it is a JPEG every decoder takes. How good a cut looks was measured on camera photos made
 * progressive by jpegtran (SSIMULACRA 2, 1080p and 12 MP): the 1:8 picture once the DC is in (a few % of the bytes),
 * fair (50) from about 35% of the file kept, good (70) from about 60%.
 */

export type CutQuality = 'preview' | 'fair' | 'good' | 'full';
/** Worst to best: a cut is at least as good as a level when it is at or after it here. */
export const CUT_QUALITIES: CutQuality[] = ['preview', 'fair', 'good', 'full'];
/** Settings → Sending → "When a picture is cut off": the waits offered (null: for good), and what it starts at. */
export const CUT_WAITS: (number | null)[] = [null, 60_000, 5 * 60_000, 30 * 60_000];
export const CUT_SETTINGS_DEFAULT: { afterMs: number | null; atLeast: CutQuality } = { afterMs: 5 * 60_000, atLeast: 'fair' };
/** The share of the file a cut keeps from which it looks fair, and good (see above). */
export const CUT_FAIR = 0.35;
export const CUT_GOOD = 0.6;

export interface JpegLayers {
  /** Where each whole scan's data ends (the offset of the marker after it), in order. */
  ends: number[];
  /** The end of the scan after which every component has its DC: the first whole picture. */
  preview: number | null;
}

const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;
/** SOFn: the frame header, which says baseline or progressive. Not DHT (C4), JPG (C8) or DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Progressive frames: SOF2, SOF6, SOF10, SOF14. */
const isProgressiveSof = (m: number) => m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce;

/**
 * The scans of a progressive JPEG as far as `b` goes: only whole ones (a scan whose data runs past the end of `b` is
 * not counted). Null for anything else: not a JPEG, not progressive, or broken before its first scan.
 */
export function jpegLayers(b: Uint8Array): JpegLayers | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let progressive = false;
  let components = 0;
  const dcOf = new Set<number>();
  const ends: number[] = [];
  let preview: number | null = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return ends.length ? { ends, preview } : null;
    // Fill bytes before a marker.
    while (i + 1 < b.length && b[i + 1] === 0xff) i++;
    const m = b[i + 1];
    if (m === 0xd9) break;
    if (m === 0x01 || isRst(m)) {
      i += 2;
      continue;
    }
    if (i + 4 > b.length) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    const seg = i + 4;
    if (isSof(m)) {
      if (!isProgressiveSof(m)) return null;
      progressive = true;
      components = b[seg + 5] ?? 0;
    }
    if (m === 0xda) {
      if (!progressive || seg + len - 2 > b.length) break;
      const ns = b[seg];
      const ids = Array.from({ length: ns }, (_, k) => b[seg + 1 + k * 2]);
      const ss = b[seg + 1 + ns * 2];
      const ahal = b[seg + 3 + ns * 2];
      // The data runs to the next marker that is not a stuffed FF00 or a restart.
      let j = i + 2 + len;
      let end = -1;
      for (; j + 1 < b.length; j++) {
        if (b[j] !== 0xff) continue;
        const n = b[j + 1];
        if (n === 0x00 || isRst(n) || n === 0xff) continue;
        end = j;
        break;
      }
      if (end < 0) break;
      ends.push(end);
      // A first DC pass (Ss 0, Ah 0) for these components.
      if (ss === 0 && ahal >> 4 === 0) for (const id of ids) dcOf.add(id);
      if (preview === null && components && dcOf.size >= components) preview = end;
      i = end;
      continue;
    }
    i += 2 + len;
  }
  return progressive ? { ends, preview } : null;
}

/** How good a cut keeping `kept` bytes of a `size`-byte progressive JPEG looks (see above). */
export function cutQuality(kept: number, size: number, layers: JpegLayers): CutQuality | null {
  if (kept >= size) return 'full';
  if (layers.preview === null || kept < layers.preview) return null;
  if (kept >= size * CUT_GOOD) return 'good';
  if (kept >= size * CUT_FAIR) return 'fair';
  return 'preview';
}

/** Whether `q` is at least as good as `want`. */
export const atLeast = (q: CutQuality | null, want: CutQuality) => !!q && CUT_QUALITIES.indexOf(q) >= CUT_QUALITIES.indexOf(want);

/**
 * Where to cut what has arrived of a `size`-byte progressive JPEG (`got`, its first bytes): after its last whole scan,
 * and how good that looks. Null when there is nothing to send yet (not progressive, or not even the first picture).
 */
export function jpegCut(got: Uint8Array, size: number): { keep: number; quality: CutQuality } | null {
  const layers = jpegLayers(got);
  if (!layers?.ends.length) return null;
  const keep = layers.ends[layers.ends.length - 1];
  const quality = cutQuality(keep, size, layers);
  return quality ? { keep, quality } : null;
}

/** The cut file: the bytes up to the cut, then the end marker. */
export function cutJpeg(got: Uint8Array, keep: number): Uint8Array {
  const out = new Uint8Array(keep + 2);
  out.set(got.subarray(0, keep));
  out[keep] = 0xff;
  out[keep + 1] = 0xd9;
  return out;
}

/**
 * Whether a hub with the first `got` bytes sees that the scan ending at `end` is whole: only once it has the marker
 * after it (jpegLayers finds a scan's end by the next marker).
 */
export const seesEnd = (end: number, got: number) => end + 2 <= got;

/**
 * Where the upload of a progressive JPEG pauses for others, so every picture of a send gets its preview, then fair,
 * then good, before any one goes further (docs/uploads.md): just past the marker after the first scan end at or past
 * each level (seesEnd: else the hub, pausing there, could not tell the scan is whole), then the end.
 */
export function qualityStops(size: number, layers: JpegLayers): number[] {
  const past = (e: number | null | undefined) => (e == null ? size : Math.min(size, e + 2));
  const at = (share: number) => past(layers.ends.find((e) => e >= size * share));
  const stops = [past(layers.preview), at(CUT_FAIR), at(CUT_GOOD), size];
  return stops.filter((s, k) => s > 0 && stops.indexOf(s) === k).sort((a, b) => a - b);
}
