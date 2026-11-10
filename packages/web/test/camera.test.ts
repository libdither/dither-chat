/** src/camera.ts: where a flip goes, what a recording is saved as, names, and which picks open the send screen. */
import { expect, test } from 'bun:test';
import { baseType, clockOf, isMedia, nextCamera, opensSendScreen, photoName, recorderType, videoName } from '../src/camera.ts';

test('a flip goes to a camera facing the other way, not the next one on the same side', () => {
  const phone = [
    { id: 'back-wide', facing: ['environment'] },
    { id: 'back-ultra', facing: ['environment'] },
    { id: 'front', facing: ['user'] },
  ];
  expect(nextCamera(phone, 'back-wide')).toBe('front');
  expect(nextCamera(phone, 'back-ultra')).toBe('front');
  expect(nextCamera(phone, 'front')).toBe('back-wide');
});

test('without facings it is the next in the list, round again; one camera has nowhere to go', () => {
  const laptop = [
    { id: 'a', facing: [] },
    { id: 'b', facing: [] },
  ];
  expect(nextCamera(laptop, 'a')).toBe('b');
  expect(nextCamera(laptop, 'b')).toBe('a');
  // Not known (the stream did not say): the first.
  expect(nextCamera(laptop, undefined)).toBe('a');
  expect(nextCamera([{ id: 'only', facing: ['user'] }], 'only')).toBeUndefined();
  expect(nextCamera([], undefined)).toBeUndefined();
});

test('a recording is MP4 where the browser can, else WebM, else none', () => {
  expect(recorderType(() => true)).toBe('video/mp4');
  expect(recorderType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp8,opus');
  expect(recorderType((t) => t === 'video/webm')).toBe('video/webm');
  expect(recorderType(() => false)).toBeUndefined();
  expect(baseType('video/webm;codecs=vp8,opus')).toBe('video/webm');
});

test('names say what and when', () => {
  const d = new Date(2026, 10, 10, 9, 5, 7);
  expect(photoName(d)).toBe('photo-2026-11-10-090507.jpg');
  expect(videoName(d, 'video/mp4')).toBe('video-2026-11-10-090507.mp4');
  expect(videoName(d, 'video/webm;codecs=vp8,opus')).toBe('video-2026-11-10-090507.webm');
  expect(clockOf(65_400)).toBe('1:05');
  expect(clockOf(-5)).toBe('0:00');
});

test('photos and videos open the send screen; other files go to the composer', () => {
  expect(isMedia({ type: 'image/png' })).toBe(true);
  expect(isMedia({ type: 'video/mp4' })).toBe(true);
  expect(isMedia({ type: 'application/pdf' })).toBe(false);
  expect(opensSendScreen([{ type: 'application/pdf' }, { type: 'image/jpeg' }])).toBe(true);
  expect(opensSendScreen([{ type: 'application/pdf' }])).toBe(false);
  expect(opensSendScreen([])).toBe(false);
});
