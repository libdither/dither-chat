import type * as P from '@dither-chat/protocol';
import { ago } from '../format.ts';
import { accountsNeedingYou, authorName, communitiesOf, convLabel, plainBody, unreadOf, visibleConv } from '../model.ts';
import { useEffect, useState } from 'preact/hooks';
import { db, go, inbox, markAllRead, rev } from '../state.ts';
import { forgetFactor, levelOf, loadPolicy, loadShadow, relearn, triagePolicy, triageShadow } from '../triage.ts';
import { TierVote } from './TierVote.tsx';
import { Avatar, SourceChip } from './bits.tsx';
import { Icon } from './icons.tsx';
import { useMenu } from './ContextMenu.tsx';
import { messageMenu } from './menus.tsx';

function PingCard({ m }: { m: P.MessageView }) {
  const ctx = useMenu(() => messageMenu(m));
  const c = db.conversations.get(m.conversationId);
  if (!c) return null;
  const com = communitiesOf(c)[0];
  const author = m.authorId ? db.identities.get(m.authorId) : null;
  const person = author?.personId ? db.persons.get(author.personId) : null;
  const t = m.triage!;
  const unread = (c.vantages.some((v) => (v.lastReadTs ?? 0) < m.ts) && unreadOf(c).unread > 0) || false;
  return (
    <div class={`ping ${unread ? 'unread' : ''}`} data-mid={m.id} {...ctx}>
      <button class="ping-main" onClick={() => go({ view: 'inbox', conv: c.id })}>
        <Avatar id={person?.id ?? m.authorId ?? m.id} name={authorName(m.authorId)} url={person?.avatar ?? author?.avatar} size={34} network={c.network} accountIds={m.seenVia} />
        <span class="ping-text">
          <span class="ping-top">
            <b>{authorName(m.authorId)}</b>
            <span class="ping-where">
              in {c.shape === 'direct' ? 'a DM' : convLabel(c)}
              {com ? ` · ${com.name}` : ''}
            </span>
            <span class="ping-time">{ago(m.ts)}</span>
          </span>
          <span class="ping-body">{plainBody(m.body, m.network).slice(0, 220) || (m.attachments.length ? 'Sent an attachment' : '')}</span>
          <span class="ping-reasons">
            {t.reasons.map((r) => (
              <span class="reason">{r}</span>
            ))}
          </span>
        </span>
      </button>
      <span class="ping-fb">
        <TierVote m={m} />
      </span>
    </div>
  );
}

const DIGEST_SHOWN = 40;

export function InboxBoard() {
  rev.value;
  const [allDigest, setAllDigest] = useState(false);
  const items = inbox.value.filter((m) => {
    const c = db.conversations.get(m.conversationId);
    return c && visibleConv(c);
  });
  // The last week, by where each one is now: a vote moves it between the lists at once.
  const week = Date.now() - 7 * 86_400_000;
  const recent = items.filter((m) => m.triage && m.ts > week);
  const at = (l: P.TriageDecision) => recent.filter((m) => levelOf(m.triage!) === l);
  const important = at('push').slice(0, 40);
  const active = at('quiet').slice(0, 40);
  // What matters most first, as the model sees it; then the newest.
  const byScore = (a: P.MessageView, b: P.MessageView) => (b.triage!.score ?? 0) - (a.triage!.score ?? 0) || b.ts - a.ts;
  const digest = at('digest').sort(byScore);
  const below = at('drop').sort(byScore).slice(0, 30);
  const s = { attention: accountsNeedingYou() };
  return (
    <section class="pane board">
      <header class="board-head">
        <div>
          <h2>Triage</h2>
          <p>Every message from every account goes through the same decision model. Here is where each landed, and why. Vote one up or down a level and it learns from that.</p>
        </div>
        <button class="btn ghost small" title="Mark every conversation read, here and on the networks" onClick={() => markAllRead([...db.conversations.values()].filter(visibleConv), 'all your accounts')}>
          <Icon name="check" size={14} /> Mark all read
        </button>
        <div class="board-stats">
          <span>
            <b>{important.length}</b> important
          </span>
          <span>
            <b>{active.length}</b> active
          </span>
          <span>
            <b>{digest.length}</b> in digest
          </span>
          <span>
            <b>{s.attention.length}</b> need you
          </span>
        </div>
      </header>
      <div class="board-scroll">
        {s.attention.length > 0 && (
          <div class="board-block">
            <h3>
              <Icon name="alert" size={15} /> Accounts that need you
            </h3>
            {s.attention.map((a) => (
              <button class="attention-card" onClick={() => go({ view: 'accounts', account: a.id })}>
                <SourceChip network={a.network} accountIds={[a.id]} />
                <b>{a.label}</b>
                <span>{a.attention?.message}</span>
                <span class="attention-cta">{a.attention?.kind === 'link_device' ? 'Show QR' : a.attention?.liveView ? 'Open live view' : 'Details'} →</span>
              </button>
            ))}
          </div>
        )}
        <div class="board-block">
          <h3>
            <Icon name="bell" size={15} /> Important
          </h3>
          <p class="muted">Buzzed your phone and notified your desktop.</p>
          {important.length === 0 && <p class="muted">Nothing this week.</p>}
          {important.map((m) => (
            <PingCard m={m} />
          ))}
        </div>
        <div class="board-block">
          <h3>
            <Icon name="bellOff" size={15} /> Active
          </h3>
          <p class="muted">A silent notification on your phone; nothing on the desktop.</p>
          {active.length === 0 && <p class="muted">Nothing this week.</p>}
          {active.map((m) => (
            <PingCard m={m} />
          ))}
        </div>
        <div class="board-block">
          <h3>
            <Icon name="layers" size={15} /> Digest
          </h3>
          <p class="muted">Held back instead of notifying, what matters most first. Read it when you feel like it, or vote one up or down.</p>
          {digest.length === 0 && <p class="muted">Nothing this week.</p>}
          {(allDigest ? digest : digest.slice(0, DIGEST_SHOWN)).map((m) => (
            <PingCard m={m} />
          ))}
          {!allDigest && digest.length > DIGEST_SHOWN && (
            <button class="btn ghost small" onClick={() => setAllDigest(true)}>
              Show all {digest.length}
            </button>
          )}
        </div>
        {below.length > 0 && (
          <details class="board-block below">
            <summary>
              <Icon name="eyeOff" size={15} /> Not interesting <span class="muted">· the closest {below.length} from the last two days</span>
            </summary>
            <p class="muted">Not even the digest: these stay unread in their chats. Vote one up if it should have made the digest.</p>
            {below.map((m) => (
              <PingCard m={m} />
            ))}
          </details>
        )}
        <Learned />
      </div>
    </section>
  );
}

const HEAD_LABEL: Record<P.TriageHead, string> = { ping: 'Ping', active: 'Notify', interesting: 'Digest' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
      <Icon name="eye" size={13} /> Learning from what you do, in the background: over the last {plural(days, 'day')} it would have pinged{' '}
      {fewer >= 0 ? `${fewer} fewer` : `${-fewer} more`} ({s.shadow.ping} instead of {s.live.ping}), missed {plural(s.answered.missed, 'message')} you answered within 15 minutes
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
        For each message it predicts three chances: worth a ping (at {Math.round(t.ping * 100)}% it buzzes), worth a silent notification (at {Math.round(t.active * 100)}%), and interesting enough for the digest (at{' '}
        {Math.round(t.interesting * 100)}%). It starts from what Discord, Signal and the rest would notify you about; your votes move it from there, one chat at once, a person or a server
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
        <div class="rule-row">
          <span class={`factor-weight ${f.weight > 0 ? 'up' : 'down'}`} title={`${f.weight > 0 ? '+' : ''}${f.weight.toFixed(2)} log-odds`}>
            {f.weight > 0 ? '▲' : '▼'} {HEAD_LABEL[f.head]}
          </span>
          <span class="rule-text">{f.text}</span>
          <span class="rule-votes" title="Votes it was part of">
            {f.votes} vote{f.votes === 1 ? '' : 's'}
          </span>
          <button class="icon-btn small" disabled={busy} title="Forget this, and never learn it again" onClick={act(() => forgetFactor(f.key, true))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      {p.rejected.length > 0 && (
        <details class="rule-dropped">
          <summary>{p.rejected.length} forgotten</summary>
          {p.rejected.map((r) => (
            <div class="rule-row">
              <span class="rule-text">{r.text}</span>
              <button class="btn ghost small" disabled={busy} onClick={act(() => forgetFactor(r.key, false))}>
                Learn again
              </button>
            </div>
          ))}
        </details>
      )}
      <div class="learned-foot">
        <button class="btn ghost small" disabled={busy} onClick={act(relearn)}>
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
