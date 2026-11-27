/** Luma and Partiful in the shared lists (docs/events.md): networks, their feeds, the hidden-guest rule, sending. */
import { expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS, NETWORK_META, NETWORKS, POST_NETWORKS, REACTION_RULES, isEventNetwork } from '../src/ontology.ts';
import { NETWORK_FEATURES } from '../src/accounts.ts';
import { homeFeedsOf, POST_RULES, timelineName } from '../src/compose.ts';
import { eventConvNativeId, guestsNamed, HOME_FEEDS, withoutHiddenGuests, type PostFact } from '../src/feed.ts';
import { sendBlocker } from '../src/send.ts';

test('both event sites are networks with chats and a feed, after Zulip', () => {
  expect(NETWORKS.slice(NETWORKS.indexOf('zulip') + 1, NETWORKS.indexOf('zulip') + 3)).toEqual(['luma', 'partiful']);
  for (const n of ['luma', 'partiful'] as const) {
    expect(isEventNetwork(n)).toBe(true);
    expect(POST_NETWORKS).toContain(n);
    expect(NETWORK_FEATURES[n]).toEqual(['chat', 'feed']);
    expect(NETWORK_META[n].name).toBeTruthy();
    expect(ATTACHMENT_LIMITS[n]).toEqual({ bytes: 0, files: 0 });
    expect(REACTION_RULES[n].freeText).toBe(false);
  }
  expect(isEventNetwork('x')).toBe(false);
});

test('an event site’s feeds are Explore and Your events; others keep Following and For you', () => {
  expect(HOME_FEEDS).toContain('explore');
  expect(homeFeedsOf('luma')).toEqual(['explore', 'following']);
  expect(homeFeedsOf('partiful')).toEqual(['explore', 'following']);
  expect(homeFeedsOf('x')).toEqual(['following', 'foryou']);
  expect(timelineName('luma', 'explore')).toBe('Explore');
  expect(timelineName('luma', 'following')).toBe('Your events');
  // Nothing is liked, reposted or answered as a post on an event site.
  expect(POST_RULES.luma!.actions).toEqual({ like: false, repost: false, quote: false, reply: false });
});

const party = (guestsShown: 'all' | 'sample' | 'count' | 'hidden'): PostFact => ({
  id: 'e1',
  url: 'https://partiful.com/e/e1',
  ts: 1,
  author: 'h',
  text: '',
  event: { start: 2, hosts: ['h'], guests: ['a', 'b'], going: 2, guestsShown },
});

test('a list the host does not name loses its guests, also inside a repost or quote', () => {
  expect(guestsNamed(party('all').event!)).toBe(true);
  expect(guestsNamed(party('sample').event!)).toBe(true);
  expect(withoutHiddenGuests(party('sample')).event!.guests).toEqual(['a', 'b']);
  for (const shown of ['count', 'hidden'] as const) {
    const p = withoutHiddenGuests(party(shown));
    expect(p.event!.guests).toBeUndefined();
    expect(p.event!.going).toBe(2);
    expect(p.event!.hosts).toEqual(['h']);
    const outer: PostFact = { id: 'o', url: '', ts: 1, author: 'h', text: '', repostOf: party(shown), quoteOf: party(shown) };
    const w = withoutHiddenGuests(outer);
    expect(w.repostOf!.event!.guests).toBeUndefined();
    expect(w.quoteOf!.event!.guests).toBeUndefined();
  }
  // A post with nothing to drop comes back as it was.
  const plain = party('all');
  expect(withoutHiddenGuests(plain)).toBe(plain);
});

test('a Luma event’s conversation takes nothing; a Partiful one, and Luma chats, do', () => {
  const conv = (network: 'luma' | 'partiful', nativeId: string) => ({ network, nativeId, encrypted: false, variant: null }) as Parameters<typeof sendBlocker>[0];
  const acc = (network: 'luma' | 'partiful') => ({ network, label: 'events', status: 'online', capabilities: [] }) as Parameters<typeof sendBlocker>[1];
  expect(sendBlocker(conv('luma', eventConvNativeId('evt-1')), acc('luma'))).toMatch(/Luma/);
  expect(sendBlocker(conv('partiful', eventConvNativeId('e1')), acc('partiful'))).toBeNull();
  expect(sendBlocker(conv('luma', 'chat-1'), acc('luma'))).toBeNull();
});
