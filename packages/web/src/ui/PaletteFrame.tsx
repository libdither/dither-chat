/**
 * A palette page's frame (docs/palette.md): the crumbs, the title, the input and the rows, and what each key does on
 * them (palette.ts's keyAct). Every page draws itself in one. Loaded with the pages, the first time the palette opens.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { keyAct, moveSel, paletteStack, type Entry, type KeyTarget } from '../palette.ts';
import { phone } from '../phone.ts';
import { Icon } from './icons.tsx';
import { backPage, closePalette, crumbTo, rootPage, setEntry } from './Palette.tsx';


/** A row Enter or a click takes. Without `run` it is a line to read (a plain "isn't built yet"), skipped by the arrows. */
export interface Row {
  key: string;
  run?: () => void;
  icon?: ComponentChildren;
  label?: ComponentChildren;
  sub?: ComponentChildren;
  class?: string;
  /** data-* attributes, for scripts. */
  data?: Record<string, string>;
  track?: string;
  title?: string;
  /** The row's insides, drawn by the page (a person with a chip per network, a person to pick). */
  inner?: ComponentChildren;
  /** A div rather than a button: for a row that holds buttons of its own. */
  holder?: boolean;
  disabled?: boolean;
  /** For a row that is picked or not. */
  selected?: boolean;
}

/** A page that picks several: Enter picks, Ctrl+Enter goes on, Backspace in an empty input un-picks the last. */
export interface Multi {
  picked: number;
  unpickLast: () => void;
  goOn: () => void;
}

export interface FrameProps {
  e: Entry;
  /** In place of the entry's own title (the picker learns whether it adds or invites). */
  title?: string;
  /** The input, saying what typing does here. None: a page with a body only. */
  placeholder?: string;
  /** On a phone, the keyboard comes up at once: only on pages that are about typing. */
  typing?: boolean;
  rows?: Row[];
  /** Said in the list when it has no rows. */
  empty?: ComponentChildren;
  /** Classes on the page: the old dialogs' names, kept for styles and scripts. */
  class?: string;
  listClass?: string;
  listLabel?: string;
  before?: ComponentChildren;
  body?: ComponentChildren;
  after?: ComponentChildren;
  multi?: Multi;
  /** Enter with no row to take. */
  onEnter?: () => void;
  /** Text pasted into the input, once it is there. */
  onPasted?: (text: string) => void;
}

/** The crumbs, the input and the rows, and what each key does. Every page draws itself in one. */
export function Frame({ e, title, placeholder, typing, rows = [], empty, class: cls, listClass, listLabel, before, body, after, multi, onEnter, onPasted }: FrameProps) {
  const stack = paletteStack.value ?? [e];
  const page = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pasted = useRef(false);
  const byKeys = useRef(false);
  const live = rows.filter((r) => r.run);
  const at = Math.max(0, Math.min(e.sel, live.length - 1));
  const activeKey = live[at]?.key;
  const index = stack.findIndex((x) => x.id === e.id);
  const rootBelow = stack[0]?.kind === 'root';

  // Focus: the input, except on a phone where the page is not about typing (no keyboard unasked); else the box.
  useLayoutEffect(() => {
    if (input.current && (typing || !phone.value)) input.current.focus({ preventScroll: true });
    else page.current?.closest<HTMLElement>('.palette')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!byKeys.current) return;
    byKeys.current = false;
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const keys = useRef<(ev: KeyboardEvent) => void>(() => {});
  keys.current = (ev: KeyboardEvent) => {
    const box = page.current?.closest<HTMLElement>('.palette');
    if (!box || ev.defaultPrevented || ev.isComposing) return;
    // A key sent to the window or the document (nothing has focus) counts as the box's.
    const t = ev.target instanceof Element ? ev.target : document.body;
    if (t !== document.body && !box.contains(t)) return;
    const target: KeyTarget = t === input.current ? 'input' : t === document.body || t === box || t === page.current || t.matches('[data-row]') ? 'box' : 'control';
    const act = keyAct({ key: ev.key, ctrl: ev.ctrlKey || ev.metaKey, alt: ev.altKey, target, empty: !(input.current ? input.current.value : e.q), multi: !!multi, picked: multi?.picked });
    if (!act) return;
    if (act === 'take' && !live.length && !onEnter) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (act === 'back') return backPage();
    if (act === 'unpick') return multi!.unpickLast();
    if (act === 'goOn') return multi!.goOn();
    if (act === 'down' || act === 'up') {
      byKeys.current = true;
      return setEntry(e.id, { sel: moveSel(at, live.length, act === 'down' ? 1 : -1) });
    }
    const r = live[at];
    if (r && !r.disabled) r.run!();
    else if (!r && act === 'take') onEnter?.();
  };
  // Before the browser takes the next key: a key pressed the moment a page appears is this page's.
  useLayoutEffect(() => {
    const k = (ev: KeyboardEvent) => keys.current(ev);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const hover = (key: string) => {
    const i = live.findIndex((r) => r.key === key);
    if (i >= 0 && i !== at) setEntry(e.id, { sel: i });
  };
  const crumbs = stack.slice(0, index).map((x, i) => ({ x, i })).filter(({ x }) => x.kind !== 'root');
  const heading = title ?? e.title;
  return (
    <div ref={page} class={`palette-page ${cls ?? ''}`}>
      <div class="palette-head">
        {e.kind !== 'root' && (
          <nav class="palette-crumbs" aria-label="Pages">
            <button class="palette-crumb palette-crumb-root" data-track="crumb (jump to)" title="Jump to (Ctrl+K)" aria-label={rootBelow ? 'Back to Jump to' : 'Jump to'} onClick={rootPage}>
              <Icon name="search" size={14} />
            </button>
            <span class="palette-sep" aria-hidden="true">›</span>
            {crumbs.map(({ x, i }) => (
              <>
                <button class="palette-crumb" data-crumb={x.kind} data-track="crumb" title={x.title} onClick={() => crumbTo(i)}>
                  {x.title}
                </button>
                <span class="palette-sep" aria-hidden="true">›</span>
              </>
            ))}
            <h2 class="palette-title" title={heading}>
              {heading}
            </h2>
            {placeholder !== undefined && (
              <span class="palette-sep" aria-hidden="true">›</span>
            )}
          </nav>
        )}
        {placeholder !== undefined && (
          <input
            ref={input}
            class="switcher-input palette-input"
            placeholder={placeholder}
            value={e.q}
            aria-label={placeholder}
            onPaste={() => (pasted.current = true)}
            onInput={(ev) => {
              const value = (ev.target as HTMLInputElement).value;
              setEntry(e.id, { q: value, sel: 0 });
              if (pasted.current) {
                pasted.current = false;
                onPasted?.(value);
              }
            }}
          />
        )}
        {(e.kind !== 'root' || phone.value) && (
          <button class="icon-btn small palette-close" data-track="close" aria-label="Close" title="Close (Esc)" onClick={closePalette}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      {before && <div class="palette-before">{before}</div>}
      {(rows.length > 0 || empty) && (
        <div ref={list} class={`switcher-list ${listClass ?? ''}`} role="listbox" aria-label={listLabel ?? heading} aria-multiselectable={multi ? 'true' : undefined}>
          {rows.map((r) => {
            if (!r.run)
              return (
                <div class={`palette-note ${r.class ?? ''}`} data-key={r.key} {...dataAttrs(r.data)}>
                  {r.inner ?? (
                    <>
                      {r.icon} {r.label}
                    </>
                  )}
                </div>
              );
            const active = r.key === activeKey;
            const props = {
              class: `${r.class ?? 'switcher-row'} ${active ? 'active' : ''}`,
              'data-key': r.key,
              'data-row': '',
              'data-track': r.track,
              title: r.title,
              role: 'option' as const,
              'aria-selected': r.selected ?? active,
              onMouseMove: () => hover(r.key),
              onClick: () => !r.disabled && r.run!(),
              ...dataAttrs(r.data),
            };
            const inner = r.inner ?? (
              <>
                <span class="switcher-icon">{r.icon}</span>
                <span class="switcher-label">{r.label}</span>
                {r.sub !== undefined && <small>{r.sub}</small>}
              </>
            );
            return r.holder ? (
              <div {...props} tabIndex={-1} aria-disabled={r.disabled || undefined}>
                {inner}
              </div>
            ) : (
              <button {...props} type="button" tabIndex={-1} disabled={r.disabled}>
                {inner}
              </button>
            );
          })}
          {!rows.length && empty}
        </div>
      )}
      {body && <div class="palette-body">{body}</div>}
      {after && <div class="palette-after">{after}</div>}
    </div>
  );
}

const dataAttrs = (d?: Record<string, string>) => (d ? Object.fromEntries(Object.entries(d).map(([k, v]) => [`data-${k}`, v])) : {});
