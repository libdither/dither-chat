/**
 * A list of threads, newest first (docs/mail.md). It shows what is at hand at once (the bootstrap's window), loads its
 * first page from the hub, and more on request. Slice 2 makes it scroll on by itself and adds the sync progress line.
 */
import { parseMailList } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { loadList } from '../../mail/api.ts';
import { listThreads, listTitle } from '../../mail/model.ts';
import { db, mailRev } from '../../state.ts';
import { Empty, Skeleton } from '../bits.tsx';
import { ThreadRow } from './ThreadRow.tsx';

export function ThreadList({ list, active }: { list: string; active?: string }) {
  mailRev.value;
  const s = db.mail;
  const l = s.lists.get(list);
  useEffect(() => {
    if (!l?.loaded && !l?.loading) void loadList(list);
  }, [list, l?.loaded]);
  const threads = listThreads(s, list);
  const parsed = parseMailList(list);
  const scope = parsed && !('mailbox' in parsed) ? parsed.accountId : null;
  const showAccount = !scope && s.accounts.size > 1;
  const syncing = [...s.accounts.values()].some((a) => a.sync.phase === 'first' || a.sync.phase === 'relist');
  return (
    <div class="mail-list" aria-label={listTitle(s, list)}>
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} active={t.id === active} account={s.accounts.get(t.accountId)} showAccount={showAccount} list={list} />
      ))}
      {!threads.length && (l?.loading || (!l?.loaded && syncing) ? <Skeleton rows={6} /> : l?.loaded && <Empty icon="mail" title={list === 'v:inbox:*' ? 'Inbox is empty.' : `Nothing in ${listTitle(s, list)}.`} />)}
      {l?.error && (
        <div class="mail-list-note" role="alert">
          Could not load this list: {l.error}{' '}
          <button class="link-btn" onClick={() => void loadList(list)}>
            Try again
          </button>
        </div>
      )}
      {l?.loaded && l.next && (
        <button class="mail-more" disabled={l.loading} onClick={() => void loadList(list, true)}>
          {l.loading ? 'Loading…' : 'Older threads'}
        </button>
      )}
      {l?.loaded && !l.next && !l.complete && threads.length > 0 && <div class="mail-list-note">Older mail is on the server only for now.</div>}
      {syncing && threads.length > 0 && <div class="mail-list-note">Syncing…</div>}
    </div>
  );
}
