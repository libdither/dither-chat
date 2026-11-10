/**
 * The pure parts of attaching on a phone (ui/Attach.tsx, docs/uploads.md): which camera a flip goes to, what a
 * recording is saved as, what a photo is called, and which picked files open the send screen.
 */

/** A press of the shutter held this long records a video instead of taking a photo. */
export const HOLD_MS = 350;

/** What the photos button lets you pick, and what the camera's fallback asks the system for. */
export const MEDIA_ACCEPT = 'image/*,video/*';
export const CAPTURE_ACCEPT = 'image/*';

export interface Cam {
  id: string;
  /** From the device's capabilities where the browser says (`user`, `environment`); empty where it does not. */
  facing: string[];
}

/**
 * The camera a flip goes to from `current`: one facing the other way where the devices say which way they face (a
 * phone with three cameras on the back flips to the front, not to the next back one), else the next in the list.
 * None when there is only one camera.
 */
export function nextCamera(cams: Cam[], current: string | undefined): string | undefined {
  if (cams.length < 2) return undefined;
  const at = cams.findIndex((c) => c.id === current);
  const cur = cams[at];
  if (cur?.facing.length) {
    const want = cur.facing.includes('user') ? 'environment' : 'user';
    const other = cams.find((c) => c.id !== current && c.facing.includes(want));
    if (other) return other.id;
  }
  return cams[(at + 1) % cams.length].id;
}

/** The type a held shutter records as: MP4 where the browser can (every network plays it), else WebM. */
export function recorderType(supported: (type: string) => boolean): string | undefined {
  return ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(supported);
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
export const photoName = (d: Date) => `photo-${stamp(d)}.jpg`;
/** `type` as recorded, parameters and all. */
export const videoName = (d: Date, type: string) => `video-${stamp(d)}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
/** A recording's type without its codecs, as the file says it. */
export const baseType = (type: string) => type.split(';')[0].trim();

export const isMedia = (f: { type: string }) => f.type.startsWith('image/') || f.type.startsWith('video/');

/** Picked files open the send screen when any of them is a photo or a video, as Signal's gallery does. */
export const opensSendScreen = (files: { type: string }[]) => files.some(isMedia);

/** "1:05" for a recording's length so far. */
export const clockOf = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
