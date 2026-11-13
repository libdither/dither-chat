# Stickers, voice messages, view-once and stories

Kinds of message beyond text and files, sent from the composer (net-gaps, package media-kinds). Each is offered only
where the sending account says it can, with a capability of protocol `media.ts`; an old adapter without them leaves
the composer as it was. Receiving stickers and voice messages was there before ([rich-messages.md](rich-messages.md),
[messages.md](messages.md)); this page is about sending them, and about stories.

None of it has run against a live account: the adapters are checked against dither-accounts' fakes (a fake
signal-cli, a replica of Discord's bundle), the hub against the demo world, and the web app in headless Chromium
against a demo hub (`scripts/verify-media-kinds.ts`).

## Stickers

The composer's sticker button sits beside the emoji button. Its picker is a chunk of its own (`MediaParts.tsx`), and
nothing is asked of the network until it opens: then `GET /api/conversations/:id/stickers` asks the sending account
for one page of packs (the `stickers` command, `StickerPage`, up to `STICKER_PAGE_PACKS` packs), and the next page only
when the owner presses More. Picking a sticker sends it at once, as a reply when one is open (`send`'s `sticker`).

- **Discord** lists what its own client holds in its stores, nothing fetched: this server's stickers, other servers'
  stickers, then the standard packs the client has loaded. Each is kept only where the client's own sendability rule
  (the function its picker and its send check with) says it may be sent; a sticker that needs Nitro is left out and the
  picker says "Stickers from other servers need Nitro". Without that rule module, only this server's own stickers and
  the standard packs. Sending goes through the client's `MessageActions.sendStickers`, its REST send without it.
- **Signal** lists the installed packs (`listStickerPacks`); a sticker's picture comes from signal-cli's copy of the
  pack, and one it has not downloaded yet is fetched with `getSticker` when the picture is asked for. Sending is
  `send --sticker packId:stickerId`. A pack is installed from a signal.art link pasted in the picker, or from a link in a
  message (tapping it opens its menu, where Install Sticker Pack is), with `addStickerPack --uri`
  (`POST /api/accounts/:id/stickers`, from the app itself only). Making packs (`uploadStickerPack`) is not built.

## Voice messages

With the box empty and no files attached, the send button is a microphone. The first press asks for the microphone
(never before), records with MediaRecorder, and shows the recording's loudness as bars as it goes. Stop shows a
player to listen first; send goes straight away; the bin throws it away. Recordings stop at `VOICE_MAX_SECONDS`.

Chromium and Android record WebM Opus; Firefox records Ogg Opus. A WebM recording is rewrapped as Ogg Opus in the page
(`voicerec.ts`: the Opus packets kept as they are, nothing decoded or encoded again), since Ogg is what Discord takes
as a voice message and what Signal's apps play. The waveform is the loudness a tenth of a second at a time, at most
256 points, as Discord's.

- **Discord** (`sendVoice`): the client's own upload path (upload URL, PUT, then the message), the message with the
  IS_VOICE_MESSAGE flag and no text, its file named `voice-message.ogg` with `duration_secs` and `waveform`. Only an Ogg
  file goes as a voice message; anything else (Safari's MP4) goes as an ordinary file.
- **Signal** (`sendVoice`): `send --voice-note`, so Signal's apps show it as a voice note.
- **Elsewhere** (an account that sends files but has no `sendVoice`): the recording goes as an ordinary audio file.

The app's own copy of a sent voice message shows as one (Discord: from the echo; Signal: a "voice note" mark on the
file). Untested live: whether iPhones play an Ogg voice note from dither (Signal's iOS app records AAC).

## View-once (Signal)

With files attached on an account that has `sendViewOnce`, a View once chip shows above the box (and on the phone's
send screen); the phone's attach sheet also has "View once" to pick a photo or video that way. It goes as
`send --view-once`. Your own copy is a placeholder ("View-once media"): the file is not kept here, as Signal's apps do
not show you yours either.

An incoming view-once message stays a placeholder ("open it on your phone"). signal-cli downloads its file anyway; the
adapter deletes that file as soon as the message is mapped, so it is never kept on disk.

## Stories (Signal)

Stories are off unless the owner turns them on, per account: the Stories section on the account's page (Accounts),
the account action `stories` (`STORIES_ACTION`, args `{ on }`). signal-cli's daemon runs with `--ignore-stories` while
it is off. The switch is read when the daemon starts, so a change takes effect at the account's next restart (the
section says so; Restart is under Controls). Nothing restarts by itself.

With it on, a story comes as a `story` event, never as a message: the hub keeps it apart (`story` table, hub
`media.ts`), it never reaches the inbox, a count or a notification, and it is gone a day after it was posted, as on
Signal (the hub holds every story to that day whatever an adapter says; the adapter deletes the story's file then).
A contact's stories show on their page, a group's on the group's page (Stories card); your own stories posted from
your phone come in too, but are not shown anywhere yet.

Opening one marks it seen here and, only where the read-receipt setting synced from your phone is on, sends a viewed
receipt (`storyViewed`); never for someone whose message request waits. A story whose author allows replies takes a
reply or a reaction (`storyReply`: `send --story-timestamp --story-author`, `sendReaction --story`), which goes to your
1:1 with them, or to the group of a group story, and shows there as "Replied to their story".

Not built: posting your own stories (`sendStory`). Without a group it goes to your whole "My Story" audience as your
phone set it up, which dither cannot read or show, so it is left to the phone. Deleting a story (`sendAdminDelete
--story`), story view lists, and a story deleted by its author before its day (signal-cli does not say which story a
deletion is for) are not built either.

## GIF picker (Discord): not built

Discord's own picker asks Discord for Tenor or Klipy results, and the pictures then come from those companies'
servers. Showing them here would have the hub or the page load them from there too, a third party beyond what
Discord's module itself asks for. Sending a GIF is sending its link, which pasting one already does.

## Protocol

Capabilities: `sendStickers`, `installStickers`, `sendVoice`, `sendViewOnce`, `stories`. Commands: `stickers`,
`addStickerPack`, `storyViewed`, `storyReply`. Events: `story`, `storyGone` (no adapter sends it yet). Fields: `send`'s `sticker` and
`viewOnce`, `OutgoingAttachment.voice`. Hub: `GET /api/conversations/:id/stickers`, `POST /api/accounts/:id/stickers`,
`GET /api/stories?identity=|conversation=`, `POST /api/stories/:id/viewed`, `POST /api/stories/:id/reply`, and the send
body's `sticker`, `voice` and `viewOnce`.
