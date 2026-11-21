/**
 * Mail's side of the screen (docs/mail.md): where mail access stands, whose mail (two wheels, with muted warnings), the
 * views (Inbox ranked or newest first, Everything, Updates) in one row of chips, Starred, Sent and each account's
 * mailboxes in the folder menu, then the list. With several accounts the line under
 * "Mail" picks whose mail the views show. On a phone it is the list a thread opens over.
 */
import type * as P from '@dither-chat/protocol';
import { MAIL_PLATFORM_NAMES, mailboxList, mailPlatform, platformScope, searchList, searchOfList, viewList } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { accountTrouble, DEFAULT_LIST, holdsOnlyMailboxes, inboxUnread, listTitle, MAIL_FOLDER_VIEWS, MAIL_VIEWS } from '../../mail/model.ts';
import { db, go, mailRev, pref, setPrefs } from '../../state.ts';
import { openMenu, type MenuEntry } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import { ComposeButton, DraftsLine } from './Composer.tsx';
import { MailAccessNote } from './MailAccounts.tsx';
import { LIST_BARS } from './slots.tsx';
import { MailSearch } from './MailSearch.tsx';
import { ScopeWheel, type WheelItem } from './ScopeWheel.tsx';
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

/** The folder menu: Starred and Sent of the scope in use (newest first), then each account's mailboxes. */
function mailboxMenu(s: typeof db.mail, scope: string, at: { x: number; y: number }, from: EventTarget | null) {
  const items: MenuEntry[] = MAIL_FOLDER_VIEWS.map((v) => {
    const k = viewList(v.view, scope === '*' ? null : scope);
    return { label: v.label, icon: v.view === 'starred' ? 'star' : 'send', run: () => go({ view: 'mail', list: k }) };
  });
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

/**
 * Under "Mail": whose mail the views show, as two wheels (ScopeWheel): the platform (All mail, Gmail, Proton…) when
 * there is more than one, then the account (All of that platform's, or one) when it has more than one. An account that
 * has not worked for PROBLEM_GRACE_MS gets a muted warning sign, as do the platform and All that hold it. A right-click
 * or long press on the account wheel opens the account menu, with each account's unread count and its problem.
 */
function ScopeWheels({ accounts, scope, trouble, pickScope, openMenu }: { accounts: P.MailAccountView[]; scope: string; trouble: Map<string, string>; pickScope: (scope: string) => void; openMenu: (from: HTMLElement) => void }) {
  const platformOf = (a: P.MailAccountView) => mailPlatform(a);
  const platforms = [...new Set(accounts.map(platformOf))];
  const account = accounts.find((a) => a.id === scope) ?? null;
  const platform = account ? platformOf(account) : scope.startsWith('k.') ? scope.slice(2) : null;
  const inPlatform = accounts.filter((a) => !platform || platformOf(a) === platform);
  const warnOf = (as: P.MailAccountView[]) => {
    const bad = as.filter((a) => trouble.has(a.id));
    return bad.length ? bad.map((a) => `${a.address ?? a.label}: ${trouble.get(a.id)}`).join('\n') : null;
  };
  const name = (p: string) => MAIL_PLATFORM_NAMES[p] ?? p;
  const platformItems: WheelItem[] = [
    { key: '*', label: 'All mail', dot: allDot(accounts), warn: warnOf(accounts) },
    ...platforms.map((p) => {
      const as = accounts.filter((a) => platformOf(a) === p);
      return { key: platformScope(p), label: name(p), dot: as.length === 1 ? as[0].color : allDot(as), warn: warnOf(as) };
    }),
  ];
  const allKey = platform ? platformScope(platform) : '*';
  const accountItems: WheelItem[] = [
    { key: allKey, label: platform ? `All ${name(platform)}` : 'All accounts', dot: allDot(inPlatform), warn: warnOf(inPlatform) },
    ...inPlatform.map((a) => ({ key: a.id, label: a.address ?? a.label, dot: a.color, warn: trouble.get(a.id) ?? null })),
  ];
  const showPlatforms = platforms.length > 1;
  const showAccounts = inPlatform.length > 1;
  return (
    <div class="scope-wheels">
      {showPlatforms && <ScopeWheel label="Platform" track="mail: platform wheel" items={platformItems} at={Math.max(0, platformItems.findIndex((i) => i.key === (platform ? platformScope(platform) : '*')))} pick={pickScope} onMenu={openMenu} />}
      {showPlatforms && showAccounts && <span class="scope-sep" aria-hidden="true">›</span>}
      {showAccounts && <ScopeWheel label="Account" track="mail: account wheel" items={accountItems} at={Math.max(0, accountItems.findIndex((i) => i.key === (account ? account.id : allKey)))} pick={pickScope} onMenu={openMenu} />}
      {!showPlatforms && !showAccounts && accounts[0] && (
        <span class="side-sub">
          {accounts[0].address ?? accounts[0].label}
          {trouble.has(accounts[0].id) && (
            <a class="scope-warn" title={`${trouble.get(accounts[0].id)}. Open in dither-accounts`} href={accounts[0].managedUrl ?? undefined} target="_blank" rel="noopener">
              <Icon name="alert" size={11} />
            </a>
          )}
        </span>
      )}
    </div>
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
  const newest = pref('mailOrder') === 'newest';
  const trouble = useTrouble(accounts);
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
              class={`icon-btn small side-new mail-boxes-btn ${key.startsWith('mb:') || view === 'starred' || view === 'sent' ? 'on' : ''}`}
              aria-label="Starred, Sent and mailboxes"
              title="Starred, Sent and mailboxes"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                mailboxMenu(s, scoped, { x: r.left, y: r.bottom + 4 }, e.currentTarget);
              }}
            >
              <Icon name="folder" size={16} />
            </button>
          )}
          <ComposeButton accountId={scoped === '*' || scoped.startsWith('k.') ? null : scoped} />
        </h1>
        {search === null && view && accounts.length > 0 ? (
          <ScopeWheels accounts={accounts} scope={scoped} trouble={trouble} pickScope={(sc) => pick(view, sc)} openMenu={openPicker} />
        ) : (
          <span class="side-sub">{search !== null ? 'Search' : view ? 'Through dither-accounts' : listTitle(s, key)}</span>
        )}
      </header>
      <MailAccessNote />
      {search !== null && <MailSearch q={search} active={active} />}
      {chips && (
        <div class="inbox-chips mail-chips" role="radiogroup" aria-label="Show" ref={row} onScroll={edges}>
          {MAIL_VIEWS.map((v) => {
            const on = view === v.view;
            // Inbox's chip names its order; tapped again, it turns to the other (docs/mail.md "Ranked").
            const order = v.view === 'inbox' ? (newest ? 'Newest' : 'Ranked') : null;
            const flip = order && on ? (newest ? 'Sort by importance' : 'Sort newest first') : undefined;
            return (
              <button
                class={`chip-btn ${on ? 'on' : ''} ${order ? 'mail-order-chip' : ''}`}
                role="radio"
                aria-checked={on}
                title={flip}
                data-track={flip ? `mail: ${newest ? 'ranked' : 'newest'}` : undefined}
                onClick={() => (flip ? setPrefs({ mailOrder: newest ? 'ranked' : 'newest' }) : pick(v.view, scoped))}
              >
                {order ?? v.label}
                {flip && <Icon name="repeat" size={11} />}
              </button>
            );
          })}
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
