/**
 * A mail message in a chat, opened up (docs/mail.md "Mail as chats"): the chat shows its words (ui/MailChat.tsx);
 * this is the rest, from its body: the quoted text, the mail as it was sent (its HTML, framed), and its files. In
 * Mail's chunk, with the renderers the reader used.
 */
import type * as P from '@dither-chat/protocol';
import { bareSubject } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { archivedInAll } from '../../mail/filing.ts';
import { canWrite, destination, move, moveKind, star } from '../../mail/ops.ts';
import { db, mailRev, toast } from '../../state.ts';
import { bodies, bodyState, details, loadBody, retryBody } from '../../mail/api.ts';
import type { MenuEntry, MenuSpec } from '../ContextMenu.tsx';
import { threadMenu } from './Filing.tsx';
import { Icon } from '../icons.tsx';
import { Loading } from '../Loader.tsx';
import { MailFiles } from './MailFiles.tsx';
import { BODY_RENDERERS, MESSAGE_ACTIONS, THREAD_ACTIONS } from './slots.tsx';
import { TextBody } from './TextBody.tsx';

/** The mail view a chat message stands for, for the reader's renderers. */
function asMailMessage(m: P.MessageView): P.MailMessageView {
  const x = m.mail!;
  return {
    id: m.id,
    threadId: x.threadId,
    accountId: x.accountId,
    messageId: x.messageId,
    from: x.from,
    to: x.to,
    cc: x.cc,
    subject: x.subject,
    date: x.date,
    receivedAt: x.receivedAt,
    flags: { seen: x.seen, flagged: x.flagged, answered: false, draft: false },
    seenHere: x.seen,
    pending: false,
    labels: [],
    mailboxIds: [],
    hasAttachments: x.hasAttachments,
    preview: m.body,
    addressed: 'to',
    body: x.bodyState,
  };
}

/**
 * `show`: 'words' its words, for a message the hub had no body for (drawn by `words`, the chat's letter); 'quote' the text with its quote open; 'sent' the mail as it was sent (its HTML where it has one); 'files'
 * only its files (a message with attachments shows them under its words without being opened).
 */
export function ChatMailBody({ m, show, words }: { m: P.MessageView; show: 'words' | 'quote' | 'sent' | 'files'; words?: (text: string, quoted: boolean) => preact.JSX.Element }) {
  mailRev.value;
  useEffect(() => void loadBody(m.id), [m.id]);
  const body = bodies.get(m.id);
  const state = bodyState.get(m.id);
  if (!body)
    return state?.error ? (
      <div class="mail-body-failed" role="alert">
        <span>Could not load this mail: {state.error}</span>
        <button class="link-btn" onClick={() => void retryBody(m.id)}>
          Try again
        </button>
      </div>
    ) : show === 'files' ? null : (
      <Loading inline label="Loading the mail…" />
    );
  const message = asMailMessage(m);
  const account = db.mail.accounts.get(message.accountId);
  if (show === 'files') return <MailFiles body={body} />;
  // Words the hub did not hold yet (mail you sent from elsewhere has no body until asked): up to its quote.
  if (show === 'words' && words && body.text) return words(body.text.slice(0, body.quoteAt ?? undefined).trimEnd(), !!body.quoteAt);
  if (show === 'words') return body.text ? <TextBody message={message} account={account} body={{ ...body, text: body.text.slice(0, body.quoteAt ?? undefined).trimEnd(), quoteAt: null }} /> : <div class="msg-body chat-mail-empty">No text</div>;
  if (show === 'quote' && body.text) return <div class="chat-mail-quote"><QuoteOpen body={body} message={message} account={account} /></div>;
  for (const r of BODY_RENDERERS) {
    const out = r({ message, body, account });
    if (out !== null && out !== undefined) return <div class="chat-mail-sent">{out}</div>;
  }
  return null;
}

/** The quoted text under the words, open (the chat shows the words itself). */
function QuoteOpen(p: { body: P.MailBodyView; message: P.MailMessageView; account: P.MailAccountView | undefined }) {
  const at = p.body.quoteAt;
  if (at === null || at === undefined || at <= 0) return <TextBody {...p} />;
  return <TextBody {...p} body={{ ...p.body, text: p.body.text!.slice(at), quoteAt: null }} />;
}

const threadOf = (id: string) => db.mail.threads.get(id) ?? details.get(id)?.thread;

/** A thread's filing in its chat's header (the reader's: Archive, Trash, Star, ⋯), from the mail chunk's table. */
export function MailThreadActions({ threadId }: { threadId: string }) {
  mailRev.value;
  const t = threadOf(threadId);
  if (!t) return null;
  const account = db.mail.accounts.get(t.accountId);
  return (
    <>
      {/* ⋯ is the head's own (PlaceHead.tsx), holding threadHeadMenu. */}
      {THREAD_ACTIONS.filter((a) => a.place === 'head' && a.id !== 'more' && (a.show?.(t, account) ?? true)).map((a) => (
        <button class="hdr-btn" data-track={`mail thread: ${a.id}`} title={a.label} aria-label={a.label} onClick={() => a.run(threadOf(threadId) ?? t)}>
          <Icon name={a.icon} size={16} />
        </button>
      ))}
    </>
  );
}

/** The thread's menu, as its head's ⋯ and a right-click on the head open it: the reader's (Mark read, Star, Move…). */
export function threadHeadMenu(threadId: string): MenuSpec | null {
  const t = threadOf(threadId);
  return t ? threadMenu([db.mail.threads.get(t.id) ?? t], 'reader') : null;
}

/** The filing a thread's details panel shows: Archive (or Unarchive), Star, and Move to the trash. */
export function threadPanelActions(threadId: string): MenuEntry[] {
  const t = threadOf(threadId);
  if (!t) return [];
  const account = db.mail.accounts.get(t.accountId);
  const trash = THREAD_ACTIONS.find((a) => a.id === 'trash' && (a.show?.(t, account) ?? true));
  return [...threadFiling(threadId, false), ...(trash ? [{ label: 'Trash', icon: trash.icon, track: 'mail thread: trash', danger: true, run: () => trash.run(threadOf(threadId) ?? t) }] : [])];
}

/** The account files the thread that way: the mailbox is there, and it makes that kind of move. */
const canMove = (t: P.MailThreadView, to: P.MailMoveTarget) => {
  const b = destination(t, to);
  return !!b && canWrite(db.mail.accounts.get(t.accountId), moveKind(b));
};

/**
 * A thread's Archive and Star from a chat (the subject tag's card, and every mail message's menu): `long` names the
 * thread ("Archive “Dinner on Friday?”", "Star thread"), as a message's menu needs; the tag's card says it already.
 * Archiving says "Archived · Undo"; the thread's tags then show the archive glyph (MailChat.tsx SubjectTag).
 */
export function threadFiling(threadId: string, long: boolean): MenuEntry[] {
  const t = threadOf(threadId);
  if (!t) return [];
  const subject = bareSubject(t.subject) || '(no subject)';
  const out: MenuEntry[] = [];
  const inbox = t.roles.includes('inbox');
  if (inbox && canMove(t, 'archive'))
    out.push({
      label: long ? `Archive “${subject}”` : 'Archive',
      icon: 'archive',
      track: 'mail thread: archive',
      run: () => {
        move([t.id], 'archive');
        toast({ kind: 'info', title: 'Archived', body: '', action: () => move([t.id], 'inbox'), actionLabel: 'Undo' });
      },
    });
  else if (!inbox && (t.roles.includes('archive') || archivedInAll(db.mail.mailboxes, t)) && canMove(t, 'inbox'))
    out.push({ label: long ? `Unarchive “${subject}”` : 'Unarchive', icon: 'inbox', track: 'mail thread: unarchive', run: () => move([t.id], 'inbox') });
  if (canWrite(db.mail.accounts.get(t.accountId), 'flagged'))
    out.push({ label: `${t.flagged ? 'Unstar' : 'Star'}${long ? ' thread' : ''}`, icon: 'star', track: t.flagged ? 'mail thread: unstar' : 'mail thread: star', run: () => star([t.id], !t.flagged) });
  return out;
}

/**
 * A mail message's menu in a chat, past answering (MailChat.tsx mailMessageMenu has that): its tier, from the reader's
 * table, its thread's Archive and Star (threadFiling), and the thread's trash.
 */
export function mailMessageItems(m: P.MessageView): MenuEntry[] {
  const t = threadOf(m.mail!.threadId);
  if (!t) return [];
  const message = asMailMessage(m);
  const account = db.mail.accounts.get(t.accountId);
  const out: MenuEntry[] = MESSAGE_ACTIONS.filter((a) => !ANSWERS.has(a.id) && !STARS.has(a.id) && (a.show?.(message, t, account) ?? true)).map((a) => ({ label: a.label, icon: a.icon, track: `mail: ${a.id}`, run: () => a.run(message, t) }));
  out.push(...threadFiling(t.id, true));
  for (const a of THREAD_ACTIONS) if (a.id === 'trash' && (a.show?.(t, account) ?? true)) out.push({ label: 'Move the thread to the trash', icon: a.icon, track: `mail thread: ${a.id}`, run: () => a.run(t) });
  return out;
}
const ANSWERS = new Set(['reply', 'replyAll', 'forward']);
/** A message's own star: in a chat the thread is starred instead ("Star thread"), as one control. */
const STARS = new Set(['star', 'unstar']);
