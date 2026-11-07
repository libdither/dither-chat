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
  placePref,
  railEntries,
  accountsNeedingYou,
  kindLabel,
  netName,
  people,
  placeConv,
  plainBody,
  resolveTokens,
  rootCommunity,
  spaceChildren,
  spaceUnread,
  sumUnread,
  threadsOf,
  unreadOf,
  visibleConv,
  type RailEntry,
} from '../model.ts';
import { db, go, newMessage, prefs, rev, route, setPrefs, type InboxFilter, type Route } from '../state.ts';
import { RowTyping } from './Typing.tsx';
import { AccountChip, AccountDots, Avatar, Count, NetBadge, NetGlyph, SourceChip, levelIcon, variantIcon } from './bits.tsx';
import { dragProps, dropClass } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { phone } from '../phone.ts';
import { dropPlace, openPlaceMenu, placeLabel } from './Organize.tsx';
import { Menuable, onMenu, useMenu } from './ContextMenu.tsx';
import { accountMenu, conversationMenu, folderMenuSpec, personMenu, spaceMenu } from './menus.tsx';
import { openAbout } from './About.tsx';
import { arrangeDrop, arrangedFolderItems, arrangedPeople, arrangedRail, snapshot } from '../arrange.ts';
import { inboxSnap, shownInbox } from '../inbox.ts';
import { SortButton, useFlip } from './Reorganize.tsx';
import { rememberSearch, SearchBox } from './SearchBox.tsx';
import { counting, rendered } from '../perf.ts';

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

/** Only there if some connected account can actually start a conversation. */
function NewMessageButton() {
  if (![...db.accounts.values()].some((a) => a.status === 'online' && a.capabilities.includes('openDirect'))) return null;
  return (
    <button class="icon-btn small side-new" title="New message" aria-label="New message" onClick={() => (newMessage.value = {})}>
      <Icon name="plus" size={16} />
    </button>
  );
}

/** Opens the people graph: who shares which servers and groups (graph/GraphView.tsx). */
function GraphButton() {
  const on = route.value.view === 'people' && !!route.value.graph;
  return (
    <button class={`icon-btn small side-graph ${on ? 'on' : ''}`} title="Who shares what" aria-label="People graph" aria-pressed={on} onClick={() => go(on ? { view: 'people' } : { view: 'people', graph: true })}>
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

/**
 * `why` is the inbox's reasons, shown on hover and at the top of the row's menu; `owedSince` marks a message you
 * have not answered, for a row that needs you without anything unread.
 */
export function ConvRow({ c, active, onClick, showPlace = true, why, owedSince }: { c: P.ConversationView; active: boolean; onClick: () => void; showPlace?: boolean; why?: string[]; owedSince?: number | null }) {
  const u = unreadOf(c);
  const lvl = effectiveLevel(c);
  const place = showPlace ? placeLine(c) : '';
  const isChannel = c.shape === 'channel' || c.shape === 'thread';
  const com = communitiesOf(c)[0];
  const ctx = useMenu(() => conversationMenu(c, why));
  return (
    <button
      class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''} ${u.muted ? 'muted' : ''}`}
      onClick={onClick}
      title={why?.length ? why.join('\n') : undefined}
      data-row={c.id}
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
          {(c.shape === 'direct' || c.shape === 'group') && <RowTyping convIds={[c.id]} />}
        </span>
      )}
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {isChannel && <Icon name={variantIcon(c.variant, c.shape)} size={13} class="row-kind" />}
            {isChannel ? convTitle(c) : convLabel(c)}
          </span>
          {c.encrypted && <Icon name="lock" size={11} class="row-lock" />}
          <span class="row-time">{ago(c.lastMessageAt)}</span>
        </span>
        {place && <span class="row-place">{place}</span>}
        <span class="row-bottom">
          <span class="row-preview">{preview(c)}</span>
          {owedSince && !u.unread ? (
            <span class="row-owed" aria-label={`Unanswered for ${since(owedSince)}`}>
              <Icon name="reply" size={11} />
              {since(owedSince)}
            </span>
          ) : null}
          {u.muted && <Icon name={levelIcon(lvl.level)} size={12} class="row-muted" />}
          {u.badge ? <Count n={u.badge} /> : u.unread && !u.muted ? <span class="unread-dot" /> : null}
        </span>
      </span>
    </button>
  );
}

function SectionHead({ id, label, count, actions }: { id: string; label: string; count?: number; actions?: any }) {
  const collapsed = !!prefs.value.collapsed[id];
  return (
    <div class="section-head">
      <button class="section-toggle" onClick={() => setPrefs({ collapsed: { ...prefs.value.collapsed, [id]: !collapsed } })}>
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

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'people', label: 'People' },
  { id: 'groups', label: 'Groups' },
  { id: 'unread', label: 'Unread' },
];

/**
 * One list: DMs, group chats, rooms outside a space and notes to self, plus anything else while it has something
 * for you, ranked by how likely you are to want each now (docs/inbox.md).
 */
export function InboxSidebar({ activeConv }: { activeConv?: string }) {
  if (counting) rendered('InboxSidebar');
  rev.value;
  const snap = inboxSnap.value;
  const accounts = accountsNeedingYou();
  const filter = FILTERS.some((f) => f.id === prefs.value.inboxFilter) ? prefs.value.inboxFilter : 'all';
  const rows = shownInbox(filter);
  const [q, setQ] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  useFlip(scroll, snap.v, '[data-row]');
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Inbox<NewMessageButton /></h1>
        <span class="side-sub">Everything that wants you, from every network</span>
      </header>
      <SearchBox
        value={q}
        setValue={setQ}
        placeholder={phone.value ? 'Search all messages' : 'Search all messages (Ctrl+K to jump)'}
        submit={(t) => {
          if (!t) return;
          rememberSearch(t);
          go({ view: 'search', q: t });
        }}
      />
      <div class="inbox-chips" role="radiogroup" aria-label="Show">
        {FILTERS.map((f) => (
          <button class={`chip-btn ${filter === f.id ? 'on' : ''}`} role="radio" aria-checked={filter === f.id} onClick={() => setPrefs({ inboxFilter: f.id })}>
            {f.label}
          </button>
        ))}
      </div>
      <div class="side-scroll" ref={scroll}>
        {accounts.length > 0 && (
          <>
            <SectionHead id="inbox-att" label="Needs you" count={accounts.length} />
            {!isCollapsed('inbox-att') &&
              accounts.map((a) => (
                <button class="row attention-row" onClick={() => go({ view: 'accounts', account: a.id })} onContextMenu={onMenu(() => accountMenu(a))}>
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
        {rows.map((r) => (
          <ConvRow key={r.conv.id} c={r.conv} active={r.conv.id === activeConv} onClick={() => go({ view: 'inbox', conv: r.conv.id })} why={r.reasons} owedSince={r.needs ? r.owedSince : null} />
        ))}
        {!rows.length && <p class="inbox-empty">{filter === 'unread' ? 'Nothing unread.' : filter === 'all' ? 'No conversations yet.' : 'None here.'}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ people

export function PersonRow({ person, active, onClick }: { person: P.PersonView; active: boolean; onClick: () => void }) {
  const directs = directsOf(person.id);
  const last = directs.reduce<P.ConversationView | null>((a, c) => (!a || (c.lastMessageAt ?? 0) > (a.lastMessageAt ?? 0) ? c : a), null);
  const u = sumUnread(directs);
  const nets = [...new Set(directs.map((d) => d.network))];
  const ctx = useMenu(() => personMenu(person));
  return (
    <button class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''}`} onClick={onClick} {...ctx}>
      <span class="row-avatar">
        <Avatar id={person.id} name={person.name} url={person.avatar} size={36} />
        <RowTyping convIds={directs.map((d) => d.id)} />
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {person.name}
            {person.starred && <Icon name="star" size={11} class="row-star" />}
          </span>
          <span class="row-nets">
            {directs.map((d) => (
              <span class="row-net" title={`${netName(d.network)}${d.vantages.length ? ' · ' + d.vantages.map((v) => db.accounts.get(v.accountId)?.label).join(', ') : ''}`}>
                <NetBadge network={d.network} size={14} />
                <AccountDots network={d.network} accountIds={d.vantages.map((v) => v.accountId)} size={6} />
              </span>
            ))}
          </span>
          <span class="row-time">{ago(last?.lastMessageAt)}</span>
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
}

export function PeopleSidebar({ activePerson }: { activePerson?: string }) {
  rev.value;
  const list = arrangedPeople(people());
  const starred = list.filter((x) => x.person.starred);
  const rest = list.filter((x) => !x.person.starred);
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>People<NewMessageButton /><GraphButton /><SortButton scope="people" class="side-sort" /></h1>
        <span class="side-sub">One thread per person, across every network</span>
      </header>
      <div class="side-scroll">
        {starred.length > 0 && <SectionHead id="people-star" label="Starred" count={starred.length} />}
        {!isCollapsed('people-star') && starred.map(({ person }) => <PersonRow person={person} active={person.id === activePerson} onClick={() => go({ view: 'people', person: person.id })} />)}
        <SectionHead id="people-all" label="Direct messages" count={rest.length} />
        {!isCollapsed('people-all') && rest.map(({ person }) => <PersonRow person={person} active={person.id === activePerson} onClick={() => go({ view: 'people', person: person.id })} />)}
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
        {u.muted && <Icon name={levelIcon(lvl.level)} size={12} class="chan-muted" />}
        {dots && <AccountDots network={c.network} accountIds={c.vantages.map((v) => v.accountId)} size={6} />}
        <Count n={u.badge} />
      </button>
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
            return p ? <PersonRow person={p} active={p.id === activePerson} onClick={() => go({ view: 'folder', folder: f.id, person: p.id })} /> : null;
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
