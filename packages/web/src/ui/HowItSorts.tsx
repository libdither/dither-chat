/**
 * How it sorts (docs/notifications.md): which tier triage put each conversation's messages in this week, one line per
 * conversation under Alerts, Conversations, List and Below the list, with why, its importance, and the two marks that
 * teach the models. Under them, what was learned. Reached from Catch up, the inbox's menu and Settings → Notifications.
 */
import type * as P from '@dither-chat/protocol';
import { EXPLORE_REASON } from '@dither-chat/protocol';
import { ago, fullTime } from '../format.ts';
import { BELOW_DAYS, isMailItem, lineKey, linesOf, listPreview, reasonsOf, topImportance, type BoardItem, type BoardLine } from '../board.ts';
import { authorName, board, boardUnread, communitiesOf, convLabel, convTitle, plainBody } from '../model.ts';
import { useEffect, useState } from 'preact/hooks';
import { db, go, loadMailTriage, rev } from '../state.ts';
import { forgetFactor, loadPolicy, loadShadow, relearn, triagePolicy, triageShadow } from '../triage.ts';
import { MarkToggles, percent, TIER_ICON } from './Marks.tsx';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { useMenu } from './ContextMenu.tsx';
import { messageMenu } from './menus.tsx';

/** Who or where a line is about, for its picture and name. */
function lineFace(l: BoardLine): { id: string; name: string; url?: string | null; network: P.Network; accountIds?: string[]; square: boolean; where: string | null } | null {
  const m = l.newest;
  if (isMailItem(m)) {
    const person = m.from.personId ? db.persons.get(m.from.personId) : null;
    return { id: person?.id ?? m.from.email, name: person?.name ?? m.from.name ?? m.from.email, url: person?.avatar, network: 'email', square: false, where: m.subject || '(no subject)' };
  }
  const c = db.conversations.get(l.key);
  if (!c) return null;
  const com = communitiesOf(c)[0];
  const accountIds = c.vantages.map((v) => v.accountId);
  if ((c.shape === 'channel' || c.shape === 'thread') && com) return { id: com.id, name: convLabel(c), url: com.icon, network: c.network, accountIds, square: true, where: com.name };
  const url = c.shape === 'direct' && c.peerPersonId ? (db.persons.get(c.peerPersonId)?.avatar ?? c.avatar) : c.avatar;
  return { id: c.peerPersonId ?? c.id, name: c.shape === 'direct' ? convTitle(c) : convLabel(c), url, network: c.network, accountIds, square: c.shape !== 'direct', where: c.shape === 'direct' ? null : c.shape === 'self' ? null : 'group' };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A message's importance, small, beside its marks. */
function Importance({ score, title }: { score: number | null | undefined; title: string }) {
  if (typeof score !== 'number') return null;
  return (
    <span class="model-imp" data-importance title={title}>
      {percent(score)}
    </span>
  );
}

/** One conversation in one tier: how many of its messages landed there, its importance, its marks, and why. */
function Line({ l, below }: { l: BoardLine; below: boolean }) {
  const [open, setOpen] = useState(false);
  const face = lineFace(l);
  if (!face) return null;
  const unread = l.items.some(boardUnread);
  const mail = isMailItem(l.newest);
  return (
    <div class={`model-line ${unread ? 'unread' : ''} ${open ? 'open' : ''}`} data-line={l.key} data-mail={mail ? '1' : undefined}>
      <div class="model-line-row">
        <button class="model-line-main" data-track={mail ? 'open (mail)' : 'open'} title="Open it" onClick={() => go({ view: 'inbox', conv: l.key })}>
          <Avatar id={face.id} name={face.name} url={face.url} size={30} square={face.square} network={face.network} accountIds={face.accountIds} />
          <span class="model-line-text">
            <span class="model-line-top">
              <b>{face.name}</b>
              {face.where && (
                <span class="model-where">
                  {mail && <Icon name="mail" size={11} />}
                  {mail ? ` by email · ${face.where}` : face.where}
                </span>
              )}
            </span>
            <span class="model-line-sub">
              {plural(l.items.length, 'message')} {below ? `in ${BELOW_DAYS === 2 ? 'two days' : `${BELOW_DAYS} days`}` : 'this week'}
              {unread && <span class="unread-dot" title="Unread" />}
              <span class="model-line-time" title={fullTime(l.newest.ts)}>
                · {ago(l.newest.ts)}
              </span>
            </span>
          </span>
        </button>
        <button class={`btn ghost small model-why-btn ${open ? 'on' : ''}`} aria-expanded={open} data-track={open ? 'why (close)' : 'why'} onClick={() => setOpen(!open)}>
          Why <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />
        </button>
        <Importance score={topImportance(l.items)} title="Importance: the highest among its messages here" />
        <span class="model-marks" title="Marks on its newest message here">
          <MarkToggles m={l.newest} small />
        </span>
      </div>
      {open && <Why l={l} />}
    </div>
  );
}

/** A line's messages beyond this many wait for "Show all". */
const WHY_SHOWN = 20;

/** The reasons, each once, and the messages themselves, each with its own importance and marks. */
function Why({ l }: { l: BoardLine }) {
  const [all, setAll] = useState(false);
  const reasons = reasonsOf(l.items);
  const items = all ? l.items : l.items.slice(0, WHY_SHOWN);
  // The inbox's learned order lifted it for now, to learn about it (docs/inbox.md, "Exploring").
  const lifted = !isMailItem(l.newest) && !!db.attention.get(l.key)?.reasons.includes(EXPLORE_REASON);
  return (
    <div class="model-why" data-track-area="how it sorts (why)">
      {lifted && (
        <div class="model-reasons">
          <span class="reason">In the inbox: {EXPLORE_REASON}</span>
        </div>
      )}
      {reasons.length > 0 && (
        <div class="model-reasons">
          {reasons.map((r) => (
            <span key={r.text} class="reason">
              {r.text}
              {r.n > 1 && l.items.length > 1 && <b> ×{r.n}</b>}
            </span>
          ))}
        </div>
      )}
      <div class="model-msgs">
        {items.map((m) => (isMailItem(m) ? <WhyMail key={m.id} m={m} /> : <WhyMessage key={m.id} m={m} />))}
        {!all && l.items.length > WHY_SHOWN && (
          <button class="link-btn" data-track="show all" onClick={() => setAll(true)}>
            Show all {l.items.length}
          </button>
        )}
      </div>
    </div>
  );
}

function WhyMessage({ m }: { m: P.MessageView }) {
  const ctx = useMenu(() => messageMenu(m));
  return (
    <div class={`model-msg ${boardUnread(m) ? 'unread' : ''}`} data-mid={m.id} {...ctx}>
      <button class="model-msg-main" data-track="message" onClick={() => go({ view: 'inbox', conv: m.conversationId, msg: m.id })}>
        <b>{authorName(m.authorId)}</b>
        <span class="model-msg-text">{plainBody(m.body, m.network).slice(0, 220) || (m.attachments.length ? 'Sent an attachment' : '')}</span>
        <span class="model-msg-time" title={fullTime(m.ts)}>
          {ago(m.ts)}
        </span>
      </button>
      <Importance score={m.triage?.score} title="Its importance" />
      <MarkToggles m={m} small />
    </div>
  );
}

function WhyMail({ m }: { m: P.MailTriageItem }) {
  return (
    <div class={`model-msg ${boardUnread(m) ? 'unread' : ''}`} data-mid={m.id} data-mail="1">
      <button class="model-msg-main" data-track="message (mail)" onClick={() => go({ view: 'inbox', conv: m.threadId })}>
        <b>{m.from.name ?? m.from.email}</b>
        <span class="model-msg-text">
          <span class="model-subject">{m.subject || '(no subject)'}</span>
          {m.preview ? ` — ${m.preview}` : ''}
        </span>
        <span class="model-msg-time" title={fullTime(m.ts)}>
          {ago(m.ts)}
        </span>
      </button>
      <Importance score={m.triage.score} title="Its importance" />
      <MarkToggles m={m} small />
    </div>
  );
}

/** Long lists show this many lines, then a button for the rest. */
const SHOWN = 40;

/** A tier's lines, the first SHOWN until asked for all. */
function Lines({ ms, below = false }: { ms: BoardItem[]; below?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = linesOf(ms, lineKey);
  return (
    <>
      {(all ? lines : lines.slice(0, SHOWN)).map((l) => (
        <Line key={l.key} l={l} below={below} />
      ))}
      {!all && lines.length > SHOWN && (
        <button class="btn ghost small" data-track="show all" onClick={() => setAll(true)}>
          Show all {lines.length}
        </button>
      )}
    </>
  );
}

export function HowItSorts({ onBack }: { onBack?: () => void }) {
  rev.value;
  useEffect(() => void loadMailTriage(), []);
  // The last week, by the tier each message landed in. The badge counts from the same.
  const { alerts, conversations, list, below, alertsUnread, conversationsUnread } = board();
  const convs = (ms: BoardItem[]) => linesOf(ms, lineKey).length;
  const unread = (n: number) => (n > 0 ? ` (${n} unread)` : '');
  return (
    <section class="pane board model-page" aria-label="How it sorts" data-track-area="how it sorts">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon model-icon">
          <Icon name="sparkles" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>How it sorts</h2>
          <div class="conv-head-sub">
            <span class="muted-label">Where messages landed this week, and why</span>
          </div>
        </div>
      </header>
      <div class="board-scroll">
        <p class="model-intro">
          Every message from every account lands in one of three tiers, or below them. A conversation is listed under each tier its messages landed in, with the importance of the most important one there. The two
          buttons on a line mark its newest message there: the bell says it should have alerted (on an alert, that the alert was wrong), the arrow says less like this. Open Why for the reasons and every message,
          each with its own marks. A mark teaches the next decision; it does not move the message.
        </p>
        <p class="model-stats">
          This week:{' '}
          <span data-count="alerts">
            <b>{alerts.length}</b> {alerts.length === 1 ? 'alert' : 'alerts'}
            {unread(alertsUnread)}
          </span>
          ,{' '}
          <span data-count="conversations">
            <b>{conversations.length}</b> {conversations.length === 1 ? 'message' : 'messages'} in conversations
            {unread(conversationsUnread)}
          </span>
          , and{' '}
          <span data-count="list">
            <b>{list.length}</b> on the list
          </span>
          .
        </p>
        <div class="board-block" data-tier="push">
          <h3>
            <Icon name={TIER_ICON.push} size={15} /> Alerts
          </h3>
          <p class="muted">
            Sounded on your phone and notified your desktop{alerts.length ? `: ${plural(alerts.length, 'message')} in ${plural(convs(alerts), 'conversation')}` : ''}. Urgent only. The unread ones count on Catch up,
            with the unread in Conversations.
          </p>
          {alerts.length === 0 && <p class="muted">Nothing this week.</p>}
          <Lines ms={alerts} />
        </div>
        <div class="board-block" data-tier="quiet">
          <h3>
            <Icon name={TIER_ICON.quiet} size={15} /> Conversations
          </h3>
          <p class="muted">People talking with you: a DM, a message about you, or a chat you take part in. A silent row of its own on your phone; nothing on the desktop.</p>
          {conversations.length === 0 && <p class="muted">Nothing this week.</p>}
          <Lines ms={conversations} />
        </div>
        <div class="board-block" data-tier="digest">
          <h3>
            <Icon name={TIER_ICON.digest} size={15} /> List
          </h3>
          <p class="muted">Everything else that is important enough: a silent row in your phone's list, the most important first.</p>
          {list.length === 0 && <p class="muted">Nothing this week.</p>}
          <Lines ms={list} />
        </div>
        {below.length > 0 && (
          <details class="board-block below" data-tier="drop">
            <summary data-track="below the list (open)">
              <Icon name={TIER_ICON.drop} size={15} /> Below the list{' '}
              <span class="muted">
                · the {below.length} most important from the last {BELOW_DAYS === 2 ? 'two days' : `${BELOW_DAYS} days`}
              </span>
            </summary>
            <p class="muted">Not important enough for the list: these stay unread in their chats. If one belonged on it, lower the list's level in Settings.</p>
            <Lines ms={below} below />
          </details>
        )}
        <Learned />
      </div>
    </section>
  );
}

/** What the candidate model, which learns from what you do and only watches, would have put on the list lately. */
function ShadowLine() {
  const s = triageShadow.value;
  useEffect(() => void loadShadow(), []);
  if (!s || !s.decided) return null;
  const days = s.since ? Math.max(1, Math.min(s.days, Math.ceil((Date.now() - s.since) / 86_400_000))) : s.days;
  return (
    <p class="muted shadow-line" title="A second model learns from what you do after messages (answers, opens, taps) as well as your marks. It only watches: it decides nothing until it is switched on.">
      The candidate model would have put {plural(s.shadow, 'message')} on the list where {s.live} {s.live === 1 ? 'was' : 'were'} ({s.both} the same) over the last {plural(days, 'day')}.
    </p>
  );
}

/** What was learned, in words, by what it moves: the chance of an alert up or down, the importance up or down. */
const LEARNED: { head: P.TriageHead; up: boolean; title: string }[] = [
  { head: 'alert', up: true, title: 'More likely to alert' },
  { head: 'alert', up: false, title: 'Less likely to alert' },
  { head: 'important', up: true, title: 'More important' },
  { head: 'important', up: false, title: 'Less important' },
];

/** Where alerts start, the list's level, how well the models fit your marks, and what they learned from them. */
function Learned() {
  const p = triagePolicy.value;
  const [busy, setBusy] = useState(false);
  useEffect(() => void loadPolicy(), []);
  if (!p) return null;
  const act = (f: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const level = p.thresholds.important;
  const preview = listPreview(p.preview, level);
  return (
    <div class="board-block learned">
      <h3>
        <Icon name="sparkles" size={15} /> What it learned from your marks
      </h3>
      <p class="muted" data-learned="bars">
        Alerts start when the local model's answer reaches {p.bars.direct} in DMs and messages about you, {p.bars.other} in chats you take part in. Your marks move them from there: one chat at once, a person or a
        server after a few, everything only after many.
      </p>
      <p class="muted" data-learned="list">
        The list holds what reaches an importance of {percent(level)}
        {preview ? `: ${preview}` : ''}. Importance starts from what Discord, Signal and the rest would notify you about, and moves with what you open and what you mark. The level is yours to set in Settings.
      </p>
      <p class="muted" data-learned="marks">
        {p.votes === 0
          ? 'No marks yet. Mark a message here, from its menu or from its notification, and what is learned shows up here.'
          : `${plural(p.votes, 'mark')}; the model gets ${p.errors} of them wrong, ${p.baseline} without what it learned.`}
        {p.learnedAt ? ` Last learned ${ago(p.learnedAt)} (${p.lastReason}).` : ''}
      </p>
      <ShadowLine />
      {LEARNED.map((g) => {
        const fs = p.factors.filter((f) => f.head === g.head && f.weight > 0 === g.up);
        if (!fs.length) return null;
        return (
          <div key={g.title} class="learned-group" data-head={g.head} data-dir={g.up ? 'up' : 'down'}>
            <h4>{g.title}:</h4>
            {fs.map((f) => (
              <div key={f.key} class="rule-row">
                <span class={`factor-weight ${g.up ? 'up' : 'down'}`} title={`${f.weight > 0 ? '+' : ''}${f.weight.toFixed(2)} log-odds`}>
                  {g.up ? '▲' : '▼'}
                </span>
                <span class="rule-text">{f.text}</span>
                <span class="rule-marks" title="Marks it was part of">
                  {plural(f.votes, 'mark')}
                </span>
                <button class="icon-btn small" disabled={busy} data-track="forget a learned rule" title="Forget this, and never learn it again" onClick={act(() => forgetFactor(f.key, true))}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        );
      })}
      {p.rejected.length > 0 && (
        <details class="rule-dropped">
          <summary>{p.rejected.length} forgotten</summary>
          {p.rejected.map((r) => (
            <div key={r.key} class="rule-row">
              <span class="rule-text">{r.text}</span>
              <button class="btn ghost small" disabled={busy} data-track="learn a forgotten rule again" onClick={act(() => forgetFactor(r.key, false))}>
                Learn again
              </button>
            </div>
          ))}
        </details>
      )}
      <div class="learned-foot">
        <button class="btn ghost small" disabled={busy} data-track="learn again now" onClick={act(relearn)}>
          <Icon name="refresh" size={13} /> Learn again now
        </button>
      </div>
    </div>
  );
}
