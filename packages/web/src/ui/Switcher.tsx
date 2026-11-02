/** Ctrl+K: type a few letters, land anywhere. Works from what the client already holds, so it answers instantly. */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { allCommunities, communitiesOf, convLabel, convTitle, netName, people, visibleConv } from '../model.ts';
import { db, go, newMessage, type Route } from '../state.ts';
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
  act?: () => void;
}

function items(): Item[] {
  const out: Item[] = [
    { key: 'v:inbox', label: 'Inbox', sub: 'View', icon: <Icon name="inbox" size={18} />, to: { view: 'inbox' }, last: 0 },
    { key: 'v:directory', label: 'All communities and groups', sub: 'View', icon: <Icon name="grid" size={18} />, to: { view: 'directory' }, last: 0 },
    { key: 'v:settings', label: 'Settings', sub: 'View', icon: <Icon name="settings" size={18} />, to: { view: 'settings' }, last: 0 },
    { key: 'v:accounts', label: 'Accounts', sub: 'View', icon: <Icon name="power" size={18} />, to: { view: 'accounts' }, last: 0 },
  ];
  if ([...db.accounts.values()].some((a) => a.status === 'online' && a.capabilities.includes('openDirect'))) out.push({ key: 'a:new', label: 'New message', sub: 'Start a direct conversation', icon: <Icon name="plus" size={18} />, to: { view: 'inbox' }, last: 0, act: () => (newMessage.value = {}) });
  for (const { person, last } of people()) out.push({ key: person.id, label: person.name, sub: 'Person', icon: <Avatar id={person.id} name={person.name} url={person.avatar} size={24} />, to: { view: 'people', person: person.id }, last });
  for (const s of allCommunities()) out.push({ key: s.id, label: s.name, sub: `${netName(s.network)} community`, icon: <Avatar id={s.id} name={s.name} url={s.icon} size={24} square network={s.network} />, to: { view: 'space', space: s.id }, last: 0 });
  for (const f of db.folders) out.push({ key: f.id, label: f.name, sub: 'Folder', icon: <Icon name="folder" size={18} />, to: { view: 'folder', folder: f.id }, last: 0 });
  for (const c of db.conversations.values()) {
    if (!visibleConv(c) || c.shape === 'direct') continue;
    const com = communitiesOf(c)[0];
    out.push({ key: c.id, label: c.shape === 'channel' ? convLabel(c) : convTitle(c), sub: com ? com.name : netName(c.network), icon: <NetGlyph network={c.network as P.Network} size={16} />, to: homeRoute(c), last: c.lastMessageAt ?? 0 });
  }
  return out;
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
  useEffect(() => box.current?.focus(), []);
  const close = () => (switcherOpen.value = false);
  useLayer(close);
  const needle = q.trim();
  const found = all
    .map((i) => ({ i, s: fuzzyScore(`${i.label}`, needle) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s! || b.i.last - a.i.last)
    .slice(0, 9)
    .map((x) => x.i);
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
            <button class={`switcher-row ${i === at ? 'active' : ''}`} onClick={() => pick(r)} onMouseEnter={() => setSel(i)}>
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
