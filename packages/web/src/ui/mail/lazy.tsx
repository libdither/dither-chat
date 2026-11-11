/**
 * Mail's screens (the list, the reader and what they draw with) are a chunk of their own, loaded the first time Mail
 * opens, as the people graph is (GraphPane.tsx): the chat app's first load does not carry them (docs/perf.md).
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { db, mailRev } from '../../state.ts';
import { Empty } from '../bits.tsx';
import { Loading } from '../Loader.tsx';

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
      <Loading />
    </div>
  );
}

export function MailCenterLazy({ thread, onBack }: { thread?: string; onBack: () => void }) {
  const { m, failed } = useScreens();
  if (m) return thread ? <m.Reader threadId={thread} onBack={onBack} /> : <m.MailWelcome />;
  return (
    <section class="pane welcome">
      {failed ? <Empty icon="alert" title="Could not load Mail">Check the connection to the hub, then try again.</Empty> : <Loading fill />}
    </section>
  );
}

/** Settings → Indexing → Mail (MailKeep.tsx), in Mail's chunk: loaded there only when the hub has mail accounts. */
export function MailKeepLazy() {
  mailRev.value;
  const want = db.mail.access.state === 'granted' && db.mail.accounts.size > 0;
  const [m, setM] = useState(screens);
  useEffect(() => {
    if (want && !m) preloadMail().then(setM, () => {});
  }, [want]);
  return want && m ? <m.MailKeepSection /> : null;
}

// ------------------------------------------------------------------ the composer (slice 5)

/** What the composer opens on: a reply, reply all or forward of a message, a new message, or a draft. */
export interface ComposeOpen {
  kind: P.MailComposeKind;
  messageId?: string;
  threadId?: string;
  accountId?: string;
  draftKey?: string;
  /** A draft in hand (Undo gives it back), shown at once. */
  draft?: P.MailDraft;
  /** Each opening is new, so the same thread can be answered twice. */
  seq: number;
}

/** The composer that is open; null when none (Composer.tsx). */
export const mailCompose = signal<ComposeOpen | null>(null);
let composeSeq = 0;
export function openCompose(o: Omit<ComposeOpen, 'seq'>) {
  mailCompose.value = { ...o, seq: ++composeSeq };
  void preloadMail();
}

/** Something of the outbox to show: a send held for Undo, on its way, or failed. */
const outboxShows = () => [...db.mail.outbox.values()].some((o) => o.state !== 'sent' || (o.createdAt ?? 0) > Date.now() - 60_000);

/** The composer and the outbox's strip, over everything; loaded with Mail's screens when first needed. */
export function MailComposerLazy() {
  mailRev.value;
  const want = !!mailCompose.value || outboxShows();
  const [m, setM] = useState(screens);
  useEffect(() => {
    if (want && !m) preloadMail().then(setM, () => {});
  }, [want]);
  return want && m ? <m.ComposerLayer /> : null;
}
