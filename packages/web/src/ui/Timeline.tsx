import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, NETWORK_META, sendBlocker, TIER_LABEL } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ago, bytes, clock, dayLabel, fullTime, sameDay } from '../format.ts';
import { retention } from '../history.ts';
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
  api,
  db,
  go,
  isSelfIdentity,
  loadTimeline,
  markRead,
  pending,
  toast,
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
  discardSend,
  editDrafts,
  editMessage,
  editing,
  retrySend,
  jumpTo,
  startEditing,
  loadNewer,
  openProfile,
  toLatest,
  timelineKey,
  timelines,
} from '../state.ts';
import { reactionContext } from '../reactions.ts';
import { openAbout } from './About.tsx';
import { AccountChip, AccountDots, Avatar, Empty, Menu, NetBadge, NetGlyph, Skeleton, levelIcon, variantIcon } from './bits.tsx';
import { HoverReactions, ReactionBar, useLongPress } from './Reactions.tsx';
import { Icon } from './icons.tsx';
import { TIER_ICON, TierPicker, TriageChances, triageHeading } from './TierVote.tsx';
import { MessageHistory, Ticks } from './MessageHistory.tsx';
import { detailsShown, showDetails, swipeReply } from './Pager.ts';
import { openConv } from './Sidebar.tsx';
import { viewer, type ViewerImage } from './Viewer.tsx';
import { JoinCallButton } from './Call.tsx';
import { EmojiComplete } from './EmojiComplete.tsx';
import { TypingBar } from './Typing.tsx';
import { composerDone, composerTyped } from '../typing.ts';
import { onMenu, openMenu, type MenuSpec } from './ContextMenu.tsx';
import { ForwardCard, forwarding } from './Forward.tsx';
import { attachmentMenu, conversationMenu, identityMenu, imageMenu, linkMenu, messageMenu, personMenu } from './menus.tsx';


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
        <button class={`hdr-btn level ${eff.level}`} onClick={toggle} title={`Notifications: ${LEVEL_LABEL[eff.level]} (${eff.source})`} aria-label={`Notifications: ${LEVEL_LABEL[eff.level]}`}>
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
  const whoTitle = person && isDirect ? `${person.name}'s profile` : `About ${convTitle(c)}`;
  const openWho = () => go(person && isDirect ? { view: 'profile', person: person.id } : { view: 'profile', conv: c.id });
  return (
    <header class="conv-head" onContextMenu={onMenu(() => conversationMenu(c))}>
      {onBack && (
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      {/* The picture and the name open its profile page: theirs for a DM, the place's otherwise. */}
      <button class="conv-head-icon conv-head-who" tabIndex={-1} title={whoTitle} onClick={openWho}>
        {isDirect || c.shape === 'group' || c.shape === 'self' ? (
          <Avatar id={person?.id ?? c.id} name={convTitle(c)} url={person?.avatar ?? c.avatar} size={34} square={!isDirect} network={c.network} />
        ) : (
          <span class="conv-head-variant">
            <Icon name={variantIcon(c.variant, c.shape)} size={20} />
          </span>
        )}
      </button>
      <div class="conv-head-text">
        <h2>
          <button class="conv-head-name" title={whoTitle} onClick={openWho}>
            {convTitle(c)}
          </button>
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
            <button class="hdr-btn phone-hide" title="Profile" aria-label="Profile" onClick={() => go({ view: 'profile', person: person.id })}>
              <Icon name="info" size={16} />
            </button>
            <button class="hdr-btn phone-hide" title="Open the merged thread with this person" aria-label="All chats with this person" onClick={() => go({ view: 'people', person: person.id })}>
              <Icon name="user" size={16} />
              <span class="hdr-btn-label">All chats</span>
            </button>
          </>
        )}
        <JoinCallButton c={c} />
        {!isDirect && (
          <button class="hdr-btn" title="About and settings" aria-label="About and settings" onClick={() => openAbout('conversation', c.id)}>
            <Icon name="info" size={16} />
          </button>
        )}
        <button class="hdr-btn" title="Search in this conversation" aria-label="Search in this conversation" onClick={() => go({ view: 'search', q: `in:${c.id}` })}>
          <Icon name="search" size={16} />
        </button>
        <LevelMenu c={c} />
        <button class={`hdr-btn ${detailsShown() ? 'on' : ''}`} onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
          <Icon name="panel" size={16} />
        </button>
      </div>
    </header>
  );
}

function PersonHeader({ person, onBack }: { person: P.PersonView; onBack?: () => void }) {
  const directs = directsOf(person.id);
  return (
    <header class="conv-head" onContextMenu={onMenu(() => personMenu(person))}>
      {onBack && (
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <button class="conv-head-icon conv-head-who" tabIndex={-1} title={`${person.name}'s profile`} onClick={() => go({ view: 'profile', person: person.id })}>
        <Avatar id={person.id} name={person.name} url={person.avatar} size={34} />
      </button>
      <div class="conv-head-text">
        <h2>
          <button class="conv-head-name" title={`${person.name}'s profile`} onClick={() => go({ view: 'profile', person: person.id })}>
            {person.name}
          </button>
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
        <button class={`hdr-btn ${detailsShown() ? 'on' : ''}`} onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
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

/** The text; `tail` (your message's ticks) sits right after its last word. */
function Body({ m, tail }: { m: P.MessageView; tail?: ComponentChildren }) {
  const html = useMemo(() => renderMarkdown(m.body, useMdContext(m.network)), [m.body, m.network, rev.value]);
  if (m.deleted) return <div class="msg-body deleted">{m.gone?.how === 'disappeared' ? 'Message disappeared' : 'Message deleted'}</div>;
  if (m.kind === 'encrypted')
    return (
      <div class="msg-body encrypted">
        <Icon name="lock" size={13} /> Encrypted message, no key for it here. It decrypts by itself when one arrives, once encryption is set up on the account's page.
      </div>
    );
  if (!m.body) return null;
  const click = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.classList?.contains('spoiler')) el.classList.add('shown');
    const user = el.dataset?.user;
    if (user) openProfile(db.identityByNative.get(`${m.network}:${user}`));
  };
  if (tail)
    return (
      <div class={`msg-body ${isJumbo(m.body) ? 'jumbo' : ''}`} onClick={click}>
        <span class="msg-text" dangerouslySetInnerHTML={{ __html: html }} />
        {tail}
      </div>
    );
  return <div class={`msg-body ${isJumbo(m.body) ? 'jumbo' : ''}`} dangerouslySetInnerHTML={{ __html: html }} onClick={click} />;
}

/** A plain click opens the viewer; a middle or modified click still opens the file in a tab. */
function openViewer(e: MouseEvent, images: ViewerImage[], index: number) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  viewer.value = { images, index };
}

/**
 * A deleted or disappeared message the hub kept (docs/history.md): one quiet line, opened on a click to show what it
 * said and when it went.
 */
function Gone({ m }: { m: P.MessageView }) {
  const [open, setOpen] = useState(false);
  const how = m.gone!.how === 'disappeared' ? 'Disappeared' : 'Deleted';
  const shown = { ...m, deleted: false };
  return (
    <div class={`msg-gone ${open ? 'open' : ''}`}>
      <button class="msg-gone-line" onClick={() => setOpen(!open)} aria-expanded={open} title={`${how} ${fullTime(m.gone!.at)}`}>
        <Icon name={m.gone!.how === 'disappeared' ? 'clock' : 'trash'} size={12} />
        {how} message
        <span class="msg-gone-when">· {ago(m.gone!.at)}</span>
        <span class="msg-gone-toggle">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div class="msg-gone-body">
          <Body m={shown} />
          <Attachments m={shown} />
        </div>
      )}
    </div>
  );
}

/** "(edited)": with earlier versions kept, a click shows them, with the rest of the message's history. */
function Edited({ m }: { m: P.MessageView }) {
  if (!m.edits)
    return (
      <span class="msg-edited" title={m.editedTs ? `Edited ${fullTime(m.editedTs)}` : undefined}>
        (edited)
      </span>
    );
  return (
    <Menu trigger={(open) => <button class="msg-edited link" onClick={open} title="See earlier versions">(edited)</button>}>
      {() => <MessageHistory m={m} />}
    </Menu>
  );
}

/** A mark beside the time: pinned. How far your message got sits after its text (`Ticks`). */
function Marks({ m }: { m: P.MessageView }) {
  return m.pinned ? (
    <span class="msg-pin" title="Pinned">
      <Icon name="pin" size={11} />
    </span>
  ) : null;
}

function Attachments({ m }: { m: P.MessageView }) {
  if (!m.attachments.length) return null;
  const images = m.attachments.filter((a) => a.kind === 'image');
  return (
    <div class="atts">
      {m.attachments.map((a, i) => {
        if (a.kind === 'image') {
          const w = a.width ?? 400;
          const h = a.height ?? 300;
          const scale = Math.min(1, 400 / w, 300 / h);
          return (
            <a class="att-img" data-att={i} href={a.url} target="_blank" rel="noreferrer" onClick={(e) => openViewer(e, images, images.indexOf(a))} style={{ width: `${Math.round(w * scale)}px`, aspectRatio: `${w} / ${h}` }}>
              <img src={a.url} alt={a.name ?? ''} loading="lazy" />
            </a>
          );
        }
        if (a.kind === 'video') return <video class="att-video" data-att={i} src={a.url} controls preload="metadata" />;
        if (a.kind === 'audio') return <audio class="att-audio" data-att={i} src={a.url} controls preload="metadata" />;
        return (
          <a class="att-file" data-att={i} href={a.url} target="_blank" rel="noreferrer">
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
          {e.image && (
            <img class="embed-image" src={e.image} alt="" loading="lazy" onClick={(ev) => openViewer(ev, [{ url: e.image!, name: e.title }], 0)} onError={(ev) => ev.currentTarget.remove()} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Why this notified (or not), and the vote: a quiet button among the hover actions, opening as a floating menu so
 * nothing clips it.
 */
function TriageNote({ m }: { m: P.MessageView }) {
  const t = m.triage;
  if (!t) return null;
  const now = t.feedback ?? t.decision;
  const label = now === 'silent' ? 'Silent' : TIER_LABEL[now];
  const spec = (): MenuSpec => ({
    label: 'Notification',
    items: [
      {
        kind: 'row',
        render: (close) => (
          <div class="triage-pop">
            <div class="menu-title">{triageHeading(t.decision)}</div>
            <ul>
              {t.reasons.map((r) => (
                <li>{r}</li>
              ))}
            </ul>
            {t.probs && <TriageChances p={t.probs} />}
            {t.score !== null && <div class="triage-score">matters {Math.round(t.score * 100)}% · decided by {t.decidedBy === 'learned' ? 'your votes' : t.decidedBy}</div>}
            <TierPicker m={m} onDone={close} />
          </div>
        ),
      },
    ],
  });
  return (
    <button
      class="icon-btn small"
      title={`${label}: why, and vote it up or down a level`}
      aria-label={`Notification: ${label}`}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu({ x: r.right - 340, y: r.bottom + 4 }, spec());
      }}
    >
      <Icon name={now === 'silent' ? 'bellOff' : TIER_ICON[now]} size={14} />
    </button>
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
  const reply = () => onReply(m);
  // Right-click or hold: the innermost thing that has a menu of its own (a file, a link, a person), else the message.
  const menuAt = (target: EventTarget | null): MenuSpec | null => {
    const el = target as HTMLElement | null;
    const att = el?.closest<HTMLElement>('[data-att]');
    if (att) {
      const a = m.attachments[Number(att.dataset.att)];
      if (a) return attachmentMenu(a, m, m.attachments.filter((x) => x.kind === 'image').map((x) => ({ url: x.url, name: x.name, width: x.width, height: x.height })), reply);
    }
    const img = el?.closest<HTMLImageElement>('img.embed-image');
    if (img) return imageMenu(img.src, null, m, reply);
    const user = el?.closest<HTMLElement>('[data-user], [data-identity]');
    if (user) {
      const id = user.dataset.identity ?? db.identityByNative.get(`${m.network}:${user.dataset.user}`);
      const spec = identityMenu(id);
      if (spec) return spec;
    }
    const link = el?.closest<HTMLAnchorElement>('a[href]');
    if (link && /^https?:/i.test(link.href)) return linkMenu(link.href, m, reply);
    return messageMenu(m, reply);
  };
  const press = useLongPress((e) => openMenu({ x: e.clientX, y: e.clientY }, menuAt(e.target)));
  const menuProps = { ...press, onContextMenu: (e: MouseEvent) => onMenu(() => menuAt(e.target))(e) };

  if (m.kind === 'system')
    return (
      <div class="msg system" id={`m-${m.id}`} {...menuProps}>
        <Icon name="chevronRight" size={12} /> <Body m={m} /> <span class="msg-time">{clock(m.ts)}</span>
        <ReactionBar m={m} />
      </div>
    );

  // Your message's ticks, after its text.
  const ticks = m.receipts && isSelfIdentity(m.authorId) ? <Ticks m={m} /> : null;
  return (
    <div
      class={`msg ${grouped ? 'grouped' : ''} ${m.mentionsSelf ? 'mentioned' : ''} ${highlight ? 'flash' : ''}`}
      id={`m-${m.id}`}
      ref={(el) => void (el && swipeReply.set(el, () => onReply(m)))}
      {...menuProps}
    >
      <div class="msg-gutter">
        {grouped ? (
          <span class="msg-time-hover" title={fullTime(m.ts)}>
            {clock(m.ts)}
          </span>
        ) : (
          <button class="avatar-btn" data-identity={m.authorId ?? undefined} onClick={() => openProfile(m.authorId)} aria-label={`Profile of ${name}`}>
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
            <span class={`msg-author ${self ? 'self' : ''}`} data-identity={m.authorId ?? undefined} role="link" tabindex={0} onClick={() => openProfile(m.authorId)} onKeyDown={(e) => e.key === 'Enter' && openProfile(m.authorId)} title={author ? `${author.displayName ?? ''} ${author.handle ? '· ' + author.handle : ''} on ${netName(author.network)}` : ''}>
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
            {(m.editedTs || m.edits) && <Edited m={m} />}
            <Marks m={m} />
            {m.encryptionWarning && (
              <span class="msg-e2ee-warning" title={m.encryptionWarning} aria-label={m.encryptionWarning}>
                <Icon name="alert" size={12} />
              </span>
            )}
          </div>
        )}
        {m.deleted && m.gone?.kept ? (
          <Gone m={m} />
        ) : m.forward && !m.deleted ? (
          <ForwardCard m={m}>
            <Body m={m.forward.text !== undefined ? { ...m, body: m.forward.text } : m} tail={ticks} />
            <Attachments m={m} />
            <Embeds m={m} />
          </ForwardCard>
        ) : (
          <>
            <Body m={m} tail={ticks} />
            <Attachments m={m} />
            <Embeds m={m} />
          </>
        )}
        {ticks && (!m.body || m.deleted) && <span class="msg-marks">{ticks}</span>}
        {grouped && (m.editedTs || m.edits) && <Edited m={m} />}
        {grouped && m.pinned && (
          <span class="msg-marks">
            <Marks m={m} />
          </span>
        )}
        <ReactionBar m={m} />
        {thread && (
          <button class="thread-chip" onClick={() => openConv(thread)}>
            <Icon name="thread" size={13} />
            <b>{convTitle(thread)}</b>
            <span>{thread.lastMessage ? `${authorName(thread.lastMessage.authorId)}: ${plainBody(thread.lastMessage.text, thread.network)}` : 'Open thread'}</span>
          </button>
        )}
      </div>
      <div class="msg-actions">
        <HoverReactions m={m} />
        {canEdit(m) && (
          <button class="icon-btn small" title="Edit" onClick={() => startEditing(m)}>
            <Icon name="pencil" size={14} />
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
        {!m.deleted && m.kind !== 'encrypted' && (
          <button class="icon-btn small" title="Forward" aria-label="Forward" onClick={() => (forwarding.value = m)}>
            <Icon name="forward" size={15} />
          </button>
        )}
        <button
          class="icon-btn small"
          title="More"
          aria-label="More"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu({ x: r.left, y: r.bottom + 4 }, messageMenu(m, reply));
          }}
        >
          <Icon name="more" size={15} />
        </button>
        <TriageNote m={m} />
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
  const msgs = t?.messages ?? [];
  const items: any[] = [];
  let prev: P.MessageView | null = null;
  let dividerDone = false;
  const hideGone = retention.value.show === 'hidden';
  for (const m of msgs) {
    // Settings → Adversarial features: deleted and disappeared messages not shown at all.
    if (hideGone && m.deleted) continue;
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
        {t?.loading && (msgs.length ? <div class="timeline-loading" role="status"><span class="spinner small" /> Loading older messages</div> : <Skeleton rows={7} kind="msg" />)}
        {!t && <Skeleton rows={7} kind="msg" />}
        {t && !t.loading && msgs.length === 0 && <Empty icon="groups" title="No messages yet" />}
        {items}
        {mine.map((p) => (
          <div key={p.tempId} class={`msg pending ${p.failed ? 'failed' : ''} ${p.queued ? 'queued' : ''}`} data-temp-id={p.tempId}>
            <div class="msg-gutter" />
            <div class="msg-main">
              <div class="msg-body">{p.body}</div>
              {p.files?.map((name, i) => (
                <div key={i} class="pending-file">
                  <Icon name="paperclip" size={12} /> {name}
                </div>
              ))}
              <span class="pending-note">{p.failed ? `Failed: ${p.failed}` : p.queued ? 'Waiting for the hub, sends when it is back' : 'Sending…'}</span>
              {p.failed && (
                <span class="pending-actions">
                  <button class="btn ghost small" onClick={() => retrySend(p.tempId)}>
                    Try again
                  </button>
                  <button class="btn ghost small" onClick={() => discardSend(p.tempId)}>
                    Discard
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
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
  const conv = db.conversations.get(targets.convId);
  const accs = (conv?.vantages ?? []).map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  const sender = accs.find((a) => a.id === targets.accountId) ?? accs.find((a) => a.status === 'online') ?? accs[0];
  const canAttach = !!conv && !!sender?.capabilities.includes('sendMedia') && !(conv.network === 'matrix' && conv.encrypted && !sender.capabilities.includes('e2ee'));
  const [files, setFiles] = useState<{ file: File; url: string | null }[]>([]);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (list: File[]) => {
    if (!list.length || !conv) return;
    if (!canAttach) return toast({ kind: 'error', title: 'Cannot send files here', body: conv.encrypted ? 'Set up encryption on the account\'s page to send files in encrypted Matrix rooms.' : `${netName(conv.network)} is not set up to send files.` });
    const limit = ATTACHMENT_LIMITS[conv.network];
    const fit = list.filter((f) => f.size <= limit.bytes);
    if (fit.length < list.length) toast({ kind: 'error', title: 'File too large', body: `${netName(conv.network)} takes files up to ${limit.bytes / 1024 / 1024} MB.` });
    setFiles((cur) => [...cur, ...fit.map((file) => ({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null }))].slice(0, limit.files));
  };
  const dropFile = (i: number) =>
    setFiles((cur) => {
      if (cur[i]?.url) URL.revokeObjectURL(cur[i].url!);
      return cur.filter((_, j) => j !== i);
    });
  const clearFiles = () =>
    setFiles((cur) => {
      cur.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      return [];
    });
  useEffect(() => clearFiles, [targets.convId]);
  const draftKey = `dither-chat:draft:${targets.convId}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const edit = editing.value?.conversationId === targets.convId ? editing.value : null;
  // A half-written message waits for you in its own conversation.
  useEffect(() => {
    const draft = localStorage.getItem(draftKey) ?? '';
    setText(draft);
    editing.value = null;
    // Opening a chat puts you in its box, ready to type; not on a phone, where that throws up the keyboard.
    const el = ta.current;
    const busy = document.activeElement instanceof HTMLInputElement || (document.activeElement instanceof HTMLTextAreaElement && document.activeElement !== el);
    if (el && !busy && !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(draft.length, draft.length);
    }
    return composerDone;
  }, [draftKey]);
  useEffect(() => {
    if (edit) {
      // An edit the hub refused comes back with what you wrote.
      setText(editDrafts.get(edit.id) ?? edit.body);
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
    if (edit) editDrafts.delete(edit.id);
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
    if ((!body && !files.length) || disabledReason) return;
    if (edit) {
      const m = edit;
      cancelEdit();
      if (body !== m.body) void editMessage(m, body);
      return;
    }
    send(targets.convId, body, { accountId: targets.accountId, replyTo: reply?.id, files: files.map((f) => f.file) });
    composerDone();
    type('');
    clearFiles();
    clearReply();
  };
  return (
    <div
      class={`composer ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        setDropping(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {edit && (
        <div class="composer-reply">
          <Icon name="pencil" size={13} /> Editing your message
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
      {files.length > 0 && (
        <div class="composer-files">
          {files.map((f, i) => (
            <div class="composer-file" title={f.file.name}>
              {f.url ? <img src={f.url} alt="" /> : <Icon name="file" size={22} />}
              <span>{f.file.name}</span>
              <button class="icon-btn small" onClick={() => dropFile(i)} aria-label={`Remove ${f.file.name}`}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <EmojiComplete ta={ta} convId={targets.convId} network={conv?.network} />
      <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
        {canAttach && !edit && !disabledReason && (
          <>
            <button class="icon-btn attach-btn" onClick={() => picker.current?.click()} title="Attach files" aria-label="Attach files">
              <Icon name="paperclip" size={17} />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const el = e.target as HTMLInputElement;
                addFiles([...(el.files ?? [])]);
                el.value = '';
              }}
            />
          </>
        )}
        {sendAs && sendAs.options.length > 1 && (
          <Menu
            up
            trigger={(toggle) => (
              <button class="send-as" onClick={toggle} title={sendAs.label} aria-label={sendAs.label}>
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
          onInput={(e) => {
            const v = (e.target as HTMLTextAreaElement).value;
            type(v);
            // Editing a sent message is not typing a new one.
            if (!edit) composerTyped({ conversationId: targets.convId, accountId: sender?.id }, v);
          }}
          onBlur={composerDone}
          onPaste={(e) => {
            const pasted = [...(e.clipboardData?.files ?? [])];
            if (!pasted.length) return;
            e.preventDefault();
            addFiles(pasted);
          }}
          enterkeyhint={touchKeyboard() ? 'enter' : 'send'}
          onKeyDown={(e) => {
            // A phone keyboard has no Shift+Enter, so there Enter is a new line and the button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!touchKeyboard() || e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              if (edit) cancelEdit();
              else clearReply();
            }
          }}
        />
        <button class="send-btn" disabled={(!text.trim() && !files.length) || !!disabledReason} onClick={submit} aria-label="Send">
          <Icon name="send" size={17} />
        </button>
      </div>
    </div>
  );
}

const touchKeyboard = () => matchMedia('(pointer: coarse)').matches;

function composerBlocker(c: P.ConversationView, accountId?: string): string | null {
  const vs = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  return sendBlocker(c, (accountId && vs.find((a) => a.id === accountId)) || vs.find((a) => a.status === 'online') || vs[0]);
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
          <span>{t.lastMessage ? `${authorName(t.lastMessage.authorId)}: ${plainBody(t.lastMessage.text, t.network)}` : ''}</span>
        </button>
      ))}
    </div>
  );
}

/** Signal's conversations exist only from the first message on, which is worth saying while there is none. */
function NotStartedNote({ c }: { c: P.ConversationView }) {
  if (c.network !== 'signal' || c.shape !== 'direct' || c.lastMessage) return null;
  return <div class="voice-note"><Icon name="info" size={14} /> Nothing exists on Signal yet. {convTitle(c)} sees this conversation when you send the first message.</div>;
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
          <NotStartedNote c={c} />
          <Timeline tkey={timelineKey('c', c.id)} convIds={[c.id]} merged={false} onReply={setReply} firstUnreadTs={unreadAt} focus={focus} />
        </>
      )}
      <TypingBar convIds={[c.id]} />
      <Composer
        targets={{ convId: c.id, accountId: sendAsValue }}
        placeholder={`Message ${c.shape === 'direct' ? convTitle(c) : convLabel(c)}`}
        reply={reply}
        clearReply={() => setReply(null)}
        disabledReason={composerBlocker(c, sendAsValue)}
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
      <NotStartedNote c={via} />
      <Timeline tkey={timelineKey('p', personId)} convIds={directs.map((d) => d.id)} merged={directs.length > 1} onReply={setReply} firstUnreadTs={unreadAt} />
      <TypingBar convIds={directs.map((d) => d.id)} />
      <Composer
        targets={{ convId: via.id }}
        placeholder={`Message ${person.name} on ${netName(via.network)}`}
        reply={reply}
        clearReply={() => setReply(null)}
        disabledReason={composerBlocker(via)}
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
