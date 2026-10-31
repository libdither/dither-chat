/**
 * Drag to reorder, with one pointer-event path for mouse and touch. A mouse drags as soon as it moves.
 * A finger has to hold first so lists can still scroll; holding and letting go without moving opens the menu.
 */
import { signal } from '@preact/signals';
import type { DropTarget, DropWhere } from '../layout.ts';

export interface DragState {
  key: string;
  label: string;
  x: number;
  y: number;
  target: DropTarget | null;
}
export const drag = signal<DragState | null>(null);

export interface DragOpts {
  key: string;
  label: string;
  /** Drops stay within rows of the same group. */
  group: string;
  folder?: string;
  /** Dropping on the middle of this row groups into it. */
  accepts?: boolean;
  /** Rows in a grid compare left and right rather than top and bottom. */
  axis?: 'x' | 'y';
  onDrop?: (key: string, target: DropTarget) => void;
  onMenu?: (x: number, y: number) => void;
}

const HOLD_MS = 350;
const SLOP = 8;

function targetAt(x: number, y: number, group: string, self: string): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-dnd-key]');
  if (!el || el.dataset.dndGroup !== group || el.dataset.dndKey === self) return null;
  const r = el.getBoundingClientRect();
  const t = el.dataset.dndAxis === 'x' ? (x - r.left) / r.width : (y - r.top) / r.height;
  const where: DropWhere = el.dataset.dndAccepts === '1' && t > 0.3 && t < 0.7 ? 'into' : t < 0.5 ? 'before' : 'after';
  return { key: el.dataset.dndKey!, folder: el.dataset.dndFolder, where };
}

function autoScroll(x: number, y: number) {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
  if (!el || el === document.documentElement) return;
  const r = el.getBoundingClientRect();
  if (y < r.top + 36) el.scrollTop -= 8;
  else if (y > r.bottom - 36) el.scrollTop += 8;
}

/** Spread onto a row. */
export function dragProps(o: DragOpts) {
  return {
    'data-dnd-key': o.key,
    'data-dnd-group': o.group,
    'data-dnd-folder': o.folder,
    'data-dnd-accepts': o.accepts ? '1' : undefined,
    'data-dnd-axis': o.axis,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      // Android fires this for the long press the hold timer already handles.
      if ((e as PointerEvent).pointerType !== 'touch' && o.onMenu) o.onMenu(e.clientX, e.clientY);
    },
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0 || (!o.onDrop && !o.onMenu)) return;
      const touch = e.pointerType !== 'mouse';
      const start = { x: e.clientX, y: e.clientY };
      let held = false;
      let last = start;
      let frame = 0;
      const begin = () => {
        if (!o.onDrop) return;
        drag.value = { key: o.key, label: o.label, x: last.x, y: last.y, target: null };
        document.body.classList.add('dragging');
        const tick = () => {
          if (!drag.value) return;
          autoScroll(last.x, last.y);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      };
      const timer = touch
        ? setTimeout(() => {
            held = true;
            navigator.vibrate?.(10);
            begin();
          }, HOLD_MS)
        : undefined;
      const move = (ev: PointerEvent) => {
        last = { x: ev.clientX, y: ev.clientY };
        const far = Math.hypot(last.x - start.x, last.y - start.y) > SLOP;
        if (!drag.value) {
          if (!far) return;
          if (touch) {
            // It is a scroll.
            if (!held) stop();
            return;
          }
          begin();
          if (!drag.value) return;
        }
        drag.value = { ...drag.value!, x: last.x, y: last.y, target: targetAt(last.x, last.y, o.group, o.key) };
      };
      // A finger that is dragging must not scroll the list out from under it; this has to be registered before the gesture starts.
      const holdPage = (ev: TouchEvent) => {
        if (drag.value) ev.preventDefault();
      };
      const swallowClick = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      const stop = () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('touchmove', holdPage);
        window.removeEventListener('keydown', key);
        document.body.classList.remove('dragging');
      };
      const finish = () => {
        window.addEventListener('click', swallowClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 50);
      };
      const up = () => {
        const d = drag.value;
        const moved = Math.hypot(last.x - start.x, last.y - start.y) > SLOP;
        stop();
        drag.value = null;
        if (d?.target) {
          finish();
          o.onDrop?.(o.key, d.target);
        } else if (touch && held && !moved) {
          finish();
          o.onMenu?.(last.x, last.y);
        } else if (d) finish();
      };
      const cancel = () => {
        stop();
        drag.value = null;
      };
      const key = (ev: KeyboardEvent) => ev.key === 'Escape' && cancel();
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('touchmove', holdPage, { passive: false });
      window.addEventListener('keydown', key);
    },
  };
}

/** Class for a row while something hovers over it. */
export function dropClass(key: string, folder?: string): string {
  const t = drag.value?.target;
  if (!t || t.key !== key || t.folder !== folder) return drag.value?.key === key ? 'dnd-source' : '';
  return `dnd-${t.where}`;
}

export function DragLayer() {
  const d = drag.value;
  if (!d) return null;
  return (
    <div class="drag-ghost" style={{ left: `${d.x}px`, top: `${d.y}px` }}>
      {d.label}
    </div>
  );
}
