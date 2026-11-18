/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post's thread (docs/feed.md "Threads"), in the feed's chunk: what it answers above it, joined by a line, the post
 * itself large, then its replies as a comment section (Comments.tsx: a tree as on Reddit, compact, flat or X's
 * chains), "N more replies" under a reply to open that branch, and "Show more replies" while the network has more.
 * The hub logs each post as it reads it, and brings back the branches logged before.
 *
 * Read ahead: a reply's hidden answers are read as they come within two screens or so (AUTO_BRANCHES at most per
 * thread, two at a time; each is a call to the network), and the next page of replies as the end nears; what is read
 * waits behind its button, which says so (a dot: hollow not read, pulsing being read, filled read and shown at once),
 * so nothing moves under the reader and a press shows it without waiting.
 *
 * The way back: a thread opened from inside another (a reply's time, "Continue this thread", a post above) remembers
 * the one it came from (`trail`), which is named under the header ("Back to Maya's post") and is where Back goes; it
 * comes back as it was left, where it was scrolled to, the reply that was opened lit for a moment.
 *
 * Also the posts conversation itself (variant 'posts'): what the hub logged, newest first, each opening its thread.
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, db, loadTimeline, openProfile, timelineKey, timelines } from '../../state.ts';
import { timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import { PostActions, type AnswerCtx } from './Actions.tsx';
import { Comments, COMMENT_STYLES, StyleMenu, type CommentStyle } from './Comments.tsx';
import { PostComposer } from './Composer.tsx';
import { Counts, Pics, QuotedIn, Row, Text, Who } from './Post.tsx';
import { flip, snap } from './Seg.tsx';
import { heldThread, readThread, seedPost } from './threadcache.ts';
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

/** "4 more replies": a page read ahead, by the posts it holds. */
const shortMore = (v: P.PostThreadView) => {
  const n = v.replies.flat().length;
  return n ? `${n} more ${n === 1 ? 'reply' : 'replies'}` : 'more replies';
};

/** Hidden answers loaded without a press, per thread opened, and how many at once. */
const AUTO_BRANCHES = 24;
const AUTO_AT_ONCE = 2;
/** Pages of replies read ahead without a press. */
const AUTO_PAGES = 8;

/** A thread as it was left: what was read and opened, and where it was scrolled to. */
interface Kept {
  t: P.PostThreadView;
  extra: P.PostView[];
  done: ReadonlySet<string>;
  folded: ReadonlySet<string>;
  mine: P.PostView[];
  acted: ReadonlyMap<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>;
  scrollTop: number;
}
/** A thread left for another opened from inside it: where Back goes. */
interface Crumb {
  key: string;
  network: P.Network;
  post: string;
  /** "Maya's post", "your post". */
  label: string;
  /** The post opened from it, lit on coming back. */
  went: string;
  kept: Kept;
}
/** The threads behind the one shown, newest last; and the one being left, until the next thread takes it. */
const trail: Crumb[] = [];
let leaving: { crumb: Crumb; at: number } | null = null;

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
      {/* No Reply in its bar: the box under it is where a reply is written. */}
      <PostActions p={shown} ctx={{ ...answer, onReply: undefined }} big />
      {children}
    </article>
  );
}

/** A post's thread, as a pane: read from the hub (which asks the network and logs it), more replies on asking. */
export function ThreadView({ src, kit: base, onBack }: { src: Src; kit: Kit; onBack?: () => void }) {
  const key = 'message' in src ? src.message : `${src.network}:${src.post}`;
  // How this thread was come to: back to one left (as it was), from another (which Back returns to), or afresh.
  const [arrival] = useState(() => {
    const top = trail[trail.length - 1];
    if (top && top.key === key) {
      trail.pop();
      leaving = null;
      return { kept: top.kept as Kept | null, went: top.went, parent: trail[trail.length - 1] ?? null };
    }
    if (leaving && Date.now() - leaving.at < 5000 && leaving.crumb.key !== key) trail.push(leaving.crumb);
    else trail.length = 0;
    leaving = null;
    return { kept: null as Kept | null, went: null as string | null, parent: trail[trail.length - 1] ?? null };
  });
  const parent = arrival.parent;
  // Back to it as it was left, or read ahead from the page (threadcache.ts): drawn with its replies from the first frame.
  const [t, setT] = useState<P.PostThreadView | null>(() => arrival.kept?.t ?? ('network' in src ? heldThread(src.network, src.post) : null));
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | string>('idle');
  // Read ahead and not shown yet: the next page of replies, and the answers under replies (by reply).
  const [nextPage, setNextPage] = useState<P.PostThreadView | null>(null);
  const [ready, setReady] = useState<ReadonlyMap<string, P.PostView[]>>(new Map());
  const wantMore = useRef(false);
  const [asking, setAsking] = useState(false);
  const want = useRef(new Set<string>());
  // Branches opened under replies (their threads' replies), folded replies, and the reader's style.
  const [extra, setExtra] = useState<P.PostView[]>(() => arrival.kept?.extra ?? []);
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<ReadonlySet<string>>(() => arrival.kept?.done ?? new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => arrival.kept?.folded ?? new Set());
  const [style, setStyle] = useState<CommentStyle>(readStyle);
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  // Answering: the post a reply or quote is being written to, and what you posted here (first in the tree).
  const [answering, setAnswering] = useState<{ mode: 'reply' | 'quote'; post: P.PostFact } | null>(null);
  const [mine, setMine] = useState<P.PostView[]>(() => arrival.kept?.mine ?? []);
  const [acted, setActed] = useState<ReadonlyMap<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>>(() => arrival.kept?.acted ?? new Map());
  // Checking the network for new replies, and those it brought (marked new).
  const [checking, setChecking] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // The post itself, from the page that opened it, shown before its thread comes.
  const seed = 'network' in src ? seedPost(src.network, src.post) : null;
  const scroller = useRef<HTMLDivElement>(null);
  // Pages and branches read ahead so far.
  const autoPages = useRef(0);
  const autoBudget = useRef(AUTO_BRANCHES);
  const queue = useRef<TreeNode[]>([]);
  const running = useRef(0);
  // The states above start as this thread's: back to it as it was left, or afresh. Only another thread in the same
  // pane (not keyed by its post) needs them set again here; set at the first draw, they would undo a press made before
  // this runs (a like on the post drawn from the first frame).
  const first = useRef(true);
  useEffect(() => {
    const again = !first.current;
    first.current = false;
    // Back to a thread as it was left: nothing asked again.
    if (arrival.kept && !again) return;
    let live = true;
    if (again) {
      setError(null);
      setMore('idle');
      setExtra([]);
      setLoading(new Set());
      setDone(new Set());
      setFolded(new Set());
      setAnswering(null);
      setMine([]);
      setActed(new Map());
      setFresh(new Set());
    }
    // Read ahead from the page (threadcache.ts): shown at once.
    const had = 'network' in src ? heldThread(src.network, src.post) : null;
    if (had) {
      setT(had);
      return;
    }
    if (again) setT(null);
    ('message' in src ? api<P.PostThreadView>(`/api/messages/${encodeURIComponent(src.message)}/thread`) : readThread(src.network, src.post)).then(
      (v) => {
        if (!live) return;
        v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        setT(v);
      },
      (e) => live && setError((e as Error).message),
    );
    return () => void (live = false);
  }, [key]);
  // The post itself in view, under what it answers; or, coming back, where it was, the reply opened lit.
  useLayoutEffect(() => {
    if (!t) return;
    const k = arrival.kept;
    if (k && scroller.current) {
      scroller.current.scrollTop = k.scrollTop;
      const lit = arrival.went ? scroller.current.querySelector(`[data-post="${CSS.escape(arrival.went)}"]`) : null;
      if (lit) {
        lit.classList.add('ct-lit');
        setTimeout(() => lit.classList.remove('ct-lit'), 2200);
      }
    } else if (t.ancestors.length) scroller.current?.querySelector('[data-focal]')?.scrollIntoView({ block: 'start' });
  }, [t?.post]);
  /** A page of replies put under the others (what is there already is not put twice). */
  const showPage = (v: P.PostThreadView) => {
    wantMore.current = false;
    setAsking(false);
    setNextPage(null);
    setT((t0) => {
      if (!t0) return t0;
      const seen = new Set(t0.replies.flat().map((p) => p.id));
      return { ...t0, replies: [...t0.replies, ...v.replies.filter((c) => !c.some((p) => seen.has(p.id)))], more: v.more };
    });
  };
  /** The next page of replies: shown (`show`), or read ahead and kept behind the button. */
  const loadMore = (show: boolean) => {
    if (!t?.more) return;
    if (nextPage) return void (show && showPage(nextPage));
    if (show) (wantMore.current = true), setAsking(true);
    if (more === 'loading') return;
    setMore('loading');
    api<P.PostThreadView>(`/api/posts/${t.network}/${t.post}/thread?cursor=${encodeURIComponent(t.more)}`).then(
      (v) => {
        v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        // A page with nothing not shown yet is put in at once: its cursor (none, at the end) takes the button away.
        const seen = new Set(t.replies.flat().map((p) => p.id));
        if (wantMore.current || !v.replies.flat().some((p) => !seen.has(p.id))) showPage(v);
        else setNextPage(v);
        setMore('idle');
      },
      (e) => (setMore((e as Error).message), setAsking(false)),
    );
  };
  const nodes = useMemo(() => {
    if (!t?.focal) return [];
    // Replies as X gave them (their counts newest), then what was logged before that they do not hold, then branches
    // opened: a later copy wins, so the freshest read of a post is the one kept.
    const given = t.replies.flat();
    const ids = new Set(given.map((p) => p.id));
    // Yours first, as Reddit puts what you just wrote at the top; then X's order, then what only the log holds.
    return replyTree((t.focal.repostOf ?? t.focal).id, [...mine, ...given, ...(t.logged ?? []).filter((p) => !ids.has(p.id)), ...extra]);
  }, [t, extra, mine]);
  const with_ = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  /** Answers read under a reply, put into the tree. */
  const showUnder = (id: string, got: P.PostView[]) => {
    want.current.delete(id);
    setReady((r) => {
      const next = new Map(r);
      next.delete(id);
      return next;
    });
    setExtra((e) => {
      const known = new Set([...(t?.replies.flat() ?? []), ...(t?.logged ?? []), ...e].map((p) => p.id));
      return [...e, ...got.filter((p) => !known.has(p.id))];
    });
    setDone((d) => with_(d, id, true));
  };
  /** "N more replies" pressed: shown at once if read ahead, when it comes if being read, else read now. */
  const openUnder = (n: TreeNode) => {
    const id = n.post.id;
    const had = ready.get(id);
    if (had) return showUnder(id, had);
    want.current.add(id);
    if (!loading.has(id)) void loadUnder(n);
  };
  /**
   * A reply's branch: its own thread's replies, read; shown if asked for, else kept behind its button (read ahead).
   * Done once read: asking again gives the same.
   */
  const loadUnder = (n: TreeNode): Promise<void> => {
    if (!t) return Promise.resolve();
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
    return api<P.PostThreadView>(`/api/posts/${t.network}/${id}/thread`).then(
      (v) => {
        if (v.stored) return fail(v.stored);
        v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
        const got = [...v.replies.flat(), ...(v.logged ?? [])];
        // Nothing X shows under it (what it counts and never shows stays hidden): no button that never ends.
        if (want.current.has(id) || !got.some((p) => p.replyTo?.id === id)) showUnder(id, got);
        else setReady((r) => new Map(r).set(id, got));
        setLoading((l) => with_(l, id, false));
      },
      (e) => fail((e as Error).message),
    );
  };
  /** A reply's hidden answers, near the screen: queued, two read at a time, while the thread's allowance lasts. */
  const pump = () => {
    while (running.current < AUTO_AT_ONCE && queue.current.length) {
      const n = queue.current.shift()!;
      running.current++;
      void loadUnder(n).finally(() => {
        running.current--;
        pump();
      });
    }
  };
  const auto = (n: TreeNode) => {
    if (autoBudget.current <= 0 || queue.current.some((x) => x.post.id === n.post.id)) return;
    autoBudget.current--;
    setLoading((l) => with_(l, n.post.id, true));
    queue.current.push(n);
    pump();
  };
  // The next page of replies read ahead, as the end of the list nears.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!t?.more || nextPage || more !== 'idle' || !el || autoPages.current >= AUTO_PAGES || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        autoPages.current++;
        loadMore(false);
      },
      { root: scroller.current, rootMargin: '0px 0px 2400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [t?.more, more, nextPage]);
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
    // Each reply slides from where it was to where the new style puts it.
    const before = snap(scroller.current);
    requestAnimationFrame(() => flip(scroller.current, before));
    setStyle(s);
    setFolded(new Set());
    try {
      localStorage.setItem(STYLE_KEY, s);
    } catch {
      /* a private window: the choice lasts while the page is open */
    }
  };
  /** Ask the network again for this thread's replies: what came that was not here is put in and marked new. */
  const check = () => {
    if (!t || checking) return;
    setChecking(true);
    // Known already: shown, logged, or read ahead behind a button (the next page, a branch).
    const had = new Set([...t.replies.flat(), ...(t.logged ?? []), ...extra, ...mine, ...(nextPage?.replies.flat() ?? []), ...[...ready.values()].flat()].map((p) => p.id));
    readThread(t.network, t.post, true).then(
      (v) => {
        setChecking(false);
        const got = [...v.replies.flat(), ...(v.logged ?? [])].filter((p) => !had.has(p.id) && p.id !== t.post);
        setFresh(new Set(got.map((p) => p.id)));
        // The new read's first page in place of the old one; pages read past it stay.
        setT((t0) => {
          if (!t0) return v;
          const ids = new Set(v.replies.flat().map((p) => p.id));
          return { ...v, replies: [...v.replies, ...t0.replies.filter((c) => !c.some((p) => ids.has(p.id)))], more: t0.more && v.more ? t0.more : v.more };
        });
        kit.toast({ title: got.length ? `${got.length} new ${got.length === 1 ? 'reply' : 'replies'}` : 'No new replies', body: '', kind: 'info' }, 2500);
      },
      (e) => {
        setChecking(false);
        kit.toast({ title: 'Could not check for replies', body: (e as Error).message, kind: 'error' });
      },
    );
  };
  const network = t?.network ?? ('network' in src ? src.network : 'x');
  const focalOf = t?.focal ? (t.focal.repostOf ?? t.focal) : null;
  const label = !focalOf ? 'the post' : base.isSelf(focalOf.author ?? null) ? 'your post' : `${base.name(focalOf.author ?? null)}'s post`;
  /** Leaving for another thread from inside this one: it is kept, to come back to. */
  const noteLeaving = (went: string) => {
    if (!t || went === t.post) return;
    leaving = {
      at: Date.now(),
      crumb: { key: `${t.network}:${t.post}`, network: t.network, post: t.post, label, went, kept: { t, extra, done, folded, mine, acted, scrollTop: scroller.current?.scrollTop ?? 0 } },
    };
  };
  const kit: Kit = useMemo(() => ({ ...base, openPost: (n: P.Network, id: string) => (noteLeaving(id), base.openPost(n, id)) }), [base, t, extra, done, folded, mine, acted, label]);
  const onLink = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = (e.target as Element | null)?.closest?.('a[href*="pst_"]')?.getAttribute('href');
    const at = href?.match(/(?:\/c\/|\/p\/)(pst_[^/?#]+)/)?.[1];
    const to = at ? base.feed.parsePostKey(decodeURIComponent(at)) : null;
    if (!to || !('post' in to)) return;
    // Opened where this page opens threads (beside the list on the Feed page), the way back kept.
    e.preventDefault();
    kit.openPost(to.network, to.post);
  };
  const back = parent ? () => base.backToPost(parent.network, parent.post) : onBack;
  const posted = (p: P.PostView, mode: 'reply' | 'quote') => {
    setAnswering(null);
    if (mode === 'reply' && p.replyTo) setMine((m) => [p, ...m]);
    kit.toast({ title: mode === 'quote' ? 'Quoted' : 'Replied', body: p.text.slice(0, 80), kind: 'info', action: () => kit.openPost(network, p.id), actionLabel: 'View' }, 4000);
  };
  const answer: AnswerCtx = {
    kit,
    network,
    ...(kit.account ? { account: kit.account } : {}),
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
  // The post: as the thread gave it, else as the page that opened it showed it.
  const shownFocal = focal ?? (t ? null : seed);
  const author = shownFocal ? ((shownFocal.repostOf ?? shownFocal).author ?? null) : null;
  // Every reply X counts under the post is shown: no "Show more replies" unless a page read ahead brought more.
  const counted = (shownFocal?.repostOf ?? shownFocal)?.counts?.replies;
  const allShown = counted !== undefined && nodes.length >= counted;
  return (
    <section class="pane feed-pane thread-pane" aria-label="Post" onClickCapture={onLink}>
      <header class="conv-head">
        {back && (
          <button class={`icon-btn back ${parent ? 'to-thread' : ''}`} data-track="pager: back button" onClick={back} aria-label={parent ? `Back to ${parent.label}` : 'Back'}>
            <kit.Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon">
          <kit.Icon name="quote" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>{!shownFocal ? 'Post' : kit.isSelf(author) ? 'Your post' : `${kit.name(author)}'s post`}</h2>
          <div class="conv-head-sub">
            <span class="muted-label">{t?.stored ? `As the hub logged it · ${net}` : `On ${net}`}</span>
          </div>
        </div>
        <kit.HeadOrb />
        {shownFocal && (
          <a class="icon-btn" href={(shownFocal.repostOf ?? shownFocal).url} target="_blank" rel="noreferrer" title={`Open on ${net}`} aria-label={`Open on ${net}`}>
            <kit.Icon name="external" size={16} />
          </a>
        )}
      </header>
      {parent && (
        <button class="thread-crumb" onClick={back} data-track="thread: back to the thread it came from">
          <kit.Icon name="back" size={14} /> Back to <b>{parent.label}</b>
        </button>
      )}
      <div class="feed-scroll thread-scroll" ref={scroller} data-thread={t?.post ?? ''}>
        <div class="feed-list thread-list">
          {!t && !error && !seed && <kit.Loading inline label={`Reading the thread from ${net}…`} />}
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
          {shownFocal && (t || !error) && (
            <>
              {t?.ancestors.map((p) => (
                <Row p={p} kit={kit} network={network} line />
              ))}
              <Focal p={shownFocal} kit={kit} network={network} joined={!!t?.ancestors.length} answer={answer}>
                {/* The reply box under the post, one line until used, as X shows it; a quote of the post opens in its place. */}
                {answering && answering.post.id === (shownFocal.repostOf ?? shownFocal).id && answering.mode === 'quote' ? (
                  <div key="quote">{composerFor(shownFocal.repostOf ?? shownFocal)}</div>
                ) : (
                  // Reply under the post opens this box (focused), rather than a second one.
                  <PostComposer
                    key="reply"
                    network={network}
                    target={{ replyTo: shownFocal.repostOf ?? shownFocal }}
                    kit={kit}
                    collapsed={!(answering && answering.post.id === (shownFocal.repostOf ?? shownFocal).id)}
                    autoFocus={!!(answering && answering.post.id === (shownFocal.repostOf ?? shownFocal).id)}
                    onCancel={answering ? () => setAnswering(null) : undefined}
                    onPosted={(made) => posted(made, 'reply')}
                  />
                )}
              </Focal>
              {!t && (
                // Shown from the page that opened it; the replies come under it.
                <p class="thread-coming" data-pre="loading" role="status">
                  <span class="pre-dot" aria-hidden="true" /> Reading the replies from {net}…
                </p>
              )}
              {t && (
                <div class="thread-replies-bar">
                  <h3 class="thread-replies-head">
                    Replies <span class="thread-replies-n">{treeSize(nodes)}</span>
                  </h3>
                  {!t.stored && (
                    <button class="icon-btn thread-check" data-busy={checking ? '' : undefined} onClick={check} disabled={checking} title="Check for new replies" aria-label="Check for new replies" data-track="thread: check for new replies">
                      <kit.Icon name="refresh" size={15} />
                    </button>
                  )}
                  {nodes.length > 0 && <StyleMenu style={style} pick={pickStyle} />}
                </div>
              )}
              {t && (
                <Comments
                  nodes={nodes}
                  style={style}
                  ctx={{ kit, network, op: author, folded, fold, loading, done, failed, ready, load: openUnder, auto, root: scroller, below, fresh }}
                />
              )}
              <div ref={end} class="thread-end" aria-hidden="true" />
              {t && !nodes.length && !t.more && <p class="thread-none">{t.stored ? 'No replies logged.' : 'No replies yet.'}</p>}
              {t?.more && (!allShown || nextPage) && (
                // Its dot says whether the page is read ahead: hollow not yet, pulsing being read, filled shows at once.
                <button class={`btn thread-more`} data-pre={nextPage ? 'ready' : more === 'loading' ? 'loading' : 'idle'} onClick={() => loadMore(true)} disabled={asking}>
                  <span class="pre-dot" aria-hidden="true" />
                  {asking ? 'Loading more replies…' : nextPage ? `Show ${shortMore(nextPage)}` : 'Show more replies'}
                  <span class="sr-only">{nextPage ? ', read already' : more === 'loading' ? ', being read' : ''}</span>
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
