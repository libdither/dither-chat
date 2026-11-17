/**
 * Where a picture sits in the picture editor's square frame (ui/PictureEditor.tsx): its zoom (1: the short side fills
 * the frame) and its top-left corner in frame pixels, kept so the frame is always covered; and the square of the
 * picture's own pixels the frame shows, which is what gets sent.
 */

interface Size {
  w: number;
  h: number;
}

export interface Place {
  zoom: number;
  x: number;
  y: number;
}

export const MAX_ZOOM = 8;

/** Picture pixels to frame pixels at zoom 1. */
export const cover = (p: Size, frame: number) => frame / Math.min(p.w, p.h);

/** The picture can't be zoomed out past filling the frame, or dragged so far that an edge shows. */
export function clamp(p: Size, frame: number, at: Place): Place {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, at.zoom));
  const s = cover(p, frame) * zoom;
  return { zoom, x: Math.min(0, Math.max(frame - p.w * s, at.x)), y: Math.min(0, Math.max(frame - p.h * s, at.y)) };
}

export function centred(p: Size, frame: number): Place {
  const s = cover(p, frame);
  return { zoom: 1, x: (frame - p.w * s) / 2, y: (frame - p.h * s) / 2 };
}

/** Zoomed to `zoom` about the frame point (cx, cy), which stays over the same spot of the picture where it can. */
export function zoomAbout(p: Size, frame: number, at: Place, zoom: number, cx: number, cy: number): Place {
  const z = Math.min(MAX_ZOOM, Math.max(1, zoom));
  const k = z / at.zoom;
  return clamp(p, frame, { zoom: z, x: cx - (cx - at.x) * k, y: cy - (cy - at.y) * k });
}

/** The square of the picture's pixels in the frame, and the size to send it at: at most 1024, at least 128. */
export function cropRect(p: Size, frame: number, at: Place): { sx: number; sy: number; side: number; out: number } {
  const s = cover(p, frame) * at.zoom;
  const side = frame / s;
  return { sx: Math.max(0, -at.x / s), sy: Math.max(0, -at.y / s), side, out: Math.max(128, Math.min(1024, Math.round(side))) };
}
