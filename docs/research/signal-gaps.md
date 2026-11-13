# Signal: what signal-cli 0.14.8 and Signal can do that dither-chat does not use

Research 2026-11-12, read-only. Sources: `signal-cli <cmd> --help` for all 63 subcommands (empty config,
dump not kept in the repo), `javap` on `signal-cli-0.14.8.jar` (commands/, json/, jsonrpc/)
and `libsignal-cli-0.14.8.jar` (manager API, helpers), compared with the adapter
(`dither-accounts/extractors/signal/src`: adapter.ts, mapping.ts, types.ts), the wire protocol
(`packages/protocol/src/adapter.ts`, `about.ts`), the hub (`packages/hub/src`) and the UI (`packages/web/src`).

Classes: **(a)** signal-cli can do it, the adapter ignores it. **(b)** the adapter reads it but cannot write it.
**(c)** the adapter and protocol carry it, the hub or UI drops it. **(d)** partial. **(e)** a hard limit: signal-cli
(or its JSON layer) cannot do it; these are listed in their own section at the end.
Value for a personal multi-network client: **H**/**M**/**L**.

How the daemon runs: `-a <aci> daemon --socket … --receive-mode on-connection --no-receive-stdout --ignore-stories`,
`--trust-new-identities always` (config default). Linking uses the CLI `link -n`, not JSON-RPC `startLink`/`finishLink`.
Note: adapter comments and docs/signal.md speak of signal-cli **0.14.9**; the store path the task names is 0.14.8.

A side finding: `MessageFact.extra` (quote, poll, sticker, storyReply, viewOnce, expiresInSeconds) is stored by the hub
(`messages.extra`) but only `extra.embeds` is ever read (store.ts search, embeddings.ts). Nothing in packages/web reads
`extra`. Every "(c)" below that names an `extra` key comes from this. **done** (net-gaps): the hub draws `quote`, `contacts`, `storyReply`, `failed`, `missingAttachments` and `attachmentNotes` into MessageView (hub msgextra.ts, protocol extra.ts, docs/messages.md) and the timeline shows them. `poll` stays unread (polls are another package); `sticker` needs nothing more, since #123 draws a `kind: 'sticker'` message's picture as a sticker; `viewOnce` and `expiresInSeconds` stay as they are.

## Messaging

- (d) H: a reply to a message the hub never saw (anything from before linking) shows no quote at all. The adapter
  puts the quoted author, text and attachment types in `extra.quote` (`JsonQuote.text/attachments/mentions/textStyles`),
  but the web's `reply-quote` draws only when `target` is a stored message (Timeline.tsx ~589). **done** (net-gaps): the reply's own quote (author, text, a word for its files, a thumbnail when signal-cli sent one) when the quoted message is not stored; a stored one wins.
- (a) M: incoming link previews are dropped. `JsonDataMessage.previews[]` (`url, title, description, image`) is
  never read by mapping.ts, and the hub does not unfurl links itself. **done** (net-gaps): `previews[]` become `extra.embeds`, drawn as Discord's embeds are (picture only when it downloaded).
- (a) L: outgoing link previews. `send --preview-url/--preview-title/--preview-description/--preview-image` is unused. **done** (net-gaps): the hub fetches the first link under the media proxy's rules (unfurl.ts: public addresses only, 512 KB page, 1 MB picture, 5 s) for an account offering `linkPreviews`, which Signal's offers only while the phone's link-preview setting is on; the adapter sends `previewUrl/Title/Description/Image`.
- (d) L: an outgoing quote carries only the quoted text (`quoteTimestamp/quoteAuthor/quoteMessage`), not
  `--quote-attachment`, `--quote-mention` or `--quote-text-style`. A reply to a photo shows no thumbnail on the phone. **done** (net-gaps): `quoteMention`, `quoteTextStyle` and `quoteAttachment` (a picture of 256 KB or less as its own thumbnail) for messages this device has seen since; older ones keep the plain text.
- (a) L: `send --no-urgent` (send without a push to the recipient) is unused. It could go with low-priority sends. **not built** (net-gaps): nothing in dither marks a send as low priority, so there is nothing to pass it for.
- (a) L: `send --end-session` (reset the session, for decryption trouble) is unused. There is no "reset secure session". **done** (net-gaps): Reset secure session on a 1:1's About (`resetSession` command and capability), with a line in the conversation.
- (d) L: a shared contact (`JsonSharedContact`) becomes one text line (name, phones, emails). `address[]`,
  `organization` (except as the name fallback), `avatar` and the contact's labels are lost, and there is no tap-to-message. **done** (net-gaps): a card with name, organisation, labelled numbers and emails, addresses and picture, and Message where someone the hub knows has that number (else New message with it); the body keeps the one line.
- (a) L: a native forward. Signal "forward" is a resend, and the `forward` capability is not advertised, so the hub
  falls back to its own copy. That is probably fine, though a native one would keep attachments without a re-upload. **not built** (net-gaps): signal-cli has no forward of its own; a "native" one would be the same resend and upload the files again, which the hub's copy already does.
- (d) M: decryption failures (`receive` notifications with `exception`, e.g. an untrusted identity or an invalid
  message) are only logged. No system message says "a message from X could not be decrypted". **done** (net-gaps): a system line in the 1:1 with the sender, once per message, nothing asked of anyone; duplicates and your own sends make none.
- (d) M: a send that fails for some recipients (`results[].type`: `UNREGISTERED_FAILURE`, `IDENTITY_FAILURE`,
  `RATE_LIMIT_FAILURE`+`token`, `NETWORK_FAILURE`, `INVALID_PRE_KEY_FAILURE`) is only logged (`logPartialFailure`). The
  message shows as sent, with no per-message failure or resend. **done** (net-gaps): `extra.failed` on your message, shown as "Not delivered to Sam (no longer on Signal)". **Resend not built**: signal-cli cannot send a group message to only some members; when nobody gets it the send fails as before.
- (d) L: a decryption-error retry (`--disable-send-log` is off, so the send log is kept). It works inside signal-cli,
  but nothing reports a resend. **not built** (net-gaps): signal-cli resends inside itself and reports nothing of it in JSON, so there is nothing to show.

## Receipts, typing, read state

- (a) L: no viewed receipts are sent. `sendReceipt --type viewed` is unused, so playing a voice note or opening a video
  never tells the sender ("played"). Incoming viewed receipts are mapped (`isViewed` → `played`). **done** (net-gaps): playing a voice note or video sends `sendReceipt --type viewed` once (`viewed` command and capability), never in a message request, only with the phone's read receipts on.
- (a) M: the account's typing-indicator setting is ignored. signal-cli's `sendTypingMessage` does not check the
  synced configuration (`ConfigurationStore.getTypingIndicators` is read only in IncomingMessageHandler). If typing
  indicators are off on the phone, dither still sends `sendTyping`. Read receipts are safe: `sendReceiptMessage`
  checks `getReadReceipts`, so a read receipt goes only to your own devices when the setting is off. No JSON-RPC
  method reads the configuration (see (e)), but the adapter could read signal-cli's account file. **done** (net-gaps): read-only from signal-cli's account database (`key_value` `config-typing-indicators`); off on the phone: nothing sent; not known: sent as before.
- (a) L: link previews and sealed-sender indicators also live in the synced configuration, and nothing reads them. **done** (net-gaps) for link previews (`config-link-previews`, gating the previews above), **not built** for sealed-sender indicators: nothing in dither shows them.
- (c) L: incoming typing in groups and 1:1s is relayed (`typing` event). Nothing is missing here; it is listed only
  for completeness. Nothing to do (net-gaps).

## Groups and admin

- (a) M/H: you cannot leave a group. `quitGroup` (with `--admin` to hand over when you are the last admin, and
  `--delete`) is used only to decline invitations. The protocol has no "leave conversation" command.
- (a) M: removing a member is unused (`updateGroup -r/--remove-member`). `about.ts` AboutChange has no kick.
- (a) M: adding or removing admins is unused (`updateGroup --admin / --remove-admin`). The adapter shows admins and
  emits `role` events from re-reads, but protocol/About has no "make admin" change.
- (a) L: ban and unban are unused (`updateGroup --ban/--unban`). `listGroups.banned[]` is read into types but never shown.
- (a) M: join requests to groups you admin go unanswered. `listGroups.requestingMembers[]` appears only as a count
  ("Asking to join"); approving (`updateGroup -m <requester>`) or refusing (`-r`) is not offered. docs/signal.md lists
  it as not built.
- (a) L/M: the group picture cannot be changed. `updateGroup -a/--avatar` exists, but groupAbout says "Changing the
  picture is not supported yet".
- (b) L: link approval can be set but not read. `updateGroup --link enabled-with-approval` exists, but
  `listGroups` JSON does not say whether approval is on (`groupInviteLink` only), so `joinApproval` is shown as
  unknown and not editable. The write side could still be offered (see (e) for the read side).
- (a) L: member labels are a newer Signal feature: `listGroups.members[].label/labelEmoji` and `updateGroup
  --member-label/--member-label-emoji` (your own label). They are not mapped or set.
- (a) L: ending a group is unused (`terminateGroup -g`). `isTerminated` is read: it blocks changes and invitations.
- (a) M: admin delete is unused. `sendAdminDelete -a <author> -t <ts>` (and `--story`) exists, but `redact` refuses
  others' messages with "Signal only lets you delete your own messages for everyone". Incoming `adminDelete` is
  mapped to `delete` (b).
- (d) L: the group revision (`JsonGroupInfo.revision`) is ignored. Every UPDATE triggers a full `listGroups` re-read
  and a diff (`describeGroupChange`), which cannot name who acted when several changes arrive together.
- (d) L: groups can only be made with 10 people at most (`GROUP_RULES.signal.max = 10`). signal-cli has no such cap.
  This is the protocol's pacing choice, not Signal's.
- (a) L: group calls cannot be started, and `groupCallUpdate.eraId` only gives "started a group call". See (e).

## Contacts, profiles, usernames

- (b) M: nicknames can be read but not set. `displayNameOf` reads `nickGivenName/nickFamilyName/nickName`, but
  `updateContact --nick-given-name/--nick-family-name` is never called. dither-chat's per-account nicknames (#99)
  could write through. **done** (net-gaps): IdentityFact `nickname`, `setContact`; the hub shares it with your own nickname both ways (docs/profile.md).
- (b) L: contact notes. The `note` is shown in the profile facts, but `updateContact --note` is never called. **done** (net-gaps): IdentityFact `note`, `setContact`; joined with the person's note when both changed.
- (a) L: the system contact name. `updateContact -n/--given-name/--family-name` is unused. **not built**: it is your phone's address book's name; dither's nickname is yours instead.
- (a) L: hiding or forgetting a contact. `removeContact --hide | --forget` is unused. Hiding **done** (net-gaps): `remove` with `contact` (Signal's Remove). Forgetting **not built**: it drops what signal-cli knows of them.
- (a) M: blocking and unblocking outside requests. `block`/`unblock` (people and groups) are only used to answer
  requests, and `unblock` never is. The `relationships`/`disconnect` capabilities are not advertised, though
  `listContacts` gives `isBlocked`, contact membership and `isHidden`, and a sync `blockedNumbers/blockedGroupIds`
  only triggers a resnapshot. **done** (net-gaps): `block` (people and groups, About.blocked), `remove` with `blocked`, `relationships`/`disconnect` advertised, contacts and blocks as the account's list; a blocked person never alerts.
- (a) M: the archived flag. `JsonContact.isArchived` (1:1s archived on the phone) is never mapped to the hub's own
  archive. Groups have no such JSON field (e). **done** (net-gaps): ConversationFact.archived on 1:1s; the hub hides or shows the chat when it changes (Settings → Appearance, Follow your phone's archive, on by default).
- (a) M: your own profile name, About emoji and picture. `updateProfile` is called with `about` only. `--given-name,
  --family-name, --about-emoji, --avatar, --remove-avatar` are unused, and protocol `setProfile` carries only `bio`. **done** (net-gaps): `setProfile` `name`, `emoji`, `avatar` (PersonAbout.editable).
- (a) L: contact colour. `JsonContact.color` (the chat colour) is ignored. **not built**: dither has no per-chat colour to put it in.
- (a) L: `profile.mobileCoinAddress` and `internal.capabilities/unidentifiedAccessMode/sharesPhoneNumber/
  discoverableByPhonenumber` (`listContacts --internal`) are ignored. **not built**: nothing here would show them.
- (a) M: your own username and username link. `updateAccount -u <name> / --delete-username` returns `{username,
  usernameLink}`, but nothing sets or reads it. ROADMAP's "A Signal username code waits on the adapter" for My code is
  this. Reading it without setting it is limited (e). **done** (net-gaps): `setProfile` `username` (set or delete), PersonAbout.username, My code shows the link; a username set on the phone shows without one (e8).
- (a) L: privacy toggles. `updateAccount --discoverable-by-number, --number-sharing,
  --unrestricted-unidentified-sender` are unused. **not built**: signal-cli cannot read their current state (e6), so a switch would show a guess.
- (a) L: `listContacts --name <text>` (search by contact or profile name) is unused. The hub searches its own copy. **not built**: the hub's copy holds the same names.
- (d) L: profile freshness. About changes become `customStatus` only when the adapter happens to read contacts
  (snapshots every 30 min, or opening a profile). Signal pushes no profile changes, but `isProfileKeyUpdate` and
  `hasProfileKey` are dropped as housekeeping and could trigger a targeted re-read. **done** (net-gaps): a profile key update re-reads that person (once in ten minutes at most).

## Sync and storage (other devices)

- (d) M: message requests answered on the phone. signal-cli's manager has
  `MessageEnvelope.Sync.messageRequestResponse`, but `JsonSyncMessage` does not serialize it, so the adapter guesses
  (re-reads 5 s and 30 s after an "empty" sync). See (e). **not built**: e1; needs a signal-cli patch.
- (a) L: sync request (`sendSyncRequest`) is used only by the manual `resync` action, never automatically after a
  relink or a long outage. **done** (net-gaps): once after linking and after a day without the daemon, not again within the hour.
- (a) L: `sendContacts` (push your contacts to linked devices) applies to a primary device only. It does not apply here. **not built**: primary only.

## Stories

- (a) L/M: stories are switched off entirely by `--ignore-stories`. `JsonStoryMessage` (`fileAttachment`,
  `textAttachment{text, style, colors, gradient, preview}`, `allowsReplies`, `groupId`) and
  `syncMessage.sentStoryMessage` never arrive.
- (c) L: a story reply arrives (`dataMessage.storyContext`) and the adapter sets `extra.storyReply`, but the web
  never shows "replied to your story". Story reactions (a reaction with `storyContext` and no text) are dropped
  ("e.g. a reaction to a story"). **done** (net-gaps) (display only): "Replied to your story", and a story reaction as "Reacted ❤️ to your story".
- (a) L: posting stories (`sendStory -a <file> [-g group] [--no-replies]`), replying to them (`send
  --story-timestamp/--story-author`), reacting (`sendReaction --story`) and deleting (`sendAdminDelete --story`) are unused.

## Calls

- (d) M: only an incoming offer is mapped ("📞 Incoming voice call"). `callMessage.hangupMessage{type, deviceId}`,
  `busyMessage`, `answerMessage` and `iceUpdateMessages` are ignored, so there is no "missed call", "declined",
  "answered on another device" (hangup types `acceptedonanotherdevice/declinedonanotherdevice/busyonanotherdevice`
  exist in CallManager) and no duration. ROADMAP "Calls without media: … hangups … do not" covers this.
- (a) L (ROADMAP rates it L/H cost): 1:1 voice calls. JSON-RPC `startCall <recipient>`, `acceptCall --call-id`,
  `rejectCall`, `hangupCall`, `listCalls` (`callId, state, number, uuid, isOutgoing, input/outputDeviceName`) and the
  `subscribeCallEvents` → `callEvent` notification (`JsonCallEvent{callId, state, isOutgoing, reason, …}`) are all
  unused. The capability `calls` is not advertised for Signal. Media goes through an external tunnel binary that
  signal-cli spawns (`CallManager.findTunnelBinary`, `spawnMediaTunnel`), with virtual input and output audio devices.
- (a) L: rejecting an incoming call from dither (`rejectCall`) would not need the media tunnel.

## Stickers

- (a) M: sending stickers. `send --sticker <packId>:<stickerId>` is unused, and the UI has no sticker picker.
- (a) L: listing installed packs (`listStickerPacks` → `packId, url, installed, title, author, cover, stickers[]`),
  installing from a signal.art link (`addStickerPack --uri`), fetching one sticker (`getSticker`) and making packs
  (`uploadStickerPack`) are unused. The adapter reads `stickers/<pack>/manifest.json` from disk for emoji and mime.
- (c) L: incoming stickers come in as `kind: 'sticker'` with an image attachment and `extra.sticker`. The web has no
  sticker-specific rendering (no `'sticker'` match in web/src), so they render as an image.

## Payments

- (d) L: an incoming `payment` is one text line ("💸 Payment: note"). `JsonPayment.receipt` (bytes) is ignored, with
  no amount or status. This is fine, since there is no wallet (e).
- (a) L: `sendPaymentNotification --receipt --note` exists, but it needs a MobileCoin receipt from a real wallet,
  which nothing here has.

## Devices, identity, safety numbers

- (a) H: safety numbers. With `--trust-new-identities always` every key change is silently trusted. No "safety
  number changed" notice, no verified state, no verify flow. `listIdentities` (`fingerprint, safetyNumber,
  scannableSafetyNumber, trustLevel` UNTRUSTED/TRUSTED_UNVERIFIED/TRUSTED_VERIFIED, `addedTimestamp`) and `trust
  -v <safety number>` are unused. signal-cli has no identity-change event (e), but a periodic `listIdentities`
  diff on `addedTimestamp` would find changes. **done** (net-gaps): `listIdentities` diff each snapshot (a line in the 1:1, PersonAbout.safety with its QR bytes, `verify` and `clear`); the trust mode stays `always` (documented in dither-accounts docs/signal.md).
- (a) L: linked devices. `listDevices` (`id, name, createdTimestamp, lastSeenTimestamp`) is unused and could feed
  the account page's layers. `removeDevice` and `updateDevice` apply to a primary device only. **done** (net-gaps): on the account page's Session (signal-cli version, this device, every device), read on start and every 6 hours.
- (a) L/M: relink leaves a stale device. `relink` deletes the data dir (`rmSync`) without `unregister`, which on a
  linked device removes itself from the account, so the old "dither-chat" entry stays in the phone's Linked devices
  until Signal ages it out (about 30 days of inactivity). `deleteLocalAccountData` is also unused. **Done as far as signal-cli allows** (net-gaps): this row is wrong about `unregister`: on a linked device 0.14.8 only clears its push token and marks it unregistered locally (AccountHelper.unregister), and removeDevice is primary-only, so nothing can take it off the account. Relink now renames it "dither-chat (old)" first, and the link screen says to remove it on the phone.
- (a) L: renaming this device (`updateAccount -n/--device-name`) after linking is unused. The name is fixed at `link -n`. **done** (net-gaps): the action `renameDevice` { name } (dither-accounts' Try it), shown on the account page.
- (a) M: captchas. `submitRateLimitChallenge --challenge <token> --captcha <token>` is unused. A
  `RATE_LIMIT_FAILURE` with `token`, or a join that needs a captcha, becomes `{check: 'captcha'}`, and nothing lets
  the owner solve it (signalcaptchas.org) and submit the token. **done** (net-gaps): a rate-limit challenge becomes a `captcha` attention with signalcaptchas.org's page and a field for the pasted link, then `submitRateLimitChallenge` (action `submitCaptcha`). A join's captcha stays a `{check: 'captcha'}`, nothing done.
- (a) L: `setPin/removePin`, `startChangeNumber/finishChangeNumber`, `register/verify` and `addDevice` apply to a
  primary device only (NotPrimaryDeviceException). They are out of scope for a linked device. **not built**: primary only.

## Attachments

- (a) L/M: voice notes. `JsonAttachment.isVoiceNote` is ignored (no voice-note player or label), and `send
  --voice-note` is never sent (no recording UI). **done** (net-gaps) for incoming: a "Voice message" label with the player (`attachmentNotes[].voiceNote`; Signal has no duration or waveform). **Not built**: `send --voice-note`, which waits on recording in the composer (another package).
- (a) L: per-attachment captions. `JsonAttachment.caption` is ignored, and `send` has no caption flag (e). **done** (net-gaps) for incoming (`attachmentNotes[].caption`, under the file); sending stays (e) e19.
- (a) L: `uploadTimestamp` and `size` (size is mapped) and `width/height` (mapped) are fine. Thumbnails of quoted
  attachments (`JsonQuotedAttachment.thumbnail`) are ignored. **done** (net-gaps) for quoted thumbnails (see the quote rows above).
- (a) L: view-once sending. `send --view-once` is unused. Incoming view-once is deliberately shown as a placeholder
  ("open it on your phone"), though signal-cli did download the file. The file is kept on disk, not shown and never
  purged early. **not built** (net-gaps): it needs a composer switch and a way to show your own view-once message; incoming view-once stays a placeholder.
- (a) L: `getAttachment` (base64 by id) is unused, but the adapter reads `<dir>/attachments/<id>` directly, which is
  equivalent. Nothing to do (net-gaps): reading the file is equivalent.
- (d) L: an attachment whose download failed or was skipped looks the same as a missing `id`, and is silently dropped
  from the message. The JSON has no "pending" or "failed" status (e). **done** (net-gaps) where the JSON lets you tell: no `id`, or no file on disk when signal-cli hands the message over (it downloads first): "Attachment not downloaded: name (size)" (`extra.missingAttachments`).

## Polls and pins

- (a)/(d) M/H: poll votes are dropped (`dataMessage.pollVote` → "ignoring a poll vote", debug log), so no tally is
  ever shown. `pollCreate` becomes text lines plus `extra.poll`, which the web never renders as a poll (c).
  `pollTerminate` becomes "ended the poll".
- (a) M: no voting or poll-making. `sendPollVote --poll-author --poll-timestamp -o <idx…> --vote-count n`,
  `sendPollCreate -q -o … [--no-multi]` and `sendPollTerminate --poll-timestamp` are unused. The protocol has no poll
  command or event.
- (b) M: pinning and unpinning. Incoming `pinMessage{…, pinDurationSeconds}` and `unpinMessage` become `pin` events
  (with duration timers), and the About shows pinned messages. But `sendPinMessage [-d secs] -a -t` and
  `sendUnpinMessage` are never called, and `configure {key:'pin'}` throws "Signal keeps no list of pinned messages to
  change", which is wrong for 0.14.8.

## Misc

- (a) L: the version probe. `version` is used only as the health probe. Its answer is not shown on the account page. **done** (net-gaps): shown on the account page (Session, and the signal-cli layer's note).
- (a) L: `getAvatar` (contact, profile or group, base64) is unused. Avatars are read from `<dir>/avatars/*` on disk,
  which is equivalent but depends on signal-cli's file naming. **not built**: the files on disk are the same pictures.
- (a) L: `--receive-mode manual` with `subscribeReceive/unsubscribeReceive` is not needed (on-connection is used). **not built**: not needed.
- (a) L: the JSON-RPC multi-account mode (daemon without `-a`: `listAccounts`, `startLink`/`finishLink` returning
  `deviceLinkUri`) is unused. Linking runs a separate `signal-cli link` process instead. That works, but it means two
  JVMs during a relink. **not built**: the separate link process works; two JVMs only during a relink.
- (a) L: `sourceDevice`, `serverReceivedTimestamp` and `serverDeliveredTimestamp` are ignored. They could order
  messages by server time, or say "sent from desktop". **done** (net-gaps): kept in `extra` (`sourceDevice`, `serverReceivedTs`, `serverDeliveredTs`), not shown yet.
- (a) L: `isEndSession`, `isProfileKeyUpdate` and `hasProfileKey` are treated as housekeeping and dropped (fine), and
  could be used as re-read triggers. `isProfileKeyUpdate` **done** (net-gaps) as a re-read trigger; the rest stay dropped.
- (d) L: history. A linked device gets none (`history` → `{count:0, done:true}`). History is only via the backup
  import (docs/import-signal.md). See (e) for link-and-sync. **not built**: e13.

## (e) Hard limits: Signal features signal-cli 0.14.8 cannot deliver

The first group exists inside signal-cli but is dropped by its JSON layer: the manager has it, `Json*` records do not
serialize it, and no JSON-RPC method exposes it. A small signal-cli patch would surface each of these.

- e1 (M): message request responses from your other devices. `MessageEnvelope.Sync.messageRequestResponse` exists;
  `JsonSyncMessage` has only `sentMessage, sentStoryMessage, blockedNumbers, blockedGroupIds, readMessages, type`.
- e2 (L): viewed sync (`Sync.viewed`) and view-once-opened sync (`Sync.viewOnceOpen`) are both dropped, and there is
  no command to send a viewOnceOpen sync.
- e3 (M): mute state. `Contact.muteUntil` (and group storage records' mute) is not in `JsonContact` or `listGroups`.
- e4 (M): archived groups. `isArchived` is exposed for contacts only. Groups' archive flag (from storage) is not.
- e5 (L): `hideStory`, `blockedAt` and `messageExpirationTimeVersion` (Contact) are not exposed.
- e6 (M): reading the account configuration (read receipts, typing indicators, link previews, sealed-sender
  indicators). `Manager.getConfiguration()` exists, but there is no JSON-RPC getter. `updateConfiguration` is
  primary-only.
- e7 (L): group link approval state. `Group.groupInviteLinkUrl` is exposed, but the link state (`GroupLinkState`
  ENABLED vs ENABLED_WITH_APPROVAL) is not in `listGroups`.
- e8 (M): your own username link without changing it. `Manager.getUsernameLink()` exists, but `updateAccount`
  returns `usernameLink` only when it sets a username.
- e9 (L): gift badges. IncomingMessageHandler reads `getGiftBadge`, but `JsonDataMessage` has no field for it.
- e10 (L): raw call signalling. `sendCallOffer/sendCallAnswer/sendIceUpdate/sendHangup/sendBusy/getTurnServerInfo`
  are Manager methods with no JSON-RPC command, so a WebRTC bridge to the PWA (like the Discord one) cannot drive
  Signal calls itself and must use signal-cli's tunnel.
- e11 (L): an attachment's download state, and `blurHash`, are not in `JsonAttachment`.
- e12 (M): identity-key changes. No envelope or notification is sent when someone's safety number changes. You can
  only diff `listIdentities`.

The second group is not implemented in signal-cli at all:

- e13 (H): message history on link (Signal's "transfer message history" link-and-sync). The provisioning code has
  `mediaRootBackupKey` but no ephemeral backup key and no archive import, so a linked signal-cli starts empty.
- e14 (M): delete-for-me sync, call-log sync (`callEvent`, `callLogEvent`, `callLinkUpdate`), outgoing-payment sync
  and attachment-backfill sync. IncomingMessageHandler reads only blocked, configuration, contacts, deviceNameChange,
  fetchType, groups, keys, pniChangeNumber, request, sent, stickerPackOperations, verified, read, viewed,
  viewOnceOpen and messageRequestResponse.
- e15 (L): group calls (joining or hosting), video calls, screen share, raise hand and call links. signal-cli's calls
  are 1:1 voice only (`CallManager` `AUDIO_CALL`; `startCall` takes one recipient). `groupCallUpdate` gives only the
  era id.
- e16 (L): payments. There is no MobileCoin wallet. You can only relay a receipt blob (`sendPaymentNotification`).
- e17 (L): pinned chats, marked-unread, chat folders and the story-view-receipts setting (AccountRecord fields) are
  not exposed, and some are not modelled.
- e18 (L): sending a shared contact card. `send` has no contact-card option (only receiving `contacts[]`).
- e19 (L): per-attachment captions on send (no flag).
- e20 (L): primary-only actions on a linked device: link another device (`addDevice`), remove or rename other
  devices, change the account settings (`updateConfiguration`), registration lock, change number and `sendContacts`.
- e21 (L): Key Transparency and backups (Signal Secure Backups) are not in signal-cli.
- e22 (L): a group-link preview without joining. `joinGroup` is the only server read of a link (as docs/signal.md says).

## signal-cli facts

- Version: 0.14.8 (`/nix/store/q88ymckbisd4y2c6v1zsz6hzmfjy7vq5-signal-cli-0.14.8`). Bundled libsignal-client
  0.102.1, signal-service-java 2.15.3_unofficial_153. Adapter docs and comments said 0.14.9
  (fixed in net-gaps: nixpkgs#signal-cli, which dither-accounts builds, is 0.14.8).
- JSON-RPC notifications: `receive` (`{account, envelope, exception}`), and `callEvent` (`JsonCallEvent`) after
  `subscribeCallEvents`. Results carry `subscription` when subscribed manually.
- JSON-RPC params are the CLI `--long-flag` names in camelCase (`groupId`, `targetTimestamp`, `quoteTimestamp`,
  `editTimestamp`, `noteToSelf`, `pinDuration`, `voteCount`…), with positionals as `recipient` (array).
- Envelope (`JsonMessageEnvelope`) fields: `source, sourceNumber, sourceUuid, sourceName, sourceDevice, timestamp,
  serverReceivedTimestamp, serverDeliveredTimestamp, dataMessage, editMessage, storyMessage, syncMessage, callMessage,
  receiptMessage, typingMessage`.
- `JsonDataMessage` fields: `timestamp, message, expiresInSeconds, isExpirationUpdate, viewOnce, groupCallUpdate{eraId},
  isEndSession, isProfileKeyUpdate, hasProfileKey, reaction, quote, payment{note, receipt}, mentions, previews,
  attachments, sticker{packId, stickerId}, remoteDelete{timestamp}, contacts, pollCreate{question, allowMultiple,
  options}, pollVote{author*, targetSentTimestamp, optionIndexes, voteCount}, pollTerminate{targetSentTimestamp},
  textStyles, groupInfo{groupId, groupName, revision, type}, storyContext{authorNumber, authorUuid, sentTimestamp},
  pinMessage{target*, pinDurationSeconds}, unpinMessage{target*}, adminDelete{target*}`.
- Unmapped by the adapter: `previews`, `pollVote` (dropped), `payment.receipt`, `contacts[].address/avatar`,
  `attachments[].caption/isVoiceNote/uploadTimestamp`, `quote.attachments[].thumbnail`, `storyMessage`,
  `syncMessage.sentStoryMessage`, `callMessage.{answer,busy,hangup,iceUpdate}`, `sourceDevice`, server timestamps,
  `groupInfo.revision`.
- `listGroups` member fields new in 0.14: `isAdmin, label, labelEmoji`. Group fields: `isTerminated`, `banned`.

JSON-RPC methods (✓ = the adapter calls it; † = primary device or registration only; ° = multi-account daemon only):

| method | ✓ | method | ✓ | method | ✓ |
|---|---|---|---|---|---|
| acceptCall | | listIdentities | | sendStory | |
| addDevice † | | listStickerPacks | | sendSyncRequest | ✓ |
| addStickerPack | | quitGroup | ✓ | sendTyping | ✓ |
| block | ✓ | receive (manual mode) | | sendUnpinMessage | |
| deleteLocalAccountData | | rejectCall | | setPin † | |
| finishChangeNumber † | | remoteDelete | ✓ | startCall | |
| finishLink ° | | removeContact | | startChangeNumber † | |
| getAttachment | | removeDevice † | | startLink ° | |
| getAvatar | | removePin † | | submitRateLimitChallenge | |
| getSticker | | send | ✓ | terminateGroup | |
| getUserStatus | ✓ | sendAdminDelete | | trust | |
| hangupCall | | sendContacts † | | unblock | |
| joinGroup | ✓ | sendMessageRequestResponse | ✓ | unregister | |
| listAccounts ° | | sendPaymentNotification | | updateAccount | |
| listCalls | | sendPinMessage | | updateConfiguration † | |
| listContacts | ✓ | sendPollCreate | | updateContact | ✓ (expiration only) |
| listDevices | | sendPollTerminate | | updateDevice † | |
| listGroups | ✓ | sendPollVote | | updateGroup | ✓ (create, accept, name, description, expiration, 3 permissions, link on/off/reset, add members) |
| register ° † | | sendReaction | ✓ | updateProfile | ✓ (about only) |
| verify ° † | | sendReceipt | ✓ (read only) | uploadStickerPack | |
| version | ✓ (health probe) | subscribeReceive | | unsubscribeReceive | |
| subscribeCallEvents | | unsubscribeCallEvents | | | |

That makes 17 of the 65 methods used. CLI-only subcommands: `link` (used, as a separate process), `daemon` (used),
`jsonRpc` (stdin mode, unused).
