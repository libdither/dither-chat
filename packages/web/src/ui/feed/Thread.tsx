/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post's thread (docs/feed.md "Threads"), in the feed's chunk: what it answers above it, joined by a line, the post
 * itself large, then the replies, each a short chain, and "Show more replies" while the network has more. Every post
 * in it opens its own thread; Open on X is the one way out. The hub logs each post as it reads it.
 *
 * Also the posts conversation itself (variant 'posts'): what the hub logged, newest first, each opening its thread.
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, db, loadTimeline, openProfile, timelineKey, timelines } from '../../state.ts';
import { timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';

type Src = { network: P.Network; post: string } | { message: string };

/** One post's text with its links (and on X its @handles). */
function Text({ p, kit, network, cls }: { p: P.PostFact; kit: Kit; network: P.Network; cls: string }) {
  if (!p.text) return null;
  return (
    <p class={cls}>
      <kit.Linked text={p.text} network={network} markdown={false} />
    </p>
  );
}

/** Pictures in a thread: each opens the full picture. */
function Pics({ media }: { media?: P.PostMedia[] }) {
  const shown = (media ?? []).slice(0, 4);
  if (!shown.length) return null;
  return (
    <div class={`post-media n${shown.length}`}>
      {shown.map((m) => (
        <a class="post-pic" href={m.url} target="_blank" rel="noreferrer" title={m.alt || 'Open the picture'}>
          <img src={m.url} alt={m.alt ?? ''} loading="lazy" />
          {m.kind !== 'image' && <span class="post-pic-kind">{m.kind === 'gif' ? 'GIF' : '▶'}</span>}
        </a>
      ))}
    </div>
  );
}

function Counts({ p, kit, big }: { p: P.PostFact; kit: Kit; big?: boolean }) {
  const c = p.counts;
  if (!c) return null;
  const items: [number | undefined, string, string][] = [
    [c.replies, 'reply', 'replies'],
    [c.reposts, 'repost', 'reposts'],
    [c.quotes, 'quote', 'quotes'],
    [c.likes, 'like', 'likes'],
    [c.views, 'view', 'views'],
  ];
  const shown = items.filter(([n]) => n !== undefined && (big || n > 0));
  if (!shown.length) return null;
  return (
    <span class={`post-counts ${big ? 'big' : ''}`}>
      {shown.map(([n, one, many]) => (
        <span title={`${n!.toLocaleString()} ${n === 1 ? one : many}`}>
          <b>{kit.feed.shortCount(n!)}</b> {n === 1 ? one : many}
        </span>
      ))}
    </span>
  );
}

/** A quoted post inside one: its byline and words, opening its own thread. */
function QuotedIn({ p, kit, network }: { p: P.PostFact; kit: Kit; network: P.Network }) {
  const who = p.author ?? null;
  return (
    <a class="post-quoted thread-quoted" href={kit.feed.postHref(network, p.id)} onClick={(e) => e.stopPropagation()}>
      <span class="post-by">
        <kit.Avatar id={who ?? p.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={16} />
        <b>{kit.name(who)}</b>
        {kit.handle(who) && <span class="post-handle">@{kit.handle(who)}</span>}
        <span class="post-handle">· {kit.ago(p.ts)}</span>
      </span>
      {p.text && <span class="post-clip">{p.text}</span>}
      {p.media?.[0] && <img class="thread-quoted-pic" src={p.media[0].url} alt={p.media[0].alt ?? ''} loading="lazy" />}
    </a>
  );
}

/** Someone's name and handle, opening their profile. */
function Who({ id, kit }: { id: string | null; kit: Kit }) {
  const name = kit.name(id);
  return (
    <button class="post-who" onClick={(e) => (e.stopPropagation(), openProfile(id))} title={`${name}'s profile`}>
      <b>{name}</b>
      {kit.handle(id) && <span class="post-handle">@{kit.handle(id)}</span>}
    </button>
  );
}

/** A post in a thread, small: their picture on the left with the line down to the next, then who, when and what. */
function Row({ p, kit, network, line, focal }: { p: P.PostView; kit: Kit; network: P.Network; line: boolean; focal?: boolean }) {
  const shown = p.repostOf ?? p;
  const who = shown.author ?? null;
  const open = (e: MouseEvent) => {
    if (focal || !kit.feed.opensPost(e)) return;
    kit.openPost(network, shown.id);
  };
  return (
    <article class={`thread-post ${line ? 'line' : ''}`} data-post={shown.id} onClick={open} tabIndex={focal ? undefined : 0} onKeyDown={(e) => !focal && e.key === 'Enter' && e.target === e.currentTarget && kit.openPost(network, shown.id)}>
      <button class="thread-face" onClick={(e) => (e.stopPropagation(), openProfile(who))} aria-label={`${kit.name(who)}'s profile`}>
        <kit.Avatar id={who ?? shown.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={36} />
      </button>
      <div class="thread-main">
        {p.repostOf && (
          <span class="post-mark">
            <kit.Icon name="repeat" size={11} /> {kit.name(p.author ?? null)} reposted
          </span>
        )}
        <div class="thread-head">
          <Who id={who} kit={kit} />
          <span class="post-handle" title={kit.fullTime(shown.ts)}>
            · {kit.ago(shown.ts)}
          </span>
        </div>
        <Text p={shown} kit={kit} network={network} cls="post-text" />
        <Pics media={shown.media} />
        {shown.quoteOf && <QuotedIn p={shown.quoteOf} kit={kit} network={network} />}
        <Counts p={shown} kit={kit} />
      </div>
    </article>
  );
}

/** The post asked for, large: who, its words, pictures, the quote, its full time, counts, and Open on X. */
function Focal({ p, kit, network, joined }: { p: P.PostView; kit: Kit; network: P.Network; joined: boolean }) {
  const shown = p.repostOf ?? p;
  const who = shown.author ?? null;
  const replyTo = shown.replyTo?.author ? kit.handle(shown.replyTo.author) : null;
  return (
    <article class={`thread-focal ${joined ? 'joined' : ''}`} data-post={shown.id} data-focal>
      <div class="thread-focal-head">
        <button class="thread-face" onClick={() => openProfile(who)} aria-label={`${kit.name(who)}'s profile`}>
          <kit.Avatar id={who ?? shown.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={44} />
        </button>
        <Who id={who} kit={kit} />
      </div>
      {shown.replyTo && !joined && <span class="post-mark">Replying to {replyTo ? `@${replyTo}` : 'a post'}</span>}
      <Text p={shown} kit={kit} network={network} cls="thread-focal-text" />
      <Pics media={shown.media} />
      {shown.quoteOf && <QuotedIn p={shown.quoteOf} kit={kit} network={network} />}
      <div class="thread-focal-time">{kit.fullTime(shown.ts)}</div>
      <div class="thread-focal-foot">
        <Counts p={shown} kit={kit} big />
        <a class="post-open" href={shown.url} target="_blank" rel="noreferrer">
          <kit.Icon name="external" size={12} /> Open on {NETWORK_META[network].name}
        </a>
      </div>
    </article>
  );
}

/** A post's thread, as a pane: read from the hub (which asks the network and logs it), more replies on asking. */
export function ThreadView({ src, kit, onBack }: { src: Src; kit: Kit; onBack?: () => void }) {
  const [t, setT] = useState<P.PostThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | string>('idle');
  const key = 'message' in src ? src.message : `${src.network}:${src.post}`;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setT(null);
    setError(null);
    setMore('idle');
    api<P.PostThreadView>('message' in src ? `/api/messages/${encodeURIComponent(src.message)}/thread` : `/api/posts/${src.network}/${src.post}/thread`).then(
      (v) => {
        if (!live) return;
        v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        setT(v);
      },
      (e) => live && setError((e as Error).message),
    );
    return () => void (live = false);
  }, [key]);
  // The post itself in view, under what it answers.
  useEffect(() => {
    if (t?.ancestors.length) scroller.current?.querySelector('[data-focal]')?.scrollIntoView({ block: 'start' });
  }, [t?.post]);
  const loadMore = () => {
    if (!t?.more) return;
    setMore('loading');
    api<P.PostThreadView>(`/api/posts/${t.network}/${t.post}/thread?cursor=${encodeURIComponent(t.more)}`).then(
      (v) => {
        v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        const seen = new Set(t.replies.flat().map((p) => p.id));
        setT({ ...t, replies: [...t.replies, ...v.replies.filter((c) => !c.some((p) => seen.has(p.id)))], more: v.more });
        setMore('idle');
      },
      (e) => setMore((e as Error).message),
    );
  };
  const network = t?.network ?? ('network' in src ? src.network : 'x');
  const net = NETWORK_META[network].name;
  const focal = t?.focal;
  const author = focal ? ((focal.repostOf ?? focal).author ?? null) : null;
  return (
    <section class="pane feed-pane thread-pane" aria-label="Post">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <kit.Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon">
          <kit.Icon name="quote" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>{!focal ? 'Post' : kit.isSelf(author) ? 'Your post' : `${kit.name(author)}'s post`}</h2>
          <div class="conv-head-sub">
            <span class="muted-label">{t?.stored ? `As the hub logged it · ${net}` : `On ${net}`}</span>
          </div>
        </div>
        {focal && (
          <a class="icon-btn" href={(focal.repostOf ?? focal).url} target="_blank" rel="noreferrer" title={`Open on ${net}`} aria-label={`Open on ${net}`}>
            <kit.Icon name="external" size={16} />
          </a>
        )}
      </header>
      <div class="feed-scroll thread-scroll" ref={scroller} data-thread={t?.post ?? ''}>
        <div class="feed-list thread-list">
          {!t && !error && <kit.Loading inline label={`Reading the thread from ${net}…`} />}
          {error && (
            <kit.Empty icon="alert" title="Could not read this post">
              {error}
            </kit.Empty>
          )}
          {t?.stored && (
            <p class="thread-stored" role="note">
              <kit.Icon name="info" size={13} /> {t.stored} This is what the hub logged.
            </p>
          )}
          {t && !focal && !error && (
            <kit.Empty icon="quote" title="Not logged">
              The hub has not read this post yet, and could not ask {net} now.
            </kit.Empty>
          )}
          {t && focal && (
            <>
              {t.ancestors.map((p) => (
                <Row p={p} kit={kit} network={network} line />
              ))}
              <Focal p={focal} kit={kit} network={network} joined={t.ancestors.length > 0} />
              {t.replies.length > 0 && <h3 class="thread-replies-head">Replies</h3>}
              {t.replies.map((chain) => (
                <div class="thread-chain">
                  {chain.map((p, i) => (
                    <Row p={p} kit={kit} network={network} line={i < chain.length - 1} />
                  ))}
                </div>
              ))}
              {!t.replies.length && !t.more && <p class="thread-none">{t.stored ? 'No replies logged.' : 'No replies yet.'}</p>}
              {t.more && (
                <button class="btn thread-more" onClick={loadMore} disabled={more === 'loading'}>
                  {more === 'loading' ? 'Loading…' : 'Show more replies'}
                </button>
              )}
              {more !== 'idle' && more !== 'loading' && <p class="thread-none">{more}</p>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** The posts conversation (variant 'posts'): what the hub logged, newest first, each opening its thread. */
export function PostsList({ c, kit }: { c: P.ConversationView; kit: Kit }) {
  const tkey = timelineKey('c', c.id);
  timelineRev(tkey).value;
  useEffect(() => void loadTimeline(tkey), [tkey]);
  const tl = timelines.get(tkey);
  const posts = useMemo(() => [...(tl?.messages ?? [])].filter((m) => m.post && !m.deleted).sort((a, b) => b.ts - a.ts), [tl?.messages, tl?.messages.length]);
  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && tl?.hasMore && !tl.loading) void loadTimeline(tkey, true);
  };
  return (
    <div class="feed-scroll" onScroll={onScroll} data-posts-view={c.id}>
      <div class="feed-list thread-list">
        <p class="thread-stored" role="note">
          <kit.Icon name="info" size={13} /> Posts the hub logged as you read them on {NETWORK_META[c.network].name}: threads you opened and profiles' recent posts. Search finds them.
        </p>
        {posts.map((m) => (
          <div class="thread-chain">
            <Row p={{ ...m.post!, messageId: m.id }} kit={kit} network={c.network} line={false} />
          </div>
        ))}
        {tl?.loading && <kit.Loading inline label="Loading posts…" />}
        {!tl?.loading && !posts.length && (
          <kit.Empty icon="quote" title="Nothing logged yet">
            Open a post from the notifications or a profile, and it is kept here.
          </kit.Empty>
        )}
      </div>
    </div>
  );
}
