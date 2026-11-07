/**
 * What a kept file is, by its bytes (docs/files.md). A network's type is often wrong or just
 * application/octet-stream, so the type comes from magic numbers and content, and the name and the network's type
 * only break ties between kinds of text.
 *
 * Reads are bounded: the first 64 KiB for the type, the first 2 MiB of text, the end of a zip for its directory, a
 * PDF's first 4 MiB and last 1 MiB, archive headers one by one, and at most 8 MiB out of a gzip. Nothing is extracted
 * or written anywhere, and nothing here runs anything. Pure apart from the reads, so tests feed it bytes.
 */
import { inflateSync } from 'node:zlib';
import type * as P from '@dither-chat/protocol';
import { cleanName, extOf, languageOf, MIME_BY_LANGUAGE } from '@dither-chat/protocol';

/** Bump when the sniffer learns something new: files looked at by an older one are looked at again. */
export const SNIFF_VERSION = 1;

export const HEAD = 64 * 1024;
export const TEXT_MAX = 2 * 1024 * 1024;
const PDF_HEAD = 4 * 1024 * 1024;
const PDF_TAIL = 1024 * 1024;
const INFLATE_MAX = 8 * 1024 * 1024;
/** Entries kept in an archive's list. */
export const LIST_MAX = 50;
/** Archive headers walked before the count is called partial. */
const WALK_MAX = 5000;

export interface Source {
  size: number;
  /** Up to `len` bytes from `at`; fewer at the end. */
  read(at: number, len: number): Promise<Uint8Array>;
}

export const bytesSource = (b: Uint8Array): Source => ({ size: b.length, read: async (at, len) => b.subarray(Math.max(0, at), Math.max(0, Math.min(b.length, at + len))) });

export function fileSource(path: string): Source {
  const f = Bun.file(path);
  return { size: f.size, read: async (at, len) => new Uint8Array(await f.slice(at, at + len).arrayBuffer()) };
}

const latin1 = new TextDecoder('latin1');
const ascii = (b: Uint8Array, from: number, to: number) => latin1.decode(b.subarray(from, Math.min(to, b.length)));
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b: Uint8Array, i: number) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
const u64le = (b: Uint8Array, i: number) => u32le(b, i) + u32le(b, i + 4) * 2 ** 32;
const u64be = (b: Uint8Array, i: number) => u32be(b, i) * 2 ** 32 + u32be(b, i + 4);
const has = (b: Uint8Array, at: number, s: string) => b.length >= at + s.length && ascii(b, at, at + s.length) === s;
const essence = (m: string | null | undefined) => (m ?? '').split(';')[0].trim().toLowerCase();
const plainType = (m: string) => /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(m);
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/unknown', 'application/x-download', 'application/force-download']);
/** A type that says nothing about the bytes. */
export const genericType = (m: string | null | undefined) => GENERIC.has(essence(m));
const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : undefined);
const dims = (w: number, h: number) => (w > 0 && h > 0 && w < 1e6 && h < 1e6 ? { width: w, height: h } : {});

type Partial_ = Omit<P.FileInfo, 'size'>;

/** What `src` is. `hint` is what the network said: a name and a type, both untrusted. */
export async function analyze(src: Source, hint: { name?: string | null; mime?: string | null } = {}): Promise<P.FileInfo> {
  const size = src.size;
  const head = await src.read(0, Math.min(size, HEAD));
  const found = (await magic(src, head, hint)) ?? (await text(src, head, hint));
  const out: P.FileInfo = { ...found, size };
  // Nothing undefined on the wire or in the table.
  for (const k of Object.keys(out) as (keyof P.FileInfo)[]) if (out[k] === undefined) delete out[k];
  return out;
}

// ------------------------------------------------------------------ binary kinds

async function magic(src: Source, b: Uint8Array, hint: { name?: string | null; mime?: string | null }): Promise<Partial_ | null> {
  const ext = extOf(hint.name);
  const pdfAt = ascii(b, 0, 1024).indexOf('%PDF-');
  if (pdfAt === 0 || (pdfAt > 0 && b.subarray(0, pdfAt).some((c) => c < 9 || c > 126))) return { mime: 'application/pdf', kind: 'pdf', ...(await pdfPages(src, b)) };
  if (b[0] === 0x89 && has(b, 1, 'PNG\r\n\x1a\n')) return { mime: 'image/png', kind: 'image', ...(b.length >= 24 ? dims(u32be(b, 16), u32be(b, 20)) : {}) };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', kind: 'image', ...(await jpegDims(src)) };
  if (has(b, 0, 'GIF87a') || has(b, 0, 'GIF89a')) return { mime: 'image/gif', kind: 'image', ...(b.length >= 10 ? dims(u16le(b, 6), u16le(b, 8)) : {}) };
  if (has(b, 0, 'RIFF') && has(b, 8, 'WEBP')) return { mime: 'image/webp', kind: 'image', ...webpDims(b) };
  if (has(b, 0, 'BM') && b.length >= 26 && u32le(b, 2) >= 26) {
    const dib = u32le(b, 14);
    const w = dib === 12 ? u16le(b, 18) : u32le(b, 18) | 0;
    const h = dib === 12 ? u16le(b, 20) : u32le(b, 22) | 0;
    if (dib >= 12 && dib <= 124) return { mime: 'image/bmp', kind: 'image', ...dims(Math.abs(w), Math.abs(h)) };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b.length >= 22 && u16le(b, 4) > 0 && u16le(b, 4) < 256 && (b[9] === 0 || b[9] === 255) && (ext === 'ico' || ext === 'cur' || ext === '')) {
    return { mime: 'image/x-icon', kind: 'image', ...dims(b[6] || 256, b[7] || 256) };
  }
  if ((has(b, 0, 'II*\0') || has(b, 0, 'MM\0*')) && !['cr2', 'nef', 'dng', 'arw'].includes(ext)) return { mime: 'image/tiff', kind: 'binary' };
  if (has(b, 0, '8BPS')) return { mime: 'image/vnd.adobe.photoshop', kind: 'binary', ...(b.length >= 22 ? dims(u32be(b, 18), u32be(b, 14)) : {}) };
  if (has(b, 4, 'ftyp')) return isoMedia(src, b);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return matroska(src, ext);
  if (has(b, 0, 'OggS')) return ogg(src, b);
  if (has(b, 0, 'RIFF') && has(b, 8, 'WAVE')) return { mime: 'audio/wav', kind: 'audio', ...(await wavDuration(src)) };
  if (has(b, 0, 'RIFF') && has(b, 8, 'AVI ')) return { mime: 'video/x-msvideo', kind: 'binary' };
  if (has(b, 0, 'fLaC')) return { mime: 'audio/flac', kind: 'audio', ...flacDuration(b) };
  if (has(b, 0, 'FORM') && (has(b, 8, 'AIFF') || has(b, 8, 'AIFC'))) return { mime: 'audio/aiff', kind: 'binary' };
  if (has(b, 0, 'MThd')) return { mime: 'audio/midi', kind: 'binary' };
  if (has(b, 0, 'PK\x03\x04') || has(b, 0, 'PK\x05\x06')) return zip(src, b, ext);
  if (b[0] === 0x1f && b[1] === 0x8b && b[2] === 8) return gzip(src, b, hint.name);
  if (b.length >= 263 && has(b, 257, 'ustar')) return { mime: 'application/x-tar', kind: 'archive', ...(await tar(windowed(src), src.size)) };
  if (has(b, 0, 'BZh') && /[1-9]/.test(String.fromCharCode(b[3]))) return { mime: 'application/x-bzip2', kind: 'binary' };
  if (has(b, 0, '\xfd7zXZ\0')) return { mime: 'application/x-xz', kind: 'binary' };
  if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return { mime: 'application/zstd', kind: 'binary' };
  if (has(b, 0, "7z\xbc\xaf'\x1c")) return { mime: 'application/x-7z-compressed', kind: 'binary' };
  if (has(b, 0, 'Rar!\x1a\x07')) return { mime: 'application/vnd.rar', kind: 'binary' };
  if (has(b, 0, 'MSCF')) return { mime: 'application/vnd.ms-cab-compressed', kind: 'binary' };
  if (has(b, 0, '!<arch>\ndebian')) return { mime: 'application/vnd.debian.binary-package', kind: 'binary' };
  if (b[0] === 0xed && b[1] === 0xab && b[2] === 0xee && b[3] === 0xdb) return { mime: 'application/x-rpm', kind: 'binary' };
  if (has(b, 0, '\x7fELF')) return { mime: 'application/x-executable', kind: 'binary' };
  if (has(b, 0, 'MZ') && b.length >= 64) {
    const pe = u32le(b, 60);
    if (pe < b.length - 4 && has(b, pe, 'PE\0\0')) return { mime: 'application/vnd.microsoft.portable-executable', kind: 'binary' };
  }
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32be(b, 0))) return { mime: 'application/x-mach-binary', kind: 'binary' };
  if (u32be(b, 0) === 0xcafebabe) return { mime: ext === 'class' ? 'application/java-vm' : 'application/x-mach-binary', kind: 'binary' };
  if (has(b, 0, '\0asm')) return { mime: 'application/wasm', kind: 'binary' };
  if (has(b, 0, 'dex\n')) return { mime: 'application/vnd.android.dex', kind: 'binary' };
  if (has(b, 0, 'SQLite format 3\0')) return { mime: 'application/vnd.sqlite3', kind: 'binary' };
  if (has(b, 0, 'wOFF')) return { mime: 'font/woff', kind: 'binary' };
  if (has(b, 0, 'wOF2')) return { mime: 'font/woff2', kind: 'binary' };
  if (has(b, 0, 'OTTO')) return { mime: 'font/otf', kind: 'binary' };
  if (u32be(b, 0) === 0x00010000 && b.length >= 12 && u16be(b, 4) > 0 && u16be(b, 4) < 64 && /^(ttf|ttc|otf|)$/.test(ext)) return { mime: 'font/ttf', kind: 'binary' };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) {
    const ole: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', msg: 'application/vnd.ms-outlook', msi: 'application/x-msi' };
    return { mime: ole[ext] ?? 'application/x-ole-storage', kind: 'binary' };
  }
  if (b.length > 0x8006 && has(b, 0x8001, 'CD001')) return { mime: 'application/x-iso9660-image', kind: 'binary' };
  // Last: MPEG audio frames start with a sync that random bytes (or a UTF-16 byte-order mark) can have too, so only
  // two frames in a row count.
  if (has(b, 0, 'ID3')) return mp3(src, b);
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return null;
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0 && adtsFrames(b)) return { mime: 'audio/aac', kind: 'audio' };
  const f = mpegFrame(b, 0);
  if (f && mpegFrame(b, f.length)) return mp3(src, b);
  return null;
}

// ------------------------------------------------------------------ text

/** The encoding of text, or null for binary. */
export function textEncoding(b: Uint8Array): string | null {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  const n = Math.min(b.length, HEAD);
  let zeroEven = 0;
  let zeroOdd = 0;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) (i & 1 ? zeroOdd++ : zeroEven++);
    else if (c < 9 || (c > 13 && c < 32 && c !== 27) || c === 127) control++;
  }
  if (zeroEven + zeroOdd) {
    // ASCII-range text in UTF-16 without a byte-order mark: every other byte is zero.
    if (n >= 4 && zeroOdd > n * 0.4 && zeroEven < n * 0.02) return 'utf-16le';
    if (n >= 4 && zeroEven > n * 0.4 && zeroOdd < n * 0.02) return 'utf-16be';
    return null;
  }
  if (control > Math.max(1, n * 0.01)) return null;
  // A multi-byte character cut by the end of what was read is not an error.
  let end = n;
  for (let k = 1; k <= 3 && end - k >= 0; k++) {
    const c = b[end - k];
    if ((c & 0xc0) === 0x80) continue;
    if (c >= 0xc0) end -= k;
    break;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, end));
    return 'utf-8';
  } catch {
    // Not UTF-8 but no control bytes either: an 8-bit code page, most likely Windows' own.
    return 'windows-1252';
  }
}

async function text(src: Source, head: Uint8Array, hint: { name?: string | null; mime?: string | null }): Promise<Partial_> {
  const net = essence(hint.mime);
  const encoding = src.size === 0 ? 'utf-8' : textEncoding(head);
  if (!encoding) {
    // Binary nobody here knows: the network's type when it is a specific one.
    const keep = plainType(net) && !GENERIC.has(net) && !/^(text|image|video|audio)\//.test(net) && !/json|xml|csv|markdown|javascript|pdf|zip|tar|gzip/.test(net);
    return { mime: keep ? net : 'application/octet-stream', kind: 'binary' };
  }
  const partial = src.size > TEXT_MAX;
  const bytes = src.size <= head.length ? head : await src.read(0, Math.min(src.size, TEXT_MAX));
  const s = new TextDecoder(encoding).decode(bytes).replace(/^\ufeff/, '');
  let lines = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) lines++;
  if (s.length && !s.endsWith('\n') && !partial) lines++;
  const base = { encoding, lines, ...(partial ? { partial: true } : {}) };
  const as = (language: string | null, kind: P.FileKind = 'text', mime?: string): Partial_ => ({
    mime: mime ?? (language ? (MIME_BY_LANGUAGE[language] ?? 'text/plain') : 'text/plain'),
    kind,
    ...base,
    ...(language ? { language } : {}),
  });

  const start = s.slice(0, 4096).trimStart().toLowerCase();
  // Markup that a browser would run is told by its content, whatever it is called: it is only ever shown as text.
  if (/^<!doctype html|^<html[\s>]/.test(start)) return as('html', 'text', 'text/html');
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(start)) return as('xml', 'text', 'image/svg+xml');
  if (start.startsWith('<?xml')) return as(languageOf(hint.name) === 'html' ? 'html' : 'xml', 'text', 'application/xml');

  let lang = languageOf(hint.name);
  if (!lang) {
    if (net === 'text/markdown') lang = 'markdown';
    else if (net === 'application/json') lang = 'json';
    else if (net === 'text/csv') lang = 'csv';
    else if (net === 'text/tab-separated-values') lang = 'tsv';
  }
  if (!lang) lang = byContent(s, partial);
  if (lang === 'markdown') return as('markdown', 'markdown');
  if (lang === 'csv' || lang === 'tsv') return as(lang, 'csv');
  if (lang === 'json') {
    // A file called .json that isn't is still shown, as text.
    let valid = partial;
    if (!partial)
      try {
        JSON.parse(s);
        valid = true;
      } catch {}
    return as('json', valid ? 'json' : 'text', 'application/json');
  }
  if (lang === 'html') return as('html', 'text', 'text/html');
  return as(lang);
}

/** A language from the text itself, for a file whose name says none. */
function byContent(s: string, partial: boolean): string | null {
  const first = s.slice(0, 200).split('\n')[0];
  const bang = first.match(/^#!\s*\S*?\b(?:env\s+(?:-\S+\s+)*)?(python\d?|node|deno|bun|bash|sh|zsh|ksh|fish|ruby|perl|php|lua)\b/);
  if (bang) {
    const b = bang[1];
    return b.startsWith('python') ? 'python' : /^(node|deno|bun)$/.test(b) ? 'javascript' : /^(bash|sh|zsh|ksh|fish)$/.test(b) ? 'shell' : b;
  }
  const t = s.trimStart();
  if (/^[[{]/.test(t) && !partial) {
    try {
      JSON.parse(s);
      return 'json';
    } catch {}
  }
  if (/^diff --git |^--- \S.*\n\+\+\+ \S/.test(t)) return 'diff';
  const sample = s.slice(0, 16384);
  let marks = 0;
  if (/^#{1,6} \S/m.test(sample)) marks++;
  if (/^(?:[-*+]|\d+\.) \S/m.test(sample)) marks++;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(sample)) marks++;
  if (/^```/m.test(sample)) marks++;
  if (/^\|.*\|\s*$\n^\|\s*:?-{3,}/m.test(sample)) marks++;
  return marks >= 2 ? 'markdown' : null;
}

// ------------------------------------------------------------------ images

async function jpegDims(src: Source): Promise<{ width?: number; height?: number }> {
  // Markers one after another; a large EXIF block can push the frame header past the first read.
  let at = 2;
  for (let n = 0; n < 200 && at + 9 < src.size; n++) {
    const h = await src.read(at, 10);
    if (h.length < 4 || h[0] !== 0xff) return {};
    const m = h[1];
    if (m === 0xff) {
      at++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      at += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return h.length >= 9 ? dims(u16be(h, 7), u16be(h, 5)) : {};
    if (m === 0xd9 || m === 0xda) return {};
    const len = u16be(h, 2);
    if (len < 2) return {};
    at += 2 + len;
  }
  return {};
}

function webpDims(b: Uint8Array): { width?: number; height?: number } {
  if (has(b, 12, 'VP8 ') && b.length >= 30) return dims(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  if (has(b, 12, 'VP8L') && b.length >= 25) return dims(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
  if (has(b, 12, 'VP8X') && b.length >= 30) return dims(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
  return {};
}

// ------------------------------------------------------------------ audio and video

/** MP4, QuickTime, M4A, 3GP, AVIF, HEIC: the brand, then the movie header for duration and the tracks for size. */
async function isoMedia(src: Source, b: Uint8Array): Promise<Partial_> {
  const brand = ascii(b, 8, 12);
  if (/^(avif|avis)$/.test(brand)) return { mime: 'image/avif', kind: 'image', ...ispe(b) };
  if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return { mime: 'image/heic', kind: 'binary', ...ispe(b) };
  let at = 0;
  for (let n = 0; n < 64 && at + 8 <= src.size; n++) {
    const h = await src.read(at, 16);
    if (h.length < 8) break;
    let size = u32be(h, 0);
    const type = ascii(h, 4, 8);
    if (size === 1 && h.length >= 16) size = u64be(h, 8);
    else if (size === 0) size = src.size - at;
    if (size < 8) break;
    if (type === 'moov') {
      const moov = await src.read(at, Math.min(size, 1024 * 1024));
      const m = movie(moov);
      const audioOnly = brand === 'M4A ' || brand === 'M4B ' || (m.tracks > 0 && !m.width);
      const mime = audioOnly ? 'audio/mp4' : brand === 'qt  ' ? 'video/quicktime' : /^3g/.test(brand) ? 'video/3gpp' : 'video/mp4';
      return { mime, kind: audioOnly ? 'audio' : 'video', ...(m.duration ? { duration: m.duration } : {}), ...(audioOnly ? {} : dims(m.width, m.height)) };
    }
    at += size;
  }
  return { mime: brand === 'M4A ' ? 'audio/mp4' : brand === 'qt  ' ? 'video/quicktime' : 'video/mp4', kind: brand === 'M4A ' ? 'audio' : 'video' };
}

function ispe(b: Uint8Array) {
  const i = ascii(b, 0, b.length).indexOf('ispe');
  return i > 0 && i + 16 <= b.length ? dims(u32be(b, i + 8), u32be(b, i + 12)) : {};
}

/** Inside a moov box: mvhd's duration, and the size of the first track that has one. */
function movie(moov: Uint8Array): { duration?: number; width: number; height: number; tracks: number } {
  const out = { duration: undefined as number | undefined, width: 0, height: 0, tracks: 0 };
  const walk = (from: number, to: number, depth: number) => {
    let at = from;
    while (at + 8 <= to && depth < 4) {
      let size = u32be(moov, at);
      const type = ascii(moov, at + 4, at + 8);
      let body = at + 8;
      if (size === 1) {
        size = u64be(moov, at + 8);
        body += 8;
      } else if (size === 0) size = to - at;
      if (size < 8) return;
      const end = Math.min(to, at + size);
      if (type === 'mvhd' && body + 32 <= moov.length) {
        const v = moov[body];
        const scale = v === 1 ? u32be(moov, body + 20) : u32be(moov, body + 12);
        const dur = v === 1 ? u64be(moov, body + 24) : u32be(moov, body + 16);
        if (scale && dur !== 0xffffffff) out.duration = finite(dur / scale);
      } else if (type === 'trak') {
        out.tracks++;
        walk(body, end, depth + 1);
      } else if (type === 'tkhd' && body + 84 <= moov.length && !out.width) {
        const off = moov[body] === 1 ? 88 : 76;
        if (body + off + 8 <= moov.length) {
          out.width = Math.round(u32be(moov, body + off) / 65536);
          out.height = Math.round(u32be(moov, body + off + 4) / 65536);
        }
      }
      at = end;
    }
  };
  walk(8, moov.length, 0);
  return out;
}

/** WebM and Matroska: the segment's Info (duration) and Tracks (a video track's size), from the first 512 KiB. */
async function matroska(src: Source, ext: string): Promise<Partial_> {
  const b = await src.read(0, Math.min(src.size, 512 * 1024));
  let doc = '';
  let scale = 1_000_000;
  let duration: number | undefined;
  let width = 0;
  let height = 0;
  let video = false;
  let tracks = false;
  const vint = (at: number, keepMarker: boolean): [value: number, len: number] | null => {
    const first = b[at];
    if (first === undefined || first === 0) return null;
    const len = Math.clz32(first) - 23;
    if (len < 1 || len > 8 || at + len > b.length) return null;
    let v = keepMarker ? first : first & (0xff >> len);
    let allOnes = v === (0xff >> len);
    for (let i = 1; i < len; i++) {
      v = v * 256 + b[at + i];
      if (b[at + i] !== 0xff) allOnes = false;
    }
    return [!keepMarker && allOnes ? -1 : v, len];
  };
  const uint = (at: number, len: number) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + b[at + i];
    return v;
  };
  const MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0]);
  const walk = (from: number, to: number, depth: number) => {
    let at = from;
    while (at < to && depth < 6) {
      const id = vint(at, true);
      if (!id) return;
      const sz = vint(at + id[1], false);
      if (!sz) return;
      const body = at + id[1] + sz[1];
      const end = sz[0] < 0 ? to : Math.min(to, body + sz[0]);
      const len = end - body;
      const tag = id[0];
      if (tag === 0x1f43b675) return; // the first cluster: the headers are over
      if (tag === 0x1a45dfa3) walk(body, end, depth + 1);
      else if (tag === 0x4282) doc = ascii(b, body, end);
      else if (tag === 0x1654ae6b) {
        tracks = true;
        walk(body, end, depth + 1);
      } else if (MASTER.has(tag)) walk(body, end, depth + 1);
      else if (tag === 0x83 && uint(body, len) === 1) video = true;
      else if (tag === 0x2ad7b1 && len <= 8) scale = uint(body, len) || scale;
      else if (tag === 0x4489 && (len === 4 || len === 8)) {
        const dv = new DataView(b.buffer, b.byteOffset + body, len);
        duration = len === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
      } else if (tag === 0xb0 && !width) width = uint(body, len);
      else if (tag === 0xba && !height) height = uint(body, len);
      at = end;
    }
  };
  walk(0, b.length, 0);
  const audioOnly = tracks && !video;
  const mime = doc === 'webm' || ext === 'webm' || ext === 'weba' ? (audioOnly ? 'audio/webm' : 'video/webm') : audioOnly ? 'audio/x-matroska' : 'video/x-matroska';
  const seconds = duration !== undefined ? finite((duration * scale) / 1e9) : undefined;
  return { mime, kind: audioOnly ? 'audio' : 'video', ...(seconds ? { duration: seconds } : {}), ...(audioOnly ? {} : dims(width, height)) };
}

/** Ogg: the codec from the first packet, the duration from the last page's granule position. */
async function ogg(src: Source, b: Uint8Array): Promise<Partial_> {
  const segs = b[26] ?? 0;
  const p = 27 + segs;
  let rate = 0;
  let skip = 0;
  let mime = 'audio/ogg';
  let kind: P.FileKind = 'audio';
  if (has(b, p, 'OpusHead')) {
    rate = 48000;
    skip = u16le(b, p + 10);
  } else if (has(b, p, '\x01vorbis')) rate = u32le(b, p + 12);
  else if (has(b, p, '\x80theora')) {
    mime = 'video/ogg';
    kind = 'video';
  } else if (has(b, p, '\x7fFLAC')) rate = b.length > p + 30 ? (b[p + 27] << 12) | (b[p + 28] << 4) | (b[p + 29] >> 4) : 0;
  if (!rate) return { mime, kind };
  const tailLen = Math.min(src.size, 64 * 1024);
  const tail = await src.read(src.size - tailLen, tailLen);
  const s = ascii(tail, 0, tail.length);
  const serial = u32le(b, 14);
  for (let i = s.lastIndexOf('OggS'); i >= 0; i = i > 0 ? s.lastIndexOf('OggS', i - 1) : -1) {
    if (i + 18 > tail.length || u32le(tail, i + 14) !== serial) continue;
    const granule = u64le(tail, i + 6);
    if (granule >= 2 ** 53 || granule <= skip) continue;
    const seconds = finite((granule - skip) / rate);
    return seconds ? { mime, kind, duration: seconds } : { mime, kind };
  }
  return { mime, kind };
}

async function wavDuration(src: Source): Promise<{ duration?: number }> {
  let at = 12;
  let rate = 0;
  for (let n = 0; n < 32 && at + 8 <= src.size; n++) {
    const h = await src.read(at, 24);
    if (h.length < 8) break;
    const id = ascii(h, 0, 4);
    const size = u32le(h, 4);
    if (id === 'fmt ' && h.length >= 20) rate = u32le(h, 16);
    if (id === 'data') {
      const bytes = size === 0 || size === 0xffffffff ? src.size - at - 8 : Math.min(size, src.size - at - 8);
      const seconds = rate ? finite(bytes / rate) : undefined;
      return seconds ? { duration: seconds } : {};
    }
    at += 8 + size + (size & 1);
  }
  return {};
}

function flacDuration(b: Uint8Array): { duration?: number } {
  if ((b[4] & 0x7f) !== 0 || b.length < 26) return {};
  const d = 8;
  const rate = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
  const samples = (b[d + 13] & 0x0f) * 2 ** 32 + u32be(b, d + 14);
  const seconds = rate ? finite(samples / rate) : undefined;
  return seconds ? { duration: seconds } : {};
}

const MPEG_RATES = [
  [11025, 12000, 8000], // 2.5
  [0, 0, 0],
  [22050, 24000, 16000], // 2
  [44100, 48000, 32000], // 1
];
const MPEG_KBPS: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** An MPEG audio frame header at `i`: its version, layer, rate and bitrate; null when it isn't one. */
function mpegFrame(b: Uint8Array, i: number) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3;
  const layer = 4 - ((b[i + 1] >> 1) & 3);
  const bri = b[i + 2] >> 4;
  const sri = (b[i + 2] >> 2) & 3;
  if (ver === 1 || layer === 4 || bri === 0 || bri === 15 || sri === 3) return null;
  const kbps = MPEG_KBPS[`${ver === 3 ? 1 : 2}-${ver === 3 ? layer : layer === 1 ? 1 : 2}`][bri];
  const rate = MPEG_RATES[ver][sri];
  const spf = layer === 1 ? 384 : layer === 2 || ver === 3 ? 1152 : 576;
  const pad = (b[i + 2] >> 1) & 1;
  const length = layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor(((spf / 8) * kbps * 1000) / rate) + pad;
  return { ver, layer, kbps, rate, spf, length, mono: b[i + 3] >> 6 === 3 };
}

/** Two AAC ADTS frames in a row: the frame length is 13 bits from the fourth byte. */
function adtsFrames(b: Uint8Array): boolean {
  const len = ((b[3] & 0x03) << 11) | (b[4] << 3) | (b[5] >> 5);
  return len > 7 && len + 2 <= b.length && b[len] === 0xff && (b[len + 1] & 0xf6) === 0xf0;
}

async function mp3(src: Source, b: Uint8Array): Promise<Partial_> {
  let start = 0;
  if (has(b, 0, 'ID3') && b.length >= 10) start = 10 + ((b[6] & 0x7f) << 21) + ((b[7] & 0x7f) << 14) + ((b[8] & 0x7f) << 7) + (b[9] & 0x7f) + (b[5] & 0x10 ? 10 : 0);
  const h = await src.read(start, 256);
  // A tag can be padded: the first frame within the next few bytes.
  let i = 0;
  while (i < h.length - 4 && !mpegFrame(h, i)) i++;
  const f = mpegFrame(h, i);
  if (!f) return { mime: 'audio/mpeg', kind: 'audio' };
  const side = f.ver === 3 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17;
  const x = i + 4 + side;
  let frames = 0;
  if ((has(h, x, 'Xing') || has(h, x, 'Info')) && u32be(h, x + 4) & 1) frames = u32be(h, x + 8);
  else if (has(h, i + 36, 'VBRI')) frames = u32be(h, i + 36 + 14);
  const seconds = frames ? frames * (f.spf / f.rate) : f.kbps ? ((src.size - start - i) * 8) / (f.kbps * 1000) : 0;
  return { mime: 'audio/mpeg', kind: 'audio', ...(finite(seconds) ? { duration: finite(seconds) } : {}) };
}

// ------------------------------------------------------------------ PDF

/**
 * Page count: a linearized file says it at the top (/N); otherwise the largest /Count of a /Pages node, in the plain
 * text or inside compressed object streams, looked for in the first 4 MiB and the last 1 MiB.
 */
async function pdfPages(src: Source, head: Uint8Array): Promise<{ pages?: number }> {
  const top = ascii(head, 0, 2048);
  const lin = top.match(/\/Linearized[\s\S]{0,400}?\/N\s+(\d+)/);
  if (lin) return { pages: Number(lin[1]) };
  const whole = src.size <= PDF_HEAD + PDF_TAIL;
  const parts = whole ? [await src.read(0, src.size)] : [await src.read(0, PDF_HEAD), await src.read(src.size - PDF_TAIL, PDF_TAIL)];
  let best = 0;
  let budget = INFLATE_MAX * 2;
  for (const part of parts) {
    const s = latin1.decode(part);
    best = Math.max(best, maxCount(s));
    // Object streams (PDF 1.5): page tree nodes may be in there, compressed.
    for (const m of s.matchAll(/\/Type\s*\/ObjStm\b/g)) {
      if (budget <= 0) break;
      const dict = dictAround(s, m.index!);
      if (!dict || !/\/FlateDecode/.test(dict.text) || /\/DecodeParms|\/Encrypt/.test(dict.text)) continue;
      const st = s.slice(dict.end, dict.end + 64).match(/^\s*stream\r?\n/);
      if (!st) continue;
      const from = dict.end + st[0].length;
      const lenM = dict.text.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      const to = lenM ? from + Number(lenM[1]) : s.indexOf('endstream', from);
      if (to <= from || to > part.length) continue;
      try {
        const out = inflateSync(part.subarray(from, to), { maxOutputLength: Math.min(budget, INFLATE_MAX) });
        budget -= out.length;
        best = Math.max(best, maxCount(latin1.decode(out)));
      } catch {}
    }
  }
  if (!best && whole) {
    // An odd file with a page tree we could not find: count the pages themselves.
    const s = latin1.decode(parts[0]);
    best = (s.match(/\/Type\s*\/Page(?![\w])/g) ?? []).length;
  }
  return best > 0 && best < 1e6 ? { pages: best } : {};
}

function maxCount(s: string): number {
  let best = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages\b/g)) {
    const d = dictAround(s, m.index!);
    const c = d?.text.match(/\/Count\s+(\d+)/);
    if (c) best = Math.max(best, Number(c[1]));
  }
  return best;
}

/** The innermost `<< … >>` around `at`: its text and where it ends. */
function dictAround(s: string, at: number): { text: string; end: number } | null {
  let open = s.lastIndexOf('<<', at);
  // Step out of dictionaries that close before `at` (a /Resources << … >> before /Type).
  for (let guard = 0; open >= 0 && guard < 32; guard++) {
    const close = s.indexOf('>>', open);
    if (close === -1 || close > at) break;
    open = s.lastIndexOf('<<', open - 1);
  }
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < Math.min(s.length, open + 1024 * 1024); i++) {
    if (s[i] === '<' && s[i + 1] === '<') {
      depth++;
      i++;
    } else if (s[i] === '>' && s[i + 1] === '>') {
      depth--;
      i++;
      if (!depth) return { text: s.slice(open, i + 1), end: i + 1 };
    }
  }
  return null;
}

// ------------------------------------------------------------------ archives

const entryName = (b: Uint8Array, utf8: boolean) => cleanName(utf8 ? new TextDecoder().decode(b) : latin1.decode(b));

/** ZIP and what is built on it (Office, OpenDocument, EPUB, JAR, APK): the central directory at the end. */
async function zip(src: Source, head: Uint8Array, ext: string): Promise<Partial_> {
  const tailLen = Math.min(src.size, 65_557);
  const tail = await src.read(src.size - tailLen, tailLen);
  const t = ascii(tail, 0, tail.length);
  const e = t.lastIndexOf('PK\x05\x06');
  const names: P.ArchiveEntry[] = [];
  const all: string[] = [];
  let total = 0;
  let partial = false;
  if (e >= 0 && e + 22 <= tail.length) {
    total = u16le(tail, e + 10);
    let cdSize = u32le(tail, e + 12);
    let cdAt = u32le(tail, e + 16);
    if ((total === 0xffff || cdAt === 0xffffffff) && e >= 20 && has(tail, e - 20, 'PK\x06\x07')) {
      const z = await src.read(u64le(tail, e - 20 + 8), 56);
      if (has(z, 0, 'PK\x06\x06')) {
        total = u64le(z, 32);
        cdSize = u64le(z, 40);
        cdAt = u64le(z, 48);
      }
    }
    const cd = await src.read(cdAt, Math.min(cdSize, 2 * 1024 * 1024));
    let i = 0;
    while (i + 46 <= cd.length && has(cd, i, 'PK\x01\x02') && all.length < WALK_MAX) {
      const flags = u16le(cd, i + 8);
      let size = u32le(cd, i + 24);
      const nl = u16le(cd, i + 28);
      const xl = u16le(cd, i + 30);
      const cl = u16le(cd, i + 32);
      const name = entryName(cd.subarray(i + 46, i + 46 + nl), !!(flags & 0x800));
      if (size === 0xffffffff) {
        // The real size is in the zip64 extra field.
        const x = cd.subarray(i + 46 + nl, i + 46 + nl + xl);
        for (let j = 0; j + 4 <= x.length; j += 4 + u16le(x, j + 2)) if (u16le(x, j) === 1 && j + 12 <= x.length) size = u64le(x, j + 4);
      }
      all.push(name);
      if (names.length < LIST_MAX) names.push({ name, size, ...(name.endsWith('/') ? { dir: true } : {}) });
      i += 46 + nl + xl + cl;
    }
    if (all.length < total) partial = true;
  } else {
    // No directory (cut short): walk the entries from the front while their sizes are known.
    partial = true;
    let at = 0;
    while (all.length < WALK_MAX && at + 30 <= src.size) {
      const h = await src.read(at, 30 + 1024);
      if (!has(h, 0, 'PK\x03\x04')) break;
      const flags = u16le(h, 6);
      const csize = u32le(h, 18);
      const size = u32le(h, 22);
      const nl = u16le(h, 26);
      const xl = u16le(h, 28);
      const name = entryName(h.subarray(30, 30 + nl), !!(flags & 0x800));
      all.push(name);
      if (names.length < LIST_MAX) names.push({ name, size, ...(name.endsWith('/') ? { dir: true } : {}) });
      if (flags & 8) break; // sizes come after the data
      at += 30 + nl + xl + csize;
    }
    total = all.length;
  }
  let mime = 'application/zip';
  let kind: P.FileKind = 'archive';
  const set = new Set(all);
  const any = (prefix: string) => all.some((n) => n.startsWith(prefix));
  if (set.has('[Content_Types].xml')) {
    kind = 'binary';
    if (any('word/')) mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (any('xl/')) mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (any('ppt/')) mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    else kind = 'archive';
  } else if (has(head, 30, 'mimetype') && u16le(head, 26) === 8 && u16le(head, 8) === 0) {
    // OpenDocument and EPUB: an uncompressed first entry holding the type.
    const len = u32le(head, 18);
    const m = ascii(head, 38 + u16le(head, 28), 38 + u16le(head, 28) + Math.min(len, 100)).trim();
    if (plainType(m)) {
      mime = m;
      kind = 'binary';
    }
  } else if (set.has('AndroidManifest.xml') && set.has('classes.dex')) mime = 'application/vnd.android.package-archive';
  else if (set.has('META-INF/MANIFEST.MF') && (ext === 'jar' || all.some((n) => n.endsWith('.class')))) mime = 'application/java-archive';
  return { mime, kind, entries: total, list: names, ...(partial ? { partial: true } : {}) };
}

/** Reads through a window, so walking many small headers in a row is a few reads, not one each. */
function windowed(src: Source, win = 256 * 1024): Source & { reads: number } {
  let base = -1;
  let buf: Uint8Array = new Uint8Array(0);
  const w = {
    size: src.size,
    reads: 0,
    async read(at: number, len: number) {
      if (len > win) return src.read(at, len);
      if (base < 0 || at < base || at + len > base + buf.length) {
        base = at;
        buf = await src.read(at, win);
        w.reads++;
      }
      return buf.subarray(at - base, at - base + len);
    },
  };
  return w;
}

const octal = (b: Uint8Array, from: number, len: number) => {
  // GNU base-256 for sizes past 8 GiB.
  if (b[from] & 0x80) {
    let v = b[from] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + b[from + i];
    return v;
  }
  const s = ascii(b, from, from + len).replace(/\0.*$/, '').trim();
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : NaN;
};

/** A tar's entries, header by header; `size` is how much of it there is. */
async function tar(src: Source, size: number): Promise<{ entries: number; list: P.ArchiveEntry[]; partial?: boolean }> {
  const list: P.ArchiveEntry[] = [];
  let entries = 0;
  let at = 0;
  let longName: string | null = null;
  let ended = false;
  while (entries < WALK_MAX && at + 512 <= size) {
    const h = await src.read(at, 512);
    if (h.length < 512) break;
    if (h.every((c) => c === 0)) {
      ended = true;
      break;
    }
    // The checksum, so a run into junk stops instead of listing it.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (octal(h, 148, 8) !== sum) break;
    const len = octal(h, 124, 12);
    if (!Number.isFinite(len) || len < 0) break;
    const type = String.fromCharCode(h[156] || 48);
    const field = (from: number, len: number) => {
      const f = h.subarray(from, from + len);
      const nul = f.indexOf(0);
      return new TextDecoder().decode(nul === -1 ? f : f.subarray(0, nul));
    };
    let name = field(0, 100);
    if (has(h, 257, 'ustar')) {
      const prefix = field(345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const data = at + 512;
    if (type === 'L' || type === 'x') {
      // GNU long name, or a pax header that may carry path=
      const body = new TextDecoder().decode(await src.read(data, Math.min(len, 8192)));
      if (type === 'L') longName = body.replace(/\0.*$/s, '');
      else longName = body.match(/(?:^|\n)\d+ path=([^\n]*)\n/)?.[1] ?? longName;
    } else if (type !== 'g') {
      const shown = cleanName(longName ?? name);
      longName = null;
      entries++;
      if (list.length < LIST_MAX) list.push({ name: shown, size: type === '5' ? 0 : len, ...(type === '5' || shown.endsWith('/') ? { dir: true } : {}) });
    }
    at = data + Math.ceil(len / 512) * 512;
  }
  // No end marker: cut short, or more entries than were walked.
  return { entries, list, ...(ended ? {} : { partial: true }) };
}

/** Up to `maxOut` bytes out of a gzip; complete when the whole stream was read and ended cleanly. */
export async function gunzipHead(src: Source, maxOut = INFLATE_MAX): Promise<{ out: Uint8Array; complete: boolean }> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let stop = false;
  const CHUNK = 256 * 1024;
  const pump = (async () => {
    for (let at = 0; at < src.size && !stop; at += CHUNK) await writer.write(new Uint8Array(await src.read(at, CHUNK)));
    if (!stop) await writer.close();
  })().catch(() => {});
  const parts: Uint8Array[] = [];
  let n = 0;
  let complete = false;
  try {
    while (n < maxOut) {
      const r = await reader.read();
      if (r.done) {
        complete = true;
        break;
      }
      parts.push(r.value);
      n += r.value.length;
    }
  } catch {
    // Cut short or not gzip after all: what came out so far.
  }
  stop = true;
  await reader.cancel().catch(() => {});
  await writer.abort().catch(() => {});
  await pump;
  const out = new Uint8Array(Math.min(n, maxOut));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    out.set(p.subarray(0, out.length - at), at);
    at += p.length;
  }
  return { out, complete: complete && n <= maxOut };
}

async function gzip(src: Source, b: Uint8Array, name: string | null | undefined): Promise<Partial_> {
  const flags = b[3];
  let i = 10;
  if (flags & 4) i += 2 + u16le(b, 10);
  let inner = '';
  if (flags & 8) {
    const end = b.indexOf(0, i);
    if (end > i) inner = cleanName(latin1.decode(b.subarray(i, Math.min(end, i + 1024))));
  }
  if (!inner) inner = cleanName(name).replace(/\.t?gz$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : '')) || 'file';
  const isize = src.size >= 18 ? u32le(await src.read(src.size - 4, 4), 0) : 0;
  const { out, complete } = await gunzipHead(src);
  if (out.length >= 263 && has(out, 257, 'ustar')) {
    const t = await tar(bytesSource(out), out.length);
    return { mime: 'application/gzip', kind: 'archive', entries: t.entries, list: t.list, ...(t.partial || !complete ? { partial: true } : {}) };
  }
  return { mime: 'application/gzip', kind: 'archive', entries: 1, list: [{ name: inner, size: complete ? out.length : isize }] };
}
