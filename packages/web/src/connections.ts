/**
 * Connections (docs/profile.md "Connections"): how your accounts stand with someone, in one vocabulary across
 * networks. A Discord friend and an X account you follow each other with are both Friends; following one way is
 * You follow or Follows you; an address book on Telegram, Signal or WhatsApp is Contact. Each stays per account,
 * with its network, and ends the way its network ends it (Remove friend, Unfollow, Remove contact). Follower counts
 * are facts about an account, not a connection: they stay in About. No browser needed, so it can be tested alone.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { profileLinks } from './requests.ts';

/** One vocabulary: what each kind is called, in this order wherever they are listed. */
export type ConnectionKind = 'friend' | 'contact' | 'following' | 'follower' | 'requested' | 'blocked';

export const CONNECTION_KINDS: readonly ConnectionKind[] = ['friend', 'contact', 'following', 'follower', 'requested', 'blocked'];

/** A group's title on the profile's Connections card, and a tag's word in the hero. */
export const CONNECTION_TITLE: Record<ConnectionKind, { group: string; tag: string }> = {
  friend: { group: 'Friends', tag: 'Friend' },
  contact: { group: 'Contacts', tag: 'Contact' },
  following: { group: 'You follow', tag: 'You follow' },
  follower: { group: 'Follows you', tag: 'Follows you' },
  requested: { group: 'Requests sent', tag: 'Request sent' },
  blocked: { group: 'Blocked', tag: 'Blocked' },
};

export interface Connection {
  kind: ConnectionKind;
  identityId: string;
  network: P.Network;
  accountId: string;
  /** What ends it on the network (its remove), or null where nothing can: someone following you. */
  ends: P.LinkRelationship | null;
  /** ms epoch, when the network says it began. */
  since: number | null;
}

/**
 * Each of your accounts' connection with them: the accounts' lists, else what the network's profile said through the
 * account that asked (requests.ts profileLinks), with X's `followsYou` folded in: following and followed back is
 * one Friend; followed back only is Follows you. Ordered by kind, then as their accounts are.
 */
export function connections(
  identities: readonly Pick<P.IdentityView, 'id' | 'network'>[],
  links: readonly P.PersonLinkView[],
  abouts: Record<string, Pick<P.PersonAboutView, 'accountId' | 'relationship' | 'followsYou'> | undefined>,
): Connection[] {
  const out: Connection[] = [];
  const since = (identityId: string, accountId: string) => links.find((l) => l.identityId === identityId && l.accountId === accountId)?.since ?? null;
  for (const x of profileLinks(identities, links, abouts)) {
    const a = abouts[x.identityId];
    const back = x.relationship === 'following' && ((a?.followsYou && a.accountId === x.accountId) || links.some((l) => l.identityId === x.identityId && l.accountId === x.accountId && l.followsYou));
    out.push({ kind: back ? 'friend' : (x.relationship as ConnectionKind), identityId: x.identityId, network: x.network, accountId: x.accountId, ends: x.relationship, since: since(x.identityId, x.accountId) });
  }
  // Follows you, and you do not follow them (or not through that account).
  for (const i of identities) {
    const a = abouts[i.id];
    if (a?.followsYou && a.accountId && !out.some((c) => c.identityId === i.id && c.accountId === a.accountId && (c.kind === 'friend' || c.kind === 'blocked')))
      out.push({ kind: 'follower', identityId: i.id, network: i.network, accountId: a.accountId, ends: null, since: null });
  }
  return out.sort((a, b) => CONNECTION_KINDS.indexOf(a.kind) - CONNECTION_KINDS.indexOf(b.kind));
}

/**
 * One connection in words, saying the network's own kind of it: "Friends on Discord", "You follow each other on
 * X", "In your Telegram contacts", "You follow them on X", "Follows you on X", "Friend request sent on Discord",
 * "Blocked on Discord".
 */
export function connectionLine(c: Pick<Connection, 'kind' | 'network' | 'ends'>): string {
  const net = NETWORK_META[c.network].name;
  switch (c.kind) {
    case 'friend':
      return c.ends === 'following' ? `You follow each other on ${net}` : `Friends on ${net}`;
    case 'contact':
      return `In your ${net} contacts`;
    case 'following':
      return `You follow them on ${net}`;
    case 'follower':
      return `Follows you on ${net}`;
    case 'requested':
      return `Friend request sent on ${net}`;
    case 'blocked':
      return `Blocked on ${net}`;
  }
}

/** The hero's tags: one per kind, with the networks it is on, in the vocabulary's order. A kind on no network: none. */
export function connectionTags(list: readonly Pick<Connection, 'kind' | 'network' | 'ends'>[]): { kind: ConnectionKind; label: string; networks: P.Network[]; title: string }[] {
  return CONNECTION_KINDS.flatMap((kind) => {
    const of = list.filter((c) => c.kind === kind);
    if (!of.length) return [];
    const networks = [...new Set(of.map((c) => c.network))];
    const lines = [...new Set(of.map(connectionLine))];
    return [{ kind, label: CONNECTION_TITLE[kind].tag, networks, title: lines.join('; ') }];
  });
}

/** A kind on People's lists: Friends holds friends and mutual follows; Following, everyone followed. */
export function linkKind(l: Pick<P.PersonLinkView, 'relationship' | 'followsYou'>): ConnectionKind {
  return l.relationship === 'following' && l.followsYou ? 'friend' : (l.relationship as ConnectionKind);
}

/**
 * A row's line on People's lists when there is no talk to tell, from its links: "Friends on Discord and X", "You
 * follow each other on X", "In your Telegram contacts".
 */
export function linksLine(links: readonly Pick<P.PersonLinkView, 'relationship' | 'followsYou' | 'accountId'>[], networkOf: (accountId: string) => P.Network | undefined): string {
  const parts = links.map((l) => ({ kind: linkKind(l), ends: l.relationship, network: networkOf(l.accountId) })).filter((x): x is { kind: ConnectionKind; ends: P.LinkRelationship; network: P.Network } => !!x.network);
  if (!parts.length) return '';
  const nets = [...new Set(parts.map((p) => p.network))];
  if (nets.length === 1) return connectionLine(parts[0]);
  const kinds = new Set(parts.map((p) => p.kind));
  const names = nets.map((n) => NETWORK_META[n].name);
  const on = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return kinds.size === 1 ? `${CONNECTION_TITLE[parts[0].kind].group} on ${on}` : `On ${on}`;
}
