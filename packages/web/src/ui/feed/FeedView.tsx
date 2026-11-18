/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A network's notifications drawn by post (docs/feed.md "The feed's page"), and a person's recent posts: the chunk
 * lazy.tsx loads.
 *
 * Each post of yours that something happened to is one card: the post, small (you know it), then what people said
 * under it in full (replies, quotes), then who liked or reposted it as one quiet line that opens the list. A mention,
 * or a reply the feed has no post of yours for, is their post on its own; follows are a row of faces. Nothing here
 * writes to the network: a quiet bar says where answering happens, with a link there.
 */
// Classic JSX (the pragmas above): preact's own `h`, so this chunk needs no jsx-runtime chunk split off the app's start.
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { loadTimeline, markRead, timelineKey, timelines } from '../../state.ts';
import { timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import { Row } from './Post.tsx';
import { Unit } from './Units.tsx';
import './feed.css';

export { PostsList, ThreadView } from './Thread.tsx';
export { FeedPane, FeedSidebar } from './FeedPage.tsx';
export { FollowChat } from './FollowChat.tsx';

/** The feed below its header. Read on the hub as it shows (the network is told nothing); older pages as it scrolls. */
export function FeedView({ c, kit }: { c: P.ConversationView; kit: Kit }) {
  const tkey = timelineKey('c', c.id);
  // A message patched in place (an edit, a delete) keeps the array and its length: the revision tells.
  const rev = timelineRev(tkey).value;
  useEffect(() => void loadTimeline(tkey), [tkey]);
  const t = timelines.get(tkey);
  // What was new when it opened stays marked while it is open.
  const readTs = useMemo(() => Math.min(...c.vantages.map((v) => v.lastReadTs ?? 0)), [c.id]);
  const unread = c.vantages.some((v) => v.unread > 0);
  useEffect(() => {
    if (unread && document.visibilityState === 'visible') markRead(c.id);
  }, [c.id, unread, t?.messages.length]);
  const units = useMemo(() => kit.feed.feedUnits(t?.messages ?? [], readTs), [t?.messages, rev, readTs]);
  const scroller = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 400 && t?.hasMore && !t.loading) void loadTimeline(tkey, true);
  };
  // A page of likes on two posts is two cards: older pages load until the list fills the pane or there are no more,
  // so scrolling is never what finds them.
  useEffect(() => {
    const el = scroller.current;
    if (el && t?.hasMore && !t.loading && el.scrollHeight <= el.clientHeight + 400) void loadTimeline(tkey, true);
  }, [units.length, t?.hasMore, t?.loading]);
  const net = NETWORK_META[c.network].name;
  const open = kit.feed.notificationsUrl(c.network);
  return (
    <>
      <div class="feed-scroll" ref={scroller} onScroll={onScroll} data-feed-view={c.id}>
        <div class="feed-list">
          {units.map((u) => (
            <Unit key={u.key} u={u} kit={kit} />
          ))}
          {t?.loading && <kit.Loading inline label="Loading notifications…" />}
          {!t?.loading && !t?.hasMore && !units.length && (
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
