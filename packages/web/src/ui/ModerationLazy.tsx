/**
 * Moderating from a place's page (Moderation.tsx, docs/moderation.md) is a chunk of its own, loaded the first time a
 * page's About says this account may moderate there, set a label, change the picture or must name who takes over.
 */
import { useEffect, useState } from 'preact/hooks';

type Parts = typeof import('./Moderation.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./Moderation.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** The parts once loaded; asked for only while `want`. */
export function useModeration(want: boolean): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (want && !m) load().then(setM, () => {});
  }, [want]);
  return m;
}
