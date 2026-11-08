/**
 * Mail's screens (the list, the reader and what they draw with) are a chunk of their own, loaded the first time Mail
 * opens, as the people graph is (GraphPane.tsx): the chat app's first load does not carry them (docs/perf.md).
 */
import { useEffect, useState } from 'preact/hooks';
import { Empty, Skeleton } from '../bits.tsx';

type Screens = typeof import('./screens.ts');
let screens: Screens | null = null;
let loading: Promise<Screens> | null = null;

/** Starts loading them (the rail calls it when the pointer comes near). */
export function preloadMail(): Promise<Screens> {
  return (loading ??= import('./screens.ts').then(
    (m) => (screens = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

function useScreens(): { m: Screens | null; failed: boolean } {
  const [m, setM] = useState(screens);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!m) preloadMail().then(setM, () => setFailed(true));
  }, []);
  return { m, failed };
}

export function MailSidebarLazy(p: { list?: string; active?: string }) {
  const { m } = useScreens();
  return m ? (
    <m.MailSidebar {...p} />
  ) : (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Mail</h1>
      </header>
      <Skeleton rows={6} />
    </div>
  );
}

export function MailCenterLazy({ thread, onBack }: { thread?: string; onBack: () => void }) {
  const { m, failed } = useScreens();
  if (m) return thread ? <m.Reader threadId={thread} onBack={onBack} /> : <m.MailWelcome />;
  return (
    <section class="pane welcome">
      {failed ? <Empty icon="alert" title="Could not load Mail">Check the connection to the hub, then try again.</Empty> : <Skeleton rows={3} kind="msg" />}
    </section>
  );
}
