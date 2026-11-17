# Stickers, GIFs, voice messages, view-once and stories

Kinds of message beyond text and files, sent from the composer (net-gaps, package media-kinds). Each is offered only
where the sending account says it can, with a capability of protocol `media.ts`; an old adapter without them leaves
the composer as it was. Receiving stickers and voice messages was there before ([rich-messages.md](rich-messages.md),
[messages.md](messages.md)); this page is about sending them, and about stories.

None of it has run against a live account: the adapters are checked against dither-accounts' fakes (a fake
signal-cli, a replica of Discord's bundle), the hub against the demo world, and the web app in headless Chromium
against a demo hub (`scripts/verify-media-kinds.ts`).

## Stickers

Stickers are **Sticker** in the + menu on a computer ([sending.md](sending.md) "The box on a computer") and the **Stickers** tab of the + panel on a phone, drawn in the panel itself ([uploads.md](uploads.md), "The panel"; until 2026-11-14 a button in the phone's box, beside the emoji button). The picker is a chunk of its own (`MediaParts.tsx`), and
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

## GIFs

**Picking one.** The GIF picker (`ComposerMediaParts.tsx` `GifPicker`) is the phone panel's **GIFs** tab and the
computer's + menu **GIF**, offered on Discord and wherever files go. It has a search box and two lists:

- **Yours** first: the GIFs already in your chats, sent or received, newest first, one each (`GET /api/gifs/yours`,
  media.ts `yourGifs`). GIF files and the networks' GIF videos (attachments marked `gif`) come from the attachment
  table; Discord's GIF links from the stored embeds of Discord messages with a `gifv` embed, looked for over the last
  120 days before each page. Nothing outside the hub is asked. With none yet, the picker opens on Trending.
- **Trending**, and what a search finds, through an account with the `searchGifs` capability (`GET /api/gifs`,
  media.ts `gifs`): the chat's own account where it has it, else any connected one, since the results can be sent
  anywhere. Today that is Discord: the account asks Discord's own GIF search (`/gifs/trending-gifs`,
  `/gifs/search`), exactly as Discord's picker does; Discord asks its provider (Klipy). Every picture comes through the
  hub's media path, so the phone and the browser never load the provider's servers; the hub fetches them as it fetches
  any embed's picture. No account with it connected: Trending says so, and Yours still works.

**Sending one** (ComposerMedia.tsx `gifSend`). A tap sends at once. On Discord, a GIF that has a link goes as that link,
as Discord's own picker sends it, and Discord draws it back as the GIF. Anywhere else, or one with no link, goes as a
file (the .gif where the provider has one, else its video), with the send's `gif`: an account with `sendGifs` sends
it as its network's own GIF (Telegram's animation, WhatsApp's GIF playback, in dither-accounts); others send the file
as it is (Signal: signal-cli has no flag for its GIFs; Matrix: an `image/gif` picture).

**Showing them.** Settings → Appearance → **Show GIFs as plain GIFs**, on unless switched off on the device (gifs.ts):

- a Discord message that is only a link which Discord drew as a GIF (one `gifv` embed, no files) shows just the GIF,
  looping, with no link text and no card naming the site, as Discord's own app shows it;
- an attachment marked `gif` (`AttachmentFact.gif`: Telegram's animation, WhatsApp's GIF playback, Signal's GIF flag
  where the adapter reads it) loops silently with no player.

Off, both show as before: the link and its card, and a video player.

## Protocol

Capabilities: `sendStickers`, `installStickers`, `searchGifs`, `sendGifs`, `sendVoice`, `sendViewOnce`, `stories`.
Commands: `stickers`, `addStickerPack`, `gifs`, `storyViewed`, `storyReply`. Events: `story`, `storyGone` (no adapter sends it yet). Fields: `send`'s `sticker` and
`viewOnce`, `OutgoingAttachment.voice` and `.gif`, `AttachmentFact.gif`. Hub: `GET /api/conversations/:id/stickers`,
`POST /api/accounts/:id/stickers`, `GET /api/gifs?q=&cursor=&conversation=`, `GET /api/gifs/yours?before=`,
`GET /api/stories?identity=|conversation=`, `POST /api/stories/:id/viewed`, `POST /api/stories/:id/reply`, and the send
body's `sticker`, `voice`, `viewOnce` and `gif`.
