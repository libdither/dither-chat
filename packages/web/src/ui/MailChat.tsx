/**
 * Mail as chats (docs/mail.md "Mail as chats"), what a chat draws of it: a mail message's words and what opens under
 * them, its subject as the tag in its head, the subject chip over an email route's box, the row of what a person wrote
 * in threads with others, and your sends still in the outbox. What needs the mail's body (its quote, its HTML, its
 * files) is in Mail's chunk (ui/mail/ChatMail.tsx), loaded when one opens.
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { chatSends, chosenRung, chooseRung, loadMailThread, mailThread, refill, sendsIn } from '../mail/chats.ts';
import { mailboxList, parseMailList, platformScope, searchOfList, viewList } from '@dither-chat/protocol';
import { holdsOnlyMailboxes, listName, MAIL_FOLDER_VIEWS, searchIn } from '../mail/model.ts';
import { linkify } from '../mail/text.ts';
import { db, go, mailRev, openProfile, previousRoute, route, toast } from '../state.ts';
import { details } from '../mail/held.ts';
import { Icon } from './icons.tsx';
import './MailChat.css';
import { ChatMailBodyLazy, MailThreadActionsLazy, mailMessageExtras, openCompose, preloadMail } from './mail/lazy.tsx';
import { HeadOrb } from './Offline.tsx';
import { identityName } from '../model.ts';
import { contextMenu, openMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';

/** Undo, Send now and Dismiss, from mail's chunk (mail/drafts.ts is in it). */
const drafts = () => preloadMail();

let refills = 0;
/**
 * Undo of a send from a chat: the hub gives back the draft it was, which the chat does not keep (it was the box's
 * words), so it goes, and the words go back in the box.
 */
async function undoChatSend(item: P.MailOutboxView) {
  try {
    const d = await drafts();
    const r = await d.undoSend(item.id);
    void d.deleteDraft(r.draftKey);
    const s = chatSends.get(item.clientId);
    chatSends.delete(item.clientId);
    if (s) refill.value = { place: s.place, text: s.text, seq: ++refills };
  } catch (e) {
    toast({ kind: 'error', title: 'Could not undo', body: e instanceof Error ? e.message : String(e) });
  }
}

function Linked({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p) =>
        'url' in p ? (
          <a href={p.url} target="_blank" rel="noreferrer noopener">
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/**
 * A mail's words in the chat: plain text with its links (mail is never Markdown), then what opens under it: ··· for
 * the quoted mail it answers, "As sent" for one whose HTML plain text would lose, and its files.
 */
export function MailWords({ m }: { m: P.MessageView }) {
  const x = m.mail!;
  // Its menu files the thread (ChatMail.tsx mailMessageItems): the thread and mail's chunk are fetched now, not on open.
  useEffect(() => {
    if (!mailThread(x.threadId)) void loadMailThread(x.threadId);
    void preloadMail().catch(() => {});
  }, [x.threadId]);
  const [open, setOpen] = useState<null | 'quote' | 'sent'>(null);
  const toggle = (w: 'quote' | 'sent') => setOpen(open === w ? null : w);
  const empty = !m.body.trim();
  return (
    <>
      {open !== 'sent' &&
        (!empty ? (
          <div class="msg-body mail-words">
            <Linked text={m.body} />
          </div>
        ) : x.bodyState !== 'cached' ? (
          <ChatMailBodyLazy m={m} show="words" />
        ) : (
          !x.hasAttachments && <div class="msg-body mail-words mail-words-empty">No text</div>
        ))}
      {(x.quoted || x.rich) && (
        <div class="mail-opens">
          {x.quoted && open !== 'sent' && (
            <button class="mail-quote-dots" data-track="mail quote" aria-expanded={open === 'quote'} title={open === 'quote' ? 'Hide the quoted mail' : 'Show the quoted mail'} onClick={() => toggle('quote')}>
              ···
            </button>
          )}
          {x.rich && (
            <button class={`mail-open-chip ${open === 'sent' ? 'on' : ''}`} data-track="mail as sent" aria-expanded={open === 'sent'} title={open === 'sent' ? 'Back to its words' : 'Show the mail as it was sent: its colours, pictures and layout'} onClick={() => toggle('sent')}>
              {open === 'sent' ? 'Just the words' : 'As sent'}
            </button>
          )}
        </div>
      )}
      {open && <ChatMailBodyLazy m={m} show={open} />}
      {x.hasAttachments && open !== 'sent' && <ChatMailBodyLazy m={m} show="files" />}
    </>
  );
}

/** Where a mail thread opens on its own (its chat), at a message. */
const openThread = (threadId: string, msg?: string) => go({ view: 'inbox', conv: threadId, ...(msg ? { msg } : {}) });

/**
 * Style A: the subject as a tag in the message's head, where the thread changes. A click opens the thread alone. In the
 * thread's own chat the subject is the page's name, so it is not drawn.
 */
export function SubjectTag({ m }: { m: P.MessageView }) {
  const x = m.mail!;
  return (
    <button class="route-tag mail-subject" data-track="mail subject" title={`Email: ${x.subject || '(no subject)'}. Open this thread on its own`} onClick={() => openThread(x.threadId, m.id)}>
      <Icon name="mail" size={11} />
      <span class="route-label">{x.subject || '(no subject)'}</span>
    </button>
  );
}

/** A mail message's menu: answer it, the full editor, the thread on its own. */
export function mailMessageMenu(m: P.MessageView, reply: () => void): MenuSpec {
  const x = m.mail!;
  const many = !x.place.startsWith('person:');
  return {
    track: 'mail message menu',
    items: [
      { label: 'Reply', icon: 'reply', track: 'reply', run: reply },
      { label: many ? 'Reply all in the full editor' : 'Reply in the full editor', icon: 'pencil', track: 'full editor', run: () => openCompose({ kind: many ? 'replyAll' : 'reply', messageId: m.id, threadId: x.threadId, accountId: x.accountId }) },
      { label: 'Forward', icon: 'forward', track: 'forward', run: () => openCompose({ kind: 'forward', messageId: m.id, threadId: x.threadId, accountId: x.accountId }) },
      ...mailMessageExtras(m),
      { kind: 'sep' },
      { label: 'Open the thread on its own', icon: 'mail', track: 'open thread', run: () => openThread(x.threadId, m.id) },
      { label: 'Copy text', icon: 'copy', track: 'copy', run: () => void navigator.clipboard?.writeText(m.body) },
    ],
  };
}

// ------------------------------------------------------------------ the subject chip

/** Over the box while answering a mail: the thread the answer goes on, which the chip does not choose then. */
export function ReplySubject({ m }: { m: P.MessageView }) {
  return (
    <span class="subject-chip-line pair-token subject-chip static">
      <Icon name="mail" size={11} /> {m.mail?.subject || '(no subject)'}
    </span>
  );
}

/** What an email route's box sends into, per route: a thread of theirs, or a new one with this subject. */
const subjectPick = signal<Record<string, { threadId: string | null; subject: string | null }>>({});

/** The thread the route's box answers in now: the pick, else the latest. */
export function subjectOf(routeId: string): { threadId: string | null; subject: string | null } {
  const p = subjectPick.value[routeId];
  if (p) return p;
  const ch = db.mail.chats.get(routeId);
  return { threadId: ch?.threadIds[0] ?? null, subject: null };
}

export function pickSubject(routeId: string, v: { threadId: string | null; subject: string | null } | null) {
  const next = { ...subjectPick.value };
  if (v) next[routeId] = v;
  else delete next[routeId];
  subjectPick.value = next;
}

/**
 * Over an email route's box, after the route line: the thread it goes into, "Re: Dinner Friday", and a card to pick
 * another of yours with them or start one with a subject (TopicChip.tsx is the channel stream's twin of it). `subjects`:
 * the thread subjects the chat holds, newest first.
 */
export function SubjectChip({ routeId, subjects }: { routeId: string; subjects: { threadId: string; subject: string }[] }) {
  mailRev.value;
  subjectPick.value;
  const ch = db.mail.chats.get(routeId);
  const cur = subjectOf(routeId);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [at, setAt] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    find.current?.focus();
    const away = (e: PointerEvent) => {
      if (!card.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  if (!ch) return null;
  const known = new Map<string, string>();
  if (ch.threadIds[0]) known.set(ch.threadIds[0], ch.subject);
  for (const s of subjects) if (!known.has(s.threadId)) known.set(s.threadId, s.subject);
  const shown = cur.subject !== null ? cur.subject : cur.threadId ? (known.get(cur.threadId) ?? ch.subject) : '';
  const needle = q.trim().toLowerCase();
  type Row = { kind: 'thread'; threadId: string; subject: string } | { kind: 'new'; subject: string };
  const rows: Row[] = [];
  if (needle && ![...known.values()].some((s) => s.toLowerCase() === needle)) rows.push({ kind: 'new', subject: q.trim() });
  for (const [threadId, subject] of known) if (!needle || subject.toLowerCase().includes(needle)) rows.push({ kind: 'thread', threadId, subject });
  const close = (focusBox = true) => {
    setOpen(false);
    if (focusBox) (document.querySelector('.composer textarea') as HTMLTextAreaElement | null)?.focus();
  };
  const choose = (r: Row | undefined) => {
    if (!r) return;
    pickSubject(routeId, r.kind === 'new' ? { threadId: null, subject: r.subject } : r.threadId === ch.threadIds[0] ? null : { threadId: r.threadId, subject: null });
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, Math.min(rows.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[hi]);
    }
  };
  return (
    <span class="subject-chip-line mail-subject-line">
      <button
        ref={btn}
        class="pair-token subject-chip"
        data-track="subject chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="The mail thread your message goes into. Click to pick another or start one with a new subject."
        onClick={() => {
          if (open) return close(false);
          const r = btn.current?.getBoundingClientRect();
          if (r) setAt({ left: Math.max(8, Math.min(r.left, innerWidth - Math.min(360, innerWidth - 16) - 8)), bottom: innerHeight - r.top + 4, maxHeight: Math.max(160, r.top - 16) });
          setQ('');
          setHi(0);
          setOpen(true);
        }}
      >
        <Icon name="mail" size={11} />
        {cur.subject !== null && <span class="subject-chip-new">New:</span>}
        <span class="subject-chip-name">{shown || '(no subject)'}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {open && at && (
        <div ref={card} class="pair-card subject-card" style={{ left: `${at.left}px`, bottom: `${at.bottom}px`, maxHeight: `${at.maxHeight}px` }}>
          <input
            ref={find}
            class="input subject-find"
            value={q}
            placeholder="Find a thread, or type a new subject"
            aria-label="Find a thread or type a new subject"
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value);
              setHi(0);
            }}
            onKeyDown={onKey}
          />
          <div class="subject-rows" role="listbox">
            {rows.map((r, i) => (
              <button key={r.kind === 'thread' ? r.threadId : 'new'} role="option" aria-selected={i === hi} class={`subject-row ${i === hi ? 'hi' : ''} ${r.kind === 'thread' && r.threadId === cur.threadId && cur.subject === null ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => choose(r)}>
                {r.kind === 'new' ? (
                  <>
                    <Icon name="pencil" size={12} /> New thread: <b>{r.subject}</b>
                  </>
                ) : (
                  <>
                    <Icon name="mail" size={12} /> <span class="subject-row-name">{r.subject || '(no subject)'}</span>
                  </>
                )}
              </button>
            ))}
            {!rows.length && <div class="subject-none">Type a subject to start a new thread</div>}
          </div>
        </div>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ what they wrote elsewhere

/** Places followed from a person's chat this visit: their links get a tick. */
const followed = signal<Set<string>>(new Set());

/** Where "Back to <person>" goes: set when a link in their chat is followed, shown by the place's pane. */
const backTo = signal<{ place: string; label: string } | null>(null);

function follow(view: string, place: string, label: string, msg: string) {
  followed.value = new Set([...followed.value, `${view} ${place}`]);
  backTo.value = { place, label };
  openThread(place, msg);
}

/** How a place shows in a view: what you chose, else what the hub said. */
const rungOf = (view: string, e: P.ElsewhereView): P.Rung => chosenRung(view, e.place) ?? (e.why === 'chosen' ? 'link' : e.rung);

/**
 * What a person wrote in threads with others, between two of their chat's own messages (docs/mail.md "Mail as
 * chats", "What they wrote elsewhere"): a few lines of what still waits for you, and one row of links for the rest,
 * one per place, behind a rail. A place name with ↗ goes there, at those messages; "Read here" opens their lines in
 * place; ⋯ chooses how this place shows in this chat.
 */
export function ElsewhereRows({ view, person, items }: { view: string; person: P.PersonView; items: P.ElsewhereView[] }) {
  mailRev.value;
  followed.value;
  const [here, setHere] = useState(false);
  const shown = items.filter((e) => rungOf(view, e) !== 'hidden');
  if (!shown.length) return null;
  const excerpts = shown.filter((e) => rungOf(view, e) === 'excerpt' && (e.excerpt || e.line));
  const linked = shown.filter((e) => !excerpts.includes(e));
  const places = new Map<string, P.ElsewhereView[]>();
  for (const e of linked) places.set(e.place, [...(places.get(e.place) ?? []), e]);
  const first = person.name.split(' ')[0];
  return (
    <div class="elsewhere" role="group" aria-label={`What ${person.name} wrote elsewhere`}>
      {excerpts.map((e) => (
        <div class="elsewhere-excerpt" key={e.messageId}>
          <div class="elsewhere-head">
            <PlaceLink view={view} e={e} first={first} name={person.name} />
            {e.others.length > 0 && <span class="elsewhere-with">with {e.others.join(', ')}</span>}
            <PlaceMenu view={view} e={e} />
          </div>
          <p class="elsewhere-text">{e.excerpt ?? e.line}</p>
          <button class="link-btn elsewhere-answer" data-track="elsewhere answer" onClick={() => follow(view, e.place, person.name, e.messageId)}>
            Answer there
          </button>
        </div>
      ))}
      {places.size > 0 && (
        <div class="elsewhere-links">
          <span class="elsewhere-lead">{excerpts.length ? 'Also in' : `${first} wrote in`}</span>
          {[...places].map(([place, es]) => (
            <span class="elsewhere-place" key={place}>
              <PlaceLink view={view} e={es[es.length - 1]} first={first} name={person.name} count={es.length} />
              <PlaceMenu view={view} e={es[es.length - 1]} />
            </span>
          ))}
          <button class="link-btn elsewhere-here" aria-expanded={here} data-track="elsewhere read here" onClick={() => setHere(!here)}>
            {here ? 'Hide' : 'Read here'}
          </button>
        </div>
      )}
      {here && (
        <ul class="elsewhere-lines">
          {linked.map((e) => (
            <li key={e.messageId}>
              <span class="elsewhere-line-place">{e.title || '(no subject)'}:</span> {e.line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlaceLink({ view, e, first, name, count }: { view: string; e: P.ElsewhereView; first: string; name: string; count?: number }) {
  const done = followed.value.has(`${view} ${e.place}`);
  return (
    <a
      class={`elsewhere-link ${e.unread ? 'unread' : ''} ${done ? 'done' : ''}`}
      href={`#/inbox/c/${encodeURIComponent(e.place)}`}
      data-track="elsewhere link"
      title={`${first} in "${e.title || '(no subject)'}"${e.others.length ? ` with ${e.others.join(', ')}` : ''}. Go there`}
      onClick={(ev) => {
        ev.preventDefault();
        follow(view, e.place, name, e.messageId);
      }}
    >
      <Icon name="mail" size={11} />
      <span class="elsewhere-title">{e.title || '(no subject)'}</span>
      {count && count > 1 ? <span class="elsewhere-count">{count}</span> : null}
      {done ? <Icon name="check" size={11} /> : <span aria-hidden="true">↗</span>}
    </a>
  );
}

const RUNG_WORDS: [P.Rung, string][] = [
  ['excerpt', 'Text and link'],
  ['link', 'Link only'],
  ['hidden', 'Hidden'],
];

function PlaceMenu({ view, e }: { view: string; e: P.ElsewhereView }) {
  const now = chosenRung(view, e.place);
  const why =
    e.why === 'awaits'
      ? 'Its text shows: it was to you, and you have not answered there.'
      : now
        ? 'You chose how this thread shows here.'
        : !e.toYou
          ? 'A link: it was to the others, not you.'
          : Date.now() - e.ts > 7 * 86_400_000
            ? 'A link: it is over a week old.'
            : 'A link: you have answered or read it there.';
  return (
    <button
      class="icon-btn small elsewhere-more"
      aria-label={`How "${e.title}" shows here`}
      title="How this shows here"
      data-track="elsewhere menu"
      onClick={(ev) => {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(
          { x: r.left, y: r.bottom },
          {
            track: 'elsewhere menu',
            items: [
              { kind: 'label', label: why, note: true },
              ...RUNG_WORDS.map(([rung, label]) => ({
                label,
                radio: true,
                checked: rungOf(view, e) === rung,
                track: rung,
                run: () =>
                  void chooseRung(view, e.place, rung).then(
                    () => toast({ kind: 'info', title: `${label}: ${e.title || '(no subject)'}`, body: 'In this chat only.', action: () => void chooseRung(view, e.place, now), actionLabel: 'Undo' }),
                    (err) => toast({ kind: 'error', title: 'Could not change that', body: String(err?.message ?? err) }),
                  ),
              })),
              ...(now ? [{ label: 'As it would show by itself', track: 'default', run: () => void chooseRung(view, e.place, null) }] : []),
            ],
          },
        );
      }}
    >
      <Icon name="more" size={13} />
    </button>
  );
}

/** The bar over a place you went to from a person's chat: back to them (Esc does the same, as everywhere). */
export function BackBar({ place }: { place: string }) {
  const b = backTo.value;
  useEffect(() => () => void (backTo.value?.place === place && (backTo.value = null)), [place]);
  if (!b || b.place !== place) return null;
  return (
    <button class="back-bar" data-track="back to person" onClick={() => history.back()}>
      <Icon name="back" size={14} /> Back to {b.label}
    </button>
  );
}

// ------------------------------------------------------------------ sends on their way

/** Your mail from this chat still in the outbox: held for Undo, on its way, or failed, under the chat's messages. */
export function MailSends({ places, held }: { places: string[]; held: P.MessageView[] }) {
  mailRev.value;
  // A sent one goes once its copy in Sent is in the chat.
  const here = new Set(held.map((m) => m.mail?.messageId).filter(Boolean));
  const items = sendsIn(places).filter(({ item }) => !(item.state === 'sent' && item.sentMessageId && here.has(item.sentMessageId)));
  if (!items.length) return null;
  return (
    <div class="mail-sends">
      {items.map(({ item, text, subject }) => (
        <div class={`msg mail-send ${item.state}`} key={item.id}>
          <div class="msg-gutter" />
          <div class="msg-main">
            <div class="msg-body mail-words">{text}</div>
            <div class="mail-send-state">
              <Icon name="mail" size={11} />
              {subject && <span class="mail-send-subject">{subject}</span>}
              {item.state === 'held' ? (
                <>
                  <Held until={item.holdUntil} />
                  <button class="link-btn" data-track="mail undo" onClick={() => void undoChatSend(item)}>
                    Undo
                  </button>
                  <button class="link-btn" data-track="mail send now" onClick={() => void drafts().then((d) => d.sendNow(item.id))}>
                    Send now
                  </button>
                </>
              ) : item.state === 'failed' ? (
                <>
                  <span class="mail-send-failed">Not sent: {item.error}</span>
                  <button class="link-btn" data-track="mail dismiss" onClick={() => void drafts().then((d) => d.dismissSend(item.id))}>
                    Dismiss
                  </button>
                </>
              ) : (
                <span>{item.state === 'sent' ? 'Sent' : 'Sending…'}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Held({ until }: { until: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.ceil(((until ?? Date.now()) - Date.now()) / 1000));
  return <span>Sending in {s} s</span>;
}

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
  const items: MenuEntry[] = MAIL_FOLDER_VIEWS.map((v) => {
    const k = viewList(v.view, scope);
    return { label: v.label, icon: v.view === 'starred' ? 'star' : 'send', checked: k === on, track: `mail list (${v.label})`, run: () => openList(k) };
  });
  for (const a of s.accounts.values()) {
    const boxes = [...s.mailboxes.values()].filter((b) => b.accountId === a.id && !holdsOnlyMailboxes(b, s.mailboxes.values())).sort((x, y) => (x.role === 'inbox' ? -1 : y.role === 'inbox' ? 1 : x.path.localeCompare(y.path)));
    if (!boxes.length) continue;
    items.push({ kind: 'label', label: a.address ?? a.label });
    for (const b of boxes) {
      const k = mailboxList(b.id);
      items.push({ label: b.path.replace(/\//g, ' / '), icon: b.role === 'inbox' ? 'inbox' : b.role === 'sent' ? 'send' : b.role === 'trash' ? 'trash' : b.role === 'archive' || b.role === 'all' ? 'archive' : 'folder', checked: k === on, track: 'mail list (mailbox)', run: () => openList(k) });
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

// ------------------------------------------------------------------ a thread as a chat

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

/**
 * Everyone on a thread but you: who wrote, and once the thread is here, who each mail went to. Their names as the
 * chat knows them.
 */
function threadPeopleOf(c: P.ConversationView): { name: string; identityId: string | null }[] {
  const mine = new Set([...db.mail.accounts.values()].map((a) => a.address?.toLowerCase()).filter(Boolean));
  const out = new Map<string, { name: string; identityId: string | null }>();
  const add = (a: P.MailAddressView & { self?: boolean }) => {
    const e = a.email.toLowerCase();
    if (a.self || mine.has(e) || out.has(e)) return;
    out.set(e, { name: (a.identityId && identityName(a.identityId)) || a.name || a.email, identityId: a.identityId ?? null });
  };
  const t = mailThread(c.id);
  t?.from.forEach(add);
  for (const m of details.get(c.id)?.messages ?? []) [m.from, ...m.to, ...m.cc].forEach(add);
  if (!out.size) for (const id of c.participantIds) out.set(id, { name: identityName(id), identityId: id });
  return [...out.values()];
}

const PEOPLE_MENU = 'People on this thread';

/** Under a thread's name: up to two of the people on it, then "+3"; a hover names everyone, a click or tap lists them. */
function ThreadPeople({ c }: { c: P.ConversationView }) {
  const people = threadPeopleOf(c);
  const t = mailThread(c.id);
  // The thread's count has you in it; the people the page has not seen yet still count.
  const total = Math.max(people.length, (t?.participants ?? 0) - 1);
  if (!total) return null;
  const all = people.map((p) => p.name).join(', ');
  const open = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(
      { x: r.left, y: r.bottom + 4 },
      {
        label: PEOPLE_MENU,
        head: <div class="cm-sheet-title">{total === 1 ? 'On this thread with you' : `${total} people on this thread with you`}</div>,
        items: people.map((p): MenuEntry => ({ label: p.name, icon: 'user', track: 'mail thread: person', ...(p.identityId ? { run: () => openProfile(p.identityId) } : { disabled: true }) })),
      },
      e.currentTarget,
    );
  };
  return (
    <button class="mail-people" title={all} aria-label={`On this thread: ${all}`} aria-haspopup="menu" aria-expanded={contextMenu.value?.label === PEOPLE_MENU} data-track="mail thread: people" onClick={open}>
      <span class="mail-people-names">{people.slice(0, 2).map((p) => p.name).join(', ')}</span>
      {total > 2 && <span class="mail-people-more">+{total - Math.min(2, people.length)}</span>}
    </button>
  );
}

/**
 * A mail thread's chat header (docs/mail.md "Mail as chats"): the envelope tile and the thread's name (its subject),
 * as its row in the inbox has them, the people on it beneath, and the thread's filing (Archive, Star, ⋯) where a chat
 * has its settings.
 */
export function MailThreadHeader({ c, onBack }: { c: P.ConversationView; onBack?: () => void }) {
  mailRev.value;
  const account = db.mail.accounts.get(c.vantages[0]?.accountId ?? '');
  const several = !!account && db.mail.accounts.size > 1;
  return (
    <header class="conv-head mail-thread-head" data-track-area="chat header">
      {onBack && (
        <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <span class="conv-head-icon">
        <MailTile size={34} />
      </span>
      <div class="conv-head-text">
        <h2>
          <span class="conv-head-name mail-subject">{c.name}</span>
        </h2>
        <div class="conv-head-sub mail-thread-sub">
          <ThreadPeople c={c} />
          {several && <span class="mail-thread-account">· {account!.address ?? account!.label}</span>}
        </div>
      </div>
      <div class="conv-head-actions">
        <HeadOrb />
        <MailThreadActionsLazy threadId={c.id} />
      </div>
    </header>
  );
}

/** Over a thread's box: everyone on it gets your answer, as Reply all does. */
export function MailThreadLead({ c }: { c: P.ConversationView }) {
  const names = c.participantIds.map((id) => identityName(id)).filter(Boolean);
  return (
    <span class="mail-thread-lead" title="Your message goes to everyone on this thread, as Reply all does">
      <Icon name="replyAll" size={12} />
      <span>To {names.length ? names.join(', ') : 'everyone on it'}</span>
    </span>
  );
}
