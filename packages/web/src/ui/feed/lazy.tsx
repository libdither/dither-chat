/**
 * A network's notifications (docs/feed.md) as cards, and a person's recent posts on their profile: a chunk of its own,
 * loaded the first time either shows, as the calendar's chip is (ui/calendar/lazy.tsx). The chunk reads state.ts only:
 * what it draws with from the app's start (names, times, icons, pictures, feed.ts) comes in `kit`, so it splits
 * nothing out of the startup chunk (docs/perf.md).
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { fullTime, ago } from '../../format.ts';
import { authorName } from '../../model.ts';
import { db } from '../../state.ts';
import { Avatar, Empty } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import { Loading } from '../Loader.tsx';
import { cardSentence, clip, FEED_VERB, feedBarLine, feedCards, notificationsUrl, shortCount } from '../../feed.ts';

type Chunk = typeof import('./FeedView.tsx');
let chunk: Chunk | null = null;
let loading: Promise<Chunk> | null = null;

function load(): Promise<Chunk> {
  return (loading ??= import('./FeedView.tsx').then(
    (m) => (chunk = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** What the chunk draws with, from the app's start. */
export const kit = {
  name: authorName,
  handle: (identityId: string | null | undefined) => (identityId ? (db.identities.get(identityId)?.handle?.replace(/^@/, '') ?? null) : null),
  avatarUrl: (identityId: string | null | undefined) => (identityId ? (db.identities.get(identityId)?.avatar ?? null) : null),
  ago,
  fullTime,
  Avatar,
  Icon,
  Empty,
  Loading,
  /** feed.ts, which the row draws with too: imported by the chunk, rolldown would split it into a startup file. */
  feed: { cardSentence, clip, FEED_VERB, feedBarLine, feedCards, notificationsUrl, shortCount },
};
export type Kit = typeof kit;

function useChunk(want: boolean): { m: Chunk | null; failed: boolean } {
  const [m, setM] = useState(chunk);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (want && !m) load().then(setM, () => setFailed(true));
  }, [want]);
  return { m, failed };
}

/** The feed's page below its header: cards, newest first, and the bar that stands in for the composer. */
export function FeedViewLazy({ c }: { c: P.ConversationView }) {
  const { m, failed } = useChunk(true);
  if (m) return <m.FeedView c={c} kit={kit} />;
  return <div class="feed-scroll">{failed ? <Empty icon="alert" title="Could not load the notifications">Check the connection to the hub, then try again.</Empty> : <Loading fill />}</div>;
}

/** A person's recent posts (X), from what their profile said (`PersonAboutView.posts`). Nothing while there are none. */
export function RecentPostsLazy({ abouts }: { abouts: P.PersonAboutView[] }) {
  const with_ = abouts.filter((a) => a.posts?.length);
  const { m } = useChunk(with_.length > 0);
  if (!with_.length || !m) return null;
  return <m.RecentPosts abouts={with_} kit={kit} />;
}
