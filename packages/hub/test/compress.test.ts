import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compress, PackedFiles, pickEncoding } from '../src/compress.ts';

const req = (enc: string | null, method = 'GET') => new Request('http://hub/api/bootstrap', { method, headers: enc ? { 'accept-encoding': enc } : {} });
const big = { items: Array.from({ length: 2000 }, (_, i) => ({ id: `cnv_${i}`, name: 'general' })) };

test('zstd first, then gzip, never what the client refused', () => {
  expect(pickEncoding('gzip, deflate, br, zstd')).toBe('zstd');
  expect(pickEncoding('gzip, deflate, br')).toBe('gzip');
  expect(pickEncoding('zstd;q=0, gzip')).toBe('gzip');
  expect(pickEncoding('identity')).toBeNull();
  expect(pickEncoding(null)).toBeNull();
});

test('large JSON is compressed and comes back intact', async () => {
  for (const enc of ['zstd', 'gzip'] as const) {
    const res = (await compress(req(enc), Response.json(big)))!;
    expect(res.headers.get('content-encoding')).toBe(enc);
    expect(res.headers.get('vary')).toContain('accept-encoding');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const raw = enc === 'zstd' ? Bun.zstdDecompressSync(bytes) : Bun.gunzipSync(bytes);
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual(big);
    expect(bytes.length).toBeLessThan(JSON.stringify(big).length / 5);
  }
});

test('small, binary, failed and upgraded responses pass through', async () => {
  expect((await compress(req('gzip'), Response.json({ ok: true })))!.headers.get('content-encoding')).toBeNull();
  const png = new Response(new Uint8Array(4096), { headers: { 'content-type': 'image/png' } });
  expect(await compress(req('gzip'), png)).toBe(png);
  const err = Response.json(big, { status: 500 });
  expect(await compress(req('gzip'), err)).toBe(err);
  expect(await compress(req('gzip'), undefined)).toBeUndefined();
  const plain = Response.json(big);
  expect(await compress(req(null), plain)).toBe(plain);
});

test('an event stream passes through unread: it never ends', async () => {
  const sse = new Response(new ReadableStream<Uint8Array>({}), { headers: { 'content-type': 'text/event-stream' } });
  // Resolves at once with the same response: nothing waited for a body that never ends.
  expect(await compress(req('gzip, zstd'), sse)).toBe(sse);
  expect(sse.bodyUsed).toBe(false);
});

test('the web build is packed once, hard, and a changed file is never answered with its old bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-packed-'));
  try {
    mkdirSync(join(dir, 'assets'));
    // Script-like text with some repetition, as a bundle has: level 19 finds more of it than level 3.
    const words = Array.from({ length: 400 }, (_, i) => `function f${i}(a,b){return a.${['map', 'filter', 'reduce'][i % 3]}((x)=>x+b*${i})}`);
    const js = Array.from({ length: 3000 }, (_, i) => words[(i * 7919) % words.length]).join(';\n');
    writeFileSync(join(dir, 'assets', 'app-1.js'), js);
    writeFileSync(join(dir, 'index.html'), '<script src="/assets/app-1.js"></script>');
    writeFileSync(join(dir, 'tiny.css'), 'a{}');
    const packed = new PackedFiles();
    await packed.packAll(dir);
    const file = join(dir, 'assets', 'app-1.js');
    const st = statSync(file);
    const body = packed.get(file, st.size, st.mtimeMs)!;
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(body))).toBe(js);
    expect(body.byteLength).toBeLessThan(Bun.zstdCompressSync(Buffer.from(js), { level: 3 }).byteLength);
    // Under a kilobyte: not worth packing, as compress() leaves it.
    const tiny = statSync(join(dir, 'tiny.css'));
    expect(packed.get(join(dir, 'tiny.css'), tiny.size, tiny.mtimeMs)).toBeNull();
    expect(packed.stats().files).toBe(1);

    // Rewritten (a new build in the same place): its old bytes are not served, and it is packed again for the next ask.
    writeFileSync(file, js + ';\nf1(1,2)');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const st2 = statSync(file);
    expect(packed.get(file, st2.size, st2.mtimeMs)).toBeNull();
    await packed.idle();
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(packed.get(file, st2.size, st2.mtimeMs)!))).toBe(js + ';\nf1(1,2)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files queued after the packer ran dry are packed: none is left queued with nothing to pack it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-packed-dry-'));
  try {
    const text = (n: number) => Array.from({ length: 200 }, (_, i) => `.c${(i * n) % 97}{margin:${i}px}`).join('\n');
    // Small files first (under a kilobyte, nothing to pack: the packer runs through them without waiting), then big ones.
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `a${i}.css`), 'a{}');
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `b${i}.css`), text(i + 1));
    const packed = new PackedFiles();
    await packed.packAll(dir);
    expect(packed.stats().files).toBe(3);
    // Then one at a time, each asked for after the last was packed, as files are asked for once the hub is running.
    for (let i = 0; i < 3; i++) {
      const f = join(dir, `c${i}.css`);
      writeFileSync(f, text(i + 7));
      const st = statSync(f);
      expect(packed.get(f, st.size, st.mtimeMs)).toBeNull();
      await packed.idle();
      expect(packed.get(f, st.size, st.mtimeMs)).not.toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
