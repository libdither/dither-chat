import { createPortal, type ComponentChildren, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { GLYPH } from '../brand.ts';
import { hueOf, initials } from '../format.ts';
import { annotateAccounts, netColor, netName } from '../model.ts';
import { db, go } from '../state.ts';
import { phone, slideAway, useLayer, useSheetDrag } from '../phone.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';
import { onMenu } from './ContextMenu.tsx';
import { accountMenu } from './menus.tsx';
import { drawLater } from './Later.tsx';

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
    <span class={`net-badge ${cls ?? ''}`} style={{ width: `${size}px`, height: `${size}px`, background: netColor(network) }} title={netName(network)}>
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
        <span class="acc-dot" style={{ width: `${size}px`, height: `${size}px`, background: a.color }} />
      ))}
    </span>
  );
}

export function AccountChip({ account, small }: { account: P.AccountView; small?: boolean }) {
  return (
    <span class={`acc-chip ${small ? 'small' : ''}`} title={`${netName(account.network)} account “${account.label}”`} onContextMenu={onMenu(() => accountMenu(account))}>
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
  // The picture that failed, not "failed": a group whose picture arrives later (or changes) shows the new one.
  const [broken, setBroken] = useState<string | null>(null);
  const radius = square ? Math.round(size * 0.3) : size / 2;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }}>
      {url && broken !== url ? (
        <img src={url} alt="" width={size} height={size} style={{ borderRadius: `${radius}px` }} onError={() => setBroken(url)} loading="lazy" />
      ) : (
        <span class="avatar-fallback" style={{ borderRadius: `${radius}px`, background: hueOf(id), fontSize: `${Math.max(10, Math.round(size * (icon ? 0.5 : 0.36)))}px` }}>
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

/** Dialogs on a phone are bottom sheets: same content, a grabber, and drag down or press back to close. */
export function useDialog(onClose: () => void) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const dismiss = () => (phone.value ? slideAway(box.current, () => close.current()) : close.current());
  useLayer(dismiss);
  useSheetDrag(box, () => close.current(), phone.value);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return { box, dismiss };
}

export function Modal({ title, onClose, children, wide }: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  const { box, dismiss } = useDialog(onClose);
  return createPortal(
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && dismiss()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" ref={box}>
        <div class="sheet-grip" aria-hidden="true" />
        <header class="modal-head">
          <h2>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div class="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Scrolls Settings to one of its sections (`set-adversarial`). */
export function showSection(id: string, behavior: ScrollBehavior = 'smooth') {
  const to = () => document.getElementById(id)?.scrollIntoView({ behavior, block: 'start' });
  // Parts of the page drawn later (Later.tsx) are drawn first, the section's own or those below it, and it is gone to
  // once they are.
  if (drawLater()) requestAnimationFrame(to);
  else to();
}

/** Opens Settings at Adversarial features. */
export function openAdversarial() {
  go({ view: 'settings' });
  setTimeout(() => showSection('set-adversarial', 'auto'), 120);
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
      {open &&
        (phone.value ? (
          <Sheet onClose={() => setOpen(false)} label="Menu">
            <div class="sheet-menu">{children(() => setOpen(false))}</div>
          </Sheet>
        ) : (
          <div class={`menu ${align} ${up ? 'up' : ''}`}>{children(() => setOpen(false))}</div>
        ))}
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

