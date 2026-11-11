/**
 * The people graph's pane, loaded only when opened: the graph, its layout worker and its WebGL drawing are a chunk of
 * their own (graph/), like the live view's noVNC, so the app's first load does not carry them.
 */
import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Empty } from './bits.tsx';
import { rev } from '../state.ts';
import { Loading } from './Loader.tsx';

type View = FunctionComponent<{ onBack: () => void }>;
let loaded: View | null = null;

export function GraphPane({ onBack }: { onBack: () => void }) {
  rev.value;
  const [View, setView] = useState<View | null>(() => loaded);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (loaded) return;
    import('../graph/GraphView.tsx')
      .then((m) => setView(() => (loaded = m.default)))
      .catch(() => setError(true));
  }, []);
  if (View) return <View onBack={onBack} />;
  return (
    <section class="pane pg-pane">
      {error ? <Empty icon="alert" title="Could not load the graph">Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
    </section>
  );
}
