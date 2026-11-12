/**
 * What the phone layout needs beyond CSS: the width that switches it on, layers that the back button
 * closes before it leaves a page, the keyboard, and a haptic tick.
 */
import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';

const PHONE = '(max-width: 820px)';
const phoneQuery = typeof matchMedia === 'function' ? matchMedia(PHONE) : null;
/** One component tree; this only says which layout it is in. */
export const phone = signal(!!phoneQuery?.matches);
phoneQuery?.addEventListener('change', () => (phone.value = phoneQuery.matches));

/**
 * A touch screen and no pointer that hovers, as styles.css's `(hover: none) and (pointer: coarse)`: what shows only on
 * hover (a message's action bar, the browser's tooltips) is not drawn at all.
 */
const TOUCH_ONLY = '(hover: none) and (pointer: coarse)';
const touchQuery = typeof matchMedia === 'function' ? matchMedia(TOUCH_ONLY) : null;
export const touchOnly = signal(!!touchQuery?.matches);
touchQuery?.addEventListener('change', () => (touchOnly.value = touchQuery.matches));

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short tick where the platform has one. Used sparingly: long-press, and a swipe crossing its threshold. */
export const haptic = (ms = 8) => {
  try {
    navigator.vibrate?.(ms);
  } catch {}
};

// ------------------------------------------------------------------ layers and the back button

/**
 * A sheet, menu, dialog or side panel that the back button closes. Each open layer owns one history entry
 * with the same URL, so Android's back button, the browser's and history.back() all close the top layer first.
 */
interface Layer {
  id: number;
  close: () => void;
}
const layers: Layer[] = [];
let seq = Number(history.state?.layer ?? 0);
let pendingBack: ReturnType<typeof setTimeout> | undefined;
let skipPops = 0;

export function pushLayer(close: () => void): number {
  const id = ++seq;
  if (pendingBack !== undefined) {
    // A layer closed in this same moment (a sheet that opens the emoji picker): take over its entry.
    clearTimeout(pendingBack);
    pendingBack = undefined;
    history.replaceState({ ...history.state, layer: id }, '');
  } else history.pushState({ ...history.state, layer: id }, '');
  layers.push({ id, close });
  return id;
}

/** The layer closed by itself: give back its history entry, unless a navigation takes it over first. */
export function dropLayer(id: number) {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  layers.splice(i, 1);
  if (history.state?.layer !== id) return;
  clearTimeout(pendingBack);
  pendingBack = setTimeout(() => {
    pendingBack = undefined;
    skipPops++;
    history.back();
  }, 0);
}

/**
 * A navigation is about to happen. Closes every layer without touching history and says whether the current
 * entry belonged to one, in which case the caller replaces it rather than stacking a new entry on top.
 */
export function takeOverLayers(): boolean {
  clearTimeout(pendingBack);
  pendingBack = undefined;
  for (const l of layers.splice(0)) l.close();
  return history.state?.layer !== undefined;
}

/** After takeOverLayers, when the navigation goes nowhere new: step off the entry the layers left. */
export function leaveLayerEntry() {
  skipPops++;
  history.back();
}

export const layerCount = () => layers.length;

window.addEventListener('popstate', () => {
  if (skipPops) {
    skipPops--;
    return;
  }
  const at = Number(history.state?.layer ?? 0);
  while (layers.length && layers[layers.length - 1].id > at) layers.pop()!.close();
  // An entry whose layer was closed some other way: step over it, so no press of back does nothing.
  if (at && !layers.some((l) => l.id === at)) {
    skipPops++;
    history.back();
  }
});
// A reload leaves us on a layer's entry with nothing open.
if (history.state?.layer !== undefined) history.replaceState({ ...history.state, layer: undefined }, '');

/** While mounted, the back button closes this. `onClose` may be called after unmount has begun; keep it idempotent. */
export function useLayer(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const id = pushLayer(() => close.current());
    return () => dropLayer(id);
  }, []);
}

// ------------------------------------------------------------------ keyboard

/**
 * Keep the app the size of what is visible. Chromium resizes the layout for the keyboard
 * (interactive-widget=resizes-content); iOS Safari only shrinks the visual viewport, and scrolls it.
 * Only while a field has focus, so pinch zoom on a desktop never shrinks the app.
 */
export function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  let tallest = 0;
  const typing = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/.test((el as HTMLInputElement).type)) || el.isContentEditable);
  };
  const update = () => {
    const h = vv?.height ?? innerHeight;
    tallest = Math.max(tallest, innerHeight, h);
    const kb = typing() && tallest - h > 120;
    root.classList.toggle('kb-open', kb);
    if (vv && typing() && (vv.height < innerHeight - 1 || vv.offsetTop > 0)) {
      root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
    } else {
      root.style.removeProperty('--app-h');
      root.style.removeProperty('--app-top');
      // iOS leaves the page scrolled after the keyboard goes away.
      if (window.scrollY) window.scrollTo(0, 0);
    }
  };
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  let wide = innerWidth;
  window.addEventListener('resize', () => {
    // A rotation changes what "full height" means; a keyboard only changes the height.
    if (innerWidth !== wide) tallest = 0;
    wide = innerWidth;
    update();
  });
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 50));
  update();
}

// ------------------------------------------------------------------ dragging a sheet down

/**
 * Drag a bottom sheet down to dismiss it. Starts from the grabber or header with mouse or finger, and from
 * anywhere in the sheet with a finger once its content is scrolled to the top. Follows the finger, and
 * decides by distance or by how fast it was let go.
 */
export function useSheetDrag(panel: { current: HTMLElement | null }, onDismiss: () => void, enabled = true) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number; t: number } | null = null;
    let dragging = false;
    let samples: { y: number; t: number }[] = [];
    const scrolledAway = (t: EventTarget | null) => {
      for (let n = t as HTMLElement | null; n && n !== el; n = n.parentElement) {
        if (n.scrollTop > 0) return true;
        if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return true;
      }
      return false;
    };
    const set = (y: number, ms = 0) => {
      el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none';
      el.style.transform = y ? `translateY(${y}px)` : '';
      const back = el.parentElement;
      if (back) back.style.setProperty('--sheet-fade', String(Math.max(0, 1 - y / Math.max(1, el.offsetHeight))));
    };
    const begin = (x: number, y: number, target: EventTarget | null, fromGrip: boolean) => {
      if (!fromGrip && scrolledAway(target)) return false;
      start = { x, y, t: performance.now() };
      dragging = false;
      samples = [{ y, t: start.t }];
      return true;
    };
    const move = (x: number, y: number): boolean => {
      if (!start) return false;
      const dy = y - start.y;
      const dx = x - start.x;
      if (!dragging) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return false;
        if (dy <= 0 || Math.abs(dx) > dy) {
          start = null;
          return false;
        }
        dragging = true;
      }
      const t = performance.now();
      samples.push({ y, t });
      if (samples.length > 5) samples.shift();
      set(Math.max(0, dy));
      return true;
    };
    const end = () => {
      if (!start) return;
      const was = dragging;
      const dy = (samples[samples.length - 1]?.y ?? start.y) - start.y;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const v = last && first && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      start = null;
      dragging = false;
      if (!was) return;
      const h = el.offsetHeight;
      if (dy > h * 0.3 || v > 0.5) {
        const ms = reducedMotion() ? 0 : Math.max(90, Math.min(240, (h - dy) / Math.max(v, 1)));
        set(h + 24, ms);
        const done = () => dismiss.current();
        if (ms) setTimeout(done, ms);
        else done();
      } else set(0, reducedMotion() ? 0 : 220);
    };
    const isGrip = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('.sheet-grip, .modal-head, .sheet-head');
    const ts = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (start = null);
      begin(e.touches[0].clientX, e.touches[0].clientY, e.target, isGrip(e.target));
    };
    const tm = (e: TouchEvent) => {
      if (move(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
    };
    const pd = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !isGrip(e.target)) return;
      if ((e.target as HTMLElement).closest('button, input, a')) return;
      begin(e.clientX, e.clientY, e.target, true);
      const mm = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
      const mu = () => {
        window.removeEventListener('pointermove', mm);
        window.removeEventListener('pointerup', mu);
        end();
      };
      window.addEventListener('pointermove', mm);
      window.addEventListener('pointerup', mu);
    };
    el.addEventListener('touchstart', ts, { passive: true });
    el.addEventListener('touchmove', tm, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('pointerdown', pd);
    return () => {
      el.removeEventListener('touchstart', ts);
      el.removeEventListener('touchmove', tm);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
      el.removeEventListener('pointerdown', pd);
    };
  }, [enabled]);
}

/** Slide a sheet out of view, then let it go. */
export function slideAway(panel: HTMLElement | null, done: () => void) {
  if (!panel || reducedMotion()) return done();
  panel.style.transition = 'transform 200ms cubic-bezier(.4,0,1,1)';
  panel.style.transform = `translateY(${panel.offsetHeight + 24}px)`;
  panel.parentElement?.style.setProperty('--sheet-fade', '0');
  setTimeout(done, 200);
}
