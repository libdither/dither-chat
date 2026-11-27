/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post's details panel (docs/feed.md "Threads"), opened by its head's Details where a chat's opens: the author (to
 * their profile), the post's counts, who liked and who reposted it (ReactorsList, opened from here), Open on the
 * network, and for a post you follow what the follow says (docs/feed.md "Following a post"): since when, the next
 * check, or that it stopped and why.
 *
 * `id`: the post's key (`pst_…`), or a followed post's conversation.
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { followedPostOf, NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { db, openProfile, rev } from '../../state.ts';
import type { Kit } from './lazy.tsx';
import { ReactorsList } from './Actions.tsx';
import { Counts } from './Post.tsx';
import { heldThread, readThread, seedPost } from './threadcache.ts';

/** The post a panel is about: by its key, or a followed post's conversation. */
function postOfPlace(id: string, kit: Kit): { network: P.Network; post: string; conv: P.ConversationView | null } | null {
  const src = kit.feed.parsePostKey(id);
  if (src && 'post' in src) return { network: src.network, post: src.post, conv: null };
  const c = db.conversations.get(id);
  const post = c?.variant === 'follow' ? followedPostOf(c.nativeId) : null;
  return c && post ? { network: c.network, post, conv: c } : null;
}

export function PostDetails({ id, kit }: { id: string; kit: Kit }) {
  rev.value; // the follow's state comes with its conversation
  const at = postOfPlace(id, kit);
  const [t, setT] = useState<P.PostThreadView | null>(() => (at ? heldThread(at.network, at.post) : null));
  const [list, setList] = useState<'like' | 'repost' | null>(null);
  useEffect(() => {
    if (!at) return;
    let live = true;
    setList(null);
    readThread(at.network, at.post).then(
      (v) => live && setT(v),
      () => {},
    );
    return () => void (live = false);
  }, [id]);
  if (!at) return null;
  const shown = t?.focal ?? seedPost(at.network, at.post);
  const p = shown ? (shown.repostOf ?? shown) : null;
  const author = p?.author ?? null;
  const net = NETWORK_META[at.network].name;
  const words = kit.feed.reactWords(at.network);
  const conv = at.conv ?? (t?.follow ? (db.conversations.get(t.follow.conversationId) ?? null) : null);
  const f = conv?.follow ?? t?.follow ?? null;
  const title = !p ? 'Post' : kit.isSelf(author) ? 'Your post' : `${kit.name(author)}'s post`;
  return (
    <aside class="details post-details">
      <header class="det-head">
        <span class="det-net">
          <kit.Avatar id={author ?? at.post} name={kit.name(author)} url={kit.avatarUrl(author)} size={28} network={at.network} />
        </span>
        <div>
          <h2>{title}</h2>
          <span class="det-kind">Post on {net}</span>
        </div>
        <kit.HeadOrb />
        <button class="icon-btn" onClick={() => kit.showDetails(false)} aria-label="Close details">
          <kit.Icon name="x" />
        </button>
      </header>
      <div class="det-scroll">
        {author && (
          <section class="det-section">
            <h3>Author</h3>
            <div class="members">
              <button class="member" onClick={() => openProfile(author)} data-track="post details: author">
                <kit.Avatar id={author} name={kit.name(author)} url={kit.avatarUrl(author)} size={28} />
                <span>
                  <b>{kit.name(author)}</b>
                  {kit.handle(author) && <small>@{kit.handle(author)}</small>}
                </span>
              </button>
            </div>
          </section>
        )}
        {p && (
          <section class="det-section">
            <h3>The post</h3>
            <dl class="kv">
              <dt>Posted</dt>
              <dd>{kit.fullTime(p.ts)}</dd>
            </dl>
            <Counts p={p} kit={kit} network={at.network} big />
            <div class="btn-row post-details-lists">
              <button class={`btn ghost small ${list === 'like' ? 'on' : ''}`} aria-pressed={list === 'like'} data-track="post details: who liked" onClick={() => setList(list === 'like' ? null : 'like')}>
                <kit.Icon name={words.likeIcon} size={13} /> {words.likedBy}
              </button>
              <button class={`btn ghost small ${list === 'repost' ? 'on' : ''}`} aria-pressed={list === 'repost'} data-track="post details: who reposted" onClick={() => setList(list === 'repost' ? null : 'repost')}>
                <kit.Icon name="repeat" size={13} /> {words.repostedBy}
              </button>
            </div>
            {list && <ReactorsList key={list} network={at.network} post={p.id} kind={list} kit={kit} count={list === 'like' ? p.counts?.likes : p.counts?.reposts} compact />}
            {p.url && (
              <a class="btn ghost small" href={p.url} target="_blank" rel="noreferrer" data-track="post details: open on the network">
                <kit.Icon name="external" size={13} /> Open on {net}
              </a>
            )}
          </section>
        )}
        {f && (
          <section class="det-section post-details-follow">
            <h3>Following replies</h3>
            <dl class="kv">
              <dt>Since</dt>
              <dd>{kit.fullTime(f.since)}</dd>
              {f.stopped === null ? (
                <>
                  {f.checked !== null && (
                    <>
                      <dt>Last checked</dt>
                      <dd>{kit.ago(f.checked)} ago</dd>
                    </>
                  )}
                  <dt>Next check</dt>
                  <dd>{f.next !== null ? kit.fullTime(f.next) : 'When the account is online'}</dd>
                </>
              ) : (
                <>
                  <dt>Stopped</dt>
                  <dd>
                    {kit.fullTime(f.stopped)}: {f.why === 'quiet' ? 'no new replies in a week' : 'you stopped following it'}
                  </dd>
                </>
              )}
            </dl>
          </section>
        )}
      </div>
    </aside>
  );
}
