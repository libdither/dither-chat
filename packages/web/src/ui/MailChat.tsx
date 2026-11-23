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
import { archivedInAll } from '../mail/filing.ts';
import { dayLabel } from '../format.ts';
import { MAIL_LISTS } from '../mail/model.ts';
import { linkify } from '../mail/text.ts';
import { db, go, mailRev, timelineRev, toast } from '../state.ts';
import { timelines } from '../store.ts';
import { Icon } from './icons.tsx';
import './MailChat.css';
import { ChatMailBodyLazy, MailThreadActionsLazy, mailMessageExtras, mailThreadFiling, openCompose, preloadMail } from './mail/lazy.tsx';
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

/** A thread is archived: out of Inbox, into Archive (or All mail where the account has no Archive). */
function archived(t: P.MailThreadView | undefined): boolean {
  return !!t && !t.roles.includes('inbox') && (t.roles.includes('archive') || archivedInAll(db.mail.mailboxes, t));
}

/** Who a thread is with, by name: everyone who wrote in it but you. */
function withWhom(t: P.MailThreadView): string {
  const names: string[] = [];
  for (const f of t.from) if (!f.self && !names.includes(f.name || f.email)) names.push(f.name || f.email);
  return names.join(', ');
}

/** "3 mails · with Sam Rivera · newest today": a thread in one line, over its filing. */
function threadLine(t: P.MailThreadView): string {
  const day = dayLabel(t.lastAt);
  const who = withWhom(t);
  return [`${t.count} ${t.count === 1 ? 'mail' : 'mails'}`, who && `with ${who}`, `newest ${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day}`].filter(Boolean).join(' · ');
}

/** First names for "to Alice only", whole names where two share one. */
function firstNames(as: P.MailAddressView[]): string[] {
  const first = (a: P.MailAddressView) => (a.name || a.email.split('@')[0]).split(/\s+/)[0];
  return as.map((a) => (as.filter((b) => first(b) === first(a)).length > 1 ? a.name || a.email : first(a)));
}
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Pick A (docs/mail.md "Mail as chats"): the subject as a tag in the message's head, where the thread changes, with the
 * composer pill's envelope and bare subject. A click or tap opens the thread's card (how many mails, with whom, the
 * newest) with Archive and Star; an archived thread's tags show the archive glyph. In the thread's own chat the
 * subject is the page's name, so `tag` is false there; a mail you sent to only some on a thread still says so.
 */
export function SubjectTag({ m, tag = true }: { m: P.MessageView; tag?: boolean }) {
  mailRev.value;
  const x = m.mail!;
  const btn = useRef<HTMLButtonElement>(null);
  const open = !!btn.current && contextMenu.value?.from === btn.current;
  const t = mailThread(x.threadId);
  const subject = bareSubject(x.subject) || '(no subject)';
  const gone = archived(t);
  return (
    <>
      {tag && (
        <button
          ref={btn}
          class={`route-tag mail-tag ${open ? 'open' : ''}`}
          data-track="mail subject"
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Email: ${subject}${gone ? ' (archived)' : ''}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu({ x: r.left, y: r.bottom + 4 }, subjectMenu(m), e.currentTarget);
          }}
        >
          <Icon name={gone ? 'archive' : 'mail'} size={11} />
          <span class="route-label">{subject}</span>
        </button>
      )}
      {x.only && <span class="mail-only" title={`Sent to ${x.only.map((a) => a.name || a.email).join(', ')} only, not everyone on the thread`}>to {andList(firstNames(x.only))} only</span>}
    </>
  );
}

/** The subject tag's card: the thread in a line, then Archive and Star for it (ChatMail.tsx threadFiling). */
function subjectMenu(m: P.MessageView): MenuSpec {
  const x = m.mail!;
  const t = mailThread(x.threadId);
  const subject = bareSubject(x.subject) || '(no subject)';
  const items: MenuEntry[] = [
    {
      kind: 'row',
      render: () => (
        <div class="mail-tag-card">
          <b>
            <Icon name="mail" size={12} /> {subject}
          </b>
          {t && <small>{threadLine(t)}</small>}
        </div>
      ),
    },
    ...mailThreadFiling(x.threadId, false),
  ];
  return { track: 'mail subject card', label: subject, items };
}

/** A mail message's menu: answer it, the full editor, its thread's filing (Archive “Subject”, Star thread), the thread on its own. */
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

// ------------------------------------------------------------------ the line over the box

/**
 * A subject in a pill, cut in the middle when long ("Dinner on Fri…day?"), so its start and end both show: the head
 * gives way first, the last few letters stay.
 */
function Mid({ text }: { text: string }) {
  if (text.length <= 14) return <span class="mail-pill-text">{text}</span>;
  return (
    <span class="mail-pill-text mid" title={text}>
      <span class="mail-pill-head">{text.slice(0, -7)}</span>
      <span class="mail-pill-tail">{text.slice(-7)}</span>
    </span>
  );
}

/** The message box's textarea: where a pick sends you back to type. */
const toBox = () => (document.querySelector('.composer textarea') as HTMLTextAreaElement | null)?.focus();

/** Over the box while answering a mail: the thread the answer goes on, which the pill does not choose then. */
export function ReplySubject({ m }: { m: P.MessageView }) {
  return (
    <span class="mail-pill fixed" title="Your answer goes on this thread">
      <Icon name="mail" size={12} />
      <Mid text={bareSubject(m.mail?.subject ?? '') || '(no subject)'} />
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
 * Over an email route's box, after "To Sam Rivera": the thread the message goes into, as a pill (`✉ Dinner on
 * Friday? ⌄`). Its list has "New subject…" first, then your threads with them, newest first. New subject turns the
 * pill into a field of its size in place; Esc puts the thread back. `subjects`: the thread subjects the chat holds,
 * newest first (for threads the page has no view of).
 */
export function SubjectChip({ routeId, subjects }: { routeId: string; subjects: { threadId: string; subject: string }[] }) {
  mailRev.value;
  subjectPick.value;
  const ch = db.mail.chats.get(routeId);
  const cur = subjectOf(routeId);
  const btn = useRef<HTMLButtonElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // The pick before New subject: Esc in the field goes back to it.
  const before = useRef<{ threadId: string | null; subject: string | null } | null>(null);
  const [focusField, setFocusField] = useState(0);
  const writing = cur.subject !== null;
  useLayoutEffect(() => {
    if (focusField) field.current?.focus();
  }, [focusField]);
  if (!ch) return null;
  const held = new Map(subjects.map((x) => [x.threadId, x.subject]));
  const threads = [...new Set([...ch.threadIds, ...held.keys()])]
    .map((id) => ({ id, t: mailThread(id), subject: mailThread(id)?.subject ?? held.get(id) ?? (id === ch.threadIds[0] ? ch.subject : null) }))
    .filter((x): x is { id: string; t: P.MailThreadView | undefined; subject: string } => x.subject !== null)
    .sort((a, b) => (b.t?.lastAt ?? 0) - (a.t?.lastAt ?? 0));
  const shown = cur.threadId ? (threads.find((x) => x.id === cur.threadId)?.subject ?? ch.subject) : ch.subject;
  const anchor = () => (writing ? pill.current : btn.current);
  const open = !!anchor() && contextMenu.value?.from === anchor();
  const startNew = () => {
    before.current = subjectPick.value[routeId] ?? null;
    pickSubject(routeId, { threadId: null, subject: '' });
    setFocusField((n) => n + 1);
  };
  const menu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openMenu(
      { x: r.left, y: r.bottom + 4 },
      {
        flipY: r.top - 4,
        track: 'subject chip',
        label: 'Where your mail goes',
        items: [
          { label: 'New subject…', icon: 'plus', track: 'new subject', run: startNew },
          { kind: 'sep' },
          ...threads.map(
            (x): MenuEntry => ({
              label: bareSubject(x.subject) || '(no subject)',
              icon: 'mail',
              track: 'thread',
              detail: x.t ? `${x.t.count} ${x.t.count === 1 ? 'mail' : 'mails'} · ${dayLabel(x.t.lastAt)}` : undefined,
              checked: !writing && x.id === cur.threadId,
              run: () => {
                pickSubject(routeId, x.id === ch.threadIds[0] ? null : { threadId: x.id, subject: null });
                toBox();
              },
            }),
          ),
        ],
      },
      el,
    );
  };
  if (writing)
    return (
      <span ref={pill} class={`mail-pill mail-pill-field set ${open ? 'open' : ''}`}>
        <Icon name="mail" size={12} />
        <input
          ref={field}
          value={cur.subject ?? ''}
          placeholder="New subject"
          aria-label="Subject of a new thread"
          size={Math.max(11, (cur.subject ?? '').length + 1)}
          onInput={(e) => pickSubject(routeId, { threadId: null, subject: (e.target as HTMLInputElement).value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              pickSubject(routeId, before.current);
              toBox();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              toBox();
            }
          }}
        />
        <button class="mail-pill-more" data-track="subject chip" aria-label="Pick a thread instead" title="Pick a thread instead" onClick={() => pill.current && menu(pill.current)}>
          <Icon name="chevronDown" size={12} />
        </button>
      </span>
    );
  return (
    <button
      ref={btn}
      class={`mail-pill ${open ? 'open' : ''} ${cur.threadId !== ch.threadIds[0] ? 'set' : ''}`}
      data-track="subject chip"
      aria-haspopup="menu"
      aria-expanded={open}
      title="The mail thread your message goes into. Pick another, or start one with a new subject."
      onClick={(e) => menu(e.currentTarget)}
    >
      <Icon name="mail" size={12} />
      <Mid text={bareSubject(shown) || '(no subject)'} />
      <Icon name="chevronDown" size={12} />
    </button>
  );
}

/** Who a thread box's answer goes to, per thread: one person of it ("Only Alice"), else everyone (absent). */
const onlyTo = signal<Record<string, P.MailAddressView>>({});

/** The one person a thread's box answers now, or null for everyone. */
export const onlyOf = (place: string): P.MailAddressView | null => onlyTo.value[place] ?? null;

/** Everyone again (after a send, or picked). */
export function answerEveryone(place: string) {
  if (!onlyTo.value[place]) return;
  const next = { ...onlyTo.value };
  delete next[place];
  onlyTo.value = next;
}

/** A thread box's placeholder: "Reply to everyone", or "Reply to Alice only". */
export function threadPlaceholder(place: string): string {
  const one = onlyOf(place);
  return one ? `Reply to ${firstNames([one])[0]} only` : 'Reply to everyone';
}

/** Your own address: an account's, or one the hub put on you. */
function mine(a: P.MailAddressView): boolean {
  if (a.personId && a.personId === db.selfPersonId) return true;
  const e = a.email.toLowerCase();
  for (const acc of db.mail.accounts.values()) if (acc.address?.toLowerCase() === e) return true;
  return false;
}

/** Who answering a thread reaches, as reply all would: the newest mail's sender and recipients but you. */
function threadAudience(msgs: P.MessageView[]): { people: P.MailAddressView[]; latest: P.MessageView | null } {
  const latest = [...msgs].reverse().find((m) => m.mail) ?? null;
  const x = latest?.mail;
  if (!x) return { people: [], latest: null };
  const people: P.MailAddressView[] = [];
  for (const a of [x.from, ...x.to, ...x.cc]) if (a.email && !mine(a) && !people.some((p) => p.email.toLowerCase() === a.email.toLowerCase())) people.push(a);
  return { people, latest };
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
      {items.map(({ item, text, subject }) => {
        const only = chatSends.get(item.clientId)?.only;
        return (
        <div class={`msg mail-send ${item.state}`} key={item.id}>
          <div class="msg-gutter" />
          <div class="msg-main">
            <div class="msg-body mail-words">{text}</div>
            <div class="mail-send-state">
              <Icon name="mail" size={11} />
              {subject && <span class="mail-send-subject">{bareSubject(subject)}</span>}
              {only?.length ? <span class="mail-only">to {andList(only)} only</span> : null}
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
        );
      })}
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

/**
 * Over a thread's box: who your answer goes to, as a pill. Up to two names ("Alice Chen, Jo Park"), else "Everyone ·
 * 5"; its menu answers everyone, only one of them, or opens the full editor. "Only Alice" outlines the pill, makes the
 * placeholder "Reply to Alice only" and marks the sent mail so; after the send it is everyone again (Timeline.tsx
 * mailPost). `tkey`: the thread's timeline, whose newest mail says who reply all reaches.
 */
export function MailThreadLead({ c, tkey }: { c: P.ConversationView; tkey: string }) {
  onlyTo.value;
  timelineRev(tkey).value;
  const msgs = timelines.get(tkey)?.messages ?? [];
  const btn = useRef<HTMLButtonElement>(null);
  const open = !!btn.current && contextMenu.value?.from === btn.current;
  const { people: all, latest } = threadAudience(msgs);
  // In the header's order (MailThreadHeader names the thread's people so).
  const at = (a: P.MailAddressView) => (a.identityId && c.participantIds.includes(a.identityId) ? c.participantIds.indexOf(a.identityId) : c.participantIds.length);
  const people = [...all].sort((a, b) => at(a) - at(b));
  const names = people.length ? people.map((a) => a.name || a.email) : c.participantIds.map((id) => identityName(id)).filter(Boolean);
  const one = onlyOf(c.id);
  // One no longer on the thread's newest mail is no pick.
  const only = one && people.some((p) => p.email.toLowerCase() === one.email.toLowerCase()) ? one : null;
  const short = firstNames(people);
  const label = only ? `Only ${firstNames([only])[0]}` : names.length && names.length <= 2 ? names.join(', ') : `Everyone · ${names.length}`;
  const pick = (a: P.MailAddressView | null) => {
    if (a) onlyTo.value = { ...onlyTo.value, [c.id]: a };
    else answerEveryone(c.id);
    toBox();
  };
  return (
    <button
      ref={btn}
      class={`mail-pill ${open ? 'open' : ''} ${only ? 'set' : ''}`}
      data-track="mail recipients"
      aria-haspopup="menu"
      aria-expanded={open}
      title={only ? `Your answer goes to ${only.name || only.email} only` : 'Your answer goes to everyone on this thread, as Reply all does'}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(
          { x: r.left, y: r.bottom + 4 },
          {
            flipY: r.top - 4,
            track: 'mail recipients',
            label: 'Who your answer goes to',
            items: [
              { label: 'Everyone', icon: 'users', track: 'everyone', radio: true, checked: !only, detail: names.join(', ') || undefined, run: () => pick(null) },
              ...people.map((a, i): MenuEntry => ({ label: `Only ${short[i]}`, icon: 'user', track: 'only one', radio: true, checked: !!only && only.email.toLowerCase() === a.email.toLowerCase(), detail: a.email, run: () => pick(a) })),
              ...(latest ? [{ kind: 'sep' } as MenuEntry, { label: 'Full editor…', icon: 'pencil', track: 'full editor', run: () => openCompose({ kind: 'replyAll', messageId: latest.id, threadId: c.id, accountId: latest.mail!.accountId }) } as MenuEntry] : []),
            ],
          },
          e.currentTarget,
        );
      }}
    >
      <Icon name={only ? 'reply' : 'replyAll'} size={12} />
      <span class="mail-pill-text">{label}</span>
      <Icon name="chevronDown" size={12} />
    </button>
  );
}
