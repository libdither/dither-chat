/**
 * Loading, in the logo's own terms: the dithered sphere (icons.tsx DitherMark) with its light going round it, redrawn
 * through the same 4×4 Bayer matrix, so the dots shimmer across it like a planet turning. It dithers in from nothing,
 * cell by cell in Bayer order. Used while the app starts (and by index.html before the script runs: the same sphere,
 * still), and for anything that takes longer than a moment.
 */
import { useEffect, useState } from 'preact/hooks';

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

/** A frame every 85 ms, about 12 a second, a little coarse on purpose; the first 600 ms dither it in, in 16 steps. */
const FRAME_MS = 85;
const REVEAL_MS = 600;
const REVEAL = 16;
const SVG = 'http://www.w3.org/2000/svg';
/** A frame moved `i` frames to the right, to sit in a strip. */
const shift = (d: string, i: number) => (i ? d.replace(/M(\d+) /g, (_, x: string) => `M${Number(x) + i * N} `) : d);

let sprite = false;
/**
 * The frames side by side, once for the whole page: each orb shows one at a time by sliding the strip (styles.css),
 * which the compositor does without the page. Redrawing the path each frame was a layout each frame, 12 a second for
 * as long as anything loaded (docs/perf.md).
 */
function ensureSprite() {
  if (sprite || typeof document === 'undefined') return;
  sprite = true;
  const turn = allFrames().map(shift).join('');
  const reveal = Array.from({ length: REVEAL }, (_, k) => {
    const i = Math.floor((k * REVEAL_MS) / REVEAL / FRAME_MS);
    return shift(frame(-Math.PI * 0.75 + (i / FRAMES) * Math.PI * 2, k + 1), k);
  }).join('');
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  el.innerHTML = `<symbol id="orb-turn" viewBox="0 0 ${N * FRAMES} ${N}"><path fill="currentColor" d="${turn}"/></symbol><symbol id="orb-in" viewBox="0 0 ${N * REVEAL} ${N}"><path fill="currentColor" d="${reveal}"/></symbol>`;
  document.body.append(el);
}

export function DitherOrb({ size = 88, class: cls, appear = true }: { size?: number; class?: string; appear?: boolean }) {
  ensureSprite();
  return (
    <span class={`dither-orb ${appear ? 'appear' : ''} ${cls ?? ''}`} style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      {appear && (
        <span class="orb-in">
          <svg width={size * REVEAL} height={size} shape-rendering="crispEdges">
            <use href="#orb-in" width="100%" height="100%" />
          </svg>
        </span>
      )}
      <span class="orb-turn">
        <svg width={size * FRAMES} height={size} shape-rendering="crispEdges">
          <use href="#orb-turn" width="100%" height="100%" />
        </svg>
      </span>
    </span>
  );
}

/** How long a load goes before its orb starts: a quick one never draws a frame (styles.css fades it in from here). */
export const LOADING_DELAY_MS = 180;

/**
 * Something about to land: the orb, small, with what it is waiting for. Inline sits in a row or a line of text;
 * fill takes the height of its pane, to centre the orb in it. It starts only once the load has taken a moment, when
 * its fade-in begins, so it dithers in where it is seen: before that the space is held, empty.
 */
export function Loading({ label, size, inline, fill }: { label?: string; size?: number; inline?: boolean; fill?: boolean }) {
  const px = inline ? 16 : size ?? 32;
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStarted(true), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div class={`loading${inline ? ' inline' : ''}${fill ? ' fill' : ''}`} role="status" aria-live="polite" aria-label={label ?? 'Loading'}>
      {started ? <DitherOrb size={px} /> : <span class="dither-orb" style={{ width: `${px}px`, height: `${px}px` }} />}
      {label && <span class="loading-label">{label}</span>}
    </div>
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
