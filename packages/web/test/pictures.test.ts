/**
 * src/pictures.ts (docs/pictures.md): how big a picture on its own is, how a mosaic splits into rows, and which
 * messages' pictures make one run.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { fitPicture, isPicture, mosaicRows, onlyPictures, PICTURE_ORDER, pictureRuns, picturesOf, settleAt, slidePosition, SLIDE_GIVE, tileAspect } from '../src/pictures.ts';

describe('a picture on its own', () => {
  test('fits 560 x 480 whole, never enlarged', () => {
    expect(fitPicture(2048, 1536)).toEqual({ w: 560, h: 420, crop: null });
    expect(fitPicture(1536, 2048)).toEqual({ w: 360, h: 480, crop: null });
    expect(fitPicture(1080, 2400)).toEqual({ w: 216, h: 480, crop: null });
    expect(fitPicture(128, 128)).toEqual({ w: 128, h: 128, crop: null });
  });
  test('a strip uses the width it has, whole', () => {
    // The picture that was cut to a 400 x 300 box: Signal sent no size for it.
    expect(fitPicture(1648, 254)).toEqual({ w: 560, h: 86, crop: null });
    expect(fitPicture(4000, 900)).toEqual({ w: 560, h: 126, crop: null });
  });
  test('a long screenshot keeps a readable width and shows its top', () => {
    expect(fitPicture(1080, 6000)).toEqual({ w: 200, h: 480, crop: 'long' });
  });
  test('a very wide one keeps some height and its middle', () => {
    expect(fitPicture(6000, 600)).toEqual({ w: 560, h: 64, crop: 'wide' });
  });
});

describe('a mosaic', () => {
  test('rows: one or two alone, three as one over two, then threes with twos first', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(mosaicRows)).toEqual([[1], [2], [1, 2], [2, 2], [2, 3], [3, 3], [2, 2, 3], [2, 3, 3], [3, 3, 3], [2, 2, 3, 3]]);
    for (let n = 1; n <= 40; n++) expect(mosaicRows(n).reduce((a, b) => a + b)).toBe(n);
  });
  test("a tile keeps its picture's shape within bounds", () => {
    expect(tileAspect(1648 / 254, 3)).toBe(1.8);
    expect(tileAspect(1080 / 6000, 2)).toBe(0.6);
    expect(tileAspect(4 / 3, 2)).toBeCloseTo(4 / 3);
    expect(tileAspect(0.75, 1)).toBe(1.25);
  });
});

let n = 0;
const att = (over: Partial<P.AttachmentView> = {}): P.AttachmentView => ({ id: `a${++n}`, kind: 'image', mime: 'image/png', name: null, size: null, width: 800, height: 600, url: `https://x.test/${n}.png`, ...over });
const msg = (author: string, ts: number, over: Partial<P.MessageView> = {}): P.MessageView =>
  ({
    id: `m${++n}`,
    conversationId: 'c1',
    network: 'signal',
    nativeId: String(n),
    authorId: author,
    ts,
    editedTs: null,
    kind: 'text',
    body: '',
    replyToId: null,
    threadId: null,
    mentionsSelf: false,
    deleted: false,
    attachments: [att()],
    embeds: [],
    reactions: [],
    seenVia: [],
    triage: null,
    ...over,
  }) as P.MessageView;
const minute = 60_000;
/** As the timeline joins them: the same author within seven minutes. */
const joins = (a: P.MessageView, b: P.MessageView) => a.authorId === b.authorId && b.ts - a.ts < 7 * minute && !b.replyToId;

describe('runs', () => {
  test("one person's picture messages one after another are one run, whatever albums they came in", () => {
    const album = msg('ann', 0, { attachments: [att(), att()] });
    const ms = [album, msg('ann', minute), msg('ann', 2 * minute, { body: 'and this one' }), msg('bo', 3 * minute), msg('bo', 4 * minute)];
    const runs = pictureRuns(ms, 0, ms.length, joins);
    expect(runs.get(album.id)).toEqual(ms.slice(0, 3));
    expect(runs.get(ms[3].id)).toEqual(ms.slice(3));
    expect(runs.get(ms[2].id)!.flatMap(picturesOf).length).toBe(4);
  });
  test('broken by words alone, a long pause, a reply, a forward, a sticker or what `joins` refuses', () => {
    const t = (i: number) => i * minute;
    const ms = [
      msg('ann', t(0)),
      msg('ann', t(1), { attachments: [], body: 'words' }),
      msg('ann', t(2)),
      msg('ann', t(20)),
      msg('ann', t(21), { replyToId: 'mx' }),
      msg('ann', t(22), { forward: {} as P.ForwardView }),
      msg('ann', t(23)),
      msg('ann', t(24), { kind: 'sticker' }),
      msg('ann', t(25)),
    ];
    expect(pictureRuns(ms, 0, ms.length, joins).size).toBe(0);
    // Only the drawn ones: a run past the window's edge is cut there.
    const two = [msg('ann', 0), msg('ann', minute), msg('ann', 2 * minute)];
    expect(pictureRuns(two, 1, 3, joins).get(two[1].id)).toEqual(two.slice(1));
    expect(pictureRuns(two, 0, 3, (_a, _b, i) => i !== 2).get(two[0].id)).toEqual(two.slice(0, 2));
  });
  test('a picture is an image or a file whose bytes are one, never a sticker', () => {
    const m = msg('ann', 0);
    expect(isPicture(m, att())).toBe(true);
    expect(isPicture(m, att({ kind: 'file', info: { mime: 'image/png', kind: 'image', size: 1 } }))).toBe(true);
    expect(isPicture(m, att({ kind: 'file' }))).toBe(false);
    expect(isPicture(m, att({ mime: 'application/x-lottie+json' }))).toBe(false);
    expect(isPicture({ ...m, kind: 'sticker' }, att())).toBe(false);
    expect(picturesOf({ ...m, deleted: true })).toEqual([]);
  });
  test('a message that is only its pictures has no row of its own; one with anything else keeps it', () => {
    expect(onlyPictures(msg('ann', 0))).toBe(true);
    expect(onlyPictures(msg('ann', 0, { body: 'hi' }))).toBe(false);
    expect(onlyPictures(msg('ann', 0, { reactions: [{} as P.ReactionView] }))).toBe(false);
    expect(onlyPictures(msg('ann', 0, { attachments: [att({ caption: 'the view' })] }))).toBe(false);
    expect(onlyPictures(msg('ann', 0, { attachments: [att(), att({ kind: 'file', name: 'a.pdf' })] }))).toBe(false);
    expect(onlyPictures(msg('ann', 0, { pinned: true }))).toBe(false);
  });
});

describe('sliding between the ways', () => {
  test('goes from smallest to biggest', () => {
    expect(PICTURE_ORDER).toEqual(['small', 'fold', 'six', 'mosaic', 'rows']);
  });
  test('sticks near each way and lets go past halfway', () => {
    for (let n = 0; n < PICTURE_ORDER.length; n++) expect(slidePosition(n)).toBeCloseTo(n, 9);
    // A quarter of the way moves the drawing much less than a quarter; three quarters, much more than three.
    expect(slidePosition(2.25) - 2).toBeLessThan(0.15);
    expect(slidePosition(2.75) - 2).toBeGreaterThan(0.85);
    expect(slidePosition(2.5)).toBeCloseTo(2.5, 9);
    expect(settleAt(slidePosition(2.4))).toBe('six');
    expect(settleAt(slidePosition(2.6))).toBe('mosaic');
  });
  test('only ever moves the way the fingers do', () => {
    let last = slidePosition(-1);
    for (let r = -1; r <= 5; r += 0.01) {
      const g = slidePosition(r);
      expect(g).toBeGreaterThanOrEqual(last - 1e-12);
      last = g;
    }
  });
  test('gives a little past either end, and settles back on it', () => {
    expect(slidePosition(-3)).toBe(-SLIDE_GIVE);
    expect(slidePosition(9)).toBe(4 + SLIDE_GIVE);
    expect(settleAt(slidePosition(-3))).toBe('small');
    expect(settleAt(slidePosition(9))).toBe('rows');
  });
});
