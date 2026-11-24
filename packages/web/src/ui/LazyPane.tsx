/**
 * Pages that are never on the first screen (a profile, a place's page, Settings, the directory, How it sorts) are
 * chunks of their own, so the app's first load does not download, parse and run them before the list shows
 * (docs/perf.md "Left out of the first load"). Each loads when first opened, and all of them a few seconds after the app
 * started, one per idle moment, so a first open is usually drawn at once, as it was when they were in the startup chunk.
 */
import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { inTurn } from '../slices.ts';
import { Empty } from './bits.tsx';
import { Loading } from './Loader.tsx';

/** How long after the app starts its pages begin loading at idle: after the first list and the hub's data. */
const PRELOAD_AFTER_MS = 3000;

const preloads: (() => Promise<unknown>)[] = [];
let scheduled = false;

/** Called once the app is drawn (App.tsx): loads every lazy page, each in an idle moment of its own. */
export function preloadPagesLater() {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  setTimeout(() => {
    for (const p of preloads) inTurn(() => void p().catch(() => {}));
  }, PRELOAD_AFTER_MS);
}

/**
 * A pane component from a chunk loaded with `load`. Until it is here, the pane shows the loading orb (or, when it could
 * not load, says so); `what` names the page in that message.
 */
export function lazyPane<P extends object>(load: () => Promise<FunctionComponent<P>>, what: string): FunctionComponent<P> {
  let View: FunctionComponent<P> | null = null;
  let loading: Promise<FunctionComponent<P>> | null = null;
  const preload = () =>
    (loading ??= load().then(
      (v) => (View = v),
      (e) => {
        loading = null;
        throw e;
      },
    ));
  preloads.push(preload);
  return function LazyPane(p: P) {
    const [V, setV] = useState<FunctionComponent<P> | null>(() => View);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (!V) preload().then((v) => setV(() => v), () => setFailed(true));
    }, []);
    if (V) return <V {...p} />;
    return (
      <section class="pane">
        {failed ? <Empty icon="alert" title={`Could not load ${what}`}>Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
      </section>
    );
  };
}
