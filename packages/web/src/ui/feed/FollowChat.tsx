/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post you follow, as a chat in the inbox (variant 'follow', docs/feed.md "Following a post"): the post's thread,
 * the same pane as anywhere, with the replies found since the chat was last read marked New while it is open. It is
 * read as it opens, like any chat. A reply found while it is open is offered with a button rather than put into the
 * thread under the reader; once the hub stopped looking, a note says so.
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { followedPostOf } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, markRead } from '../../state.ts';
import type { Kit } from './lazy.tsx';
import { freshReplies } from './fresh.ts';
import { forgetThread } from './threadcache.ts';
import { ThreadView } from './Thread.tsx';

/** Shown in the thread on the page now. */
const shown = (id: string) => !!document.querySelector(`.thread-pane [data-post="${CSS.escape(id)}"]`);
/** After the page has drawn what it has (two frames). */
const drawn = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export function FollowChat({ c, kit, onBack }: { c: P.ConversationView; kit: Kit; onBack?: () => void }) {
  const post = followedPostOf(c.nativeId);
  // Read again (a key of its own) when replies found while open are asked for.
  const [round, setRound] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const opened = useRef(false);
  // Read from the hub each time, never a copy read on this device before: the hub's checks found what is new since.
  useMemo(() => post && forgetThread(c.network, post), [c.id, round]);
  const unread = c.vantages.some((v) => v.unread > 0);
  // What is new since it was last read, asked before it is marked read; and again as more comes while it is open.
  useEffect(() => {
    if (!post) return;
    let live = true;
    api<P.PostFollow>(`/api/posts/${c.network}/${post}/follow`)
      .then(async (f) => {
        if (!live) return;
        const add = (f.fresh ?? []).filter((id) => !freshReplies.value.has(id));
        if (add.length) freshReplies.value = new Set([...freshReplies.value, ...add]);
        const first = !opened.current;
        opened.current = true;
        if (first || !add.length) return;
        // Found by a check while open: not in the thread shown. One the thread's own read found is there already.
        await drawn();
        const missing = add.filter((id) => !shown(id)).length;
        if (live && missing) setWaiting((n) => n + missing);
      })
      .catch(() => {})
      .finally(() => {
        if (live && document.visibilityState === 'visible') markRead(c.id);
      });
    return () => void (live = false);
  }, [c.id, unread]);
  // Marked while it is open, and no longer once it is left.
  useEffect(
    () => () => {
      opened.current = false;
      freshReplies.value = new Set();
    },
    [c.id],
  );
  if (!post) return <kit.Empty icon="alert" title="Not a post" />;
  const f = c.follow;
  const top = (
    <>
      {f?.stopped != null && (
        <p class="thread-stored follow-note" role="note">
          <kit.Icon name="bellOff" size={13} /> {f.why === 'quiet' ? 'No new replies in a week, so the hub stopped looking.' : 'You stopped following this post.'} What it found stays here.
        </p>
      )}
      {waiting > 0 && (
        <button class="btn follow-more" data-track="follow: show replies found while open" onClick={() => (setWaiting(0), setRound((r) => r + 1))}>
          <kit.Icon name="bell" size={14} /> Show {waiting} new {waiting === 1 ? 'reply' : 'replies'}
        </button>
      )}
    </>
  );
  return <ThreadView key={`${c.id}:${round}`} src={{ network: c.network, post }} kit={kit} onBack={onBack} top={top} />;
}
