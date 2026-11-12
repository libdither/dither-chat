/**
 * A person you reach through several routes (docs/chats.md): every pair of your account and theirs is a route, and
 * their chat is one page over them all, interleaved. It is the page any conversation has (Timeline.tsx's PersonChat),
 * and these are the parts it adds. Each adds only what the chat needs: chatroutes.ts says, for a route among the
 * chat's, what tells it apart (the network, their account, yours), and every part here asks it.
 *
 * Where a message goes, first to last: the route you picked on this page (a tag in the timeline, the message box's
 * line, the list under the name); the DM the page was opened as; where you came from (from a Discord group on one of
 * your accounts, the DM through that account); the route you chose last time (the hub keeps it, chats.ts); the route
 * of the latest message.
 */
import type * as P from '@dither-chat/protocol';
import { effect, signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { badgeDiffers, headIdents, leadTells, tagTells, tagText, tells, type HeadName, type RouteKey, type Side } from '../chatroutes.ts';
import { ago, hueOf, initials } from '../format.ts';
import { identityName, netColor, netName, visibleAccount } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, go, isSelfIdentity, prefs, route, setPrefs, toast } from '../state.ts';
import { AccountChip, Avatar, Count, Menu, NetBadge, NetGlyph } from './bits.tsx';

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

/** A handle that is a phone number (Signal, WhatsApp): never shown beside a name. */
const PHONE = /^\+?[\d\s()-]{6,}$/;

/** Their name on the network: the username, or the profile name where the handle is a phone number (Signal, WhatsApp). */
export const theirName = (p: Pair) => {
  const h = p.theirs?.handle;
  if (h && PHONE.test(h) && p.theirs?.displayName) return p.theirs.displayName;
  return h ?? p.theirs?.displayName ?? netName(p.conv.network);
};
export const myName = (p: Pair) => p.acc?.label || identityName(p.mine?.id) || 'you';

/** A route as chatroutes.ts sees it. */
export function routeKey(c: P.ConversationView): RouteKey {
  const p = pairOf(c);
  return { id: c.id, network: c.network, theirs: p.theirs?.id ?? null, mine: p.acc?.id ?? null };
}

/** What tells this route from the chat's others (chatroutes.ts). */
/** Whether message pictures carry the network's badge in this chat: only when it would differ between its routes. */
export const badgeShows = (directs: P.ConversationView[]) => badgeDiffers(directs.map(routeKey));

/** A route said in full, for a title: "Send as zyn.alt to kit.work on Discord". */
export function routeTitle(c: P.ConversationView): string {
  const p = pairOf(c);
  return `Send as ${myName(p)} to ${theirName(p)} on ${netName(c.network)}`;
}

/**
 * Where the route changes in the timeline, after the time on the message's head line: what of the route the head has
 * not already said (chatroutes.ts tagTells), quietly. The head names the author's account, so after their message
 * it is your account where yours differ (`via zyn.alt`), after yours theirs (`to kit.work`), and the network's icon
 * where networks mix. Nothing left to say, no tag. A click sends through it.
 */
export function RouteTag({ c, directs, side, onPick }: { c: P.ConversationView; directs: P.ConversationView[]; side: Side; onPick: () => void }) {
  const t = tagTells(routeKey(c), directs.map(routeKey), side);
  const p = pairOf(c);
  const text = tagText(t, { network: netName(c.network), theirs: theirName(p), mine: myName(p) }, side);
  if (!t.network && !text) return null;
  return (
    <button class="route-tag" data-track="route tag" title={routeTitle(c)} aria-label={routeTitle(c)} onClick={onPick}>
      {t.network && <NetGlyph network={c.network} size={10} />}
      {text && <span class="route-label">{text}</span>}
    </button>
  );
}

/**
 * How the message heads of a chat name each account in it, theirs and yours: the account's own name (its display
 * name, else handle, else id), and its identifier after it, muted, where another account on the same side would show
 * the same name (chatroutes.ts headIdents). Keyed by identity. Someone else in a DM (a bot) is not in it.
 */
export function headNames(convIds: string[]): Map<string, { name: string; ident?: string }> {
  const theirs: HeadName[] = [];
  const mine: HeadName[] = [];
  const head = (i: P.IdentityView): HeadName => ({ id: i.id, network: i.network, name: identityName(i.id), ident: i.handle ?? i.nativeId });
  for (const id of convIds) {
    const c = db.conversations.get(id);
    if (!c) continue;
    const p = pairOf(c);
    if (p.theirs) theirs.push(head(p.theirs));
    if (p.mine) mine.push(head(p.mine));
  }
  const out = new Map<string, { name: string; ident?: string }>();
  for (const side of [theirs, mine]) {
    const idents = headIdents(side);
    for (const a of side) out.set(a.id, idents.has(a.id) ? { name: a.name, ident: idents.get(a.id) } : { name: a.name });
  }
  return out;
}

/**
 * The route picked on this page, per person, this session, and the address it was picked at: a pick holds while the
 * page stays at that address, and the address wins once it changes (opening another of their DMs sends through it).
 */
const picked = signal<Record<string, { to: string; at: string }>>({});

/** The route picked this session, if it is still one of theirs: where the inbox's row for them opens. */
export function pickedRoute(personId: string, directs: P.ConversationView[]): string | null {
  const p = picked.value[personId];
  return p && directs.some((d) => d.id === p.to) ? p.to : null;
}

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

/** Where a message to them goes now (the module's comment says in what order). `at`: the DM the page was opened as. */
export function focusedPair(personId: string, directs: P.ConversationView[], at?: string): P.ConversationView {
  const p = picked.value[personId];
  const hit = p && p.at === (at ?? '') && directs.find((d) => d.id === p.to);
  if (hit) return hit;
  const opened = at && directs.find((d) => d.id === at);
  if (opened) return opened;
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
 * Send through a route from now on: here at once, and the hub keeps it as the chat's route for next time. A draft
 * typed for the old route moves along, so switching mid-sentence keeps the sentence. `at`: the DM the page was
 * opened as, if it was.
 */
export function focusPair(personId: string, from: string | null, to: string, at?: string) {
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
  picked.value = { ...picked.value, [personId]: { to, at: at ?? '' } };
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
      <button class="pair-token" data-track="send through" title={`Switch to ${options[(cur + 1) % 2].label}`} onClick={() => onPick(options[(cur + 1) % 2].id)}>
        {picture}
        {label}
      </button>
    );
  return (
    <Menu
      up
      trigger={(toggle) => (
        <button class="pair-token" data-track="send through" title="Choose" onClick={toggle} aria-haspopup="menu">
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
              data-track="send through (choice)"
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

/**
 * Where a message goes, by the same rule as the tags and no more: "Message Kit on Signal", "Message Kit on Discord
 * (kit.work)", and "from zyn.alt" only when the account of theirs it goes to can be reached from several of yours
 * (chatroutes.ts leadTells). The parts that can change switch. In the box while it is empty, on its edge once typed in.
 */
export function PairLead({ person, directs, focus, onFocus }: { person: P.PersonView; directs: P.ConversationView[]; focus: P.ConversationView; onFocus: (convId: string) => void }) {
  const keys = directs.map(routeKey);
  const pairs = directs.map(pairOf);
  const cur = pairOf(focus);
  const t = leadTells(routeKey(focus), keys);
  // Theirs you can reach, each once; picking one keeps your account when it talks with them too.
  const theirs: Pair[] = [];
  for (const p of pairs) if (!theirs.some((x) => x.theirs?.id === p.theirs?.id)) theirs.push(p);
  const pickTheirs = (identityId: string) => {
    const withThem = pairs.filter((p) => p.theirs?.id === identityId);
    const next = withThem.find((p) => p.acc?.id === cur.acc?.id) ?? withThem.sort((a, b) => (b.conv.lastMessageAt ?? 0) - (a.conv.lastMessageAt ?? 0))[0];
    if (next) onFocus(next.conv.id);
  };
  const mine = pairs.filter((p) => p.theirs?.id === cur.theirs?.id && p.conv.network === focus.network);
  const theirLabel = (p: Pair) => {
    const lt = leadTells(routeKey(p.conv), keys);
    // A phone has room for one name: their account's where it tells (`To kit.work`), else theirs on the network.
    if (phone.value && lt.theirs) return theirName(p);
    return `${person.name}${lt.network ? ` on ${netName(p.conv.network)}` : ''}${lt.theirs ? ` · to ${theirName(p)}` : ''}`;
  };
  return (
    <span class="pair-lead-line">
      {/* As the line under the name says it: "Message Kit on Discord · to kit.work · via zyn.alt"; on a phone
          "To kit.work · via zyn.alt". */}
      {phone.value ? 'To ' : 'Message '}
      <Token
        label={theirLabel(cur)}
        options={theirs.map((p) => ({ id: p.theirs?.id ?? p.conv.id, label: theirLabel(p), picture: <Avatar id={p.theirs?.id ?? p.conv.id} name={theirName(p)} url={p.theirs?.avatar} size={16} network={p.conv.network} /> }))}
        onPick={pickTheirs}
      />
      {t.mine && (
        <>
          {' · via '}
          <Token label={myName(cur)} picture={<MyPicture p={cur} size={16} />} options={mine.map((p) => ({ id: p.conv.id, label: myName(p), picture: <MyPicture p={p} size={16} /> }))} onPick={onFocus} />
        </>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ the page's parts

/** What the page shows, per person this session: every route (the default) or one route's, picked from the list. */
const viewing = signal<Record<string, string>>({});
export const viewOf = (personId: string, directs: P.ConversationView[]) => {
  const v = viewing.value[personId];
  return v && directs.some((d) => d.id === v) ? v : 'all';
};
export const setView = (personId: string, v: string) => void (viewing.value = { ...viewing.value, [personId]: v });


/**
 * The line under the name, in the same words for a direct conversation and for a person's chat: where your message
 * goes. The network (its icon and name); their account, where theirs on that network differ (`to mo.codes`); and the
 * account of yours it goes from, where you have more than one, as every conversation's header says it (`via ●
 * zyansheep`, which a narrow window leaves out everywhere).
 */
export function SendLine({ c, accounts, to }: { c: P.ConversationView; accounts: P.AccountView[]; to?: string }) {
  const via = accounts.length > 0 && (accounts.length > 1 || db.accounts.size > 1);
  return (
    <span class="send-line" style={{ '--net': netColor(c.network) } as Record<string, string>}>
      <span class="crumb net">
        <NetGlyph network={c.network} size={11} /> <span class="send-net-name">{netName(c.network)}</span>
      </span>
      {to && (
        <span class="send-to">
          <span class="send-sep">·</span> to {to}
        </span>
      )}
      {via && (
        <span class="via">
          <span class="send-sep">·</span> via
          {accounts.map((a) => (
            <AccountChip account={a} small />
          ))}
        </span>
      )}
    </span>
  );
}

/** The account of yours a route goes from, as the line under the name lists it. */
const routeAccounts = (c: P.ConversationView): P.AccountView[] => {
  const a = pairOf(c).acc;
  return a && visibleAccount(a.id) ? [a] : [];
};

const sameText = (s: string) => s.trim().toLowerCase();
const counted = (n: number, what: string) => (n > 1 ? `${n} ${what}s` : null);

interface ListRow {
  p: Pair;
  unread: number;
  last: number;
}

/**
 * Under the name of a person's chat: the line any conversation has there (where your message goes, `SendLine`), and
 * one control more, a pill of the other routes' networks and their number (`+7 ▾`), or `only this ✕` while the page
 * shows one route. The whole line opens the list: press and drag down to a row and let go, or click and click a row,
 * or the arrow keys and Enter. Picking a route shows its history alone and sends through it; it never navigates.
 *
 * The list is a card: the person, how many accounts, chats and networks, and All; then the routes, under their
 * network's name where a network has two or more, the rest after them, each by their account's own picture and name,
 * its handle, your account where yours differ there (chatroutes.ts tells), unread, and when it was last active. The
 * route messages go to says "sending". `view`: 'all' or the route's conversation. `focus`: where messages go now.
 */
export function PairDropdown({ person, directs, focus, view: v, onPick }: { person: P.PersonView; directs: P.ConversationView[]; focus: P.ConversationView; view: string; onPick: (view: string) => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  // The header clips what overflows it, so the card is placed on the page, under the line.
  const [at, setAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // Opened from the keyboard: the row to put the focus on once the card is drawn.
  const keyTo = useRef<string | null>(null);
  const show = (fromKeys = false) => {
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      const w = Math.min(360, innerWidth - 16);
      setAt({ left: Math.max(8, Math.min(r.left, innerWidth - w - 8)), top: r.bottom + 4, maxHeight: Math.max(200, innerHeight - r.bottom - 16) });
    }
    keyTo.current = fromKeys ? v : null;
    setOpen(true);
  };
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pick = (id: string) => {
    const inside = !!root.current?.contains(document.activeElement);
    setOpen(false);
    setHover(null);
    onPick(id);
    if (inside) btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    if (keyTo.current) {
      const to = keyTo.current;
      keyTo.current = null;
      [...(card.current?.querySelectorAll<HTMLElement>('[data-pair-row]') ?? [])].find((e) => e.dataset.pairRow === to)?.focus();
    }
    const away = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = !!root.current?.contains(document.activeElement);
      setOpen(false);
      if (inside) btn.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const rowAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-pair-row]')?.dataset.pairRow ?? null;
  const onCardKey = (e: KeyboardEvent) => {
    const rows = [...(card.current?.querySelectorAll<HTMLElement>('[data-pair-row]') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const last = rows.length - 1;
    const j = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(last, i + 1)) : e.key === 'ArrowUp' ? Math.max(0, i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (j === null) return;
    e.preventDefault();
    rows[j]?.focus();
  };

  const keys = directs.map(routeKey);
  const fp = pairOf(focus);
  const to = tells(routeKey(focus), keys).theirs ? theirName(fp) : undefined;
  const others = directs.filter((d) => d.id !== focus.id);
  const otherNets = [...new Set(others.map((d) => d.network))].slice(0, 3);
  const nets = new Set(directs.map((d) => d.network));
  const summary = [counted(new Set(directs.map((d) => pairOf(d).theirs?.id ?? d.id)).size, 'account'), counted(directs.length, 'chat'), counted(nets.size, 'network')].filter(Boolean).join(' · ');
  const rows: ListRow[] = directs.map((d) => ({ p: pairOf(d), unread: d.vantages.reduce((n, x) => n + x.unread, 0), last: d.lastMessageAt ?? 0 })).sort((a, b) => b.last - a.last);
  const byNet = new Map<P.Network, ListRow[]>();
  for (const r of rows) byNet.set(r.p.conv.network, [...(byNet.get(r.p.conv.network) ?? []), r]);
  const groups = [...byNet].filter(([, rs]) => rs.length > 1).sort((a, b) => b[1].length - a[1].length || b[1][0].last - a[1][0].last);
  const singles = rows.filter((r) => byNet.get(r.p.conv.network)!.length === 1);

  const row = ({ p, unread }: ListRow, single: boolean) => {
    const id = p.conv.id;
    const name = p.theirs ? identityName(p.theirs.id) : theirName(p);
    const handle = p.theirs?.handle;
    const t = tells(routeKey(p.conv), keys);
    const sending = id === focus.id;
    const sub: ComponentChildren[] = [];
    if (single)
      sub.push(
        <span class="pair-row-net" style={{ '--net': netColor(p.conv.network) } as Record<string, string>}>
          {netName(p.conv.network)}
        </span>,
      );
    if (handle && !PHONE.test(handle) && sameText(handle) !== sameText(name)) sub.push(<span class="pair-row-handle">{handle}</span>);
    if (t.mine)
      sub.push(
        <span class="pair-row-via">
          via <span class="acc-dot" style={{ background: p.acc?.color ?? hueOf(id) }} />
          {myName(p)}
        </span>,
      );
    return (
      <button
        role="option"
        aria-selected={v === id}
        data-pair-row={id}
        data-track="chats list (pair)"
        title={routeTitle(p.conv)}
        class={`pair-row ${v === id ? 'on' : ''} ${hover === id ? 'hover' : ''} ${sending ? 'sending' : ''}`}
        onClick={() => pick(id)}
      >
        <Avatar id={p.theirs?.id ?? id} name={name} url={p.theirs?.avatar} size={26} network={p.conv.network} />
        <span class="pair-row-text">
          <span class="pair-row-name">{name}</span>
          {sub.length > 0 && (
            <span class="pair-row-sub">
              {sub.map((x, i) => (
                <>
                  {i > 0 && <span class="send-sep">·</span>}
                  {x}
                </>
              ))}
            </span>
          )}
        </span>
        <span class="pair-row-end">
          <span class="pair-row-ago">{ago(p.conv.lastMessageAt)}</span>
          {(unread > 0 || sending) && (
            <span class="pair-row-marks">
              {unread > 0 && <Count n={unread} />}
              {sending && <span class="pair-row-sending">➤ sending</span>}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div class="pair-dd" ref={root}>
      <button
        ref={btn}
        class={`pair-dd-btn ${open ? 'open' : ''}`}
        data-track="chats list"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${routeTitle(focus).replace(/^Send/, 'Sending')}. ${v === 'all' ? `${others.length} more ${others.length === 1 ? 'chat' : 'chats'} with them` : 'Showing only this chat'}: press and drag to pick, or click`}
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
            const r = rowAt(ev.clientX, ev.clientY);
            if (p0.moved && r) pick(r);
            else if (p0.moved) setOpen(false);
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            show(true);
          }
        }}
      >
        <SendLine c={focus} accounts={routeAccounts(focus)} to={to} />
        {v === 'all' && (
          <span class="pair-more">
            <span class="pair-more-nets">
              {otherNets.map((n) => (
                <NetGlyph network={n} size={11} color={netColor(n)} />
              ))}
            </span>
            +{others.length}
            <span class="pair-dd-caret" aria-hidden="true">
              ▾
            </span>
          </span>
        )}
      </button>
      {v !== 'all' && (
        <button class="pair-more pair-only" data-track="chats list (back to all)" title="Showing only this chat: show all chats together" aria-label="Showing only this chat. Show all chats together" onClick={() => onPick('all')}>
          only this
          <span class="pair-only-x" aria-hidden="true">
            ✕
          </span>
        </button>
      )}
      {open && (
        <div class="pair-card" ref={card} role="dialog" aria-label={`Chats with ${person.name}`} style={at ? { left: `${at.left}px`, top: `${at.top}px`, maxHeight: `${at.maxHeight}px` } : undefined} onKeyDown={onCardKey}>
          <div class="pair-card-top">
            <Avatar id={person.id} name={person.name} url={person.avatar} size={36} />
            <span class="pair-card-who">
              <b>{person.name}</b>
              <small>{summary}</small>
            </span>
            <button aria-pressed={v === 'all'} data-pair-row="all" data-track="chats list (all)" title="Show all chats together" class={`pair-card-all ${v === 'all' ? 'on' : ''} ${hover === 'all' ? 'hover' : ''}`} onClick={() => pick('all')}>
              All
            </button>
          </div>
          <div class="pair-card-rows" role="listbox" aria-label="Chats">
            {groups.map(([n, rs]) => (
              <div role="group" aria-label={netName(n)}>
                <div class="pair-card-net" style={{ '--net': netColor(n) } as Record<string, string>} aria-hidden="true">
                  <NetGlyph network={n} size={11} /> {netName(n)}
                </div>
                {rs.map((r) => row(r, false))}
              </div>
            ))}
            {singles.length > 0 && (
              <div role="group" aria-label={groups.length ? 'Other networks' : 'Networks'} class={groups.length ? 'pair-card-rest' : ''}>
                {singles.map((r) => row(r, true))}
              </div>
            )}
          </div>
          <button
            class="pair-card-foot"
            data-track="chats list (profile)"
            onClick={() => {
              setOpen(false);
              go({ view: 'profile', person: person.id });
            }}
          >
            {person.name}’s profile →
          </button>
        </div>
      )}
    </div>
  );
}
