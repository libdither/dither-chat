import { searchOp } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { accountsNeedingYou, pingedCount, sumUnread, visibleConv } from '../model.ts';
import { api, back, connected, db, go, loaded, pending, prefs, previousRoute, readProgress, refresh, rev, route, unreachable, type Route } from '../state.ts';
import { dropLayer, phone, pushLayer } from '../phone.ts';
import { AccountPane, AccountsSidebar, AddAccount, addingAccount } from './Accounts.tsx';
import { ConversationDetails, PersonDetails } from './Details.tsx';
import { DirectoryPane } from './Directory.tsx';
import { DragLayer } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { ContextMenuLayer } from './ContextMenu.tsx';
import { ForwardLayer } from './Forward.tsx';
import { InboxBoard } from './Inbox.tsx';
import { NewMessage } from './NewMessage.tsx';
import { ReactionLayer } from './Reactions.tsx';
import { ProfilePane } from './Profile.tsx';
import { Rail } from './Rail.tsx';
import { TitleBar } from './TitleBar.tsx';
import { SearchPane } from './Search.tsx';
import { SettingsPane } from './Settings.tsx';
import { FolderSidebar, InboxSidebar, PeopleSidebar, SpaceSidebar, SpacesSidebar } from './Sidebar.tsx';
import { ConversationPane, PersonPane } from './Timeline.tsx';
import { Switcher } from './Switcher.tsx';
import { Toasts } from './Toasts.tsx';
import { CallDock } from './Call.tsx';
import { Viewer } from './Viewer.tsx';
import { AboutLayer } from './About.tsx';
import { PEEK, panel, usePager, type Rest } from './Pager.ts';
import { Skeleton } from './bits.tsx';
import { applyUpdate, updateReady } from '../pwa.ts';

/** What the center pane shows, and whether a details pane is available. */
function centerFor(r: Route, back: () => void): { pane: any; detail?: { kind: 'conv' | 'person'; id: string } } {
  switch (r.view) {
    case 'triage':
      return { pane: <InboxBoard /> };
    case 'inbox':
      return r.conv ? { pane: <ConversationPane convId={r.conv} focus={r.msg} onBack={back} />, detail: { kind: 'conv', id: r.conv } } : { pane: <InboxBoard /> };
    case 'people':
      return r.person ? { pane: <PersonPane personId={r.person} onBack={back} />, detail: { kind: 'person', id: r.person } } : { pane: <WelcomePane view="people" /> };
    case 'profile':
      return { pane: <ProfilePane personId={r.person} identityId={r.identity} onBack={back} /> };
    case 'space':
      return r.conv ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: { kind: 'conv', id: r.conv } } : { pane: <WelcomePane view="space" id={r.space} /> };
    case 'folder':
      return r.conv
        ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: { kind: 'conv', id: r.conv } }
        : r.person
          ? { pane: <PersonPane personId={r.person} onBack={back} />, detail: { kind: 'person', id: r.person } }
          : { pane: <WelcomePane view="folder" id={r.folder} /> };
    case 'spaces':
      return { pane: <WelcomePane view="space" /> };
    case 'accounts':
      return r.account ? { pane: <AccountPane accountId={r.account} onBack={back} /> } : { pane: <WelcomePane view="accounts" /> };
    case 'settings':
      return { pane: <SettingsPane /> };
    case 'directory':
      return { pane: <DirectoryPane /> };
    case 'search':
      return r.conv ? { pane: <ConversationPane convId={r.conv} focus={r.msg} onBack={back} />, detail: { kind: 'conv', id: r.conv } } : { pane: <SearchPane q={r.q} /> };
  }
}

function sidebarFor(r: Route, onAdd: () => void) {
  switch (r.view) {
    case 'triage':
      return <InboxSidebar />;
    case 'inbox':
      return <InboxSidebar activeConv={r.conv} />;
    case 'people':
      return <PeopleSidebar activePerson={r.person} />;
    case 'profile':
      return <PeopleSidebar activePerson={r.person} />;
    case 'space':
      return <SpaceSidebar spaceId={r.space} activeConv={r.conv} />;
    case 'spaces':
      return <SpacesSidebar />;
    case 'folder':
      return <FolderSidebar folderId={r.folder} activeConv={r.conv} activePerson={r.person} />;
    case 'accounts':
      return <AccountsSidebar active={r.account} onAdd={onAdd} />;
    case 'settings':
      return <div class="sidebar-inner settings-side"><SettingsNav /></div>;
    case 'directory':
      return <SpacesSidebar />;
    case 'search':
      return <InboxSidebar activeConv={r.conv} />;
  }
}

function SettingsNav() {
  return (
    <>
      <header class="side-head">
        <h1>Settings</h1>
        <span class="side-sub">Rules, triage and appearance</span>
      </header>
      <div class="side-scroll">
        {[
          ['Default notifications', 'bell', 'set-defaults'],
          ['Smart triage', 'sparkles', 'set-triage'],
          ['Push and quiet hours', 'bellOff', 'push'],
          ['Each device', 'phone', 'set-devices'],
          ['Keywords', 'at', 'set-keywords'],
          ['Per-place overrides', 'layers', 'set-overrides'],
          ['Privacy', 'lock', 'set-privacy'],
          ['Appearance', 'eye', 'set-appearance'],
        ].map(([t, i, id]) => (
          <button class="settings-nav-item" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <Icon name={i} size={16} /> {t}
          </button>
        ))}
        <button class="settings-nav-item" onClick={() => go({ view: 'accounts' })}>
          <Icon name="power" size={16} /> Accounts
        </button>
      </div>
    </>
  );
}

function WelcomePane({ view, id }: { view: string; id?: string }) {
  const space = view === 'space' && id ? db.spaces.get(id) : undefined;
  const folder = view === 'folder' && id ? db.folders.find((f) => f.id === id) : undefined;
  const titles: Record<string, { h: string; p: string; icon: string }> = {
    people: db.persons.size > 1
      ? { h: 'People', p: 'Pick a person to see every DM you have with them, on every network, in one thread.', icon: 'users' }
      : { h: 'No one here yet', p: 'People show up once an account has a direct message with them.', icon: 'users' },
    space: { h: space?.name ?? 'Communities', p: space ? 'Pick a channel on the left.' : 'Pick a server or space, then a channel.', icon: 'hash' },
    folder: { h: folder?.name ?? 'Folder', p: 'A custom grouping that spans networks. Pick anything on the left.', icon: 'folder' },
    accounts: { h: 'Accounts', p: 'Pick an account to check its status, or add a new one.', icon: 'power' },
  };
  const t = titles[view] ?? titles.space;
  return (
    <section class="pane welcome">
      <div class="welcome-inner">
        <Icon name={t.icon} size={40} />
        <h2>{t.h}</h2>
        <p>{t.p}</p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the phone's layout

/** A page that slides in over the lists, with somewhere to go back to. */
function isDetail(r: Route): boolean {
  switch (r.view) {
    case 'search':
      // Searching one conversation is a page of that conversation, with the way back to it.
      return !!r.conv || !!searchOp(r.q, 'in');
    case 'inbox':
    case 'space':
      return !!r.conv;
    case 'people':
      return !!r.person;
    case 'folder':
      return !!(r.conv || r.person);
    case 'accounts':
      return !!r.account;
    case 'profile':
    case 'directory':
      return true;
    default:
      return false;
  }
}
/** A tab's own page: full screen, with the tab bar under it. */
const isTabRoot = (r: Route) => r.view === 'triage' || r.view === 'settings' || (r.view === 'search' && !isDetail(r));
/** The list a page belongs to. The list shows that page peeking at its edge. */
function listOf(r: Route): string {
  if (r.view === 'space') return `space:${r.space}`;
  if (r.view === 'folder') return `folder:${r.folder}`;
  if (r.view === 'profile') return 'people';
  if (r.view === 'directory') return 'spaces';
  return r.view;
}
/** Where the back button goes from a page when there is no history to go back through. */
function listRoute(r: Route): Route {
  switch (r.view) {
    case 'space':
      return { view: 'space', space: r.space };
    case 'folder':
      return { view: 'folder', folder: r.folder };
    case 'search':
      return { view: 'search', q: r.conv ? r.q : '' };
    case 'profile':
      return { view: 'people' };
    case 'directory':
      return { view: 'spaces' };
    default:
      return { view: r.view } as Route;
  }
}

type Tab = 'home' | 'triage' | 'search' | 'you';
const tabOf = (r: Route): Tab => (r.view === 'triage' ? 'triage' : r.view === 'search' ? 'search' : r.view === 'settings' || r.view === 'accounts' ? 'you' : 'home');

/** The last page and the last list on the Home tab, which a phone keeps while you look elsewhere. */
let lastDetail: Route | null = null;
let lastHome: Route = { view: 'inbox' };

function TabBar({ r }: { r: Route }) {
  const tab = tabOf(r);
  const all = sumUnread([...db.conversations.values()].filter(visibleConv)).badge;
  const attention = [...db.accounts.values()].some((a) => a.attention);
  const tabs: { id: Tab; label: string; icon: string; to: () => Route; badge?: number; dot?: boolean }[] = [
    { id: 'home', label: 'Home', icon: 'home', to: () => lastHome, badge: all },
    { id: 'triage', label: 'Triage', icon: 'bell', to: () => ({ view: 'triage' }), badge: pingedCount() + accountsNeedingYou().length },
    { id: 'search', label: 'Search', icon: 'search', to: () => ({ view: 'search', q: '' }) },
    { id: 'you', label: 'You', icon: 'user', to: () => ({ view: 'settings' }), dot: attention },
  ];
  return (
    <nav class="tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <button class={`tab ${tab === t.id ? 'active' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.to())}>
          <span class="tab-icon">
            <Icon name={t.icon} size={22} />
            {!!t.badge && <span class="tab-badge">{t.badge > 99 ? '99+' : t.badge}</span>}
            {t.dot && <span class="tab-dot" />}
          </span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function App() {
  rev.value;
  const r = route.value;
  const p = phone.value;
  // The installed app's icon shows what wants you, where the platform has badges.
  const badge = loaded.value ? sumUnread([...db.conversations.values()].filter(visibleConv)).badge : 0;
  useEffect(() => {
    if ('setAppBadge' in navigator) (badge ? navigator.setAppBadge(badge) : navigator.clearAppBadge()).catch(() => {});
  }, [badge]);
  // A mark-all-read can outlive the page that started it.
  useEffect(() => {
    api<{ pending: number }>('/api/read-all').then((p) => (readProgress.value = { pending: p.pending, failed: 0 })).catch(() => {});
  }, []);

  // On a phone the page you are on is a card over the lists; see Pager.ts.
  const detailRoute = isDetail(r);
  const tabRoot = isTabRoot(r);
  if (detailRoute) lastDetail = r;
  else if (!tabRoot && tabOf(r) === 'home') lastHome = r;
  const shown = p && !detailRoute && !tabRoot && lastDetail ? lastDetail : r;
  const { pane, detail } = centerFor(shown, () => back(listRoute(shown)));
  const details = p ? panel.value === 'details' && !!detail : prefs.value.details && !!detail;
  const rest: Rest = !p ? 'open' : detailRoute || tabRoot ? (details ? 'details' : 'open') : lastDetail && listOf(lastDetail) === listOf(r) ? 'peek' : 'away';
  const after = previousRoute() ?? listRoute(r);
  const backRest: Rest | null = !detailRoute ? null : isDetail(after) || isTabRoot(after) ? 'open' : listOf(after) === listOf(r) ? 'peek' : 'away';

  // The details panel is a layer: back closes it before it leaves the page.
  const detailsOpen = p && panel.value === 'details';
  useLayoutEffect(() => {
    if (!detailsOpen) return;
    const id = pushLayer(() => (panel.value = 'main'));
    return () => dropLayer(id);
  }, [detailsOpen]);
  useEffect(() => {
    if (!detail && panel.value === 'details') panel.value = 'main';
  });

  const app = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const pull = useRef<HTMLDivElement>(null);
  usePager(app, card, pull, {
    ready: loaded.value,
    rest,
    back: backRest,
    details: !!detail,
    onBack: () => back(listRoute(r)),
    onDetails: (open) => (panel.value = open ? 'details' : 'main'),
    onForward: () => lastDetail && go(lastDetail),
    onRefresh: refresh,
  });

  if (!loaded.value)
    return (
      <div class="loading-screen">
        <div class="loading-skeleton" aria-hidden="true">
          <Skeleton rows={9} />
        </div>
        <div class="loading-note">
          <div class="spinner" />
          <span>{connected.value ? 'Loading your conversations…' : 'Connecting to the hub…'}</span>
        </div>
      </div>
    );

  const full = r.view === 'directory';
  const tabs = p && (tabRoot || rest === 'peek' || rest === 'away');
  // While a page is open or peeking, the list beside it leaves room for its edge.
  const narrow = p && (detailRoute || rest === 'peek');
  return (
    <div
      ref={app}
      class={`app ${p ? `phone rest-${rest}` : ''} ${!p && details ? 'with-details' : ''} ${full ? 'full' : ''} ${tabs ? 'tabs' : ''} ${tabRoot ? 'tab-root' : ''} ${narrow ? 'narrow' : ''}`}
      style={{ '--peek': `${PEEK}px` } as any}
    >
      {/* Short drops go unmentioned: the app shows what it has and catches up when the hub is back (docs/sync.md). */}
      {(unreachable.value || (!connected.value && pending.value.some((x) => x.queued))) && (
        <div class="reconnect" role="status">
          <span class="dot" /> Can't reach the hub · showing what this device has
        </div>
      )}
      {updateReady.value && (
        <button class="update-bar" onClick={applyUpdate}>
          <Icon name="refresh" size={14} /> A new version is ready. Tap to reload.
        </button>
      )}
      {(readProgress.value.pending > 0 || readProgress.value.failed > 0) && (
        <div class="read-progress" role="status" onClick={() => (readProgress.value = { ...readProgress.value, failed: 0 })}>
          <Icon name="check" size={13} />
          <span>
            {readProgress.value.pending > 0 ? `Telling the networks: ${readProgress.value.pending} left` : 'Read everywhere it could be'}
            {readProgress.value.failed > 0 && `, ${readProgress.value.failed} would not go through`}
          </span>
        </div>
      )}
      {!p && <TitleBar />}
      <Rail />
      <aside class="sidebar">{sidebarFor(r, () => (addingAccount.value = true))}</aside>
      <main class="center" ref={card} inert={rest === 'away'}>
        {pane}
        {p && (rest === 'peek' || rest === 'details') && (
          <button
            class="card-shield"
            aria-label={rest === 'peek' ? 'Back to the conversation' : 'Close the details'}
            onClick={() => (rest === 'peek' ? lastDetail && go(lastDetail) : (panel.value = 'main'))}
          />
        )}
      </main>
      {(p ? !!detail : details) && <>{detail!.kind === 'conv' ? <ConversationDetails convId={detail!.id} /> : <PersonDetails personId={detail!.id} />}</>}
      {p && <TabBar r={r} />}
      {p && (
        <div class="ptr" ref={pull} aria-hidden="true">
          <Icon name="refresh" size={18} />
        </div>
      )}
      {addingAccount.value && <AddAccount onClose={() => (addingAccount.value = false)} />}
      <CallDock />
      <ReactionLayer />
      <Toasts />
      <DragLayer />
      <ContextMenuLayer />
      <ForwardLayer />
      <AboutLayer />
      <Switcher />
      <NewMessage />
      <Viewer />
    </div>
  );
}
