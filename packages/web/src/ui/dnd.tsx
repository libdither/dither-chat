/**
 * Drag to reorder, with one pointer-event path for mouse and touch. A mouse drags as soon as it moves.
 * A finger has to hold first so lists can still scroll; holding and letting go without moving opens the menu.
 *
 * A move draws nothing through Preact: the label under the pointer is moved by its transform, and the row it would
 * land on is found once a frame and marked with `data-dnd-at` directly. Putting the position or the target in the
 * signal re-rendered every row of the rail and the sidebar on every move.
 */
import { signal } from '@preact/signals';
import type { DropTarget, DropWhere } from '../layout.ts';

interface DragState {
  key: string;
  label: string;
}
/** What is being dragged: set when a drag starts and cleared when it ends, never while it moves. */
export const drag = signal<DragState | null>(null);
/** Where the pointer is, for the label that follows it. */
let pos = { x: 0, y: 0 };
let ghost: HTMLElement | null = null;
const placeGhost = () => ghost && (ghost.style.transform = `translate(${pos.x + 12}px, ${pos.y}px) translateY(-50%)`);
/** The row marked as where the drop would land. */
let marked: HTMLElement | null = null;
function mark(el: HTMLElement | null, where?: DropWhere) {
  if (marked && marked !== el) delete marked.dataset.dndAt;
  marked = el;
  if (el && el.dataset.dndAt !== where) el.dataset.dndAt = where;
}

interface DragOpts {
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

function targetAt(under: Element | null, x: number, y: number, group: string, self: string): { el: HTMLElement; target: DropTarget } | null {
  const el = under?.closest<HTMLElement>('[data-dnd-key]');
  if (!el || el.dataset.dndGroup !== group || el.dataset.dndKey === self) return null;
  const r = el.getBoundingClientRect();
  const t = el.dataset.dndAxis === 'x' ? (x - r.left) / r.width : (y - r.top) / r.height;
  const where: DropWhere = el.dataset.dndAccepts === '1' && t > 0.3 && t < 0.7 ? 'into' : t < 0.5 ? 'before' : 'after';
  return { el, target: { key: el.dataset.dndKey!, folder: el.dataset.dndFolder, where } };
}

function autoScroll(under: Element | null, y: number) {
  let el = under as HTMLElement | null;
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
      // Shift+right-click is the browser's own menu, as in Discord.
      if (e.shiftKey && (e as PointerEvent).pointerType !== 'touch') return;
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
      /** Once a frame, not once an event: what is under the pointer, the list's scroll, and the mark. */
      const tick = () => {
        if (!drag.value) return;
        placeGhost();
        const under = document.elementFromPoint(last.x, last.y);
        autoScroll(under, last.y);
        const hit = targetAt(under, last.x, last.y, o.group, o.key);
        mark(hit?.el ?? null, hit?.target.where);
        frame = requestAnimationFrame(tick);
      };
      const begin = () => {
        if (!o.onDrop) return;
        pos = last;
        drag.value = { key: o.key, label: o.label };
        document.body.classList.add('dragging');
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
        pos = last;
        // The label follows in this event's frame; finding the target waits for the frame's tick.
        placeGhost();
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
        mark(null);
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
        // Where it lands is where the pointer is now, not where the last frame's tick saw it.
        const d = drag.value && { target: targetAt(document.elementFromPoint(last.x, last.y), last.x, last.y, o.group, o.key)?.target ?? null };
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

/** Class for the row being dragged. Where it would land is marked by `data-dnd-at`, set directly (above). */
export function dropClass(key: string, _folder?: string): string {
  return drag.value?.key === key ? 'dnd-source' : '';
}

export function DragLayer() {
  const d = drag.value;
  if (!d) return null;
  return (
    <div
      class="drag-ghost"
      ref={(el) => {
        ghost = el;
        placeGhost();
      }}
    >
      {d.label}
    </div>
  );
}
