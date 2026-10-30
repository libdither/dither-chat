import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { GLYPH } from '../brand.ts';
import { hueOf, initials } from '../format.ts';
import { annotateAccounts, netColor, netName } from '../model.ts';
import { db } from '../state.ts';
import { Icon } from './icons.tsx';

export function NetGlyph({ network, size = 14, color }: { network: P.Network; size?: number; color?: string }) {
  return (
    <svg class="net-glyph" width={size} height={size} viewBox="0 0 24 24" fill={color ?? 'currentColor'} aria-label={netName(network)}>
      <path d={GLYPH[network]} />
    </svg>
  );
}

/** Round source badge: network colour with its glyph. */
export function NetBadge({ network, size = 16, class: cls }: { network: P.Network; size?: number; class?: string }) {
  return (
    <span class={`net-badge ${cls ?? ''}`} style={{ width: size, height: size, background: netColor(network) }} title={netName(network)}>
      <NetGlyph network={network} size={Math.round(size * 0.62)} color="#fff" />
    </span>
  );
}

/** Coloured dots for the accounts that see something. Hidden when the network has only one account. */
export function AccountDots({ network, accountIds, size = 8, force }: { network: P.Network; accountIds: string[]; size?: number; force?: boolean }) {
  if (!force && !annotateAccounts(network)) return null;
  const accs = accountIds.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  if (!accs.length) return null;
  return (
    <span class="acc-dots" title={`via ${accs.map((a) => a.label).join(' + ')}`}>
      {accs.map((a) => (
        <span class="acc-dot" style={{ width: size, height: size, background: a.color }} />
      ))}
    </span>
  );
}

export function AccountChip({ account, small }: { account: P.AccountView; small?: boolean }) {
  return (
    <span class={`acc-chip ${small ? 'small' : ''}`} title={`${netName(account.network)} account “${account.label}”`}>
      <span class="acc-dot" style={{ background: account.color }} />
      {account.label}
    </span>
  );
}

/** A labelled source chip: glyph + network (+ account label when it disambiguates). */
export function SourceChip({ network, accountIds }: { network: P.Network; accountIds?: string[] }) {
  const accs = (accountIds ?? []).map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  const multi = annotateAccounts(network);
  return (
    <span class="source-chip" style={{ '--net': netColor(network) } as Record<string, string | number>}>
      <NetGlyph network={network} size={11} />
      {netName(network)}
      {multi &&
        accs.map((a) => (
          <span class="source-acc">
            <span class="acc-dot" style={{ background: a.color }} />
            {a.label}
          </span>
        ))}
    </span>
  );
}

export function Avatar({
  id,
  name,
  url,
  size = 36,
  square,
  network,
  accountIds,
  icon,
}: {
  id: string;
  name: string;
  url?: string | null;
  size?: number;
  square?: boolean;
  network?: P.Network;
  accountIds?: string[];
  icon?: string;
}) {
  const [broken, setBroken] = useState(false);
  const radius = square ? Math.round(size * 0.3) : size / 2;
  return (
    <span class="avatar" style={{ width: size, height: size }}>
      {url && !broken ? (
        <img src={url} alt="" width={size} height={size} style={{ borderRadius: radius }} onError={() => setBroken(true)} loading="lazy" />
      ) : (
        <span class="avatar-fallback" style={{ borderRadius: radius, background: hueOf(id), fontSize: Math.max(10, Math.round(size * (icon ? 0.5 : 0.36))) }}>
          {icon ?? initials(name)}
        </span>
      )}
      {network && <NetBadge network={network} size={Math.max(13, Math.round(size * 0.42))} class="avatar-net" />}
      {network && accountIds && (
        <span class="avatar-accs">
          <AccountDots network={network} accountIds={accountIds} size={Math.max(6, Math.round(size * 0.2))} />
        </span>
      )}
    </span>
  );
}

export function Count({ n, muted }: { n: number; muted?: boolean }) {
  if (!n) return null;
  return <span class={`count ${muted ? 'muted' : ''}`}>{n > 99 ? '99+' : n}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Small anchored menu that closes on outside click. */
export function Menu({ trigger, children, align = 'left', up }: { trigger: (open: () => void) => ComponentChildren; children: (close: () => void) => ComponentChildren; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div class="menu-anchor" ref={ref}>
      {trigger(() => setOpen(!open))}
      {open && <div class={`menu ${align} ${up ? 'up' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} size={30} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function variantIcon(v: P.Variant, shape?: P.Shape): string {
  if (shape === 'thread') return 'thread';
  return { text: 'hash', announcement: 'announcement', forum: 'forum', voice: 'voice', stage: 'stage', media: 'media', rules: 'rules' }[v] ?? 'hash';
}

export function levelIcon(l: P.NotifyLevel): string {
  return { all: 'bell', smart: 'sparkles', mentions: 'at', digest: 'layers', none: 'bellOff' }[l];
}
