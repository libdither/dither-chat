/**
 * Notices (docs/notices.md): the inbox's row, here, and the list (NoticesPane.tsx), a chunk of its own loaded the first
 * time Notices opens, so the app's first load does not carry it.
 */
import type { FunctionComponent } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { loadNotices, noticesPage, unreadNotices } from '../notices.ts';
import { go, noticesBoot } from '../state.ts';
import { Empty } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';

let fetched = false;

/** The inbox's row: shown while the hub has notices. */
export function NoticesRow() {
  const boot = noticesBoot.value;
  const page = noticesPage.value;
  useEffect(() => {
    if (boot && !fetched) {
      fetched = true;
      void loadNotices();
    }
  }, [!!boot]);
  if (!boot) return null;
  const unread = unreadNotices(page);
  const newest = page?.items[0];
  return (
    <button class="row requests-row notices-row" data-track="notices row" onClick={() => go({ view: 'notices' })} title="What your accounts and services told you">
      <span class="row-avatar">
        <span class="requests-icon">
          <Icon name="bell" size={18} />
        </span>
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            Notices {unread.length > 0 && <span class="requests-count">{unread.length}</span>}
          </span>
          {newest && <span class="row-time">{ago(newest.at)}</span>}
        </span>
        <span class="row-bottom">
          <span class="row-preview">{boot.access !== 'granted' ? accessLine(boot.access) : unread[0]?.title ?? newest?.title ?? 'Nothing yet'}</span>
        </span>
      </span>
    </button>
  );
}

export function accessLine(a: P.NoticeAccessState): string {
  if (a === 'pending') return 'Waiting for you to approve it in dither-accounts';
  if (a === 'denied') return 'You declined it in dither-accounts';
  if (a === 'off') return 'Off: the hub runs without dither-accounts';
  return 'dither-accounts is not reachable';
}

type Pane = FunctionComponent<{ focus?: string; onBack?: () => void }>;
let loaded: Pane | null = null;

export function NoticesPaneLazy(p: { focus?: string; onBack?: () => void }) {
  const [View, setView] = useState<Pane | null>(() => loaded);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (loaded) return;
    import('./NoticesPane.tsx')
      .then((m) => setView(() => (loaded = m.NoticesPane)))
      .catch(() => setError(true));
  }, []);
  if (View) return <View {...p} />;
  return (
    <section class="pane requests-pane notices-pane">
      {error ? <Empty icon="alert" title="Could not load Notices">Check the connection to the hub, then try again.</Empty> : <Loading fill label="Loading…" />}
    </section>
  );
}
