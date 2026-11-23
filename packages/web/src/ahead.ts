/**
 * Fetching ahead (prefetch.ts) with the app's own state. prefetch.ts is a chunk of its own, loaded once the first screen
 * is up; it imports none of the app, so the startup set's chunks stay as they were.
 */
import { effect } from '@preact/signals';
import type { Deps } from './prefetch.ts';
import { inboxSnap, shownInbox } from './inbox.ts';
import { chatPersonOf, directsOf, inboxRows } from './model.ts';
import { channelKey } from './channelrows.ts';
import { fromSnapshot, pages } from './snapshot.ts';
import { channelView } from './stream.ts';
import { connected, db, loaded, loadTimeline, openHooks, timelines } from './state.ts';

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
  // A channel that opens on its stream (stream.ts), its stream; one on its thread cards has no timeline to fetch.
  return p ? `p:${p.id}` : channelView(c) === 'stream' ? `k:${c.id}` : `c:${c.id}`;
};

/**
 * The timeline a channel's inbox row leads to (docs/inbox.md "One row per channel"): the channel's, or for a forum,
 * which opens on its cards and takes no messages of its own, the row's latest listed thread's, the likeliest next.
 */
const channelRowKey = (channelId: string) => {
  const c = db.conversations.get(channelId);
  if (!c) return null;
  if (c.variant !== 'forum' && c.variant !== 'media') return `c:${c.id}`;
  const row = inboxRows().find((r) => r.key === channelKey(channelId));
  const t = row?.kind === 'conv' ? row.channel?.latest : undefined;
  return t && t !== c ? `c:${t.id}` : null;
};

const deps: Deps = {
  loaded: () => loaded.value,
  connected: () => connected.value,
  fresh: () => !fromSnapshot && performance.getEntriesByName('dither:fresh').length > 0,
  busy: () => [...timelines.values()].some((t) => t.loading && !t.glance),
  // A chat of several routes is one row (docs/inbox.md), and opens the person's chat.
  rows: () =>
    shownInbox('all').flatMap((r) => {
      if (r.kind !== 'conv') return [];
      if (r.chat) return [`p:${r.chat.person.id}`];
      if (r.channel) return [channelRowKey(r.conv.id) ?? `c:${r.channel.latest.id}`];
      return [convKey(r.conv.id) ?? `c:${r.conv.id}`];
    }),
  // A row's `data-row` (a conversation, `person:<id>` for a chat, `channel:<id>` for a channel's threads) or a person row's `data-person`.
  rowKey: (row) => (row.startsWith('person:') ? personKey(row.slice('person:'.length)) : row.startsWith('channel:') ? channelRowKey(row.slice('channel:'.length)) : convKey(row)),
  personKey,
  inMemory: (key) => timelines.has(key),
  drop: (key) => {
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
