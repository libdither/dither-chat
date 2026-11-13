/**
 * Reply marks made on an inbox row (docs/inbox.md, "Marks"), by gesture instead of a menu:
 *
 * - On a computer, a row's ↩ is a button: hovered it shows ✕ and says "No reply needed", and a click takes the ↩ off
 *   without opening the chat. A row with no ↩ shows a faint one in the same place while the pointer is on the row,
 *   "Reply needed". The button sits beside the row's own button, not in it, so Tab reaches it and a screen reader
 *   names it.
 * - On a phone, a row swiped left does the same: "No reply needed" where the ↩ shows, "Reply needed" elsewhere. What
 *   it will do shows under the row as it slides; it happens past SWIPE_AT or on a flick. The row claims a left swipe
 *   (`data-claims-swipe`), so the pager (Pager.ts) does not take it to go forward to a peeking page.
 *
 * Both go through markRow, with its Undo toast.
 */
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { since } from '../format.ts';
import { commits, lockAxis, rubber, settleMs, velocity } from '../gesture.ts';
import { haptic, layerCount, reducedMotion } from '../phone.ts';
import { countKey } from '../clicklog.ts';
import { markRow, REPLY_MARK_LABEL } from '../replymarks.ts';
import { rev } from '../state.ts';
import { drag } from './dnd.tsx';

/** How far left a row goes before letting go marks it. */
export const SWIPE_AT = 72;
/** A flick shorter than this is not taken for a swipe. */
const FLICK_MIN = 24;

/** A swipe that ended: the click the browser may still make of it is not a tap on the row. */
let swallowUntil = 0;

/** The ↩ and how long, as the row draws it: the button over it has the same, so it covers it exactly. */
function Age({ at }: { at: number }) {
  rev.value;
  return <>{since(at)}</>;
}

interface Swipe {
  x0: number;
  y0: number;
  on: boolean;
  x: number;
  armed: boolean;
  layers: number;
  samples: { x: number; t: number }[];
}

/**
 * Around one inbox row. `owedSince`: the row's ↩ (a reply you owe, or one held by "Reply needed"); `latest`: the
 * newest message from someone else, when "Reply needed" can go on the row at all (not notes to self, not where you
 * wrote last, not mail without a reply owed).
 */
export function MarkableRow({ rowKey, kind, ids, owedSince, canNeed, latest, children }: { rowKey: string; kind: 'conversation' | 'mail'; ids: string[]; owedSince: number | null | undefined; canNeed: boolean; latest?: string; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const g = useRef<Swipe | null>(null);
  const owes = owedSince != null;
  const mark: P.ReplyMark | null = owes ? 'none' : canNeed ? 'needs' : null;
  // Nothing to mark: the row as it is, with no wrapper.
  if (!mark) return <>{children}</>;
  const label = REPLY_MARK_LABEL[mark];
  const run = () => void markRow(kind, ids, mark, latest);

  const fg = () => box.current?.querySelector<HTMLElement>(':scope > .row');
  const setX = (x: number, ms = 0) => {
    const el = fg();
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none';
    el.style.transform = x ? `translateX(${x}px)` : '';
  };
  const stop = (ms: number) => {
    setX(0, ms);
    const b = box.current;
    setTimeout(() => {
      b?.classList.remove('swiping', 'armed');
      b?.querySelector(':scope > .row-swipe-under')?.remove();
    }, ms);
  };
  /** What the swipe will do, under the row: made when a swipe starts, so a list of rows carries none of it. */
  const reveal = () => {
    const b = box.current;
    if (!b || b.querySelector(':scope > .row-swipe-under')) return;
    const under = document.createElement('div');
    under.className = 'row-swipe-under';
    under.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    span.append(document.createElement('i'), label);
    under.append(span);
    b.prepend(under);
    b.classList.add('swiping');
  };

  const onTouchStart = (e: TouchEvent) => {
    g.current = null;
    if (e.touches.length !== 1 || drag.value) return;
    const p = e.touches[0];
    g.current = { x0: p.clientX, y0: p.clientY, on: false, x: 0, armed: false, layers: layerCount(), samples: [{ x: p.clientX, t: performance.now() }] };
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = g.current;
    if (!s) return;
    if (e.touches.length !== 1) return onTouchCancel();
    const p = e.touches[0];
    const dx = p.clientX - s.x0;
    const dy = p.clientY - s.y0;
    if (!s.on) {
      // A hold that became a drag, or opened the row's sheet: the finger is theirs now.
      if (drag.value || layerCount() > s.layers) return void (g.current = null);
      const axis = lockAxis(dx, dy);
      if (!axis) return;
      // Down is the list's scroll; right is the pager's (back).
      if (axis === 'y' || dx > 0) return void (g.current = null);
      s.on = true;
      reveal();
    }
    if (e.cancelable) e.preventDefault();
    s.samples.push({ x: p.clientX, t: performance.now() });
    if (s.samples.length > 5) s.samples.shift();
    s.x = -rubber(Math.max(0, -dx), SWIPE_AT * 1.5);
    setX(s.x);
    const armed = -s.x >= SWIPE_AT;
    if (armed && !s.armed) haptic();
    s.armed = armed;
    box.current?.classList.toggle('armed', armed);
  };
  const onTouchEnd = () => {
    const s = g.current;
    g.current = null;
    if (!s?.on) return;
    swallowUntil = Date.now() + 500;
    const v = velocity(s.samples);
    const go = -s.x >= FLICK_MIN && commits(0, -2 * SWIPE_AT, s.x, v);
    stop(reducedMotion() ? 0 : settleMs(s.x, v, 240));
    if (!go) return;
    countKey(mark === 'none' ? 'inbox: swipe no reply needed' : 'inbox: swipe reply needed');
    run();
  };
  const onTouchCancel = () => {
    const s = g.current;
    g.current = null;
    if (s?.on) stop(0);
  };
  const onClickCapture = (e: MouseEvent) => {
    if (Date.now() >= swallowUntil) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      class={`inbox-row markable ${owes ? 'owes' : 'can-need'} mark-${mark}`}
      data-row-key={rowKey}
      data-claims-swipe="left"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onClickCapture={onClickCapture}
    >
      {children}
      {/* Its ↩ and ✕ are drawn by styles.css: one element per row, as the perf budget counts them. */}
      <button type="button" class="row-mark" aria-label={label} title={label} data-track={mark === 'none' ? 'mark no reply needed' : 'mark reply needed'} onClick={run}>
        {owes ? <Age at={owedSince!} /> : null}
      </button>
    </div>
  );
}
