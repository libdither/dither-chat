/**
 * Mail as chats (docs/mail.md "Mail as chats"), what a chat draws of it: a mail message's words and what opens under
 * them, its subject as the tag in its head, the subject chip over an email route's box, the row of what a person wrote
 * in threads with others, and your sends still in the outbox. What needs the mail's body (its quote, its HTML, its
 * files) is in Mail's chunk (ui/mail/ChatMail.tsx), loaded when one opens.
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { chatSends, chosenRung, chooseRung, loadMailThread, mailThread, refill, sendsIn, sendsShown } from '../mail/chats.ts';
import { bareSubject, linkIsAddress } from '@dither-chat/protocol';
import { archivedInAll } from '../mail/filing.ts';
import { clock, dayLabel, fullTime } from '../format.ts';
import { rowOpen, toggled, type ElsewhereRow } from '../mail/elsewhere.ts';
import { type BlockLetter, type BlockLine, inlineText, type Letter, letter, letterBlocks, shortLink } from '../mail/letter.ts';
import { askLink, linkMismatch } from './mail/linkOut.tsx';
import { linkify } from '../mail/text.ts';
import { db, go, mailRev, metaRev, openChat, openProfile, timelineKey, timelineRev, toast } from '../state.ts';
import { timelines } from '../store.ts';
import { details } from '../mail/held.ts';
import { Icon } from './icons.tsx';
import { PublicRow } from './PublicRow.tsx';
import './MailChat.css';
import { MailTile } from './MailLists.tsx';
import { ChatMailBodyLazy, MailThreadActionsLazy, mailMessageExtras, mailThreadFiling, openCompose, preloadMail } from './mail/lazy.tsx';
import { HeadOrb } from './Offline.tsx';
import { identityName } from '../model.ts';
import { contextMenu, openMenu, useMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';

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

/** Text with its links, each shown as its host and a short path (mail/letter.ts shortLink), the full address on hover. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p) =>
        'url' in p ? (
          <a href={p.url} target="_blank" rel="noreferrer noopener" title={p.url}>
            {shortLink(p.url)}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** What the sender may sign a mail with: the From name, their identity's and person's names, your account's on mail you sent. */
function signNames(m: P.MessageView): (string | null | undefined)[] {
  const x = m.mail!;
  const i = m.authorId ? db.identities.get(m.authorId) : undefined;
  const acc = db.mail.accounts.get(x.accountId);
  const mine = !!acc?.address && acc.address.toLowerCase() === x.from.email.toLowerCase();
  return [x.from.name, i?.displayName, i?.personId ? db.persons.get(i.personId)?.name : null, mine ? acc!.name : null];
}

/**
 * A mail's words in the chat, drawn as a letter (mail/letter.ts): paragraphs a small gap apart, an unsure sign-off
 * small and faint. Plain text with its links (mail is never Markdown), or, when the hub sent its tree
 * (`mail.blocks`), the words with their formatting. Words the hub did not hold yet come from Mail's chunk.
 * `quoteAbove`: the mail it answers is the message drawn right above, so its quote is no reason for ···.
 */
export function MailWords({ m, quoteAbove }: { m: P.MessageView; quoteAbove?: boolean }) {
  const x = m.mail!;
  // Its menu files the thread (ChatMail.tsx mailMessageItems): the thread and mail's chunk are fetched now, not on open.
  useEffect(() => {
    if (!mailThread(x.threadId)) void loadMailThread(x.threadId);
    void preloadMail().catch(() => {});
  }, [x.threadId]);
  if (!m.body.trim() && x.bodyState !== 'cached')
    return <ChatMailBodyLazy m={m} show="words" words={(text, quoted, blocks) => <MailLetter m={m} text={text} blocks={blocks} quoted={quoted} quoteAbove={quoteAbove} />} />;
  return <MailLetter m={m} text={m.body} blocks={x.blocks} quoted={x.quoted} quoteAbove={quoteAbove} />;
}

/** A mail's link: its words, or its address shortened when it has none of its own; one whose words name another site asks first. */
function MailLink({ href, c }: { href: string; c: P.MailInline[] }) {
  const words = inlineText(c);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={href}
      onClick={(e) => {
        const url = new URL(href);
        const shown = linkMismatch(url, words);
        if (!shown) return;
        e.preventDefault();
        e.stopPropagation();
        askLink(url, shown, { x: e.clientX, y: e.clientY });
      }}
    >
      {!words.trim() || linkIsAddress(href, words) ? shortLink(href) : <Inline xs={c} link />}
    </a>
  );
}

const MARK = { b: 'b', i: 'i', u: 'u', s: 's', code: 'code' } as const;

/** A formatted mail's inline nodes as elements (never HTML): text with its bare links, marks, links, breaks. */
function Inline({ xs, link }: { xs: P.MailInline[]; link?: boolean }) {
  return (
    <>
      {xs.map((x) => {
        if (typeof x === 'string') return link ? x : <Linked text={x} />;
        if (x.t === 'br') return <br />;
        if (x.t === 'a') return link ? <Inline xs={x.c} link /> : <MailLink href={x.href} c={x.c} />;
        const Tag = MARK[x.t];
        return (
          <Tag>
            <Inline xs={x.c} link={link} />
          </Tag>
        );
      })}
    </>
  );
}

/** A formatted mail's block: headings sized for a chat row, code that scrolls sideways inside the message. */
function Block({ b }: { b: P.MailBlock }) {
  if (b.t === 'p')
    return (
      <div class="mail-para">
        <Inline xs={b.c} />
      </div>
    );
  if (b.t === 'h')
    return (
      <div class={`mail-h mail-h${Math.min(b.level, 3)}`} role="heading" aria-level={b.level}>
        <Inline xs={b.c} />
      </div>
    );
  if (b.t === 'hr') return <hr class="mail-hr" />;
  if (b.t === 'pre') return <pre class="mail-pre">{b.text}</pre>;
  if (b.t === 'quote')
    return (
      <blockquote class="mail-bq">
        {b.c.map((c) => (
          <Block b={c} />
        ))}
      </blockquote>
    );
  const items = b.items.map((it) => (
    <li>
      {it.map((c) => (
        <Block b={c} />
      ))}
    </li>
  ));
  return b.ordered ? (
    <ol class="mail-wlist" start={b.start}>
      {items}
    </ol>
  ) : (
    <ul class="mail-wlist">{items}</ul>
  );
}

/**
 * A paragraph of the letter: its lines a break apart, its blocks as themselves. `dots`: the … of the rest, at the end
 * of its last line, or on a row of its own after a block.
 */
function BlockPara({ p, dots }: { p: BlockLine[]; dots?: (inline: boolean) => preact.JSX.Element }) {
  const out: preact.JSX.Element[] = [];
  let run: { c: P.MailInline[]; faint?: true }[] = [];
  const flush = (end: boolean) => {
    if (run.length)
      out.push(
        <div class="mail-para">
          {run.map((l, i) => (
            <>
              {i > 0 && '\n'}
              {l.faint ? (
                <span class="mail-faint">
                  <Inline xs={l.c} />
                </span>
              ) : (
                <Inline xs={l.c} />
              )}
            </>
          ))}
          {end && dots?.(true)}
        </div>,
      );
    run = [];
  };
  for (const l of p) {
    if ('block' in l) {
      flush(false);
      out.push(<Block b={l.block} />);
    } else run.push(l);
  }
  const tail = !run.length;
  flush(true);
  return (
    <>
      {out}
      {tail && dots?.(false)}
    </>
  );
}

/** Close to the view (or in it): a framed mail loads only then, so a long thread does not load every frame at once. */
function useNear<T extends Element>(on: boolean) {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || near || !el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [on, near]);
  return { ref, near };
}

/** Mail folded back to its words with "Just the words", this session: it stays so when the chat draws it again. */
const justWords = new Set<string>();

/** A text letter as lines of text nodes, so one walker draws both. */
const asBlockLetter = (l: Letter): BlockLetter => ({
  paras: l.paras.map((p) => p.map((x): BlockLine => (x.faint ? { c: [x.text], faint: true } : { c: [x.text] }))),
  rest: l.rest === null ? null : [[{ c: [l.rest] }]],
});

/**
 * The letter, then ··· when something is behind it: the folded name and signature, the quoted mail (unless it is the
 * message above), "Show as sent" for a mail whose HTML its words would lose. ··· opens them under the message and
 * closes them again. Its files show under it either way. A designed mail (`rich` with no `blocks`: tables, pictures,
 * colours) shows as sent, framed in place, once it comes near the view; "Just the words" folds it back.
 */
function MailLetter({ m, text, blocks, quoted, quoteAbove }: { m: P.MessageView; text: string; blocks?: P.MailBlock[]; quoted: boolean; quoteAbove?: boolean }) {
  metaRev.value; // the names it may be signed with (signNames)
  mailRev.value; // and your mail account's
  const x = m.mail!;
  const [open, setOpen] = useState(false);
  const framed = x.rich && !blocks && x.bodyState === 'cached';
  // What the reader picked here; until then a designed mail shows as sent. Not fixed at the first draw: a mail drawn
  // before its tree came is not left framed once it has one.
  const [chosen, setSent] = useState<boolean | null>(null);
  const sent = chosen ?? (framed && !justWords.has(m.id));
  const { ref, near } = useNear<HTMLDivElement>(sent && framed);
  const names = signNames(m);
  const l = blocks ? letterBlocks(blocks, names) : asBlockLetter(letter(text, names));
  const quote = quoted && !quoteAbove;
  const behind = !!l.rest || quote || x.rich;
  const asSent = (on: boolean) => {
    if (on) justWords.delete(m.id);
    else justWords.add(m.id);
    setSent(on);
  };
  // Shown as sent: at once when asked for, once near the view when it is the default.
  if (sent && (near || !framed))
    return (
      <>
        <ChatMailBodyLazy m={m} show="sent" cap={framed} />
        <div class="mail-opens">
          <button class="mail-open-chip on" data-track="mail as sent" aria-pressed="true" title="Back to its words" onClick={() => asSent(false)}>
            Just the words
          </button>
        </div>
        {x.hasAttachments && <ChatMailBodyLazy m={m} show="files" />}
      </>
    );
  const dots = (inline: boolean) => (
    <button class={`mail-quote-dots ${inline ? 'inline' : ''}`} data-track="mail rest" aria-expanded={open} aria-label={open ? 'Hide the rest of this mail' : 'Show the rest of this mail'} title={open ? 'Hide the rest of this mail' : 'Show the rest of this mail'} onClick={() => setOpen(!open)}>
      …
    </button>
  );
  return (
    <>
      {l.paras.length ? (
        <div ref={ref} class={`msg-body mail-words ${blocks ? 'mail-blocks' : ''}`}>
          {l.paras.map((p, pi) => (
            // The rest of the mail opens from the end of its last line, not from a row of its own.
            <BlockPara p={p} dots={behind && pi === l.paras.length - 1 ? dots : undefined} />
          ))}
        </div>
      ) : (
        <div ref={ref} class={`msg-body mail-words mail-words-empty ${x.hasAttachments ? 'none' : ''}`}>
          {!x.hasAttachments && 'No text'}
        </div>
      )}
      {behind && !l.paras.length && dots(false)}
      {behind && open && (
        <div class="mail-rest">
          {l.rest && (
            <div class={`mail-words mail-faint ${blocks ? 'mail-blocks' : ''}`}>
              {l.rest.map((p) => (
                <BlockPara p={p} />
              ))}
            </div>
          )}
          {quote && <ChatMailBodyLazy m={m} show="quote" />}
          {x.rich && (
            <button class="mail-open-chip" data-track="mail as sent" title="Show the mail as it was sent: its colours, pictures and layout" onClick={() => asSent(true)}>
              Show as sent
            </button>
          )}
        </div>
      )}
      {x.hasAttachments && <ChatMailBodyLazy m={m} show="files" />}
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
  const extras = mailMessageExtras(m);
  // The thread's trash goes last, under a line of its own, not among Star and Archive at the same weight.
  const trash = extras.filter((e) => e.kind !== 'sep' && e.kind !== 'label' && e.kind !== 'row' && e.track === 'mail thread: trash');
  return {
    track: 'mail message menu',
    items: [
      { label: 'Reply', icon: 'reply', track: 'reply', run: reply },
      { label: many ? 'Reply all in the full editor' : 'Reply in the full editor', icon: 'pencil', track: 'full editor', run: () => openCompose({ kind: many ? 'replyAll' : 'reply', messageId: m.id, threadId: x.threadId, accountId: x.accountId }) },
      { label: 'Forward', icon: 'forward', track: 'forward', run: () => openCompose({ kind: 'forward', messageId: m.id, threadId: x.threadId, accountId: x.accountId }) },
      ...extras.filter((e) => !trash.includes(e)),
      { kind: 'sep' },
      { label: 'Open the thread on its own', icon: 'mail', track: 'open thread', run: () => openThread(x.threadId, m.id) },
      { label: 'Copy text', icon: 'copy', track: 'copy', run: () => void navigator.clipboard?.writeText(m.body) },
      ...(trash.length ? [{ kind: 'sep' } as const, ...trash.map((e) => ({ ...e, danger: true }))] : []),
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
  mailRev.value; // whether it is open is its rung in `db.mail`, which a click on it changes
  // Their post written to you in public (PublicRow.tsx): a row of its own kind.
  if (r.e.placeKind === 'post') return <PublicRow person={person} e={r.e} />;
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
            {/* "Answer there" only where something waits on you; an answered thread is only gone to. */}
            {r.e.awaits ? 'Answer there' : 'Open there'} <Icon name="chevronRight" size={12} />
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
  const key = places.join(' ');
  useEffect(() => {
    sendsShown.value = new Set([...sendsShown.value, ...places]);
    return () => {
      const next = new Set(sendsShown.value);
      for (const p of places) next.delete(p);
      sendsShown.value = next;
    };
  }, [key]);
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

// ------------------------------------------------------------------ a thread as a chat

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
  // Who is on it, not only who wrote: each mail's To and Cc, from the thread's chat page once it is drawn, or from the
  // thread itself once the mail chunk has it.
  for (const m of timelines.get(timelineKey('c', c.id))?.messages ?? []) if (m.mail) [m.mail.from, ...m.mail.to, ...m.mail.cc].forEach(add);
  for (const m of details.get(c.id)?.messages ?? []) [m.from, ...m.to, ...m.cc].forEach(add);
  if (!out.size) for (const id of c.participantIds) out.set(id, { name: identityName(id), identityId: id });
  return [...out.values()];
}

const PEOPLE_MENU = 'People on this thread';

/** Under a thread's name: up to two of the people on it, then "+3"; a hover names everyone, a click or tap lists them. */
function ThreadPeople({ c }: { c: P.ConversationView }) {
  timelineRev(timelineKey('c', c.id)).value;
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
              // One person on it: Everyone is them already.
              ...(people.length < 2 ? [] : people).map((a, i): MenuEntry => ({ label: `Only ${short[i]}`, icon: 'user', track: 'only one', radio: true, checked: !!only && only.email.toLowerCase() === a.email.toLowerCase(), detail: a.email, run: () => pick(a) })),
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
