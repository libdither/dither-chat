import type * as P from '@dither-chat/protocol';
import { folderConvs, inboxSections, people, railCommunities, spaceUnread, sumUnread, groupsLists, netName } from '../model.ts';
import { db, go, rev, route, type Route } from '../state.ts';
import { AccountDots, Avatar, Count, NetBadge } from './bits.tsx';
import { DitherMark, Icon } from './icons.tsx';

function RailItem({ active, unread, badge, title, onClick, children }: { active: boolean; unread?: boolean; badge?: number; title: string; onClick: () => void; children: any }) {
  return (
    <div class={`rail-item ${active ? 'active' : ''}`}>
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
      <RailItem active={is((r) => r.view === 'inbox')} title="Inbox" badge={priorityCount} onClick={() => go({ view: 'inbox' })}>
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
        {db.folders.map((f) => {
          const u = sumUnread(folderConvs(f));
          return (
            <RailItem key={f.id} active={is((r) => r.view === 'folder' && r.folder === f.id)} unread={u.unread > 0} badge={u.badge} title={`Folder: ${f.name}`} onClick={() => go({ view: 'folder', folder: f.id })}>
              <FolderIcon folder={f} />
            </RailItem>
          );
        })}
        {db.folders.length > 0 && <div class="rail-sep small" />}
        {railCommunities().map((s) => {
          const u = spaceUnread(s.id);
          return (
            <RailItem
              key={s.id}
              active={is((r) => r.view === 'space' && r.space === s.id)}
              unread={u.unread > 0}
              badge={u.badge}
              title={`${s.name} · ${netName(s.network)} ${s.network === 'discord' ? 'server' : 'space'}`}
              onClick={() => go({ view: 'space', space: s.id })}
            >
              <SpaceIcon space={s} />
            </RailItem>
          );
        })}
      </div>
      <div class="rail-sep" />
      <RailItem active={is((r) => r.view === 'accounts')} title="Accounts and connections" onClick={() => go({ view: 'accounts' })}>
        <span class="rail-acc">
          <Icon name="power" size={20} />
          {attention && <span class="rail-alert" />}
        </span>
      </RailItem>
      <RailItem active={is((r) => r.view === 'settings')} title="Notification rules and settings" onClick={() => go({ view: 'settings' })}>
        <Icon name="settings" size={20} />
      </RailItem>
    </nav>
  );
}
