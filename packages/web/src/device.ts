/**
 * The phone's own photos and files, for the message box's panel (ui/panel/, docs/uploads.md "The panel"). Only in the
 * Android app (apps/android Device.kt): it lists them over the bridge and serves their bytes at a private address
 * under the hub's origin. Elsewhere `device()` is null and the panel offers the hub's files and the system pickers.
 */
import { android } from './android.ts';

export interface DeviceMedia {
  /** `i<id>` or `v<id>`: MediaStore's. */
  id: string;
  kind: 'image' | 'video';
  name: string;
  mime: string | null;
  size: number;
  w: number;
  h: number;
  /** A video's length. */
  ms: number;
  at: number;
}

export interface DeviceAlbum {
  id: string;
  name: string;
  count: number;
  cover: string;
}

export interface DeviceFile {
  name: string;
  /** Under the phone's shared storage ("Download/lease.pdf"). */
  path: string;
  dir: boolean;
  at: number;
  size?: number;
  mime?: string | null;
  /** A folder's visible entries. */
  count?: number;
}

/** What the app lets the page read, or null where there is no app (or an older one). */
export function device() {
  const d = android?.info.value?.device;
  return d && android!.info.value!.opens.includes('device') ? d : null;
}

const base = () => `/__device/${device()?.token}`;
export const thumbUrl = (id: string) => `${base()}/media/${id}/thumb`;
const mediaUrl = (id: string) => `${base()}/media/${id}`;
const fileUrl = (path: string) => `${base()}/file?path=${encodeURIComponent(path)}`;

export function listMedia(o: { album?: string | null; before?: string | null; limit?: number }) {
  return android!.request<{ access: 'all' | 'partial' | 'none'; items: DeviceMedia[]; next: string | null; albums?: DeviceAlbum[] }>({ t: 'device.media', album: o.album ?? '', before: o.before ?? '', limit: o.limit ?? 60 });
}

export function listFiles(o: { path?: string; q?: string; recent?: boolean }) {
  return android!.request<{ access: boolean; path: string; entries: DeviceFile[]; error?: string }>({ t: 'device.files', path: o.path ?? '', q: o.q ?? '', recent: !!o.recent });
}

/** Android's question for the gallery (all, or the ones picked); asked again, it changes the pick. */
export const askMediaAccess = () => android?.send({ t: 'device.mediaAccess' });
/** Settings' "All files access" switch for this app; the page hears on return (android.ts info). */
export const askFilesAccess = () => android?.send({ t: 'device.filesAccess' });

/** Any same-origin file (the phone's through the app, or one the hub keeps) as a File to attach. */
export async function asFile(url: string, name: string, mime?: string | null): Promise<File> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Could not read ${name}`);
  const b = await r.blob();
  return new File([b], name, { type: mime || b.type || 'application/octet-stream' });
}

export const mediaFile = (m: DeviceMedia) => asFile(mediaUrl(m.id), m.name, m.mime);
export const deviceFile = (f: DeviceFile) => asFile(fileUrl(f.path), f.name, f.mime);
