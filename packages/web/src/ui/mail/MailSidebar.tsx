/**
 * A mail list in the Inbox's place (docs/mail.md "Mail as chats", docs/inbox.md "Mail lists"): mail is chats, and its
 * threads live in the Inbox and in people's chats; this is what mail has besides, as lists. Where mail access stands,
 * whose mail (two wheels, with muted warnings), then the list. On a phone it is the list a thread opens over.
 */
import type * as P from '@dither-chat/protocol';
import { MAIL_PLATFORM_NAMES, mailPlatform, platformScope, searchOfList, viewList } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { accountTrouble, inboxUnread } from '../../mail/model.ts';
import { db, go, mailRev } from '../../state.ts';
import { openMenu, type MenuEntry } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import { DraftsLine } from './Composer.tsx';
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

/**
 * A mail list in the Inbox's place (`#/?mail=<list>`): Updates, Everything, Starred, Sent, a mailbox or a search in
 * one, under the Inbox's own header and chips (ui/Sidebar.tsx InboxSidebar, MailChat.tsx MailListChips), so nothing
 * above a list moves as you change lists. Writing a mail is the header's +.
 */
export function MailSidebar({ list, active }: { list: string; active?: string }) {
  mailRev.value;
  const s = db.mail;
  const key = list;
  const accounts = [...s.accounts.values()];
  const scoped = (key.startsWith('v:') && key.split(':')[2]) || '*';
  const view = key.startsWith('v:') ? key.split(':')[1] : null;
  const pick = (v: string, acc: string) => go({ view: 'inbox', mail: viewList(v as P.MailView, acc === '*' ? null : acc) }, true);
  const search = searchOfList(key);
  const trouble = useTrouble(accounts);
  const openPicker = (from: HTMLElement) => openAccountMenu(from, accounts, scoped, trouble, (acc) => pick(view ?? 'all', acc));
  return (
    <div class="mail-side">
      <MailAccessNote />
      {search === null && view && accounts.length > 1 ? <ScopeWheels accounts={accounts} scope={scoped} trouble={trouble} pickScope={(sc) => pick(view, sc)} openMenu={openPicker} /> : null}
      {search !== null && <MailSearch q={search} active={active} />}
      {search === null && <DraftsLine />}
      {search === null &&
        LIST_BARS.map((B) => (
          <B list={key} />
        ))}
      {search === null && <div class="side-scroll">{(accounts.length > 0 || db.mail.threads.size > 0) && <ThreadList list={key} active={active} />}</div>}
    </div>
  );
}
