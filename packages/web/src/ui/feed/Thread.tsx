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
 * Two ways to read it, the switch row under the header (docs/places.md "A thread as a chat or a tree"): Thread, the
 * tree in the reader's style, or Chat, every reply oldest first (Comments.tsx ChatReplies). Either way one box at the
 * bottom (Composer.tsx `docked`) answers the post, or the reply its Reply aimed it at, as the account its line names.
 *
 * Also the posts conversation itself (variant 'posts'): what the hub logged, newest first, each opening its thread.
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, db, loadTimeline, openProfile, rev, route, timelineKey, timelines } from '../../state.ts';
import { timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import type { PlaceTab } from '../bits.tsx';
import { PostActions, type AnswerCtx } from './Actions.tsx';
import { ChatReplies, Comments, COMMENT_STYLES, StyleMenu, type CommentStyle } from './Comments.tsx';
import { PostComposer } from './Composer.tsx';
import { FollowButton, followOf, setFollow } from './Follow.tsx';
import type { MenuEntry } from '../ContextMenu.tsx';
import { loadSources, sources } from './feedstate.ts';
import { Counts, Folded, Pics, Place, QuotedIn, Row, Text, Who } from './Post.tsx';
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

/** Chat or Thread (the switch row), kept on the device; a post's thread opens as a tree until you choose. */
type ThreadShow = 'chat' | 'thread';
const SHOW_KEY = 'dither.thread.show';
const AS_KEY = 'dither.thread.as.';
const readKey = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const keepKey = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* a private window: the choice lasts while the page is open */
  }
};
const SHOWS: PlaceTab<ThreadShow>[] = [
  { id: 'chat' as const, label: 'Chat', title: 'Every reply by time, oldest first' },
  { id: 'thread' as const, label: 'Thread', title: 'Each reply under the one it answers' },
];

/** Your accounts on a network that can post, for the line over the box. */
const postersOn = (network: P.Network) => (sources.value?.accounts ?? []).filter((a) => a.network === network && a.publish);

/** The account a thread's box posts as, on the line over it: fixed for one, a toggle for two, a menu for more (as a chat's "via"). */
function AsToken({ accs, value, pick, kit }: { accs: P.FeedAccountView[]; value: string; pick: (id: string) => void; kit: Kit }) {
  const name = (a: P.FeedAccountView) => (a.identityId && kit.handle(a.identityId) ? `@${kit.handle(a.identityId)}` : a.label);
  const face = (a: P.FeedAccountView) => <kit.Avatar id={a.identityId ?? a.accountId} name={kit.name(a.identityId)} url={kit.avatarUrl(a.identityId)} size={16} />;
  const cur = accs.find((a) => a.accountId === value) ?? accs[0];
  if (accs.length === 2) {
    const other = accs.find((a) => a !== cur)!;
    return (
      <button class="pair-token" data-track="thread box: post as" title={`Switch to ${name(other)}`} onClick={() => pick(other.accountId)}>
        {face(cur)}
        {name(cur)}
        <kit.Icon name="repeat" size={10} class="pair-token-hint" />
      </button>
    );
  }
  return (
    <kit.Menu
      up
      trigger={(toggle) => (
        <button class="pair-token" data-track="thread box: post as" title="Choose" onClick={toggle} aria-haspopup="menu">
          {face(cur)}
          {name(cur)}
          <kit.Icon name="chevronDown" size={10} class="pair-token-hint" />
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu pair-menu">
          {accs.map((a) => (
            <button class={`menu-item ${a === cur ? 'on' : ''}`} data-track="thread box: post as (choice)" onClick={() => (pick(a.accountId), close())}>
              {face(a)}
              {name(a)}
            </button>
          ))}
        </div>
      )}
    </kit.Menu>
  );
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

type MarkdownChunk = typeof import('../files/MarkdownView.tsx');
let markdown: MarkdownChunk | null = null;

/**
 * A long-form post's whole body (`article`: Substack, LessWrong), in place of its preview and cover. The renderer is the file
 * viewer's chunk, loaded the first time an article shows; until then, and if it fails, the post's preview.
 */
function Article({ p, kit, network }: { p: P.PostFact; kit: Kit; network: P.Network }) {
  const [m, setM] = useState<MarkdownChunk | null>(markdown);
  useEffect(() => {
    if (m) return;
    let live = true;
    import('../files/MarkdownView.tsx').then(
      (c) => live && setM((markdown = c)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!m) return <Text p={p} kit={kit} network={network} cls="thread-focal-text" />;
  return <m.MarkdownBody text={p.article!} cls="thread-article" />;
}

/** The post asked for, large: who, where, its title, its words (behind a content warning), pictures, the quote, its full time, counts, and Open on its network. */
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
      <Place p={shown} />
      {shown.title && <h2 class="post-title thread-focal-title">{shown.title}</h2>}
      <Folded warning={shown.warning} kit={kit}>
        {shown.article ? (
          // Its pictures are in it; the cover (media) is the post's picture for cards, usually its first one again.
          <Article p={shown} kit={kit} network={network} />
        ) : (
          <>
            <Text p={shown} kit={kit} network={network} cls="thread-focal-text" />
            <Pics media={shown.media} />
          </>
        )}
      </Folded>
      {shown.quoteOf && <QuotedIn p={shown.quoteOf} kit={kit} network={network} />}
      <div class="thread-focal-time">{kit.fullTime(shown.ts)}</div>
      <div class="thread-focal-foot">
        <Counts p={shown} kit={kit} big network={network} />
        {shown.url && (
          <a class="post-open" href={shown.url} target="_blank" rel="noreferrer">
            <kit.Icon name="external" size={12} /> Open on {NETWORK_META[network].name}
          </a>
        )}
      </div>
      {/* Reply here goes to the box at the bottom, aimed at the post. */}
      <PostActions p={shown} ctx={answer} big />
      {children}
    </article>
  );
}

/** A post's thread, as a pane: read from the hub (which asks the network and logs it), more replies on asking. */
export function ThreadView({ src, kit: base, onBack, top }: { src: Src; kit: Kit; onBack?: () => void; top?: preact.ComponentChildren }) {
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
  // Where the box at the bottom is aimed: a reply or a quote; none answers the post. And what you posted here (first in the tree).
  const [answering, setAnswering] = useState<{ mode: 'reply' | 'quote'; post: P.PostFact } | null>(null);
  // Chat or Thread, and your posts deleted here.
  const [show, setShow] = useState<ThreadShow>(() => (readKey(SHOW_KEY) === 'chat' ? 'chat' : 'thread'));
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const pane = useRef<HTMLElement>(null);
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
    return replyTree((t.focal.repostOf ?? t.focal).id, [...mine, ...given, ...(t.logged ?? []).filter((p) => !ids.has(p.id)), ...extra].filter((p) => !gone.has(p.id)));
  }, [t, extra, mine, gone]);
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
  // The account answering, liking and reposting here: the one picked on this network last, else the page's, else the first online.
  useEffect(() => void loadSources(), []);
  const posters = postersOn(network);
  const picked = readKey(AS_KEY + network);
  const as = (posters.find((a) => a.accountId === picked) ?? posters.find((a) => a.accountId === kit.account) ?? posters.find((a) => a.online) ?? posters[0])?.accountId ?? kit.account;
  const [, setPicked] = useState(0);
  const pickAs = (id: string) => (keepKey(AS_KEY + network, id), setPicked((n) => n + 1));
  const asAcc = posters.find((a) => a.accountId === as);
  /** The box at the bottom, focused, aimed at `p` (null: the post). */
  const aim = (a: { mode: 'reply' | 'quote'; post: P.PostFact } | null) => {
    setAnswering(a);
    setTimeout(() => pane.current?.querySelector<HTMLTextAreaElement>('.post-composer.docked .compose-text')?.focus({ preventScroll: true }));
  };
  // Escape takes the box's aim off before it leaves the page (the box's own Escape does the same from inside it).
  useLayoutEffect(() => {
    if (!answering) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setAnswering(null);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [!!answering]);
  const del = async (p: P.PostFact) => {
    try {
      await api(`/api/posts/${network}/${p.id}/delete`, { method: 'POST', body: as ? { account: as } : {} });
      kit.toast({ title: `Deleted from ${NETWORK_META[network].name}`, body: '', kind: 'info' }, 3000);
      if (focalOf && p.id === focalOf.id) back?.();
      else setGone((g) => with_(g, p.id, true));
    } catch (err) {
      kit.toast({ title: 'Could not delete it', body: (err as Error).message, kind: 'error' });
    }
  };
  const posted = (p: P.PostView, mode: 'reply' | 'quote') => {
    setAnswering(null);
    if (mode === 'reply' && p.replyTo) setMine((m) => [p, ...m]);
    // In the chat it is the newest: brought into view at the end.
    if (show === 'chat') setTimeout(() => scroller.current?.querySelector(`[data-post="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
    kit.toast({ title: mode === 'quote' ? 'Quoted' : 'Replied', body: p.text.slice(0, 80), kind: 'info', action: () => kit.openPost(network, p.id), actionLabel: 'View' }, 4000);
  };
  const answer: AnswerCtx = {
    kit,
    network,
    ...(as ? { account: as } : {}),
    onReply: (p) => aim(focalOf && p.id === focalOf.id ? null : { mode: 'reply', post: p }),
    onQuote: (p) => aim({ mode: 'quote', post: p }),
    acted,
    onActed: (id, st) => setActed((m) => new Map(m).set(id, st)),
    // Yours, from an account that can delete: Delete in its ⋯.
    ...(asAcc?.unpublish || posters.some((a) => a.unpublish) ? { onDelete: del } : {}),
  };
  const below = (p: P.PostFact) => <PostActions p={p} ctx={answer} />;
  const pickShow = (v: ThreadShow) => (keepKey(SHOW_KEY, v), setShow(v));
  const net = NETWORK_META[network].name;
  const focal = t?.focal;
  // The post: as the thread gave it, else as the page that opened it showed it.
  const shownFocal = focal ?? (t ? null : seed);
  const author = shownFocal ? ((shownFocal.repostOf ?? shownFocal).author ?? null) : null;
  // Every reply X counts under the post is shown: no "Show more replies" unless a page read ahead brought more.
  const counted = (shownFocal?.repostOf ?? shownFocal)?.counts?.replies;
  const allShown = counted !== undefined && nodes.length >= counted;
  const post = shownFocal ? (shownFocal.repostOf ?? shownFocal) : null;
  // The box's line: where it goes, and as whom (docs/chats.md "The message box's line").
  const aimedAt = answering?.post ?? post;
  const whom = aimedAt ? (kit.isSelf(aimedAt.author ?? null) ? 'yourself' : kit.name(aimedAt.author ?? null)) : '';
  const lead = (
    <span class="pair-lead-line">
      {answering?.mode === 'quote' ? 'Quote ' : 'Reply to '}
      <span class="pair-token fixed">{answering?.mode === 'quote' ? `${whom === 'yourself' ? 'your' : `${whom}'s`} post` : whom}</span>
      {` on ${net}`}
      {posters.length > 1 && as && (
        <>
          {' · as '}
          <AsToken accs={posters} value={as} pick={pickAs} kit={kit} />
        </>
      )}
    </span>
  );
  const ctx = { kit, network, op: author, folded, fold, loading, done, failed, ready, load: openUnder, auto, root: scroller, below, fresh, chat: show === 'chat' };
  return (
    <section class="pane feed-pane thread-pane" aria-label="Post" onClickCapture={onLink} ref={pane}>
      <PostHead t={t} kit={kit} network={network} author={author} shown={!!shownFocal} url={(shownFocal?.repostOf ?? shownFocal)?.url ?? null} back={back} parent={parent?.label ?? null} />
      {parent && (
        <button class="thread-crumb" onClick={back} data-track="thread: back to the thread it came from">
          <kit.Icon name="back" size={14} /> Back to <b>{parent.label}</b>
        </button>
      )}
      <kit.PlaceTabs tabs={SHOWS} value={show} onPick={pickShow} label="Show the replies" track="thread view" />
      <div class="feed-scroll thread-scroll" ref={scroller} data-thread={t?.post ?? ''}>
        <div class="feed-list thread-list">
          {top}
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
              <Focal p={shownFocal} kit={kit} network={network} joined={!!t?.ancestors.length} answer={answer} />
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
                  {nodes.length > 0 && show === 'thread' && <StyleMenu style={style} pick={pickStyle} />}
                </div>
              )}
              {t && post && (show === 'chat' ? <ChatReplies nodes={nodes} post={post} ctx={ctx} root={scroller} /> : <Comments nodes={nodes} style={style} ctx={ctx} />)}
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
      {/* One box, at the bottom as a chat's: the post, or the reply or quote it is aimed at. */}
      {post && t && !error && (
        <PostComposer
          network={network}
          target={answering ? (answering.mode === 'quote' ? { quote: answering.post } : { replyTo: answering.post }) : { replyTo: post }}
          kit={kit}
          {...(as ? { account: as } : {})}
          docked={{ lead, draft: post.id, media: !!asAcc?.media, ...(answering ? { onUnaim: () => setAnswering(null) } : {}) }}
          onPosted={(made) => posted(made, answering?.mode ?? 'reply')}
        />
      )}
    </section>
  );
}

/**
 * A post's head (PlaceHead.tsx, through `kit`): the author's picture with the network's badge, whose post and on which
 * network, Follow replies, the bell of a followed post's own conversation, Details, and ⋯ with the post on its network,
 * its link and following it. Reads `rev` itself: a follow's conversation comes and its rule changes while the thread
 * stays as it is.
 */
function PostHead({ t, kit, network, author, shown, url, back, parent }: { t: P.PostThreadView | null; kit: Kit; network: P.Network; author: string | null; shown: boolean; url: string | null; back?: () => void; parent: string | null }) {
  rev.value;
  const net = NETWORK_META[network].name;
  const follow = followOf(t);
  const followed = follow ? (db.conversations.get(follow.conversationId) ?? null) : null;
  const more = (): MenuEntry[] => [
    ...(url ? [{ label: `Open on ${net}`, icon: 'external', track: 'post: open on the network', run: () => void window.open(url, '_blank', 'noopener') }] : []),
    ...(url ? [{ label: 'Copy link to the post', icon: 'link', track: 'post: copy link', run: () => void kit.copy(url, 'Link copied') }] : []),
    ...(t?.focal && follow ? [follow.stopped === null ? { label: 'Stop following', icon: 'bellOff', track: 'post: stop following', run: () => void setFollow(t, true, kit) } : { label: 'Follow again', icon: 'bell', track: 'post: follow again', run: () => void setFollow(t, false, kit) }] : []),
  ];
  return (
    <kit.PlaceHead
      class="post-head"
      back={back}
      backLabel={parent ? `Back to ${parent}` : 'Back'}
      backClass={parent ? 'to-thread' : ''}
      tile={author ? <kit.Avatar id={author} name={kit.name(author)} url={kit.avatarUrl(author)} size={34} network={network} /> : <kit.Icon name="quote" size={18} />}
      onTile={author ? () => openProfile(author) : undefined}
      tileTitle={author ? `${kit.name(author)}'s profile` : undefined}
      name={!shown ? 'Post' : kit.isSelf(author) ? 'Your post' : `${kit.name(author)}'s post`}
      sub={<span class="muted-label">{t?.stored ? `As the hub logged it · ${net}` : `On ${net}`}</span>}
      extras={<FollowButton t={t} kit={kit} />}
      bell={followed ? { c: followed } : undefined}
      // The Feed page has no panel beside its list and thread (App.tsx).
      details={route.value.view !== 'feed'}
      more={more}
      menu={() => ({ items: more(), label: 'Post', track: 'post head menu' })}
    />
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
