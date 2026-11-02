import type * as P from '@dither-chat/protocol';
import { convTitle, directsOf, folderConvs, inboxSections, people, placePref, railEntries, spaceUnread, sumUnread, groupsLists, netName, unreadOf, type RailEntry } from '../model.ts';
import { db, go, patchPlaces, rev, route, type Route } from '../state.ts';
import { AccountDots, Avatar, Count, NetBadge } from './bits.tsx';
import { dragProps, dropClass } from './dnd.tsx';
import { DitherMark, Icon } from './icons.tsx';
import { dropPlace, openPlaceMenu, placeLabel } from './Organize.tsx';

function RailItem({ active, unread, badge, title, onClick, children, dnd, class: cls }: { active: boolean; unread?: boolean; badge?: number; title: string; onClick: () => void; children: any; dnd?: Record<string, unknown>; class?: string }) {
  return (
    <div class={`rail-item ${active ? 'active' : ''} ${cls ?? ''}`} {...dnd}>
      <span class={`rail-pill ${active ? 'active' : unread ? 'unread' : ''}`} />
      <button class="rail-btn" title={title} aria-label={title} onClick={onClick}>
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
            <span class="folder-mini" title={m.name}>
              <Avatar id={m.id} name={m.name} url={m.url} size={18} square />
            </span>
          ) : (
            <span class="folder-mini" />
          ),
        )}
      </span>
      {folder.icon && <span class="folder-emoji">{folder.icon}</span>}
    </span>
  );
}

const entryId = (e: RailEntry) => e.key.slice(e.key.indexOf(':') + 1);

function dnd(key: string, folder?: string, accepts = false) {
  return { ...dragProps({ key, label: placeLabel(key), group: 'rail', folder, accepts, onDrop: dropPlace, onMenu: (x, y) => openPlaceMenu(key, placeLabel(key), x, y, folder) }) };
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
      title={`${s.name} · ${netName(s.network)} ${s.network === 'discord' ? 'server' : 'space'}`}
      onClick={() => go({ view: 'space', space: s.id })}
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
      title={`${convTitle(c)} · ${netName(c.network)}`}
      onClick={() => go(folder ? { view: 'folder', folder, conv: c.id } : { view: 'groups', conv: c.id })}
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
    <RailItem active={r.view === 'folder' && r.person === id} unread={u.unread > 0} badge={u.badge} title={p.name} onClick={() => go({ view: 'folder', folder, person: id })} dnd={dnd(key, folder)} class={dropClass(key, folder)}>
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
  return (
    <div class={`rail-folder ${open ? 'open' : ''}`} style={{ '--folder': f.color ?? '#8b93a7' } as any}>
      <RailItem
        active={r.view === 'folder' && r.folder === f.id && !open}
        unread={!open && u.unread > 0}
        badge={open ? 0 : u.badge}
        title={`Folder: ${f.name}. Click to ${open ? 'close' : 'open'}, right-click or hold for more.`}
        onClick={() => patchPlaces([{ kind: 'folder', id: f.id, open: !open }])}
        dnd={dnd(e.key, undefined, true)}
        class={dropClass(e.key)}
      >
        {open ? (
          <span class="folder-open-icon">
            <Icon name="folder" size={20} />
          </span>
        ) : (
          <FolderIcon folder={f} />
        )}
      </RailItem>
      {open &&
        f.items.map((it) => {
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

export function Rail() {
  rev.value;
  const r = route.value;
  const inb = inboxSections();
  const priorityCount = inb.priority.length + inb.attention.length;
  const peopleBadge = sumUnread(people().flatMap((p) => p.directs)).badge;
  const g = groupsLists();
  const groupsBadge = sumUnread([...g.groups, ...g.rooms]).badge;
  const attention = [...db.accounts.values()].some((a) => a.attention);
  const is = (pred: (r: Route) => boolean) => pred(r);

  return (
    <nav class="rail" aria-label="Places">
      <RailItem active={is((r) => r.view === 'inbox' || r.view === 'triage')} title="Inbox" badge={priorityCount} onClick={() => go({ view: 'inbox' })}>
        <span class="rail-logo">
          <DitherMark size={26} />
        </span>
      </RailItem>
      <RailItem active={is((r) => r.view === 'people')} title="People: every DM, merged per person" badge={peopleBadge} onClick={() => go({ view: 'people' })}>
        <Icon name="users" size={22} />
      </RailItem>
      <RailItem active={is((r) => r.view === 'groups')} title="Groups: group chats and rooms outside a community" badge={groupsBadge} onClick={() => go({ view: 'groups' })}>
        <Icon name="groups" size={22} />
      </RailItem>
      <div class="rail-sep" />
      <div class="rail-scroll">
        {railEntries().map((e, i, all) => (
          <>
            <RailEntryView entry={e} route={r} />
            {placePref(e.kind, entryId(e)).pinned && !placePref(all[i + 1]?.kind ?? 'space', all[i + 1] ? entryId(all[i + 1]) : '').pinned && <div class="rail-sep small" />}
          </>
        ))}
        <RailItem active={r.view === 'directory'} title="All communities and groups" onClick={() => go({ view: 'directory' })}>
          <Icon name="grid" size={20} />
        </RailItem>
      </div>
      <div class="rail-sep rail-foot" />
      <RailItem class="rail-foot" active={is((r) => r.view === 'accounts')} title="Accounts and connections" onClick={() => go({ view: 'accounts' })}>
        <span class="rail-acc">
          <Icon name="power" size={20} />
          {attention && <span class="rail-alert" />}
        </span>
      </RailItem>
      <RailItem class="rail-foot" active={is((r) => r.view === 'settings')} title="Notification rules and settings" onClick={() => go({ view: 'settings' })}>
        <Icon name="settings" size={20} />
      </RailItem>
    </nav>
  );
}
