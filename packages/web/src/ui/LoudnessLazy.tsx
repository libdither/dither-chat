/**
 * The loudness scale's parts (Loudness.tsx) are a chunk of their own, loaded the first time one is shown: a bell
 * opened, a why to ask, Settings. Nothing of it is drawn at start-up unless there is something to ask.
 */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { whyAsk } from '../loudness.ts';

type Parts = typeof import('./Loudness.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./Loudness.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

function useParts(want = true): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (!m && want) load().then(setM, () => {});
  }, [want]);
  return m;
}

export function WhyLoudLazy(props: { m: { id: string; triage?: P.TriageView | null }; marks?: boolean; onDone?: () => void }) {
  const p = useParts();
  return p ? <p.WhyLoud {...props} /> : <div class="loud-why loading" aria-busy="true" />;
}

/** The why after an answer: mounted once in the app, loaded only when there is one to ask. */
export function WhyFollowUpLazy() {
  const asking = !!whyAsk.value;
  const p = useParts(asking);
  return p && asking ? <p.WhyFollowUp /> : null;
}

export function LoudnessSettingsLazy() {
  const p = useParts();
  return p ? <p.LoudnessSettings /> : null;
}
