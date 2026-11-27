/**
 * Photos made progressive on the device (progressive/): the WASI jpegtran writes exactly what the native one does,
 * and pack() keeps what is already progressive, reorders a baseline JPEG, and leaves anything else alone. On an
 * invented picture (gradients and two shapes).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jpegLayers } from '@dither-chat/protocol';
import { pack } from '../src/progressive/pack.ts';
import { runWasi } from '../src/progressive/wasi.ts';

const fixture = (f: string) => new Uint8Array(readFileSync(join(import.meta.dir, '../../protocol/test/fixtures', f)));
const baseline = fixture('baseline.jpg');
/** What native jpegtran -progressive -copy all (libjpeg-turbo 3.1.4.1) wrote from it. */
const progressive = fixture('progressive.jpg');
const mod = new WebAssembly.Module(readFileSync(join(import.meta.dir, '../src/progressive/jpegtran.wasm')));
const jpegtran = async (b: Uint8Array) => {
  const r = runWasi(mod, ['jpegtran', '-progressive', '-copy', 'all'], b);
  if (r.code) throw new Error(r.stderr);
  return r.stdout;
};

test('the WASI jpegtran writes what the native one does, byte for byte', async () => {
  expect(Buffer.compare(await jpegtran(baseline), progressive)).toBe(0);
});

test('a broken file: jpegtran says why and exits, nothing written', () => {
  const r = runWasi(mod, ['jpegtran', '-progressive'], new TextEncoder().encode('not a picture'));
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('Not a JPEG file');
  expect(r.stdout.length).toBe(0);
});

test('pack: a baseline JPEG is reordered, with its layers and stops', async () => {
  const p = (await pack(new Blob([baseline]), jpegtran))!;
  expect(p.blob.type).toBe('image/jpeg');
  expect(Buffer.compare(new Uint8Array(await p.blob.arrayBuffer()), progressive)).toBe(0);
  expect(p.layers).toEqual(jpegLayers(progressive)!);
  // Just past the marker after the first picture, so the hub sees it whole (qualityStops).
  expect(p.stops[0]).toBe(p.layers.preview! + 2);
  expect(p.stops.at(-1)).toBe(progressive.length);
});

test('pack: a progressive JPEG stays as it is; a PNG, or a JPEG the packer fails on, goes as it was', async () => {
  const already = new Blob([progressive]);
  let ran = 0;
  const counting = async (b: Uint8Array) => (ran++, jpegtran(b));
  expect((await pack(already, counting))!.blob).toBe(already);
  expect(ran).toBe(0);
  expect(await pack(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]), counting)).toBeNull();
  expect(await pack(new Blob([baseline]), () => Promise.reject(new Error('no')))).toBeNull();
  // What comes back must be a whole progressive JPEG.
  expect(await pack(new Blob([baseline]), async () => baseline)).toBeNull();
});
