/**
 * The bar across the top of the desktop layout: where you are, and a few app-wide buttons.
 *
 * In an installed app with the window controls overlay (manifest display_override), this bar is the window's
 * title bar: the browser keeps only its own minimize/maximize/close buttons (and a button to bring the normal
 * title bar back), and gives us the rest through env(titlebar-area-*). Its empty parts move the window
 * (app-region: drag); buttons opt out. Anywhere else it is a plain bar. There are no buttons of our own for the
 * window: the browser's are always drawn in this mode, the web has no minimize or maximize, and window.close()
 * only works on windows a script opened.
 */
import { useEffect } from 'preact/hooks';
import { convTitle } from '../model.ts';
import { db, route, type Route } from '../state.ts';
import { variantIcon } from './bits.tsx';
import { Icon } from './icons.tsx';
import { switcherOpen } from './Switcher.tsx';
import { ThemeButton } from './Themes.tsx';

function placeTitle(r: Route): { title: string; icon: string } {
  const conv = 'conv' in r && r.conv ? db.conversations.get(r.conv) : undefined;
  if (conv) return { title: convTitle(conv), icon: conv.shape === 'direct' ? 'user' : conv.shape === 'group' ? 'groups' : variantIcon(conv.variant, conv.shape) };
  const person = 'person' in r && r.person ? db.persons.get(r.person) : undefined;
  if (person) return { title: person.name, icon: 'user' };
  switch (r.view) {
    case 'space':
      return { title: db.spaces.get(r.space)?.name ?? 'Server', icon: 'layers' };
    case 'folder':
      return { title: db.folders.find((f) => f.id === r.folder)?.name ?? 'Folder', icon: 'folder' };
    case 'people':
    case 'profile':
      return { title: 'People', icon: 'users' };
    case 'spaces':
    case 'directory':
      return { title: 'All communities', icon: 'grid' };
    case 'accounts':
      return { title: 'Accounts', icon: 'power' };
    case 'settings':
      return { title: 'Settings', icon: 'settings' };
    case 'search':
      return { title: 'Search', icon: 'search' };
    default:
      return { title: 'Inbox', icon: 'inbox' };
  }
}

export function TitleBar() {
  const { title, icon } = placeTitle(route.value);
  useEffect(() => {
    document.title = title === 'Inbox' ? 'dither-chat' : `${title} · dither-chat`;
  }, [title]);
  return (
    <header class="titlebar">
      <div class="titlebar-in">
        <span class="tb-title">
          <Icon name={icon} size={14} />
          <span>{title}</span>
        </span>
        <div class="tb-actions">
          <button class="tb-btn" title="Jump to a conversation (Ctrl+K)" aria-label="Jump to a conversation" onClick={() => (switcherOpen.value = true)}>
            <Icon name="search" size={15} />
          </button>
          <ThemeButton />
        </div>
      </div>
    </header>
  );
}
