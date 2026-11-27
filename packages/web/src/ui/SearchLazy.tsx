/**
 * Search's page, loaded when first opened (docs/search.md, "In the app"): its tabs, chips, ranking reasons and Jump to
 * are a chunk of their own (Search.tsx), so the app's first load does not carry them. What must be there from the
 * start stays here: Ctrl+F. What the inbox finds as you type in
 * its box beyond its own rows (InboxFound) is in the same chunk, which the box starts loading on focus.
 */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { go, route } from '../state.ts';
import { countKey } from '../clicklog.ts';
import { Loading } from './Loader.tsx';
import { Empty } from './bits.tsx';

type Chunk = Pick<typeof import('./Search.tsx'), 'default' | 'InboxFound'>;
const chunk = signal<Chunk | null>(null);
const failed = signal(false);
let loading: Promise<unknown> | null = null;
/** Starts loading the page; the inbox's box calls it on focus, so the page is usually there by the first key. */
export const preloadSearch = () =>
  (loading ??= import('./Search.tsx').then(
    // Named, so the check for unused exports sees both used.
    (m) => ((chunk.value = { default: m.default, InboxFound: m.InboxFound }), (failed.value = false)),
    () => ((loading = null), (failed.value = true)),
  ));

/** `onBack` when searching is a page (one conversation's): App knows where that goes back to. */
export function SearchPane(props: { q: string; onBack?: () => void }) {
  const m = chunk.value;
  useEffect(() => void (m || preloadSearch()), [m]);
  if (m) return <m.default {...props} />;
  return (
    <section class="pane search-pane">
      {failed.value ? <Empty icon="alert" title="Could not load search">Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
    </section>
  );
}

/** The inbox's finds beyond its rows (Search.tsx InboxFound); a line saying so until the chunk is here. */
export function InboxFoundLazy(props: { q: string; skip: Set<string>; onFull: () => void }) {
  const m = chunk.value;
  useEffect(() => void (m || preloadSearch()), [m]);
  if (m) return <m.InboxFound {...props} />;
  return <p class="inbox-found-note">{failed.value ? 'Could not load search.' : 'Searching…'}</p>;
}

/** Ctrl+F: search the chat you are in, or with search open, go to its box. */
export function FindShortcut() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      countKey('keys: Ctrl+F (search)');
      const r = route.value;
      const input = document.querySelector<HTMLInputElement>('.search-pane .search-main input');
      if (r.view === 'search' && !r.conv && input) return (input.focus(), input.select());
      const conv = r.view !== 'profile' && 'conv' in r ? r.conv : undefined;
      go({ view: 'search', q: conv ? `in:${conv}` : '' });
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return null;
}
