/**
 * A person you reach through several routes (docs/chats.md): every pair of your account and theirs is a route, and
 * their chat is one page over them all, interleaved. It is the page any conversation has (Timeline.tsx's PersonChat),
 * and these are the parts it adds. Each adds only what the chat needs: chatroutes.ts says, for a route among the
 * chat's, what tells it apart (the network, their account, yours), and every part here asks it.
 *
 * Where a message goes, first to last: the route you picked on this page (a tag in the timeline, the message box's
 * line, the list under the name); the DM the page was opened as; where you came from, if they are there (from a Discord
 * group of theirs on one of your accounts, the DM through that account); the route you chose last time (the hub keeps it, chats.ts); the route
 * of the latest message. A pick, here or the hub's, gives way once a message comes on another route after it
 * (chatroutes.ts pickHolds), unless a draft waits in the picked route's box.
 */
import type * as P from '@dither-chat/protocol';
import { MATCH_STRONG, POST_NETWORKS } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { badgeDiffers, cameFromThem, headIdents, lastRouteTells, leadTells, tagTells, tagText, tells, yourAccount, yourName, type HeadName, type RouteKey, type Side } from '../chatroutes.ts';
import { personTabs, POSTS_TAB, postNetworks, routeForTab, tabNetwork, tabOf, viewIn } from '../chattabs.ts';
import { ago, hueOf, initials } from '../format.ts';
import { convLabel, identityName, netColor, netName, visibleAccount } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, go, isSelfIdentity, metaRev, pref, setPrefs, timelineKey, timelines, toast } from '../state.ts';
import { Avatar, Count, FromChips, Menu, NetBadge, NetGlyph, PlaceTabs } from './bits.tsx';
import { TimerLabel } from './Disappearing.tsx';
import { Icon } from './icons.tsx';
import { cameFrom, live, picked } from '../pairpick.ts';
import { TAB_KEYS } from '../tabkeys.ts';
import { convById } from '../mail/chats.ts';
import './Pairs.css';

// ------------------------------------------------------------------ pairs

interface Pair {
  conv: P.ConversationView;
  acc: P.AccountView | null;
  /** Your identity on that account. */
  mine: P.IdentityView | null;
  /** Theirs in the conversation. */
  theirs: P.IdentityView | null;
  /** A person's email route goes from a mail account, which is not among the chat accounts (mail/chats.ts). */
  mail: P.MailAccountView | null;
}

function pairOf(conv: P.ConversationView): Pair {
  const acc = conv.vantages.map((v) => db.accounts.get(v.accountId)).find((a): a is P.AccountView => !!a) ?? null;
  const mine = acc?.selfIdentityId ? (db.identities.get(acc.selfIdentityId) ?? null) : null;
  const peer = conv.participantIds.find((p) => !isSelfIdentity(p));
  const theirs = peer ? (db.identities.get(peer) ?? null) : null;
  const mail = acc ? null : (conv.vantages.map((v) => db.mail.accounts.get(v.accountId)).find((a) => !!a) ?? null);
  return { conv, acc, mine, theirs, mail };
}

/** A handle that is a phone number (Signal, WhatsApp): never shown beside a name. */
const PHONE = /^\+?[\d\s()-]{6,}$/;

/** Their name on the network: the username, or the profile name where the handle is a phone number (Signal, WhatsApp). */
const theirName = (p: Pair) => {
  const h = p.theirs?.handle;
  if (h && PHONE.test(h) && p.theirs?.displayName) return p.theirs.displayName;
  return h ?? p.theirs?.displayName ?? netName(p.conv.network);
};
const yours = (p: Pair) => ({ chat: p.acc, mail: p.mail, identity: p.mine ? identityName(p.mine.id) : null });
const myName = (p: Pair) => yourName(yours(p));
/** Your account on this route: a chat account, else a mail account. */
const myId = (p: Pair) => yourAccount(yours(p));
/** Your account's colour on this route. */
const myColor = (p: Pair) => p.acc?.color ?? p.mail?.color ?? hueOf(p.conv.id);

/** A route as chatroutes.ts sees it. */
function routeKey(c: P.ConversationView): RouteKey {
  const p = pairOf(c);
  return { id: c.id, network: c.network, theirs: p.theirs?.id ?? null, mine: myId(p) };
}

/** What tells this route from the chat's others (chatroutes.ts). */
/** Whether message pictures carry the network's badge in this chat: only when it would differ between its routes. */
export const badgeShows = (directs: P.ConversationView[]) => badgeDiffers(directs.map(routeKey));

/** A route said in full, for a title: "Send as zyn.alt to kit.work on Discord". */
function routeTitle(c: P.ConversationView): string {
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

/** What the hub says of each person's chat (GET /api/chats/person:<id>): the route chosen last time, if any. */
const chats = signal<Record<string, P.ChatView>>({});

/** Ask the hub for a person's chat again: on opening their page, so a route chosen on another device counts. */
export async function loadChat(personId: string) {
  const c = await api<P.ChatView>(`/api/chats/person:${personId}`).catch(() => null);
  if (!c) return;
  chats.value = { ...chats.value, [personId]: c };
  // A route this browser kept before the hub kept them (prefs.via, a conversation id): moved there once.
  const old = pref('via')[personId];
  if (old !== undefined) {
    const { [personId]: _, ...rest } = pref('via');
    setPrefs({ via: rest });
    const r = c.routes.find((x) => x.conversationId === old);
    if (r && c.route?.why !== 'chosen') void chooseRoute(personId, r.conversationId, r.accountId);
  }
}

async function chooseRoute(personId: string, conversationId: string, accountId: string) {
  const c = await api<P.ChatView>(`/api/chats/person:${personId}`, { method: 'PATCH', body: { route: { conversationId, accountId } } }).catch(() => null);
  if (c) chats.value = { ...chats.value, [personId]: c };
}

/** Where a message to them goes now (the module's comment says in what order). `at`: the DM the page was opened as. */
export function focusedPair(personId: string, directs: P.ConversationView[], at?: string): P.ConversationView {
  const p = picked.value[personId];
  const hit = p && p.at === (at ?? '') && live(p.to, p.ts, directs) && directs.find((d) => d.id === p.to);
  if (hit) return hit;
  const opened = at && directs.find((d) => d.id === at);
  if (opened) return opened;
  const latest = (xs: P.ConversationView[]) => [...xs].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0];
  const from = cameFrom.value ? db.conversations.get(cameFrom.value) : null;
  if (from) {
    // Their DM itself; else, if they are there (chatroutes.ts cameFromThem), a DM through the account you were
    // reading on, else one on that network. A DM with someone else says nothing of how to reach them.
    const same = directs.find((d) => d.id === from.id);
    if (same) return same;
    const isTheirs = (id: string) => db.identities.get(id)?.personId === personId;
    const loaded = timelines.get(timelineKey('c', from.id))?.messages ?? [];
    if (cameFromThem(from, loaded, isTheirs)) {
      const accs = new Set(from.vantages.map((v) => v.accountId));
      const viaAcc = directs.filter((d) => d.vantages.some((v) => accs.has(v.accountId)));
      if (viaAcc.length) return latest(viaAcc);
      const onNet = directs.filter((d) => d.network === from.network);
      if (onNet.length) return latest(onNet);
    }
  }
  // The hub's chosen route, by the same rule against messages that came since it said so.
  const chosen = chats.value[personId]?.route;
  const kept = chosen?.why === 'chosen' && (chosen.at == null || live(chosen.conversationId, chosen.at, directs)) && directs.find((d) => d.id === chosen.conversationId);
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
  picked.value = { ...picked.value, [personId]: { to, at: at ?? '', ts: Date.now() } };
  // An email route is no conversation row (mail/chats.ts): it is among their directs, sent from a mail account.
  const conv = convById(to);
  const p = conv && pairOf(conv);
  const acc = p ? (p.acc?.id ?? p.mail?.id ?? null) : null;
  const cur = chats.value[personId]?.route;
  if (acc && !(cur?.why === 'chosen' && cur.conversationId === to && cur.accountId === acc)) void chooseRoute(personId, to, acc);
}

/** Your account: its picture, else its colour and initials (your accounts' pictures often look alike), and its network. */
function MyPicture({ p, size }: { p: Pair; size: number }) {
  const name = myName(p);
  if (p.mine?.avatar) return <Avatar id={p.acc?.id ?? p.conv.id} name={name} url={p.mine.avatar} size={size} network={p.conv.network} />;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }}>
      <span class="avatar-fallback" style={{ borderRadius: `${size / 2}px`, background: myColor(p), color: '#14161d', fontSize: `${Math.max(9, Math.round(size * 0.38))}px` }}>
        {initials(name.replace(/^[@+]/, ''))}
      </span>
      <NetBadge network={p.conv.network} size={Math.max(11, Math.round(size * 0.5))} class="avatar-net" />
    </span>
  );
}

/** A name in the message box's line that changes the pair: cycles between two, lists more. */
function Token({ label, options, onPick, picture }: { label: string; options: { id: string; label: string; picture?: ComponentChildren }[]; onPick: (id: string) => void; picture?: ComponentChildren }) {
  const cur = options.findIndex((o) => o.label === label);
  if (options.length < 2)
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
        <Icon name="repeat" size={10} class="pair-token-hint" />
      </button>
    );
  return (
    <Menu
      up
      trigger={(toggle) => (
        <button class="pair-token" data-track="send through" title="Choose" onClick={toggle} aria-haspopup="menu">
          {picture}
          {label}
          <Icon name="chevronDown" size={10} class="pair-token-hint" />
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
 * A channel's or group's route line where two or more of your accounts are in it: "To #general · via main", the
 * account a token like a person chat's (two switch with a press, more open a menu). It was a chip in the box.
 */
export function SendAsLead({ c, accounts, value, onPick }: { c: P.ConversationView; accounts: P.AccountView[]; value: string; onPick: (accountId: string) => void }) {
  const cur = accounts.find((a) => a.id === value) ?? accounts[0];
  const dot = (a: P.AccountView) => <span class="acc-dot" style={{ width: '8px', height: '8px', background: a.color }} />;
  return (
    <span class="pair-lead-line">
      {'To '}
      <span class="pair-token fixed">{convLabel(c)}</span>
      {' · via '}
      <Token label={cur.label} picture={dot(cur)} options={accounts.map((a) => ({ id: a.id, label: a.label, picture: dot(a) }))} onPick={onPick} />
    </span>
  );
}

/**
 * Where a message goes, by the same rule as the tags and no more: "Message Kit on Signal", "Message Kit on Discord
 * (kit.work)", and "from zyn.alt" only when the account of theirs it goes to can be reached from several of yours
 * (chatroutes.ts leadTells). The parts that can change switch. It sits at the start of the typing line's row, over the
 * box (ui/Typing.tsx): "To Kit on Signal".
 */
export function PairLead({ person, directs, focus, onFocus }: { person: P.PersonView; directs: P.ConversationView[]; focus: P.ConversationView; onFocus: (convId: string) => void }) {
  metaRev.value; // names on both sides
  const keys = directs.map(routeKey);
  const pairs = directs.map(pairOf);
  const cur = pairOf(focus);
  const t = leadTells(routeKey(focus), keys);
  // Theirs you can reach, each once; picking one keeps your account when it talks with them too.
  const theirs: Pair[] = [];
  for (const p of pairs) if (!theirs.some((x) => x.theirs?.id === p.theirs?.id)) theirs.push(p);
  const pickTheirs = (identityId: string) => {
    const withThem = pairs.filter((p) => p.theirs?.id === identityId);
    const next = withThem.find((p) => myId(p) === myId(cur)) ?? withThem.sort((a, b) => (b.conv.lastMessageAt ?? 0) - (a.conv.lastMessageAt ?? 0))[0];
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
      {/* As the line under the name says it: "To Kit on Discord · to kit.work · via zyn.alt"; on a phone
          "To kit.work · via zyn.alt". */}
      {'To '}
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
      <TimerLabel conv={focus} />
      <LastRoute directs={directs} focus={focus} onFocus={onFocus} />
    </span>
  );
}

/**
 * A quiet hint at the end of the message box's line when the message would go another way than the chat's latest
 * message came: "last message on Signal" (else "with kit.work", "via zyn.alt": chatroutes.ts lastRouteTells). A
 * click or tap sends through that route.
 */
function LastRoute({ directs, focus, onFocus }: { directs: P.ConversationView[]; focus: P.ConversationView; onFocus: (convId: string) => void }) {
  const last = directs.reduce<P.ConversationView | null>((a, d) => (!a || (d.lastMessageAt ?? 0) > (a.lastMessageAt ?? 0) ? d : a), null);
  if (!last?.lastMessageAt) return null;
  const tells = lastRouteTells(routeKey(focus), routeKey(last));
  if (!tells) return null;
  const p = pairOf(last);
  const where = tells === 'network' ? `on ${netName(last.network)}` : tells === 'theirs' ? `with ${theirName(p)}` : `via ${myName(p)}`;
  const title = `The last message was ${where} (${ago(last.lastMessageAt)}); this one goes ${tells === 'network' ? `on ${netName(focus.network)}` : routeTitle(focus).replace(/^Send /, '')}`;
  const body = (
    <>
      {tells === 'network' && <NetGlyph network={last.network} size={10} />}
      last message {where}
    </>
  );
  return (
    <button class="pair-last" data-track="last route" title={`${title}. Click to send there.`} onClick={() => onFocus(last.id)}>
      {body}
    </button>
  );
}

// ------------------------------------------------------------------ the page's parts

/**
 * What the page shows, per person this session: every route ('all', the default), one network's (`net:<network>`,
 * its tab), or one route's, picked from the list (its id). Never in the address (docs/places.md).
 */
const viewing = signal<Record<string, string>>({});
/**
 * The networks of posts they post on that your accounts read (chattabs.ts postNetworks): with any, their row ends in
 * Posts. From what the app holds already, their identities and your accounts: nothing asked, no bytes added at start.
 */
export const postNetsOf = (person: P.PersonView): P.Network[] =>
  postNetworks(
    person.identityIds.flatMap((id) => db.identities.get(id)?.network ?? []),
    [...db.accounts.values()].map((a) => a.network),
    POST_NETWORKS,
  );
const extraOf = (person: P.PersonView) => (postNetsOf(person).length ? [POSTS_TAB] : []);
export const viewOf = (person: P.PersonView, directs: P.ConversationView[]) => viewIn(viewing.value[person.id], directs, extraOf(person));
export const setView = (personId: string, v: string) => void (viewing.value = { ...viewing.value, [personId]: v });

const unreadOf = (d: P.ConversationView) => d.vantages.reduce((n, x) => n + x.unread, 0);

/**
 * The switch row of a person's page (docs/places.md "A person's networks"): All, then each network they are reached
 * on (chattabs.ts personTabs), its glyph, name and unread. A route shown alone from the list chooses its network's
 * tab. Picking a network shows its routes together and sends through it; All shows everything and leaves the send
 * route as it is. Ctrl+Shift+] and [ move along it from anywhere on the page (tabkeys.ts).
 */
export function PersonTabs({ person, directs, view, onTab }: { person: P.PersonView; directs: P.ConversationView[]; view: string; onTab: (id: string) => void }) {
  // Their public posts, last: with the network's glyph when they post on one only.
  const posts = postNetsOf(person);
  const extra = posts.length ? [{ id: POSTS_TAB, network: posts.length === 1 ? posts[0]! : null, unread: 0 }] : [];
  const tabs = personTabs(directs.map((d) => ({ network: d.network, unread: unreadOf(d) })), netName, extra);
  return (
    <PlaceTabs
      class="person-tabs"
      label={`Chats with ${person.name}`}
      track="person tab"
      value={tabOf(view, directs, extra.map((t) => t.id))}
      onPick={onTab}
      tabs={tabs.map((t) => {
        if (t.id === POSTS_TAB) {
          // In the text's colour: a network of posts may be black or white (X), so it takes the tab's text colour, which never hides it.
          return { id: t.id, label: 'Posts', icon: t.network ? <NetGlyph network={t.network} size={12} /> : undefined, title: `What they posted in public${t.network ? ` on ${netName(t.network)}` : ''}, as the hub logged it (${TAB_KEYS} move between tabs)` };
        }
        const label = t.network ? netName(t.network) : 'All';
        const what = t.network ? `Only ${label}` : 'Every chat with them together';
        return {
          id: t.id,
          label,
          count: t.unread,
          icon: t.network ? <NetGlyph network={t.network} size={12} color={netColor(t.network)} /> : undefined,
          title: `${what}${t.unread ? `, ${t.unread} unread` : ''} (${TAB_KEYS} move between tabs)`,
        };
      })}
    />
  );
}

/** The route a network's tab sends through (chattabs.ts routeForTab). */
export const tabRoute = (tab: string, focus: P.ConversationView, directs: P.ConversationView[]) => {
  const net = tabNetwork(tab);
  return net === null ? null : routeForTab(net, focus, directs);
};


/**
 * The line under the name, in the same words for a direct conversation and for a person's chat: where your message
 * goes. The account of yours it goes from, as one chip with its network's icon in it (the network's name alone where
 * no account of yours shows), and their account, where theirs on that network differ (`to mo.codes`).
 */
export function SendLine({ c, accounts, to }: { c: P.ConversationView; accounts: P.AccountView[]; to?: string }) {
  return (
    <span class="send-line">
      <FromChips network={c.network} accounts={accounts} />
      {to && (
        <span class="send-to">
          <span class="send-sep">·</span> to {to}
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
 * `only this ✕` while the page shows one route. The networks are the switch row's under the head (`PersonTabs`); the
 * whole line opens the list of routes: press and drag down to a row and let go, or click and click a row, or the
 * arrow keys and Enter. Picking a route shows its history alone and sends through it; it never navigates.
 *
 * The list is a card: the person, how many accounts, chats and networks, and All; then the routes, under their
 * network's name where a network has two or more, the rest after them, each by their account's own picture and name,
 * its handle, your account where yours differ there (chatroutes.ts tells), unread, and when it was last active. The
 * route messages go to says "sending". `focus`: where messages go now. What the page shows is read here (`viewing`),
 * so a network's tab is not taken for one route: `view` is what older callers pass, and is not needed.
 */
export function PairDropdown({ person, directs, focus, onPick }: { person: P.PersonView; directs: P.ConversationView[]; focus: P.ConversationView; view?: string; onPick: (view: string) => void }) {
  metaRev.value; // names: counts and times come with a new `directs`
  const shows = viewOf(person, directs);
  // One route shown alone follows the route you send through (PersonChat); their posts are no one route.
  const v = shows === 'all' || shows === POSTS_TAB || tabNetwork(shows) !== null ? shows : focus.id;
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
  useLayoutEffect(() => {
    if (!open) return;
    if (keyTo.current) {
      const to = keyTo.current;
      keyTo.current = null;
      [...(card.current?.querySelectorAll<HTMLElement>('[data-pair-row]') ?? [])].find((e) => e.dataset.pairRow === to)?.focus();
    }
    const away = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
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
          via <span class="acc-dot" style={{ background: p.acc?.color ?? p.mail?.color ?? hueOf(id) }} />
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
        title={`${routeTitle(focus).replace(/^Send/, 'Sending')}. ${v === focus.id ? 'Showing only this chat' : others.length === 0 ? 'No other chats with them' : `${others.length + 1} chats with them`}: press and drag to pick one, or click`}
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
        {/* One route (someone reached only by email, mail/chats.ts): nothing more to pick. */}
        {others.length > 0 && (
          <span class="pair-dd-caret" aria-hidden="true">
            ▾
          </span>
        )}
      </button>
      {v === focus.id && (
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

/**
 * "Is this the same person?" where it matters: one slim line under the head of a person's page when the Same person?
 * suggester (docs/same-person.md) is confident someone else is them, "Also Mom on Signal · Same person? Join · Not
 * them". The suggestions are the ones SameBox shows on a profile (GET /api/matches?side=); only those at
 * MATCH_STRONG or over come here, the first of them. Join merges them (POST /api/matches/merge), Not them says so
 * (POST /api/matches/decide). Never joined without you.
 */
// redraws: it reads nothing shared while it draws; what it shows is its own state, asked for again per person.
export function SameLine({ person }: { person: P.PersonView }) {
  const [s, setS] = useState<P.MatchSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    setS(null);
    api<P.MatchesView>(`/api/matches?side=${encodeURIComponent(person.id)}`)
      .then((v) => on && setS(v.suggestions.find((x) => x.p >= MATCH_STRONG && (x.a.id === person.id || x.b.id === person.id)) ?? null))
      .catch(() => {});
    return () => void (on = false);
  }, [person.id]);
  if (!s) return null;
  const other = s.a.id === person.id ? s.b : s.a;
  const nets = [...new Set(other.identities.map((i) => i.network))];
  const join = async () => {
    setBusy(true);
    try {
      const r = await api<{ person: string }>('/api/matches/merge', { body: { sides: [s.a.id, s.b.id] } });
      toast({ kind: 'info', title: 'Joined', body: `${s.a.name} and ${s.b.name} are one person now.` }, 4000);
      setS(null);
      go({ view: 'people', person: r.person });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not join them', body: (e as Error).message });
    }
    setBusy(false);
  };
  const no = async () => {
    setBusy(true);
    await api('/api/matches/decide', { body: { key: s.key, decision: 'no' } }).catch(() => {});
    setBusy(false);
    setS(null);
  };
  const why = s.evidence.filter((e) => e.weight > 0).slice(0, 3).map((e) => e.text).join('; ');
  return (
    <div class="same-line" role="note" title={`${Math.round(s.p * 100)}% likely the same person${why ? `: ${why}` : ''}`}>
      <span class="same-line-who">
        Also{' '}
        <button class="link-btn" data-track="same line (other)" onClick={() => go(other.id.startsWith('per_') ? { view: 'profile', person: other.id } : { view: 'profile', identity: other.id })}>
          {other.name}
        </button>
        {nets.length > 0 && (
          <>
            {' on '}
            {nets.map((n, i) => (
              <>
                {i > 0 && ', '}
                <NetGlyph network={n} size={11} color={netColor(n)} /> {netName(n)}
              </>
            ))}
          </>
        )}
      </span>
      <span class="send-sep">·</span>
      <span class="same-line-q">Same person?</span>
      <button class="link-btn" data-track="same line (join)" disabled={busy} onClick={() => void join()}>
        Join
      </button>
      <span class="send-sep">·</span>
      <button class="link-btn" data-track="same line (not them)" disabled={busy} onClick={() => void no()}>
        Not them
      </button>
    </div>
  );
}
