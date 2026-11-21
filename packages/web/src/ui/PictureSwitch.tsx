/**
 * Switching a run of pictures to another way where it is (docs/pictures.md, "Switching in the chat"). On a computer,
 * a rail of the five ways stands beside the run: invisible until you point at the message, then only the way in use,
 * faint; pointing at that brings in the other four. On a phone, a chip at the top right of the message (its words
 * wrap round it) is a wheel of the five: drag it up or down, scroll on it, or pinch the pictures, and the run slides
 * from one way to the next in PICTURE_ORDER, sticky near each (pictures.ts slidePosition) and undone by going back,
 * until you let go. A tap opens the list. Either way the choice is saved for that chat (place_pref.pictures), with no
 * toast: the run shows it.
 */
import { signal, type Signal } from '@preact/signals';
import type { PictureLayout } from '@dither-chat/protocol';
import { render, type ComponentChildren, type JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { PICTURE_LABELS, setPlacePictures } from '../arrange.ts';
import { PICTURE_ORDER, settleAt, slidePosition, SLIDE_GIVE, type PictureRef } from '../pictures.ts';
import { veiled } from './rich/parts.tsx';

const LAST = PICTURE_ORDER.length - 1;
const IDX = Object.fromEntries(PICTURE_ORDER.map((l, i) => [l, i])) as Record<PictureLayout, number>;
/** The chip's and the list's names: one short word each. */
const SHORT_LABELS: Record<PictureLayout, string> = { small: 'Small', fold: 'Fold', six: 'Six', mosaic: 'All', rows: 'Rows' };

const ICONS: Record<PictureLayout, JSX.Element> = {
  six: (
    <>
      <rect x="1" y="2" width="6.5" height="5" rx="1" />
      <rect x="8.5" y="2" width="6.5" height="5" rx="1" />
      <rect x="1" y="8.5" width="4" height="5" rx="1" />
      <rect x="6" y="8.5" width="4" height="5" rx="1" />
      <rect x="11" y="8.5" width="4" height="5" rx="1" opacity=".55" />
    </>
  ),
  mosaic: (
    <>
      {[1, 6, 11].flatMap((y) => [1, 6, 11].map((x) => <rect x={x} y={y} width="4" height="4" rx=".8" />))}
    </>
  ),
  rows: (
    <>
      <rect x="1" y="2" width="5" height="5.5" rx=".8" />
      <rect x="7" y="2" width="8" height="5.5" rx=".8" />
      <rect x="1" y="8.5" width="9" height="5.5" rx=".8" />
      <rect x="11" y="8.5" width="4" height="5.5" rx=".8" />
    </>
  ),
  fold: (
    <>
      <rect x="1" y="1" width="10" height="8" rx="1" />
      <rect x="1" y="10.5" width="14" height="4" rx="2" opacity=".55" />
    </>
  ),
  small: (
    <>
      {[1, 5, 9].map((x) => <rect x={x} y="5" width="3.2" height="3.2" rx=".6" />)}
      <rect x="13" y="5" width="2.4" height="3.2" rx=".6" />
      <rect x="1" y="9" width="3.2" height="3.2" rx=".6" />
      <rect x="5" y="9" width="3.2" height="3.2" rx=".6" />
    </>
  ),
};

function LayoutIcon({ l }: { l: PictureLayout }) {
  return (
    <svg class="layout-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {ICONS[l]}
    </svg>
  );
}

// ------------------------------------------------------------------ folded runs that were opened

/** Runs whose folded pictures were opened, by their first message's id. */
export const unfolded = signal<ReadonlySet<string>>(new Set());
export const setUnfolded = (key: string, open: boolean) => {
  if (unfolded.value.has(key) === open) return;
  const next = new Set(unfolded.value);
  open ? next.add(key) : next.delete(key);
  unfolded.value = next;
};

/** Saves a way for the chat; a run switched to Fold starts folded. */
function choose(runKey: string, convId: string, l: PictureLayout) {
  setUnfolded(runKey, false);
  setPlacePictures('conversation', convId, l);
}

// ------------------------------------------------------------------ the computer's rail

export function PictureRail({ layout, convId, runKey }: { layout: PictureLayout; convId: string; runKey: string }) {
  return (
    <div class="pics-rail" role="group" aria-label="Show these pictures as">
      {PICTURE_ORDER.map((l) => (
        <button
          class="pics-rail-btn"
          aria-pressed={l === layout}
          aria-label={PICTURE_LABELS[l]}
          data-track="pictures: rail"
          onClick={(e) => {
            e.stopPropagation();
            if (l !== layout) choose(runKey, convId, l);
          }}
        >
          <LayoutIcon l={l} />
          <span class="pics-rail-tip">{PICTURE_LABELS[l]}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ where every picture sits in each way

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface TileBox extends Box {
  /** 0 where this way doesn't draw the picture (past Six's sixth, past Fold's eighth thumbnail). */
  o: number;
  r: number;
}
interface WayBoxes {
  w: number;
  h: number;
  tiles: TileBox[];
  /** Fold's "Show N more" bar, and its words. */
  bar: Box | null;
  words: Box | null;
}
type RunGeometry = Record<PictureLayout, WayBoxes>;

/** What Pictures.tsx leaves for the switch: its block, its pictures and how it draws them one way. */
interface Measurer {
  host: () => HTMLElement | null;
  pics: PictureRef[];
  runKey: string;
  draw: (pics: PictureRef[], layout: PictureLayout, runKey: string, open: boolean) => { body: ComponentChildren; wide: boolean };
}
export const measurers = new Map<string, Measurer>();

const RADIUS: Record<PictureLayout, number> = { small: 6, fold: 5, six: 3, mosaic: 3, rows: 3 };

/**
 * Draws the run each way out of sight, beside where it is so the same width and styles apply, and reads where each
 * picture lands. Done once when a slide starts.
 */
function measureRun(m: Measurer): RunGeometry | null {
  const host = m.host();
  const parent = host?.parentElement;
  if (!host || !parent) return null;
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:0;top:0;width:${parent.clientWidth}px;visibility:hidden;pointer-events:none;contain:layout`;
  parent.appendChild(box);
  const out = {} as RunGeometry;
  try {
    for (const l of PICTURE_ORDER) {
      const { body, wide } = m.draw(m.pics, l, m.runKey, false);
      render(<div class={`pics${wide ? ' wide' : ''}`}>{body}</div>, box);
      const el = box.firstElementChild as HTMLElement;
      const o = el.getBoundingClientRect();
      const rel = (e: Element | null): Box | null => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
      };
      const at = new Map<number, Box>();
      el.querySelectorAll<HTMLElement>('[data-i]').forEach((t) => at.set(Number(t.dataset.i), rel(t)!));
      let last: Box = { x: 0, y: 0, w: 0, h: 0 };
      const tiles = m.pics.map((_, i): TileBox => {
        const b = at.get(i);
        if (b) last = b;
        return { ...(b ?? last), o: b ? 1 : 0, r: l === 'fold' && i === 0 ? 10 : RADIUS[l] };
      });
      out[l] = { w: o.width, h: o.height, tiles, bar: rel(el.querySelector('.pics-fold')), words: rel(el.querySelector('.pics-fold > span:last-child')) };
    }
  } finally {
    render(null, box);
    box.remove();
  }
  return out;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const at = (b: Box) => ({ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });

/** The run between two ways: every picture moved part of the way from where one way draws it to where the next does. */
export function Morph({ pics, geo, g }: { pics: PictureRef[]; geo: RunGeometry; g: number }) {
  const gc = Math.max(0, Math.min(LAST, g));
  const ai = Math.floor(gc);
  const bi = Math.min(LAST, ai + 1);
  const t = gc - ai;
  const A = geo[PICTURE_ORDER[ai]];
  const B = geo[PICTURE_ORDER[bi]];
  const weight = (l: PictureLayout) => (l === PICTURE_ORDER[ai] ? 1 - t : 0) + (l === PICTURE_ORDER[bi] ? t : 0);
  // Past either end, a little give.
  const over = g < 0 ? g : g > LAST ? g - LAST : 0;
  const fold = weight('fold');
  const six = weight('six');
  const n = pics.length;
  const sixth = n > 6 ? { x: lerp(A.tiles[5].x, B.tiles[5].x, t), y: lerp(A.tiles[5].y, B.tiles[5].y, t), w: lerp(A.tiles[5].w, B.tiles[5].w, t), h: lerp(A.tiles[5].h, B.tiles[5].h, t) } : null;
  return (
    <div class="pics-morph-box" style={{ width: `${lerp(A.w, B.w, t)}px`, height: `${lerp(A.h, B.h, t)}px`, transform: over ? `scale(${1 + over * 0.06})` : undefined }}>
      {fold > 0 && geo.fold.bar && <div class="pics-morph-bar" style={{ ...at(geo.fold.bar), opacity: fold }} />}
      {fold > 0 && geo.fold.words && (
        <div class="pics-morph-words" style={{ ...at(geo.fold.words), opacity: fold }}>
          Show {n - 1} more
        </div>
      )}
      {pics.map((p, i) => {
        const a = A.tiles[i];
        const b = B.tiles[i];
        return (
          <div class="pics-morph-tile" style={{ left: `${lerp(a.x, b.x, t)}px`, top: `${lerp(a.y, b.y, t)}px`, width: `${lerp(a.w, b.w, t)}px`, height: `${lerp(a.h, b.h, t)}px`, opacity: lerp(a.o, b.o, t), borderRadius: `${lerp(a.r, b.r, t)}px` }}>
            <img src={p.a.url} alt="" class={veiled(p.a) ? 'veiled' : undefined} />
          </div>
        );
      })}
      {sixth && six > 0 && (
        <div class="pics-morph-more" style={{ ...at(sixth), opacity: six }}>
          +{n - 6}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ a slide under way

interface Sliding {
  /** Where the drawing stands (0 Small … 4 Rows); raw: where the fingers are. */
  g: number;
  raw: number;
  /** The fingers are on it, or it is settling after them: the chip shows its wheel open. */
  busy: boolean;
  geo: RunGeometry;
  from: PictureLayout;
}
const slides = new Map<string, Signal<Sliding | null>>();
/** The slide under way on a run, if any, by its first message's id. */
export function switchOf(runKey: string): Signal<Sliding | null> {
  let s = slides.get(runKey);
  if (!s) slides.set(runKey, (s = signal<Sliding | null>(null)));
  return s;
}
const rawOf = (runKey: string, layout: PictureLayout) => switchOf(runKey).value?.raw ?? IDX[layout];

/**
 * What stays under the finger while the run grows and shrinks: the chip, or the pictures' top. The timeline keeps its
 * bottom still (it is a column-reverse scroller), so it is scrolled by however far that moved.
 */
let still: { el: HTMLElement; top: number } | null = null;
function holdStill() {
  requestAnimationFrame(() => {
    if (!still?.el.isConnected) return;
    const d = still.el.getBoundingClientRect().top - still.top;
    const scroller = still.el.closest<HTMLElement>('.timeline-scroll');
    if (scroller && Math.abs(d) > 0.5) scroller.scrollTop += d;
  });
}

function start(runKey: string, layout: PictureLayout, anchor: HTMLElement | null, busy: boolean): Sliding | null {
  const s = switchOf(runKey);
  if (s.value) return s.value;
  const m = measurers.get(runKey);
  const geo = m && measureRun(m);
  if (!geo) return null;
  still = anchor ? { el: anchor, top: anchor.getBoundingClientRect().top } : null;
  return (s.value = { g: IDX[layout], raw: IDX[layout], busy, geo, from: layout });
}

const anims = new Map<string, number>();
function stopAnim(runKey: string) {
  cancelAnimationFrame(anims.get(runKey) ?? 0);
  anims.delete(runKey);
}

/** The fingers moved: the drawing follows them, sticky near each way. */
function slide(runKey: string, layout: PictureLayout, raw: number, anchor: HTMLElement | null) {
  const cur = start(runKey, layout, anchor, true);
  if (!cur) return;
  stopAnim(runKey);
  const r = Math.max(-SLIDE_GIVE, Math.min(LAST + SLIDE_GIVE, raw));
  switchOf(runKey).value = { ...cur, raw: r, g: slidePosition(r), busy: true };
  holdStill();
}

/** Eases the drawing to `to`, then saves that way if it is a new one and draws the run as it is again. */
function settleTo(runKey: string, convId: string, to: PictureLayout) {
  const s = switchOf(runKey);
  if (!s.value) return;
  stopAnim(runKey);
  const from = s.value.g;
  const target = IDX[to];
  const t0 = performance.now();
  const step = (now: number) => {
    const cur = s.value;
    if (!cur) return;
    const k = Math.min(1, (now - t0) / 240);
    const e = 1 - Math.pow(1 - k, 3);
    s.value = { ...cur, g: lerp(from, target, e), raw: lerp(from, target, e) };
    holdStill();
    if (k < 1) return void anims.set(runKey, requestAnimationFrame(step));
    anims.delete(runKey);
    if (to !== cur.from) choose(runKey, convId, to);
    s.value = null;
    still = null;
  };
  anims.set(runKey, requestAnimationFrame(step));
}

/** Let go: it settles on the nearest way. */
function letGo(runKey: string, convId: string) {
  const cur = switchOf(runKey).value;
  if (cur) settleTo(runKey, convId, settleAt(cur.g));
}

const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

/**
 * Two fingers on a run (a phone): spreading them makes the pictures bigger, one way at a time. Its moves are caught on
 * the window, before the pager's swipes see them, and because the picture the fingers went down on is redrawn.
 */
export function pinchHandlers(runKey: string, convId: string, layout: PictureLayout) {
  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.stopPropagation();
      const host = e.currentTarget as HTMLElement;
      const d0 = spread(e.touches);
      const raw0 = rawOf(runKey, layout);
      const move = (ev: TouchEvent) => {
        if (ev.touches.length !== 2) return;
        ev.preventDefault();
        ev.stopPropagation();
        slide(runKey, layout, raw0 + Math.log2(spread(ev.touches) / d0) * 2.4, host);
      };
      const end = (ev: TouchEvent) => {
        if (ev.touches.length >= 2) return;
        window.removeEventListener('touchmove', move, true);
        window.removeEventListener('touchend', end, true);
        window.removeEventListener('touchcancel', end, true);
        letGo(runKey, convId);
      };
      window.addEventListener('touchmove', move, { capture: true, passive: false });
      window.addEventListener('touchend', end, true);
      window.addEventListener('touchcancel', end, true);
    },
  };
}

// ------------------------------------------------------------------ the phone's chip

const LIST_ROW = 30;

export function PictureChip({ runKey, convId, layout }: { runKey: string; convId: string; layout: PictureLayout }) {
  const chip = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ y: number; raw: number; moved: boolean } | null>(null);
  // A slide ends in a click too: that one doesn't open the list.
  const slid = useRef(false);
  const wheel = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [list, setList] = useState<number | null>(null);
  const s = switchOf(runKey).value;
  const g = s ? s.g : IDX[layout];
  const busy = !!s?.busy;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  const openList = () => {
    const el = chip.current;
    if (!el) return;
    // The way in use opens where the chip is, so the list reads as the wheel opened out; kept inside the timeline.
    let top = 12 - (4 + IDX[layout] * LIST_ROW + LIST_ROW / 2) - 1;
    const r = el.getBoundingClientRect();
    const pane = el.closest('.timeline-scroll')?.getBoundingClientRect();
    const height = 8 + PICTURE_ORDER.length * LIST_ROW + 2;
    if (pane) top = Math.max(pane.top + 4 - r.top, Math.min(pane.bottom - 4 - height - r.top, top));
    setList(top);
  };

  return (
    <span class="pchip-wrap">
      <button
        ref={chip}
        class={`pchip${busy ? ' busy' : ''}${list !== null ? ' on' : ''}`}
        aria-label={`Pictures: ${PICTURE_LABELS[layout]}. Drag up or down to change`}
        aria-haspopup="menu"
        aria-expanded={list !== null}
        data-track="pictures: chip"
        style={{ '--g': g, '--u': busy ? clamp01(g) : 0, '--d': busy ? clamp01(LAST - g) : 0 }}
        onPointerDown={(e) => {
          // The message's long-press menu and the pager's swipes leave this one alone.
          (e as PointerEvent & { longPressTaken?: boolean }).longPressTaken = true;
          drag.current = { y: e.clientY, raw: rawOf(runKey, layout), moved: false };
          chip.current?.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.abs(dy) < 6) return;
          d.moved = true;
          slide(runKey, layout, d.raw - dy / 36, chip.current);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          slid.current = !!d?.moved;
          if (d?.moved) letGo(runKey, convId);
        }}
        onPointerCancel={() => {
          if (drag.current?.moved) letGo(runKey, convId);
          drag.current = null;
        }}
        onTouchStart={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.preventDefault();
          // The wheel turns the way the page would move: scrolling down brings the next, bigger, name up.
          slide(runKey, layout, rawOf(runKey, layout) + e.deltaY / 110, chip.current);
          clearTimeout(wheel.current);
          wheel.current = setTimeout(() => letGo(runKey, convId), 180);
        }}
        onClick={(e) => {
          // On the click rather than the finger lifting, so the list that opens over the chip doesn't take it too.
          e.stopPropagation();
          if (slid.current) return void (slid.current = false);
          list === null ? openList() : setList(null);
        }}
      >
        {/* As wide as the widest name, so the words round it never move. */}
        <span class="pchip-size" aria-hidden="true">
          {PICTURE_ORDER.map((l) => (
            <span class="pchip-row">
              <LayoutIcon l={l} />
              {SHORT_LABELS[l]}
            </span>
          ))}
        </span>
        <span class="pchip-win">
          <span class="pchip-reel">
            {PICTURE_ORDER.map((l, i) => (
              <span class="pchip-row" style={{ opacity: Math.max(0, 1 - Math.abs(i - g) * 0.6) }}>
                <LayoutIcon l={l} />
                {SHORT_LABELS[l]}
              </span>
            ))}
          </span>
        </span>
      </button>
      {list !== null && (
        <>
          <span class="pchip-shade" onPointerDown={(e) => (e.stopPropagation(), setList(null))} onClick={(e) => e.stopPropagation()} />
          <span class="pchip-list" role="menu" style={{ top: `${list}px` }}>
            {PICTURE_ORDER.map((l) => (
              <button
                role="menuitemradio"
                aria-checked={l === layout}
                data-track="pictures: chip list"
                onClick={(e) => {
                  e.stopPropagation();
                  setList(null);
                  if (l === layout || !start(runKey, layout, chip.current, false)) return void (l !== layout && choose(runKey, convId, l));
                  settleTo(runKey, convId, l);
                }}
              >
                <LayoutIcon l={l} />
                {SHORT_LABELS[l]}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}
