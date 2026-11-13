/**
 * Polls' card and maker (Poll.tsx, docs/polls.md) are a chunk of their own, loaded the first time a poll is shown or
 * made. Until then a poll shows as its text, as the message's body has it.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';

type Parts = typeof import('./Poll.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./Poll.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

function useParts(): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (!m) load().then(setM, () => {});
  }, []);
  return m;
}

/** A poll's card, or `fallback` (its body) while the chunk loads or if it will not. */
export function PollCardLazy({ m, fallback }: { m: P.MessageView; fallback: ComponentChildren }) {
  const p = useParts();
  return p ? <p.PollCard m={m} /> : <>{fallback}</>;
}

export function PollMakerLazy(props: { conversationId: string; network: P.Network; accountId?: string; question?: string; onClose: () => void; onSent?: () => void }) {
  const p = useParts();
  return p ? <p.PollMaker {...props} /> : null;
}
