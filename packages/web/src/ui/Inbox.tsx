import type * as P from '@dither-chat/protocol';
import { ago } from '../format.ts';
import { accountsNeedingYou, authorName, communitiesOf, convLabel, convTitle, placeConv, plainBody, rootCommunity, unreadOf, visibleConv } from '../model.ts';
import { useEffect, useState } from 'preact/hooks';
import { TIER_LABEL } from '@dither-chat/protocol';
import { db, go, inbox, markAllRead, rev } from '../state.ts';
import { changeRule, levelOf, loadPolicy, relearn, triagePolicy } from '../triage.ts';
import { TierVote } from './TierVote.tsx';
import { Avatar, Count, SourceChip } from './bits.tsx';
import { Icon } from './icons.tsx';
import { useMenu } from './ContextMenu.tsx';
import { messageMenu } from './menus.tsx';

function placeOf(c: P.ConversationView) {
  const base = placeConv(c);
  const com = base.spaceIds.length ? rootCommunity(base.spaceIds[0]) : null;
  return com;
}

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

interface DigestGroup {
  key: string;
  title: string;
  network: P.Network;
  icon: { id: string; name: string; url: string | null; square: boolean };
  accountIds: string[];
  messages: P.MessageView[];
  places: Set<string>;
  reasons: Set<string>;
  first: P.ConversationView;
}

export function InboxBoard() {
  rev.value;
  const items = inbox.value.filter((m) => {
    const c = db.conversations.get(m.conversationId);
    return c && visibleConv(c);
  });
  // The last week, by where each one is now: a vote moves it between the lists at once.
  const week = Date.now() - 7 * 86_400_000;
  const recent = items.filter((m) => m.triage && m.ts > week);
  const important = recent.filter((m) => levelOf(m.triage!) === 'push').slice(0, 40);
  const active = recent.filter((m) => levelOf(m.triage!) === 'quiet').slice(0, 40);
  const digest = items.filter((m) => m.triage && levelOf(m.triage) === 'digest');
  const groups = new Map<string, DigestGroup>();
  for (const m of digest) {
    const c = db.conversations.get(m.conversationId)!;
    const com = placeOf(c);
    const key = com?.id ?? c.id;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        title: com?.name ?? convTitle(c),
        network: c.network,
        icon: com ? { id: com.id, name: com.name, url: com.icon, square: true } : { id: c.id, name: convTitle(c), url: c.avatar, square: c.shape !== 'direct' },
        accountIds: com?.accountIds ?? c.vantages.map((v) => v.accountId),
        messages: [],
        places: new Set(),
        reasons: new Set(),
        first: c,
      };
      groups.set(key, g);
    }
    g.messages.push(m);
    g.places.add(convLabel(c));
    for (const r of m.triage?.reasons ?? []) g.reasons.add(r);
  }
  const s = { attention: accountsNeedingYou() };
  const digestGroups = [...groups.values()].sort((a, b) => b.messages[0].ts - a.messages[0].ts);
  return (
    <section class="pane board">
      <header class="board-head">
        <div>
          <h2>Triage</h2>
          <p>Every message from every account goes through the same rules. Here is where each landed, and why. Vote one up or down a level and triage learns from it.</p>
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
          <p class="muted">Held back instead of notifying. Read it when you feel like it, or vote one up.</p>
          <div class="digest-grid">
            {digestGroups.map((g) => (
              <div class="digest" role="button" tabIndex={0} onClick={() => go({ view: 'inbox', conv: g.messages[0].conversationId })}>
                <span class="digest-head">
                  <Avatar id={g.icon.id} name={g.icon.name} url={g.icon.url} size={28} square={g.icon.square} network={g.network} accountIds={g.accountIds} />
                  <b>{g.title}</b>
                  <Count n={g.messages.length} muted />
                </span>
                <span class="digest-places">{[...g.places].slice(0, 4).join(', ')}</span>
                {g.messages.slice(0, 3).map((m) => (
                  <span class="digest-line" data-mid={m.id}>
                    <span class="digest-text">
                      <b>{authorName(m.authorId)}</b> {plainBody(m.body, m.network).slice(0, 90)}
                    </span>
                    <TierVote m={m} />
                  </span>
                ))}
                <span class="digest-why">{[...g.reasons][0]}</span>
              </div>
            ))}
          </div>
        </div>
        <Learned />
      </div>
    </section>
  );
}

/** What triage learned from your votes, how well it fits them, and the prompt written from it. */
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
  return (
    <div class="board-block learned">
      <h3>
        <Icon name="sparkles" size={15} /> What it learned from your votes
      </h3>
      <p class="muted">
        {p.votes === 0
          ? 'No votes yet. Vote a notification up or down a level, here or from the notification itself, and rules that explain your votes show up here.'
          : `${p.votes} vote${p.votes === 1 ? '' : 's'}: these rules get ${p.errors} wrong, triage's own rules alone would get ${p.baseline} wrong. Past ${Math.round(p.threshold * 100)}% wrong it learns them again.`}
        {p.learnedAt ? ` Last learned ${ago(p.learnedAt)} (${p.lastReason}).` : ''}
      </p>
      {p.rules.map((r) => (
        <div class={`rule-row ${r.pinned ? 'pinned' : ''}`}>
          <span class="rule-text">{r.text}</span>
          <span class={`tier-chip ${r.level}`}>{TIER_LABEL[r.level]}</span>
          <span class="rule-votes" title="Votes it matches that agree with it">
            {r.agree} of {r.votes} vote{r.votes === 1 ? '' : 's'}
          </span>
          <button class={`icon-btn small ${r.pinned ? 'on' : ''}`} disabled={busy} title={r.pinned ? 'Kept: relearning will not drop it. Click to let it go' : 'Keep it, whatever relearning finds'} onClick={act(() => changeRule(r.key, { pinned: !r.pinned }))}>
            <Icon name="star" size={13} />
          </button>
          <button class="icon-btn small" disabled={busy} title="Drop it, and never learn it (or a narrower version of it) again" onClick={act(() => changeRule(r.key, { rejected: true }))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      {p.rejected.length > 0 && (
        <details class="rule-dropped">
          <summary>{p.rejected.length} dropped</summary>
          {p.rejected.map((r) => (
            <div class="rule-row">
              <span class="rule-text">{r.text}</span>
              <button class="btn ghost small" disabled={busy} onClick={act(() => changeRule(r.key, { rejected: false }))}>
                Allow again
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
            {!p.model && <p class="muted">No local model is set (DITHER_TRIAGE_MODEL), so the rules above apply on their own. With one, smart places ask it with this.</p>}
            <pre>{p.prompt}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
