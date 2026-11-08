/**
 * Where later mail slices plug into the reader and the list (docs/mail.md, docs/mail-design.md §12.1). Each table is
 * filled here, one line per slice, from components in the slice's own files; MessageCard, Reader and ThreadRow only
 * read these tables.
 *
 *   BODY_RENDERERS   what a message card shows as its body: the first that answers wins, TextBody last (slice 3 puts
 *                    its sanitised HTML frame first)
 *   MESSAGE_ACTIONS  buttons under one message (slice 5: reply, reply all, forward)
 *   THREAD_ACTIONS   the reader's header ('head': slice 4's archive, star, trash) and its bottom bar ('bar': slice 5's
 *                    reply bar)
 *   ROW_WRAPPERS     around each thread row, outermost first (slice 4: the swipes, right archives, left marks read
 *                    or unread; slice 4 also adds long-press selection there)
 */
import type { ComponentChildren, ComponentType } from 'preact';
import type * as P from '@dither-chat/protocol';
import { TextBody } from './TextBody.tsx';

export interface BodyProps {
  message: P.MailMessageView;
  body: P.MailBodyView;
  account: P.MailAccountView | undefined;
}
/** Null: not this renderer's message; the next one in the table gets it. */
export type BodyRenderer = (p: BodyProps) => ComponentChildren | null;

export interface MessageAction {
  id: string;
  label: string;
  icon: string;
  /** Shown for this message (the account's level, whether it can send, …). */
  show?: (m: P.MailMessageView, t: P.MailThreadView, account: P.MailAccountView | undefined) => boolean;
  run: (m: P.MailMessageView, t: P.MailThreadView) => void;
}

export interface ThreadAction {
  id: string;
  label: string;
  icon: string;
  place: 'head' | 'bar';
  show?: (t: P.MailThreadView, account: P.MailAccountView | undefined) => boolean;
  run: (t: P.MailThreadView) => void;
}

export type RowWrapper = ComponentType<{ thread: P.MailThreadView; children: ComponentChildren }>;

export const BODY_RENDERERS: BodyRenderer[] = [(p) => <TextBody {...p} />];
export const MESSAGE_ACTIONS: MessageAction[] = [];
export const THREAD_ACTIONS: ThreadAction[] = [];
export const ROW_WRAPPERS: RowWrapper[] = [];
