/**
 * Same person?'s pane, loaded only when opened (same/SamePerson.tsx is a chunk of its own, with the picture hashing),
 * like the people graph's.
 */
import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Empty } from './bits.tsx';
import { Loading } from './Loader.tsx';

type View = FunctionComponent<{ onBack: () => void }>;
let loaded: View | null = null;

export function SamePane({ onBack }: { onBack: () => void }) {
  const [View, setView] = useState<View | null>(() => loaded);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (loaded) return;
    import('../same/SamePerson.tsx')
      .then((m) => setView(() => (loaded = m.default)))
      .catch(() => setError(true));
  }, []);
  if (View) return <View onBack={onBack} />;
  return (
    <section class="pane sp-pane">
      {error ? <Empty icon="alert" title="Could not load Same person?">Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
    </section>
  );
}
