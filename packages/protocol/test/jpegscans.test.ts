/**
 * The layers of a progressive JPEG (jpegscans.ts): where each scan ends, the first whole picture, a cut after the last
 * whole scan, and the stops an upload makes by quality. On an invented picture (gradients and two shapes), as cjpeg
 * wrote it (baseline) and as jpegtran -progressive reordered it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atLeast, CUT_FAIR, CUT_GOOD, cutJpeg, cutQuality, jpegCut, jpegLayers, qualityStops, seesEnd } from '../src/jpegscans.ts';

const read = (f: string) => new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', f)));
const prog = read('progressive.jpg');
const base = read('baseline.jpg');

describe('jpegLayers', () => {
  test("jpegtran's ten scans, each ending at a marker, the first whole picture after the DC scan", () => {
    const L = jpegLayers(prog)!;
    expect(L.ends).toHaveLength(10);
    expect(L.ends.at(-1)).toBe(prog.length - 2);
    for (const e of L.ends) expect(prog[e]).toBe(0xff);
    expect(L.preview).toBe(L.ends[0]);
  });

  test('only whole scans count in a cut-off file', () => {
    const L = jpegLayers(prog)!;
    const part = jpegLayers(prog.subarray(0, L.ends[3] + 5))!;
    expect(part.ends).toEqual(L.ends.slice(0, 4));
    expect(jpegLayers(prog.subarray(0, L.ends[0] - 1))).toEqual({ ends: [], preview: null });
  });

  test('a baseline JPEG, or not a JPEG, has none', () => {
    expect(jpegLayers(base)).toBeNull();
    expect(jpegLayers(new TextEncoder().encode('not a picture'))).toBeNull();
    expect(jpegLayers(new Uint8Array(0))).toBeNull();
  });
});

describe('cuts', () => {
  test('cut after the last whole scan, closed with an end marker; its quality by the share kept', () => {
    const L = jpegLayers(prog)!;
    const got = prog.subarray(0, L.ends[4] + 100);
    const c = jpegCut(got, prog.length)!;
    expect(c.keep).toBe(L.ends[4]);
    expect(c.quality).toBe(cutQuality(L.ends[4], prog.length, L));
    const file = cutJpeg(got, c.keep);
    expect(file.length).toBe(L.ends[4] + 2);
    expect([...file.subarray(-2)]).toEqual([0xff, 0xd9]);
    // The cut is itself a progressive JPEG with those scans.
    expect(jpegLayers(file)!.ends).toEqual(L.ends.slice(0, 5));
  });

  test('nothing to cut before the first picture is in', () => {
    const L = jpegLayers(prog)!;
    expect(jpegCut(prog.subarray(0, L.preview! - 1), prog.length)).toBeNull();
    expect(jpegCut(base.subarray(0, 9000), base.length)).toBeNull();
  });

  test('preview, fair, good, full by the share of the file kept', () => {
    const L = { ends: [100], preview: 100 };
    expect(cutQuality(99, 1000, L)).toBeNull();
    expect(cutQuality(100, 1000, L)).toBe('preview');
    expect(cutQuality(1000 * CUT_FAIR, 1000, L)).toBe('fair');
    expect(cutQuality(1000 * CUT_GOOD, 1000, L)).toBe('good');
    expect(cutQuality(1000, 1000, L)).toBe('full');
    expect(atLeast('good', 'fair')).toBe(true);
    expect(atLeast('preview', 'fair')).toBe(false);
    expect(atLeast(null, 'preview')).toBe(false);
  });
});

test('an upload stops just past the first picture, the first scan past fair and past good, then the end', () => {
  const L = jpegLayers(prog)!;
  const stops = qualityStops(prog.length, L);
  expect(stops[0]).toBe(L.preview! + 2);
  expect(stops.at(-1)).toBe(prog.length);
  for (const s of stops.slice(0, -1)) expect(L.ends).toContain(s - 2);
  expect(stops).toEqual([...new Set(stops)].sort((a, b) => a - b));
});

test('a hub paused at a stop sees the scan before it whole, as the phone counts it', () => {
  const L = jpegLayers(prog)!;
  for (const s of qualityStops(prog.length, L).slice(0, -1)) {
    expect(jpegCut(prog.subarray(0, s), prog.length)?.keep).toBe(s - 2);
    // One byte short of the marker after it, and the scan is not known to be whole: the phone must not count it either.
    expect(jpegCut(prog.subarray(0, s - 1), prog.length)?.keep ?? 0).toBeLessThan(s - 2);
    expect(seesEnd(s - 2, s - 1)).toBe(false);
    expect(seesEnd(s - 2, s)).toBe(true);
  }
});
