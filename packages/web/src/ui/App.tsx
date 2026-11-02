import { useEffect, useState } from 'preact/hooks';
import { sumUnread, visibleConv } from '../model.ts';
import { api, connected, db, go, loaded, prefs, readProgress, rev, route, toasts, type Route } from '../state.ts';
import { AccountPane, AccountsSidebar, AddAccount } from './Accounts.tsx';
import { ConversationDetails, PersonDetails } from './Details.tsx';
import { DirectoryPane } from './Directory.tsx';
import { DragLayer } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { PlaceMenu } from './Organize.tsx';
import { InboxBoard } from './Inbox.tsx';
import { ReactionLayer } from './Reactions.tsx';
import { ProfilePane } from './Profile.tsx';
import { Rail } from './Rail.tsx';
import { SearchPane } from './Search.tsx';
import { SettingsPane } from './Settings.tsx';
import { FolderSidebar, GroupsSidebar, InboxSidebar, PeopleSidebar, SpaceSidebar, SpacesSidebar } from './Sidebar.tsx';
import { ConversationPane, PersonPane } from './Timeline.tsx';
import { Switcher } from './Switcher.tsx';
import { Toasts } from './Toasts.tsx';
import { applyUpdate, updateReady } from '../pwa.ts';

/** What the center pane shows, and whether a details pane is available. */
function centerFor(r: Route, back: () => void): { pane: any; detail?: { kind: 'conv' | 'person'; id: string } } {
  switch (r.view) {
    case 'inbox':
      return r.conv ? { pane: <ConversationPane convId={r.conv} focus={r.msg} onBack={back} />, detail: { kind: 'conv', id: r.conv } } : { pane: <InboxBoard /> };
    case 'people':
      return r.person ? { pane: <PersonPane personId={r.person} onBack={back} />, detail: { kind: 'person', id: r.person } } : { pane: <WelcomePane view="people" /> };
    case 'profile':
      return { pane: <ProfilePane personId={r.person} identityId={r.identity} onBack={() => history.back()} /> };
    case 'groups':
      return r.conv ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: { kind: 'conv', id: r.conv } } : { pane: <WelcomePane view="groups" /> };
    case 'space':
      return r.conv ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: { kind: 'conv', id: r.conv } } : { pane: <WelcomePane view="space" /> };
    case 'folder':
      return r.conv
        ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: { kind: 'conv', id: r.conv } }
        : r.person
          ? { pane: <PersonPane personId={r.person} onBack={back} />, detail: { kind: 'person', id: r.person } }
          : { pane: <WelcomePane view="folder" /> };
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
    case 'inbox':
      return <InboxSidebar activeConv={r.conv} />;
    case 'people':
      return <PeopleSidebar activePerson={r.person} />;
    case 'profile':
      return <PeopleSidebar activePerson={r.person} />;
    case 'groups':
      return <GroupsSidebar activeConv={r.conv} />;
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
          ['Default notifications', 'bell'],
          ['Smart triage', 'sparkles'],
          ['Keywords', 'at'],
          ['Per-place overrides', 'layers'],
          ['Appearance', 'eye'],
        ].map(([t, i]) => (
          <div class="settings-nav-item">
            <Icon name={i} size={16} /> {t}
          </div>
        ))}
      </div>
    </>
  );
}

function WelcomePane({ view }: { view: string }) {
  const titles: Record<string, { h: string; p: string; icon: string }> = {
    people: { h: 'People', p: 'Pick a person to see every DM you have with them — Signal, Discord and Matrix in one thread.', icon: 'users' },
    groups: { h: 'Groups', p: 'Group chats and rooms that live on their own, outside a server or space.', icon: 'groups' },
    space: { h: 'Communities', p: 'Pick a channel from the server or space on the left.', icon: 'hash' },
    folder: { h: 'Folder', p: 'A custom grouping that spans networks. Pick anything on the left.', icon: 'folder' },
    accounts: { h: 'Accounts', p: 'Pick an account to check its status, or add a new one.', icon: 'power' },
  };
  const t = titles[view] ?? titles.groups;
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

const MOBILE_TABS: { view: Route['view']; label: string; icon: string; route: Route }[] = [
  { view: 'inbox', label: 'Inbox', icon: 'inbox', route: { view: 'inbox' } },
  { view: 'people', label: 'People', icon: 'users', route: { view: 'people' } },
  { view: 'groups', label: 'Groups', icon: 'groups', route: { view: 'groups' } },
  { view: 'spaces', label: 'Spaces', icon: 'layers', route: { view: 'spaces' } },
  { view: 'settings', label: 'More', icon: 'settings', route: { view: 'settings' } },
];

function useTheme() {
  const theme = prefs.value.theme;
  useEffect(() => {
    const sys = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const t = theme === 'system' ? (sys.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    if (theme === 'system') {
      sys.addEventListener('change', apply);
      return () => sys.removeEventListener('change', apply);
    }
  }, [theme]);
}

export function App() {
  rev.value;
  const r = route.value;
  const [adding, setAdding] = useState(false);
  useTheme();
  // The installed app's icon shows what wants you, where the platform has badges.
  const badge = loaded.value ? sumUnread([...db.conversations.values()].filter(visibleConv)).badge : 0;
  useEffect(() => {
    if ('setAppBadge' in navigator) (badge ? navigator.setAppBadge(badge) : navigator.clearAppBadge()).catch(() => {});
  }, [badge]);
  // A mark-all-read can outlive the page that started it.
  useEffect(() => {
    api<{ pending: number }>('/api/read-all').then((p) => (readProgress.value = { pending: p.pending, failed: 0 })).catch(() => {});
  }, []);
  const backRoute: Route =
    r.view === 'space'
      ? { view: 'space', space: r.space }
      : r.view === 'folder'
        ? { view: 'folder', folder: r.folder }
        : r.view === 'search'
          ? { view: 'search', q: r.q }
          : r.view === 'accounts'
            ? { view: 'accounts' }
            : r.view === 'people'
              ? { view: 'people' }
              : { view: r.view } as Route;
  const { pane, detail } = centerFor(r, () => go(backRoute));
  const showDetails = prefs.value.details && detail;
  // On mobile, the center pane replaces the list when something is open.
  const convOpen = 'conv' in r && r.conv !== undefined;
  const personOpen = r.view === 'people' && r.person !== undefined;
  const accountOpen = r.view === 'accounts' && r.account !== undefined;
  const full = r.view === 'directory';
  const detailOpen = r.view === 'settings' || r.view === 'profile' || convOpen || personOpen || accountOpen || r.view === 'search' || (r.view === 'folder' && (r.conv || r.person));

  if (!loaded.value)
    return (
      <div class="loading-screen">
        <div class="spinner" />
        <span>{connected.value ? 'Loading your conversations…' : 'Connecting to the hub…'}</span>
      </div>
    );

  return (
    <div class={`app ${detailOpen ? 'detail-open' : ''} ${showDetails ? 'with-details' : ''} ${full ? 'full' : ''}`}>
      {!connected.value && (
        <div class="reconnect">
          <span class="dot" /> Reconnecting to the hub…
        </div>
      )}
      {updateReady.value && (
        <button class="update-bar" onClick={applyUpdate}>
          <Icon name="refresh" size={14} /> A new version is ready. Tap to reload.
        </button>
      )}
      {(readProgress.value.pending > 0 || readProgress.value.failed > 0) && (
        <div class="read-progress" role="status">
          <Icon name="check" size={13} />
          {readProgress.value.pending > 0 ? ` Telling the networks: ${readProgress.value.pending} left` : ' Read everywhere it could be'}
          {readProgress.value.failed > 0 && `, ${readProgress.value.failed} would not go through`}
        </div>
      )}
      <Rail />
      <aside class="sidebar">{sidebarFor(r, () => setAdding(true))}</aside>
      <main class="center">{pane}</main>
      {showDetails && <>{detail!.kind === 'conv' ? <ConversationDetails convId={detail!.id} /> : <PersonDetails personId={detail!.id} />}</>}
      <nav class="tabbar">
        {MOBILE_TABS.map((t) => (
          <button class={`tab ${r.view === t.view || (t.view === 'spaces' && (r.view === 'space' || r.view === 'directory')) ? 'active' : ''}`} onClick={() => go(t.route)}>
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      {adding && <AddAccount onClose={() => setAdding(false)} />}
      <ReactionLayer />
      <Toasts />
      <DragLayer />
      <PlaceMenu />
      <Switcher />
    </div>
  );
}
