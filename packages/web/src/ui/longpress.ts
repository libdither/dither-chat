/**
 * A long-press for touch, on its own (not in ui/Reactions.tsx), so the context menu and the feed can use it without
 * importing the reactions (docs/testing.md "Import cycles").
 */
import { useRef } from 'preact/hooks';
import { haptic } from '../phone.ts';

/** Long-press, for touch. Scrolling or lifting the finger cancels it; once it fires, the click that lifting makes does not count. */
export function useLongPress(onPress: (e: PointerEvent) => void, ms = 420) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Where the press that fired was: the lift's click lands there. */
  const fired = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  // Only the click the lift makes, where the finger was: held past the browser's own long press, lifting makes no
  // click, and a quick tap somewhere else (picking a second row) is a tap of its own.
  const swallow = (at: { x: number; y: number }) => (e: MouseEvent) => {
    if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) return;
    e.stopPropagation();
    e.preventDefault();
  };
  return {
    onPointerDown: (e: PointerEvent & { longPressTaken?: boolean }) => {
      // A reaction pill sits inside a message: the innermost long-press is the one meant.
      if (e.pointerType !== 'touch' || e.longPressTaken) return;
      e.longPressTaken = true;
      // A second finger while the first is still held: a pinch (ui/PictureSwitch.tsx), not a long press.
      if (start.current) return cancel();
      const at = { x: e.clientX, y: e.clientY };
      start.current = at;
      fired.current = null;
      timer.current = setTimeout(() => {
        start.current = null;
        fired.current = at;
        haptic(10);
        onPress(e);
      }, ms);
    },
    onPointerMove: (e: PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: () => {
      cancel();
      const at = fired.current;
      if (!at) return;
      fired.current = null;
      const s = swallow(at);
      window.addEventListener('click', s, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', s, { capture: true }), 400);
    },
    onPointerCancel: cancel,
    onContextMenu: (e: Event) => {
      if (matchMedia('(pointer: coarse)').matches) e.preventDefault();
    },
  };
}
