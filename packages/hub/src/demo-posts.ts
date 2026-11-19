/**
 * The demo world's Mastodon, Reddit, Lemmy and Substack accounts (docs/feed.md "The demo world"): networks of posts
 * only, as dither-accounts' extractors for them send them. Each has a home timeline in two (Mastodon's Home and
 * Trending, Reddit's New and Best, Lemmy's Subscribed and All, Substack's Inbox and Notes), threads with comment trees,
 * notifications in one `feed` conversation, profiles with posts, and what you do there (like, repost where the network
 * has one, posts with a title and a place, a content warning). Everyone and everything here is made up.
 *
 * What each exercises: Mastodon a content warning on a post and on a reply, a boost and Trending's reasons; Reddit a
 * title and a subreddit on every post, a comment tree deeper than six levels (Continue this thread) and votes with no
 * names; Lemmy `post:` and `comment:` ids, communities on other servers; Substack a publication as the place, a
 * long post's title, Notes and restacks.
 */
import type * as P from '@dither-chat/protocol';
import type { AccountRow } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

export type PostsNet = 'mastodon' | 'reddit' | 'lemmy' | 'substack';

export const DEMO_POST_ACCOUNTS: { id: string; network: PostsNet; label: string; color: string }[] = [
  { id: 'acc_demo-mastodon', network: 'mastodon', label: 'toots', color: '#6364FF' },
  { id: 'acc_demo-reddit', network: 'reddit', label: 'reddit', color: '#FF4500' },
  { id: 'acc_demo-lemmy', network: 'lemmy', label: 'lemmy', color: '#00BC8C' },
  { id: 'acc_demo-substack', network: 'substack', label: 'reading', color: '#FF6719' },
];

const MIN = 60_000;
const H = 60;

const pic = (bg: string, fg: string, letter: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="42" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="${fg}">${letter}</text></svg>`)}`;
const shot = (bg: string, body: string, w = 640, h = 360) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`)}`;
const FIG = shot('#e8f3e0', `<g fill="#3f7d3a"><ellipse cx="320" cy="200" rx="90" ry="120"/><ellipse cx="220" cy="230" rx="60" ry="80"/><ellipse cx="420" cy="230" rx="60" ry="80"/></g><rect x="250" y="290" width="140" height="60" rx="8" fill="#a0522d"/>`);
const COAST = shot('#9ec5e8', `<rect y="240" width="640" height="120" fill="#2f5d7c"/><rect x="470" y="90" width="40" height="160" fill="#f4f1ea"/><rect x="470" y="90" width="40" height="30" fill="#d9480f"/><circle cx="120" cy="80" r="36" fill="#ffd36e"/>`);
const LOAF = shot('#f7e7c6', `<ellipse cx="320" cy="210" rx="220" ry="110" fill="#b5652b"/><path d="M160 180 Q320 120 480 180" stroke="#f3d29b" stroke-width="10" fill="none"/>`);
const GRAPH = shot('#1f2a4a', `<g stroke="#5cc8ff" stroke-width="3">${[[80, 280, 200, 120], [200, 120, 340, 220], [340, 220, 480, 100], [480, 100, 580, 260], [200, 120, 480, 100]].map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`).join('')}</g><g fill="#f7d154">${[[80, 280], [200, 120], [340, 220], [480, 100], [580, 260]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="12"/>`).join('')}</g>`);

interface Person {
  key: string;
  identity: P.IdentityFact;
  bio: string;
  followers?: number;
  following?: number;
  followsYou?: boolean;
  url: string;
}

interface World {
  network: PostsNet;
  me: Person;
  people: Person[];
  /** Every post and comment it knows, by id, each with what it answers. */
  posts: P.PostFact[];
  home: Record<P.HomeFeed, { id: string; reason?: P.HomeReason }[]>;
  /** Notifications, oldest first. */
  feed: { min: number; who: string; nativeId: string; body: string; item: P.FeedItem }[];
  /** Who liked, where the network names them (Mastodon's favourites, Substack's likes). */
  likers?: Record<string, string[]>;
  reposters?: Record<string, string[]>;
  /** Where a new post goes: its place's address on the network (a subreddit, a community). */
  placeOf?: (name: string) => P.PostFact['place'];
  /** A new post's id and link. */
  newId: (n: number, reply: P.PostFact | null) => { id: string; url: string };
  capabilities: P.Capability[];
}

const personOf = (key: string, nativeId: string, handle: string, displayName: string, bg: string, bio: string, url: string, x: Partial<Person> = {}): Person => ({
  key,
  identity: { nativeId, handle, displayName, avatarUrl: pic(bg, '#fff', displayName[0]!) },
  bio,
  url,
  ...x,
});

/** A comment tree from rows of [id, parent id, author, minutes ago, text, extra]. */
function tree(epoch: number, root: P.PostFact, rows: [string, string, Person, number, string, Partial<P.PostFact>?][], url: (id: string) => string): P.PostFact[] {
  const out: P.PostFact[] = rows.map(([id, parent, who, min, text, x]) => ({ id, url: url(id), ts: epoch - min * MIN, author: who.identity.nativeId, text, replyTo: { id: parent }, root: root.id, ...x }));
  const all = [root, ...out];
  // Each says how many answer it directly, as a network's count does: no "more replies" that never come.
  return all.map((p) => {
    const n = all.filter((q) => q.replyTo?.id === p.id).length;
    return { ...p, counts: { ...p.counts, replies: n, likes: p.counts?.likes ?? (p.id.length * 7) % 40 } };
  });
}

// ------------------------------------------------------------------ Mastodon

function mastodon(epoch: number): World {
  const s = 'mastodon.example';
  const at = (n: number) => String(113_400_000_000_000_000n + BigInt(n) * 1_009n);
  const me = personOf('me', '109001', 'zyan@mastodon.example', 'Zyan', '#F7D154', 'Routing, sheaves, sheep. Trying out the fediverse.', `https://${s}/@zyan`);
  const fern = personOf('fern', '109002', 'fern@mastodon.example', 'Fern', '#3f7d3a', 'Houseplants and long walks.', `https://${s}/@fern`, { followers: 410, following: 220, followsYou: true });
  const otti = personOf('otti', '209003', 'ottilie@social.example', 'Ottilie', '#9c36b5', 'Watches too much television, writes about it.', 'https://social.example/@ottilie', { followers: 1890, following: 340 });
  const basil = personOf('basil', '109004', 'basil@mastodon.example', 'Basil', '#1971c2', 'Bikes, bread and boosts.', `https://${s}/@basil`, { followers: 95, following: 180, followsYou: true });
  const juno = personOf('juno', '309005', 'juno@toot.example', 'Juno', '#e8590c', 'Photographs lighthouses.', 'https://toot.example/@juno', { followers: 5200, following: 610 });
  const u = (who: Person, id: string) => `${who.url}/${id}`;
  const post = (n: number, who: Person, min: number, text: string, x: Partial<P.PostFact> = {}): P.PostFact => ({ id: at(n), url: u(who, at(n)), ts: epoch - min * MIN, author: who.identity.nativeId, text, ...x });
  const mine = post(1, me, 5 * H, 'Trying out a Mastodon account in the hub. Hello, fediverse! What should I follow first?', { counts: { replies: 4, reposts: 1, likes: 6 } });
  const lighthouse = post(2, juno, 9 * H, 'Low tide at the old lighthouse this morning.', { media: [{ kind: 'image', url: COAST, width: 640, height: 360, alt: 'A red and white lighthouse over a calm sea' }], counts: { replies: 0, reposts: 120, likes: 640 } });
  const posts = [
    lighthouse,
    post(3, fern, 2 * H, 'Re-potted the fig this morning. Roots everywhere, a happy mess.', { media: [{ kind: 'image', url: FIG, width: 640, height: 360, alt: 'A fig tree in a terracotta pot' }], counts: { replies: 0, reposts: 2, likes: 23 } }),
    post(4, otti, 3 * H, 'I did not see that ending coming. The whole last episode is one long shot, and the score drops out right when the door opens.', { warning: 'Spoilers: the finale of the lighthouse show', counts: { replies: 0, reposts: 4, likes: 51 } }),
    post(5, basil, 4 * H, '', { repostOf: lighthouse }),
    post(6, otti, 30 * H, 'Hot take: the second season was better than the first, and the theme song proves it.', { counts: { replies: 0, reposts: 30, likes: 210 } }),
    ...tree(epoch, mine, [
      [at(20), mine.id, fern, 4 * H, `@zyan welcome! Follow the plant people, we are friendly.`],
      [at(21), at(20), me, 3 * H + 40, '@fern noted, starting with you.'],
      [at(22), at(21), fern, 3 * H + 20, '@zyan 🌱'],
      [at(23), mine.id, basil, 3 * H, '@zyan the bread hashtag never disappoints.'],
      [at(24), mine.id, juno, 2 * H, '@zyan some photos from the coast, if you like that sort of thing.', { warning: 'Bright light, flashing water' }],
    ], (id) => u(me, id)),
  ];
  return {
    network: 'mastodon',
    me,
    people: [fern, otti, basil, juno],
    posts,
    home: {
      following: [{ id: at(1) }, { id: at(3) }, { id: at(4) }, { id: at(5) }],
      foryou: [{ id: at(2), reason: { text: 'Trending on mastodon.example', kind: 'topic' } }, { id: at(6), reason: { text: 'Trending', kind: 'topic' } }],
    },
    feed: [
      { min: 4 * H + 30, who: 'fern', nativeId: `like:${mine.id}:${fern.identity.nativeId}`, body: 'favourited your post', item: { type: 'like', post: mine, url: mine.url } },
      { min: 4 * H + 10, who: 'basil', nativeId: `like:${mine.id}:${basil.identity.nativeId}`, body: 'favourited your post', item: { type: 'like', post: mine, url: mine.url } },
      { min: 4 * H, who: 'fern', nativeId: `reply:${at(20)}`, body: posts.find((p) => p.id === at(20))!.text, item: { type: 'reply', post: mine, theirs: posts.find((p) => p.id === at(20)), url: u(fern, at(20)) } },
      { min: 3 * H, who: 'juno', nativeId: `repost:${mine.id}:${juno.identity.nativeId}`, body: 'boosted your post', item: { type: 'repost', post: mine, url: mine.url } },
      { min: 2 * H, who: 'otti', nativeId: `follow:${otti.identity.nativeId}`, body: 'followed you', item: { type: 'follow', url: otti.url } },
    ],
    likers: { [mine.id]: ['fern', 'basil'] },
    reposters: { [mine.id]: ['juno'] },
    newId: (n) => ({ id: at(900 + n), url: u(me, at(900 + n)) }),
    capabilities: ['profile', 'posts', 'postActions', 'publish', 'postReactors', 'home', 'unpublish'],
  };
}

// ------------------------------------------------------------------ Reddit

function reddit(epoch: number): World {
  const b36 = (n: number) => (n * 46_657 + 1_000_000).toString(36);
  const t3 = (n: number) => `t3_${b36(n)}`;
  const t1 = (n: number) => `t1_${b36(n)}`;
  const user = (key: string, name: string, bg: string, bio: string, x: Partial<Person> = {}) => personOf(key, `t2_${b36(key.length * 31 + name.length)}${key}`, name, name, bg, bio, `https://www.reddit.com/user/${name}`, x);
  const me = user('me', 'zyan_demo', '#F7D154', 'Mesh routing and bread.');
  const baker = user('baker', 'thirdshift_baker', '#b5652b', 'Bakes at 3am so you do not have to.', { followers: 120 });
  const lattice = user('lattice', 'lattice_walker', '#5c7cfa', 'Graphs, mostly random ones.', { followers: 860 });
  const kettle = user('kettle', 'kettle_corn', '#e8590c', 'Lurker turned commenter.');
  const moss = user('moss', 'moss_and_stone', '#2b8a3e', 'Rocks, moss, sourdough.');
  const sub = (name: string): P.PostFact['place'] => ({ id: `t5_${b36(name.length * 97)}`, name: `r/${name}`, url: `https://www.reddit.com/r/${name}/` });
  const link = (sr: string, id: string, c?: string) => `https://www.reddit.com/r/${sr}/comments/${id.slice(3)}/${c ? `_/${c.slice(3)}/` : ''}`;
  const post = (n: number, sr: string, who: Person, min: number, title: string, text: string, x: Partial<P.PostFact> = {}): P.PostFact => ({ id: t3(n), url: link(sr, t3(n)), ts: epoch - min * MIN, author: who.identity.nativeId, title, text, place: sub(sr), ...x });
  const greedy = post(2, 'graphtheory', lattice, 6 * H, 'Greedy routing on random geometric graphs: when does it get stuck?', 'I keep hitting local minima once the radius drops below the connectivity threshold. Is there a known bound on how often greedy fails, or is everyone just adding a fallback?', { media: [{ kind: 'image', url: GRAPH, width: 640, height: 360, alt: 'Five nodes joined by lines' }], counts: { replies: 3, likes: 412 } });
  const mine = post(3, 'graphtheory', me, 26 * H, 'Small-world benchmarks for a mesh routing toy', 'Wrote up the numbers from a toy mesh router: stretch stays under 1.3 up to a million nodes. Happy to share the simulator if anyone wants to break it.', { counts: { replies: 2, likes: 57 } });
  // A long back-and-forth under the greedy post, each level with a second answer, so the tree indents past six levels.
  const deep: [string, string, Person, number, string][] = [];
  const voices = [kettle, lattice, moss, baker, me];
  let parent = greedy.id;
  for (let d = 0; d < 9; d++) {
    const id = t1(100 + d * 2);
    deep.push([id, parent, voices[d % voices.length]!, 5 * H - d * 20, d === 0 ? 'Greedy gets stuck exactly when the graph has voids. Add a face-routing fallback and it always delivers.' : `Level ${d + 1}: ${['but face routing needs a planar subgraph', 'Gabriel graph works, it is local', 'only if positions are exact though', 'noise of a few percent is fine in practice', 'has anyone measured that?', 'there is a paper from 2019 on it', 'link please', 'I will dig it up tonight'][d - 1]}`]);
    deep.push([t1(101 + d * 2), parent, voices[(d + 2) % voices.length]!, 5 * H - d * 20 - 5, `A side note at level ${d + 1}.`]);
    parent = id;
  }
  const posts = [
    post(1, 'sourdough', baker, 2 * H, 'My starter finally doubled in six hours', 'Switched to a 1:5:5 feed and kept it on top of the fridge. Six hours to double, smells like yogurt. Is that normal?', { counts: { replies: 0, likes: 88 } }),
    ...tree(epoch, greedy, [...deep, [t1(50), greedy.id, moss, 4 * H, 'Following, I have the same problem with sensor networks.'], [t1(51), greedy.id, me, 3 * H, 'In my toy mesh, greedy plus a two-hop lookahead fixed most of the stuck cases.'], [t1(52), t1(50), lattice, 2 * H, 'u/zyan_demo had a lookahead trick for this, see the comment below.']], (id) => link('graphtheory', greedy.id, id)),
    ...tree(epoch, mine, [
      [t1(60), mine.id, kettle, 20 * H, 'What degree distribution did you use? Small-world graphs are kind to greedy.'],
      [t1(61), t1(60), me, 19 * H, 'Watts-Strogatz with rewiring 0.1. Fair point, I should try a scale-free one.'],
      [t1(62), mine.id, lattice, 18 * H, 'Nice write-up. Would love the simulator.'],
    ], (id) => link('graphtheory', mine.id, id)),
    post(4, 'sourdough', moss, 30 * H, 'Crumb shot after 18 months of trying', 'Finally an open crumb. Thank you all for the advice in the weekly threads.', { media: [{ kind: 'image', url: LOAF, width: 640, height: 360, alt: 'A loaf with an open crumb' }], counts: { replies: 0, likes: 1204 } }),
  ];
  const reply = posts.find((p) => p.id === t1(60))!;
  const mention = posts.find((p) => p.id === t1(52))!;
  return {
    network: 'reddit',
    me,
    people: [baker, lattice, kettle, moss],
    posts,
    home: { following: [{ id: t3(1) }, { id: t3(2) }, { id: t3(3) }], foryou: [{ id: t3(4), reason: { text: 'Popular in r/sourdough', kind: 'community' } }, { id: t3(2), reason: { text: 'Because you visited r/graphtheory', kind: 'community' } }] },
    feed: [
      { min: 20 * H, who: 'kettle', nativeId: `reply:${reply.id}`, body: reply.text, item: { type: 'reply', post: mine, theirs: reply, url: reply.url } },
      { min: 18 * H, who: 'lattice', nativeId: `reply:${t1(62)}`, body: posts.find((p) => p.id === t1(62))!.text, item: { type: 'reply', post: mine, theirs: posts.find((p) => p.id === t1(62)), url: link('graphtheory', mine.id, t1(62)) } },
      { min: 2 * H, who: 'lattice', nativeId: `mention:${mention.id}`, body: mention.text, item: { type: 'mention', theirs: mention, url: mention.url } },
    ],
    placeOf: (name) => sub(name),
    newId: (n, to) => {
      const id = to ? t1(800 + n) : t3(800 + n);
      return { id, url: to ? link('graphtheory', to.root ?? to.id, id) : link('graphtheory', id) };
    },
    capabilities: ['profile', 'posts', 'postActions', 'publish', 'home', 'unpublish'],
  };
}

// ------------------------------------------------------------------ Lemmy

function lemmy(epoch: number): World {
  const s = 'lemmy.example';
  const pid = (n: number) => `post:${n}`;
  const cid = (n: number) => `comment:${n}`;
  const user = (key: string, name: string, host: string, bg: string, bio: string) => personOf(key, `https://${host}/u/${name}`, `${name}@${host}`, name, bg, bio, `https://${host}/u/${name}`);
  const me = user('me', 'zyan', s, '#F7D154', 'Gardening and small tools.');
  const pip = user('pip', 'pip', s, '#2b8a3e', 'Grows too many tomatoes.');
  const rook = user('rook', 'rook', 'feddit.example', '#495057', 'Writes static site generators for fun.');
  const wren = user('wren', 'wren', s, '#c2255c', 'Moderator of !gardening.');
  const community = (name: string, host = s): P.PostFact['place'] => ({ id: `https://${host}/c/${name}`, name: `!${name}@${host}`, url: `https://${host}/c/${name}` });
  const url = (id: string) => `https://${s}/${id.replace(':', '/')}`;
  const post = (n: number, who: Person, min: number, title: string, text: string, place: P.PostFact['place'], x: Partial<P.PostFact> = {}): P.PostFact => ({ id: pid(n), url: url(pid(n)), ts: epoch - min * MIN, author: who.identity.nativeId, title, text, place, ...x });
  const weekly = post(101, wren, 7 * H, 'Weekly thread: what are you growing?', 'Post your windowsills, balconies and allotments. Pictures welcome.', community('gardening'), { counts: { replies: 2, likes: 64 } });
  const mine = post(103, me, 30 * H, 'Seed swap at the community garden this Saturday', 'Bring what you saved, take what you need. There will be tea.', community('gardening'), { counts: { replies: 1, likes: 22 } });
  const posts = [
    ...tree(epoch, weekly, [
      [cid(9001), weekly.id, pip, 6 * H, 'Tomatoes, again. Seven kinds this year, I have no self-control.'],
      [cid(9002), cid(9001), wren, 5 * H, 'Which one did best?'],
      [cid(9003), cid(9002), pip, 4 * H, 'The little yellow pear ones. Hundreds of them.'],
      [cid(9004), weekly.id, me, 3 * H, 'Basil on the windowsill, and one very stubborn lemon tree.'],
    ], url),
    post(102, rook, 10 * H, 'A tiny static site generator in 300 lines', 'No plugins, no config, just Markdown in and HTML out. The source is one file.', community('opensource', 'feddit.example'), { counts: { replies: 0, likes: 140 } }),
    ...tree(epoch, mine, [[cid(9010), mine.id, pip, 20 * H, 'I will bring the yellow pear tomato seeds!']], url),
  ];
  const reply = posts.find((p) => p.id === cid(9010))!;
  return {
    network: 'lemmy',
    me,
    people: [pip, rook, wren],
    posts,
    home: { following: [{ id: pid(101) }, { id: pid(103) }], foryou: [{ id: pid(102), reason: { text: 'Active in !opensource@feddit.example', kind: 'community' } }, { id: pid(101) }] },
    feed: [{ min: 20 * H, who: 'pip', nativeId: `reply:${reply.id}`, body: reply.text, item: { type: 'reply', post: mine, theirs: reply, url: reply.url } }],
    placeOf: (name) => (name.includes('@') ? community(name.split('@')[0]!, name.split('@')[1]!) : community(name)),
    newId: (n, to) => {
      const id = to ? cid(9800 + n) : pid(800 + n);
      return { id, url: url(id) };
    },
    capabilities: ['profile', 'posts', 'postActions', 'publish', 'home', 'unpublish'],
  };
}

// ------------------------------------------------------------------ Substack

function substack(epoch: number): World {
  const nid = (n: number) => `c-${2_000_000 + n}`;
  let n = 0;
  const user = (key: string, handle: string, name: string, bg: string, bio: string, x: Partial<Person> = {}) => personOf(key, String(9_000_000 + ++n), handle, name, bg, bio, `https://substack.com/@${handle}`, x);
  const me = user('me', 'zyan', 'Zyan', '#F7D154', 'Reading about maps and networks.');
  const wren = user('wren', 'slowgraph', 'Wren Abara', '#0c8599', 'Writes The Slow Graph, about maps and the ways they lie.', { followers: 12_400, followsYou: false });
  const ines = user('ines', 'inesfield', 'Ines Okafor', '#862e9c', 'Field Notes: one walk, one essay, every week.', { followers: 3_100, followsYou: true });
  const tom = user('tom', 'tomreads', 'Tom', '#5c940d', 'Comments more than he posts.');
  const slow: P.PostFact['place'] = { id: 'pub:slowgraph', name: 'The Slow Graph', url: 'https://slowgraph.substack.com' };
  const field: P.PostFact['place'] = { id: 'pub:fieldnotes', name: 'Field Notes', url: 'https://fieldnotes.substack.com' };
  const essay: P.PostFact = {
    id: 'p-150001',
    url: 'https://slowgraph.substack.com/p/why-maps-lie-gently',
    ts: epoch - 9 * H * MIN,
    author: wren.identity.nativeId,
    title: 'Why maps lie, gently',
    text: 'Every map leaves things out, and the good ones tell you what. This week: three projections, a subway diagram, and the one map I keep on my wall even though it is wrong about everything.',
    place: slow,
    media: [{ kind: 'image', url: GRAPH, width: 640, height: 360, alt: 'A diagram of stations and lines' }],
    counts: { replies: 3, likes: 214, reposts: 18 },
  };
  const walk: P.PostFact = { id: 'p-150002', url: 'https://fieldnotes.substack.com/p/the-long-way-round', ts: epoch - 30 * H * MIN, author: ines.identity.nativeId, title: 'The long way round', text: 'I walked the old canal path to the edge of the city and back, and counted herons.', place: field, counts: { replies: 0, likes: 96, reposts: 4 } };
  const mine: P.PostFact = { id: nid(1), url: `https://substack.com/@zyan/note/${nid(1)}`, ts: epoch - 6 * H * MIN, author: me.identity.nativeId, text: 'Halfway through "Why maps lie, gently" and already rethinking every diagram I have drawn this year.', counts: { replies: 1, likes: 12, reposts: 2 } };
  const noteOf = (n: number, who: Person, min: number, text: string, x: Partial<P.PostFact> = {}): P.PostFact => ({ id: nid(n), url: `https://substack.com/@${who.identity.handle}/note/${nid(n)}`, ts: epoch - min * MIN, author: who.identity.nativeId, text, ...x });
  const posts = [
    ...tree(epoch, essay, [
      [nid(10), essay.id, tom, 8 * H, 'The subway diagram section is the best thing I have read this month.'],
      [nid(11), nid(10), wren, 7 * H, 'Thank you! That one took three drafts.'],
      [nid(12), essay.id, ines, 6 * H, 'The map on your wall: is it the one with the sea monsters?'],
      [nid(13), nid(12), wren, 5 * H, 'It is. Mostly for the sea monsters.'],
    ], (id) => `${essay.url}/comment/${id.slice(2)}`),
    walk,
    ...tree(epoch, mine, [[nid(20), mine.id, ines, 5 * H, 'Same here. The projections part changed how I read weather maps.']], (id) => `https://substack.com/@zyan/note/${id}`),
    noteOf(30, ines, 2 * H, 'Restacking this because everyone who draws diagrams should read it.', { quoteOf: essay, counts: { likes: 40, reposts: 6, replies: 0 } }),
    noteOf(31, wren, 4 * H, 'Next week: a map of every bench in one park, and what it says about who the park is for.', { counts: { likes: 88, reposts: 9, replies: 0 } }),
  ];
  const reply = posts.find((p) => p.id === nid(20))!;
  return {
    network: 'substack',
    me,
    people: [wren, ines, tom],
    posts,
    home: { following: [{ id: essay.id }, { id: walk.id }], foryou: [{ id: nid(30), reason: { text: 'Ines Okafor restacked', kind: 'like', who: ines.identity.nativeId } }, { id: nid(31) }, { id: mine.id }] },
    feed: [
      { min: 5 * H + 30, who: 'tom', nativeId: `like:${mine.id}:${tom.identity.nativeId}`, body: 'liked your note', item: { type: 'like', post: mine, url: mine.url } },
      { min: 5 * H, who: 'ines', nativeId: `reply:${reply.id}`, body: reply.text, item: { type: 'reply', post: mine, theirs: reply, url: reply.url } },
      { min: 4 * H, who: 'wren', nativeId: `repost:${mine.id}:${wren.identity.nativeId}`, body: 'restacked your note', item: { type: 'repost', post: mine, url: mine.url } },
      { min: 3 * H, who: 'ines', nativeId: `follow:${ines.identity.nativeId}`, body: 'subscribed to you', item: { type: 'follow', url: ines.url } },
    ],
    likers: { [mine.id]: ['tom'] },
    reposters: { [mine.id]: ['wren'] },
    newId: (n) => ({ id: nid(800 + n), url: `https://substack.com/@zyan/note/${nid(800 + n)}` }),
    capabilities: ['profile', 'posts', 'postActions', 'publish', 'postReactors', 'home', 'unpublish'],
  };
}

const WORLDS: Record<PostsNet, (epoch: number) => World> = { mastodon, reddit, lemmy, substack };

/**
 * One network of posts, played: its feed conversation and notifications, home timelines, threads, profiles, and what
 * you do there. Nothing is sent anywhere; every command that would change something is logged (action writeLog).
 */
export class DemoPosts implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private w!: World;
  private liked = new Set<string>();
  private reposted = new Set<string>();
  private made: P.PostFact[] = [];
  private deleted = new Set<string>();
  private writes: string[] = [];
  private postLog: { post: string; cursor?: string; at: number }[] = [];
  private homeLog: { feed: P.HomeFeed; cursor?: string; at: number }[] = [];
  private published: Extract<P.AdapterCommand, { t: 'publish' }>[] = [];

  constructor(
    private acc: AccountRow,
    _dir: string,
  ) {}

  private get network(): PostsNet {
    return this.acc.network as PostsNet;
  }

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    const epoch = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    this.w = WORLDS[this.network](epoch);
    const w = this.w;
    emit({ t: 'hello', network: this.network, version: 'demo', capabilities: w.capabilities });
    emit({ t: 'status', status: 'online', self: { ...w.me.identity, isSelf: true } });
    for (const p of w.people) emit({ t: 'identity', identity: p.identity });
    emit({ t: 'conversation', conversation: { nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications', lastMessageAt: epoch - (w.feed[w.feed.length - 1]?.min ?? 0) * MIN } });
    for (const who of new Set(w.feed.map((x) => x.who))) emit({ t: 'personAbout', who: this.person(who)!.identity.nativeId, about: this.about(this.person(who)!), ts: epoch - 60 * MIN });
    for (const x of w.feed) {
      const text = x.item.type === 'reply' || x.item.type === 'mention' || x.item.type === 'quote';
      emit({
        t: 'message',
        live: false,
        message: { nativeId: x.nativeId, conversation: 'feed', author: this.person(x.who)!.identity.nativeId, ts: epoch - x.min * MIN, kind: text ? 'text' : 'system', body: x.body, ...(x.item.type === 'mention' || x.item.type === 'reply' ? { mentionsSelf: true } : {}), extra: { feed: x.item } },
      });
    }
  }

  private person(key: string): Person | undefined {
    return key === 'me' ? this.w.me : this.w.people.find((p) => p.key === key);
  }

  private about(p: Person): P.PersonAbout {
    return {
      displayName: p.identity.displayName,
      handle: p.identity.handle,
      avatar: p.identity.avatarUrl,
      bio: p.bio,
      counts: { followers: p.followers ?? 40, following: p.following ?? 60, posts: this.all().filter((x) => x.author === p.identity.nativeId).length },
      ...(p === this.w.me ? {} : { followsYou: !!p.followsYou }),
      links: [{ label: 'Profile', value: p.url.replace(/^https:\/\//, ''), url: p.url }],
    };
  }

  private all(): P.PostFact[] {
    return [...this.w.posts, ...this.made].filter((p) => !this.deleted.has(p.id));
  }

  private known(id: string): P.PostFact | undefined {
    return this.all().find((p) => p.id === id) ?? this.all().find((p) => p.repostOf?.id === id)?.repostOf;
  }

  /** A post as you see it: what you did to it, and its counts with it. */
  private viewed(p: P.PostFact): P.PostFact {
    const liked = this.liked.has(p.id);
    const reposted = this.reposted.has(p.id);
    const under = this.made.filter((m) => m.replyTo?.id === p.id && !this.deleted.has(m.id)).length;
    if (!liked && !reposted && !under) return p;
    const c = p.counts ?? {};
    return { ...p, viewer: { liked, reposted }, counts: { ...c, likes: (c.likes ?? 0) + Number(liked), ...(c.reposts !== undefined || reposted ? { reposts: (c.reposts ?? 0) + Number(reposted) } : {}), replies: (c.replies ?? 0) + under } };
  }

  /** A post's thread: what it answers, and every branch under it as chains (each a path down), ten deep at most. */
  private thread(id: string): P.PostThread | null {
    const focal = this.known(id);
    if (!focal) return null;
    const all = this.all();
    const ancestors: P.PostFact[] = [];
    for (let up = focal.replyTo?.id; up; ) {
      const p = all.find((x) => x.id === up);
      if (!p) break;
      ancestors.unshift(p);
      up = p.replyTo?.id;
    }
    const under = (p: P.PostFact) => all.filter((x) => x.replyTo?.id === p.id);
    const chains: P.PostFact[][] = [];
    const walk = (p: P.PostFact, path: P.PostFact[]) => {
      const kids = path.length < 10 ? under(p) : [];
      if (!kids.length) return void (path.length && chains.push(path));
      for (const k of kids) walk(k, [...path, k]);
    };
    walk(focal, []);
    const v = (p: P.PostFact) => this.viewed(p);
    return { focal: v(focal), ancestors: ancestors.map(v), replies: chains.map((c) => c.map(v)), more: null };
  }

  command(cmd: P.AdapterCommand) {
    const reply = (result?: unknown) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: true, result });
    const fail = (error: string) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: false, error });
    const net = this.network;
    if (cmd.t !== 'profile' && cmd.t !== 'post' && cmd.t !== 'postReactors' && cmd.t !== 'history' && cmd.t !== 'action' && cmd.t !== 'home') this.writes.push(cmd.t === 'postAct' ? `postAct:${cmd.act}` : cmd.t);
    switch (cmd.t) {
      case 'home': {
        this.homeLog.push({ feed: cmd.feed, ...(cmd.cursor ? { cursor: cmd.cursor } : {}), at: Date.now() });
        if (cmd.cursor) return reply({ items: [], more: null, top: null } satisfies P.HomePage);
        const own = cmd.feed === 'following' ? this.made.filter((p) => !p.replyTo && !this.deleted.has(p.id)).reverse().map((post) => ({ post })) : [];
        const items = this.w.home[cmd.feed].map((x) => ({ post: this.known(x.id), ...(x.reason ? { reason: x.reason } : {}) })).filter((x): x is P.HomeItem => !!x.post);
        return reply({ items: [...own, ...items].map((i) => ({ ...i, post: this.viewed(i.post) })), more: null, top: null } satisfies P.HomePage);
      }
      case 'post': {
        this.postLog.push({ post: cmd.post, ...(cmd.cursor ? { cursor: cmd.cursor } : {}), at: Date.now() });
        if (cmd.cursor) return reply({ ancestors: [], replies: [], more: null } satisfies P.PostThread);
        const t = this.thread(cmd.post);
        return t ? reply(t) : fail(`${net} did not give this post`);
      }
      case 'profile': {
        const p = [this.w.me, ...this.w.people].find((x) => x.identity.nativeId === cmd.who);
        if (!p) return fail('no such user');
        const posts = this.all().filter((x) => x.author === p.identity.nativeId && !x.replyTo).sort((a, b) => b.ts - a.ts).map((x) => this.viewed(x));
        return reply({ ...this.about(p), posts } satisfies P.PersonAbout);
      }
      case 'postAct': {
        if (!this.known(cmd.post)) return fail(`${net} did not give this post`);
        const repost = cmd.act.endsWith('repost');
        if (repost && (net === 'reddit' || net === 'lemmy')) return fail(`${net} has no reposts`);
        const set = repost ? this.reposted : this.liked;
        if (cmd.act.startsWith('un')) set.delete(cmd.post);
        else set.add(cmd.post);
        return reply({ liked: this.liked.has(cmd.post), reposted: this.reposted.has(cmd.post) } satisfies P.PostViewer);
      }
      case 'publish': {
        this.published.push(cmd);
        const to = cmd.replyTo ? this.known(cmd.replyTo) : null;
        if (cmd.replyTo && !to) return fail('That post is gone');
        if (!to && (net === 'reddit' || net === 'lemmy') && (!cmd.title || !cmd.place)) return fail(`A new ${net} post needs a title and a ${net === 'reddit' ? 'subreddit' : 'community'}`);
        const { id, url } = this.w.newId(this.made.length + this.deleted.size, to ?? null);
        const p: P.PostFact = {
          id,
          url,
          ts: Date.now(),
          author: this.w.me.identity.nativeId,
          text: cmd.text,
          ...(to ? { replyTo: { id: to.id, ...(to.author ? { author: to.author } : {}) }, root: to.root ?? to.id } : {}),
          ...(cmd.title ? { title: cmd.title } : {}),
          ...(cmd.place && this.w.placeOf ? { place: this.w.placeOf(cmd.place) } : {}),
          ...(cmd.warning ? { warning: cmd.warning } : {}),
          counts: { replies: 0, likes: net === 'reddit' || net === 'lemmy' ? 1 : 0, ...(net === 'mastodon' || net === 'substack' ? { reposts: 0 } : {}) },
        };
        this.made.push(p);
        return reply(p satisfies P.PostFact);
      }
      case 'unpublish': {
        const p = this.known(cmd.post);
        if (!p || this.deleted.has(cmd.post)) return reply({ deleted: true });
        if (p.author !== this.w.me.identity.nativeId) return fail('You can delete only your own posts');
        this.deleted.add(cmd.post);
        return reply({ deleted: true });
      }
      case 'postReactors': {
        if (!this.w.capabilities.includes('postReactors')) return fail(`${net} does not say who reacted`);
        const keys = (cmd.kind === 'like' ? this.w.likers : this.w.reposters)?.[cmd.post] ?? [];
        const who = keys.map((k) => this.person(k)!).map((p) => ({ id: p.identity.nativeId, ...(p.followers !== undefined ? { followers: p.followers } : {}), followsYou: !!p.followsYou }));
        return reply({ who, more: null } satisfies P.ReactorsPage);
      }
      case 'history':
        return reply({ count: 0, done: true } satisfies P.HistoryResult);
      case 'action':
        return reply(cmd.action === 'writeLog' ? { writes: this.writes } : cmd.action === 'postLog' ? { posts: this.postLog } : cmd.action === 'homeLog' ? { home: this.homeLog } : cmd.action === 'publishLog' ? { published: this.published } : { note: `demo ${net} has no such action` });
      default:
        if ('id' in cmd) fail(`the demo ${net} account cannot do that`);
    }
  }

  stop() {}
}
