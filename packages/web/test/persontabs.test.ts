/**
 * A person's switch row (docs/places.md "A person's networks"): which tabs it has and in what order (chattabs.ts
 * personTabs), what a view chooses and sends through (viewIn, tabOf, routeForTab), a pick against the address (pickAt),
 * and the keys that move along any
 * page's row (tabkeys.ts). The page itself is checked in a browser by scripts/verify-chat-header.ts.
 */
import { expect, test } from 'bun:test';
import { netTab, personTabs, pickAt, POSTS_TAB, postNetworks, routeForTab, tabNetwork, tabOf, viewIn } from '../src/chattabs.ts';
import { tabStep } from '../src/tabkeys.ts';

const NAMES: Record<string, string> = { signal: 'Signal', discord: 'Discord', matrix: 'Matrix', telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'Email' };
const name = (n: string) => NAMES[n] ?? n;
const route = (id: string, network: string, unread = 0, lastMessageAt: number | null = null) => ({ id, network, unread, lastMessageAt });

// Alice: five chat networks and mail, two Discord routes.
const ALICE = [
  route('sig', 'signal', 2, 50),
  route('dc-main', 'discord', 1, 40),
  route('mail', 'email', 3, 60),
  route('dc-alt', 'discord', 4, 45),
  route('mx', 'matrix', 0, 10),
  route('wa', 'whatsapp', 0, 20),
  route('tg', 'telegram', 0, 30),
];

test('All, then each network once, by name, mail last; unread summed per network and over all', () => {
  const tabs = personTabs(ALICE, name);
  expect(tabs.map((t) => t.id)).toEqual(['all', 'net:discord', 'net:matrix', 'net:signal', 'net:telegram', 'net:whatsapp', 'net:email']);
  expect(tabs.map((t) => t.unread)).toEqual([10, 5, 0, 2, 0, 0, 3]);
  expect(tabs[0].network).toBeNull();
  expect(tabs[1].network).toBe('discord');
});

test('the order does not move as messages come: only names decide it', () => {
  const later = ALICE.map((r) => (r.network === 'matrix' ? { ...r, lastMessageAt: 999, unread: 9 } : r)).reverse();
  expect(personTabs(later, name).map((t) => t.id)).toEqual(personTabs(ALICE, name).map((t) => t.id));
});

test('one network by several routes still has All and that network; one route alone has no row', () => {
  expect(personTabs([route('a', 'discord'), route('b', 'discord')], name).map((t) => t.id)).toEqual(['all', 'net:discord']);
  expect(personTabs([route('a', 'email')], name)).toEqual([]);
  expect(personTabs([], name)).toEqual([]);
});

test('tabs added after the networks (a person\'s posts), also for a person of one route', () => {
  const posts = { id: 'posts', network: null, unread: 0 };
  expect(personTabs([route('s', 'signal'), route('m', 'email')], name, [posts]).map((t) => t.id)).toEqual(['all', 'net:signal', 'net:email', 'posts']);
  expect(personTabs([route('m', 'email')], name, [posts]).map((t) => t.id)).toEqual(['all', 'net:email', 'posts']);
});

test('the Posts tab: last after the networks, with the one network they post on, its id kept by viewIn and tabOf', () => {
  const posts = { id: POSTS_TAB, network: 'x', unread: 0 };
  const tabs = personTabs([route('s', 'signal', 1)], name, [posts]);
  expect(tabs.map((t) => t.id)).toEqual(['all', 'net:signal', POSTS_TAB]);
  expect(tabs.at(-1)).toEqual(posts);
  // All counts what is unread in their chats; Posts adds nothing to it.
  expect(tabs[0].unread).toBe(1);
  expect(viewIn(POSTS_TAB, ALICE, [POSTS_TAB])).toBe(POSTS_TAB);
  expect(tabOf(POSTS_TAB, ALICE, [POSTS_TAB])).toBe(POSTS_TAB);
  // Without the tab (they no longer post anywhere you read): All again.
  expect(viewIn(POSTS_TAB, ALICE)).toBe('all');
  expect(tabOf(POSTS_TAB, ALICE)).toBe('all');
});

test('which networks of posts give the tab: theirs that one of your accounts reads, once each, in order', () => {
  const OF_POSTS = ['x', 'mastodon', 'reddit', 'bluesky'];
  expect(postNetworks(['signal', 'x', 'discord', 'x'], ['signal', 'x', 'discord'], OF_POSTS)).toEqual(['x']);
  expect(postNetworks(['x', 'mastodon', 'reddit'], ['reddit', 'x', 'mastodon'], OF_POSTS)).toEqual(['mastodon', 'reddit', 'x']);
  // Posting where no account of yours reads: nothing could have been logged.
  expect(postNetworks(['bluesky', 'signal'], ['signal', 'x'], OF_POSTS)).toEqual([]);
  // Chat networks only: no tab.
  expect(postNetworks(['signal', 'discord'], ['signal', 'discord', 'x'], OF_POSTS)).toEqual([]);
});

test('a view that no longer fits their routes is All again', () => {
  expect(viewIn(undefined, ALICE)).toBe('all');
  expect(viewIn('all', ALICE)).toBe('all');
  expect(viewIn('net:signal', ALICE)).toBe('net:signal');
  expect(viewIn('net:zulip', ALICE)).toBe('all');
  expect(viewIn('dc-alt', ALICE)).toBe('dc-alt');
  expect(viewIn('gone', ALICE)).toBe('all');
});

test('a tab picked at one address never hides the chat another address opens', () => {
  const discord = { v: netTab('discord'), at: '' };
  // The person's own page, and the address the tab was picked at: the pick holds.
  expect(pickAt(discord, '', undefined)).toBe('net:discord');
  expect(pickAt({ v: netTab('discord'), at: 'thread-1' }, 'thread-1', { network: 'email' })).toBe('net:discord');
  // Another address naming a chat on that network: still shown, so it holds.
  expect(pickAt(discord, 'dc-main', { network: 'discord' })).toBe('net:discord');
  // A mail of theirs opened from the inbox: the Discord tab would hide it, so the page is All again...
  expect(pickAt(discord, 'thread-1', { network: 'email' })).toBeUndefined();
  expect(viewIn(pickAt(discord, 'thread-1', { network: 'email' }), ALICE)).toBe('all');
  // ...and a second thread of theirs after a tab picked at the first, though both are the one mail route.
  expect(pickAt({ v: netTab('discord'), at: 'thread-1' }, 'thread-2', { network: 'email' })).toBeUndefined();
  // Their posts hide every chat; All hides none; a route shown alone follows the route in use (pairpick.ts).
  expect(pickAt({ v: POSTS_TAB, at: '' }, 'sig', { network: 'signal' }, [POSTS_TAB])).toBeUndefined();
  expect(pickAt({ v: 'all', at: '' }, 'sig', { network: 'signal' })).toBe('all');
  expect(pickAt({ v: 'mx', at: '' }, 'sig', { network: 'signal' })).toBe('mx');
  expect(pickAt(undefined, 'sig', { network: 'signal' })).toBeUndefined();
});

test('a route shown alone chooses its network\'s tab', () => {
  expect(tabOf('dc-alt', ALICE)).toBe('net:discord');
  expect(tabOf('net:email', ALICE)).toBe('net:email');
  expect(tabOf('all', ALICE)).toBe('all');
  expect(tabOf('gone', ALICE)).toBe('all');
  expect(tabNetwork(netTab('email'))).toBe('email');
  expect(tabNetwork('all')).toBeNull();
  expect(tabNetwork('dc-alt')).toBeNull();
});

test('a network\'s tab sends through the route in use when it is on it, else that network\'s latest', () => {
  const by = (id: string) => ALICE.find((r) => r.id === id)!;
  expect(routeForTab('discord', by('dc-main'), ALICE)?.id).toBe('dc-main');
  expect(routeForTab('discord', by('sig'), ALICE)?.id).toBe('dc-alt');
  expect(routeForTab('email', by('sig'), ALICE)?.id).toBe('mail');
  expect(routeForTab('zulip', by('sig'), ALICE)).toBeNull();
});

test('Ctrl+Shift+] and [ move along the row, by the physical key; nothing else does', () => {
  const k = (code: string, o: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; composing: boolean }> = {}) =>
    tabStep({ code, ctrl: true, shift: true, alt: false, meta: false, composing: false, ...o });
  expect(k('BracketRight')).toBe(1);
  expect(k('BracketLeft')).toBe(-1);
  expect(k('BracketRight', { shift: false })).toBeNull();
  expect(k('BracketRight', { ctrl: false })).toBeNull();
  expect(k('BracketRight', { alt: true })).toBeNull();
  expect(k('BracketRight', { meta: true })).toBeNull();
  expect(k('BracketRight', { composing: true })).toBeNull();
  expect(k('ArrowRight')).toBeNull();
  expect(k('Digit2')).toBeNull();
});
