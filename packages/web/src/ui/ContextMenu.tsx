/**
 * Right-click menus, one component for all of them (docs/menus.md). On a desktop it opens at the pointer, stays
 * inside the window, has submenus and works from the keyboard; Shift+right-click is left to the browser. On a
 * phone the same items open as a bottom sheet, from a long press.
 */
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { phone, useLayer } from '../phone.ts';
import { rev, route, toast } from '../state.ts';
import { countKey } from '../clicklog.ts';
import { fullKey, pageOf } from '../clicks.ts';
import { Icon } from './icons.tsx';
import { useLongPress } from './Reactions.tsx';
import { Sheet } from './Sheet.tsx';

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      icon?: string;
      /** A key shown at the right. A letter (or Del) also picks the item while the menu is open. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** A setting that is on: a tick, or a dot when `radio`. */
      checked?: boolean;
      radio?: boolean;
      sub?: MenuEntry[];
      /** A dot of this colour (any CSS background) before the label: a mail account's colour. */
      dot?: string;
      run?: () => void;
      /** Its key for button counts (clicks.ts): a fixed string, never the label, which may hold a name. */
      track?: string;
    }
  | { kind: 'sep' }
  | { kind: 'label'; label: string }
  /** Anything else in a row of its own, such as quick reactions. Not reachable by arrow keys. */
  | { kind: 'row'; render: (close: () => void, sheet: boolean) => ComponentChildren };

type Item = Extract<MenuEntry, { label: string; kind?: 'item' }>;

export interface MenuSpec {
  items: MenuEntry[];
  /** The sheet's header on a phone: what the menu is about. */
  head?: ComponentChildren;
  /** Below the items, in the sheet only. */
  foot?: ComponentChildren;
  label?: string;
  /** The area its items' keys count under (clicks.ts), such as "message menu". */
  track?: string;
}

/** Groups of items with a line between each; empty groups and stray lines go. */
export function groups(...gs: (MenuEntry | false | null | undefined | '' | 0)[][]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const g of gs) {
    const items = g.filter(Boolean) as MenuEntry[];
    if (!items.length) continue;
    if (out.length) out.push({ kind: 'sep' });
    out.push(...items);
  }
  return out;
}

const isItem = (e: MenuEntry): e is Item => !e.kind || e.kind === 'item';
const selectable = (e: MenuEntry) => isItem(e) && !e.disabled;

export const contextMenu = signal<(MenuSpec & { x: number; y: number }) | null>(null);

let lastAt = { x: 0, y: 0 };
/** Where the last menu opened, for what an item opens in its place (who reacted). */
export const menuPoint = () => new DOMRect(lastAt.x, lastAt.y, 0, 0);

export function openMenu(at: { x: number; y: number }, spec: MenuSpec | null) {
  if (!spec || !spec.items.length) return;
  lastAt = { x: at.x, y: at.y };
  contextMenu.value = { ...spec, x: at.x, y: at.y };
}
export const closeMenu = () => (contextMenu.value = null);

/** onContextMenu for anything with a menu. The innermost one wins; Shift+right-click gets the browser's own. */
export function onMenu(build: () => MenuSpec | null) {
  return (e: MouseEvent & { menuTaken?: boolean }) => {
    // Something inside answered it already (a reaction pill shows who reacted).
    if (e.shiftKey || e.menuTaken || e.defaultPrevented) return;
    // Android fires contextmenu for a long press as well; the long press opens it there.
    if ((e as PointerEvent).pointerType === 'touch' || (phone.value && matchMedia('(pointer: coarse)').matches)) return void e.preventDefault();
    const spec = build();
    if (!spec) return;
    e.menuTaken = true;
    e.preventDefault();
    openMenu({ x: e.clientX, y: e.clientY }, spec);
  };
}

/** Right-click and long-press on one element. A hook: call it from the component that renders the element. */
export function useMenu(build: () => MenuSpec | null) {
  const press = useLongPress((e) => openMenu({ x: e.clientX, y: e.clientY }, build()));
  return { ...press, onContextMenu: onMenu(build) };
}

/** useMenu for things drawn in a loop: `<Menuable build={…}>{(p) => <button {...p}>…</button>}</Menuable>`. */
export function Menuable({ build, children }: { build: () => MenuSpec | null; children: (props: ReturnType<typeof useMenu>) => ComponentChildren }) {
  return <>{children(useMenu(build))}</>;
}

export async function copy(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast({ kind: 'info', title: what, body: '' }, 1500);
  } catch {
    toast({ kind: 'error', title: 'Could not copy', body: 'The browser refused.' });
  }
}

// ------------------------------------------------------------------ desktop

const PAD = 8;

/** Where a box of this size goes: at the point, flipped or pushed back inside the window. */
export function place(x: number, y: number, w: number, h: number, vw: number, vh: number, flipX?: number): { left: number; top: number } {
  let left = x;
  if (left + w > vw - PAD) left = flipX !== undefined ? flipX - w : x - w;
  left = Math.max(PAD, Math.min(left, vw - w - PAD));
  const top = Math.max(PAD, Math.min(y, vh - h - PAD));
  return { left, top };
}

function Panel({ items, x, y, flipX, depth, onClose, onBack, autoFocus, track }: { items: MenuEntry[]; x: number; y: number; flipX?: number; depth: number; onClose: () => void; onBack?: () => void; autoFocus: 'first' | 'none'; track?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(autoFocus === 'first' ? items.findIndex(selectable) : -1);
  const [open, setOpen] = useState<{ index: number; x: number; y: number; flipX: number; focus: 'first' | 'none' } | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = place(x, y, r.width, r.height, innerWidth, innerHeight, flipX);
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.visibility = 'visible';
    el.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => () => clearTimeout(hover.current), []);

  const openSub = (i: number, focus: 'first' | 'none') => {
    const row = box.current?.querySelector<HTMLElement>(`[data-i="${i}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    setOpen({ index: i, x: r.right - 2, y: r.top - 6, flipX: r.left + 2, focus });
  };
  const activate = (i: number) => {
    const e = items[i];
    if (!e || !isItem(e) || e.disabled) return;
    if (e.sub) return openSub(i, 'first');
    onClose();
    e.run?.();
  };
  const move = (d: 1 | -1) => {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const j = (((active < 0 ? (d > 0 ? -1 : 0) : active) + d * k) % n + n) % n;
      if (selectable(items[j])) return setActive(j);
    }
  };
  const key = (e: KeyboardEvent) => {
    if (open) return; // the submenu has it
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === 'ArrowDown') return stop(), move(1);
    if (e.key === 'ArrowUp') return stop(), move(-1);
    if (e.key === 'Home') return stop(), setActive(items.findIndex(selectable));
    if (e.key === 'End') return stop(), setActive(items.length - 1 - [...items].reverse().findIndex(selectable));
    if (e.key === 'Enter' || e.key === ' ') return stop(), activate(active);
    if (e.key === 'ArrowRight') {
      const it = items[active];
      if (it && isItem(it) && it.sub && !it.disabled) openSub(active, 'first');
      return stop();
    }
    if (e.key === 'ArrowLeft' && onBack) return stop(), onBack();
    if (e.key === 'Escape') return stop(), (onBack ?? onClose)();
    if (e.key === 'Tab') return stop(), onClose();
    const name = e.key === 'Delete' || e.key === 'Backspace' ? 'del' : e.key.length === 1 ? e.key.toLowerCase() : null;
    if (name && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = items.findIndex((x) => selectable(x) && (x as Item).hint?.toLowerCase() === name);
      if (i >= 0) {
        const it = items[i] as Item;
        if (it.track) countKey(`${fullKey(it.track, track ?? null, pageOf(route.value))} (key ${it.hint})`);
        return stop(), activate(i);
      }
    }
  };
  const sub = open ? items[open.index] : null;
  return (
    <>
      <div class={`cm ${depth ? 'cm-sub' : ''}`} ref={box} role="menu" tabIndex={-1} onKeyDown={key} style={{ visibility: 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((e, i) => {
          if (e.kind === 'sep') return <div class="cm-sep" role="separator" />;
          if (e.kind === 'label') return <div class="cm-label">{e.label}</div>;
          if (e.kind === 'row') return <div class="cm-row">{e.render(onClose, false)}</div>;
          return (
            <button
              data-i={i}
              data-track={e.track}
              class={`cm-item ${e.danger ? 'danger' : ''} ${i === active ? 'active' : ''}`}
              role={e.checked !== undefined ? (e.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem'}
              aria-checked={e.checked}
              aria-haspopup={e.sub ? 'menu' : undefined}
              aria-expanded={e.sub ? open?.index === i : undefined}
              disabled={e.disabled}
              tabIndex={-1}
              onMouseEnter={() => {
                setActive(i);
                clearTimeout(hover.current);
                if (open && open.index !== i) setOpen(null);
                if (e.sub && !e.disabled) hover.current = setTimeout(() => openSub(i, 'none'), 120);
              }}
              onClick={() => activate(i)}
            >
              {e.dot && <span class="cm-dot" style={{ background: e.dot }} aria-hidden="true" />}
              <span class="cm-text">{e.label}</span>
              {e.hint && <kbd class="cm-hint">{e.hint}</kbd>}
              {e.checked !== undefined && <span class={`cm-check ${e.radio ? 'radio' : ''} ${e.checked ? 'on' : ''}`} aria-hidden="true">{!e.radio && e.checked && <Icon name="check" size={13} />}</span>}
              {e.sub ? <Icon name="chevronRight" size={14} class="cm-icon" /> : e.icon && e.checked === undefined && <Icon name={e.icon} size={16} class="cm-icon" />}
            </button>
          );
        })}
      </div>
      {open && sub && isItem(sub) && sub.sub && (
        <Panel
          key={open.index}
          items={sub.sub}
          x={open.x}
          y={open.y}
          flipX={open.flipX}
          depth={depth + 1}
          autoFocus={open.focus}
          track={track}
          onClose={onClose}
          onBack={() => {
            setOpen(null);
            box.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

function DesktopMenu({ spec, onClose }: { spec: MenuSpec & { x: number; y: number }; onClose: () => void }) {
  useLayer(onClose);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const outside = (e: Event) => root.current && !root.current.contains(e.target as Node) && onClose();
    const gone = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', outside, { capture: true, passive: true });
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', gone);
    window.addEventListener('blur', gone);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('blur', gone);
      if (before?.isConnected && document.activeElement?.closest('.cm-root') !== null) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div class="cm-root" ref={root} aria-label={spec.label} data-track-area={spec.track}>
      <Panel items={spec.items} x={spec.x} y={spec.y} depth={0} onClose={onClose} autoFocus="none" track={spec.track} />
    </div>
  );
}

// ------------------------------------------------------------------ phone

function SheetMenu({ spec, onClose }: { spec: MenuSpec; onClose: () => void }) {
  const [stack, setStack] = useState<{ title: string; items: MenuEntry[] }[]>([]);
  const top = stack[stack.length - 1];
  const items = top?.items ?? spec.items;
  return (
    <Sheet onClose={onClose} label={spec.label ?? 'Menu'} class="cm-sheet">
      {top ? (
        <button class="cm-sheet-back" onClick={() => setStack(stack.slice(0, -1))}>
          <Icon name="back" size={18} /> {top.title}
        </button>
      ) : (
        spec.head
      )}
      <div class="sheet-actions" role="menu" data-track-area={spec.track}>
        {items.map((e) => {
          if (e.kind === 'sep') return <div class="cm-sep" role="separator" />;
          if (e.kind === 'label') return <div class="cm-label">{e.label}</div>;
          if (e.kind === 'row') return e.render(onClose, true);
          return (
            <button
              data-track={e.track}
              class={`sheet-action ${e.danger ? 'danger' : ''}`}
              role="menuitem"
              aria-checked={e.checked}
              disabled={e.disabled}
              onClick={() => {
                if (e.sub) return setStack([...stack, { title: e.label, items: e.sub }]);
                onClose();
                e.run?.();
              }}
            >
              <Icon name={e.sub ? 'chevronRight' : e.checked ? 'check' : (e.icon ?? 'chevronRight')} size={20} class={e.checked === false || (!e.icon && !e.sub && !e.checked) ? 'cm-blank' : ''} />
              {e.dot && <span class="cm-dot" style={{ background: e.dot }} aria-hidden="true" />}
              <span class="cm-text">{e.label}</span>
            </button>
          );
        })}
      </div>
      {!top && spec.foot}
    </Sheet>
  );
}

/** Mounted once at the app root. */
export function ContextMenuLayer() {
  // Rows draw from `db` (a menu's level, who is in it): an open menu follows it.
  rev.value;
  const m = contextMenu.value;
  if (!m) return null;
  // A new menu replaces the old one outright, so its position and focus start over.
  const key = `${m.x},${m.y},${m.items.length}`;
  return phone.value ? <SheetMenu key={key} spec={m} onClose={closeMenu} /> : <DesktopMenu key={key} spec={m} onClose={closeMenu} />;
}
