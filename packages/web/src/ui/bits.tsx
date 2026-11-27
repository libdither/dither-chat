import { createPortal, type ComponentChildren } from 'preact';
import { computed } from '@preact/signals';
import { memo } from './memo.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { GLYPH } from '../brand.ts';
import { linkParts } from '../links.ts';
import { hueOf, initials } from '../format.ts';
import { annotateAccounts, netColor, netName, usualAccount } from '../model.ts';
import { db, go, metaRev } from '../state.ts';
import { phone, slideAway, useLayer, useSheetDrag } from '../phone.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';
import { onMenu } from './ContextMenu.tsx';
import { accountMenu } from './accountMenu.tsx';
import { drawLater } from './Later.tsx';
import { PresenceDot, type PresenceOf } from './PresenceDot.tsx';

/** `decorative`: hidden from screen readers, for where the network is already said in words around it. */
export function NetGlyph({ network, size = 14, color, decorative }: { network: P.Network; size?: number; color?: string; decorative?: boolean }) {
  return (
    <svg class="net-glyph" width={size} height={size} viewBox="0 0 24 24" fill={color ?? 'currentColor'} {...(decorative ? { 'aria-hidden': 'true' as const } : { 'aria-label': netName(network) })}>
      <path d={GLYPH[network]} />
    </svg>
  );
}

/**
 * Round source badge: network colour with its glyph. Kept when its row is drawn again (its props are plain values): an
 * inbox row drawn again need not draw its picture's badge.
 */
export const NetBadge = memo(function NetBadge({ network, size = 16, class: cls }: { network: P.Network; size?: number; class?: string }) {
  return (
    <span class={`net-badge ${cls ?? ''}`} style={{ width: `${size}px`, height: `${size}px`, background: netColor(network) }} title={netName(network)}>
      <NetGlyph network={network} size={Math.round(size * 0.62)} color="#fff" />
    </span>
  );
});

/**
 * Coloured dots for the accounts that see something. Hidden when the network has only one account, and where only the
 * network's usual account sees it (usualAccount): a dot means "another account of yours", not "your account".
 */
/** The accounts AccountDots shows, none where it shows none. */
function dotted(network: P.Network, accountIds: string[], force?: boolean): P.AccountView[] {
  if (!force && !annotateAccounts(network)) return [];
  const accs = accountIds.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  if (!force && accs.length === 1 && accs[0].id === usualAccount(network)) return [];
  return accs;
}

/** What AccountDots draws, as a string: a memoised row given it draws again when the dots would change, and not for every setting. */
export const dotsLook = (network: P.Network, accountIds: string[]) =>
  dotted(network, accountIds)
    .map((a) => `${a.color} ${a.label}`)
    .join('|');

/**
 * What every AccountDots draws from, as a string: whether each network's chats are annotated, its usual account, and
 * each account's colour and label. It follows `metaRev`, and the dots draw again only when it changes, not for every
 * name, rule or status that moves `metaRev` (docs/perf.md "What redraws").
 */
const dotsSource = computed(() => {
  metaRev.value;
  const accs = [...db.accounts.values()];
  const nets = [...new Set(accs.map((a) => a.network))].map((n) => `${n} ${annotateAccounts(n)} ${usualAccount(n)}`);
  return `${nets.join('|')}#${accs.map((a) => `${a.id} ${a.color} ${a.label}`).join('|')}`;
});

export function AccountDots({ network, accountIds, size = 8, force }: { network: P.Network; accountIds: string[]; size?: number; force?: boolean }) {
  dotsSource.value;
  const accs = dotted(network, accountIds, force);
  if (!accs.length) return null;
  return (
    <span class="acc-dots" title={`via ${accs.map((a) => a.label).join(' + ')}`}>
      {accs.map((a) => (
        <span class="acc-dot" style={{ width: `${size}px`, height: `${size}px`, background: a.color }} />
      ))}
    </span>
  );
}

/** One of your accounts. `net`: its network's icon in place of its colour dot, where the chip stands for the network too. */
export function AccountChip({ account, small, net }: { account: P.AccountView; small?: boolean; net?: boolean }) {
  return (
    <span class={`acc-chip ${small ? 'small' : ''} ${net ? 'with-net' : ''}`} title={`${netName(account.network)} account “${account.label}”`} onContextMenu={onMenu(() => accountMenu(account))}>
      {net ? <NetGlyph network={account.network} size={11} color={netColor(account.network)} /> : <span class="acc-dot" style={{ background: account.color }} />}
      {account.label}
    </span>
  );
}

/**
 * Under a chat's name: the account of yours it goes through, as one chip with its network's icon in it (docs/chats.md).
 * With no account of yours to show, the network's name in its place.
 */
export function FromChips({ network, accounts }: { network: P.Network; accounts: P.AccountView[] }) {
  if (accounts.length === 0)
    return (
      <span class="acc-chip small with-net" title={netName(network)}>
        <NetGlyph network={network} size={11} color={netColor(network)} decorative />
        {netName(network)}
      </span>
    );
  return (
    <>
      {accounts.map((a) => (
        <AccountChip account={a} small net />
      ))}
    </>
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
  presence,
}: {
  id: string;
  name: string;
  url?: string | null;
  size?: number;
  square?: boolean;
  network?: P.Network;
  accountIds?: string[];
  icon?: string;
  /** Whose status dot it shows (PresenceDot.tsx): none without, and none while their presence is unknown. */
  presence?: PresenceOf;
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
      {presence && <PresenceDot of={presence} size={size} corner={network ? 'top' : undefined} />}
    </span>
  );
}

export function Count({ n, muted }: { n: number; muted?: boolean }) {
  if (!n) return null;
  return <span class={`count ${muted ? 'muted' : ''}`}>{n > 99 ? '99+' : n}</span>;
}

/** One tab of a place's switch row (docs/places.md "The switch row"). */
export interface PlaceTab<T extends string = string> {
  id: T;
  label: string;
  /** Drawn before the label: a network's glyph, a view's icon. */
  icon?: ComponentChildren;
  /** Unread there, as a count after the label. */
  count?: number;
  /** The tooltip, where the label does not say it all. */
  title?: string;
}

/**
 * The switch row under a page's header: the ways one place can be looked at. A channel's Stream, Topics and own
 * messages; a person's networks (All, Signal, Email, Posts); a thread as a chat or a tree. One row, one look and the
 * same keys wherever a place has more than one way: a click or Enter picks, the arrow keys move through the tabs as
 * through radio buttons, Home and End go to the ends. A row that is too wide scrolls sideways (a phone).
 * `track` names the row in the click log ("channel view", "person tab"): a tab is logged as `<track> <id>`.
 */
export function PlaceTabs<T extends string>({ tabs, value, onPick, label, track, class: cls }: { tabs: readonly PlaceTab<T>[]; value: T; onPick: (id: T) => void; label: string; track: string; class?: string }) {
  const row = useRef<HTMLDivElement>(null);
  if (tabs.length < 2) return null;
  const at = Math.max(0, tabs.findIndex((t) => t.id === value));
  const key = (e: KeyboardEvent) => {
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    if (next.id !== value) onPick(next.id);
    // The row is drawn again with the new tab chosen: the focus follows it there.
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus());
  };
  return (
    <div class={`view-switch ${cls ?? ''}`} role="tablist" aria-label={label} ref={row} onKeyDown={key}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          class={`view-switch-btn ${t.id === value ? 'on' : ''}`}
          data-tab={t.id}
          data-track={`${track} ${t.id}`}
          title={t.title}
          onClick={() => t.id !== value && onPick(t.id)}
        >
          {t.icon}
          {t.label}
          {!!t.count && <Count n={t.count} />}
        </button>
      ))}
    </div>
  );
}

/** Dialogs on a phone are bottom sheets: same content, a grabber, and drag down or press back to close. */
function useDialog(onClose: () => void) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const dismiss = () => (phone.value ? slideAway(box.current, () => close.current()) : close.current());
  useLayer(dismiss);
  useSheetDrag(box, () => close.current(), phone.value);
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close.current());
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
  if (drawLater()) return void requestAnimationFrame(to);
  if (document.getElementById(id)) return void to();
  // Settings is a chunk of its own (LazyPane.tsx): opened a moment ago, it may not be drawn yet. Once it is, the same.
  const mo = new MutationObserver(() => {
    const later = drawLater();
    if (!later && !document.getElementById(id)) return;
    mo.disconnect();
    clearTimeout(t);
    requestAnimationFrame(to);
  });
  const t = setTimeout(() => mo.disconnect(), 10_000);
  mo.observe(document.body, { childList: true, subtree: true });
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
    // A phone's menu is a sheet on the body, outside this anchor, and closes itself on a tap past it (Sheet.tsx); a
    // press inside it, or the one a finger lifting from a long-press makes, must not close it here.
    if (!open || phone.value) return;
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

/**
 * Plain text with its links as links (links.ts): web addresses with or without their scheme, Markdown links, and on
 * X an @handle. Each opens in a new tab; a click on one does not reach what the text sits in. `markdown` false: a
 * Markdown link stays as written (a post).
 */
export function Linked({ text, network, markdown = true }: { text: string; network?: P.Network; markdown?: boolean }) {
  return (
    <>
      {linkParts(text, network, markdown).map((p) =>
        typeof p === 'string' ? (
          p
        ) : (
          <a class="text-link" href={p.href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
            {p.label}
          </a>
        ),
      )}
    </>
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
  return { text: 'hash', announcement: 'announcement', forum: 'forum', voice: 'voice', stage: 'stage', media: 'media', rules: 'rules', feed: 'bell', posts: 'quote', follow: 'bell' }[v] ?? 'hash';
}

