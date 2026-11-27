/**
 * A file on its way to the hub, drawn as what the hub has of it (docs/uploads.md "How it looks"), in the composer and on
 * a pending message.
 *
 * - A photo is made progressive first (a dither of it sparkles meanwhile), then shows the hub's copy: the picture cut
 *   after the last layer the hub has whole, blurry at first and sharper with every layer, which is exactly what the
 *   hub would send if this phone went away now. The dither stays only until the first whole picture is in.
 * - A video has no usable half: its frame turns from the dither to colour as its bytes reach the hub, with a ring.
 * - Another file: a ring and the size so far.
 *
 * The ring is the hub's count. Amber while the hub is out of reach; a tick once it has all of it.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../format.ts';
import { hubCut, hubQuality, type FileState } from '../sendline.ts';
import { connected } from '../state.ts';
import type { UploadJob } from '../upload.ts';

/** The state of a job, as sendline.ts reads it. */
export function fileState(job: UploadJob): FileState {
  const p = job.progress.value;
  return { status: p.status, sent: p.status === 'done' && !p.cut ? job.size : p.sent, size: job.size, layers: job.packed?.layers ?? null, at: p.at };
}

/** A small ring: how much of it the hub has; spinning while a photo is packed; a tick when all of it is there. */
function Ring({ p, spin, amber, done, size = 16 }: { p: number; spin?: boolean; amber?: boolean; done?: boolean; size?: number }) {
  const r = 6.2;
  const c = 2 * Math.PI * r;
  return (
    <svg class={`up-ring${spin ? ' spin' : ''}${amber ? ' amber' : ''}${done ? ' done' : ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {done ? (
        <path d="M4.2 8.4l2.4 2.4 5.2-5.4" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      ) : (
        <>
          <circle class="up-ring-track" cx="8" cy="8" r={r} fill="none" stroke-width="2.2" />
          <circle cx="8" cy="8" r={r} fill="none" stroke-width="2.2" stroke-linecap="round" stroke-dasharray={`${spin ? c * 0.28 : Math.max(0.01, p) * c} ${c}`} transform="rotate(-90 8 8)" />
        </>
      )}
    </svg>
  );
}

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map((v) => (v + 0.5) / 64);
const bayer = (x: number, y: number) => BAYER[(y & 7) * 8 + (x & 7)];

/**
 * A two-colour dither of the picture over the tile: the part of it still only on this phone. Cells whose threshold is
 * under `reveal` show the picture itself, so the frame turns to colour as the bytes go.
 */
function Dither({ src, video, reveal = 0, sparkle }: { src: string | null; video?: boolean; reveal?: number; sparkle?: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<CanvasImageSource | null>(null);
  useEffect(() => {
    if (!src) return;
    let gone = false;
    if (video) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadeddata = () => !gone && setSource(v);
      v.src = src;
    } else {
      const i = new Image();
      i.decoding = 'async';
      i.onload = () => !gone && setSource(i);
      i.src = src;
    }
    return () => void (gone = true);
  }, [src, video]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(1, Math.round(c.clientWidth * dpr));
    const H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const x = c.getContext('2d');
    if (!x) return;
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue('--accent').trim() || '#7c6cff';
    const ground = css.getPropertyValue('--bg-raised').trim() || '#1d1e26';
    const cell = Math.max(2, Math.round(3 * dpr));
    // The picture at the tile's size, cropped to cover it as the tile does.
    let pic: ImageData | null = null;
    if (source) {
      const sw = (source as HTMLVideoElement).videoWidth || (source as HTMLImageElement).naturalWidth;
      const sh = (source as HTMLVideoElement).videoHeight || (source as HTMLImageElement).naturalHeight;
      const k = Math.max(W / sw, H / sh);
      x.drawImage(source, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
      pic = x.getImageData(0, 0, W, H);
    }
    const px = pic?.data;
    x.fillStyle = ground;
    x.fillRect(0, 0, W, H);
    x.fillStyle = ink;
    for (let y = 0, j = 0; y < H; y += cell, j++)
      for (let i = 0, xx = 0; xx < W; xx += cell, i++) {
        const t = bayer(i, j);
        if (pic && t < reveal) {
          x.putImageData(pic, 0, 0, xx, y, cell, cell);
          continue;
        }
        const o = 4 * (y * W + xx);
        // A file's tile has no picture: a light, even dither.
        const l = px ? (0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2]) / 255 : 0.2;
        if (l > t) x.fillRect(xx, y, cell, cell);
      }
  }, [source, reveal]);
  return <canvas ref={cv} class={`up-dither${sparkle ? ' sparkle' : ''}`} aria-hidden="true" />;
}

/** An object URL for what the hub has of this progressive photo: its bytes up to `end`, closed with an end marker. */
function useHubCopy(file: Blob, end: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (end <= 0) return setUrl(null);
    const b = end >= file.size ? file : new Blob([file.slice(0, end), new Uint8Array([0xff, 0xd9])], { type: 'image/jpeg' });
    const u = URL.createObjectURL(b);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, end]);
  return url;
}

const NO_FILE = new Blob();
const QUALITY_WORD = { preview: 'preview', fair: 'fair', good: 'good', full: '' } as const;

/** A photo or video attached, as a tile: what the hub has of it, and a badge saying how far it is. */
export function UploadTile({ job, url, video, children }: { job?: UploadJob; url: string | null; video?: boolean; children?: JSX.Element | null }) {
  const p = job?.progress.value;
  const st = job ? fileState(job) : null;
  const whole = !st || (p!.status === 'done' && !p!.cut) || p!.status === 'cancelled';
  const offline = !connected.value || (p?.status === 'failed' && !!p.offline);
  const share = st ? Math.min(1, st.sent / (st.size || 1)) : 1;
  const end = st && !video && !whole ? hubCut(st) : 0;
  const hub = useHubCopy(job?.file ?? NO_FILE, job?.packed && end ? end : 0);
  const preview = !!job?.packed && !!hub && end >= (job.packed.layers.preview ?? Infinity);
  const q = st && !video ? hubQuality(st) : null;
  const pct = Math.floor(share * 100);
  const label = !st ? '' : p!.status === 'packing' ? 'packing' : p!.cut ? `sent as ${q ?? 'is'}` : whole ? 'sent' : offline ? (q ? QUALITY_WORD[q] || 'waiting' : 'waiting') : q && QUALITY_WORD[q] ? `${QUALITY_WORD[q]} · ${pct}%` : `${pct}%`;
  const base = video ? <video src={url ?? undefined} muted playsInline preload="metadata" aria-hidden="true" /> : <img src={url ?? undefined} alt="" />;
  return (
    <span class={`up-tile${whole ? ' whole' : ''}`}>
      {/* The file itself, under everything: it gives the tile its shape, and shows once the hub has all of it. */}
      {base}
      {!whole && (video ? <Dither src={url} video reveal={share} /> : preview ? <img class="up-hub" src={hub!} alt="" /> : <Dither src={url} sparkle={p?.status === 'packing'} />)}
      {children}
      {st && !(whole && !p!.cut) && (
        <span class="up-badge" data-quality={q ?? ''}>
          <Ring p={share} spin={p!.status === 'packing'} amber={offline} done={whole || !!p!.cut} />
          <span>{label}</span>
        </span>
      )}
    </span>
  );
}

/** A file that is neither photo nor video: a ring, and how much of it the hub has. */
export function UploadSize({ job }: { job: UploadJob }) {
  const p = job.progress.value;
  const offline = !connected.value || (p.status === 'failed' && !!p.offline);
  const done = p.status === 'done';
  return (
    <span class="up-size">
      <Ring p={job.size ? p.sent / job.size : 0} amber={offline} done={done} size={14} />
      {done ? bytes(job.size) : `${bytes(p.sent)} of ${bytes(job.size)}`}
    </span>
  );
}
