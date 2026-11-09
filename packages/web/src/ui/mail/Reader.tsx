/**
 * A thread, read (docs/mail.md): the subject, then its messages oldest first. Unread messages and the latest are open;
 * the rest fold to one line each. After a second in view it counts as read here (slice 4 also tells the server).
 * Header and bottom-bar actions come from slots.tsx THREAD_ACTIONS.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { details, loadThread, markThreadRead } from '../../mail/api.ts';
import { db, mailRev } from '../../state.ts';
import { Empty, Skeleton } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import { SendNote } from './Composer.tsx';
import { MessageCard } from './MessageCard.tsx';
import { THREAD_ACTIONS } from './slots.tsx';

/** How long a thread is on screen before it counts as read (§14 Q3). */
export const READ_AFTER_MS = 1000;

export function Reader({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  mailRev.value;
  const d = details.get(threadId);
  const thread = d?.thread ?? db.mail.threads.get(threadId);
  const account = thread ? db.mail.accounts.get(thread.accountId) : undefined;
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOpened({});
    void loadThread(threadId);
  }, [threadId]);
  // Read once it has been in view a second, while the page is in front.
  const loaded = !!d && !d.loading && !d.error;
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = document.visibilityState === 'visible' ? setTimeout(() => markThreadRead(threadId), READ_AFTER_MS) : null;
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [threadId, loaded]);

  const head = THREAD_ACTIONS.filter((a) => a.place === 'head' && thread && (a.show?.(thread, account) ?? true));
  const bar = THREAD_ACTIONS.filter((a) => a.place === 'bar' && thread && (a.show?.(thread, account) ?? true));
  const messages = d?.messages ?? [];
  const last = messages[messages.length - 1];
  const isOpen = (m: P.MailMessageView) => opened[m.id] ?? (m === last || !(m.flags.seen || m.seenHere));

  return (
    <section class="pane mail-reader" aria-label={thread?.subject || 'Mail'}>
      <header class="conv-head mail-reader-head">
        <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="conv-head-text">
          <h2 class="mail-subject">{thread?.subject || (thread ? '(no subject)' : 'Mail')}</h2>
          {thread && (
            <div class="conv-head-sub">
              {thread.count} {thread.count === 1 ? 'message' : 'messages'}
              {account && db.mail.accounts.size > 1 && <> · {account.address ?? account.label}</>}
              {thread.labels.length > 0 && <> · {thread.labels.join(', ')}</>}
            </div>
          )}
        </div>
        {head.length > 0 && (
          <div class="conv-head-actions">
            {head.map((a) => (
              <button class="hdr-btn" title={a.label} aria-label={a.label} onClick={() => thread && a.run(thread)}>
                <Icon name={a.icon} size={16} />
              </button>
            ))}
          </div>
        )}
      </header>
      <div class="mail-reader-scroll">
        {!thread && !d ? (
          <Skeleton rows={3} kind="msg" />
        ) : d?.error && !messages.length ? (
          <Empty icon="alert" title="Could not open this thread">
            {d.error}
          </Empty>
        ) : !messages.length ? (
          <Skeleton rows={3} kind="msg" />
        ) : (
          messages.map((m) => <MessageCard key={m.id} message={m} thread={thread!} account={account} open={isOpen(m)} onToggle={() => setOpened({ ...opened, [m.id]: !isOpen(m) })} />)
        )}
        {account?.level === 'read' && (
          <p class="mail-reader-note">dither-accounts lets dither-chat read this account, not change it. It is marked read here only.</p>
        )}
        <SendNote account={account} />
        {account && account.level === null && (
          <p class="mail-reader-note">dither-chat no longer has access to this account. What is shown was kept here{account.deleteAt ? ' until it is deleted' : ''}.</p>
        )}
      </div>
      {bar.length > 0 && thread && (
        <footer class="mail-reader-bar">
          {bar.map((a) => (
            <button class="hdr-btn" onClick={() => a.run(thread)}>
              <Icon name={a.icon} size={16} />
              <span class="hdr-btn-label">{a.label}</span>
            </button>
          ))}
        </footer>
      )}
    </section>
  );
}

/** The center pane with no thread open: what to do, or where mail stands. */
export function MailWelcome() {
  mailRev.value;
  const s = db.mail;
  return (
    <section class="pane welcome">
      <div class="welcome-inner">
        <Icon name="mail" size={40} />
        <h2>Mail</h2>
        <p>{s.accounts.size ? 'Pick a thread to read it.' : 'Your mail shows here once an account is shared with dither-chat.'}</p>
      </div>
    </section>
  );
}
