/**
 * A mail message in a chat, opened up (docs/mail.md "Mail as chats"): the chat shows its words (ui/MailChat.tsx);
 * this is the rest, from its body: the quoted text, the mail as it was sent (its HTML, framed), and its files. In
 * Mail's chunk, with the renderers the reader used.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { db, mailRev } from '../../state.ts';
import { bodies, bodyState, details, loadBody, retryBody } from '../../mail/api.ts';
import type { MenuEntry } from '../ContextMenu.tsx';
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
      {THREAD_ACTIONS.filter((a) => a.place === 'head' && (a.show?.(t, account) ?? true)).map((a) => (
        <button class="hdr-btn" data-track={`mail thread: ${a.id}`} title={a.label} aria-label={a.label} onClick={() => a.run(threadOf(threadId) ?? t)}>
          <Icon name={a.icon} size={16} />
        </button>
      ))}
    </>
  );
}

/** What a thread's filing is called from one of its messages, in a chat. */
const ON_THE_THREAD: Record<string, string> = { archive: 'Archive the thread', unarchive: 'Move the thread to Inbox', trash: 'Move the thread to the trash' };

/**
 * A mail message's menu in a chat, past answering (MailChat.tsx mailMessageMenu has that): its star and tier, from the
 * reader's table, and its thread's filing.
 */
export function mailMessageItems(m: P.MessageView): MenuEntry[] {
  const t = threadOf(m.mail!.threadId);
  if (!t) return [];
  const message = asMailMessage(m);
  const account = db.mail.accounts.get(t.accountId);
  const out: MenuEntry[] = MESSAGE_ACTIONS.filter((a) => !ANSWERS.has(a.id) && (a.show?.(message, t, account) ?? true)).map((a) => ({ label: a.label, icon: a.icon, track: `mail: ${a.id}`, run: () => a.run(message, t) }));
  for (const a of THREAD_ACTIONS) if (ON_THE_THREAD[a.id] && (a.show?.(t, account) ?? true)) out.push({ label: ON_THE_THREAD[a.id], icon: a.icon, track: `mail thread: ${a.id}`, run: () => a.run(t) });
  return out;
}
const ANSWERS = new Set(['reply', 'replyAll', 'forward']);
