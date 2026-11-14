/**
 * The demo world's X account (docs/feed.md): a feed of notifications about your posts, one message per actor as
 * packages/protocol/src/feed.ts says, `personAbout` events for the people in it, and their recent posts when a profile
 * asks. Everyone and everything here is made up.
 *
 * The feed, newest first: a reply, five likes on one post, a repost of it, a quote, a mention, two follows, two likes
 * on another post. The newest four arrive live on the first run, so triage decides them (reply, mention and quote
 * at most a silent row on the list; likes never).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { AccountRow } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

export const DEMO_X_ACCOUNT = { id: 'acc_demo-x', network: 'x' as const, label: 'personal', color: '#8899A6' };

const pic = (bg: string, fg: string, letter: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="42" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="${fg}">${letter}</text></svg>`)}`;
/** A wide picture for a post. */
const shot = (bg: string, body: string, w = 640, h = 360) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`)}`;

const xid = (n: number) => String(1_600_000_000_000_000_000n + BigInt(n) * 7_919n);
const person = (n: number, handle: string, displayName: string, bg: string, fg = '#fff'): P.IdentityFact => ({ nativeId: xid(n), handle, displayName, avatarUrl: pic(bg, fg, displayName[0]) });

export const X = {
  self: person(1, 'zyan_demo', 'Zyan', '#F7D154', '#2b2b33'),
  alice: person(2, 'alicechen_dev', 'Alice Chen', '#e86a92'),
  ravi: person(3, 'ravi_routes', 'Ravi', '#5c7cfa'),
  quinn: person(4, 'quinnwrites', 'Quinn', '#0dbd8b'),
  maya: person(5, 'maya_k', 'Maya K.', '#f2a541', '#2b2b33'),
  theo: person(6, 'theo_builds', 'Theo', '#7c5cff'),
  nora: person(7, 'nora_on_nets', 'Nora', '#d9480f'),
  lee: person(8, 'lee_sheaves', 'Lee', '#263238', '#7fd1ae'),
  sam: person(9, 'samdoesmath', 'Sam', '#5277c3'),
};
type Who = keyof typeof X;

const MIN = 60_000;
const url = (who: P.IdentityFact, id: string) => `https://x.com/${who.handle}/status/${id}`;
const pid = (n: number) => String(1_900_000_000_000_000_000n + BigInt(n) * 104_729n);

/** A post at `min` minutes before the epoch. */
function post(epoch: number, n: number, who: P.IdentityFact, min: number, text: string, x: Partial<P.PostFact> = {}): P.PostFact {
  const id = pid(n);
  return { id, url: url(who, id), ts: epoch - min * MIN, author: who.nativeId, text, ...x };
}

const ROUTING = shot('#1f2a4a', `<g stroke="#5cc8ff" stroke-width="4" fill="none"><path d="M60 300 C 180 80, 300 320, 420 120 S 560 200, 600 60"/></g><g fill="#f7d154">${[[60, 300], [180, 170], [300, 230], [420, 120], [600, 60]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="12"/>`).join('')}</g><text x="40" y="50" font-family="sans-serif" font-size="28" fill="#e6eefc">greedy routing, 1M nodes</text>`);
const SHEAF = shot('#fff1d6', `<g fill="none" stroke="#7a4b2a" stroke-width="5"><ellipse cx="320" cy="250" rx="220" ry="60"/><path d="M180 240 L180 90 M320 250 L320 70 M460 240 L460 90"/></g><g fill="#e86a92"><circle cx="180" cy="90" r="14"/><circle cx="320" cy="70" r="14"/><circle cx="460" cy="90" r="14"/></g>`);
const DESK = shot('#2f5d7c', `<rect x="120" y="120" width="400" height="200" rx="14" fill="#26313f"/><rect x="150" y="145" width="340" height="150" fill="#9ec5e8"/><circle cx="560" cy="80" r="40" fill="#ffd36e"/>`);

/** Your posts, the ones the feed is about. */
function yourPosts(epoch: number) {
  const me = X.self;
  return {
    routing: post(epoch, 1, me, 300, 'Greedy routing in dither now holds stretch under 1.3 on a million-node graph. Write-up and the simulator are in the repo, numbers in the thread below.', {
      media: [{ kind: 'image', url: ROUTING, width: 640, height: 360, alt: 'A path hopping across five nodes' }],
      counts: { replies: 4, reposts: 3, likes: 41, quotes: 1, views: 3120 },
    }),
    sheaves: post(epoch, 2, me, 2 * 24 * 60, 'Sheafification is just "glue what agrees locally". Everything else is bookkeeping.', { counts: { replies: 2, reposts: 1, likes: 17, quotes: 1, views: 980 } }),
    desk: post(epoch, 3, me, 6 * 24 * 60, 'New desk, new monitor, same unfinished TODO list.', { media: [{ kind: 'image', url: DESK, width: 640, height: 360 }], counts: { likes: 9, views: 400 } }),
  };
}

interface Item {
  min: number;
  who: Who;
  item: P.FeedItem;
  body: string;
  nativeId: string;
}

/** The feed, oldest first. */
function feed(epoch: number): Item[] {
  const mine = yourPosts(epoch);
  const like = (who: Who, p: P.PostFact, min: number): Item => ({ min, who, nativeId: `like:${p.id}:${X[who].nativeId}`, body: 'liked your post', item: { type: 'like', post: p, url: p.url } });
  const theirs = (who: Who, n: number, min: number, text: string, x: Partial<P.PostFact> = {}) => post(epoch, n, X[who], min, text, x);
  const reply = theirs('ravi', 20, 40, 'Does it hold up under churn? Curious what happens when a fifth of the nodes leave at once.', { replyTo: { id: mine.routing.id, author: X.self.nativeId }, counts: { likes: 3 } });
  const quote = theirs('lee', 21, 26 * 60, 'This is the cleanest one-line summary of sheaves I have seen.', { quoteOf: mine.sheaves, counts: { likes: 12, reposts: 2 } });
  const mention = theirs('sam', 22, 10 * 60, `@${X.self.handle} you would like this paper on discrete Morse theory for routing tables`, { media: [{ kind: 'image', url: SHEAF, width: 640, height: 360, alt: 'A sheaf over a circle' }] });
  return [
    like('nora', mine.sheaves, 40 * 60),
    like('alice', mine.sheaves, 38 * 60),
    { min: 26 * 60, who: 'lee', nativeId: `quote:${quote.id}`, body: quote.text, item: { type: 'quote', post: mine.sheaves, theirs: quote, url: quote.url } },
    { min: 20 * 60, who: 'lee', nativeId: `follow:${X.lee.nativeId}`, body: 'followed you', item: { type: 'follow', url: `https://x.com/${X.lee.handle}` } },
    { min: 19 * 60, who: 'sam', nativeId: `follow:${X.sam.nativeId}`, body: 'followed you', item: { type: 'follow', url: `https://x.com/${X.sam.handle}` } },
    { min: 10 * 60, who: 'sam', nativeId: `mention:${mention.id}`, body: mention.text, item: { type: 'mention', theirs: mention, url: mention.url } },
    { min: 200, who: 'nora', nativeId: `repost:${mine.routing.id}:${X.nora.nativeId}`, body: 'reposted your post', item: { type: 'repost', post: mine.routing, url: mine.routing.url } },
    like('alice', mine.routing, 180),
    like('ravi', mine.routing, 150),
    like('quinn', mine.routing, 120),
    like('maya', mine.routing, 90),
    like('theo', mine.routing, 60),
    { min: 40, who: 'ravi', nativeId: `reply:${reply.id}`, body: reply.text, item: { type: 'reply', post: mine.routing, theirs: reply, url: reply.url } },
  ];
}
/** The newest this many arrive live on the first run. */
const LIVE = 4;

const BIO: Record<Who, { bio: string; followers: number; following: number; posts: number; followsYou?: boolean; location?: string }> = {
  self: { bio: 'Building dither: one inbox for every network. Routing, sheaves, sheep.', followers: 812, following: 301, posts: 2210 },
  alice: { bio: 'Distributed systems at a small company. Rust, coffee, long walks. https://alicechen.dev/notes', followers: 2310, following: 512, posts: 8120, followsYou: true },
  ravi: { bio: 'Routing protocols and the people who break them.', followers: 640, following: 220, posts: 1900, followsYou: true },
  quinn: { bio: 'Writer. Mostly about software, sometimes about birds. quinnwrites.blog', followers: 15200, following: 870, posts: 22100 },
  maya: { bio: 'PhD student, networks and graphs.', followers: 410, following: 390, posts: 760, followsYou: true },
  theo: { bio: 'I make small tools for big repos.', followers: 980, following: 1020, posts: 5400 },
  nora: { bio: 'Networks researcher. Opinions are cached.', followers: 3300, following: 610, posts: 12000, followsYou: true },
  lee: { bio: 'Category theory for working programmers.', followers: 5100, following: 140, posts: 3100, followsYou: true },
  sam: { bio: 'Math, mostly discrete.', followers: 220, following: 180, posts: 640, followsYou: true },
};

/** Someone's profile as the network shows it, without posts (what a `personAbout` event carries). */
function aboutOf(who: Who): P.PersonAbout {
  const b = BIO[who];
  const i = X[who];
  return {
    displayName: i.displayName,
    handle: i.handle,
    avatar: i.avatarUrl,
    bio: b.bio,
    createdAt: Date.UTC(2014 + (Number(i.nativeId.slice(-2)) % 9), Number(i.nativeId.slice(-3, -1)) % 12, 3),
    counts: { followers: b.followers, following: b.following, posts: b.posts },
    // You follow Alice and Nora, who follow you back (Friends, docs/profile.md "Connections"), and Quinn, who does not.
    ...(who === 'self' ? {} : { followsYou: !!b.followsYou, relationship: who === 'alice' || who === 'nora' || who === 'quinn' ? ('following' as const) : ('stranger' as const) }),
    links: [{ label: 'Website', value: `${i.handle}.example`, url: `https://${i.handle}.example` }],
  };
}

/** Their recent posts, newest first, a pinned one first. */
function postsOf(who: Who, epoch: number): P.PostFact[] {
  const i = X[who];
  const mine = yourPosts(epoch);
  const base = 100 + Object.keys(X).indexOf(who) * 10;
  if (who === 'self') return [{ ...mine.routing, pinned: true }, mine.sheaves, mine.desk];
  const own = (n: number, min: number, text: string, x: Partial<P.PostFact> = {}) => post(epoch, base + n, i, min, text, x);
  const pinned = own(0, 30 * 24 * 60, `${BIO[who].bio} Pinned: what I am working on this year.`, { pinned: true, counts: { likes: 120, reposts: 14, replies: 9, views: 20_400 } });
  const fresh = own(1, 75, who === 'ravi' ? 'Churn is the whole problem. Everything else is a routing table.' : `Notes from today: ${['less is more', 'measure twice', 'ship it', 'read the paper first'][base % 4]}.`, { counts: { likes: 8, replies: 1, views: 610 } });
  const repost: P.PostFact = { ...own(2, 170, ''), repostOf: mine.routing };
  const replied = own(3, 9 * 60, 'Agreed, and the second graph says it better than the first.', { replyTo: { id: pid(999), author: X.quinn.nativeId }, counts: { likes: 2 } });
  const quoted = own(4, 30 * 60, 'Worth reading twice.', { quoteOf: post(epoch, 998, X.quinn, 31 * 60, 'Every abstraction leaks; the good ones leak where you can see it.', { counts: { likes: 300 } }), media: [{ kind: 'image', url: DESK, width: 640, height: 360 }], counts: { likes: 15, quotes: 1 } });
  return [pinned, fresh, ...(who === 'nora' || who === 'alice' ? [repost] : []), replied, quoted];
}

/**
 * The threads (docs/feed.md "Threads"): your routing post continued by you and answered by five people (two on a
 * second page), with a tree under it eight deep in places: Ravi and you on churn, Alice's question opening a branch on
 * the tail and landmarks that Nora, Lee, Sam and Maya carry on, Theo's on the browser. Each post is read as X reads
 * it: its replies, each with the first answers under it as a chain of up to three, so the tree's other branches come
 * only by opening them. Any other post the demo knows answers with what it answers.
 */
function threads(epoch: number, made: readonly P.PostFact[] = []) {
  const me = X.self;
  const mine = yourPosts(epoch);
  const r = mine.routing;
  const under = (n: number, who: P.IdentityFact, min: number, text: string, to: P.PostFact, x: Partial<P.PostFact> = {}) =>
    post(epoch, n, who, min, text, { replyTo: { id: to.id, author: to.author }, root: r.id, ...x });
  const cont1 = under(30, me, 299, 'Setup: a random geometric graph, each node knowing only its 8 nearest neighbours. Stretch is the routed path over the shortest one.', r, { counts: { likes: 12 } });
  const cont2 = under(31, me, 298, 'Median stretch 1.08, p99 1.29. The simulator is in sim/ and runs in about a minute.', cont1, { counts: { likes: 9 } });
  const ravi = feed(epoch).find((x) => x.item.type === 'reply')!.item.theirs!;
  const raviIn = { ...ravi, root: r.id };
  const ans = under(32, me, 35, 'Under 20% churn stretch goes to about 1.6 until the neighbour tables refill, roughly ten seconds. Plot coming.', raviIn, { counts: { likes: 4 } });
  const ravi2 = under(33, X.ravi, 30, 'Ten seconds is better than I guessed. Is the refill pushed or pulled?', ans, { counts: { likes: 1 } });
  const pulled = under(38, me, 20, 'Pulled: a node with a short table asks its neighbours every 500 ms until it is full again.', ravi2, { counts: { likes: 2 } });
  const noraChurn = under(39, X.nora, 28, 'We saw the same on our testbed. The refill is the whole game.', ans, { counts: { likes: 3 } });
  const alice = under(34, X.alice, 160, 'The plot in the repo is lovely. What does the tail look like at 10M?', r, { counts: { likes: 6 } });
  const tail = under(40, me, 150, 'At 10M the p99 is 1.34. The tail grows with the diameter, slowly.', alice, { counts: { likes: 5 } });
  const alice2 = under(41, X.alice, 140, 'So the tail is the diameter, more or less. Makes sense.', tail, { counts: { likes: 1 } });
  const nora = under(42, X.nora, 145, 'Did you try landmarks? They usually fix exactly that tail.', tail, { counts: { likes: 4 } });
  const land = under(43, me, 120, 'Four landmarks bring p99 to 1.2, for four more entries per node.', nora, { counts: { likes: 7 } });
  const nora2 = under(44, X.nora, 100, 'That is a good trade.', land, { counts: { likes: 1 } });
  const lee = under(45, X.lee, 110, 'Landmarks are a cover, so this is a sheaf question in disguise.', land, { counts: { likes: 9 } });
  const sam = under(46, X.sam, 90, 'Everything is a sheaf question in disguise.', lee, { counts: { likes: 11 } });
  const maya2 = under(47, X.maya, 60, 'Can confirm, my advisor says this every week.', sam, { counts: { likes: 5 } });
  const lee2 = under(48, X.lee, 50, 'Your advisor is right.', maya2, { counts: { likes: 2 } });
  const maya = under(35, X.maya, 95, 'Citing this in my qualifying exam, thank you.', r, { counts: { likes: 2 } });
  const theo = under(36, X.theo, 70, 'Any chance the simulator runs in the browser?', r);
  const wasm = under(49, me, 55, 'It is about 400 lines of Rust with no threads, so wasm should be easy. Want to try?', theo, { counts: { likes: 3 } });
  const theo2 = under(50, X.theo, 50, 'On it this weekend.', wasm, { counts: { likes: 2 } });
  const quinn = under(37, X.quinn, 65, 'Saving this for the weekend.', r, { counts: { likes: 1 } });
  // Replies in other languages, as X tags them (legacy.lang): the demo's translate answers for them.
  const kenji = under(60, FANS[1]!, 62, '面白い結果ですね。ランドマークなしでこの数字は驚きです。', r, { counts: { likes: 3 }, lang: 'ja' });
  const paula = under(61, FANS[2]!, 58, '¿Funciona también con grafos dirigidos? Me interesa para redes de sensores.', r, { counts: { likes: 2 }, lang: 'es' });
  const toPaula = under(62, me, 52, 'Not yet: greedy routing needs the links both ways. Directed graphs are on the list.', paula, { counts: { likes: 1 }, lang: 'en' });
  // A long back-and-forth under Theo's: one answer each, ten deep (the tree draws it as one run).
  const bf: P.PostFact[] = [];
  const turns: [Who | 'me', number, string][] = [
    ['me', 48, 'Great. The one thing that needs care is the random seed: it comes from the clock.'],
    ['theo', 46, 'I will pass the seed in from JS then. Same numbers on every run?'],
    ['me', 44, 'Same numbers for the same seed, yes. CI checks that.'],
    ['theo', 40, 'First build is 180 KB of wasm. A million nodes takes 40 s in Firefox.'],
    ['me', 38, 'About twice the native time. Most of it is the neighbour search.'],
    ['theo', 30, 'A grid index brings it to 25 s. PR is up.'],
    ['me', 25, 'Merged, thank you! Linking it from the post.'],
  ];
  turns.forEach(([w, min, text], i) => bf.push(under(51 + i, w === 'me' ? me : X[w], min, text, bf[i - 1] ?? theo2, { counts: { likes: i % 3 } })));
  // What you posted here (a reply goes under what it answers).
  const tree = [cont1, cont2, raviIn, ans, ravi2, pulled, noraChurn, alice, tail, alice2, nora, land, nora2, lee, sam, maya2, lee2, maya, theo, wasm, theo2, ...bf, quinn, kenji, paula, toPaula, ...made];
  const kids = (id: string) => tree.filter((p) => p.replyTo?.id === id);
  // Each post's reply count is what is under it, as X counts it.
  for (const p of [r, ...tree]) p.counts = { ...p.counts, replies: kids(p.id).length };
  // X counts a reply under Maya's that it never shows (a reply it filters out): "1 more reply" there brings nothing.
  maya.counts = { ...maya.counts, replies: 1 };
  const all = [r, ...tree];
  // A reply and the first answers under it, as X shows one in a thread.
  const chain = (p: P.PostFact) => {
    const c = [p];
    for (let k = kids(p.id)[0]; k && c.length < 3; k = kids(k.id)[0]) c.push(k);
    return c;
  };
  const thread = (id: string, cursor?: string): P.PostThread | null => {
    if (id === r.id)
      return cursor === 'more-1'
        ? { focal: { ...r, root: r.id }, ancestors: [], replies: [chain(theo), chain(kenji), chain(paula), chain(quinn)], more: null }
        : { focal: { ...r, root: r.id }, ancestors: [], replies: [cont1, raviIn, alice, maya].map(chain), more: 'more-1' };
    const at = all.find((p) => p.id === id);
    const known = at ?? [...Object.values(mine), ...feed(epoch).flatMap((x) => [x.item.post, x.item.theirs]), ...(Object.keys(X) as Who[]).flatMap((w) => postsOf(w, epoch))].find((p) => p?.id === id);
    if (!known) return null;
    const ancestors: P.PostFact[] = [];
    for (let p = known; p.replyTo; ) {
      const up = all.find((q) => q.id === p.replyTo!.id);
      if (!up) break;
      ancestors.unshift(up);
      p = up;
    }
    // The author continuing first, as X shows it.
    const replies = kids(id).sort((a, b) => Number(b.author === known.author) - Number(a.author === known.author));
    return { focal: known, ancestors, replies: replies.map(chain), more: null };
  };
  return Object.assign(thread, { known: (id: string) => all.find((p) => p.id === id) ?? [...Object.values(mine), ...feed(epoch).flatMap((x) => [x.item.post, x.item.theirs]), ...(Object.keys(X) as Who[]).flatMap((w) => postsOf(w, epoch))].find((p) => p?.id === id) ?? null });
}

/** What the demo's X says a post in another language means, as its "Translate post" would (by Grok). */
const TRANSLATED: Record<number, { text: string; from: string }> = {
  60: { text: 'Interesting result. That number without landmarks is surprising.', from: 'ja' },
  61: { text: 'Does it also work with directed graphs? I am interested in it for sensor networks.', from: 'es' },
};

/** People who liked or reposted your routing post beyond those in your notifications (X names them on asking). */
const FANS = [
  person(20, 'graphs_daily', 'Graphs Daily', '#3b5bdb'),
  person(21, 'kenji_net', 'Kenji', '#2f9e44'),
  person(22, 'p2p_paula', 'Paula', '#c2255c'),
  person(23, 'dist_sys_digest', 'Distributed Systems Digest', '#5f3dc4'),
  person(24, 'oscar_o', 'Oscar', '#e8590c'),
  person(25, 'mesh_mira', 'Mira', '#0c8599'),
  person(26, 'b_routing', 'Bea', '#862e9c'),
];
const FAN_FOLLOWERS = [184_000, 2_100, 640, 51_000, 90, 12_400, 310];

/**
 * X, played: the feed conversation and its messages, profiles of the people in it, their posts on asking. Nothing
 * here is ever sent anywhere; markRead and typing are logged for the verify script, which checks the hub sent none.
 */
export class DemoX implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private epoch = Date.now();
  private readLog: { conversation: string; upTo: string; at: number }[] = [];
  private typingLog: { conversation: string; at: number }[] = [];
  private refused: string[] = [];
  /** Every command that is not a read (action writeLog): what would have changed something on X, sent or not. */
  private writes: string[] = [];
  /** What you did here: posts liked and reposted, and posts written. */
  private liked = new Set<string>();
  private reposted = new Set<string>();
  private made: P.PostFact[] = [];
  /** The next like or repost is refused (action failNextAct): the verify script sees the page take it back. */
  private failNext = false;
  private postLog: { post: string; cursor?: string; at: number }[] = [];
  private translateLog: { post: string; to: string; at: number }[] = [];

  constructor(
    private acc: AccountRow,
    private dir: string,
  ) {}

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    this.epoch = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    const marker = join(this.dir, 'seeded');
    const firstRun = !existsSync(marker);
    // No `connect` or `disconnect`: it cannot follow or unfollow, as the real extractor cannot yet.
    emit({ t: 'hello', network: 'x', version: 'demo', capabilities: ['send', 'history', 'markRead', 'typing', 'react', 'profile', 'posts', 'postActions', 'publish', 'postReactors', 'translate', 'openDirect'] });
    emit({ t: 'status', status: 'online', self: { ...X.self, isSelf: true } });
    // Identity facts first, then what X showed about each of them (their profile came with the notification).
    for (const [k, i] of Object.entries(X)) if (k !== 'self') emit({ t: 'identity', identity: i });
    const items = feed(this.epoch);
    emit({ t: 'conversation', conversation: { nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications', lastMessageAt: this.epoch - items[items.length - 1].min * MIN } });
    for (const who of new Set(items.map((x) => x.who))) emit({ t: 'personAbout', who: X[who].nativeId, about: aboutOf(who), ts: this.epoch - 60 * MIN });
    items.forEach((x, n) => {
      const text = x.item.type === 'reply' || x.item.type === 'mention' || x.item.type === 'quote';
      emit({
        t: 'message',
        live: firstRun && n >= items.length - LIVE,
        message: {
          nativeId: x.nativeId,
          conversation: 'feed',
          author: X[x.who].nativeId,
          ts: this.epoch - x.min * MIN,
          kind: text ? 'text' : 'system',
          body: x.body,
          ...(x.item.type === 'mention' || x.item.type === 'reply' ? { mentionsSelf: true } : {}),
          extra: { feed: x.item },
        },
      });
    });
    // Read up to the ones that arrive live.
    emit({ t: 'read', conversation: 'feed', upToTs: this.epoch - items[items.length - LIVE - 1].min * MIN });
    if (firstRun) writeFileSync(marker, String(Date.now()));
  }

  private whoOf(nativeId: string): Who | null {
    return (Object.entries(X) as [Who, P.IdentityFact][]).find(([, i]) => i.nativeId === nativeId)?.[0] ?? null;
  }

  command(cmd: P.AdapterCommand) {
    const reply = (result?: unknown) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: true, result });
    const fail = (error: string) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: false, error });
    if (cmd.t !== 'profile' && cmd.t !== 'post' && cmd.t !== 'postReactors' && cmd.t !== 'translate' && cmd.t !== 'history' && cmd.t !== 'action') this.writes.push(cmd.t === 'postAct' ? `postAct:${cmd.act}` : cmd.t);
    switch (cmd.t) {
      case 'profile': {
        const who = this.whoOf(cmd.who);
        if (!who) return fail('no such user');
        // A repost or a quote names its author: their facts come first, as the real extractor sends them.
        for (const k of ['quinn'] as Who[]) this.emit({ t: 'identity', identity: X[k] });
        return reply({ ...aboutOf(who), posts: postsOf(who, this.epoch) } satisfies P.PersonAbout);
      }
      case 'post': {
        this.postLog.push({ post: cmd.post, ...(cmd.cursor ? { cursor: cmd.cursor } : {}), at: Date.now() });
        const t = threads(this.epoch, this.made)(cmd.post, cmd.cursor);
        if (!t) return fail('X did not give this post');
        // Authors from outside the demo's people (the fans who answer in other languages): their facts first.
        for (const i of FANS) if ([...t.replies.flat(), ...t.ancestors, t.focal].some((p) => p?.author === i.nativeId)) this.emit({ t: 'identity', identity: i });
        const v = (p: P.PostFact) => this.viewed(p);
        return reply({ ...t, ...(t.focal ? { focal: v(t.focal) } : {}), ancestors: t.ancestors.map(v), replies: t.replies.map((c) => c.map(v)) } satisfies P.PostThread);
      }
      case 'postAct': {
        if (this.failNext) {
          this.failNext = false;
          return fail('X said no (the demo was asked to refuse this one)');
        }
        const on = !cmd.act.startsWith('un');
        const set = cmd.act.endsWith('like') ? this.liked : this.reposted;
        if (on) set.add(cmd.post);
        else set.delete(cmd.post);
        return reply({ liked: this.liked.has(cmd.post), reposted: this.reposted.has(cmd.post) } satisfies P.PostViewer);
      }
      case 'publish': {
        const known = threads(this.epoch, this.made).known;
        const to = cmd.replyTo ? known(cmd.replyTo) : null;
        if (cmd.replyTo && !to) return fail('That post is gone');
        const quoted = cmd.quote ? known(cmd.quote) : null;
        const id = pid(2000 + this.made.length);
        const p: P.PostFact = {
          id,
          url: url(X.self, id),
          ts: Date.now(),
          author: X.self.nativeId,
          text: cmd.text,
          ...(to ? { replyTo: { id: to.id, ...(to.author ? { author: to.author } : {}) }, root: to.root ?? to.id } : {}),
          ...(quoted ? { quoteOf: quoted } : {}),
          counts: { replies: 0, reposts: 0, likes: 0, views: 0 },
        };
        this.made.push(p);
        return reply(p satisfies P.PostFact);
      }
      case 'translate': {
        this.translateLog.push({ post: cmd.post, to: cmd.to, at: Date.now() });
        const n = Object.keys(TRANSLATED).map(Number).find((k) => pid(k) === cmd.post);
        if (n === undefined) return fail('X has no translation for this post');
        return reply({ text: TRANSLATED[n]!.text, from: TRANSLATED[n]!.from, by: 'Grok' } satisfies P.NetworkTranslation);
      }
      case 'postReactors': {
        const known = threads(this.epoch, this.made).known(cmd.post);
        if (!known) return fail('X did not give this post');
        // X names who liked a post only to its author.
        if (cmd.kind === 'like' && known.author !== X.self.nativeId) return reply({ who: [], more: null } satisfies P.ReactorsPage);
        const fromFeed = feed(this.epoch).filter((x) => x.item.type === cmd.kind && x.item.post?.id === cmd.post).map((x) => X[x.who]);
        const fans = known.id === yourPosts(this.epoch).routing.id ? (cmd.kind === 'like' ? FANS : FANS.slice(0, 2)) : [];
        const all = [...fans.slice(0, 2), ...fromFeed, ...fans.slice(2)];
        all.forEach((i) => this.emit({ t: 'identity', identity: i }));
        const page = cmd.cursor === 'r-1' ? all.slice(8) : all.slice(0, 8);
        const who = page.map((i) => {
          const fan = FANS.indexOf(i);
          const k = (Object.keys(X) as Who[]).find((w) => X[w] === i);
          return { id: i.nativeId, followers: fan >= 0 ? FAN_FOLLOWERS[fan] : k ? BIO[k].followers : undefined, followsYou: k ? !!BIO[k].followsYou : false };
        });
        return reply({ who, more: !cmd.cursor && all.length > 8 ? 'r-1' : null } satisfies P.ReactorsPage);
      }
      case 'history':
        return reply({ count: 0, done: true } satisfies P.HistoryResult);
      case 'markRead':
        this.readLog.push({ conversation: cmd.conversation, upTo: cmd.upTo, at: Date.now() });
        return reply();
      case 'typing':
        this.typingLog.push({ conversation: cmd.conversation, at: Date.now() });
        return reply();
      case 'send':
      case 'react':
      case 'edit':
      case 'redact':
        // The hub should never get here for the feed; if it did, the verify script sees it.
        this.refused.push(`${cmd.t}:${cmd.conversation}`);
        return fail('the demo X account sends nothing');
      case 'action':
        return reply(cmd.action === 'readLog' ? { reads: this.readLog } : cmd.action === 'typingLog' ? { typing: this.typingLog } : cmd.action === 'sendLog' ? { sent: this.refused } : cmd.action === 'postLog' ? { posts: this.postLog } : cmd.action === 'translateLog' ? { translated: this.translateLog } : cmd.action === 'writeLog' ? { writes: this.writes } : cmd.action === 'failNextAct' ? ((this.failNext = true), { note: 'the next like or repost is refused' }) : { note: 'demo X has no such action' });
      default:
        if ('id' in cmd) fail('the demo X account cannot do that');
    }
  }

  /** A post as you see it: what you did to it, and its counts with it. */
  private viewed(p: P.PostFact): P.PostFact {
    const liked = this.liked.has(p.id);
    const reposted = this.reposted.has(p.id);
    if (!liked && !reposted) return p;
    const c = p.counts ?? {};
    return { ...p, viewer: { liked, reposted }, counts: { ...c, likes: (c.likes ?? 0) + Number(liked), reposts: (c.reposts ?? 0) + Number(reposted) } };
  }

  stop() {}
}
