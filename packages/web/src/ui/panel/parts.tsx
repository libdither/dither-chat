/** What the panel's tabs share (ui/panel/Panel.tsx): the pick mark and the header row. */
import type { ComponentChildren } from 'preact';
import { Icon } from '../icons.tsx';

/** A tile's or a row's pick mark: its number once picked, a ring before, a spinner while it is read. */
export function PickMark({ n }: { n: number | null }) {
  return <span class={`kp-pick ${n ? 'on' : ''} ${n === 0 ? 'busy' : ''}`}>{n || ''}</span>;
}

/** A row of the panel's own header: what it shows, and what it does (to the whole screen, back). */
export function PanelHead({ children, full, setFull, title }: { children?: ComponentChildren; full: boolean; setFull: (f: boolean) => void; title?: string }) {
  return (
    <div class="kp-head">
      {full && (
        <button class="icon-btn" data-track="panel back" aria-label="Back" onClick={() => setFull(false)}>
          <Icon name="back" size={18} />
        </button>
      )}
      {title && <span class="kp-title">{title}</span>}
      {children}
    </div>
  );
}
