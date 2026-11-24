/**
 * A message's history (MessageHistory.tsx, docs/history.md "A message's history") is a chunk of its own, loaded the
 * first time one opens: from "(edited)", the words an edit put in, the ticks, a reaction held on a phone, or the menu.
 */
import { useEffect, useState } from 'preact/hooks';
import { historyOf } from '../messageHistory.ts';

type Parts = typeof import('./MessageHistory.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./MessageHistory.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

export function MessageHistoryLayer() {
  const want = !!historyOf.value;
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (want && !m) load().then(setM, () => {});
  }, [want]);
  return want && m ? <m.MessageHistoryLayer /> : null;
}
