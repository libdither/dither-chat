/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post's thread (docs/feed.md "Threads"), in the feed's chunk: what it answers above it, joined by a line, the post
 * itself large, then its replies as a comment section (Comments.tsx: a tree as on Reddit, compact, flat or X's
 * chains), "N more replies" under a reply to open that branch, and "Show more replies" while the network has more.
 * The hub logs each post as it reads it, and brings back the branches logged before.
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
import { PostActions, type AnswerCtx } from './Actions.tsx';
import { Comments, COMMENT_STYLES, StyleMenu, type CommentStyle } from './Comments.tsx';
import { PostComposer } from './Composer.tsx';
import { Counts, Pics, QuotedIn, Row, Text, Who } from './Post.tsx';
import { replyTree, treeSize, type TreeNode } from './tree.ts';

const STYLE_KEY = 'dither.thread.style';
function readStyle(): CommentStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return COMMENT_STYLES.some((s) => s.id === v) ? (v as CommentStyle) : 'tree';
  } catch {
    return 'tree';
  }
}

type Src = { network: P.Network; post: string } | { message: string };

/** The post asked for, large: who, its words, pictures, the quote, its full time, counts, and Open on X. */
function Focal({ p, kit, network, joined, answer, children }: { p: P.PostView; kit: Kit; network: P.Network; joined: boolean; answer: AnswerCtx; children?: preact.ComponentChildren }) {
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
      <PostActions p={shown} ctx={answer} big />
      {children}
    </article>
  );
}

/** A post's thread, as a pane: read from the hub (which asks the network and logs it), more replies on asking. */
export function ThreadView({ src, kit, onBack }: { src: Src; kit: Kit; onBack?: () => void }) {
  const [t, setT] = useState<P.PostThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | string>('idle');
  const key = 'message' in src ? src.message : `${src.network}:${src.post}`;
  // Branches opened under replies (their threads' replies), folded replies, and the reader's style.
  const [extra, setExtra] = useState<P.PostView[]>([]);
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [style, setStyle] = useState<CommentStyle>(readStyle);
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  // Answering: the post a reply or quote is being written to, and what you posted here (first in the tree).
  const [answering, setAnswering] = useState<{ mode: 'reply' | 'quote'; post: P.PostFact } | null>(null);
  const [mine, setMine] = useState<P.PostView[]>([]);
  const [acted, setActed] = useState<ReadonlyMap<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>>(new Map());
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setT(null);
    setError(null);
    setMore('idle');
    setExtra([]);
    setLoading(new Set());
    setDone(new Set());
    setFolded(new Set());
    setAnswering(null);
    setMine([]);
    setActed(new Map());
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
  const nodes = useMemo(() => {
    if (!t?.focal) return [];
    // Replies as X gave them (their counts newest), then what was logged before that they do not hold, then branches
    // opened: a later copy wins, so the freshest read of a post is the one kept.
    const given = t.replies.flat();
    const ids = new Set(given.map((p) => p.id));
    // Yours first, as Reddit puts what you just wrote at the top.
    return replyTree((t.focal.repostOf ?? t.focal).id, [...mine, ...(t.logged ?? []).filter((p) => !ids.has(p.id)), ...given, ...extra]);
  }, [t, extra, mine]);
  const with_ = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  /** A reply's branch: its own thread's replies, put into the tree. */
  const loadUnder = (n: TreeNode) => {
    if (!t) return;
    const id = n.post.id;
    setLoading((l) => with_(l, id, true));
    setFailed((f) => {
      const next = new Map(f);
      next.delete(id);
      return next;
    });
    const fail = (why: string) => {
      // Kept: X may answer next time. Said, so the button does not just vanish.
      setFailed((f) => new Map(f).set(id, why));
      setLoading((l) => with_(l, id, false));
    };
    api<P.PostThreadView>(`/api/posts/${t.network}/${id}/thread`).then(
      (v) => {
        if (v.stored) return fail(v.stored);
        v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        const got = [...v.replies.flat(), ...(v.logged ?? [])];
        setExtra((e) => {
          const known = new Set([...t.replies.flat(), ...(t.logged ?? []), ...e].map((p) => p.id));
          return [...e, ...got.filter((p) => !known.has(p.id))];
        });
        // Nothing (more) under it on X: no button that never ends.
        const known = new Set(nodes.flatMap(function all(x: TreeNode): string[] {
          return [x.post.id, ...x.children.flatMap(all)];
        }));
        if (!got.some((p) => p.replyTo?.id === id && !known.has(p.id))) setDone((d) => with_(d, id, true));
        setLoading((l) => with_(l, id, false));
      },
      (e) => fail((e as Error).message),
    );
  };
  /** Fold or unfold a reply, keeping the keyboard where it was: on the control that now stands for it. */
  const fold = (id: string) => {
    const inside = !!document.activeElement?.closest(`[data-post="${CSS.escape(id)}"]`);
    setFolded((f) => with_(f, id, !f.has(id)));
    if (inside)
      setTimeout(() => {
        const node = scroller.current?.querySelector(`[data-post="${CSS.escape(id)}"]`);
        (node?.querySelector('.ct-unfold, .ct-toggle, .ct-rail, .ct-flat-toggle') as HTMLElement | null)?.focus();
      });
  };
  const pickStyle = (s: CommentStyle) => {
    setStyle(s);
    setFolded(new Set());
    try {
      localStorage.setItem(STYLE_KEY, s);
    } catch {
      /* a private window: the choice lasts while the page is open */
    }
  };
  const network = t?.network ?? ('network' in src ? src.network : 'x');
  const posted = (p: P.PostView, mode: 'reply' | 'quote') => {
    setAnswering(null);
    if (mode === 'reply' && p.replyTo) setMine((m) => [p, ...m]);
    kit.toast({ title: mode === 'quote' ? 'Quoted' : 'Replied', body: p.text.slice(0, 80), kind: 'info', action: () => kit.openPost(network, p.id), actionLabel: 'View' }, 4000);
  };
  const answer: AnswerCtx = {
    kit,
    network,
    onReply: (p) => setAnswering({ mode: 'reply', post: p }),
    onQuote: (p) => setAnswering({ mode: 'quote', post: p }),
    acted,
    onActed: (id, st) => setActed((m) => new Map(m).set(id, st)),
  };
  const composerFor = (p: P.PostFact) =>
    answering && answering.post.id === p.id ? (
      <PostComposer
        key={`${answering.mode}:${p.id}`}
        network={network}
        target={answering.mode === 'quote' ? { quote: p } : { replyTo: p }}
        kit={kit}
        autoFocus
        onCancel={() => setAnswering(null)}
        onPosted={(made) => posted(made, answering.mode)}
      />
    ) : null;
  const below = (p: P.PostFact) => (
    <>
      <PostActions p={p} ctx={answer} />
      {composerFor(p)}
    </>
  );
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
              <Focal p={focal} kit={kit} network={network} joined={t.ancestors.length > 0} answer={answer}>
                {/* The reply box under the post, one line until used, as X shows it; a quote of the post opens in its place. */}
                {answering && answering.post.id === (focal.repostOf ?? focal).id && answering.mode === 'quote' ? (
                  <div key="quote">{composerFor(focal.repostOf ?? focal)}</div>
                ) : (
                  // Reply under the post opens this box (focused), rather than a second one.
                  <PostComposer
                    key="reply"
                    network={network}
                    target={{ replyTo: focal.repostOf ?? focal }}
                    kit={kit}
                    collapsed={!(answering && answering.post.id === (focal.repostOf ?? focal).id)}
                    autoFocus={!!(answering && answering.post.id === (focal.repostOf ?? focal).id)}
                    onCancel={answering ? () => setAnswering(null) : undefined}
                    onPosted={(made) => posted(made, 'reply')}
                  />
                )}
              </Focal>
              {nodes.length > 0 && (
                <div class="thread-replies-bar">
                  <h3 class="thread-replies-head">
                    Replies <span class="thread-replies-n">{treeSize(nodes)}</span>
                  </h3>
                  <StyleMenu style={style} pick={pickStyle} kit={kit} />
                </div>
              )}
              <Comments
                nodes={nodes}
                style={style}
                ctx={{ kit, network, op: author, folded, fold, loading, done, failed, load: loadUnder, below }}
              />
              {!nodes.length && !t.more && <p class="thread-none">{t.stored ? 'No replies logged.' : 'No replies yet.'}</p>}
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
            <Row p={m.post!} kit={kit} network={c.network} line={false} />
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
