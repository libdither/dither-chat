/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A network's notifications as cards (docs/feed.md), and a person's recent posts: the chunk lazy.tsx loads.
 *
 * A card is one thing that happened: the same thing done to the same post one after another is one card ("Alice, Bob
 * and 3 others liked your post", their pictures stacked, each name and picture opening their profile), your post
 * quoted under it. A reply, mention or quote is a card of its own with their post's words and pictures. Nothing here
 * writes to the network: a quiet bar says where answering happens, with a link there.
 */
// Classic JSX (the pragmas above): preact's own `h`, so this chunk needs no jsx-runtime chunk split off the app's start.
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { FeedCard } from '../../feed.ts';
import { loadTimeline, markRead, openProfile, timelineKey, timelines } from '../../state.ts';
import { timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import './feed.css';

export { PostsList, ThreadView } from './Thread.tsx';

const TYPE_ICON: Record<P.FeedItemType, string> = { like: 'heart', repost: 'repeat', reply: 'reply', mention: 'at', quote: 'quote', follow: 'userPlus', other: 'bell' };
/** At most this many pictures in a card's row of faces. */
const FACES = 8;

function Pictures({ media, url, one }: { media?: P.PostMedia[]; url?: string; one?: boolean }) {
  const shown = (media ?? []).slice(0, one ? 1 : 4);
  if (!shown.length) return null;
  return (
    <a class={`post-media ${one ? 'one' : `n${shown.length}`}`} href={url} {...(url?.startsWith('#') ? { title: 'Open the thread' } : { target: '_blank', rel: 'noreferrer', title: 'Open on the network' })} onClick={(e) => e.stopPropagation()}>
      {shown.map((m) => (
        <span class="post-pic">
          <img src={m.url} alt={m.alt ?? ''} loading="lazy" />
          {m.kind !== 'image' && <span class="post-pic-kind">{m.kind === 'gif' ? 'GIF' : '▶'}</span>}
        </span>
      ))}
    </a>
  );
}

/** Who wrote a post: their picture, name and handle, opening their profile; then when, linking to the post. */
function Byline({ p, kit, size = 18, network = 'x' }: { p: P.PostFact; kit: Kit; size?: number; network?: P.Network }) {
  const who = p.author ?? null;
  const name = who ? kit.name(who) : 'Someone';
  const handle = kit.handle(who);
  return (
    <span class="post-by">
      <button class="post-who" onClick={(e) => (e.stopPropagation(), openProfile(who))} title={`${name}'s profile`}>
        <kit.Avatar id={who ?? p.id} name={name} url={kit.avatarUrl(who)} size={size} />
        <b>{name}</b>
        {handle && <span class="post-handle">@{handle}</span>}
      </button>
      <a class="post-time" href={kit.feed.postHref(network, p.id)} title={`${kit.fullTime(p.ts)}: open the thread`} onClick={(e) => e.stopPropagation()}>
        {kit.ago(p.ts)}
      </a>
    </span>
  );
}

/** A post quoted inside a card or another post: its byline, text clipped to three lines, its first picture small. */
function Quoted({ p, kit, label, network = 'x' }: { p: P.PostFact; kit: Kit; label?: string; network?: P.Network }) {
  const pic = p.media?.[0];
  const href = kit.feed.postHref(network, p.id);
  return (
    <div class="post-quoted">
      {label && <span class="post-label">{label}</span>}
      <div class="post-quoted-body">
        <div class="post-quoted-text">
          <Byline p={p} kit={kit} size={16} network={network} />
          {p.text && (
            <a class="post-clip" href={href} title="Open the thread" onClick={(e) => e.stopPropagation()}>
              {p.text}
            </a>
          )}
        </div>
        {pic && (
          <a class="post-thumb" href={href} title="Open the thread" onClick={(e) => e.stopPropagation()}>
            <img src={pic.url} alt={pic.alt ?? ''} loading="lazy" />
          </a>
        )}
      </div>
    </div>
  );
}

function Counts({ p, kit }: { p: P.PostFact; kit: Kit }) {
  const c = p.counts;
  if (!c) return null;
  const items: [string, number | undefined, string][] = [
    ['reply', c.replies, 'repl'],
    ['repeat', c.reposts, 'repost'],
    ['heart', c.likes, 'like'],
    ['eye', c.views, 'view'],
  ];
  const word = (n: number, w: string) => (w === 'repl' ? (n === 1 ? 'reply' : 'replies') : n === 1 ? w : `${w}s`);
  return (
    <span class="post-counts">
      {items
        .filter(([, n]) => n !== undefined)
        .map(([, n, label]) => (
          <span title={`${n!.toLocaleString()} ${word(n!, label)}`}>
            {kit.feed.shortCount(n!)} {word(n!, label)}
          </span>
        ))}
    </span>
  );
}

/** The faces and names of a card: each opens their profile. Up to three by name, else two and how many others. */
function Actors({ card, kit }: { card: FeedCard; kit: Kit }) {
  const n = card.actors.length;
  const named = n <= 3 ? card.actors : card.actors.slice(0, 2);
  const others = n - named.length;
  return (
    <>
      <div class="feed-faces">
        {card.actors.slice(0, FACES).map((id) => (
          <button class="feed-face" onClick={() => openProfile(id)} title={kit.name(id)} aria-label={`${kit.name(id)}'s profile`}>
            <kit.Avatar id={id} name={kit.name(id)} url={kit.avatarUrl(id)} size={30} />
          </button>
        ))}
        {n > FACES && <span class="feed-faces-more">+{n - FACES}</span>}
      </div>
      <p class="feed-what">
        {named.map((id, i) => (
          <>
            {i > 0 && (i === named.length - 1 && !others ? ' and ' : ', ')}
            <button class="feed-name" onClick={() => openProfile(id)}>
              {kit.name(id)}
            </button>
          </>
        ))}
        {others > 0 && (
          <span class="feed-others" title={card.actors.slice(named.length).map(kit.name).join(', ')}>
            {' '}
            and {others} other{others === 1 ? '' : 's'}
          </span>
        )}{' '}
        {kit.feed.FEED_VERB[card.type]}
        <span class="feed-when" title={kit.fullTime(card.ts)}>
          {kit.ago(card.ts)}
        </span>
      </p>
    </>
  );
}

function GroupCard({ card, kit }: { card: FeedCard; kit: Kit }) {
  return (
    <article
      class={`feed-card ${card.fresh ? 'fresh' : ''} ${card.post ? 'opens' : ''}`}
      data-type={card.type}
      data-count={card.actors.length}
      aria-label={kit.feed.cardSentence(card, kit.name)}
      onClick={(e) => card.post && kit.feed.opensPost(e) && kit.openPost(card.messages[0].network, card.post.id)}
    >
      <span class="feed-icon">
        <kit.Icon name={TYPE_ICON[card.type]} size={18} />
      </span>
      <div class="feed-main">
        <Actors card={card} kit={kit} />
        {card.post && <Quoted p={card.post} kit={kit} network={card.messages[0].network} />}
      </div>
    </article>
  );
}

/** A reply, a mention or a quote: their post, with what it answers. */
function SaidCard({ card, kit }: { card: FeedCard; kit: Kit }) {
  const m = card.messages[0];
  const theirs = card.theirs;
  const who = m.authorId;
  const name = kit.name(who);
  const text = theirs?.text ?? m.body;
  const link = theirs?.url ?? card.url;
  return (
    <article
      class={`feed-card feed-said ${card.fresh ? 'fresh' : ''} ${theirs ? 'opens' : ''}`}
      data-type={card.type}
      aria-label={kit.feed.cardSentence(card, kit.name)}
      onClick={(e) => theirs && kit.feed.opensPost(e) && kit.openPost(m.network, theirs.id)}
    >
      <button class="feed-said-face" onClick={() => openProfile(who)} aria-label={`${name}'s profile`}>
        <kit.Avatar id={who ?? m.id} name={name} url={kit.avatarUrl(who)} size={36} />
        <span class="feed-said-icon">
          <kit.Icon name={TYPE_ICON[card.type]} size={11} />
        </span>
      </button>
      <div class="feed-main">
        <div class="feed-said-head">
          <button class="feed-name" onClick={() => openProfile(who)}>
            {name}
          </button>
          {kit.handle(who) && <span class="post-handle">@{kit.handle(who)}</span>}
          <span class="feed-when" title={kit.fullTime(card.ts)}>
            {kit.ago(card.ts)}
          </span>
        </div>
        {card.type === 'reply' && (
          <p class="feed-context">
            replied to your post
            {card.post?.text ? (
              <>
                :{' '}
                <a href={kit.feed.postHref(m.network, card.post.id)} onClick={(e) => e.stopPropagation()}>
                  “{kit.feed.clip(card.post.text)}”
                </a>
              </>
            ) : null}
          </p>
        )}
        {card.type === 'mention' && <p class="feed-context">mentioned you</p>}
        {card.type === 'quote' && <p class="feed-context">quoted your post</p>}
        {text && (
          <p class="feed-text">
            <kit.Linked text={text} network={m.network} />
          </p>
        )}
        <Pictures media={theirs?.media} url={theirs ? kit.feed.postHref(m.network, theirs.id) : link} />
        {card.type === 'quote' && card.post && <Quoted p={card.post} kit={kit} network={m.network} />}
        {link && (
          <a class="feed-open" href={link} target="_blank" rel="noreferrer">
            <kit.Icon name="external" size={12} /> Open on {NETWORK_META[m.network].name}
          </a>
        )}
      </div>
    </article>
  );
}

function OtherCard({ card, kit }: { card: FeedCard; kit: Kit }) {
  return (
    <article class={`feed-card ${card.fresh ? 'fresh' : ''}`} data-type="other">
      <span class="feed-icon">
        <kit.Icon name="bell" size={18} />
      </span>
      <div class="feed-main">
        <p class="feed-what">
          {kit.feed.cardSentence(card, kit.name)}
          <span class="feed-when">{kit.ago(card.ts)}</span>
        </p>
        {card.post && <Quoted p={card.post} kit={kit} network={card.messages[0].network} />}
      </div>
    </article>
  );
}

/** The feed below its header. Read on the hub as it shows (the network is told nothing); older pages as it scrolls. */
export function FeedView({ c, kit }: { c: P.ConversationView; kit: Kit }) {
  const tkey = timelineKey('c', c.id);
  timelineRev(tkey).value;
  useEffect(() => void loadTimeline(tkey), [tkey]);
  const t = timelines.get(tkey);
  // What was new when it opened stays marked while it is open.
  const readTs = useMemo(() => Math.min(...c.vantages.map((v) => v.lastReadTs ?? 0)), [c.id]);
  const unread = c.vantages.some((v) => v.unread > 0);
  useEffect(() => {
    if (unread && document.visibilityState === 'visible') markRead(c.id);
  }, [c.id, unread, t?.messages.length]);
  const cards = useMemo(() => kit.feed.feedCards(t?.messages ?? [], readTs), [t?.messages, t?.messages.length, readTs]);
  const scroller = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 400 && t?.hasMore && !t.loading) void loadTimeline(tkey, true);
  };
  const net = NETWORK_META[c.network].name;
  const open = kit.feed.notificationsUrl(c.network);
  return (
    <>
      <div class="feed-scroll" ref={scroller} onScroll={onScroll} data-feed-view={c.id}>
        <div class="feed-list">
          {cards.map((card) => (card.type === 'reply' || card.type === 'mention' || card.type === 'quote' ? <SaidCard key={card.key} card={card} kit={kit} /> : card.type === 'other' ? <OtherCard key={card.key} card={card} kit={kit} /> : <GroupCard key={card.key} card={card} kit={kit} />))}
          {t?.loading && <kit.Loading inline label="Loading notifications…" />}
          {!t?.loading && !cards.length && (
            <kit.Empty icon="bell" title="Nothing yet">
              When people like, repost, reply to or quote your posts on {net}, mention you or follow you, it shows here.
            </kit.Empty>
          )}
        </div>
      </div>
      <div class="feed-bar" role="note">
        <kit.Icon name="info" size={14} />
        <span>{kit.feed.feedBarLine(c.network)}</span>
        {open && (
          <a href={open} target="_blank" rel="noreferrer" class="feed-bar-open">
            Open on {net} <kit.Icon name="external" size={12} />
          </a>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ profiles

/** One of their posts: pinned, a repost, a reply or a quote says so; then its words, pictures, counts and when. */
function PostItem({ p, kit, owner, network }: { p: P.PostFact; kit: Kit; owner: string; network: P.Network }) {
  const shown = p.repostOf ?? p;
  const replyTo = shown.replyTo?.author ? kit.handle(shown.replyTo.author) : null;
  return (
    <article class="post-item opens" data-post={p.id} onClick={(e) => kit.feed.opensPost(e) && kit.openPost(network, shown.id)}>
      {p.pinned && (
        <span class="post-mark">
          <kit.Icon name="pin" size={11} /> Pinned
        </span>
      )}
      {p.repostOf && (
        <span class="post-mark">
          <kit.Icon name="repeat" size={11} /> {kit.name(owner)} reposted
        </span>
      )}
      <Byline p={shown} kit={kit} size={20} network={network} />
      {shown.replyTo && <span class="post-mark">Replying to {replyTo ? `@${replyTo}` : 'a post'}</span>}
      {shown.text && (
        <p class="post-text">
          <kit.Linked text={shown.text} network={network} />
        </p>
      )}
      <Pictures media={shown.media} url={kit.feed.postHref(network, shown.id)} />
      {shown.quoteOf && <Quoted p={shown.quoteOf} kit={kit} network={network} />}
      <div class="post-foot">
        <Counts p={shown} kit={kit} />
        <a class="post-open" href={shown.url} target="_blank" rel="noreferrer">
          <kit.Icon name="external" size={12} /> Open
        </a>
      </div>
    </article>
  );
}

/** Each X account's recent posts, as its profile said them, newest first after a pinned one. */
export function RecentPosts({ abouts, kit }: { abouts: P.PersonAboutView[]; kit: Kit }) {
  return (
    <div class="post-list">
      {abouts.map((a) => (
        <>
          {abouts.length > 1 && <span class="post-mark">@{kit.handle(a.identityId) ?? kit.name(a.identityId)}</span>}
          {a.posts!.map((p) => (
            <PostItem p={p} kit={kit} owner={a.identityId} network={a.network} />
          ))}
        </>
      ))}
    </div>
  );
}

