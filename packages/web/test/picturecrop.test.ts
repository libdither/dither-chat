import { describe, expect, test } from 'bun:test';
import { centred, clamp, cropRect, MAX_ZOOM, zoomAbout } from '../src/picturecrop.ts';

const wide = { w: 2000, h: 1000 };
const frame = 200;

describe('picture crop', () => {
  test('centred: the short side fills the frame and the long side is centred', () => {
    expect(centred(wide, frame)).toEqual({ zoom: 1, x: -100, y: 0 });
    const r = cropRect(wide, frame, centred(wide, frame));
    expect(r).toEqual({ sx: 500, sy: 0, side: 1000, out: 1000 });
  });

  test('clamp: no edge of the frame is ever left uncovered', () => {
    expect(clamp(wide, frame, { zoom: 1, x: 50, y: 30 })).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(clamp(wide, frame, { zoom: 1, x: -900, y: -30 })).toEqual({ zoom: 1, x: -200, y: 0 });
    expect(clamp(wide, frame, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
    expect(clamp(wide, frame, { zoom: 99, x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  });

  test('zoomAbout keeps the point under the fingers where it was', () => {
    const at = centred(wide, frame);
    const z = zoomAbout(wide, frame, at, 2, 100, 100);
    // The frame's middle showed picture pixel (1000, 500) before, and still does.
    const before = cropRect(wide, frame, at);
    const after = cropRect(wide, frame, z);
    expect(before.sx + before.side / 2).toBeCloseTo(1000);
    expect(after.sx + after.side / 2).toBeCloseTo(1000);
    expect(after.sy + after.side / 2).toBeCloseTo(500);
    expect(after.side).toBeCloseTo(500);
  });

  test('cropRect sends at most 1024 and at least 128 pixels a side', () => {
    expect(cropRect({ w: 4000, h: 3000 }, frame, { zoom: 1, x: 0, y: 0 }).out).toBe(1024);
    expect(cropRect({ w: 300, h: 300 }, frame, { zoom: MAX_ZOOM, x: 0, y: 0 }).out).toBe(128);
  });
});
