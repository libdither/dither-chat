/**
 * Sort modes and the Organize view (docs/organize.md): pick how the rail and the lists sort, freeze an
 * automatic order into your own, and rearrange many servers at once, with folders the categories suggest.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, type SortMode, type SortScope } from '@dither-chat/protocol';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { arrange, arrangedFolderItems, arrangedRail, freezeOrder, organizing, patchDismissed, resort, setInteracting, setSort, snapshot, SORT_LABELS, sortOf, startArrange } from '../arrange.ts';
import { ago } from '../format.ts';
import { categoriesOf, convTitle, kindLabel, netName, placePref, railEntries, type RailEntry } from '../model.ts';
import { db, patchPlaces, rev, saveFolders, toast } from '../state.ts';
import { resetUsage, usageSummary } from '../usage.ts';
import { Avatar, Modal } from './bits.tsx';
import { contextMenu, openMenu, type MenuEntry } from './ContextMenu.tsx';
import { drag } from './dnd.tsx';
import { Icon } from './icons.tsx';

// ------------------------------------------------------------------ when the order may change

let pointerOnList = false;
let touchedAt = 0;
let listening = false;
const LISTS = '.rail, .sidebar .side-scroll';
/** Moving through a list by keyboard; a button merely left focused by a click does not count. */
const keyboardIn = () => {
  const el = document.activeElement;
  return !!el?.closest(LISTS) && el.matches(':focus-visible');
};
/** Starts measuring and sorting, and tells the sorter what counts as "in use". Idempotent. */
export function startOrganize() {
  if (typeof window === 'undefined') return;
  startArrange();
  if (listening) return;
  listening = true;
  document.addEventListener('pointerover', (e) => (pointerOnList = !!(e.target as Element)?.closest?.(LISTS)), { passive: true });
  // Out of the window altogether.
  document.addEventListener('pointerout', (e) => !e.relatedTarget && (pointerOnList = false), { passive: true });
  window.addEventListener('blur', () => (pointerOnList = false));
  document.addEventListener('touchstart', (e) => (e.target as Element)?.closest?.(LISTS) && (touchedAt = Date.now()), { passive: true, capture: true });
  setInteracting(() => !!drag.value || !!contextMenu.value || pointerOnList || Date.now() - touchedAt < 4000 || keyboardIn());
}

/** Moves animate: each row slides from where it was when the order last changed. */
export function useFlip(ref: { current: HTMLElement | null }, version: number) {
  const last = useRef(new Map<string, number>());
  const seen = useRef(version);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const origin = box.getBoundingClientRect().top - box.scrollTop;
    const rows = [...box.querySelectorAll<HTMLElement>('[data-dnd-key]')];
    const id = (x: HTMLElement) => `${x.dataset.dndKey}|${x.dataset.dndFolder ?? ''}`;
    const now = new Map(rows.map((x) => [id(x), x.getBoundingClientRect().top - origin]));
    if (seen.current !== version && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const x of rows) {
        const before = last.current.get(id(x));
        const after = now.get(id(x))!;
        if (before === undefined || Math.abs(before - after) < 1) continue;
        x.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' });
      }
    }
    seen.current = version;
    last.current = now;
  });
}

// ------------------------------------------------------------------ the sort menu

const MODES: Record<SortScope, SortMode[]> = { rail: ['manual', 'smart', 'recent', 'az'], people: ['recent', 'smart', 'az'], groups: ['recent', 'smart', 'az'] };
const HELP: Record<SortMode, string> = {
  manual: 'Your order',
  smart: 'Time you spend',
  recent: 'Latest message first',
  az: 'By name',
};

export function sortEntries(scope: SortScope): MenuEntry[] {
  const mode = sortOf(scope);
  return [
    { kind: 'label', label: scope === 'rail' ? 'Order servers by' : 'Order by' },
    ...MODES[scope].map((m): MenuEntry => ({ label: m === 'manual' || m === 'smart' ? `${SORT_LABELS[m]} (${HELP[m].toLowerCase()})` : SORT_LABELS[m], radio: true, checked: mode === m, run: () => setSort(scope, m) })),
    { kind: 'sep' },
    scope === 'rail' && { label: 'Freeze This Order', icon: 'lock', disabled: mode === 'manual', run: () => freezeOrder() },
    mode === 'smart' && { label: 'Sort Again Now', icon: 'refresh', run: () => resort('asked') },
    { label: 'Organize Servers…', icon: 'layers', run: () => (organizing.value = true) },
    {
      label: 'Reset Usage History…',
      icon: 'trash',
      danger: true,
      run: () => {
        if (!confirm('Forget how much you used each place, on every device? Smart order starts over from recent activity.')) return;
        resetUsage()
          .then(() => (resort('asked'), toast({ kind: 'info', title: 'Usage history cleared', body: 'Smart order starts over.' })))
          .catch((e) => toast({ kind: 'error', title: 'Could not reset', body: e.message }));
      },
    },
  ].filter(Boolean) as MenuEntry[];
}

export function SortIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h11M3 12h7M3 18h4" />
      <path d="M18 4v16M15 17l3 3 3-3" />
    </svg>
  );
}

/** A small button that opens the sort menu; it says which order is on. */
export function SortButton({ scope, class: cls }: { scope: SortScope; class?: string }) {
  const mode = sortOf(scope);
  const label = `Order: ${SORT_LABELS[mode]}. Click to change`;
  return (
    <button
      class={`icon-btn small sort-btn ${mode !== MODES[scope][0] ? 'on' : ''} ${cls ?? ''}`}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu({ x: r.left, y: r.bottom + 4 }, { items: sortEntries(scope), label: 'Order', head: <div class="cm-sheet-title">Order</div> });
      }}
    >
      <SortIcon size={15} />
    </button>
  );
}

// ------------------------------------------------------------------ bulk changes

type ItemKind = 'space' | 'conversation' | 'person';
const split = (key: string) => ({ kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1) });
const toKey = (it: { kind: string; id: string }) => `${it.kind}:${it.id}`;
const randomId = () => 'fld_' + Math.random().toString(36).slice(2, 12);
/** What a move takes: places as they are, and a folder's contents (folders do not nest, so they merge). */
const movable = (keys: string[]) => [
  ...new Set(keys.flatMap((k) => (k.startsWith('folder:') ? (db.folders.find((f) => f.id === split(k).id)?.items.map(toKey) ?? []) : [k]))),
];

/** Saves folders after a bulk move: a folder the move emptied goes; one that was already empty stays. */
function commit(folders: P.FolderView[]) {
  const had = new Set(db.folders.filter((f) => f.items.length).map((f) => f.id));
  saveFolders(folders.filter((f) => f.items.length || !had.has(f.id)));
  // In an automatic order, what changed takes its place now: you asked for it.
  if (sortOf('rail') !== 'manual') setTimeout(() => resort('asked'));
}

/** Moves places into a folder (or out of every folder, with null), keeping the folder's order. */
export function moveToFolder(keys: string[], folderId: string | null) {
  const ks = new Set(movable(keys));
  if (!ks.size) return;
  const folders = db.folders.map((f) => ({ ...f, items: f.items.filter((it) => !ks.has(toKey(it))) }));
  const target = folderId ? folders.find((f) => f.id === folderId) : null;
  if (target) target.items = [...target.items, ...[...ks].map((k) => split(k) as { kind: ItemKind; id: string })];
  commit(folders);
}

/** A new folder of these places, where the first of them was in the rail. */
export function newFolder(keys: string[], name: string, color: string | null = null): string | null {
  const ks = movable(keys);
  if (!ks.length) return null;
  const id = randomId();
  const set = new Set(ks);
  const order = railEntries().map((e) => e.key);
  const first = order.findIndex((k) => set.has(k) || keys.includes(k));
  const folders = db.folders.map((f) => ({ ...f, items: f.items.filter((it) => !set.has(toKey(it))) }));
  commit([...folders, { id, name, icon: null, color, items: ks.map((k) => split(k) as { kind: ItemKind; id: string }) }]);
  if (first >= 0) {
    const pos = placePref(split(order[first]).kind as P.PlaceKind, split(order[first]).id).position;
    patchPlaces([{ kind: 'folder', id, position: pos ?? first }]);
  }
  return id;
}

const prefable = (keys: string[]) => keys.map(split).filter((x) => x.kind !== 'person') as { kind: P.PlaceKind; id: string }[];
function togglePin(keys: string[]) {
  const xs = prefable(keys).filter((x) => topLevel().has(toKey(x)));
  if (!xs.length) return;
  const all = xs.every((x) => placePref(x.kind, x.id).pinned);
  patchPlaces(xs.map((x) => ({ ...x, pinned: !all })));
}
function toggleHidden(keys: string[]) {
  const xs = prefable(keys).filter((x) => x.kind !== 'folder');
  if (!xs.length) return;
  const all = xs.every((x) => placePref(x.kind, x.id).hidden);
  patchPlaces(xs.map((x) => ({ ...x, hidden: !all })));
}
const topLevel = () => new Set([...railEntries(), ...railEntries('hidden')].map((e) => e.key));

// ------------------------------------------------------------------ suggestions from categories

export interface Suggestion {
  category: P.CategoryView;
  keys: string[];
  /** A folder of that name already exists: add to it. */
  folder: P.FolderView | null;
}

/** For each category, the places in the rail (not already in a folder) that belong to it, unless dismissed. */
export function suggestions(): Suggestion[] {
  const loose = railEntries().filter((e) => e.kind !== 'folder' && !placePref(e.kind, split(e.key).id).pinned);
  const out: Suggestion[] = [];
  for (const c of db.categories) {
    const keys = loose.filter((e) => categoriesOf(e.kind as 'space' | 'conversation', split(e.key).id).some((x) => x.id === c.id)).map((e) => e.key);
    const folder = db.folders.find((f) => f.name.trim().toLowerCase() === c.name.trim().toLowerCase()) ?? null;
    if (keys.length < (folder ? 1 : 2)) continue;
    const dismissed = arrange.value.dismissed[c.id];
    if (dismissed && keys.every((k) => dismissed.includes(k))) continue;
    out.push({ category: c, keys, folder });
  }
  return out.sort((a, b) => b.keys.length - a.keys.length);
}

export function acceptSuggestion(s: Suggestion, keys = s.keys, name = s.category.name) {
  if (s.folder && name === s.category.name) moveToFolder(keys, s.folder.id);
  else newFolder(keys, name, s.category.color);
}

// ------------------------------------------------------------------ the view

interface Row {
  key: string;
  /** Inside this folder. */
  folder?: string;
  hidden?: boolean;
  name: string;
  sub: string;
  icon: any;
}

function placeRow(key: string, folder?: string, hidden?: boolean): Row | null {
  const { kind, id } = split(key);
  if (kind === 'folder') {
    const f = db.folders.find((x) => x.id === id);
    if (!f) return null;
    return {
      key,
      hidden,
      name: f.name,
      sub: `Folder · ${f.items.length} ${f.items.length === 1 ? 'place' : 'places'}`,
      icon: (
        <span class="folder-row-icon" style={{ '--folder': f.color ?? '#8b93a7' } as any}>
          {f.icon ?? <Icon name="folder" />}
        </span>
      ),
    };
  }
  if (kind === 'space') {
    const s = db.spaces.get(id);
    if (!s) return null;
    return { key, folder, hidden, name: s.name, sub: `${netName(s.network)} ${NETWORK_META[s.network].spaceNoun}`, icon: <Avatar id={s.id} name={s.name} url={s.icon} size={30} square network={s.network} /> };
  }
  if (kind === 'person') {
    const p = db.persons.get(id);
    return p ? { key, folder, hidden, name: p.name, sub: 'Person', icon: <Avatar id={p.id} name={p.name} url={p.avatar} size={30} /> } : null;
  }
  const c = db.conversations.get(id);
  return c ? { key, folder, hidden, name: convTitle(c), sub: kindLabel(c), icon: <Avatar id={c.id} name={convTitle(c)} url={c.avatar} size={30} square network={c.network} /> } : null;
}

function allRows(): Row[] {
  const out: Row[] = [];
  const push = (r: Row | null) => r && out.push(r);
  for (const e of arrangedRail()) {
    push(placeRow(e.key));
    if (e.kind === 'folder') for (const it of arrangedFolderItems(e.folder)) push(placeRow(toKey(it), e.folder.id));
  }
  for (const e of railEntries('hidden') as RailEntry[]) push(placeRow(e.key, undefined, true));
  return out;
}

function usageLine(key: string): string {
  const { kind, id } = split(key);
  if (kind === 'folder') return '';
  const u = usageSummary(kind as ItemKind, id);
  const m = Math.round(u.minutes);
  const time = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min` : '';
  return [time && `${time} lately`, u.lastVisit && `opened ${ago(u.lastVisit)}`].filter(Boolean).join(' · ');
}

const rowId = (r: Row) => `${r.key}|${r.folder ?? ''}`;

export function OrganizeView() {
  rev.value;
  snapshot.value;
  arrange.value;
  if (!organizing.value) return null;
  return <Organize onClose={() => (organizing.value = false)} />;
}

function Organize({ onClose }: { onClose: () => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<{ name: string; suggestion?: Suggestion } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLInputElement>(null);

  const needle = q.trim().toLowerCase();
  const every = allRows();
  const rows = every.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.sub.toLowerCase().includes(needle));
  const sugg = useMemo(suggestions, [rev.value, arrange.value]);
  // Only what is still there counts: a place that moved into a folder is a different row now.
  const selRows = every.filter((r) => sel.has(rowId(r)));
  const keys = [...new Set(selRows.map((r) => r.key))];
  const anyFolderMember = selRows.some((r) => r.folder);
  const allPinned = selRows.length > 0 && selRows.every((r) => !r.folder && placePref(split(r.key).kind as P.PlaceKind, split(r.key).id).pinned);
  const allHidden = selRows.length > 0 && selRows.every((r) => r.hidden);
  const mode = sortOf('rail');

  const toggle = (i: number, range = false, from = focus) => {
    const next = new Set(sel);
    const start = anchor ?? from;
    if (range) {
      if (anchor === null) setAnchor(start);
      const [a, b] = [Math.min(start, i), Math.max(start, i)];
      for (let j = a; j <= b; j++) next.add(rowId(rows[j]));
    } else {
      const id = rowId(rows[i]);
      next.has(id) ? next.delete(id) : next.add(id);
      setAnchor(i);
    }
    setSel(next);
  };
  const clear = () => (setSel(new Set()), setDraft(null));
  const focusRow = (i: number) => {
    const j = Math.max(0, Math.min(rows.length - 1, i));
    setFocus(j);
    list.current?.querySelectorAll<HTMLElement>('.org-row')[j]?.focus();
  };

  const moveMenu = (at: { x: number; y: number }) =>
    openMenu(at, {
      label: 'Move to folder',
      head: <div class="cm-sheet-title">Move {keys.length} to…</div>,
      items: [
        ...db.folders.map((f): MenuEntry => ({ label: f.name, icon: 'folder', run: () => (moveToFolder(keys, f.id), clear()) })),
        ...(db.folders.length ? [{ kind: 'sep' } as MenuEntry] : []),
        { label: 'New Folder…', icon: 'plus', hint: 'N', run: () => startDraft() },
        anyFolderMember && { label: 'Out of Its Folder', icon: 'unlink', hint: 'U', run: () => (moveToFolder(keys, null), clear()) },
      ].filter(Boolean) as MenuEntry[],
    });
  const startDraft = (name = 'New folder', suggestion?: Suggestion) => {
    setDraft({ name, suggestion });
    setTimeout(() => draftInput.current?.select(), 0);
  };
  const createDraft = () => {
    if (!draft || !keys.length) return;
    const name = draft.name.trim() || 'New folder';
    const n = movable(keys).length;
    if (draft.suggestion) acceptSuggestion(draft.suggestion, keys, name);
    else newFolder(keys, name);
    toast({ kind: 'info', title: `Folder “${name}”`, body: `${n} places moved in.` });
    clear();
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'ArrowDown' || k === 'j') {
      e.preventDefault();
      focusRow(focus + 1);
      if (e.shiftKey) toggle(Math.min(rows.length - 1, focus + 1), true);
    } else if (k === 'ArrowUp' || k === 'k') {
      e.preventDefault();
      focusRow(focus - 1);
      if (e.shiftKey) toggle(Math.max(0, focus - 1), true);
    } else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      focusRow(k === 'Home' ? 0 : rows.length - 1);
    } else if (k === ' ' || k === 'x' || k === 'Enter') {
      e.preventDefault();
      if (rows[focus]) toggle(focus, e.shiftKey);
    } else if (mod && k === 'a') {
      e.preventDefault();
      setSel(new Set(rows.map(rowId)));
    } else if (k === '/') {
      e.preventDefault();
      filter.current?.focus();
    } else if (mod || !keys.length) return;
    else if (k === 'm') {
      e.preventDefault();
      const r = list.current?.querySelectorAll<HTMLElement>('.org-row')[focus]?.getBoundingClientRect();
      moveMenu({ x: (r?.left ?? 100) + 40, y: (r?.bottom ?? 100) + 2 });
    } else if (k === 'n') {
      e.preventDefault();
      startDraft();
    } else if (k === 'p') togglePin(keys);
    else if (k === 'h') toggleHidden(keys);
    else if (k === 'u') moveToFolder(keys, null);
  };

  return (
    <Modal title="Organize servers" onClose={onClose} wide>
      <div class="org" onKeyDown={onKey as any}>
        <div class="org-top">
          <div class="search org-search">
            <Icon name="search" size={15} />
            <input ref={filter} placeholder="Filter (press /)" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), focusRow(0))} />
          </div>
          <div class="level-picker" role="radiogroup" aria-label="Rail order">
            {MODES.rail.map((m) => (
              <button role="radio" aria-checked={mode === m} class={`chip-btn ${mode === m ? 'on' : ''}`} title={HELP[m]} onClick={() => setSort('rail', m)}>
                {SORT_LABELS[m]}
              </button>
            ))}
            {mode !== 'manual' && (
              <button class="chip-btn" title="Make this order your manual order" onClick={() => freezeOrder()}>
                <Icon name="lock" size={12} /> Freeze
              </button>
            )}
          </div>
        </div>

        {sugg.length > 0 && (
          <section class="org-suggest" aria-label="Suggested folders">
            <h3>Suggested folders</h3>
            <div class="org-suggest-list">
              {sugg.map((s) => (
                <article class="org-sugg" style={{ '--cat': s.category.color ?? '#8b93a7' } as any}>
                  <div class="org-sugg-text">
                    <b>
                      <Icon name="folder" size={13} /> {s.folder ? `Add to “${s.folder.name}”` : s.category.name}
                    </b>
                    <span>{s.keys.map((k) => placeRow(k)?.name).filter(Boolean).join(', ')}</span>
                  </div>
                  <div class="org-sugg-actions">
                    <button
                      class="btn primary small"
                      onClick={() => {
                        acceptSuggestion(s);
                        clear();
                        toast({ kind: 'info', title: s.folder ? `Added to “${s.folder.name}”` : `Folder “${s.category.name}”`, body: `${s.keys.length} places moved in.` });
                      }}
                    >
                      {s.folder ? 'Add' : 'Create'}
                    </button>
                    <button
                      class="btn ghost small"
                      title="Pick which places go in, and the name"
                      onClick={() => {
                        setSel(new Set(s.keys.map((k) => `${k}|`)));
                        startDraft(s.folder?.name ?? s.category.name, s);
                      }}
                    >
                      Edit
                    </button>
                    <button class="icon-btn small" title="Dismiss this suggestion" aria-label={`Dismiss ${s.category.name}`} onClick={() => patchDismissed({ [s.category.id]: s.keys })}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <div class={`org-bar ${keys.length ? 'active' : ''}`} role="toolbar" aria-label="Selected places">
          {draft ? (
            <form
              class="org-draft"
              onSubmit={(e) => {
                e.preventDefault();
                createDraft();
              }}
            >
              <Icon name="folder" size={14} />
              <input ref={draftInput} class="input" aria-label="Folder name" value={draft.name} onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setDraft(null))} />
              <span class="org-count">{movable(keys).length} {movable(keys).length === 1 ? 'place' : 'places'}</span>
              <button class="btn primary small" type="submit" disabled={!movable(keys).length}>
                Create folder
              </button>
              <button class="btn ghost small" type="button" onClick={() => (draft.suggestion ? clear() : setDraft(null))}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <span class="org-count">{keys.length ? `${keys.length} selected` : 'Select places: click, Space, Shift for a range'}</span>
              <button class="btn ghost small" disabled={!movable(keys).length} onClick={(e) => moveMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY })}>
                <Icon name="folder" size={13} /> Move to… <kbd>M</kbd>
              </button>
              <button class="btn ghost small" disabled={!movable(keys).length} onClick={() => startDraft()}>
                <Icon name="plus" size={13} /> New folder <kbd>N</kbd>
              </button>
              <button class="btn ghost small" disabled={!keys.length} onClick={() => togglePin(keys)}>
                <Icon name="star" size={13} /> {allPinned ? 'Unpin' : 'Pin'} <kbd>P</kbd>
              </button>
              <button class="btn ghost small" disabled={!keys.length} onClick={() => toggleHidden(keys)}>
                <Icon name="eye" size={13} /> {allHidden ? 'Show' : 'Hide'} <kbd>H</kbd>
              </button>
              {anyFolderMember && (
                <button class="btn ghost small" onClick={() => moveToFolder(keys, null)}>
                  <Icon name="unlink" size={13} /> Out of folder <kbd>U</kbd>
                </button>
              )}
              {keys.length > 0 && (
                <button class="btn ghost small" onClick={clear}>
                  Clear
                </button>
              )}
            </>
          )}
        </div>

        <div class="org-list" ref={list} role="listbox" aria-multiselectable="true" aria-label="Your servers and folders">
          {rows.map((r, i) => {
            const pref = r.folder || split(r.key).kind === 'person' ? null : placePref(split(r.key).kind as P.PlaceKind, split(r.key).id);
            const on = sel.has(rowId(r));
            const cats = r.key.startsWith('space:') || r.key.startsWith('conversation:') ? categoriesOf(split(r.key).kind as 'space' | 'conversation', split(r.key).id) : [];
            const firstHidden = r.hidden && !rows[i - 1]?.hidden;
            return (
              <>
                {firstHidden && <div class="org-section">Hidden</div>}
                <div
                  class={`org-row ${on ? 'on' : ''} ${r.folder ? 'in-folder' : ''} ${r.key.startsWith('folder:') ? 'is-folder' : ''} ${r.hidden ? 'is-hidden' : ''}`}
                  role="option"
                  aria-selected={on}
                  tabIndex={i === focus ? 0 : -1}
                  onFocus={() => setFocus(i)}
                  onClick={(e) => {
                    setFocus(i);
                    toggle(i, (e as MouseEvent).shiftKey);
                  }}
                >
                  <span class={`org-check ${on ? 'on' : ''}`} aria-hidden="true">
                    {on && <Icon name="check" size={12} />}
                  </span>
                  <span class="org-icon">{r.icon}</span>
                  <span class="org-text">
                    <span class="org-name">
                      {r.name}
                      {pref?.pinned && <Icon name="star" size={11} class="row-star" />}
                    </span>
                    <span class="org-sub">
                      {r.sub}
                      {r.folder && ` · in ${db.folders.find((f) => f.id === r.folder)?.name ?? 'a folder'}`}
                    </span>
                  </span>
                  <span class="org-cats">
                    {cats.slice(0, 2).map((c) => (
                      <span class="cat-chip" style={{ '--cat': c.color ?? '#8b93a7' } as any}>
                        {c.name}
                      </span>
                    ))}
                  </span>
                  <span class="org-usage">{usageLine(r.key)}</span>
                </div>
              </>
            );
          })}
          {!rows.length && <p class="set-help">Nothing matches.</p>}
        </div>
        <p class="org-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Space</kbd> select · <kbd>Shift</kbd> range · <kbd>Ctrl</kbd>+<kbd>A</kbd> all · <kbd>M</kbd> move to folder · <kbd>N</kbd> new folder · <kbd>P</kbd> pin · <kbd>H</kbd> hide · <kbd>/</kbd> filter
        </p>
      </div>
    </Modal>
  );
}
