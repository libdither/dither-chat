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
import { bareSubject, viewList } from '@dither-chat/protocol';
import { MAIL_LISTS } from '../mail/model.ts';
import { rowOpen, toggled, type ElsewhereRow } from '../mail/elsewhere.ts';
import { linkify } from '../mail/text.ts';
import { db, go, mailRev, openChat, toast } from '../state.ts';
import { clock, fullTime } from '../format.ts';
import { Icon } from './icons.tsx';
import './MailChat.css';
import { ChatMailBodyLazy, MailThreadActionsLazy, mailMessageExtras, openCompose, preloadMail } from './mail/lazy.tsx';
import { HeadOrb } from './Offline.tsx';
import { identityName } from '../model.ts';
import { useMenu, type MenuSpec } from './ContextMenu.tsx';

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

/** Where "Back to <person>" goes: set when a thread is opened from a person's chat, shown by the thread's pane. */
const backTo = signal<{ place: string; label: string } | null>(null);

function follow(place: string, label: string, msg: string) {
  backTo.value = { place, label };
  openThread(place, msg);
}

/** Whether a row shows its text (mail/elsewhere.ts rowOpen). */
const isOpen = (view: string, r: ElsewhereRow) => rowOpen(chosenRung(view, r.place), r);
const isHidden = (view: string, r: ElsewhereRow) => chosenRung(view, r.place)?.rung === 'hidden';

/** Choose how a thread shows in a chat; a failure puts it back and says so. Whether it was saved. */
const choose = (view: string, place: string, rung: P.Rung | null): Promise<boolean> =>
  chooseRung(view, place, rung).then(
    () => true,
    (err) => (toast({ kind: 'error', title: 'Could not save that', body: String(err?.message ?? err) }), false),
  );

/**
 * What a person wrote in threads with others, between two of their chat's own messages on one day (docs/mail.md "Mail
 * as chats", "What they wrote elsewhere"): a row per thread, its header line the toggle that shows its text and
 * "Answer there". Hidden threads leave a faint line with Show in their place.
 */
export function ElsewhereRows({ view, person, rows }: { view: string; person: P.PersonView; rows: ElsewhereRow[] }) {
  mailRev.value;
  // Hidden rows one after another are one line.
  const parts: (ElsewhereRow | ElsewhereRow[])[] = [];
  for (const r of rows) {
    if (!isHidden(view, r)) parts.push(r);
    else if (Array.isArray(parts[parts.length - 1])) (parts[parts.length - 1] as ElsewhereRow[]).push(r);
    else parts.push([r]);
  }
  return (
    <div class="elsewhere" role="group" aria-label={`What ${person.name} wrote elsewhere`}>
      {parts.map((p) =>
        Array.isArray(p) ? (
          <div class="elsewhere-hidden" key={`hidden-${p[0].place}`}>
            {p.length === 1 ? '1 hidden thread' : `${p.length} hidden threads`} ·{' '}
            <button class="link-btn" data-track="elsewhere show hidden" onClick={() => p.forEach((r) => void choose(view, r.place, null))}>
              Show
            </button>
          </div>
        ) : (
          <PlaceRow key={p.place} view={view} person={person} r={p} />
        ),
      )}
    </div>
  );
}

function PlaceRow({ view, person, r }: { view: string; person: P.PersonView; r: ElsewhereRow }) {
  const subject = bareSubject(r.e.title) || '(no subject)';
  const open = isOpen(view, r);
  const menu = useMenu(() => placeMenu(view, person, r, subject));
  const toggle = () => void choose(view, r.place, toggled(open, r));
  return (
    <div class={`elsewhere-row ${r.waits ? 'waits' : ''}`} {...menu}>
      <button class="elsewhere-head" aria-expanded={open} data-track={open ? 'elsewhere close' : 'elsewhere open'} title={`${person.name} in "${subject}"${r.e.others.length ? ` with ${r.e.others.join(', ')}` : ''}, ${fullTime(r.ts)}`} onClick={toggle}>
        <Icon name="mail" size={12} />
        <span class={`elsewhere-title ${r.e.unread ? 'unread' : ''}`}>{subject}</span>
        {r.e.others.length > 0 && <span class="elsewhere-with">· with {r.e.others.join(', ')}</span>}
        <span class="elsewhere-time">· {clock(r.ts)}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
        {!open && r.waits && <span class="elsewhere-waiting">Waiting on you</span>}
      </button>
      {open && (
        <div class="elsewhere-body">
          {r.e.excerpt && (
            <p class="elsewhere-text">
              <b>{person.name.split(' ')[0]}:</b> {r.e.excerpt}
            </p>
          )}
          <button class="link-btn elsewhere-answer" data-track="elsewhere answer" onClick={() => follow(r.place, person.name, r.e.messageId)}>
            Answer there <Icon name="chevronRight" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Right-click or long-press on a row: open its thread, or hide it in this chat (Undo in the toast, Show in its place). */
function placeMenu(view: string, person: P.PersonView, r: ElsewhereRow, subject: string): MenuSpec {
  return {
    track: 'elsewhere menu',
    head: subject,
    items: [
      { label: `Open in ${subject}`, icon: 'external', track: 'open', run: () => follow(r.place, person.name, r.e.messageId) },
      {
        label: 'Hide in this chat',
        icon: 'eyeOff',
        track: 'hide',
        run: () => {
          const was = chosenRung(view, r.place);
          void choose(view, r.place, 'hidden').then(
            (ok) =>
              ok &&
              toast({ kind: 'info', title: 'Hidden in this chat', body: subject, action: () => void choose(view, r.place, was?.rung ?? null), actionLabel: 'Undo', chat: openChat() }),
          );
        },
      },
    ],
  };
}

/** The bar over a thread opened from a person's chat: back to them, by their full name (Esc does the same, as everywhere). */
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
 * The chips under the Inbox's search with the Mail filter on, and atop a mail list (ui/mail/MailSidebar.tsx): Inbox,
 * then the lists mail has that chats don't (Updates, Everything, Starred, Sent), each shown in the Inbox's place
 * (`?mail=`). `on`: the list open, or null for the Inbox itself. `scope`: whose mail the lists show.
 */
export function MailListChips({ on, scope = null }: { on: string | null; scope?: string | null }) {
  const chips: { key: string | null; label: string }[] = [{ key: null, label: 'Inbox' }, ...MAIL_LISTS.map((v) => ({ key: viewList(v.view, scope), label: v.label }))];
  return (
    <div class="inbox-chips mail-list-chips" role="radiogroup" aria-label="Mail lists">
      {chips.map((c) => (
        <button class={`chip-btn ${c.key === on ? 'on' : ''}`} role="radio" aria-checked={c.key === on} data-track={`mail list (${c.label})`} onClick={() => go(c.key ? { view: 'inbox', mail: c.key } : { view: 'inbox' })}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ a thread as a chat

/**
 * A mail thread's chat header (docs/mail.md "Mail as chats"): its subject as the name, who is on it, and the thread's
 * filing (Archive, Trash, Star, ⋯) where a chat has its settings.
 */
export function MailThreadHeader({ c, onBack }: { c: P.ConversationView; onBack?: () => void }) {
  mailRev.value;
  const names = c.participantIds.map((id) => identityName(id)).filter(Boolean);
  const account = db.mail.accounts.get(c.vantages[0]?.accountId ?? '');
  const sub = [names.length ? names.join(', ') : null, account && db.mail.accounts.size > 1 ? (account.address ?? account.label) : null].filter(Boolean).join(' · ');
  return (
    <header class="conv-head mail-thread-head" data-track-area="chat header">
      {onBack && (
        <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <span class="conv-head-icon">
        <span class="conv-head-variant">
          <Icon name="mail" size={20} />
        </span>
      </span>
      <div class="conv-head-text">
        <h2>
          <span class="conv-head-name mail-subject">{c.name}</span>
        </h2>
        {sub && <div class="conv-head-sub">{sub}</div>}
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
