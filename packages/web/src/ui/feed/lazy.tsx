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
import { db, go, isSelfIdentity, previousRoute, toast } from '../../state.ts';
import { Avatar, Empty, Linked } from '../bits.tsx';
import { useLongPress } from '../longpress.ts';
import { Sheet } from '../Sheet.tsx';
import { Icon } from '../icons.tsx';
import { HeadOrb } from '../Offline.tsx';
import { languageName, needsTranslation } from '@dither-chat/protocol';
import { Loading } from '../Loader.tsx';
import { phone } from '../../phone.ts';
import { uploadFile } from '../../upload.ts';
import { activityVerbs, clip, feedBarLine, feedUnits, namesPhrase, notificationsUrl, opensPost, parsePostKey, postHref, postKey, reactionCounts, reactorsPhrase, reactWords, shortCount } from '../../feed.ts';

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
  isSelf: (identityId: string | null | undefined) => !!identityId && isSelfIdentity(identityId),
  Avatar,
  Icon,
  Empty,
  Loading,
  Linked,
  /** The hub out of reach, on a phone page (Offline.tsx). */
  HeadOrb,
  /** A long press on a phone (Reactions.tsx), a sheet from the bottom, a toast: as the rest of the app has them. */
  useLongPress,
  Sheet,
  toast,
  /** The account answering, liking and reposting here (the Feed page's), else the hub picks the first that can. */
  account: undefined as string | undefined,
  /** A post's thread, beside the inbox (docs/feed.md "Threads"). */
  openPost: (network: P.Network, post: string) => go({ view: 'inbox', conv: postKey(network, post) }),
  /** Back to the post this thread was opened from: a step back through history when that is the entry before, so
   * the phone's back button and this agree; else opened afresh. */
  backToPost: (network: P.Network, post: string) => {
    const conv = postKey(network, post);
    const prev = previousRoute();
    if (prev?.view === 'inbox' && prev.conv === conv) history.back();
    else go({ view: 'inbox', conv });
  },
  /** feed.ts, which the row draws with too: imported by the chunk, rolldown would split it into a startup file. */
  feed: { activityVerbs, clip, feedBarLine, feedUnits, namesPhrase, notificationsUrl, reactionCounts, reactorsPhrase, reactWords, shortCount, opensPost, parsePostKey, postHref, postKey },
  /** A phone's layout, and a file sent to the hub (upload.ts): both in the app's start already. */
  phone,
  uploadFile,
  // Startup already has these (Settings → Translation): handed over, so the chunk does not split them out.
  translate: { needsTranslation, languageName },
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

/** A post's thread (docs/feed.md "Threads"), opened by its key (feed.ts postKey) where a conversation would be. */
export function ThreadLazy({ postKey: key, onBack }: { postKey: string; onBack?: () => void }) {
  const { m, failed } = useChunk(true);
  const src = parsePostKey(key);
  if (!src) return <Empty icon="alert" title="Not a post" />;
  // Keyed by the post: a late answer for one thread never lands in the next.
  if (m) return <m.ThreadView key={key} src={src} kit={kit} onBack={onBack} />;
  return <section class="pane">{failed ? <Empty icon="alert" title="Could not load the post">Check the connection to the hub, then try again.</Empty> : <Loading fill />}</section>;
}

/** A post you follow (variant 'follow', docs/feed.md "Following a post"): its thread, what came since it was read marked New. */
export function FollowChatLazy({ c, onBack }: { c: P.ConversationView; onBack?: () => void }) {
  const { m, failed } = useChunk(true);
  if (m) return <m.FollowChat c={c} kit={kit} onBack={onBack} />;
  return <section class="pane">{failed ? <Empty icon="alert" title="Could not load the post">Check the connection to the hub, then try again.</Empty> : <Loading fill />}</section>;
}

/** The posts the hub logged (variant 'posts'), newest first. */
export function PostsListLazy({ c }: { c: P.ConversationView }) {
  const { m, failed } = useChunk(true);
  if (m) return <m.PostsList c={c} kit={kit} />;
  return <div class="feed-scroll">{failed ? <Empty icon="alert" title="Could not load the posts">Check the connection to the hub, then try again.</Empty> : <Loading fill />}</div>;
}

/** Loads the Feed page's chunk ahead (a pointer over its rail button). */
export const preloadFeed = (): Promise<unknown> => load();

/** The Feed page's list of sources (docs/feed.md "The Feed page"). */
export function FeedSidebarLazy({ source }: { source?: string }) {
  const { m } = useChunk(true);
  if (m) return <m.FeedSidebar source={source} kit={kit} />;
  return <div class="sidebar-inner"><Loading fill /></div>;
}

/** The Feed page: a source's posts with the composer over them, and a post's thread beside them. */
export function FeedPaneLazy({ source, post, onBack }: { source?: string; post?: string; onBack?: () => void }) {
  const { m, failed } = useChunk(true);
  if (m) return <m.FeedPane source={source} post={post} kit={kit} onBack={onBack} />;
  return <section class="pane">{failed ? <Empty icon="alert" title="Could not load the Feed">Check the connection to the hub, then try again.</Empty> : <Loading fill />}</section>;
}
