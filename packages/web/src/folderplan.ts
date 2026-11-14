/**
 * The suggested layout on this device (docs/organize.md, "Suggested layout"): the hub's places read into the planner
 * (protocol folderplan.ts), and taking what you chose, with an undo.
 */
import type * as P from '@dither-chat/protocol';
import type { FolderPlan, PlanChoice, PlanInput } from '@dither-chat/protocol/folderplan';
import { signal } from '@preact/signals';
import { allCommunities, convsUnder, placePref, railEntries } from './model.ts';
import { db, patchPlaces, saveFolders, toast } from './state.ts';

const randomId = () => 'fld_' + Math.random().toString(36).slice(2, 12);

/** The planner, a chunk of its own: loaded when the Organize view first opens, not at start. */
export const planner = signal<typeof import('@dither-chat/protocol/folderplan') | null>(null);
let loading: Promise<unknown> | null = null;
export const loadPlanner = () => (loading ??= import('@dither-chat/protocol/folderplan').then((m) => (planner.value = m)));

/** What the planner reads, from what this device has. */
export function planInput(): PlanInput {
  const spaces = allCommunities().map((s) => ({
    id: s.id,
    network: s.network,
    name: s.name,
    text: [s.topic ?? '', ...convsUnder(s.id).slice(0, 25).map((c) => c.name ?? '')].join(' '),
    accountIds: s.accountIds,
  }));
  const vectors: Record<string, Record<string, number>> = {};
  for (const s of spaces) {
    const cats = db.placeCategories.get(`space:${s.id}`);
    if (cats?.length) vectors[s.id] = Object.fromEntries(cats.filter((c) => c.p !== null).map((c) => [c.categoryId, c.p!]));
  }
  const accounts = [...db.accounts.values()].map((a) => ({ id: a.id, network: a.network, label: a.label, color: a.color }));
  const networkFolders = [...db.accounts.values()].flatMap((a) => (a.self?.folders ?? []).map((f) => ({ accountId: a.id, name: f.name, color: f.color ?? null, spaces: f.spaces })));
  return { accounts, spaces, folders: db.folders, networkFolders, vectors };
}

/** The plan now, once the planner has loaded. */
export function currentPlan(): FolderPlan | null {
  return planner.value?.planFolders(planInput()) ?? null;
}

/** Takes what was chosen; new folders go where their first server was in the rail. Returns how many places moved. */
export function takePlan(plan: FolderPlan, choice: PlanChoice): number {
  const applyPlan = planner.value?.applyPlan;
  if (!applyPlan) return 0;
  const before = db.folders.map((f) => ({ ...f, items: [...f.items] }));
  const loose = railEntries().map((e) => e.key);
  const next = applyPlan(db.folders, plan, choice, randomId, loose);
  const had = new Set(before.map((f) => f.id));
  const inner = new Set(next.flatMap((f) => f.items.filter((i) => i.kind === 'folder').map((i) => i.id)));
  // Where each new top-level folder goes: just before the earliest of its places that had a spot in the rail.
  const pos = (k: string) => placePref(k.slice(0, k.indexOf(':')) as P.PlaceKind, k.slice(k.indexOf(':') + 1)).position;
  const leaves = (f: P.FolderView): string[] => f.items.flatMap((i) => (i.kind === 'folder' ? leaves(next.find((x) => x.id === i.id) ?? { ...f, items: [] }) : [`${i.kind}:${i.id}`]));
  const placed: P.PlacePrefPatch[] = [];
  const undoPlaces: P.PlacePrefPatch[] = [];
  next.forEach((f) => {
    if (had.has(f.id) || inner.has(f.id)) return;
    const ps = [...leaves(f), ...f.items.filter((i) => i.kind === 'folder').map((i) => `folder:${i.id}`)].map(pos).filter((p): p is number => p !== null);
    if (ps.length) placed.push({ kind: 'folder', id: f.id, position: Math.min(...ps) - 0.5 });
  });
  // A folder that moved into an account's folder keeps its old spot for an undo.
  for (const f of before) if (inner.has(f.id)) undoPlaces.push({ kind: 'folder', id: f.id, position: placePref('folder', f.id).position });
  const places = (fs: P.FolderView[]) => fs.reduce((n, f) => n + f.items.filter((i) => i.kind !== 'folder').length, 0);
  const moved = places(next) - places(before);
  saveFolders(next);
  if (placed.length) patchPlaces(placed);
  toast({
    kind: 'info',
    title: 'Layout applied',
    body: `${next.length - before.length} new ${next.length - before.length === 1 ? 'folder' : 'folders'}, ${moved} ${moved === 1 ? 'server' : 'servers'} filed. Tap to undo.`,
    actionLabel: 'Undo',
    action: () => {
      saveFolders(before);
      if (undoPlaces.length) patchPlaces(undoPlaces);
    },
  }, 12_000);
  return moved;
}
