/** Ctrl+K: type a few letters, land anywhere. Works from what the client already holds, so it answers instantly. */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { allCommunities, communitiesOf, convLabel, convTitle, directsOf, netName, people, visibleConv } from '../model.ts';
import { shownInbox } from '../inbox.ts';
import { switcherOrder } from '../ordering.ts';
import { db, go, newMessage, type Route } from '../state.ts';
import { describeAddRef, joinsSomething, mailboxList, parseAdd, viewList } from '@dither-chat/protocol';
import { MAIL_VIEWS } from '../mail/model.ts';
import { useLayer } from '../phone.ts';
import { Avatar, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { homeRoute } from './Sidebar.tsx';

export const switcherOpen = signal(false);

/** Word starts beat prefixes of the whole name beat scattered letters. Null when the letters are not all there in order. */
export function fuzzyScore(name: string, needle: string): number | null {
  const n = name.toLowerCase();
  const q = needle.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 1000 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) return (/[^\p{L}\p{N}]/u.test(n[at - 1] ?? ' ') ? 800 : 500) - n.length;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = n.indexOf(ch, i);
    if (j < 0) return null;
    gaps += j - i;
    i = j + 1;
  }
  return 200 - gaps - n.length;
}

interface Item {
  key: string;
  label: string;
  sub: string;
  icon: any;
  to: Route;
  last: number;
  /** The inbox's score (docs/inbox.md): a person's is their best DM's. */
  score?: number | null;
  act?: () => void;
}

const scoreOf = (ids: string[]) => {
  const s = ids.map((id) => db.attention.get(id)?.score).filter((x): x is number => x !== undefined);
  return s.length ? Math.max(...s) : null;
};

function items(): Item[] {
  const out: Item[] = [
    { key: 'v:inbox', label: 'Inbox', sub: 'View', icon: <Icon name="inbox" size={18} />, to: { view: 'inbox' }, last: 0 },
    { key: 'v:directory', label: 'All communities and groups', sub: 'View', icon: <Icon name="grid" size={18} />, to: { view: 'directory' }, last: 0 },
    { key: 'v:settings', label: 'Settings', sub: 'View', icon: <Icon name="settings" size={18} />, to: { view: 'settings' }, last: 0 },
    { key: 'v:accounts', label: 'Accounts', sub: 'View', icon: <Icon name="power" size={18} />, to: { view: 'accounts' }, last: 0 },
  ];
  // Mail, its views and each account's mailboxes (docs/mail.md).
  if (db.mail.access.state !== 'off') {
    out.push({ key: 'v:mail', label: 'Mail', sub: 'View', icon: <Icon name="mail" size={18} />, to: { view: 'mail' }, last: 0 });
    for (const v of MAIL_VIEWS.slice(1)) out.push({ key: `v:mail:${v.view}`, label: `Mail: ${v.label}`, sub: 'View', icon: <Icon name="mail" size={18} />, to: { view: 'mail', list: viewList(v.view) }, last: 0 });
    for (const b of db.mail.mailboxes.values()) {
      const acc = db.mail.accounts.get(b.accountId);
      out.push({ key: b.id, label: b.path.replace(/\//g, ' / '), sub: `Mailbox${acc ? ` · ${acc.address ?? acc.label}` : ''}`, icon: <Icon name="folder" size={18} />, to: { view: 'mail', list: mailboxList(b.id) }, last: 0 });
    }
  }
  if ([...db.accounts.values()].some((a) => a.status === 'online' && a.capabilities.includes('openDirect'))) out.push({ key: 'a:new', label: 'New message', sub: 'Start a direct conversation', icon: <Icon name="plus" size={18} />, to: { view: 'inbox' }, last: 0, act: () => (newMessage.value = {}) });
  // Joining and adding (docs/add.md): the same box, which says plainly what each account cannot do yet.
  if ([...db.accounts.values()].some((a) => a.status === 'online')) {
    out.push({ key: 'a:join', label: 'Join a server or group', sub: 'From an invite link or address', icon: <Icon name="link" size={18} />, to: { view: 'inbox' }, last: 0, act: () => (newMessage.value = { mode: 'join' }) });
    out.push({ key: 'a:add', label: 'Add someone', sub: 'By username, handle or phone', icon: <Icon name="user" size={18} />, to: { view: 'inbox' }, last: 0, act: () => (newMessage.value = { mode: 'add' }) });
  }
  for (const { person, last } of people())
    out.push({ key: person.id, label: person.name, sub: 'Person', icon: <Avatar id={person.id} name={person.name} url={person.avatar} size={24} />, to: { view: 'people', person: person.id }, last, score: scoreOf(directsOf(person.id).map((d) => d.id)) });
  for (const s of allCommunities()) out.push({ key: s.id, label: s.name, sub: `${netName(s.network)} community`, icon: <Avatar id={s.id} name={s.name} url={s.icon} size={24} square network={s.network} />, to: { view: 'space', space: s.id }, last: 0 });
  for (const f of db.folders) out.push({ key: f.id, label: f.name, sub: 'Folder', icon: <Icon name="folder" size={18} />, to: { view: 'folder', folder: f.id }, last: 0 });
  for (const c of db.conversations.values()) {
    if (!visibleConv(c) || c.shape === 'direct') continue;
    const com = communitiesOf(c)[0];
    out.push({ key: c.id, label: c.shape === 'channel' ? convLabel(c) : convTitle(c), sub: com ? com.name : netName(c.network), icon: <NetGlyph network={c.network as P.Network} size={16} />, to: homeRoute(c), last: c.lastMessageAt ?? 0, score: scoreOf([c.id]) });
  }
  return out;
}

/** With nothing typed: the top of the inbox as it is on screen, a DM as its person; then the rest by the latest message. */
function opening(all: Item[]): Item[] {
  const byKey = new Map(all.map((i) => [i.key, i]));
  const keys = new Set(shownInbox('all').map((r) => (r.kind === 'mail' ? r.key : r.conv.shape === 'direct' && r.conv.peerPersonId ? r.conv.peerPersonId : r.conv.id)));
  const top = [...keys].map((k) => byKey.get(k)).filter((i): i is Item => !!i);
  const rest = all.filter((i) => !keys.has(i.key)).sort((a, b) => b.last - a.last);
  return [...top, ...rest].slice(0, 9);
}

export function Switcher() {
  const open = switcherOpen.value;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        switcherOpen.value = !switcherOpen.value;
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return open ? <SwitcherBox /> : null;
}

function SwitcherBox() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const all = useMemo(items, []);
  const first = useMemo(() => opening(all), [all]);
  useEffect(() => box.current?.focus(), []);
  const close = () => (switcherOpen.value = false);
  useLayer(close);
  const needle = q.trim();
  // How well the name matches, times how likely you are to want it now (the inbox's score).
  const byKey = new Map(all.map((i) => [i.key, i]));
  const matched = needle
    ? all.flatMap((i) => {
        const match = fuzzyScore(i.label, needle);
        return match === null ? [] : [{ key: i.key, match, score: i.score ?? null, last: i.last }];
      })
    : [];
  const found = needle ? switcherOrder(matched).slice(0, 9).map((k) => byKey.get(k)!) : first;
  // An invite link or address typed or pasted here: Join it, first, so Enter takes it. Read here only; the box asks the network.
  const invite = parseAdd(needle).find(joinsSomething);
  if (invite) found.unshift({ key: 'join', label: `Join ${describeAddRef(invite)}`, sub: 'Join', icon: <Icon name="link" size={18} />, to: { view: 'inbox' }, last: 0, act: () => (newMessage.value = { q: needle, mode: 'join' }) });
  const rows: Item[] = needle ? [...found, { key: 'search', label: `Search messages for “${needle}”`, sub: 'Search', icon: <Icon name="search" size={18} />, to: { view: 'search', q: needle }, last: 0 }] : [...found];
  const at = Math.min(sel, rows.length - 1);
  const pick = (i: Item | undefined) => {
    if (!i) return;
    close();
    if (i.act) i.act();
    else go(i.to);
  };
  return (
    <div class="modal-backdrop switcher-back" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="switcher" role="dialog" aria-label="Jump to">
        <input
          ref={box}
          class="switcher-input"
          placeholder="Jump to a person, channel or server"
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((at + 1) % rows.length));
            if (e.key === 'ArrowUp') (e.preventDefault(), setSel((at - 1 + rows.length) % rows.length));
            if (e.key === 'Enter') pick(rows[at]);
          }}
        />
        <div class="switcher-list">
          {rows.map((r, i) => (
            <button class={`switcher-row ${i === at ? 'active' : ''}`} data-key={r.key} onClick={() => pick(r)} onMouseEnter={() => setSel(i)}>
              <span class="switcher-icon">{r.icon}</span>
              <span class="switcher-label">{r.label}</span>
              <small>{r.sub}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
