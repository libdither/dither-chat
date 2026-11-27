/**
 * A person's switch row (docs/places.md "A person's networks"): which tabs it has, what a view shows and which route a
 * network's tab sends through. Pure, so tests can import it; ui/Pairs.tsx draws it. Apart from chatroutes.ts, which the
 * first load holds (pairpick.ts), so these stay in the conversation's chunk.
 */

/**
 * One tab of a person's switch row (docs/places.md "A person's networks"): All (`network` null), one network
 * (`net:<network>`), or a tab a caller adds after the networks (a person's posts). `unread`: how many are unread there.
 */
interface PersonTab<N extends string = string> {
  id: string;
  network: N | null;
  unread: number;
}

/** A network's tab id, and the network a tab id names (null for All, a route, or an added tab). */
export const netTab = (network: string) => `net:${network}`;
export const tabNetwork = (id: string): string | null => (id.startsWith('net:') ? id.slice(4) : null);

/**
 * The tabs of a person's page: All, then one per network they are reached on, then `extra`. None for a page of one
 * route and nothing added: there is nothing to switch between. A person on one network by several routes gets All
 * and that network.
 *
 * The networks are in the order of their names (`name`), mail last: an order that never changes as messages come,
 * so a tab stays where your eyes and keys left it. Unread is the sum over each network's routes, and All's over all.
 */
export function personTabs<N extends string>(routes: readonly { network: N; unread: number }[], name: (network: N) => string, extra: readonly PersonTab<N>[] = []): PersonTab<N>[] {
  if (routes.length < 2 && !extra.length) return [];
  const nets = new Map<N, number>();
  for (const r of routes) nets.set(r.network, (nets.get(r.network) ?? 0) + r.unread);
  const order = [...nets.keys()].sort((a, b) => Number(a === 'email') - Number(b === 'email') || name(a).localeCompare(name(b)) || a.localeCompare(b));
  const all = routes.reduce((n, r) => n + r.unread, 0);
  return [{ id: 'all', network: null, unread: all }, ...order.map((n): PersonTab<N> => ({ id: netTab(n), network: n, unread: nets.get(n)! })), ...extra];
}

/** The tab of their public posts, last in the row (ui/feed/PersonPosts.tsx, docs/places.md "A person's networks"). */
export const POSTS_TAB = 'posts';

/**
 * The networks of posts a person posts on that one of your accounts reads, in order: their identities' networks met
 * with the feed's (your accounts on networks of posts). None: no Posts tab. One: the tab carries its glyph.
 */
export function postNetworks<N extends string>(theirs: readonly N[], yours: readonly N[], ofPosts: readonly N[]): N[] {
  return [...new Set(theirs)].filter((n) => ofPosts.includes(n) && yours.includes(n)).sort();
}

/**
 * What a person's page shows (`viewing` in ui/Pairs.tsx): 'all', a network (`net:<network>`), one route by its id, or
 * an added tab of `extra` (Posts). One that no longer fits (a split, a removed account) is All again.
 */
export function viewIn(v: string | undefined, routes: readonly { id: string; network: string }[], extra: readonly string[] = []): string {
  if (!v) return 'all';
  if (extra.includes(v)) return v;
  const net = tabNetwork(v);
  if (net !== null) return routes.some((r) => r.network === net) ? v : 'all';
  return routes.some((r) => r.id === v) ? v : 'all';
}

/**
 * A pick against the address (docs/places.md "A person's networks"): it holds while the page stays at the address it
 * was made at (`addr`, the conversation the address names; '' for the person's own page). At another address that
 * names one of their chats (`opened`) it holds only while it still shows that chat: another network's tab, or an
 * added tab, would hide what you just opened, so the page is All again. A route shown alone needs no rule here: it
 * follows the route in use, which the address already sets (pairpick.ts).
 */
export function pickAt(pick: { v: string; at: string } | undefined, addr: string, opened: { network: string } | undefined, extra: readonly string[] = []): string | undefined {
  if (!pick) return undefined;
  if (!opened || pick.at === addr) return pick.v;
  const net = tabNetwork(pick.v);
  if (net !== null) return net === opened.network ? pick.v : undefined;
  return extra.includes(pick.v) ? undefined : pick.v;
}

/** Which tab of the row a view has chosen: a route shown alone chooses its network's. `extra`: the added tabs' ids. */
export function tabOf(v: string, routes: readonly { id: string; network: string }[], extra: readonly string[] = []): string {
  if (v === 'all' || tabNetwork(v) !== null || extra.includes(v)) return v;
  const r = routes.find((x) => x.id === v);
  return r ? netTab(r.network) : 'all';
}

/** The route a network's tab sends through: the one in use when it is on that network, else that network's latest. */
export function routeForTab<R extends { id: string; network: string; lastMessageAt: number | null }>(network: string, inUse: R, routes: readonly R[]): R | null {
  if (inUse.network === network) return inUse;
  return routes.filter((r) => r.network === network).reduce<R | null>((a, r) => (!a || (r.lastMessageAt ?? 0) > (a.lastMessageAt ?? 0) ? r : a), null);
}
