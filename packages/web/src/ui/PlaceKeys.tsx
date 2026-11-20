/**
 * Keys to the places (docs/desktop.md "Keys to the places"): G then I, P, M, C or F, and Alt+1 to Alt+5. After a G, a
 * small card says which letters there are. The calendar's frame passes its keys here too (CalendarPane.tsx), so the
 * keys work with the calendar in focus, and its own M and C do not take a letter that followed G.
 */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { POST_NETWORKS } from '@dither-chat/protocol';
import { countKey } from '../clicklog.ts';
import { calendarOn } from '../plans.ts';
import { G_WAIT_MS, PLACES, readKey, type Place } from '../placekeys.ts';
import { db, go, type Route } from '../state.ts';

/** Whether the Feed is offered: an account with posts (X, Mastodon, Reddit, Lemmy, Substack, Bluesky), or its notifications already held. */
export const feedOn = () => [...db.accounts.values()].some((a) => POST_NETWORKS.includes(a.network)) || [...db.conversations.values()].some((c) => c.variant === 'feed');

/** What the rail shows (Rail.tsx): Mail with mail access, the calendar with its account, the Feed with posts. */
function offered(p: Place): boolean {
  if (p === 'mail') return db.mail.access.state !== 'off';
  if (p === 'calendar') return calendarOn;
  if (p === 'feed') return feedOn();
  return true;
}

const ROUTES: Record<Place, Route> = {
  inbox: { view: 'inbox' },
  people: { view: 'people' },
  mail: { view: 'mail' },
  calendar: { view: 'calendar' },
  feed: { view: 'feed' },
};

/** For a place's tooltip: its keys, as `Alt+2|G P`. */
export function placeKeys(p: Place): string {
  const x = PLACES.find((y) => y.place === p)!;
  return `Alt+${x.digit}|G ${x.letter.toUpperCase()}`;
}

/** True between a G and its letter: the card shows. */
const waiting = signal(false);
let timer: ReturnType<typeof setTimeout> | undefined;
const stopWaiting = () => (clearTimeout(timer), (waiting.value = false));

const COVERS = '.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer';

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  // Not instanceof: a key in the calendar's frame comes from that frame's own Element.
  const el = typeof (e.target as Element | null)?.closest === 'function' ? (e.target as Element) : null;
  const typing = !!el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const out = readKey(
    { key: e.key, code: e.code, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, repeat: e.repeat, composing: e.isComposing, typing, covered: !!document.querySelector(COVERS) },
    waiting.value,
    offered,
  );
  if (!out) return;
  if (out.kind === 'cancel') return void stopWaiting();
  // Used up: nothing behind it sees the key (mail's C, the calendar's M), and the browser does nothing with it.
  e.preventDefault();
  e.stopPropagation();
  if (out.kind === 'wait') {
    clearTimeout(timer);
    waiting.value = true;
    timer = setTimeout(stopWaiting, G_WAIT_MS);
    return;
  }
  stopWaiting();
  const x = PLACES.find((p) => p.place === out.place)!;
  countKey(out.how === 'alt' ? `keys: Alt+${x.digit} (${out.place})` : `keys: G ${x.letter.toUpperCase()} (${out.place})`);
  go(ROUTES[out.place]);
}

/** Listens on `win` (the app's window, or the calendar's frame) before anything in it; returns the way to stop. */
export function listenPlaceKeys(win: Window): () => void {
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}

/** The listener on the app's window, and the card a G brings up. */
export function PlaceKeys() {
  useEffect(() => listenPlaceKeys(window), []);
  if (!waiting.value) return null;
  return (
    <div class="place-keys" role="status" aria-label="Go to">
      <span class="place-keys-head">Go to</span>
      {PLACES.filter((p) => offered(p.place)).map((p) => (
        <span class="place-keys-row">
          <kbd>{p.letter.toUpperCase()}</kbd> {p.label}
        </span>
      ))}
    </div>
  );
}
