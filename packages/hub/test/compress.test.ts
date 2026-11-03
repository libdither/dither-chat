import { expect, test } from 'bun:test';
import { compress, pickEncoding } from '../src/compress.ts';

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
