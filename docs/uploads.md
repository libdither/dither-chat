# Sending files

How a file gets from the composer to a network: checked first, uploaded as it is attached, a piece at a time, kept
on the hub's disk until it is sent, and through a restart of either end. A photo goes so that whatever part of it the
hub has is the whole picture, and a message sent while its files upload is the hub's to send, even if the phone goes
away.

## In the composer

- **Attach** by picking, pasting or dropping. Each file is checked first. One that cannot go stays in the row with
  the reason, in red, and is never uploaded:
  - `Empty file`;
  - `Over Discord’s 10 MB limit (this is 12 MB)`: the network's limit, from `ATTACHMENT_LIMITS` in the protocol;
  - `Over the hub’s 25 MB limit`: `MAX_UPLOAD`, only for a network that takes more than the hub does (none today);
  - `Cannot be read`: moved or deleted since it was picked, a folder, or no permission;
  - for mail only, `Email takes 20 files at a time`: the ones after the twentieth. Elsewhere any number can be
    attached: see "More files than a message takes" below.

  Refused files leave the row when you send or remove them. Before this, files over the limit were left out with a
  toast that named no file, and files over the count were dropped without a word.
- **Each accepted file starts uploading at once**, with a cancel (×): a photo or video as a tile showing what the hub
  has of it (see "How it looks"), another file with a ring and its size so far. Cancelling, or leaving the
  conversation with files attached, also deletes what the hub has of them (`ui/ComposerFiles.tsx`).
- **A failed upload** says why, with Retry. Send waits until it is retried or removed. A failure for want of the hub
  shows "Waiting for the hub" instead: it tries again when the hub is back, and does not hold a send.
- **Send while files are still uploading**, and the message goes to the outbox as any send does (docs/sync.md). The
  hub takes it at once and holds it until the files are in (see "A send the hub holds"). Its pending copy shows the
  tiles and a line: "Sending · 376 KB of 711 KB · about 4 s left". The composer is free at once.
- **Look before it goes.** Photos and videos in the row are tiles at their own shape (112px high, 84px on a phone,
  up to 220px wide), × in the corner, the name and size on a hover. A click opens one in a box over the chat, as
  other files open on a computer: as large as the window lets it be and never past its own size, with its name,
  type, pixels and size, arrows (and ← →) to the others attached, and Remove; a click on a photo the box shrank
  shows it at its own pixels to scroll about. ×, Escape or a click beside the box closes it. On a phone a tap opens the send screen at that one.
  The row is one line that scrolls sideways, so many files never push the chat out of sight.

## More files than a message takes

Each network takes so many files in one message (`ATTACHMENT_LIMITS[network].files`: 10 on most, 1 in an X direct
message). Attach more and they all stay, and the row (or the phone's send screen) says `Goes as 3 messages: Discord
takes 10 files in one`. Send makes that many messages, in the order the files were attached, each with as many as
the network takes; the words and the reply go with the first, silent with all of them (`send` in `state.ts`,
`fileBatches` and `splitsFiles` in the protocol).

- Each is a send of its own: its own pending copy, upload progress, retry and clientId. One that fails does not
  make the others go twice.
- They go one after another, each once the one before is through, so they arrive in order; the outbox flushes
  oldest first, one at a time, for the same reason after the hub was away.
- Send later does the same on the hub when the time comes (`sendlater.ts`): clientIds are the scheduled id, then
  `<id>#1`, `<id>#2`…, so trying a failed one again sends only those that did not go, and its note says how many
  went.
- Mail does not split: one letter carries its files. The hub's send still refuses more than a network takes in one
  request (413), which the app no longer asks for.

## On a phone

The row is Signal's and Discord's: **+** on the left, the message box with a **camera** button inside it on the
right, and send (`ui/Attach.tsx`, pure parts in `camera.ts`). The desktop keeps paste and drop, and files are **Upload a file** in its + menu, or a plain paperclip where files are all the network takes ([sending.md](sending.md)).

- **+** opens the panel in the keyboard's place (below, "The panel").
- **The camera button** (in the box while it is empty; once you type, the text has its width, as in Signal and
  WhatsApp, and the panel's camera tile is still there) opens a full-screen camera in the app (`getUserMedia`), the rear camera first: tap the
  shutter for a photo (a JPEG from the preview's frame, 1920×1080 where the camera gives it), hold it for a video
  (`MediaRecorder`, MP4 where the browser records it, else WebM; with sound once the microphone is allowed, asked
  the first time you hold), flip where there is another camera (to the one facing the other way, not the next one
  on the same side), the torch where the camera has one, the gallery beside the shutter, and close.
  Where the browser has no camera API (plain HTTP, an old browser), or the camera is refused, it falls back to
  `<input type="file" accept="image/*" capture="environment">`, the system's camera: at once while the tap that
  opened it still counts as one, else from a button on the camera screen.
- **The send screen.** A photo or video taken, or photos and videos picked, open a full-screen preview: the media
  large, a strip of thumbnails when there are several (tap one to see it, × on each to remove it, + to add more), a
  caption box, which is the message's text, and send. × goes back to the composer with the files and the text still
  there. A tap on the photo opens it in the picture viewer, to pinch and look closer; back or × returns to the send
  screen. A picked file that is not a photo or video goes to the composer's row as on a desktop.
- **The files are the composer's own.** Each starts uploading as soon as it is attached, before the send screen
  shows, so send is quick. A refused file says why on the send screen as it does in the row (`refusalOf`); a failed
  upload has Retry, and send waits for it.

The Android app (`MainActivity.chooserIntent`): WebView's own picker intent keeps only the first of an input's types
and ignores `capture`, so the app builds its own. Photos and videos: `MediaStore.ACTION_PICK_IMAGES` on Android 13+
(several at once where the input allows), the documents picker with both types before that. `capture`: the camera
app (`ACTION_IMAGE_CAPTURE`) writing to a file in the app's cache, served to it by `FilesProvider` under
`capture/` and writable only there; but only with the camera allowed, since Android refuses that intent to an app
that declares `CAMERA` without holding it, and the page asks for it after the camera was refused, so then it is the
photo picker. `getUserMedia` gets the camera through `onPermissionRequest`, which asks for `CAMERA` (and
`RECORD_AUDIO` for a video's sound) when the page first asks.

## The panel

On a phone, **+** swaps the keyboard for a panel of exactly its height (`ui/panel/`, a chunk of its own): the message
box never moves, and a tap in the box brings the keyboard back up over the panel, which goes once the keyboard is up
(phone.ts `openPanel`, [phone.md](phone.md) "Keyboard"). While it is open the + is a keyboard button. A tap on the
chat above, back, or a send with what it picked closes it. Tabs along its bottom show only what the chat's network
takes: **Photos**, **Files**, **Stickers**, **GIFs**, **Emoji** and **Poll**. The box's emoji button opens it on Emoji. Its
own fields (a search, the poll's lines) put it on the keyboard at its own height, the chat still in sight above, and it
closes for the keyboard only when the box (or another field outside it) has focus. The button whose tab is showing (+,
or the emoji button on Emoji) is the keyboard's button meanwhile.

- **Stickers** is the sticker picker, drawn in the panel: every pack in one scroll, small tiles four or five to a row,
  the strip of packs on top jumping between them and following the scroll; a sticker sends at once and the panel
  stays for another.
- **GIFs** is the GIF picker ([media-kinds.md](media-kinds.md) "GIFs"): a search, Yours and Trending, two columns of
  GIFs at their own shapes; a GIF sends at once and the panel stays.
- **Emoji** is the emoji picker, the categories along its bottom; each one goes into the box where the caret was, and
  the panel stays, so you can add several.
- **Poll** is the poll maker ([polls.md](polls.md), "Making one"), with what the box held as its question; it waits
  for a tap to bring the keyboard, and once sent the box empties and the panel closes.

What is picked is attached at once, into the row over the box, and starts uploading while you pick more or write
the caption; it is numbered in the order picked, and picking it again (or its × in the row) takes it back. The box
is the caption. **Open large** is the send screen.

- **Photos.** In the Android app, the phone's gallery itself, newest first, 60 at a time, the camera first; an album
  menu (Camera, Screenshots…, largest first, each with its newest picture); **View once** where the network has it.
  The first time it asks in place, and Android asks "all photos or selected ones" (Android 14+); with selected ones
  it shows only those, with **Change** to pick again. Elsewhere (a browser, an older app, or not allowed): the
  camera, **Gallery…** (the system's photo picker), and the pictures your chats already hold (`has:image`).
- **Files.** In the Android app, the phone's own storage: **On this phone** lists what changed lately, **Browse
  folders** walks every folder (Downloads, Documents…; hidden files and `Android/` left out), and the search finds
  files by name there and in your chats. Android shows an app other folders than its own only with **All files
  access**, a switch in Settings the panel opens (the storage permission on Android 10). **In your chats** is every
  file sent or received on any network (`has:file`, newest first), sent again with no picker and no permission.
  **Other apps…** at the end is the system's file picker, for a file that lives in another app (a cloud drive); in a
  browser it is **Choose a file…**, the only way to the phone's files there.
- **The search** puts the panel on the keyboard at its own height (at most half of what the keyboard leaves, and only
  while the keyboard is up), so the chat stays in sight above the box; the same for any field of the panel's own (phone.ts `panelLift`).

How the app does it (`apps/android` `Device.kt`): lists go over the bridge (`device.media`, `device.files`,
answered by request id), from MediaStore (the gallery, by `DATE_MODIFIED` and id, so pictures taken in the same
second are neither lost nor repeated) and the shared storage's folders. The bytes (a 360px thumbnail, a whole photo
or file) are served at `<hub origin>/__device/<token>/…`, intercepted by the WebView before any request leaves the
phone; the service worker leaves that path alone. The token is new each time the app starts and only the hub's page
hears it (`info.device`), and a path outside the shared storage is refused. The permissions: `READ_MEDIA_IMAGES`,
`READ_MEDIA_VIDEO` and `READ_MEDIA_VISUAL_USER_SELECTED` (`READ_EXTERNAL_STORAGE` before Android 13), and
`MANAGE_EXTERNAL_STORAGE`, each asked for only when its tab asks. Google Play limits that last one to file managers
and the like; the app is installed from its own APK.

## Pictures that sharpen

A JPEG photo is reordered into a progressive JPEG before it uploads (`web/src/progressive/`). The order is coarse to
fine: first the whole picture at 1:8 detail, then scans that each sharpen all of it. Cut after any whole scan, with an
end marker after it, it is a JPEG every decoder takes. So whatever part of it the hub has is the whole picture, only
blurrier, and the hub can send that if the phone goes away.

- **Lossless.** jpegtran (libjpeg-turbo 3.1, `-progressive -copy all`) reorders the coefficients already in the file:
  the same pixels and the same metadata, often a little smaller. It runs as WebAssembly (`jpegtran.wasm`, 366 KB,
  80 KB as the hub sends it) in a worker, through a small WASI shim (`wasi.ts`) with stdin in and stdout out. The
  worker is loaded on the first photo only. About 0.5 s for a 12 MP photo on a desktop. Rebuild it with
  `scripts/jpegtran-wasm.sh` (nix, `pkgsCross.wasi32`; only the `jpegtran-static` target, without SIMD or TurboJPEG,
  which need setjmp). `packages/web/test/progressive.test.ts` checks its output is byte for byte jpegtran's.
- **Left as they are:** a JPEG already progressive, a PNG, HEIC, video or any other file, and a JPEG the worker cannot
  read or takes over 30 s on. Those upload as before.
- **The layers** (`jpegLayers` in `protocol/src/jpegscans.ts`): each scan ends at the next marker that is not a
  stuffed `FF00` or a restart. The preview point is the scan after which every component has its DC. How good a cut
  looks, measured on camera photos (SSIMULACRA 2): the preview once the DC is in (a few % of the bytes), **fair** from
  35% of the file kept (`CUT_FAIR`), **good** from 60% (`CUT_GOOD`).
- **By quality across a send.** The upload pauses at each level (`qualityStops`): just past the marker after the
  preview, after fair, after good, then the end. "Just past the marker" because a hub with only the bytes up to a
  scan's end cannot tell it ended; the page counts a layer the same way (`seesEnd`). Photos in one send take turns at
  each stop (`turn()` in `upload.ts`), so every picture is a preview before any goes on to fair.
- Pieces are `UPLOAD_PIECE` (256 KiB) or up to the next stop, whichever is shorter. The hub still takes pieces up to
  `UPLOAD_CHUNK` (2 MiB), which older pages send.

## A send the hub holds

A send is a row of the hub's send queue ([sync.md](sync.md), "The send queue"). `POST /api/conversations/:id/send`
with `waitForFiles: true` and files not all in takes it at once, as any send with `ack: 'hub'` (one tick), its row
marked `filesComing` (`packages/hub/src/sendqueue.ts`). From then on the send is the hub's:

- **It heads its chat.** The sends after it in the chat, from any device, wait behind it ("waiting on the message
  above"), so they still go out in the order they were sent. The page uploads its files on, its own copy hidden behind
  the hub's row, after a reload too; the row says "The hub has it, and sends it once the files are in".
- **Sent when the last byte lands** (`Uploads.onWhole`): the row stops waiting, and goes as any other (a chat that
  moved on meanwhile holds it, as it holds any send). The page stops uploading once the row no longer waits.
- **Sent as far as it came** when the phone stops. Every 10 s the hub looks at the rows that wait for files. When
  every file still coming has had no byte for the wait set in Settings → Sending, and each is a photo the hub can cut
  at the quality set there or better, it cuts each after its last whole layer, closes it with an end marker, and sends.
  All or none: a message goes once, so one video or file not all there keeps the whole message waiting. The row
  keeps `cut`, the worst quality of them, and says "Sent as far as it had come (fair)".
- **Held before it is cut.** A cut cannot be undone, so the hold check comes first: if the chat moved on while it
  waited, the row is held uncut, as any send would be, and the phone, back, uploads the rest. Let go (Send, or the
  countdown in a chat someone has open) and it waits for its files again: whole if they came, else cut at the next
  look.
- A piece for an upload that went (whole or cut) gets `410 { sent: true }`, and so does asking how much the hub has
  of it: the phone, back online, ends the upload as sent instead of beginning it again.
- Cancel on the row drops its files, and the sends behind it go. One whose upload is gone fails ("that upload has
  expired"), and one whose files never come fails after 24 hours; the sends behind either go. A hub restart keeps the
  row waiting, as any queued send.
- **Settings → Sending** (`GET`/`PUT /api/sending/cut`, `{ afterMs, atLeast }`, kept in the hub's meta): send what the
  hub has after Never, 1, 5 (the default) or 30 minutes; only if each picture is at least a preview, fair (the
  default) or good.

## How it looks

`ui/UploadTile.tsx` and `sendline.ts`, the same in the composer and on the pending copy:

- **A photo** sparkles as a two-colour dither of itself (an 8×8 Bayer pattern in the accent colour) while it is made
  progressive. Then it shows the hub's copy: the file cut after the last layer the hub has whole, exactly what the hub
  would send now, blurry at first and sharper with each layer. The badge says how good that is and how much is up:
  "preview · 12%", "fair · 52%". Once it is all there the tile is the photo itself.
- **A video** has no usable half: its frame turns from the dither to colour as its bytes reach the hub, with a ring.
- **Another file**: a ring and "2.1 MB of 6.0 MB".
- The ring and the counts are the hub's own count of what it has, never the browser's count of bytes sent. Amber
  while the hub is out of reach; a tick once it has all of it.
- **The line** under a pending copy: "Packing…", then "Sending · 376 KB of 711 KB · about 4 s left". With the link
  lost and the send with the hub: "Link lost · the hub has all 2, at least fair · sends as is in 4:12", or "waits: not all
  fair yet", or "the hub waits for this phone" with Never set.
- A piece that has moved nothing for 30 s (`STALL_MS`) is given up as no answer and tried again, so a link gone
  silent does not hang an upload.

## Uploading in pieces

```
POST /api/uploads/start        { name, mime, size }        → { id, name, mime, size, received: 0 }
PUT  /api/uploads/:id?offset=N  up to UPLOAD_CHUNK bytes    → { …, received }   (409 { received } at a wrong offset)
GET  /api/uploads/:id                                       → { …, received }   (404 once gone; 410 { sent } if sent)
DELETE /api/uploads/:id                                     cancels
POST /api/conversations/:id/send { attachments: [id, …] }   sends; 410 if one is gone or not all there
     … { attachments, clientId, ack: 'hub', waitForFiles }  its queue row at once, `filesComing` until they are in
GET|PUT /api/sending/cut  { afterMs, atLeast }              Settings → Sending
```

- **Why pieces rather than one streamed request**: a phone on a flaky connection. A dropped connection loses at most
  the piece in flight (`UPLOAD_PIECE`, 256 KiB), and the app carries on from `received` instead of starting a 25 MB
  file again. The same pattern as history imports (docs/import.md).
- `received` is the size of the file on the hub's disk. Every byte written is at its own offset, so a piece cut off
  midway still leaves good bytes, and the next piece starts after them.
- The pieces go with XHR, since fetch reports no upload progress (`upload.ts`). On no answer, or a 5xx, the app waits
  1, 2, 4, 8, 15 and 15 s, asking each time how much the hub has. After that it gives up the way fetch does (a
  `TypeError`), and the outbox waits for the hub as it does for any send. A 404 begins the upload again, once: the
  hub no longer has it. Any other refusal is shown as it is.
- The upload ids go with the send in IndexedDB as soon as the hub gives them, so after a reload an upload carries on
  where it was. A send whose uploads the hub let expire (410) uploads them again from the files kept with it.
- `POST /api/uploads` with the file as the body (`x-file-name`, URI-encoded) still takes a whole file in one
  request, streamed to disk and refused once it passes the cap. Older cached pages use it.

## On the hub

- `<data>/uploads/` (0700) holds two files per upload, both 0600: `<id>`, the bytes so far, and `<id>.json`,
  `{ name, mime, size, at }`, with `cut: { from, quality }` once a send whose phone stopped cut it. The bytes go to disk as they arrive. The hub never holds a whole file in memory
  (`packages/hub/src/uploads.ts`).
- **Kept across a restart.** At startup the hub keeps every upload used in the last hour, whole or half-made. "Used"
  means made, written to, or handed to a send. Everything else in the folder goes: older uploads, a stream a crash
  cut off before its record, a half-written record. Before this, the folder was emptied at every start. A send
  queued on a device then had to upload all its files again, and a send that a remote adapter was still reading
  (dither-accounts keeps running while the hub restarts) lost its files.
- **Deleted once sent**, after the adapter answers. One a send waits on is kept while it waits. A send that failed keeps them for a retry. Unused ones go an
  hour after their last use.
- Names are cleaned to a name and never become a path: the last part after any `/` or `\`, no control characters,
  at most 200 characters keeping the end. A type that is not `type/subtype` becomes `application/octet-stream`.

## Limits

`MAX_UPLOAD` stays 25 MiB. Uploads no longer sit in the hub's memory, but the adapters still read a file whole to
send it. Discord's base64-encodes it into the command it hands its client. Signal, WhatsApp, Telegram and Google
Messages also take `MAX_UPLOAD` as their limit in `ATTACHMENT_LIMITS`. Raising it means checking each network's real
limit, and streaming in the adapters (dither-accounts' extractors).

## Tests

- `packages/hub/test/uploads.test.ts`: streaming over the cap, a dropped connection leaving no partial file, pieces
  and offsets, restart with orphans swept, names.
- `packages/hub/test/server.test.ts` ("sending files"): the routes over HTTP, a stream with no length cut off at the
  cap, a dropped connection, a hub restarted between upload and send.
- `packages/web/test/upload.test.ts`: pieces and progress against a fake hub, carrying on after a drop and after a
  reload, refusals, cancel and retry, and why a file is refused; pieces capped at the quality stops, photos taking
  turns by quality, a stalled piece, packing, and a 410 `sent` ending an upload as sent.
- `packages/protocol/test/jpegscans.test.ts`: the layers of an invented progressive JPEG (`test/fixtures/`), only
  whole scans in a cut-off file, cuts closed with an end marker, qualities, and that a hub paused at a stop sees the layer whole.
- `packages/hub/test/sendqueue-files.test.ts`: queue rows waiting for files, against real uploads and a fake clock:
  sent when the last byte lands, a repeat, a send behind one waiting with it, cut after the wait and not before, never
  with Never, all or none (one file that cannot be cut keeps the message waiting), a file gone, expiry, cancel, a
  restart, and a chat that moved on (held uncut, then whole once let go, or cut if the phone is still away).
  `server.test.ts` ("sending files") does one and the cut setting over HTTP.
- `packages/web/test/progressive.test.ts`: the wasm's output against jpegtran's own, a file it cannot read, what is
  packed and what is left. `sendline.test.ts`: the line's words.
- `scripts/verify-pictures.ts` (CI): a pasted photo made progressive in headless Chromium, its pieces held and let go
  one at a time over DevTools; at each, the badge says what the hub could send, worked out from the hub's own bytes.
  Sent mid-upload, the hub takes it at once and sends it whole at the last byte. A second photo, sent and then cut off
  by cutting the link (`link-proxy.ts`): the pending copy says what the hub has and when it sends; a minute later the
  hub sends it cut after a whole layer, at least fair; back online, the page shows the message. Then Settings →
  Sending, kept on the hub.
- `packages/web/test/camera.test.ts`: where a flip goes, what a recording is saved as, names, which picks open the
  send screen.
- `scripts/verify-attach.ts`: the phone's attaching at 390x844 against a demo hub of its own, with Chromium's fake
  cameras: + → Photos & videos → the send screen → a caption → send, as exactly one message with the image, its
  upload begun before send; three photos with the strip, pick, remove and × back; a file over the limit; the camera's
  flip, shutter and a held video, each sent; the fallback when the camera is refused or missing. The file chooser is
  answered over DevTools.
- **In the Android app, on the Android 15 emulator** (AVD `dither35`, run `-read-only`, a debug build installed
  under its own id beside the real one, the page driven over its WebView's DevTools and the system screens with
  `adb input`, against a demo hub through `adb reverse`), 2026-11-10:
  - + → Photos & videos opens the system photo picker ("This app can only access the photos you select"); two
    photos picked arrive on the send screen and upload.
  - The camera button asks for the camera with Android's own prompt. Refused, and answered after the tap stopped
    counting, the camera screen offers the system camera; with the camera refused that opens the photo picker,
    whose photo reaches the send screen.
  - Allowed: the emulated rear camera first, the torch on, flip to the front (mirrored), a real tap on the shutter,
    the photo on the send screen. Held, a video (WebM: that WebView records no MP4).
  - `capture` with the camera allowed opens the camera app, which writes the photo through `FilesProvider`; sent
    with a caption it arrives as one message with that photo.
  - Once, on the very first pick after the app was installed, both photos came back unreadable and showed
    "Cannot be read". It did not happen again in five more tries, with the picker's process killed first or the
    app installed afresh. The send screen says so and the file can be picked again; the cause is not known.
  Not tried on a real phone.
- `scripts/verify-uploads.ts`: in headless Chromium against a demo hub of its own. Refused files are shown with
  their reasons, progress is seen and a cancel leaves nothing behind. A message is sent while a file uploads, and the
  hub is restarted midway. The upload carries on from the offset it reached, with nothing uploaded again, and the
  message goes out with both files. The hub's copies are gone afterwards.
