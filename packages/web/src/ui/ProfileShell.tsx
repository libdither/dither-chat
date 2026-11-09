/**
 * The frame every profile page shares (docs/profile.md): a person's, or a conversation's or space's. A hero with a
 * banner, the picture, the name and what it is; one row of actions with the rest under "More"; then cards in two
 * columns, what it is and what you share on the left, how you stand with it on the right. One column on a phone.
 */
import type { ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { Avatar } from './bits.tsx';
import { openMenu, type MenuSpec } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';

export function ProfilePage({ title, onBack, children, label }: { title: string; onBack: () => void; children: ComponentChildren; label: string }) {
  return (
    <section class="pane profile-page" aria-label={label}>
      <header class="conv-head pf-head">
        <button class="icon-btn back-btn profile-back" data-track="pager: back button" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="conv-head-text">
          <h2>{title}</h2>
        </div>
      </header>
      <div class="pf-scroll">{children}</div>
    </section>
  );
}

/** The banner's colour when there is no picture: what the network gave, else the network's own. */
export function bannerStyle(banner: string | null | undefined, accent: string | null | undefined, network: P.Network | undefined): Record<string, string> {
  const c = accent ?? (network ? NETWORK_META[network].color : 'var(--accent)');
  return banner ? { '--pf-accent': c, backgroundImage: `url("${banner}")` } : { '--pf-accent': c };
}

export function Hero({
  id,
  name,
  picture,
  square,
  network,
  banner,
  accent,
  title,
  sub,
  tags,
  status,
  actions,
}: {
  id: string;
  name: string;
  picture?: string | null;
  square?: boolean;
  network?: P.Network;
  banner?: string | null;
  accent?: string | null;
  /** The name, or an editable one. */
  title: ComponentChildren;
  sub?: ComponentChildren;
  tags?: ComponentChildren;
  status?: ComponentChildren;
  actions?: ComponentChildren;
}) {
  return (
    <section class="pf-hero">
      <div class={`pf-banner ${banner ? 'pic' : ''}`} style={bannerStyle(banner, accent, network)} />
      <div class="pf-ident">
        <span class={`pf-avatar ${square ? 'square' : ''}`}>
          <Avatar id={id} name={name} url={picture} size={92} square={square} />
        </span>
        <div class="pf-names">
          <div class="pf-title">{title}</div>
          {sub && <div class="pf-sub">{sub}</div>}
          {tags && <div class="pf-tags">{tags}</div>}
          {status && <div class="pf-status">{status}</div>}
        </div>
      </div>
      {actions && <div class="pf-actions">{actions}</div>}
    </section>
  );
}

export function Columns({ main, side }: { main: ComponentChildren; side: ComponentChildren }) {
  return (
    <div class="pf-cols">
      <div class="pf-main">{main}</div>
      <aside class="pf-side">{side}</aside>
    </div>
  );
}

export function Card({ title, icon, count, extra, children, class: cls }: { title: string; icon?: string; count?: number; extra?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`pf-card ${cls ?? ''}`}>
      <h3>
        {icon && <Icon name={icon} size={14} />}
        <span>{title}</span>
        {count !== undefined && <span class="pf-count">{count}</span>}
        {extra && <span class="pf-card-extra">{extra}</span>}
      </h3>
      {children}
    </section>
  );
}

export function Tag({ icon, children, tone, title }: { icon?: string; children: ComponentChildren; tone?: 'accent' | 'warn' | 'muted'; title?: string }) {
  return (
    <span class={`pf-tag ${tone ?? ''}`} title={title}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

/** An action in the hero's row. `menu`: it opens a menu under itself instead. `kind`: its data-action, for scripts. */
export function Action({ icon, label, onClick, menu, primary, on, title, disabled, kind }: { icon: string; label: string; onClick?: () => void; menu?: () => MenuSpec | null; primary?: boolean; on?: boolean; title?: string; disabled?: boolean; kind?: string }) {
  return (
    <button
      class={`pf-action ${primary ? 'primary' : ''} ${on ? 'on' : ''}`}
      title={title ?? label}
      disabled={disabled}
      data-action={kind}
      onClick={(e) => {
        if (menu) {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu({ x: r.left, y: r.bottom + 4 }, menu());
        } else onClick?.();
      }}
    >
      <Icon name={icon} size={15} />
      <span>{label}</span>
      {menu && <Icon name="chevronDown" size={12} />}
    </button>
  );
}

/** Label and value pairs. */
export function Facts({ rows }: { rows: ([ComponentChildren, ComponentChildren] | null | false | undefined)[] }) {
  const shown = rows.filter((r): r is [ComponentChildren, ComponentChildren] => !!r);
  if (!shown.length) return null;
  return (
    <dl class="pf-facts">
      {shown.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

export const monthYear = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
