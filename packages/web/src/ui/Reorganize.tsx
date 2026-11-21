/**
 * Sort modes and the Organize view (docs/organize.md): pick how the rail and the lists sort, freeze an
 * automatic order into your own, and rearrange many servers at once.
 */
import type * as P from '@dither-chat/protocol';
import { categoryThreshold, NETWORK_META, type SortMode, type SortScope } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { arrange, arrangedFolderItems, arrangedRail, freezeOrder, organizing, resort, setInteracting, setQuietShelf, setSort, snapshot, SORT_LABELS, sortOf, startArrange } from '../arrange.ts';
import { quietShelfOn } from '../quiet.ts';
import { ago } from '../format.ts';
import { convTitle, folderLeaves, kindLabel, netName, parentFolder, placePref, railEntries, type RailEntry } from '../model.ts';
import { mayHold } from '../layout.ts';
import { api, db, patchPlaces, rev, saveFolders, toast } from '../state.ts';
import { resetUsage, usageSummary } from '../usage.ts';
import { Avatar, Modal } from './bits.tsx';
import { contextMenu, openMenu, type MenuEntry } from './ContextMenu.tsx';
import { drag } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { pct, Sensitivity } from './Sensitivity.tsx';
import { SuggestedLayout } from './SuggestedLayout.tsx';
import { currentPlan, loadPlanner, planner } from '../folderplan.ts';

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

/** Where each row is, from the top of the list's content. */
function rowTops(box: HTMLElement, sel: string) {
  const origin = box.getBoundingClientRect().top - box.scrollTop;
  const id = (x: HTMLElement) => `${x.dataset.dndKey ?? x.dataset.row ?? x.dataset.rowKey}|${x.dataset.dndFolder ?? ''}`;
  return new Map([...box.querySelectorAll<HTMLElement>(sel)].map((x) => [id(x), { el: x, top: x.getBoundingClientRect().top - origin }]));
}

/**
 * Moves animate: each row slides from where it was when the order changed. Rows are `sel`, keyed by their data.
 * Rows are measured only when `version` (the order) changes: before the new order is drawn, from the DOM as it still
 * is, and after. Measuring after every render forced a layout of the whole list each time.
 */
export function useFlip(ref: { current: HTMLElement | null }, version: number, sel = '[data-dnd-key]') {
  const seen = useRef(version);
  const before = useRef<ReturnType<typeof rowTops> | null>(null);
  if (seen.current !== version && !before.current && ref.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) before.current = rowTops(ref.current, sel);
  useLayoutEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    const was = before.current;
    before.current = null;
    const box = ref.current;
    if (!box || !was) return;
    for (const [key, { el, top }] of rowTops(box, sel)) {
      const from = was.get(key)?.top;
      if (from === undefined || Math.abs(from - top) < 1) continue;
      el.animate([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  });
}

// ------------------------------------------------------------------ the sort menu

const MODES: Record<SortScope, SortMode[]> = { rail: ['manual', 'smart', 'recent', 'az'], people: ['recent', 'smart', 'az'] };
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
    scope === 'rail' && { label: 'Quiet Servers on a Shelf', checked: quietShelfOn(), run: () => setQuietShelf(!quietShelfOn()) },
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
        openMenu({ x: r.left, y: r.bottom + 4 }, { items: sortEntries(scope), label: 'Order', head: <div class="cm-sheet-title">Order</div> }, e.currentTarget);
      }}
    >
      <SortIcon size={15} />
    </button>
  );
}

// ------------------------------------------------------------------ bulk changes

type ItemKind = P.FolderItemKind;
const split = (key: string) => ({ kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1) });
const toKey = (it: { kind: string; id: string }) => `${it.kind}:${it.id}`;
const randomId = () => 'fld_' + Math.random().toString(36).slice(2, 12);
const asLayout = (fs: P.FolderView[]) => fs.map((f) => ({ id: f.id, items: f.items.map(toKey) }));
/**
 * What a move into `target` takes: places as they are; a folder itself where it may sit inside the target (one level),
 * else its contents, which merge. Out of every folder (`target` null), a folder goes as it is.
 */
const movable = (keys: string[], target: string | null = null) => [
  ...new Set(
    keys.flatMap((k) => {
      if (!k.startsWith('folder:')) return [k];
      if (target === null || mayHold(asLayout(db.folders), target, k)) return [k];
      return db.folders.find((f) => f.id === split(k).id)?.items.map(toKey).filter((x) => !x.startsWith('folder:') || mayHold(asLayout(db.folders), target, x)) ?? [];
    }),
  ),
];

/** Saves folders after a bulk move: a folder the move emptied goes; one that was already empty stays. */
function commit(folders: P.FolderView[]) {
  const had = new Set(db.folders.filter((f) => f.items.length).map((f) => f.id));
  saveFolders(folders.filter((f) => f.items.length || !had.has(f.id)));
  // In an automatic order, what changed takes its place now: you asked for it.
  if (sortOf('rail') !== 'manual') setTimeout(() => resort('asked'));
}

/** Moves places into a folder (or out of every folder, with null), keeping the folder's order. */
function moveToFolder(keys: string[], folderId: string | null) {
  const ks = new Set(movable(keys, folderId));
  if (!ks.size) return;
  const folders = db.folders.map((f) => ({ ...f, items: f.items.filter((it) => !ks.has(toKey(it))) }));
  const target = folderId ? folders.find((f) => f.id === folderId) : null;
  if (target) target.items = [...target.items, ...[...ks].filter((k) => k !== `folder:${folderId}`).map((k) => split(k) as { kind: ItemKind; id: string })];
  commit(folders);
}

/** A new folder of these places, where the first of them was in the rail. */
function newFolder(keys: string[], name: string): string | null {
  // Into a new folder, a folder goes whole unless it holds folders itself.
  const ks = [...new Set(keys.flatMap((k) => (k.startsWith('folder:') && db.folders.find((f) => f.id === split(k).id)?.items.some((i) => i.kind === 'folder') ? (db.folders.find((f) => f.id === split(k).id)?.items.map(toKey) ?? []) : [k])))];
  if (!ks.length) return null;
  const id = randomId();
  const set = new Set(ks);
  const order = railEntries().map((e) => e.key);
  const first = order.findIndex((k) => set.has(k) || keys.includes(k));
  const folders = db.folders.map((f) => ({ ...f, items: f.items.filter((it) => !set.has(toKey(it))) }));
  commit([...folders, { id, name, icon: null, color: null, items: ks.map((k) => split(k) as { kind: ItemKind; id: string }) }]);
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
    const n = folderLeaves(f).length;
    const inner = f.items.filter((i) => i.kind === 'folder').length;
    return {
      key,
      folder,
      hidden,
      name: f.name,
      sub: `Folder · ${inner ? `${inner} ${inner === 1 ? 'folder' : 'folders'}, ` : ''}${n} ${n === 1 ? 'place' : 'places'}`,
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
  const folder = (f: P.FolderView) => {
    for (const it of arrangedFolderItems(f)) {
      push(placeRow(toKey(it), f.id));
      const inner = it.kind === 'folder' ? db.folders.find((x) => x.id === it.id) : undefined;
      if (inner) folder(inner);
    }
  };
  for (const e of arrangedRail()) {
    push(placeRow(e.key));
    if (e.kind === 'folder') folder(e.folder);
  }
  for (const e of railEntries('hidden') as RailEntry[]) push(placeRow(e.key, undefined, true));
  return out;
}

function usageLine(key: string): string {
  const { kind, id } = split(key);
  if (kind === 'folder') return '';
  const u = usageSummary(kind as P.UsageKind, id);
  const m = Math.round(u.minutes);
  const time = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min` : '';
  return [time && `${time} lately`, u.lastVisit && `opened ${ago(u.lastVisit)}`].filter(Boolean).join(' · ');
}

const rowId = (r: Row) => `${r.key}|${r.folder ?? ''}`;

/** Folders shown on a loose place's line, at most this many before "Other…" (a phone shows two). */
const TARGETS = 3;
type Near = { folder: string; name: string }[];
/**
 * Where a loose place could go, its own list: the folder it fits best first (marked), then the planner's ranking of
 * the rest for this place, then any other folder by size. Inside an account's folder, only that account's folders.
 */
function moveTargets(key: string, inFolder: string | undefined, suggest: Near, near: Near): { folder: string; name: string; best: boolean }[] {
  const holds = (f: P.FolderView) => !f.items.some((i) => i.kind === 'folder');
  const scope = inFolder ? (db.folders.find((f) => f.id === inFolder)?.items.filter((i) => i.kind === 'folder').map((i) => db.folders.find((f) => f.id === i.id)).filter((f): f is P.FolderView => !!f) ?? []) : db.folders.filter(holds);
  const inScope = new Set(scope.map((f) => f.id));
  const ok = (id: string) => inScope.has(id) && db.folders.some((f) => f.id === id && holds(f)) && mayHold(asLayout(db.folders), id, key);
  const bySize = [...scope].sort((a, b) => b.items.length - a.items.length).map((f) => ({ folder: f.id, name: f.name }));
  const out: { folder: string; name: string; best: boolean }[] = [];
  for (const x of [...suggest, ...near, ...bySize]) {
    if (out.length >= TARGETS) break;
    if (!ok(x.folder) || out.some((o) => o.folder === x.folder)) continue;
    out.push({ folder: x.folder, name: db.folders.find((f) => f.id === x.folder)?.name ?? x.name, best: !out.length && suggest.some((y) => y.folder === x.folder) });
  }
  return out;
}

/** What the filter asks the model when matching by meaning: a question as typed, else "about …". */
const probeQuestion = (text: string) => (/\?\s*$/.test(text) ? text.trim() : `Is this community about ${text.trim()}?`);

/** A category's threshold now: what its slider says, else what the hub has. */
export const thresholdOf = (c: P.CategoryView, at: Record<string, number> = {}) => at[c.id] ?? categoryThreshold(c, db.categoryProvider);

export function saveThreshold(c: P.CategoryView, threshold: number | null) {
  return api(`/api/categories/${c.id}`, { method: 'PATCH', body: { threshold } }).catch((e) => toast({ kind: 'error', title: 'Could not save', body: e.message }));
}

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
  const [draft, setDraft] = useState<{ name: string } | null>(null);
  /** Matching by meaning: the reranker's answer to the filter as a question, and how sure it must be. */
  const [meaning, setMeaning] = useState(false);
  const [probe, setProbe] = useState<{ question: string; p: Map<string, number>; provider: string } | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [cut, setCut] = useState(0.12);
  const list = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLInputElement>(null);

  const needle = q.trim().toLowerCase();
  const every = allRows();
  const asked = meaning && probe && probe.question === probeQuestion(q) && !!needle;
  const scoreOf = (r: Row) => (asked ? probe!.p.get(r.key) : undefined);
  const scored = asked ? every.filter((r) => scoreOf(r) !== undefined) : [];
  const rows = asked
    ? scored.filter((r) => scoreOf(r)! >= cut).sort((a, b) => scoreOf(b)! - scoreOf(a)!)
    : meaning && needle
      ? []
      : every.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.sub.toLowerCase().includes(needle));
  // The suggested layout, and each loose server's nearest folders (docs/organize.md).
  useEffect(() => void loadPlanner(), []);
  const plan = useMemo(() => currentPlan(), [rev.value, planner.value]);

  const ask = async (text = q) => {
    if (!text.trim()) return;
    const question = probeQuestion(text);
    setProbing(question);
    try {
      const res = await api<P.CategoryProbe>('/api/categories/probe', { body: { question } });
      setProbe({ question, provider: res.provider, p: new Map(res.scores.map((x) => [`${x.kind}:${x.id}`, x.p])) });
      setCut(categoryThreshold(undefined, res.provider));
    } catch (e) {
      toast({ kind: 'error', title: 'Could not ask the model', body: (e as Error).message });
    } finally {
      setProbing((cur) => (cur === question ? null : cur));
    }
  };
  // Typing pauses ask by themselves; Enter asks at once.
  useEffect(() => {
    if (!meaning || !q.trim() || probe?.question === probeQuestion(q)) return;
    const t = setTimeout(() => void ask(), 900);
    return () => clearTimeout(t);
  }, [meaning, q]);
  const saveAsCategory = async () => {
    const name = q.trim().replace(/\?$/, '');
    await api('/api/categories', { body: { name: name.charAt(0).toUpperCase() + name.slice(1), question: probeQuestion(q), threshold: cut } });
    toast({ kind: 'info', title: `Category “${name}”`, body: 'Every place is being scored for it; its folder will be suggested here.' });
  };
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
        ...db.folders.map((f): MenuEntry => ({ label: parentFolder(f.id) ? `${parentFolder(f.id)!.name} › ${f.name}` : f.name, icon: 'folder', run: () => (moveToFolder(keys, f.id), clear()) })),
        ...(db.folders.length ? [{ kind: 'sep' } as MenuEntry] : []),
        { label: 'New Folder…', icon: 'plus', hint: 'N', run: () => startDraft() },
        anyFolderMember && { label: 'Out of Its Folder', icon: 'unlink', hint: 'U', run: () => (moveToFolder(keys, null), clear()) },
      ].filter(Boolean) as MenuEntry[],
    });
  const startDraft = (name = 'New folder') => {
    setDraft({ name });
    setTimeout(() => draftInput.current?.select(), 0);
  };
  const createDraft = () => {
    if (!draft || !keys.length) return;
    const name = draft.name.trim() || 'New folder';
    const n = movable(keys).length;
    newFolder(keys, name);
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
            <input
              ref={filter}
              placeholder={meaning ? 'Describe them: “rust and systems programming”' : 'Filter (press /)'}
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') (e.preventDefault(), focusRow(0));
                if (e.key === 'Enter' && meaning) (e.preventDefault(), void ask());
              }}
            />
            {probing && <span class="org-asking" aria-live="polite">Asking…</span>}
            <button
              class={`chip-btn org-meaning ${meaning ? 'on' : ''}`}
              type="button"
              aria-pressed={meaning}
              title="Match by meaning: the local model judges every server against what you type"
              onClick={() => {
                setMeaning(!meaning);
                filter.current?.focus();
              }}
            >
              <Icon name="sparkles" size={13} /> By meaning
            </button>
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

        {meaning && needle && (
          <div class="org-probe" aria-label="Match by meaning">
            {asked ? (
              <>
                <Sensitivity threshold={cut} onInput={setCut} count={`${rows.length} of ${scored.length} match`} />
                <button class="btn ghost small" disabled={!rows.length} onClick={() => setSel(new Set(rows.map(rowId)))}>
                  Select all {rows.length}
                </button>
                <button class="btn ghost small" title="Keep this question as a category: new servers are scored for it too, and its scores help pick the folders offered on each server's line" onClick={() => void saveAsCategory()}>
                  <Icon name="layers" size={13} /> Save as category
                </button>
                {probe!.provider === 'keyword' && <span class="set-help">The model is not running: matching words only.</span>}
              </>
            ) : (
              <span class="set-help">{probing ? `Asking the model about every server: “${probing}”` : 'Press Enter to ask the model.'}</span>
            )}
          </div>
        )}

        {!needle && plan && <SuggestedLayout plan={plan} />}

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
              <input ref={draftInput} class="input" aria-label="Folder name" value={draft.name} onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), setDraft(null))} />
              <span class="org-count">{movable(keys).length} {movable(keys).length === 1 ? 'place' : 'places'}</span>
              <button class="btn primary small" type="submit" disabled={!movable(keys).length}>
                Create folder
              </button>
              <button class="btn ghost small" type="button" onClick={() => setDraft(null)}>
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
            const firstHidden = r.hidden && !rows[i - 1]?.hidden;
            // A place not in a folder (or loose inside an account's folder): where it could go, on its own line.
            const level = !r.folder || db.folders.find((f) => f.id === r.folder)?.items.some((i) => i.kind === 'folder');
            const movable = level && !r.hidden && (r.key.startsWith('space:') || r.key.startsWith('conversation:'));
            const near = movable ? moveTargets(r.key, r.folder, plan?.suggest[split(r.key).id] ?? [], plan?.near[split(r.key).id] ?? []) : [];
            return (
              <>
                {firstHidden && <div class="org-section">Hidden</div>}
                <div
                  class={`org-row ${on ? 'on' : ''} ${r.folder ? 'in-folder' : ''} ${r.folder && parentFolder(r.folder) ? 'deep' : ''} ${r.key.startsWith('folder:') ? 'is-folder' : ''} ${r.hidden ? 'is-hidden' : ''}`}
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
                      {r.folder && ` · in ${[parentFolder(r.folder)?.name, db.folders.find((f) => f.id === r.folder)?.name ?? 'a folder'].filter(Boolean).join(' › ')}`}
                    </span>
                  </span>
                  <span class="org-moves" aria-label={movable ? `Move ${r.name} to` : undefined}>
                    {movable && (
                      <>
                        {near.map((x) => {
                          const f = db.folders.find((y) => y.id === x.folder);
                          const outer = parentFolder(x.folder);
                          return (
                            <button
                              class={`move-chip ${x.best ? 'best' : ''}`}
                              style={{ '--folder': f?.color ?? 'var(--accent)' } as any}
                              title={x.best ? `Move to ${x.name}: it fits best` : `Move to ${x.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveToFolder([r.key], x.folder);
                                toast({ kind: 'info', title: `Moved to “${x.name}”`, body: r.name });
                              }}
                            >
                              <Icon name={x.best ? 'sparkles' : 'folder'} size={12} />
                              {/* The account's folder it sits in already goes without saying. */}
                              {outer && outer.id !== r.folder ? <span class="move-chip-in">{outer.name} ›</span> : null}
                              <span class="move-chip-name">{x.name}</span>
                            </button>
                          );
                        })}
                        <button
                          class="move-chip other"
                          title="Pick a folder"
                          aria-label={near.length ? "Other folders" : "Move to a folder"}
                          onClick={(e) => {
                            e.stopPropagation();
                            const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            openMenu({ x: b.left, y: b.bottom + 4 }, {
                              label: 'Move to folder',
                              head: <div class="cm-sheet-title">Move {r.name} to…</div>,
                              items: [
                                ...db.folders.filter((f) => mayHold(asLayout(db.folders), f.id, r.key) && !near.some((x) => x.folder === f.id)).map((f): MenuEntry => ({ label: parentFolder(f.id) ? `${parentFolder(f.id)!.name} › ${f.name}` : f.name, icon: 'folder', run: () => moveToFolder([r.key], f.id) })),
                                { kind: 'sep' } as MenuEntry,
                                { label: 'New Folder…', icon: 'plus', run: () => (setSel(new Set([rowId(r)])), startDraft()) },
                              ],
                            }, e.currentTarget as HTMLElement);
                          }}
                        >
                          <Icon name="more" size={14} />
                          <span class="move-chip-name">{near.length ? 'Other…' : 'Move to…'}</span>
                        </button>
                      </>
                    )}
                  </span>
                  <span class="org-usage">{asked ? <span class="org-score">{pct(scoreOf(r)!)}</span> : usageLine(r.key)}</span>
                </div>
              </>
            );
          })}
          {!rows.length && <p class="set-help">{meaning && needle && !asked ? '' : asked ? 'Nothing at this sensitivity: slide toward More.' : 'Nothing matches.'}</p>}
        </div>
        <p class="org-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Space</kbd> select · <kbd>Shift</kbd> range · <kbd>Ctrl</kbd>+<kbd>A</kbd> all · <kbd>M</kbd> move to folder · <kbd>N</kbd> new folder · <kbd>P</kbd> pin · <kbd>H</kbd> hide · <kbd>/</kbd> filter
        </p>
      </div>
    </Modal>
  );
}
