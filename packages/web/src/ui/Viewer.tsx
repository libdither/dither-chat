/**
 * Images, full screen. Pinch or double-tap to zoom, drag to pan, swipe sideways between a message's images,
 * swipe down to put it away. With a mouse: the wheel zooms, the arrows page, Escape closes.
 *
 * Other files open here too (docs/files.md): text and code, Markdown, JSON, CSV, PDF and archives, each shown by a
 * viewer in a chunk of its own (files/), loaded when such a file is first opened. The header always has Download; with
 * the desktop helper or the Android app it can open the file in an app as well.
 */
import { signal } from '@preact/signals';
import type { FunctionComponent } from 'preact';
import type * as P from '@dither-chat/protocol';
import { languageOf } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { android } from '../android.ts';
import { desk } from '../desk.ts';
import { fileFacts, fileIcon, fileKind, fileMime, fileViewer, type FileSource } from '../files.ts';
import { commits, lockAxis, settleMs, velocity } from '../gesture.ts';
import { reducedMotion, useLayer } from '../phone.ts';
import { api } from '../state.ts';
import { openAttachment, openWith } from './fileopen.tsx';
import { Icon } from './icons.tsx';

export interface ViewerImage {
  url: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
}
export const viewer = signal<{ images: ViewerImage[]; index: number } | null>(null);

export function Viewer() {
  const v = viewer.value;
  const f = fileViewer.value;
  if (v) return <ViewerBox images={v.images} start={v.index} />;
  return f ? <FileBox key={f.att.url} att={f.att} /> : null;
}

/** What each file viewer gets. */
export interface FileViewProps {
  att: FileSource;
  info: P.FileInfo | null;
  kind: P.FileKind;
  /** For highlighting: what the hub found, else by the name. */
  language: string | null;
}
type FileView = FunctionComponent<FileViewProps>;

const VIEWS: Partial<Record<P.FileKind, () => Promise<{ default: FileView }>>> = {
  text: () => import('./files/TextView.tsx'),
  markdown: () => import('./files/MarkdownView.tsx'),
  json: () => import('./files/JsonView.tsx'),
  csv: () => import('./files/TableView.tsx'),
  pdf: () => import('./files/PdfView.tsx'),
  archive: () => import('./files/ArchiveView.tsx'),
};
const loadedViews = new Map<P.FileKind, FileView>();

function FileBox({ att }: { att: FileSource }) {
  const close = () => (fileViewer.value = null);
  useLayer(close);
  // Not looked at by the hub yet: it looks now (its infoUrl), and the viewer waits for the answer.
  const [info, setInfo] = useState<P.FileInfo | null>(att.info ?? null);
  const [asked, setAsked] = useState(!!att.info || !att.infoUrl);
  useEffect(() => {
    if (att.info || !att.infoUrl) return;
    let live = true;
    api<P.FileInfo>(att.infoUrl)
      .then((i) => live && setInfo(i))
      .catch(() => {})
      .finally(() => live && setAsked(true));
    return () => {
      live = false;
    };
  }, [att.infoUrl]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const a = { ...att, info: info ?? undefined };
  const kind = fileKind(a);
  // The bytes are a picture after all: the image viewer shows it.
  useEffect(() => {
    if (asked && kind === 'image') {
      fileViewer.value = null;
      viewer.value = { images: [{ url: att.url, name: att.name, width: info?.width, height: info?.height }], index: 0 };
    }
  }, [asked, kind]);
  const name = att.name ?? 'file';
  const apps = !!desk.value?.files || !!android?.opensFiles();
  return (
    <div class="fviewer" role="dialog" aria-modal="true" aria-label={name} data-kind={asked ? kind : 'unknown'}>
      <div class="fviewer-bar">
        <Icon name={fileIcon(kind, info?.language)} size={20} />
        <span class="fviewer-name">
          <b title={name}>{name}</b>
          <small>{fileFacts(a)}</small>
        </span>
        {apps && (
          <button class="icon-btn" onClick={() => openAttachment(a)} aria-label="Open File" title="Open in its app">
            <Icon name="external" size={20} />
          </button>
        )}
        {!!desk.value && !!fileMime(a) && (
          <button class="icon-btn fviewer-with" onClick={() => void openWith(a)} aria-label="Open With…" title="Open with another app">
            <Icon name="more" size={20} />
          </button>
        )}
        <a class="icon-btn" href={att.url} download={name} aria-label="Download" title="Download">
          <Icon name="download" size={20} />
        </a>
        <button class="icon-btn" onClick={close} aria-label="Close" title="Close">
          <Icon name="x" size={22} />
        </button>
      </div>
      <div class="fviewer-body">{!asked ? (
          <div class="fv-wait">Looking at the file…</div>
        ) : VIEWS[kind] ? (
          <FileBody kind={kind} att={a} info={info} language={info?.language ?? languageOf(att.name)} />
        ) : kind === 'video' ? (
          <video class="fv-media" src={att.url} controls preload="metadata" />
        ) : kind === 'audio' ? (
          <audio class="fv-media" src={att.url} controls preload="metadata" />
        ) : (
          <NoView a={a} />
        )}</div>
    </div>
  );
}

function FileBody(p: FileViewProps) {
  const [View, setView] = useState<FileView | null>(() => loadedViews.get(p.kind) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const have = loadedViews.get(p.kind);
    if (have) return setView(() => have);
    let live = true;
    VIEWS[p.kind]!()
      .then((m) => {
        loadedViews.set(p.kind, m.default);
        if (live) setView(() => m.default);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [p.kind]);
  if (failed) return <div class="fv-wait">Could not load the viewer. Check the connection to the hub, then try again.</div>;
  return View ? <View {...p} /> : <div class="fv-wait">Loading…</div>;
}

/** A type with no viewer here. */
function NoView({ a }: { a: FileSource }) {
  return (
    <div class="fv-none">
      <Icon name="file" size={40} />
      <p>There is no preview for this kind of file.</p>
      <p>
        <a href={a.url} download={a.name ?? true}>
          Download it
        </a>
        {(desk.value?.files || android?.opensFiles()) && (
          <>
            {' or '}
            <button class="link" onClick={() => openAttachment(a)}>
              open it in its app
            </button>
          </>
        )}
        .
      </p>
    </div>
  );
}

const MAX = 5;

function ViewerBox({ images, start }: { images: ViewerImage[]; start: number }) {
  const [i, setI] = useState(start);
  const img = images[i];
  const root = useRef<HTMLDivElement>(null);
  const pic = useRef<HTMLImageElement>(null);
  // Zoom and pan, kept out of state so a finger moves the image without a render.
  const z = useRef({ s: 1, x: 0, y: 0 });
  const close = () => (viewer.value = null);
  useLayer(close);

  const fitted = () => {
    const el = pic.current!;
    const W = innerWidth;
    const H = innerHeight;
    const nw = el.naturalWidth || img.width || W;
    const nh = el.naturalHeight || img.height || H;
    const k = Math.min(W / nw, H / nh, 1);
    return { w: nw * k, h: nh * k, W, H };
  };
  const clamp = (s: number, x: number, y: number) => {
    const f = fitted();
    const ox = Math.max(0, (f.w * s - f.W) / 2);
    const oy = Math.max(0, (f.h * s - f.H) / 2);
    return { s, x: Math.min(ox, Math.max(-ox, x)), y: Math.min(oy, Math.max(-oy, y)) };
  };
  const show = (t: { s: number; x: number; y: number }, ms = 0, extra = '') => {
    z.current = t;
    const el = pic.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none';
    el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})${extra}`;
  };
  /** Zoom to `s`, keeping the screen point (px, py) where it is. */
  const zoomAt = (s: number, px: number, py: number, ms = 0) => {
    const cur = z.current;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const ns = Math.min(MAX, Math.max(1, s));
    const x = px - cx - ((px - cx - cur.x) * ns) / cur.s;
    const y = py - cy - ((py - cy - cur.y) * ns) / cur.s;
    show(clamp(ns, x, y), ms);
  };
  const page = (d: number) => {
    const n = i + d;
    if (n < 0 || n >= images.length) return;
    setI(n);
  };
  useLayoutEffect(() => show({ s: 1, x: 0, y: 0 }), [i]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') page(-1);
      if (e.key === 'ArrowRight') page(1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [i]);

  useEffect(() => {
    const el = root.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let mode: null | 'pan' | 'pinch' | 'dismiss' | 'page' = null;
    let start = { x: 0, y: 0 };
    let base = z.current;
    let pinch0 = { d: 1, mx: 0, my: 0 };
    let samples: { x: number; t: number }[] = [];
    let lastTap = { t: 0, x: 0, y: 0 };
    let moved = false;
    let onImage = false;
    const backdrop = (p: number) => el.style.setProperty('--viewer-bg', String(p));
    /** After a pinch or a pan: back within the zoom limits, and no empty space at the edges. */
    const settle = () => {
      const t = z.current;
      const ms = reducedMotion() ? 0 : 200;
      if (t.s < 1) show({ s: 1, x: 0, y: 0 }, ms);
      else if (t.s > MAX) {
        const k = MAX / t.s;
        show(clamp(MAX, t.x * k, t.y * k), ms);
      } else show(clamp(t.s, t.x, t.y), ms);
    };

    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.viewer-bar, .viewer-nav')) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      base = z.current;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        mode = 'pinch';
      } else if (pts.size === 1) {
        start = { x: e.clientX, y: e.clientY };
        mode = null;
        moved = false;
        onImage = e.target === pic.current;
        samples = [{ x: e.clientY, t: performance.now() }];
      }
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Follow the fingers freely, a little past the limits; the release brings it back in.
        const s = Math.min(MAX * 1.3, Math.max(0.6, (base.s * d) / pinch0.d));
        const cx = innerWidth / 2;
        const cy = innerHeight / 2;
        show({ s, x: mx - cx - ((pinch0.mx - cx - base.x) * s) / base.s, y: my - cy - ((pinch0.my - cy - base.y) * s) / base.s });
        moved = true;
        return;
      }
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!mode) {
        const axis = lockAxis(dx, dy, 6);
        if (!axis) return;
        moved = true;
        mode = base.s > 1.01 ? 'pan' : axis === 'y' ? 'dismiss' : images.length > 1 ? 'page' : 'dismiss';
      }
      const now = performance.now();
      if (mode === 'pan') show({ s: base.s, x: base.x + dx, y: base.y + dy });
      else if (mode === 'dismiss') {
        samples.push({ x: e.clientY, t: now });
        if (samples.length > 5) samples.shift();
        show({ s: 1, x: dx * 0.3, y: dy }, 0, ` scale(${Math.max(0.7, 1 - Math.abs(dy) / 1200)})`);
        backdrop(Math.max(0, 1 - Math.abs(dy) / 400));
      } else if (mode === 'page') {
        samples.push({ x: e.clientX, t: now });
        if (samples.length > 5) samples.shift();
        const edge = (dx > 0 && i === 0) || (dx < 0 && i === images.length - 1);
        show({ s: 1, x: edge ? dx / 3 : dx, y: 0 });
      }
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (mode === 'pinch') {
        if (pts.size === 1) {
          // One finger left: carry on as a pan from here.
          const [p] = [...pts.values()];
          start = p;
          base = z.current;
          mode = 'pan';
          return;
        }
        settle();
        mode = null;
        return;
      }
      if (pts.size) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const motion = reducedMotion();
      if (mode === 'pan') settle();
      else if (mode === 'dismiss') {
        const v = velocity(samples);
        if (Math.abs(dy) > 120 || Math.abs(v) > 0.6) {
          const ms = motion ? 0 : settleMs(innerHeight - Math.abs(dy), v, 220);
          show({ s: 1, x: dx * 0.3, y: Math.sign(dy || v) * innerHeight }, ms);
          backdrop(0);
          setTimeout(close, ms);
        } else {
          show({ s: 1, x: 0, y: 0 }, motion ? 0 : 200);
          backdrop(1);
        }
      } else if (mode === 'page') {
        const v = velocity(samples);
        const d = dx < 0 ? 1 : -1;
        const can = i + d >= 0 && i + d < images.length;
        if (can && commits(0, -d * innerWidth, dx, v)) {
          const ms = motion ? 0 : settleMs(innerWidth - Math.abs(dx), v, 220);
          show({ s: 1, x: -d * innerWidth, y: 0 }, ms);
          setTimeout(() => page(d), ms);
        } else show({ s: 1, x: 0, y: 0 }, motion ? 0 : 200);
      } else if (!moved && e.pointerType === 'mouse' && !onImage) close();
      else if (!moved) {
        // A tap. Two quick ones zoom in on that spot, or back out.
        const now = performance.now();
        if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          if (z.current.s > 1.01) show({ s: 1, x: 0, y: 0 }, motion ? 0 : 220);
          else zoomAt(2.5, e.clientX, e.clientY, motion ? 0 : 220);
          lastTap = { t: 0, x: 0, y: 0 };
        } else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      mode = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(z.current.s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [i]);

  return (
    <div class="viewer" ref={root} role="dialog" aria-modal="true" aria-label={img.name ?? 'Image'}>
      <div class="viewer-bar">
        <span class="viewer-name">
          {img.name ?? 'Image'}
          {images.length > 1 && <small>{` ${i + 1} of ${images.length}`}</small>}
        </span>
        <a class="icon-btn" href={img.url} target="_blank" rel="noreferrer" download={img.name ?? true} aria-label="Open the original" title="Open the original">
          <Icon name="download" size={20} />
        </a>
        <button class="icon-btn" onClick={close} aria-label="Close" title="Close">
          <Icon name="x" size={22} />
        </button>
      </div>
      <img ref={pic} class="viewer-img" src={img.url} alt={img.name ?? ''} draggable={false} />
      {images.length > 1 && i > 0 && (
        <button class="viewer-nav prev" onClick={() => page(-1)} aria-label="Previous image">
          <Icon name="back" size={22} />
        </button>
      )}
      {images.length > 1 && i < images.length - 1 && (
        <button class="viewer-nav next" onClick={() => page(1)} aria-label="Next image">
          <Icon name="chevronRight" size={22} />
        </button>
      )}
    </div>
  );
}
