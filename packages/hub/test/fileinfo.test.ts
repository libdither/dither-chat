/**
 * What a kept file is, by its bytes (fileinfo.ts, mediainfo.ts, docs/files.md): types a network got wrong, files cut
 * short, hostile names, bounded reads, the walk over attachments, and how the hub serves a file once it knows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { analyze, bytesSource, gunzipHead, HEAD, LIST_MAX, textEncoding, TEXT_MAX, type Source } from '../src/fileinfo.ts';
import { infoFor, mediaKey, MediaInfo } from '../src/mediainfo.ts';
import { storedZip } from '../src/demo.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[] | string)[]) => new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p as Uint8Array)))));
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const of = (b: Uint8Array, name?: string | null, mime?: string | null) => analyze(bytesSource(b), { name, mime });

// ------------------------------------------------------------------ builders

const png = (w: number, h: number) => cat([0x89], 'PNG\r\n\x1a\n', u32be(13), 'IHDR', u32be(w), u32be(h), [8, 2, 0, 0, 0], u32be(0), u32be(0), 'IEND', u32be(0));
const gif = (w: number, h: number) => cat('GIF89a', u16le(w), u16le(h), [0, 0, 0], ';');
const bmp = (w: number, h: number) => cat('BM', u32le(54), u32le(0), u32le(54), u32le(40), u32le(w), u32le(-h >>> 0), u16le(1), u16le(24), new Array(24).fill(0));
const webp = (w: number, h: number) => cat('RIFF', u32le(30), 'WEBPVP8X', u32le(10), [0, 0, 0, 0], [(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, 0], [(h - 1) & 0xff, ((h - 1) >> 8) & 0xff, 0]);
/** A JPEG whose frame header comes after 80 KB of metadata, past the first read. */
const jpeg = (w: number, h: number) => {
  const app = (n: number) => cat([0xff, 0xe1], u16be(n + 2), new Uint8Array(n));
  return cat([0xff, 0xd8], app(40000), app(40000), [0xff, 0xc0], u16be(17), [8], u16be(h), u16be(w), [3], new Array(9).fill(0), [0xff, 0xd9]);
};

const box = (type: string, ...payload: (Uint8Array | number[] | string)[]) => {
  const body = cat(...payload);
  return cat(u32be(8 + body.length), type, body);
};
/** An MP4 with the movie header at the end, after the media, as a phone writes one. */
const mp4 = (seconds: number, w: number, h: number, audioOnly = false) => {
  const mvhd = box('mvhd', [0, 0, 0, 0], u32be(0), u32be(0), u32be(1000), u32be(seconds * 1000), new Array(80).fill(0));
  const tkhd = (tw: number, th: number) => box('tkhd', [0, 0, 0, 3], new Array(20).fill(0), new Array(52).fill(0), u32be(tw * 65536), u32be(th * 65536));
  const traks = audioOnly ? [box('trak', tkhd(0, 0))] : [box('trak', tkhd(0, 0)), box('trak', tkhd(w, h))];
  return cat(box('ftyp', 'isom', u32be(512), 'isomiso2mp41'), box('mdat', new Uint8Array(100_000)), box('moov', mvhd, ...traks));
};

const ebml = (id: number[], ...payload: (Uint8Array | number[] | string)[]) => {
  const body = cat(...payload);
  const size = body.length < 127 ? [0x80 | body.length] : [0x40 | (body.length >> 8), body.length & 0xff];
  return cat(id, size, body);
};
const webm = (seconds: number, w: number, h: number) => {
  const dur = Buffer.alloc(8);
  dur.writeDoubleBE(seconds * 1000);
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], 'webm'));
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ebml([0x44, 0x89], dur));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], ebml([0x83], [1]), ebml([0xe0], ebml([0xb0], u16be(w)), ebml([0xba], u16be(h)))));
  // A segment of unknown size, as a recorder writes it.
  return cat(header, [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], info, tracks, ebml([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(50)));
};

const wav = (seconds: number, rate = 8000) => {
  const data = rate * 2 * seconds;
  return cat('RIFF', u32le(36 + data), 'WAVE', 'fmt ', u32le(16), u16le(1), u16le(1), u32le(rate), u32le(rate * 2), u16le(2), u16le(16), 'data', u32le(data), new Uint8Array(data));
};
const flac = (seconds: number, rate = 44100) => {
  const bits = (BigInt(rate) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(rate * seconds);
  const packed = Array.from({ length: 8 }, (_, i) => Number((bits >> BigInt(8 * (7 - i))) & 0xffn));
  return cat('fLaC', [0x80, 0, 0, 34], u16be(4096), u16be(4096), [0, 0, 0, 0, 0, 0], packed, new Uint8Array(16));
};
const mp3 = (frames: number) => cat('ID3', [4, 0, 0], [0, 0, 0, 10], new Uint8Array(10), [0xff, 0xfb, 0x90, 0x64], new Uint8Array(32), 'Xing', u32be(1), u32be(frames), new Uint8Array(400));
const oggPage = (granule: number, serial: number, data: Uint8Array) => {
  const g = Buffer.alloc(8);
  g.writeBigUInt64LE(BigInt(granule));
  return cat('OggS', [0, 0], g, u32le(serial), u32le(0), u32le(0), [1, data.length], data);
};
const opus = (seconds: number) => {
  const head = cat('OpusHead', [1, 2], u16le(312), u32le(48000), [0, 0, 0]);
  return cat(oggPage(0, 7, head), oggPage(0, 7, cat('OpusTags', new Uint8Array(8))), new Uint8Array(3000), oggPage(48000 * seconds + 312, 7, new Uint8Array(40)));
};

/** A ustar archive; entries over 100 bytes of name get a GNU long-name entry first. */
function tar(entries: [name: string, body: string, dir?: boolean][], end = true): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = new Uint8Array(512);
    h.set(enc(name).subarray(0, 100), 0);
    h.set(enc('0000644\0'), 100);
    h.set(enc('0000000\0'), 108);
    h.set(enc('0000000\0'), 116);
    h.set(enc(size.toString(8).padStart(11, '0') + '\0'), 124);
    h.set(enc('00000000000\0'), 136);
    h.set(enc('        '), 148);
    h[156] = type.charCodeAt(0);
    h.set(enc('ustar\0'), 257);
    h.set(enc('00'), 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.set(enc(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    return h;
  };
  const pad = (b: Uint8Array) => cat(b, new Uint8Array((512 - (b.length % 512)) % 512));
  for (const [name, body, dir] of entries) {
    if (enc(name).length > 100) blocks.push(header('././@LongLink', enc(name).length + 1, 'L'), pad(cat(enc(name), [0])));
    blocks.push(header(name, dir ? 0 : enc(body).length, dir ? '5' : '0'));
    if (!dir) blocks.push(pad(enc(body)));
  }
  if (end) blocks.push(new Uint8Array(1024));
  return cat(...blocks);
}

/** A PDF whose page tree has `pages` pages. */
function pdf(pages: number, opts: { compressed?: boolean; linearized?: number } = {}): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const tree = `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`;
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  if (opts.linearized) out += `1 0 obj\n<< /Linearized 1 /L 9999 /H [ 600 200 ] /O 3 /E 900 /N ${opts.linearized} /T 9000 >>\nendobj\n`;
  out += `2 0 obj\n<< /Type /Catalog /Pages 9 0 R >>\nendobj\n`;
  for (let i = 0; i < pages; i++) out += `${i + 3} 0 obj\n<< /Type /Page /Parent 9 0 R /MediaBox [0 0 612 792] >>\nendobj\n`;
  if (!opts.compressed) return cat(out, `9 0 obj\n${tree}\nendobj\ntrailer\n<< /Root 2 0 R >>\n%%EOF\n`);
  const z = deflateSync(Buffer.from(`9 0 ${tree}`));
  return cat(out, `20 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, z, '\nendstream\nendobj\n%%EOF\n');
}

/** Counts what a source hands out, to show reads stay bounded. */
function counted(b: Uint8Array): Source & { bytes: number } {
  const s = { size: b.length, bytes: 0, read: async (at: number, len: number) => {
    const out = b.subarray(at, Math.min(b.length, at + len));
    s.bytes += out.length;
    return out;
  } };
  return s;
}

// ------------------------------------------------------------------ the sniffer

describe('the type comes from the bytes, not the network', () => {
  test('a PDF the network calls a PNG', async () => {
    const i = await of(pdf(3), 'scan.png', 'image/png');
    expect(i).toMatchObject({ mime: 'application/pdf', kind: 'pdf', pages: 3 });
  });
  test('a PNG called notes.txt and sent as text/plain', async () => {
    expect(await of(png(640, 480), 'notes.txt', 'text/plain')).toMatchObject({ mime: 'image/png', kind: 'image', width: 640, height: 480 });
  });
  test('Markdown and JSON sent as application/octet-stream', async () => {
    expect(await of(enc('# Notes\n\n- one\n- two\n'), 'notes.md', 'application/octet-stream')).toMatchObject({ mime: 'text/markdown', kind: 'markdown', lines: 4, encoding: 'utf-8' });
    // No name either: valid JSON says so itself.
    expect(await of(enc('{"a": [1, 2, {"b": null}]}'), null, 'application/octet-stream')).toMatchObject({ mime: 'application/json', kind: 'json', language: 'json' });
  });
  test("a Rust file that Discord calls application/rls-services+xml", async () => {
    expect(await of(enc('fn main() {\n    println!("hi");\n}\n'), 'main.rs', 'application/rls-services+xml')).toMatchObject({ mime: 'text/rust', kind: 'text', language: 'rust', lines: 3 });
  });
  test('HTML and SVG are text whatever they are called, and never anything a browser would render', async () => {
    expect(await of(enc('<!DOCTYPE html><html><script>alert(1)</script></html>'), 'readme.txt', 'text/plain')).toMatchObject({ mime: 'text/html', kind: 'text', language: 'html' });
    expect(await of(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'), 'logo.png', 'image/png')).toMatchObject({ mime: 'image/svg+xml', kind: 'text' });
    expect(await of(enc('<?xml version="1.0"?><feed/>'), 'feed', null)).toMatchObject({ mime: 'application/xml', kind: 'text', language: 'xml' });
  });
  test('a .json file that is not JSON is shown as text', async () => {
    expect(await of(enc('{"a": '), 'broken.json')).toMatchObject({ kind: 'text', language: 'json' });
  });
  test('CSV by name or type; a script by its #! line; Markdown by its marks', async () => {
    expect(await of(enc('a,b\n1,2\n'), 'data.csv')).toMatchObject({ kind: 'csv', mime: 'text/csv' });
    expect(await of(enc('a\tb\n1\t2\n'), 'export', 'text/tab-separated-values')).toMatchObject({ kind: 'csv', language: 'tsv' });
    expect(await of(enc('#!/usr/bin/env python3\nprint(1)\n'), 'run')).toMatchObject({ kind: 'text', language: 'python' });
    expect(await of(enc('# Title\n\nSee [the docs](https://example.org).\n\n```\ncode\n```\n'), 'README')).toMatchObject({ kind: 'markdown' });
    expect(await of(enc('just some words\non two lines\n'), 'README')).toMatchObject({ kind: 'text', mime: 'text/plain', lines: 2 });
  });
  test('encodings: UTF-16 with and without a byte-order mark, and an 8-bit code page', async () => {
    const le = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\nworld\n', 'utf16le')]));
    expect(await of(le, 'a.txt')).toMatchObject({ kind: 'text', encoding: 'utf-16le', lines: 2 });
    expect(textEncoding(new Uint8Array(Buffer.from('plain ascii here', 'utf16le')))).toBe('utf-16le');
    expect(await of(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]), 'menu.txt')).toMatchObject({ kind: 'text', encoding: 'windows-1252' });
    // A multi-byte character cut by the end of the first read is still UTF-8.
    const long = enc('é'.repeat(HEAD / 2 + 1));
    expect(textEncoding(long.subarray(0, HEAD - 1))).toBe('utf-8');
  });
  test('binary nobody knows keeps a specific network type, else octet-stream', async () => {
    const junk = new Uint8Array(4096).map((_, i) => (i * 7919) & 0xff);
    expect(await of(junk, 'x.bin', 'application/x-thing')).toMatchObject({ mime: 'application/x-thing', kind: 'binary' });
    expect(await of(junk, 'x.bin', 'text/plain')).toMatchObject({ mime: 'application/octet-stream', kind: 'binary' });
    expect(await of(cat('\x7fELF', new Uint8Array(60)), 'run.txt', 'text/plain')).toMatchObject({ mime: 'application/x-executable', kind: 'binary' });
  });
  test('an empty file is empty text', async () => {
    expect(await of(new Uint8Array(0), 'empty.txt')).toMatchObject({ kind: 'text', lines: 0, size: 0 });
  });
});

describe('structure', () => {
  test('image sizes', async () => {
    expect(await of(gif(32, 16))).toMatchObject({ mime: 'image/gif', width: 32, height: 16 });
    expect(await of(bmp(100, 50))).toMatchObject({ mime: 'image/bmp', width: 100, height: 50 });
    expect(await of(webp(1878, 983))).toMatchObject({ mime: 'image/webp', width: 1878, height: 983 });
    expect(await of(jpeg(1200, 800))).toMatchObject({ mime: 'image/jpeg', width: 1200, height: 800 });
  });
  test('PDF pages: from the page tree, a compressed object stream, or a linearized header', async () => {
    expect((await of(pdf(12))).pages).toBe(12);
    expect((await of(pdf(7, { compressed: true }))).pages).toBe(7);
    expect((await of(pdf(2, { linearized: 40 }))).pages).toBe(40);
  });
  test('audio and video length, and a video frame size', async () => {
    expect(await of(mp4(12, 640, 360))).toMatchObject({ mime: 'video/mp4', kind: 'video', duration: 12, width: 640, height: 360 });
    expect(await of(mp4(30, 0, 0, true))).toMatchObject({ mime: 'audio/mp4', kind: 'audio', duration: 30 });
    expect(await of(webm(5, 320, 240))).toMatchObject({ mime: 'video/webm', kind: 'video', duration: 5, width: 320, height: 240 });
    expect(await of(wav(2))).toMatchObject({ mime: 'audio/wav', kind: 'audio', duration: 2 });
    expect(await of(flac(3))).toMatchObject({ mime: 'audio/flac', duration: 3 });
    expect((await of(mp3(100))).duration).toBeCloseTo((100 * 1152) / 44100, 3);
    expect(await of(opus(3))).toMatchObject({ mime: 'audio/ogg', kind: 'audio', duration: 3 });
  });
  test('a ZIP: its entries from the central directory, and what is built on ZIP', async () => {
    const z = storedZip([['src/', ''], ['src/main.rs', 'fn main() {}'], ['README.md', '# hi']]);
    expect(await of(z, 'code.zip')).toMatchObject({ mime: 'application/zip', kind: 'archive', entries: 3, list: [{ name: 'src/', size: 0, dir: true }, { name: 'src/main.rs', size: 12 }, { name: 'README.md', size: 4 }] });
    const xlsx = storedZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook/>']]);
    expect(await of(xlsx, 'budget.xlsx', 'application/octet-stream')).toMatchObject({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'binary' });
    const epub = storedZip([['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<container/>']]);
    expect(await of(epub, 'book.epub')).toMatchObject({ mime: 'application/epub+zip', kind: 'binary' });
  });
  test('a ZIP with more entries than the list keeps', async () => {
    const z = storedZip(Array.from({ length: 120 }, (_, i) => [`f${i}.txt`, 'x'] as [string, string]));
    const i = await of(z);
    expect(i.entries).toBe(120);
    expect(i.list).toHaveLength(LIST_MAX);
  });
  test('tar, tar.gz and a single gzipped file', async () => {
    const long = `deep/${'d'.repeat(120)}/file.txt`;
    const t = tar([['pkg/', '', true], ['pkg/a.txt', 'hello'], [long, 'x']]);
    expect(await of(t, 'pkg.tar')).toMatchObject({ mime: 'application/x-tar', kind: 'archive', entries: 3, list: [{ name: 'pkg/', dir: true }, { name: 'pkg/a.txt', size: 5 }, { name: long, size: 1 }] });
    expect(await of(new Uint8Array(Bun.gzipSync(t)), 'pkg.tar.gz')).toMatchObject({ mime: 'application/gzip', kind: 'archive', entries: 3 });
    expect(await of(new Uint8Array(Bun.gzipSync(enc('a'.repeat(5000)))), 'log.txt.gz')).toMatchObject({ kind: 'archive', entries: 1, list: [{ name: 'log.txt', size: 5000 }] });
  });
});

describe('files cut short', () => {
  test('nothing throws, and what can still be read is', async () => {
    expect(await of(png(10, 10).subarray(0, 12))).toMatchObject({ mime: 'image/png', kind: 'image' });
    expect((await of(png(10, 10).subarray(0, 12))).width).toBeUndefined();
    expect(await of(jpeg(10, 10).subarray(0, 50000))).toMatchObject({ mime: 'image/jpeg' });
    expect(await of(gif(1, 1).subarray(0, 7))).toMatchObject({ mime: 'image/gif' });
    expect(await of(mp4(3, 10, 10).subarray(0, 2000))).toMatchObject({ mime: 'video/mp4', kind: 'video' });
    expect(await of(webm(3, 10, 10).subarray(0, 30))).toMatchObject({ kind: 'video' });
    expect((await of(wav(2).subarray(0, 8044))).duration).toBeCloseTo(0.5, 2);
    expect(await of(opus(2).subarray(0, 60))).toMatchObject({ mime: 'audio/ogg' });
    expect(await of(pdf(4).subarray(0, 60))).toMatchObject({ mime: 'application/pdf', kind: 'pdf' });
  });
  test('a ZIP without its directory: the entries before the cut, marked partial', async () => {
    const z = storedZip([['a.txt', 'aaa'], ['b.txt', 'bbbb'], ['c.txt', 'cc']]);
    const i = await of(z.subarray(0, 75));
    expect(i).toMatchObject({ kind: 'archive', partial: true });
    expect(i.list!.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
  });
  test('a tar cut in the middle, and a gzip cut short', async () => {
    const t = tar([['a', 'x'.repeat(2000)], ['b', 'y']]);
    expect(await of(t.subarray(0, 1500), 'x.tar')).toMatchObject({ kind: 'archive', entries: 1, partial: true });
    const gz = new Uint8Array(Bun.gzipSync(t));
    const cut = await of(gz.subarray(0, gz.length - 30), 'x.tar.gz');
    expect(cut.kind).toBe('archive');
    expect(cut.partial).toBe(true);
  });
});

describe('hostile names', () => {
  test("a direction override can't make a name end in another extension", async () => {
    // Shown, "invoice<RLO>fdp.exe" reads as invoiceexe.pdf; the bytes are text, and stay text.
    expect(await of(enc('hello\n'), 'invoice\u202efdp.exe', 'application/pdf')).toMatchObject({ kind: 'text', mime: 'text/plain' });
    expect(await of(enc('just words\n'), 'song\u202e3pm.txt', 'audio/mpeg')).toMatchObject({ kind: 'text', mime: 'text/plain' });
  });
  test('paths, dots, control characters and absurd lengths are only names', async () => {
    expect(await of(enc('# Up\n\n- a\n- b\n'), '../../etc/passwd.md')).toMatchObject({ kind: 'markdown' });
    expect(await of(enc('x\n'), '.md')).toMatchObject({ kind: 'text', mime: 'text/plain' });
    expect(await of(enc('x\n'), 'a\u0000.md\u0007')).toMatchObject({ kind: 'markdown' });
    expect(await of(enc('x\n'), `${'a'.repeat(5000)}.md`)).toMatchObject({ kind: 'text' });
  });
  test('entry names inside an archive are cleaned of control and direction characters', async () => {
    const z = storedZip([['evil\u202egnp.exe', 'x'], ['../../etc/passwd', 'y'], ['a\u0007b\u001bc', 'z'], ['x'.repeat(400), 'w']]);
    const names = (await of(z)).list!.map((e) => e.name);
    expect(names.slice(0, 3)).toEqual(['evilgnp.exe', '../../etc/passwd', 'abc']);
    expect(names[3].length).toBe(200);
  });
});

describe('reads are bounded', () => {
  test('a big text file: the first part only, counted as partial', async () => {
    const big = enc('line of text that goes on a bit\n'.repeat(400_000));
    const src = counted(big);
    const i = await analyze(src, { name: 'big.log' });
    expect(i).toMatchObject({ kind: 'text', partial: true, size: big.length });
    expect(i.lines).toBe(TEXT_MAX / 32);
    expect(src.bytes).toBeLessThanOrEqual(HEAD + TEXT_MAX);
  });
  test('a gzip bomb stops at the cap', async () => {
    const bomb = new Uint8Array(Bun.gzipSync(new Uint8Array(96 * 1024 * 1024)));
    const i = await of(bomb, 'zeros.bin.gz');
    expect(i).toMatchObject({ kind: 'archive', entries: 1, list: [{ name: 'zeros.bin', size: 96 * 1024 * 1024 }] });
    // 8 MiB out, not 96: counted, not timed.
    const head = await gunzipHead(bytesSource(bomb));
    expect(head.complete).toBe(false);
    expect(head.out.length).toBe(8 * 1024 * 1024);
  });
  test('a big PDF is read at its two ends only', async () => {
    const body = pdf(5);
    const big = cat(body.subarray(0, 20), new Uint8Array(12 * 1024 * 1024), body.subarray(20));
    const src = counted(big);
    expect((await analyze(src)).pages).toBe(5);
    expect(src.bytes).toBeLessThan(6 * 1024 * 1024);
  });
});

// ------------------------------------------------------------------ the walk and the hub

describe('looking at every kept file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-fileinfo-'));
  let store: Store;
  let acc: AccountRow;
  const cache = join(dir, 'media-cache');
  const remote = 'https://cdn.example.org/attachments/1/bench.json';
  const missing = 'https://cdn.example.org/attachments/2/gone.zip';
  const local = join(dir, 'imports', 'notes.md');

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    acc = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
    store.ingest(acc, { t: 'hello', network: 'discord', version: '1', capabilities: [] });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c1', shape: 'group', name: 'files' } });
    mkdirSync(cache, { recursive: true });
    mkdirSync(join(dir, 'imports'), { recursive: true });
    writeFileSync(join(cache, mediaKey(remote)), '{"ok": true}');
    writeFileSync(join(cache, mediaKey(remote)) + '.mime', 'application/octet-stream');
    writeFileSync(local, '# Notes\n\n- one\n- two\n');
    store.ingest(acc, {
      t: 'message',
      message: {
        nativeId: 'm1',
        conversation: 'c1',
        author: 'u1',
        ts: Date.now() - 1000,
        body: 'files',
        attachments: [
          { kind: 'file', mime: 'application/octet-stream', name: 'bench.json', url: remote },
          { kind: 'file', mime: 'application/zip', name: 'gone.zip', url: missing },
          { kind: 'file', name: 'notes.md', url: `file://${local}` },
          { kind: 'image', mime: 'image/png', name: 'inline.png', url: 'data:image/png;base64,iVBORw0KGgo=' },
        ],
      },
    });
    store.flush();
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a hub that archives waits for the archive', async () => {
    const mi = new MediaInfo(store, dir, { behindArchive: true });
    await mi.tick();
    expect(mi.looked).toBe(0);
  });

  test('the walk looks at what is on disk, skips the rest, and the message carries what it found', async () => {
    const mi = new MediaInfo(store, dir, { behindArchive: false });
    await mi.tick();
    expect(mi.looked).toBe(2);
    const found = infoFor(store.db, [remote, missing, `file://${local}`]);
    expect(found.get(remote)).toMatchObject({ mime: 'application/json', kind: 'json', size: 12 });
    expect(found.get(`file://${local}`)).toMatchObject({ kind: 'markdown', lines: 4 });
    expect(found.has(missing)).toBe(false);
    const [m] = store.messageViews(store.db.query(`SELECT * FROM message`).all() as any[]);
    expect(m.attachments.map((a) => a.info?.kind ?? null)).toEqual(['json', null, 'markdown', null]);
    // A recent message is sent again to the apps, with what was found.
    expect(store.flush().some((e) => e.t === 'message')).toBe(true);
  });

  test('a restart carries on from the cursor and looks at nothing twice', async () => {
    const mi = new MediaInfo(store, dir, { behindArchive: false });
    await mi.tick();
    expect(mi.looked).toBe(0);
  });

  test('a file the archive keeps later is looked at then', async () => {
    writeFileSync(join(cache, mediaKey(missing)), storedZip([['a.txt', 'a']]));
    const mi = new MediaInfo(store, dir, { behindArchive: false });
    const m = store.db.query('SELECT message_id FROM attachment WHERE url = ?').get(missing) as { message_id: string };
    await mi.kept({ url: missing, name: 'gone.zip', mime: 'application/zip', messageId: m.message_id });
    expect(infoFor(store.db, [missing]).get(missing)).toMatchObject({ kind: 'archive', entries: 1 });
  });
});

describe('serving and asking for a file once the hub knows what it is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-fileinfo-hub-'));
  const port = 19960 + Math.floor(Math.random() * 30);
  const url = `http://127.0.0.1:${port}`;
  const files: Record<string, { mime: string; bytes: Uint8Array }> = {
    'att:pic': { mime: 'application/octet-stream', bytes: png(4, 3) },
    'att:page': { mime: 'application/octet-stream', bytes: enc('<!doctype html><script>alert(1)</script>') },
    'att:sheet': { mime: 'text/csv', bytes: enc('a,b\n1,2\n') },
  };
  let store: Store;
  let hub: HubServer;
  const ids: Record<string, string> = {};

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = {
      authorize: () => null,
      online: () => true,
      command: async (_a: string, c: any) => (c.t === 'fetchMedia' && files[c.url] ? { mime: files[c.url].mime, base64: Buffer.from(files[c.url].bytes).toString('base64') } : null),
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    hub.start();
    const a = store.createAccount({ network: 'matrix', label: 'mx', color: '#000', adapter: 'matrix' });
    store.ingest(a, { t: 'hello', network: 'matrix', version: '1', capabilities: [] });
    store.ingest(a, { t: 'conversation', conversation: { nativeId: '!r:x.org', shape: 'group', name: 'Room' } });
    store.ingest(a, {
      t: 'message',
      message: { nativeId: '$1', conversation: '!r:x.org', author: '@a:x.org', ts: Date.now(), body: '', attachments: Object.entries(files).map(([u, f]) => ({ kind: 'file' as const, mime: f.mime, name: null as any, url: u })) },
    });
    store.flush();
    for (const r of store.db.query('SELECT id, url FROM attachment').all() as { id: string; url: string }[]) ids[r.url] = r.id;
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET /api/attachments/:id/info fetches the file, looks at it and says what it is', async () => {
    const r = await fetch(`${url}/api/attachments/${ids['att:pic']}/info`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ mime: 'image/png', kind: 'image', width: 4, height: 3 });
    expect((await fetch(`${url}/api/attachments/att_nope/info`)).status).toBe(404);
  });

  test('a file the network called octet-stream is served as what it is, with the same protections', async () => {
    await fetch(`${url}/api/attachments/${ids['att:page']}/info`);
    const media = (u: string) => fetch(url + store.mediaUrl(u, store.accounts()[0].id)!);
    const pic = await media('att:pic');
    expect(pic.headers.get('content-type')).toBe('image/png');
    expect(pic.headers.get('content-disposition')).toBeNull();
    expect(pic.headers.get('x-content-type-options')).toBe('nosniff');
    // HTML is HTML now, and so a download, under the sandbox.
    const page = await media('att:page');
    expect(page.headers.get('content-type')).toBe('text/html');
    expect(page.headers.get('content-disposition')).toStartWith('attachment');
    expect(page.headers.get('content-security-policy')).toStartWith('sandbox;');
    // A network's own specific type stays what it said.
    await fetch(`${url}/api/attachments/${ids['att:sheet']}/info`);
    expect((await media('att:sheet')).headers.get('content-type')).toBe('text/csv');
  });
});
