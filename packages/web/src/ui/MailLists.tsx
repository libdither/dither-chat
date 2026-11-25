/**
 * What the inbox draws of mail from the start (docs/inbox.md "Mail lists"): the mail lists' chips, a thread's tile, and
 * back to the Inbox. The rest of mail in a chat (MailChat.tsx) is in the conversation's chunk (docs/perf.md "Left out
 * of the first load").
 */
import { mailboxList, parseMailList, platformScope, searchOfList, viewList } from '@dither-chat/protocol';
import { holdsOnlyMailboxes, listName, MAIL_FOLDER_VIEWS, searchIn } from '../mail/model.ts';
import { db, go, mailRev, previousRoute, route } from '../state.ts';
import { Icon } from './icons.tsx';
import './MailLists.css';
import { contextMenu, openMenu, type MenuEntry } from './ContextMenu.tsx';

// ------------------------------------------------------------------ mail lists

/**
 * Back to the Inbox chip from a mail list (Esc, back, the Inbox chip): back where the first list was opened from when
 * that was the Inbox, so the lists in between leave no steps behind; else the Inbox in the list's place.
 */
export function toInboxChip() {
  const prev = previousRoute();
  if (prev && prev.view === 'inbox' && !prev.mail && !prev.conv) history.back();
  else go({ view: 'inbox' }, true);
}

/** A list from the chips: from the Inbox a step of its own, from another list in its place, so back is the Inbox. */
function openList(key: string | null) {
  const r = route.value;
  const inList = r.view === 'inbox' && !!r.mail;
  if (!key) return void (inList && toInboxChip());
  go({ view: 'inbox', mail: key }, inList);
}

const MORE_MENU = 'More mail lists';

/** More's menu: Starred and Sent of the scope in use, then each account's mailboxes. */
function openMore(from: HTMLElement, scope: string | null, on: string | null) {
  const s = db.mail;
  // Only the list open now is marked (a tick), so the rest keep their icons rather than rows of empty boxes.
  const lit = (k: string): { checked?: boolean } => (k === on ? { checked: true } : {});
  const items: MenuEntry[] = MAIL_FOLDER_VIEWS.map((v) => {
    const k = viewList(v.view, scope);
    return { label: v.label, icon: v.view === 'starred' ? 'star' : 'send', ...lit(k), track: `mail list (${v.label})`, run: () => openList(k) };
  });
  // With one account its Inbox and Sent are the Inbox chip and Sent above, and it needs no heading of its own.
  const one = s.accounts.size === 1;
  for (const a of s.accounts.values()) {
    const boxes = [...s.mailboxes.values()]
      .filter((b) => b.accountId === a.id && !holdsOnlyMailboxes(b, s.mailboxes.values()) && !(one && (b.role === 'inbox' || b.role === 'sent')))
      .sort((x, y) => (x.role === 'inbox' ? -1 : y.role === 'inbox' ? 1 : x.path.localeCompare(y.path)));
    if (!boxes.length) continue;
    if (!one) items.push({ kind: 'label', label: a.address ?? a.label });
    for (const b of boxes) {
      const k = mailboxList(b.id);
      items.push({ label: b.role === 'inbox' ? 'Inbox' : b.path.replace(/\//g, ' / '), icon: b.role === 'inbox' ? 'inbox' : b.role === 'sent' ? 'send' : b.role === 'trash' ? 'trash' : b.role === 'archive' || b.role === 'all' ? 'archive' : 'folder', ...lit(k), track: 'mail list (mailbox)', run: () => openList(k) });
    }
  }
  const r = from.getBoundingClientRect();
  openMenu({ x: r.left, y: r.bottom + 4 }, { items, label: MORE_MENU, head: <div class="cm-sheet-title">Mail lists</div> }, from);
}

/**
 * The chips under the Inbox's search with the Mail filter on, the same over every mail list (docs/inbox.md "Mail
 * lists"): always Inbox, Updates, Everything and More, so nothing above a list moves as you change lists. More holds
 * Starred, Sent and the mailboxes, and with one of them open, is lit with its name. `on`: the list open (a search in a
 * list counts as that list), or null for the Inbox itself.
 */
export function MailListChips({ on }: { on: string | null }) {
  mailRev.value;
  const search = on ? searchOfList(on) : null;
  const list = search !== null ? searchIn(search).list : on;
  const l = list ? parseMailList(list) : null;
  const scope = l && !('mailbox' in l) ? (l.platform ? platformScope(l.platform) : l.accountId) : null;
  const main: { key: string | null; label: string }[] = [
    { key: null, label: 'Inbox' },
    { key: viewList('updates', scope), label: 'Updates' },
    { key: viewList('all', scope), label: 'Everything' },
  ];
  const lit = (k: string | null) => k === list && (k !== null || on === null);
  const more = !!on && !main.some((c) => lit(c.key));
  return (
    <div class="mail-list-chips" role="radiogroup" aria-label="Mail lists">
      {main.map((c) => (
        <button class={`chip-btn ${lit(c.key) ? 'on' : ''}`} role="radio" aria-checked={lit(c.key)} data-track={`mail list (${c.label})`} onClick={() => openList(c.key)}>
          {c.label}
        </button>
      ))}
      <button
        class={`chip-btn mail-more-chip ${more ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={contextMenu.value?.label === MORE_MENU}
        data-track="mail list (More)"
        onClick={(e) => openMore(e.currentTarget as HTMLElement, scope, list)}
      >
        <span class="mail-more-name">{more ? listName(db.mail, on!) : 'More'}</span>
        <Icon name="chevronDown" size={12} />
      </button>
    </div>
  );
}

/**
 * A mail thread's tile: the envelope, where a chat has its picture, the same for every thread (its name tells them
 * apart). In the inbox's row, the mail lists' rows and the thread's header.
 */
export function MailTile({ size = 36 }: { size?: number }) {
  return (
    <span class="mail-tile" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <Icon name="mail" size={Math.round(size * 0.5)} />
    </span>
  );
}
