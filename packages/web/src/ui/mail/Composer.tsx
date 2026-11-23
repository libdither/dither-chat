/**
 * Writing mail (docs/mail.md, docs/mail-design.md §6.4): the composer, a full-screen card on a phone and a panel docked
 * at the bottom right on a desktop, over whatever else is open. It answers a message (reply, reply all, forward),
 * starts a new one, or opens a draft. The card itself is ComposerCard.tsx, a chunk of its own; here are the layer it
 * opens in, the outbox's strip, and the ways in (✎, the Drafts line, Reply, the keys).
 *
 * Drafts save themselves (mail/drafts.ts). Send hands the message to the hub's outbox, which holds it 10 s: the strip
 * at the bottom says "Sending… Undo" meanwhile, then "Sent", or why not, with the draft to open again. A discarded
 * draft has its Undo there too (discard.ts). An account that cannot send (a read grant, or sending turned off) says
 * why, and the rest of mail keeps working.
 */
import { isMailThread } from '../../mail/chats.ts';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { details } from '../../mail/held.ts';
import { canSendFrom, dismissSend, drafts, loadDrafts, loadOutbox, sendNow, undoSend } from '../../mail/drafts.ts';
import { connected, db, go, mailRev, route } from '../../state.ts';
import { openMenu } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import { undoDiscard } from './discard.ts';
import { mailCompose, mailDiscarded, openCompose } from './lazy.tsx';

type Card = typeof import('./ComposerCard.tsx');
let card: Card | null = null;
let loadingCard: Promise<Card> | null = null;
/** The composer's card, a chunk of its own (ComposerCard.tsx). */
function loadCard(): Promise<Card> {
  return (loadingCard ??= import('./ComposerCard.tsx').then(
    (m) => (card = m),
    (e) => {
      loadingCard = null;
      throw e;
    },
  ));
}
// Mail is open: the card comes ahead, when the page is idle, so ✎ and Reply open at once.
if (typeof window !== 'undefined') (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 2000)))(() => void loadCard().catch(() => {}));

export function ComposerLayer() {
  mailRev.value;
  const open = mailCompose.value;
  const [m, setM] = useState(card);
  useEffect(() => {
    if (open && !m) loadCard().then(setM, () => {});
  }, [open]);
  return (
    <>
      {open && m && <m.Composer key={open.seq} open={open} />}
      <OutboxStrip />
    </>
  );
}

// ------------------------------------------------------------------ the outbox strip

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Seen as sent by this page: shown a few seconds, then gone. */
const sentSeen = new Map<string, number>();
const SENT_SHOWN_MS = 6000;

function OutboxStrip() {
  mailRev.value;
  const [, tick] = useState(0);
  const now = Date.now();
  const items = [...db.mail.outbox.values()].filter((o) => {
    if (o.state !== 'sent') return true;
    if (!sentSeen.has(o.id)) sentSeen.set(o.id, (o.createdAt ?? 0) > now - 60_000 ? now : 0);
    return now - sentSeen.get(o.id)! < SENT_SHOWN_MS;
  });
  const gone = mailDiscarded.value.filter((x) => x.until > now);
  const live = items.some((o) => o.state === 'held' || o.state === 'sent') || gone.length > 0;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [live]);
  // Back from being away: the outbox as the hub has it now.
  const up = connected.value;
  useEffect(() => {
    if (up) void loadOutbox();
  }, [up]);
  if (!items.length && !gone.length) return null;
  const quoted = (s: string) => (s ? `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”` : 'your message');
  return (
    <div class="mc-strip" role="status" aria-live="polite">
      {gone.map((x) => (
        <div class="mc-out discarded" data-state="discarded" key={`discarded:${x.key}`}>
          <Icon name="trash" size={15} />
          <span class="mc-out-text">Discarded {quoted(x.subject)}</span>
          <button class="btn small mc-undo" onClick={() => undoDiscard(x)}>
            Undo
          </button>
        </div>
      ))}
      {items.map((o) => (
        <div class={`mc-out ${o.state}`} data-state={o.state} key={o.id}>
          <Icon name={o.state === 'failed' ? 'alert' : o.state === 'sent' ? 'check' : 'send'} size={15} />
          <span class="mc-out-text">
            {o.state === 'held' && (
              <>
                Sending {quoted(o.subject)} in {Math.max(0, Math.ceil(((o.holdUntil ?? now) - now) / 1000))} s
              </>
            )}
            {(o.state === 'queued' || o.state === 'sending') && (
              <>
                Sending {quoted(o.subject)}…{o.error ? ` ${o.error}` : ''}
              </>
            )}
            {o.state === 'sent' && (o.dryRun ? <>Dry run: {quoted(o.subject)} did not reach the account</> : <>Sent {quoted(o.subject)}</>)}
            {o.state === 'failed' && (
              <>
                <b>Not sent.</b> {o.error}
              </>
            )}
            {o.pictures && o.pictures.leftOut.failed + o.pictures.leftOut.canTell > 0 && (
              <span
                class="mc-out-note"
                title={[
                  o.pictures.leftOut.failed && `${plural(o.pictures.leftOut.failed, 'picture')} could not be fetched`,
                  o.pictures.leftOut.canTell && `${plural(o.pictures.leftOut.canTell, 'picture')} would have told where it comes from that it was opened`,
                ]
                  .filter(Boolean)
                  .join('; ')}
              >
                {' '}
                · {plural(o.pictures.leftOut.failed + o.pictures.leftOut.canTell, 'picture')} left out
              </span>
            )}
          </span>
          {o.state === 'held' && (
            <button class="btn small mc-send-now" title="Send it without waiting" onClick={() => void sendNow(o.id).catch(() => {})}>
              Send now
            </button>
          )}
          {o.state === 'held' && (
            <button
              class="btn small mc-undo"
              onClick={() =>
                void undoSend(o.id).then(
                  (r) => openCompose({ kind: r.draft.kind, draftKey: r.draftKey, draft: r.draft, threadId: o.threadId ?? undefined }),
                  () => {},
                )
              }
            >
              Undo
            </button>
          )}
          {o.state === 'sent' && o.threadId && route.value.view === 'inbox' && (
            <button class="link-btn" onClick={() => go({ view: 'inbox', conv: o.threadId! })}>
              View
            </button>
          )}
          {o.state === 'failed' && o.draftKey && (
            <button
              class="btn small"
              onClick={() => {
                openCompose({ kind: o.kind ?? 'new', draftKey: o.draftKey!, threadId: o.threadId ?? undefined });
                void dismissSend(o.id);
              }}
            >
              Open draft
            </button>
          )}
          {o.state === 'failed' && (
            <button class="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => void dismissSend(o.id)}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ where it starts from

/** "2 drafts" under the views: each opens in the composer. */
export function DraftsLine() {
  mailRev.value;
  // One thrown away waits out its Undo before it goes: not listed meanwhile.
  const list = drafts.value.filter((x) => !mailDiscarded.value.some((y) => y.key === x.key));
  useEffect(() => {
    void loadDrafts();
  }, []);
  if (!list.length) return null;
  const label = (x: P.MailDraftView) => {
    const to = [...x.draft.to, ...x.draft.cc].map((a) => a.name || a.email).join(', ');
    return `${x.draft.subject || '(no subject)'}${to ? ` · to ${to}` : ''}`;
  };
  return (
    <button
      class="mail-drafts-line"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(
          { x: r.left, y: r.bottom + 4 },
          {
            label: 'Drafts',
            head: <div class="cm-sheet-title">Drafts</div>,
            items: list.map((x) => ({ label: label(x), icon: x.draft.kind === 'forward' ? 'forward' : x.draft.kind === 'new' ? 'pencil' : 'reply', run: () => openCompose({ kind: x.draft.kind, draftKey: x.key }) })),
          },
          e.currentTarget,
        );
      }}
    >
      <Icon name="pencil" size={13} />
      {list.length === 1 ? '1 draft' : `${list.length} drafts`}
    </button>
  );
}

// ------------------------------------------------------------------ answering

/** Answering works from this message's account. */
export const canAnswer = (a: P.MailAccountView | undefined) => canSendFrom(a);

/** Reply all would reach more people than reply (as far as the page knows your addresses). */
export function replyAllHelps(m: P.MailMessageView, a: P.MailAccountView | undefined): boolean {
  const me = a?.address?.toLowerCase();
  const others = new Set([m.from, ...m.to, ...m.cc].map((x) => x.email.toLowerCase()).filter((e) => e && e !== me));
  return others.size > 1;
}

export function answer(kind: P.MailComposeKind, m: P.MailMessageView) {
  openCompose({ kind, messageId: m.id, threadId: m.threadId, accountId: m.accountId });
}

/** The message the reader's bottom bar answers: the latest. */
export function latestOf(threadId: string): P.MailMessageView | undefined {
  const ms = details.get(threadId)?.messages ?? [];
  return ms[ms.length - 1];
}

// Keys (§6.5), in a mail list or a thread's chat (docs/mail.md "Mail as chats"): c composes; r, a and f answer the
// open thread's latest message.
if (typeof window !== 'undefined')
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || mailCompose.value) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const r = route.value;
    if (r.view !== 'inbox' || !(r.mail || isMailThread(r.conv))) return;
    const thread = isMailThread(r.conv) ? r.conv : undefined;
    if (e.key === 'c') {
      const acc = [...db.mail.accounts.values()].find(canSendFrom);
      if (acc) (e.preventDefault(), openCompose({ kind: 'new', accountId: acc.id }));
      return;
    }
    const kind = ({ r: 'reply', a: 'replyAll', f: 'forward' } as const)[e.key as 'r' | 'a' | 'f'];
    if (!kind || !thread) return;
    const m = latestOf(thread);
    if (m && canAnswer(db.mail.accounts.get(m.accountId))) (e.preventDefault(), answer(kind, m));
  });
