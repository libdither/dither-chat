/** Arranging the sidebar: what a drop saves, and the menu for everything that is not a drag. */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { applyDrop, moveStep, type DropTarget, type Layout } from '../layout.ts';
import { convTitle, placePref, railEntries } from '../model.ts';
import { db, go, patchPlaces, route, saveFolders } from '../state.ts';
import { Icon } from './icons.tsx';

const randomId = () => 'fld_' + Math.random().toString(36).slice(2, 12);
const splitKey = (key: string) => {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
};
const toKey = (it: P.FolderView['items'][number]) => `${it.kind}:${it.id}`;

export function currentLayout(): Layout {
  return { order: railEntries().map((e) => e.key), folders: db.folders.map((f) => ({ id: f.id, items: f.items.map(toKey) })) };
}

function save(next: Layout, pinned?: { key: string; pinned: boolean }) {
  const had = new Map(db.folders.map((f) => [f.id, f]));
  const changed = next.folders.length !== db.folders.length || next.folders.some((f) => had.get(f.id)?.items.map(toKey).join() !== f.items.join());
  if (changed) {
    saveFolders(
      next.folders.map((f) => ({
        id: f.id,
        name: had.get(f.id)?.name ?? 'New folder',
        icon: had.get(f.id)?.icon ?? null,
        color: had.get(f.id)?.color ?? null,
        items: f.items.map((k) => {
          const { kind, id } = splitKey(k);
          return { kind: kind as 'space' | 'conversation' | 'person', id };
        }),
      })),
    );
  }
  const items: P.PlacePrefPatch[] = next.order.map((k, i) => {
    const { kind, id } = splitKey(k);
    return { kind: kind as P.PlaceKind, id, position: i, ...(k === pinned?.key ? { pinned: pinned.pinned } : {}) };
  });
  return patchPlaces(items);
}

/** Drops anywhere in the sidebar end here. Dropped next to a pinned entry, it becomes pinned too. */
export function dropPlace(key: string, target: DropTarget) {
  const next = applyDrop(currentLayout(), key, target, randomId);
  const anchor = target.folder ? null : splitKey(target.key);
  const pinned = anchor && target.where !== 'into' ? { key, pinned: placePref(anchor.kind as P.PlaceKind, anchor.id).pinned } : undefined;
  save(next, pinned);
}

export const placeMenu = signal<{ key: string; label: string; folder?: string; x: number; y: number } | null>(null);
export const openPlaceMenu = (key: string, label: string, x: number, y: number, folder?: string) => (placeMenu.value = { key, label, folder, x, y });

function moveToFolder(key: string, folderId: string | null) {
  const l = currentLayout();
  const folders = l.folders.map((f) => ({ ...f, items: f.items.filter((k) => k !== key) }));
  if (folderId) folders.find((f) => f.id === folderId)?.items.push(key);
  save({ order: l.order.filter((k) => !folderId || k !== key), folders });
}

export function PlaceMenu() {
  const m = placeMenu.value;
  if (!m) return null;
  const { kind, id } = splitKey(m.key);
  const close = () => (placeMenu.value = null);
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  const placeKind = kind as P.PlaceKind;
  const pref = kind === 'person' ? null : placePref(placeKind, id);
  const inFolder = db.folders.find((f) => f.items.some((i) => toKey(i) === m.key));
  const folder = kind === 'folder' ? db.folders.find((f) => f.id === id) : null;
  const order = currentLayout().order;
  const pos = order.indexOf(m.key);
  const step = (d: -1 | 1) => save({ ...currentLayout(), order: moveStep(order, m.key, d) });
  const item = (icon: string, label: string, fn: () => void, disabled = false) => (
    <button class="menu-item" disabled={disabled} onClick={act(fn)}>
      <Icon name={icon} size={14} /> {label}
    </button>
  );
  const x = Math.min(m.x, window.innerWidth - 240);
  const y = Math.min(m.y, window.innerHeight - 380);
  return (
    <div class="place-menu-back" onClick={close} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div class="menu place-menu" style={{ left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` }} role="menu" onClick={(e) => e.stopPropagation()}>
        <div class="menu-label">{m.label}</div>
        {folder && item('folder', pref?.open ? 'Close in sidebar' : 'Open in sidebar', () => patchPlaces([{ kind: 'folder', id, open: !pref?.open }]))}
        {folder && item('at', 'Rename folder', () => {
          const name = prompt('Folder name', folder.name)?.trim();
          if (name) saveFolders(db.folders.map((f) => (f.id === id ? { ...f, name } : f)));
        })}
        {folder && item('groups', 'Open as list', () => go({ view: 'folder', folder: id }))}
        {pref && pos >= 0 && item('star', pref.pinned ? 'Unpin' : 'Pin to top', () => patchPlaces([{ kind: placeKind, id, pinned: !pref.pinned }]))}
        {kind === 'conversation' && !inFolder && item('plus', pref?.railed ? 'Remove from sidebar' : 'Add to sidebar', () => patchPlaces([{ kind: 'conversation', id, railed: !pref?.railed }]))}
        {pos >= 0 && item('chevronUp', 'Move up', () => step(-1), pos === 0)}
        {pos >= 0 && item('chevronDown', 'Move down', () => step(1), pos === order.length - 1)}
        {kind !== 'folder' && db.folders.filter((f) => f.id !== inFolder?.id).map((f) => item('folder', `Move to ${f.name}`, () => moveToFolder(m.key, f.id)))}
        {kind !== 'folder' && !inFolder && item('plus', 'New folder with this', () => {
          const name = prompt('Folder name', 'New folder')?.trim();
          if (!name) return;
          const fid = randomId();
          saveFolders([...db.folders, { id: fid, name, icon: null, color: null, items: [{ kind: kind as 'space' | 'conversation', id }] }]);
        })}
        {inFolder && item('unlink', `Take out of ${inFolder.name}`, () => moveToFolder(m.key, null))}
        {folder && item('trash', 'Delete folder, keep contents', () => {
          saveFolders(db.folders.filter((f) => f.id !== id));
          const r = route.value;
          if (r.view === 'folder' && r.folder === id) go({ view: 'inbox' });
        })}
        {pref && kind !== 'folder' && item('eye', pref.hidden ? 'Show again' : 'Hide', () => patchPlaces([{ kind: placeKind, id, hidden: !pref.hidden }]))}
      </div>
    </div>
  );
}

export function placeLabel(key: string): string {
  const { kind, id } = splitKey(key);
  if (kind === 'folder') return db.folders.find((f) => f.id === id)?.name ?? 'Folder';
  if (kind === 'space') return db.spaces.get(id)?.name ?? 'Space';
  if (kind === 'person') return db.persons.get(id)?.name ?? 'Person';
  return convTitle(db.conversations.get(id));
}
