import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { bytes, clock, dayLabel, fullTime, sameDay } from '../format.ts';
import { isJumbo, renderMarkdown } from '../markdown.ts';
import {
  LEVEL_LABEL,
  authorName,
  plainBody,
  convLabel,
  convTitle,
  crumbs,
  directsOf,
  effectiveLevel,
  identityName,
  kindLabel,
  netName,
  personOf,
  threadsOf,
  visibleAccount,
} from '../model.ts';
import {
  db,
  feedback,
  go,
  isSelfIdentity,
  loadTimeline,
  markRead,
  pending,
  prefs,
  quoted,
  rev,
  route,
  send,
  setPrefs,
  setRule,
  canDelete,
  canEdit,
  deleteMessage,
  editMessage,
  editing,
  jumpTo,
  startEditing,
  loadNewer,
  openProfile,
  toLatest,
  timelineKey,
  timelines,
  typing,
} from '../state.ts';
import { reactionContext, sheetFor } from '../reactions.ts';
import { AccountChip, AccountDots, Avatar, Empty, Menu, NetBadge, NetGlyph, levelIcon, variantIcon } from './bits.tsx';
import { HoverReactions, ReactionBar, useLongPress } from './Reactions.tsx';
import { Icon } from './icons.tsx';
import { openConv } from './Sidebar.tsx';


// ------------------------------------------------------------------ header

function Crumbs({ c }: { c: P.ConversationView }) {
  const r = route.value;
  const within = r.view === 'space' ? r.space : undefined;
  const cs = crumbs(c, within);
  return (
    <span class="crumbs" style={{ '--net': NETWORK_META[c.network].color } as any}>
      {cs.map((x, i) => (
        <>
          {i > 0 && <span class="crumb-sep">›</span>}
          {x.kind === 'network' ? (
            <span class="crumb net">
              <NetGlyph network={c.network} size={11} /> {x.label}
            </span>
          ) : x.kind === 'space' && x.id ? (
            <button class="crumb link" onClick={() => go({ view: 'space', space: x.id! })}>
              {x.label}
            </button>
          ) : x.kind === 'conversation' && x.id && x.id !== c.id ? (
            <button class="crumb link" onClick={() => openConv(db.conversations.get(x.id!)!)}>
              {x.label}
            </button>
          ) : (
            <span class={`crumb ${i === cs.length - 1 ? 'last' : ''}`}>{x.label}</span>
          )}
        </>
      ))}
    </span>
  );
}

export function LevelMenu({ c }: { c: P.ConversationView }) {
  const eff = effectiveLevel(c);
  const levels: P.NotifyLevel[] = ['all', 'smart', 'mentions', 'digest', 'none'];
  const com = c.spaceIds[0] ?? (c.parentId ? db.conversations.get(c.parentId)?.spaceIds[0] : undefined);
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button class={`hdr-btn level ${eff.level}`} onClick={toggle} title={`Notifications: ${LEVEL_LABEL[eff.level]} (${eff.source})`}>
          <Icon name={levelIcon(eff.level)} size={16} />
          <span class="hdr-btn-label">{LEVEL_LABEL[eff.level]}</span>
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu">
          <div class="menu-title">Notify me about {convLabel(c)}</div>
          {levels.map((l) => (
            <button
              class={`menu-item ${eff.explicit && eff.scope === 'conversation' && eff.level === l ? 'on' : ''}`}
              onClick={() => {
                setRule('conversation', c.id, l);
                close();
              }}
            >
              <Icon name={levelIcon(l)} size={15} />
              <span>
                <b>{LEVEL_LABEL[l]}</b>
                <small>{LEVEL_HELP[l]}</small>
              </span>
            </button>
          ))}
          <div class="menu-sep" />
          <button
            class="menu-item"
            onClick={() => {
              setRule('conversation', c.id, null);
              close();
            }}
          >
            <Icon name="refresh" size={15} />
            <span>
              <b>Inherit</b>
              <small>Currently: {LEVEL_LABEL[eff.level]}, from {eff.source}</small>
            </span>
          </button>
          {com && (
            <div class="menu-foot">
              Whole {NETWORK_META[c.network].spaceNoun}:
              {(['mentions', 'digest', 'none'] as const).map((l) => (
                <button
                  class="chip-btn"
                  onClick={() => {
                    const root = db.spaces.get(com);
                    const top = root?.kind === 'section' ? (db.parents.get(com)?.[0]?.parentId ?? com) : com;
                    setRule('space', top, l);
                    close();
                  }}
                >
                  {LEVEL_LABEL[l]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Menu>
  );
}

const LEVEL_HELP: Record<P.NotifyLevel, string> = {
  all: 'Push every message',
  smart: 'Push what looks addressed to you or urgent',
  mentions: 'Push @mentions and replies to you',
  digest: 'Never push; collect into the digest',
  none: 'Silent; unread count only',
};

function ConvHeader({ c, onBack }: { c: P.ConversationView; onBack?: () => void }) {
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  const isDirect = c.shape === 'direct';
  const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  return (
    <header class="conv-head">
      {onBack && (
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <span class="conv-head-icon">
        {isDirect || c.shape === 'group' || c.shape === 'self' ? (
          <Avatar id={person?.id ?? c.id} name={convTitle(c)} url={person?.avatar ?? c.avatar} size={34} square={!isDirect} network={c.network} />
        ) : (
          <span class="conv-head-variant">
            <Icon name={variantIcon(c.variant, c.shape)} size={20} />
          </span>
        )}
      </span>
      <div class="conv-head-text">
        <h2>
          {convTitle(c)}
          {c.encrypted && (
            <span class="e2ee" title="End-to-end encrypted on the network">
              <Icon name="lock" size={12} />
            </span>
          )}
        </h2>
        <div class="conv-head-sub">
          <Crumbs c={c} />
          {accounts.length > 0 && (accounts.length > 1 || db.accounts.size > 1) && (
            <span class="via">
              via
              {accounts.map((a) => (
                <AccountChip account={a} small />
              ))}
            </span>
          )}
        </div>
      </div>
      <div class="conv-head-actions">
        {person && isDirect && (
          <>
            <button class="hdr-btn" title="Profile" onClick={() => go({ view: 'profile', person: person.id })}>
              <Icon name="info" size={16} />
            </button>
            <button class="hdr-btn" title="Open the merged thread with this person" onClick={() => go({ view: 'people', person: person.id })}>
              <Icon name="user" size={16} />
              <span class="hdr-btn-label">All chats</span>
            </button>
          </>
        )}
        <LevelMenu c={c} />
        <button class={`hdr-btn ${prefs.value.details ? 'on' : ''}`} onClick={() => setPrefs({ details: !prefs.value.details })} title="Details">
          <Icon name="panel" size={16} />
        </button>
      </div>
    </header>
  );
}

function PersonHeader({ person, onBack }: { person: P.PersonView; onBack?: () => void }) {
  const directs = directsOf(person.id);
  return (
    <header class="conv-head">
      {onBack && (
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <span class="conv-head-icon">
        <Avatar id={person.id} name={person.name} url={person.avatar} size={34} />
      </span>
      <div class="conv-head-text">
        <h2>
          {person.name}
          {person.starred && <Icon name="star" size={13} class="row-star" />}
        </h2>
        <div class="conv-head-sub">
          <span class="ident-chips">
            {directs.map((d) => {
              const peer = d.participantIds.find((p) => !isSelfIdentity(p));
              const ident = peer ? db.identities.get(peer) : null;
              return (
                <button class="ident-chip" style={{ '--net': NETWORK_META[d.network].color } as any} title={`Open only the ${netName(d.network)} chat`} onClick={() => go({ view: 'inbox', conv: d.id })}>
                  <NetGlyph network={d.network} size={11} />
                  {ident?.handle ?? ident?.displayName ?? netName(d.network)}
                  <AccountDots network={d.network} accountIds={d.vantages.map((v) => v.accountId)} size={6} />
                </button>
              );
            })}
          </span>
        </div>
      </div>
      <div class="conv-head-actions">
        <button class={`hdr-btn ${prefs.value.details ? 'on' : ''}`} onClick={() => setPrefs({ details: !prefs.value.details })} title="Details">
          <Icon name="panel" size={16} />
        </button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ messages

function useMdContext(network: P.Network) {
  return {
    network,
    user: (nativeId: string) => {
      const id = db.identityByNative.get(`${network}:${nativeId}`);
      if (!id) return null;
      return { name: isSelfIdentity(id) ? identityName(id) : authorName(id), self: isSelfIdentity(id) };
    },
    room: (nativeId: string) => {
      for (const c of db.conversations.values()) if (c.network === network && c.nativeId === nativeId) return convTitle(c);
      return null;
    },
  };
}

function Body({ m }: { m: P.MessageView }) {
  const html = useMemo(() => renderMarkdown(m.body, useMdContext(m.network)), [m.body, m.network, rev.value]);
  if (m.deleted) return <div class="msg-body deleted">Message deleted</div>;
  if (m.kind === 'encrypted')
    return (
      <div class="msg-body encrypted">
        <Icon name="lock" size={13} /> Encrypted message. dither-chat can't decrypt Matrix E2EE yet.
      </div>
    );
  if (!m.body) return null;
  return <div class={`msg-body ${isJumbo(m.body) ? 'jumbo' : ''}`} dangerouslySetInnerHTML={{ __html: html }} onClick={(e) => {
    const el = e.target as HTMLElement;
    if (el.classList?.contains('spoiler')) el.classList.add('shown');
    const user = el.dataset?.user;
    if (user) openProfile(db.identityByNative.get(`${m.network}:${user}`));
  }} />;
}

function Attachments({ m }: { m: P.MessageView }) {
  if (!m.attachments.length) return null;
  return (
    <div class="atts">
      {m.attachments.map((a) => {
        if (a.kind === 'image') {
          const w = a.width ?? 400;
          const h = a.height ?? 300;
          const scale = Math.min(1, 400 / w, 300 / h);
          return (
            <a class="att-img" href={a.url} target="_blank" rel="noreferrer" style={{ width: `${Math.round(w * scale)}px`, aspectRatio: `${w} / ${h}` }}>
              <img src={a.url} alt={a.name ?? ''} loading="lazy" />
            </a>
          );
        }
        if (a.kind === 'video') return <video class="att-video" src={a.url} controls preload="metadata" />;
        if (a.kind === 'audio') return <audio class="att-audio" src={a.url} controls preload="metadata" />;
        return (
          <a class="att-file" href={a.url} target="_blank" rel="noreferrer">
            <Icon name="file" size={22} />
            <span>
              <b>{a.name ?? 'file'}</b>
              <small>
                {a.mime ?? 'file'} {a.size ? `· ${bytes(a.size)}` : ''}
              </small>
            </span>
          </a>
        );
      })}
    </div>
  );
}

function Embeds({ m }: { m: P.MessageView }) {
  if (!m.embeds.length) return null;
  const ctx = useMdContext(m.network);
  const md = (text: string) => ({ __html: renderMarkdown(text, ctx) });
  return (
    <div class="embeds">
      {m.embeds.map((e) => (
        <div class="embed">
          {(e.provider || e.author) && <small>{[e.provider, e.author].filter(Boolean).join(' · ')}</small>}
          {e.title && (e.url && /^https?:\/\//i.test(e.url) ? <a class="embed-title" href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a> : <b class="embed-title">{e.title}</b>)}
          {e.description && <div class="msg-body" dangerouslySetInnerHTML={md(e.description)} />}
          {e.fields?.map((f) => (
            <div class="embed-field">
              <b>{f.name}</b>
              <div class="msg-body" dangerouslySetInnerHTML={md(f.value)} />
            </div>
          ))}
          {e.image && <img class="embed-image" src={e.image} alt="" loading="lazy" onError={(ev) => ev.currentTarget.remove()} />}
        </div>
      ))}
    </div>
  );
}

function TriageNote({ m }: { m: P.MessageView }) {
  const t = m.triage;
  if (!t) return null;
  const pushed = t.decision === 'push';
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button class={`triage-pill ${t.decision}`} onClick={toggle} title="Why did this notify (or not)?">
          <Icon name={pushed ? 'bell' : t.decision === 'digest' ? 'layers' : 'bellOff'} size={11} />
          {pushed ? 'pinged' : t.decision}
        </button>
      )}
    >
      {(close) => (
        <div class="triage-pop">
          <div class="menu-title">{pushed ? 'This pinged you because' : t.decision === 'digest' ? 'This went to the digest because' : 'This was silent because'}</div>
          <ul>
            {t.reasons.map((r) => (
              <li>{r}</li>
            ))}
          </ul>
          {t.score !== null && <div class="triage-score">score {t.score.toFixed(2)} · decided by {t.decidedBy}</div>}
          <div class="triage-fb">
            <button
              class={`chip-btn ${t.feedback === 'should_push' ? 'on' : ''}`}
              onClick={() => {
                feedback(m.id, 'should_push');
                close();
              }}
            >
              <Icon name="thumbsUp" size={13} /> {pushed ? 'Right call' : 'Should have pinged'}
            </button>
            <button
              class={`chip-btn ${t.feedback === 'should_not_push' ? 'on' : ''}`}
              onClick={() => {
                feedback(m.id, 'should_not_push');
                close();
              }}
            >
              <Icon name="thumbsDown" size={13} /> {pushed ? "Shouldn't have pinged" : 'Right call'}
            </button>
          </div>
        </div>
      )}
    </Menu>
  );
}

function MessageItem({ m, grouped, merged, onReply, highlight }: { m: P.MessageView; grouped: boolean; merged: boolean; onReply: (m: P.MessageView) => void; highlight: boolean }) {
  const author = m.authorId ? db.identities.get(m.authorId) : null;
  const person = personOf(m.authorId);
  const self = isSelfIdentity(m.authorId);
  const name = self ? (identityName(m.authorId) || 'You') : authorName(m.authorId);
  const conv = db.conversations.get(m.conversationId);
  const target = m.replyToId ? (timelines.get(timelineKey('c', m.conversationId))?.messages.find((x) => x.id === m.replyToId) ?? quoted.get(m.replyToId)) : null;
  const thread = m.threadId ? db.conversations.get(m.threadId) : null;
  const seenVia = m.seenVia.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  const press = useLongPress(() => (sheetFor.value = { message: m, onReply: () => onReply(m) }));

  if (m.kind === 'system')
    return (
      <div class="msg system" id={`m-${m.id}`} {...press}>
        <Icon name="chevronRight" size={12} /> <Body m={m} /> <span class="msg-time">{clock(m.ts)}</span>
        <ReactionBar m={m} />
      </div>
    );

  return (
    <div class={`msg ${grouped ? 'grouped' : ''} ${m.mentionsSelf ? 'mentioned' : ''} ${highlight ? 'flash' : ''}`} id={`m-${m.id}`} {...press}>
      <div class="msg-gutter">
        {grouped ? (
          <span class="msg-time-hover" title={fullTime(m.ts)}>
            {clock(m.ts)}
          </span>
        ) : (
          <button class="avatar-btn" onClick={() => openProfile(m.authorId)} aria-label={`Profile of ${name}`}>
            <Avatar id={person?.id ?? m.authorId ?? m.id} name={name} url={person?.avatar ?? author?.avatar} size={36} />
          </button>
        )}
      </div>
      <div class="msg-main">
        {target && (
          <button class="reply-quote" onClick={() => document.getElementById(`m-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            <Icon name="reply" size={12} />
            <b>{isSelfIdentity(target.authorId) ? 'You' : authorName(target.authorId)}</b>
            <span>{target.deleted ? 'Message deleted' : plainBody(target.body, target.network).slice(0, 120) || 'Attachment'}</span>
          </button>
        )}
        {!grouped && (
          <div class="msg-head">
            <span class={`msg-author ${self ? 'self' : ''}`} role="link" tabindex={0} onClick={() => openProfile(m.authorId)} onKeyDown={(e) => e.key === 'Enter' && openProfile(m.authorId)} title={author ? `${author.displayName ?? ''} ${author.handle ? '· ' + author.handle : ''} on ${netName(author.network)}` : ''}>
              {name}
            </span>
            {author?.isBot && <span class="bot-tag">BOT</span>}
            {merged && conv && (
              <span class="msg-src" title={`${kindLabel(conv)}${seenVia.length ? ' · via ' + seenVia.map((a) => a.label).join(', ') : ''}`}>
                <NetGlyph network={m.network} size={11} />
                {netName(m.network)}
              </span>
            )}
            <span class="msg-time" title={fullTime(m.ts)}>
              {clock(m.ts)}
            </span>
            {m.editedTs && <span class="msg-edited">(edited)</span>}
            <TriageNote m={m} />
          </div>
        )}
        <Body m={m} />
        {grouped && m.editedTs && <span class="msg-edited">(edited)</span>}
        <Attachments m={m} />
        <Embeds m={m} />
        <ReactionBar m={m} />
        {thread && (
          <button class="thread-chip" onClick={() => openConv(thread)}>
            <Icon name="thread" size={13} />
            <b>{convTitle(thread)}</b>
            <span>{thread.lastMessage ? `${authorName(thread.lastMessage.authorId)}: ${thread.lastMessage.text}` : 'Open thread'}</span>
          </button>
        )}
      </div>
      <div class="msg-actions">
        <HoverReactions m={m} />
        {canEdit(m) && (
          <button class="icon-btn small" title="Edit" onClick={() => startEditing(m)}>
            <Icon name="settings" size={14} />
          </button>
        )}
        {canDelete(m) && (
          <button class="icon-btn small" title="Delete" onClick={() => deleteMessage(m)}>
            <Icon name="trash" size={14} />
          </button>
        )}
        <button class="icon-btn small" title="Reply" onClick={() => onReply(m)}>
          <Icon name="reply" size={15} />
        </button>
        {grouped && <TriageNote m={m} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

function Timeline({ tkey, convIds, merged, onReply, firstUnreadTs, focus }: { tkey: string; convIds: string[]; merged: boolean; onReply: (m: P.MessageView) => void; firstUnreadTs: number | null; focus?: string }) {
  rev.value;
  const scroller = useRef<HTMLDivElement>(null);
  const t = timelines.get(tkey);
  const [flash, setFlash] = useState<string | null>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (focus) void jumpTo(convIds[0], focus);
    else loadTimeline(tkey);
    scrolledTo.current = null;
  }, [tkey, focus]);
  useEffect(() => {
    if (!focus || scrolledTo.current === focus) return;
    const el = document.getElementById(`m-${focus}`);
    if (!el) return;
    scrolledTo.current = focus;
    el.scrollIntoView({ block: 'center' });
    setFlash(focus);
    const id = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(id);
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // column-reverse: scrollTop is 0 at the bottom and negative going up.
    if (el.scrollHeight + el.scrollTop - el.clientHeight < 400) loadTimeline(tkey, true);
    if (t?.detached) {
      if (Math.abs(el.scrollTop) < 400) void loadNewer(tkey);
    } else if (Math.abs(el.scrollTop) < 40 && document.visibilityState === 'visible') convIds.forEach(markRead);
  };
  useEffect(() => {
    const id = setTimeout(() => onScroll(), 300);
    return () => clearTimeout(id);
  });

  const mine = pending.value.filter((p) => convIds.includes(p.conversationId));
  const typers = convIds.flatMap((c) => (typing.value[c] ?? []).filter((x) => x.until > Date.now()));
  const msgs = t?.messages ?? [];
  const items: any[] = [];
  let prev: P.MessageView | null = null;
  let dividerDone = false;
  for (const m of msgs) {
    if (!prev || !sameDay(prev.ts, m.ts)) items.push(<div class="day-sep"><span>{dayLabel(m.ts)}</span></div>);
    if (merged && prev && prev.conversationId !== m.conversationId) {
      const c = db.conversations.get(m.conversationId);
      items.push(
        <div class="net-switch" style={{ '--net': NETWORK_META[m.network].color } as any}>
          <span>
            <NetGlyph network={m.network} size={11} /> continued on {netName(m.network)}
            {c && c.vantages.length > 0 && db.accounts.get(c.vantages[0].accountId) && ` · ${db.accounts.get(c.vantages[0].accountId)!.label}`}
          </span>
        </div>,
      );
    }
    if (!dividerDone && firstUnreadTs !== null && m.ts > firstUnreadTs && !isSelfIdentity(m.authorId)) {
      items.push(<div class="new-sep"><span>New</span></div>);
      dividerDone = true;
    }
    const grouped = !!prev && prev.authorId === m.authorId && prev.conversationId === m.conversationId && m.ts - prev.ts < 7 * 60_000 && sameDay(prev.ts, m.ts) && prev.kind !== 'system' && !m.replyToId;
    items.push(<MessageItem key={m.id} m={m} grouped={grouped} merged={merged} onReply={onReply} highlight={m.id === flash} />);
    prev = m;
  }

  return (
    <div class="timeline-scroll" ref={scroller} onScroll={onScroll}>
      <div class="timeline-inner">
        {t && !t.hasMore && msgs.length > 0 && <div class="timeline-start">This is the start of what dither-chat has stored here.</div>}
        {t?.detached && (
          <button class="jump-latest" onClick={() => void toLatest(tkey)}>
            <Icon name="chevronDown" size={14} /> Older messages. Jump to the latest
          </button>
        )}
        {t?.loading && <div class="timeline-loading">Loading…</div>}
        {t && !t.loading && msgs.length === 0 && <Empty icon="groups" title="No messages yet" />}
        {items}
        {mine.map((p) => (
          <div class={`msg pending ${p.failed ? 'failed' : ''}`}>
            <div class="msg-gutter" />
            <div class="msg-main">
              <div class="msg-body">{p.body}</div>
              <span class="pending-note">{p.failed ? `Failed: ${p.failed}` : 'Sending…'}</span>
            </div>
          </div>
        ))}
        {typers.length > 0 && <div class="typing">{[...new Set(typers.map((x) => authorName(x.identityId)))].join(', ')} typing…</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer

function Composer({ targets, placeholder, sendAs, onSendAs, reply, clearReply, disabledReason }: {
  targets: { convId: string; accountId?: string };
  placeholder: string;
  sendAs?: { options: { id: string; label: any }[]; value: string; onChange: (v: string) => void; label: string };
  onSendAs?: never;
  reply: P.MessageView | null;
  clearReply: () => void;
  disabledReason?: string | null;
}) {
  const draftKey = `dither-chat:draft:${targets.convId}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const edit = editing.value?.conversationId === targets.convId ? editing.value : null;
  // A half-written message waits for you in its own conversation.
  useEffect(() => {
    setText(localStorage.getItem(draftKey) ?? '');
    editing.value = null;
  }, [draftKey]);
  useEffect(() => {
    if (edit) {
      setText(edit.body);
      ta.current?.focus();
    }
  }, [edit]);
  const type = (v: string) => {
    setText(v);
    if (edit) return;
    if (v) localStorage.setItem(draftKey, v);
    else localStorage.removeItem(draftKey);
  };
  const cancelEdit = () => {
    editing.value = null;
    setText(localStorage.getItem(draftKey) ?? '');
  };
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(220, el.scrollHeight) + 'px';
  }, [text]);
  useEffect(() => {
    if (reply) ta.current?.focus();
  }, [reply]);
  const submit = () => {
    const body = text.trim();
    if (!body || disabledReason) return;
    if (edit) {
      if (body !== edit.body) editMessage(edit, body);
      cancelEdit();
      return;
    }
    send(targets.convId, body, { accountId: targets.accountId, replyTo: reply?.id });
    type('');
    clearReply();
  };
  return (
    <div class="composer">
      {edit && (
        <div class="composer-reply">
          <Icon name="settings" size={13} /> Editing your message
          <button class="icon-btn small" onClick={cancelEdit} aria-label="Cancel editing">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {reply && (
        <div class="composer-reply">
          <Icon name="reply" size={13} /> Replying to <b>{isSelfIdentity(reply.authorId) ? 'yourself' : authorName(reply.authorId)}</b>
          <span>{plainBody(reply.body, reply.network).slice(0, 80)}</span>
          <button class="icon-btn small" onClick={clearReply} aria-label="Cancel reply">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
        {sendAs && sendAs.options.length > 1 && (
          <Menu
            up
            trigger={(toggle) => (
              <button class="send-as" onClick={toggle} title={sendAs.label}>
                {sendAs.options.find((o) => o.id === sendAs.value)?.label ?? sendAs.options[0].label}
                <Icon name="chevronDown" size={12} />
              </button>
            )}
          >
            {(close) => (
              <div class="level-menu">
                <div class="menu-title">{sendAs.label}</div>
                {sendAs.options.map((o) => (
                  <button
                    class={`menu-item ${o.id === sendAs.value ? 'on' : ''}`}
                    onClick={() => {
                      sendAs.onChange(o.id);
                      close();
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </Menu>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={disabledReason ?? placeholder}
          disabled={!!disabledReason}
          onInput={(e) => type((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') clearReply();
          }}
        />
        <button class="send-btn" disabled={!text.trim() || !!disabledReason} onClick={submit} aria-label="Send">
          <Icon name="send" size={17} />
        </button>
      </div>
    </div>
  );
}

function sendBlocker(c: P.ConversationView, accountId?: string): string | null {
  const vs = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  const acc = (accountId && vs.find((a) => a.id === accountId)) || vs.find((a) => a.status === 'online') || vs[0];
  if (!acc) return 'No account can send here';
  if (acc.status !== 'online' && acc.status !== 'connecting') return `${netName(acc.network)} · ${acc.label} is ${acc.status === 'attention' ? 'waiting for you (see Accounts)' : acc.status}`;
  if (c.variant === 'forum') return 'Open a post to reply';
  return null;
}

// ------------------------------------------------------------------ panes

function firstUnread(convs: P.ConversationView[]): number | null {
  const ts = convs.flatMap((c) => c.vantages.filter((v) => v.unread > 0).map((v) => v.lastReadTs ?? 0));
  return ts.length ? Math.min(...ts) : null;
}

function ForumView({ c }: { c: P.ConversationView }) {
  const posts = threadsOf(c.id);
  return (
    <div class="forum">
      {c.topic && <p class="forum-topic">{c.topic}</p>}
      {posts.length === 0 && <Empty icon="forum" title="No posts loaded" />}
      {posts.map((t) => (
        <button class="forum-post" onClick={() => openConv(t)}>
          <b>{convTitle(t)}</b>
          <span>{t.lastMessage ? `${authorName(t.lastMessage.authorId)}: ${t.lastMessage.text}` : ''}</span>
        </button>
      ))}
    </div>
  );
}

export function ConversationPane({ convId, onBack, focus }: { convId: string; onBack?: () => void; focus?: string }) {
  rev.value;
  const c = db.conversations.get(convId);
  const [reply, setReply] = useState<P.MessageView | null>(null);
  const unreadAt = useMemo(() => (c ? firstUnread([c]) : null), [convId]);
  useEffect(() => setReply(null), [convId]);
  useEffect(() => void reactionContext(convId), [convId]);
  if (!c) return <Empty icon="groups" title="Conversation not found" />;
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  const sendAsValue = prefs.value.sendAs[c.id] ?? accounts.find((a) => a.status === 'online')?.id ?? accounts[0]?.id;
  const voice = c.variant === 'voice' || c.variant === 'stage';
  return (
    <section class="pane">
      <ConvHeader c={c} onBack={onBack} />
      {c.variant === 'forum' ? (
        <ForumView c={c} />
      ) : (
        <>
          {voice && <div class="voice-note"><Icon name="voice" size={14} /> Voice isn't relayed. This shows the channel's text chat.</div>}
          <Timeline tkey={timelineKey('c', c.id)} convIds={[c.id]} merged={false} onReply={setReply} firstUnreadTs={unreadAt} focus={focus} />
        </>
      )}
      <Composer
        targets={{ convId: c.id, accountId: sendAsValue }}
        placeholder={`Message ${c.shape === 'direct' ? convTitle(c) : convLabel(c)}`}
        reply={reply}
        clearReply={() => setReply(null)}
        disabledReason={sendBlocker(c, sendAsValue)}
        sendAs={
          accounts.length > 1
            ? {
                label: `Send as which ${netName(c.network)} account?`,
                value: sendAsValue!,
                onChange: (v) => setPrefs({ sendAs: { ...prefs.value.sendAs, [c.id]: v } }),
                options: accounts.map((a) => ({ id: a.id, label: <AccountChip account={a} small /> })),
              }
            : undefined
        }
      />
    </section>
  );
}

export function PersonPane({ personId, onBack }: { personId: string; onBack?: () => void }) {
  rev.value;
  const person = db.persons.get(personId);
  const [reply, setReply] = useState<P.MessageView | null>(null);
  const directs = directsOf(personId);
  const unreadAt = useMemo(() => firstUnread(directs), [personId]);
  if (!person) return <Empty icon="user" title="Person not found" />;
  if (!directs.length) return <Empty icon="user" title={`No chats with ${person.name}`} />;
  const viaId = (reply && directs.find((d) => d.id === reply.conversationId)?.id) || prefs.value.via[personId] || directs[0].id;
  const via = directs.find((d) => d.id === viaId) ?? directs[0];
  const label = (d: P.ConversationView) => {
    const acc = d.vantages.map((v) => db.accounts.get(v.accountId)).filter(Boolean)[0];
    return (
      <span class="via-opt">
        <NetBadge network={d.network} size={14} />
        {netName(d.network)}
        {acc && <AccountChip account={acc} small />}
      </span>
    );
  };
  return (
    <section class="pane">
      <PersonHeader person={person} onBack={onBack} />
      <Timeline tkey={timelineKey('p', personId)} convIds={directs.map((d) => d.id)} merged={directs.length > 1} onReply={setReply} firstUnreadTs={unreadAt} />
      <Composer
        targets={{ convId: via.id }}
        placeholder={`Message ${person.name} on ${netName(via.network)}`}
        reply={reply}
        clearReply={() => setReply(null)}
        disabledReason={sendBlocker(via)}
        sendAs={{
          label: `Send to ${person.name} through`,
          value: via.id,
          onChange: (v) => setPrefs({ via: { ...prefs.value.via, [personId]: v } }),
          options: directs.map((d) => ({ id: d.id, label: label(d) })),
        }}
      />
    </section>
  );
}

export { LEVEL_HELP };
