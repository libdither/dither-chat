/**
 * A person you reach through several of your accounts (docs/chats.md): every pair of your account and theirs is a
 * route, and the person page shows them as one chat.
 *
 * All chats together by default: each run of one pair is a chunk, with a label at its top (the network's icon, their
 * name there, yours) and a bar down its side. The dropdown on the name's line (press and drag to a pair, or click)
 * shows one pair's history alone. The message box's line says where a message goes, and on a computer switches it.
 *
 * Where a message goes, first to last: the pair you picked on this page; where you came from (from a Discord group on
 * one of your accounts, the DM through that account); the route you chose last time (the hub keeps it, chats.ts);
 * the pair of the latest message.
 */
import type * as P from '@dither-chat/protocol';
import { effect, signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hueOf, initials } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, isSelfIdentity, prefs, route, setPrefs, toast } from '../state.ts';
import { Avatar, Menu, NetBadge } from './bits.tsx';

// ------------------------------------------------------------------ pairs

export interface Pair {
  conv: P.ConversationView;
  acc: P.AccountView | null;
  /** Your identity on that account. */
  mine: P.IdentityView | null;
  /** Theirs in the conversation. */
  theirs: P.IdentityView | null;
}

export function pairOf(conv: P.ConversationView): Pair {
  const acc = conv.vantages.map((v) => db.accounts.get(v.accountId)).find((a): a is P.AccountView => !!a) ?? null;
  const mine = acc?.selfIdentityId ? (db.identities.get(acc.selfIdentityId) ?? null) : null;
  const peer = conv.participantIds.find((p) => !isSelfIdentity(p));
  const theirs = peer ? (db.identities.get(peer) ?? null) : null;
  return { conv, acc, mine, theirs };
}

/** Their name on the network: the username, or the profile name where the handle is a phone number (Signal, WhatsApp). */
export const theirName = (p: Pair) => {
  const h = p.theirs?.handle;
  if (h && /^\+?[\d\s()-]{6,}$/.test(h) && p.theirs?.displayName) return p.theirs.displayName;
  return h ?? p.theirs?.displayName ?? netName(p.conv.network);
};
export const myName = (p: Pair) => p.acc?.label || identityName(p.mine?.id) || 'you';

/** The pair picked on this page, per person, this session. */
const picked = signal<Record<string, string>>({});

/** What the hub says of each person's chat (GET /api/chats/person:<id>): the route chosen last time, if any. */
export const chats = signal<Record<string, P.ChatView>>({});

/** Ask the hub for a person's chat again: on opening their page, so a route chosen on another device counts. */
export async function loadChat(personId: string) {
  const c = await api<P.ChatView>(`/api/chats/person:${personId}`).catch(() => null);
  if (!c) return;
  chats.value = { ...chats.value, [personId]: c };
  // A route this browser kept before the hub kept them (prefs.via, a conversation id): moved there once.
  const old = prefs.value.via[personId];
  if (old !== undefined) {
    const { [personId]: _, ...rest } = prefs.value.via;
    setPrefs({ via: rest });
    const r = c.routes.find((x) => x.conversationId === old);
    if (r && c.route?.why !== 'chosen') void chooseRoute(personId, r.conversationId, r.accountId);
  }
}

async function chooseRoute(personId: string, conversationId: string, accountId: string) {
  const c = await api<P.ChatView>(`/api/chats/person:${personId}`, { method: 'PATCH', body: { route: { conversationId, accountId } } }).catch(() => null);
  if (c) chats.value = { ...chats.value, [personId]: c };
}

/** The last conversation open before this page: where you came from, to guess which of your accounts to send as. */
const cameFrom = signal<string | null>(null);
if (typeof window !== 'undefined')
  effect(() => {
    const r = route.value as { view: string; conv?: string };
    if (r.view !== 'people' && r.conv) cameFrom.value = r.conv;
  });

/** Where a message to them goes now (the module's comment says in what order). */
export function focusedPair(personId: string, directs: P.ConversationView[]): P.ConversationView {
  const id = picked.value[personId];
  const hit = id && directs.find((d) => d.id === id);
  if (hit) return hit;
  const latest = (xs: P.ConversationView[]) => [...xs].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0];
  const from = cameFrom.value ? db.conversations.get(cameFrom.value) : null;
  if (from) {
    // Their DM itself; else a DM through the account you were reading on; else one on that network.
    const same = directs.find((d) => d.id === from.id);
    if (same) return same;
    const accs = new Set(from.vantages.map((v) => v.accountId));
    const viaAcc = directs.filter((d) => d.vantages.some((v) => accs.has(v.accountId)));
    if (viaAcc.length) return latest(viaAcc);
    const onNet = directs.filter((d) => d.network === from.network);
    if (onNet.length) return latest(onNet);
  }
  const chosen = chats.value[personId]?.route;
  const kept = chosen?.why === 'chosen' && directs.find((d) => d.id === chosen.conversationId);
  if (kept) return kept;
  return latest(directs);
}

/**
 * Send through a pair from now on: here at once, and the hub keeps it as the chat's route for next time. A draft typed
 * for the old pair moves along, so switching mid-sentence keeps the sentence.
 */
export function focusPair(personId: string, from: string | null, to: string) {
  if (from && from !== to) {
    try {
      const k = (id: string) => `dither-chat:draft:${id}`;
      const draft = localStorage.getItem(k(from));
      if (draft && !localStorage.getItem(k(to))) {
        localStorage.setItem(k(to), draft);
        localStorage.removeItem(k(from));
      }
    } catch {}
  }
  picked.value = { ...picked.value, [personId]: to };
  const conv = db.conversations.get(to);
  const acc = conv && pairOf(conv).acc;
  const cur = chats.value[personId]?.route;
  if (acc && !(cur?.why === 'chosen' && cur.conversationId === to && cur.accountId === acc.id)) void chooseRoute(personId, to, acc.id);
}

/** Your account: its picture, else its colour and initials (your accounts' pictures often look alike), and its network. */
function MyPicture({ p, size }: { p: Pair; size: number }) {
  const name = myName(p);
  if (p.mine?.avatar) return <Avatar id={p.acc?.id ?? p.conv.id} name={name} url={p.mine.avatar} size={size} network={p.conv.network} />;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }}>
      <span class="avatar-fallback" style={{ borderRadius: `${size / 2}px`, background: p.acc?.color ?? hueOf(p.conv.id), color: '#14161d', fontSize: `${Math.max(9, Math.round(size * 0.38))}px` }}>
        {initials(name.replace(/^[@+]/, ''))}
      </span>
      <NetBadge network={p.conv.network} size={Math.max(11, Math.round(size * 0.5))} class="avatar-net" />
    </span>
  );
}

/** A name in the message box's line that changes the pair: cycles between two, lists more. */
function Token({ label, options, onPick, picture }: { label: string; options: { id: string; label: string; picture?: ComponentChildren }[]; onPick: (id: string) => void; picture?: ComponentChildren }) {
  const cur = options.findIndex((o) => o.label === label);
  // On a phone the line only says where it goes: a tap in the box is for typing, not for switching accounts.
  if (options.length < 2 || phone.value)
    return (
      <span class="pair-token fixed">
        {picture}
        {label}
      </span>
    );
  if (options.length === 2)
    return (
      <button class="pair-token" title={`Switch to ${options[(cur + 1) % 2].label}`} onClick={() => onPick(options[(cur + 1) % 2].id)}>
        {picture}
        {label}
      </button>
    );
  return (
    <Menu
      up
      trigger={(toggle) => (
        <button class="pair-token" title="Choose" onClick={toggle} aria-haspopup="menu">
          {picture}
          {label}
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu pair-menu">
          {options.map((o) => (
            <button
              class={`menu-item ${o.label === label ? 'on' : ''}`}
              onClick={() => {
                onPick(o.id);
                close();
              }}
            >
              {o.picture}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

/** "Message Kit (kit.exe) from zyansheep": both names switch. In the box while it is empty, on its edge once typed in. */
export function PairLead({ person, personId, directs, focus }: { person: P.PersonView; personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const pairs = directs.map(pairOf);
  const cur = pairOf(focus);
  // Theirs you can reach, each once; picking one keeps your account when it talks with them too.
  const theirs: Pair[] = [];
  for (const p of pairs) if (!theirs.some((x) => x.theirs?.id === p.theirs?.id)) theirs.push(p);
  const pickTheirs = (identityId: string) => {
    const withThem = pairs.filter((p) => p.theirs?.id === identityId);
    const next = withThem.find((p) => p.acc?.id === cur.acc?.id) ?? withThem.sort((a, b) => (b.conv.lastMessageAt ?? 0) - (a.conv.lastMessageAt ?? 0))[0];
    if (next) focusPair(personId, focus.id, next.conv.id);
  };
  const mine = pairs.filter((p) => p.theirs?.id === cur.theirs?.id);
  const theirLabel = (p: Pair) => `${netName(p.conv.network)} ${theirName(p)}`;
  // A phone has room for the two names only.
  const short = phone.value;
  // Their name there in brackets, unless it is the name already shown.
  const curLabel = short || theirName(cur) === person.name ? theirName(cur) : `${person.name} (${theirName(cur)})`;
  return (
    <span class="pair-lead-line">
      {short ? 'To' : 'Message'}{' '}
      <Token
        label={curLabel}
        options={theirs.map((p) => ({ id: p.theirs?.id ?? p.conv.id, label: p.theirs?.id === cur.theirs?.id ? curLabel : theirLabel(p), picture: <Avatar id={p.theirs?.id ?? p.conv.id} name={theirName(p)} url={p.theirs?.avatar} size={16} network={p.conv.network} /> }))}
        onPick={pickTheirs}
      />{' '}
      from{' '}
      <Token
        label={myName(cur)}
        picture={<MyPicture p={cur} size={16} />}
        options={mine.map((p) => ({ id: p.conv.id, label: myName(p), picture: <MyPicture p={p} size={16} /> }))}
        onPick={(id) => focusPair(personId, focus.id, id)}
      />
    </span>
  );
}

/** The person's name: click the pencil to give them a nickname, or to take it away (this hub only, nobody is told). */
export function Nickname({ person, onOpen }: { person: P.PersonView; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  // Left empty, the nickname goes: they are called what their accounts say again.
  const save = async (name: string) => {
    setEditing(false);
    const v = name.trim();
    if (v === person.name || (!v && person.nameSource !== 'user')) return;
    await api(`/api/chats/person:${person.id}`, { method: 'PATCH', body: { name: v || null } }).catch((e) => toast({ kind: 'error', title: 'Could not save that', body: e.message }));
  };
  if (editing)
    return (
      <input
        class="pair-nick-input"
        value={person.nameSource === 'user' ? person.name : ''}
        placeholder={person.name}
        aria-label="Nickname"
        title="Leave it empty to call them what their accounts say"
        ref={(el) => {
          if (el && document.activeElement !== el) {
            el.focus();
            el.select();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save((e.target as HTMLInputElement).value);
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => void save((e.target as HTMLInputElement).value)}
      />
    );
  return (
    <>
      <button class="conv-head-name" title={`${person.name}'s profile`} onClick={onOpen}>
        {person.name}
      </button>
      <button class="pair-nick-edit" title={person.nameSource === 'user' ? 'Change or remove the nickname (only you see it)' : 'Give them a nickname (only you see it)'} aria-label="Nickname" onClick={() => setEditing(true)}>
        ✎
      </button>
    </>
  );
}

// ------------------------------------------------------------------ the page's parts

/** What the person page shows, per person this session: every chat (the default) or one pair's. */
const viewing = signal<Record<string, string>>({});
export const viewOf = (personId: string, directs: P.ConversationView[]) => {
  const v = viewing.value[personId];
  return v && directs.some((d) => d.id === v) ? v : 'all';
};

/** A pair as a line: the network's icon, their name there, ⇄, yours. */
function PairLine({ p, size = 16 }: { p: Pair; size?: number }) {
  return (
    <>
      <NetBadge network={p.conv.network} size={size} />
      <span class="pair-line-theirs">{theirName(p)}</span>
      <span class="pair-line-arrow">⇄</span>
      <span class="pair-line-mine">{myName(p)}</span>
    </>
  );
}

/**
 * On the name's line: all chats, or one pair's. Press and drag down to a row and let go to pick it, or click to open
 * and click a row.
 */
export function PairDropdown({ personId, directs, focus }: { personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  // The header clips what overflows it, so the list is placed on the page, under the button.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, innerWidth - 320)), top: r.bottom + 4 });
    setOpen(true);
  };
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pairs = directs.map(pairOf).sort((a, b) => a.conv.network.localeCompare(b.conv.network) || theirName(a).localeCompare(theirName(b)) || myName(a).localeCompare(myName(b)));
  const v = viewOf(personId, directs) === 'all' ? 'all' : focus.id;
  const cur = v === 'all' ? null : pairOf(directs.find((d) => d.id === v)!);
  const pick = (id: string) => {
    setOpen(false);
    setHover(null);
    viewing.value = { ...viewing.value, [personId]: id };
    if (id !== 'all') focusPair(personId, focus.id, id);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const rowAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-pair-row]')?.dataset.pairRow ?? null;
  return (
    <div class="pair-dd" ref={root}>
      <button
        ref={btn}
        class={`pair-dd-btn ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Which chats to show. Press and drag to pick, or click"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          press.current = { x: e.clientX, y: e.clientY, moved: false };
          try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {}
          if (!open) show();
          else press.current = null;
          // Moves and the release are followed on the document, so the drag can end on a row.
          const move = (ev: PointerEvent) => {
            if (!press.current) return;
            if (Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 6) press.current.moved = true;
            setHover(rowAt(ev.clientX, ev.clientY));
          };
          const up = (ev: PointerEvent) => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            const p0 = press.current;
            press.current = null;
            if (!p0) {
              setOpen(false);
              return;
            }
            const row = rowAt(ev.clientX, ev.clientY);
            if (p0.moved && row) pick(row);
            else if (p0.moved) setOpen(false);
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            show();
          }
        }}
      >
        {cur ? (
          <PairLine p={cur} size={16} />
        ) : (
          <span class="pair-dd-all">
            All chats <span class="pair-dd-count">{directs.length}</span>
          </span>
        )}
        <span class="pair-dd-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div class="pair-dd-menu" role="listbox" aria-label="Show" style={at ? { left: `${at.left}px`, top: `${at.top}px` } : undefined}>
          <button role="option" aria-selected={v === 'all'} data-pair-row="all" class={`pair-dd-row ${v === 'all' ? 'on' : ''} ${hover === 'all' ? 'hover' : ''}`} onClick={() => pick('all')}>
            <span class="pair-dd-all">All chats together</span>
            <span class="pair-dd-count">{directs.length}</span>
          </button>
          {pairs.map((p) => {
            const unread = p.conv.vantages.reduce((n, x) => n + x.unread, 0);
            return (
              <button role="option" aria-selected={v === p.conv.id} data-pair-row={p.conv.id} class={`pair-dd-row ${v === p.conv.id ? 'on' : ''} ${hover === p.conv.id ? 'hover' : ''}`} onClick={() => pick(p.conv.id)}>
                <PairLine p={p} size={18} />
                <span class="pair-dd-net">{netName(p.conv.network)}</span>
                {unread > 0 && <span class="pair-dd-unread">{unread}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The top of a chunk: whose accounts these messages went between. Click to send there. */
export function ChunkHead({ p, focused, onPick }: { p: Pair; focused: boolean; onPick: () => void }) {
  return (
    <div class={`pair-chunk-head ${focused ? 'on' : 'off'}`}>
      <button title={focused ? `Sending as ${myName(p)} to ${theirName(p)}` : `Send as ${myName(p)} to ${theirName(p)}`} onClick={onPick}>
        <PairLine p={p} size={16} />
        {focused && <span class="pair-chunk-sending">sending here</span>}
      </button>
    </div>
  );
}

/** Whether you gave them a nickname: then it shows in place of the names their accounts go by, which move aside. */
export function hasNickname(person: P.PersonView | null | undefined): boolean {
  return !!person && !person.isSelf && person.nameSource === 'user';
}
