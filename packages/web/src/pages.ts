/**
 * Where back goes from each page on a phone, the way Discord does it (docs/phone.md). A page is a card over the
 * lists. A conversation, a person's thread, a mail thread, Requests or the people graph belongs to a list, and
 * going back from it (a swipe, its back button, the phone's) always shows that list with the page peeking at its
 * edge, never whatever was open before it. A profile, a place's About page, a search in one conversation, an
 * account page and All communities instead open on top of the page you were on, as Discord opens a profile or a
 * search over the channel; back closes them onto that page. A post's thread, and a thread or forum post opened from
 * its channel, stack on the page they were opened from the same way (`stacksOn`). Pure: what it needs of the hub's
 * data comes in as `Places`.
 */
import { searchOp } from '@dither-chat/protocol';
import { isPostKey } from './feed.ts';
import { href, type Route } from './routes.ts';

/** What the pages need to know of the hub's data. */
export interface Places {
  /** A conversation's page where it lives: in its community, under People for a DM, else in the inbox. */
  home(conv: string): Route;
  /** The list a place's About page belongs to: the community it is in (or is), else the inbox. Null for a person. */
  placeHome(r: Extract<Route, { view: 'profile' }>): Route | null;
  /** The conversation a thread or forum post was started in; null for any other conversation. */
  parent(conv: string): string | null;
}

/** The conversation a route shows (not its About page, which is a profile). */
const convOf = (r: Route): string | undefined => (r.view === 'profile' ? undefined : 'conv' in r ? r.conv : undefined);

/**
 * Whether page `to`, opened from route `from`, goes on top of it rather than on its list: back closes it onto `from`.
 * A post's thread does from anywhere (another post, the feed, a profile, search results), as X goes back from a reply
 * to the post it was opened from; a thread or forum post does from the channel it is in, as Discord does. Opened
 * directly (from nothing) it is a list's page like any other.
 */
export function stacksOn(to: Route, from: Route | null, places: Places): boolean {
  if (!from || !isPage(to)) return false;
  const conv = convOf(to);
  if (!conv) return false;
  if (isPostKey(conv)) return true;
  const parent = places.parent(conv);
  return !!parent && convOf(from) === parent;
}

/** A page that slides in over the lists. */
export function isPage(r: Route): boolean {
  switch (r.view) {
    case 'search':
      // Searching one conversation is a page of that conversation, with the way back to it.
      return !!r.conv || !!searchOp(r.q, 'in');
    case 'inbox':
    case 'space':
      return !!r.conv;
    case 'people':
      return !!r.person || !!r.graph;
    case 'folder':
      return !!(r.conv || r.person);
    case 'accounts':
      return !!r.account;
    case 'mail':
      return !!r.thread;
    case 'profile':
    case 'directory':
    case 'requests':
    case 'notices':
    case 'model':
      return true;
    default:
      return false;
  }
}

/** A tab's own page: full screen, with the tab bar under it. */
export const isTabRoot = (r: Route) => r.view === 'triage' || r.view === 'settings' || r.view === 'calendar' || (r.view === 'search' && !isPage(r));

/** A page opened on top of the page you were on, rather than one of a list's own. */
export function opensOver(r: Route): boolean {
  switch (r.view) {
    case 'profile':
    case 'directory':
    case 'model':
      return true;
    case 'accounts':
      return !!r.account;
    case 'search':
      return !r.conv && !!searchOp(r.q, 'in');
    default:
      return false;
  }
}

/** The list a page belongs to. A list or a tab is its own. */
export function ownList(r: Route, places: Places): Route {
  switch (r.view) {
    case 'inbox':
    case 'requests':
    case 'notices':
      // A chat or a mail thread opened in the inbox (a notification opens one there too), and Requests and Notices, rows in it.
      return { view: 'inbox' };
    case 'people':
      return { view: 'people' };
    case 'space':
      return { view: 'space', space: r.space };
    case 'folder':
      return { view: 'folder', folder: r.folder };
    case 'accounts':
      return { view: 'accounts' };
    case 'mail':
      return r.list ? { view: 'mail', list: r.list } : { view: 'mail' };
    case 'directory':
      return { view: 'spaces' };
    // How it sorts is reached from Catch up, Settings or the inbox's menu; opened directly, back goes to Catch up.
    case 'model':
      return { view: 'triage' };
    case 'profile':
      return places.placeHome(r) ?? { view: 'people' };
    case 'search': {
      // A conversation opened from search is filed where it lives, not under the results: Discord jumps to the channel.
      const conv = r.conv ?? searchOp(r.q, 'in');
      return conv ? ownList(places.home(conv), places) : { view: 'search', q: r.q };
    }
    default:
      return r;
  }
}

/** Routes with the same key show the same list, so a page left on one of them peeks beside it. */
export const listKey = (r: Route, places: Places) => href(ownList(r, places));

/**
 * The list to keep under a page in history, so the phone's back button shows it like the swipe does: a list's
 * own pages have one; a page opened on top of another has none, and nor has a list.
 */
export const listUnder = (r: Route, places: Places): Route | null => (isPage(r) && !opensOver(r) ? ownList(r, places) : null);

/** A page's address without the message it is scrolled to, or the request or notice it shows. */
const bare = (r: Route) => href(r.view === 'requests' ? { view: 'requests' } : r.view === 'notices' ? { view: 'notices' } : 'msg' in r ? { ...r, msg: undefined } : r);

/**
 * The entry to write before page `to` when going there `from` a route (null for an entry made outside the app, which
 * has nothing before it): its list, but none when it comes from that list, for a jump within the page it is on (to a
 * message, or another request), or for a page that stacks on the one it comes from. A page that opens over another,
 * opened directly, gets its list too, so the phone's back button never leaves the app from a page.
 */
export function listToWrite(to: Route, from: Route | null, places: Places): Route | null {
  if (!from && opensOver(to)) return ownList(to, places);
  const list = listUnder(to, places);
  if (!list || !from) return list;
  if (stacksOn(to, from, places)) return null;
  return href(from) === href(list) || bare(from) === bare(to) ? null : list;
}

/**
 * Where back goes from page `r`, given the route of the history entry before it (null when the page was opened
 * directly), and how: `back` steps back through history to it, `replace` puts it in the page's place.
 */
export function wayBack(r: Route, prev: Route | null, places: Places): { to: Route; how: 'back' | 'replace' } {
  if (prev && stacksOn(r, prev, places)) return { to: prev, how: 'back' };
  if (opensOver(r)) {
    if (prev) return { to: prev, how: 'back' };
    // Opened directly: searching a conversation goes back to that conversation, the rest to their list.
    const conv = r.view === 'search' ? searchOp(r.q, 'in') : null;
    return { to: conv ? places.home(conv) : ownList(r, places), how: 'replace' };
  }
  const to = ownList(r, places);
  return { to, how: prev && href(prev) === href(to) ? 'back' : 'replace' };
}

/**
 * How the card rests once back from page `r` has landed on `to`: open with the page there, beside the list with
 * `r` peeking when it is `r`'s own, else off screen.
 */
export function restAfter(r: Route, to: Route, places: Places): 'open' | 'peek' | 'away' {
  if (isPage(to) || isTabRoot(to)) return 'open';
  return listKey(to, places) === listKey(r, places) ? 'peek' : 'away';
}
