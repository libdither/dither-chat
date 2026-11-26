import type * as P from '@dither-chat/protocol';
import { bareSubject, NETWORK_META, searchOfList } from '@dither-chat/protocol';
import { computed, type ReadonlySignal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ago, since } from '../format.ts';
import {
  authorName,
  communitiesOf,
  communityOfSpace,
  convLabel,
  convTitle,
  directsOf,
  effectiveLevel,
  folderConvs,
  folderLeaves,
  parentFolder,
  heldByRequest,
  inboxKeyOf,
  placePref,
  railEntries,
  accountsNeedingYou,
  kindLabel,
  mailRowsWaiting,
  netName,
  people,
  placeConv,
  plainBody,
  resolvedTopic,
  rowConvs,
  ruleIcon,
  spaceChildren,
  channelUnread,
  shownThreads,
  spaceUnread,
  sumUnread,
  threadWords,
  unreadThreadsOf,
  unreadOf,
  visibleConv,
  type InboxRow,
  type RailEntry,
} from '../model.ts';
import { convPresence } from './PresenceDot.tsx';
import { db, go, isSelfIdentity, mailRev, metaRev, pref, readMinute, rev, route, setPrefs, type InboxFilter } from '../state.ts';
import { openPalette } from './Palette.tsx';
import { INBOX_FILTERS } from '../ordering.ts';
import { isGroupThread, listName, listSearch, searchIn, threadName, threadSnippet } from '../mail/model.ts';
import { MailSidebarLazy } from './mail/lazy.tsx';
import { personItems } from './mail/Classify.tsx';
import { RowTyping } from './Typing.tsx';
import { AccountChip, AccountDots, Avatar, Count, NetBadge, NetGlyph, SourceChip, variantIcon } from './bits.tsx';
import { dragProps, dropClass } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { InboxStatus } from './InboxStatus.tsx';
import { offline } from './Offline.tsx';
import { FolderIcon } from './Rail.tsx';
import { phone } from '../phone.ts';
import { dropPlace, placeLabel } from './Organize.tsx';
import { contextMenu, Menuable, onMenu, openMenu, useMenu, type MenuEntry } from './ContextMenu.tsx';
import { chatMenu, conversationMenu, folderMenuSpec, openPlaceMenu, personMenu, spaceMenu, WhyHere } from './menus.tsx';
import { accountMenu } from './accountMenu.tsx';
import { MarkableRow } from './ReplyMark.tsx';
import { needsReplyLabel, needsReplyOf } from '../replymarks.ts';
import { pickedRoute } from '../pairpick.ts';
import { chatKey } from '../chatroutes.ts';
import { threadDialog } from '../threads.ts';
import { showCardsOnce } from '../stream.ts';
import { subThreads } from '../channelrows.ts';
import { groups, type MenuSpec } from './ContextMenu.tsx';
import { openAbout } from '../opening.ts';
import { arrangeDrop, arrangedFolderItems, arrangedPeople, arrangedRail, snapshot } from '../arrange.ts';
import { openShelves, shelve, toggleShelf } from '../quiet.ts';
import { inboxSnap, shownInbox } from '../inbox.ts';
import { linkAccounts, PeopleAccountPicker, PeopleLinks, RequestsRow, usePeopleLinks } from './Requests.tsx';
import { loudByConv, loudEdge, loudOf } from '../loudness.ts';
import { NoticesRow } from './Notices.tsx';
import { CalibrationRow } from './Calibration.tsx';
import { nameMatches, peopleFilters, type PeopleFilter } from '../requests.ts';
import { SortButton, SortIcon, useFlip } from './Reorganize.tsx';
import { rememberSearch, SearchBox } from './SearchBox.tsx';
import { InboxFoundLazy, preloadSearch } from './SearchLazy.tsx';
import { filterRows, hasOperators, rowStandsFor } from '../inboxfilter.ts';
import { counting, rendered } from '../perf.ts';
import { memo, sameProps } from './memo.ts';
import { convKind, rowTrack } from '../clicks.ts';
import { useShown } from './more.tsx';
import { VoicePeople } from './Ringing.tsx';
import { MailListChips, MailTile } from './MailLists.tsx';
import { CallMark } from './CallBar.tsx';

// ------------------------------------------------------------------ navigation helpers

// Opening a conversation (openConv, homeRoute) is in opening.ts.

/** Only there if some connected account can actually start a conversation, or join or add (docs/add.md). */
function NewMessageButton() {
  if (![...db.accounts.values()].some((a) => a.status === 'online' && (a.capabilities.includes('openDirect') || a.capabilities.includes('resolve'))) && !db.mail.accounts.size) return null;
  return (
    <button class="icon-btn small side-new" data-track="new message" title="New message, join or add" aria-label="New message" onClick={() => openPalette({ kind: 'new' })}>
      <Icon name="plus" size={16} />
    </button>
  );
}

/** Opens Same person?: who may be one person on several accounts (same/SamePerson.tsx). */
function SameButton() {
  const on = route.value.view === 'people' && !!route.value.same;
  return (
    <button class={`icon-btn small side-same ${on ? 'on' : ''}`} data-track="same person" title="Same person? Accounts that may be one person" aria-label="Same person?" aria-pressed={on} onClick={() => go(on ? { view: 'people' } : { view: 'people', same: true })}>
      <Icon name="merge" size={16} />
    </button>
  );
}

/** Opens the people graph: who shares which servers and groups (graph/GraphView.tsx). */
function GraphButton() {
  const on = route.value.view === 'people' && !!route.value.graph;
  return (
    <button class={`icon-btn small side-graph ${on ? 'on' : ''}`} data-track="people graph" title="Who shares what" aria-label="People graph" aria-pressed={on} onClick={() => go(on ? { view: 'people' } : { view: 'people', graph: true })}>
      <Icon name="graph" size={16} />
    </button>
  );
}

function preview(c: P.ConversationView): string {
  const m = c.lastMessage;
  if (!m) return c.topic ?? kindLabel(c);
  const who = m.authorId ? authorName(m.authorId) : '';
  const showWho = c.shape !== 'direct' || who === 'You';
  return `${showWho && who ? who + ': ' : ''}${plainBody(m.text, c.network) || (m.kind === 'media' ? 'Attachment' : '')}`;
}

/** Where a conversation lives, for rows in mixed lists. */
function placeLine(c: P.ConversationView): string {
  if (c.shape === 'direct') return '';
  const base = placeConv(c);
  const com = communitiesOf(c)[0];
  const parts = [];
  if (com) parts.push(com.name);
  if (base !== c) parts.push(convLabel(base));
  return parts.join(' › ');
}

// ------------------------------------------------------------------ rows

/** A row's "5m": it reads the list's version, so it moves on as often as the list changes, without the row. */
function Ago({ ts }: { ts: number | null | undefined }) {
  readMinute();
  return <>{ago(ts)}</>;
}

/**
 * A reply you owe: ↩ and how long, and the chance it needs one (`p`, docs/inbox.md "Needs a reply") as a faint
 * percentage that styles.css draws from `data-p`, so the row has no more elements.
 */
function Owed({ at, p }: { at: number; p?: number | null }) {
  readMinute();
  const chance = p != null ? needsReplyLabel(p) : null;
  return (
    <span class="row-owed" aria-label={`Unanswered for ${since(at)}${chance ? `. ${chance}` : ''}`} title={chance ?? undefined} data-p={p != null ? `${Math.round(p * 100)}%` : undefined}>
      <Icon name="reply" size={11} />
      {since(at)}
    </span>
  );
}

/** One opener per place, the same each time, so a row whose conversation did not change is not drawn again. */
const openers = new Map<string, () => void>();
function opener(key: string, open: () => void): () => void {
  let f = openers.get(key);
  if (!f) openers.set(key, (f = open));
  return f;
}

/**
 * `why` is the inbox's reasons, shown on hover and at the top of the row's menu; `owedSince` marks a message you
 * have not answered, for a row that needs you: ↩ and how long, beside the unread count if there is one. `chat`: the
 * inbox's one row for a person reached by several routes (model.ts), drawn as a DM row of the route with the latest
 * message (`c`), its unread summed over every route and its menu acting on them all.
 */
const ConvRow = memo(function ConvRow({
  c,
  active,
  onClick,
  showPlace = true,
  why,
  owedSince,
  needsP,
  chat,
  loud,
}: {
  c: P.ConversationView;
  active: boolean;
  onClick: () => void;
  showPlace?: boolean;
  why?: string[];
  owedSince?: number | null;
  needsP?: number | null;
  chat?: { person: P.PersonView; routes: P.ConversationView[] };
  /** How loud its latest message was, 0 to 100 (docs/inbox.md "The loudness edge"): drawn while it is unread. */
  loud?: number;
}) {
  metaRev.value;
  const u = chat ? chatUnread(chat.routes) : unreadOf(c);
  const lvl = effectiveLevel(c);
  const place = showPlace ? placeLine(c) : '';
  const isChannel = c.shape === 'channel' || c.shape === 'thread';
  const com = communitiesOf(c)[0];
  const ctx = useMenu(() => (chat ? chatMenu(chat.person, chat.routes, why) : conversationMenu(c, why)));
  return (
    <button
      class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''} ${u.muted ? 'muted' : ''}`}
      onClick={onClick}
      title={why?.length ? why.join('\n') : undefined}
      data-row={chat ? chatKey(chat.person.id) : c.id}
      data-track={rowTrack(convKind(c.shape), !!u.unread, !!owedSince)}
      {...loudEdge(u.unread ? loud : undefined)}
      {...ctx}
    >
      {isChannel && com ? (
        <span class="row-avatar">
          <Avatar id={com.id} name={com.name} url={com.icon} size={36} square network={c.network} accountIds={c.vantages.map((v) => v.accountId)} />
        </span>
      ) : (
        <span class="row-avatar">
          <Avatar
            id={c.peerPersonId ?? c.id}
            name={convTitle(c)}
            url={c.shape === 'direct' && c.peerPersonId ? (db.persons.get(c.peerPersonId)?.avatar ?? c.avatar) : c.avatar}
            size={36}
            square={c.shape !== 'direct'}
            network={c.network}
            accountIds={c.vantages.map((v) => v.accountId)}
            icon={c.shape === 'self' ? '✎' : undefined}
            presence={chat ? { person: chat.person.id } : convPresence(c)}
          />
          {(c.shape === 'direct' || c.shape === 'group') && <RowTyping convIds={chat ? chat.routes.map((r) => r.id) : [c.id]} />}
        </span>
      )}
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {isChannel && <Icon name={variantIcon(c.variant, c.shape)} size={13} class="row-kind" />}
            {isChannel ? convTitle(c) : convLabel(c)}
          </span>
          <CallMark convIds={chat ? chat.routes.map((r) => r.id) : [c.id]} />
          {c.encrypted && <Icon name="lock" size={11} class="row-lock" />}
          <span class="row-time">
            <Ago ts={c.lastMessageAt} />
          </span>
        </span>
        {place && <span class="row-place">{place}</span>}
        <span class="row-bottom">
          <span class="row-preview">{preview(c)}</span>
          {u.muted && <Icon name={ruleIcon(lvl.level)} size={12} class="row-muted" />}
          {u.badge ? <Count n={u.badge} /> : u.unread && !u.muted ? <span class="unread-dot" /> : null}
          {owedSince ? <Owed at={owedSince} p={needsP} /> : null}
        </span>
      </span>
    </button>
  );
});

// ------------------------------------------------------------------ a channel's threads as one row

/**
 * Whether a channel's inbox row is open on its threads, on this device. Closed until opened: kept as `false` in
 * `collapsed` under `inbox:<channel>`. One computed per row, so opening one draws that row alone.
 */
const foldOpen = new Map<string, ReadonlySignal<boolean>>();
function isFoldOpen(channelId: string): boolean {
  const key = `inbox:${channelId}`;
  let s = foldOpen.get(key);
  if (!s) foldOpen.set(key, (s = computed(() => pref('collapsed')[key] === false)));
  return s.value;
}
function toggleFold(channelId: string) {
  const key = `inbox:${channelId}`;
  const next = { ...pref('collapsed') };
  if (next[key] === false) delete next[key];
  else next[key] = false;
  setPrefs({ collapsed: next });
}

/**
 * Where a channel's inbox row opens: the channel, as its page opens from the sidebar (a Zulip channel or a Discord
 * forum on its cards, a Discord text channel or a Matrix room on its messages). The one place a channel row's click
 * goes, for the stream to take it over.
 */
function openChannelRow(channelId: string) {
  go({ view: 'inbox', conv: channelId });
}

/** A thread under an open channel row: its name, its own unread count (red where it mentions you), and it opens the thread. */
const ThreadSubRow = memo(function ThreadSubRow({ t, rowKey, active }: { t: P.ConversationView; rowKey: string; active: boolean }) {
  // A rule or a mute changes no conversation: it draws again on the settings' version.
  metaRev.value;
  const u = unreadOf(t);
  const ctx = useMenu(() => conversationMenu(t));
  return (
    <button
      class={`inbox-subrow ${active ? 'active' : ''} ${u.muted ? 'muted' : ''}`}
      data-in-row={rowKey}
      data-track="row (thread in a channel row)"
      onClick={opener(`inbox-thread:${t.id}`, () => go({ view: 'inbox', conv: t.id }))}
      {...ctx}
    >
      <Icon name={variantIcon(t.variant, t.shape)} size={12} class="row-kind" />
      <span class="inbox-subrow-name">{convTitle(t)}</span>
      <span class="row-time">
        <Ago ts={t.lastMessageAt} />
      </span>
      <Count n={u.unread} muted={!u.badge} />
    </button>
  );
});

/**
 * A channel's count on its inbox row: its unread threads' summed (a muted one's only where it mentions you, as
 * `sumUnread` counts), the listed ones and the rest alike, with the place's own messages (likewise). A forum takes none
 * of its own (Zulip) or may already count its posts' (Discord): the larger, never both added, as the sidebar's channel
 * row. `loud`: a group's own unread, red as any group's.
 */
function channelCount(c: P.ConversationView, threads: P.ConversationView[]) {
  const own = sumUnread([c]);
  const sum = sumUnread(threads);
  const forum = c.variant === 'forum' || c.variant === 'media';
  const add = (a: number, b: number) => (forum ? Math.max(a, b) : a + b);
  return { unread: add(own.unread, sum.unread), mentions: add(own.mentions, sum.mentions), loud: own.badge > 0 && (c.shape === 'group' || c.shape === 'direct') };
}

/**
 * A channel's threads as one inbox row (docs/inbox.md "One row per channel", channelrows.ts): the channel's name and
 * place, the latest listed thread's name and its last message, the unread summed over every thread of it, and a red
 * @ count where you are mentioned. Muted only when every listed part is. A Matrix room drawn so keeps a group's lock,
 * typing and dot. Its menu is the channel's, whose Mark As Read reads every thread. `unread`: the channel's threads
 * with something unread, listed or not.
 */
const ChannelInboxRow = memo(function ChannelInboxRow({ c, rowKey, parts, unread, latest, active, why, owedSince, needsP, loud }: { c: P.ConversationView; rowKey: string; parts: P.ConversationView[]; unread: P.ConversationView[]; latest: P.ConversationView; active: boolean; why?: string[]; owedSince?: number | null; needsP?: number | null; loud?: number }) {
  metaRev.value;
  const n = channelCount(c, unread);
  const muted = parts.every((p) => unreadOf(p).muted);
  // The level the muted mark says: the latest listed part's, which is muted when the row is.
  const lvl = effectiveLevel(latest);
  const place = placeLine(c);
  const com = communitiesOf(c)[0];
  const ctx = useMenu(() => conversationMenu(c, why, true));
  const channel = c.shape === 'channel';
  const title = channel ? convTitle(c) : convLabel(c);
  return (
    <button
      class={`row conv-row channel-row ${active ? 'active' : ''} ${n.unread ? 'unread' : ''} ${muted ? 'muted' : ''}`}
      onClick={opener(`inbox:${rowKey}`, () => openChannelRow(c.id))}
      title={why?.length ? why.join('\n') : undefined}
      {...loudEdge(n.unread ? loud : undefined)}
      data-row={rowKey}
      data-track={rowTrack(convKind(c.shape), !!n.unread, !!owedSince)}
      {...ctx}
    >
      <span class="row-avatar">
        {channel && com ? (
          <Avatar id={com.id} name={com.name} url={com.icon} size={36} square network={c.network} accountIds={c.vantages.map((v) => v.accountId)} />
        ) : (
          <Avatar id={c.id} name={title} url={c.avatar} size={36} square network={c.network} accountIds={c.vantages.map((v) => v.accountId)} presence={convPresence(c)} />
        )}
        {c.shape === 'group' && <RowTyping convIds={parts.map((p) => p.id)} />}
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {channel && <Icon name={variantIcon(c.variant, c.shape)} size={13} class="row-kind" />}
            {title}
          </span>
          <CallMark convIds={parts.map((p) => p.id)} />
          {c.encrypted && <Icon name="lock" size={11} class="row-lock" />}
          <span class="row-time">
            <Ago ts={latest.lastMessageAt} />
          </span>
        </span>
        {place && <span class="row-place">{place}</span>}
        <span class="row-bottom">
          <span class="row-preview">
            {latest !== c && <span class="row-subject">{convTitle(latest)}</span>}
            {latest !== c ? ` — ${preview(latest)}` : preview(c)}
          </span>
          {muted && <Icon name={ruleIcon(lvl.level)} size={12} class="row-muted" />}
          {n.mentions ? (
            <span class="count row-at" title="Mentions you">
              @{n.mentions > 99 ? '99+' : n.mentions}
            </span>
          ) : null}
          <Count n={n.unread} muted={!n.loud} />
          {owedSince ? <Owed at={owedSince} p={needsP} /> : null}
        </span>
      </span>
    </button>
  );
});

/**
 * The chevron beside a channel row, and the threads it opens on: the unread ones, mentions of you first, then the
 * latest, and the one open now. Its name stays; `aria-expanded` says whether it is open.
 */
function channelFold(c: P.ConversationView, rowKey: string, threads: P.ConversationView[], activeConv: string | undefined) {
  const shown = subThreads(
    threads.map((t) => ({ ...unreadOf(t), id: t.id, t, last: t.lastMessageAt ?? 0 })),
    activeConv,
  ).map((x) => x.t);
  if (!shown.length) return {};
  const open = isFoldOpen(c.id);
  const many = threadWords(shown[0]).many;
  const list = `inbox-fold-${c.id}`;
  const fold = (
    <button type="button" class="row-fold" aria-expanded={open} aria-controls={list} aria-label={`Unread ${many}`} title={open ? `Hide unread ${many}` : `Show ${shown.length} unread ${many}`} data-track="channel row fold" onClick={() => toggleFold(c.id)}>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
  );
  const below = (
    <div class="inbox-subrows" id={list} role="group" aria-label={`Unread ${many} in ${convTitle(c)}`} hidden={!open}>
      {open && shown.map((t) => <ThreadSubRow key={t.id} t={t} rowKey={rowKey} active={t.id === activeConv} />)}
    </div>
  );
  return { fold, below };
}

type RowChat = { person: P.PersonView; routes: P.ConversationView[] };
type InboxRowProps = {
  rowKey: string;
  ids: string[];
  conv?: P.ConversationView;
  chat?: RowChat;
  /**
   * A channel's row: its listed conversations, the channel's threads with something unread (listed or not), the
   * thread it previews, and the open conversation when it is the channel or a thread of it.
   */
  channel?: { parts: P.ConversationView[]; unread: P.ConversationView[]; latest: P.ConversationView; open?: string };
  active: boolean;
  why?: string[];
  owedSince: number | null;
  needsP: number | null;
  latest?: string;
  loud?: number;
};
/** The same chat: the inbox makes its rows again for each change, so a chat is the same person by the same routes. */
const sameChat = (a?: RowChat, b?: RowChat) => a === b || (!!a && !!b && a.person === b.person && sameProps({ r: a.routes }, { r: b.routes }));

/**
 * One inbox row with its ↩ (ReplyMark.tsx): a mail thread when there is no `conv`. Drawn again only when what it shows
 * changes (memo.ts), so a message or a visit elsewhere draws the list again but not every row.
 */
const InboxRowView = memo(
  function InboxRowView({ rowKey, ids, conv, chat, channel, active, why, owedSince, needsP, latest, loud }: InboxRowProps) {
    if (conv && channel) {
      // Whether a thread is muted is a setting: drawn again on the settings' version (`sameChannel` sees no change).
      metaRev.value;
      const { fold, below } = channelFold(conv, rowKey, channel.unread, channel.open);
      return (
        <MarkableRow rowKey={rowKey} kind="conversation" ids={ids} owedSince={owedSince} needsP={needsP} canNeed={!!latest} latest={latest} fold={fold} below={below}>
          <ChannelInboxRow c={conv} rowKey={rowKey} parts={channel.parts} unread={channel.unread} latest={channel.latest} active={active} why={why} owedSince={owedSince} needsP={needsP} loud={loud} />
        </MarkableRow>
      );
    }
    if (!conv)
      return (
        <MarkableRow rowKey={rowKey} kind="mail" ids={ids} owedSince={owedSince} needsP={needsP} canNeed={false}>
          <MailRow id={rowKey} active={active} why={why} owedSince={owedSince} needsP={needsP} />
        </MarkableRow>
      );
    return (
      <MarkableRow rowKey={rowKey} kind="conversation" ids={ids} owedSince={owedSince} needsP={needsP} canNeed={!!latest} latest={latest}>
        {chat ? (
          <ConvRow c={conv} chat={chat} active={active} onClick={opener(`inbox:${rowKey}`, () => go({ view: 'inbox', conv: chatOpens(chat.person.id) ?? conv.id }))} why={why} owedSince={owedSince} needsP={needsP} loud={loud} />
        ) : (
          <ConvRow c={conv} active={active} onClick={opener(`inbox:${conv.id}`, () => go({ view: 'inbox', conv: conv.id }))} why={why} owedSince={owedSince} needsP={needsP} loud={loud} />
        )}
      </MarkableRow>
    );
  },
  (a, b) => sameProps({ ...a, chat: undefined, channel: undefined }, { ...b, chat: undefined, channel: undefined }) && sameChat(a.chat, b.chat) && sameChannel(a.channel, b.channel),
);
/** The same channel row: the same conversations, preview and open thread. */
const sameChannel = (a?: InboxRowProps['channel'], b?: InboxRowProps['channel']) => a === b || (!!a && !!b && a.latest === b.latest && a.open === b.open && sameProps({ p: a.parts, u: a.unread }, { p: b.parts, u: b.unread }));

/** A chat's unread, as one row: summed over its routes, muted only if every route is. */
function chatUnread(routes: P.ConversationView[]) {
  const us = routes.map(unreadOf);
  return { unread: us.reduce((n, u) => n + u.unread, 0), badge: us.reduce((n, u) => n + u.badge, 0), muted: us.every((u) => u.muted) };
}

/**
 * Where a chat's row opens: the route picked on its page this session, else the conversation of the latest message,
 * so a reply goes where they last wrote. Asked at the click, not when the row was drawn.
 */
function chatOpens(personId: string): string | undefined {
  const directs = directsOf(personId);
  const held = heldByRequest();
  return pickedRoute(personId, directs) ?? (directs.find((d) => !held.has(d.id)) ?? directs[0])?.id;
}

/** A thread's menu in the inbox: why it is here, where it lives in Mail, and whether it is from a person. */
function mailRowMenu(t: P.MailThreadView, why?: string[]): MenuSpec {
  const title = threadName(t);
  return {
    label: `${title} actions`,
    head: <div class="cm-sheet-title">{title}</div>,
    items: groups(why?.length ? [{ kind: 'row', render: () => <WhyHere reasons={why} /> }] : [], [{ label: 'Open the thread', icon: 'mail', run: () => go({ view: 'inbox', conv: t.id }) }], personItems([t])),
  };
}

/**
 * A thread of mail in the one-list inbox (docs/mail.md, slice 8), with the same ↩ and reasons as a chat. From one
 * person: their picture with the envelope where a chat's network badge goes, the subject before the start of the last
 * message. With more people, a chat of its own (docs/mail.md "Mail as chats"): the envelope tile, its name (the subject)
 * and "Jo: …", as its header has them.
 */
const MailRow = memo(function MailRow({ id, active, why, owedSince, needsP }: { id: string; active: boolean; why?: string[]; owedSince?: number | null; needsP?: number | null }) {
  mailRev.value;
  metaRev.value;
  const t = db.mail.threads.get(id);
  const ctx = useMenu(() => (t ? mailRowMenu(t, why) : null));
  if (!t) return null;
  const other = [...t.from].reverse().find((f) => !f.self) ?? t.from[t.from.length - 1];
  const person = other?.personId ? db.persons.get(other.personId) : undefined;
  const group = isGroupThread(t);
  const title = group ? threadName(t) : (person?.name ?? other?.name ?? other?.email ?? '?');
  return (
    <button
      class={`row conv-row inbox-mail-row ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}
      onClick={opener(`inbox:${id}`, () => go({ view: 'inbox', conv: id }))}
      title={why?.length ? why.join('\n') : undefined}
      data-row={id}
      data-track={rowTrack('mail', !!t.unread, !!owedSince)}
      {...ctx}
    >
      <span class="row-avatar">{group ? <MailTile /> : <Avatar id={person?.id ?? other?.email ?? id} name={person?.name ?? other?.name ?? other?.email ?? title} url={person?.avatar} size={36} network="email" />}</span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">{title}</span>
          <span class="row-time">
            <Ago ts={t.lastAt} />
          </span>
        </span>
        <span class="row-bottom">
          {group ? (
            <span class="row-preview">{threadSnippet(t)}</span>
          ) : (
            <span class="row-preview">
              <span class="row-subject">{bareSubject(t.subject) || '(no subject)'}</span>
              {t.preview ? ` — ${t.preview}` : ''}
            </span>
          )}
          <Count n={t.unread} />
          {owedSince ? <Owed at={owedSince} p={needsP} /> : null}
        </span>
      </span>
    </button>
  );
});

/**
 * The message "Reply needed" would go on, from a row with no ↩: its newest, when someone else wrote it. None where you
 * wrote last (nothing waits on you), in notes to self, or where the newest is a system line.
 */
function needsTarget(c: P.ConversationView): string | undefined {
  const m = c.lastMessage;
  return c.shape !== 'self' && m && m.kind !== 'system' && !isSelfIdentity(m.authorId) ? m.id : undefined;
}

/** A list's section, folded or open on this device. Its click counts as "section toggle (label)": labels are fixed words. */
function SectionHead({ id, label, count, actions }: { id: string; label: string; count?: number; actions?: any }) {
  const collapsed = !!pref('collapsed')[id];
  return (
    <div class="section-head" data-section={id}>
      <button class="section-toggle" aria-expanded={!collapsed} data-track={`section toggle (${label})`} onClick={() => setPrefs({ collapsed: { ...pref('collapsed'), [id]: !collapsed } })}>
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        <span>{label}</span>
        {count ? <span class="section-count">{count}</span> : null}
      </button>
      {actions}
    </div>
  );
}
const isCollapsed = (id: string) => !!pref('collapsed')[id];

// ------------------------------------------------------------------ inbox

const FILTER_MENU = 'Show in the inbox';

/**
 * Beside the search box: what the inbox shows, as a menu. With a filter on it says which, so a shorter list is never
 * a surprise. Mail is there with a mail account.
 */
function InboxFilterButton({ filter }: { filter: InboxFilter }) {
  const choices = INBOX_FILTERS.filter((f) => f.id !== 'mail' || db.mail.accounts.size > 0 || filter === 'mail');
  const on = INBOX_FILTERS.find((f) => f.id === filter)!;
  const open = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(
      { x: r.right, y: r.bottom + 4 },
      {
        label: FILTER_MENU,
        track: 'inbox',
        head: <div class="cm-sheet-title">Show</div>,
        items: choices.map(
          (f): MenuEntry => ({
            label: f.label,
            checked: f.id === filter,
            radio: true,
            track: `filter (${f.label})`,
            run: () => {
              setPrefs({ inboxFilter: f.id });
              // The mail lists are the Mail filter's: another filter is the whole inbox again.
              const r = route.value;
              if (f.id !== 'mail' && r.view === 'inbox' && r.mail) go({ view: 'inbox' }, true);
            },
          }),
        ),
      },
      e.currentTarget,
    );
  };
  const label = filter === 'all' ? 'Show: all conversations' : `Showing only ${on.label.toLowerCase()}`;
  return (
    <button
      class={`icon-btn small inbox-filter-btn ${filter !== 'all' ? 'on' : ''}`}
      aria-haspopup="menu"
      aria-expanded={contextMenu.value?.label === FILTER_MENU}
      aria-label={label}
      title={label}
      data-track="filter"
      onClick={open}
    >
      <Icon name="filter" size={16} />
      {filter !== 'all' && <span class="inbox-filter-name">{on.short}</span>}
    </button>
  );
}

const EMPTY: Record<InboxFilter, string> = { all: 'No conversations yet.', direct: 'No direct messages here.', groups: 'No groups here.', mail: 'No mail from people here.' };

/**
 * The search box over a mail list, where the Inbox's is (docs/inbox.md "Mail lists"): it searches that list's mail
 * (listSearch), and holds the words of a search in it. Emptied, the list is back.
 */
function MailListSearch({ list }: { list: string }) {
  mailRev.value;
  const search = searchOfList(list);
  const scoped = search !== null ? searchIn(search) : null;
  const home = scoped ? scoped.list : list;
  const words = scoped ? scoped.words : '';
  const [q, setQ] = useState(words);
  useEffect(() => setQ(words), [list]);
  const run = (t: string) => {
    if (t) go({ view: 'inbox', mail: home ? listSearch(home, t) : `s:${t}` }, true);
    else if (search !== null) go(home ? { view: 'inbox', mail: home } : { view: 'inbox' }, true);
  };
  const name = home ? listName(db.mail, home) : 'mail';
  return (
    <form
      class="search search-box"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        run(q.trim());
      }}
    >
      <Icon name="search" size={15} />
      <input data-track="mail list: search" aria-label={`Search ${name}`} placeholder={`Search ${name}`} enterkeyhint="search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {q && (
        <button type="button" class="icon-btn small" aria-label="Clear" title="Clear" onClick={() => (setQ(''), run(''))}>
          <Icon name="x" size={14} />
        </button>
      )}
    </form>
  );
}

/**
 * One list: DMs, group chats, rooms outside a space and notes to self, plus anything else while it has something
 * for you, and mail from people (docs/mail.md), ranked by how likely you are to want each now (docs/inbox.md). No
 * sections: a reply you owe shows on its row (↩ and how long), and unread rows are bold with their count.
 *
 * `mail`: a mail list open in the Inbox's place (Updates, Everything, Starred, Sent, a mailbox, a search in one). The
 * Inbox's header stays as it is, title, search box and Mail filter, with the list under the same chips (docs/inbox.md
 * "Mail lists").
 */
export function InboxSidebar({ activeConv, mail }: { activeConv?: string; mail?: string }) {
  if (counting) rendered('InboxSidebar');
  rev.value;
  // A mail thread the hub listed whose view has not come yet: the mail event that brings it draws the list again.
  if (mailRowsWaiting()) mailRev.value;
  const snap = inboxSnap.value;
  const accounts = accountsNeedingYou();
  let filter = pref('inboxFilter');
  if (filter === 'mail' && !db.mail.accounts.size) filter = 'all';
  // A mail list is the Mail filter's, however it was opened (Ctrl+K, a link).
  if (mail) filter = 'mail';
  const [q, setQ] = useState('');
  // Words in the box narrow the list in place, by name, at every key (docs/search.md "In the inbox").
  const finding = !mail && !!q.trim();
  // from:, in:, has: and the rest ask for messages, not a name: the list gives the room to them.
  const asking = finding && hasOperators(q);
  const listed = mail || asking ? [] : shownInbox(filter);
  const rows = finding ? filterRows(listed, q) : listed;
  // With a filter on, the rows it leaves out that hold the words are a tap away.
  const outside = finding && !asking && filter !== 'all' ? filterRows(shownInbox('all'), q).length - rows.length : 0;
  const [drawn, more] = useShown(rows.length);
  const full = () => {
    rememberSearch(q.trim());
    go({ view: 'search', q: q.trim() });
  };
  const scroll = useRef<HTMLDivElement>(null);
  // A row and its ↩ button move as one (ReplyMark.tsx), and a channel row with the threads under it; anything else keyed by its own data-row.
  useFlip(scroll, snap.v, '[data-row-key], [data-row]:not([data-row-key] [data-row])');
  // A person's chat is one row, active whichever of their DMs is open.
  const activeKey = activeConv ? inboxKeyOf(activeConv) : undefined;
  const louds = loudByConv.value;
  const row = (r: InboxRow) => {
    const owedSince = r.needs ? r.owedSince : null;
    // A channel row's ↩ goes on the parts that rank it: a muted thread does not lift it, nor take its marks.
    const convs = r.kind === 'mail' ? [] : rowConvs(r);
    const loud = r.kind === 'conv' && r.channel ? convs.filter((c) => !unreadOf(c).muted) : convs;
    const ids = r.kind === 'mail' ? [r.key] : (loud.length ? loud : convs).map((c) => c.id);
    const needsP = owedSince !== null ? needsReplyOf(ids) : null;
    if (r.kind === 'mail') return <InboxRowView key={r.key} rowKey={r.key} ids={ids} active={r.key === activeConv} why={r.reasons} owedSince={owedSince} needsP={needsP} />;
    if (r.channel) {
      const ch = r.channel;
      const open = activeConv && db.conversations.get(activeConv);
      const here = open && (open === r.conv || open.parentId === r.conv.id) ? open : undefined;
      // The open thread stays under the row once read, so it does not go from under you.
      const unread = unreadThreadsOf(r.conv.id);
      const threads = here && here !== r.conv && !unread.includes(here) ? [...unread, here] : unread;
      const channel = { parts: ch.parts, unread: threads, latest: ch.latest, open: here?.id };
      return <InboxRowView key={r.key} rowKey={r.key} ids={ids} conv={r.conv} channel={channel} active={r.key === activeKey} why={r.reasons} owedSince={owedSince} needsP={needsP} latest={needsTarget(ch.latest)} loud={loudOf(louds, ids)} />;
    }
    return <InboxRowView key={r.key} rowKey={r.key} ids={ids} conv={r.conv} chat={r.chat} active={r.chat ? r.key === activeKey : r.conv.id === activeConv} why={r.reasons} owedSince={owedSince} needsP={needsP} latest={needsTarget(r.conv)} loud={loudOf(louds, ids)} />;
  };
  return (
    <div class={`sidebar-inner inbox-side ${offline.value ? 'offline' : ''}`} data-track-area="inbox">
      {/* What the app is doing with the hub goes in the room the title leaves (InboxStatus.tsx). */}
      <header class="side-head inbox-head">
        <h1>Inbox</h1>
        <InboxStatus />
        <NewMessageButton />
      </header>
      <div class="inbox-search">
        {mail ? <MailListSearch list={mail} /> : <SearchBox
          value={q}
          setValue={setQ}
          onClear={() => setQ('')}
          // The cursor stays here, on a phone too: the list narrows under it. What it finds beyond its rows is search's
          // chunk (InboxFound), loaded from the focus so it is there by the first key.
          onFocusBox={preloadSearch}
          onDown={() => scroll.current?.querySelector<HTMLElement>(WALK)?.focus()}
          placeholder="Search chats and messages"
          hint={phone.value || filter !== 'all' ? undefined : 'Ctrl K'}
          // Enter: the full results, on the search page.
          submit={(t) => t && full()}
        />}
        <InboxFilterButton filter={filter} />
      </div>
      {/* Mail is chats (docs/mail.md "Mail as chats"): with the Mail filter on, its other lists are a tap away. */}
      {filter === 'mail' && <MailListChips on={mail ?? null} />}
      {mail ? <MailSidebarLazy list={mail} active={activeConv} /> : <div class="side-scroll" ref={scroll} onKeyDown={finding ? (e) => walkFound(e, scroll.current) : undefined}>
        {!finding && accounts.length > 0 && (
          <>
            <SectionHead id="inbox-att" label="Needs you" count={accounts.length} />
            {!isCollapsed('inbox-att') &&
              accounts.map((a) => (
                <button class="row attention-row" data-track="row (account needs you)" onClick={() => go({ view: 'accounts', account: a.id })} onContextMenu={onMenu(() => accountMenu(a))}>
                  <span class="row-avatar">
                    <span class="attention-icon">
                      <Icon name={a.attention?.kind === 'link_device' ? 'qr' : a.attention?.liveView ? 'monitor' : 'alert'} size={18} />
                    </span>
                  </span>
                  <span class="row-main">
                    <span class="row-top">
                      <span class="row-title">
                        {netName(a.network)} · {a.label}
                      </span>
                    </span>
                    <span class="row-bottom">
                      <span class="row-preview">{a.attention?.message}</span>
                    </span>
                  </span>
                </button>
              ))}
          </>
        )}
        {/* Chat requests, notices and the questions about notifications are not mail: the Mail filter leaves them out. */}
        {!finding && filter !== 'mail' && <RequestsRow />}
        {!finding && filter !== 'mail' && <NoticesRow />}
        {!finding && filter !== 'mail' && <CalibrationRow />}
        {rows.slice(0, drawn).map(row)}
        {more}
        {!rows.length && !finding && <p class="inbox-empty">{EMPTY[filter]}</p>}
        {finding && !asking && !rows.length && <p class="inbox-empty inbox-found-none">No chat in the inbox is named “{q.trim()}”.</p>}
        {outside > 0 && (
          <button class="link-btn inbox-found-outside" data-track="inbox search: more without the filter" onClick={() => setPrefs({ inboxFilter: 'all' })}>
            {outside} more with no filter
          </button>
        )}
        {finding && <InboxFoundLazy q={q} skip={rowStandsFor(rows)} onFull={full} />}
      </div>}
    </div>
  );
}

/** What Up and Down walk while the inbox is narrowed: its rows, then what was found beyond them. */
const WALK = 'button.row, .search-jump-row, .inbox-found-full, .inbox-hit, .inbox-found-more';

/** Up and Down through the narrowed inbox; Up from the first goes back to the box. */
function walkFound(e: KeyboardEvent, list: HTMLElement | null) {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !list) return;
  const all = [...list.querySelectorAll<HTMLElement>(WALK)];
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) next.focus();
  else if (e.key === 'ArrowUp') list.closest('.inbox-side')?.querySelector<HTMLInputElement>('.inbox-search input')?.focus();
}

// ------------------------------------------------------------------ people

/** `directs`: the person's direct conversations (directsOf), which change with each message where the person does not. */
const PersonRow = memo(function PersonRow({ person, directs, active, onClick }: { person: P.PersonView; directs: P.ConversationView[]; active: boolean; onClick: () => void }) {
  metaRev.value;
  const last = directs.reduce<P.ConversationView | null>((a, c) => (!a || (c.lastMessageAt ?? 0) > (a.lastMessageAt ?? 0) ? c : a), null);
  const u = sumUnread(directs);
  const nets = [...new Set(directs.map((d) => d.network))];
  const ctx = useMenu(() => personMenu(person));
  return (
    <button class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''}`} data-person={person.id} data-track={rowTrack('person', !!u.unread)} onClick={onClick} {...ctx}>
      <span class="row-avatar">
        <Avatar id={person.id} name={person.name} url={person.avatar} size={36} presence={{ person: person.id }} />
        <RowTyping convIds={directs.map((d) => d.id)} />
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {person.name}
          </span>
          <CallMark convIds={directs.map((d) => d.id)} />
          <span class="row-nets">
            {directs.map((d) => (
              <span class="row-net" title={`${netName(d.network)}${d.vantages.length ? ' · ' + d.vantages.map((v) => db.accounts.get(v.accountId)?.label).join(', ') : ''}`}>
                <NetBadge network={d.network} size={14} />
                <AccountDots network={d.network} accountIds={d.vantages.map((v) => v.accountId)} size={6} />
              </span>
            ))}
          </span>
          <span class="row-time">
            <Ago ts={last?.lastMessageAt} />
          </span>
        </span>
        <span class="row-bottom">
          <span class="row-preview">
            {last && nets.length > 1 && <NetGlyph network={last.network} size={10} />}
            {last ? preview(last) : ''}
          </span>
          <Count n={u.badge} />
        </span>
      </span>
    </button>
  );
});

const LINK_SORTS: { id: 'recent' | 'az'; label: string }[] = [
  { id: 'recent', label: 'Last talked' },
  { id: 'az', label: 'A to Z' },
];

/** The order of a list of friends, contacts or follows: the same button as the Chats order, two choices, kept per device. */
function LinkSortButton() {
  const mode = pref('peopleLinkSort') ?? 'recent';
  const on = LINK_SORTS.find((m) => m.id === mode)!;
  const label = `Order: ${on.label}. Click to change`;
  return (
    <button
      class={`icon-btn small sort-btn side-sort ${mode !== 'recent' ? 'on' : ''}`}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      data-track="order"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(
          { x: r.left, y: r.bottom + 4 },
          {
            label: 'Order',
            track: 'people',
            head: <div class="cm-sheet-title">Order</div>,
            items: [
              { kind: 'label', label: 'Order by' },
              ...LINK_SORTS.map((m): MenuEntry => ({ label: m.label, radio: true, checked: m.id === mode, track: `order (${m.label})`, run: () => setPrefs({ peopleLinkSort: m.id }) })),
            ],
          },
          e.currentTarget,
        );
      }}
    >
      <SortIcon size={15} />
    </button>
  );
}

/** Narrows the list by name, here on the page. Esc empties it. */
function FindBox({ value, set, placeholder }: { value: string; set: (v: string) => void; placeholder: string }) {
  return (
    <label class="search people-find">
      <Icon name="search" size={15} />
      <input
        type="search"
        data-track="filter box"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        enterkeyhint="search"
        onInput={(e) => set((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Escape' && value && (e.preventDefault(), e.stopPropagation(), set(''))}
      />
    </label>
  );
}

const FIND: Record<PeopleFilter, string> = { chats: 'Filter people', friend: 'Filter friends', contact: 'Filter contacts', following: 'Filter follows' };

export function PeopleSidebar({ activePerson }: { activePerson?: string }) {
  rev.value;
  // Friends, contacts and follows, where an account keeps such a list (docs/add.md "Relationships").
  const chips = peopleFilters(db.accounts.values());
  const filter = chips.find((f) => f.id === pref('peopleFilter'))?.id ?? 'chats';
  const relationship = filter === 'chats' ? null : filter;
  const links = usePeopleLinks(relationship);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const accounts = relationship && links.view ? linkAccounts(links.view) : [];
  const scoped = accountId && accounts.some((a) => a.id === accountId) ? accountId : null;
  const list = filter === 'chats' ? arrangedPeople(people()).filter((x) => !q.trim() || nameMatches(x.person.name, q)) : [];
  const [drawn, more] = useShown(list.length);
  return (
    <div class="sidebar-inner" data-track-area="people">
      <header class="side-head">
        <h1>People<NewMessageButton /><GraphButton /><SameButton />{relationship ? <LinkSortButton /> : <SortButton scope="people" class="side-sort" />}</h1>
        {accounts.length > 1 && <PeopleAccountPicker accounts={accounts} current={scoped} pick={setAccountId} />}
      </header>
      {chips.length > 0 && (
        <div class="inbox-chips people-chips" role="radiogroup" aria-label="Show">
          {chips.map((f) => (
            <button class={`chip-btn ${filter === f.id ? 'on' : ''}`} role="radio" aria-checked={filter === f.id} data-filter={f.id} data-track={`chip (${f.id})`} onClick={() => setPrefs({ peopleFilter: f.id })}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      <FindBox value={q} set={setQ} placeholder={FIND[filter]} />
      <div class="side-scroll">
        {relationship && <PeopleLinks relationship={relationship} links={links} accountId={scoped} dots={accounts.length > 1 && !scoped} q={q} sort={pref('peopleLinkSort') ?? 'recent'} active={activePerson} />}
        {filter === 'chats' && <SectionHead id="people-all" label="Direct messages" count={list.length} />}
        {!isCollapsed('people-all') && list.slice(0, drawn).map(({ person, directs }) => <PersonRow key={person.id} person={person} directs={directs} active={person.id === activePerson} onClick={opener(`people:${person.id}`, () => go({ view: 'people', person: person.id }))} />)}
        {!isCollapsed('people-all') && more}
        {filter === 'chats' && q.trim() && !list.length && <p class="inbox-empty">Nobody here matches “{q.trim()}”.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ space tree

/** One opener per list a channel tree is in, the same each time, so a channel row that did not change is not drawn again. */
const treeOpeners = new Map<string, (c: P.ConversationView) => void>();
function treeOpener(key: string, open: (c: P.ConversationView) => void) {
  let f = treeOpeners.get(key);
  if (!f) treeOpeners.set(key, (f = open));
  return f;
}

/** A thread under its channel: drawn again only when it changes or is opened or left, not when another is. */
const ThreadRow = memo(function ThreadRow({ t, active, depth, onOpen }: { t: P.ConversationView; active: boolean; depth: number; onOpen: (c: P.ConversationView) => void }) {
  metaRev.value;
  const tu = unreadOf(t);
  const ctx = useMenu(() => conversationMenu(t));
  return (
    <button class={`chan thread ${active ? 'active' : ''} ${tu.unread && !tu.muted ? 'unread' : ''}`} style={{ paddingLeft: `${26 + depth * 12}px` }} onClick={() => onOpen(t)} title={kindLabel(t)} {...ctx}>
      <span class="thread-elbow" />
      <span class="chan-name">{convTitle(t)}</span>
      {resolvedTopic(t) && (
        <span class="chan-resolved" title="Resolved">
          <Icon name="check" size={11} />
        </span>
      )}
      {tu.badge > 0 && <Count n={tu.badge} />}
    </button>
  );
});

/**
 * "N more": the channel opens on its thread cards for this visit (stream.ts showCardsOnce), though it opens on its
 * stream otherwise (a Zulip channel, a Matrix room); a channel with no cards (a Discord text channel) opens its thread
 * browser too.
 */
function moreThreads(c: P.ConversationView, onOpen: (c: P.ConversationView) => void) {
  onOpen(c);
  if (!showCardsOnce(c)) threadDialog.value = { kind: 'browse', convId: c.id, tab: 'active' };
}

/** The pref('collapsed') key of a channel whose threads are folded away, on this device. */
const foldKey = (id: string) => `chan:${id}`;

/** A channel's own line: its name, count and fold. Not drawn again when one of its threads is opened or left. */
const ChannelHead = memo(function ChannelHead({ c, folded, active, depth, onOpen, alsoIn, dots, unread, badge }: { c: P.ConversationView; folded?: boolean; active: boolean; depth: number; onOpen: (c: P.ConversationView) => void; alsoIn?: string[]; dots: boolean; unread: number; badge: number }) {
  metaRev.value;
  const muted = unreadOf(c).muted;
  const lvl = effectiveLevel(c);
  const ctx = useMenu(() => conversationMenu(c));
  const threads = folded === undefined ? null : threadWords(c);
  return (
    <div class="chan-line">
      <button
        class={`chan ${active ? 'active' : ''} ${unread && !muted ? 'unread' : ''} ${muted ? 'muted' : ''}`}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        onClick={() => onOpen(c)}
        title={kindLabel(c)}
        {...ctx}
      >
        <Icon name={variantIcon(c.variant)} size={16} class="chan-icon" />
        <span class="chan-name">{convTitle(c)}</span>
        <CallMark convIds={[c.id]} />
        {alsoIn && alsoIn.length > 0 && (
          <span class="chan-also" title={`Also in ${alsoIn.join(', ')}`}>
            <Icon name="link" size={11} />
          </span>
        )}
        {muted && <Icon name={ruleIcon(lvl.level)} size={12} class="chan-muted" />}
        {dots && <AccountDots network={c.network} accountIds={c.vantages.map((v) => v.accountId)} size={6} />}
        {badge > 0 && <Count n={badge} />}
      </button>
      {threads && (
        <button
          class="chan-fold"
          aria-expanded={!folded}
          title={folded ? `Show ${threads.many}` : `Hide ${threads.many}`}
          aria-label={folded ? `Show ${threads.many}` : `Hide ${threads.many}`}
          data-track={`channel fold (${threads.many})`}
          onClick={() => setPrefs({ collapsed: { ...pref('collapsed'), [foldKey(c.id)]: !folded } })}
        >
          <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} />
        </button>
      )}
    </div>
  );
});

/**
 * A channel and the threads under it (model.ts `shownThreads`, docs/servers.md "Threads under a channel"): a chevron
 * folds them away, and a last row says how many more its thread list has. Its badge is its threads' count with its own
 * (`channelUnread`), folded or not. Drawn again only when its props change (memo.ts): `active` is the open
 * conversation only when it is this one or a thread shown here, so opening another channel draws two rows, not the
 * list, and opening a thread draws that thread's row and the one left; a fold draws only its own channel.
 */
const ChannelRow = memo(function ChannelRow({ c, shownThreads, more = 0, folded, active, depth, onOpen, alsoIn, dots = true, unread = 0, badge = 0 }: { c: P.ConversationView; shownThreads: P.ConversationView[]; more?: number; folded?: boolean; active?: string; depth: number; onOpen: (c: P.ConversationView) => void; alsoIn?: string[]; dots?: boolean; unread?: number; badge?: number }) {
  const words = folded === undefined ? null : threadWords(c);
  return (
    <>
      <ChannelHead c={c} folded={folded} active={c.id === active} depth={depth} onOpen={onOpen} alsoIn={alsoIn} dots={dots} unread={unread} badge={badge} />
      {(c.variant === 'voice' || c.variant === 'stage') && <VoicePeople conversationId={c.id} class="chan-voice" style={{ paddingLeft: `${36 + depth * 12}px` }} />}
      {/* Folded, the open thread still shows: where you are. */}
      {(folded ? shownThreads.filter((t) => t.id === active) : shownThreads).map((t) => (
        <ThreadRow key={t.id} t={t} active={t.id === active} depth={depth} onOpen={onOpen} />
      ))}
      {/* The rest are in the channel's thread list: a forum's post cards (ui/Threads.tsx), which the channel opens on;
          else the channel, with its thread browser over it. */}
      {!folded && words && more > 0 && (
        <button class="chan thread chan-more" style={{ paddingLeft: `${26 + depth * 12}px` }} data-track={`more threads (${words.many})`} onClick={() => moreThreads(c, onOpen)}>
          <span class="thread-elbow" />
          <span class="chan-name">
            {more} more {more === 1 ? words.one : words.many}
          </span>
        </button>
      )}
    </>
  );
});

/**
 * A server's (or a section's) channels and their threads. It reads `rev` itself: its parent passes the same props each
 * time, and Preact does not draw a child again whose props are all the same, so a count read on another device would
 * otherwise stay as it was until something else moved.
 */
function SpaceTree({ spaceId, active, onOpen, depth = 0, seen = new Set<string>(), dots }: { spaceId: string; active?: string; onOpen: (c: P.ConversationView) => void; depth?: number; seen?: Set<string>; dots?: boolean }) {
  rev.value;
  if (seen.has(spaceId)) return null;
  const nextSeen = new Set(seen).add(spaceId);
  const kids = spaceChildren(spaceId);
  // Seen through one account, the header's "via" already says which; a dot on every channel would repeat it.
  dots ??= (db.spaces.get(spaceId)?.accountIds.length ?? 0) > 1;
  const folds = pref('collapsed');
  return (
    <>
      {kids.map((k) => {
        if (k.kind === 'conversation') {
          const c = db.conversations.get(k.id)!;
          const also = c.spaceIds.filter((s) => s !== spaceId).map((s) => communityOfSpace(s)?.name ?? db.spaces.get(s)?.name ?? '');
          const { shown, more } = shownThreads(c, active);
          const has = shown.length > 0 || more > 0;
          const here = active === c.id || shown.some((t) => t.id === active);
          // Its threads' counts with its own, as numbers so the row's memo still holds.
          const u = channelUnread(c);
          return <ChannelRow key={c.id} c={c} shownThreads={shown} more={more} folded={has ? !!folds[foldKey(c.id)] : undefined} active={here ? active : undefined} depth={depth} onOpen={onOpen} alsoIn={also.filter(Boolean)} dots={dots} unread={u.unread} badge={u.badge} />;
        }
        const s = db.spaces.get(k.id)!;
        if (k.kind === 'section' && !spaceChildren(s.id).length) return null; // a category whose channels this account can't see
        const key = `space:${s.id}`;
        const collapsed = !!folds[key];
        const u = spaceUnread(s.id);
        return (
          <div class={`tree-group ${k.kind}`}>
            <Menuable build={() => spaceMenu(s)}>
              {(ctx) => (
            <button class="tree-head" style={{ paddingLeft: `${6 + depth * 12}px` }} onClick={() => setPrefs({ collapsed: { ...pref('collapsed'), [key]: !collapsed } })} {...ctx}>
              <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={11} />
              {k.kind === 'subspace' && <NetGlyph network={s.network} size={11} />}
              <span>{k.kind === 'section' ? s.name.toUpperCase() : s.name}</span>
              {k.kind === 'subspace' && <span class="tree-tag">subspace</span>}
              {collapsed && <Count n={u.badge} />}
            </button>
              )}
            </Menuable>
            {!collapsed && <SpaceTree spaceId={s.id} active={active} onOpen={onOpen} depth={k.kind === 'subspace' ? depth + 1 : depth} seen={nextSeen} dots={dots} />}
          </div>
        );
      })}
    </>
  );
}

function SpaceHeader({ space }: { space: P.SpaceView }) {
  const accounts = space.accountIds.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  const noun = NETWORK_META[space.network].spaceNoun;
  const ctx = useMenu(() => spaceMenu(space));
  return (
    <header class="space-head" style={{ '--net': NETWORK_META[space.network].color } as any} {...ctx}>
      <div class="space-head-top">
        <Avatar id={space.id} name={space.name} url={space.icon} size={40} square />
        <div class="space-head-text">
          <h1 title={space.name}>{space.name}</h1>
          <span class="space-kind">
            <NetGlyph network={space.network} size={12} /> {netName(space.network)} {noun}
          </span>
        </div>
        <button class="icon-btn small space-about" title={`About this ${noun}`} aria-label={`About this ${noun}`} onClick={() => openAbout('space', space.id)}>
          <Icon name="info" size={15} />
        </button>
      </div>
      {space.topic && <p class="space-topic">{space.topic}</p>}
      {accounts.length > 0 && (
        <div class="space-accounts">
          <span class="muted-label">via</span>
          {accounts.map((a) => (
            <AccountChip account={a} small />
          ))}
        </div>
      )}
    </header>
  );
}

export function SpaceSidebar({ spaceId, activeConv }: { spaceId: string; activeConv?: string }) {
  rev.value;
  const space = db.spaces.get(spaceId);
  if (!space) return <div class="sidebar-inner" />;
  return (
    <div class="sidebar-inner">
      <SpaceHeader space={space} />
      <div class="side-scroll tree">
        <SpaceTree spaceId={spaceId} active={activeConv} onOpen={treeOpener(`space:${spaceId}`, (c) => go({ view: 'space', space: spaceId, conv: c.id }))} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ folders

export function FolderSidebar({ folderId, activeConv, activePerson }: { folderId: string; activeConv?: string; activePerson?: string }) {
  rev.value;
  const found = db.folders.find((x) => x.id === folderId);
  if (!found) return <div class="sidebar-inner" />;
  const f = found;
  const nets = new Set<string>();
  const outer = parentFolder(f.id);
  for (const it of folderLeaves(f)) {
    if (it.kind === 'space') nets.add(db.spaces.get(it.id)?.network ?? '');
    if (it.kind === 'conversation') nets.add(db.conversations.get(it.id)?.network ?? '');
    if (it.kind === 'person') directsOf(it.id).forEach((d) => nets.add(d.network));
  }
  nets.delete('');
  const open = treeOpener(`folder:${f.id}`, (c: P.ConversationView) => go({ view: 'folder', folder: f.id, conv: c.id }));
  return (
    <div class="sidebar-inner">
      <header class="side-head folder-head" style={{ '--folder': f.color ?? '#8b93a7' } as any} onContextMenu={onMenu(() => folderMenuSpec(f.id))}>
        <h1>
          <span class="folder-head-icon">{f.icon ?? <Icon name="folder" />}</span>
          {f.name}
        </h1>
        <span class="side-sub">
          {outer ? (
            <>
              In{' '}
              <button class="link-btn" onClick={() => go({ view: 'folder', folder: outer.id })}>
                {outer.name}
              </button>
              {' · '}
            </>
          ) : (
            'Folder '
          )}
          across {[...nets].map((n) => netName(n as P.Network)).join(', ')}
        </span>
      </header>
      <div class="side-scroll tree">
        {(() => {
          const all = arrangedFolderItems(f);
          const { shown, quiet } = shelve(all, (it) => `${it.kind}:${it.id}`);
          const list = `folder:${f.id}`;
          const on = openShelves.value.has(list);
          return [...shown, ...(on ? quiet : [])].map(row).concat(quiet.length ? [<ShelfRow list={list} n={quiet.length} open={on} />] : []);
        })()}
      </div>
    </div>
  );

  function row(it: P.FolderView['items'][number]) {
          if (it.kind === 'folder') {
            const c = db.folders.find((x) => x.id === it.id);
            if (!c) return null;
            const u = sumUnread(folderConvs(c));
            const n = folderLeaves(c).length;
            return (
              <button class="row conv-row place-row" onClick={() => go({ view: 'folder', folder: c.id })} onContextMenu={onMenu(() => folderMenuSpec(c.id))}>
                <span class="row-avatar">
                  {c.icon ? (
                    <span class="folder-row-icon" style={{ '--folder': c.color ?? '#8b93a7' } as any}>
                      {c.icon}
                    </span>
                  ) : (
                    <FolderIcon folder={c} small />
                  )}
                </span>
                <span class="row-main">
                  <span class="row-top">
                    <span class="row-title">{c.name}</span>
                  </span>
                  <span class="row-bottom">
                    <span class="row-preview">Folder · {n} {n === 1 ? 'place' : 'places'}</span>
                    <Count n={u.badge} />
                  </span>
                </span>
              </button>
            );
          }
          if (it.kind === 'space') {
            const s = db.spaces.get(it.id);
            if (!s) return null;
            const key = `folder:${f.id}:${s.id}`;
            const collapsed = isCollapsed(key);
            const u = spaceUnread(s.id);
            return (
              <div class="folder-space">
                <button class="folder-space-head" onClick={() => setPrefs({ collapsed: { ...pref('collapsed'), [key]: !collapsed } })} onContextMenu={onMenu(() => spaceMenu(s))}>
                  <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                  <Avatar id={s.id} name={s.name} url={s.icon} size={22} square network={s.network} />
                  <span class="folder-space-name">{s.name}</span>
                  <SourceChip network={s.network} accountIds={s.accountIds} />
                  {collapsed && <Count n={u.badge} />}
                </button>
                {!collapsed && <SpaceTree spaceId={s.id} active={activeConv} onOpen={open} depth={1} />}
              </div>
            );
          }
          if (it.kind === 'person') {
            const p = db.persons.get(it.id);
            return p ? <PersonRow person={p} directs={directsOf(p.id)} active={p.id === activePerson} onClick={() => go({ view: 'folder', folder: f.id, person: p.id })} /> : null;
          }
          const c = db.conversations.get(it.id);
          return c && visibleConv(c) ? <ConvRow c={c} active={c.id === activeConv} onClick={() => open(c)} /> : null;
  }
}

/** A list's quiet servers, closed: one row with their count (quiet.ts). */
function ShelfRow({ list, n, open }: { list: string; n: number; open: boolean }) {
  return (
    <button class="row shelf-row" aria-expanded={open} onClick={() => toggleShelf(list)} title="Never opened here and nothing new in 6 months">
      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
      <span>{open ? 'Put quiet servers away' : `${n} quiet ${n === 1 ? 'server' : 'servers'}`}</span>
    </button>
  );
}

// ------------------------------------------------------------------ all communities (mobile tab)

const spacesDrop = arrangeDrop(dropPlace);
function SpacesEntry({ entry: e, hidden }: { entry: RailEntry; hidden?: boolean }) {
  const label = placeLabel(e.key);
  const folderId = e.kind === 'folder' ? e.folder.id : undefined;
  const props = dragProps({
    key: e.key,
    label,
    group: 'spaces',
    accepts: !hidden,
    onDrop: hidden ? undefined : spacesDrop,
    onMenu: (x, y) => openPlaceMenu(e.key, label, x, y),
  });
  const pinned = placePref(e.kind, e.key.slice(e.key.indexOf(':') + 1)).pinned;
  const icon =
    e.kind === 'folder' ? (
      e.folder.icon ? (
        <span class="folder-row-icon" style={{ '--folder': e.folder.color ?? '#8b93a7' } as any}>
          {e.folder.icon}
        </span>
      ) : (
        <FolderIcon folder={e.folder} small />
      )
    ) : e.kind === 'space' ? (
      <Avatar id={e.space.id} name={e.space.name} url={e.space.icon} size={36} square network={e.space.network} accountIds={e.space.accountIds} />
    ) : (
      <Avatar id={e.conv.id} name={label} url={e.conv.avatar} size={36} square network={e.conv.network} presence={convPresence(e.conv)} />
    );
  const u = e.kind === 'folder' ? sumUnread(folderConvs(e.folder)) : e.kind === 'space' ? spaceUnread(e.space.id) : unreadOf(e.conv);
  const sub =
    e.kind === 'folder'
      ? `Folder · ${folderLeaves(e.folder).length} ${folderLeaves(e.folder).length === 1 ? 'place' : 'places'}`
      : e.kind === 'space'
        ? `${netName(e.space.network)} ${NETWORK_META[e.space.network].spaceNoun}`
        : kindLabel(e.conv);
  return (
    <button
      class={`row conv-row place-row ${dropClass(e.key)}`}
      {...props}
      onClick={() => (folderId ? go({ view: 'folder', folder: folderId }) : e.kind === 'space' ? go({ view: 'space', space: e.space.id }) : e.kind === 'conversation' ? go({ view: 'inbox', conv: e.conv.id }) : undefined)}
    >
      <span class="row-avatar">{icon}</span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {label}
            {pinned && <Icon name="star" size={11} class="row-star" />}
          </span>
        </span>
        <span class="row-bottom">
          <span class="row-preview">{sub}</span>
          <Count n={u.badge} />
        </span>
      </span>
    </button>
  );
}

export function SpacesSidebar() {
  rev.value;
  const hidden = railEntries('hidden');
  const scroll = useRef<HTMLDivElement>(null);
  useFlip(scroll, snapshot.value.v);
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Spaces<SortButton scope="rail" class="side-sort" /></h1>
        <span class="side-sub">Hold and drag to arrange, tap and hold for more</span>
      </header>
      <div class="side-scroll" ref={scroll}>
        <button class="row conv-row" onClick={() => go({ view: 'directory' })}>
          <span class="row-avatar">
            <span class="folder-row-icon">
              <Icon name="grid" />
            </span>
          </span>
          <span class="row-main">
            <span class="row-top">
              <span class="row-title">All communities and groups</span>
            </span>
            <span class="row-bottom">
              <span class="row-preview">Browse, sort and categorise</span>
            </span>
          </span>
        </button>
        {(() => {
          const { shown, quiet } = shelve(arrangedRail(), (e) => e.key);
          const on = openShelves.value.has('rail');
          return (
            <>
              {shown.map((e) => (
                <SpacesEntry entry={e} />
              ))}
              {on && quiet.map((e) => <SpacesEntry entry={e} />)}
              {quiet.length > 0 && <ShelfRow list="rail" n={quiet.length} open={on} />}
            </>
          );
        })()}
        {hidden.length > 0 && <SectionHead id="spaces-h" label="Hidden" count={hidden.length} />}
        {!isCollapsed('spaces-h') && hidden.map((e) => <SpacesEntry entry={e} hidden />)}
      </div>
    </div>
  );
}
