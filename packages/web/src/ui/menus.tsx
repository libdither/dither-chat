/**
 * What each thing's right-click menu (or long-press sheet) holds, in Discord's names and order where Discord has
 * the same action. The reasoning per surface is in docs/menus.md.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, showsInline } from '@dither-chat/protocol';
import { fullTime } from '../format.ts';
import { LEVEL_LABEL, authorName, convTitle, deepLink, directsOf, effectiveLevel, externalProfile, netName, plainBody, sumUnread, unreadOf } from '../model.ts';
import { deviceRule, myDevice, setDeviceRule } from '../devices.ts';
import { android } from '../android.ts';
import { desk, openLink } from '../desk.ts';
import { pickerFor, quickReactions, reactionScope, reactorsFor, replacing, toggleReaction } from '../reactions.ts';
import { api, canDelete, canEdit, db, deleteMessage, go, href, isSelfIdentity, markAllRead, markRead, newMessage, openProfile, rev, setRule, startEditing, toast } from '../state.ts';
import { hasHistory, historyOf } from './MessageHistory.tsx';
import { TierPicker, triageHeading } from './TierVote.tsx';
import { Avatar } from './bits.tsx';
import { copy, groups, menuPoint, openMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';
import { DEVICE_LEVELS } from './DeviceRules.tsx';
import { forwarding } from './Forward.tsx';
import { addLook } from './Reactions.tsx';
import { Icon } from './icons.tsx';
import { openAbout } from './About.tsx';
import { arrangeEntries, folderEntries, placeConvs } from './Organize.tsx';
import { openConv } from './Sidebar.tsx';
import { viewer, type ViewerImage } from './Viewer.tsx';
import { openAttachment, openWith, save } from './fileopen.tsx';
import { fileKind, fileMime, openFileViewer, VIEWABLE } from '../files.ts';
import { inviteRef } from '../invites.ts';

export { openAttachment };

const appLink = (r: Parameters<typeof href>[0]) => `${location.origin}${location.pathname}${href(r)}`;

// ------------------------------------------------------------------ messages

/** A link to a message the network's own apps open; this app's own link where the network has none (Signal). */
export function messageLink(m: P.MessageView): string {
  const c = db.conversations.get(m.conversationId);
  if (c?.network === 'discord') return `${deepLink(c)}/${m.nativeId}`;
  if (c?.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(c.nativeId.split('|')[0])}/${encodeURIComponent(m.nativeId)}`;
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
            {m.editedTs ? ' · edited' : ''} · {netName(m.network)}
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

/** Why it notified, on the phone, where there is no pill to hover. */
function TriageFoot({ m }: { m: P.MessageView }) {
  const t = m.triage;
  if (!t) return null;
  return (
    <div class="sheet-triage">
      <h4>
        <Icon name={t.decision === 'push' ? 'bell' : t.decision === 'quiet' ? 'bellOff' : t.decision === 'digest' ? 'layers' : 'bellOff'} size={14} />
        {triageHeading(t.decision)}
      </h4>
      <ul>
        {t.reasons.map((r) => (
          <li>{r}</li>
        ))}
      </ul>
      <TierPicker m={m} />
    </div>
  );
}

function messageEntries(m: P.MessageView, onReply?: () => void): MenuEntry[] {
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
      thread && { label: 'Open Thread', icon: 'thread', track: 'open thread', run: () => openConv(thread) },
      !!text.trim() && !m.deleted && m.kind !== 'encrypted' && { label: 'Copy Text', icon: 'copy', hint: 'C', track: 'copy text', run: () => copy(plainBody(text, m.network), 'Text copied') },
      { label: 'Copy Message Link', icon: 'link', track: 'copy link', run: () => copy(messageLink(m), 'Link copied') },
    ],
    [
      m.replyToId && { label: 'Go to Replied Message', icon: 'chevronUp', track: 'go to replied', run: () => document.getElementById(`m-${m.replyToId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) },
      original && { label: 'Go to Original Message', icon: 'external', track: 'go to original', run: () => go({ view: 'inbox', conv: original.conversationId!, msg: original.messageId! }) },
      m.authorId && { label: self ? 'Your Profile' : 'Profile', icon: 'user', track: 'profile', run: () => openProfile(m.authorId) },
      hasHistory(m) && { label: 'Message History', icon: 'clock', track: 'history', run: () => (historyOf.value = m) },
    ],
    // Google Messages has no unsend: a delete only takes it off your phone.
    [canDelete(m) && { label: m.network === 'gmessages' ? 'Delete From Your Phone' : 'Delete Message', icon: 'trash', hint: 'Del', danger: true, track: 'delete', run: () => deleteMessage(m) }],
    [
      { label: 'Copy Message ID', icon: 'idBadge', track: 'copy message id', run: () => copy(m.nativeId, 'Message ID copied') },
      { label: 'Copy dither-chat ID', icon: 'idBadge', track: 'copy dither-chat id', run: () => copy(m.id, 'ID copied') },
    ],
  );
}

export function messageMenu(m: P.MessageView, onReply?: () => void): MenuSpec {
  return { label: 'Message actions', track: 'message menu', items: messageEntries(m, onReply), head: <MessageHead m={m} />, foot: <TriageFoot m={m} /> };
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
  const image = a.kind === 'image';
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
  return {
    label: 'Link actions',
    track: 'link menu',
    items: groups(
      [
        ...(invite ? [{ label: 'Preview Invite', icon: 'eye', run: () => void (newMessage.value = { q: url, mode: 'join' }) } as MenuEntry] : []),
        { label: invite ? 'Open in Browser' : 'Open Link', icon: 'external', run: open },
        { label: 'Copy Link', icon: 'link', run: () => copy(url, 'Link copied') },
      ],
      m ? messageEntries(m, onReply) : [],
    ),
    head: <div class="cm-sheet-title">{url}</div>,
  };
}

// ------------------------------------------------------------------ notification settings

const LEVELS: P.NotifyLevel[] = ['all', 'smart', 'mentions', 'digest', 'none'];
const LEVEL_MENU: Record<P.NotifyLevel, string> = { all: 'All Messages', smart: 'Smart', mentions: 'Only @mentions', digest: 'Digest only', none: 'Nothing' };

function notifyEntries(scope: 'conversation' | 'space', id: string, current: P.NotifyLevel | null, inherited: string): MenuEntry[] {
  return [
    { label: `Use Default (${inherited})`, radio: true, checked: current === null, run: () => setRule(scope, id, null) },
    { kind: 'sep' },
    ...LEVELS.map((l): MenuEntry => ({ label: LEVEL_MENU[l], radio: true, checked: current === l, run: () => setRule(scope, id, l) })),
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

const ruleOf = (scope: P.NotifyScope, id: string) => db.rules.find((r) => r.scope === scope && r.target === id)?.level ?? null;

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

/** `why`: the inbox's reasons for where this row sits (docs/inbox.md), shown first. */
export function conversationMenu(c: P.ConversationView, why?: string[]): MenuSpec {
  const eff = effectiveLevel(c);
  const own = ruleOf('conversation', c.id);
  const muted = own === 'none';
  const person = c.shape === 'direct' && c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  const link = deepLink(c);
  const channel = c.shape === 'channel' || c.shape === 'thread';
  const noun = channel ? 'Channel' : 'Conversation';
  const inherited = own ? 'from above' : LEVEL_LABEL[eff.level];
  const placeKey = `conversation:${c.id}`;
  return {
    label: `${convTitle(c)} actions`,
    head: <div class="cm-sheet-title">{convTitle(c)}</div>,
    items: groups(
      why?.length ? [{ kind: 'row', render: () => <WhyHere reasons={why} /> }] : [],
      [{ label: 'Mark As Read', icon: 'check', disabled: !unreadOf(c).unread, run: () => markRead(c.id) }],
      [
        person && { label: 'Profile', icon: 'user', run: () => go({ view: 'profile', person: person.id }) },
        person && directsOf(person.id).length > 1 && { label: 'All Chats with Them', icon: 'users', run: () => go({ view: 'people', person: person.id }) },
        { label: `About This ${c.shape === 'direct' ? 'Chat' : noun}`, icon: 'info', run: () => openAbout('conversation', c.id) },
        { label: `Search in ${noun}`, icon: 'search', run: () => go({ view: 'search', q: `in:${c.id}` }) },
        { label: 'Copy Link', icon: 'link', run: () => copy(link ?? appLink({ view: 'inbox', conv: c.id }), 'Link copied') },
      ],
      [
        { label: muted ? `Unmute ${noun}` : `Mute ${noun}`, icon: muted ? 'bell' : 'bellOff', run: () => setRule('conversation', c.id, muted ? null : 'none') },
        { label: 'Notification Settings', icon: 'bell', sub: notifyEntries('conversation', c.id, own, inherited) },
        deviceEntries('conversation', c.id),
      ],
      c.shape !== 'thread' ? arrangeEntries(placeKey) : [],
      [
        { label: `Copy ${channel ? 'Channel' : 'Chat'} ID`, icon: 'idBadge', run: () => copy(c.nativeId, 'ID copied') },
        { label: 'Copy dither-chat ID', icon: 'idBadge', run: () => copy(c.id, 'ID copied') },
      ],
    ),
  };
}

// ------------------------------------------------------------------ spaces, folders, places

export function spaceMenu(s: P.SpaceView): MenuSpec {
  const own = ruleOf('space', s.id);
  const muted = own === 'none';
  const section = s.kind === 'section';
  const noun = section ? 'Category' : s.network === 'discord' ? 'Server' : NETWORK_META[s.network].spaceNoun.replace(/^./, (x) => x.toUpperCase());
  const convs = placeConvs('space', s.id);
  const link = s.network === 'discord' ? `https://discord.com/channels/${s.nativeId}` : s.network === 'matrix' ? `https://matrix.to/#/${encodeURIComponent(s.nativeId)}` : null;
  return {
    label: `${s.name} actions`,
    head: <div class="cm-sheet-title">{s.name}</div>,
    items: groups(
      [{ label: 'Mark As Read', icon: 'check', disabled: !sumUnread(convs).unread, run: () => markAllRead(convs, s.name) }],
      [{ label: `About This ${noun}`, icon: 'info', run: () => openAbout('space', s.id) }],
      [
        { label: muted ? `Unmute ${noun}` : `Mute ${noun}`, icon: muted ? 'bell' : 'bellOff', run: () => setRule('space', s.id, muted ? null : 'none') },
        { label: 'Notification Settings', icon: 'bell', sub: notifyEntries('space', s.id, own, own ? 'from above' : 'your default') },
        deviceEntries('space', s.id),
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
export function placeMenu(key: string, _folder?: string): MenuSpec | null {
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
        !p.isSelf && !directs.length && idents[0] && canStartDirect() && { label: 'Message', icon: 'groups', run: () => (newMessage.value = { identityId: idents[0].id }) },
      ],
      [directs.length > 0 && { label: 'Mark As Read', icon: 'check', disabled: !sumUnread(directs).unread, run: () => markAllRead(directs, p.name) }],
      placeKey ? arrangeEntries(placeKey) : [],
      identityCopies(idents),
    ),
  };
}

/** One Copy entry: a handle, an id or a profile link, under each network when someone is on several. */
function identityCopies(idents: P.IdentityView[]): MenuEntry[] {
  const one = (i: P.IdentityView): MenuEntry[] => {
    const link = externalProfile(i);
    return [
      i.handle ? { label: 'Copy Username', icon: 'at', run: () => copy(i.handle!, 'Username copied') } : null,
      { label: 'Copy User ID', icon: 'idBadge', run: () => copy(i.nativeId, 'ID copied') },
      link ? { label: 'Copy Profile Link', icon: 'link', run: () => copy(link, 'Link copied') } : null,
    ].filter(Boolean) as MenuEntry[];
  };
  if (!idents.length) return [];
  // Two identities on one network are told apart by their handle.
  const twice = (i: P.IdentityView) => idents.filter((x) => x.network === i.network).length > 1;
  const name = (i: P.IdentityView) => (twice(i) ? `${netName(i.network)} · ${i.handle ?? i.displayName ?? i.nativeId}` : netName(i.network));
  const sub = idents.length === 1 ? one(idents[0]) : idents.map((i): MenuEntry => ({ label: name(i), icon: 'copy', sub: one(i) }));
  return [{ label: 'Copy', icon: 'copy', sub }];
}

/** An author, an avatar or a mention: the person behind it if the hub merged one, else just this identity. */
export function identityMenu(identityId: string | null | undefined): MenuSpec | null {
  if (!identityId) return null;
  const ident = db.identities.get(identityId);
  const person = ident?.personId ? db.persons.get(ident.personId) : null;
  if (person) return personMenu(person);
  if (!ident) return null;
  const name = isSelfIdentity(identityId) ? 'You' : authorName(identityId);
  return {
    label: `${name} actions`,
    head: <div class="cm-sheet-title">{name}</div>,
    items: groups(
      [
        { label: 'Profile', icon: 'user', run: () => openProfile(identityId) },
        !isSelfIdentity(identityId) && canStartDirect(ident.network) && { label: 'Message', icon: 'groups', run: () => (newMessage.value = { identityId }) },
      ],
      identityCopies([ident]),
    ),
  };
}

// ------------------------------------------------------------------ accounts

function accountEntries(a: P.AccountView): MenuEntry[] {
  const disabled = a.status === 'disabled';
  const fail = (e: Error) => toast({ kind: 'error', title: 'That did not work', body: e.message });
  return groups(
    [
      { label: 'Open Account Page', icon: 'settings', run: () => go({ view: 'accounts', account: a.id }) },
      !disabled && { label: 'Reconnect', icon: 'refresh', run: () => api(`/api/accounts/${a.id}/action`, { body: { action: 'restart' } }).catch(fail) },
      { label: disabled ? 'Enable' : 'Disable', icon: 'power', run: () => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { enabled: disabled } }).catch(fail) },
    ],
    [{ label: 'Copy Account ID', icon: 'idBadge', run: () => copy(a.id, 'ID copied') }],
  );
}

export function accountMenu(a: P.AccountView): MenuSpec {
  return { label: `${a.label} actions`, head: <div class="cm-sheet-title">{netName(a.network)} · {a.label}</div>, items: accountEntries(a) };
}

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

