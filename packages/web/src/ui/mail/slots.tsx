/**
 * Where later mail slices plug into the reader and the list (docs/mail.md, docs/mail-design.md §12.1). Each table is
 * filled here, one line per slice, from components in the slice's own files; MessageCard, Reader and ThreadRow only
 * read these tables.
 *
 *   BODY_RENDERERS   what a message card shows as its body: the first that answers wins, TextBody last (slice 3 puts
 *                    its sanitised HTML frame first)
 *   MESSAGE_ACTIONS  buttons under one message (slice 5: reply, reply all, forward, from Composer.tsx)
 *   THREAD_ACTIONS   the reader's header ('head': slice 4's archive, star, trash) and its bottom bar ('bar': slice 5's
 *                    reply bar)
 *   ROW_WRAPPERS     around each thread row, outermost first (slice 4: the swipes, right archives, left marks read
 *                    or unread; slice 4 also adds long-press selection there)
 *   LIST_BARS        above a list, under the views (slice 4: the selection's bar, Undo, changes still waiting)
 */
import type { ComponentChildren, ComponentType } from 'preact';
import type * as P from '@dither-chat/protocol';
import { phone } from '../../phone.ts';
import { answer, canAnswer, latestOf, replyAllHelps } from './Composer.tsx';
import { FILING_MESSAGE_ACTIONS, FILING_THREAD_ACTIONS, FilingBar, FilingRow } from './Filing.tsx';
import { HtmlBody } from './HtmlBody.tsx';
import { TextBody } from './TextBody.tsx';
import { TRIAGE_MESSAGE_ACTIONS } from './Triage.tsx';

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
export type ListBar = ComponentType<{ list: string }>;

// A plain HTML part (only text, links, lists, quotes, bold, italic) with a text part beside it reads as the text does,
// in the app's theme; anything styled keeps its white sheet.
export const BODY_RENDERERS: BodyRenderer[] = [(p) => (p.body.html && !p.body.html.plain ? <HtmlBody {...p} /> : null), (p) => <TextBody {...p} />];
/** On a phone the latest message is answered from the bar below, so its own buttons would be the same twice. */
const underMessage = (m: P.MailMessageView, a: P.MailAccountView | undefined) => canAnswer(a) && !(phone.value && latestOf(m.threadId)?.id === m.id);
const onTheBar = (t: P.MailThreadView, a: P.MailAccountView | undefined) => phone.value && canAnswer(a) && !!latestOf(t.id);

export const MESSAGE_ACTIONS: MessageAction[] = [
  // Slice 5: answering.
  { id: 'reply', label: 'Reply', icon: 'reply', show: (m, _t, a) => underMessage(m, a), run: (m) => answer('reply', m) },
  { id: 'replyAll', label: 'Reply all', icon: 'replyAll', show: (m, _t, a) => underMessage(m, a) && replyAllHelps(m, a), run: (m) => answer('replyAll', m) },
  { id: 'forward', label: 'Forward', icon: 'forward', show: (m, _t, a) => underMessage(m, a), run: (m) => answer('forward', m) },
  // Slice 4: a message's star.
  ...FILING_MESSAGE_ACTIONS,
  // Slice 9: its tier, why, and "Less like this".
  ...TRIAGE_MESSAGE_ACTIONS,
];
export const THREAD_ACTIONS: ThreadAction[] = [
  // Slice 5: the phone's bottom bar answers the latest message.
  { id: 'reply', label: 'Reply', icon: 'reply', place: 'bar', show: onTheBar, run: (t) => latestOf(t.id) && answer('reply', latestOf(t.id)!) },
  { id: 'replyAll', label: 'Reply all', icon: 'replyAll', place: 'bar', show: (t, a) => onTheBar(t, a) && replyAllHelps(latestOf(t.id)!, a), run: (t) => latestOf(t.id) && answer('replyAll', latestOf(t.id)!) },
  { id: 'forward', label: 'Forward', icon: 'forward', place: 'bar', show: onTheBar, run: (t) => latestOf(t.id) && answer('forward', latestOf(t.id)!) },
  // Slice 4: archive, trash, star and ⋯ in the reader's header.
  ...FILING_THREAD_ACTIONS,
];
// Slice 4: swipes and selection; the selection's bar, Undo, what still waits.
export const ROW_WRAPPERS: RowWrapper[] = [FilingRow];
export const LIST_BARS: ListBar[] = [FilingBar];
