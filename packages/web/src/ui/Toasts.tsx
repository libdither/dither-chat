import { go, toasts } from '../state.ts';
import { Icon } from './icons.tsx';

export function Toasts() {
  const list = toasts.value;
  if (!list.length) return null;
  return (
    <div class="toasts">
      {list.map((t) => (
        <button
          class={`toast ${t.kind ?? 'info'}`}
          onClick={() => {
            if (t.conversationId) go({ view: 'inbox', conv: t.conversationId });
            else if (t.kind === 'notify') go({ view: 'inbox' });
            toasts.value = toasts.value.filter((x) => x.id !== t.id);
          }}
        >
          <span class="toast-icon">
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'notify' ? 'bell' : 'info'} size={16} />
          </span>
          <span class="toast-text">
            <b>{t.title}</b>
            <span>{t.body}</span>
            {t.reasons && t.reasons.length > 0 && <small class="toast-reason">{t.reasons[0]}</small>}
          </span>
          <span class="toast-x" onClick={(e) => { e.stopPropagation(); toasts.value = toasts.value.filter((x) => x.id !== t.id); }}>
            <Icon name="x" size={14} />
          </span>
        </button>
      ))}
    </div>
  );
}
