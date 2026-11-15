/**
 * Pictures in a chat (docs/pictures.md): which messages' pictures make one run, how big a picture drawn on its own
 * is, and how a mosaic splits into rows. What a run looks like is ui/Pictures.tsx; which way a chat draws them is
 * arrange.ts (pictureLayout).
 */
import type * as P from '@dither-chat/protocol';
import { isSticker } from './ui/Sticker.tsx';

/** One picture of a run: the attachment, its message and its place among the message's attachments. */
export interface PictureRef {
  a: P.AttachmentView;
  m: P.MessageView;
  i: number;
}

/** Shown as a picture: an image, or a file whose bytes are one (files.ts); never a sticker. */
export const isPicture = (m: P.MessageView, a: P.AttachmentView) => !isSticker(m, a) && (a.kind === 'image' || (a.kind === 'file' && a.info?.kind === 'image'));

export const picturesOf = (m: P.MessageView): PictureRef[] => (m.deleted ? [] : m.attachments.flatMap((a, i) => (isPicture(m, a) ? [{ a, m, i }] : [])));

/**
 * Runs among the drawn messages `from`..`to`: one person's messages with pictures one after another, each joining
 * the one before when `joins` says so (the timeline's grouping, and no New line between). A forward keeps its
 * pictures in its card. Only runs of two or more messages are listed: each of their messages maps to the run, in
 * order, and the last one draws all of its pictures.
 */
export function pictureRuns(msgs: readonly P.MessageView[], from: number, to: number, joins: (prev: P.MessageView, m: P.MessageView, i: number) => boolean): Map<string, P.MessageView[]> {
  const out = new Map<string, P.MessageView[]>();
  let run: P.MessageView[] = [];
  const close = () => {
    if (run.length > 1) for (const x of run) out.set(x.id, run);
    run = [];
  };
  for (let i = from; i < to; i++) {
    const m = msgs[i];
    if (m.forward || !picturesOf(m).length) {
      close();
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && prev === msgs[i - 1] && joins(prev, m, i)) run.push(m);
    else {
      close();
      run = [m];
    }
  }
  close();
  return out;
}

/**
 * A message of a run that is only its pictures: nothing else of it to draw (no words, reactions, thread, marks), so
 * its row is left out and the run's block stands for it.
 */
export const onlyPictures = (m: P.MessageView) =>
  !m.body.trim() &&
  !m.deleted &&
  !m.forward &&
  !m.poll &&
  !m.contacts?.length &&
  !m.embeds.length &&
  !m.reactions.length &&
  !m.threadId &&
  !m.replyToId &&
  !m.quote &&
  !m.rich &&
  !m.storyReply &&
  !m.failed?.length &&
  !m.missingAttachments?.length &&
  !m.editedTs &&
  !m.edits &&
  !m.pinned &&
  !m.encryptionWarning &&
  !m.feed &&
  !m.post &&
  m.attachments.every((a) => isPicture(m, a) && !a.caption && !a.voiceNote);

/** A picture on its own: at most this wide and high, never enlarged; a long one keeps minW, a strip minH. */
const PICTURE_BOX = { w: 560, h: 480, minW: 200, minH: 64 };

/**
 * The box a picture of w x h is drawn in on its own. It fits inside PICTURE_BOX whole, unless that would make it
 * narrower than minW (a long screenshot: it keeps minW and shows its top, `crop` 'long') or lower than minH (a strip:
 * it keeps minH and its middle, 'wide').
 */
export function fitPicture(w: number, h: number): { w: number; h: number; crop: 'long' | 'wide' | null } {
  const { w: maxW, h: maxH, minW, minH } = PICTURE_BOX;
  const s = Math.min(1, maxW / w, maxH / h);
  let bw = w * s;
  let bh = h * s;
  let crop: 'long' | 'wide' | null = null;
  if (bw < minW && w >= minW) {
    bw = minW;
    const full = (h * minW) / w;
    bh = Math.min(full, maxH);
    if (full > maxH + 0.5) crop = 'long';
  } else if (bh < minH && h >= minH) {
    bh = minH;
    const full = (w * minH) / h;
    bw = Math.min(full, maxW);
    if (full > maxW + 0.5) crop = 'wide';
  }
  return { w: Math.round(bw), h: Math.round(bh), crop };
}

/**
 * How many tiles each row of a mosaic of n holds: one or two on a row of their own, three as one over two, then rows
 * of three, the first rows two where three don't come out even.
 */
export function mosaicRows(n: number): number[] {
  if (n <= 2) return [n];
  if (n === 3) return [1, 2];
  const rows = Math.ceil(n / 3);
  const out: number[] = Array(rows).fill(3);
  for (let k = 0, extra = rows * 3 - n; extra > 0; k++, extra--) out[k] = 2;
  return out;
}

/** A tile's shape in a mosaic row of `k`: the picture's own, kept within bounds so no tile is a sliver. */
export const tileAspect = (aspect: number, k: number) => (k === 1 ? Math.min(2.4, Math.max(1.25, aspect)) : Math.min(1.8, Math.max(0.6, aspect)));
