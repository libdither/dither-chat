/**
 * Navigation as a whole on a phone (docs/phone.md "Back"): a model of the history state.ts writes (go, adoptEntry)
 * and of App's back (leave), driven over every pair of routes and over chains of pages, checking what must hold
 * whatever a later change adds:
 *
 * - the three ways back agree: the phone's back button (a step back through history) lands where the page's back
 *   button and the swipe (wayBack) land;
 * - back from a page never leaves the app: there is always a list or a tab under it;
 * - a page that stacks on another (a post's thread, a thread from its channel) goes back to exactly that page;
 * - pressing a page's back button again and again reaches a list or a tab, and never goes round in a circle.
 *
 * A new kind of route goes in ROUTES (pages.test.ts checks each kind's list); a new rule for where back goes is in
 * pages.ts, and this test says whether the rest still fits with it.
 */
import { expect, test } from 'bun:test';
import { isPage, isTabRoot, listToWrite, stacksOn, wayBack, type Places } from '../src/pages.ts';
import { href, parseHash } from '../src/routes.ts';

const places: Places = {
  home: (id) =>
    id === 'chan' || id === 'thr' ? { view: 'space', space: 'srv', conv: id }
    : id === 'chan2' ? { view: 'space', space: 'srv2', conv: 'chan2' }
    : id === 'dm' ? { view: 'people', person: 'pal' }
    : { view: 'inbox', conv: id },
  placeHome: (r) => (r.space ? { view: 'space', space: r.space } : r.conv === 'chan' || r.conv === 'thr' ? { view: 'space', space: 'srv' } : r.conv ? { view: 'inbox' } : null),
  parent: (id) => (id === 'thr' ? 'chan' : null),
};

/** One of every kind of place: lists, tabs, a list's pages, pages opened over others, posts and a thread. */
const ROUTES = [
  '#/inbox',
  '#/inbox/c/group',
  '#/inbox/c/group?m=m2',
  '#/inbox/c/feedx',
  '#/inbox/c/pst_x_1',
  '#/inbox/c/pst_x_2',
  '#/inbox/c/mth_1',
  '#/triage',
  '#/model',
  '#/people',
  '#/people/pal',
  '#/people/graph',
  '#/p/pal',
  '#/i/ident',
  '#/about/c/chan',
  '#/about/s/srv',
  '#/spaces',
  '#/s/srv',
  '#/s/srv/c/chan',
  '#/s/srv/c/thr',
  '#/s/srv2/c/chan2',
  '#/f/fold',
  '#/f/fold/c/group',
  '#/accounts',
  '#/accounts/acc',
  '#/settings',
  '#/directory',
  '#/search?q=hello',
  '#/search/c/chan?q=hello&m=m1',
  '#/search?q=in%3Achan%20hello',
  '#/mail',
  '#/mail/l/inbox/t/th',
  '#/requests',
  '#/requests/req1',
  '#/notices/ntc_1',
  '#/calendar',
];

const R = parseHash;
const isRest = (h: string) => !isPage(R(h));

/** The browser's history as state.ts writes it on a phone: entries of { hash, prev }, the one shown at `at`. */
class Phone {
  entries: { hash: string; prev: string | null }[] = [];
  at = -1;
  get now() {
    return this.entries[this.at];
  }
  /** Opened from a link or a notification: adoptEntry, nothing before it. */
  constructor(h: string) {
    this.write(h, null, null);
  }
  /** state.ts write(): the list it keeps under a page first, then the page. */
  private write(h: string, prev: string | null, from: string | null) {
    this.entries.length = this.at + 1;
    const list = listToWrite(R(h), from === null ? null : R(from), places);
    const under = list && href(list);
    if (under) this.entries.push({ hash: under, prev });
    this.entries.push({ hash: h, prev: under ?? prev });
    this.at = this.entries.length - 1;
  }
  /** go(): a link, a row, a button. */
  go(h: string) {
    if (h !== this.now.hash) this.write(h, this.now.hash, this.now.hash);
    return this;
  }
  /** The phone's back button. Null: it left the app. */
  hardwareBack(): string | null {
    this.at--;
    return this.at < 0 ? null : this.now.hash;
  }
  /** The page's back button and the swipe: App's leave(). */
  leave(): string {
    const cur = this.now;
    const way = wayBack(R(cur.hash), cur.prev === null ? null : R(cur.prev), places);
    if (way.how === 'back') this.at--;
    else this.entries[this.at] = { hash: href(way.to), prev: cur.prev };
    return this.now.hash;
  }
  clone() {
    const p = Object.create(Phone.prototype) as Phone;
    p.entries = this.entries.map((e) => ({ ...e }));
    p.at = this.at;
    return p;
  }
}

/** Every way to reach a page: opened directly, or from each route (itself opened directly). */
function* arrivals(to: string) {
  yield { path: [to], phone: new Phone(to) };
  for (const from of ROUTES) if (from !== to) yield { path: [from, to], phone: new Phone(from).go(to) };
}

/** Same page, ignoring the message it is scrolled to. */
const samePage = (a: string | null, b: string | null) => a !== null && b !== null && a.replace(/[?&]m=[^&]*/, '') === b.replace(/[?&]m=[^&]*/, '');

test('the phone back button lands where the page back button and the swipe land', () => {
  const off: string[] = [];
  for (const to of ROUTES) {
    if (!isPage(R(to))) continue;
    for (const { path, phone } of arrivals(to)) {
      const hw = phone.clone().hardwareBack();
      const sw = phone.clone().leave();
      // A jump within the page it is on (to a message, to another request) is a step the phone's back button takes
      // back, while the page's back button leaves the page: both are meant.
      const jump = path.length === 2 && samePage(path[0].replace(/\/req1$|\/ntc_1$/, ''), to.replace(/\/req1$|\/ntc_1$/, ''));
      if (!jump && hw !== sw) off.push(`${path.join(' → ')}: phone back ${hw}, page back ${sw}`);
    }
  }
  expect(off).toEqual([]);
});

test('back from a page never leaves the app: a list or a tab is always under it', () => {
  const off: string[] = [];
  for (const to of ROUTES) {
    if (!isPage(R(to))) continue;
    for (const { path, phone } of arrivals(to)) {
      let h: string | null = to;
      for (let i = 0; i < 6 && h !== null && !isRest(h); i++) h = phone.hardwareBack();
      if (h === null) off.push(path.join(' → '));
    }
  }
  expect(off).toEqual([]);
});

test('a page that stacks on another goes back to exactly that page, every way', () => {
  let seen = 0;
  for (const to of ROUTES) {
    for (const from of ROUTES) {
      if (from === to || !stacksOn(R(to), R(from), places)) continue;
      seen++;
      const phone = new Phone(from).go(to);
      expect([from, to, phone.clone().hardwareBack(), phone.clone().leave()]).toEqual([from, to, from, from]);
    }
  }
  // Posts from every page, and the thread from its channel.
  expect(seen).toBeGreaterThan(ROUTES.length);
});

test('feed → post → reply → back, back, back: the reply, the post, the feed, the inbox', () => {
  for (const how of ['hardwareBack', 'leave'] as const) {
    const phone = new Phone('#/inbox').go('#/inbox/c/feedx').go('#/inbox/c/pst_x_1').go('#/inbox/c/pst_x_2');
    const steps = [phone[how](), phone[how](), phone[how]()];
    expect([how, ...steps]).toEqual([how, '#/inbox/c/pst_x_1', '#/inbox/c/feedx', '#/inbox']);
  }
  // From a profile's posts, and from search results.
  expect(new Phone('#/p/pal').go('#/inbox/c/pst_x_1').leave()).toBe('#/p/pal');
  expect(new Phone('#/search?q=hello').go('#/inbox/c/pst_x_1').hardwareBack()).toBe('#/search?q=hello');
  // A thread back to its channel, the channel to its server.
  const thread = new Phone('#/s/srv').go('#/s/srv/c/chan').go('#/s/srv/c/thr');
  expect([thread.leave(), thread.leave()]).toEqual(['#/s/srv/c/chan', '#/s/srv']);
});

test("pressing a page's back button again and again reaches a list or a tab, through any three pages", () => {
  const pages = ROUTES.filter((h) => isPage(R(h)));
  const off: string[] = [];
  for (const a of ROUTES)
    for (const b of pages)
      for (const c of pages) {
        if (a === b || b === c) continue;
        const phone = new Phone(a).go(b).go(c);
        const seen = new Set<string>();
        let h = c;
        while (!isRest(h) && !seen.has(`${phone.at}:${h}`) && seen.size < 8) {
          seen.add(`${phone.at}:${h}`);
          h = phone.leave();
        }
        if (!isRest(h)) off.push(`${a} → ${b} → ${c}: stuck at ${h}`);
      }
  expect(off).toEqual([]);
});

test('a tab is the bottom: what is under one is never reached by a page back button', () => {
  // Tabs and lists have no back of their own; the model above stops at them. This keeps the set honest.
  for (const h of ROUTES) if (isTabRoot(R(h))) expect([h, isPage(R(h))]).toEqual([h, false]);
});
