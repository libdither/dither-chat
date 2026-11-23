/**
 * What each thing's right-click menu (or long-press sheet) holds, in Discord's names and order where Discord has
 * the same action. The reasoning per surface is in docs/menus.md.
 */
import { isLottie } from './Sticker.tsx';
import type * as P from '@dither-chat/protocol';
import { followedPostOf, NETWORK_META, PICTURE_LAYOUTS, RULE_LABEL, RULE_LEVELS, showsInline } from '@dither-chat/protocol';
import { fullTime } from '../format.ts';
import { noteRowRead } from '../activity.ts';
import { AUTOMATIC, OLDER_RULE, authorName, convTitle, deepLink, directsOf, effectiveLevel, externalProfile, heldHere, netName, placePref, plainBody, ruleOn, spaceLink, sumUnread, unreadOf, zulipMessageLink, type Level } from '../model.ts';
import { inheritedPictures, PICTURE_LABELS, setPlacePictures } from '../arrange.ts';
import { deviceRule, myDevice, setDeviceRule } from '../devices.ts';
import { android } from '../android.ts';
import { alertToggle, isTier, lessToggle } from '../marks.ts';
import { phone } from '../phone.ts';
import { mark } from '../triage.ts';
import { desk, openLink } from '../desk.ts';
import { pickerFor, quickReactions, reactionScope, reactorsFor, replacing, toggleReaction } from '../reactions.ts';
import { clearReactions, moderatorDelete, moderatorRemoveEmbeds, modOf } from '../moderate.ts';
import { api, canDelete, canEdit, db, deleteMessage, go, href, isSelfIdentity, markAllRead, markRead, openProfile, rev, setRule, startEditing, toast } from '../state.ts';
import { messageSomeone, openPalette } from './Palette.tsx';
import { hasHistory, historyOf } from './MessageHistory.tsx';
import { MarkToggles, tierHeading, tierIcon } from './Marks.tsx';
import { Avatar } from './bits.tsx';
import { closeMenu, copy, groups, menuPoint, openMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';
import { DEVICE_LEVELS } from './DeviceRules.tsx';
import { forwarding } from './Forward.tsx';
import { appsFor, can } from '../apps.ts';
import { addLook } from './Reactions.tsx';
import { Icon } from './icons.tsx';
import { nicknameEntries } from './Nickname.tsx';
import { openAbout } from '../opening.ts';
import { canIndex, startIndexing } from './Indexing.tsx';
import { arrangeEntries, folderEntries, placeConvs } from './Organize.tsx';
import { openConv } from '../opening.ts';
import { viewer, type ViewerImage } from '../viewer.ts';
import { canMarkUnread, markUnreadFrom } from '../unread.ts';
import { openAttachment, openWith, save } from './fileopen.tsx';
import { fileKind, fileMime, openFileViewer, VIEWABLE } from '../files.ts';
import { inviteRef } from '../invites.ts';
import { installStickerLink, stickerInstaller } from './ComposerMedia.tsx';
import { canEndPoll, endPoll, pin, pinChoices, pinnable } from '../polls.ts';
import { threadConvEntries, threadMessageEntries } from '../threads.ts';
import { sendingEntries } from './sendingMenu.tsx';
import { accountEntries } from './accountMenu.tsx';

export { openAttachment };

const appLink = (r: Parameters<typeof href>[0]) => `${location.origin}${location.pathname}${href(r)}`;

// ------------------------------------------------------------------ messages

/** A link to a message the network's own apps open; this app's own link where the network has none (Signal). */
function messageLink(m: P.MessageView): string {
  const c = db.conversations.get(m.conversationId);
  if (c?.network === 'discord') return `${deepLink(c)}/${m.nativeId}`;
  if (c?.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(c.nativeId.split('|')[0])}/${encodeURIComponent(m.nativeId)}`;
  if (c?.network === 'zulip') return zulipMessageLink(c, m.nativeId) ?? appLink({ view: 'inbox', conv: m.conversationId, msg: m.id });
  return appLink({ view: 'inbox', conv: m.conversationId, msg: m.id });
}

const forwardable = (m: P.MessageView) => !m.deleted && m.kind !== 'system' && m.kind !== 'encrypted' && (!!m.body.trim() || m.attachments.length > 0);

function QuickReactions({ m, close, sheet }: { m: P.MessageView; close: () => void; sheet: boolean }) {
  const pick = (k: string) => () => {
    close();
    void toggleReaction(m, { key: k });
  };
  const swap = replacing(m);
  return (
    <div class={sheet ? 'sheet-quick' : 'cm-quick'}>
      {quickReactions(m.network, sheet ? 6 : 4).map((k) => (
        <button class={swap?.key === k ? 'on' : ''} data-track="quick reaction" aria-label={`React ${k}`} title={swap ? (swap.key === k ? `Take back your ${k}` : `Replace your reaction with ${k}`) : `React ${k}`} onClick={pick(k)}>
          {k}
        </button>
      ))}
      {sheet && (
        <button
          class="more"
          data-track="add reaction (other)"
          aria-label="More reactions"
          onClick={() => {
            close();
            pickerFor.value = { message: m, anchor: null };
          }}
        >
          <Icon name={addLook(m).icon} size={22} />
        </button>
      )}
    </div>
  );
}

function MessageHead({ m }: { m: P.MessageView }) {
  const self = isSelfIdentity(m.authorId);
  const name = self ? 'You' : authorName(m.authorId);
  const author = m.authorId ? db.identities.get(m.authorId) : null;
  const person = author?.personId ? db.persons.get(author.personId) : null;
  const via = m.seenVia.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  return (
    <>
      <div class="msg-sheet-head">
        <Avatar id={person?.id ?? m.authorId ?? m.id} name={name} url={person?.avatar ?? author?.avatar} size={36} />
        <span>
          <b>{name}</b>
          <small>
            {fullTime(m.ts)}
            {m.editedTs ? ' · edited' : ''}
            {m.movedAt ? ' · moved' : ''} · {netName(m.network)}
            {via.length ? ` via ${via.map((a) => a.label).join(', ')}` : ''}
          </small>
        </span>
      </div>
      {m.encryptionWarning && (
        <div class="ep-note">
          <Icon name="alert" size={13} /> {m.encryptionWarning}
        </div>
      )}
      {reactionScope(m.conversationId) === 'existing' && <div class="ep-note">You can only add to reactions already on a message here. Tap one to join in.</div>}
    </>
  );
}

/** A message from someone else that triage put in a tier: it can be marked. */
const markable = (m: P.MessageView) => !!m.triage && isTier(m.triage.decision) && !isSelfIdentity(m.authorId);

/** Which tier it landed in and why, on the phone, where there is no bell to hover: the reasons, then the two marks. */
function TriageFoot({ m }: { m: P.MessageView }) {
  const t = m.triage;
  if (!t) return null;
  return (
    <div class="sheet-triage">
      <h4>
        <Icon name={tierIcon(t.decision)} size={14} />
        {tierHeading(t.decision)}
      </h4>
      <ul>
        {t.reasons.map((r) => (
          <li>{r}</li>
        ))}
      </ul>
      {markable(m) && (
        <div class="triage-fb">
          <MarkToggles m={m} onDone={closeMenu} />
        </div>
      )}
    </div>
  );
}

/** The two marks as ticked entries: "Should have alerted" (on an alert, "Alert was wrong") and "Less like this". */
function markEntries(m: P.MessageView): MenuEntry[] {
  if (!markable(m)) return [];
  const alert = alertToggle(m.triage!);
  const less = lessToggle(m.triage!);
  return [
    { label: alert.label, checked: alert.on, track: m.triage!.decision === 'push' ? 'mark alert wrong' : 'mark alert', run: () => void mark(m, { alert: alert.send }) },
    { label: less.label, checked: less.on, track: 'mark less', run: () => void mark(m, { less: less.send }) },
  ];
}

/** `marks` false leaves the two triage marks out: the phone's sheet has them under the reasons (`TriageFoot`). */
function messageEntries(m: P.MessageView, onReply?: () => void, marks = true): MenuEntry[] {
  const scope = reactionScope(m.conversationId);
  const self = isSelfIdentity(m.authorId);
  const thread = m.threadId ? db.conversations.get(m.threadId) : null;
  const original = m.forward?.messageId && m.forward.conversationId ? m.forward : null;
  const text = m.forward?.text ?? m.body;
  const live = !m.deleted && m.kind !== 'system';
  return groups(
    [
      live && scope === 'all' && { kind: 'row', render: (close, sheet) => <QuickReactions m={m} close={close} sheet={sheet} /> },
      live &&
        scope === 'all' && {
          label: replacing(m) ? 'Change Reaction' : 'Add Reaction',
          icon: addLook(m).icon,
          track: 'add reaction',
          sub: [
            ...quickReactions(m.network, 6).map((k): MenuEntry => ({ label: k, track: 'add reaction (quick)', run: () => void toggleReaction(m, { key: k }) })),
            { kind: 'sep' },
            { label: 'Other Reactions…', icon: 'smilePlus', track: 'add reaction (other)', run: () => (pickerFor.value = { message: m, anchor: menuPoint() }) },
          ],
        },
      m.reactions.length > 0 && {
        label: 'View Reactions',
        icon: 'smile',
        track: 'view reactions',
        sub: m.reactions.map((r): MenuEntry => ({ track: 'view reactions (one)', label: `${r.emoji ? `:${r.emoji.name}:` : r.key.match(/^(.+):\d+$/) ? `:${r.key.split(':')[0]}:` : r.key}  ${r.count}${r.style === 'super' ? ' ⚡' : ''}`, run: () => (reactorsFor.value = { message: m, key: r.key, style: r.style, anchor: menuPoint() }) })),
      },
    ],
    [
      canEdit(m) && { label: 'Edit Message', icon: 'pencil', hint: 'E', track: 'edit', run: () => startEditing(m) },
      live && onReply && { label: 'Reply', icon: 'reply', hint: 'R', track: 'reply', run: onReply },
      forwardable(m) && { label: 'Forward', icon: 'forward', hint: 'F', track: 'forward', run: () => (forwarding.value = m) },
      // Apps' message commands (docs/apps.md): listed and run from a dialog of their own.
      live && can(m.conversationId, 'interactContext') && { label: 'Apps', icon: 'gamepad', track: 'message apps', run: () => (appsFor.value = m) },
      pinnable(m) && pinEntry(m),
      canEndPoll(m) && { label: 'End Poll', icon: 'list', track: 'end poll', run: () => confirm('End this poll now? Nobody can vote after.') && void endPoll(m) },
      thread && { label: 'Open Thread', icon: 'thread', track: 'open thread', run: () => openConv(thread) },
      // Create Thread, Publish (threads.ts).
      ...threadMessageEntries(m),
      !!text.trim() && !m.deleted && m.kind !== 'encrypted' && { label: 'Copy Text', icon: 'copy', hint: 'C', track: 'copy text', run: () => copy(plainBody(text, m.network), 'Text copied') },
      { label: 'Copy Message Link', icon: 'link', track: 'copy link', run: () => copy(messageLink(m), 'Link copied') },
    ],
    [
      m.replyToId && { label: 'Go to Replied Message', icon: 'chevronUp', track: 'go to replied', run: () => document.getElementById(`m-${m.replyToId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) },
      original && { label: 'Go to Original Message', icon: 'external', track: 'go to original', run: () => go({ view: 'inbox', conv: original.conversationId!, msg: original.messageId! }) },
      m.authorId && { label: self ? 'Your Profile' : 'Profile', icon: 'user', track: 'profile', run: () => openProfile(m.authorId) },
      hasHistory(m) && { label: 'Message History', icon: 'clock', track: 'history', run: () => (historyOf.value = m) },
    ],
    [canMarkUnread(m, self) && { label: 'Mark Unread', icon: 'mail', track: 'mark unread', run: () => void markUnreadFrom(m) }],
    // Saved on Discord, Remind Me, Remove Embeds, Report (sendingMenu.tsx, docs/sending.md).
    sendingEntries(m),
    marks ? markEntries(m) : [],
    // Google Messages has no unsend: a delete only takes it off your phone.
    [canDelete(m) && { label: m.network === 'gmessages' ? 'Delete From Your Phone' : 'Delete Message', icon: 'trash', hint: 'Del', danger: true, track: 'delete', run: () => deleteMessage(m) }],
    moderatorEntries(m),
    [
      { label: 'Copy Message ID', icon: 'idBadge', track: 'copy message id', run: () => copy(m.nativeId, 'Message ID copied') },
      { label: 'Copy dither-chat ID', icon: 'idBadge', track: 'copy dither-chat id', run: () => copy(m.id, 'ID copied') },
    ],
  );
}

/** Pin or Unpin (docs/polls.md "Pins"), with how long where the network's pins run out (Signal). */
function pinEntry(m: P.MessageView): MenuEntry {
  if (m.pinned) return { label: 'Unpin Message', icon: 'pin', track: 'unpin', run: () => void pin(m, true) };
  const choices = pinChoices(m.network);
  if (!choices.length) return { label: 'Pin Message', icon: 'pin', track: 'pin', run: () => void pin(m, false) };
  return { label: 'Pin Message', icon: 'pin', track: 'pin', sub: choices.map((c): MenuEntry => ({ label: c.label, track: 'pin (duration)', run: () => void pin(m, false, c.seconds) })) };
}

/** Someone else's message where this account moderates (docs/moderation.md): delete it, take its embeds or reactions off. */
function moderatorEntries(m: P.MessageView): MenuEntry[] {
  const mod = modOf(m);
  if (!mod) return [];
  const label = (r: P.ReactionView) => (r.emoji ? `:${r.emoji.name}:` : r.key.match(/^(.+):\d+$/) ? `:${r.key.split(':')[0]}:` : r.key);
  return [
    mod.delete && m.kind !== 'system' && { label: 'Delete Message (Moderator)', icon: 'trash', danger: true, track: 'mod delete', run: () => moderatorDelete(m) },
    mod.embeds && m.embeds.length > 0 && { label: 'Remove Embeds (Moderator)', icon: 'eyeOff', danger: true, track: 'mod embeds', run: () => moderatorRemoveEmbeds(m) },
    mod.reactions &&
      m.reactions.length > 0 && {
        label: 'Remove Reactions',
        icon: 'smile',
        danger: true,
        track: 'mod reactions',
        sub: [
          { label: 'All Reactions', danger: true, track: 'mod reactions (all)', run: () => clearReactions(m) },
          { kind: 'sep' },
          ...m.reactions.filter((r) => r.style !== 'super').map((r): MenuEntry => ({ label: `Every ${label(r)}`, track: 'mod reactions (one)', run: () => clearReactions(m, r.key, undefined, label(r)) })),
        ],
      },
  ].filter(Boolean) as MenuEntry[];
}

export function messageMenu(m: P.MessageView, onReply?: () => void): MenuSpec {
  return { label: 'Message actions', track: 'message menu', items: messageEntries(m, onReply, !phone.value), head: <MessageHead m={m} />, foot: <TriageFoot m={m} /> };
}

// ------------------------------------------------------------------ attachments and links

/** Copy an image as an image. Browsers take PNG, so anything else is drawn into a canvas first. */
async function copyImage(url: string) {
  try {
    const blob = await (await fetch(url)).blob();
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      png = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast({ kind: 'info', title: 'Image copied', body: '' }, 1500);
  } catch {
    toast({ kind: 'error', title: 'Could not copy the image', body: 'The browser refused. Save it instead.' });
  }
}

const absolute = (url: string) => new URL(url, location.href).href;

export function attachmentMenu(a: P.AttachmentView, m: P.MessageView | null, images: ViewerImage[] = [], onReply?: () => void): MenuSpec {
  // A Lottie sticker is an animation's JSON, not a picture to open or copy.
  const image = a.kind === 'image' && !isLottie(a);
  const noun = image ? 'Image' : a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : 'File';
  const items = groups(
    [
      image && { label: 'Open Image', icon: 'image', run: () => (viewer.value = { images: images.length ? images : [{ url: a.url, name: a.name }], index: Math.max(0, images.findIndex((x) => x.url === a.url)) }) },
      // Text, code, Markdown, tables, PDFs and archives have a viewer in the app (files.ts).
      a.kind === 'file' && VIEWABLE.has(fileKind(a)) && { label: 'View File', icon: 'eye', run: () => openFileViewer(a, m) },
      // A type the hub serves only as a download has nothing to open here: Save does the same. The desktop helper
      // can open any of them in the desktop's own apps.
      (image || showsInline(a.mime) || (!image && (!!desk.value?.files || !!android?.opensFiles()))) && { label: image ? 'Open Original' : `Open ${noun}`, icon: 'external', run: () => (image ? window.open(a.url, '_blank', 'noopener') : openAttachment(a)) },
      !!desk.value && !!fileMime(a) && { label: 'Open With…', icon: 'external', run: () => void openWith(a) },
      image && { label: 'Copy Image', icon: 'copy', run: () => void copyImage(a.url) },
      { label: `Save ${noun}`, icon: 'download', run: () => save(a.url, a.name) },
      { label: 'Copy Link', icon: 'link', run: () => copy(absolute(a.url), 'Link copied') },
    ],
    // A run of pictures: how this chat shows them (the rail beside it does the same; ui/PictureSwitch.tsx).
    image && m && images.length > 1 ? [{ label: 'Show Pictures As', icon: 'image', sub: pictureEntries('conversation', m.conversationId) }] : [],
    m ? messageEntries(m, onReply) : [],
  );
  return { label: `${noun} actions`, track: 'attachment menu', items, head: m ? <MessageHead m={m} /> : undefined };
}

export function imageMenu(url: string, name: string | null | undefined, m: P.MessageView | null, onReply?: () => void): MenuSpec {
  return attachmentMenu({ id: url, kind: 'image', url, name: name ?? null, mime: null, size: null, width: null, height: null }, m, [{ url, name }], onReply);
}

export function linkMenu(url: string, m: P.MessageView | null, onReply?: () => void): MenuSpec {
  const open = () => void openLink(url).then((ok) => ok || window.open(url, '_blank', 'noopener,noreferrer'));
  // An invite: a click opens the New box on it (InviteCard.tsx), so the browser is one entry down.
  const invite = !!inviteRef(url);
  // A signal.art sticker pack (docs/media-kinds.md): installed through a Signal account, on this click.
  const installer = stickerInstaller(url, m?.seenVia);
  return {
    label: 'Link actions',
    track: 'link menu',
    items: groups(
      [
        ...(invite ? [{ label: 'Preview Invite', icon: 'eye', run: () => openPalette({ kind: 'new', mode: 'join' }, url) } as MenuEntry] : []),
        ...(installer ? [{ label: 'Install Sticker Pack', icon: 'sticker', run: () => void installStickerLink(url, installer) } as MenuEntry] : []),
        { label: invite ? 'Open in Browser' : 'Open Link', icon: 'external', run: open },
        { label: 'Copy Link', icon: 'link', run: () => copy(url, 'Link copied') },
      ],
      m ? messageEntries(m, onReply) : [],
    ),
    head: <div class="cm-sheet-title">{url}</div>,
  };
}

// ------------------------------------------------------------------ notification settings

/**
 * A place's rule: Automatic (none), Always alert, List only or Mute. `held`: with no rule here, what holds instead (a
 * rule above, or what the network does), said under Automatic. A rule from before the tiers shows as what is set,
 * and any of the four replaces it.
 */
function notifyEntries(scope: 'conversation' | 'space', id: string | string[], own: Level | null, held?: string): MenuEntry[] {
  // A person's chat (chatMenu): the rule goes on every route.
  const set = (l: P.RuleLevel | null) => () => void (Array.isArray(id) ? id : [id]).forEach((x) => setRule(scope, x, l));
  return [
    ...(own === 'mentions' ? [{ label: OLDER_RULE, radio: true, checked: true, disabled: true } as MenuEntry] : []),
    { label: AUTOMATIC, radio: true, checked: own === null, run: set(null) },
    ...(held && own === null ? [{ kind: 'label', label: held, note: true } as MenuEntry] : []),
    { kind: 'sep' },
    ...RULE_LEVELS.map((l): MenuEntry => ({ label: RULE_LABEL[l], radio: true, checked: own === l, run: set(l) })),
  ];
}

/** This device's own say over a place (docs/devices.md): only lowers what the shared rules let through. */
function deviceEntries(scope: 'conversation' | 'space', id: string): MenuEntry | null {
  const me = myDevice();
  if (!me) return null;
  const current = deviceRule(me, scope, id);
  const set = (l: P.DeviceLevel | null) => () => void setDeviceRule(me.id, scope, id, l).catch((e) => toast({ kind: 'error', title: 'Device rules', body: String(e?.message ?? e) }));
  return {
    label: 'On This Device',
    icon: 'phone',
    sub: [
      { label: 'Same as Everywhere', radio: true, checked: current === null, run: set(null) },
      { kind: 'sep' },
      ...DEVICE_LEVELS.map((l): MenuEntry => ({ label: { hub: 'Notify', mentions: 'Only @mentions', none: 'Off' }[l], radio: true, checked: current === l, run: set(l) })),
    ],
  };
}

// ------------------------------------------------------------------ conversations

/** Why a conversation sits where it does in the inbox: not an action, so the keys pass over it. */
export function WhyHere({ reasons }: { reasons: string[] }) {
  return (
    <div class="cm-why">
      <span class="cm-why-head">Why it's here</span>
      {reasons.map((r) => (
        <span class="cm-why-line">{r}</span>
      ))}
    </div>
  );
}

/**
 * How a chat or a server shows pictures (docs/pictures.md): as the place it is in says, else as Settings say; or a
 * way of its own. Several ids (a person's chat, one per route): each of them, and a way is ticked when they all have it.
 */
function pictureEntries(kind: P.PlaceKind, ids: string | string[]): MenuEntry[] {
  const all = Array.isArray(ids) ? ids : [ids];
  const id = all[0];
  const owns = all.map((i) => placePref(kind, i).pictures ?? null);
  const own = owns.every((o) => o === owns[0]) ? owns[0] : undefined;
  const up = inheritedPictures(kind, id);
  const from = up.from && (up.from.kind === 'space' ? db.spaces.get(up.from.id)?.name : up.from.kind === 'folder' ? db.folders.find((f) => f.id === up.from!.id)?.name : convTitle(db.conversations.get(up.from.id)));
  return [
    { label: `As ${from ? `in ${from}` : 'in Settings'}: ${PICTURE_LABELS[up.layout]}`, radio: true, checked: own === null, run: () => void setPlacePictures(kind, all, null) },
    ...PICTURE_LAYOUTS.map((l): MenuEntry => ({ label: PICTURE_LABELS[l], radio: true, checked: own === l, run: () => void setPlacePictures(kind, all, l) })),
  ];
}

/** A post you follow (docs/feed.md "Following a post"): stop the hub looking for replies, or start it again. */
function followEntries(c: P.ConversationView): MenuEntry[] {
  const post = c.variant === 'follow' ? followedPostOf(c.nativeId) : null;
  if (!post) return [];
  const stopped = !!c.follow && c.follow.stopped !== null;
  const run = () =>
    void api<P.PostFollow>(`/api/posts/${c.network}/${post}/follow`, { method: stopped ? 'PUT' : 'DELETE' }).then(
      () => toast(stopped ? { kind: 'info', title: 'Following replies again', body: 'New replies will come to this chat.' } : { kind: 'info', title: 'Stopped following', body: 'No more replies come here. The chat stays.' }),
      (e) => toast({ kind: 'error', title: stopped ? 'Could not follow it again' : 'Could not stop following', body: (e as Error).message }),
    );
  return [{ label: stopped ? 'Follow Again' : 'Stop Following', icon: stopped ? 'bell' : 'bellOff', run }];
}

/**
 * Mark As Read. A forum channel (a Zulip channel, a Discord forum) holds no messages of its own and is never unread
 * itself: its threads are marked read, each told to its network through the read queue (hub readqueue.ts).
 */
function markReadEntry(c: P.ConversationView): MenuEntry {
  if (c.shape === 'channel' && (c.variant === 'forum' || c.variant === 'media')) {
    const threads = (db.threads.get(c.id) ?? []).map((id) => db.conversations.get(id)).filter((t): t is P.ConversationView => !!t);
    return { label: 'Mark As Read', icon: 'check', disabled: !threads.some((t) => unreadOf(t).unread), run: () => markAllRead(threads, convTitle(c)) };
  }
  return { label: 'Mark As Read', icon: 'check', disabled: !unreadOf(c).unread, run: () => (noteRowRead('conversation', [c.id]), markRead(c.id)) };
}

/** `why`: the inbox's reasons for where this row sits (docs/inbox.md), shown first. */
export function conversationMenu(c: P.ConversationView, why?: string[]): MenuSpec {
  const eff = effectiveLevel(c);
  const own = ruleOn('conversation', c.id);
  const muted = own === 'none';
  const person = c.shape === 'direct' && c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  const link = deepLink(c);
  const channel = c.shape === 'channel' || c.shape === 'thread';
  const noun = channel ? 'Channel' : 'Conversation';
  const placeKey = `conversation:${c.id}`;
  return {
    label: `${convTitle(c)} actions`,
    head: <div class="cm-sheet-title">{convTitle(c)}</div>,
    items: groups(
      why?.length ? [{ kind: 'row', render: () => <WhyHere reasons={why} /> }] : [],
      [markReadEntry(c)],
      [
        person && { label: 'Profile', icon: 'user', run: () => go({ view: 'profile', person: person.id }) },
        { label: `About This ${c.shape === 'direct' ? 'Chat' : noun}`, icon: 'info', run: () => openAbout('conversation', c.id) },
        { label: `Search in ${noun}`, icon: 'search', run: () => go({ view: 'search', q: `in:${c.id}` }) },
        c.shape !== 'self' && canIndex('conversation', c.id) && { label: `Index This ${channel ? 'Channel' : 'Chat'}…`, icon: 'archive', run: () => startIndexing('conversation', c.id) },
        { label: 'Copy Link', icon: 'link', run: () => copy(link ?? appLink({ view: 'inbox', conv: c.id }), 'Link copied') },
      ],
      [
        { label: muted ? `Unmute ${noun}` : `Mute ${noun}`, icon: muted ? 'bell' : 'bellOff', run: () => setRule('conversation', c.id, muted ? null : 'none') },
        { label: 'Notification Settings', icon: 'bell', sub: notifyEntries('conversation', c.id, own, heldHere(eff)) },
        deviceEntries('conversation', c.id),
        { label: 'Pictures', icon: 'image', sub: pictureEntries('conversation', c.id) },
      ],
      c.shape !== 'thread' ? arrangeEntries(placeKey) : [],
      // Follow a thread and how it notifies; start, post, browse threads (threads.ts).
      threadConvEntries(c),
      followEntries(c),
      [
        { label: `Copy ${channel ? 'Channel' : 'Chat'} ID`, icon: 'idBadge', run: () => copy(c.nativeId, 'ID copied') },
        { label: 'Copy dither-chat ID', icon: 'idBadge', run: () => copy(c.id, 'ID copied') },
      ],
    ),
  };
}

/**
 * The inbox's row for a person reached by several routes (model.ts): its actions act on the whole chat. Mark As Read
 * reads every route, Mute and the rule go on each, search looks in every chat with them.
 */
export function chatMenu(p: P.PersonView, routes: P.ConversationView[], why?: string[]): MenuSpec {
  const rules = routes.map((c) => ruleOn('conversation', c.id));
  // The rule they all have, if they agree; otherwise none is shown as set.
  const own = rules.every((r) => r === rules[0]) ? rules[0] : null;
  const muted = rules.every((r) => r === 'none');
  const ids = routes.map((c) => c.id);
  return {
    label: `${p.name} actions`,
    head: <div class="cm-sheet-title">{p.name}</div>,
    items: groups(
      why?.length ? [{ kind: 'row', render: () => <WhyHere reasons={why} /> }] : [],
      [{ label: 'Mark As Read', icon: 'check', disabled: !routes.some((c) => unreadOf(c).unread), run: () => (noteRowRead('conversation', ids), routes.forEach((c) => markRead(c.id))) }],
      [
        { label: 'Profile', icon: 'user', run: () => go({ view: 'profile', person: p.id }) },
        { label: 'Search in Chat', icon: 'search', run: () => go({ view: 'search', q: `in:${p.id}` }) },
        { label: 'Copy Link', icon: 'link', run: () => copy(appLink({ view: 'people', person: p.id }), 'Link copied') },
      ],
      [
        { label: muted ? 'Unmute Chat' : 'Mute Chat', icon: muted ? 'bell' : 'bellOff', run: () => ids.forEach((id) => setRule('conversation', id, muted ? null : 'none')) },
        { label: 'Notification Settings', icon: 'bell', sub: notifyEntries('conversation', ids, own) },
        { label: 'Pictures', icon: 'image', sub: pictureEntries('conversation', ids) },
      ],
      identityCopies(p.identityIds.map((id) => db.identities.get(id)).filter((x): x is P.IdentityView => !!x)),
    ),
  };
}

// ------------------------------------------------------------------ spaces, folders, places

export function spaceMenu(s: P.SpaceView): MenuSpec {
  const own = ruleOn('space', s.id);
  const muted = own === 'none';
  const section = s.kind === 'section';
  const noun = section ? 'Category' : s.network === 'discord' ? 'Server' : NETWORK_META[s.network].spaceNoun.replace(/^./, (x) => x.toUpperCase());
  const convs = placeConvs('space', s.id);
  const link = spaceLink(s);
  return {
    label: `${s.name} actions`,
    head: <div class="cm-sheet-title">{s.name}</div>,
    items: groups(
      [{ label: 'Mark As Read', icon: 'check', disabled: !sumUnread(convs).unread, run: () => markAllRead(convs, s.name) }],
      [
        { label: `About This ${noun}`, icon: 'info', run: () => openAbout('space', s.id) },
        !section && canIndex('space', s.id) && { label: `Index This ${noun}…`, icon: 'archive', run: () => startIndexing('space', s.id) },
      ],
      [
        { label: muted ? `Unmute ${noun}` : `Mute ${noun}`, icon: muted ? 'bell' : 'bellOff', run: () => setRule('space', s.id, muted ? null : 'none') },
        { label: 'Notification Settings', icon: 'bell', sub: notifyEntries('space', s.id, own) },
        deviceEntries('space', s.id),
        { label: 'Pictures', icon: 'image', sub: pictureEntries('space', s.id) },
      ],
      section ? [] : arrangeEntries(`space:${s.id}`),
      [
        link && !section && { label: 'Copy Link', icon: 'link', run: () => copy(link, 'Link copied') },
        { label: `Copy ${noun} ID`, icon: 'idBadge', run: () => copy(s.nativeId, 'ID copied') },
        { label: 'Copy dither-chat ID', icon: 'idBadge', run: () => copy(s.id, 'ID copied') },
      ],
    ),
  };
}

/** Whatever sits in the sidebar or the directory, by its place key ("space:…", "conversation:…", "folder:…", "person:…"). */
function placeMenu(key: string, _folder?: string): MenuSpec | null {
  rev.value;
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === 'space') {
    const s = db.spaces.get(id);
    return s ? spaceMenu(s) : null;
  }
  if (kind === 'conversation') {
    const c = db.conversations.get(id);
    return c ? conversationMenu(c) : null;
  }
  if (kind === 'person') {
    const p = db.persons.get(id);
    return p ? personMenu(p, key) : null;
  }
  if (kind === 'folder') return folderMenuSpec(id);
  return null;
}

/** Opens what a right-click or a held finger opens on a place: dnd.tsx calls this. Here, not in Organize.tsx, which this file imports. */
export const openPlaceMenu = (key: string, _label: string, x: number, y: number, folder?: string) => openMenu({ x, y }, placeMenu(key, folder));

export function folderMenuSpec(id: string): MenuSpec | null {
  const f = db.folders.find((x) => x.id === id);
  return f ? { label: `${f.name} actions`, head: <div class="cm-sheet-title">{f.name}</div>, items: groups(...folderEntries(id)) } : null;
}

// ------------------------------------------------------------------ people

function canStartDirect(network?: P.Network) {
  return [...db.accounts.values()].some((a) => a.status === 'online' && a.capabilities.includes('openDirect') && (!network || a.network === network));
}

export function personMenu(p: P.PersonView, placeKey?: string): MenuSpec {
  const directs = directsOf(p.id);
  const idents = p.identityIds.map((id) => db.identities.get(id)).filter((x): x is P.IdentityView => !!x);
  return {
    label: `${p.name} actions`,
    head: <div class="cm-sheet-title">{p.name}</div>,
    items: groups(
      [
        { label: 'Profile', icon: 'user', run: () => go({ view: 'profile', person: p.id }) },
        !p.isSelf && directs.length > 0 && { label: 'Message', icon: 'groups', run: () => go({ view: 'people', person: p.id }) },
        !p.isSelf && !directs.length && idents[0] && canStartDirect() && { label: 'Message', icon: 'groups', run: () => messageSomeone(idents[0].id) },
      ],
      [
        directs.length > 0 && { label: 'Mark As Read', icon: 'check', disabled: !sumUnread(directs).unread, run: () => markAllRead(directs, p.name) },
        directs.length > 0 && { label: 'Pictures', icon: 'image', sub: pictureEntries('conversation', directs.map((c) => c.id)) },
      ],
      placeKey ? arrangeEntries(placeKey) : [],
      identityCopies(idents),
    ),
  };
}

/** One Copy entry: a handle, an id or a profile link, under each network when someone is on several. */
function identityCopies(idents: P.IdentityView[]): MenuEntry[] {
  return idents.length ? [{ label: 'Copy', icon: 'copy', sub: copyEntries(idents) }] : [];
}

/** What Copy holds: one account's handle, id and profile link, or a submenu of those per account (the profile's Copy button). */
export function copyEntries(idents: P.IdentityView[]): MenuEntry[] {
  const one = (i: P.IdentityView): MenuEntry[] => {
    const link = externalProfile(i);
    return [
      i.handle ? { label: 'Copy Username', icon: 'at', run: () => copy(i.handle!, 'Username copied') } : null,
      { label: 'Copy User ID', icon: 'idBadge', run: () => copy(i.nativeId, 'ID copied') },
      link ? { label: 'Copy Profile Link', icon: 'link', run: () => copy(link, 'Link copied') } : null,
    ].filter(Boolean) as MenuEntry[];
  };
  // Two identities on one network are told apart by their handle.
  const twice = (i: P.IdentityView) => idents.filter((x) => x.network === i.network).length > 1;
  const name = (i: P.IdentityView) => (twice(i) ? `${netName(i.network)} · ${i.handle ?? i.displayName ?? i.nativeId}` : netName(i.network));
  return idents.length === 1 ? one(idents[0]) : idents.map((i): MenuEntry => ({ label: name(i), icon: 'copy', sub: one(i) }));
}

/** An author, an avatar or a mention: the person behind it if the hub merged one, else just this identity. */
export function identityMenu(identityId: string | null | undefined): MenuSpec | null {
  if (!identityId) return null;
  const ident = db.identities.get(identityId);
  const person = ident?.personId ? db.persons.get(ident.personId) : null;
  // Their nickname is this account's (docs/chats.md, Names), so it goes with the person's entries.
  if (person) {
    const m = personMenu(person);
    return { ...m, items: groups(m.items, nicknameEntries(ident)) };
  }
  if (!ident) return null;
  const name = isSelfIdentity(identityId) ? 'You' : authorName(identityId);
  return {
    label: `${name} actions`,
    head: <div class="cm-sheet-title">{name}</div>,
    items: groups(
      [
        { label: 'Profile', icon: 'user', run: () => openProfile(identityId) },
        !isSelfIdentity(identityId) && canStartDirect(ident.network) && { label: 'Message', icon: 'groups', run: () => messageSomeone(identityId) },
      ],
      nicknameEntries(ident),
      identityCopies([ident]),
    ),
  };
}

// ------------------------------------------------------------------ accounts

// One account's menu (accountMenu, accountEntries) is in accountMenu.tsx.

/** The accounts button in the rail: every account, each with its own actions. */
export function accountsMenu(): MenuSpec {
  const accs = [...db.accounts.values()];
  return {
    label: 'Accounts',
    head: <div class="cm-sheet-title">Accounts</div>,
    items: groups(
      accs.map((a): MenuEntry => ({ label: `${netName(a.network)} · ${a.label}${a.status === 'online' ? '' : ` (${a.status})`}`, icon: 'user', sub: accountEntries(a) })),
      [{ label: 'Accounts and Connections', icon: 'power', run: () => go({ view: 'accounts' }) }],
    ),
  };
}

