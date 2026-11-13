/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A network's notifications drawn by post (docs/feed.md "The feed's page"), and a person's recent posts: the chunk
 * lazy.tsx loads.
 *
 * Each post of yours that something happened to is one card: the post, small (you know it), then what people said
 * under it in full (replies, quotes), then who liked or reposted it as one quiet line that opens the list. A mention,
 * or a reply the feed has no post of yours for, is their post on its own; follows are a row of faces. "Replies and
 * mentions" leaves out likes, reposts and follows altogether. Nothing here writes to the network: a quiet bar says
 * where answering happens, with a link there.
 */
// Classic JSX (the pragmas above): preact's own `h`, so this chunk needs no jsx-runtime chunk split off the app's start.
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FeedFilter, FeedTalk, FeedUnit } from '../../feed.ts';
import { api, db, loadTimeline, markRead, openProfile, timelineKey, timelines } from '../../state.ts';
import { timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import { Row } from './Post.tsx';
import './feed.css';

export { PostsList, ThreadView } from './Thread.tsx';

type PostUnit = Extract<FeedUnit, { kind: 'post' }>;
/** Under a post, at most this many of what people said before "N more". */
const TALK_SHOWN = 3;
/** At most this many faces on a line. */
const FACES = 4;
const FILTER_KEY = 'dither.feed.filter';

function readFilter(): FeedFilter {
  try {
    return localStorage.getItem(FILTER_KEY) === 'talk' ? 'talk' : 'all';
  } catch {
    return 'all';
  }
}

function Faces({ ids, kit, size = 20 }: { ids: string[]; kit: Kit; size?: number }) {
  return (
    <span class="feed-stack">
      {ids.slice(0, FACES).map((id) => (
        <kit.Avatar id={id} name={kit.name(id)} url={kit.avatarUrl(id)} size={size} />
      ))}
    </span>
  );
}

/** Your post at the head of its card, small: who and when, its words clipped, its first picture; opens its thread. */
function Mine({ p, kit, network }: { p: P.PostFact; kit: Kit; network: P.Network }) {
  const who = p.author ?? null;
  const pic = p.media?.[0];
  return (
    <a class="feed-mine" href={kit.feed.postHref(network, p.id)} title="Open the thread" onClick={(e) => e.stopPropagation()}>
      <kit.Avatar id={who ?? p.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={22} />
      <span class="feed-mine-body">
        <span class="feed-mine-head">
          <b>{kit.isSelf(who) ? 'Your post' : kit.name(who)}</b>{' '}
          <span class="post-handle" title={kit.fullTime(p.ts)}>
            · {kit.ago(p.ts)}
          </span>
        </span>
        {p.text ? <span class="post-clip">{p.text}</span> : <span class="post-clip muted">{pic ? 'A picture' : 'A post'}</span>}
      </span>
      {pic && <img class="feed-mine-pic" src={pic.url} alt={pic.alt ?? ''} loading="lazy" />}
    </a>
  );
}

/** Someone's post that talks to you: theirs in full, opening its thread; the words alone when the network sent no post. */
function Talk({ t, kit, network, above, size }: { t: FeedTalk; kit: Kit; network: P.Network; above?: ComponentChildren; size?: number }) {
  const m = t.message;
  const p: P.PostFact = t.theirs ?? { id: '', url: m.feed?.url ?? '', ts: m.ts, text: m.body, ...(m.authorId ? { author: m.authorId } : {}) };
  const tag = t.fresh ? 'new' : t.type === 'quote' ? 'quoted' : undefined;
  if (!t.theirs) {
    return (
      <div class={`thread-post ${t.fresh ? 'fresh' : ''}`}>
        <button class="thread-face" onClick={() => openProfile(m.authorId)} aria-label={`${kit.name(m.authorId)}'s profile`}>
          <kit.Avatar id={m.authorId ?? m.id} name={kit.name(m.authorId)} url={kit.avatarUrl(m.authorId)} size={size ?? 30} />
        </button>
        <div class="thread-main">
          {above}
          <span class="thread-head">
            <b>{kit.name(m.authorId)}</b>
            <span class="post-handle">· {kit.ago(m.ts)}</span>
            {tag && <span class={`post-tag ${tag === 'new' ? 'new' : ''}`}>{tag}</span>}
          </span>
          <p class="post-text">
            <kit.Linked text={m.body} network={network} markdown={false} />
          </p>
        </div>
      </div>
    );
  }
  return <Row p={p} kit={kit} network={network} line={false} size={size ?? 30} tag={tag} fresh={t.fresh} above={above} />;
}

/** Who liked and reposted a post: every one the feeds named (the hub's list, not just the pages held), each opening their profile. */
function Reactors({ u, kit }: { u: PostUnit; kit: Kit }) {
  const [page, setPage] = useState<P.MessagePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<P.MessagePage>(`/api/posts/${u.network}/${u.post.id}/activity`).then(
      (p) => {
        p.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        setPage(p);
      },
      (e) => setError((e as Error).message),
    );
  }, [u.key]);
  const lists = useMemo(() => {
    const by = { like: [] as P.MessageView[], repost: [] as P.MessageView[] };
    const seen = new Set<string>();
    for (const m of page?.messages ?? []) {
      const ty = m.feed?.type;
      if ((ty === 'like' || ty === 'repost') && m.authorId && !seen.has(`${ty}:${m.authorId}`)) {
        seen.add(`${ty}:${m.authorId}`);
        by[ty].push(m);
      }
    }
    return by;
  }, [page]);
  const [tab, setTab] = useState<'like' | 'repost'>(u.reactors.like.length ? 'like' : 'repost');
  const counts = kit.feed.reactionCounts(u);
  const shown = lists[tab];
  const net = NETWORK_META[u.network].name;
  const unnamed = counts[tab] - shown.length;
  return (
    <div class="feed-reactors" role="region" aria-label="Who reacted">
      <div class="feed-reactors-tabs" role="tablist">
        {(['like', 'repost'] as const).map((k) => (
          <button role="tab" aria-selected={tab === k} class={`feed-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {k === 'like' ? 'Likes' : 'Reposts'} <span class="feed-tab-n">{kit.feed.shortCount(counts[k])}</span>
          </button>
        ))}
      </div>
      {!page && !error && <kit.Loading inline label="Reading who reacted…" />}
      {error && <p class="thread-none">{error}</p>}
      {page &&
        shown.map((m) => (
          <button class="feed-person" onClick={() => openProfile(m.authorId)}>
            <kit.Avatar id={m.authorId!} name={kit.name(m.authorId)} url={kit.avatarUrl(m.authorId)} size={28} />
            <span class="feed-person-who">
              <b>{kit.name(m.authorId)}</b>
              {kit.handle(m.authorId) && <span class="post-handle">@{kit.handle(m.authorId)}</span>}
            </span>
            <span class="post-handle" title={kit.fullTime(m.ts)}>
              {kit.ago(m.ts)}
            </span>
          </button>
        ))}
      {page && unnamed > 0 && (
        <p class="feed-reactors-note">
          {net} counts {counts[tab].toLocaleString()}; your notifications named {shown.length ? `these ${shown.length}` : 'none of them'}.
        </p>
      )}
    </div>
  );
}

/** One post of yours and what came of it. */
function PostCard({ u, kit, filter }: { u: PostUnit; kit: Kit; filter: FeedFilter }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const talk = all ? u.talk : u.talk.slice(0, TALK_SHOWN);
  const counts = kit.feed.reactionCounts(u);
  const reacted = u.reactors.like.length + u.reactors.repost.length > 0;
  const replies = counts.reply;
  const phrase = kit.feed.reactorsPhrase(u, kit.name);
  return (
    <article class={`feed-unit ${u.fresh ? 'fresh' : ''}`} data-unit="post" data-post={u.post.id}>
      <Mine p={u.post} kit={kit} network={u.network} />
      {talk.length > 0 && (
        <div class="feed-talk">
          {talk.map((t) => (
            <Talk t={t} kit={kit} network={u.network} />
          ))}
        </div>
      )}
      <div class="feed-unit-foot">
        {u.talk.length > TALK_SHOWN && (
          <button class="feed-link" onClick={() => setAll(!all)}>
            {all ? 'Fewer' : `${u.talk.length - TALK_SHOWN} more`}
          </button>
        )}
        {replies > 0 && (
          <a class="feed-link" href={kit.feed.postHref(u.network, u.post.id)}>
            The thread: {replies.toLocaleString()} {replies === 1 ? 'reply' : 'replies'} ›
          </a>
        )}
      </div>
      {filter === 'all' && reacted && (
        <>
          <button class="feed-react" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span class="feed-react-counts">
              {counts.like > 0 && (
                <span class="like">
                  <kit.Icon name="heart" size={13} /> {kit.feed.shortCount(counts.like)}
                </span>
              )}
              {counts.repost > 0 && (
                <span class="repost">
                  <kit.Icon name="repeat" size={13} /> {kit.feed.shortCount(counts.repost)}
                </span>
              )}
            </span>
            <span class="feed-react-who">{phrase}</span>
            <Faces ids={u.reactors.like.length ? u.reactors.like : u.reactors.repost} kit={kit} size={18} />
            <kit.Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
          </button>
          {open && <Reactors u={u} kit={kit} />}
        </>
      )}
    </article>
  );
}

const SAID: Record<FeedTalk['type'], (hasPost: boolean) => string> = {
  mention: () => 'mentioned you',
  reply: () => 'replied to you',
  quote: () => 'quoted you',
};

function Unit({ u, kit, filter }: { u: FeedUnit; kit: Kit; filter: FeedFilter }) {
  if (u.kind === 'post') return <PostCard u={u} kit={kit} filter={filter} />;
  if (u.kind === 'said')
    return (
      <article class={`feed-unit ${u.fresh ? 'fresh' : ''}`} data-unit="said">
        <Talk
          t={u.talk}
          kit={kit}
          network={u.network}
          size={36}
          above={
            <span class="post-mark">
              <kit.Icon name={u.talk.type === 'mention' ? 'at' : u.talk.type} size={11} /> {SAID[u.talk.type](false)}
            </span>
          }
        />
      </article>
    );
  if (u.kind === 'follow')
    return (
      <article class={`feed-unit feed-slim ${u.fresh ? 'fresh' : ''}`} data-unit="follow">
        <span class="feed-slim-icon">
          <kit.Icon name="userPlus" size={16} />
        </span>
        <span class="feed-stack">
          {u.actors.slice(0, 8).map((id) => (
            <button class="feed-face" onClick={() => openProfile(id)} title={kit.name(id)} aria-label={`${kit.name(id)}'s profile`}>
              <kit.Avatar id={id} name={kit.name(id)} url={kit.avatarUrl(id)} size={24} />
            </button>
          ))}
        </span>
        <span class="feed-slim-what">
          <b>{kit.feed.namesPhrase(u.actors.slice(0, 3).map(kit.name), u.actors.length)}</b> followed you
        </span>
        <span class="feed-when" title={kit.fullTime(u.ts)}>
          {kit.ago(u.ts)}
        </span>
      </article>
    );
  return (
    <article class={`feed-unit feed-slim ${u.fresh ? 'fresh' : ''}`} data-unit="other">
      <span class="feed-slim-icon">
        <kit.Icon name="bell" size={16} />
      </span>
      <span class="feed-slim-what">
        {u.text}
        {u.post?.text && <span class="muted"> · “{kit.feed.clip(u.post.text, 60)}”</span>}
      </span>
      <span class="feed-when" title={kit.fullTime(u.ts)}>
        {kit.ago(u.ts)}
      </span>
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
  const [filter, setFilter] = useState<FeedFilter>(readFilter);
  const pick = (f: FeedFilter) => {
    setFilter(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* a private window: the choice lasts while the page is open */
    }
  };
  const units = useMemo(() => kit.feed.feedUnits(t?.messages ?? [], readTs, filter), [t?.messages, t?.messages.length, readTs, filter]);
  const freshTalk = useMemo(() => kit.feed.feedUnits(t?.messages ?? [], readTs, 'talk').reduce((n, u) => n + (u.kind === 'post' ? u.talk.filter((x) => x.fresh).length : u.fresh ? 1 : 0), 0), [t?.messages, t?.messages.length, readTs]);
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
          <div class="feed-filter" role="tablist" aria-label="Show">
            <button role="tab" aria-selected={filter === 'all'} class={`feed-tab ${filter === 'all' ? 'on' : ''}`} onClick={() => pick('all')}>
              Everything
            </button>
            <button role="tab" aria-selected={filter === 'talk'} class={`feed-tab ${filter === 'talk' ? 'on' : ''}`} onClick={() => pick('talk')} title="Leave out likes, reposts and follows">
              Replies and mentions {freshTalk > 0 && <span class="feed-tab-n">{freshTalk}</span>}
            </button>
          </div>
          {units.map((u) => (
            <Unit key={u.key} u={u} kit={kit} filter={filter} />
          ))}
          {t?.loading && <kit.Loading inline label="Loading notifications…" />}
          {!t?.loading && !units.length && (
            <kit.Empty icon="bell" title={filter === 'talk' ? 'Nobody has said anything yet' : 'Nothing yet'}>
              {filter === 'talk' ? `When people reply to, quote or mention you on ${net}, it shows here.` : `When people like, repost, reply to or quote your posts on ${net}, mention you or follow you, it shows here.`}
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

/** Each X account's recent posts, as its profile said them, newest first after a pinned one: posts as a thread draws them. */
export function RecentPosts({ abouts, kit }: { abouts: P.PersonAboutView[]; kit: Kit }) {
  return (
    <div class="post-list">
      {abouts.map((a) => (
        <>
          {abouts.length > 1 && <span class="post-mark">@{kit.handle(a.identityId) ?? kit.name(a.identityId)}</span>}
          {a.posts!.map((p) => {
            const shown = p.repostOf ?? p;
            const replyTo = shown.replyTo?.author ? kit.handle(shown.replyTo.author) : null;
            const marks = (p.pinned || shown.replyTo) && (
              <>
                {p.pinned && (
                  <span class="post-mark">
                    <kit.Icon name="pin" size={11} /> Pinned
                  </span>
                )}
                {shown.replyTo && <span class="post-mark">Replying to {replyTo ? `@${replyTo}` : 'a post'}</span>}
              </>
            );
            return (
              <div class="post-item" data-post={p.id}>
                <Row p={p} kit={kit} network={a.network} line={false} size={28} above={marks || undefined} />
              </div>
            );
          })}
        </>
      ))}
    </div>
  );
}
