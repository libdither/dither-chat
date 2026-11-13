import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, NETWORK_META, RULE_LABEL, RULE_LEVELS, sendBlocker, showsGone, showsInline } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ago, bytes, clock, dayLabel, fullTime, sameDay } from '../format.ts';
import { retention } from '../history.ts';
import { isJumbo, renderMarkdown } from '../markdown.ts';
import { inviteRef } from '../invites.ts';
import {
  AUTOMATIC,
  AUTOMATIC_HELP,
  OLDER_RULE,
  OLDER_RULE_HELP,
  RULE_HELP,
  authorName,
  chatPersonOf,
  plainBody,
  convByNative,
  convLabel,
  convTitle,
  crumbs,
  directsOf,
  effectiveLevel,
  heldHere,
  identityName,
  netName,
  peerIdentity,
  personOf,
  ruleIcon,
  ruleName,
  ruleOn,
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
  jumpInChat,
  jumpTo,
  startEditing,
  loadNewer,
  openProfile,
  toLatest,
  timelineKey,
  timelineRev,
  timelines,
} from '../state.ts';
import { openPalette } from './Palette.tsx';
import { reactionContext } from '../reactions.ts';
import { openAbout } from './About.tsx';
import { AccountChip, Avatar, Empty, Menu, NetGlyph, variantIcon } from './bits.tsx';
import { HoverReactions, InsertPicker, ReactionBar, useLongPress } from './Reactions.tsx';
import { Icon } from './icons.tsx';
import { TriageWhy, tierIcon, tierName } from './Marks.tsx';
import { MessageHistory, Ticks } from './MessageHistory.tsx';
import { detailsShown, showDetails, swipeReply } from './Pager.ts';
import { openConv } from './Sidebar.tsx';
import { viewer, type ViewerImage } from './Viewer.tsx';
import { JoinCallButton } from './Call.tsx';
import { EmojiComplete, insertAtCaret } from './EmojiComplete.tsx';
import { SlashCommandsLazy } from './apps/lazy.tsx';
import { claimSend } from '../apps.ts';
import { MentionComplete } from './MentionComplete.tsx';
import { loadEmoji } from '../emoji.ts';
import { isLottie, isSticker, Sticker } from './Sticker.tsx';
import { AttachedFiles, PendingUpload, useAttached } from './ComposerFiles.tsx';
import { TypingBar } from './Typing.tsx';
import { useGrow } from './grow.ts';
import { AttachSheet, CameraView, SendScreen } from './Attach.tsx';
import { mediaOffer, preloadStickers, StickerButton, StickerPicker, stickerInstaller, ViewOnceChip, VoiceButton } from './ComposerMedia.tsx';
import { CAPTURE_ACCEPT, MEDIA_ACCEPT, opensSendScreen } from '../camera.ts';
import { phone, touchOnly } from '../phone.ts';
import { composerDone, composerTyped } from '../typing.ts';
import { noteSeen } from '../activity.ts';
import { onMenu, openMenu, type MenuSpec } from './ContextMenu.tsx';
import { ForwardCard, forwarding } from './Forward.tsx';
import { InviteCards } from './InviteCard.tsx';
import { PollCardLazy, PollMakerLazy } from './PollLazy.tsx';
import { pollMaker } from '../polls.ts';
import { AttachmentNote, ContactCards, MissingFiles, played, QuoteFallback, SendFailures, StoryReplyLine, withoutCardLines } from './MessageExtras.tsx';
import { attachmentMenu, conversationMenu, identityMenu, imageMenu, linkMenu, messageMenu, openAttachment, personMenu } from './menus.tsx';
import { fileFacts, fileIcon, fileKind, openFileViewer, VIEWABLE } from '../files.ts';
import { desk } from '../desk.ts';
import { android } from '../android.ts';
import { counting, markPainted, rendered } from '../perf.ts';
import { memo } from './memo.ts';
import { heldRequest } from '../requests.ts';
import { LinkBanner, RequestBar } from './Requests.tsx';
import { countKey } from '../clicklog.ts';
import { badgeShows, focusedPair, focusPair, headNames, loadChat, PairDropdown, PairLead, RouteTag, SendLine, setView, viewOf } from './Pairs.tsx';
import { nicknamable, NicknamedName, ownName } from './Nickname.tsx';
import { Loading } from './Loader.tsx';
import { Slices, whenIdle } from '../slices.ts';
import { calendarOn } from '../plans.ts';
import { PlanChipLazy } from './calendar/lazy.tsx';
import { AltBadge, EmbedVideo, RichFoot, RichHead, RichMarks, Veil, veiled, Voice } from './rich/parts.tsx';
import { VoicePeople } from './Ringing.tsx';
import { ForumLazy } from './ThreadsLazy.tsx';
import { ScheduledStrip, useSendExtras } from './SendExtras.tsx';
import { FeedViewLazy, PostsListLazy, ThreadLazy } from './feed/lazy.tsx';
import { postMessageKey } from '../feed.ts';


// ------------------------------------------------------------------ header

function Crumbs({ c }: { c: P.ConversationView }) {
  metaRev.value; // a DM's crumb is the person's name, which changes without `c` changing
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

/**
 * A conversation's notification rule, from its header: Automatic (no rule), Always alert, List only or Mute. With no
 * rule of its own, the line under Automatic says what holds: a rule above it, or what the network does here.
 */
export function LevelMenu({ c, also }: { c: P.ConversationView; /** A person's other chats, which take the same rule (all chats together). */ also?: P.ConversationView[] }) {
  const eff = effectiveLevel(c);
  const own = ruleOn('conversation', c.id);
  const com = c.spaceIds[0] ?? (c.parentId ? db.conversations.get(c.parentId)?.spaceIds[0] : undefined);
  // The button says the rule that holds; with none, Automatic. A place muted on its network looks kept to the list.
  const held = eff.rule === 'mentions' ? 'Mentions only' : ruleName(eff.rule);
  const look = eff.rule ?? (eff.level === 'digest' ? 'digest' : 'auto');
  const pick = (l: P.RuleLevel | null, close: () => void) => () => {
    for (const x of [c, ...(also ?? [])]) setRule('conversation', x.id, l);
    close();
  };
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button class={`hdr-btn level ${look}`} data-track="notification level" onClick={toggle} title={`Notifications: ${ruleName(eff.rule)} (${eff.source})`} aria-label={`Notifications: ${held}`}>
          <Icon name={ruleIcon(eff.rule)} size={16} />
          <span class="hdr-btn-label">{held}</span>
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu">
          <div class="menu-title">Notify me about {convLabel(c)}</div>
          {own === 'mentions' && (
            <div class="menu-item on" data-rule="mentions">
              <Icon name={ruleIcon(own)} size={15} />
              <span>
                <b>{OLDER_RULE}</b>
                <small>{OLDER_RULE_HELP}</small>
              </span>
            </div>
          )}
          <button data-track="notification level (automatic)" data-rule="" class={`menu-item ${own === null ? 'on' : ''}`} onClick={pick(null, close)}>
            <Icon name={ruleIcon(null)} size={15} />
            <span>
              <b>{AUTOMATIC}</b>
              <small>
                {AUTOMATIC_HELP}
                {own === null && `. Now: ${heldHere(eff)}`}
              </small>
            </span>
          </button>
          {RULE_LEVELS.map((l) => (
            <button data-track={`notification level (${l})`} data-rule={l} class={`menu-item ${own === l ? 'on' : ''}`} onClick={pick(l, close)}>
              <Icon name={ruleIcon(l)} size={15} />
              <span>
                <b>{RULE_LABEL[l]}</b>
                <small>{RULE_HELP[l]}</small>
              </span>
            </button>
          ))}
          {com && (
            <div class="menu-foot">
              Whole {NETWORK_META[c.network].spaceNoun}:
              {(['digest', 'none'] as const).map((l) => (
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
                  {RULE_LABEL[l]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Menu>
  );
}

/**
 * A conversation's header. Under the name of a direct conversation, one line says where your message goes: the
 * network and, where you have several accounts, yours (`SendLine`); a group, a channel or a server says where it is
 * (the crumbs) and your account. The picture's badge is the network you send on.
 *
 * `chat`: someone you reach through several routes (PersonChat), and `c` the route messages go through. The header is
 * the same, saying the same of that route; it adds one control, the pill that opens the list of routes (Pairs.tsx).
 */
function ConvHeader({ c, onBack, chat }: { c: P.ConversationView; onBack?: () => void; chat?: { person: P.PersonView; directs: P.ConversationView[]; all: boolean; onView: (view: string) => void } }) {
  // Names it shows come from people and accounts, which change without `c` changing (a nickname, a rename).
  metaRev.value;
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  const isDirect = c.shape === 'direct';
  const person = chat?.person ?? (c.peerPersonId ? db.persons.get(c.peerPersonId) : null);
  // All chats together: the header is the person's, not one conversation's.
  const all = !!chat?.all;
  const whoTitle = person && isDirect ? `${person.name}'s profile` : `About ${convTitle(c)}`;
  // One route: the pencil by the name is for the nickname of their account in it. Several: the name is made of
  // their accounts' names, each with its own nickname on their profile, so it has none.
  const peer = isDirect && !chat ? db.identities.get(peerIdentity(c) ?? '') : null;
  const openWho = () => go(person && isDirect ? { view: 'profile', person: person.id } : { view: 'profile', conv: c.id });
  return (
    <header class="conv-head" data-track-area="chat header" onContextMenu={onMenu(() => (all ? personMenu(chat!.person) : conversationMenu(c)))}>
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
          {chat ? (
            <button class="conv-head-name" data-track="name" title={whoTitle} onClick={openWho}>
              {chat.person.name}
            </button>
          ) : nicknamable(peer) && !peer.isBot ? (
            <NicknamedName i={peer} label={convTitle(c)} title={peer.nickname ? `${whoTitle} (your nickname for ${ownName(peer)})` : whoTitle} onOpen={openWho} />
          ) : (
            <button class="conv-head-name" data-track="name" title={whoTitle} onClick={openWho}>
              {convTitle(c)}
            </button>
          )}
          {c.encrypted && !all && (
            <span class="e2ee" title="End-to-end encrypted on the network">
              <Icon name="lock" size={12} />
            </span>
          )}
        </h2>
        <div class="conv-head-sub">
          {chat ? (
            <PairDropdown person={chat.person} directs={chat.directs} focus={c} view={all ? 'all' : c.id} onPick={chat.onView} />
          ) : isDirect ? (
            <SendLine c={c} accounts={accounts} />
          ) : (
            <>
              <Crumbs c={c} />
              {accounts.length > 0 && (accounts.length > 1 || db.accounts.size > 1) && (
                <span class="via">
                  via
                  {accounts.map((a) => (
                    <AccountChip account={a} small />
                  ))}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div class="conv-head-actions">
        {person && isDirect && (
          <button class="hdr-btn phone-hide" data-track="profile" title="Profile" aria-label="Profile" onClick={() => go({ view: 'profile', person: person.id })}>
            <Icon name="info" size={16} />
          </button>
        )}
        <JoinCallButton c={c} />
        {!isDirect && (
          <button class="hdr-btn" data-track="about" title="About and settings" aria-label="About and settings" onClick={() => openAbout('conversation', c.id)}>
            <Icon name="info" size={16} />
          </button>
        )}
        <button class="hdr-btn" data-track="search here" title={all ? 'Search in every chat with them' : 'Search in this conversation'} aria-label={all ? 'Search in every chat with them' : 'Search in this conversation'} onClick={() => go({ view: 'search', q: `in:${all ? chat!.person.id : c.id}` })}>
          <Icon name="search" size={16} />
        </button>
        <LevelMenu c={c} also={all ? chat!.directs.filter((d) => d.id !== c.id) : undefined} />
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
    person: (id: string) => db.persons.get(id)?.name ?? null,
    identity: (id: string) => {
      const i = db.identities.get(id);
      return i ? { name: authorName(id), network: netName(i.network) } : null;
    },
  };
}

/** The text; `tail` (your message's ticks) sits right after its last word. */
function Body({ m, tail }: { m: P.MessageView; tail?: ComponentChildren }) {
  // Only mentions and room links read the db (names may arrive later); other bodies render once.
  // A role's name comes with the message (docs/rich-messages.md); a relative <t:…:R> moves on with the list.
  const roles = m.rich?.roles;
  const relative = /<t:-?\d+:R>/.test(m.body);
  const html = useMemo(
    () => renderMarkdown(m.body, { ...useMdContext(m.network), role: (id) => roles?.find((r) => r.id === id) ?? null }),
    [m.body, m.network, /<[@#]/.test(m.body) ? metaRev.value : 0, roles, relative ? rev.value : 0],
  );
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
    // A reference names a person, or one of their accounts (docs/mentions.md).
    if (el.dataset?.person) go({ view: 'profile', person: el.dataset.person });
    else if (el.dataset?.identity) openProfile(el.dataset.identity);
    // An invite link opens the New box on it, not the browser; the link's menu still opens it there.
    const a = el.closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && inviteRef(a.href)) {
      e.preventDefault();
      openPalette({ kind: 'new', mode: 'join' }, a.href);
    }
    // A sticker pack link opens its menu, where Install Sticker Pack is (ComposerMedia.tsx).
    else if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && stickerInstaller(a.href, m.seenVia)) {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, linkMenu(a.href, m));
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
  return (
    <>
      {m.pinned && (
        <span class="msg-pin" title="Pinned">
          <Icon name="pin" size={11} />
        </span>
      )}
      <RichMarks m={m} />
    </>
  );
}

function Attachments({ m }: { m: P.MessageView }) {
  if (!m.attachments.length) return null;
  // A file the network called just a file whose bytes are a picture, a video or a sound shows as one (files.ts).
  const media = (a: P.AttachmentView) => (a.kind === 'file' && a.info && /^(image|video|audio)$/.test(a.info.kind) ? (a.info.kind as P.AttachmentKind) : a.kind);
  const images = m.attachments.filter((a) => media(a) === 'image' && !isSticker(m, a));
  return (
    <div class="atts">
      {m.attachments.map((a, i) => {
        const kind = media(a);
        if (isSticker(m, a)) return <Sticker a={a} index={i} />;
        if (kind === 'image') {
          const w = a.width ?? a.info?.width ?? 400;
          const h = a.height ?? a.info?.height ?? 300;
          const scale = Math.min(1, 400 / w, 300 / h);
          const img = (
            <a class="att-img" data-att={i} href={a.url} target="_blank" rel="noreferrer" onClick={(e) => openViewer(e, images, images.indexOf(a))} style={{ width: `${Math.round(w * scale)}px`, aspectRatio: `${w} / ${h}` }}>
              <img src={a.url} alt={a.alt ?? a.name ?? ''} loading="lazy" />
              <AltBadge alt={a.alt} />
            </a>
          );
          return withNote(a, veiled(a) ? <Veil a={a}>{img}</Veil> : img);
        }
        if (kind === 'video') {
          const video = <video class="att-video" data-att={i} src={a.url} controls preload="metadata" onPlay={() => played(m)} />;
          return withNote(a, veiled(a) ? <Veil a={a}>{video}</Veil> : video);
        }
        // A voice message with its waveform and length (docs/rich-messages.md).
        if (a.voice) return withNote(a, <Voice a={a} index={i} />);
        if (kind === 'audio') return withNote(a, <audio class="att-audio" data-att={i} src={a.url} controls preload="metadata" onPlay={() => played(m)} />);
        const fk = fileKind(a);
        // A kind with a viewer opens in it (Viewer.tsx); any other opens in its app when the helper or the phone can,
        // else downloads (a type the hub won't show, HTML or SVG, straight away rather than through an empty tab).
        const open = (e: MouseEvent) => {
          if (VIEWABLE.has(fk)) e.preventDefault(), openFileViewer(a, m);
          else if (desk.value?.files || android?.opensFiles()) e.preventDefault(), openAttachment(a);
        };
        return withNote(
          a,
          <a class="att-file" data-att={i} data-kind={fk} href={a.url} target="_blank" rel="noreferrer" download={showsInline(a.mime) ? undefined : (a.name ?? true)} onClick={open}>
            <Icon name={fileIcon(fk, a.info?.language)} size={22} />
            <span>
              <b>{a.name ?? 'file'}</b>
              <small>{fileFacts(a)}</small>
            </span>
          </a>,
        );
      })}
    </div>
  );
}

/** A file with its voice-note label or caption under it (MessageExtras.tsx), or the file alone. */
const withNote = (a: P.AttachmentView, el: ComponentChildren) =>
  a.voiceNote || a.caption ? (
    <div class="att-with-note">
      {el}
      <AttachmentNote a={a} />
    </div>
  ) : (
    el
  );

function Embeds({ m }: { m: P.MessageView }) {
  if (!m.embeds.length) return null;
  const ctx = useMdContext(m.network);
  const md = (text: string) => ({ __html: renderMarkdown(text, ctx) });
  return (
    <div class="embeds">
      {m.embeds.map((e) => (
        <div class="embed" style={e.color && /^#[0-9a-f]{6}$/i.test(e.color) ? { borderLeftColor: e.color } : undefined}>
          {(e.provider || e.author) && (
            <small class="embed-by">
              {e.authorIcon && <img class="embed-icon" src={e.authorIcon} alt="" loading="lazy" onError={(ev) => ev.currentTarget.remove()} />}
              {[e.provider, e.author].filter(Boolean).join(' · ')}
            </small>
          )}
          {e.title && (e.url && /^https?:\/\//i.test(e.url) ? <a class="embed-title" href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a> : <b class="embed-title">{e.title}</b>)}
          {e.description && <div class="msg-body" dangerouslySetInnerHTML={md(e.description)} />}
          {e.fields?.map((f) => (
            <div class="embed-field">
              <b>{f.name}</b>
              <div class="msg-body" dangerouslySetInnerHTML={md(f.value)} />
            </div>
          ))}
          {e.video ? (
            <EmbedVideo e={e} />
          ) : (
            e.image && <img class="embed-image" src={e.image} alt="" loading="lazy" onClick={(ev) => openViewer(ev, [{ url: e.image!, name: e.title }], 0)} onError={(ev) => ev.currentTarget.remove()} />
          )}
          {(e.footer || e.timestamp) && (
            <small class="embed-by">
              {e.footerIcon && <img class="embed-icon" src={e.footerIcon} alt="" loading="lazy" onError={(ev) => ev.currentTarget.remove()} />}
              {[e.footer, e.timestamp ? fullTime(e.timestamp) : null].filter(Boolean).join(' · ')}
            </small>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Which tier a message landed in and why, and your marks on it: a quiet button among the hover actions, opening as a
 * floating menu so nothing clips it.
 */
function TriageNote({ m }: { m: P.MessageView }) {
  const t = m.triage;
  if (!t) return null;
  const label = tierName(t.decision);
  const spec = (): MenuSpec => ({
    label: 'Notification',
    items: [{ kind: 'row', render: (close) => <TriageWhy m={m} marks={!isSelfIdentity(m.authorId)} onDone={close} /> }],
  });
  return (
    <button
      class="icon-btn small"
      data-track="triage note"
      title={`${label}: why, and say if it was wrong`}
      aria-label={`Notification: ${label}`}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu({ x: r.right - 340, y: r.bottom + 4 }, spec(), e.currentTarget);
      }}
    >
      <Icon name={tierIcon(t.decision)} size={14} />
    </button>
  );
}

/**
 * Drawn again only when its props change (memo.ts) or a name or setting does (`metaRev`): a message arriving draws
 * itself and the one before it, not the whole timeline. The timeline looks up what it would read that changes with
 * each message: `target`, the message it replies to (a map per render, not a search per message); `thread`, its
 * thread's conversation. `onQuote` shows the quoted message. In a person's chat over several routes (ui/Pairs.tsx):
 * `who`, the author's account's own name (theirs or yours; their picture is the account's too), and `whoIdent`, the
 * account's identifier where another account on the same side shares that name; `net`, the network's badge on the
 * picture, where it would differ between the routes; `tag`, where the route changes, what of the route the head does
 * not say, after the time, which `onTag` sends through.
 */
const MessageItem = memo(function MessageItem({ m, grouped, onReply, onQuote, highlight, target, thread, who, whoIdent, net, tag, onTag }: { m: P.MessageView; grouped: boolean; onReply: (m: P.MessageView) => void; onQuote: (id: string) => void; highlight: boolean; target: P.MessageView | null; thread: P.ConversationView | null; who?: string; whoIdent?: string; net?: boolean; tag?: boolean; onTag?: (convId: string) => void }) {
  if (counting) rendered('MessageItem');
  metaRev.value;
  // On a touch screen the action bar (it shows on hover) and the tooltips are not drawn: a long-press opens the same
  // actions. That is a third of a message's DOM nodes on a phone (docs/perf.md).
  const hover = !touchOnly.value;
  const author = m.authorId ? db.identities.get(m.authorId) : null;
  const person = personOf(m.authorId);
  const self = isSelfIdentity(m.authorId);
  // In a person's chat, each account by its own name and picture (`who`); elsewhere theirs by the person's name.
  const name = who ?? (self ? identityName(m.authorId) || 'You' : authorName(m.authorId));
  const picture = who !== undefined ? author?.avatar : (person?.avatar ?? author?.avatar);
  const conv = net || tag ? db.conversations.get(m.conversationId) : undefined;
  const chatPerson = tag ? chatPersonOf(conv) : null;
  const reply = () => onReply(m);
  // Right-click or hold: the innermost thing that has a menu of its own (a file, a link, a person), else the message.
  const menuAt = (target: EventTarget | null): MenuSpec | null => {
    const el = target as HTMLElement | null;
    const att = el?.closest<HTMLElement>('[data-att]');
    if (att) {
      const a = m.attachments[Number(att.dataset.att)];
      if (a) return attachmentMenu(a, m, m.attachments.filter((x) => x.kind === 'image' && !isLottie(x)).map((x) => ({ url: x.url, name: x.name, width: x.width, height: x.height })), reply);
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
      {/* What it replies to, on a line of its own above the picture and the name: its line bends up from the picture. */}
      {target && (
        <button class="reply-quote" onClick={() => onQuote(target.id)}>
          <Icon name="reply" size={12} />
          <b>{isSelfIdentity(target.authorId) ? 'You' : authorName(target.authorId)}</b>
          <span>{target.deleted ? 'Message deleted' : plainBody(target.body, target.network).slice(0, 120) || 'Attachment'}</span>
        </button>
      )}
      {!target && m.quote && <QuoteFallback m={m} />}
      <div class="msg-gutter">
        {grouped ? (
          <span class="msg-time-hover" title={hover ? fullTime(m.ts) : undefined}>
            {clock(m.ts)}
          </span>
        ) : (
          <button class="avatar-btn" data-identity={m.authorId ?? undefined} onClick={() => openProfile(m.authorId)} aria-label={`Profile of ${name}`}>
            <Avatar id={(who !== undefined ? m.authorId : person?.id) ?? m.authorId ?? m.id} name={name} url={picture} size={36} network={net ? m.network : undefined} accountIds={net ? conv?.vantages.map((v) => v.accountId) : undefined} />
          </button>
        )}
      </div>
      <div class="msg-main">
        {!grouped && (
          <div class="msg-head">
            <span class={`msg-author ${self ? 'self' : ''}`} data-identity={m.authorId ?? undefined} role="link" tabindex={0} onClick={() => openProfile(m.authorId)} onKeyDown={(e) => e.key === 'Enter' && openProfile(m.authorId)} title={author ? `${author.nickname ? `${author.nickname} (your nickname; their name: ${author.displayName ?? author.handle ?? author.nativeId})` : (author.displayName ?? '')} ${author.handle ? '· ' + author.handle : ''} on ${netName(author.network)}` : ''}>
              {name}
            </span>
            {whoIdent && (
              <span class="msg-ident" title={`${name} on ${netName(m.network)}`}>
                {whoIdent}
              </span>
            )}
            {author?.isBot && <span class="bot-tag">BOT</span>}
            <span class="msg-time" title={hover ? fullTime(m.ts) : undefined}>
              {clock(m.ts)}
            </span>
            {/* A person's chat (ui/Pairs.tsx): where the route changes, which one, quietly. A click sends through it. */}
            {conv && chatPerson && onTag && <RouteTag c={conv} directs={directsOf(chatPerson.id)} side={self ? 'mine' : who !== undefined ? 'theirs' : 'other'} onPick={() => onTag(conv.id)} />}
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
            <RichHead m={m} />
            <Body m={m.forward.text !== undefined ? { ...m, body: m.forward.text } : m} tail={ticks} />
            <Attachments m={m} />
            <Embeds m={m} />
            <InviteCards m={m} body={m.forward.text ?? m.body} />
            <RichFoot m={m} />
          </ForwardCard>
        ) : (
          <>
            <RichHead m={m} />
            <StoryReplyLine m={m} />
            {m.poll ? <PollCardLazy m={m} fallback={<Body m={m} />} /> : <Body m={m.contacts ? withoutCardLines(m) : m} tail={ticks} />}
            <Attachments m={m} />
            <MissingFiles m={m} />
            <ContactCards m={m} />
            <Embeds m={m} />
            <InviteCards m={m} body={m.body} />
            <RichFoot m={m} />
          </>
        )}
        <SendFailures m={m} />
        {ticks && (!m.body || m.deleted || (m.poll && !m.forward)) && <span class="msg-marks">{ticks}</span>}
        {grouped && (m.editedTs || m.edits) && <Edited m={m} />}
        {grouped && (m.pinned || m.rich?.silent || m.rich?.marks) && (
          <span class="msg-marks">
            <Marks m={m} />
          </span>
        )}
        <ReactionBar m={m} />
        {/* A plan the calendar found in this message (docs/calendar.md): nothing at all on a hub without a calendar. */}
        {calendarOn && <PlanChipLazy messageId={m.id} />}
        {thread && (
          <button class="thread-chip" onClick={() => openConv(thread)}>
            <Icon name="thread" size={13} />
            <b>{convTitle(thread)}</b>
            <span>{thread.lastMessage ? `${authorName(thread.lastMessage.authorId)}: ${plainBody(thread.lastMessage.text, thread.network)}` : 'Open thread'}</span>
          </button>
        )}
      </div>
      {hover && (
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
              openMenu({ x: r.left, y: r.bottom + 4 }, messageMenu(m, reply), e.currentTarget);
            }}
          >
            <Icon name="more" size={15} />
          </button>
          <TriageNote m={m} />
        </div>
      )}
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

/**
 * `chat`: a person's chat over several routes (PersonChat): messages name each account by its own name and picture
 * (Pairs.tsx headNames, over the routes shown); `badge`, whether pictures
 * carry the network's badge; `onFocus`, a route tag's click; `onMissing`, a message linked to (`focus`) that paging
 * back through the chat did not reach.
 */
function Timeline({ tkey, convIds, onReply, firstUnreadTs, focus, chat }: { tkey: string; convIds: string[]; onReply: (m: P.MessageView) => void; firstUnreadTs: number | null; focus?: string; chat?: { badge: boolean; onFocus: (convId: string) => void; onMissing: () => void } }) {
  if (counting) rendered('Timeline');
  timelineRev(tkey).value;
  const scroller = useRef<HTMLDivElement>(null);
  const t = timelines.get(tkey);
  const [flash, setFlash] = useState<string | null>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    // A person's chat pages back through every route to the message; one too far back shows its route alone.
    if (focus && tkey.startsWith('p:')) void jumpInChat(tkey, focus).then((found) => !found && chat?.onMissing());
    else if (focus) void jumpTo(convIds[0], focus);
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
  // And of that, the newest FIRST when it shows, then a slice more each time the page is idle (slices.ts).
  const [slices] = useState(() => new Slices());
  slices.begin(tkey);
  const draw = (from: string | null, to: string | null) => {
    drawn.current = { key: tkey, from, to };
    slices.whole();
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
    slices.whole();
  }
  const want = bounds();
  const end = want.end;
  const start = slices.start(want.start, end);
  /** Slices still to draw. */
  const more = start > want.start;
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
  // A slice drawn above holds the first message in view, not the first drawn: that one loses its name line when the
  // message before it is drawn (grouped with it), which would move everything below it by a line.
  const firstInView = () => {
    const el = scroller.current;
    if (!el) return first;
    const top = el.getBoundingClientRect().top;
    for (let i = start; i < end; i++) {
      const node = document.getElementById(`m-${all[i].id}`);
      if (node && node.getBoundingClientRect().bottom > top) return all[i];
    }
    return first;
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // column-reverse: scrollTop is 0 at the bottom and negative going up.
    if (el.scrollHeight + el.scrollTop - el.clientHeight < 400) {
      if (more) {
        // Nearer the top of what is drawn than its slices have come: the next one now.
        hold(firstInView(), 'first');
        slices.next(want.start, end);
        redraw((n) => n + 1);
      } else if (start > 0) {
        hold(first, 'first');
        drawn.current = { key: tkey, from: all[Math.max(0, start - STEP)].id, to: drawn.current.to };
        slices.extend(end - start);
        redraw((n) => n + 1);
      } else {
        if (t && !t.loading && t.hasMore) {
          hold(first, 'first');
          // The page coming is drawn, as is everything above it: a slice at once, the rest in slices.
          if (drawn.current.from !== '^') drawn.current = { ...drawn.current, from: '^' };
          slices.extend(end - start);
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
      // The newest message is on screen, read or not: what this stay could have seen (activity.ts).
      const newest = all[all.length - 1];
      if (newest) noteSeen(convIds, newest.ts);
      // Back at the newest after drawing far up: only the newest again. What goes is above the view.
      if (d.from !== null && end - start > WINDOW + STEP) draw(null, null);
    }
  };
  useEffect(() => {
    const id = setTimeout(() => onScroll(), 300);
    return () => clearTimeout(id);
  });
  // The next slice once the page is idle. Above the view it would move what is in it, so the first message in view is
  // held where it is; at the newest end (column-reverse) nothing moves.
  useEffect(() => {
    if (!more) return;
    return whenIdle(() => {
      if (Math.abs(scroller.current?.scrollTop ?? 0) > 1) hold(firstInView(), 'first');
      slices.next(want.start, end);
      redraw((n) => n + 1);
    });
  });
  // Until the drawn messages fill the view, a slice more before it is painted: short ones may not, the first time.
  useLayoutEffect(() => {
    const el = scroller.current;
    // A view not laid out (a page out of sight) has nothing to fill.
    if (!more || !el || !el.clientHeight || slices.filled === tkey) return;
    if (el.scrollHeight > el.clientHeight) slices.filled = tkey;
    else {
      slices.next(want.start, end);
      redraw((n) => n + 1);
    }
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
  // The same function from one render to the next, so a message is not drawn again for a new one (memo.ts).
  const tagTo = useRef(chat?.onFocus);
  tagTo.current = chat?.onFocus;
  const onTag = useMemo(() => (id: string) => tagTo.current?.(id), []);
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
  // A person's chat: how each account in it is named (the routes shown; a bot in a DM is not among them).
  const heads = chat ? headNames(convIds) : null;
  const unreadFrom = firstUnreadTs === null ? -1 : all.findIndex((m) => m.ts > firstUnreadTs && !isSelfIdentity(m.authorId));
  for (let i = start; i < end; i++) {
    const m = all[i];
    if (!prev || !sameDay(prev.ts, m.ts)) items.push(<div class="day-sep"><span>{dayLabel(m.ts)}</span></div>);
    if (i === unreadFrom) items.push(<div class="new-sep"><span>New</span></div>);
    const grouped = !!prev && prev.authorId === m.authorId && prev.conversationId === m.conversationId && m.ts - prev.ts < 7 * 60_000 && sameDay(prev.ts, m.ts) && prev.kind !== 'system' && !m.replyToId;
    const target = m.replyToId ? (byId.get(m.replyToId) ?? quoted.get(m.replyToId) ?? null) : null;
    const thread = m.threadId ? (db.conversations.get(m.threadId) ?? null) : null;
    // All chats together: where the route changes, grouping breaks (above) and the head line says which route.
    const tag = !!chat && convIds.length > 1 && !grouped && (!prev || prev.conversationId !== m.conversationId);
    const head = heads && m.authorId ? heads.get(m.authorId) : undefined;
    items.push(<MessageItem key={m.id} m={m} grouped={grouped} onReply={onReply} onQuote={onQuote} highlight={m.id === flash} target={target} thread={thread} who={head?.name} whoIdent={head?.ident} net={!!chat?.badge} tag={tag} onTag={chat ? onTag : undefined} />);
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
        {t?.loading && (msgs.length ? <Loading inline label="Loading older messages" /> : <Loading label="Loading messages…" />)}
        {!t && <Loading label="Loading messages…" />}
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
  /** A person page (ui/Pairs.tsx): a line in place of the placeholder that can be clicked; it moves to the box's edge once typed in. */
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
  // The emoji button's picker, beside what opened it (Reactions.tsx).
  const [emojiAt, setEmojiAt] = useState<DOMRect | null>(null);
  // Stickers, recording and view-once, where the sending account has them (ComposerMedia.tsx).
  const offer = mediaOffer(sender, canAttach);
  const [viewOnce, setViewOnce] = useState(false);
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
    setEmojiAt(null);
    setViewOnce(false);
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
    // A slash command picked over the box runs instead of the text being sent (ui/apps, docs/apps.md).
    if (!edit && claimSend(targets.convId)) return;
    const body = text.trim();
    if ((!body && !files.length) || disabledReason || (att.failed && !edit)) return;
    if (edit) {
      const m = edit;
      cancelEdit();
      if (body !== m.body) void editMessage(m, body);
      return;
    }
    send(targets.convId, body, { accountId: targets.accountId, replyTo: reply?.id, files: files.map((f) => f.file), uploads: files.map((f) => f.job!), ...extras.opts, ...(viewOnce && offer.viewOnce && files.length ? { media: { viewOnce: true } } : {}) });
    extras.sent();
    composerDone();
    type('');
    att.clear(true);
    clearReply();
    setReview(false);
    setViewOnce(false);
  };
  /** A sticker or a recording goes at once, on its own, as a reply when one is open. */
  const sendMedia = (opts: { files?: File[]; media?: { sticker?: string; voice?: P.VoiceOut } }) => {
    send(targets.convId, '', { accountId: targets.accountId, replyTo: reply?.id, ...opts });
    clearReply();
  };
  const canSend = !((!text.trim() && !files.length) || !!disabledReason || (att.failed && !edit));
  const sendTitle = att.failed && !edit ? 'A file did not upload: try it again or remove it' : undefined;
  // Reply without a ping, send silently, send later (SendExtras.tsx, docs/sending.md).
  const extras = useSendExtras({
    conv,
    sender,
    reply,
    canSend,
    blocked: !!edit || !!disabledReason,
    draft: async () => ({ body: text.trim(), attachments: (await Promise.all(files.map((f) => f.job!.settle()))).map((u) => u.id) }),
    done: () => {
      composerDone();
      type('');
      att.clear(true);
      clearReply();
    },
  });
  const onText = (v: string) => {
    type(v);
    // Editing a sent message is not typing a new one.
    if (!edit) composerTyped({ conversationId: targets.convId, accountId: sender?.id }, v);
  };
  const limit = conv ? `up to ${ATTACHMENT_LIMITS[conv.network].bytes / 1024 / 1024} MB each` : '';
  const attaching = canAttach && !edit && !disabledReason;
  // Making a poll (docs/polls.md): where an account here makes them, not in an open message request.
  const [polling, setPolling] = useState(false);
  useEffect(() => setPolling(false), [targets.convId]);
  const pollAccount = conv && !edit && !disabledReason ? pollMaker(targets.convId, sender?.id) : null;
  // A computer's + (docs/sending.md "The + menu"): what this chat's network takes besides words, and only that. Where
  // files are all it takes, the + is a paperclip that opens the file picker at once.
  const [stickerAt, setStickerAt] = useState<DOMRect | null>(null);
  useEffect(() => setStickerAt(null), [targets.convId]);
  const plusRef = useRef<HTMLButtonElement>(null);
  const canSticker = !!conv && !disabledReason && !edit && offer.stickers;
  type PlusItem = { track: string; icon: string; label: string; note?: string; run: () => void; hover?: () => void };
  const plusItems: PlusItem[] = onPhone
    ? []
    : ([
        attaching && { track: 'attach', icon: 'paperclip', label: 'Upload a file', note: limit.replace('up to ', ''), run: () => picker.current?.click() },
        pollAccount && { track: 'poll', icon: 'list', label: 'Poll', run: () => setPolling(true) },
        canSticker && { track: 'stickers', icon: 'sticker', label: 'Sticker', run: () => plusRef.current && setStickerAt(plusRef.current.getBoundingClientRect()), hover: preloadStickers },
      ] as (PlusItem | false | null | undefined)[]).filter((x): x is PlusItem => !!x);
  const plus =
    plusItems.length === 1 && plusItems[0].track === 'attach' ? (
      <button class="icon-btn attach-btn" data-track="attach" onClick={() => picker.current?.click()} title={`Attach files, ${limit}`} aria-label="Attach files">
        <Icon name="paperclip" size={17} />
      </button>
    ) : plusItems.length > 0 ? (
      <Menu
        up
        trigger={(toggle) => (
          <button ref={plusRef} class="icon-btn composer-plus-menu" data-track="plus" onClick={toggle} title="Files, polls and stickers" aria-label="More to send">
            <Icon name="plus" size={18} />
          </button>
        )}
      >
        {(close) => (
          <div class="level-menu plus-menu">
            {plusItems.map((it) => (
              <button
                class="menu-item"
                data-track={it.track}
                onPointerEnter={it.hover}
                onClick={() => {
                  close();
                  it.run();
                }}
              >
                <Icon name={it.icon} size={15} /> {it.label}
                {it.note && <span class="plus-note">{it.note}</span>}
              </button>
            ))}
          </div>
        )}
      </Menu>
    ) : null;
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
  const emojiBtn = conv && !disabledReason && (
    <button
      class="icon-btn composer-emoji"
      data-track="emoji"
      title="Emoji"
      aria-label="Emoji"
      aria-expanded={!!emojiAt}
      // The catalog loads while the pointer is on its way, so the picker opens whole.
      onPointerEnter={() => void loadEmoji()}
      onClick={(e) => setEmojiAt(emojiAt ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
    >
      <Icon name="smile" size={onPhone ? 20 : 18} />
    </button>
  );
  const sendBtn =
    attaching && offer.record && !text.trim() && !files.length ? (
      <VoiceButton conversationId={targets.convId} onPhone={onPhone} voice={offer.voice} onSend={(f, voice) => sendMedia({ files: [f], ...(voice ? { media: { voice } } : {}) })} />
    ) : (
      <button class="send-btn" data-track="send" disabled={!canSend} onClick={submit} aria-label="Send" title={sendTitle}>
        <Icon name="send" size={17} />
      </button>
    );
  const stickerBtn = conv && !disabledReason && !edit && offer.stickers && (
    <StickerButton conversationId={targets.convId} accountId={targets.accountId ?? sender?.id} onPhone={onPhone} onSend={(st) => sendMedia({ media: { sticker: st.id } })} />
  );
  const viewOnceChip = offer.viewOnce && files.length > 0 && !edit && <ViewOnceChip on={viewOnce} set={setViewOnce} />;
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
      <ScheduledStrip conversationId={targets.convId} />
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
          {extras.replyToggle}
          <button class="icon-btn small" data-track="cancel reply" onClick={clearReply} aria-label="Cancel reply">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      <AttachedFiles files={att.files} remove={att.remove} />
      {viewOnceChip}
      <EmojiComplete ta={ta} convId={targets.convId} network={conv?.network} />
      {!edit && <SlashCommandsLazy ta={ta} convId={targets.convId} accountId={sender?.id} text={text} />}
      <MentionComplete ta={ta} convId={targets.convId} network={conv?.network} accountId={sender?.id} />
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
      {polling && conv && pollAccount ? (
        // A poll is drafted where the message box was; what the box held is its question (docs/polls.md).
        <PollMakerLazy
          conversationId={targets.convId}
          network={conv.network}
          accountId={pollAccount.id}
          question={text.trim()}
          onClose={() => {
            setPolling(false);
            requestAnimationFrame(() => ta.current?.focus());
          }}
          onSent={() => type('')}
        />
      ) : onPhone ? (
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
            {emojiBtn}
            {stickerBtn}
            {attaching && (
              <button class="icon-btn composer-camera" data-track="camera" onClick={openCamera} aria-label="Take a photo or video">
                <Icon name="camera" size={20} />
              </button>
            )}
          </div>
          {extras.button}
          {sendBtn}
        </div>
      ) : (
        <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
          {plus}
          {sendAsMenu}
          {lead ? (
            <div class={`pair-lead ${text ? 'raised' : ''}`}>
              <div class="pair-lead-slot">{lead}</div>
              {box}
            </div>
          ) : (
            box
          )}
          {emojiBtn}
          <div class={`send-split ${extras.button ? 'two' : ''}`}>
            {sendBtn}
            {extras.button}
          </div>
        </div>
      )}
      {stickerAt && canSticker && (
        <StickerPicker
          conversationId={targets.convId}
          accountId={targets.accountId ?? sender?.id}
          anchor={stickerAt}
          onSend={(st) => sendMedia({ media: { sticker: st.id } })}
          onClose={() => setStickerAt(null)}
        />
      )}
      {emojiAt && conv && (
        <InsertPicker
          conversationId={targets.convId}
          network={conv.network}
          anchor={emojiAt}
          onInsert={(t) => ta.current && insertAtCaret(ta.current, t, !onPhone)}
          onClose={() => setEmojiAt(null)}
        />
      )}
      {sheet && (
        <AttachSheet
          limit={limit}
          onClose={() => setSheet(false)}
          onPhotos={() => photos.current?.click()}
          onFile={() => picker.current?.click()}
          onPoll={pollAccount ? () => setPolling(true) : undefined}
          {...(offer.viewOnce ? { onViewOnce: () => (setViewOnce(true), photos.current?.click()) } : {})}
        />
      )}
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
          extra={viewOnceChip}
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

/** Signal's conversations exist only from the first message on, which is worth saying while there is none. */
function NotStartedNote({ c }: { c: P.ConversationView }) {
  if (c.network !== 'signal' || c.shape !== 'direct' || c.lastMessage) return null;
  return <div class="voice-note"><Icon name="info" size={14} /> Nothing exists on Signal yet. {convTitle(c)} sees this conversation when you send the first message.</div>;
}

/**
 * A conversation's page. A DM with someone you reach by several routes is their chat (PersonChat), whichever DM of
 * theirs the address names: the page is the same, and sends through that DM.
 */
export function ConversationPane({ convId, onBack, focus }: { convId: string; onBack?: () => void; focus?: string }) {
  rev.value;
  const c = db.conversations.get(convId);
  const person = chatPersonOf(c);
  if (c && person) return <PersonChat person={person} directs={directsOf(person.id)} at={c} onBack={onBack} msg={focus} />;
  return <PlainPane convId={convId} onBack={onBack} focus={focus} />;
}

function PlainPane({ convId, onBack, focus }: { convId: string; onBack?: () => void; focus?: string }) {
  rev.value;
  const c = db.conversations.get(convId);
  const [reply, setReply] = useState<P.MessageView | null>(null);
  const unreadAt = useMemo(() => (c ? firstUnread([c]) : null), [convId]);
  useEffect(() => setReply(null), [convId]);
  useEffect(() => void reactionContext(convId), [convId]);
  if (!c) return <Empty icon="groups" title="Conversation not found" />;
  // A network's notifications about you: cards, and no composer (docs/feed.md).
  if (c.variant === 'feed')
    return (
      <section class="pane feed-pane">
        <ConvHeader c={c} onBack={onBack} />
        <FeedViewLazy c={c} />
      </section>
    );
  // The public posts the hub logged (docs/feed.md "Threads"): a message opens its thread; else the list of them.
  if (c.variant === 'posts')
    return focus ? (
      <ThreadLazy postKey={postMessageKey(focus)} onBack={onBack} />
    ) : (
      <section class="pane feed-pane">
        <ConvHeader c={c} onBack={onBack} />
        <PostsListLazy c={c} />
      </section>
    );
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  const sendAsValue = prefs.value.sendAs[c.id] ?? accounts.find((a) => a.status === 'online')?.id ?? accounts[0]?.id;
  const voice = c.variant === 'voice' || c.variant === 'stage';
  const held = heldRequest(db.requests, c.id);
  return (
    <section class="pane">
      <ConvHeader c={c} onBack={onBack} />
      {!held && c.pending && <LinkBanner c={c} />}
      {/* A forum's or media channel's messages are its posts (ui/Threads.tsx, docs/threads.md). */}
      {c.variant === 'forum' || c.variant === 'media' ? (
        <ForumLazy c={c} />
      ) : (
        <>
          {voice && <div class="voice-note"><Icon name="voice" size={14} /> Voice isn't relayed. This shows the channel's text chat.</div>}
          {voice && <VoicePeople conversationId={c.id} size={22} names class="voice-here" />}
          <NotStartedNote c={c} />
          <Timeline tkey={timelineKey('c', c.id)} convIds={[c.id]} onReply={setReply} firstUnreadTs={unreadAt} focus={focus} />
        </>
      )}
      <TypingBar convIds={[c.id]} />
      {held ? (
        <RequestBar r={held} />
      ) : c.variant === 'forum' || c.variant === 'media' ? null : (
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

/** A person's page: the chat with them. One conversation is that conversation's page; several are one chat over them. */
export function PersonPane({ personId, onBack }: { personId: string; onBack?: () => void }) {
  rev.value;
  const person = db.persons.get(personId);
  const directs = directsOf(personId);
  if (!person) return <Empty icon="user" title="Person not found" />;
  if (!directs.length) return <Empty icon="user" title={`No chats with ${person.name}`} />;
  if (directs.length === 1) return <PlainPane convId={directs[0].id} onBack={onBack} />;
  return <PersonChat person={person} directs={directs} onBack={onBack} />;
}

/**
 * Someone you reach by several routes (ui/Pairs.tsx, docs/chats.md), as one chat: the page any conversation has,
 * every route interleaved, adding only what the chat needs (chatroutes.ts). `at`: the DM the address names, which
 * messages go through until another route is picked. The list under the name filters to one route without leaving.
 * `msg`: a message to open at, in the interleaved timeline when paging back reaches it, else in its route alone.
 */
function PersonChat({ person, directs, at, onBack, msg }: { person: P.PersonView; directs: P.ConversationView[]; at?: P.ConversationView; onBack?: () => void; msg?: string }) {
  const [reply, setReply] = useState<P.MessageView | null>(null);
  const unreadAt = useMemo(() => firstUnread(directs), [person.id]);
  useEffect(() => setReply(null), [person.id]);
  useEffect(() => void loadChat(person.id), [person.id]);
  // Where a message goes: the route of the message you are replying to, else the route in use (Pairs.tsx).
  const focus = (reply && directs.find((d) => d.id === reply.conversationId)) || focusedPair(person.id, directs, at?.id);
  useEffect(() => void reactionContext(focus.id), [focus.id]);
  // Showing one route's history follows the route you send through, so switching it in the message box switches both.
  const view = viewOf(person.id, directs) !== 'all' ? focus.id : 'all';
  const shown = view === 'all' ? directs : [focus];
  const onFocus = (id: string) => {
    if (reply && reply.conversationId !== id) setReply(null);
    focusPair(person.id, focus.id, id, at?.id);
  };
  const onView = (v: string) => {
    setView(person.id, v);
    if (v !== 'all') onFocus(v);
  };
  // A message too far back to page to: its route alone (the list under the name says so; one pick returns to all).
  const onMissing = () => at && onView(at.id);
  const held = heldRequest(db.requests, focus.id);
  return (
    <section class="pane">
      <ConvHeader c={focus} onBack={onBack} chat={{ person, directs, all: view === 'all', onView }} />
      {!held && shown.filter((d) => d.pending).map((d) => <LinkBanner key={d.id} c={d} />)}
      <NotStartedNote c={focus} />
      <Timeline
        key={view}
        tkey={view === 'all' ? timelineKey('p', person.id) : timelineKey('c', view)}
        convIds={shown.map((d) => d.id)}
        onReply={setReply}
        firstUnreadTs={unreadAt}
        focus={msg}
        chat={{ badge: view === 'all' && badgeShows(directs), onFocus, onMissing }}
      />
      <TypingBar convIds={shown.map((d) => d.id)} />
      {held ? (
        <RequestBar r={held} />
      ) : (
        <Composer
          targets={{ convId: focus.id }}
          placeholder={`Message ${person.name}`}
          reply={reply}
          clearReply={() => setReply(null)}
          disabledReason={composerBlocker(focus)}
          lead={<PairLead person={person} directs={directs} focus={focus} onFocus={onFocus} />}
        />
      )}
    </section>
  );
}
