/**
 * A wheel of choices on one line (docs/mail.md, "Whose mail"): the one in use shows, and the others are a turn away. A
 * click turns it to the next (Shift+click back), as does the mouse wheel, a drag up or down, or the arrow keys; the
 * words slide as it turns. A right-click or a long press opens the whole list. Dots beside it say how many there are and
 * which this is. A choice whose account is not working carries a small muted warning sign, its problem in the tooltip.
 */
import { useRef } from 'preact/hooks';
import { Icon } from '../icons.tsx';

export interface WheelItem {
  key: string;
  label: string;
  /** Any CSS background: an account's colour, or every colour at once. */
  dot?: string;
  /** What is wrong, when something is: a muted warning sign. */
  warn?: string | null;
}

const ROW = 18;
/** Pixels of drag, and of mouse wheel, per step. */
const DRAG_STEP = 24;
const WHEEL_STEP = 60;

export function ScopeWheel({ items, at, pick, label, onMenu, track }: { items: WheelItem[]; at: number; pick: (key: string) => void; label: string; onMenu?: (from: HTMLElement) => void; track: string }) {
  const n = items.length;
  const drag = useRef<{ y: number; moved: number; id: number } | null>(null);
  const wheelSum = useRef(0);
  const turned = useRef(false);

  const step = (d: number) => {
    if (n < 2) return;
    pick(items[(((at + d) % n) + n) % n].key);
  };

  const cur = items[at] ?? items[0];
  return (
    <button
      class="scope-wheel"
      type="button"
      aria-label={`${label}: ${cur?.label}. Click for the next, right-click for the list`}
      aria-haspopup={onMenu ? 'menu' : undefined}
      data-track={track}
      onPointerDown={(e) => {
        (e as PointerEvent & { longPressTaken?: boolean }).longPressTaken = true;
        drag.current = { y: e.clientY, moved: 0, id: e.pointerId };
        turned.current = false;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dy) < 6) return;
        if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture(d.id);
        const steps = Math.trunc(dy / DRAG_STEP);
        if (steps !== d.moved) {
          // Dragging up brings the next one up, as a wheel turns.
          step(d.moved - steps);
          d.moved = steps || d.moved;
          turned.current = true;
        }
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onTouchStart={(e) => e.stopPropagation()}
      onWheel={(e) => {
        e.preventDefault();
        wheelSum.current += e.deltaY;
        if (Math.abs(wheelSum.current) < WHEEL_STEP) return;
        step(Math.sign(wheelSum.current));
        wheelSum.current = 0;
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') (e.preventDefault(), step(1));
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') (e.preventDefault(), step(-1));
      }}
      onClick={(e) => {
        if (turned.current) return void (turned.current = false);
        step(e.shiftKey ? -1 : 1);
      }}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu(e.currentTarget as HTMLElement);
      }}
    >
      {/* As wide as the choice in use; the reel slides over it. */}
      <span class="scope-cell">
        <span class="scope-size" aria-hidden="true">
          <Row it={cur} />
        </span>
        <span class="scope-win">
          <span class="scope-reel" style={{ transform: `translateY(${-at * ROW}px)` }}>
            {items.map((it, i) => (
              <Row it={it} dim={i !== at} />
            ))}
          </span>
        </span>
      </span>
      {n > 1 && (
        <span class="scope-dots" aria-hidden="true">
          {items.map((_, i) => (
            <span class={i === at ? 'on' : ''} />
          ))}
        </span>
      )}
    </button>
  );
}

function Row({ it, dim }: { it: WheelItem; dim?: boolean }) {
  return (
    <span class={`scope-row${dim ? ' dim' : ''}`}>
      {it.dot && <span class="mail-acc-dot" style={{ background: it.dot }} />}
      <span class="scope-label">{it.label}</span>
      {it.warn && (
        <span class="scope-warn" title={it.warn}>
          <Icon name="alert" size={11} />
        </span>
      )}
    </span>
  );
}
