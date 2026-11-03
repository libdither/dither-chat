import type * as P from '@dither-chat/protocol';
import { ago } from '../format.ts';
import { accountsNeedingYou, authorName, communitiesOf, convLabel, convTitle, placeConv, resolveTokens, rootCommunity, unreadOf, visibleConv } from '../model.ts';
import { db, feedback, go, inbox, markAllRead, rev } from '../state.ts';
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
    <div class={`ping ${unread ? 'unread' : ''}`} {...ctx}>
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
          <span class="ping-body">{resolveTokens(m.body, m.network).slice(0, 220) || (m.attachments.length ? 'Sent an attachment' : '')}</span>
          <span class="ping-reasons">
            {t.reasons.map((r) => (
              <span class="reason">{r}</span>
            ))}
          </span>
        </span>
      </button>
      <span class="ping-fb">
        <button class={`icon-btn small ${t.feedback === 'should_push' ? 'on' : ''}`} title="Right call" onClick={() => feedback(m.id, 'should_push')}>
          <Icon name="thumbsUp" size={14} />
        </button>
        <button class={`icon-btn small ${t.feedback === 'should_not_push' ? 'on' : ''}`} title="Shouldn't have pinged me" onClick={() => feedback(m.id, 'should_not_push')}>
          <Icon name="thumbsDown" size={14} />
        </button>
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
  const dayAgo = Date.now() - 36 * 3600_000;
  const pings = items.filter((m) => m.triage?.decision === 'push' && m.ts > dayAgo - 6 * 86_400_000).slice(0, 30);
  const digest = items.filter((m) => m.triage?.decision === 'digest');
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
    for (const r of m.triage?.reasons ?? []) g.reasons.add(r.replace(/^(Digest only|Mentions only|Smart): ?/, (x) => x));
  }
  const s = { attention: accountsNeedingYou() };
  const digestGroups = [...groups.values()].sort((a, b) => b.messages[0].ts - a.messages[0].ts);
  return (
    <section class="pane board">
      <header class="board-head">
        <div>
          <h2>Triage</h2>
          <p>Every message from every account goes through the same rules. Here is what got through, and why.</p>
        </div>
        <button class="btn ghost small" title="Mark every conversation read, here and on the networks" onClick={() => markAllRead([...db.conversations.values()].filter(visibleConv), 'all your accounts')}>
          <Icon name="check" size={14} /> Mark all read
        </button>
        <div class="board-stats">
          <span>
            <b>{pings.length}</b> pinged
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
            <Icon name="bell" size={15} /> Pinged you
          </h3>
          {pings.length === 0 && <p class="muted">Nothing pushed recently.</p>}
          {pings.map((m) => (
            <PingCard m={m} />
          ))}
        </div>
        <div class="board-block">
          <h3>
            <Icon name="layers" size={15} /> Digest
          </h3>
          <p class="muted">Held back instead of pinging. Read it when you feel like it.</p>
          <div class="digest-grid">
            {digestGroups.map((g) => (
              <button class="digest" onClick={() => go({ view: 'inbox', conv: g.messages[0].conversationId })}>
                <span class="digest-head">
                  <Avatar id={g.icon.id} name={g.icon.name} url={g.icon.url} size={28} square={g.icon.square} network={g.network} accountIds={g.accountIds} />
                  <b>{g.title}</b>
                  <Count n={g.messages.length} muted />
                </span>
                <span class="digest-places">{[...g.places].slice(0, 4).join(', ')}</span>
                {g.messages.slice(0, 3).map((m) => (
                  <span class="digest-line">
                    <b>{authorName(m.authorId)}</b> {resolveTokens(m.body, m.network).replace(/```[\s\S]*?```/g, '[code]').slice(0, 90)}
                  </span>
                ))}
                <span class="digest-why">{[...g.reasons][0]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
