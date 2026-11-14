/**
 * Images, full screen. Pinch or double-tap to zoom, drag to pan, swipe sideways between a message's images,
 * swipe down to put it away. With a mouse: the wheel zooms, a double click zooms in, a drag pans, the arrows page,
 * + and - zoom, 0 fits it again, Escape closes.
 *
 * The picture is sized here, to fit the screen, rather than by CSS: in the grid that centres it, max-height: 100% does
 * not hold, so a large photo or a long screenshot was drawn at its own size, cut off, with the zoom and the pan
 * worked out for a fitted picture that was not there. A large picture zooms far enough to see its own pixels twice
 * over, and a long one fills the screen's width at a double tap.
 *
 * Zoomed in, it pans past its edges by up to SLACK of the screen, so its top can come out from under the bar; a pan
 * let go with speed glides on and slows, and the wheel eases to the zoom it asks for rather than jumping there.
 *
 * Other files open here too (docs/files.md): text and code, Markdown, JSON, CSV, PDF and archives, each shown by a
 * viewer in a chunk of its own (files/), loaded when such a file is first opened. On a phone they fill the screen; on a
 * wider screen they open in a box over the app, which a click beside it closes. The header always has Download; with
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
import { Loading } from './Loader.tsx';

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
  // A click beside the box closes it, but not the end of a text selection dragged out of it.
  const pressedOutside = useRef(false);
  return (
    <div
      class="fviewer"
      data-kind={asked ? kind : 'unknown'}
      onPointerDown={(e) => (pressedOutside.current = e.target === e.currentTarget)}
      onClick={(e) => pressedOutside.current && e.target === e.currentTarget && close()}
    >
      <div class="fviewer-card" role="dialog" aria-modal="true" aria-label={name}>
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
  return View ? <View {...p} /> : <Loading fill label="Loading…" />;
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

/** Zoom over the fitted size, at least; a large picture goes further (top()). */
const MAX = 5;
/** How far past its edges a zoomed picture pans, as a share of the screen (reached by 2x, none at 1x). */
const SLACK = 0.4;
/** How fast a glide slows (ms for its speed to fall to a third), and how fast the wheel's zoom catches up. */
const GLIDE_MS = 325;
const EASE_MS = 70;

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
    const el = pic.current;
    const W = innerWidth;
    const H = innerHeight;
    const nw = el?.naturalWidth || img.width || W;
    const nh = el?.naturalHeight || img.height || H;
    const k = Math.min(W / nw, H / nh, 1);
    return { w: nw * k, h: nh * k, W, H, nw };
  };
  /** As far as it zooms: MAX, or to twice the picture's own pixels where that is further. */
  const top = () => {
    const f = fitted();
    return Math.max(MAX, (2 * f.nw) / f.w);
  };
  /** The picture at its fitted size, once its size is known (from the message, else once it loads). */
  const layout = () => {
    const el = pic.current;
    if (!el || !(el.naturalWidth || img.width)) return;
    const f = fitted();
    el.style.width = `${f.w}px`;
    el.style.height = `${f.h}px`;
  };
  /** How far it may be moved each way at zoom `s`: to its edges, and SLACK of the screen past them once zoomed. */
  const bounds = (s: number) => {
    const f = fitted();
    const k = Math.min(1, Math.max(0, s - 1)) * SLACK;
    return { ox: Math.max(0, (f.w * s - f.W) / 2) + k * f.W, oy: Math.max(0, (f.h * s - f.H) / 2) + k * f.H };
  };
  const clamp = (s: number, x: number, y: number) => {
    const { ox, oy } = bounds(s);
    return { s, x: Math.min(ox, Math.max(-ox, x)), y: Math.min(oy, Math.max(-oy, y)) };
  };
  /** One motion at a time on a frame clock (a glide, the wheel's easing): a new one, or a finger, stops the last. */
  const anim = useRef(0);
  const halt = () => {
    cancelAnimationFrame(anim.current);
    anim.current = 0;
  };
  const run = (step: (dt: number) => boolean) => {
    halt();
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      anim.current = step(dt) ? requestAnimationFrame(frame) : 0;
    };
    anim.current = requestAnimationFrame(frame);
  };
  /** Where the wheel is taking the zoom, and about which point. */
  const wheelTo = useRef<{ s: number; px: number; py: number } | null>(null);
  useEffect(() => halt, []);
  const show = (t: { s: number; x: number; y: number }, ms = 0, extra = '') => {
    z.current = t;
    const el = pic.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none';
    el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})${extra}`;
    root.current?.toggleAttribute('data-zoomed', t.s > 1.01);
  };
  /** Zoom to `s`, keeping the screen point (px, py) where it is. */
  const zoomAt = (s: number, px: number, py: number, ms = 0) => {
    const cur = z.current;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const ns = Math.min(top(), Math.max(1, s));
    const x = px - cx - ((px - cx - cur.x) * ns) / cur.s;
    const y = py - cy - ((py - cy - cur.y) * ns) / cur.s;
    show(clamp(ns, x, y), ms);
  };
  const page = (d: number) => {
    const n = i + d;
    if (n < 0 || n >= images.length) return;
    setI(n);
  };
  useLayoutEffect(() => {
    halt();
    wheelTo.current = null;
    layout();
    show({ s: 1, x: 0, y: 0 });
  }, [i]);
  // A turned phone or a resized window: fitted again, the zoom kept within the new edges.
  useEffect(() => {
    const r = () => {
      layout();
      const t = z.current;
      show(clamp(t.s, t.x, t.y));
    };
    addEventListener('resize', r);
    return () => removeEventListener('resize', r);
  }, [i]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') page(-1);
      if (e.key === 'ArrowRight') page(1);
      const ms = reducedMotion() ? 0 : 160;
      if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') {
        halt();
        wheelTo.current = null;
      }
      if (e.key === '+' || e.key === '=') zoomAt(z.current.s * 1.5, innerWidth / 2, innerHeight / 2, ms);
      if (e.key === '-') zoomAt(z.current.s / 1.5, innerWidth / 2, innerHeight / 2, ms);
      if (e.key === '0') show({ s: 1, x: 0, y: 0 }, ms);
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
    /** The wheel's easing is the motion under way (halt() from elsewhere clears wheelTo, which ends it). */
    let easing = false;
    /** A pan's last moves, for the speed it glides on with. */
    let trail: { x: number; y: number; t: number }[] = [];
    let lastTap = { t: 0, x: 0, y: 0 };
    let moved = false;
    let onImage = false;
    const backdrop = (p: number) => el.style.setProperty('--viewer-bg', String(p));
    // A layer of its own only while a finger or the mouse moves it: a picture kept on one is drawn once at its fitted
    // size and blurs as it zooms, so once it stops it is drawn again at the zoom, sharp.
    let still = 0;
    const moving = () => {
      clearTimeout(still);
      if (pic.current) pic.current.style.willChange = 'transform';
    };
    const stopped = () => {
      clearTimeout(still);
      still = window.setTimeout(() => pic.current && (pic.current.style.willChange = ''), 260);
    };
    /** After a pinch or a pan: back within the zoom limits and the edges (with their slack). */
    const settle = () => {
      const t = z.current;
      const ms = reducedMotion() ? 0 : 200;
      const most = top();
      if (t.s < 1) show({ s: 1, x: 0, y: 0 }, ms);
      else if (t.s > most) {
        const k = most / t.s;
        show(clamp(most, t.x * k, t.y * k), ms);
      } else show(clamp(t.s, t.x, t.y), ms);
    };

    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.viewer-bar, .viewer-nav')) return;
      el.setPointerCapture(e.pointerId);
      halt();
      wheelTo.current = null;
      moving();
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
        trail = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
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
        const s = Math.min(top() * 1.3, Math.max(0.6, (base.s * d) / pinch0.d));
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
      if (mode === 'pan') {
        trail.push({ x: e.clientX, y: e.clientY, t: now });
        while (trail.length > 2 && now - trail[0].t > 100) trail.shift();
        // Past the edges' slack it still follows, at a third of the finger's pace; the release brings it back.
        const { ox, oy } = bounds(base.s);
        const give = (v: number, o: number) => (Math.abs(v) <= o ? v : Math.sign(v) * (o + (Math.abs(v) - o) / 3));
        show({ s: base.s, x: give(base.x + dx, ox), y: give(base.y + dy, oy) });
      }
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
        stopped();
        mode = null;
        return;
      }
      if (pts.size) return;
      stopped();
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const motion = reducedMotion();
      if (mode === 'pan') {
        // Let go with speed: it glides on, slowing, and stops at the edges' slack.
        const a = trail[0];
        const b = trail[trail.length - 1];
        const gap = b && a && b.t - a.t > 0 && performance.now() - b.t < 80 ? b.t - a.t : 0;
        let vx = gap ? (b.x - a.x) / gap : 0;
        let vy = gap ? (b.y - a.y) / gap : 0;
        const t0 = z.current;
        const inside = clamp(t0.s, t0.x, t0.y);
        if (motion || Math.hypot(vx, vy) < 0.15 || inside.x !== t0.x || inside.y !== t0.y) settle();
        else {
          moving();
          run((dt) => {
            const t = z.current;
            const next = clamp(t.s, t.x + vx * dt, t.y + vy * dt);
            if (next.x !== t.x + vx * dt) vx = 0;
            if (next.y !== t.y + vy * dt) vy = 0;
            const k = Math.exp(-dt / GLIDE_MS);
            vx *= k;
            vy *= k;
            show(next);
            const on = Math.hypot(vx, vy) > 0.02;
            if (!on) stopped();
            return on;
          });
        }
      } else if (mode === 'dismiss') {
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
          else {
            // A long screenshot or a wide panorama fills the screen the other way; anything else zooms 2.5 times.
            const f = fitted();
            const fill = Math.max(f.W / f.w, f.H / f.h);
            zoomAt(fill > 1.25 ? fill : 2.5, e.clientX, e.clientY, motion ? 0 : 220);
          }
          lastTap = { t: 0, x: 0, y: 0 };
        } else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      mode = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // A trackpad's pinch comes as the wheel with Ctrl held, in small steps: it zooms faster per step. Lines and
      // pages (Firefox's wheel) count as 40 px a line.
      const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1);
      const from = wheelTo.current?.s ?? z.current.s;
      const s = Math.min(top(), Math.max(1, from * Math.exp(-dy / (e.ctrlKey ? 100 : 300))));
      wheelTo.current = { s, px: e.clientX, py: e.clientY };
      if (reducedMotion()) {
        wheelTo.current = null;
        return zoomAt(s, e.clientX, e.clientY);
      }
      moving();
      // Already easing: it eases to the new target. A glide under way gives way to the wheel.
      if (easing && anim.current) return;
      easing = true;
      run((dt) => {
        const to = wheelTo.current;
        if (!to) return (easing = false);
        const cur = z.current.s;
        const near = Math.abs(to.s / cur - 1) < 0.002;
        zoomAt(near ? to.s : cur + (to.s - cur) * (1 - Math.exp(-dt / EASE_MS)), to.px, to.py);
        if (near) {
          wheelTo.current = null;
          easing = false;
          stopped();
        }
        return !near;
      });
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
      clearTimeout(still);
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
      <img ref={pic} class="viewer-img" src={img.url} alt={img.name ?? ''} draggable={false} onLoad={() => {
        layout();
        const t = z.current;
        show(clamp(t.s, t.x, t.y));
      }} />
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
