/** Arranging the sidebar: what a drop saves, and the menu entries for everything that is not a drag. */
import type * as P from '@dither-chat/protocol';
import { applyDrop, moveStep, type DropTarget, type Layout } from '../layout.ts';
import { convsUnder, convTitle, directsOf, folderConvs, placePref, railEntries, sumUnread } from '../model.ts';
import { db, go, markAllRead, patchPlaces, route, saveFolders } from '../state.ts';
import { openMenu, type MenuEntry } from './ContextMenu.tsx';
import { placeMenu } from './menus.tsx';
import { arrangedRail, freezeOrder, organizing, sortOf } from '../arrange.ts';
import { canIndex, startIndexing } from './Indexing.tsx';
import { FINDS_LABEL } from './MentionFinds.tsx';

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

/** Opens what a right-click or a held finger opens on a place: dnd.tsx calls this. */
export const openPlaceMenu = (key: string, _label: string, x: number, y: number, folder?: string) => openMenu({ x, y }, placeMenu(key, folder));

function moveToFolder(key: string, folderId: string | null) {
  const l = currentLayout();
  const folders = l.folders.map((f) => ({ ...f, items: f.items.filter((k) => k !== key) }));
  if (folderId) folders.find((f) => f.id === folderId)?.items.push(key);
  save({ order: l.order.filter((k) => !folderId || k !== key), folders });
}

export function newFolderWith(key: string) {
  const { kind, id } = splitKey(key);
  const name = prompt('Folder name', 'New folder')?.trim();
  if (!name) return;
  saveFolders([...db.folders, { id: randomId(), name, icon: null, color: null, items: [{ kind: kind as 'space' | 'conversation' | 'person', id }] }]);
}

/** Where a place sits in the sidebar: pin, order, folders, hide. Every place's menu ends with these. */
export function arrangeEntries(key: string): MenuEntry[] {
  const { kind, id } = splitKey(key);
  const placeKind = kind as P.PlaceKind;
  const pref = kind === 'person' ? null : placePref(placeKind, id);
  const inFolder = db.folders.find((f) => f.items.some((i) => toKey(i) === key));
  // In an automatic order, moving by hand first makes the order on screen yours (arrange.ts).
  const auto = sortOf('rail') !== 'manual' && !inFolder;
  const order = auto ? arrangedRail().map((e) => e.key) : currentLayout().order;
  const pos = order.indexOf(key);
  const step = (d: -1 | 1) => {
    if (auto) freezeOrder(true);
    save({ ...currentLayout(), order: moveStep(currentLayout().order, key, d) });
  };
  const others = db.folders.filter((f) => f.id !== inFolder?.id);
  return [
    pref && pos >= 0 && { label: pref.pinned ? 'Unpin' : 'Pin to Top', icon: 'star', run: () => patchPlaces([{ kind: placeKind, id, pinned: !pref.pinned }]) },
    kind === 'conversation' && !inFolder && { label: pref?.railed ? 'Remove from Sidebar' : 'Add to Sidebar', icon: 'plus', run: () => patchPlaces([{ kind: 'conversation', id, railed: !pref?.railed }]) },
    pos >= 0 && { label: 'Move Up', icon: 'chevronUp', disabled: pos === 0, run: () => step(-1) },
    pos >= 0 && { label: 'Move Down', icon: 'chevronDown', disabled: pos === order.length - 1, run: () => step(1) },
    kind !== 'folder' && {
      label: 'Move to Folder',
      icon: 'folder',
      sub: [
        ...others.map((f): MenuEntry => ({ label: f.name, icon: 'folder', run: () => moveToFolder(key, f.id) })),
        ...(others.length ? [{ kind: 'sep' } as MenuEntry] : []),
        { label: 'New Folder…', icon: 'plus', run: () => newFolderWith(key) },
      ],
    },
    inFolder && { label: `Take Out of ${inFolder.name}`, icon: 'unlink', run: () => moveToFolder(key, null) },
    pref && kind !== 'folder' && { label: pref.hidden ? 'Show in Sidebar' : 'Hide', icon: 'eye', run: () => patchPlaces([{ kind: placeKind, id, hidden: !pref.hidden }]) },
    { label: 'Organize Servers…', icon: 'layers', run: () => (organizing.value = true) },
  ].filter(Boolean) as MenuEntry[];
}

/** A folder's own menu: read, open, rename, delete. */
export function folderEntries(id: string): MenuEntry[][] {
  const folder = db.folders.find((f) => f.id === id);
  if (!folder) return [];
  const open = placePref('folder', id).open;
  return [
    [{ label: 'Mark Folder As Read', icon: 'check', disabled: !sumUnread(folderConvs(folder)).unread, run: () => markAllRead(folderConvs(folder), folder.name) }],
    [
      { label: open ? 'Close in Sidebar' : 'Open in Sidebar', icon: 'folder', run: () => patchPlaces([{ kind: 'folder', id, open: !open }]) },
      { label: 'Open as List', icon: 'groups', run: () => go({ view: 'folder', folder: id }) },
      // Whom the @ list offers in the folder's chats that do not say (docs/mentions.md).
      {
        label: '@ Finds',
        icon: 'at',
        sub: ([null, 'here', 'friends', 'everyone'] as const).map((s): MenuEntry => ({ label: s ? FINDS_LABEL[s] : 'Default', radio: true, checked: (placePref('folder', id).mentionScope ?? null) === s, run: () => patchPlaces([{ kind: 'folder', id, mentionScope: s }]) })),
      },
      ...(canIndex('folder', id) ? [{ label: 'Index Servers in This Folder…', icon: 'archive', run: () => startIndexing('folder', id) }] : []),
      {
        label: 'Rename Folder…',
        icon: 'pencil',
        run: () => {
          const name = prompt('Folder name', folder.name)?.trim();
          if (name) saveFolders(db.folders.map((f) => (f.id === id ? { ...f, name } : f)));
        },
      },
    ],
    arrangeEntries(`folder:${id}`),
    [
      {
        label: 'Delete Folder',
        icon: 'trash',
        danger: true,
        run: () => {
          if (!confirm(`Delete the folder "${folder.name}"? What is in it stays in the sidebar.`)) return;
          saveFolders(db.folders.filter((f) => f.id !== id));
          const r = route.value;
          if (r.view === 'folder' && r.folder === id) go({ view: 'inbox' });
        },
      },
    ],
  ];
}

export function placeConvs(kind: string, id: string): P.ConversationView[] {
  if (kind === 'folder') {
    const f = db.folders.find((f) => f.id === id);
    return f ? folderConvs(f) : [];
  }
  if (kind === 'space') return convsUnder(id);
  if (kind === 'person') return directsOf(id);
  const c = db.conversations.get(id);
  return c ? [c] : [];
}

export function placeLabel(key: string): string {
  const { kind, id } = splitKey(key);
  if (kind === 'folder') return db.folders.find((f) => f.id === id)?.name ?? 'Folder';
  if (kind === 'space') return db.spaces.get(id)?.name ?? 'Space';
  if (kind === 'person') return db.persons.get(id)?.name ?? 'Person';
  return convTitle(db.conversations.get(id));
}
