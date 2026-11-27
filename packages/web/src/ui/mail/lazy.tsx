/**
 * Mail's screens (its lists, bodies, compose and filing) are a chunk of their own, loaded at idle or the first time a
 * chat draws mail, as the people graph is (GraphPane.tsx): the chat app's first load does not carry them (docs/perf.md).
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { db, mailRev } from '../../state.ts';
import type { MenuEntry, MenuSpec } from '../ContextMenu.tsx';
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

export function MailSidebarLazy(p: { list: string; active?: string }) {
  const { m } = useScreens();
  return m ? (
    <m.MailSidebar {...p} />
  ) : (
    <Loading />
  );
}

/** A thread's filing in its chat's header (ChatMail.tsx), once mail's chunk is here. */
export function MailThreadActionsLazy(p: { threadId: string }) {
  const { m } = useScreens();
  return m ? <m.MailThreadActions {...p} /> : null;
}

/** A mail message's star, tier and its thread's filing for its menu: none until mail's chunk is here (it loads at idle). */
export const mailMessageExtras = (msg: P.MessageView): MenuEntry[] => screens?.mailMessageItems(msg) ?? [];

/** A thread's Archive and Star from a chat (ChatMail.tsx threadFiling): none until mail's chunk is here. */
export const mailThreadFiling = (threadId: string, long: boolean): MenuEntry[] => screens?.threadFiling(threadId, long) ?? [];

/** A thread's menu (ChatMail.tsx threadHeadMenu), for its head's ⋯ and right-click: none until mail's chunk is here. */
export const mailThreadMenu = (threadId: string): MenuSpec | null => screens?.threadHeadMenu(threadId) ?? null;

/** A thread's filing for its details panel (ChatMail.tsx threadPanelActions). */
export const mailThreadPanel = (threadId: string): Extract<MenuEntry, { label: string; kind?: 'item' }>[] => (screens?.threadPanelActions(threadId) ?? []) as Extract<MenuEntry, { label: string; kind?: 'item' }>[];

/** A mail message in a chat, opened up (ChatMail.tsx): its quote, the mail as sent, or its files. */
export function ChatMailBodyLazy(p: { m: P.MessageView; show: 'words' | 'quote' | 'sent' | 'files'; words?: (text: string, quoted: boolean) => preact.JSX.Element }) {
  const { m, failed } = useScreens();
  if (m) return <m.ChatMailBody {...p} />;
  return failed || p.show === 'files' ? null : <Loading inline label="Loading the mail…" />;
}

/** What a chat box writes, sent as mail (mail/chatsend.ts), once Mail's chunk is here. */
export async function sendMailFromChat(o: Parameters<typeof import('../../mail/chatsend.ts').sendFromChat>[0]) {
  const m = await preloadMail();
  return m.sendFromChat(o);
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

/** A draft thrown away, its Undo in the strip until `until` (Composer.tsx discardLater). */
export interface MailDiscarded {
  key: string;
  kind: P.MailComposeKind;
  threadId?: string;
  subject: string;
  until: number;
}
export const mailDiscarded = signal<MailDiscarded[]>([]);

/** Something of the outbox to show: a send held for Undo, on its way, or failed. */
const outboxShows = () => [...db.mail.outbox.values()].some((o) => o.state !== 'sent' || (o.createdAt ?? 0) > Date.now() - 60_000);

/** The composer and the outbox's strip, over everything; loaded with Mail's screens when first needed. */
export function MailComposerLazy() {
  mailRev.value;
  const want = !!mailCompose.value || outboxShows() || mailDiscarded.value.length > 0;
  const [m, setM] = useState(screens);
  useEffect(() => {
    if (want && !m) preloadMail().then(setM, () => {});
  }, [want]);
  return want && m ? <m.ComposerLayer /> : null;
}
