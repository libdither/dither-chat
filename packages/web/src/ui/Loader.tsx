/**
 * Loading, in the logo's own terms: the dithered sphere (icons.tsx DitherMark) with its light going round it, redrawn
 * through the same 4×4 Bayer matrix, so the dots shimmer across it like a planet turning. It dithers in from nothing,
 * cell by cell in Bayer order. Used while the app starts (and by index.html before the script runs: the same sphere,
 * still), and for anything that takes longer than a moment.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Finer than the 12-cell mark, so the light's edge reads as a gradient. */
const N = 16;
const FRAMES = 36;

/** One frame: the lit cells for a light at `angle`, with only cells below `reveal` (0…16) of the matrix shown. */
function frame(angle: number, reveal = 16): string {
  // The light orbits a little in front of the sphere, from the top left round.
  const L = [Math.cos(angle) * 0.8, Math.sin(angle) * 0.8, 0.6];
  let d = '';
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const nx = (x + 0.5 - N / 2) / (N / 2);
      const ny = (y + 0.5 - N / 2) / (N / 2);
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) continue;
      const nz = Math.sqrt(1 - r2);
      const lit = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const b = BAYER[(y % 4) * 4 + (x % 4)];
      // As DitherMark: a cell is drawn where it is lit enough; a little light everywhere keeps the outline.
      const bright = 0.08 + 0.92 * lit ** 1.6;
      if (b >= reveal || bright * 16 <= b) continue;
      d += `M${x} ${y}h1v1h-1z`;
    }
  return d;
}

let frames: string[] | null = null;
const allFrames = () => (frames ??= Array.from({ length: FRAMES }, (_, i) => frame(-Math.PI * 0.75 + (i / FRAMES) * Math.PI * 2)));

/** index.html drew the first frame already: carry on from it rather than dithering in again. */
const drawnByPage = typeof document !== 'undefined' && !!document.getElementById('boot-static');

export function DitherOrb({ size = 88, class: cls, appear = true }: { size?: number; class?: string; appear?: boolean }) {
  const path = useRef<SVGPathElement>(null);
  useEffect(() => {
    const p = path.current;
    if (!p) return;
    const fs = allFrames();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return void p.setAttribute('d', fs[0]);
    const start = performance.now();
    let raf = 0;
    let last = -1;
    const tick = (now: number) => {
      // A frame's time can be from just before the effect ran: below zero, the frame index was too, and `d` undefined.
      const t = Math.max(0, now - start);
      // About 12 frames a second, a little coarse on purpose; the first 600 ms dither it in.
      const i = Math.floor(t / 85) % FRAMES;
      const reveal = appear ? Math.min(16, Math.floor((t / 600) * 16) + 1) : 16;
      const key = i * 17 + reveal;
      if (key !== last) {
        last = key;
        p.setAttribute('d', reveal < 16 ? frame(-Math.PI * 0.75 + (i / FRAMES) * Math.PI * 2, reveal) : fs[i]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <svg class={`dither-orb ${cls ?? ''}`} width={size} height={size} viewBox={`0 0 ${N} ${N}`} shape-rendering="crispEdges" aria-hidden="true">
      <path ref={path} fill="currentColor" />
    </svg>
  );
}

/** The whole-screen start: the orb, what it is waiting for, and after a while what to try. */
export function BootScreen({ status, slow }: { status: string; slow?: string | null }) {
  return (
    <div class="boot-screen" role="status" aria-live="polite">
      <DitherOrb size={88} appear={!drawnByPage} />
      <div class="boot-text">
        <div class="boot-status">{status}</div>
        {slow && <div class="boot-slow">{slow}</div>}
      </div>
    </div>
  );
}

/** The start screen while the app connects and loads, with a hint once it has taken a while. */
export function Boot({ connected }: { connected: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  return (
    <BootScreen
      status={connected ? 'Loading your conversations…' : 'Connecting to your hub…'}
      slow={slow ? (connected ? 'A big first sync takes a moment.' : 'Still trying. Is the hub running, and is this device on its network?') : null}
    />
  );
}
