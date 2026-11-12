import { loadRetention } from '../history.ts';
import type * as P from '@dither-chat/protocol';
import { Fragment } from 'preact';
import { accountsNeedingYou, convTitle, directsOf, folderConvs, people, inboxBadge, placePref, railEntries, spaceUnread, sumUnread, netName, unreadOf, visibleConv, type RailEntry } from '../model.ts';
import { db, go, mailRev, markAllRead, patchPlaces, rev, route, type Route } from '../state.ts';
import { unreadInbox } from '../mail/model.ts';
import { preloadMail } from './mail/lazy.tsx';
import { AccountDots, Avatar, Count, NetBadge } from './bits.tsx';
import { dragProps, dropClass } from './dnd.tsx';
import { DitherMark, Icon } from './icons.tsx';
import { dropPlace, openPlaceMenu, placeLabel } from './Organize.tsx';
import { groups, useMenu, type MenuSpec } from './ContextMenu.tsx';
import { accountsMenu } from './menus.tsx';
import { useEffect, useRef } from 'preact/hooks';
import { NETWORK_META } from '@dither-chat/protocol';
import { tipProps } from './Tooltip.tsx';
import { arrangeDrop, arrangedFolderItems, arrangedRail, snapshot, sortOf, SORT_LABELS } from '../arrange.ts';
import { OrganizeView, SortIcon, sortEntries, startOrganize, useFlip } from './Reorganize.tsx';
import { startInbox } from '../inbox.ts';
import { openMenu } from './ContextMenu.tsx';
import { useShown } from './more.tsx';

/** `track`: its key for button counts (clicks.ts), never the title, which may be a name. */
function RailItem({ active, unread, badge, title, sub, onClick, children, dnd, menu, class: cls, track }: { active: boolean; unread?: boolean; badge?: number; title: string; sub?: string; onClick: () => void; children: any; dnd?: Record<string, unknown>; menu?: () => MenuSpec | null; class?: string; track: string }) {
  const ctx = useMenu(menu ?? (() => null));
  return (
    <div class={`rail-item ${active ? 'active' : ''} ${cls ?? ''}`} {...dnd}>
      <span class={`rail-pill ${active ? 'active' : unread ? 'unread' : ''}`} />
      <button class="rail-btn" data-track={track} {...tipProps(title, sub)} onClick={onClick} {...(menu ? ctx : {})}>
        {children}
      </button>
      {!!badge && (
        <span class="rail-count">
          <Count n={badge} />
        </span>
      )}
    </div>
  );
}

function SpaceIcon({ space }: { space: P.SpaceView }) {
  return (
    <span class="space-icon">
      <Avatar id={space.id} name={space.name} url={space.icon} size={44} square />
      <NetBadge network={space.network} size={18} class="space-net" />
      <span class="space-accs">
        <AccountDots network={space.network} accountIds={space.accountIds} size={9} />
      </span>
    </span>
  );
}

function FolderIcon({ folder }: { folder: P.FolderView }) {
  const minis = folder.items.slice(0, 4).map((it) => {
    if (it.kind === 'space') {
      const s = db.spaces.get(it.id);
      return s ? { id: s.id, name: s.name, url: s.icon, net: s.network } : null;
    }
    if (it.kind === 'person') {
      const p = db.persons.get(it.id);
      return p ? { id: p.id, name: p.name, url: p.avatar, net: null } : null;
    }
    const c = db.conversations.get(it.id);
    return c ? { id: c.id, name: c.name ?? '?', url: c.avatar, net: c.network } : null;
  });
  return (
    <span class="folder-icon" style={{ '--folder': folder.color ?? '#8b93a7' } as any}>
      <span class="folder-grid">
        {minis.map((m) =>
          m ? (
            <span class="folder-mini">
              <Avatar id={m.id} name={m.name} url={m.url} size={18} square />
            </span>
          ) : (
            <span class="folder-mini" />
          ),
        )}
      </span>
    </span>
  );
}

const mentions = (n: number) => (n ? `${n} unread ${n === 1 ? 'mention' : 'mentions'}` : '');

/** What a folder holds, as Discord's tooltip lists it. */
function folderNames(f: P.FolderView): string {
  const names = f.items.map((it) => (it.kind === 'space' ? db.spaces.get(it.id)?.name : it.kind === 'person' ? db.persons.get(it.id)?.name : db.conversations.get(it.id)?.name)).filter(Boolean) as string[];
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
}

const entryId = (e: RailEntry) => e.key.slice(e.key.indexOf(':') + 1);

const railDrop = arrangeDrop(dropPlace);
function dnd(key: string, folder?: string, accepts = false) {
  return { ...dragProps({ key, label: placeLabel(key), group: 'rail', folder, accepts, onDrop: railDrop, onMenu: (x, y) => openPlaceMenu(key, placeLabel(key), x, y, folder) }) };
}

function RailSpace({ space: s, route: r, folder }: { space: P.SpaceView; route: Route; folder?: string }) {
  const u = spaceUnread(s.id);
  const key = `space:${s.id}`;
  return (
    <RailItem
      key={s.id}
      active={r.view === 'space' && r.space === s.id}
      unread={u.unread > 0}
      badge={u.badge}
      title={s.name}
      sub={[`${netName(s.network)} ${NETWORK_META[s.network].spaceNoun}`, mentions(u.badge)].filter(Boolean).join(' · ')}
      onClick={() => go({ view: 'space', space: s.id })}
      track={folder ? 'community (in a folder)' : 'community'}
      dnd={dnd(key, folder, !folder)}
      class={dropClass(key, folder)}
    >
      <SpaceIcon space={s} />
    </RailItem>
  );
}

function RailConv({ conv: c, route: r, folder }: { conv: P.ConversationView; route: Route; folder?: string }) {
  const u = unreadOf(c);
  const key = `conversation:${c.id}`;
  return (
    <RailItem
      active={'conv' in r && r.conv === c.id}
      unread={u.unread > 0}
      badge={u.badge}
      title={convTitle(c)}
      sub={[`${netName(c.network)} ${c.shape === 'group' ? 'group' : c.shape}`, mentions(u.badge)].filter(Boolean).join(' · ')}
      onClick={() => go(folder ? { view: 'folder', folder, conv: c.id } : { view: 'inbox', conv: c.id })}
      track={folder ? 'chat (in a folder)' : 'chat'}
      dnd={dnd(key, folder, !folder)}
      class={dropClass(key, folder)}
    >
      <span class="space-icon">
        <Avatar id={c.id} name={convTitle(c)} url={c.avatar} size={44} square />
        <NetBadge network={c.network} size={18} class="space-net" />
      </span>
    </RailItem>
  );
}

function RailPerson({ id, route: r, folder }: { id: string; route: Route; folder: string }) {
  const p = db.persons.get(id);
  if (!p) return null;
  const u = sumUnread(directsOf(id));
  const key = `person:${id}`;
  return (
    <RailItem active={r.view === 'folder' && r.person === id} unread={u.unread > 0} badge={u.badge} title={p.name} track="person (in a folder)" onClick={() => go({ view: 'folder', folder, person: id })} dnd={dnd(key, folder)} class={dropClass(key, folder)}>
      <Avatar id={p.id} name={p.name} url={p.avatar} size={44} />
    </RailItem>
  );
}

function RailEntryView({ entry: e, route: r }: { entry: RailEntry; route: Route }) {
  if (e.kind === 'space') return <RailSpace space={e.space} route={r} />;
  if (e.kind === 'conversation') return <RailConv conv={e.conv} route={r} />;
  const f = e.folder;
  const u = sumUnread(folderConvs(f));
  const open = placePref('folder', f.id).open;
  // A closed folder stands in for what is open inside it, as Discord's does.
  const inside = (r.view === 'folder' && r.folder === f.id) || f.items.some((it) => (it.kind === 'space' ? r.view === 'space' && r.space === it.id : it.kind === 'conversation' && 'conv' in r && r.conv === it.id));
  return (
    <div class={`rail-folder ${open ? 'open' : ''}`} style={{ '--folder': f.color ?? '#8b93a7' } as any}>
      <RailItem
        active={inside && !open}
        unread={!open && u.unread > 0}
        badge={open ? 0 : u.badge}
        title={f.name}
        sub={folderNames(f)}
        onClick={() => patchPlaces([{ kind: 'folder', id: f.id, open: !open }])}
        track={open ? 'folder (close)' : 'folder (open)'}
        dnd={dnd(e.key, undefined, true)}
        class={dropClass(e.key)}
      >
        {open ? (
          <span class="folder-open-icon">{f.icon ? <span class="folder-open-emoji">{f.icon}</span> : <Icon name="folder" size={20} />}</span>
        ) : (
          <FolderIcon folder={f} />
        )}
      </RailItem>
      {open &&
        arrangedFolderItems(f).map((it) => {
          if (it.kind === 'person') return <RailPerson id={it.id} route={r} folder={f.id} />;
          if (it.kind === 'space') {
            const s = db.spaces.get(it.id);
            return s ? <RailSpace space={s} route={r} folder={f.id} /> : null;
          }
          const c = db.conversations.get(it.id);
          return c ? <RailConv conv={c} route={r} folder={f.id} /> : null;
        })}
    </div>
  );
}

/** Discord's home button has no menu; this inbox spans every account, so reading all of it is worth one. */
function inboxMenu(): MenuSpec {
  const all = [...db.conversations.values()].filter(visibleConv);
  return {
    label: 'Inbox',
    track: 'inbox menu',
    items: groups([
      { label: 'Mark Everything As Read', icon: 'check', track: 'mark everything read', disabled: !sumUnread(all).unread, run: () => markAllRead(all, 'all your accounts') },
      { label: 'How It Sorts', icon: 'sparkles', track: 'how it sorts', run: () => go({ view: 'model' }) },
    ]),
  };
}

/** Mail, once the hub can read it (docs/mail.md): a dot while Inbox has unread threads. Reads only mail's signal. */
function RailMail({ active }: { active: boolean }) {
  mailRev.value;
  const s = db.mail;
  if (s.access.state === 'off') return null;
  const unread = unreadInbox(s);
  return (
    <RailItem active={active} unread={unread > 0} title="Mail" track="mail" sub={unread ? `${unread} unread ${unread === 1 ? 'thread' : 'threads'} in Inbox` : 'Your email, through dither-accounts'} onClick={() => go({ view: 'mail' })}>
      <span class="rail-mail" onPointerEnter={() => void preloadMail().catch(() => {})}>
        <Icon name="mail" size={21} />
        {unread > 0 && <span class="rail-mail-dot" />}
      </span>
    </RailItem>
  );
}

export function Rail() {
  rev.value;
  const r = route.value;
  const priorityCount = inboxBadge() + accountsNeedingYou().length;
  const peopleBadge = sumUnread(people().flatMap((p) => p.directs)).badge;
  const attention = [...db.accounts.values()].some((a) => a.attention);
  const is = (pred: (r: Route) => boolean) => pred(r);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    startOrganize();
    startInbox();
    void loadRetention();
  }, []);
  useFlip(scroll, snapshot.value.v);
  const entries = arrangedRail();
  const [drawn, more] = useShown(entries.length);

  return (
    <nav class="rail" aria-label="Places" data-track-area="rail">
      <RailItem active={is((r) => r.view === 'inbox' || r.view === 'triage' || r.view === 'model')} title="Inbox" track="inbox" badge={priorityCount} onClick={() => go({ view: 'inbox' })} menu={inboxMenu}>
        <span class="rail-logo">
          <DitherMark size={26} />
        </span>
      </RailItem>
      <RailItem active={is((r) => r.view === 'people')} title="People" track="people" sub="Every DM, merged per person" badge={peopleBadge} onClick={() => go({ view: 'people' })}>
        <Icon name="users" size={22} />
      </RailItem>
      <RailMail active={r.view === 'mail'} />
      <div class="rail-sep" />
      <div class="rail-scroll" ref={scroll}>
        {entries.slice(0, drawn).map((e, i) => (
          <Fragment key={e.key}>
            <RailEntryView entry={e} route={r} />
            {placePref(e.kind, entryId(e)).pinned && !placePref(entries[i + 1]?.kind ?? 'space', entries[i + 1] ? entryId(entries[i + 1]) : '').pinned && <div class="rail-sep small" />}
          </Fragment>
        ))}
        {more}
        <RailItem active={r.view === 'directory'} title="All communities" track="all communities" sub="Browse, sort and categorise" onClick={() => go({ view: 'directory' })}>
          <Icon name="grid" size={20} />
        </RailItem>
        <RailItem
          class="rail-sort"
          track="order"
          active={false}
          title={`Order: ${SORT_LABELS[sortOf('rail')]}`}
          sub="Change the order, or organize servers"
          onClick={() => {
            const b = scroll.current?.querySelector('.rail-sort')?.getBoundingClientRect();
            openMenu({ x: (b?.right ?? 72) + 4, y: b?.top ?? 0 }, { items: sortEntries('rail'), label: 'Order servers', head: <div class="cm-sheet-title">Order servers</div> });
          }}
        >
          <SortIcon size={18} />
        </RailItem>
      </div>
      <OrganizeView />
      <div class="rail-sep rail-foot" />
      <RailItem class="rail-foot" active={is((r) => r.view === 'accounts')} title="Accounts and connections" track="accounts" onClick={() => go({ view: 'accounts' })} menu={accountsMenu}>
        <span class="rail-acc">
          <Icon name="power" size={20} />
          {attention && <span class="rail-alert" />}
        </span>
      </RailItem>
      <RailItem class="rail-foot" active={is((r) => r.view === 'settings')} title="Settings" track="settings" sub="Notification rules and everything else" onClick={() => go({ view: 'settings' })}>
        <Icon name="settings" size={20} />
      </RailItem>
    </nav>
  );
}
