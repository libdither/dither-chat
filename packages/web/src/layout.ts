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

/** The folder whose items hold `key`. */
export const holderOf = (folders: Layout['folders'], key: string) => folders.find((f) => f.items.includes(key));

/**
 * Whether folder `parent` may take `drag`. A place always; a folder only one level deep: not into itself, not when it
 * holds folders of its own, and not into a folder that is itself inside one.
 */
export function mayHold(folders: Layout['folders'], parent: string, drag: string): boolean {
  if (!isFolder(drag)) return true;
  const d = folderId(drag);
  if (d === parent) return false;
  if (folders.find((f) => f.id === d)?.items.some(isFolder)) return false;
  return !holderOf(folders, `folder:${parent}`);
}

/** The top-level key a key sits under: itself, its folder, or its folder's folder. */
function outermost(folders: Layout['folders'], key: string): string {
  for (let k = key, i = 0; i < 3; i++) {
    const h = holderOf(folders, k);
    if (!h) return k;
    k = `folder:${h.id}`;
  }
  return key;
}

/** The layout after dropping `drag` on `target`. `newFolderId` names the folder made by dropping one place on another. */
export function applyDrop(layout: Layout, drag: string, target: DropTarget, newFolderId: () => string): Layout {
  if (drag === target.key) return layout;
  const order = layout.order.filter((k) => k !== drag);
  const folders = layout.folders.map((f) => ({ id: f.id, items: f.items.filter((k) => k !== drag) }));

  if (target.where === 'into') {
    if (isFolder(target.key)) {
      const into = folders.find((f) => f.id === folderId(target.key));
      if (into && mayHold(folders, into.id, drag)) {
        into.items.push(drag);
        return { order, folders };
      }
      // A folder that cannot go in goes next to it.
      return applyDrop(layout, drag, { key: target.key, folder: target.folder, where: 'before' }, newFolderId);
    }
    if (isFolder(drag) || target.folder) return applyDrop(layout, drag, { ...target, where: isFolder(drag) ? 'before' : 'after' }, newFolderId);
    const id = newFolderId();
    const i = order.indexOf(target.key);
    order.splice(i < 0 ? order.length : i, i < 0 ? 0 : 1, `folder:${id}`);
    folders.push({ id, items: [target.key, drag] });
    return { order, folders };
  }

  if (target.folder) {
    const f = folders.find((x) => x.id === target.folder);
    if (f && mayHold(folders, f.id, drag)) {
      const i = f.items.indexOf(target.key);
      f.items.splice((i < 0 ? f.items.length : i) + (target.where === 'after' ? 1 : 0), 0, drag);
      return { order, folders };
    }
    // A folder dropped among a folder's rows where it cannot nest: beside the folder, in the folder above if it may.
    const outer = holderOf(folders, `folder:${target.folder}`);
    if (f && outer && mayHold(folders, outer.id, drag)) {
      const i = outer.items.indexOf(`folder:${target.folder}`);
      outer.items.splice(i + (target.where === 'after' ? 1 : 0), 0, drag);
      return { order, folders };
    }
  }
  const anchor = outermost(folders, target.folder ? `folder:${target.folder}` : target.key);
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
