/**
 * Downloading a kept file in the form you pick (docs/files.md "Downloading"). The hub's media links take `?as=`:
 * `original` is the bytes as they came (a picture the hub keeps as JPEG XL, rebuilt), `jxl`, `png` or `jpeg` a
 * picture converted, and `info` what the file is, how the hub keeps it and what this device is sent.
 *
 * A plain media link is what this device shows best, which may be a JPEG XL of a JPEG: saved under the network's
 * name, `photo.jpg` would hold a JPEG XL. So every save goes through `?as=original` (fileopen.tsx save), which the
 * hub names with the right extension.
 */
import { downloadsAs, type DownloadAs } from '@dither-chat/protocol';
import { bytes } from './format.ts';

export { downloadsAs };

/** True for one of the hub's own media links (not a blob:, data: or another site's). */
export function hubMedia(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/media/');
  } catch {
    return false;
  }
}

/** A hub media link asking for `as`, named `name` (the hub gives it the form's extension). */
export function mediaAs(url: string, as: DownloadAs | 'info', name?: string | null): string {
  const u = new URL(url, location.href);
  u.searchParams.set('as', as);
  if (name) u.searchParams.set('name', name);
  return u.pathname + u.search;
}

/** What a menu calls each form. */
const FORM_LABEL: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/jxl': 'JPEG XL',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/heic': 'HEIC',
};
const AS_MIME: Record<Exclude<DownloadAs, 'original'>, string> = { jxl: 'image/jxl', png: 'image/png', jpeg: 'image/jpeg' };

export const formLabel = (mime: string | null | undefined) => FORM_LABEL[(mime ?? '').split(';')[0].trim().toLowerCase()] ?? null;

/** A menu line for downloading as `as`: "Original (JPEG)", "JPEG XL". */
export function asLabel(as: DownloadAs, type: string | null | undefined): string {
  if (as === 'original') {
    const l = formLabel(type);
    return l ? `Original (${l})` : 'Original';
  }
  return FORM_LABEL[AS_MIME[as]];
}

/** The hub's answer to `?as=info`. */
export interface MediaFormat {
  /** What it came as, and its size then (null when not known). */
  type: string;
  size: number | null;
  /** How the hub keeps it. */
  kept: { type: string; size: number };
  /** What a plain fetch of the link sends this device: null when one is made for it (a JPEG XL as a JPEG or PNG). */
  sent: string | null;
  as: DownloadAs[];
}

const asked = new Map<string, Promise<MediaFormat | null>>();

/** `?as=info` for a hub media link, asked once a link while the app is open. */
export function mediaFormat(url: string): Promise<MediaFormat | null> {
  let p = asked.get(url);
  if (!p) {
    p = fetch(mediaAs(url, 'info'), { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<MediaFormat>) : null))
      .catch(() => null);
    // A failure is asked again next time.
    void p.then((r) => r || asked.delete(url));
    asked.set(url, p);
  }
  return p;
}

/**
 * The line under a picture's name: what it came as, how the hub keeps it and what this device was sent, as in
 * "JPEG, 2.1 MB · kept as JPEG XL, 1.4 MB, shown here as JPEG XL".
 */
export function formatLine(f: MediaFormat): string {
  const came = formLabel(f.type) ?? f.type;
  const parts = [f.size != null ? `${came}, ${bytes(f.size)}` : came];
  const kept = f.kept.type !== f.type;
  if (kept) parts.push(`kept as ${formLabel(f.kept.type) ?? f.kept.type}, ${bytes(f.kept.size)}`);
  const shown = f.sent === null ? 'shown here as a JPEG or PNG' : f.sent !== f.type ? `shown here as ${formLabel(f.sent) ?? f.sent}` : kept ? `shown here as ${came}` : null;
  return shown ? `${parts.join(' · ')}, ${shown}` : parts.join(' · ');
}
