/** A bottom sheet with a grabber: drag it down, tap outside it, press Escape or back, and it goes. */
import { createPortal, type ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { slideAway, useLayer, useSheetDrag } from '../phone.ts';

export function Sheet({ onClose, label, class: cls, tall, children }: { onClose: () => void; label: string; class?: string; tall?: boolean; children: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  const gone = useRef(false);
  // The finger that held something down to open this lifts over its backdrop, and may click there.
  const opened = useRef(performance.now());
  const dismiss = () => {
    if (gone.current) return;
    gone.current = true;
    slideAway(panel.current, onClose);
  };
  useLayer(dismiss);
  useSheetDrag(panel, () => {
    gone.current = true;
    onClose();
  });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && dismiss();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // On the body, so nothing it sits in (a message, a sliding card) can clip it or pin it.
  return createPortal(
    <div class="sheet-layer" onClick={(e) => e.target === e.currentTarget && performance.now() - opened.current > 450 && dismiss()}>
      <div class={`sheet ${tall ? 'tall' : ''} ${cls ?? ''}`} ref={panel} role="dialog" aria-modal="true" aria-label={label}>
        <div class="sheet-grip" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
