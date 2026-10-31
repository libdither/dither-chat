/**
 * Sidebar arrangement as plain data: what a drop does to the top-level order and the folders.
 * Keys are `kind:id` as in RailEntry; folder items also allow `person:id`.
 */
export interface Layout {
  order: string[];
  folders: { id: string; items: string[] }[];
}
export type DropWhere = 'before' | 'after' | 'into';
/** A drop target; `folder` when it is a row inside an open folder. */
export interface DropTarget {
  key: string;
  folder?: string;
  where: DropWhere;
}

const isFolder = (key: string) => key.startsWith('folder:');
const folderId = (key: string) => key.slice('folder:'.length);

/** The layout after dropping `drag` on `target`. `newFolderId` names the folder made by dropping one place on another. */
export function applyDrop(layout: Layout, drag: string, target: DropTarget, newFolderId: () => string): Layout {
  if (drag === target.key) return layout;
  const order = layout.order.filter((k) => k !== drag);
  const folders = layout.folders.map((f) => ({ id: f.id, items: f.items.filter((k) => k !== drag) }));

  if (target.where === 'into') {
    // A folder holds places, not other folders: treat that as a move next to it.
    if (isFolder(drag)) return applyDrop(layout, drag, { key: target.key, folder: target.folder, where: 'before' }, newFolderId);
    if (isFolder(target.key)) {
      folders.find((f) => f.id === folderId(target.key))?.items.push(drag);
      return { order, folders };
    }
    if (target.folder) return applyDrop(layout, drag, { ...target, where: 'after' }, newFolderId);
    const id = newFolderId();
    const i = order.indexOf(target.key);
    order.splice(i < 0 ? order.length : i, i < 0 ? 0 : 1, `folder:${id}`);
    folders.push({ id, items: [target.key, drag] });
    return { order, folders };
  }

  if (target.folder && !isFolder(drag)) {
    const f = folders.find((x) => x.id === target.folder);
    if (f) {
      const i = f.items.indexOf(target.key);
      f.items.splice((i < 0 ? f.items.length : i) + (target.where === 'after' ? 1 : 0), 0, drag);
      return { order, folders };
    }
  }
  const anchor = target.folder ? `folder:${target.folder}` : target.key;
  const i = order.indexOf(anchor);
  order.splice(i < 0 ? order.length : i + (target.where === 'after' ? 1 : 0), 0, drag);
  return { order, folders };
}

/** Move one step within the top level, for the menu's keyboard- and screen-reader-friendly route. */
export function moveStep(order: string[], key: string, delta: -1 | 1): string[] {
  const i = order.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const out = [...order];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
