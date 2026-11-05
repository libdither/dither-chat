/**
 * Discord-style tooltips: a dark bubble beside the thing you point at, with an arrow, shown at once and without the
 * browser's delay. Any element with `data-tip` gets one (`data-tip-sub` adds a dim second line,
 * `data-tip-side="right|top|bottom"` picks the side, right by default). Pointer and keyboard focus show it; touch does not.
 */
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

type Side = 'right' | 'top' | 'bottom';
interface Tip {
  el: HTMLElement;
  text: string;
  sub: string | null;
  side: Side;
}

const tip = signal<Tip | null>(null);

/** Props for an element with a tooltip. The label doubles as its accessible name. */
export const tipProps = (text: string, sub?: string | null, side?: Side) => ({ 'data-tip': text, 'data-tip-sub': sub || undefined, 'data-tip-side': side, 'aria-label': sub ? `${text}, ${sub}` : text });

function show(el: HTMLElement | null) {
  const t = el?.closest<HTMLElement>('[data-tip]');
  if (!t) return void (tip.value = null);
  if (tip.value?.el === t) return;
  tip.value = { el: t, text: t.dataset.tip!, sub: t.dataset.tipSub ?? null, side: (t.dataset.tipSide as Side) ?? 'right' };
}

let started = false;
function start() {
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener('pointerover', (e) => e.pointerType !== 'touch' && show(e.target as HTMLElement), { passive: true });
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget as HTMLElement | null;
    if (!to || to.closest('[data-tip]') !== tip.value?.el) show(to);
  }, { passive: true });
  document.addEventListener('focusin', (e) => (e.target as HTMLElement).matches?.(':focus-visible') && show(e.target as HTMLElement));
  document.addEventListener('focusout', () => (tip.value = null));
  // Anything that moves or covers it hides it: a click, a drag, scrolling, a key.
  for (const ev of ['pointerdown', 'dragstart', 'wheel', 'keydown']) document.addEventListener(ev, () => (tip.value = null), { passive: true, capture: true });
  document.addEventListener('scroll', () => (tip.value = null), { passive: true, capture: true });
  window.addEventListener('blur', () => (tip.value = null));
}

export function TooltipLayer() {
  useEffect(start, []);
  const t = tip.value;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!t || !box.current || !t.el.isConnected) return setPos(null);
    const r = t.el.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    const gap = 10;
    let x = t.side === 'right' ? r.right + gap : r.left + r.width / 2 - b.width / 2;
    let y = t.side === 'right' ? r.top + r.height / 2 - b.height / 2 : t.side === 'top' ? r.top - b.height - gap : r.bottom + gap;
    x = Math.max(6, Math.min(innerWidth - b.width - 6, x));
    y = Math.max(6, Math.min(innerHeight - b.height - 6, y));
    setPos({ x, y });
  }, [t]);
  if (!t) return null;
  return (
    <div ref={box} class={`tooltip tip-${t.side} ${pos ? 'shown' : ''}`} role="tooltip" style={pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : { left: '-9999px', top: '-9999px' }}>
      <b>{t.text}</b>
      {t.sub && <small>{t.sub}</small>}
    </div>
  );
}
