/**
 * The Calendar pane (docs/calendar.md): dither-calendar's own web app, through the hub at /calendar/, in a frame. Its
 * address inside the chat app is #/calendar/<the calendar's hash>, so a reminder or a chip opens it on the right day,
 * and moving around inside it keeps the chat app's address in step (replaced, so a reload or a copied link comes back
 * to the same place). The frame's own moves are history entries of their own, as a browser keeps for any frame: Back
 * steps back through them, and the address follows.
 */
import { useEffect, useRef } from 'preact/hooks';
import { go } from '../../state.ts';
import { listenPlaceKeys } from '../PlaceKeys.tsx';

export function CalendarPane({ at }: { at?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The src the frame was first given: later changes of `at` go to its hash, so the calendar never loads again.
  const first = useRef(`/calendar/#/${at ?? ''}`);
  useEffect(() => {
    const f = frame.current;
    const win = (() => {
      try {
        return f?.contentWindow?.location.pathname.startsWith('/calendar') ? f.contentWindow : null;
      } catch {
        return null;
      }
    })();
    const want = `#/${at ?? ''}`;
    if (win && win.location.hash !== want && !(want === '#/' && !win.location.hash)) win.location.hash = want;
  }, [at]);
  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    let win: Window | null = null;
    // The app's keys to its places work with the calendar in focus too (PlaceKeys.tsx).
    let unkeys = () => {};
    const follow = () => {
      const h = win?.location.hash.replace(/^#\/?/, '') ?? '';
      if (h !== (at ?? '')) go(h ? { view: 'calendar', at: h } : { view: 'calendar' }, true);
    };
    const attach = () => {
      win?.removeEventListener('hashchange', follow);
      unkeys();
      unkeys = () => {};
      try {
        // Same origin through the hub; a page that is not the calendar's (an error page) has no hash to follow.
        win = f.contentWindow;
        win?.addEventListener('hashchange', follow);
        if (win) unkeys = listenPlaceKeys(win);
      } catch {
        win = null;
      }
    };
    f.addEventListener('load', attach);
    attach();
    return () => {
      f.removeEventListener('load', attach);
      win?.removeEventListener('hashchange', follow);
      unkeys();
    };
  }, [at]);
  return (
    <section class="pane calendar-pane">
      <iframe ref={frame} class="calendar-frame" src={first.current} title="Calendar" />
    </section>
  );
}
