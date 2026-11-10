/**
 * How it sorts (docs/notifications.md#voting): where triage put each conversation's messages this week, one line per
 * conversation under Important, Active, Digest and Not interesting, with why, and votes that teach the decision model.
 * Under them, what it learned. Reached from Catch up, the inbox's menu and Settings → Smart triage.
 */
import type * as P from '@dither-chat/protocol';
import { EXPLORE_REASON } from '@dither-chat/protocol';
import { ago, fullTime } from '../format.ts';
import { BELOW_DAYS, isMailItem, lineKey, linesOf, reasonsOf, type BoardItem, type BoardLine } from '../board.ts';
import { authorName, board, boardUnread, communitiesOf, convLabel, convTitle, plainBody } from '../model.ts';
import { useEffect, useState } from 'preact/hooks';
import { db, go, loadMailTriage, rev } from '../state.ts';
import { forgetFactor, HEAD_LABEL, loadPolicy, loadShadow, relearn, triagePolicy, triageShadow } from '../triage.ts';
import { TierVote } from './TierVote.tsx';
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

/** One conversation at one level: how many of its messages landed there, its vote, and why. */
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
        <span class="model-vote" title="Votes on its newest message here">
          <TierVote m={l.newest} />
        </span>
      </div>
      {open && <Why l={l} />}
    </div>
  );
}

/** A line's messages beyond this many wait for "Show all". */
const WHY_SHOWN = 20;

/** The reasons, each once, and the messages themselves, each with its own vote. */
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
      <TierVote m={m} />
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
      <TierVote m={m} />
    </div>
  );
}

/** Long lists show this many lines, then a button for the rest. */
const SHOWN = 40;

/** A level's lines, the first SHOWN until asked for all. Keyed by conversation: a vote moves a message to another level's line. */
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
  // The last week, by where each message is now: a vote moves it between the lists at once. The badge counts from the same.
  const { important, active, digest, below, importantUnread } = board();
  const convs = (ms: BoardItem[]) => linesOf(ms, lineKey).length;
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
          Every message from every account goes through the same decision model. A conversation is listed under each level its messages landed at. The arrows on a line vote on its newest message there; open
          Why for the reasons and every message, each with its own vote. The model learns from each vote.
        </p>
        <p class="model-stats">
          This week:{' '}
          <span data-count="important">
            <b>{important.length}</b> {important.length === 1 ? 'message' : 'messages'} buzzed you{importantUnread > 0 ? ` (${importantUnread} unread)` : ''}
          </span>
          ,{' '}
          <span data-count="active">
            <b>{active.length}</b> came as silent notifications
          </span>
          , and{' '}
          <span data-count="digest">
            <b>{digest.length}</b> waited for the digest
          </span>
          .
        </p>
        <div class="board-block">
          <h3>
            <Icon name="bell" size={15} /> Important
          </h3>
          <p class="muted">Buzzed your phone and notified your desktop{important.length ? `: ${plural(important.length, 'message')} in ${plural(convs(important), 'conversation')}` : ''}. The unread ones are the count on Catch up.</p>
          {important.length === 0 && <p class="muted">Nothing this week.</p>}
          <Lines ms={important} />
        </div>
        <div class="board-block">
          <h3>
            <Icon name="bellOff" size={15} /> Active
          </h3>
          <p class="muted">A silent notification on your phone; nothing on the desktop.</p>
          {active.length === 0 && <p class="muted">Nothing this week.</p>}
          <Lines ms={active} />
        </div>
        <div class="board-block">
          <h3>
            <Icon name="layers" size={15} /> Digest
          </h3>
          <p class="muted">Held back instead of notifying, what matters most first. Read it when you feel like it, or vote one up or down.</p>
          {digest.length === 0 && <p class="muted">Nothing this week.</p>}
          <Lines ms={digest} />
        </div>
        {below.length > 0 && (
          <details class="board-block below">
            <summary data-track="not interesting (open)">
              <Icon name="eyeOff" size={15} /> Not interesting{' '}
              <span class="muted">
                · the closest {below.length} from the last {BELOW_DAYS === 2 ? 'two days' : `${BELOW_DAYS} days`}
              </span>
            </summary>
            <p class="muted">Not even the digest: these stay unread in their chats. Vote one up if it should have made the digest.</p>
            <Lines ms={below} below />
          </details>
        )}
        <Learned />
      </div>
    </section>
  );
}


/** What the candidate model, which learns from what you do and only watches, would have done this week. */
function ShadowLine() {
  const s = triageShadow.value;
  useEffect(() => void loadShadow(), []);
  if (!s || !s.decided) return null;
  const fewer = s.live.ping - s.shadow.ping;
  const days = s.since ? Math.max(1, Math.min(s.days, Math.ceil((Date.now() - s.since) / 86_400_000))) : s.days;
  const explored = s.explored.up + s.explored.down;
  return (
    <p class="muted shadow-line" title="A second model learns from what you do after messages (answers, opens, taps) as well as your votes. It only watches: it decides nothing until it is switched on.">
      Learning from what you do, in the background: over the last {plural(days, 'day')} it would have made{' '}
      {fewer > 0 ? `${fewer} fewer` : fewer < 0 ? `${-fewer} more` : 'as many'} Important ({s.shadow.ping} instead of {s.live.ping}), missed {plural(s.answered.missed, 'message')} you answered within 15 minutes
      {s.answered.gained ? `, and caught ${s.answered.gained} more` : ''}.{explored ? ` ${plural(explored, 'notification')} changed to learn from (silent only).` : ''}
    </p>
  );
}

/** What the decision model learned from your votes, how well it fits them, and the prompt written from it. */
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
  const t = p.thresholds;
  return (
    <div class="board-block learned">
      <h3>
        <Icon name="sparkles" size={15} /> What it learned from your votes
      </h3>
      <p class="muted">
        For each message it predicts three chances: <b>Important</b>, worth buzzing you (at {Math.round(t.ping * 100)}% or more); else <b>Active</b>, worth a silent notification (at{' '}
        {Math.round(t.active * 100)}%); else <b>Digest</b>, interesting enough for the digest (at {Math.round(t.interesting * 100)}%); below that, Not interesting. It starts from what Discord, Signal and the rest would notify you about; your votes move it from there, one chat at once, a person or a server
        after a few, everything only after many.
      </p>
      <p class="muted">
        {p.votes === 0
          ? 'No votes yet. Vote a notification up or down a level, here or from the notification itself, and what it learns shows up here.'
          : `${p.votes} vote${p.votes === 1 ? '' : 's'}: it gets ${p.errors} wrong; the networks' own settings alone would get ${p.baseline} wrong.`}
        {p.learnedAt ? ` Last learned ${ago(p.learnedAt)} (${p.lastReason}).` : ''}
      </p>
      <ShadowLine />
      {p.factors.map((f) => (
        <div key={f.key} class="rule-row">
          <span class={`factor-weight ${f.weight > 0 ? 'up' : 'down'}`} title={`${f.weight > 0 ? '+' : ''}${f.weight.toFixed(2)} log-odds`}>
            {f.weight > 0 ? '▲' : '▼'} {HEAD_LABEL[f.head]}
          </span>
          <span class="rule-text">{f.text}</span>
          <span class="rule-votes" title="Votes it was part of">
            {f.votes} vote{f.votes === 1 ? '' : 's'}
          </span>
          <button class="icon-btn small" disabled={busy} data-track="forget a learned rule" title="Forget this, and never learn it again" onClick={act(() => forgetFactor(f.key, true))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
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
        {p.prompt && (
          <details class="learned-prompt">
            <summary>Decision prompt{p.model ? ` for ${p.model}` : ''}</summary>
            {!p.model && <p class="muted">No local model is set (DITHER_TRIAGE_MODEL), so the model above decides on its own. With one, places set to Smart ask it with this, and its chances become the starting point.</p>}
            <pre>{p.prompt}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
