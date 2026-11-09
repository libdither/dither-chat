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

/** One group per kind that has any, newest first in each. */
export function groupRequests(rs: readonly P.RequestView[]): { kind: Kind; title: string; requests: P.RequestView[] }[] {
  return REQUEST_GROUPS.map((g) => ({ ...g, requests: rs.filter((r) => r.kind === g.kind).sort((a, b) => b.ts - a.ts) })).filter((g) => g.requests.length);
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

/** "23 members", for an invite or a join request whose place says. */
export function targetMembers(r: Pick<P.RequestView, 'target'>): string | null {
  const n = r.target?.members;
  return typeof n === 'number' ? `${n.toLocaleString('en-US')} member${n === 1 ? '' : 's'}` : null;
}

export const ANSWER_LABEL: Record<P.RequestAnswer, string> = { accept: 'Accept', decline: 'Decline', block: 'Block' };

/** The inbox's Requests row: how many, who, and the newest. Null when nothing waits. */
export function requestsRow(rs: readonly P.RequestView[], nameOf: (identityId: string | null) => string): { count: number; names: string[]; lastAt: number } | null {
  if (!rs.length) return null;
  const sorted = [...rs].sort((a, b) => b.ts - a.ts);
  const names = [...new Set(sorted.map((r) => nameOf(r.from)))].slice(0, 4);
  return { count: rs.length, names, lastAt: sorted[0].ts };
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
  | { kind: 'answer'; request: P.RequestView }
  /** Nothing to do but say so. */
  | { kind: 'state'; label: string };

/**
 * What a profile offers on one network, from how the network says you stand with them: Add friend, Follow or Add
 * contact for a stranger where an account can; Accept or Decline what they asked; "Request sent", "Following".
 * Null where nothing can be done: no account with the capability, no way on that network.
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
    case 'requested':
      return { kind: 'state', label: 'Request sent' };
    case 'following':
      return { kind: 'state', label: 'Following' };
    default:
      return null;
  }
}
