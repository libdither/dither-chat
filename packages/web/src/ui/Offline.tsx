/**
 * The hub out of reach for a while (docs/sync.md, "Quiet"): never a bar over what is under it. The logo's own sphere
 * turns in amber where the rail's logo is, or, on a phone page that covers the rail, at the start of its header's
 * buttons; the row over the message box ends with what happens to a send; a tap on the orb says since when, and tries
 * again at once. All of it goes the moment the hub answers.
 */
import { computed, signal } from '@preact/signals';
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { stamp } from '../format.ts';
import { phone, useLayer } from '../phone.ts';
import { connected, offlineSince, pending, tryNow, unreachable } from '../state.ts';
import { DitherOrb } from './Loader.tsx';

/** Out of reach for a while, or a send is waiting for the hub. Short drops are not shown (state.ts NOTICE_AFTER). */
export const offline = computed(() => unreachable.value || (!connected.value && pending.value.some((x) => x.queued)));

/** The orb whose popover is open, which it hangs from. */
const popFrom = signal<HTMLElement | null>(null);

/** A click on an orb: its popover, or closed again. */
export function toggleOfflinePop(from: HTMLElement) {
  popFrom.value = popFrom.value === from ? null : from;
}

/** The loader's turning sphere (Loader.tsx), slower and in amber: a state, not a wait. Still under reduced motion. */
export function OfflineOrb({ size }: { size: number }) {
  return <DitherOrb size={size} appear={false} class="offline-orb" />;
}

/** On a phone page that covers the rail: the orb, first of its header's buttons. Nothing anywhere else. */
export function HeadOrb() {
  if (!offline.value || !phone.value) return null;
  return (
    <button
      class="head-orb"
      data-track="offline orb"
      aria-label="Can't reach the hub"
      aria-haspopup="dialog"
      aria-expanded={!!popFrom.value}
      onClick={(e) => toggleOfflinePop(e.currentTarget)}
    >
      <OfflineOrb size={18} />
    </button>
  );
}

/** The end of the row over the message box (Typing.tsx) while out of reach: what happens to a send. */
export function OfflineNote() {
  return (
    <span class="typing-off" role="status">
      <OfflineOrb size={10} />
      <span class="typing-off-text">Offline · sends when the hub is back</span>
    </span>
  );
}

/** The popover, for App: drawn on the body, so no sliding card can clip or carry it. */
export function OfflineLayer() {
  const from = popFrom.value;
  const shown = offline.value && !!from?.isConnected;
  useEffect(() => {
    if (!shown && from) popFrom.value = null;
  });
  if (!shown) return null;
  return <OfflinePop from={from!} onClose={() => (popFrom.value = null)} />;
}

/** What an hour a time was, as a sentence goes on: "6:01 PM", "yesterday 6:01 PM", "Tue 6:01 PM". */
const sinceLabel = (t: number) => stamp(t).replace(/^Yesterday/, 'yesterday');

function OfflinePop({ from, onClose }: { from: HTMLElement; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [trying, setTrying] = useState(false);
  const [missed, setMissed] = useState(false);
  const [, relayout] = useState(0);
  const close = () => {
    if (box.current?.contains(document.activeElement)) from.focus({ preventScroll: true });
    onClose();
  };
  // Esc, a click anywhere else, and on a phone its back button close it. A click on the orb itself toggles it. Listening
  // from the moment it is drawn (a layout effect, not one after the next paint), so an Esc right away is not missed.
  useLayoutEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !from.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const resize = () => relayout((n) => n + 1);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
    };
  }, [from]);
  useLayoutEffect(() => button.current?.focus({ preventScroll: true }), []);
  const since = offlineSince();
  const b = from.getBoundingClientRect();
  const width = Math.min(272, innerWidth - 24);
  const clamp = (v: number, max: number) => Math.max(12, Math.min(v, max));
  // Beside the rail's orb; under a header's, its right edge on the orb's.
  const [left, top] = from.closest('.rail') ? [b.right + 8, clamp(b.top, innerHeight - 160)] : [clamp(b.right - width, innerWidth - width - 12), b.bottom + 6];
  const again = async () => {
    setTrying(true);
    setMissed(false);
    const answered = await tryNow();
    setTrying(false);
    // The hub did not answer this try either; the app goes on trying by itself. (One that answered closes all this.)
    setMissed(!answered);
  };
  return createPortal(
    <div class="offline-pop" ref={box} role="dialog" aria-labelledby="offline-pop-title" style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}>
      {phone.value && <BackCloses onClose={onClose} />}
      <b id="offline-pop-title">Can't reach the hub</b>
      <p>
        {since !== null && `Since ${sinceLabel(since)}. `}Showing what this device kept; messages you send go out when it's back.
      </p>
      <div class="offline-pop-foot">
        <button class="btn primary small" ref={button} data-track="offline: try now" disabled={trying} onClick={again}>
          {trying ? 'Trying…' : 'Try now'}
        </button>
        {missed && !trying && <span class="offline-pop-missed">No answer yet</span>}
      </div>
    </div>,
    document.body,
  );
}

/** A phone's back button closes the popover before it leaves the page (phone.ts layers). */
function BackCloses({ onClose }: { onClose: () => void }) {
  useLayer(onClose);
  return null;
}
