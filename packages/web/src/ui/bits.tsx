import { createPortal, type ComponentChildren, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { GLYPH } from '../brand.ts';
import { hueOf, initials } from '../format.ts';
import { annotateAccounts, netColor, netName } from '../model.ts';
import { db } from '../state.ts';
import { phone, slideAway, useLayer, useSheetDrag } from '../phone.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';
import { onMenu } from './ContextMenu.tsx';
import { accountMenu } from './menus.tsx';

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
  const [broken, setBroken] = useState(false);
  const radius = square ? Math.round(size * 0.3) : size / 2;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }}>
      {url && !broken ? (
        <img src={url} alt="" width={size} height={size} style={{ borderRadius: `${radius}px` }} onError={() => setBroken(true)} loading="lazy" />
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

export function levelIcon(l: P.NotifyLevel): string {
  return { all: 'bell', smart: 'sparkles', mentions: 'at', digest: 'layers', none: 'bellOff' }[l];
}

/**
 * Grey shapes where content is about to land, so the layout does not jump when it does. They wait a moment before
 * showing (CSS), so a load that is quick shows nothing at all, and one wave of light crosses all of them together.
 * Messages come as Discord draws them: groups of a name and one to three lines, now and then a picture.
 */
export function Skeleton({ rows = 5, kind = 'row' }: { rows?: number; kind?: 'row' | 'msg' }) {
  // Fixed, varied shapes: the same every time, so a skeleton that reappears does not reshuffle.
  const w = (i: number, k: number) => 22 + ((i * 37 + k * 53) % 61);
  if (kind === 'msg')
    return (
      <div class="skeleton msg" role="status" aria-label="Loading messages">
        {Array.from({ length: rows }, (_, i) => (
          <div class="sk-item">
            <span class="sk-avatar" />
            <span class="sk-lines">
              <span class="sk-head">
                <span class="sk-line sk-name" style={{ width: `${70 + ((i * 41) % 70)}px` }} />
                <span class="sk-line sk-time" />
              </span>
              {Array.from({ length: 1 + ((i * 7) % 3) }, (_, k) => (
                <span class="sk-line" style={{ width: `${w(i, k) + 15}%` }} />
              ))}
              {i % 4 === 2 && <span class="sk-media" />}
            </span>
          </div>
        ))}
      </div>
    );
  return (
    <div class="skeleton row" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div class="sk-item">
          <span class="sk-avatar" />
          <span class="sk-lines">
            <span class="sk-line sk-name" style={{ width: `${w(i, 0)}%` }} />
            <span class="sk-line" style={{ width: `${w(i, 1) + 20}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}
