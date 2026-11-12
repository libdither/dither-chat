/**
 * Fetching ahead (prefetch.ts) with the app's own state. prefetch.ts is a chunk of its own, loaded once the first screen
 * is up; it imports none of the app, so the startup set's chunks stay as they were.
 */
import { effect } from '@preact/signals';
import type { Deps } from './prefetch.ts';
import { inboxSnap, shownInbox } from './inbox.ts';
import { chatPersonOf, directsOf } from './model.ts';
import { fromSnapshot, pages } from './snapshot.ts';
import { connected, db, loaded, loadTimeline, openHooks, route, timelines } from './state.ts';

/** The timeline a person's page opens: their one DM, or their chat of several routes (ui/Timeline.tsx PersonPane). */
const personKey = (id: string) => {
  const ds = directsOf(id);
  return ds.length === 1 ? `c:${ds[0].id}` : ds.length ? `p:${id}` : null;
};
/** The timeline a conversation's page opens: a DM of someone reached by several routes is their chat (ConversationPane). */
const convKey = (id: string) => {
  const c = db.conversations.get(id);
  if (!c) return null;
  const p = chatPersonOf(c);
  return p ? `p:${p.id}` : `c:${c.id}`;
};

const deps: Deps = {
  loaded: () => loaded.value,
  connected: () => connected.value,
  fresh: () => !fromSnapshot && performance.getEntriesByName('dither:fresh').length > 0,
  busy: () => [...timelines.values()].some((t) => t.loading && !t.glance),
  // A chat of several routes is one row (docs/inbox.md), and opens the person's chat.
  rows: () => shownInbox('all').flatMap((r) => (r.kind !== 'conv' ? [] : r.chat ? [`p:${r.chat.person.id}`] : [convKey(r.conv.id) ?? `c:${r.conv.id}`])),
  // A row's `data-row` (a conversation, or `person:<id>` for a chat) or a person row's `data-person`.
  rowKey: (row) => (row.startsWith('person:') ? personKey(row.slice('person:'.length)) : convKey(row)),
  personKey,
  inMemory: (key) => timelines.has(key),
  drop: (key) => {
    // Not while Catch up may show it as a card (the inbox with nothing open, or its tab).
    const r = route.value;
    if (r.view === 'triage' || (r.view === 'inbox' && !r.conv)) return false;
    const t = timelines.get(key);
    if (t?.glance && !t.loading) timelines.delete(key);
    return true;
  },
  keep: (key) => pages.touch(key),
  glance: (key) => loadTimeline(key, false, { glance: true }),
  messages: (key) => timelines.get(key)?.messages ?? [],
  avatar: (id) => {
    const i = db.identities.get(id);
    return (i?.personId ? db.persons.get(i.personId)?.avatar : null) ?? i?.avatar;
  },
  onRows: (fn) => void effect(() => void (inboxSnap.value, fn())),
  onOpen: (fn) => void openHooks.add(fn),
};

export function startAhead() {
  void import('./prefetch.ts').then((m) => m.startPrefetch(deps));
}
