/**
 * A list of threads, newest first (docs/mail.md). It shows what is at hand at once (the bootstrap's window), loads its
 * first page from the hub, and the next ones as it is scrolled near its end; past what the hub holds, the hub fetches
 * them from the server. A list the hub made stale while it was away loads again when it shows. The last line says how
 * the sync is going.
 */
import { parseMailList } from '@dither-chat/protocol';
import { useEffect, useRef } from 'preact/hooks';
import { loadList } from '../../mail/api.ts';
import { hasMore, listThreads, listTitle, syncLine } from '../../mail/model.ts';
import { db, mailRev } from '../../state.ts';
import { mailChanged } from '../../versions.ts';
import { Empty, Skeleton } from '../bits.tsx';
import { ThreadRow } from './ThreadRow.tsx';

export function ThreadList({ list, active }: { list: string; active?: string }) {
  mailRev.value;
  const s = db.mail;
  const l = s.lists.get(list);
  useEffect(() => {
    if (!l?.loaded && !l?.loading) void loadList(list);
  }, [list, l?.loaded]);
  // Changed by the hub while it was not showing: again, now that it is.
  useEffect(() => {
    const now = db.mail.lists.get(list);
    if (now?.stale && !now.loading) void loadList(list);
  }, [list]);
  const threads = listThreads(s, list);
  const parsed = parseMailList(list);
  const scope = parsed && !('mailbox' in parsed) ? parsed.accountId : null;
  const showAccount = !scope && s.accounts.size > 1;
  const accounts = [...s.accounts.values()].filter((a) => !scope || a.id === scope);
  const syncing = accounts.some((a) => a.sync.phase === 'first' || a.sync.phase === 'relist');
  const line = syncLine(accounts);
  const more = hasMore(l);

  // Near the end: the next page.
  const end = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || !more || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void loadList(list, true), { root: el.closest('.side-scroll'), rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list, more, l?.ids.length]);

  const again = () => {
    if (l) s.lists.set(list, { ...l, dry: false });
    mailChanged();
    void loadList(list, true);
  };
  return (
    <div class="mail-list" aria-label={listTitle(s, list)}>
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} active={t.id === active} account={s.accounts.get(t.accountId)} showAccount={showAccount} list={list} />
      ))}
      {!threads.length && (l?.loading || l?.pending || (!l?.loaded && syncing) ? <Skeleton rows={6} /> : l?.loaded && <Empty icon="mail" title={list === 'v:inbox:*' ? 'Inbox is empty.' : `Nothing in ${listTitle(s, list)}.`} />)}
      {l?.error && (
        <div class="mail-list-note" role="alert">
          Could not load this list: {l.error}{' '}
          <button class="link-btn" onClick={() => void loadList(list, !!l.loaded)}>
            Try again
          </button>
        </div>
      )}
      {more && (
        <button ref={end} class="mail-more" disabled={l?.loading} onClick={() => void loadList(list, true)}>
          {l?.loading ? 'Loading…' : 'Older threads'}
        </button>
      )}
      {l?.pending && threads.length > 0 && <div class="mail-list-note">Fetching older mail from the server…</div>}
      {l?.loaded && !more && !l.complete && !l.pending && !l.error && threads.length > 0 && (
        <div class="mail-list-note">
          {line ? 'More comes as older mail syncs.' : 'Older mail is on the server.'}{' '}
          {!line && (
            <button class="link-btn" onClick={again}>
              Look again
            </button>
          )}
        </div>
      )}
      {line && (threads.length > 0 || l?.loaded) && (
        <div class="mail-list-note mail-sync-line" role="status">
          {line}
        </div>
      )}
    </div>
  );
}
