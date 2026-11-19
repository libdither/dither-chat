/** @jsxRuntime classic */
/** @jsx h */
/**
 * The bell in a thread's head (docs/feed.md "Following a post"): Follow replies makes the post a chat in the inbox,
 * where the replies found from then on come unread; pressed again, the hub stops looking and the chat stays. A post
 * the hub stopped looking at after a quiet week says Follow again.
 */
import { h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, db, go, rev } from '../../state.ts';
import type { Kit } from './lazy.tsx';

export function FollowButton({ t, kit }: { t: P.PostThreadView | null; kit: Kit }) {
  rev.value;
  // What a press here answered, until the thread is another; then what devices heard since, through its chat.
  const [pressed, setPressed] = useState<P.PostFollow | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPressed(undefined), [t?.post]);
  if (!t?.focal) return null;
  const known = pressed ?? t.follow ?? null;
  const f = (known && db.conversations.get(known.conversationId)?.follow) ?? known;
  const on = !!f && f.stopped === null;
  const label = on ? 'Following replies' : f?.why === 'quiet' ? 'Follow again' : 'Follow replies';
  const title = on
    ? 'New replies come to your inbox. Press to stop.'
    : f?.why === 'quiet'
      ? 'No new replies in a week, so the hub stopped looking. Press to look again.'
      : 'New replies to this post come to your inbox';
  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const got = await api<P.PostFollow>(`/api/posts/${t.network}/${t.post}/follow`, { method: on ? 'DELETE' : 'PUT' });
      setPressed(got);
      if (on) kit.toast({ kind: 'info', title: 'Stopped following', body: 'No more replies come to your inbox. The chat stays.' });
      else {
        const name = db.conversations.get(got.conversationId)?.name ?? 'The post';
        kit.toast({ kind: 'info', title: 'New replies will come to your inbox', body: `${name}, in your inbox`, action: () => go({ view: 'inbox', conv: got.conversationId }), actionLabel: 'View' }, 6000);
      }
    } catch (e) {
      kit.toast({ kind: 'error', title: on ? 'Could not stop following' : 'Could not follow it', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button class={`icon-btn follow-btn ${on ? 'on' : ''}`} aria-pressed={on} aria-label={label} title={title} disabled={busy} onClick={press} data-track="thread: follow replies">
      <kit.Icon name={f && f.stopped !== null ? 'bellOff' : 'bell'} size={16} />
      <span class="follow-btn-label">{label}</span>
    </button>
  );
}
