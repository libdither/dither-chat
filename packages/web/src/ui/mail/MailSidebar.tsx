/**
 * Mail's side of the screen (docs/mail.md): where mail access stands, accounts that need you, the views (Inbox, Unread,
 * Starred, Sent) in one row of chips and each account's mailboxes, then the list. With several accounts the line under
 * "Mail" picks whose mail the views show. On a phone it is the list a thread opens over.
 */
import type * as P from '@dither-chat/protocol';
import { mailboxList, searchList, searchOfList, viewList } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { DEFAULT_LIST, holdsOnlyMailboxes, listTitle, MAIL_VIEWS } from '../../mail/model.ts';
import { db, go, mailRev } from '../../state.ts';
import { contextMenu, openMenu, type MenuEntry } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import { ComposeButton, DraftsLine } from './Composer.tsx';
import { MailAccessNote } from './MailAccounts.tsx';
import { LIST_BARS } from './slots.tsx';
import { MailSearch } from './MailSearch.tsx';
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
    const boxes = [...s.mailboxes.values()].filter((b) => b.accountId === a.id && !holdsOnlyMailboxes(b, s.mailboxes.values())).sort((x, y) => (x.role === 'inbox' ? -1 : y.role === 'inbox' ? 1 : x.path.localeCompare(y.path)));
    if (!boxes.length) continue;
    items.push({ kind: 'label', label: a.address ?? a.label });
    for (const b of boxes) items.push({ label: b.path.replace(/\//g, ' / '), icon: b.role === 'inbox' ? 'inbox' : b.role === 'sent' ? 'send' : b.role === 'trash' ? 'trash' : b.role === 'archive' || b.role === 'all' ? 'archive' : 'folder', run: () => go({ view: 'mail', list: mailboxList(b.id) }) });
  }
  openMenu(at, { items, label: 'Mailboxes', head: <div class="cm-sheet-title">Mailboxes</div> });
}

/** Every account's colour in one dot: all of their mail. */
const allDot = (accounts: P.MailAccountView[]) =>
  `conic-gradient(${accounts.map((a, i) => `${a.color} ${(i * 360) / accounts.length}deg ${((i + 1) * 360) / accounts.length}deg`).join(', ')})`;

const PICKER = 'Mail accounts';

/**
 * Under "Mail" with several accounts: whose mail the views show. A menu of All accounts and each account, each with
 * the colour of the dot its threads carry in the lists, and a line saying what those dots are.
 */
function AccountPicker({ accounts, scoped, pick }: { accounts: P.MailAccountView[]; scoped: string; pick: (account: string) => void }) {
  const current = accounts.find((a) => a.id === scoped) ?? null;
  const open = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(
      { x: r.left, y: r.bottom + 4 },
      {
        label: PICKER,
        head: <div class="cm-sheet-title">Show mail from</div>,
        items: [
          { label: 'All accounts', dot: allDot(accounts), checked: !current, radio: true, run: () => pick('*') },
          ...accounts.map((a): MenuEntry => ({ label: a.address ?? a.label, dot: a.color, checked: current?.id === a.id, radio: true, run: () => pick(a.id) })),
          { kind: 'sep' },
          { kind: 'row', render: () => <p class="mail-acc-note">With all accounts showing, a dot in the account's colour comes before each sender's name.</p> },
        ],
      },
    );
  };
  return (
    <button class="mail-acc-btn" aria-haspopup="menu" aria-expanded={contextMenu.value?.label === PICKER} title="Whose mail to show" onClick={open}>
      <span class="mail-acc-dot" style={{ background: current ? current.color : allDot(accounts) }} aria-hidden="true" />
      <span class="mail-acc-name">{current ? (current.address ?? current.label) : 'All accounts'}</span>
      <Icon name="chevronDown" size={12} />
    </button>
  );
}

export function MailSidebar({ list, active }: { list?: string; active?: string }) {
  mailRev.value;
  const s = db.mail;
  const key = list ?? DEFAULT_LIST;
  const accounts = [...s.accounts.values()];
  const scoped = key.startsWith('v:') ? key.split(':')[2] : '*';
  const view = key.startsWith('v:') ? key.split(':')[1] : null;
  const pick = (v: string, acc: string) => go({ view: 'mail', list: viewList(v as P.MailView, acc === '*' ? null : acc) });
  const search = searchOfList(key);
  const chips = search === null && accounts.length > 0;
  const row = useRef<HTMLDivElement>(null);
  // An edge with more chips past it fades out.
  const edges = () => {
    const el = row.current;
    if (!el) return;
    el.classList.toggle('fade-l', el.scrollLeft > 2);
    el.classList.toggle('fade-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  // One row that scrolls sideways: the chosen chip is brought into it.
  useLayoutEffect(() => {
    const el = row.current;
    const on = el?.querySelector<HTMLElement>('.chip-btn.on');
    if (el && on) {
      const r = el.getBoundingClientRect();
      const c = on.getBoundingClientRect();
      if (c.left < r.left + 8) el.scrollLeft -= r.left + 12 - c.left;
      else if (c.right > r.right - 8) el.scrollLeft += c.right - r.right + 12;
    }
    edges();
  }, [view, chips]);
  useEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(edges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chips]);
  return (
    <div class="sidebar-inner mail-side">
      <header class="side-head">
        <h1>
          Mail
          {accounts.length > 0 && (
            <button class={`icon-btn small side-new mail-search-btn ${search !== null ? 'on' : ''}`} aria-label="Search mail" title="Search mail" onClick={() => go(search !== null ? { view: 'mail' } : { view: 'mail', list: searchList('') })}>
              <Icon name="search" size={16} />
            </button>
          )}
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
        {search === null && view && accounts.length > 1 ? (
          <AccountPicker accounts={accounts} scoped={scoped} pick={(acc) => pick(view, acc)} />
        ) : (
          <span class="side-sub">{search !== null ? 'Search' : view ? (accounts.length === 1 ? (accounts[0].address ?? accounts[0].label) : 'Through dither-accounts') : listTitle(s, key)}</span>
        )}
      </header>
      <MailAccessNote />
      <ProblemStrips />
      {search !== null && <MailSearch q={search} active={active} />}
      {chips && (
        <div class="inbox-chips mail-chips" role="radiogroup" aria-label="Show" ref={row} onScroll={edges}>
          {/* Updates is Inbox's folded row; its chip shows while you are in it. */}
          {MAIL_VIEWS.filter((v) => v.view !== 'updates' || view === 'updates').map((v) => (
            <button class={`chip-btn ${view === v.view ? 'on' : ''}`} role="radio" aria-checked={view === v.view} onClick={() => pick(v.view, scoped)}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      {search === null && <DraftsLine />}
      {search === null &&
        LIST_BARS.map((B) => (
          <B list={key} />
        ))}
      {search === null && <div class="side-scroll">{(accounts.length > 0 || db.mail.threads.size > 0) && <ThreadList list={key} active={active} />}</div>}
    </div>
  );
}
