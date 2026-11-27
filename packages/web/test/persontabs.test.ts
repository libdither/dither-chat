/**
 * A person's switch row (docs/places.md "A person's networks"): which tabs it has and in what order (chattabs.ts
 * personTabs), what a view chooses and sends through (viewIn, tabOf, routeForTab), and the keys that move along any
 * page's row (tabkeys.ts). The page itself is checked in a browser by scripts/verify-chat-header.ts.
 */
import { expect, test } from 'bun:test';
import { netTab, personTabs, routeForTab, tabNetwork, tabOf, viewIn } from '../src/chattabs.ts';
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

test('a view that no longer fits their routes is All again', () => {
  expect(viewIn(undefined, ALICE)).toBe('all');
  expect(viewIn('all', ALICE)).toBe('all');
  expect(viewIn('net:signal', ALICE)).toBe('net:signal');
  expect(viewIn('net:zulip', ALICE)).toBe('all');
  expect(viewIn('dc-alt', ALICE)).toBe('dc-alt');
  expect(viewIn('gone', ALICE)).toBe('all');
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
