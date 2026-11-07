# Sending files

How a file gets from the composer to a network: checked first, uploaded as it is attached, a piece at a time, kept
on the hub's disk until it is sent, and through a restart of either end.

## In the composer

- **Attach** by picking, pasting or dropping. Each file is checked first. One that cannot go stays in the row with
  the reason, in red, and is never uploaded:
  - `Empty file`;
  - `Over Discord’s 10 MB limit (this is 12 MB)`: the network's limit, from `ATTACHMENT_LIMITS` in the protocol;
  - `Over the hub’s 25 MB limit`: `MAX_UPLOAD`, only for a network that takes more than the hub does (none today);
  - `Cannot be read`: moved or deleted since it was picked, a folder, or no permission;
  - `Discord takes 10 files at a time`: the ones after the tenth.

  Refused files leave the row when you send or remove them. Before this, files over the limit were left out with a
  toast that named no file, and files over the count were dropped without a word.
- **Each accepted file starts uploading at once**, with a progress bar and a cancel (×). Cancelling, or leaving the
  conversation with files attached, also deletes what the hub has of them (`ui/ComposerFiles.tsx`).
- **A failed upload** says why, with Retry. Send waits until it is retried or removed. A failure for want of the hub
  shows "Waiting for the hub" instead: it tries again when the hub is back, and does not hold a send.
- **Send while files are still uploading**, and the message goes to the outbox as any send does (docs/sync.md) and
  waits for them. Its pending copy says "Uploading…", with each file's percentage. The composer is free at once.

## Uploading in pieces

```
POST /api/uploads/start        { name, mime, size }        → { id, name, mime, size, received: 0 }
PUT  /api/uploads/:id?offset=N  up to UPLOAD_CHUNK bytes    → { …, received }   (409 { received } at a wrong offset)
GET  /api/uploads/:id                                       → { …, received }   (404 once gone)
DELETE /api/uploads/:id                                     cancels
POST /api/conversations/:id/send { attachments: [id, …] }   sends; 410 if one is gone or not all there
```

- **Why pieces rather than one streamed request**: a phone on a flaky connection. A dropped connection loses at most
  the piece in flight (`UPLOAD_CHUNK`, 2 MiB), and the app carries on from `received` instead of starting a 25 MB
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
  `{ name, mime, size, at }`. The bytes go to disk as they arrive. The hub never holds a whole file in memory
  (`packages/hub/src/uploads.ts`).
- **Kept across a restart.** At startup the hub keeps every upload used in the last hour, whole or half-made. "Used"
  means made, written to, or handed to a send. Everything else in the folder goes: older uploads, a stream a crash
  cut off before its record, a half-written record. Before this, the folder was emptied at every start. A send
  queued on a device then had to upload all its files again, and a send that a remote adapter was still reading
  (dither-accounts keeps running while the hub restarts) lost its files.
- **Deleted once sent**, after the adapter answers. A send that failed keeps them for a retry. Unused ones go an
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
  reload, refusals, cancel and retry, and why a file is refused.
- `scripts/verify-uploads.ts`: in headless Chromium against a demo hub of its own. Refused files are shown with
  their reasons, progress is seen and a cancel leaves nothing behind. A message is sent while a file uploads, and the
  hub is restarted midway. The upload carries on from the offset it reached, with nothing uploaded again, and the
  message goes out with both files. The hub's copies are gone afterwards.
