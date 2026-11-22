/**
 * A network's notifications as cards (feed.ts, docs/feed.md): the same thing done to the same post one after another
 * is one card, names said the way X says them, and the inbox row's words.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { activityVerbs, cardSentence, clip, feedBarLine, feedCards, feedUnits, feedVerb, isPostKey, namesPhrase, parsePostKey, postHref, postKey, postMessageKey, reactionCounts, reactWords, reactorsPhrase, shortCount } from '../src/feed.ts';

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

test('clipping and counts', () => {
  expect(clip('a  b\nc')).toBe('a b c');
  expect(clip('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  expect([980, 3120, 15200, 1_250_000].map(shortCount)).toEqual(['980', '3.1K', '15K', '1.3M']);
});

test('post keys: a post and a logged message, there and back', () => {
    expect(parsePostKey(postKey('x', '1900000000000000001'))).toEqual({ network: 'x', post: '1900000000000000001' });
    expect(parsePostKey(postMessageKey('msg_abc-D_9'))).toEqual({ message: 'msg_abc-D_9' });
    expect(parsePostKey('pst_nowhere_1')).toBeNull();
    // Ids are the network's own, opaque: Reddit's t1_…, Lemmy's comment:…, Bluesky's did:…~rkey; nothing that would leave a path.
    expect(parsePostKey(postKey('reddit', 't1_abc12'))).toEqual({ network: 'reddit', post: 't1_abc12' });
    expect(parsePostKey(postKey('lemmy', 'comment:9001'))).toEqual({ network: 'lemmy', post: 'comment:9001' });
    expect(parsePostKey(postKey('bluesky', 'did:plc:riverdemoqqqqqqqqqqqqqqq~3lbxaaaaaaaab'))).toEqual({ network: 'bluesky', post: 'did:plc:riverdemoqqqqqqqqqqqqqqq~3lbxaaaaaaaab' });
    expect(parsePostKey(postKey('lesswrong', 'c-dmo0013LwQxZk7Faq'))).toEqual({ network: 'lesswrong', post: 'c-dmo0013LwQxZk7Faq' });
    expect(parsePostKey('pst_x_12/ab')).toBeNull();
    expect(parsePostKey('pst_x_')).toBeNull();
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


test("LessWrong in its own words: an upvote on karma, no repost, votes on the bar", () => {
  expect(reactWords('lesswrong')).toMatchObject({ liked: 'upvoted', likes: 'Karma', likeIcon: 'upvote' });
  expect(feedVerb('like', 'lesswrong')).toBe('upvoted your post');
  expect(activityVerbs('lesswrong')).toBe('upvote or reply to');
  expect(feedBarLine('lesswrong')).toBe('Replies, votes and follows happen on LessWrong.');
});
