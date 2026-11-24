/**
 * Panes that are not the first screen are chunks of their own, so the app's first load does not download, parse and
 * run them before the list shows (docs/perf.md "Left out of the first load"): a conversation, a profile, a place's
 * page, Settings, the directory, How it sorts, and layers drawn only once opened (the viewer, the index dialog,
 * Organize, the reaction picker). Each loads when first opened. Once the hub's data is in (or at a first tap or key, if sooner), the
 * conversation's chunk loads at once, as the next thing tapped is usually one, and the rest a few seconds later, one
 * per idle moment, so a first open is drawn at once, as it was when they were in the startup chunk.
 */
import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { inTurn } from '../slices.ts';
import { Empty } from './bits.tsx';
import { Loading } from './Loader.tsx';

/** How long after the hub's data is in the other panes begin loading at idle. */
const PRELOAD_AFTER_MS = 3000;

const soon: (() => Promise<unknown>)[] = [];
const later: (() => Promise<unknown>)[] = [];
let scheduled = false;

let soonStarted = false;
/** Starts loading the panes wanted soon (a conversation), at once: the data is in, or a first tap or key came first. */
function loadSoon() {
  if (soonStarted) return;
  soonStarted = true;
  for (const p of soon) void p().catch(() => {});
}

/**
 * Called once the hub's data is in (App.tsx): the conversation's chunk loads at once, the rest a few seconds later,
 * each in an idle moment of its own. A tap or key before then starts the conversation's too (`whenTouched`).
 */
export function preloadPanes() {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  loadSoon();
  setTimeout(() => later.forEach((p) => inTurn(() => void p().catch(() => {}))), PRELOAD_AFTER_MS);
}

/** Until the data is in: the first pointer down or key starts the conversation's chunk (App.tsx, at mount). */
export function whenTouched(): () => void {
  if (typeof window === 'undefined') return () => {};
  const go = () => (loadSoon(), stop());
  const stop = () => (removeEventListener('pointerdown', go, true), removeEventListener('keydown', go, true));
  addEventListener('pointerdown', go, true);
  addEventListener('keydown', go, true);
  return stop;
}

/**
 * A pane component from a chunk loaded with `load`. Until it is here, the pane shows the loading orb (or, when it could
 * not load, says so); `what` names the page in that message. A `layer` over the app shows nothing meanwhile. A pane
 * loaded `soon` is preloaded as soon as the data is in, the rest a few seconds later.
 */
export function lazyPane<P extends object>(load: () => Promise<FunctionComponent<P>>, what: string, o: { layer?: boolean; soon?: boolean } = {}): FunctionComponent<P> {
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
  (o.soon ? soon : later).push(preload);
  return function LazyPane(p: P) {
    const [V, setV] = useState<FunctionComponent<P> | null>(() => View);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (!V) preload().then((v) => setV(() => v), () => setFailed(true));
    }, []);
    if (V) return <V {...p} />;
    if (o.layer) return null;
    return (
      <section class="pane">
        {failed ? <Empty icon="alert" title={`Could not load ${what}`}>Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
      </section>
    );
  };
}
