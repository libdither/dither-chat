/**
 * What tells one route of a chat from the others (docs/chats.md): the one rule every part of a person's page asks
 * before it adds anything, so a simple chat looks simple and each extra piece appears only when the chat needs it.
 * Pure, so tests can import it; ui/Pairs.tsx puts names to what it says. The same thinking names a message's
 * author: by its account's own name, with the account's identifier only where two accounts on one side share a name
 * (`headIdents`).
 *
 * A route is a conversation with them and the account of yours in it. Of a chat's routes, look at those on the same
 * network as this one:
 *
 * - the chat has one route: nothing tells it apart, and the page is a plain conversation's;
 * - it is the only route on its network: the network alone;
 * - they differ in their account: their account's name there;
 * - they differ in yours: your account's name;
 * - both differ: both.
 *
 * The network is part of a label only when the chat spans more than one network.
 */

/** A route as the rule sees it: ids only. */
export interface RouteKey {
  /** The conversation. */
  id: string;
  network: string;
  /** Their identity in it. */
  theirs: string | null;
  /** Your account in it. */
  mine: string | null;
}

/** Which parts a route's label needs. All false: the chat has one route. */
export interface Tells {
  network: boolean;
  theirs: boolean;
  mine: boolean;
}

const NOTHING: Tells = { network: false, theirs: false, mine: false };
const count = <T>(xs: T[]) => new Set(xs).size;

export function tells(route: RouteKey, routes: RouteKey[]): Tells {
  if (routes.length <= 1) return NOTHING;
  const nets = count(routes.map((r) => r.network)) > 1;
  const same = routes.filter((r) => r.network === route.network);
  if (same.length <= 1) return { network: true, theirs: false, mine: false };
  const theirs = count(same.map((r) => r.theirs)) > 1;
  const mine = count(same.map((r) => r.mine)) > 1;
  // Two conversations between the same two accounts (a DM that was started again): both names, which is all there is.
  if (!theirs && !mine) return { network: nets, theirs: true, mine: true };
  return { network: nets, theirs, mine };
}

/** The names a label is made of. */
export interface RouteNames {
  network: string;
  theirs: string;
  mine: string;
}

/**
 * A route's label as text: `Signal`, `kit.work`, `via zyn.alt` or `kit.work ⇄ zyn.alt`, after the network's name when
 * networks mix (the page draws the network's icon there instead, so `withNetwork` is false for it). Empty for a chat of
 * one route.
 */
export function labelText(t: Tells, n: RouteNames, withNetwork = true): string {
  const who = t.theirs && t.mine ? `${n.theirs} ⇄ ${n.mine}` : t.theirs ? n.theirs : t.mine ? `via ${n.mine}` : '';
  if (!who) return t.network ? n.network : '';
  return t.network && withNetwork ? `${n.network} ${who}` : who;
}

/** Whose account a message head names: theirs, yours, or someone else's (a bot in a DM). */
export type Side = 'theirs' | 'mine' | 'other';

/**
 * What a route tag still has to say once the message head has named the author's account: the route's label without
 * the author's side. Their message drops their account (`via zyn.alt` is left where yours differ); yours drops yours
 * (`to kit.work` is left where theirs differ). The network stays where networks mix, as an icon.
 */
export function tagTells(route: RouteKey, routes: RouteKey[], side: Side): Tells {
  const t = tells(route, routes);
  if (side === 'theirs') return { ...t, theirs: false };
  if (side === 'mine') return { ...t, mine: false };
  return t;
}

/**
 * A route tag's words (the page draws the network's icon in front where `t.network`): `via zyn.alt` after their
 * message, `to kit.work` after yours, nothing where the head already said it all. Someone else's message keeps the
 * whole label.
 */
export function tagText(t: Tells, n: RouteNames, side: Side): string {
  if (side === 'other') return labelText(t, n, false);
  if (t.theirs && t.mine) return `${n.theirs} ⇄ ${n.mine}`;
  if (t.mine) return `via ${n.mine}`;
  if (t.theirs) return `to ${n.theirs}`;
  return '';
}

/**
 * An account's name as you see it (docs/chats.md, Names): your nickname for it, else its display name, else its
 * handle, else its id. A person's name is made of these on the hub, so it follows.
 */
export const accountName = (i: { nickname?: string | null; displayName?: string | null; handle?: string | null; nativeId: string }): string =>
  i.nickname || i.displayName || i.handle || i.nativeId;

/** An account as a message head names it: its name as you see it, and what identifies it on its network (a handle, else an id). */
export interface HeadName {
  id: string;
  network: string;
  name: string;
  ident: string | null;
}

const sameName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Which accounts on one side of a chat need their identifier after their name, and what it is: only those whose name
 * another account on the same side and the same network would also show (Mo is "Mo" on two Discord accounts),
 * compared ignoring case. Two networks never need it: the network's badge on the picture already tells them apart, so
 * "Kit" on Discord and "Kit" on Telegram stay "Kit", and no phone number lands in a head. An identifier that says no
 * more than the name is left out. Call it once for their side and once for yours.
 */
export function headIdents(accounts: HeadName[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  const each = accounts.filter((a, i) => accounts.findIndex((b) => b.id === a.id) === i);
  const key = (a: HeadName) => `${a.network}\n${sameName(a.name)}`;
  for (const a of each) seen.set(key(a), (seen.get(key(a)) ?? 0) + 1);
  for (const a of each) if ((seen.get(key(a)) ?? 0) > 1 && a.ident && sameName(a.ident) !== sameName(a.name)) out.set(a.id, a.ident);
  return out;
}

/**
 * The message box's line, by the same rule and no more: their network when networks mix, their account when theirs
 * on that network differ, and yours only when the account of theirs you chose can be reached from several of yours.
 */
export function leadTells(route: RouteKey, routes: RouteKey[]): Tells {
  if (routes.length <= 1) return NOTHING;
  const t = tells(route, routes);
  const viaMine = count(routes.filter((r) => r.network === route.network && r.theirs === route.theirs).map((r) => r.mine)) > 1;
  return { network: count(routes.map((r) => r.network)) > 1, theirs: t.theirs, mine: viaMine };
}

/**
 * Whether the network's badge goes on the pictures of a chat's messages: only when it would differ between its
 * routes, that is when the chat spans networks or two of your accounts on one network. Never in a chat of one route.
 */
export function badgeDiffers(routes: RouteKey[]): boolean {
  if (routes.length <= 1) return false;
  if (count(routes.map((r) => r.network)) > 1) return true;
  return count(routes.map((r) => r.mine)) > 1;
}

// ------------------------------------------------------------------ the inbox

/** One route's inbox row, as the merge needs it (model.ts makes these of the hub's scores). */
export interface RoutePart {
  key: string;
  score: number;
  needs: boolean;
  reasons: string[];
  owedSince: number | null;
  /** Its latest message, anyone's. */
  last: number;
  unread: number;
  muted: boolean;
}

export interface Merged<T extends RoutePart> {
  score: number;
  needs: boolean;
  reasons: string[];
  owedSince: number | null;
  unread: number;
  muted: boolean;
  /** The route with the highest score: its reasons are the row's. */
  top: T;
  /** The route of the latest message: the row's picture, preview, and what a click opens. */
  latest: T;
}

/**
 * A person with several routes is one row of the inbox (docs/inbox.md): it scores the highest of its routes, needs
 * you if any does, is owed since the earliest, sums the unread, and is muted only if every route is. The reasons are
 * the top route's.
 */
export function mergeRoutes<T extends RoutePart>(parts: T[]): Merged<T> {
  const top = parts.reduce((a, b) => (b.score > a.score ? b : a));
  const latest = parts.reduce((a, b) => (b.last > a.last ? b : a));
  const owed = parts.map((p) => p.owedSince).filter((x): x is number => x !== null);
  return {
    score: top.score,
    needs: parts.some((p) => p.needs),
    reasons: top.reasons,
    owedSince: owed.length ? Math.min(...owed) : null,
    unread: parts.reduce((n, p) => n + p.unread, 0),
    muted: parts.every((p) => p.muted),
    top,
    latest,
  };
}

/** The inbox's key for a chat of several routes. A conversation keeps its own id as its key. */
export const chatKey = (personId: string) => `person:${personId}`;

/** A person's chat as one inbox row: the merge, its key, and its routes' rows newest first. */
export interface ChatRow<T extends RoutePart> extends Merged<T> {
  key: string;
  personId: string;
  parts: T[];
}

/**
 * The inbox's rows with each person's routes made one (model.ts convRows): `chatOf` names the person whose chat of
 * several routes a row is a route of, else null, and such rows come back merged under `person:<id>`. The rest stay
 * as they are.
 */
export function groupChats<T extends RoutePart>(rows: T[], chatOf: (r: T) => string | null): { rows: T[]; chats: ChatRow<T>[] } {
  const plain: T[] = [];
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const p = chatOf(r);
    if (!p) plain.push(r);
    else by.set(p, [...(by.get(p) ?? []), r]);
  }
  const chats = [...by].map(([personId, parts]): ChatRow<T> => ({ ...mergeRoutes(parts), key: chatKey(personId), personId, parts: [...parts].sort((a, b) => b.last - a.last) }));
  return { rows: plain, chats };
}
