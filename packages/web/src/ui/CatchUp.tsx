/**
 * Catch up (docs/inbox.md#catch-up): the right pane with no conversation open, and the phone's Catch up tab. The
 * conversations that need you, one compact card each: what came since you last read it, a reply box that sends as the
 * conversation's composer does, and Done, Later and Open. The queue is taken when the pane opens and stays steady while
 * you work through it (catchup.ts). Nothing here marks anything read but Done, a reply, or opening the conversation.
 */
import type * as P from '@dither-chat/protocol';
import { TIER_LABEL } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { arrive, focusAfter, later, remove, reopen, seen, step, take, type Queue, type QueueRow } from '../catchup.ts';
import { isMailItem, lineKey, topTier, type BoardItem } from '../board.ts';
import { countKey } from '../clicklog.ts';
import { ago, fullTime, since as sinceText } from '../format.ts';
import { shownInbox } from '../inbox.ts';
import { accountsNeedingYou, authorName, communitiesOf, convLabel, convTitle, inboxKeyOf, mailRowsWaiting, plainBody, rowConvs, rowLast, rowUnread, visibleAccount, visibleConv, type ConvInboxRow, type InboxRow } from '../model.ts';
import { senderLine } from '../mail/model.ts';
import { phone } from '../phone.ts';
import { db, discardSend, go, inbox, isSelfIdentity, loadMailTriage, loadTimeline, mailRev, mailTriage, markAllRead, markRead, pending, prefs, retrySend, rev, route, send, timelineKey, timelineRev, timelines } from '../state.ts';
import { composerDone, composerTyped } from '../typing.ts';
import { Avatar } from './bits.tsx';
import { useGrow } from './grow.ts';
import { Icon } from './icons.tsx';
import { composerBlocker } from './Timeline.tsx';
import { TIER_ICON } from './Marks.tsx';
import { viewer, type ViewerImage } from './Viewer.tsx';

// ------------------------------------------------------------------ the session's queue

interface Session {
  q: Queue;
  /** Each card's read point when it joined the queue: what came after it is shown. */
  since: Map<string, number>;
  /** Cards answered from here, and when. */
  replied: Map<string, number>;
  focus: string | null;
  /** When the pane last opened, and closed. */
  openedAt: number;
  closedAt: number | null;
  /** Done, Later or a reply since it opened: from then on the order is yours. */
  acted: boolean;
  /** After Mark all read, until then: cards that no longer need you leave as the reads come in. */
  pruneUntil?: number;
}
const session = signal<Session | null>(null);

/** Closed this long, the pane takes its queue afresh in the inbox's order. Shorter, it carries on where you were. */
const SESSION_GAP = 30 * 60_000;
/** What arrives this soon after opening (mail views, a late score) is part of the first queue, in order. */
const SETTLING = 3000;
/** Messages a card shows before "and N earlier". */
const SHOWN = 5;
/** Cards after the focused one that load their messages before they are scrolled to. */
const AHEAD = 3;
/** Cards drawn at first, and then each time the end of them comes near: a busy queue is drawn as you go. */
const DRAWN = 10;

/**
 * The queue and its cards wait until the app has started (the browser is idle once after the pane first opens): the
 * inbox list comes first. Once per page load; opening the pane again later is immediate.
 */
const warm = signal(false);
let warming = false;
function warmUp() {
  if (warm.value || warming) return;
  warming = true;
  const go = () => (warm.value = true);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1500 });
  else setTimeout(go, 500);
}

const DONE_KEY = 'dither-chat:catch-up-done';
/** Cards marked Done on this device, with their latest message then (catchup.ts `DoneMarks`). Not the hub's. */
let doneMarks = (() => {
  try {
    return new Map<string, number>(Object.entries(JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}')));
  } catch {
    return new Map<string, number>();
  }
})();
function markDone(key: string, last: number) {
  doneMarks.set(key, last);
  // A month is plenty: by then a new message has come, or the place no longer needs you.
  const old = Date.now() - 30 * 86_400_000;
  doneMarks = new Map([...doneMarks].filter(([, t]) => t > old).slice(-300));
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(Object.fromEntries(doneMarks)));
  } catch {}
}

type Row = QueueRow & { row: InboxRow };
/** The inbox's rows in its own order, the snapshot its list shows (inbox.ts). */
const queueRows = (): Row[] =>
  shownInbox('all').map((r) => ({ key: r.key, needs: r.needs, owedSince: r.owedSince, unread: rowUnread(r), last: rowLast(r), row: r }));

/** Where a card's messages start: the earliest unread, or the message you owe an answer, whichever came first. */
function sinceOf(r: InboxRow): number {
  if (r.kind === 'mail') return 0;
  // A person's chat: over every route.
  const reads = rowConvs(r).flatMap((c) => c.vantages.filter((v) => v.unread > 0).map((v) => v.lastReadTs ?? 0));
  let s = reads.length ? Math.min(...reads) : Infinity;
  if (r.owedSince !== null) s = Math.min(s, r.owedSince - 1);
  return s === Infinity ? (r.conv.lastMessageAt ?? 1) - 1 : s;
}

function openSession(rows: Row[]) {
  const now = Date.now();
  const s = session.value;
  const byKey = new Map(rows.map((r) => [r.key, r.row]));
  const fresh = !s || (s.closedAt !== null && now - s.closedAt > SESSION_GAP);
  const q = fresh ? take(rows, doneMarks) : reopen(s.q, rows, doneMarks);
  const sinceMap = new Map(q.keys.map((k) => [k, sinceOf(byKey.get(k)!)]));
  const focus = !fresh && s.focus && q.keys.includes(s.focus) ? s.focus : (q.keys[0] ?? null);
  session.value = { q, since: sinceMap, replied: new Map(), focus, openedAt: now, closedAt: null, acted: false };
}

function update(f: (s: Session) => Partial<Session>) {
  const s = session.value;
  if (s) session.value = { ...s, ...f(s) };
}

// ------------------------------------------------------------------ actions

const rowOf = (key: string) => queueRows().find((r) => r.key === key);

function done(key: string) {
  const r = rowOf(key);
  if (r) markDone(key, r.last);
  if (key.startsWith('mth_')) void import('../mail/api.ts').then((m) => m.markThreadRead(key));
  // A person's chat reads every route.
  else if (r?.row.kind === 'conv') rowConvs(r.row).forEach((c) => markRead(c.id));
  else markRead(key);
  update((s) => {
    const q = remove(s.q, key);
    return { q, focus: s.focus === key ? focusAfter(s.q.keys, q.keys, key) : s.focus, acted: true };
  });
}

function putLater(key: string) {
  update((s) => {
    const q = later(s.q, key);
    return { q, focus: s.focus === key ? focusAfter(s.q.keys, q.keys, key) : s.focus, acted: true };
  });
}

function openCard(key: string) {
  const r = rowOf(key)?.row;
  go({ view: 'inbox', conv: r?.kind === 'conv' ? r.conv.id : key });
}

function setFocus(key: string | null) {
  update((s) => ({ focus: key, q: key ? seen(s.q, key) : s.q }));
}

/** The account a reply goes out as: the conversation's choice in its composer, else one that is online. */
function sendAs(c: P.ConversationView): string | undefined {
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  return prefs.value.sendAs[c.id] ?? accounts.find((a) => a.status === 'online')?.id ?? accounts[0]?.id;
}

/** Through the conversation's own send path (state.ts `send`): the same outbox, clientId and echo matching. */
function reply(c: P.ConversationView, body: string, key: string) {
  void send(c.id, body, { accountId: sendAs(c) });
  composerDone();
  markRead(c.id);
  update((s) => {
    const replied = new Map(s.replied).set(key, Date.now());
    // Focus goes on to the next card; this one stays where it is, marked Replied.
    const next = s.focus === key ? focusAfter(s.q.keys, s.q.keys.filter((k) => k !== key), key) : s.focus;
    return { replied, focus: next, acted: true };
  });
}

// ------------------------------------------------------------------ the pane

const scrollToCard = (key: string | null) => key && document.querySelector(`.catchup [data-card="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
const touchKeyboard = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function CatchUp() {
  rev.value;
  // A mail thread the hub listed whose view has not come yet: its mail event draws the queue again.
  if (mailRowsWaiting()) mailRev.value;
  // A phone draws this pane under the inbox list too; it is only open on its own tab.
  const shown = !phone.value || route.value.view === 'triage';
  const s = session.value;

  useEffect(warmUp, []);
  const started = warm.value;
  useEffect(() => {
    if (!shown || !started) return;
    void loadMailTriage();
    openSession(queueRows());
    return () => update(() => ({ closedAt: Date.now() }));
  }, [shown, started]);

  // What newly needs you joins the end (catchup.ts); in the first moments, the queue is still being taken.
  const rows = shown && started ? queueRows() : [];
  useEffect(() => {
    const s = session.value;
    if (!shown || !started || !s || s.closedAt !== null) return;
    if (!s.acted && Date.now() - s.openedAt < SETTLING) {
      const q = take(rows, doneMarks);
      if (q.keys.join('\n') !== s.q.keys.join('\n')) {
        const byKey = new Map(rows.map((r) => [r.key, r.row]));
        update((s) => ({ q, since: new Map(q.keys.map((k) => [k, s.since.get(k) ?? sinceOf(byKey.get(k)!)])), focus: s.focus ?? q.keys[0] ?? null }));
      }
      return;
    }
    if (s.pruneUntil && Date.now() < s.pruneUntil) {
      const q = reopen(s.q, rows, doneMarks);
      if (q.keys.join('\n') === s.q.keys.join('\n')) return;
      update((s) => ({ q: { keys: q.keys, fresh: s.q.fresh.filter((k) => q.keys.includes(k)) }, focus: s.focus && q.keys.includes(s.focus) ? s.focus : (q.keys[0] ?? null) }));
      return;
    }
    const q = arrive(s.q, rows, doneMarks);
    if (q === s.q) return;
    const byKey = new Map(rows.map((r) => [r.key, r.row]));
    const sinceMap = new Map(s.since);
    for (const k of q.keys) if (!sinceMap.has(k)) sinceMap.set(k, sinceOf(byKey.get(k)!));
    update((s) => ({ q, since: sinceMap, focus: s.focus ?? q.keys[0] ?? null }));
  });

  // j, k, Enter, e, l and r; never while typing, or with a menu or dialog over the page.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable], .cm, .sheet-layer, .modal-backdrop, .switcher-back')) return;
      if (document.querySelector('.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer')) return;
      const s = session.value;
      if (!s) return;
      const f = s.focus && s.q.keys.includes(s.focus) ? s.focus : null;
      switch (e.key) {
        case 'j':
        case 'k': {
          const to = step(s.q.keys, f, e.key === 'j' ? 1 : -1);
          setFocus(to);
          scrollToCard(to);
          break;
        }
        case 'Enter':
          // Enter on a button presses it.
          if (!f || el?.closest?.('button, a')) return;
          openCard(f);
          break;
        case 'e':
          if (!f) return;
          done(f);
          break;
        case 'l':
          if (!f) return;
          putLater(f);
          break;
        case 'r': {
          const box = f && document.querySelector<HTMLTextAreaElement>(`.catchup [data-card="${CSS.escape(f)}"] textarea:not(:disabled)`);
          if (!box) return;
          box.focus();
          box.scrollIntoView({ block: 'nearest' });
          break;
        }
        default:
          return;
      }
      countKey(`catch up: key ${e.key}`);
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [shown]);

  const [drawn, setDrawn] = useState(DRAWN);
  // After Done, Later or a reply, the focused card comes into view. Opening on the first card, it is in view already:
  // asking would lay the whole page out inside the task that draws it (60-130 ms at 4x on a phone).
  const focus = s?.focus ?? null;
  const opened = useRef(false);
  useLayoutEffect(() => {
    const first = !opened.current;
    opened.current = true;
    if (first && focus && document.querySelector('.catchup [data-card]')?.getAttribute('data-card') === focus) return;
    scrollToCard(focus);
  }, [focus]);

  // Each card's tier, from what triage decided on its messages since it joined. Not before there are cards.
  const decided = useMemo(() => {
    const by = new Map<string, BoardItem[]>();
    if (!shown || !s) return by;
    for (const m of [...inbox.value, ...mailTriage.value]) {
      // A person's chat is one card over every route (model.ts).
      const k = isMailItem(m) ? lineKey(m) : inboxKeyOf(m.conversationId);
      const l = by.get(k);
      if (l) l.push(m);
      else by.set(k, [m]);
    }
    return by;
  }, [inbox.value, mailTriage.value, shown && !!s]);

  if (!shown || !s) return <section class="pane catchup" aria-label="Catch up" />;
  const byKey = new Map(rows.map((r) => [r.key, r.row]));
  const keys = s.q.keys.filter((k) => byKey.has(k));
  const waiting = keys.filter((k) => !s.replied.has(k) || rowUnread(byKey.get(k)!)).length;
  const fresh = s.q.fresh.filter((k) => byKey.has(k));
  const at = focus ? keys.indexOf(focus) : -1;
  // Drawn: the first DRAWN and as many more as scrolling asked for, and always the focused card and a few after it.
  const upTo = Math.max(drawn, at + AHEAD + 1);
  const accounts = accountsNeedingYou();
  const last = Math.max(0, ...rows.map((r) => r.last));
  return (
    <section class="pane catchup" aria-label="Catch up" data-track-area="catch up">
      <header class="catchup-head">
        <h2>
          Catch up {waiting > 0 && <span class="catchup-count">· {waiting} waiting</span>}
        </h2>
        {fresh.length > 0 && (
          <button
            class="catchup-new"
            data-track="new note"
            title="Joined the end of the queue since you opened it"
            onClick={() => {
              setFocus(fresh[0]);
              scrollToCard(fresh[0]);
            }}
          >
            {fresh.length} new <Icon name="chevronDown" size={12} />
          </button>
        )}
        <span class="catchup-actions">
          <button
            class="btn ghost small"
            data-track="mark all read"
            title="Mark every conversation read, here and on the networks"
            onClick={() => {
              markAllRead([...db.conversations.values()].filter(visibleConv), 'all your accounts');
              // The reads come back as events: what then no longer needs you leaves. A reply you owe stays.
              update(() => ({ pruneUntil: Date.now() + 10_000, acted: true }));
            }}
          >
            <Icon name="check" size={14} /> Mark all read
          </button>
          <button class="btn ghost small" data-track="how it sorts" title="Where triage put each message this week, and why" onClick={() => go({ view: 'model' })}>
            <Icon name="sparkles" size={14} /> How it sorts
          </button>
        </span>
      </header>
      {accounts.length > 0 && (
        <div class="catchup-accounts" role="status">
          <Icon name="alert" size={14} />
          <span>
            {accounts.length} {accounts.length === 1 ? 'account needs' : 'accounts need'} you ·{' '}
            {accounts.map((a, i) => (
              <>
                {i > 0 && ', '}
                <button class="link-btn" data-track="account needs you" title={a.attention?.message} onClick={() => go({ view: 'accounts', account: a.id })}>
                  {a.label}
                </button>
              </>
            ))}
          </span>
        </div>
      )}
      <div class="catchup-scroll">
        {waiting === 0 && (
          <div class="catchup-empty">
            <Icon name="checks" size={34} />
            <h3>All caught up</h3>
            <p title={last ? fullTime(last) : undefined}>{last ? `The last message came ${lastAgo(last)}.` : 'No messages yet.'}</p>
            <button class="link-btn" data-track="how it sorts (all caught up)" onClick={() => go({ view: 'model' })}>
              How it sorts
            </button>
          </div>
        )}
        {keys.slice(0, upTo).map((k, i) => {
          const r = byKey.get(k)!;
          const props = { focused: k === focus, ahead: at >= 0 && i >= at && i <= at + AHEAD, owedSince: r.needs ? r.owedSince : null, onFocus: () => k !== focus && setFocus(k) };
          if (r.kind === 'mail') {
            const items = decided.get(k) ?? [];
            const unread = items.filter((m) => (m as P.MailTriageItem).unread);
            return <MailCard key={k} t={r.thread} tier={topTier(unread.length ? unread : items)} {...props} />;
          }
          const from = s.since.get(k) ?? sinceOf(r);
          return <ChatCard key={k} k={k} r={r} since={from} tier={topTier((decided.get(k) ?? []).filter((m) => m.ts > from))} replied={s.replied.has(k)} {...props} />;
        })}
        {keys.length > upTo && <More key={upTo} left={keys.length - upTo} onMore={() => setDrawn(upTo + DRAWN)} />}
      </div>
      {keys.length > 0 && !phone.value && (
        <div class="catchup-keys" aria-hidden="true">
          <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>e</kbd> done · <kbd>l</kbd> later · <kbd>r</kbd> reply · <kbd>Esc</kbd> leave the box
        </div>
      )}
    </section>
  );
}

const lastAgo = (ts: number) => {
  const t = sinceText(ts);
  return t === 'now' ? 'just now' : `${t} ago`;
};

/** The end of the cards drawn: coming near it draws the next ones. A button too, for a press. */
function More({ left, onMore }: { left: number; onMore: () => void }) {
  const el = useRef<HTMLButtonElement>(null);
  const near = useNear(el);
  useEffect(() => void (near && onMore()), [near]);
  return (
    <button ref={el} class="btn ghost small cu-more" data-track="more" onClick={onMore}>
      {left} more
    </button>
  );
}

// ------------------------------------------------------------------ cards

interface CardProps {
  focused: boolean;
  /** The focused card or one of the few after it: its messages load before it is scrolled to. */
  ahead: boolean;
  owedSince: number | null;
  /** The highest tier among its messages since you last read it. */
  tier: P.NotifyTier | null;
  onFocus: () => void;
}

/** True once the element is on screen or near it. */
function useNear(el: { current: HTMLElement | null }): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !el.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '300px 0px' });
    io.observe(el.current);
    return () => io.disconnect();
  }, [near]);
  return near;
}

/** A card's tier; what fell below the list has no tag. */
function TierTag({ tier }: { tier: P.NotifyTier | null }) {
  if (!tier || tier === 'drop') return null;
  return (
    <span class={`tier-chip ${tier}`} title="The highest tier among its messages since you last read it">
      <Icon name={TIER_ICON[tier]} size={10} /> {TIER_LABEL[tier]}
    </span>
  );
}

function Waiting({ at }: { at: number | null }) {
  if (at === null) return null;
  return (
    <span class="cu-owed" title={`You have not answered since ${fullTime(at)}`}>
      <Icon name="reply" size={11} /> waiting {sinceText(at)}
    </span>
  );
}

/** A conversation's picture as the inbox shows it: the person for a DM, the community for a channel. */
function ConvAvatar({ c }: { c: P.ConversationView }) {
  const com = communitiesOf(c)[0];
  const accountIds = c.vantages.map((v) => v.accountId);
  if ((c.shape === 'channel' || c.shape === 'thread') && com) return <Avatar id={com.id} name={com.name} url={com.icon} size={32} square network={c.network} accountIds={accountIds} />;
  const url = c.shape === 'direct' && c.peerPersonId ? (db.persons.get(c.peerPersonId)?.avatar ?? c.avatar) : c.avatar;
  return <Avatar id={c.peerPersonId ?? c.id} name={convTitle(c)} url={url} size={32} square={c.shape !== 'direct'} network={c.network} accountIds={accountIds} icon={c.shape === 'self' ? '✎' : undefined} />;
}

/** A picture in a card: a file the network called just a file shows as one when its bytes are a picture. */
const isImage = (a: P.AttachmentView) => a.kind === 'image' || (a.kind === 'file' && a.info?.kind === 'image');

function CardMessage({ m, names }: { m: P.MessageView; names: boolean }) {
  const self = isSelfIdentity(m.authorId);
  const images = m.attachments.filter(isImage);
  const files = m.attachments.filter((a) => !isImage(a));
  const text = plainBody(m.body, m.network);
  const shown: ViewerImage[] = images.map((a) => ({ url: a.url, name: a.name, width: a.width, height: a.height }));
  return (
    <div class={`cu-msg ${self ? 'self' : ''}`} data-mid={m.id}>
      <span class="cu-msg-line">
        {(names || self) && <b>{authorName(m.authorId)}</b>}
        {text ? <span class="cu-msg-text">{text}</span> : !m.attachments.length && <span class="cu-msg-text muted">{m.kind === 'encrypted' ? 'Encrypted message' : 'Message'}</span>}
        <span class="cu-msg-time" title={fullTime(m.ts)}>
          {ago(m.ts)}
        </span>
      </span>
      {images.length > 0 && (
        <span class="cu-thumbs">
          {images.map((a, i) => (
            <a
              class="cu-thumb"
              href={a.url}
              target="_blank"
              rel="noreferrer"
              data-track="picture"
              onClick={(e) => {
                if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
                e.preventDefault();
                viewer.value = { images: shown, index: i };
              }}
            >
              <img src={a.url} alt={a.name ?? ''} loading="lazy" />
            </a>
          ))}
        </span>
      )}
      {files.map((a) => (
        <span class="cu-file">
          <Icon name="paperclip" size={11} /> {a.name ?? 'file'}
        </span>
      ))}
    </div>
  );
}

/**
 * A conversation's card, or a person's chat of several routes as one (`r.chat`): then the messages are every
 * route's, and a reply goes through the route of the latest message, where they last wrote.
 */
function ChatCard({ k, r, since, replied, focused, ahead, owedSince, tier, onFocus }: CardProps & { k: string; r: ConvInboxRow; since: number; replied: boolean }) {
  const c = r.conv;
  const ids = rowConvs(r).map((x) => x.id);
  const tkey = r.chat ? timelineKey('p', r.chat.person.id) : timelineKey('c', c.id);
  timelineRev(tkey).value;
  const el = useRef<HTMLDivElement>(null);
  const near = useNear(el);
  const load = near || ahead;
  useEffect(() => void (load && loadTimeline(tkey, false, { glance: true })), [load, tkey]);
  const [all, setAll] = useState(false);
  const t = timelines.get(tkey);
  const msgs = (t?.messages ?? []).filter((m) => m.ts > since && !m.deleted && m.kind !== 'system');
  const shown = all ? msgs : msgs.slice(-SHOWN);
  const earlier = msgs.length - shown.length;
  // Not yet sent: as the timeline shows them, and gone once their message is here (outbox.ts).
  const mine = pending.value.filter((p) => ids.includes(p.conversationId) && !p.echoed);
  const com = c.shape === 'channel' || c.shape === 'thread' ? communitiesOf(c)[0] : undefined;
  const names = c.shape !== 'direct';
  return (
    <div ref={el} class={`cu-card ${focused ? 'focused' : ''} ${replied ? 'replied' : ''}`} data-card={k} data-owed={owedSince !== null ? '1' : undefined} onClick={onFocus}>
      <div class="cu-head">
        <ConvAvatar c={c} />
        <span class="cu-who">
          <span class="cu-top">
            <span class="cu-name">{c.shape === 'direct' ? convTitle(c) : convLabel(c)}</span>
            {com && <span class="cu-where">{com.name}</span>}
          </span>
          <span class="cu-tags">
            {replied ? (
              <span class="cu-replied">
                <Icon name="check" size={11} /> Replied
              </span>
            ) : (
              <Waiting at={owedSince} />
            )}
            <TierTag tier={tier} />
          </span>
        </span>
        <span class="cu-time" title={c.lastMessageAt ? fullTime(c.lastMessageAt) : undefined}>
          {ago(c.lastMessageAt)}
        </span>
      </div>
      <div class="cu-msgs">
        {earlier > 0 && (
          <button class="link-btn cu-earlier" data-track="earlier" onClick={() => setAll(true)}>
            and {earlier} earlier
          </button>
        )}
        {shown.map((m) => (
          <CardMessage key={m.id} m={m} names={names} />
        ))}
        {!t && c.lastMessage && (
          <div class="cu-msg loading">
            <span class="cu-msg-line">
              {names && <b>{authorName(c.lastMessage.authorId)}</b>}
              <span class="cu-msg-text">{plainBody(c.lastMessage.text, c.network)}</span>
            </span>
          </div>
        )}
        {t && !t.loading && !msgs.length && !mine.length && <div class="cu-msg muted">Nothing new since you last read it.</div>}
        {mine.map((p) => (
          <div key={p.tempId} class={`cu-msg self pending ${p.failed ? 'failed' : ''}`} data-temp-id={p.tempId}>
            <span class="cu-msg-line">
              <b>You</b>
              <span class="cu-msg-text">{p.body}</span>
              <span class="cu-msg-time">{p.failed ? 'Failed' : p.queued ? 'Waiting for the hub' : 'Sending…'}</span>
            </span>
            {p.failed && (
              <span class="cu-pending-actions">
                <button class="btn ghost small" data-track="reply: try again" onClick={() => retrySend(p.tempId)}>
                  Try again
                </button>
                <button class="btn ghost small" data-track="reply: discard" onClick={() => discardSend(p.tempId)}>
                  Discard
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div class="cu-foot">
        <ReplyBox c={c} k={k} />
        <span class="cu-actions">
          <button class="btn ghost small" data-track="done" title="Mark it read, and take it off the queue (e)" onClick={(e) => (e.stopPropagation(), done(k))}>
            <Icon name="check" size={14} /> Done
          </button>
          <button class="btn ghost small" data-track="later" title="To the end of the queue, for now (l)" onClick={(e) => (e.stopPropagation(), putLater(k))}>
            <Icon name="clock" size={14} /> Later
          </button>
          <button class="btn ghost small" data-track="open" title="Open the conversation (Enter)" onClick={(e) => (e.stopPropagation(), openCard(k))}>
            Open <Icon name="chevronRight" size={14} />
          </button>
        </span>
      </div>
    </div>
  );
}

/** One line that grows, sending through the conversation's own path. Its draft is the conversation's composer's. */
function ReplyBox({ c, k }: { c: P.ConversationView; k: string }) {
  const draftKey = `dither-chat:draft:${c.id}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const blocked = composerBlocker(c, sendAs(c));
  // Never measured while empty: measuring each card's box would lay out the page once a card.
  useGrow(ta, text);
  const type = (v: string) => {
    setText(v);
    if (v) localStorage.setItem(draftKey, v);
    else localStorage.removeItem(draftKey);
  };
  /** The button's press is counted by its data-track; Enter here. */
  const submit = (enter: boolean) => {
    const body = text.trim();
    if (!body || blocked) return;
    if (enter) countKey('catch up: reply sent (Enter)');
    type('');
    ta.current?.blur();
    reply(c, body, k);
  };
  // Where the composer cannot send, the card says why instead of offering a box.
  if (blocked)
    return (
      <span class="cu-reply disabled" title={blocked}>
        <Icon name="lock" size={13} />
        <span class="cu-blocked">{blocked}</span>
      </span>
    );
  return (
    <span class="cu-reply" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ta}
        rows={1}
        value={text}
        data-track="reply box"
        placeholder={`Reply to ${c.shape === 'direct' ? convTitle(c) : convLabel(c)}`}
        enterkeyhint={touchKeyboard() ? 'enter' : 'send'}
        onInput={(e) => {
          const v = (e.target as HTMLTextAreaElement).value;
          type(v);
          composerTyped({ conversationId: c.id, accountId: sendAs(c) }, v);
        }}
        onFocus={() => setFocus(k)}
        onBlur={composerDone}
        onKeyDown={(e) => {
          // As in the composer: a phone keyboard has no Shift+Enter, so there Enter is a new line and the button sends.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!touchKeyboard() || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            countKey('catch up: leave the box (Esc)');
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      <button class="send-btn" data-track="reply sent" disabled={!text.trim()} aria-label="Send" onMouseDown={(e) => e.preventDefault()} onClick={() => submit(false)}>
        <Icon name="send" size={15} />
      </button>
    </span>
  );
}

function MailCard({ t, focused, owedSince, tier, onFocus }: CardProps & { t: P.MailThreadView }) {
  const other = [...t.from].reverse().find((f) => !f.self) ?? t.from[t.from.length - 1];
  const person = other?.personId ? db.persons.get(other.personId) : undefined;
  const name = t.participants <= 2 ? (person?.name ?? other?.name ?? other?.email ?? '?') : senderLine(t);
  return (
    <div class={`cu-card cu-mail ${focused ? 'focused' : ''}`} data-card={t.id} data-mail="1" data-owed={owedSince !== null ? '1' : undefined} onClick={onFocus}>
      <div class="cu-head">
        <Avatar id={person?.id ?? other?.email ?? t.id} name={name} url={person?.avatar} size={32} square={t.participants > 2} network="email" />
        <span class="cu-who">
          <span class="cu-top">
            <span class="cu-name">{name}</span>
            <span class="cu-where">
              <Icon name="mail" size={11} /> by email
            </span>
          </span>
          <span class="cu-tags">
            <Waiting at={owedSince} />
            <TierTag tier={tier} />
          </span>
        </span>
        <span class="cu-time" title={fullTime(t.lastAt)}>
          {ago(t.lastAt)}
        </span>
      </div>
      <div class="cu-msgs">
        <div class="cu-msg">
          <span class="cu-msg-line">
            <b class="cu-subject">{t.subject || '(no subject)'}</b>
            {t.preview && <span class="cu-msg-text">{t.preview}</span>}
          </span>
        </div>
      </div>
      <div class="cu-foot">
        <span class="cu-actions">
          <button class="btn ghost small" data-track="open (mail)" title="Open the thread (Enter)" onClick={(e) => (e.stopPropagation(), openCard(t.id))}>
            Open <Icon name="chevronRight" size={14} />
          </button>
          <button class="btn ghost small" data-track="done (mail)" title="Mark it read, and take it off the queue (e)" onClick={(e) => (e.stopPropagation(), done(t.id))}>
            <Icon name="check" size={14} /> Done
          </button>
        </span>
      </div>
    </div>
  );
}
