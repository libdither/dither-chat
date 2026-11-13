/**
 * Requests waiting on you (docs/add.md "Requests"): grouped for the Requests view, said in words, and what a profile
 * offers by how you stand with someone on each network. No browser needed, so it can be tested alone.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, parseAdd } from '@dither-chat/protocol';

type Kind = P.RequestView['kind'];

/** The Requests view's groups, in this order. */
export const REQUEST_GROUPS: { kind: Kind; title: string }[] = [
  { kind: 'friend', title: 'Friend requests' },
  { kind: 'invite', title: 'Invites' },
  { kind: 'message', title: 'Message requests' },
  { kind: 'follow', title: 'Follow requests' },
  { kind: 'join', title: 'Asking to join your groups' },
];

/** Where what a network filed as spam waits: last, under a heading of its own. */
export const SPAM_TITLE = 'Filed as spam';

/** One group per kind that has any, newest first in each; what the network filed as spam in a last group of its own. */
export function groupRequests(rs: readonly P.RequestView[]): { kind: Kind; title: string; requests: P.RequestView[] }[] {
  const plain = rs.filter((r) => !r.spam);
  const spam = rs.filter((r) => r.spam).sort((a, b) => b.ts - a.ts);
  const groups = REQUEST_GROUPS.map((g) => ({ ...g, requests: plain.filter((r) => r.kind === g.kind).sort((a, b) => b.ts - a.ts) })).filter((g) => g.requests.length);
  return spam.length ? [...groups, { kind: spam[0]!.kind, title: SPAM_TITLE, requests: spam }] : groups;
}

/** What it asks, after their name: "wants to be friends", "invited you to Nix Hackathon 2026". */
export function requestLine(r: Pick<P.RequestView, 'kind' | 'network' | 'target'>): string {
  const place = r.target?.name ?? null;
  const noun = r.target?.kind === 'space' ? NETWORK_META[r.network].spaceNoun : 'group';
  switch (r.kind) {
    case 'friend':
      return 'wants to be friends';
    case 'follow':
      return 'wants to follow you';
    case 'invite':
      return place ? `invited you to ${place}` : `invited you to a ${noun}`;
    case 'message':
      return 'sent you a message request';
    case 'join':
      return place ? `asks to join ${place}` : `asks to join your ${noun}`;
  }
}

/** Which of your accounts it came to, plainly: "to your Discord account main". */
export function accountLine(network: P.Network, label: string | null | undefined): string {
  const net = NETWORK_META[network].name;
  return label && label !== net ? `to your ${net} account ${label}` : `to your ${net} account`;
}

/** A line the network gave, ending as a sentence does. */
export const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * Said under the network's words before "Accept anyway" or "Add anyway": reads right after a warning on the card
 * ("Discord filed this request as possible spam") and after the network asked for a confirm.
 */
export function confirmNext(verb: 'accept' | 'add', canMessage: boolean): string {
  const first = verb === 'accept' ? 'Nothing is accepted yet.' : 'No friend request has gone out yet.';
  const then = verb === 'accept' ? 'Accept it anyway' : 'Add them anyway';
  return canMessage ? `${first} ${then}, or message them first to see who they are.` : `${first} ${then} only if you know who they are.`;
}

/** "23 members", for an invite or a join request whose place says. */
export function targetMembers(r: Pick<P.RequestView, 'target'>): string | null {
  const n = r.target?.members;
  return typeof n === 'number' ? `${n.toLocaleString('en-US')} member${n === 1 ? '' : 's'}` : null;
}

export const ANSWER_LABEL: Record<P.RequestAnswer, string> = { accept: 'Accept', decline: 'Decline', block: 'Block' };

/**
 * The inbox's Requests row: how many, who, and the newest. Null when nothing waits. What the network filed as spam is
 * quieter: not in the count or the names, only said (`spam`), and its time counts only when nothing else waits.
 */
export function requestsRow(rs: readonly P.RequestView[], nameOf: (identityId: string | null) => string): { count: number; names: string[]; lastAt: number; spam?: number } | null {
  if (!rs.length) return null;
  const plain = rs.filter((r) => !r.spam);
  const spam = rs.length - plain.length;
  const sorted = [...(plain.length ? plain : rs)].sort((a, b) => b.ts - a.ts);
  const names = plain.length ? [...new Set(sorted.map((r) => nameOf(r.from)))].slice(0, 4) : [];
  return { count: plain.length, names, lastAt: sorted[0]!.ts, ...(spam ? { spam } : {}) };
}

/** Said beside a message request: why opening it here is safe, and what accepting does. */
export function messageRequestNote(network: P.Network, who: string): string {
  const net = NETWORK_META[network].name;
  return `Accepting tells ${who} you saw it. On ${net} even opening it on another device does; here it does not: dither-chat sends ${net} no read receipts and no typing for it until you accept.`;
}

/** The open message request a conversation waits on, if any. */
export function heldRequest(rs: readonly P.RequestView[], conversationId: string): P.RequestView | undefined {
  return rs.find((r) => r.kind === 'message' && r.target?.kind === 'conversation' && r.target.id === conversationId);
}

// ------------------------------------------------------------------ profile buttons

/** How a network lets you reach a stranger, where it has a way. */
export const CONNECT_ACTION: Partial<Record<P.Network, 'friend' | 'follow' | 'contact'>> = { discord: 'friend', x: 'follow', instagram: 'follow', telegram: 'contact' };

/** A reading POST /api/add takes for someone known by their identity, or null when parseAdd would not give one. */
export function identityRef(i: Pick<P.IdentityView, 'network' | 'nativeId' | 'handle'>): P.AddRef | null {
  const handle = i.handle?.replace(/^@/, '') ?? null;
  const tries: (string | null)[] =
    i.network === 'discord' ? [i.nativeId, handle]
    : i.network === 'telegram' ? [handle && `@${handle}`, i.handle]
    : i.network === 'x' || i.network === 'instagram' ? [handle && `@${handle}`]
    : i.network === 'messenger' ? [`https://m.me/${handle ?? i.nativeId}`]
    : i.network === 'matrix' ? [i.nativeId]
    : [i.handle, i.nativeId];
  for (const t of tries) {
    const ref = t ? parseAdd(t).find((r) => r.network === i.network && (r.kind === 'person' || r.kind === 'name')) : undefined;
    if (ref) return ref;
  }
  return null;
}

export type Relation =
  /** A stranger you can reach: this action, through this account. */
  | { kind: 'connect'; action: 'friend' | 'follow' | 'contact'; accountId: string; ref: P.AddRef }
  /** They asked you: the open request to answer. */
  | { kind: 'answer'; request: P.RequestView };

/**
 * What a profile offers on one network, from how the network says you stand with them: Add friend, Follow or Add
 * contact for a stranger where an account can; Accept or Decline what they asked. Null where nothing can be done (no
 * account with the capability, no way on that network) and where there is only something to say, such as a request
 * sent or a follow: the hero's tags and Connections say those (connections.ts).
 */
export function relation(
  about: Pick<P.PersonAboutView, 'network' | 'relationship' | 'accountId'>,
  identity: Pick<P.IdentityView, 'id' | 'network' | 'nativeId' | 'handle'>,
  accounts: readonly P.AccountView[],
  requests: readonly P.RequestView[],
): Relation | null {
  const net = about.network;
  const can = (cap: P.Capability) => accounts.filter((a) => a.network === net && a.status === 'online' && a.capabilities.includes(cap)).sort((a, b) => +(b.id === about.accountId) - +(a.id === about.accountId));
  switch (about.relationship) {
    case 'stranger': {
      const action = CONNECT_ACTION[net];
      const account = action ? can('connect')[0] : undefined;
      const ref = identityRef(identity);
      return action && account && ref ? { kind: 'connect', action, accountId: account.id, ref } : null;
    }
    case 'requesting': {
      const ids = new Set(can('requests').map((a) => a.id));
      const request = requests.find((r) => r.from === identity.id && (r.kind === 'friend' || r.kind === 'follow') && ids.has(r.accountId));
      return request ? { kind: 'answer', request } : null;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ relationships

/** The question before ending one: "Remove Nova as a friend on your Discord account main?" */
export function removeQuestion(rel: P.LinkRelationship, name: string, network: P.Network, label: string | null | undefined): string {
  const where = accountLine(network, label).replace(/^to /, 'on ');
  switch (rel) {
    case 'friend':
      return `Remove ${name} as a friend ${where}?`;
    case 'requested':
      return `Cancel your friend request to ${name} ${where}?`;
    case 'blocked':
      return `Unblock ${name} ${where}?`;
    case 'contact':
      return `Remove ${name} from your contacts ${where}?`;
    case 'following':
      return `Unfollow ${name} ${where}?`;
  }
}

/** What ending it does, said under the question. */
export function removeNote(rel: P.LinkRelationship, network: P.Network): string {
  const net = NETWORK_META[network].name;
  switch (rel) {
    case 'friend':
      return `You stay in your DMs and servers with them; to be friends again, one of you sends a new request on ${net}.`;
    case 'requested':
      return 'They no longer see your request. You can send another later.';
    case 'blocked':
      return `They can find you and message you on ${net} again, as anyone can.`;
    case 'contact':
      return `They leave your ${net} contacts. Your chats with them stay.`;
    case 'following':
      return `Their posts leave your ${net} feed.`;
  }
}


/** The People list's filters: chats with people, or one kind of list across your accounts. */
export const PEOPLE_FILTERS: { id: 'chats' | 'friend' | 'contact' | 'following'; label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'friend', label: 'Friends' },
  { id: 'contact', label: 'Contacts' },
  { id: 'following', label: 'Following' },
];
export type PeopleFilter = (typeof PEOPLE_FILTERS)[number]['id'];

/** Where each kind of list is: friends on Discord, address books, follows on X and Instagram (mutual ones are Friends too). */
const LIST_NETWORKS: Record<Exclude<PeopleFilter, 'chats'>, readonly P.Network[]> = {
  friend: ['discord'],
  contact: ['telegram', 'signal', 'whatsapp', 'gmessages'],
  following: ['x', 'instagram'],
};

/** Networks of follows, whose accounts' profiles say whom you follow and who follows you back without a list. */
const FOLLOW_NETWORKS: readonly P.Network[] = ['x', 'instagram'];

/**
 * The filters worth a chip: chats, and each kind some account here keeps a list of. An X or Instagram account's
 * follows come from the profiles it reads (docs/profile.md "Connections"), so it gives Following, and Friends for
 * those who follow back, with or without a list. None but chats: no chips.
 */
export function peopleFilters(accounts: Iterable<Pick<P.AccountView, 'network' | 'capabilities'>>): typeof PEOPLE_FILTERS {
  const all = [...accounts];
  const nets = new Set(all.filter((a) => a.capabilities.includes('relationships')).map((a) => a.network));
  const follows = all.some((a) => FOLLOW_NETWORKS.includes(a.network) && a.capabilities.includes('profile'));
  const shown = PEOPLE_FILTERS.filter((f) => f.id === 'chats' || LIST_NETWORKS[f.id].some((n) => nets.has(n)) || (follows && (f.id === 'friend' || f.id === 'following')));
  return shown.length > 1 ? shown : [];
}

/**
 * One row per person (or identity with no person) on the lists, in the hub's order, each with its accounts' links: a
 * friend on two accounts is one row with two links, as is a person whose two identities are each on one.
 */
export function linkRows(links: readonly P.PersonLinkView[]): { key: string; personId: string | null; identityId: string; links: P.PersonLinkView[] }[] {
  const rows = new Map<string, { key: string; personId: string | null; identityId: string; links: P.PersonLinkView[] }>();
  for (const l of links) {
    const key = l.personId ?? l.identityId;
    const row = rows.get(key) ?? rows.set(key, { key, personId: l.personId, identityId: l.identityId, links: [] }).get(key)!;
    row.links.push(l);
  }
  return [...rows.values()];
}

/** How a list of people is ordered (People's lists, docs/add.md): whom you talked with last first, or by name. */
export type LinkSort = 'recent' | 'az';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The rows in order. Last talked: the latest message in your DMs with them first; people you never talked with after,
 * by name. A to Z: by name. Ties go by key, so the order never flickers.
 */
export function sortLinkRows<T extends { key: string }>(rows: readonly T[], mode: LinkSort, last: (r: T) => number | null, name: (r: T) => string): T[] {
  const byName = (a: T, b: T) => collator.compare(name(a), name(b)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (mode === 'az') return [...rows].sort(byName);
  return [...rows].sort((a, b) => (last(b) ?? -1) - (last(a) ?? -1) || byName(a, b));
}

/** The filter box: each word typed is somewhere in the name, whatever the case or accents. */
export function nameMatches(name: string, q: string): boolean {
  const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const n = fold(name);
  return fold(q).split(/\s+/).filter(Boolean).every((w) => n.includes(w));
}

/** A row's second line: when you last talked, from your DMs with them ("talked 3 days ago"). */
export function talkedLine(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const d = Math.max(0, now - at);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const n = (x: number, one: string) => `${Math.floor(x)} ${one}${Math.floor(x) === 1 ? '' : 's'} ago`;
  if (d < 2 * MIN) return 'talked just now';
  if (d < HOUR) return `talked ${n(d / MIN, 'minute')}`;
  if (d < DAY) return `talked ${n(d / HOUR, 'hour')}`;
  if (d < 2 * DAY) return 'talked yesterday';
  if (d < 14 * DAY) return `talked ${n(d / DAY, 'day')}`;
  if (d < 60 * DAY) return `talked ${n(d / (7 * DAY), 'week')}`;
  if (d < 730 * DAY) return `talked ${n(d / (30 * DAY), 'month')}`;
  return `talked ${n(d / (365 * DAY), 'year')}`;
}

/** A row's tooltip: since when, on which accounts ("Friends since Mar 2023 on Discord main and alt"). */
export function linkSinceLine(rel: P.LinkRelationship, since: number | null, accounts: string[]): string {
  const what = { friend: 'Friends', contact: 'In your contacts', following: 'Following', requested: 'Request sent', blocked: 'Blocked' }[rel];
  const when = since !== null && Number.isFinite(since) ? ` since ${new Date(since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : '';
  const on = accounts.length ? ` on ${accounts.length > 1 ? `${accounts.slice(0, -1).join(', ')} and ${accounts[accounts.length - 1]}` : accounts[0]}` : '';
  return `${what}${when}${on}`;
}

/**
 * How each of your accounts stands with them, for a profile: the accounts' own lists, else what a network's profile
 * said through the account that asked. Someone asking you is a request, not a list entry: the hero has Accept.
 */
export function profileLinks(
  identities: readonly Pick<P.IdentityView, 'id' | 'network'>[],
  links: readonly P.PersonLinkView[],
  abouts: Record<string, Pick<P.PersonAboutView, 'accountId' | 'relationship'> | undefined>,
): { identityId: string; network: P.Network; accountId: string; relationship: P.LinkRelationship }[] {
  const out: { identityId: string; network: P.Network; accountId: string; relationship: P.LinkRelationship }[] = [];
  for (const i of identities) {
    const listed = links.filter((l) => l.identityId === i.id);
    for (const l of listed) out.push({ identityId: i.id, network: i.network, accountId: l.accountId, relationship: l.relationship });
    const a = abouts[i.id];
    const rel = a?.relationship;
    if (a?.accountId && rel && rel !== 'stranger' && rel !== 'requesting' && !listed.some((l) => l.accountId === a.accountId)) out.push({ identityId: i.id, network: i.network, accountId: a.accountId, relationship: rel });
  }
  return out;
}

/** Who can end it: the account itself, connected, with the capability. */
export const canRemove = (account: Pick<P.AccountView, 'status' | 'capabilities'> | undefined) => !!account && account.status === 'online' && account.capabilities.includes('disconnect');
