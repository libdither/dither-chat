/**
 * Events (docs/events.md) on the Feed page: their card and page are a chunk of their own, loaded the first time a feed
 * holds an event, so the Feed page's chunk carries none of it for people with no event site.
 */
import type * as P from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Kit } from '../feed/lazy.tsx';

type Chunk = typeof import('./Event.tsx');
let chunk: Chunk | null = null;
let loading: Promise<Chunk> | null = null;

function load(): Promise<Chunk> {
  return (loading ??= import('./Event.tsx').then(
    (m) => (chunk = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

function useChunk(): { m: Chunk | null; failed: boolean } {
  const [m, setM] = useState(chunk);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!m) load().then(setM, () => setFailed(true));
  }, []);
  return { m, failed };
}

/** An event in a feed; until its chunk comes, a plain row with its title, so the list keeps its place. */
export function EventCardLazy(props: { e: P.FeedEntryView; kit: Kit; reason?: ComponentChildren; onOpen: () => void }) {
  const { m } = useChunk();
  if (m) return <m.EventCard {...props} />;
  return <props.kit.Loading inline label={props.e.post.title || 'An event'} />;
}

/** An event's page, opened from its card. */
export function EventViewLazy(props: { network: P.Network; event: string; kit: Kit; onBack: () => void }) {
  const { m, failed } = useChunk();
  if (m) return <m.EventView {...props} />;
  return <section class="pane">{failed ? <props.kit.Empty icon="alert" title="Could not load the event">Check the connection to the hub, then try again.</props.kit.Empty> : <props.kit.Loading fill />}</section>;
}
