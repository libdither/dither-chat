/**
 * Mail's side of the screen (docs/mail.md): where mail access stands, accounts that need you, the views (Inbox, Unread,
 * Starred, Sent) and each account's mailboxes, then the list. On a phone it is the list a thread opens over.
 */
import type * as P from '@dither-chat/protocol';
import { mailboxList, viewList } from '@dither-chat/protocol';
import { DEFAULT_LIST, listTitle, MAIL_VIEWS } from '../../mail/model.ts';
import { db, go, mailRev } from '../../state.ts';
import { openMenu, type MenuEntry } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import { ComposeButton, DraftsLine } from './Composer.tsx';
import { MailAccessNote } from './MailAccounts.tsx';
import { LIST_BARS } from './slots.tsx';
import { ThreadList } from './ThreadList.tsx';

/** The manager's page, or its account page. */
const managerLink = (s: typeof db.mail, account?: P.MailAccountView) => account?.managedUrl ?? s.access.managerUrl;

function ProblemStrips() {
  const s = db.mail;
  const bad = [...s.accounts.values()].filter((a) => a.problem || a.level === null);
  return (
    <>
      {bad.map((a) => (
        <div class="mail-problem" role="status">
          <Icon name="alert" size={14} />
          <span>
            <b>{a.address ?? a.label}</b>: {a.level === null ? 'dither-chat no longer has access to it.' : a.problem!.message}
          </span>
          {managerLink(s, a) && (
            <a class="link-btn" href={managerLink(s, a)!} target="_blank" rel="noopener">
              Open in dither-accounts
            </a>
          )}
        </div>
      ))}
    </>
  );
}

function mailboxMenu(s: typeof db.mail, at: { x: number; y: number }) {
  const items: MenuEntry[] = [];
  for (const a of s.accounts.values()) {
    const boxes = [...s.mailboxes.values()].filter((b) => b.accountId === a.id).sort((x, y) => (x.role === 'inbox' ? -1 : y.role === 'inbox' ? 1 : x.path.localeCompare(y.path)));
    if (!boxes.length) continue;
    items.push({ kind: 'label', label: a.address ?? a.label });
    for (const b of boxes) items.push({ label: b.path.replace(/\//g, ' / '), icon: b.role === 'inbox' ? 'inbox' : b.role === 'sent' ? 'send' : b.role === 'trash' ? 'trash' : b.role === 'archive' || b.role === 'all' ? 'archive' : 'folder', run: () => go({ view: 'mail', list: mailboxList(b.id) }) });
  }
  openMenu(at, { items, label: 'Mailboxes', head: <div class="cm-sheet-title">Mailboxes</div> });
}

export function MailSidebar({ list, active }: { list?: string; active?: string }) {
  mailRev.value;
  const s = db.mail;
  const key = list ?? DEFAULT_LIST;
  const accounts = [...s.accounts.values()];
  const scoped = key.startsWith('v:') ? key.split(':')[2] : '*';
  const view = key.startsWith('v:') ? key.split(':')[1] : null;
  const pick = (v: string, acc: string) => go({ view: 'mail', list: viewList(v as P.MailView, acc === '*' ? null : acc) });
  return (
    <div class="sidebar-inner mail-side">
      <header class="side-head">
        <h1>
          Mail
          {accounts.length > 0 && (
            <button
              class={`icon-btn small side-new mail-boxes-btn ${key.startsWith('mb:') ? 'on' : ''}`}
              aria-label="Mailboxes"
              title="Mailboxes"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                mailboxMenu(s, { x: r.left, y: r.bottom + 4 });
              }}
            >
              <Icon name="folder" size={16} />
            </button>
          )}
          <ComposeButton accountId={scoped === '*' ? null : scoped} />
        </h1>
        <span class="side-sub">{key === DEFAULT_LIST ? (accounts.length === 1 ? (accounts[0].address ?? accounts[0].label) : accounts.length ? 'All accounts' : 'Through dither-accounts') : listTitle(s, key)}</span>
      </header>
      <MailAccessNote />
      <ProblemStrips />
      {accounts.length > 0 && (
        <div class="inbox-chips mail-chips" role="radiogroup" aria-label="Show">
          {/* Updates is Inbox's folded row; its chip shows while you are in it. */}
          {MAIL_VIEWS.filter((v) => v.view !== 'updates' || view === 'updates').map((v) => (
            <button class={`chip-btn ${view === v.view ? 'on' : ''}`} role="radio" aria-checked={view === v.view} onClick={() => pick(v.view, scoped)}>
              {v.label}
            </button>
          ))}
          {accounts.length > 1 && view && (
            <select class="mail-acc-pick" aria-label="Account" value={scoped} onChange={(e) => pick(view, (e.target as HTMLSelectElement).value)}>
              <option value="*">All accounts</option>
              {accounts.map((a) => (
                <option value={a.id}>{a.address ?? a.label}</option>
              ))}
            </select>
          )}
        </div>
      )}
      <DraftsLine />
      {LIST_BARS.map((B) => (
        <B list={key} />
      ))}
      <div class="side-scroll">{(accounts.length > 0 || db.mail.threads.size > 0) && <ThreadList list={key} active={active} />}</div>
    </div>
  );
}
