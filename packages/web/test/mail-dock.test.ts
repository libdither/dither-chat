import { describe, expect, test } from 'bun:test';
import { clampDock, defaultDock, loadDock, MIN_H, MIN_W, moveDock, parseDock, resizeDock, saveDock } from '../src/mail/dock.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('the composer dock', () => {
  test('starts at the bottom right, smaller on a small window', () => {
    expect(defaultDock(1440, 900)).toEqual({ r: 16, b: 16, w: 560, h: 660 });
    expect(defaultDock(500, 400)).toEqual({ r: 16, b: 16, w: 468, h: 368 });
  });

  test('dragging moves it, and no edge goes past the window', () => {
    const d = defaultDock(1440, 900);
    expect(moveDock(d, -200, -100, 1440, 900)).toEqual({ ...d, r: 216, b: 116 });
    // Far to the left and up: stops at the left and top edges.
    expect(moveDock(d, -5000, -5000, 1440, 900)).toEqual({ ...d, r: 1440 - 560, b: 900 - 660 });
    // Past the right and bottom: stops at them.
    expect(moveDock(d, 500, 500, 1440, 900)).toEqual({ ...d, r: 0, b: 0 });
  });

  test('a smaller window keeps it wholly on screen', () => {
    const d = { r: 800, b: 200, w: 560, h: 660 };
    const c = clampDock(d, 1000, 700);
    expect(c.r + c.w).toBeLessThanOrEqual(1000);
    expect(c.b + c.h).toBeLessThanOrEqual(700);
    expect(c).toEqual({ r: 440, b: 40, w: 560, h: 660 });
    // Smaller than the window lets it be: it is the window.
    expect(clampDock(d, 300, 200)).toEqual({ r: 0, b: 0, w: 300, h: 200 });
  });

  test('resizing by the top left corner keeps the right and bottom edges, between the least size and the window', () => {
    const d = defaultDock(1440, 900);
    expect(resizeDock(d, -100, -50, 1440, 900)).toEqual({ ...d, w: 660, h: 710 });
    expect(resizeDock(d, 1000, 1000, 1440, 900)).toEqual({ ...d, w: MIN_W, h: MIN_H });
    expect(resizeDock(d, -5000, -5000, 1440, 900)).toEqual({ ...d, w: 1440 - 16, h: 900 - 16 });
    // Only the top edge: the width stays.
    expect(resizeDock(d, 0, -40, 1440, 900).w).toBe(560);
  });

  test('remembered per browser, and anything else is the default', () => {
    const s = memory();
    expect(loadDock(s)).toEqual({ at: null, min: false });
    saveDock({ at: { r: 20.4, b: 30.6, w: 500, h: 400 }, min: true }, s);
    expect(loadDock(s)).toEqual({ at: { r: 20, b: 31, w: 500, h: 400 }, min: true });
    saveDock({ at: null, min: false }, s);
    expect(s.m.size).toBe(0);
    expect(parseDock('not json')).toEqual({ at: null, min: false });
    expect(parseDock('{"at":{"r":"1","b":2,"w":3,"h":4},"min":1}')).toEqual({ at: null, min: false });
    expect(parseDock('{"min":true}')).toEqual({ at: null, min: true });
  });

  test('storage that throws is no storage', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDock(bad)).toEqual({ at: null, min: false });
    expect(() => saveDock({ at: null, min: true }, bad)).not.toThrow();
  });
});
