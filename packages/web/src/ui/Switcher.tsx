/**
 * The palette's root (Ctrl+K): type a few letters, land anywhere. Works from what the client already holds, so it
 * answers instantly. Its own action rows open the palette's other pages (docs/palette.md).
 */
import type * as P from '@dither-chat/protocol';
import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { allCommunities, communitiesOf, convLabel, convTitle, directsOf, netName, people, visibleConv } from '../model.ts';
import { shownInbox } from '../inbox.ts';
import { db, go, type Route } from '../state.ts';
import { describeAddRef, joinsSomething, mailboxList, parseAdd, viewList } from '@dither-chat/protocol';
import { holdsOnlyMailboxes, MAIL_VIEWS } from '../mail/model.ts';
import { JOIN, NEW, rootKeys, SEARCH, type Entry, type PageRef } from '../palette.ts';
import { addableGroups } from './AddMembers.tsx';
import { Avatar, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { closePalette, pushPage } from './Palette.tsx';
import { Frame, type Row } from './PaletteFrame.tsx';
import { homeRoute } from './Sidebar.tsx';

interface Item {
  key: string;
  label: string;
  sub: string;
  icon: JSX.Element;
  to?: Route;
  /** An action: the palette page it opens. */
  page?: PageRef;
  last: number;
  /** The inbox's score (docs/inbox.md): a person's is their best DM's. */
  score?: number | null;
  track: string;
  /** Other words it is found by. */
  also?: string[];
}

const scoreOf = (ids: string[]) => {
  const s = ids.map((id) => db.attention.get(id)?.score).filter((x): x is number => x !== undefined);
  return s.length ? Math.max(...s) : null;
};

/** New group (the next step): its page. Set, it shows as a row of New and of the root; null keeps both off. */
export const NEW_GROUP: PageRef | null = { kind: 'group' };

function items(): Item[] {
  const view = (key: string, label: string, icon: string, to: Route): Item => ({ key, label, sub: 'View', icon: <Icon name={icon as any} size={18} />, to, last: 0, track: 'row (view)' });
  const action = (key: string, label: string, sub: string, icon: string, page: PageRef): Item => ({ key, label, sub, icon: <Icon name={icon as any} size={18} />, page, last: 0, track: 'row (action)' });
  const out: Item[] = [
    view('v:inbox', 'Inbox', 'inbox', { view: 'inbox' }),
    view('v:directory', 'All communities and groups', 'grid', { view: 'directory' }),
    view('v:settings', 'Settings', 'settings', { view: 'settings' }),
    view('v:accounts', 'Accounts', 'power', { view: 'accounts' }),
  ];
  // Mail, its views and each account's mailboxes (docs/mail.md).
  if (db.mail.access.state !== 'off') {
    out.push(view('v:mail', 'Mail', 'mail', { view: 'mail' }));
    for (const v of MAIL_VIEWS.slice(1)) out.push(view(`v:mail:${v.view}`, `Mail: ${v.label}`, 'mail', { view: 'mail', list: viewList(v.view) }));
    for (const b of db.mail.mailboxes.values()) {
      if (holdsOnlyMailboxes(b, db.mail.mailboxes.values())) continue;
      const acc = db.mail.accounts.get(b.accountId);
      out.push({ key: b.id, label: b.path.replace(/\//g, ' / '), sub: `Mailbox${acc ? ` · ${acc.address ?? acc.label}` : ''}`, icon: <Icon name="folder" size={18} />, to: { view: 'mail', list: mailboxList(b.id) }, last: 0, track: 'row (mailbox)' });
    }
  }
  const online = [...db.accounts.values()].filter((a) => a.status === 'online');
  if (online.some((a) => a.capabilities.includes('openDirect'))) out.push(action('a:new', 'New message', 'Start a direct conversation', 'plus', { kind: 'new', mode: 'message' }));
  // Joining and adding (docs/add.md): New's pages, which say plainly what each account cannot do yet.
  if (online.length) {
    out.push(action('a:join', 'Join a server or group', 'From an invite link or address', 'link', { kind: 'new', mode: 'join' }));
    out.push(action('a:add', 'Add someone', 'By username, handle or phone', 'user', { kind: 'new', mode: 'add' }));
    if (NEW_GROUP) out.push({ ...action('a:group', 'New group', 'Pick people across your accounts, then where', 'groups', NEW_GROUP), also: ['group chat', 'gc', 'make a group'] });
    if (addableGroups().length) out.push(action('a:add-people', 'Add people to a group', 'Pick a group, then the people', 'userPlus', { kind: 'groups' }));
    out.push(action('a:scan', 'Scan a code', 'An invite or a profile, with the camera or a picture', 'scan', { kind: 'scan' }));
    out.push(action('a:mine', 'My code', "Your accounts' codes, for someone to scan", 'qr', { kind: 'mine' }));
  }
  for (const { person, last } of people())
    out.push({ key: person.id, label: person.name, sub: 'Person', icon: <Avatar id={person.id} name={person.name} url={person.avatar} size={24} />, to: { view: 'people', person: person.id }, last, score: scoreOf(directsOf(person.id).map((d) => d.id)), track: 'row (person)' });
  for (const s of allCommunities()) out.push({ key: s.id, label: s.name, sub: `${netName(s.network)} community`, icon: <Avatar id={s.id} name={s.name} url={s.icon} size={24} square network={s.network} />, to: { view: 'space', space: s.id }, last: 0, track: 'row (community)' });
  for (const f of db.folders) out.push({ key: f.id, label: f.name, sub: 'Folder', icon: <Icon name="folder" size={18} />, to: { view: 'folder', folder: f.id }, last: 0, track: 'row (folder)' });
  for (const c of db.conversations.values()) {
    if (!visibleConv(c) || c.shape === 'direct') continue;
    const com = communitiesOf(c)[0];
    out.push({ key: c.id, label: c.shape === 'channel' ? convLabel(c) : convTitle(c), sub: com ? com.name : netName(c.network), icon: <NetGlyph network={c.network as P.Network} size={16} />, to: homeRoute(c), last: c.lastMessageAt ?? 0, score: scoreOf([c.id]), track: 'row (place)' });
  }
  return out;
}

/** The top of the inbox as it is on screen, a DM as its person. */
const inboxTop = () => shownInbox('all').map((r) => (r.kind === 'mail' ? r.key : r.conv.shape === 'direct' && r.conv.peerPersonId ? r.conv.peerPersonId : r.conv.id));

export function RootPage({ e }: { e: Entry }) {
  // Taken once as it opens: nothing moves under the pointer while it is open.
  const all = useMemo(items, []);
  const top = useMemo(inboxTop, []);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  const needle = e.q.trim();
  const take = (i: Item) => {
    if (i.page) return pushPage(i.page);
    closePalette();
    go(i.to!);
  };
  const rows: Row[] = rootKeys(all, needle, top).map((key): Row => {
    if (key === JOIN) {
      // An invite link or address typed or pasted here: Join it, first, so Enter takes it. Read here only: New asks the network.
      const invite = parseAdd(needle).find(joinsSomething)!;
      return { key, label: `Join ${describeAddRef(invite)}`, sub: 'Join', icon: <Icon name="link" size={18} />, track: 'row (join)', run: () => pushPage({ kind: 'new', mode: 'join' }, needle) };
    }
    if (key === SEARCH) return { key, label: `Search messages for “${needle}”`, sub: 'Search', icon: <Icon name="search" size={18} />, track: 'row (search)', run: () => take({ to: { view: 'search', q: needle } } as Item) };
    if (key === NEW) return { key, label: 'New…', sub: 'Message, join, add, scan', icon: <Icon name="plus" size={18} />, track: 'row (new)', run: () => pushPage({ kind: 'new' }) };
    const i = byKey.get(key)!;
    return { key, label: i.label, sub: i.sub, icon: i.icon, track: i.track, run: () => take(i) };
  });
  return <Frame e={e} placeholder="Jump to a person, channel or server" typing rows={rows} listLabel="Jump to" />;
}
