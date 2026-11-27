/**
 * The line under a send's pending copy (sendline.ts): packing, how much is up and how long is left, and with the link
 * lost what the hub has of each picture and when it sends them as they are. Also what the hub would cut at.
 */
import { expect, test } from 'bun:test';
import type { JpegLayers } from '@dither-chat/protocol';
import { hubCut, hubQuality, sendLine, type FileState } from '../src/sendline.ts';

// An invented 1000-byte progressive photo: the first picture at 40, fair from 350, good from 600.
const layers: JpegLayers = { ends: [40, 200, 380, 640, 998], preview: 40 };
const photo = (sent: number, o: Partial<FileState> = {}): FileState => ({
  status: 'uploading',
  sent,
  size: 1000,
  layers,
  at: 1_000,
  ...o,
});
const cut = { afterMs: 60_000, atLeast: 'fair' as const };

test('the hub can cut only after a scan whose next marker it has', () => {
  expect(hubCut(photo(41))).toBe(0);
  expect(hubCut(photo(42))).toBe(40);
  expect(hubCut(photo(381))).toBe(200);
  expect(hubCut(photo(382))).toBe(380);
  expect(hubCut(photo(1000))).toBe(1000);
  expect(hubQuality(photo(10))).toBeNull();
  expect(hubQuality(photo(100))).toBe('preview');
  expect(hubQuality(photo(400))).toBe('fair');
  expect(hubQuality(photo(700))).toBe('good');
  expect(hubQuality(photo(1000))).toBe('full');
  // Not a photo: nothing until all of it is there.
  expect(hubQuality({ status: 'uploading', sent: 900, size: 1000 })).toBeNull();
});

test('online: packing, then how much is up, and how long is left once it has been going a while', () => {
  const base = { online: true, held: true, cut, now: 10_000 };
  expect(sendLine({ ...base, files: [photo(0, { status: 'packing' })] })?.text).toBe('Packing…');
  expect(sendLine({ ...base, files: [photo(500)] })?.text).toBe('Sending · 1 KB of 1 KB');
  const big = (sent: number): FileState => ({
    status: 'uploading',
    sent,
    size: 4 * 1024 * 1024,
  });
  expect(
    sendLine({
      ...base,
      files: [big(2 * 1024 * 1024)],
      began: { at: 0, sent: 1024 * 1024 },
    })?.text,
  ).toBe('Sending · 2.0 MB of 4.0 MB · about 20 s left');
  expect(sendLine({ ...base, files: [photo(1000, { status: 'done' })] })).toBeNull();
});

test('the link lost: what the hub has, and when it sends it as it is', () => {
  const base = { online: false, held: true, cut, now: 31_000 };
  expect(sendLine({ ...base, files: [photo(400), photo(700)] })).toEqual({
    text: 'Link lost · the hub has all 2, at least fair · sends as is in 0:30',
    amber: true,
  });
  // Past the wait the hub is on it (its next look is within 10 s).
  expect(sendLine({ ...base, now: 61_000, files: [photo(400)] })?.text).toBe('Link lost · the hub has at least fair · sending as is');
  expect(sendLine({ ...base, files: [photo(100)] })?.text).toBe('Link lost · the hub has at least preview · waits: not all fair yet');
  expect(
    sendLine({
      ...base,
      files: [photo(400), { status: 'uploading', sent: 5, size: 10 }],
    })?.text,
  ).toBe('Link lost · the hub has 1 of 2 · waits: not all fair yet');
  expect(
    sendLine({
      ...base,
      cut: { afterMs: null, atLeast: 'fair' },
      files: [photo(400)],
    })?.text,
  ).toBe('Link lost · the hub has at least fair · the hub waits for this phone');
  expect(sendLine({ ...base, cut: null, files: [photo(400)] })?.text).toBe('Link lost · the hub has at least fair · it carries on when this phone is back');
  // Not the hub's to send yet (its first ask never got there): nothing beyond the pending copy's own note.
  expect(sendLine({ ...base, held: false, files: [photo(400)] })).toBeNull();
});
