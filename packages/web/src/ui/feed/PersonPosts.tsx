/** @jsxRuntime classic */
/** @jsx h */
/**
 * A person's Posts tab (docs/places.md "A person's networks"): what they posted in public, as the hub logged it
 * (GET /api/persons/:id/posts), newest first as on the Feed page, each drawn with the feed's own row. Older pages
 * load as it scrolls. A click opens the post's thread on top of this page; coming back, the list is where it was:
 * what was loaded and how far down, kept per person for the session.
 */
// Classic JSX (the pragmas above), as the rest of the feed chunk.
import { h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, db, openProfile } from '../../state.ts';
import type { Kit } from './lazy.tsx';
import { Row } from './Post.tsx';

/** A page this long: a screen and more of rows. */
const PAGE = 20;

interface Held {
  posts: P.PersonPostView[];
  before: string | null;
  hasMore: boolean;
  scrollTop: number;
}
/** Per person, this session: what was loaded and how far down (a thread opened from here comes back to it). */
const held = new Map<string, Held>();

const named = (v: P.PersonPostsPage) => v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));

/** What a row says over it when it was written to you. */
const TO_YOU: Record<NonNullable<P.PersonPostView['toYou']>, string> = { reply: 'Replied to your post', mention: 'Mentioned you', quote: 'Quoted your post' };

// redraws: what it draws is its own state, loaded here; the names and pictures in it come with each page (`named`).
export function PersonPosts({ person, kit }: { person: P.PersonView; kit: Kit }) {
  const [h0] = useState(() => held.get(person.id) ?? null);
  const [posts, setPosts] = useState<P.PersonPostView[]>(h0?.posts ?? []);
  const [before, setBefore] = useState<string | null>(h0?.before ?? null);
  const [hasMore, setHasMore] = useState(h0?.hasMore ?? false);
  const [loading, setLoading] = useState(!h0);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(h0?.scrollTop ?? 0);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  // Kept as it changes, so leaving for a thread keeps it.
  useEffect(() => void held.set(person.id, { posts, before, hasMore, scrollTop: scrollTop.current }), [posts, before, hasMore]);

  const fetchPage = (cursor: string | null) =>
    api<P.PersonPostsPage>(`/api/persons/${encodeURIComponent(person.id)}/posts?limit=${PAGE}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`).then((v) => {
      named(v);
      return v;
    });

  // The first page; coming back, the kept list at once and any newer ones put over it.
  useEffect(() => {
    fetchPage(null).then(
      (v) => {
        if (!live.current) return;
        setLoading(false);
        if (!h0) {
          setPosts(v.posts);
          setBefore(v.before);
          setHasMore(v.hasMore);
          return;
        }
        setPosts((was) => {
          const have = new Set(was.map((p) => p.messageId));
          const fresh = v.posts.filter((p) => !have.has(p.messageId) && p.ts > (was[0]?.ts ?? 0));
          return fresh.length ? [...fresh, ...was] : was;
        });
      },
      (e) => live.current && (setLoading(false), setError((e as Error).message)),
    );
  }, [person.id]);

  useLayoutEffect(() => {
    if (h0 && scroller.current) scroller.current.scrollTop = h0.scrollTop;
  }, []);

  const older = () => {
    if (loading || !hasMore || !before) return;
    setLoading(true);
    fetchPage(before).then(
      (v) => {
        if (!live.current) return;
        setLoading(false);
        setPosts((was) => {
          const have = new Set(was.map((p) => p.post.id));
          return [...was, ...v.posts.filter((p) => !have.has(p.post.id))];
        });
        setBefore(v.before);
        setHasMore(v.hasMore);
      },
      (e) => live.current && (setLoading(false), setError((e as Error).message)),
    );
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    scrollTop.current = el.scrollTop;
    const k = held.get(person.id);
    if (k) k.scrollTop = el.scrollTop;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) older();
  };
  // A page that does not fill the pane: the next, so scrolling is never what finds them.
  useEffect(() => {
    const el = scroller.current;
    if (el && hasMore && !loading && el.scrollHeight <= el.clientHeight + 400) older();
  }, [posts.length, hasMore, loading]);

  // The network after each name only when they post on several.
  const several = new Set(posts.map((v) => v.network)).size > 1;
  const profileOf = person.identityIds.find((id) => db.identities.has(id)) ?? null;
  return (
    <div class="feed-scroll person-posts" ref={scroller} onScroll={onScroll} data-person-posts={person.id}>
      <div class="feed-list thread-list">
        {posts.map((v) => (
          <div class="thread-chain" key={v.messageId} data-person-post={v.post.id}>
            <Row
              p={v.post}
              kit={kit}
              network={v.network}
              line={false}
              aside={several ? <span class="pp-net">{NETWORK_META[v.network].name}</span> : undefined}
              above={v.toYou ? <span class="post-mark pp-to-you">{TO_YOU[v.toYou]}</span> : undefined}
            />
          </div>
        ))}
        {loading && <kit.Loading inline label="Loading posts…" />}
        {error && !loading && (
          <kit.Empty icon="alert" title="Could not load their posts">
            {error}
          </kit.Empty>
        )}
        {!loading && !error && !posts.length && (
          <p class="pp-none" role="note">
            No post of {person.name}'s is logged yet: the hub keeps the posts you read.{' '}
            <button class="text-link" data-track="person posts profile" onClick={() => openProfile(profileOf)}>
              Open their profile
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
