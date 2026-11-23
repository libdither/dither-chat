/**
 * Next unread topic (docs/threads.md "Next unread"): the bar at the bottom of a thread's timeline, and where the `n`
 * key goes. nextunread.ts decides where; this reads the page's channels and threads for it, in the order the rail and
 * the sidebar show them, and goes there. A chunk of its own, loaded by NextUnreadLazy.tsx.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { arrangedFolderItems, arrangedRail } from '../arrange.ts';
import { countKey } from '../clicklog.ts';
import { convLabel, placeConv, spaceChildren, threadWords, topicForum, unreadOf, visibleConv } from '../model.ts';
import { nextUnread, type Here, type Lane, type Next, type Slot } from '../nextunread.ts';
import { openConv } from '../opening.ts';
import { db, rev, route, toast } from '../state.ts';
import { dataVersion, metaDataVersion } from '../versions.ts';
import { Icon } from './icons.tsx';
import { quietOpen, streamShown } from './NextUnreadLazy.tsx';

/** Variants whose channel holds no messages of its own: its threads are all there is to read. */
const NO_OWN: ReadonlySet<P.Variant> = new Set(['forum', 'media']);

/** Every channel in sidebar order: the rail's servers (and those in its folders) in its order, each one's tree in order. */
let laneCache: { key: string; lanes: Lane[] } | null = null;
function lanes(): Lane[] {
  const rail = arrangedRail();
  // The rail's order and each folder's (an automatic sort moves both), and the tree's names and settings.
  const order = rail.map((e) => (e.kind === 'folder' ? `${e.key}[${arrangedFolderItems(e.folder).map((i) => i.id).join(',')}]` : e.key));
  const key = `${metaDataVersion()}|${order.join(',')}`;
  if (laneCache?.key === key) return laneCache.lanes;
  const out: Lane[] = [];
  const seenSpaces = new Set<string>();
  const walk = (id: string, top: string) => {
    if (seenSpaces.has(id)) return;
    seenSpaces.add(id);
    for (const n of spaceChildren(id)) {
      if (n.kind === 'conversation') out.push({ channel: n.id, space: top });
      else walk(n.id, top);
    }
  };
  const seenFolders = new Set<string>();
  const folder = (f: P.FolderView) => {
    if (seenFolders.has(f.id)) return;
    seenFolders.add(f.id);
    for (const it of arrangedFolderItems(f)) {
      if (it.kind === 'space') walk(it.id, it.id);
      else if (it.kind === 'conversation') out.push({ channel: it.id, space: '' });
      else if (it.kind === 'folder') {
        const inner = db.folders.find((x) => x.id === it.id);
        if (inner) folder(inner);
      }
    }
  };
  for (const e of rail) {
    if (e.kind === 'space') walk(e.space.id, e.space.id);
    else if (e.kind === 'folder') folder(e.folder);
    else out.push({ channel: e.conv.id, space: '' });
  }
  laneCache = { key, lanes: out };
  return out;
}

const slot = (c: P.ConversationView): Slot => {
  const u = unreadOf(c);
  return { id: c.id, unread: u.unread, mentions: u.mentions, muted: u.muted, lastAt: c.lastMessageAt ?? 0 };
};

/**
 * What you went on from with `n` or the bar, and its latest activity then: passed over until something new comes in
 * there. Without it, two unread threads would send you back and forth, as one left in a moment is not yet read.
 */
const passed = new Map<string, number>();
const isPassed = (c: P.ConversationView) => passed.has(c.id) && passed.get(c.id) === (c.lastMessageAt ?? 0);

/** What there is to read in a channel: its own messages (where it takes any), and its threads. Zulip's resolved topics count; another network's archived threads do not, as its sidebar. */
function slotsOf(id: string): Slot[] {
  const c = db.conversations.get(id);
  if (!c) return [];
  const out: Slot[] = [];
  if (!NO_OWN.has(c.variant) && c.vantages.some((v) => v.unread || v.mentions) && !isPassed(c)) out.push(slot(c));
  for (const tid of db.threads.get(id) ?? []) {
    const t = db.conversations.get(tid);
    if (t && t.vantages.some((v) => v.unread || v.mentions) && visibleConv(t) && (!t.archived || topicForum(c)) && !isPassed(t)) out.push(slot(t));
  }
  return out;
}

/** Where `convId` is: a thread in its channel, or a channel itself; in the server shown, if one is. */
function hereOf(convId: string): Here | null {
  const c = db.conversations.get(convId);
  if (!c) return null;
  const base = placeConv(c);
  const r = route.value;
  const space = r.view === 'space' ? r.space : undefined;
  return base.id === c.id ? { channel: c.id, thread: null, space } : { channel: base.id, thread: c.id, space };
}

/** The next unread after the conversation `convId`; `stream`: it is shown as a channel's stream, and next is the next channel. */
let lastNext: { key: string; next: Next | null } | null = null;
function nextAfter(convId: string, stream = false): Next | null {
  const here = hereOf(convId);
  if (!here) return null;
  const all = lanes();
  // Once per data version: a timeline drawn again for a scroll asks the same.
  const key = `${convId}|${stream}|${here.space}|${dataVersion()}|${laneCache?.key}|${passed.size}`;
  if (lastNext?.key === key) return lastNext.next;
  const next = nextUnread(all, here, slotsOf, stream ? 'channel' : 'thread');
  lastNext = { key, next };
  return next;
}

function goTo(n: Next, from: string) {
  const c = db.conversations.get(n.id);
  if (!c) return;
  const left = db.conversations.get(from);
  if (left) passed.set(left.id, left.lastMessageAt ?? 0);
  quietOpen(n.id);
  (document.activeElement as HTMLElement | null)?.blur?.();
  openConv(c);
}

/** "topic", "thread": what the place calls a thread, for a toast. */
const noun = (convId: string) => threadWords(db.conversations.get(convId)).one;

/** The `n` key, from the conversation `at` (NextUnreadLazy.tsx took the key). */
export function goNext(at: string) {
  countKey('keys: N (next unread)');
  const stream = streamShown();
  const n = nextAfter(at, !!stream && hereOf(at)?.thread === null && hereOf(stream)?.channel === at);
  if (n) goTo(n, at);
  else toast({ kind: 'info', title: `No unread ${noun(at)}s left`, body: 'Everything after this one is read.' });
}

/**
 * The bar at the bottom of a thread's timeline: "Next: <name> · N unread", once you are at the newest message
 * (`bottom`) and there is a next one. In a channel's stream (`stream`), the next channel with anything unread. Drawn on
 * its own: a new message anywhere redraws this, not the timeline above it.
 */
export function NextUnreadBar({ at, stream = false, bottom }: { at: string; stream?: boolean; bottom: boolean }) {
  const here = hereOf(at);
  const channelId = here?.channel ?? at;
  rev.value;
  // A thread's page, or a stream: a channel's own page has its threads in the sidebar, and `n` still works there.
  const n = bottom && (stream || here?.thread) ? nextAfter(at, stream) : null;
  const target = n && db.conversations.get(n.id);
  const channel = n && db.conversations.get(n.channel);
  if (!n || !target || !channel) return null;
  const other = !stream && channelId !== n.channel && target.id !== channel.id;
  // Into another server: its name first, so the jump is no surprise.
  const mine = here?.space ?? lanes().find((l) => l.channel === channelId)?.space;
  const away = n.space && n.space !== mine ? db.spaces.get(n.space)?.name : undefined;
  return (
    <button
      class={`next-unread ${n.mentions ? 'mention' : ''}`}
      style={{ '--chan': NETWORK_META[channel.network].color } as any}
      data-track="next unread"
      title={`Next unread ${noun(n.id)} (N)`}
      onClick={() => goTo(n, at)}
    >
      <span class="next-unread-lead">Next:</span>
      {away && <span class="next-unread-chan">{away} ›</span>}
      {other && <span class="next-unread-chan">{convLabel(channel)} ›</span>}
      <span class="next-unread-name">{convLabel(target)}</span>
      <span class="next-unread-count">
        {n.mentions > 0 && <span class="next-unread-at">@</span>}
        {n.unread} unread
      </span>
      <Icon name="chevronRight" size={14} />
    </button>
  );
}
