import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { effect, untracked } from '@preact/signals';
import { accountsNeedingYou, chatPersonOf, convsUnder, firstChannel, inboxBadge, rootCommunity, totalUnread } from '../model.ts';
import { adoptEntry, api, connected, db, go, loaded, pending, prefs, previousRoute, readProgress, refresh, rev, route, setListUnder, setRouteFill, unreachable, type Route } from '../state.ts';
import { isPage, isTabRoot, listKey, listToWrite, ownList, restAfter, wayBack, type Places } from '../pages.ts';
import { dropLayer, phone, pushLayer } from '../phone.ts';
import { AccountPane, AccountsSidebar, AddAccount, addingAccount } from './Accounts.tsx';
import { ConversationDetails, PersonDetails } from './Details.tsx';
import { DirectoryPane } from './Directory.tsx';
import { DragLayer } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { ContextMenuLayer } from './ContextMenu.tsx';
import { TooltipLayer } from './Tooltip.tsx';
import { ForwardLayer } from './Forward.tsx';
import { AppsHostLazy } from './apps/lazy.tsx';
import { SendingLayer } from './SendExtras.tsx';
import { IndexLayer } from './Indexing.tsx';
import { CatchUp } from './CatchUp.tsx';
import { HowItSorts } from './HowItSorts.tsx';
import { Palette } from './Palette.tsx';
import { ReactionLayer } from './Reactions.tsx';
import { ProfilePane } from './Profile.tsx';
import { PlaceProfile } from './PlaceProfile.tsx';
import { GraphPane } from './GraphPane.tsx';
import { MessageHistoryLayer } from './MessageHistory.tsx';
import { ThreadsLayerLazy } from './ThreadsLazy.tsx';
import { Rail } from './Rail.tsx';
import { TitleBar } from './TitleBar.tsx';
import { FindShortcut, SearchPane } from './Search.tsx';
import { SECTIONS, SettingsPane } from './Settings.tsx';
import { showSection } from './bits.tsx';
import { FolderSidebar, homeRoute, InboxSidebar, PeopleSidebar, SpaceSidebar, SpacesSidebar } from './Sidebar.tsx';
import { ConversationPane, PersonPane } from './Timeline.tsx';
import { Toasts } from './Toasts.tsx';
import { CallDock } from './Call.tsx';
import { RingCards } from './Ringing.tsx';
import { Viewer } from './Viewer.tsx';
import { PEEK, panel, usePager, type Rest } from './Pager.ts';
import { Boot } from './Loader.tsx';
import { applyUpdate, updateReady } from '../pwa.ts';
import { noteChannel, readLastChannels, saveLastChannels, withLastChannel } from '../lastchannel.ts';
import { counting, rendered } from '../perf.ts';
import { MailCenterLazy, MailComposerLazy, MailSidebarLazy } from './mail/lazy.tsx';
import { RequestsPane } from './Requests.tsx';
import { NoticesPaneLazy } from './Notices.tsx';
import { CalendarPane } from './calendar/CalendarPane.tsx';
import { calendarLink, calendarOn } from '../plans.ts';
import { countKey } from '../clicklog.ts';
import { ThreadLazy } from './feed/lazy.tsx';
import { isPostKey } from '../feed.ts';

/** A conversation's details panel: the person's, for a DM of someone reached by several routes (their chat's page). */
function convDetail(id: string): { kind: 'conv' | 'person'; id: string } {
  const p = chatPersonOf(db.conversations.get(id));
  return p ? { kind: 'person', id: p.id } : { kind: 'conv', id };
}

/** What the center pane shows, and whether a details pane is available. */
function centerFor(r: Route, back: () => void): { pane: any; detail?: { kind: 'conv' | 'person'; id: string } } {
  switch (r.view) {
    case 'triage':
      return { pane: <CatchUp /> };
    case 'model':
      return { pane: <HowItSorts onBack={back} /> };
    case 'inbox':
      // A mail thread from the inbox opens in the reader, beside the inbox (docs/mail.md).
      if (r.conv?.startsWith('mth_')) return { pane: <MailCenterLazy thread={r.conv} onBack={back} /> };
      // A post's thread (docs/feed.md "Threads"), beside the inbox as a conversation is.
      if (isPostKey(r.conv)) return { pane: <ThreadLazy key={r.conv} postKey={r.conv!} onBack={back} /> };
      // A group of notices (a notification's conversation, quiet hours' summary) opens under Notices.
      if (r.conv?.startsWith('ntg_')) return { pane: <NoticesPaneLazy onBack={back} /> };
      return r.conv ? { pane: <ConversationPane convId={r.conv} focus={r.msg} onBack={back} />, detail: convDetail(r.conv) } : { pane: <CatchUp /> };
    case 'people':
      if (r.graph) return { pane: <GraphPane onBack={back} /> };
      return r.person ? { pane: <PersonPane personId={r.person} onBack={back} />, detail: { kind: 'person', id: r.person } } : { pane: <WelcomePane view="people" /> };
    case 'profile':
      if (r.conv || r.space) return { pane: <PlaceProfile kind={r.conv ? 'conversation' : 'space'} id={(r.conv ?? r.space)!} onBack={back} /> };
      return { pane: <ProfilePane personId={r.person} identityId={r.identity} onBack={back} /> };
    case 'space':
      return r.conv ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: convDetail(r.conv) } : { pane: <WelcomePane view="space" id={r.space} /> };
    case 'folder':
      return r.conv
        ? { pane: <ConversationPane convId={r.conv} onBack={back} />, detail: convDetail(r.conv) }
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
      return { pane: <DirectoryPane onBack={back} /> };
    case 'search':
      return r.conv ? { pane: <ConversationPane convId={r.conv} focus={r.msg} onBack={back} />, detail: convDetail(r.conv) } : { pane: <SearchPane q={r.q} onBack={isPage(r) ? back : undefined} /> };
    case 'mail':
      return { pane: <MailCenterLazy thread={r.thread} onBack={back} /> };
    case 'requests':
      return { pane: <RequestsPane focus={r.request} onBack={back} /> };
    case 'notices':
      return { pane: <NoticesPaneLazy focus={r.notice} onBack={back} /> };
    case 'calendar':
      return { pane: <CalendarPane at={r.at} /> };
  }
}

function sidebarFor(r: Route, onAdd: () => void): ComponentChildren {
  switch (r.view) {
    case 'triage':
    case 'model':
      return <InboxSidebar />;
    case 'inbox':
      return <InboxSidebar activeConv={r.conv} />;
    case 'people':
      return <PeopleSidebar activePerson={r.person} />;
    case 'profile': {
      // A place's page keeps the list it lives in beside it.
      const home = placeHome(r);
      if (home?.view === 'space') return <SpaceSidebar spaceId={home.space} activeConv={r.conv} />;
      if (home?.view === 'inbox') return <InboxSidebar activeConv={r.conv} />;
      return <PeopleSidebar activePerson={r.person} />;
    }
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
      // On a phone a conversation opened from search sits on the list it lives in, which a swipe shows (pages.ts).
      return phone.value && isPage(r) ? sidebarFor(ownList(r, places), onAdd) : <InboxSidebar activeConv={r.conv} />;
    case 'mail':
      return <MailSidebarLazy list={r.list} active={r.thread} />;
    case 'requests':
    case 'notices':
      return <InboxSidebar />;
    case 'calendar':
      return null;
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
        {SECTIONS.map(([t, i, id]) => (
          <button class="settings-nav-item" data-track={`settings: section ${t}`} onClick={() => showSection(id)}>
            <Icon name={i} size={16} /> {t}
          </button>
        ))}
        <button class="settings-nav-item" data-track="settings: section Accounts" onClick={() => go({ view: 'accounts' })}>
          <Icon name="power" size={16} /> Accounts
        </button>
      </div>
    </>
  );
}

function WelcomePane({ view, id }: { view: string; id?: string }) {
  rev.value;
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

/** Where a place's profile page lives: the space it is in (or is), else the inbox. Null for a person's. */
function placeHome(r: Extract<Route, { view: 'profile' }>): Route | null {
  if (r.space) return { view: 'space', space: rootCommunity(r.space)?.id ?? r.space };
  if (!r.conv) return null;
  const c = db.conversations.get(r.conv);
  const root = c?.spaceIds.length ? rootCommunity(c.spaceIds[0]) : null;
  return root ? { view: 'space', space: root.id } : { view: 'inbox' };
}

/** Where things live, for pages.ts. */
const places: Places = {
  home: (id) => {
    const c = db.conversations.get(id);
    return c ? homeRoute(c) : { view: 'inbox', conv: id };
  },
  placeHome,
};
// A list's page keeps its list under it in history, so the phone's back button shows the list as the swipe does.
setListUnder((to, from) => (phone.value ? listToWrite(to, from, places) : null));

// Opening a server goes back to the channel last opened in it, else its first channel to read, on a computer, where
// its list stays beside it (docs/servers.md "Opening a server"). On a phone the server's list is the page you open.
let lastChannels = readLastChannels();
const serverOf = (space: string) => rootCommunity(space)?.id ?? space;
setRouteFill((r) => (phone.value ? r : withLastChannel(r, lastChannels, serverOf, (space, conv) => convsUnder(space).some((c) => c.id === conv), firstChannel)));
effect(() => {
  const r = route.value;
  // A channel's About page is not reading it.
  if (r.view === 'profile' || !('conv' in r) || !r.conv) return;
  const conv = r.conv;
  untracked(() => {
    const space = r.view === 'space' ? r.space : db.conversations.get(conv)?.spaceIds[0];
    const next = space && noteChannel(lastChannels, serverOf(space), conv);
    if (next) saveLastChannels((lastChannels = next));
  });
});

/** Back from page `r`, by a swipe or its back button: to its list, or off the page it was opened over (pages.ts). */
function leave(r: Route) {
  const way = wayBack(r, previousRoute(), places);
  if (way.how === 'back') history.back();
  else go(way.to, true);
}

type Tab = 'home' | 'triage' | 'search' | 'calendar' | 'you';
const tabOf = (r: Route): Tab => (r.view === 'triage' || r.view === 'model' ? 'triage' : r.view === 'search' ? 'search' : r.view === 'calendar' ? 'calendar' : r.view === 'settings' || r.view === 'accounts' ? 'you' : 'home');

/** The last page and the last list on the Home tab, which a phone keeps while you look elsewhere. */
let lastDetail: Route | null = null;
let lastHome: Route = { view: 'inbox' };

function TabBar({ r }: { r: Route }) {
  rev.value;
  // The calendar's tab comes and goes with its account (plans.ts).
  calendarLink.value;
  const tab = tabOf(r);
  const all = totalUnread().badge;
  const attention = [...db.accounts.values()].some((a) => a.attention);
  const tabs: { id: Tab; label: string; icon: string; to: () => Route; badge?: number; dot?: boolean }[] = [
    { id: 'home', label: 'Home', icon: 'home', to: () => lastHome, badge: all },
    // Its badge is the unread alerts and Conversation messages, and accounts that need you.
    { id: 'triage', label: 'Catch up', icon: 'checks', to: () => ({ view: 'triage' }), badge: inboxBadge() + accountsNeedingYou().length },
    { id: 'search', label: 'Search', icon: 'search', to: () => ({ view: 'search', q: '' }) },
    // A hub with dither-calendar beside it (docs/calendar.md).
    ...(calendarOn ? [{ id: 'calendar' as const, label: 'Calendar', icon: 'calendar', to: (): Route => ({ view: 'calendar' }) }] : []),
    { id: 'you', label: 'You', icon: 'user', to: () => ({ view: 'settings' }), dot: attention },
  ];
  return (
    <nav class="tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <button class={`tab ${tab === t.id ? 'active' : ''}`} data-track={`tabs: ${t.label}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.to())}>
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

/** The installed app's icon shows what wants you, where the platform has badges. */
function AppBadge() {
  rev.value;
  const badge = loaded.value ? totalUnread().badge : 0;
  useEffect(() => {
    if ('setAppBadge' in navigator) (badge ? navigator.setAppBadge(badge) : navigator.clearAppBadge()).catch(() => {});
  }, [badge]);
  return null;
}

/**
 * Reads no `rev`: each pane, list and layer below reads what it shows, so a change to one conversation does not
 * draw the whole app again (docs/perf.md). Only a place's profile page follows `db` for where it lives.
 */
export function App() {
  if (counting) rendered('App');
  const r = route.value;
  if (r.view === 'profile' || lastDetail?.view === 'profile') rev.value;
  const p = phone.value;
  // A mark-all-read can outlive the page that started it.
  useEffect(() => {
    api<{ pending: number }>('/api/read-all').then((p) => (readProgress.value = { pending: p.pending, failed: 0 })).catch(() => {});
  }, []);
  // The entry the app opened on takes go()'s shape once there is data to say where its page lives (state.ts).
  useEffect(() => {
    if (loaded.value) adoptEntry();
  }, [loaded.value]);

  // On a phone the page you are on is a card over the lists; see Pager.ts.
  const detailRoute = isPage(r);
  const tabRoot = isTabRoot(r);
  if (detailRoute) lastDetail = r;
  else if (!tabRoot && tabOf(r) === 'home') lastHome = r;
  const shown = p && !detailRoute && !tabRoot && lastDetail ? lastDetail : r;
  const { pane, detail } = centerFor(shown, () => leave(shown));
  const details = p ? panel.value === 'details' && !!detail : prefs.value.details && !!detail;
  const rest: Rest = !p ? 'open' : detailRoute || tabRoot ? (details ? 'details' : 'open') : lastDetail && listKey(lastDetail, places) === listKey(r, places) ? 'peek' : 'away';
  // Exactly where leave(r) will land, so the card goes the way the page does.
  const backRest: Rest | null = detailRoute ? restAfter(r, wayBack(r, previousRoute(), places).to, places) : null;

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
    onBack: () => (countKey('pager: swipe back'), leave(r)),
    onDetails: (open) => (countKey(open ? 'pager: swipe to details' : 'pager: swipe from details'), (panel.value = open ? 'details' : 'main')),
    onForward: () => (countKey('pager: swipe forward'), lastDetail && go(lastDetail)),
    onRefresh: refresh,
  });

  if (!loaded.value)
    return (
      <Boot connected={connected.value} />
    );

  const full = r.view === 'directory' || r.view === 'calendar';
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
      <AppBadge />
      {!p && <TitleBar />}
      <Rail />
      <aside class="sidebar">{sidebarFor(r, () => (addingAccount.value = true))}</aside>
      <main class="center" ref={card} inert={rest === 'away'}>
        {pane}
        {p && (rest === 'peek' || rest === 'details') && (
          <button
            class="card-shield"
            data-track={rest === 'peek' ? 'pager: back to the page' : 'pager: close details'}
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
      <RingCards />
      <ReactionLayer />
      <MessageHistoryLayer />
      <ThreadsLayerLazy />
      <Toasts />
      <DragLayer />
      <ContextMenuLayer />
      <TooltipLayer />
      <ForwardLayer />
      <AppsHostLazy />
      <SendingLayer />
      <IndexLayer />
      <Palette />
      <FindShortcut />
      <MailComposerLazy />
      <Viewer />
    </div>
  );
}
