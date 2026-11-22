import { isArrivedCopy } from '../arrived.ts';
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, durationLabel, NETWORK_META, RULE_LABEL, RULE_LEVELS, sendBlocker, showsGone, showsInline, type PictureLayout } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ago, clock, dayLabel, fullTime, sameDay } from '../format.ts';
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
  visibleAccount,
} from '../model.ts';
import {
  db,
  go,
  isSelfIdentity,
  loadTimeline,
  markRead,
  pending,
  toast,
  pref,
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
  openMessage,
  openProfile,
  toLatest,
  timelineKey,
  timelineRev,
  timelines,
} from '../state.ts';
import { openPalette } from './Palette.tsx';
import { reactionContext } from '../reactions.ts';
import { openAbout } from '../opening.ts';
import { Avatar, Empty, FromChips, Menu, variantIcon } from './bits.tsx';
import { HoverReactions, InsertPicker, ReactionBar } from './Reactions.tsx';
import { useLongPress } from './longpress.ts';
import { Icon } from './icons.tsx';
import { TriageWhy, tierIcon, tierName } from './Marks.tsx';
import { Ticks } from './Ticks.tsx';
import { openHistory } from '../messageHistory.ts';
import { markChanged } from '../wordDiff.ts';
import { detailsShown, showDetails, swipeReply } from './Pager.ts';
import { openConv } from '../opening.ts';
import { JoinCallButton } from './Call.tsx';
import { EmojiComplete, insertAtCaret } from './EmojiComplete.tsx';
import { SlashCommandsLazy } from './apps/lazy.tsx';
import { claimSend } from '../apps.ts';
import { MentionComplete } from './MentionComplete.tsx';
import { useChipBox } from './ChipBox.tsx';
import { loadEmoji } from '../emoji.ts';
import { isSticker, Sticker } from './Sticker.tsx';
import { openViewer, Pictures } from './Pictures.tsx';
import { PictureChip } from './PictureSwitch.tsx';
import { isPicture, onlyPictures, pictureRuns, picturesOf } from '../pictures.ts';
import { pictureLayout } from '../arrange.ts';
import { AttachedFiles, PendingUpload, useAttached } from './ComposerFiles.tsx';
import { TypingBar } from './Typing.tsx';
import { HeadOrb, offline } from './Offline.tsx';
import { DisappearsMark, TimerLabel } from './Disappearing.tsx';
import { useGrow } from './grow.ts';
import { CameraView, SendScreen } from './Attach.tsx';
import type { PanelTab } from './panel/Panel.tsx';
import { GifPicker, gifSend, mediaOffer, preloadStickers, StickerPicker, stickerInstaller, ViewOnceChip, VoiceButton } from './ComposerMedia.tsx';
import type { GifPick } from './ComposerMediaParts.tsx';
import { CAPTURE_ACCEPT, MEDIA_ACCEPT, opensSendScreen } from '../camera.ts';
import { gifLinkOf, plainGifs } from '../gifs.ts';
import { closePanel, openPanel, panelOpen, panelShown, phone, reducedMotion, touchOnly } from '../phone.ts';
import { composerDone, composerTyped } from '../typing.ts';
import { noteSeen } from '../activity.ts';
import { onMenu, openMenu, type MenuSpec } from './ContextMenu.tsx';
import { ForwardCard, forwarding } from './Forward.tsx';
import { InviteCards } from './InviteCard.tsx';
import { PollCardLazy, PollMakerLazy } from './PollLazy.tsx';
import { pollMaker } from '../polls.ts';
import { AttachmentNote, ContactCards, MissingFiles, played, QuoteFallback, ReplyQuote, SendFailures, StoryReplyLine, withoutCardLines } from './MessageExtras.tsx';
import { attachmentMenu, conversationMenu, identityMenu, imageMenu, linkMenu, messageMenu, openAttachment, personMenu } from './menus.tsx';
import { fileFacts, fileIcon, fileKind, openFileViewer, VIEWABLE } from '../files.ts';
import { desk } from '../desk.ts';
import { android } from '../android.ts';
import { counting, markPainted, rendered } from '../perf.ts';
import { memo } from './memo.ts';
import { heldRequest } from '../requests.ts';
import { LinkBanner, RequestBar, RequestSentMark, RequestSentNote } from './Requests.tsx';
import { countKey } from '../clicklog.ts';
import { badgeShows, focusedPair, focusPair, headNames, loadChat, PairDropdown, PairLead, RouteTag, SendAsLead, SendLine, setView, viewOf } from './Pairs.tsx';
import { nicknamable, NicknamedName, ownName } from './Nickname.tsx';
import { Loading } from './Loader.tsx';
import { Slices, whenIdle } from '../slices.ts';
import { calendarOn } from '../plans.ts';
import { PlanChipLazy } from './calendar/lazy.tsx';
import { EmbedVideo, RichFoot, RichHead, RichMarks, Veil, veiled, Voice } from './rich/parts.tsx';
import { VoicePeople } from './Ringing.tsx';
import { ForumLazy } from './ThreadsLazy.tsx';
import { CallRoomLazy, roomCall, roomHasChat, roomSide, RoomSwitch } from './CallRoomLazy.tsx';
import { CallSlot, fillsPage } from './CallSlot.tsx';
import { ScheduledStrip, useSendExtras } from './SendExtras.tsx';
import { FeedViewLazy, FollowChatLazy, PostsListLazy, ThreadLazy } from './feed/lazy.tsx';
import { postMessageKey } from '../feed.ts';


// ------------------------------------------------------------------ header

/**
 * Where a place is, under its name: its server and the sections or parent chat in between. The network is the chip
 * before it (FromChips), and a chat's own name is the title, so neither repeats here; nor does "Groups".
 */
function Crumbs({ c }: { c: P.ConversationView }) {
  metaRev.value; // names change without `c` changing
  const r = route.value;
  const within = r.view === 'space' ? r.space : undefined;
  const cs = crumbs(c, within).filter((x) => x.kind !== 'network' && x.id && x.id !== c.id);
  if (cs.length === 0) return null;
  return (
    <span class="crumbs">
      {cs.map((x, i) => (
        <>
          {i > 0 && <span class="crumb-sep">›</span>}
          {x.kind === 'space' ? (
            <button class="crumb link" data-track="crumb (community)" onClick={() => go({ view: 'space', space: x.id! })}>
              {x.label}
            </button>
          ) : x.kind === 'conversation' ? (
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
function LevelMenu({ c, also }: { c: P.ConversationView; /** A person's other chats, which take the same rule (all chats together). */ also?: P.ConversationView[] }) {
  const eff = effectiveLevel(c);
  // The button says the rule that holds; with none, Automatic. A place muted on its network looks kept to the list.
  const held = eff.rule === 'mentions' ? 'Mentions only' : ruleName(eff.rule);
  const look = eff.rule ?? (eff.level === 'digest' ? 'digest' : 'auto');
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        // A bell, with a dot where a rule other than Automatic holds; the rule's own icon says which.
        <button class={`hdr-btn level ${look} phone-hide`} data-track="notification level" onClick={toggle} title={`Notifications: ${ruleName(eff.rule)} (${eff.source})`} aria-label={`Notifications: ${held}`}>
          <Icon name={eff.rule ? ruleIcon(eff.rule) : 'bell'} size={16} />
          {eff.rule && <span class="hdr-dot" aria-hidden="true" />}
        </button>
      )}
    >
      {(close) => <LevelItems c={c} also={also} close={close} />}
    </Menu>
  );
}

/** The notification rules, as the header's bell lists them and a phone's ⋯ menu does. */
function LevelItems({ c, also, close }: { c: P.ConversationView; also?: P.ConversationView[]; close: () => void }) {
  const eff = effectiveLevel(c);
  const own = ruleOn('conversation', c.id);
  const com = c.spaceIds[0] ?? (c.parentId ? db.conversations.get(c.parentId)?.spaceIds[0] : undefined);
  const pick = (l: P.RuleLevel | null, close: () => void) => () => {
    for (const x of [c, ...(also ?? [])]) setRule('conversation', x.id, l);
    close();
  };
  return (
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
  );
}

/**
 * A phone's header keeps Call and Search; the rest is in this menu: the profile or the place's about page, the
 * details panel, and the notification rules.
 */
function HeadMore({ c, also, profile }: { c: P.ConversationView; also?: P.ConversationView[]; profile?: string }) {
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button class="hdr-btn phone-only" data-track="header menu" title="More" aria-label="More" onClick={toggle}>
          <Icon name="more" size={18} />
        </button>
      )}
    >
      {(close) => (
        <>
          <button
            class="menu-item"
            data-track={profile ? 'profile' : 'about'}
            onClick={() => {
              close();
              if (profile) go({ view: 'profile', person: profile });
              else openAbout('conversation', c.id);
            }}
          >
            <Icon name="info" size={15} />
            <span>
              <b>{profile ? 'Profile' : 'About and settings'}</b>
            </span>
          </button>
          <button
            class="menu-item"
            data-track="details"
            onClick={() => {
              close();
              showDetails(!detailsShown());
            }}
          >
            <Icon name="panel" size={15} />
            <span>
              <b>Details</b>
            </span>
          </button>
          <LevelItems c={c} also={also} close={close} />
        </>
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
              <FromChips network={c.network} accounts={accounts} />
              <Crumbs c={c} />
              {c.shape === 'group' && c.participantIds.length > 1 && <span class="head-count">{c.participantIds.length} people</span>}
            </>
          )}
          {isDirect && <RequestSentMark convs={chat ? [c, ...chat.directs] : [c]} />}
        </div>
      </div>
      <div class="conv-head-actions">
        <HeadOrb />
        <JoinCallButton c={c} />
        {/* A DM's profile is its picture and name, and the details panel's Profile. */}
        {!isDirect && (
          <button class="hdr-btn phone-hide" data-track="about" title="About and settings" aria-label="About and settings" onClick={() => openAbout('conversation', c.id)}>
            <Icon name="info" size={16} />
          </button>
        )}
        <button class="hdr-btn" data-track="search here" title={all ? 'Search in every chat with them' : 'Search in this conversation'} aria-label={all ? 'Search in every chat with them' : 'Search in this conversation'} onClick={() => go({ view: 'search', q: `in:${all ? chat!.person.id : c.id}` })}>
          <Icon name="search" size={16} />
        </button>
        <LevelMenu c={c} also={all ? chat!.directs.filter((d) => d.id !== c.id) : undefined} />
        <button class={`hdr-btn phone-hide ${detailsShown() ? 'on' : ''}`} data-track="details" onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
          <Icon name="panel" size={16} />
        </button>
        <HeadMore c={c} also={all ? chat!.directs.filter((d) => d.id !== c.id) : undefined} profile={person && isDirect ? person.id : undefined} />
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
  // The words the last edit put in are underlined, and open the edits (docs/history.md "A message's history"). A
  // forward shows the forwarded text, which the edit was not to.
  const prev = m.edits && m.prevBody != null && !m.forward ? m.prevBody : null;
  const html = useMemo(() => {
    const ctx = { ...useMdContext(m.network), role: (id: string) => roles?.find((r) => r.id === id) ?? null };
    const now = renderMarkdown(m.body, ctx);
    return prev != null ? markChanged(now, renderMarkdown(prev, ctx)) : now;
  }, [m.body, prev, m.network, /<[@#]/.test(m.body) ? metaRev.value : 0, roles, relative ? rev.value : 0]);
  if (m.deleted) return <div class="msg-body deleted">{m.gone?.how === 'disappeared' ? 'Message disappeared' : 'Message deleted'}</div>;
  if (m.kind === 'encrypted')
    return (
      <div class="msg-body encrypted">
        <Icon name="lock" size={13} /> Encrypted message, no key for it here. It decrypts by itself when one arrives, once encryption is set up on the account's page.
      </div>
    );
  if (!m.body) return null;
  const click = (e: MouseEvent) => {
    // A changed word's mark sits inside whatever it marks (a mention, a link): that is what the click is on.
    const hit = e.target as HTMLElement;
    const changed = hit.classList?.contains('msg-changed') ? hit : null;
    const el = changed?.parentElement ?? hit;
    if (changed && !el.closest?.('a[href], [data-user], [data-person], [data-identity], .spoiler:not(.shown)') && !getSelection()?.toString())
      openHistory(m, 'edits', changed.getBoundingClientRect());
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

/**
 * A deleted or disappeared message the hub kept (docs/history.md): shown in full, as it was, with a quiet mark of
 * how and when it went.
 */
function Gone({ m, layout }: { m: P.MessageView; layout: PictureLayout }) {
  // Its "5m ago" moves on with the list, as it did when every change drew every message.
  rev.value;
  const how = m.gone!.how === 'disappeared' ? 'Disappeared' : 'Deleted';
  const shown = { ...m, deleted: false };
  return (
    <div class="msg-gone open">
      <Body m={shown} />
      <Attachments m={shown} layout={layout} />
      <span class="msg-gone-mark" title={`${how} ${fullTime(m.gone!.at)}`}>
        <Icon name={m.gone!.how === 'disappeared' ? 'clock' : 'trash'} size={11} />
        {how} <span class="msg-gone-when">· {ago(m.gone!.at)}</span>
      </span>
    </div>
  );
}

/** "(edited)": with earlier versions kept, a click opens the message's history on its edits. */
function Edited({ m }: { m: P.MessageView }) {
  if (!m.edits)
    return (
      <span class="msg-edited" title={m.editedTs ? `Edited ${fullTime(m.editedTs)}` : undefined}>
        (edited)
      </span>
    );
  return (
    <button class="msg-edited link" onClick={(e) => openHistory(m, 'edits', (e.currentTarget as HTMLElement).getBoundingClientRect())} title="See earlier versions">
      (edited)
    </button>
  );
}

/** "(moved)": moved here from another topic (Zulip), when it says in its tooltip. */
function Moved({ m }: { m: P.MessageView }) {
  return (
    <span class="msg-edited msg-moved" title={`Moved here ${fullTime(m.movedAt!)}`}>
      (moved)
    </span>
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

/**
 * A message's files. Its pictures are drawn as one block the way the chat says (ui/Pictures.tsx): with the pictures
 * of the run it ends (`run`, docs/pictures.md), or not at all when a later message of its run draws them (`absorbed`).
 */
function Attachments({ m, run, absorbed, layout, switchable }: { m: P.MessageView; run?: P.MessageView[]; absorbed?: boolean; layout: PictureLayout; switchable?: boolean }) {
  if (!m.attachments.length) return null;
  // A file the network called just a file whose bytes are a picture, a video or a sound shows as one (files.ts).
  const media = (a: P.AttachmentView) => (a.kind === 'file' && a.info && /^(image|video|audio)$/.test(a.info.kind) ? (a.info.kind as P.AttachmentKind) : a.kind);
  const pics = absorbed ? [] : (run ?? [m]).flatMap(picturesOf);
  const rest = m.attachments.map((a, i) => [a, i] as const).filter(([a]) => !isPicture(m, a));
  if (!pics.length && !rest.length) return null;
  return (
    <div class="atts">
      {pics.length > 0 && <Pictures pics={pics} layout={layout} runKey={(run ?? [m])[0].id} anchors={run?.slice(0, -1).filter(onlyPictures).map((x) => x.id)} convId={switchable ? m.conversationId : undefined} rail={!touchOnly.value} />}
      {rest.map(([a, i]) => {
        const kind = media(a);
        if (isSticker(m, a)) return <Sticker a={a} index={i} />;
        if (kind === 'video') {
          // A GIF the network sent as a video loops silently, as a GIF, with no player (docs/media-kinds.md "GIFs").
          const video =
            a.gif && plainGifs() ? (
              <video class="att-video att-gif" data-att={i} src={a.url} autoplay loop muted playsInline preload="auto" aria-label={a.alt ?? 'GIF'} style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined} />
            ) : (
              <video class="att-video" data-att={i} src={a.url} controls preload="metadata" onPlay={() => played(m)} />
            );
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

/** A Discord GIF drawn as just the GIF: a looping silent video (a picture in the demo world). */
function PlainGif({ e }: { e: P.EmbedView }) {
  const v = e.video!;
  const ratio = v.width && v.height ? `${v.width} / ${v.height}` : undefined;
  const label = e.title ?? 'GIF';
  return v.url.startsWith('data:image/') ? (
    <img class="plain-gif" src={v.url} alt={label} style={ratio ? { aspectRatio: ratio } : undefined} />
  ) : (
    <video class="plain-gif" src={v.url} autoplay loop muted playsInline preload="auto" aria-label={label} style={ratio ? { aspectRatio: ratio } : undefined} />
  );
}

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
 * not say, after the time, which `onTag` sends through. Pictures (docs/pictures.md): `pictures`, how this chat
 * draws them; `run`, the messages whose pictures this one draws after its own, when it ends a run of them; `absorbed`,
 * a message of a run whose pictures the run's last message draws.
 */
const MessageItem = memo(function MessageItem({ m, grouped, onReply, onQuote, highlight, target, thread, who, whoIdent, net, tag, onTag, pictures, run, absorbed, chipRun }: { m: P.MessageView; grouped: boolean; onReply: (m: P.MessageView) => void; onQuote: (id: string) => void; highlight: boolean; target: P.MessageView | null; thread: P.ConversationView | null; who?: string; whoIdent?: string; net?: boolean; tag?: boolean; onTag?: (convId: string) => void; pictures: PictureLayout; run?: P.MessageView[]; absorbed?: boolean; chipRun?: P.MessageView[] }) {
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
      // A picture of the run this message draws is its own message's (ui/Pictures.tsx data-msg).
      const owner = (att.dataset.msg && run?.find((x) => x.id === att.dataset.msg)) || m;
      const a = owner.attachments[Number(att.dataset.att)];
      const pics = (run ?? [m]).flatMap(picturesOf).map(({ a: x }) => ({ url: x.url, name: x.name, width: x.width, height: x.height }));
      if (a) return attachmentMenu(a, owner, pics, owner === m ? reply : () => onReply(owner));
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

  // On a touch screen, the chip that switches a run of two or more pictures: on the run's first row (`chipRun`), or on
  // a message with several pictures of its own.
  const chipOn = chipRun ?? (!run && !absorbed && m.attachments.length > 1 ? [m] : undefined);
  const chip = !hover && !!chipOn && !m.deleted && !m.forward && chipOn.reduce((k, x) => k + picturesOf(x).length, 0) > 1;
  // Your message's ticks, after its text.
  const ticks = m.receipts && isSelfIdentity(m.authorId) ? <Ticks m={m} /> : null;
  // A Discord GIF: just the GIF, with no link or card (docs/media-kinds.md "GIFs").
  const gif = !m.deleted && !m.forward && !m.poll ? gifLinkOf(m) : null;
  return (
    <div
      class={`msg ${grouped ? 'grouped' : target || m.quote ? '' : 'head'} ${m.mentionsSelf ? 'mentioned' : ''} ${highlight ? 'flash' : ''}`}
      id={`m-${m.id}`}
      ref={(el) => void (el && swipeReply.set(el, () => onReply(m)))}
      {...menuProps}
    >
      {target && <ReplyQuote m={m} target={target} onQuote={onQuote} />}
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
      <div class={chip ? 'msg-main has-pchip' : 'msg-main'}>
        {/* A phone's switch for a run of pictures: top right, the words wrap round it (ui/PictureSwitch.tsx). */}
        {chip && <PictureChip runKey={chipOn![0].id} convId={m.conversationId} layout={pictures} />}
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
            {/* A text from a Signal backup (SMS or MMS) heads its own run, so the mark covers each of them. */}
            {m.sms && (
              <span class="msg-sms" title={`Sent as ${m.sms.toUpperCase()}, not over ${netName(m.network)}`}>
                {m.sms.toUpperCase()}
              </span>
            )}
            <span class="msg-time" title={hover ? fullTime(m.ts) : undefined}>
              {clock(m.ts)}
            </span>
            {/* A person's chat (ui/Pairs.tsx): where the route changes, which one, quietly. A click sends through it. */}
            {conv && chatPerson && onTag && <RouteTag c={conv} directs={directsOf(chatPerson.id)} side={self ? 'mine' : who !== undefined ? 'theirs' : 'other'} onPick={() => onTag(conv.id)} />}
            {(m.editedTs || m.edits) && <Edited m={m} />}
            {m.movedAt && <Moved m={m} />}
            <DisappearsMark m={m} self={self} />
            <Marks m={m} />
            {m.encryptionWarning && (
              <span class="msg-e2ee-warning" title={m.encryptionWarning} aria-label={m.encryptionWarning}>
                <Icon name="alert" size={12} />
              </span>
            )}
          </div>
        )}
        {m.deleted && m.gone?.kept ? (
          <Gone m={m} layout={pictures} />
        ) : m.forward && !m.deleted ? (
          <ForwardCard m={m}>
            <RichHead m={m} />
            <Body m={m.forward.text !== undefined ? { ...m, body: m.forward.text } : m} tail={ticks} />
            <Attachments m={m} layout={pictures} />
            <Embeds m={m} />
            <InviteCards m={m} body={m.forward.text ?? m.body} />
            <RichFoot m={m} />
          </ForwardCard>
        ) : (
          <>
            <RichHead m={m} />
            <StoryReplyLine m={m} />
            {m.poll ? <PollCardLazy m={m} fallback={<Body m={m} />} /> : gif ? null : <Body m={m.contacts ? withoutCardLines(m) : m} tail={ticks} />}
            <Attachments m={m} run={run} absorbed={absorbed} layout={pictures} switchable />
            <MissingFiles m={m} />
            <ContactCards m={m} />
            {gif ? <PlainGif e={gif} /> : <Embeds m={m} />}
            <InviteCards m={m} body={m.body} />
            <RichFoot m={m} />
          </>
        )}
        <SendFailures m={m} />
        {ticks && (!m.body || gif || m.deleted || (m.poll && !m.forward)) && <span class="msg-marks">{ticks}</span>}
        {grouped && (m.editedTs || m.edits) && <Edited m={m} />}
        {grouped && m.movedAt && <Moved m={m} />}
        {grouped && <DisappearsMark m={m} self={self} />}
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
const WINDOW = 150;
/** How many more are drawn each time the view nears an end of what is drawn. */
const STEP = 100;

/**
 * How far from the newest end (px) the view still follows it: a new message, or one growing (a picture loading),
 * keeps it on screen. Further up, what you are reading stays still.
 */
const FOLLOW = 32;

/**
 * Brings a message to the middle of the view, as Discord does: one more than a screen and a half away is jumped to most
 * of the way at once, and the rest glides, so a far one takes no longer than a near one. `then` runs once it is there.
 */
function bringToCenter(scroller: HTMLElement | null, el: HTMLElement, then: () => void) {
  if (!scroller || reducedMotion()) {
    el.scrollIntoView({ block: 'center' });
    return then();
  }
  const box = scroller.getBoundingClientRect();
  /** How far the message's middle is below the view's (above: negative). */
  const offset = () => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2 - (box.top + box.height / 2);
  };
  /** In the middle, or as near it as the view goes (column-reverse: scrollTop 0 at the newest end). */
  const there = () => {
    const o = offset();
    const top = Math.abs(scroller.scrollTop);
    return Math.abs(o) < 2 || (o > 0 && top < 1) || (o < 0 && top > scroller.scrollHeight - scroller.clientHeight - 1);
  };
  if (there()) return then();
  const off = offset();
  if (Math.abs(off) > box.height * 1.5) scroller.scrollTop += off - Math.sign(off) * box.height * 0.75;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    scroller.removeEventListener('scrollend', onEnd);
    then();
  };
  // The jump most of the way ends a scroll of its own before the glide: only the one that ends there counts.
  const onEnd = () => there() && finish();
  scroller.addEventListener('scrollend', onEnd);
  setTimeout(finish, 1200);
}

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
  // A message gone to (a link, a quote) is lit up for a moment; lit again from the start if gone to again.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashIt = (id: string) => {
    clearTimeout(flashTimer.current);
    setFlash(null);
    requestAnimationFrame(() => setFlash(id));
    flashTimer.current = setTimeout(() => setFlash((f) => (f === id ? null : f)), 2500);
  };
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  /** Whether the view follows the newest message (FOLLOW): it is drawn, and the view is at it. */
  const following = useRef(true);
  /** A jump to a message under way (goTo): its glide away from the newest end does not follow it back. */
  const jumping = useRef(false);
  const goTo = (el: HTMLElement, id: string) => {
    following.current = false;
    jumping.current = true;
    bringToCenter(scroller.current, el, () => {
      jumping.current = false;
      flashIt(id);
    });
  };
  /** The content's height when last looked at (onScroll, and the ResizeObserver below). */
  const heightSeen = useRef(0);
  /** A quoted message on its way to the screen (onQuote below). */
  const revealing = useRef<string | null>(null);
  useEffect(() => {
    revealing.current = null;
    following.current = !focus;
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
    following.current = false;
    el.scrollIntoView({ block: 'center' });
    flashIt(focus);
  });

  const msgs = t?.messages ?? [];
  const off = offline.value;
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
  // And a quoted message that has just come in (onQuote below), likewise.
  const shown = revealing.current;
  const si = shown ? at.get(shown) : undefined;
  if (si !== undefined) {
    const b = bounds();
    if (si < b.start || si >= b.end) {
      const [from, to] = around(si);
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
    // A scroll that comes with the content's height changed, while following, is the browser's anchoring and not you:
    // when a layout is forced before the ResizeObserver's turn (a measure in an effect), its scroll event comes first.
    const grew = el.scrollHeight !== heightSeen.current;
    heightSeen.current = el.scrollHeight;
    if (following.current && grew && el.scrollTop !== 0) el.scrollTop = 0;
    else following.current = !jumping.current && Math.abs(el.scrollTop) < FOLLOW && drawn.current.to === null && !t?.detached;
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
      } else if (!off) {
        // (Without the hub a page cannot come: it is asked for once the hub is back, as this runs after every draw.)
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

  // A reply's quote shows the message it quotes: drawn first if it is held but not drawn. One further back than the
  // timeline holds is fetched with the page around it, in place, as a link to a message is (jumpTo, jumpInChat); one
  // in another chat, or too far back in a person's chat, opens its own chat at it.
  const quote = useRef((_: string) => {});
  quote.current = (id: string) => {
    const el = document.getElementById(`m-${id}`);
    following.current = false;
    const i = at.get(id);
    // Near the top of what is drawn there is nothing above it to centre it among: what is around it is drawn first.
    const edge = i !== undefined && i - start < 20 && (start > 0 || more);
    if (el && !edge) return goTo(el, id);
    revealing.current = id;
    if (i !== undefined) return draw(...around(i));
    const q = quoted.get(id);
    const away = () => {
      if (revealing.current === id) revealing.current = null;
      if (q) openMessage(q.conversationId, id);
    };
    if (tkey.startsWith('p:')) void jumpInChat(tkey, id).then((found) => !found && away());
    else if (q?.conversationId === convIds[0]) void jumpTo(convIds[0], id);
    else away();
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
    goTo(el, id);
  });

  // The browser holds what is in view still while the content changes (scroll anchoring), unless the view is right at
  // the newest end: a pixel above it, a new message came in below the view and stayed out of sight. So while the view
  // follows the newest (FOLLOW), it is put back at the end whenever the content grows or shrinks, before it is painted.
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const box = inner.current;
    if (!el || !box || typeof ResizeObserver !== 'function') return;
    const stick = () => {
      heightSeen.current = el.scrollHeight;
      if (following.current && el.scrollTop !== 0) el.scrollTop = 0;
    };
    const ro = new ResizeObserver(stick);
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tkey]);
  // A message of your own just sent goes to the newest end, from wherever the view was (Discord does the same).
  const sent = useRef(0);
  useLayoutEffect(() => {
    const n = mine.length;
    const grew = n > sent.current;
    sent.current = n;
    const el = scroller.current;
    if (!grew || !el || end !== all.length) return;
    following.current = true;
    el.scrollTop = 0;
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
  const groups = (prev: P.MessageView | null, m: P.MessageView) =>
    !!prev && prev.authorId === m.authorId && prev.conversationId === m.conversationId && m.ts - prev.ts < 7 * 60_000 && sameDay(prev.ts, m.ts) && prev.kind !== 'system' && !m.replyToId && prev.sms === m.sms;
  // One person's pictures one after another are one run, drawn by its last message (docs/pictures.md); a message of
  // it that is nothing but pictures has no row of its own. How each chat draws them, once per chat.
  const runs = pictureRuns(all, start, end, (p, m, i) => groups(p, m) && i !== unreadFrom);
  const layouts = new Map<string, PictureLayout>();
  const layoutOf = (cid: string) => layouts.get(cid) ?? layouts.set(cid, pictureLayout(cid)).get(cid)!;
  // A phone's switch for a run sits on its first row, with that row's words (ui/PictureSwitch.tsx).
  const chipped = new Set<P.MessageView[]>();
  // The row above, for grouping: a left-out row isn't one.
  let above: P.MessageView | null = null;
  for (let i = start; i < end; i++) {
    const m = all[i];
    if (!prev || !sameDay(prev.ts, m.ts)) items.push(<div class="day-sep"><span>{dayLabel(m.ts)}</span></div>);
    if (i === unreadFrom) items.push(<div class="new-sep"><span>New</span></div>);
    // A push's copy, before the hub has answered (arrived.ts): what came before it may not be here yet.
    if (isArrivedCopy(m) && !(prev && isArrivedCopy(prev)))
      items.push(
        <div class="day-sep arrived-sep" role="note">
          <span>From notifications · earlier messages may be missing until the hub is back</span>
        </div>,
      );
    const run = runs.get(m.id);
    const ends = !!run && run[run.length - 1] === m;
    if (run && !ends && onlyPictures(m)) {
      prev = m;
      continue;
    }
    const grouped = groups(above, m);
    const target = m.replyToId ? (byId.get(m.replyToId) ?? quoted.get(m.replyToId) ?? null) : null;
    const thread = m.threadId ? (db.conversations.get(m.threadId) ?? null) : null;
    // All chats together: where the route changes, grouping breaks (above) and the head line says which route.
    const tag = !!chat && convIds.length > 1 && !grouped && (!prev || prev.conversationId !== m.conversationId);
    const head = heads && m.authorId ? heads.get(m.authorId) : undefined;
    items.push(
      <MessageItem
        key={m.id}
        m={m}
        grouped={grouped}
        onReply={onReply}
        onQuote={onQuote}
        highlight={m.id === flash}
        target={target}
        thread={thread}
        who={head?.name}
        whoIdent={head?.ident}
        net={!!chat?.badge}
        tag={tag}
        onTag={chat ? onTag : undefined}
        pictures={layoutOf(m.conversationId)}
        run={ends ? run : undefined}
        absorbed={!!run && !ends}
        chipRun={run && !chipped.has(run) ? (chipped.add(run), run) : undefined}
      />,
    );
    prev = above = m;
  }

  return (
    <div class="timeline-scroll" ref={scroller} onScroll={onScroll}>
      <div class="timeline-inner" ref={inner}>
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
        {/* Out of reach, what is not on the device waits for the hub, said rather than spun (Offline.tsx); its
            coming back draws this again, and the scroll check after it loads them. */}
        {off && msgs.length > 0 && (t?.loading || (t?.hasMore && start === 0)) ? (
          <div class="older-wait">Older messages load when the hub is back</div>
        ) : off && t?.loading ? (
          <div class="older-wait">Messages load when the hub is back</div>
        ) : (
          t?.loading && (msgs.length ? <Loading inline label="Loading older messages" /> : <Loading label="Loading messages…" />)
        )}
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

// The phone's + panel is a chunk of its own, loaded at the first press of + (ui/panel/Panel.tsx).
type Panels = typeof import('./panel/Panel.tsx');
let panels: Panels | null = null;
let loadingPanels: Promise<Panels> | null = null;
const loadPanels = () =>
  (loadingPanels ??= import('./panel/Panel.tsx').then(
    (m) => (panels = m),
    (e) => {
      loadingPanels = null;
      throw e;
    },
  ));

function Composer({ targets, placeholder, reply, clearReply, disabledReason, routed }: {
  targets: { convId: string; accountId?: string };
  placeholder: string;
  /** A person page: the line over the box says where the message goes (ui/Pairs.tsx), so the placeholder is just "Message". */
  routed?: boolean;
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
  // A phone's attaching: the + panel in the keyboard's place (ui/panel/), the camera and the send screen
  // (ui/Attach.tsx), and the system pickers' inputs.
  const onPhone = phone.value;
  const photos = useRef<HTMLInputElement>(null);
  const capture = useRef<HTMLInputElement>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('photos');
  const [panelMod, setPanelMod] = useState(panels);
  const panelUp = onPhone && !!panelMod && (panelOpen.value || panelShown.value > 0);
  const [camera, setCamera] = useState(false);
  const [review, setReview] = useState(false);
  // The emoji button's picker, beside what opened it (Reactions.tsx).
  const [emojiAt, setEmojiAt] = useState<DOMRect | null>(null);
  // Stickers, recording and view-once, where the sending account has them (ComposerMedia.tsx).
  const offer = mediaOffer(sender, canAttach);
  const [viewOnce, setViewOnce] = useState(false);
  const addFiles = async (list: File[]) => {
    if (!list.length || !conv) return [];
    if (!canAttach) return (toast({ kind: 'error', title: 'Cannot send files here', body: conv.encrypted ? 'Set up encryption on the account\'s page to send files in encrypted Matrix rooms.' : `${netName(conv.network)} is not set up to send files.` }), []);
    return att.add(list);
  };
  /** Photos and videos, picked or taken on a phone, go to the send screen; other files to the row. */
  const addMedia = async (list: File[]) => {
    await addFiles(list);
    if (onPhone && canAttach && opensSendScreen(list)) setReview(true);
  };
  useEffect(() => {
    closePanel(true);
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
    // What the panel picked went: it goes too, as Telegram's does.
    if (files.length) closePanel();
  };
  /** A sticker or a recording goes at once, on its own, as a reply when one is open. */
  const sendMedia = (opts: { files?: File[]; media?: { sticker?: string; voice?: P.VoiceOut; gif?: boolean } }) => {
    send(targets.convId, '', { accountId: targets.accountId, replyTo: reply?.id, ...opts });
    clearReply();
  };
  /** A GIF goes at once too: its link on Discord, its file elsewhere (ComposerMedia.tsx gifSend). */
  const sendGif = async (g: GifPick) => {
    if (!conv) return;
    try {
      const r = await gifSend(g, conv.network);
      if ('body' in r) {
        send(targets.convId, r.body, { accountId: targets.accountId, replyTo: reply?.id });
        clearReply();
      } else sendMedia({ files: [r.file], media: { gif: r.gif } });
    } catch (e) {
      toast({ kind: 'error', title: 'The GIF did not go', body: (e as Error).message });
    }
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
  // Mentions in the box are chips; the box holds their names, the body their tokens (ChipBox.tsx, docs/mentions.md).
  const chips = useChipBox(ta, text, onText, conv?.network);
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
  const [gifAt, setGifAt] = useState<DOMRect | null>(null);
  useEffect(() => setGifAt(null), [targets.convId]);
  const plusRef = useRef<HTMLButtonElement>(null);
  const canSticker = !!conv && !disabledReason && !edit && offer.stickers;
  // GIFs (docs/media-kinds.md "GIFs"): a link on Discord, a file anywhere files go.
  const canGif = !!conv && !disabledReason && !edit && (conv.network === 'discord' || attaching);
  type PlusItem = { track: string; icon: string; label: string; note?: string; run: () => void; hover?: () => void };
  const plusItems: PlusItem[] = onPhone
    ? []
    : ([
        attaching && { track: 'attach', icon: 'paperclip', label: 'Upload a file', note: limit.replace('up to ', ''), run: () => picker.current?.click() },
        pollAccount && { track: 'poll', icon: 'list', label: 'Poll', run: () => setPolling(true) },
        canSticker && { track: 'stickers', icon: 'sticker', label: 'Sticker', run: () => plusRef.current && setStickerAt(plusRef.current.getBoundingClientRect()), hover: preloadStickers },
        canGif && { track: 'gifs', icon: 'gif', label: 'GIF', run: () => plusRef.current && setGifAt(plusRef.current.getBoundingClientRect()), hover: preloadStickers },
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
          <button ref={plusRef} class="icon-btn composer-plus-menu" data-track="plus" onClick={toggle} title="Files, polls, stickers and GIFs" aria-label="More to send">
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
  // The box re-renders as each emoji goes in and, unfocused, loses its caret: the panel keeps it here.
  const caret = useRef<number | null>(null);
  const insertFromPanel = (t: string) => {
    const el = ta.current;
    if (!el) return;
    const at = Math.min(caret.current ?? el.value.length, el.value.length);
    el.setSelectionRange(at, at);
    insertAtCaret(el, t, false);
    caret.current = at + t.length;
  };
  // + opens the panel in the keyboard's place on the last of its tabs (Photos first, or Stickers or Poll where files
  // can't go); the box's emoji button opens it on Emoji. The button whose tab is showing becomes the keyboard's.
  const lastPlusTab = useRef<PanelTab>('photos');
  if (panelTab !== 'emoji') lastPlusTab.current = panelTab;
  const plusTab: PanelTab = attaching ? lastPlusTab.current : lastPlusTab.current === 'stickers' || lastPlusTab.current === 'gifs' || lastPlusTab.current === 'poll' ? lastPlusTab.current : canSticker ? 'stickers' : canGif ? 'gifs' : pollAccount ? 'poll' : 'emoji';
  const onEmojiTab = panelOpen.value && panelTab === 'emoji';
  const onPlusTab = panelOpen.value && !onEmojiTab;
  const togglePanel = (at: PanelTab) => {
    if (panelOpen.value && at === panelTab) return ta.current?.focus();
    setPanelTab(at);
    if (panelOpen.value) return;
    void loadPanels().then((m) => {
      setPanelMod(m);
      openPanel();
    });
  };
  const openCamera = () => {
    // No camera API at all: the system's camera, from this tap.
    if (!navigator.mediaDevices?.getUserMedia) return capture.current?.click();
    setCamera(true);
  };
  const field = (
    <textarea
      ref={ta}
      data-track="text box"
      rows={1}
      value={chips.shown}
      placeholder={disabledReason ?? (routed ? 'Message' : placeholder)}
      disabled={!!disabledReason}
      onInput={chips.onInput}
      onBlur={(e) => {
        // Where the caret was: the panel's emoji go there while the box is not focused.
        caret.current = (e.currentTarget as HTMLTextAreaElement).selectionEnd;
        composerDone();
      }}
      onPaste={(e) => {
        const pasted = [...(e.clipboardData?.files ?? [])];
        if (!pasted.length) return void chips.onPaste(e);
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
        } else if (e.key === 'Escape' && (edit || reply)) {
          e.preventDefault();
          countKey(`composer: cancel ${edit ? 'edit' : 'reply'} (Esc)`);
          if (edit) cancelEdit();
          else clearReply();
        }
      }}
    />
  );
  // The chips' layer goes first: drawn behind the box's text (ChipLayer.ts).
  const box = (
    <>
      {chips.layer}
      {field}
    </>
  );
  const emojiBtn = conv && !disabledReason && (
    <button
      class="icon-btn composer-emoji"
      data-track="emoji"
      title="Emoji"
      aria-label={onEmojiTab ? 'Back to the keyboard' : 'Emoji'}
      aria-expanded={!!emojiAt}
      // The catalog loads while the pointer is on its way, so the picker opens whole.
      onPointerEnter={() => void loadEmoji()}
      // On a phone the panel's Emoji tab, in the keyboard's place; it keeps the box focused until then.
      onPointerDown={(e) => onPhone && e.preventDefault()}
      onClick={(e) => (onPhone ? togglePanel('emoji') : setEmojiAt(emojiAt ? null : (e.currentTarget as HTMLElement).getBoundingClientRect()))}
    >
      <Icon name={onEmojiTab ? 'keyboard' : 'smile'} size={onPhone ? 20 : 18} />
    </button>
  );
  const recording = attaching && offer.record && !text.trim() && !files.length;
  // The chat's disappearing timer is on: a stopwatch on whatever sits in send's place (Disappearing.tsx).
  const sendBtn = recording ? (
      <VoiceButton conversationId={targets.convId} onPhone={onPhone} voice={offer.voice} onSend={(f, voice) => sendMedia({ files: [f], ...(voice ? { media: { voice } } : {}) })} />
  ) : (
    <button class={"send-btn"} data-track="send" disabled={!canSend} onClick={submit} aria-label="Send" title={`${sendTitle ?? 'Send'}${extras.timer ? `, disappears after ${durationLabel(extras.timer).toLowerCase()}` : ''}`}>
      <Icon name="send" size={17} />
    </button>
  );
  // On a phone, holding send opens the send menu (Send silently, Send later…); a right-click does with a mouse.
  const sendMenuOpen = useRef<(() => void) | null>(null);
  const sendHold = useLongPress(() => sendMenuOpen.current?.());
  const phoneSend = (toggle: () => void) => {
    sendMenuOpen.current = toggle;
    return (
      <button
        class={`send-btn ${extras.silent ? 'silent' : ''}`}
        data-track="send"
        disabled={!canSend}
        onClick={submit}
        {...sendHold}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!matchMedia('(pointer: coarse)').matches) toggle();
        }}
        aria-label="Send"
        aria-haspopup="menu"
        title={`${sendTitle ?? 'Send'}${extras.silent ? ', silently' : ''}${extras.timer ? `, disappears after ${durationLabel(extras.timer).toLowerCase()}` : ''} (hold for more ways to send)`}
      >
        <Icon name="send" size={17} />
        {extras.silent && <Icon name="bellOff" size={10} class="send-badge" />}
        </button>
    );
  };
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
      {!edit && <RequestSentNote c={conv} />}
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
      <AttachedFiles files={att.files} remove={att.remove} network={conv?.network} />
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
          {!!conv && !disabledReason && (
            <button
              ref={plusRef}
              class={`icon-btn composer-plus ${onPlusTab ? 'on' : ''}`}
              data-track={onPlusTab ? 'keyboard' : 'plus'}
              // Keeps the box focused, so the panel takes the keyboard's room before the keyboard goes.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => togglePanel(onPlusTab ? panelTab : plusTab)}
              aria-label={onPlusTab ? 'Back to the keyboard' : 'Photos, files, stickers, GIFs and polls'}
            >
              <Icon name={onPlusTab ? 'keyboard' : 'plus'} size={22} />
            </button>
          )}
          <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
            {box}
            {emojiBtn}
            {/* Once you type, the text has the camera's width (as in Signal and WhatsApp): the box takes a second line
                only when the words need one. The panel's camera tile is still there. */}
            {attaching && !text && (
              <button class="icon-btn composer-camera" data-track="camera" onClick={openCamera} aria-label="Take a photo or video">
                <Icon name="camera" size={20} />
              </button>
            )}
          </div>
          {/* A phone has no room for the send menu's arrow: holding the send button opens it. */}
          {extras.menu && !recording ? extras.menu(phoneSend) : sendBtn}
        </div>
      ) : (
        <div class={`composer-box ${disabledReason ? 'disabled' : ''}`}>
          {plus}
          {box}
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
      {gifAt && canGif && <GifPicker conversationId={targets.convId} anchor={gifAt} onSend={(g) => void sendGif(g)} onClose={() => setGifAt(null)} />}
      {emojiAt && conv && (
        <InsertPicker
          conversationId={targets.convId}
          network={conv.network}
          anchor={emojiAt}
          onInsert={(t) => ta.current && insertAtCaret(ta.current, t, !onPhone)}
          onClose={() => setEmojiAt(null)}
        />
      )}
      {panelUp && conv && (
        <panelMod.Panel
          tab={panelTab}
          setTab={setPanelTab}
          ctx={{
            convId: targets.convId,
            network: conv.network,
            limit,
            attached: att.files,
            add: addFiles,
            remove: att.remove,
            canAttach: attaching,
            openCamera,
            pickPhotos: () => photos.current?.click(),
            pickFiles: () => picker.current?.click(),
            openLarge: () => setReview(true),
            ...(offer.viewOnce ? { viewOnce: { on: viewOnce, set: setViewOnce } } : {}),
            ...(canSticker ? { stickers: () => <StickerPicker inline conversationId={targets.convId} accountId={targets.accountId ?? sender?.id} onSend={(st) => sendMedia({ media: { sticker: st.id } })} onClose={() => closePanel()} /> } : {}),
            ...(canGif ? { gifs: () => <GifPicker inline conversationId={targets.convId} onSend={(g) => void sendGif(g)} onClose={() => closePanel()} /> } : {}),
            emoji: () => <InsertPicker inline conversationId={targets.convId} network={conv.network} anchor={null} onInsert={insertFromPanel} onClose={() => closePanel()} />,
            ...(pollAccount
              ? { poll: () => <PollMakerLazy conversationId={targets.convId} network={conv.network} accountId={pollAccount.id} question={text.trim()} focus={false} onClose={() => closePanel()} onSent={() => type('')} /> }
              : {}),
          }}
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
          network={conv?.network}
        />
      )}
    </div>
  );
}

const touchKeyboard = () => matchMedia('(pointer: coarse)').matches;

/** Why the composer cannot send here, or null. */
function composerBlocker(c: P.ConversationView, accountId?: string): string | null {
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
  // A post you follow (docs/feed.md "Following a post"): its thread, what came since it was read marked new.
  if (c.variant === 'follow') return <FollowChatLazy c={c} onBack={onBack} />;
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && visibleAccount(a.id));
  const sendAsValue = pref('sendAs')[c.id] ?? accounts.find((a) => a.status === 'online')?.id ?? accounts[0]?.id;
  const voice = c.variant === 'voice' || c.variant === 'stage';
  const held = heldRequest(db.requests, c.id);
  // A stage you are in is a room (docs/calls.md "The room view"): beside the chat on a wide pane, a Room / Chat switch
  // on a narrow one (a container query on .room-pane), only the room where there is no chat.
  const room = roomCall(c);
  const chat = !room || roomHasChat(c);
  const body = chat && (
    <>
      {!held && c.pending && <LinkBanner c={c} />}
      {/* A forum's or media channel's messages are its posts (ui/Threads.tsx, docs/threads.md). */}
      {c.variant === 'forum' || c.variant === 'media' ? (
        <ForumLazy key={c.id} c={c} />
      ) : (
        <>
          {voice && !room && <div class="voice-note"><Icon name="voice" size={14} /> Voice isn't relayed. This shows the channel's text chat.</div>}
          {voice && <VoicePeople conversationId={c.id} size={22} names class="voice-here" />}
          <NotStartedNote c={c} />
          <Timeline tkey={timelineKey('c', c.id)} convIds={[c.id]} onReply={setReply} firstUnreadTs={unreadAt} focus={focus} />
        </>
      )}
      <TypingBar
        convIds={[c.id]}
        lead={
          !held &&
          (accounts.length > 1 ? (
            <>
              <SendAsLead c={c} accounts={accounts} value={sendAsValue!} onPick={(v) => setPrefs({ sendAs: { ...pref('sendAs'), [c.id]: v } })} />
              <TimerLabel conv={c} accountId={sendAsValue} />
            </>
          ) : (
            <TimerLabel conv={c} accountId={sendAsValue} alone />
          ))
        }
      />
      {held ? (
        <RequestBar r={held} />
      ) : c.variant === 'forum' || c.variant === 'media' ? null : (
        <Composer
          targets={{ convId: c.id, accountId: sendAsValue }}
          placeholder={`Message ${c.shape === 'direct' ? convTitle(c) : convLabel(c)}`}
          reply={reply}
          clearReply={() => setReply(null)}
          disabledReason={composerBlocker(c, sendAsValue)}
        />
      )}
    </>
  );
  if (room)
    return (
      <section class="pane room-pane">
        <ConvHeader c={c} onBack={onBack} />
        <RoomSwitch c={c} />
        <div class={`room-split ${chat ? '' : 'alone'}`} data-show={roomSide(c)}>
          <div class="room-col">
            <CallRoomLazy c={c} />
          </div>
          {chat && <div class="room-chat">{body}</div>}
        </div>
      </section>
    );
  // The call's own chat: the call window's slot under the header (docked, or the whole page for Fill).
  return (
    <section class="pane">
      <ConvHeader c={c} onBack={onBack} />
      <CallSlot c={c} />
      {!fillsPage(c) && body}
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
      {/* The route line shares the typing line's row, over the box (docs/chats.md "The message box"). */}
      <TypingBar convIds={shown.map((d) => d.id)} lead={!held && <PairLead person={person} directs={directs} focus={focus} onFocus={onFocus} />} />
      {held ? (
        <RequestBar r={held} />
      ) : (
        <Composer
          targets={{ convId: focus.id }}
          placeholder={`Message ${person.name}`}
          reply={reply}
          clearReply={() => setReply(null)}
          disabledReason={composerBlocker(focus)}
          routed
        />
      )}
    </section>
  );
}
