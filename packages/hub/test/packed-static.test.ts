/**
 * The web build's files as the hub serves them (compress.ts PackedFiles, docs/perf.md "The web build on the wire"):
 * packed once with zstd at level 19 for a client that takes zstd, with their own type and caching; gzip and HEAD as
 * before.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

let dir: string;
let store: Store;
let hub: HubServer;
let base: string;
const js = Array.from({ length: 2000 }, (_, i) => `export function f${i % 300}(a){return a.map((x)=>x*${i % 17})}`).join(';\n');
const html = `<!doctype html><script type="module" src="/assets/app-1.js"></script>${'<!-- padding -->'.repeat(100)}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dither-packed-static-'));
  mkdirSync(join(dir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'web', 'assets', 'app-1.js'), js);
  writeFileSync(join(dir, 'web', 'index.html'), html);
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const sup = { authorize: () => null, online: () => false, command: async () => ({}) } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, 'data'), webDist: join(dir, 'web'), secret: 's', open: true });
  base = `http://127.0.0.1:${hub.start().port}`;
});

afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, encoding: string, method = 'GET') => fetch(base + path, { method, headers: { 'accept-encoding': encoding }, decompress: false } as RequestInit);
const unzstd = async (r: Response) => new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await r.arrayBuffer())));

test('before packing, a file goes out compressed on the fly; after, packed, the same text and fewer bytes', async () => {
  const before = await get('/assets/app-1.js', 'gzip, deflate, br, zstd');
  expect(before.headers.get('content-encoding')).toBe('zstd');
  const onTheFly = new Uint8Array(await before.clone().arrayBuffer()).byteLength;
  expect(await unzstd(before)).toBe(js);

  // The first ask queued it; packAll covers the rest of the build.
  await hub.packed.packAll(join(dir, 'web'));
  const after = await get('/assets/app-1.js', 'gzip, deflate, br, zstd');
  expect(after.headers.get('content-encoding')).toBe('zstd');
  expect(after.headers.get('content-type')).toContain('javascript');
  expect(after.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(after.headers.get('vary')).toContain('accept-encoding');
  const packed = new Uint8Array(await after.clone().arrayBuffer()).byteLength;
  expect(await unzstd(after)).toBe(js);
  expect(packed).toBeLessThan(onTheFly);
});

test('index.html, asked for by an app route, is packed too and stays no-cache', async () => {
  await hub.packed.packAll(join(dir, 'web'));
  const r = await get('/c/some-chat', 'zstd');
  expect(r.headers.get('content-encoding')).toBe('zstd');
  expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(r.headers.get('cache-control')).toBe('no-cache');
  expect(await unzstd(r)).toBe(html);
});

test('gzip and HEAD are answered as before', async () => {
  await hub.packed.packAll(join(dir, 'web'));
  const gz = await get('/assets/app-1.js', 'gzip');
  expect(gz.headers.get('content-encoding')).toBe('gzip');
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(js);
  const head = await get('/assets/app-1.js', 'zstd', 'HEAD');
  expect(head.status).toBe(200);
  expect(head.headers.get('content-encoding')).toBeNull();
});
