/**
 * Stories on a person's or a group's page (docs/media-kinds.md): asked for only where an account has them (capability
 * 'stories', Signal with its stories setting on), and drawn by Stories.tsx, in the chunk MediaParts.tsx.
 */
import { useEffect, useState } from 'preact/hooks';
import { db } from '../state.ts';

type Parts = typeof import('./MediaParts.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

/** Some account has stories, on this network. */
export const storiesHere = (network: string | undefined) => !!network && [...db.accounts.values()].some((a) => a.network === network && a.capabilities.includes('stories'));

export function Stories({ identityId, conversationId, network }: { identityId?: string; conversationId?: string; network?: string }) {
  const want = storiesHere(network);
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (!want || m) return;
    (loading ??= import('./MediaParts.tsx').then(
      (x) => (parts = x),
      (e) => {
        loading = null;
        throw e;
      },
    )).then(setM, () => {});
  }, [want]);
  return want && m ? <m.StoriesCard identityId={identityId} conversationId={conversationId} /> : null;
}
