import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { ago } from '../format.ts';
import {
  allCommunities,
  authorName,
  communitiesOf,
  communityOfSpace,
  convLabel,
  convTitle,
  convsUnder,
  directsOf,
  effectiveLevel,
  groupsLists,
  inboxSections,
  kindLabel,
  netName,
  people,
  placeConv,
  resolveTokens,
  rootCommunity,
  spaceChildren,
  spaceUnread,
  sumUnread,
  threadsOf,
  unreadOf,
  visibleConv,
} from '../model.ts';
import { db, go, prefs, rev, route, setPrefs, type Route } from '../state.ts';
import { AccountChip, AccountDots, Avatar, Count, NetBadge, NetGlyph, SourceChip, levelIcon, variantIcon } from './bits.tsx';
import { Icon } from './icons.tsx';

// ------------------------------------------------------------------ navigation helpers

/** Open a conversation, keeping the current sidebar context when it contains it. */
export function openConv(c: P.ConversationView, ctx: Route = route.value) {
  if (ctx.view === 'folder') return go({ view: 'folder', folder: ctx.folder, conv: c.id });
  if (ctx.view === 'inbox') return go({ view: 'inbox', conv: c.id });
  if (ctx.view === 'search') return go({ view: 'search', q: ctx.q, conv: c.id });
  if (ctx.view === 'space' && convsUnder(ctx.space).some((x) => x.id === c.id)) return go({ view: 'space', space: ctx.space, conv: c.id });
  if (ctx.view === 'groups' && (c.shape === 'group' || c.shape === 'self' || !placeConv(c).spaceIds.length)) return go({ view: 'groups', conv: c.id });
  return go(homeRoute(c));
}

export function homeRoute(c: P.ConversationView): Route {
  if (c.shape === 'direct' && c.peerPersonId) return { view: 'people', person: c.peerPersonId };
  const base = placeConv(c);
  if (base.spaceIds.length) {
    const root = rootCommunity(base.spaceIds[0]);
    if (root) return { view: 'space', space: root.id, conv: c.id };
  }
  return { view: 'groups', conv: c.id };
}

function preview(c: P.ConversationView): string {
  const m = c.lastMessage;
  if (!m) return c.topic ?? kindLabel(c);
  const who = m.authorId ? authorName(m.authorId) : '';
  const showWho = c.shape !== 'direct' || who === 'You';
  return `${showWho && who ? who + ': ' : ''}${resolveTokens(m.text, c.network) || (m.kind === 'media' ? 'Attachment' : '')}`;
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

export function ConvRow({ c, active, onClick, showPlace = true, reason }: { c: P.ConversationView; active: boolean; onClick: () => void; showPlace?: boolean; reason?: string }) {
  const u = unreadOf(c);
  const lvl = effectiveLevel(c);
  const place = showPlace ? placeLine(c) : '';
  const isChannel = c.shape === 'channel' || c.shape === 'thread';
  const com = communitiesOf(c)[0];
  return (
    <button class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''} ${u.muted ? 'muted' : ''}`} onClick={onClick}>
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
          <span class="row-preview">{reason ? <span class="row-reason">{reason}</span> : preview(c)}</span>
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

export function InboxSidebar({ activeConv }: { activeConv?: string }) {
  rev.value;
  const s = inboxSections();
  const [q, setQ] = useState('');
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Inbox</h1>
        <span class="side-sub">Everything that wants you, from every network</span>
      </header>
      <form
        class="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) go({ view: 'search', q: q.trim() });
        }}
      >
        <Icon name="search" size={15} />
        <input placeholder="Search all messages" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </form>
      <div class="side-scroll">
        {s.attention.length > 0 && (
          <>
            <SectionHead id="inbox-att" label="Needs you" count={s.attention.length} />
            {!isCollapsed('inbox-att') &&
              s.attention.map((a) => (
                <button class="row attention-row" onClick={() => go({ view: 'accounts', account: a.id })}>
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
        {s.priority.length > 0 && (
          <>
            <SectionHead id="inbox-pri" label="Pinged you" count={s.priority.length} />
            {!isCollapsed('inbox-pri') && s.priority.map((c) => <ConvRow c={c} active={c.id === activeConv} onClick={() => go({ view: 'inbox', conv: c.id })} />)}
          </>
        )}
        {s.unread.length > 0 && (
          <>
            <SectionHead id="inbox-unread" label="Unread" count={s.unread.length} />
            {!isCollapsed('inbox-unread') && s.unread.map((c) => <ConvRow c={c} active={c.id === activeConv} onClick={() => go({ view: 'inbox', conv: c.id })} />)}
          </>
        )}
        <SectionHead id="inbox-recent" label="Recent chats" />
        {!isCollapsed('inbox-recent') && s.recent.map((c) => <ConvRow c={c} active={c.id === activeConv} onClick={() => go({ view: 'inbox', conv: c.id })} />)}
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
  return (
    <button class={`row conv-row ${active ? 'active' : ''} ${u.unread ? 'unread' : ''}`} onClick={onClick}>
      <span class="row-avatar">
        <Avatar id={person.id} name={person.name} url={person.avatar} size={36} />
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
  const list = people();
  const starred = list.filter((x) => x.person.starred);
  const rest = list.filter((x) => !x.person.starred);
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>People</h1>
        <span class="side-sub">One thread per person, across Signal, Discord and Matrix</span>
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

// ------------------------------------------------------------------ groups

export function GroupsSidebar({ activeConv }: { activeConv?: string }) {
  rev.value;
  const g = groupsLists();
  const open = (c: P.ConversationView) => go({ view: 'groups', conv: c.id });
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Groups</h1>
        <span class="side-sub">Group chats that don't belong to a server or space</span>
      </header>
      <div class="side-scroll">
        <SectionHead id="groups-g" label="Group chats" count={g.groups.length} />
        {!isCollapsed('groups-g') && g.groups.map((c) => <ConvRow c={c} active={c.id === activeConv} onClick={() => open(c)} showPlace={false} />)}
        {g.rooms.length > 0 && <SectionHead id="groups-r" label="Rooms outside a space" count={g.rooms.length} />}
        {!isCollapsed('groups-r') && g.rooms.map((c) => <ConvRow c={c} active={c.id === activeConv} onClick={() => open(c)} showPlace={false} />)}
        {g.notes.length > 0 && <SectionHead id="groups-n" label="Notes to self" count={g.notes.length} />}
        {!isCollapsed('groups-n') && g.notes.map((c) => <ConvRow c={c} active={c.id === activeConv} onClick={() => open(c)} showPlace={false} />)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ space tree

function ChannelRow({ c, active, depth, onOpen, alsoIn }: { c: P.ConversationView; active?: string; depth: number; onOpen: (c: P.ConversationView) => void; alsoIn?: string[] }) {
  const u = unreadOf(c);
  const threads = threadsOf(c.id).filter((t) => t.id === active || unreadOf(t).unread > 0 || (t.lastMessageAt ?? 0) > Date.now() - 3 * 86_400_000);
  const forum = c.variant === 'forum';
  const shownThreads = forum ? threadsOf(c.id).slice(0, 6) : threads;
  const lvl = effectiveLevel(c);
  return (
    <>
      <button
        class={`chan ${c.id === active ? 'active' : ''} ${u.unread && !u.muted ? 'unread' : ''} ${u.muted ? 'muted' : ''}`}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        onClick={() => onOpen(c)}
        title={kindLabel(c)}
      >
        <Icon name={variantIcon(c.variant)} size={16} class="chan-icon" />
        <span class="chan-name">{convTitle(c)}</span>
        {alsoIn && alsoIn.length > 0 && (
          <span class="chan-also" title={`Also in ${alsoIn.join(', ')}`}>
            <Icon name="link" size={11} />
          </span>
        )}
        {u.muted && <Icon name={levelIcon(lvl.level)} size={12} class="chan-muted" />}
        <AccountDots network={c.network} accountIds={c.vantages.map((v) => v.accountId)} size={6} />
        <Count n={u.badge} />
      </button>
      {shownThreads.map((t) => {
        const tu = unreadOf(t);
        return (
          <button
            class={`chan thread ${t.id === active ? 'active' : ''} ${tu.unread && !tu.muted ? 'unread' : ''}`}
            style={{ paddingLeft: `${26 + depth * 12}px` }}
            onClick={() => onOpen(t)}
            title={kindLabel(t)}
          >
            <span class="thread-elbow" />
            <span class="chan-name">{convTitle(t)}</span>
            <Count n={tu.badge} />
          </button>
        );
      })}
    </>
  );
}

export function SpaceTree({ spaceId, active, onOpen, depth = 0, seen = new Set<string>() }: { spaceId: string; active?: string; onOpen: (c: P.ConversationView) => void; depth?: number; seen?: Set<string> }) {
  if (seen.has(spaceId)) return null;
  const nextSeen = new Set(seen).add(spaceId);
  const kids = spaceChildren(spaceId);
  return (
    <>
      {kids.map((k) => {
        if (k.kind === 'conversation') {
          const c = db.conversations.get(k.id)!;
          const also = c.spaceIds.filter((s) => s !== spaceId).map((s) => communityOfSpace(s)?.name ?? db.spaces.get(s)?.name ?? '');
          return <ChannelRow c={c} active={active} depth={depth} onOpen={onOpen} alsoIn={also.filter(Boolean)} />;
        }
        const s = db.spaces.get(k.id)!;
        if (k.kind === 'section' && !spaceChildren(s.id).length) return null; // a category whose channels this account can't see
        const key = `space:${s.id}`;
        const collapsed = isCollapsed(key);
        const u = spaceUnread(s.id);
        return (
          <div class={`tree-group ${k.kind}`}>
            <button class="tree-head" style={{ paddingLeft: `${6 + depth * 12}px` }} onClick={() => setPrefs({ collapsed: { ...prefs.value.collapsed, [key]: !collapsed } })}>
              <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={11} />
              {k.kind === 'subspace' && <NetGlyph network={s.network} size={11} />}
              <span>{k.kind === 'section' ? s.name.toUpperCase() : s.name}</span>
              {k.kind === 'subspace' && <span class="tree-tag">subspace</span>}
              {collapsed && <Count n={u.badge} />}
            </button>
            {!collapsed && <SpaceTree spaceId={s.id} active={active} onOpen={onOpen} depth={k.kind === 'subspace' ? depth + 1 : depth} seen={nextSeen} />}
          </div>
        );
      })}
    </>
  );
}

function SpaceHeader({ space }: { space: P.SpaceView }) {
  const accounts = space.accountIds.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  const noun = NETWORK_META[space.network].spaceNoun;
  return (
    <header class="space-head" style={{ '--net': NETWORK_META[space.network].color } as any}>
      <div class="space-head-top">
        <Avatar id={space.id} name={space.name} url={space.icon} size={40} square />
        <div class="space-head-text">
          <h1 title={space.name}>{space.name}</h1>
          <span class="space-kind">
            <NetGlyph network={space.network} size={12} /> {netName(space.network)} {noun}
          </span>
        </div>
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
      <header class="side-head folder-head" style={{ '--folder': f.color ?? '#8b93a7' } as any}>
        <h1>
          <span class="folder-head-icon">{f.icon ?? <Icon name="folder" />}</span>
          {f.name}
        </h1>
        <span class="side-sub">
          Folder across {[...nets].map((n) => netName(n as P.Network)).join(', ')}
        </span>
      </header>
      <div class="side-scroll tree">
        {f.items.map((it) => {
          if (it.kind === 'space') {
            const s = db.spaces.get(it.id);
            if (!s) return null;
            const key = `folder:${f.id}:${s.id}`;
            const collapsed = isCollapsed(key);
            const u = spaceUnread(s.id);
            return (
              <div class="folder-space">
                <button class="folder-space-head" onClick={() => setPrefs({ collapsed: { ...prefs.value.collapsed, [key]: !collapsed } })}>
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

export function SpacesSidebar() {
  rev.value;
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Spaces</h1>
        <span class="side-sub">Discord servers and Matrix spaces, plus your folders</span>
      </header>
      <div class="side-scroll">
        {db.folders.length > 0 && <SectionHead id="spaces-f" label="Folders" count={db.folders.length} />}
        {!isCollapsed('spaces-f') &&
          db.folders.map((f) => {
            const u = sumUnread(
              f.items.flatMap((it) => (it.kind === 'space' ? convsUnder(it.id) : it.kind === 'conversation' ? [db.conversations.get(it.id)!].filter(Boolean) : directsOf(it.id))),
            );
            return (
              <button class="row conv-row" onClick={() => go({ view: 'folder', folder: f.id })}>
                <span class="row-avatar">
                  <span class="folder-row-icon" style={{ '--folder': f.color ?? '#8b93a7' } as any}>
                    {f.icon ?? <Icon name="folder" />}
                  </span>
                </span>
                <span class="row-main">
                  <span class="row-top">
                    <span class="row-title">{f.name}</span>
                  </span>
                  <span class="row-bottom">
                    <span class="row-preview">{f.items.length} items</span>
                    <Count n={u.badge} />
                  </span>
                </span>
              </button>
            );
          })}
        <SectionHead id="spaces-c" label="Communities" />
        {!isCollapsed('spaces-c') &&
          allCommunities().map((s) => {
            const u = spaceUnread(s.id);
            return (
              <button class="row conv-row" onClick={() => go({ view: 'space', space: s.id })}>
                <span class="row-avatar">
                  <Avatar id={s.id} name={s.name} url={s.icon} size={36} square network={s.network} accountIds={s.accountIds} />
                </span>
                <span class="row-main">
                  <span class="row-top">
                    <span class="row-title">{s.name}</span>
                  </span>
                  <span class="row-bottom">
                    <span class="row-preview">
                      {netName(s.network)} {NETWORK_META[s.network].spaceNoun}
                    </span>
                    <Count n={u.badge} />
                  </span>
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}

