/**
 * A network's notifications as cards (feed.ts, docs/feed.md): the same thing done to the same post one after another
 * is one card, names said the way X says them, and the inbox row's words.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { cardSentence, clip, feedCards, feedRow, feedUnits, isPostKey, namesPhrase, parsePostKey, postHref, postKey, postMessageKey, reactionCounts, reactorsPhrase, shortCount } from '../src/feed.ts';

const post = (id: string, text = `post ${id}`): P.PostFact => ({ id, url: `https://x.com/me/status/${id}`, ts: 0, author: 'idn_me', text });
let n = 0;
function msg(type: P.FeedItemType, who: string, ts: number, x: Partial<P.FeedItem> = {}): P.MessageView {
  return {
    id: `m${++n}`,
    conversationId: 'cnv_feed',
    network: 'x',
    nativeId: `${type}:${n}`,
    authorId: who,
    ts,
    editedTs: null,
    kind: type === 'reply' ? 'text' : 'system',
    body: type,
    replyToId: null,
    threadId: null,
    mentionsSelf: false,
    deleted: false,
    attachments: [],
    embeds: [],
    reactions: [],
    seenVia: [],
    triage: null,
    feed: { type, ...x },
  } as P.MessageView;
}
const NAMES: Record<string, string> = { a: 'Alice', b: 'Bob', c: 'Cam', d: 'Dee', e: 'Eve' };
const name = (id: string) => NAMES[id] ?? id;

test('likes on one post in a row are one card, newest first; a like on another post starts a new one', () => {
  const p1 = post('1');
  const p2 = post('2');
  const cards = feedCards([msg('like', 'a', 10, { post: p1 }), msg('like', 'b', 20, { post: p1 }), msg('like', 'c', 30, { post: p1 }), msg('like', 'd', 40, { post: p2 }), msg('like', 'a', 50, { post: p1 })]);
  expect(cards.map((c) => [c.type, c.post?.id, c.actors])).toEqual([
    ['like', '1', ['a']],
    ['like', '2', ['d']],
    ['like', '1', ['c', 'b', 'a']],
  ]);
});

test('follows group with no post; replies never group; something else between two likes splits them', () => {
  const p1 = post('1');
  const cards = feedCards([msg('follow', 'a', 1), msg('follow', 'b', 2), msg('reply', 'c', 3, { post: p1, theirs: post('9') }), msg('reply', 'd', 4, { post: p1, theirs: post('8') }), msg('like', 'a', 5, { post: p1 }), msg('repost', 'b', 6, { post: p1 }), msg('like', 'c', 7, { post: p1 })]);
  expect(cards.map((c) => `${c.type}:${c.actors.join('')}`)).toEqual(['like:c', 'repost:b', 'like:a', 'reply:d', 'reply:c', 'follow:ba']);
});

test('one person liking twice is one face', () => {
  const p1 = post('1');
  expect(feedCards([msg('like', 'a', 1, { post: p1 }), msg('like', 'a', 2, { post: p1 })])[0].actors).toEqual(['a']);
});

test('names as X says them', () => {
  expect(namesPhrase(['Alice'])).toBe('Alice');
  expect(namesPhrase(['Alice', 'Bob'])).toBe('Alice and Bob');
  expect(namesPhrase(['Alice', 'Bob', 'Cam'])).toBe('Alice, Bob and Cam');
  expect(namesPhrase(['Alice', 'Bob', 'Cam'], 5)).toBe('Alice, Bob and 3 others');
  expect(namesPhrase(['Alice', 'Bob'], 3)).toBe('Alice, Bob and 1 other');
  const card = feedCards(['a', 'b', 'c', 'd', 'e'].map((w, i) => msg('like', w, i, { post: post('1') })))[0];
  expect(cardSentence(card, name)).toBe('Eve, Dee and 3 others liked your post');
  expect(cardSentence(feedCards([msg('follow', 'a', 1)])[0], name)).toBe('Alice followed you');
  expect(cardSentence(feedCards([msg('other', 'a', 1, { text: 'Your post was seen 1,000 times' })])[0], name)).toBe('Your post was seen 1,000 times');
});

test('what is new is what came after the read line', () => {
  const p1 = post('1');
  const cards = feedCards([msg('like', 'a', 10, { post: p1 }), msg('follow', 'b', 20), msg('like', 'c', 30, { post: p1 })], 15);
  expect(cards.map((c) => c.fresh)).toEqual([true, true, false]);
});

test("the inbox row: how many new, who, and the newest card's words; nothing once read and a day old", () => {
  const now = 1_000_000_000;
  const conv = (unread: number, lastAt: number, lastReadTs: number) =>
    ({ id: 'cnv_feed', network: 'x', variant: 'feed', lastMessageAt: lastAt, lastMessage: { id: 'm', authorId: 'a', ts: lastAt, kind: 'system', text: 'liked your post' }, vantages: [{ accountId: 'acc', unread, mentions: 0, lastReadTs }] }) as unknown as P.ConversationView;
  const p1 = post('1');
  const ms = [msg('like', 'a', now - 100, { post: p1 }), msg('like', 'b', now - 50, { post: p1 }), msg('reply', 'c', now - 10, { post: p1, theirs: post('9') })];
  expect(feedRow(conv(3, now - 10, now - 1000), ms, name, now)).toEqual({ count: 3, who: ['c', 'b', 'a'], what: 'Cam replied to your post, and 1 more', lastAt: now - 10 });
  // Before its page is held: the last message.
  expect(feedRow(conv(1, now - 10, now - 1000), null, name, now)?.what).toBe('Alice liked your post');
  expect(feedRow(conv(0, now - 25 * 60 * 60_000, now), ms, name, now)).toBeNull();
});

test('clipping and counts', () => {
  expect(clip('a  b\nc')).toBe('a b c');
  expect(clip('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  expect([980, 3120, 15200, 1_250_000].map(shortCount)).toEqual(['980', '3.1K', '15K', '1.3M']);
});

test('post keys: a post and a logged message, there and back', () => {
    expect(parsePostKey(postKey('x', '1900000000000000001'))).toEqual({ network: 'x', post: '1900000000000000001' });
    expect(parsePostKey(postMessageKey('msg_abc-D_9'))).toEqual({ message: 'msg_abc-D_9' });
    expect(parsePostKey('pst_nowhere_1')).toBeNull();
    expect(parsePostKey('pst_x_12ab')).toBeNull();
    expect(isPostKey('cnv_x')).toBe(false);
    expect(postHref('x', '5')).toBe('#/inbox/c/pst_x_5');
});

// ------------------------------------------------------------------ the feed by post

test('by post: likes, reposts, replies and quotes on one post are one unit, by its newest activity', () => {
  const p1 = post('1');
  const p2 = post('2');
  const units = feedUnits([
    msg('like', 'a', 10, { post: p1 }),
    msg('like', 'b', 20, { post: p2 }),
    msg('repost', 'c', 30, { post: p1 }),
    msg('reply', 'd', 40, { post: p1, theirs: post('9') }),
    msg('like', 'e', 50, { post: p1 }),
    msg('quote', 'a', 60, { post: p2, theirs: post('8') }),
  ]);
  expect(units.map((u) => u.key)).toEqual(['post:2', 'post:1']);
  const u1 = units[1] as Extract<(typeof units)[0], { kind: 'post' }>;
  expect(u1.reactors).toEqual({ like: ['e', 'a'], repost: ['c'] });
  expect(u1.talk.map((t) => [t.type, t.message.authorId])).toEqual([['reply', 'd']]);
  expect([u1.ts, u1.talkTs]).toEqual([50, 40]);
});

test('by post: a mention and a reply with no post of yours stand alone; follows in a row are one row', () => {
  const units = feedUnits([msg('follow', 'a', 1), msg('follow', 'b', 2), msg('mention', 'c', 3, { theirs: post('7') }), msg('reply', 'd', 4, { theirs: post('6') }), msg('follow', 'e', 5)]);
  expect(units.map((u) => (u.kind === 'follow' ? `follow:${u.actors.join('')}` : u.kind))).toEqual(['follow:e', 'said', 'said', 'follow:ba']);
});

test('by post: talk only leaves out likes, reposts and follows, ordered by when someone last said something', () => {
  const p1 = post('1');
  const p2 = post('2');
  const units = feedUnits([msg('reply', 'a', 10, { post: p1, theirs: post('9') }), msg('like', 'b', 90, { post: p1 }), msg('like', 'c', 80, { post: p2 }), msg('follow', 'd', 70), msg('mention', 'e', 20, { theirs: post('5') })], Infinity, 'talk');
  expect(units.map((u) => u.kind + ':' + u.talkTs)).toEqual(['said:20', 'post:10']);
});

test('by post: what is new, and the reactions line in words and counts', () => {
  const p1 = { ...post('1'), counts: { likes: 41, reposts: 3 } };
  const units = feedUnits([msg('like', 'a', 10, { post: p1 }), msg('like', 'b', 20, { post: p1 }), msg('like', 'c', 30, { post: p1 }), msg('like', 'd', 40, { post: p1 }), msg('reply', 'e', 50, { post: p1, theirs: post('9') })], 35);
  const u = units[0] as Extract<(typeof units)[0], { kind: 'post' }>;
  expect(u.fresh).toBe(true);
  expect(u.talk[0].fresh).toBe(true);
  expect(reactorsPhrase(u, name)).toBe('Liked by Dee, Cam and 2 others');
  expect(reactionCounts(u)).toEqual({ like: 41, repost: 3, quote: 0, reply: 1 });
  const old = feedUnits([msg('repost', 'a', 1, { post: post('3') })], 35)[0] as Extract<(typeof units)[0], { kind: 'post' }>;
  expect([old.fresh, reactorsPhrase(old, name), reactionCounts(old).repost]).toEqual([false, 'Reposted by Alice', 1]);
});

test('by post, talk only: a card is new for what was said, not for a like it does not show', () => {
  const p1 = post('1');
  const units = feedUnits([msg('reply', 'a', 10, { post: p1, theirs: post('9') }), msg('like', 'b', 90, { post: p1 })], 50, 'talk');
  expect(units[0].fresh).toBe(false);
  expect(feedUnits([msg('reply', 'a', 10, { post: p1, theirs: post('9') }), msg('like', 'b', 90, { post: p1 })], 50)[0].fresh).toBe(true);
});
