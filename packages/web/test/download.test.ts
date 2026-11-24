import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { asLabel, downloadsAs, formatLine, hubMedia, mediaAs } from '../src/download.ts';
import { bytes } from '../src/format.ts';

// Downloading in a chosen form (download.ts, docs/files.md "Downloading").
describe('downloading a picture in the form you pick', () => {
  const had = (globalThis as any).location;
  beforeAll(() => ((globalThis as any).location = new URL('https://hub.example/c/one')));
  afterAll(() => ((globalThis as any).location = had));

  test("only the hub's own media links take ?as=", () => {
    expect(hubMedia('/media/abc/def?a=acc')).toBe(true);
    expect(hubMedia('https://hub.example/media/abc/def')).toBe(true);
    expect(hubMedia('https://elsewhere.example/media/abc/def')).toBe(false);
    expect(hubMedia('blob:https://hub.example/1234')).toBe(false);
    expect(hubMedia('data:image/png;base64,AAAA')).toBe(false);
    expect(hubMedia('/emoji/discord/1')).toBe(false);
  });

  test('the link keeps its account and carries the form and the name', () => {
    expect(mediaAs('/media/abc/def?a=acc', 'original', 'IMG 1.jpg')).toBe('/media/abc/def?a=acc&as=original&name=IMG+1.jpg');
    expect(mediaAs('/media/abc/def', 'info')).toBe('/media/abc/def?as=info');
  });

  test('each type offers its own form first, then the ones worth having', () => {
    expect(downloadsAs('image/jpeg')).toEqual(['original', 'jxl', 'png']);
    expect(downloadsAs('image/png; charset=binary')).toEqual(['original', 'jxl']);
    expect(downloadsAs('image/jxl')).toEqual(['original', 'jpeg', 'png']);
    expect(downloadsAs('image/gif')).toEqual(['original']);
    expect(downloadsAs(null)).toEqual(['original']);
    expect(downloadsAs('image/jxl').map((as) => asLabel(as, 'image/jxl'))).toEqual(['Original (JPEG XL)', 'JPEG', 'PNG']);
    expect(asLabel('original', 'application/pdf')).toBe('Original');
  });

  test('the line under the name says what it came as, how it is kept and what this device got', () => {
    const kb = (n: number) => bytes(n);
    expect(formatLine({ type: 'image/jpeg', size: 2_100_000, kept: { type: 'image/jxl', size: 1_400_000 }, sent: 'image/jxl', as: [] })).toBe(
      `JPEG, ${kb(2_100_000)} · kept as JPEG XL, ${kb(1_400_000)}, shown here as JPEG XL`,
    );
    expect(formatLine({ type: 'image/jpeg', size: 2_100_000, kept: { type: 'image/jxl', size: 1_400_000 }, sent: 'image/jpeg', as: [] })).toBe(
      `JPEG, ${kb(2_100_000)} · kept as JPEG XL, ${kb(1_400_000)}, shown here as JPEG`,
    );
    expect(formatLine({ type: 'image/png', size: 5000, kept: { type: 'image/png', size: 5000 }, sent: 'image/png', as: [] })).toBe(`PNG, ${kb(5000)}`);
    expect(formatLine({ type: 'image/jxl', size: 9000, kept: { type: 'image/jxl', size: 9000 }, sent: null, as: [] })).toBe(`JPEG XL, ${kb(9000)}, shown here as a JPEG or PNG`);
    // Packed before its size was recorded.
    expect(formatLine({ type: 'image/jpeg', size: null, kept: { type: 'image/jxl', size: 1000 }, sent: 'image/jxl', as: [] })).toBe(`JPEG · kept as JPEG XL, ${kb(1000)}, shown here as JPEG XL`);
  });
});
