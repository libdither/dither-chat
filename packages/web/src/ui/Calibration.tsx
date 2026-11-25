/**
 * Notification calibration (docs/notifications.md, "Asking, without nagging"): the inbox's row, here, and the page
 * (CalibrationPane.tsx), a chunk of its own loaded the first time it opens. The row is quiet: a count, no sound, no
 * push. Asking the hub how many wait is also a look (the next look's bundle is let go): at start, and each time the
 * page comes back into view.
 */
import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { checkinCount, loadCheckinCount } from '../loudness.ts';
import { go } from '../state.ts';
import { Empty } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';

/** The inbox's row: shown while questions wait. */
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
    <button class="row requests-row calibration-row" data-track="calibration row" onClick={() => go({ view: 'calibration' })} title="Questions about single notifications, for when you get to them">
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
          <span class="row-preview">{n === 1 ? 'A question about a notification' : `${n} questions about notifications`}, whenever you like</span>
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
