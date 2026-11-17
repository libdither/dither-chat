/**
 * How a chat shows pictures (docs/pictures.md). One person's pictures sent one after another, in one message or in
 * several, are one run, and a run is drawn one of these ways. Chosen for every chat (ArrangeSettings.pictures) and
 * per chat or server (PlacePrefView.pictures), which wins.
 *
 * - mosaic: every picture, as tiles of one block, cropped to fit their rows.
 * - rows: every picture whole, in rows of the same height.
 * - six: the mosaic, at most six tiles; the sixth says how many more and opens the viewer.
 * - fold: the first picture full size; the rest folded into a line of thumbnails, opened with a click.
 * - small: every picture as a small thumbnail.
 */
export type PictureLayout = 'mosaic' | 'rows' | 'six' | 'fold' | 'small';
export const PICTURE_LAYOUTS: readonly PictureLayout[] = ['six', 'mosaic', 'rows', 'fold', 'small'];
export const DEFAULT_PICTURE_LAYOUT: PictureLayout = 'six';
export const isPictureLayout = (v: unknown): v is PictureLayout => typeof v === 'string' && (PICTURE_LAYOUTS as readonly string[]).includes(v);
