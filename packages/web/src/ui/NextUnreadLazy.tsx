/**
 * Next unread topic (docs/threads.md "Next unread"): what the page holds from the start, the `n` key and the bar's
 * mount at the bottom of a timeline. The rest (where next is, the bar) is a chunk of its own, NextUnread.tsx, loaded
 * the first time the bar could show or `n` is pressed.
 */
import { useEffect, useState } from 'preact/hooks';
import { layerCount } from '../phone.ts';
import { db, route } from '../state.ts';

type Parts = typeof import('./NextUnread.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./NextUnread.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** Set by a go to the next unread: that chat, as it opens, does not put the caret in its message box, so `n` goes on working. */
let quietFor: string | null = null;
export const quietOpen = (convId: string) => void (quietFor = convId);
/** For the composer of `convId` as it opens: whether to leave the focus where it is. Used up by that chat only. */
export function takeQuietOpen(convId: string): boolean {
  if (quietFor !== convId) return false;
  quietFor = null;
  return true;
}

/** A conversation of the channel whose stream is shown (its mount says so): from it, `n` goes to the next channel. */
let streamOf: string | null = null;
export const streamShown = () => streamOf;

const COVERS = '.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer';

/** The open conversation, on a page that shows one beside its list. */
function openConvId(): string | null {
  const r = route.value;
  if ((r.view === 'inbox' || r.view === 'space' || r.view === 'folder' || r.view === 'search') && r.conv) return r.conv;
  return null;
}

/**
 * `n`, as Zulip's: not while typing, nor with anything over the page (a menu, a sheet, a dialog, a layer the back
 * button closes), nor with a modifier. Caps Lock's `N` is the same key.
 */
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || (e.key !== 'n' && e.key !== 'N') || e.repeat || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || layerCount() > 0 || document.querySelector(COVERS)) return;
  const at = openConvId();
  if (!at) return;
  e.preventDefault();
  load().then((m) => m.goNext(at), () => {});
}

/** The `n` key, on the app's window. */
export function NextUnreadKey() {
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

/**
 * The bar's one mount, at the bottom of a timeline (Timeline.tsx): `at` the conversation shown (a thread, or for a
 * channel's stream any of it), `stream` whether it is a stream, `bottom` whether the newest message is drawn. Its
 * chunk loads only on a thread's page or a stream, once at the bottom.
 */
export function NextUnreadBar(p: { at: string; stream?: boolean; bottom: boolean }) {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (!p.stream) return;
    streamOf = p.at;
    return () => {
      if (streamOf === p.at) streamOf = null;
    };
  }, [p.at, p.stream]);
  const wanted = p.bottom && (!!p.stream || db.conversations.get(p.at)?.shape === 'thread');
  useEffect(() => {
    if (wanted && !m) load().then(setM, () => {});
  }, [wanted]);
  return m && wanted ? <m.NextUnreadBar {...p} /> : null;
}
