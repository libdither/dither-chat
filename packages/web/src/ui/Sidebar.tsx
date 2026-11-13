import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useRef, useState } from 'preact/hooks';
import { ago, since } from '../format.ts';
import {
  authorName,
  communitiesOf,
  communityOfSpace,
  convLabel,
  convTitle,
  convsUnder,
  directsOf,
  effectiveLevel,
  folderConvs,
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
  resolveTokens,
  rootCommunity,
  ruleIcon,
  spaceChildren,
  spaceUnread,
  sumUnread,
  threadsOf,
  unreadOf,
  visibleConv,
  type InboxRow,
  type RailEntry,
} from '../model.ts';
import { db, go, mailRev, metaRev, prefs, rev, route, setPrefs, type InboxFilter, type Route } from '../state.ts';
import { openPalette } from './Palette.tsx';
import { INBOX_FILTERS } from '../ordering.ts';
import { senderLine } from '../mail/model.ts';
import { personItems } from './mail/Classify.tsx';
import { RowTyping } from './Typing.tsx';
import { AccountChip, AccountDots, Avatar, Count, NetBadge, NetGlyph, SourceChip, variantIcon } from './bits.tsx';
import { dragProps, dropClass } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { phone } from '../phone.ts';
import { dropPlace, openPlaceMenu, placeLabel } from './Organize.tsx';
import { contextMenu, Menuable, onMenu, openMenu, useMenu, type MenuEntry } from './ContextMenu.tsx';
import { accountMenu, chatMenu, conversationMenu, folderMenuSpec, owedEntries, personMenu, spaceMenu, WhyHere } from './menus.tsx';
import { pickedRoute } from './Pairs.tsx';
import { chatKey } from '../chatroutes.ts';
import { groups, type MenuSpec } from './ContextMenu.tsx';
import { openAbout } from './About.tsx';
import { arrangeDrop, arrangedFolderItems, arrangedPeople, arrangedRail, snapshot } from '../arrange.ts';
import { inboxSnap, shownInbox } from '../inbox.ts';
import { linkAccounts, PeopleAccountPicker, PeopleLinks, RequestsRow, usePeopleLinks } from './Requests.tsx';
import { nameMatches, peopleFilters, type PeopleFilter } from '../requests.ts';
import { SortButton, SortIcon, useFlip } from './Reorganize.tsx';
import { rememberSearch, SearchBox } from './SearchBox.tsx';
import { counting, rendered } from '../perf.ts';
import { memo } from './memo.ts';
import { convKind, rowTrack } from '../clicks.ts';
import { useShown } from './more.tsx';
import { VoicePeople } from './Ringing.tsx';

// ------------------------------------------------------------------ navigation helpers

/** Open a conversation, keeping the current sidebar context when it contains it. */
export function openConv(c: P.ConversationView, ctx: Route = route.value) {
  if (ctx.view === 'folder') return go({ view: 'folder', folder: ctx.folder, conv: c.id });
  if (ctx.view === 'inbox') return go({ view: 'inbox', conv: c.id });
  if (ctx.view === 'search') return go({ view: 'search', q: ctx.q, conv: c.id });
  if (ctx.view === 'space' && convsUnder(ctx.space).some((x) => x.id === c.id)) return go({ view: 'space', space: ctx.space, conv: c.id });
  return go(homeRoute(c));
}

export function homeRoute(c: P.ConversationView): Route {
  if (c.shape === 'direct' && c.peerPersonId) return { view: 'people', person: c.peerPersonId };
  const base = placeConv(c);
  if (base.spaceIds.length) {
    const root = rootCommunity(base.spaceIds[0]);
    if (root) return { view: 'space', space: root.id, conv: c.id };
  }
  // Group chats, rooms outside a space and notes to self live in the inbox.
  return { view: 'inbox', conv: c.id };
}

/** Only there if some connected account can actually start a conversation, or join or add (docs/add.md). */
function NewMessageButton() {
  if (![...db.accounts.values()].some((a) => a.status === 'online' && (a.capabilities.includes('openDirect') || a.capabilities.includes('resolve')))) return null;
  return (
    <button class="icon-btn small side-new" data-track="new message" title="New message, join or add" aria-label="New message" onClick={() => openPalette({ kind: 'new' })}>
      <Icon name="plus" size={16} />
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
  rev.value;
  return <>{ago(ts)}</>;
}

function Owed({ at }: { at: number }) {
  rev.value;
  return (
    <span class="row-owed" aria-label={`Unanswered for ${since(at)}`}>
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
export const ConvRow = memo(function ConvRow({ c, active, onClick, showPlace = true, why, owedSince, chat }: { c: P.ConversationView; active: boolean; onClick: () => void; showPlace?: boolean; why?: string[]; owedSince?: number | null; chat?: { person: P.PersonView; routes: P.ConversationView[] } }) {
  metaRev.value;
  const u = chat ? chatUnread(chat.routes) : unreadOf(c);
  const lvl = effectiveLevel(c);
  const place = showPlace ? placeLine(c) : '';
  const isChannel = c.shape === 'channel' || c.shape === 'thread';
  const com = communitiesOf(c)[0];
  const ctx = useMenu(() => (chat ? chatMenu(chat.person, chat.routes, why, owedSince) : conversationMenu(c, why, owedSince)));
  return (
    <button
      class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''} ${u.muted ? 'muted' : ''}`}
      onClick={onClick}
      title={why?.length ? why.join('\n') : undefined}
      data-row={chat ? chatKey(chat.person.id) : c.id}
      data-track={rowTrack(convKind(c.shape), !!u.unread, !!owedSince)}
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
          {c.encrypted && <Icon name="lock" size={11} class="row-lock" />}
          <span class="row-time">
            <Ago ts={c.lastMessageAt} />
          </span>
        </span>
        {place && <span class="row-place">{place}</span>}
        <span class="row-bottom">
          <span class="row-preview">{preview(c)}</span>
          {owedSince ? <Owed at={owedSince} /> : null}
          {u.muted && <Icon name={ruleIcon(lvl.level)} size={12} class="row-muted" />}
          {u.badge ? <Count n={u.badge} /> : u.unread && !u.muted ? <span class="unread-dot" /> : null}
        </span>
      </span>
    </button>
  );
});

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
function mailRowMenu(t: P.MailThreadView, why?: string[], owedSince?: number | null): MenuSpec {
  const title = t.subject || '(no subject)';
  return {
    label: `${title} actions`,
    head: <div class="cm-sheet-title">{title}</div>,
    items: groups(why?.length ? [{ kind: 'row', render: () => <WhyHere reasons={why} /> }] : [], owedEntries('mail', [t.id], owedSince), [{ label: 'Open in Mail', icon: 'mail', run: () => go({ view: 'mail', thread: t.id }) }], personItems([t])),
  };
}

/**
 * A thread of mail from a person in the one-list inbox (docs/mail.md, slice 8): their picture with the envelope where
 * a chat's network badge goes, the subject before the start of the last message, the same ↩ and reasons as a chat.
 * Opening it opens the reader beside the inbox.
 */
export const MailRow = memo(function MailRow({ id, active, why, owedSince }: { id: string; active: boolean; why?: string[]; owedSince?: number | null }) {
  mailRev.value;
  metaRev.value;
  const t = db.mail.threads.get(id);
  const ctx = useMenu(() => (t ? mailRowMenu(t, why, owedSince) : null));
  if (!t) return null;
  const other = [...t.from].reverse().find((f) => !f.self) ?? t.from[t.from.length - 1];
  const person = other?.personId ? db.persons.get(other.personId) : undefined;
  const title = t.participants <= 2 ? (person?.name ?? other?.name ?? other?.email ?? '?') : senderLine(t);
  return (
    <button
      class={`row conv-row inbox-mail-row ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`}
      onClick={opener(`inbox:${id}`, () => go({ view: 'inbox', conv: id }))}
      title={why?.length ? why.join('\n') : undefined}
      data-row={id}
      data-track={rowTrack('mail', !!t.unread, !!owedSince)}
      {...ctx}
    >
      <span class="row-avatar">
        <Avatar id={person?.id ?? other?.email ?? id} name={person?.name ?? other?.name ?? other?.email ?? title} url={person?.avatar} size={36} square={t.participants > 2} network="email" />
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">{title}</span>
          <span class="row-time">
            <Ago ts={t.lastAt} />
          </span>
        </span>
        <span class="row-bottom">
          <span class="row-preview">
            <span class="row-subject">{t.subject || '(no subject)'}</span>
            {t.preview ? ` — ${t.preview}` : ''}
          </span>
          {owedSince ? <Owed at={owedSince} /> : null}
          <Count n={t.unread} />
        </span>
      </span>
    </button>
  );
});

/** A list's section, folded or open on this device. Its click counts as "section toggle (label)": labels are fixed words. */
function SectionHead({ id, label, count, actions }: { id: string; label: string; count?: number; actions?: any }) {
  const collapsed = !!prefs.value.collapsed[id];
  return (
    <div class="section-head" data-section={id}>
      <button class="section-toggle" aria-expanded={!collapsed} data-track={`section toggle (${label})`} onClick={() => setPrefs({ collapsed: { ...prefs.value.collapsed, [id]: !collapsed } })}>
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        <span>{label}</span>
        {count ? <span class="section-count">{count}</span> : null}
      </button>
      {actions}
    </div>
  );
}
const isCollapsed = (id: string) => !!prefs.value.collapsed[id];

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
        items: choices.map((f): MenuEntry => ({ label: f.label, checked: f.id === filter, radio: true, track: `filter (${f.label})`, run: () => setPrefs({ inboxFilter: f.id }) })),
      },
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
 * One list: DMs, group chats, rooms outside a space and notes to self, plus anything else while it has something
 * for you, and mail from people (docs/mail.md), ranked by how likely you are to want each now (docs/inbox.md). No
 * sections: a reply you owe shows on its row (↩ and how long), and unread rows are bold with their count.
 */
export function InboxSidebar({ activeConv }: { activeConv?: string }) {
  if (counting) rendered('InboxSidebar');
  rev.value;
  // A mail thread the hub listed whose view has not come yet: the mail event that brings it draws the list again.
  if (mailRowsWaiting()) mailRev.value;
  const snap = inboxSnap.value;
  const accounts = accountsNeedingYou();
  let filter = prefs.value.inboxFilter;
  if (filter === 'mail' && !db.mail.accounts.size) filter = 'all';
  const rows = shownInbox(filter);
  const [drawn, more] = useShown(rows.length);
  const [q, setQ] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  useFlip(scroll, snap.v, '[data-row]');
  // A person's chat is one row, active whichever of their DMs is open.
  const activeKey = activeConv ? inboxKeyOf(activeConv) : undefined;
  const row = (r: InboxRow) =>
    r.kind === 'mail' ? (
      <MailRow key={r.key} id={r.key} active={r.key === activeConv} why={r.reasons} owedSince={r.needs ? r.owedSince : null} />
    ) : r.chat ? (
      <ConvRow key={r.key} c={r.conv} chat={r.chat} active={r.key === activeKey} onClick={opener(`inbox:${r.key}`, () => go({ view: 'inbox', conv: chatOpens(r.chat!.person.id) ?? r.conv.id }))} why={r.reasons} owedSince={r.needs ? r.owedSince : null} />
    ) : (
      <ConvRow key={r.conv.id} c={r.conv} active={r.conv.id === activeConv} onClick={opener(`inbox:${r.conv.id}`, () => go({ view: 'inbox', conv: r.conv.id }))} why={r.reasons} owedSince={r.needs ? r.owedSince : null} />
    );
  return (
    <div class="sidebar-inner inbox-side" data-track-area="inbox">
      <header class="side-head">
        <h1>Inbox<NewMessageButton /></h1>
      </header>
      <div class="inbox-search">
        <SearchBox
          value={q}
          setValue={setQ}
          placeholder={phone.value || filter !== 'all' ? 'Search all messages' : 'Search all messages (Ctrl+K)'}
          submit={(t) => {
            if (!t) return;
            rememberSearch(t);
            go({ view: 'search', q: t });
          }}
        />
        <InboxFilterButton filter={filter} />
      </div>
      <div class="side-scroll" ref={scroll}>
        {accounts.length > 0 && (
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
        <RequestsRow />
        {rows.slice(0, drawn).map(row)}
        {more}
        {!rows.length && <p class="inbox-empty">{EMPTY[filter]}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ people

/** `directs`: the person's direct conversations (directsOf), which change with each message where the person does not. */
export const PersonRow = memo(function PersonRow({ person, directs, active, onClick }: { person: P.PersonView; directs: P.ConversationView[]; active: boolean; onClick: () => void }) {
  metaRev.value;
  const last = directs.reduce<P.ConversationView | null>((a, c) => (!a || (c.lastMessageAt ?? 0) > (a.lastMessageAt ?? 0) ? c : a), null);
  const u = sumUnread(directs);
  const nets = [...new Set(directs.map((d) => d.network))];
  const ctx = useMenu(() => personMenu(person));
  return (
    <button class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''}`} data-person={person.id} data-track={rowTrack('person', !!u.unread)} onClick={onClick} {...ctx}>
      <span class="row-avatar">
        <Avatar id={person.id} name={person.name} url={person.avatar} size={36} />
        <RowTyping convIds={directs.map((d) => d.id)} />
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {person.name}
          </span>
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
  const mode = prefs.value.peopleLinkSort ?? 'recent';
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
  const filter = chips.find((f) => f.id === prefs.value.peopleFilter)?.id ?? 'chats';
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
        <h1>People<NewMessageButton /><GraphButton />{relationship ? <LinkSortButton /> : <SortButton scope="people" class="side-sort" />}</h1>
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
        {relationship && <PeopleLinks relationship={relationship} links={links} accountId={scoped} dots={accounts.length > 1 && !scoped} q={q} sort={prefs.value.peopleLinkSort ?? 'recent'} active={activePerson} />}
        {filter === 'chats' && <SectionHead id="people-all" label="Direct messages" count={list.length} />}
        {!isCollapsed('people-all') && list.slice(0, drawn).map(({ person, directs }) => <PersonRow key={person.id} person={person} directs={directs} active={person.id === activePerson} onClick={opener(`people:${person.id}`, () => go({ view: 'people', person: person.id }))} />)}
        {!isCollapsed('people-all') && more}
        {filter === 'chats' && q.trim() && !list.length && <p class="inbox-empty">Nobody here matches “{q.trim()}”.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ space tree

function ChannelRow({ c, active, depth, onOpen, alsoIn, dots = true }: { c: P.ConversationView; active?: string; depth: number; onOpen: (c: P.ConversationView) => void; alsoIn?: string[]; dots?: boolean }) {
  const u = unreadOf(c);
  const threads = threadsOf(c.id).filter((t) => t.id === active || unreadOf(t).unread > 0 || (t.lastMessageAt ?? 0) > Date.now() - 3 * 86_400_000);
  const forum = c.variant === 'forum';
  const shownThreads = forum ? threadsOf(c.id).slice(0, 6) : threads;
  const lvl = effectiveLevel(c);
  const ctx = useMenu(() => conversationMenu(c));
  return (
    <>
      <button
        class={`chan ${c.id === active ? 'active' : ''} ${u.unread && !u.muted ? 'unread' : ''} ${u.muted ? 'muted' : ''}`}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        onClick={() => onOpen(c)}
        title={kindLabel(c)}
        {...ctx}
      >
        <Icon name={variantIcon(c.variant)} size={16} class="chan-icon" />
        <span class="chan-name">{convTitle(c)}</span>
        {alsoIn && alsoIn.length > 0 && (
          <span class="chan-also" title={`Also in ${alsoIn.join(', ')}`}>
            <Icon name="link" size={11} />
          </span>
        )}
        {u.muted && <Icon name={ruleIcon(lvl.level)} size={12} class="chan-muted" />}
        {dots && <AccountDots network={c.network} accountIds={c.vantages.map((v) => v.accountId)} size={6} />}
        <Count n={u.badge} />
      </button>
      {(c.variant === 'voice' || c.variant === 'stage') && <VoicePeople conversationId={c.id} class="chan-voice" style={{ paddingLeft: `${36 + depth * 12}px` }} />}
      {shownThreads.map((t) => {
        const tu = unreadOf(t);
        return (
          <Menuable build={() => conversationMenu(t)}>
            {(ctx) => (
              <button
                class={`chan thread ${t.id === active ? 'active' : ''} ${tu.unread && !tu.muted ? 'unread' : ''}`}
                style={{ paddingLeft: `${26 + depth * 12}px` }}
                onClick={() => onOpen(t)}
                title={kindLabel(t)}
                {...ctx}
              >
                <span class="thread-elbow" />
                <span class="chan-name">{convTitle(t)}</span>
                <Count n={tu.badge} />
              </button>
            )}
          </Menuable>
        );
      })}
    </>
  );
}

export function SpaceTree({ spaceId, active, onOpen, depth = 0, seen = new Set<string>(), dots }: { spaceId: string; active?: string; onOpen: (c: P.ConversationView) => void; depth?: number; seen?: Set<string>; dots?: boolean }) {
  if (seen.has(spaceId)) return null;
  const nextSeen = new Set(seen).add(spaceId);
  const kids = spaceChildren(spaceId);
  // Seen through one account, the header's "via" already says which; a dot on every channel would repeat it.
  dots ??= (db.spaces.get(spaceId)?.accountIds.length ?? 0) > 1;
  return (
    <>
      {kids.map((k) => {
        if (k.kind === 'conversation') {
          const c = db.conversations.get(k.id)!;
          const also = c.spaceIds.filter((s) => s !== spaceId).map((s) => communityOfSpace(s)?.name ?? db.spaces.get(s)?.name ?? '');
          return <ChannelRow c={c} active={active} depth={depth} onOpen={onOpen} alsoIn={also.filter(Boolean)} dots={dots} />;
        }
        const s = db.spaces.get(k.id)!;
        if (k.kind === 'section' && !spaceChildren(s.id).length) return null; // a category whose channels this account can't see
        const key = `space:${s.id}`;
        const collapsed = isCollapsed(key);
        const u = spaceUnread(s.id);
        return (
          <div class={`tree-group ${k.kind}`}>
            <Menuable build={() => spaceMenu(s)}>
              {(ctx) => (
            <button class="tree-head" style={{ paddingLeft: `${6 + depth * 12}px` }} onClick={() => setPrefs({ collapsed: { ...prefs.value.collapsed, [key]: !collapsed } })} {...ctx}>
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
        <SpaceTree spaceId={spaceId} active={activeConv} onOpen={(c) => go({ view: 'space', space: spaceId, conv: c.id })} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ folders

export function FolderSidebar({ folderId, activeConv, activePerson }: { folderId: string; activeConv?: string; activePerson?: string }) {
  rev.value;
  const f = db.folders.find((x) => x.id === folderId);
  if (!f) return <div class="sidebar-inner" />;
  const nets = new Set<string>();
  for (const it of f.items) {
    if (it.kind === 'space') nets.add(db.spaces.get(it.id)?.network ?? '');
    if (it.kind === 'conversation') nets.add(db.conversations.get(it.id)?.network ?? '');
    if (it.kind === 'person') directsOf(it.id).forEach((d) => nets.add(d.network));
  }
  nets.delete('');
  const open = (c: P.ConversationView) => go({ view: 'folder', folder: f.id, conv: c.id });
  return (
    <div class="sidebar-inner">
      <header class="side-head folder-head" style={{ '--folder': f.color ?? '#8b93a7' } as any} onContextMenu={onMenu(() => folderMenuSpec(f.id))}>
        <h1>
          <span class="folder-head-icon">{f.icon ?? <Icon name="folder" />}</span>
          {f.name}
        </h1>
        <span class="side-sub">
          Folder across {[...nets].map((n) => netName(n as P.Network)).join(', ')}
        </span>
      </header>
      <div class="side-scroll tree">
        {arrangedFolderItems(f).map((it) => {
          if (it.kind === 'space') {
            const s = db.spaces.get(it.id);
            if (!s) return null;
            const key = `folder:${f.id}:${s.id}`;
            const collapsed = isCollapsed(key);
            const u = spaceUnread(s.id);
            return (
              <div class="folder-space">
                <button class="folder-space-head" onClick={() => setPrefs({ collapsed: { ...prefs.value.collapsed, [key]: !collapsed } })} onContextMenu={onMenu(() => spaceMenu(s))}>
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
        })}
      </div>
    </div>
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
      <span class="folder-row-icon" style={{ '--folder': e.folder.color ?? '#8b93a7' } as any}>
        {e.folder.icon ?? <Icon name="folder" />}
      </span>
    ) : e.kind === 'space' ? (
      <Avatar id={e.space.id} name={e.space.name} url={e.space.icon} size={36} square network={e.space.network} accountIds={e.space.accountIds} />
    ) : (
      <Avatar id={e.conv.id} name={label} url={e.conv.avatar} size={36} square network={e.conv.network} />
    );
  const u = e.kind === 'folder' ? sumUnread(folderConvs(e.folder)) : e.kind === 'space' ? spaceUnread(e.space.id) : unreadOf(e.conv);
  const sub =
    e.kind === 'folder'
      ? `Folder · ${e.folder.items.length} items`
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
        {arrangedRail().map((e) => (
          <SpacesEntry entry={e} />
        ))}
        {hidden.length > 0 && <SectionHead id="spaces-h" label="Hidden" count={hidden.length} />}
        {!isCollapsed('spaces-h') && hidden.map((e) => <SpacesEntry entry={e} hidden />)}
      </div>
    </div>
  );
}
