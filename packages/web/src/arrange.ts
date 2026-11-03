/**
 * Sort modes for the rail and the lists, and the snapshot of the automatic order that is on screen
 * (docs/organize.md). The order is taken anew when the app starts, comes back to the front, every few
 * minutes at most, or when you ask; never while a drag, a menu or your pointer is on a list.
 */
import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_ARRANGE, smartScore, type ArrangeSettings, type SortMode, type SortScope, type UsageKind } from '@dither-chat/protocol';
import type { DropTarget } from './layout.ts';
import { activityOfSpace, convTitle, directsOf, folderConvs, groupsLists, people, placePref, railEntries, spaceUnread, sumUnread, unreadOf, type RailEntry } from './model.ts';
import { sameSnapshot, shouldResort, sortKeys, stabilize, type ResortReason, type Sortable } from './ordering.ts';
import { api, db, loaded, patchPlaces, rev, saveFolders, toast } from './state.ts';
import { fetchUsage, onForeground, startUsage, usageLoaded, usageOf, usageState } from './usage.ts';

const ARRANGE_KEY = 'dither-chat:arrange';
const SNAPSHOT_KEY = 'dither-chat:arrange-snapshot';
const read = <T>(k: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '');
  } catch {
    return null;
  }
};

/** The hub's copy wins once it answers; this device's copy shows the right order before that. */
export const arrange = signal<ArrangeSettings>({ ...DEFAULT_ARRANGE, ...(read<ArrangeSettings>(ARRANGE_KEY) ?? {}) });
/** List id -> keys in the order last taken. Bumping `v` animates the change. */
export const snapshot = signal<{ v: number; at: number | null; lists: Record<string, string[]> }>({ v: 0, at: null, lists: read<Record<string, string[]>>(SNAPSHOT_KEY) ?? {} });
/** The Organize view is open. */
export const organizing = signal(false);

export const sortOf = (scope: SortScope): SortMode => arrange.value.sort[scope];
export const SORT_LABELS: Record<SortMode, string> = { manual: 'Manual', smart: 'Smart', recent: 'Recent activity', az: 'A–Z' };

function setArrange(a: ArrangeSettings) {
  arrange.value = a;
  try {
    localStorage.setItem(ARRANGE_KEY, JSON.stringify(a));
  } catch {}
}

let pickedAt = 0;
export function setSort(scope: SortScope, mode: SortMode) {
  pickedAt = Date.now();
  setArrange({ ...arrange.value, sort: { ...arrange.value.sort, [scope]: mode } });
  api<ArrangeSettings>('/api/arrange', { method: 'PATCH', body: { sort: { [scope]: mode } } })
    .then(setArrange)
    .catch((e) => toast({ kind: 'error', title: 'Could not save the order', body: e.message }));
  resort('mode');
}

export function patchDismissed(dismissed: Record<string, string[] | null>) {
  const next = { ...arrange.value.dismissed };
  for (const [k, v] of Object.entries(dismissed)) v === null ? delete next[k] : (next[k] = v);
  setArrange({ ...arrange.value, dismissed: next });
  api<ArrangeSettings>('/api/arrange', { method: 'PATCH', body: { dismissed } }).then(setArrange).catch(() => {});
}

// ------------------------------------------------------------------ what each place weighs

const idOf = (key: string) => key.slice(key.indexOf(':') + 1);
const score = (kind: UsageKind, id: string, badge: number) => smartScore(usageOf(kind, id), Date.now(), badge);

function itemSortable(it: P.FolderView['items'][number]): Sortable | null {
  const key = `${it.kind}:${it.id}`;
  if (it.kind === 'space') {
    const s = db.spaces.get(it.id);
    return s ? { key, name: s.name, pinned: false, position: null, last: activityOfSpace(s.id), score: score('space', s.id, spaceUnread(s.id).badge) } : null;
  }
  if (it.kind === 'person') {
    const p = db.persons.get(it.id);
    if (!p) return null;
    const ds = directsOf(p.id);
    return { key, name: p.name, pinned: false, position: null, last: ds[0]?.lastMessageAt ?? 0, score: score('person', p.id, sumUnread(ds).badge) };
  }
  const c = db.conversations.get(it.id);
  return c ? convSortable(c) : null;
}

function convSortable(c: P.ConversationView, pinned = false): Sortable {
  return { key: `conversation:${c.id}`, name: convTitle(c), pinned, position: null, last: c.lastMessageAt ?? 0, score: score('conversation', c.id, unreadOf(c).badge) };
}

function entrySortable(e: RailEntry): Sortable {
  const pref = placePref(e.kind, idOf(e.key));
  if (e.kind === 'folder') {
    const members = e.folder.items.map(itemSortable).filter((x): x is Sortable => !!x);
    return { key: e.key, name: e.folder.name, pinned: pref.pinned, position: pref.position, last: Math.max(0, ...folderConvs(e.folder).map((c) => c.lastMessageAt ?? 0)), score: 0, members };
  }
  const base = e.kind === 'space' ? itemSortable({ kind: 'space', id: e.space.id })! : convSortable(e.conv);
  return { ...base, pinned: pref.pinned, position: pref.position };
}

// ------------------------------------------------------------------ the lists, in the order to show

/** Pinned first in your order, then the snapshot's order, then anything new. */
function shown(list: string, items: Sortable[], mode: SortMode, live: boolean): string[] {
  const fresh = sortKeys(items, mode);
  const pinned = new Set(items.filter((x) => x.pinned).map((x) => x.key));
  if (live) return fresh;
  return [...fresh.filter((k) => pinned.has(k)), ...stabilize(snapshot.value.lists[list], fresh.filter((k) => !pinned.has(k)))];
}

/**
 * Only Smart waits for a quiet moment in the people and group lists: Recent there stays live, as in any chat
 * app, and A–Z only changes when something is renamed or added. The rail keeps a snapshot in every
 * automatic mode, since a server jumping under the pointer is what it must never do.
 */
const isLive = (scope: SortScope, mode: SortMode) => mode === 'manual' || (scope !== 'rail' && mode !== 'smart');

/** Top-level rail entries in the order to show. */
export function arrangedRail(): RailEntry[] {
  rev.value;
  snapshot.value;
  const entries = railEntries();
  const mode = sortOf('rail');
  if (mode === 'manual') return entries;
  const byKey = new Map(entries.map((e) => [e.key, e]));
  return shown('rail', entries.map(entrySortable), mode, false).map((k) => byKey.get(k)!);
}

/** A folder's contents, sorted the same way as the rail. */
export function arrangedFolderItems(f: P.FolderView): P.FolderView['items'] {
  const mode = sortOf('rail');
  if (mode === 'manual') return f.items;
  const items = f.items.map(itemSortable).filter((x): x is Sortable => !!x);
  const byKey = new Map(f.items.map((it) => [`${it.kind}:${it.id}`, it]));
  return shown(`folder:${f.id}`, items, mode, false).map((k) => byKey.get(k)!);
}

type PersonEntry = { person: P.PersonView; directs: P.ConversationView[]; last: number };
const personSortable = (x: PersonEntry): Sortable => ({ key: `person:${x.person.id}`, name: x.person.name, pinned: x.person.starred, position: null, last: x.last, score: score('person', x.person.id, sumUnread(x.directs).badge) });
const groupSortable = (c: P.ConversationView) => convSortable(c, placePref('conversation', c.id).pinned);

/** The People list; starred people stay first, like pinned places. */
export function arrangedPeople(list: PersonEntry[]): PersonEntry[] {
  const mode = sortOf('people');
  if (mode === 'recent') return list;
  const byKey = new Map(list.map((x) => [`person:${x.person.id}`, x]));
  return shown('people', list.map(personSortable), mode, isLive('people', mode)).map((k) => byKey.get(k)!);
}

/** A list of group chats or rooms (`groups:g`, `groups:r`); pinned ones first. */
export function arrangedConvs(list: string, convs: P.ConversationView[]): P.ConversationView[] {
  const mode = sortOf('groups');
  if (mode === 'recent' && !convs.some((c) => placePref('conversation', c.id).pinned)) return convs;
  const byKey = new Map(convs.map((c) => [`conversation:${c.id}`, c]));
  return shown(list, convs.map(groupSortable), mode, isLive('groups', mode)).map((k) => byKey.get(k)!);
}

// ------------------------------------------------------------------ taking a new snapshot

let interactingCheck: () => boolean = () => false;
/** The UI says what counts as "in use": a drag, an open menu, a pointer on a list. */
export function setInteracting(fn: () => boolean) {
  interactingCheck = fn;
}

let waiting: ReturnType<typeof setTimeout> | undefined;
/** Take a new snapshot of every automatic order, if now is a good moment; otherwise as soon as it is. */
export function resort(reason: ResortReason) {
  clearTimeout(waiting);
  const now = Date.now();
  if (!shouldResort({ reason, now, last: snapshot.value.at, interacting: organizing.value || interactingCheck() })) {
    // Retry soon, but as a timer: a start or a return to the front that had to wait still happens.
    if (reason !== 'timer') waiting = setTimeout(() => resort(reason), 1500);
    return;
  }
  const lists: Record<string, string[]> = {};
  const unpinned = (items: Sortable[], mode: SortMode) => sortKeys(items.filter((x) => !x.pinned), mode);
  const rail = sortOf('rail');
  if (rail !== 'manual') {
    lists.rail = unpinned(railEntries().map(entrySortable), rail);
    for (const f of db.folders) lists[`folder:${f.id}`] = unpinned(f.items.map(itemSortable).filter((x): x is Sortable => !!x), rail);
  }
  if (sortOf('people') === 'smart') lists.people = unpinned(people().map(personSortable), 'smart');
  if (sortOf('groups') === 'smart') {
    const g = groupsLists();
    lists['groups:g'] = unpinned(g.groups.map(groupSortable), 'smart');
    lists['groups:r'] = unpinned(g.rooms.map(groupSortable), 'smart');
  }
  const prev = snapshot.value;
  const same = sameSnapshot(prev.lists, lists);
  snapshot.value = { v: same ? prev.v : prev.v + 1, at: now, lists };
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(lists));
  } catch {}
}

// ------------------------------------------------------------------ freezing it into your order

/** The automatic order on screen becomes your manual order, once, and the rail switches to Manual. */
export function freezeOrder(quiet = false) {
  const top = arrangedRail();
  patchPlaces(top.map((e, i) => ({ kind: e.kind, id: idOf(e.key), position: i })));
  const folders = db.folders.map((f) => ({ ...f, items: arrangedFolderItems(f) }));
  if (folders.some((f, i) => f.items.map((x) => x.id).join() !== db.folders[i].items.map((x) => x.id).join())) saveFolders(folders);
  if (sortOf('rail') !== 'manual') setSort('rail', 'manual');
  if (!quiet) toast({ kind: 'info', title: 'Order frozen', body: 'The rail keeps this order now. Drag to change it, or pick another order.' });
}

/**
 * A drop in the rail: placing a server by hand only makes sense in your own order, so in an automatic one
 * the order on screen becomes yours first. Dropping into a folder does not need that.
 */
export function arrangeDrop(drop: (key: string, target: DropTarget) => void) {
  return (key: string, target: DropTarget) => {
    if (sortOf('rail') !== 'manual' && target.where !== 'into') {
      freezeOrder(true);
      toast({ kind: 'info', title: 'Switched to Manual order', body: 'Moving a server by hand keeps the rest where they were.' });
    }
    drop(key, target);
  };
}

// ------------------------------------------------------------------ when

let started = false;
export function startArrange() {
  if (started || typeof window === 'undefined') return;
  started = true;
  startUsage();
  // Sort modes come with the usage totals; a mode picked here a moment ago is not undone by an older answer.
  effect(() => {
    const s = usageState.value;
    if (s?.arrange && Date.now() - pickedAt > 5000) setArrange(s.arrange);
  });
  // The first order once the places and the hub's usage are both in.
  const first = () => {
    if (loaded.value && usageLoaded.value) resort('start');
    else setTimeout(first, 300);
  };
  first();
  onForeground.add(() => resort('foreground'));
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    fetchUsage().then(() => resort('timer'));
  }, 60_000);
}
