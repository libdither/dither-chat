/**
 * Threads, forums and group DMs (Threads.tsx, docs/threads.md) are a chunk of their own, loaded the first time a forum
 * opens, a thread menu opens its browser or form, or a thread's or group's About wants its card (as ServerPartsLazy.tsx).
 */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { threadDialog } from '../threads.ts';

type Parts = typeof import('./Threads.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./Threads.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** The parts once loaded; asked for only while `want`. */
export function useThreadParts(want: boolean): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (want && !m) load().then(setM, () => {});
  }, [want]);
  return m;
}

/** The thread browser and forms over the page, once a menu asked for one. */
export function ThreadsLayerLazy() {
  const m = useThreadParts(!!threadDialog.value);
  return m ? <m.ThreadsLayer /> : null;
}

/** A forum's or media channel's posts. */
export function ForumLazy({ c }: { c: P.ConversationView }) {
  const m = useThreadParts(true);
  return m ? <m.ForumView c={c} /> : null;
}
