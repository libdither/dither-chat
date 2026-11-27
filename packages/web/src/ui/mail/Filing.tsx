/**
 * Filing mail (docs/mail.md, slice 4), plugged in through slots.tsx: the reader's buttons (archive, trash, star, ⋯),
 * a message's star, and around each row the swipes (right archives, left marks read or unread), the selection (a
 * long press, the avatar, or Ctrl/Shift-click; then taps add and remove) and its menu. Above the list: the selection's
 * bar, "Archived · Undo", and what still waits for the hub or the server. Keys: e archives, # trashes, s stars,
 * u marks unread, ! marks junk, Escape lets the selection go.
 *
 * An account the hub may only read shows none of these; one that answered 501 to an op loses that op's buttons, and
 * one whose status lists the writes it makes (`writes`: Gmail's, a kind at a time) shows only those (canWrite).
 */
import { isMailThread } from '../../mail/chats.ts';
import type * as P from '@dither-chat/protocol';
import { computed } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { lockAxis, rubber } from '../../gesture.ts';
import { archivedInAll } from '../../mail/filing.ts';
import { canWrite, clearSelected, destination, lastMove, markRead, move, moveKind, moveTargets, selected, star, starMessage, toggleSelected, waiting } from '../../mail/ops.ts';
import { haptic, reducedMotion } from '../../phone.ts';
import { connected, db, go, mailRev, route } from '../../state.ts';
import { groups, onMenu, openMenu, type MenuEntry, type MenuSpec } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import type { MessageAction, RowWrapper, ThreadAction } from './slots.tsx';
import { personItems } from './Classify.tsx';
import { countKey } from '../../clicklog.ts';
import { noteRowRead } from '../../activity.ts';

const acc = (t: P.MailThreadView) => db.mail.accounts.get(t.accountId);
/**
 * What a row's swipes are offered from, as a string: each mail account's writes and its mailboxes' roles. It follows
 * `mailRev`, and the rows draw again only when it changes, not for every thread that moves (docs/perf.md "What
 * redraws").
 */
const filingSource = computed(() => {
  mailRev.value;
  const accs = [...db.mail.accounts.values()].map((a) => `${a.id} ${a.level} ${a.writes ?? ''} ${a.ops?.unsupported ?? ''}`);
  const boxes = [...db.mail.mailboxes.values()].map((b) => `${b.id} ${b.accountId} ${b.role ?? ''}`);
  return `${accs.join('|')}#${boxes.join('|')}`;
});
const inInbox = (t: P.MailThreadView) => t.roles.includes('inbox');
const only = (t: P.MailThreadView, role: string) => t.roles.length > 0 && t.roles.every((r) => r === role || r === 'sent' || r === 'drafts');
/** Filing it there is offered: the mailbox is there, and the account makes that kind of move (archive, trash, junk). */
const canMove = (t: P.MailThreadView, to: P.MailMoveTarget) => {
  const b = destination(t, to);
  return !!b && canWrite(acc(t), moveKind(b));
};

/** Leaving the open thread after it was filed away: back to its list. */
function leave(ids: string[]) {
  const r = route.value;
  if (r.view === 'inbox' && r.conv && ids.includes(r.conv)) go({ view: 'inbox', ...(r.mail ? { mail: r.mail } : {}) }, true);
}

function file(ts: P.MailThreadView[], to: P.MailMoveTarget) {
  const ids = ts.filter((t) => canMove(t, to)).map((t) => t.id);
  if (!ids.length) return;
  move(ids, to);
  leave(ids);
  clearSelected();
}

/** Where the last pointer went down: menus opened from a button open there. */
let pointAt = { x: innerWidth / 2, y: 80 };
addEventListener('pointerdown', (e) => (pointAt = { x: e.clientX, y: e.clientY }), true);

/** The menu for one thread or a selection: the same in a row's right-click, the reader's ⋯ and the selection bar. */
export function threadMenu(ts: P.MailThreadView[], from: 'row' | 'reader' | 'selection'): MenuSpec | null {
  if (!ts.length) return null;
  const write = ts.every((t) => canWrite(acc(t)));
  const ids = ts.map((t) => t.id);
  const unread = ts.some((t) => t.unread > 0);
  const flagged = ts.every((t) => t.flagged);
  const oneAccount = ts.every((t) => t.accountId === ts[0].accountId);
  const targets = oneAccount ? moveTargets(ts[0]).filter((b) => canWrite(acc(ts[0]), moveKind(b)) && !ts.every((t) => t.mailboxIds.length === 1 && t.mailboxIds[0] === b.id)) : [];
  const anyIn = (role: string) => ts.some((t) => t.roles.includes(role as P.MailboxRole));
  const items = groups(
    [
      write && ts.every((t) => canWrite(acc(t), 'seen')) && { label: unread ? 'Mark read' : 'Mark unread', icon: unread ? 'eye' : 'mail', hint: unread ? undefined : 'U', run: () => (unread && noteRowRead('mail', ids), markRead(ids, unread), !unread && leave(ids), clearSelected()) },
      write && ts.every((t) => canWrite(acc(t), 'flagged')) && { label: flagged ? 'Unstar' : 'Star', icon: 'star', hint: 'S', run: () => (star(ids, !flagged), clearSelected()) },
    ],
    [
      ts.some(inInbox) && ts.every((t) => canMove(t, 'archive')) && { label: 'Archive', icon: 'archive', hint: 'E', run: () => file(ts, 'archive') },
      !ts.some(inInbox) && ts.every((t) => canMove(t, 'inbox')) && { label: anyIn('junk') ? 'Not junk' : 'Move to Inbox', icon: 'inbox', run: () => file(ts, 'inbox') },
      targets.length > 0 && write && { label: 'Move to…', icon: 'folder', sub: targets.map((b) => ({ label: b.path.replace(/\//g, ' / '), icon: b.role === 'inbox' ? 'inbox' : b.role === 'trash' ? 'trash' : b.role === 'archive' ? 'archive' : 'folder', run: () => file(ts, b.id) })) },
      !ts.every((t) => only(t, 'junk')) && ts.every((t) => canMove(t, 'junk')) && { label: 'Mark as junk', icon: 'alert', hint: '!', run: () => file(ts, 'junk') },
      !ts.every((t) => only(t, 'trash')) && ts.every((t) => canMove(t, 'trash')) && { label: 'Move to the trash', icon: 'trash', hint: '#', danger: true, run: () => file(ts, 'trash') },
    ],
    // Slice 8: from a person or not.
    personItems(ts),
    [from === 'row' && { label: selected.value.has(ts[0].id) ? 'Unselect' : 'Select', icon: 'check', run: () => toggleSelected(ts[0].id) }],
  ) as MenuEntry[];
  if (!items.length) return null;
  const title = ts.length === 1 ? ts[0].subject || '(no subject)' : `${ts.length} threads`;
  return { items, label: title, head: <div class="cm-sheet-title">{title}</div> };
}

// ------------------------------------------------------------------ the reader

const leaveAfter = (t: P.MailThreadView, to: P.MailMoveTarget) => file([t], to);

export const FILING_THREAD_ACTIONS: ThreadAction[] = [
  { id: 'archive', label: 'Archive', icon: 'archive', place: 'head', show: (t) => inInbox(t) && canMove(t, 'archive'), run: (t) => leaveAfter(t, 'archive') },
  {
    id: 'unarchive',
    label: 'Move to Inbox',
    icon: 'inbox',
    place: 'head',
    show: (t) => !inInbox(t) && (t.roles.some((r) => r === 'archive' || r === 'junk' || r === 'trash') || archivedInAll(db.mail.mailboxes, t)) && canMove(t, 'inbox'),
    run: (t) => leaveAfter(t, 'inbox'),
  },
  // Trash and Star are in ⋯ (threadMenu): a thread's chat header keeps one filing button, Archive, as a chat keeps its
  // own buttons. A chat's message menu has them too.
  { id: 'trash', label: 'Move to the trash', icon: 'trash', place: 'menu', show: (t) => !only(t, 'trash') && canMove(t, 'trash'), run: (t) => leaveAfter(t, 'trash') },
  {
    id: 'more',
    label: 'More',
    icon: 'more',
    place: 'head',
    show: (t, a) => canWrite(a) || personItems([t]).length > 0,
    run: (t) => openMenu(pointAt, threadMenu([db.mail.threads.get(t.id) ?? t], 'reader')),
  },
];

export const FILING_MESSAGE_ACTIONS: MessageAction[] = [
  { id: 'star', label: 'Star', icon: 'star', show: (m, _t, a) => !m.flags.flagged && canWrite(a, 'flagged'), run: (m) => starMessage(m, true) },
  { id: 'unstar', label: 'Unstar', icon: 'star', show: (m, _t, a) => m.flags.flagged && canWrite(a, 'flagged'), run: (m) => starMessage(m, false) },
];

// ------------------------------------------------------------------ a row

const ARM = 88;
/**
 * Where and until when a long press or a swipe ended: the click the browser makes of it, landing where the finger
 * lifted, is not a tap, whichever row is there by then (an archived row slides away). A tap somewhere else is a tap,
 * however soon: picking a second row right after the long press that picked the first.
 */
let lifted = { until: 0, x: 0, y: 0 };
/** The lift's click, once: a lift makes one click at most, and the next one there is a tap. */
const liftClick = (e: MouseEvent) => {
  const it = Date.now() < lifted.until && Math.hypot(e.clientX - lifted.x, e.clientY - lifted.y) <= 16;
  if (it) lifted = { until: 0, x: 0, y: 0 };
  return it;
};

/** Around each thread row: swipes, selection, the menu. */
export const FilingRow: RowWrapper = ({ thread: t, children }) => {
  filingSource.value; // what the account may do (`acc`) changes without the thread changing
  const picking = selected.value.size > 0;
  const on = selected.value.has(t.id);
  const fg = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const g = useRef<{ x0: number; y0: number; x: number; y: number; mode: null | 'x' | 'y'; dx: number; w: number; side: string; timer?: ReturnType<typeof setTimeout>; armed: boolean } | null>(null);
  const a = acc(t);
  const right = inInbox(t) && canMove(t, 'archive');
  const left = canWrite(a, 'flag.seen');

  const setX = (x: number, ms = 0) => {
    const el = fg.current;
    if (!el) return;
    el.style.transition = ms && !reducedMotion() ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none';
    el.style.transform = x ? `translateX(${x}px)` : '';
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const p = e.touches[0];
    g.current = { x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY, mode: null, dx: 0, w: 0, side: '', armed: false };
    // A long press picks it.
    g.current.timer = setTimeout(() => {
      const s = g.current;
      if (!s || s.mode) return;
      g.current = null;
      haptic(10);
      toggleSelected(t.id);
      lifted = { until: Date.now() + 600, x: s.x, y: s.y };
    }, 450);
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = g.current;
    if (!s) return;
    const p = e.touches[0];
    s.x = p.clientX;
    s.y = p.clientY;
    const dx = p.clientX - s.x0;
    const dy = p.clientY - s.y0;
    if (!s.mode) {
      const axis = lockAxis(dx, dy);
      if (!axis) return;
      clearTimeout(s.timer);
      if (axis === 'y' || picking || (dx > 0 ? !right : !left)) return void (g.current = null);
      s.mode = 'x';
      // Measured once, when the swipe starts: a read after the last move's transform forced a layout every move.
      s.w = box.current?.clientWidth ?? 320;
    }
    // The swipe is the row's: the pager under it does not see it.
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const w = s.w;
    const x = dx > 0 ? (right ? rubber(dx, w * 0.6) : 0) : left ? -rubber(-dx, w * 0.6) : 0;
    s.dx = x;
    const armed = Math.abs(x) >= ARM;
    if (armed && !s.armed) haptic();
    // Only when they change: each write restyles the row.
    if (armed !== s.armed) box.current?.classList.toggle('armed', armed);
    s.armed = armed;
    const side = x > 0 ? 'right' : x < 0 ? 'left' : '';
    if (side !== s.side) box.current?.setAttribute('data-swipe', (s.side = side));
    setX(x);
  };
  const onTouchEnd = () => {
    const s = g.current;
    g.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (s.mode !== 'x') return;
    lifted = { until: Date.now() + 500, x: s.x, y: s.y };
    box.current?.classList.remove('armed');
    if (s.armed && s.dx > 0) {
      setX(s.w || 400, 180);
      setTimeout(() => {
        file([t], 'archive');
        // Still listed here (Unread, a search): back in place.
        setTimeout(() => setX(0), 50);
      }, 180);
    } else {
      setX(0, 180);
      // Once the row is on its way back, not in the frame that starts it.
      if (s.armed) requestAnimationFrame(() => setTimeout(() => markRead([t.id], t.unread > 0)));
    }
  };
  const onClickCapture = (e: MouseEvent) => {
    const pick = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (liftClick(e)) return pick();
    const avatar = (e.target as HTMLElement).closest('.row-avatar');
    if (picking || avatar || e.ctrlKey || e.metaKey || e.shiftKey) {
      pick();
      toggleSelected(t.id);
    }
  };
  const menu = onMenu(() => {
    const sel = selected.value.has(t.id) ? [...selected.value].map((id) => db.mail.threads.get(id)).filter((x): x is P.MailThreadView => !!x) : [t];
    return threadMenu(sel, sel.length > 1 ? 'selection' : 'row');
  });

  return (
    <div
      ref={box}
      class={`mail-swipe ${on ? 'selected' : ''} ${t.pending ? 'pending' : ''}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onClickCapture={onClickCapture}
      onContextMenu={menu}
      title={t.pending ? 'Waiting for the server' : undefined}
    >
      {(right || left) && (
        <div class="mail-swipe-bg" aria-hidden="true">
          <span class="mail-swipe-archive">
            <Icon name="archive" size={18} /> Archive
          </span>
          <span class="mail-swipe-read">
            {t.unread ? 'Read' : 'Unread'} <Icon name={t.unread ? 'eye' : 'mail'} size={18} />
          </span>
        </div>
      )}
      <div class="mail-swipe-fg" ref={fg}>
        {children}
        {on && (
          <span class="mail-picked" aria-label="Selected">
            <Icon name="check" size={16} />
          </span>
        )}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ above the list

/** The selection's bar, Undo, and what still waits. */
export function FilingBar({ list }: { list: string }) {
  mailRev.value;
  const sel = selected.value;
  const last = lastMove.value;
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  // A new list lets the selection go.
  useEffect(() => clearSelected, [list]);
  const ts = [...sel].map((id) => db.mail.threads.get(id)).filter((x): x is P.MailThreadView => !!x);
  const accounts = [...db.mail.accounts.values()];
  const held = waiting.value.length;
  const notes: { key: string; text: string; error?: number }[] = [];
  if (held && !connected.value) notes.push({ key: 'hub', text: `${held === 1 ? 'A change waits' : `${held} changes wait`} for the hub.` });
  for (const a of accounts) {
    const o = a.ops;
    if (!o) continue;
    const away = !a.online || db.mail.access.state !== 'granted';
    if (o.waiting && away) notes.push({ key: `w${a.id}`, text: `${o.waiting === 1 ? 'A change waits' : `${o.waiting} changes wait`} for ${a.address ?? a.label}.` });
    if (o.error && dismissed[a.id] !== o.error.at) notes.push({ key: a.id, text: o.error.message, error: o.error.at });
  }
  const unread = ts.some((t) => t.unread > 0);
  const flagged = ts.length > 0 && ts.every((t) => t.flagged);
  const write = ts.length > 0 && ts.every((t) => canWrite(acc(t)));
  return (
    <>
      {ts.length > 0 && (
        <div class="mail-pickbar" role="toolbar" aria-label="Selected threads">
          <button class="icon-btn" aria-label="Let the selection go" title="Let the selection go" onClick={clearSelected}>
            <Icon name="x" size={16} />
          </button>
          <span class="mail-pickbar-n" title={`${ts.length} selected`}>
            {ts.length}
          </span>
          {write && ts.some(inInbox) && ts.every((t) => canMove(t, 'archive')) && (
            <button class="icon-btn" aria-label="Archive" title="Archive" onClick={() => file(ts, 'archive')}>
              <Icon name="archive" size={17} />
            </button>
          )}
          {write && ts.every((t) => canWrite(acc(t), 'seen')) && (
            <button class="icon-btn" aria-label={unread ? 'Mark read' : 'Mark unread'} title={unread ? 'Mark read' : 'Mark unread'} onClick={() => (unread && noteRowRead('mail', ts.map((t) => t.id)), markRead(ts.map((t) => t.id), unread), clearSelected())}>
              <Icon name={unread ? 'eye' : 'mail'} size={17} />
            </button>
          )}
          {write && ts.every((t) => canWrite(acc(t), 'flagged')) && (
            <button class={`icon-btn ${flagged ? 'on' : ''}`} aria-label={flagged ? 'Unstar' : 'Star'} title={flagged ? 'Unstar' : 'Star'} onClick={() => (star(ts.map((t) => t.id), !flagged), clearSelected())}>
              <Icon name="star" size={17} />
            </button>
          )}
          {write && ts.every((t) => canMove(t, 'trash')) && (
            <button class="icon-btn" aria-label="Move to the trash" title="Move to the trash" onClick={() => file(ts, 'trash')}>
              <Icon name="trash" size={17} />
            </button>
          )}
          <button
            class="icon-btn"
            aria-label="More"
            title="More"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu({ x: r.left, y: r.bottom + 4 }, threadMenu(ts, 'selection'), e.currentTarget);
            }}
          >
            <Icon name="more" size={17} />
          </button>
        </div>
      )}
      {notes.map((n) => (
        <div class={`mail-ops-note ${n.error ? 'error' : ''}`} role="status" key={n.key}>
          <Icon name={n.error ? 'alert' : 'clock'} size={13} />
          <span>{n.text}</span>
          {n.error && (
            <button class="link-btn" onClick={() => setDismissed({ ...dismissed, [n.key]: n.error! })}>
              Dismiss
            </button>
          )}
        </div>
      ))}
      {last && (
        <div class="mail-undo" role="status" key={last.seq}>
          <span>{last.text}</span>
          {last.undo && (
            <button class="link-btn" onClick={last.undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ keys

addEventListener('keydown', (e) => {
  const r = route.value;
  // In a mail list or a thread's chat (docs/mail.md "Mail as chats").
  if (r.view !== 'inbox' || !(r.mail || isMailThread(r.conv)) || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest?.('input, textarea, select, [contenteditable], .cm, .sheet-layer, .modal-backdrop, .switcher-back')) return;
  if (e.key === 'Escape' && selected.value.size) return void (clearSelected(), e.preventDefault());
  const ids = selected.value.size ? [...selected.value] : isMailThread(r.conv) ? [r.conv] : [];
  const ts = ids.map((id) => db.mail.threads.get(id)).filter((x): x is P.MailThreadView => !!x);
  if (!ts.length) return;
  const all = (kind: P.MailWriteKind) => ts.every((t) => canWrite(acc(t), kind));
  switch (e.key) {
    case 'e':
      if (!ts.some(inInbox)) return;
      file(ts, 'archive');
      break;
    case '#':
      file(ts, 'trash');
      break;
    case '!':
      file(ts, 'junk');
      break;
    case 's':
      if (!all('flagged')) return;
      star(ids, !ts.every((t) => t.flagged));
      break;
    case 'u':
      if (!all('seen')) return;
      markRead(ids, false);
      leave(ids);
      clearSelected();
      break;
    default:
      return;
  }
  countKey(`keys: mail ${e.key}`);
  e.preventDefault();
});
