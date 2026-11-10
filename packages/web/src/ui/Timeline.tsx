import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, NETWORK_META, sendBlocker, showsGone, showsInline, TIER_LABEL } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ago, bytes, clock, dayLabel, fullTime, sameDay } from '../format.ts';
import { retention } from '../history.ts';
import { isJumbo, renderMarkdown } from '../markdown.ts';
import { inviteRef } from '../invites.ts';
import {
  LEVEL_LABEL,
  authorName,
  plainBody,
  convByNative,
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
  metaRev,
  newMessage,
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
  timelineRev,
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
import { AttachedFiles, PendingUpload, useAttached } from './ComposerFiles.tsx';
import { TypingBar } from './Typing.tsx';
import { useGrow } from './grow.ts';
import { AttachSheet, CameraView, SendScreen } from './Attach.tsx';
import { CAPTURE_ACCEPT, MEDIA_ACCEPT, opensSendScreen } from '../camera.ts';
import { phone } from '../phone.ts';
import { composerDone, composerTyped } from '../typing.ts';
import { onMenu, openMenu, type MenuSpec } from './ContextMenu.tsx';
import { ForwardCard, forwarding } from './Forward.tsx';
import { InviteCards } from './InviteCard.tsx';
import { attachmentMenu, conversationMenu, identityMenu, imageMenu, linkMenu, messageMenu, openAttachment, personMenu } from './menus.tsx';
import { fileFacts, fileIcon, fileKind, openFileViewer, VIEWABLE } from '../files.ts';
import { desk } from '../desk.ts';
import { android } from '../android.ts';
import { counting, markPainted, rendered } from '../perf.ts';
import { memo } from './memo.ts';
import { heldRequest } from '../requests.ts';
import { LinkBanner, RequestBar } from './Requests.tsx';
import { countKey } from '../clicklog.ts';
import { ChunkHead, design, focusedPair, focusPair, hasNickname, myName, Nickname, pairOf, PairDropdown, PairIcons, PairLead, PairMark, PairRail, PairSliders, theirName, viewOf } from './Pairs.tsx';


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
            <button class="crumb link" data-track="crumb (community)" onClick={() => go({ view: 'space', space: x.id! })}>
              {x.label}
            </button>
          ) : x.kind === 'conversation' && x.id && x.id !== c.id ? (
            <button class="crumb link" data-track="crumb (parent)" onClick={() => openConv(db.conversations.get(x.id!)!)}>
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
        <button class={`hdr-btn level ${eff.level}`} data-track="notification level" onClick={toggle} title={`Notifications: ${LEVEL_LABEL[eff.level]} (${eff.source})`} aria-label={`Notifications: ${LEVEL_LABEL[eff.level]}`}>
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
              data-track={`notification level (${l})`}
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
            data-track="notification level (inherit)"
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
                  data-track={`notification level (whole community, ${l})`}
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
  all: 'Every message is Important',
  smart: 'Triage decides each one: Important, Active or Digest',
  mentions: '@mentions and replies to you are Important; the rest goes to the digest',
  digest: 'Nothing notifies; everything waits for the digest',
  none: 'Silent; unread count only',
};

function ConvHeader({ c, onBack }: { c: P.ConversationView; onBack?: () => void }) {
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  const isDirect = c.shape === 'direct';
  const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  const whoTitle = person && isDirect ? `${person.name}'s profile` : `About ${convTitle(c)}`;
  const openWho = () => go(person && isDirect ? { view: 'profile', person: person.id } : { view: 'profile', conv: c.id });
  return (
    <header class="conv-head" data-track-area="chat header" onContextMenu={onMenu(() => conversationMenu(c))}>
      {onBack && (
        <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      {/* The picture and the name open its profile page: theirs for a DM, the place's otherwise. */}
      <button class="conv-head-icon conv-head-who" tabIndex={-1} data-track="picture" title={whoTitle} onClick={openWho}>
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
          <button class="conv-head-name" data-track="name" title={whoTitle} onClick={openWho}>
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
            <button class="hdr-btn phone-hide" data-track="profile" title="Profile" aria-label="Profile" onClick={() => go({ view: 'profile', person: person.id })}>
              <Icon name="info" size={16} />
            </button>
            <button class="hdr-btn phone-hide" data-track="all chats" title="Open the merged thread with this person" aria-label="All chats with this person" onClick={() => go({ view: 'people', person: person.id })}>
              <Icon name="user" size={16} />
              <span class="hdr-btn-label">All chats</span>
            </button>
          </>
        )}
        <JoinCallButton c={c} />
        {!isDirect && (
          <button class="hdr-btn" data-track="about" title="About and settings" aria-label="About and settings" onClick={() => openAbout('conversation', c.id)}>
            <Icon name="info" size={16} />
          </button>
        )}
        <button class="hdr-btn" data-track="search here" title="Search in this conversation" aria-label="Search in this conversation" onClick={() => go({ view: 'search', q: `in:${c.id}` })}>
          <Icon name="search" size={16} />
        </button>
        <LevelMenu c={c} />
        <button class={`hdr-btn ${detailsShown() ? 'on' : ''}`} data-track="details" onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
          <Icon name="panel" size={16} />
        </button>
      </div>
    </header>
  );
}

function PersonHeader({ person, onBack }: { person: P.PersonView; onBack?: () => void }) {
  const directs = directsOf(person.id);
  return (
    <header class="conv-head" data-track-area="chat header" onContextMenu={onMenu(() => personMenu(person))}>
      {onBack && (
        <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <button class="conv-head-icon conv-head-who" tabIndex={-1} data-track="picture" title={`${person.name}'s profile`} onClick={() => go({ view: 'profile', person: person.id })}>
        <Avatar id={person.id} name={person.name} url={person.avatar} size={34} />
      </button>
      <div class="conv-head-text">
        <h2>
          <button class="conv-head-name" data-track="name" title={`${person.name}'s profile`} onClick={() => go({ view: 'profile', person: person.id })}>
            {person.name}
          </button>
        </h2>
        <div class="conv-head-sub">
          <span class="ident-chips">
            {directs.map((d) => {
              const peer = d.participantIds.find((p) => !isSelfIdentity(p));
              const ident = peer ? db.identities.get(peer) : null;
              return (
                <button class="ident-chip" data-track="network chip" style={{ '--net': NETWORK_META[d.network].color } as any} title={`Open only the ${netName(d.network)} chat`} onClick={() => go({ view: 'inbox', conv: d.id })}>
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
        <button class={`hdr-btn ${detailsShown() ? 'on' : ''}`} data-track="details" onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
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
      const c = convByNative(network, nativeId);
      return c ? convTitle(c) : null;
    },
  };
}

/** The text; `tail` (your message's ticks) sits right after its last word. */
function Body({ m, tail }: { m: P.MessageView; tail?: ComponentChildren }) {
  // Only mentions and room links read the db (names may arrive later); other bodies render once.
  const html = useMemo(() => renderMarkdown(m.body, useMdContext(m.network)), [m.body, m.network, /<[@#]/.test(m.body) ? metaRev.value : 0]);
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
    // An invite link opens the New box on it, not the browser; the link's menu still opens it there.
    const a = el.closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && inviteRef(a.href)) {
      e.preventDefault();
      newMessage.value = { q: a.href, mode: 'join' };
    }
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
 * A deleted or disappeared message the hub kept (docs/history.md): shown in full, as it was, with a quiet mark of
 * how and when it went.
 */
function Gone({ m }: { m: P.MessageView }) {
  // Its "5m ago" moves on with the list, as it did when every change drew every message.
  rev.value;
  const how = m.gone!.how === 'disappeared' ? 'Disappeared' : 'Deleted';
  const shown = { ...m, deleted: false };
  return (
    <div class="msg-gone open">
      <Body m={shown} />
      <Attachments m={shown} />
      <span class="msg-gone-mark" title={`${how} ${fullTime(m.gone!.at)}`}>
        <Icon name={m.gone!.how === 'disappeared' ? 'clock' : 'trash'} size={11} />
        {how} <span class="msg-gone-when">· {ago(m.gone!.at)}</span>
      </span>
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
  // A file the network called just a file whose bytes are a picture, a video or a sound shows as one (files.ts).
  const media = (a: P.AttachmentView) => (a.kind === 'file' && a.info && /^(image|video|audio)$/.test(a.info.kind) ? (a.info.kind as P.AttachmentKind) : a.kind);
  const images = m.attachments.filter((a) => media(a) === 'image');
  return (
    <div class="atts">
      {m.attachments.map((a, i) => {
        const kind = media(a);
        if (kind === 'image') {
          const w = a.width ?? a.info?.width ?? 400;
          const h = a.height ?? a.info?.height ?? 300;
          const scale = Math.min(1, 400 / w, 300 / h);
          return (
            <a class="att-img" data-att={i} href={a.url} target="_blank" rel="noreferrer" onClick={(e) => openViewer(e, images, images.indexOf(a))} style={{ width: `${Math.round(w * scale)}px`, aspectRatio: `${w} / ${h}` }}>
              <img src={a.url} alt={a.name ?? ''} loading="lazy" />
            </a>
          );
        }
        if (kind === 'video') return <video class="att-video" data-att={i} src={a.url} controls preload="metadata" />;
        if (kind === 'audio') return <audio class="att-audio" data-att={i} src={a.url} controls preload="metadata" />;
        const fk = fileKind(a);
        // A kind with a viewer opens in it (Viewer.tsx); any other opens in its app when the helper or the phone can,
        // else downloads (a type the hub won't show, HTML or SVG, straight away rather than through an empty tab).
        const open = (e: MouseEvent) => {
          if (VIEWABLE.has(fk)) e.preventDefault(), openFileViewer(a, m);
          else if (desk.value?.files || android?.opensFiles()) e.preventDefault(), openAttachment(a);
        };
        return (
          <a class="att-file" data-att={i} data-kind={fk} href={a.url} target="_blank" rel="noreferrer" download={showsInline(a.mime) ? undefined : (a.name ?? true)} onClick={open}>
            <Icon name={fileIcon(fk, a.info?.language)} size={22} />
            <span>
              <b>{a.name ?? 'file'}</b>
              <small>{fileFacts(a)}</small>
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
              {t.reasons.map((r, i) => (
                <li key={i}>{r}</li>
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
      data-track="triage note"
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

/** Where a message in a merged timeline came from, for the title of its network mark. */
function sourceTitle(m: P.MessageView): string | undefined {
  const conv = db.conversations.get(m.conversationId);
  if (!conv) return undefined;
  const seenVia = m.seenVia.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  return `${kindLabel(conv)}${seenVia.length ? ' · via ' + seenVia.map((a) => a.label).join(', ') : ''}`;
}

/**
 * Drawn again only when its props change (memo.ts) or a name or setting does (`metaRev`): a message arriving draws
 * itself and the one before it, not the whole timeline. The timeline looks up what it would read that changes with
 * each message: `target`, the message it replies to (a map per render, not a search per message); `thread`, its
 * thread's conversation; `src`, where it came from in a merged timeline. `onQuote` shows the quoted message.
 */
const MessageItem = memo(function MessageItem({ m, grouped, src, onReply, onQuote, highlight, target, thread, mark, onPick, via, viaOn, chunk, alias, netPic }: { m: P.MessageView; grouped: boolean; src?: string; onReply: (m: P.MessageView) => void; onQuote: (id: string) => void; highlight: boolean; target: P.MessageView | null; thread: P.ConversationView | null; mark?: ComponentChildren; onPick?: () => void; via?: string; viaOn?: boolean; chunk?: 'on' | 'off'; alias?: string; netPic?: boolean }) {
  if (counting) rendered('MessageItem');
  metaRev.value;
  const author = m.authorId ? db.identities.get(m.authorId) : null;
  const person = personOf(m.authorId);
  const self = isSelfIdentity(m.authorId);
  const name = alias ?? (self ? identityName(m.authorId) || 'You' : authorName(m.authorId));
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
      class={`msg ${grouped ? 'grouped' : ''} ${m.mentionsSelf ? 'mentioned' : ''} ${highlight ? 'flash' : ''} ${onPick ? 'pair-pick' : ''} ${chunk ? `pair-chunk ${chunk}` : ''}`}
      id={`m-${m.id}`}
      ref={(el) => void (el && swipeReply.set(el, () => onReply(m)))}
      {...menuProps}
      // Design study (ui/Pairs.tsx): a click on a message of another pair sends through that pair, unless it selects text or hits a control.
      onClick={
        onPick &&
        ((e: MouseEvent) => {
          if (getSelection()?.toString()) return;
          if ((e.target as HTMLElement).closest('a, button, img, video, audio, input, textarea, [data-att], [role="link"]')) return;
          onPick();
        })
      }
    >
      <div class="msg-gutter">
        {grouped ? (
          <span class="msg-time-hover" title={fullTime(m.ts)}>
            {clock(m.ts)}
          </span>
        ) : (
          <button class="avatar-btn" data-identity={m.authorId ?? undefined} onClick={() => openProfile(m.authorId)} aria-label={`Profile of ${name}`}>
            {netPic ? <NetBadge network={m.network} size={36} /> : <Avatar id={person?.id ?? m.authorId ?? m.id} name={name} url={person?.avatar ?? author?.avatar} size={36} />}
          </button>
        )}
      </div>
      <div class="msg-main">
        {mark}
        {target && (
          <button class="reply-quote" onClick={() => onQuote(target.id)}>
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
            {/* Design study (ui/Pairs.tsx, sliders): which of their accounts, or which of yours it was sent from. */}
            {via !== undefined &&
              (self ? (
                <span class={`msg-via-mine ${viaOn ? 'on' : ''}`}>
                  sent from <NetGlyph network={m.network} size={11} /> {via}
                </span>
              ) : (
                <span class={`msg-src msg-via-their ${viaOn ? 'on' : ''}`} title={`${via} on ${netName(m.network)}`}>
                  <NetGlyph network={m.network} size={11} />
                  {via}
                </span>
              ))}
            {src !== undefined && (
              <span class="msg-src" title={src}>
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
            <InviteCards m={m} body={m.forward.text ?? m.body} />
          </ForwardCard>
        ) : (
          <>
            <Body m={m} tail={ticks} />
            <Attachments m={m} />
            <Embeds m={m} />
            <InviteCards m={m} body={m.body} />
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
      <div class="msg-actions" data-track-area="message">
        <HoverReactions m={m} />
        {canEdit(m) && (
          <button class="icon-btn small" data-track="edit" title="Edit" onClick={() => startEditing(m)}>
            <Icon name="pencil" size={14} />
          </button>
        )}
        {canDelete(m) && (
          <button class="icon-btn small" data-track="delete" title="Delete" onClick={() => deleteMessage(m)}>
            <Icon name="trash" size={14} />
          </button>
        )}
        <button class="icon-btn small" data-track="reply" title="Reply" onClick={() => onReply(m)}>
          <Icon name="reply" size={15} />
        </button>
        {!m.deleted && m.kind !== 'encrypted' && (
          <button class="icon-btn small" data-track="forward" title="Forward" aria-label="Forward" onClick={() => (forwarding.value = m)}>
            <Icon name="forward" size={15} />
          </button>
        )}
        <button
          class="icon-btn small"
          data-track="more"
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
});

// ------------------------------------------------------------------ timeline

/** Messages drawn at the newest end of a timeline. The rest stay in memory and are drawn as the view nears them. */
export const WINDOW = 150;
/** How many more are drawn each time the view nears an end of what is drawn. */
const STEP = 100;

/** What is drawn: from `from` (a message id; '^' the oldest held; null the newest WINDOW) to `to` (an id; null the newest). */
interface Drawn {
  key: string;
  from: string | null;
  to: string | null;
}

function Timeline({ tkey, convIds, merged, onReply, firstUnreadTs, focus, pairs }: { tkey: string; convIds: string[]; merged: boolean; onReply: (m: P.MessageView) => void; firstUnreadTs: number | null; focus?: string; pairs?: { focus: string; onFocus: (convId: string) => void; inline?: boolean; chunks?: boolean } }) {
  if (counting) rendered('Timeline');
  timelineRev(tkey).value;
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

  const msgs = t?.messages ?? [];
  // Settings → Adversarial features, or the chat's own say: kept deleted and disappeared messages not shown at all.
  const r = retention.value;
  const all = r.adversarial ? msgs.filter((m) => !(m.deleted && m.gone?.kept) || showsGone(r, m.conversationId)) : msgs;
  const at = new Map<string, number>();
  all.forEach((m, i) => at.set(m.id, i));

  // A long timeline is drawn in part (docs/perf.md): a switch back to it draws the newest WINDOW, not all it holds.
  const [, redraw] = useState(0);
  const drawn = useRef<Drawn>({ key: tkey, from: null, to: null });
  if (drawn.current.key !== tkey) drawn.current = { key: tkey, from: null, to: null };
  const draw = (from: string | null, to: string | null) => {
    drawn.current = { key: tkey, from, to };
    redraw((n) => n + 1);
  };
  const around = (i: number): [string, string | null] => [all[Math.max(0, i - STEP / 2)].id, i + STEP / 2 >= all.length - 1 ? null : all[i + STEP / 2].id];
  const bounds = () => {
    const d = drawn.current;
    const toAt = d.to ? at.get(d.to) : undefined;
    const end = toAt === undefined ? all.length : toAt + 1;
    const fromAt = d.from === '^' ? 0 : d.from ? at.get(d.from) : undefined;
    return { start: fromAt === undefined || fromAt >= end ? Math.max(0, end - WINDOW) : fromAt, end };
  };
  // A message linked to (?m=) that is held but not drawn: draw what is around it.
  if (focus && scrolledTo.current !== focus) {
    const i = at.get(focus);
    const b = bounds();
    if (i !== undefined && (i < b.start || i >= b.end)) {
      const [from, to] = around(i);
      drawn.current = { key: tkey, from, to };
    }
  }
  const { start, end } = bounds();
  const first = all[start];
  const last = all[end - 1];

  // At the very top the browser keeps the view at the top while older messages come in above it: that shows
  // them, and asks for the next page, and the next, to the start. So the message that was first stays where it was;
  // drawing more below keeps the one that was last where it was.
  const anchor = useRef<{ id: string; y: number; edge: 'first' | 'last' } | null>(null);
  const hold = (m: P.MessageView | undefined, edge: 'first' | 'last') => {
    const node = m && document.getElementById(`m-${m.id}`);
    if (node) anchor.current = { id: m.id, y: node.getBoundingClientRect().top, edge };
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // column-reverse: scrollTop is 0 at the bottom and negative going up.
    if (el.scrollHeight + el.scrollTop - el.clientHeight < 400) {
      if (start > 0) {
        hold(first, 'first');
        draw(all[Math.max(0, start - STEP)].id, drawn.current.to);
      } else {
        if (t && !t.loading && t.hasMore) {
          hold(first, 'first');
          // The page coming is drawn whole, as is everything above it.
          if (drawn.current.from !== '^') drawn.current = { ...drawn.current, from: '^' };
        }
        loadTimeline(tkey, true);
      }
    }
    const d = drawn.current;
    if (d.to !== null) {
      if (Math.abs(el.scrollTop) < 400) {
        hold(last, 'last');
        draw(d.from ?? first?.id ?? null, end - 1 + STEP >= all.length - 1 ? null : all[end - 1 + STEP].id);
      }
    } else if (t?.detached) {
      if (Math.abs(el.scrollTop) < 400) void loadNewer(tkey);
    } else if (Math.abs(el.scrollTop) < 40 && document.visibilityState === 'visible') {
      convIds.forEach(markRead);
      // Back at the newest after drawing far up: only the newest again. What goes is above the view.
      if (d.from !== null && end - start > WINDOW + STEP) draw(null, null);
    }
  };
  useEffect(() => {
    const id = setTimeout(() => onScroll(), 300);
    return () => clearTimeout(id);
  });

  // A copy whose message came before the hub's answer is not shown: the message is (outbox.ts).
  const mine = pending.value.filter((p) => convIds.includes(p.conversationId) && !p.echoed);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a || t?.loading || (a.edge === 'first' ? first?.id : last?.id) === a.id) return;
    anchor.current = null;
    const node = document.getElementById(`m-${a.id}`);
    const el = scroller.current;
    const moved = node ? node.getBoundingClientRect().top - a.y : 0;
    if (el && Math.abs(moved) >= 1) el.scrollTop += moved;
  });

  // A reply's quote shows the message it quotes: drawn first if it is held but not drawn.
  const revealing = useRef<string | null>(null);
  const quote = useRef((_: string) => {});
  quote.current = (id: string) => {
    const el = document.getElementById(`m-${id}`);
    if (el) return el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const i = at.get(id);
    if (i === undefined) return;
    revealing.current = id;
    draw(...around(i));
  };
  const onQuote = useMemo(() => (id: string) => quote.current(id), []);
  useLayoutEffect(() => {
    const id = revealing.current;
    const el = id && document.getElementById(`m-${id}`);
    if (!el) return;
    revealing.current = null;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // A switch is done once the newest message is on screen, or the hub has answered (docs/perf.md).
  const painted = useRef('');
  useEffect(() => {
    if (!t || painted.current === tkey) return;
    const newestHeld = msgs[msgs.length - 1];
    const newest = tkey.startsWith('c:') ? db.conversations.get(tkey.slice(2))?.lastMessage?.id : newestHeld?.id;
    if (t.loading && !(newestHeld && newestHeld.id === newest)) return;
    painted.current = tkey;
    markPainted('dither:timeline', { key: tkey, messages: msgs.length });
  });
  const items: any[] = [];
  let prev: P.MessageView | null = null;
  const byId = new Map(msgs.map((x) => [x.id, x]));
  const unreadFrom = firstUnreadTs === null ? -1 : all.findIndex((m) => m.ts > firstUnreadTs && !isSelfIdentity(m.authorId));
  for (let i = start; i < end; i++) {
    const m = all[i];
    if (!prev || !sameDay(prev.ts, m.ts)) items.push(<div class="day-sep"><span>{dayLabel(m.ts)}</span></div>);
    // Design study (ui/Pairs.tsx): where the pair changes, a picture at the right of the message instead of a divider.
    const runStart = !!pairs && (!prev || prev.conversationId !== m.conversationId || (!!pairs.chunks && !sameDay(prev.ts, m.ts)));
    if (merged && !pairs && prev && prev.conversationId !== m.conversationId) {
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
    if (i === unreadFrom) items.push(<div class="new-sep"><span>New</span></div>);
    const grouped = !!prev && prev.authorId === m.authorId && prev.conversationId === m.conversationId && m.ts - prev.ts < 7 * 60_000 && sameDay(prev.ts, m.ts) && prev.kind !== 'system' && !m.replyToId;
    const target = m.replyToId ? (byId.get(m.replyToId) ?? quoted.get(m.replyToId) ?? null) : null;
    const thread = m.threadId ? (db.conversations.get(m.threadId) ?? null) : null;
    let mark: ComponentChildren = undefined;
    let onPick: (() => void) | undefined;
    let via: string | undefined;
    let chunk: 'on' | 'off' | undefined;
    let alias: string | undefined;
    if (pairs?.chunks) {
      const c = db.conversations.get(m.conversationId);
      const focused = m.conversationId === pairs.focus;
      // Names as the network has them (your account's, their username), unless you gave them a nickname.
      if (c) {
        const pr = pairOf(c);
        if (isSelfIdentity(m.authorId)) alias = myName(pr);
        else if (hasNickname(personOf(m.authorId))) via = theirName(pr);
        else alias = theirName(pr);
      }
      if (c && convIds.length > 1) {
        chunk = focused ? 'on' : 'off';
        if (runStart) items.push(<ChunkHead key={`ch-${m.id}`} p={pairOf(c)} focused={focused} onPick={() => pairs.onFocus(c.id)} />);
      }
    } else if (pairs) {
      const c = db.conversations.get(m.conversationId);
      const focused = m.conversationId === pairs.focus;
      if (c && !focused) onPick = () => pairs.onFocus(c.id);
      if (c && pairs.inline) via = isSelfIdentity(m.authorId) ? myName(pairOf(c)) : theirName(pairOf(c));
      else if (c && runStart) mark = <PairMark p={pairOf(c)} directs={convIds.map((id) => db.conversations.get(id)).filter((x): x is P.ConversationView => !!x)} focused={focused} onPick={() => pairs.onFocus(c.id)} />;
    }
    items.push(<MessageItem key={m.id} m={m} grouped={pairs ? grouped && !runStart : grouped} src={merged && !pairs ? sourceTitle(m) : undefined} onReply={onReply} onQuote={onQuote} highlight={m.id === flash} target={target} thread={thread} mark={mark} onPick={onPick} via={via} viaOn={!!pairs && m.conversationId === pairs.focus} chunk={chunk} alias={alias} netPic={!!pairs?.chunks} />);
    prev = m;
  }

  return (
    <div class="timeline-scroll" ref={scroller} onScroll={onScroll}>
      <div class="timeline-inner">
        {t && !t.hasMore && msgs.length > 0 && start === 0 && <div class="timeline-start">This is the start of what dither-chat has stored here.</div>}
        {t?.detached && (
          <button
            class="jump-latest"
            onClick={() => {
              draw(null, null);
              void toLatest(tkey);
              // Off the old message in the address too, so a reload (a new build) does not jump back to it.
              const r = route.value;
              if ('msg' in r && r.msg) go({ ...r, msg: undefined }, true);
            }}
          >
            <Icon name="chevronDown" size={14} /> Older messages. Jump to the latest
          </button>
        )}
        {t?.loading && (msgs.length ? <div class="timeline-loading" role="status"><span class="spinner small" /> Loading older messages</div> : <Skeleton rows={7} kind="msg" />)}
        {!t && <Skeleton rows={7} kind="msg" />}
        {t && !t.loading && msgs.length === 0 && <Empty icon="groups" title="No messages yet" />}
        {items}
        {/* Not yet sent: after the newest, so only while the newest is drawn. */}
        {end === all.length &&
          mine.map((p) => (
            <div key={p.tempId} class={`msg pending ${p.failed ? 'failed' : ''} ${p.queued ? 'queued' : ''}`} data-temp-id={p.tempId}>
              <div class="msg-gutter" />
              <div class="msg-main">
                <div class="msg-body">{p.body}</div>
                {p.files?.map((name, i) => (
                  <div key={i} class="pending-file">
                    <Icon name="paperclip" size={12} /> {name}
                    {p.uploading && <PendingUpload tempId={p.tempId} index={i} />}
                  </div>
                ))}
                <span class="pending-note">{p.failed ? `Failed: ${p.failed}` : p.queued ? 'Waiting for the hub, sends when it is back' : p.uploading ? 'Uploading…' : 'Sending…'}</span>
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

function Composer({ targets, placeholder, sendAs, onSendAs, reply, clearReply, disabledReason, lead }: {
  targets: { convId: string; accountId?: string };
  placeholder: string;
  /** Design study (ui/Pairs.tsx): a line in place of the placeholder that can be clicked; it moves to the box's edge once typed in. */
  lead?: ComponentChildren;
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
  // Each uploads as it is attached; one that cannot be sent stays in the row with the reason (ComposerFiles.tsx).
  const att = useAttached(conv?.network, targets.convId);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // A phone's attaching (ui/Attach.tsx): the + sheet, the camera, the send screen, and their inputs.
  const onPhone = phone.value;
  const photos = useRef<HTMLInputElement>(null);
  const capture = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState(false);
  const [camera, setCamera] = useState(false);
  const [review, setReview] = useState(false);
  const addFiles = async (list: File[]) => {
    if (!list.length || !conv) return;
    if (!canAttach) return toast({ kind: 'error', title: 'Cannot send files here', body: conv.encrypted ? 'Set up encryption on the account\'s page to send files in encrypted Matrix rooms.' : `${netName(conv.network)} is not set up to send files.` });
    await att.add(list);
  };
  /** Photos and videos, picked or taken on a phone, go to the send screen; other files to the row. */
  const addMedia = async (list: File[]) => {
    await addFiles(list);
    if (onPhone && canAttach && opensSendScreen(list)) setReview(true);
  };
  useEffect(() => {
    setSheet(false);
    setCamera(false);
    setReview(false);
  }, [targets.convId]);
  const files = att.sendable;
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
  useGrow(ta, text);
  useEffect(() => {
    if (reply) ta.current?.focus();
  }, [reply]);
  const submit = () => {
    const body = text.trim();
    if ((!body && !files.length) || disabledReason || (att.failed && !edit)) return;
    if (edit) {
      const m = edit;
      cancelEdit();
      if (body !== m.body) void editMessage(m, body);
      return;
    }
    send(targets.convId, body, { accountId: targets.accountId, replyTo: reply?.id, files: files.map((f) => f.file), uploads: files.map((f) => f.job!) });
    composerDone();
    type('');
    att.clear(true);
    clearReply();
    setReview(false);
  };
  const canSend = !((!text.trim() && !files.length) || !!disabledReason || (att.failed && !edit));
  const sendTitle = att.failed && !edit ? 'A file did not upload: try it again or remove it' : undefined;
  const onText = (v: string) => {
    type(v);
    // Editing a sent message is not typing a new one.
    if (!edit) composerTyped({ conversationId: targets.convId, accountId: sender?.id }, v);
  };
  const limit = conv ? `up to ${ATTACHMENT_LIMITS[conv.network].bytes / 1024 / 1024} MB each` : '';
  const attaching = canAttach && !edit && !disabledReason;
  const openCamera = () => {
    // No camera API at all: the system's camera, from this tap.
    if (!navigator.mediaDevices?.getUserMedia) return capture.current?.click();
    setCamera(true);
  };
  const sendAsMenu = sendAs && sendAs.options.length > 1 && (
    <Menu
      up
      trigger={(toggle) => (
        <button class="send-as" data-track="send as" onClick={toggle} title={sendAs.label} aria-label={sendAs.label}>
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
              data-track="send as (pick)"
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
  );
  const box = (
    <textarea
      ref={ta}
      data-track="text box"
      rows={1}
      value={text}
      placeholder={disabledReason ?? (lead ? '' : placeholder)}
      disabled={!!disabledReason}
      onInput={(e) => onText((e.target as HTMLTextAreaElement).value)}
      onBlur={composerDone}
      onPaste={(e) => {
        const pasted = [...(e.clipboardData?.files ?? [])];
        if (!pasted.length) return;
        e.preventDefault();
        void addFiles(pasted);
      }}
      enterkeyhint={touchKeyboard() ? 'enter' : 'send'}
      onKeyDown={(e) => {
        // A phone keyboard has no Shift+Enter, so there Enter is a new line and the button sends.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!touchKeyboard() || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          countKey('composer: send (Enter)');
          submit();
        } else if (e.key === 'Escape') {
          if (edit || reply) countKey(`composer: cancel ${edit ? 'edit' : 'reply'} (Esc)`);
          if (edit) cancelEdit();
          else clearReply();
        }
      }}
    />
  );
  const sendBtn = (
    <button class="send-btn" data-track="send" disabled={!canSend} onClick={submit} aria-label="Send" title={sendTitle}>
      <Icon name="send" size={17} />
    </button>
  );
  return (
    <div
      class={`composer ${dropping ? 'dropping' : ''}`}
      data-track-area="composer"
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
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      {edit && (
        <div class="composer-reply">
          <Icon name="pencil" size={13} /> Editing your message
          <button class="icon-btn small" data-track="cancel edit" onClick={cancelEdit} aria-label="Cancel editing">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {reply && (
        <div class="composer-reply">
          <Icon name="reply" size={13} /> Replying to <b>{isSelfIdentity(reply.authorId) ? 'yourself' : authorName(reply.authorId)}</b>
          <span>{plainBody(reply.body, reply.network).slice(0, 80)}</span>
          <button class="icon-btn small" data-track="cancel reply" onClick={clearReply} aria-label="Cancel reply">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      <AttachedFiles files={att.files} remove={att.remove} />
      <EmojiComplete ta={ta} convId={targets.convId} network={conv?.network} />
      {attaching && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              void addFiles([...(el.files ?? [])]);
              el.value = '';
            }}
          />
          {onPhone && (
            <>
              <input
                ref={photos}
                class="attach-photos"
                type="file"
                accept={MEDIA_ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  const el = e.target as HTMLInputElement;
                  void addMedia([...(el.files ?? [])]);
                  el.value = '';
                }}
              />
              <input
                ref={capture}
                class="attach-capture"
                type="file"
                accept={CAPTURE_ACCEPT}
                capture="environment"
                hidden
                onChange={(e) => {
                  const el = e.target as HTMLInputElement;
                  void addMedia([...(el.files ?? [])]);
                  el.value = '';
                }}
              />
            </>
          )}
        </>
      )}
      {onPhone ? (
        <div class="composer-row">
          {attaching && (
            <button class="icon-btn composer-plus" data-track="plus" onClick={() => setSheet(true)} aria-label="Attach photos, videos or files">
              <Icon name="plus" size={22} />
            </button>
          )}
          <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
            {sendAsMenu}
            {lead ? (
              <div class={`pair-lead ${text ? 'raised' : ''}`}>
                <div class="pair-lead-slot">{lead}</div>
                {box}
              </div>
            ) : (
              box
            )}
            {attaching && (
              <button class="icon-btn composer-camera" data-track="camera" onClick={openCamera} aria-label="Take a photo or video">
                <Icon name="camera" size={20} />
              </button>
            )}
          </div>
          {sendBtn}
        </div>
      ) : (
        <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
          {attaching && (
            <button class="icon-btn attach-btn" data-track="attach" onClick={() => picker.current?.click()} title={`Attach files, ${limit}`} aria-label="Attach files">
              <Icon name="paperclip" size={17} />
            </button>
          )}
          {sendAsMenu}
          {lead ? (
            <div class={`pair-lead ${text ? 'raised' : ''}`}>
              <div class="pair-lead-slot">{lead}</div>
              {box}
            </div>
          ) : (
            box
          )}
          {sendBtn}
        </div>
      )}
      {sheet && <AttachSheet limit={limit} onClose={() => setSheet(false)} onPhotos={() => photos.current?.click()} onFile={() => picker.current?.click()} />}
      {camera && (
        <CameraView
          onClose={() => setCamera(false)}
          onFallback={() => capture.current?.click()}
          onGallery={() => photos.current?.click()}
          onShot={(f) => {
            setCamera(false);
            void addMedia([f]);
          }}
        />
      )}
      {review && onPhone && (
        <SendScreen
          files={att.files}
          remove={att.remove}
          text={text}
          onText={onText}
          canSend={canSend}
          sendTitle={sendTitle}
          onSend={submit}
          onAddMore={() => photos.current?.click()}
          onClose={() => setReview(false)}
          enterSends={() => !touchKeyboard()}
        />
      )}
    </div>
  );
}

const touchKeyboard = () => matchMedia('(pointer: coarse)').matches;

/** Why the composer cannot send here, or null. Catch up's reply box asks the same (ui/CatchUp.tsx). */
export function composerBlocker(c: P.ConversationView, accountId?: string): string | null {
  // An open message request is read-only until accepted (docs/add.md).
  if (heldRequest(db.requests, c.id)) return 'Accept the message request first, under Requests';
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
  const held = heldRequest(db.requests, c.id);
  return (
    <section class="pane">
      <ConvHeader c={c} onBack={onBack} />
      {!held && c.pending && <LinkBanner c={c} />}
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
      {held ? (
        <RequestBar r={held} />
      ) : (
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
      )}
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
  if (design.value !== 'current' && directs.length > 1) return <PairsPersonPane person={person} directs={directs} onBack={onBack} reply={reply} setReply={setReply} unreadAt={unreadAt} />;
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
      {directs.filter((d) => d.pending).map((d) => (
        <LinkBanner key={d.id} c={d} />
      ))}
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

/** Design study (ui/Pairs.tsx): the person page as pairs of your account and theirs. */
function PairsPersonPane({ person, directs, onBack, reply, setReply, unreadAt }: { person: P.PersonView; directs: P.ConversationView[]; onBack?: () => void; reply: P.MessageView | null; setReply: (m: P.MessageView | null) => void; unreadAt: number | null }) {
  const rail = design.value === 'pairs-rail';
  const sliders = design.value === 'sliders';
  const chunks = design.value === 'chunks';
  const picked = focusedPair(person.id, directs);
  // Replying to a message sends through the pair it came from.
  const focus = (reply && directs.find((d) => d.id === reply.conversationId)) || picked;
  // Showing one pair's history follows the pair you send through, so switching it in the message box switches both.
  const view = chunks && viewOf(person.id, directs) !== 'all' ? focus.id : 'all';
  const shown = view === 'all' ? directs : directs.filter((d) => d.id === view);
  const onFocus = (id: string) => {
    if (reply && reply.conversationId !== id) setReply(null);
    focusPair(person.id, focus.id, id);
  };
  const cur = pairOf(focus);
  return (
    <section class={`pane pairs-pane ${rail ? 'pairs-pane-rail' : ''} ${sliders ? 'pairs-pane-sliders' : ''} ${chunks ? 'pairs-pane-chunks' : ''}`}>
      <header class="conv-head" data-track-area="chat header" onContextMenu={onMenu(() => personMenu(person))}>
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <button class="conv-head-icon conv-head-who" tabIndex={-1} title={`${person.name}'s profile`} onClick={() => go({ view: 'profile', person: person.id })}>
          <Avatar id={person.id} name={person.name} url={person.avatar} size={34} />
        </button>
        <div class="conv-head-text">
          <h2>
            {chunks ? (
              <>
                <Nickname person={person} onOpen={() => go({ view: 'profile', person: person.id })} />
                <PairDropdown personId={person.id} directs={directs} focus={focus} />
              </>
            ) : sliders ? (
              <Nickname person={person} onOpen={() => go({ view: 'profile', person: person.id })} />
            ) : (
              <button class="conv-head-name" title={`${person.name}'s profile`} onClick={() => go({ view: 'profile', person: person.id })}>
                {person.name}
              </button>
            )}
            {person.starred && !chunks && <Icon name="star" size={13} class="row-star" />}
          </h2>
          <div class="conv-head-sub">{chunks ? null : sliders ? <PairSliders personId={person.id} directs={directs} focus={focus} /> : rail ? <PairRail personId={person.id} directs={directs} focus={focus} /> : <PairIcons personId={person.id} directs={directs} focus={focus} />}</div>
        </div>
        <div class="conv-head-actions">
          <button class={`hdr-btn ${detailsShown() ? 'on' : ''}`} data-track="details" onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
            <Icon name="panel" size={16} />
          </button>
        </div>
      </header>
      {directs.filter((d) => d.pending).map((d) => (
        <LinkBanner key={d.id} c={d} />
      ))}
      <NotStartedNote c={focus} />
      <Timeline key={view} tkey={view === 'all' ? timelineKey('p', person.id) : timelineKey('c', view)} convIds={shown.map((d) => d.id)} merged={shown.length > 1} onReply={setReply} firstUnreadTs={unreadAt} pairs={{ focus: focus.id, onFocus, inline: sliders, chunks }} />
      <TypingBar convIds={directs.map((d) => d.id)} />
      <Composer
        targets={{ convId: focus.id }}
        placeholder={`Message ${theirName(cur)} from ${myName(cur)} on ${netName(cur.conv.network)}`}
        reply={reply}
        clearReply={() => setReply(null)}
        disabledReason={composerBlocker(focus)}
        lead={rail || sliders ? undefined : <PairLead person={person} personId={person.id} directs={directs} focus={focus} />}
      />
    </section>
  );
}

export { LEVEL_HELP };
