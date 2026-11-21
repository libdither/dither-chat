/**
 * Mail's side of the screen (docs/mail.md): where mail access stands, one line on accounts that are not working, the views (Inbox, Unread,
 * Starred, Sent) in one row of chips and each account's mailboxes, then the list. With several accounts the line under
 * "Mail" picks whose mail the views show. On a phone it is the list a thread opens over.
 */
import type * as P from '@dither-chat/protocol';
import { mailboxList, searchList, searchOfList, viewList } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { accountTrouble, DEFAULT_LIST, holdsOnlyMailboxes, inboxUnread, listTitle, MAIL_VIEWS } from '../../mail/model.ts';
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

/**
 * The accounts with something to say (accountTrouble), drawn again when a start-up's quiet time runs out so a layer
 * still coming up then is said.
 */
function useTrouble(accounts: P.MailAccountView[]) {
  const [now, setNow] = useState(Date.now());
  const all = accounts.map((a) => ({ a, t: accountTrouble(a, now) }));
  const next = Math.min(...all.map(({ t }) => t.at ?? Infinity));
  useEffect(() => {
    if (next === Infinity) return;
    const id = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [next]);
  return new Map(all.flatMap(({ a, t }) => (t.message ? [[a.id, t.message] as const] : [])));
}

/**
 * Accounts that are not working: one quiet line under the header rather than a card each. A line about one account
 * says what is wrong; with several accounts it opens the account menu, where each says its own; with one it opens the
 * account in dither-accounts.
 */
function TroubleLine({ trouble, openPicker }: { trouble: Map<string, string>; openPicker: ((from: HTMLElement) => void) | null }) {
  const s = db.mail;
  if (!trouble.size) return null;
  const [id, message] = [...trouble][0];
  const a = s.accounts.get(id)!;
  const text = trouble.size === 1 ? `${a.address ?? a.label}: ${message}` : `${trouble.size} accounts aren't working`;
  const body = (
    <>
      <Icon name="alert" size={13} />
      <span>{text}</span>
    </>
  );
  if (openPicker) {
    return (
      <button class="mail-problem" title={trouble.size === 1 ? text : 'See which in the account menu'} onClick={(e) => openPicker(e.currentTarget)}>
        {body}
      </button>
    );
  }
  const href = managerLink(s, a);
  return href ? (
    <a class="mail-problem" href={href} target="_blank" rel="noopener" title={`${text}. Open in dither-accounts`}>
      {body}
    </a>
  ) : (
    <div class="mail-problem" role="status" title={text}>
      {body}
    </div>
  );
}

function mailboxMenu(s: typeof db.mail, at: { x: number; y: number }, from: EventTarget | null) {
  const items: MenuEntry[] = [];
  for (const a of s.accounts.values()) {
    const boxes = [...s.mailboxes.values()].filter((b) => b.accountId === a.id && !holdsOnlyMailboxes(b, s.mailboxes.values())).sort((x, y) => (x.role === 'inbox' ? -1 : y.role === 'inbox' ? 1 : x.path.localeCompare(y.path)));
    if (!boxes.length) continue;
    items.push({ kind: 'label', label: a.address ?? a.label });
    for (const b of boxes) items.push({ label: b.path.replace(/\//g, ' / '), icon: b.role === 'inbox' ? 'inbox' : b.role === 'sent' ? 'send' : b.role === 'trash' ? 'trash' : b.role === 'archive' || b.role === 'all' ? 'archive' : 'folder', run: () => go({ view: 'mail', list: mailboxList(b.id) }) });
  }
  openMenu(at, { items, label: 'Mailboxes', head: <div class="cm-sheet-title">Mailboxes</div> }, from);
}

/** Every account's colour in one dot: all of their mail. */
const allDot = (accounts: P.MailAccountView[]) =>
  `conic-gradient(${accounts.map((a, i) => `${a.color} ${(i * 360) / accounts.length}deg ${((i + 1) * 360) / accounts.length}deg`).join(', ')})`;

const PICKER = 'Mail accounts';

const KIND_NAME: Record<string, string> = { imap: 'Email', proton: 'Proton Mail', google: 'Gmail' };

/**
 * The account menu: All accounts and each account with the colour of the dot its threads carry in the lists, its Inbox
 * unread count, and a second line saying what it is or, in the warning colour, what is wrong with it. An account that is
 * not working also gets a way to it in dither-accounts.
 */
function openAccountMenu(from: HTMLElement, accounts: P.MailAccountView[], scoped: string, trouble: Map<string, string>, pick: (account: string) => void) {
  const s = db.mail;
  const current = accounts.find((a) => a.id === scoped) ?? null;
  const r = from.getBoundingClientRect();
  const total = accounts.reduce((n, a) => n + (inboxUnread(s, a.id) ?? 0), 0);
  const broken = accounts.filter((a) => trouble.has(a.id) && managerLink(s, a));
  const items: MenuEntry[] = [
    { label: 'All accounts', dot: allDot(accounts), count: total, checked: !current, radio: true, run: () => pick('*') },
    ...accounts.map(
      (a): MenuEntry => ({
        label: a.address ?? a.label,
        dot: a.color,
        detail: trouble.get(a.id) ?? (a.address ? (KIND_NAME[a.kind] ?? a.label) : (KIND_NAME[a.kind] ?? undefined)),
        warn: trouble.has(a.id),
        count: inboxUnread(s, a.id) ?? undefined,
        checked: current?.id === a.id,
        radio: true,
        run: () => pick(a.id),
      }),
    ),
  ];
  if (broken.length) {
    items.push({ kind: 'sep' });
    for (const a of broken) items.push({ label: broken.length === 1 ? 'Open it in dither-accounts' : `Open ${a.address ?? a.label} in dither-accounts`, icon: 'external', run: () => window.open(managerLink(s, a)!, '_blank', 'noopener') });
  }
  items.push({ kind: 'sep' }, { kind: 'row', render: () => <p class="mail-acc-note">With all accounts showing, a dot in the account's colour comes before each sender's name.</p> });
  openMenu({ x: r.left, y: r.bottom + 4 }, { label: PICKER, head: <div class="cm-sheet-title">Show mail from</div>, items }, from);
}

/** Under "Mail" with several accounts: whose mail the views show, ringed in the warning colour when one is not working. */
function AccountPicker({ accounts, scoped, warn, open }: { accounts: P.MailAccountView[]; scoped: string; warn: boolean; open: (from: HTMLElement) => void }) {
  const current = accounts.find((a) => a.id === scoped) ?? null;
  return (
    <button class="mail-acc-btn" aria-haspopup="menu" aria-expanded={contextMenu.value?.label === PICKER} title="Whose mail to show" onClick={(e) => open(e.currentTarget)}>
      <span class={`mail-acc-dot ${warn ? 'warn' : ''}`} style={{ background: current ? current.color : allDot(accounts) }} aria-hidden="true" />
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
  const trouble = useTrouble(accounts);
  const picker = search === null && view && accounts.length > 1;
  const openPicker = (from: HTMLElement) => openAccountMenu(from, accounts, scoped, trouble, (acc) => pick(view ?? 'inbox', acc));
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
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = row.current;
    const on = el?.querySelector<HTMLElement>('.chip-btn.on');
    // Mail opening on its first chip: nothing to scroll, and the ResizeObserver below sets the edges once the row is
    // laid out. Measuring here forced the layout of the whole page into the task that drew it (140 ms at 4x on a phone).
    const first = !opened.current && on === el?.querySelector('.chip-btn');
    if (el) opened.current = true;
    if (first) return;
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
                mailboxMenu(s, { x: r.left, y: r.bottom + 4 }, e.currentTarget);
              }}
            >
              <Icon name="folder" size={16} />
            </button>
          )}
          <ComposeButton accountId={scoped === '*' ? null : scoped} />
        </h1>
        {picker ? (
          <AccountPicker accounts={accounts} scoped={scoped} warn={[...trouble.keys()].some((id) => scoped === '*' || id === scoped)} open={openPicker} />
        ) : (
          <span class="side-sub">{search !== null ? 'Search' : view ? (accounts.length === 1 ? (accounts[0].address ?? accounts[0].label) : 'Through dither-accounts') : listTitle(s, key)}</span>
        )}
      </header>
      <MailAccessNote />
      <TroubleLine trouble={trouble} openPicker={picker ? openPicker : null} />
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
