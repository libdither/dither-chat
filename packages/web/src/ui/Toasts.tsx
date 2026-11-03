import { useRef } from 'preact/hooks';
import { lockAxis, velocity } from '../gesture.ts';
import { reducedMotion } from '../phone.ts';
import { go, toasts, type Toast } from '../state.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';

const dismiss = (id: number) => (toasts.value = toasts.value.filter((x) => x.id !== id));

/** On a phone a toast is flicked away, sideways or up, the way a system notification is. */
function useFlick(id: number) {
  const g = useRef<{ x: number; y: number; axis: 'x' | 'y' | null; samples: { x: number; t: number }[] } | null>(null);
  const moved = useRef(false);
  const el = (e: Event) => e.currentTarget as HTMLElement;
  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      g.current = { x: t.clientX, y: t.clientY, axis: null, samples: [{ x: t.clientX, t: performance.now() }] };
      moved.current = false;
    },
    onTouchMove: (e: TouchEvent) => {
      const s = g.current;
      if (!s) return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      s.axis ??= lockAxis(dx, dy, 6);
      if (!s.axis) return;
      moved.current = true;
      if (e.cancelable) e.preventDefault();
      s.samples.push({ x: s.axis === 'x' ? t.clientX : t.clientY, t: performance.now() });
      if (s.samples.length > 5) s.samples.shift();
      const box = el(e);
      box.style.transition = 'none';
      box.style.transform = s.axis === 'x' ? `translateX(${dx}px)` : `translateY(${Math.min(0, dy)}px)`;
      box.style.opacity = String(1 - Math.min(1, Math.abs(s.axis === 'x' ? dx : Math.min(0, dy)) / 200));
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = g.current;
      g.current = null;
      if (!s?.axis) return;
      const box = el(e);
      const last = s.samples[s.samples.length - 1].x - (s.axis === 'x' ? s.x : s.y);
      const v = velocity(s.samples);
      const ms = reducedMotion() ? 0 : 160;
      box.style.transition = `transform ${ms}ms, opacity ${ms}ms`;
      if (Math.abs(last) > 80 || Math.abs(v) > 0.5) {
        box.style.transform = s.axis === 'x' ? `translateX(${Math.sign(last || v) * 420}px)` : 'translateY(-160px)';
        box.style.opacity = '0';
        setTimeout(() => dismiss(id), ms);
      } else {
        box.style.transform = '';
        box.style.opacity = '';
      }
    },
    // A flick is not a tap.
    onClickCapture: (e: Event) => moved.current && (e.stopPropagation(), e.preventDefault()),
  };
}

function ToastItem({ t }: { t: Toast }) {
  const flick = useFlick(t.id);
  return (
    <button
      class={`toast ${t.kind ?? 'info'}`}
      {...flick}
      onClick={() => {
        if (t.conversationId) go({ view: 'inbox', conv: t.conversationId });
        else if (t.kind === 'notify') go({ view: 'inbox' });
        dismiss(t.id);
      }}
    >
      {t.kind === 'notify' && t.network ? (
        // The sender, with the network it came through, as the system notification shows them.
        <Avatar id={t.conversationId ?? t.title} name={t.title.replace(/ · [^·]+$/, '')} url={t.icon} network={t.network} size={34} />
      ) : (
        <span class="toast-icon">
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'notify' ? 'bell' : 'info'} size={16} />
        </span>
      )}
      <span class="toast-text">
        <b>{t.title}</b>
        <span>{t.body}</span>
        {t.reasons && t.reasons.length > 0 && <small class="toast-reason">{t.reasons[0]}</small>}
      </span>
      <span
        class="toast-x"
        role="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          dismiss(t.id);
        }}
      >
        <Icon name="x" size={14} />
      </span>
    </button>
  );
}

export function Toasts() {
  const list = toasts.value;
  if (!list.length) return null;
  return (
    <div class="toasts">
      {list.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
