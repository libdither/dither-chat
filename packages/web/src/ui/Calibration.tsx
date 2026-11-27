/**
 * Notification calibration (docs/notifications.md, "The calibration feed"): the inbox's row, here, and the page
 * (CalibrationPane.tsx), a chunk of its own loaded the first time it opens. The row is quiet: a count, no sound, no
 * push. It asks the hub how many cards wait at start, and each time the page comes back into view.
 */
import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { checkinCount, loadCheckinCount } from '../loudness.ts';
import { go } from '../state.ts';
import { Empty } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';

/** The inbox's row: shown while cards wait. */
export function CalibrationRow() {
  useEffect(() => {
    void loadCheckinCount();
    const back = () => document.visibilityState === 'visible' && void loadCheckinCount();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
  const n = checkinCount.value;
  if (!n) return null;
  return (
    <button class="row requests-row calibration-row" data-track="calibration row" onClick={() => go({ view: 'calibration' })} title="Notifications worth asking about, for when you get to them">
      <span class="row-avatar">
        <span class="requests-icon">
          <Icon name="bell" size={18} />
        </span>
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            Notification calibration <span class="requests-count">{n}</span>
          </span>
        </span>
        <span class="row-bottom">
          <span class="row-preview">{n === 1 ? 'A notification to answer' : `${n} notifications to answer`}, whenever you like</span>
        </span>
      </span>
    </button>
  );
}

type Pane = FunctionComponent<{ onBack?: () => void }>;
let loaded: Pane | null = null;

export function CalibrationPaneLazy(p: { onBack?: () => void }) {
  const [View, setView] = useState<Pane | null>(() => loaded);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (loaded) return;
    import('./CalibrationPane.tsx')
      .then((m) => setView(() => (loaded = m.CalibrationPane)))
      .catch(() => setError(true));
  }, []);
  if (View) return <View {...p} />;
  return (
    <section class="pane requests-pane calibration-pane">
      {error ? <Empty icon="alert" title="Could not load Notification calibration">Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
    </section>
  );
}
