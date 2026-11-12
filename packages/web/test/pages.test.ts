/** Where back goes from a page on a phone (pages.ts): every route kind's own list, and how back gets there. */
import { expect, test } from 'bun:test';
import { isPage, isTabRoot, listToWrite, listUnder, opensOver, ownList, restAfter, wayBack, type Places } from '../src/pages.ts';
import { href, parseHash } from '../src/routes.ts';

// A channel in a server, a DM with a person, a group chat that lives in the inbox, and a channel in a second server.
const places: Places = {
  home: (id) =>
    id === 'chan' ? { view: 'space', space: 'srv', conv: 'chan' }
    : id === 'chan2' ? { view: 'space', space: 'srv2', conv: 'chan2' }
    : id === 'dm' ? { view: 'people', person: 'pal' }
    : { view: 'inbox', conv: id },
  placeHome: (r) => (r.space ? { view: 'space', space: r.space } : r.conv === 'chan' ? { view: 'space', space: 'srv' } : r.conv ? { view: 'inbox' } : null),
};
const R = (h: string) => parseHash(h);
const list = (h: string) => href(ownList(R(h), places));

// Every kind of route: what it is, and the list it belongs to.
const ROUTES: [hash: string, kind: 'list' | 'tab' | 'page' | 'over', own: string][] = [
  ['#/inbox', 'list', '#/inbox'],
  ['#/inbox/c/group', 'page', '#/inbox'],
  ['#/inbox/c/chan', 'page', '#/inbox'],
  ['#/inbox/c/mth_1', 'page', '#/inbox'],
  ['#/triage', 'tab', '#/triage'],
  ['#/model', 'over', '#/triage'],
  ['#/people', 'list', '#/people'],
  ['#/people/pal', 'page', '#/people'],
  ['#/people/graph', 'page', '#/people'],
  ['#/p/pal', 'over', '#/people'],
  ['#/i/ident', 'over', '#/people'],
  ['#/about/c/chan', 'over', '#/s/srv'],
  ['#/about/c/group', 'over', '#/inbox'],
  ['#/about/s/srv', 'over', '#/s/srv'],
  ['#/spaces', 'list', '#/spaces'],
  ['#/s/srv', 'list', '#/s/srv'],
  ['#/s/srv/c/chan', 'page', '#/s/srv'],
  ['#/f/fold', 'list', '#/f/fold'],
  ['#/f/fold/c/group', 'page', '#/f/fold'],
  ['#/f/fold/p/pal', 'page', '#/f/fold'],
  ['#/accounts', 'list', '#/accounts'],
  ['#/accounts/acc', 'over', '#/accounts'],
  ['#/settings', 'tab', '#/settings'],
  ['#/directory', 'over', '#/spaces'],
  ['#/search?q=hello', 'tab', '#/search?q=hello'],
  ['#/search/c/chan?q=hello&m=m1', 'page', '#/s/srv'],
  ['#/search/c/dm?q=hello', 'page', '#/people'],
  ['#/search/c/group?q=hello', 'page', '#/inbox'],
  ['#/search?q=in%3Achan%20hello', 'over', '#/s/srv'],
  ['#/mail', 'list', '#/mail'],
  ['#/mail/l/inbox', 'list', '#/mail/l/inbox'],
  ['#/mail/l/inbox/t/th', 'page', '#/mail/l/inbox'],
  ['#/mail/t/th', 'page', '#/mail'],
  ['#/requests', 'page', '#/inbox'],
  ['#/requests/req1', 'page', '#/inbox'],
  ['#/calendar', 'tab', '#/calendar'],
  ['#/calendar/day/2026-11-14?x', 'tab', '#/calendar/day/2026-11-14?x'],
];

test('the table covers every kind of route', () => {
  const views = new Set(ROUTES.map(([h]) => R(h).view));
  expect([...views].sort()).toEqual(['accounts', 'calendar', 'directory', 'folder', 'inbox', 'mail', 'model', 'people', 'profile', 'requests', 'search', 'settings', 'space', 'spaces', 'triage']);
});

test("the calendar's own hash is kept verbatim, query and all, both ways", () => {
  expect(R('#/calendar/day/2026-11-14?x')).toEqual({ view: 'calendar', at: 'day/2026-11-14?x' });
  expect(R('#/calendar/day/2026-11-14?e=evt_1%7C1800000000000')).toEqual({ view: 'calendar', at: 'day/2026-11-14?e=evt_1%7C1800000000000' });
  expect(R('#/calendar/search?q=dinner%20alice')).toEqual({ view: 'calendar', at: 'search?q=dinner%20alice' });
  expect(R('#/calendar')).toEqual({ view: 'calendar' });
  expect(R('#/calendar/')).toEqual({ view: 'calendar' });
  for (const h of ['#/calendar', '#/calendar/day/2026-11-14?x', '#/calendar/week/2026-11-09', '#/calendar/chats']) expect(href(R(h))).toBe(h);
});

test('pages, tabs and lists are told apart', () => {
  for (const [h, kind] of ROUTES) {
    const r = R(h);
    expect([h, isPage(r)]).toEqual([h, kind === 'page' || kind === 'over']);
    expect([h, isTabRoot(r)]).toEqual([h, kind === 'tab']);
    expect([h, opensOver(r)]).toEqual([h, kind === 'over']);
  }
});

test("each route's own list", () => {
  for (const [h, , own] of ROUTES) expect([h, list(h)]).toEqual([h, own]);
});

test('a list is its own list', () => {
  for (const [h] of ROUTES) {
    const own = ownList(R(h), places);
    expect([h, href(ownList(own, places))]).toEqual([h, href(own)]);
    expect([h, isPage(own)]).toEqual([h, false]);
  }
});

test("a list's pages keep their list under them in history; pages opened over another and lists keep none", () => {
  for (const [h, kind, own] of ROUTES) {
    const under = listUnder(R(h), places);
    expect([h, under && href(under)]).toEqual([h, kind === 'page' ? own : null]);
  }
});

test('going to a page writes its list first, unless it comes from that list or jumps within the page', () => {
  const written = (to: string, from: string | null) => {
    const l = listToWrite(R(to), from ? R(from) : null, places);
    return l && href(l);
  };
  expect(written('#/s/srv/c/chan', '#/s/srv')).toBeNull();
  expect(written('#/s/srv/c/chan', '#/search?q=hello')).toBe('#/s/srv');
  expect(written('#/s/srv2/c/chan2', '#/s/srv/c/chan')).toBe('#/s/srv2');
  expect(written('#/inbox/c/dm', '#/s/srv/c/chan')).toBe('#/inbox');
  expect(written('#/search/c/chan?q=hello&m=m1', '#/search?q=hello')).toBe('#/s/srv');
  // The app opened on it, from a link or a notification: nothing before it.
  expect(written('#/inbox/c/dm', null)).toBe('#/inbox');
  // A jump to a message in the conversation it is on.
  expect(written('#/inbox/c/group?m=m2', '#/inbox/c/group')).toBeNull();
  expect(written('#/inbox/c/group?m=m3', '#/inbox/c/group?m=m2')).toBeNull();
  // Requests is a row in the inbox; from elsewhere the inbox goes under it, but not between two of its requests.
  expect(written('#/requests', '#/inbox')).toBeNull();
  expect(written('#/requests/req1', '#/p/pal')).toBe('#/inbox');
  expect(written('#/requests', '#/requests/req1')).toBeNull();
  // A page opened over another, and a list, have none.
  expect(written('#/p/pal', '#/s/srv/c/chan')).toBeNull();
  expect(written('#/s/srv', '#/s/srv/c/chan')).toBeNull();
});

test("back from a list's page always goes to its list, and steps back through history only when that is the entry before", () => {
  const way = (h: string, prev: string | null) => {
    const w = wayBack(R(h), prev ? R(prev) : null, places);
    return [href(w.to), w.how];
  };
  // From its own list: history.
  expect(way('#/s/srv/c/chan', '#/s/srv')).toEqual(['#/s/srv', 'back']);
  expect(way('#/inbox/c/group', '#/inbox')).toEqual(['#/inbox', 'back']);
  expect(way('#/mail/l/inbox/t/th', '#/mail/l/inbox')).toEqual(['#/mail/l/inbox', 'back']);
  // Opened from somewhere else: that page's list, never where it came from.
  expect(way('#/s/srv/c/chan', '#/search?q=hello')).toEqual(['#/s/srv', 'replace']);
  expect(way('#/s/srv2/c/chan2', '#/s/srv/c/chan')).toEqual(['#/s/srv2', 'replace']);
  expect(way('#/s/srv2/c/chan2', '#/s/srv')).toEqual(['#/s/srv2', 'replace']);
  expect(way('#/people/pal', '#/p/pal')).toEqual(['#/people', 'replace']);
  expect(way('#/inbox/c/group', '#/triage')).toEqual(['#/inbox', 'replace']);
  // A notification opens a conversation in the inbox, with nothing before it.
  expect(way('#/inbox/c/dm', null)).toEqual(['#/inbox', 'replace']);
  // A search hit goes to the list the conversation lives in, not back to the results.
  expect(way('#/search/c/chan?q=hello&m=m1', '#/search?q=hello')).toEqual(['#/s/srv', 'replace']);
  expect(way('#/search/c/chan?q=hello&m=m1', '#/s/srv')).toEqual(['#/s/srv', 'back']);
});

test('back from a page opened over another closes it onto that page, or goes to its list when opened directly', () => {
  const way = (h: string, prev: string | null) => {
    const w = wayBack(R(h), prev ? R(prev) : null, places);
    return [href(w.to), w.how];
  };
  expect(way('#/p/pal', '#/s/srv/c/chan')).toEqual(['#/s/srv/c/chan', 'back']);
  // How it sorts, from Catch up or Settings; opened directly, back goes to Catch up.
  expect(way('#/model', '#/triage')).toEqual(['#/triage', 'back']);
  expect(way('#/model', '#/settings')).toEqual(['#/settings', 'back']);
  expect(way('#/model', null)).toEqual(['#/triage', 'replace']);
  expect(way('#/p/pal', null)).toEqual(['#/people', 'replace']);
  expect(way('#/about/c/chan', null)).toEqual(['#/s/srv', 'replace']);
  expect(way('#/accounts/acc', '#/settings')).toEqual(['#/settings', 'back']);
  expect(way('#/directory', null)).toEqual(['#/spaces', 'replace']);
  // Searching one conversation goes back to that conversation.
  expect(way('#/search?q=in%3Achan%20hello', '#/s/srv/c/chan')).toEqual(['#/s/srv/c/chan', 'back']);
  expect(way('#/search?q=in%3Achan%20hello', null)).toEqual(['#/s/srv/c/chan', 'replace']);
});

test("the card's rest after back matches where back lands", () => {
  // A list's page always lands beside its list, peeking.
  for (const [h, kind] of ROUTES) {
    if (kind !== 'page') continue;
    for (const prev of [null, '#/search?q=hello', '#/s/srv2/c/chan2', '#/p/pal']) {
      const r = R(h);
      expect([h, prev, restAfter(r, wayBack(r, prev ? R(prev) : null, places).to, places)]).toEqual([h, prev, 'peek']);
    }
  }
  const after = (h: string, prev: string) => restAfter(R(h), wayBack(R(h), R(prev), places).to, places);
  // Onto a page or a tab: the card stays open with that page in it.
  expect(after('#/p/pal', '#/s/srv/c/chan')).toBe('open');
  expect(after('#/accounts/acc', '#/settings')).toBe('open');
  // Onto a list: beside it when the page belongs there, else off screen.
  expect(after('#/p/pal', '#/people')).toBe('peek');
  expect(after('#/p/pal', '#/inbox')).toBe('away');
  expect(after('#/directory', '#/inbox')).toBe('away');
});

