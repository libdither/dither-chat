/**
 * JPEG XL (jxl.ts, jxlformat.ts, docs/files.md "JPEG XL"): telling one by its bytes and reading its size; packing kept
 * JPEGs and PNGs and getting them back as they came; serving a device that shows JPEG XL the packed file and any other
 * the original; and a JPEG XL going out to a network as a JPEG or PNG. The parts that run cjxl and djxl skip on a
 * machine without them (CI installs libjxl-tools).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { analyze, bytesSource } from '../src/fileinfo.ts';
import { pruneMediaCache } from '../src/housekeeping.ts';
import { findJxl, MediaPacker, pack, rebuild, takesJxl, toCommon } from '../src/jxl.ts';
import { isJxl, jxlDims, repackedJpeg } from '../src/jxlformat.ts';
import { sniffMime } from '../src/mediaheaders.ts';
import { mediaKey } from '../src/mediainfo.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { Uploads } from '../src/uploads.ts';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** Made by cjxl from one-colour pictures: bare codestreams, and a JPEG repacked into the container. */
const JXL: Record<string, string> = {
  '64x64': '/wpPQCQIAAEAeABLGIsVAJSIcTfG3QM4gAMDAGEkplHva+w4MrXtzg0=',
  '300x200': '/woxQSQIBAEA6ABLGIsVAJSIcTfG3QM4gGN+VeYXzkzyrAdchy/ndtsnuAhjVJ+evHHXhnjNG5V43B0ZAwZApmTj/+YM',
  '1000x1': '/woAgM4HiAQIAgEAOAAAAEACJEACJABLGIvDoDCFOa4bAIAJAAdwEJI8AI7HdgdwEJI8AI7HdgdwEJI8AI7HdgdwEJI8AI7Hdg==',
  '640x480': '/wr4PhAJCAIBAGwAAADAARzAARzAARwASxgTL4fhYGE0YPDsGDwFYrCjQAy+IBwAgAkAB3DAzcAEAAdwwM3ABAAHcMDNwAQAB3DAzcAEAAdwwM3ABAAHcMDNwAQA',
  '7x5': '/wogQBAJCAABAFwASxiLFQCUiFGMkTyA0zm2fmBWhh6gN90=',
};
const REPACKED_120x80 =
  'AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAARanhscAAAAAD/ChNBJAAAAExqYnJkwG0DCIIgtAwIgFCjQBIAAAAA+X8iAAAAAPhfSQAAAADk/4sAAAAA4H+BHwCoLAALCIDgABBKRklGAAEBAAABAAEAAAMAAADDanhscIAAAAHgWwIQAMACDm4MbA5u/v8OgCgJAIXGxm4AAAAFAADwAwAAAAAAAAAQsCRxirib1wPK5hx+gEKhkKSgoEAiYvAwceJMjDHODHIgU7GRMUZFsYwxyiwmZADp4oQ5fA5QhMMLOofPAc3lEHACiEH7jgwA/FI/o/EClO7gPhpi27Pv2n7A/QbB+gNJqlStqlgL2s8U1FUUhsPs2LADh7kcJ/i5oGrZnThtV1/5g1W+CHATAAAAAABASQI=';

/** An invented picture (a plasma cloud) as a JPEG. */
const JPEG = readFileSync(join(import.meta.dir, 'fixtures', 'plasma.jpg'));

/** A PNG of a noisy gradient, CRCs and all, which a real decoder reads. */
function noisyPng(w: number, h: number): Uint8Array {
  const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([u32(data.length), td, u32(Bun.hash.crc32(td))]);
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 24;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      raw[at] = Math.min(255, (x * 255) / w + rnd());
      raw[at + 1] = Math.min(255, (y * 255) / h + rnd());
      raw[at + 2] = Math.min(255, 128 + rnd());
    }
  }
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]));
}

const pngSize = (b: Uint8Array) => ({ width: Buffer.from(b).readUInt32BE(16), height: Buffer.from(b).readUInt32BE(20) });

describe('a JPEG XL by its bytes', () => {
  test('a bare codestream and the box container are JPEG XL; other pictures are not', () => {
    for (const s of Object.values(JXL)) expect(isJxl(b64(s))).toBe(true);
    expect(isJxl(b64(REPACKED_120x80))).toBe(true);
    expect(isJxl(JPEG)).toBe(false);
    expect(isJxl(noisyPng(4, 4))).toBe(false);
    expect(isJxl(new Uint8Array([0xff]))).toBe(false);
  });

  test('its size, in each way the header writes one: by eighths, by ratio, and in full', () => {
    for (const [s, data] of Object.entries(JXL)) {
      const [width, height] = s.split('x').map(Number);
      expect(jxlDims(b64(data))).toEqual({ width, height });
    }
    expect(jxlDims(b64(REPACKED_120x80))).toEqual({ width: 120, height: 80 });
    expect(jxlDims(b64(JXL['640x480']).subarray(0, 3))).toEqual({});
  });

  test('a JPEG repacked losslessly is told apart from a picture made as JPEG XL', () => {
    expect(repackedJpeg(b64(REPACKED_120x80))).toBe(true);
    expect(repackedJpeg(b64(JXL['300x200']))).toBe(false);
  });

  test('the sniffers call it image/jxl, a picture, with its size', async () => {
    expect(await analyze(bytesSource(b64(JXL['300x200'])), { mime: 'application/octet-stream', name: 'x.bin' })).toMatchObject({ mime: 'image/jxl', kind: 'image', width: 300, height: 200 });
    expect(sniffMime(b64(REPACKED_120x80))).toBe('image/jxl');
  });
});

describe('which devices are sent JPEG XL', () => {
  const req = (h: Record<string, string>) => new Request('http://hub/media/x/y', { headers: h });
  test("the app's cookie, or image/jxl in the Accept header", () => {
    expect(takesJxl(req({ cookie: 'a=b; dither_jxl=1' }))).toBe(true);
    expect(takesJxl(req({ cookie: 'dither_jxl=1' }))).toBe(true);
    expect(takesJxl(req({ accept: 'image/jxl,image/avif,image/webp,*/*;q=0.8' }))).toBe(true);
    expect(takesJxl(req({ accept: 'image/avif, image/jxl;q=0.9' }))).toBe(true);
  });
  test('not without them, nor on a cookie that only looks like it', () => {
    expect(takesJxl(req({}))).toBe(false);
    expect(takesJxl(req({ cookie: 'dither_jxl=0; xdither_jxl=1' }))).toBe(false);
    expect(takesJxl(req({ accept: 'image/avif,image/webp,image/*' }))).toBe(false);
  });
});

describe('trimming a cache with packed pictures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-jxl-trim-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a packed picture keeps its .mime, goes with it when trimmed, and a tool’s leftover output goes', () => {
    const old = (p: string, at: number) => utimesSync(p, at / 1000, at / 1000);
    const now = Date.now();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    writeFileSync(join(dir, a + '.jxl'), new Uint8Array(100));
    writeFileSync(join(dir, a + '.mime'), 'image/png');
    old(join(dir, a + '.jxl'), now - 10_000);
    writeFileSync(join(dir, b + '.jxl'), new Uint8Array(100));
    writeFileSync(join(dir, b + '.mime'), 'image/jpeg');
    const left = join(dir, `${b}.0123456789ab.tmp.png`);
    writeFileSync(left, new Uint8Array(10));
    old(left, now - 2 * 3_600_000);
    pruneMediaCache(dir, 150, now);
    expect(existsSync(join(dir, a + '.jxl')) || existsSync(join(dir, a + '.mime'))).toBe(false);
    expect(existsSync(join(dir, b + '.jxl')) && existsSync(join(dir, b + '.mime'))).toBe(true);
    expect(existsSync(left)).toBe(false);
  });
});

const tools = await findJxl({ nix: true });
const withTools = describe.skipIf(!tools);

withTools('packing and rebuilding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-jxl-pack-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a JPEG is stored as JPEG XL, smaller, and comes back byte for byte; it keeps its last use', async () => {
    const f = join(dir, 'c'.repeat(64));
    writeFileSync(f, JPEG);
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    const p = await pack(tools!, f, 'image/jpeg');
    expect(p.packed).toBe(true);
    expect(p.after).toBeLessThan(JPEG.length);
    expect(existsSync(f)).toBe(false);
    expect(statSync(f + '.jxl').mtimeMs).toBe(1_700_000_000_000);
    const back = await rebuild(tools!, f + '.jxl');
    expect(back?.mime).toBe('image/jpeg');
    expect(Buffer.from(back!.bytes).equals(JPEG)).toBe(true);
  });

  test('a PNG is stored lossless and comes back a PNG of the same size', async () => {
    const f = join(dir, 'd'.repeat(64));
    const png = noisyPng(160, 120);
    writeFileSync(f, png);
    const p = await pack(tools!, f, 'image/png');
    expect(p.packed).toBe(true);
    const back = await rebuild(tools!, f + '.jxl');
    expect(back?.mime).toBe('image/png');
    expect(pngSize(back!.bytes)).toEqual({ width: 160, height: 120 });
  });

  test('a file that is not what it says stays as it is', async () => {
    const f = join(dir, 'e'.repeat(64));
    writeFileSync(f, JPEG);
    expect((await pack(tools!, f, 'image/png')).packed).toBe(false);
    expect(existsSync(f) && !existsSync(f + '.jxl')).toBe(true);
  });

  test('a JPEG XL someone sent becomes the JPEG it was repacked from, else a PNG', async () => {
    const repacked = join(dir, 'sent-repacked');
    writeFileSync(repacked, b64(REPACKED_120x80));
    const j = await toCommon(tools!, repacked, join(dir, 'out-a'));
    expect(j?.mime).toBe('image/jpeg');
    expect([...readFileSync(j!.path).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const made = join(dir, 'sent-made');
    writeFileSync(made, b64(JXL['300x200']));
    const p = await toCommon(tools!, made, join(dir, 'out-b'));
    expect(p?.mime).toBe('image/png');
    expect(pngSize(readFileSync(p!.path))).toEqual({ width: 300, height: 200 });
    expect(await toCommon(tools!, repacked + '-not', join(dir, 'out-c')).catch(() => 'threw')).toBe('threw');
  });
});

withTools('the packer over the media cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-jxl-packer-'));
  const cache = join(dir, 'media-cache');
  let store: Store;
  beforeAll(() => {
    mkdirSync(cache, { recursive: true });
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('packs the JPEGs and PNGs media_info knows, and leaves the rest, the small ones and the mail files', async () => {
    const put = (name: string, bytes: Uint8Array, mime: string, info?: string) => {
      writeFileSync(join(cache, name), bytes);
      writeFileSync(join(cache, name + '.mime'), mime);
      if (info)
        store.db
          .query("INSERT INTO media_info (key, mime, kind, size, partial, version, at) VALUES (?, ?, 'image', ?, 0, 2, 0)")
          .run(name, info, bytes.length);
    };
    const jpg = mediaKey('https://cdn.example/a.jpg');
    const png = mediaKey('https://cdn.example/b.png');
    const gif = mediaKey('https://cdn.example/c.gif');
    const unknown = mediaKey('https://cdn.example/d.jpg');
    const tiny = mediaKey('https://cdn.example/e.png');
    put(jpg, JPEG, 'image/jpeg', 'image/jpeg');
    put(png, noisyPng(160, 120), 'application/octet-stream', 'image/png');
    put(gif, JPEG, 'image/gif', 'image/gif');
    put(unknown, JPEG, 'image/jpeg');
    put(tiny, noisyPng(2, 2), 'image/png', 'image/png');
    put('mailimg-' + 'a'.repeat(64), JPEG, 'image/jpeg');
    const packer = new MediaPacker(store, cache, async () => tools);
    await packer.tick();
    expect(packer.packed).toBe(2);
    expect(existsSync(join(cache, jpg + '.jxl')) && !existsSync(join(cache, jpg))).toBe(true);
    expect(existsSync(join(cache, png + '.jxl')) && !existsSync(join(cache, png))).toBe(true);
    for (const k of [gif, unknown, tiny, 'mailimg-' + 'a'.repeat(64)]) expect(existsSync(join(cache, k)) && !existsSync(join(cache, k + '.jxl'))).toBe(true);
    // The walk is over: the next run finds nothing until it starts again.
    await packer.tick();
    await packer.tick();
    expect(packer.packed).toBe(2);
  });
});

withTools('serving pictures to each device, and sending them on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-jxl-hub-'));
  const png = noisyPng(160, 120);
  const sent = b64(JXL['300x200']);
  const files: Record<string, { mime: string; bytes: Uint8Array }> = {
    'mxc://x.org/photo': { mime: 'image/jpeg', bytes: JPEG },
    'mxc://x.org/shot': { mime: 'image/png', bytes: png },
    'mxc://x.org/sent': { mime: 'image/jxl', bytes: sent },
  };
  let store: Store;
  let hub: HubServer;
  let url = '';
  let account = '';
  const sends: any[] = [];

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = {
      authorize: () => null,
      online: () => true,
      command: async (_a: string, c: any) => {
        if (c.t === 'fetchMedia') return files[c.url] ? { mime: files[c.url].mime, base64: Buffer.from(files[c.url].bytes).toString('base64') } : null;
        if (c.t === 'send') {
          sends.push({ ...c, attachments: c.attachments?.map((a: any) => ({ ...a, bytes: readFileSync(a.path) })) });
          return { nativeId: `$sent${sends.length}` };
        }
        return null;
      },
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's', jxl: async () => tools });
    url = `http://127.0.0.1:${hub.start().port}`;
    account = store.createAccount({ network: 'matrix', label: 'mx', color: '#000', adapter: 'matrix' });
    store.ingest(account, { t: 'hello', network: 'matrix', version: '1', capabilities: ['sendMedia'] });
    store.ingest(account, { t: 'status', status: 'online', self: { nativeId: '@me:x.org', isSelf: true, displayName: 'me' } });
    store.ingest(account, { t: 'conversation', conversation: { nativeId: '!r:x.org', shape: 'group', name: 'Room' } });
    store.flush();
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (raw: string, headers: Record<string, string> = {}) => fetch(url + store.mediaUrl(raw, account)!, { headers });
  const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

  test('a packed JPEG goes as JPEG XL where the device shows it, and as the same JPEG where it does not', async () => {
    expect(Buffer.from(await bytes(await get('mxc://x.org/photo'))).equals(JPEG)).toBe(true);
    const cache = join(dir, 'media-cache');
    const key = mediaKey('mxc://x.org/photo');
    expect((await pack(tools!, join(cache, key), 'image/jpeg')).packed).toBe(true);
    const asJxl = await get('mxc://x.org/photo', { cookie: 'dither_jxl=1' });
    expect(asJxl.headers.get('content-type')).toBe('image/jxl');
    expect(Buffer.from(await bytes(asJxl)).equals(readFileSync(join(cache, key + '.jxl')))).toBe(true);
    const asJpeg = await get('mxc://x.org/photo');
    expect(asJpeg.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await bytes(asJpeg)).equals(JPEG)).toBe(true);
  });

  test('a packed PNG goes back a PNG of the same size', async () => {
    await get('mxc://x.org/shot');
    const key = mediaKey('mxc://x.org/shot');
    expect((await pack(tools!, join(dir, 'media-cache', key), 'image/png')).packed).toBe(true);
    const r = await get('mxc://x.org/shot', { accept: 'image/avif,image/webp,*/*' });
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(pngSize(await bytes(r))).toEqual({ width: 160, height: 120 });
  });

  test('a JPEG XL someone sent goes as it is where it shows, else as a PNG', async () => {
    const as = await get('mxc://x.org/sent', { accept: 'image/jxl,*/*' });
    expect(as.headers.get('content-type')).toBe('image/jxl');
    expect(Buffer.from(await bytes(as)).equals(Buffer.from(sent))).toBe(true);
    const other = await get('mxc://x.org/sent');
    expect(other.headers.get('content-type')).toBe('image/png');
    expect(pngSize(await bytes(other))).toEqual({ width: 300, height: 200 });
  });

  test('a JPEG XL you attach goes to the network as a JPEG or PNG, named for it', async () => {
    const up = await fetch(`${url}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/jxl', 'x-file-name': 'holiday.jxl' }, body: b64(REPACKED_120x80) });
    expect(up.status).toBe(200);
    const { id } = (await up.json()) as { id: string };
    const conv = (store.db.query('SELECT id FROM conversation').get() as { id: string }).id;
    const r = await fetch(`${url}/api/conversations/${conv}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '', attachments: [id] }) });
    expect(await r.text()).toContain('"ok":true');
    const a = sends.at(-1).attachments[0];
    expect({ name: a.name, mime: a.mime, kind: a.kind }).toEqual({ name: 'holiday.jpg', mime: 'image/jpeg', kind: 'image' });
    expect([...a.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  test('an upload that is no JPEG XL goes as it is', async () => {
    const uploads = new Uploads(join(dir, 'uploads-plain'));
    const v = uploads.put(JPEG, 'photo.jpg', 'image/jpeg');
    const files = uploads.get([v.id])!;
    expect(await uploads.common(files, tools)).toEqual(files);
  });
});
