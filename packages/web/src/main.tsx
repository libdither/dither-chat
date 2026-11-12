import { effect } from '@preact/signals';
import { render } from 'preact';
import { App } from './ui/App.tsx';
import { reportContent, reportFresh, startAndroid } from './android.ts';
import { startActivity } from './activity.ts';
import { startClickLog } from './clicklog.ts';
import { startDevices } from './devices.ts';
import { installDeskLinks } from './desk.ts';
import { trackViewport } from './phone.ts';
import { startAhead } from './ahead.ts';
import { registerServiceWorker } from './pwa.ts';
import { dropPages, dropSnapshot, readSnapshot, restore } from './snapshot.ts';
import { applyBootstrap, applyEvents, beforeSync, connect, loaded, restoreOutbox } from './state.ts';
import './styles.css';

const scriptAt = performance.now();
// The hub first, so the socket is on its way while this device's snapshot is read.
connect();
// Sends that were waiting for the hub when the app last closed: shown again, and sent after the first sync.
void restoreOutbox();
trackViewport();
startAndroid();
startActivity();
startClickLog();
startDevices();
installDeskLinks();

let source = 'hub';
let readMs = -1;
const restored = readSnapshot()
  .then((s) => {
    readMs = performance.now() - scriptAt;
    if (s && restore(s, applyBootstrap, (ids) => applyEvents(ids.map((identity) => ({ t: 'identity', identity }))))) source = 'snapshot';
  })
  .catch((e) => console.warn('snapshot not restored', e));
// The socket may open first: the sync waits for the snapshot, to resume from its position (docs/sync.md).
beforeSync.wait = restored;
// Painting the loading screen first would only flash it: the snapshot is a few tens of milliseconds away.
await Promise.race([restored, new Promise((r) => setTimeout(r, 400))]);

// Time to the first screen with conversations on it, for docs/android.md (and the Android app's "fully drawn").
let marked = false;
effect(() => {
  if (!loaded.value || marked) return;
  marked = true;
  requestAnimationFrame(() =>
    setTimeout(() => {
      const ms = performance.now();
      performance.mark('dither:content', { detail: { source } });
      console.info(`[dither] content after ${ms.toFixed(0)} ms, from the ${source} (script ran at ${scriptAt.toFixed(0)} ms, snapshot read took ${readMs.toFixed(0)} ms)`);
      reportContent(ms, source);
    }),
  );
});

// And when the hub's own data replaced it.
new PerformanceObserver((list, obs) => {
  const fresh = list.getEntriesByName('dither:fresh')[0];
  if (!fresh) return;
  obs.disconnect();
  console.info(`[dither] fresh from the hub after ${fresh.startTime.toFixed(0)} ms`);
  reportFresh(fresh.startTime);
}).observe({ type: 'mark', buffered: true });

try {
  render(<App />, document.getElementById('app')!);
} catch (e) {
  // A snapshot the code cannot render is dropped, once, and the app starts from the hub.
  if (source !== 'snapshot') throw e;
  console.error('the snapshot did not render; starting from the hub', e);
  await Promise.all([dropSnapshot(), dropPages()]);
  location.reload();
}

registerServiceWorker();
// Fetching ahead what you will likely open next (prefetch.ts): a chunk of its own, off the first screen's path.
startAhead();
