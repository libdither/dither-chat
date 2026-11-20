/**
 * Writing a post or a reply on a network that has posts (docs/feed.md "Answering"): how long it may be and how the
 * network counts, what the counter shows and when, the network's own words, and what can be done to a post. One
 * composer draws every network from these rules: X's ring that fills and counts down from 20, Mastodon's 500 with its
 * content warning, Reddit's and Lemmy's title, place and Markdown, Substack's Notes, Bluesky's 300. Pure, so the hub checks a post with the same count the page shows.
 */
import type { ReplyGate } from './feed.ts';

export interface PostRules {
  /**
   * The network's words: its button, its placeholder, a reply's; what liking and reposting are called there (X's Like
   * and Repost, Mastodon's Favourite and Boost, Reddit's Upvote, Substack's Restack).
   */
  words: {
    post: string;
    reply: string;
    quote: string;
    placeholder: string;
    replyPlaceholder: string;
    quotePlaceholder: string;
    like: string;
    unlike: string;
    repost: string;
    unrepost: string;
    /** The list of who liked or reposted: "Liked by", "Favourited by", "Boosted by". */
    likedBy: string;
    repostedBy: string;
  };
  /** The like button's picture: X's and Substack's heart, Mastodon's star, Reddit's and Lemmy's arrow up. */
  likeIcon: 'heart' | 'star' | 'upvote';
  /** What the account's two home timelines are called there (HomeFeed 'following' and 'foryou'). */
  timelines: { following: string; foryou: string };
  /** At most this long, as `count` counts. */
  maxLength: number;
  /** A reply or comment, where the network allows less than a new post (Reddit: 10,000 in a comment, 40,000 in a post). */
  replyMaxLength?: number;
  /**
   * How length is counted. 'weighted' (X, twitter-text v3): most Latin, Cyrillic, Greek and punctuation count one,
   * other characters (CJK, most symbols) and each emoji two, every link `urlLength`; the limit is in those units.
   * 'chars': characters as the reader sees them (graphemes). 'links': graphemes, but every link `urlLength`
   * (Mastodon's 23, whatever its length).
   */
  count: 'weighted' | 'chars' | 'links';
  /** What a link counts as under 'weighted' and 'links'. */
  urlLength: number;
  /**
   * The counter: 'ring' (X: a ring filling as you type; from `warnAt` left it grows and shows what is left, past the
   * limit a negative count in red, and the ring goes once you are more than 10 over), or 'text' ("1,204 left", shown
   * from `warnAt` left).
   */
  counter: 'ring' | 'text';
  warnAt: number;
  /** Written in Markdown (Reddit), or plain as it shows (X). */
  markdown: boolean;
  /** What a post here can have done to it. */
  actions: { like: boolean; repost: boolean; quote: boolean; reply: boolean };
  /**
   * Who may see who liked a post: only its author (X since 2024), everyone, or nobody (a count only: Reddit, YouTube).
   * Who reposted is public where reposts are.
   */
  likersVisible: 'author' | 'all' | 'none';
  /** Pictures or a video with a new post: at most `images` pictures, or one GIF, or one video (none: 0 and false). */
  media: { images: number; gif: boolean; video: boolean };
  /** Who may reply, offered on a new post (X's "who can reply"); empty when the network has no such choice. */
  replyGates: readonly ReplyGate[];
  /** A title apart from the words (Reddit, Lemmy), on a new post only: whether it needs one, and how long it may be. */
  title?: { required: boolean; maxLength: number };
  /**
   * Where a new post goes (a subreddit, a community), on a new post only. `prefix` is how the network writes one
   * ("r/", "!"), `example` a placeholder, `pattern` what a name must look like (without the prefix).
   */
  place?: { required: boolean; noun: string; prefix: string; example: string; pattern: string };
  /** A content warning over the words (Mastodon's CW), on any post: how long it may be. */
  warning?: { maxLength: number };
}

const X_RULES: PostRules = {
  words: { post: 'Post', reply: 'Reply', quote: 'Quote', placeholder: "What's happening?", replyPlaceholder: 'Post your reply', quotePlaceholder: 'Add a comment', like: 'Like', unlike: 'Unlike', repost: 'Repost', unrepost: 'Undo repost', likedBy: 'Liked by', repostedBy: 'Reposted by' },
  likeIcon: 'heart',
  timelines: { following: 'Following', foryou: 'For you' },
  maxLength: 280,
  count: 'weighted',
  urlLength: 23,
  counter: 'ring',
  warnAt: 20,
  markdown: false,
  actions: { like: true, repost: true, quote: true, reply: true },
  likersVisible: 'author',
  media: { images: 4, gif: true, video: true },
  replyGates: ['everyone', 'following', 'mentioned', 'verified'],
};

/**
 * Mastodon's: 500 characters (an instance may allow more), every link 23, a content warning (counted in the same 500
 * on Mastodon; here on its own), favourites everyone can see, boosts. Home is the home timeline, For you its trends.
 */
export const MASTODON_RULES: PostRules = {
  words: { post: 'Publish', reply: 'Reply', quote: 'Quote', placeholder: "What's on your mind?", replyPlaceholder: 'Post your reply', quotePlaceholder: 'Add a comment', like: 'Favourite', unlike: 'Undo favourite', repost: 'Boost', unrepost: 'Undo boost', likedBy: 'Favourited by', repostedBy: 'Boosted by' },
  likeIcon: 'star',
  timelines: { following: 'Home', foryou: 'Trending' },
  maxLength: 500,
  count: 'links',
  urlLength: 23,
  counter: 'text',
  warnAt: 50,
  markdown: false,
  actions: { like: true, repost: true, quote: false, reply: true },
  likersVisible: 'all',
  media: { images: 4, gif: true, video: true },
  replyGates: [],
  warning: { maxLength: 500 },
};

/** Reddit's: a post needs a title (300) and a subreddit; a body up to 40,000 characters of Markdown, a comment 10,000; votes, no reposts. */
export const REDDIT_RULES: PostRules = {
  words: { post: 'Post', reply: 'Comment', quote: 'Crosspost', placeholder: 'Body text (optional)', replyPlaceholder: 'Add a comment', quotePlaceholder: 'Add a comment', like: 'Upvote', unlike: 'Remove upvote', repost: 'Crosspost', unrepost: 'Undo crosspost', likedBy: 'Upvoted by', repostedBy: 'Crossposted by' },
  likeIcon: 'upvote',
  timelines: { following: 'New', foryou: 'Best' },
  maxLength: 40_000,
  replyMaxLength: 10_000,
  count: 'chars',
  urlLength: 0,
  counter: 'text',
  warnAt: 1_000,
  markdown: true,
  actions: { like: true, repost: false, quote: false, reply: true },
  likersVisible: 'none',
  media: { images: 20, gif: true, video: true },
  replyGates: [],
  title: { required: true, maxLength: 300 },
  place: { required: true, noun: 'subreddit', prefix: 'r/', example: 'r/subreddit', pattern: '^[A-Za-z0-9][A-Za-z0-9_]{1,20}$' },
};

/** Lemmy's: as Reddit's, a title (200) and a community (`name@instance` for one on another server), 10,000 characters. */
export const LEMMY_RULES: PostRules = {
  words: { post: 'Post', reply: 'Reply', quote: 'Crosspost', placeholder: 'Body (optional)', replyPlaceholder: 'Write a reply', quotePlaceholder: 'Add a comment', like: 'Upvote', unlike: 'Remove upvote', repost: 'Crosspost', unrepost: 'Undo crosspost', likedBy: 'Upvoted by', repostedBy: 'Crossposted by' },
  likeIcon: 'upvote',
  timelines: { following: 'Subscribed', foryou: 'All' },
  maxLength: 10_000,
  count: 'chars',
  urlLength: 0,
  counter: 'text',
  warnAt: 500,
  markdown: true,
  actions: { like: true, repost: false, quote: false, reply: true },
  likersVisible: 'none',
  media: { images: 1, gif: false, video: false },
  replyGates: [],
  title: { required: true, maxLength: 200 },
  place: { required: true, noun: 'community', prefix: '!', example: '!community@instance', pattern: '^[a-z0-9_]{3,20}(@[a-z0-9.-]+\\.[a-z]{2,})?$' },
};

/** Substack's: Notes and comments, no short limit (10,000 here), hearts and restacks. Inbox is your subscriptions' posts, Notes its For you. */
export const SUBSTACK_RULES: PostRules = {
  words: { post: 'Post', reply: 'Reply', quote: 'Restack with note', placeholder: 'What’s on your mind?', replyPlaceholder: 'Write a comment…', quotePlaceholder: 'Add a note', like: 'Like', unlike: 'Unlike', repost: 'Restack', unrepost: 'Undo restack', likedBy: 'Liked by', repostedBy: 'Restacked by' },
  likeIcon: 'heart',
  timelines: { following: 'Inbox', foryou: 'Notes' },
  maxLength: 10_000,
  count: 'chars',
  urlLength: 0,
  counter: 'text',
  warnAt: 500,
  markdown: false,
  actions: { like: true, repost: true, quote: false, reply: true },
  likersVisible: 'all',
  media: { images: 4, gif: true, video: false },
  replyGates: [],
};

/**
 * Bluesky's: 300 characters as the reader sees them (graphemes, as Bluesky counts: an emoji or a flag is one, a link
 * counts as written), up to four pictures or one video, likes and reposts everyone can see, quote posts. No title, no
 * place (no communities), and no content warning of your own words (Bluesky's labels are a fixed few, not built here).
 * Following is your follows, Discover Bluesky's own feed.
 */
export const BLUESKY_RULES: PostRules = {
  words: { post: 'Post', reply: 'Reply', quote: 'Quote post', placeholder: "What's up?", replyPlaceholder: 'Write your reply', quotePlaceholder: 'Add a comment', like: 'Like', unlike: 'Unlike', repost: 'Repost', unrepost: 'Undo repost', likedBy: 'Liked by', repostedBy: 'Reposted by' },
  likeIcon: 'heart',
  timelines: { following: 'Following', foryou: 'Discover' },
  maxLength: 300,
  count: 'chars',
  urlLength: 0,
  counter: 'ring',
  warnAt: 20,
  markdown: false,
  actions: { like: true, repost: true, quote: true, reply: true },
  likersVisible: 'all',
  media: { images: 4, gif: false, video: true },
  replyGates: [],
};

/** The rules of each network that has posts. */
export const POST_RULES: Readonly<Record<string, PostRules>> = { x: X_RULES, mastodon: MASTODON_RULES, reddit: REDDIT_RULES, lemmy: LEMMY_RULES, substack: SUBSTACK_RULES, bluesky: BLUESKY_RULES };
export const postRulesFor = (network: string): PostRules | null => (Object.hasOwn(POST_RULES, network) ? POST_RULES[network]! : null);

/** The rules for a reply or comment: the network's, with its reply limit where it has one. */
export const rulesForReply = (rules: PostRules): PostRules => (rules.replyMaxLength === undefined ? rules : { ...rules, maxLength: rules.replyMaxLength });

/** A timeline's name on its network: X's "For you", Reddit's "Best", Substack's "Notes". */
export const timelineName = (network: string, feed: 'following' | 'foryou'): string => postRulesFor(network)?.timelines[feed] ?? (feed === 'following' ? 'Following' : 'For you');

/**
 * A place as written in the composer ("r/rust", "rust", "!rust@lemmy.example", "rust@lemmy.example") as the network's name for
 * it, without its prefix; null when the network takes no place or it does not look like one.
 */
export function placeName(input: string, rules: PostRules): string | null {
  if (!rules.place) return null;
  let t = input.trim();
  const pre = rules.place.prefix;
  if (t.toLowerCase().startsWith(pre.toLowerCase())) t = t.slice(pre.length);
  else if (pre === 'r/' && t.toLowerCase().startsWith('/r/')) t = t.slice(3);
  if (rules.place.noun === 'community') t = t.toLowerCase();
  return new RegExp(rules.place.pattern).test(t) ? t : null;
}

/**
 * What stops a new post's extra fields (a title, a place, a content warning) from going, or null: the same words on the
 * page and from the hub. `reply`: a reply or comment takes no title and no place.
 */
export function postFieldsProblem(f: { title?: string; place?: string; warning?: string }, rules: PostRules, reply: boolean, net: string): string | null {
  const title = f.title?.trim() ?? '';
  const place = f.place?.trim() ?? '';
  if (reply && (title || place)) return `A reply on ${net} takes no title or ${rules.place?.noun ?? 'place'}.`;
  if (title && !rules.title) return `${net} posts take no title.`;
  if (place && !rules.place) return `${net} posts go to no place.`;
  if (f.warning?.trim() && !rules.warning) return `${net} posts take no content warning.`;
  if (rules.warning && (f.warning?.trim().length ?? 0) > rules.warning.maxLength) return `The content warning is longer than ${rules.warning.maxLength}.`;
  if (reply) return null;
  if (rules.title?.required && !title) return `A post on ${net} needs a title.`;
  if (rules.title && graphemes(title).length > rules.title.maxLength) return `The title is longer than ${net}'s ${rules.title.maxLength}.`;
  if (rules.place?.required && !place) return `A post on ${net} goes to a ${rules.place.noun}: say which (${rules.place.example}).`;
  if (rules.place && place && !placeName(place, rules)) return `That is not a ${rules.place.noun} name (${rules.place.example}).`;
  return null;
}

// twitter-text v3: code points in these ranges weigh 100 (one), all others 200 (two); scale 100.
const LIGHT: readonly [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const light = (cp: number) => LIGHT.some(([a, b]) => cp >= a && cp <= b);
// A link as X sees one (twitter-text's extractUrls, simplified): with its scheme anywhere; bare, on a known ending,
// not inside an email address or an @handle. A bare two-letter (country) ending counts only with a path, except .co
// and .tv, as twitter-text has it.
const GENERIC = 'com|org|net|edu|gov|mil|int|info|biz|name|pro|io|ai|app|dev|page|link|live|news|blog|site|online|store|tech|club|xyz|art|wiki|social|space|studio|world|zone|tools|codes|cafe|moe|ink|garden|email|today|top|shop|games|media|network|cloud|software|systems';
const COUNTRY = '[a-z]{2}';
const URL = new RegExp(
  `(?<![\\p{L}\\p{N}_@.\\-/])(?:https?://[^\\s<>"]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:(${GENERIC})|(${COUNTRY}))(?![\\p{L}\\p{N}_\\-@])(/[^\\s<>"]*)?)`,
  'giu',
);
// An emoji as X counts one (two): shown as a picture by default, asked for with VS16, a flag, a keycap, a ZWJ sequence.
// © and ® alone are text (one).
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f|\p{Regional_Indicator}|\u20e3|\u200d/u;
/** What does not count as something to send: spaces, and the invisible joiners and marks. */
const BLANK = /[\s\u200b-\u200d\u2060\ufeff]/gu;

/** Trailing punctuation that ends a sentence, not a link; a closing bracket stays when the link opened one. */
function trimLink(raw: string): string {
  let t = raw.replace(/[.,;:!?'"\]]+$/u, '');
  while (t.endsWith(')') && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, -1).replace(/[.,;:!?'"\]]+$/u, '');
  return t;
}

// Made on first use: nothing runs when the module loads, so a bundle that does not count drops it.
let segmenter: Intl.Segmenter | null | undefined;
const graphemes = (s: string): string[] => {
  segmenter ??= typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return segmenter ? [...segmenter.segment(s)].map((g) => g.segment) : Array.from(s);
};

/** Each piece of the text and what it counts for: so the page can tell where the limit falls. */
function pieces(text: string, rules: PostRules): { at: number; end: number; weight: number }[] {
  const t = text.normalize('NFC');
  const out: { at: number; end: number; weight: number }[] = [];
  if (rules.count === 'chars') {
    let at = 0;
    for (const g of graphemes(t)) out.push({ at, end: (at += g.length), weight: 1 });
    return out;
  }
  const links: [number, number][] = [];
  for (const m of t.matchAll(URL)) {
    // A bare country ending with no path is not a link ("read.me now"), but .co and .tv are.
    if (m[2] && !m[3] && m[2].toLowerCase() !== 'co' && m[2].toLowerCase() !== 'tv') continue;
    const raw = trimLink(m[0]);
    if (raw) links.push([m.index!, m.index! + raw.length]);
  }
  let at = 0;
  let li = 0;
  while (at < t.length) {
    const link = links[li];
    if (link && at === link[0]) {
      out.push({ at, end: link[1], weight: rules.urlLength });
      at = link[1];
      li++;
      continue;
    }
    const stop = link ? link[0] : t.length;
    for (const g of graphemes(t.slice(at, stop))) {
      const weight = rules.count === 'links' ? 1 : EMOJI.test(g) ? 2 : Array.from(g).reduce((n, ch) => n + (light(ch.codePointAt(0)!) ? 1 : 2), 0);
      out.push({ at, end: at + g.length, weight });
      at += g.length;
    }
  }
  return out;
}

/** The text's length as the network counts it. */
export const postLength = (text: string, rules: PostRules) => pieces(text, rules).reduce((n, p) => n + p.weight, 0);

export interface ComposeState {
  length: number;
  remaining: number;
  /** How full, 0 to 1 (the ring). */
  progress: number;
  /** 'ok', 'warn' (within `warnAt` of the limit), 'over'. */
  level: 'ok' | 'warn' | 'over';
  /** Show the number: within `warnAt` of the limit or past it. */
  showCount: boolean;
  /** The ring: until more than 10 over (X). */
  showRing: boolean;
  /** Where in the text (a string index, NFC) it first goes past the limit, for marking what is too much; null within. */
  overFrom: number | null;
  /** Something to send, and not too long. */
  sendable: boolean;
}

/** What the composer shows for this text. */
export function composeState(text: string, rules: PostRules): ComposeState {
  const ps = pieces(text, rules);
  let length = 0;
  let overFrom: number | null = null;
  for (const p of ps) {
    length += p.weight;
    if (overFrom === null && length > rules.maxLength) overFrom = p.at;
  }
  const remaining = rules.maxLength - length;
  const level = remaining < 0 ? 'over' : remaining <= rules.warnAt ? 'warn' : 'ok';
  return {
    length,
    remaining,
    progress: Math.min(1, length / rules.maxLength),
    level,
    showCount: level !== 'ok',
    showRing: rules.counter === 'ring' && remaining >= -10,
    overFrom,
    sendable: text.replace(BLANK, '').length > 0 && remaining >= 0,
  };
}

/**
 * Text too long for one post, as a thread: parts that each fit, cut where a reader would. A paragraph is kept whole in
 * one post when it fits, short ones sharing a post; a paragraph too long for one is cut between sentences, then words,
 * and a word longer than a whole post where it must. Each part trimmed; empty ones dropped. Text that fits is one part.
 */
export function splitThread(text: string, rules: PostRules): string[] {
  const fits = (s: string) => postLength(s, rules) <= rules.maxLength;
  const t = text.trim();
  if (!t) return [];
  if (fits(t)) return [t];
  const parts: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  /** Adds a piece after what is there, joined by `join`, starting a new part when it would not fit. */
  const add = (piece: string, join: string) => {
    const next = cur ? cur + join + piece : piece;
    if (cur && !fits(next)) {
      flush();
      cur = piece;
    } else cur = next;
  };
  for (const raw of t.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (!para) continue;
    // A paragraph that fits goes whole: with what came before when both fit, else in a post of its own.
    if (fits(para)) {
      add(para, '\n\n');
      continue;
    }
    flush();
    // Too long for one post: by sentences, a sentence too long by words, a word too long by characters.
    const sentences = para.match(/[^.!?。！？\n]+(?:[.!?。！？]+["')\]]*|\n|$)/gu) ?? [para];
    for (const sen of sentences) {
      const sentence = sen.trim();
      if (!sentence) continue;
      const join = sen.startsWith('\n') || /\n$/.test(cur) ? '\n' : ' ';
      if (fits(sentence)) {
        add(sentence, join);
        continue;
      }
      for (const [wi, w] of sentence.split(/\s+/).entries()) {
        let rest = w;
        while (!fits(rest)) {
          let n = rest.length;
          while (n > 1 && !fits(rest.slice(0, n))) n = Math.floor(n * 0.9);
          add(rest.slice(0, n), wi ? ' ' : join);
          rest = rest.slice(n);
        }
        if (rest) add(rest, wi ? ' ' : join);
      }
    }
    flush();
  }
  flush();
  return parts.filter(Boolean);
}
