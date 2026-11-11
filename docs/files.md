# Files: what they are, and viewers for them

A file in a message says what it is on its card (the type by its bytes, then pages, lines or entries, then size), and a
click opens it in a viewer in the app: text and code, Markdown, JSON, CSV and TSV, PDF, and archives. HTML, SVG and XML
are shown as their source, never rendered. A file with no viewer here (a spreadsheet, a program, a disc image) opens as
before: in the desktop's app through the desktop helper or the Android app when they are on, else as a download.

## What the hub records

A network's type is often wrong (Discord calls a `.rs` file `application/rls-services+xml`) or says nothing
(`application/octet-stream`). So once a file's bytes are kept in the media cache (the media archive,
`packages/hub/src/mediaarchive.ts`, keeps every attachment), the hub looks at them (`packages/hub/src/fileinfo.ts`) and
records in `media_info`, keyed like the cache by the SHA-256 of the attachment's URL:

| | |
| --- | --- |
| `mime`, `kind` | The type by magic numbers and content; the kind is the viewer that shows it (`FileKind` in `packages/protocol/src/files.ts`), `binary` for none |
| `size` | In bytes, of the file on disk |
| `pages` | PDF: a linearized file's `/N`, else the largest `/Count` of a page-tree node, also inside compressed object streams |
| `encoding`, `lines`, `language` | Text: UTF-8, UTF-16 (with or without a byte-order mark) or Windows-1252; lines; a highlighting language from the name, else from a `#!` line or the content (JSON that parses, a patch, Markdown's marks) |
| `entries`, `list` | ZIP (from the central directory; Office, OpenDocument, EPUB, JAR and APK told apart), tar and gzip (a tar inside is listed): the count and the first 50 names and sizes |
| `width`, `height` | PNG, JPEG, GIF, WebP, BMP, ICO, AVIF; a video's frame size from MP4 and WebM |
| `duration` | MP4, M4A, QuickTime, WebM, Matroska, WAV, FLAC, Ogg (Opus, Vorbis), MP3 (Xing/VBRI, else from the bitrate) |
| `partial` | Lines or entries were counted in the first part only: there are at least this many |

The name and the network's type only break ties between kinds of text. Markup a browser would run (HTML, SVG, XML) is
told by its content whatever it is called, and is only ever `text`. A name's control and direction-changing characters
are dropped before its extension is read, so `invoice` + U+202E + `fdp.exe` (which shows as invoiceexe.pdf) is an
`.exe`, and archive entry names are cleaned the same way.

Reads are bounded: the first 64 KiB for the type, the first 2 MiB of text, the last 64 KiB of a ZIP and up to 2 MiB
of its directory, a PDF's first 4 MiB and last 1 MiB, one 512-byte header at a time through a tar (5,000 at most), and
at most 8 MiB out of a gzip, so a gzip bomb stops there. Nothing is extracted or written, nothing is run, and there are
no new native dependencies (gzip through the runtime's `DecompressionStream`, object streams through `node:zlib`).

### When

`packages/hub/src/mediainfo.ts` walks attachments by rowid from a cursor in `meta` (`media_info_cursor`), so a restart
carries on and the first run goes through everything the hub already has. On a hub that archives it stays behind the
archive's cursor, and the archive hands it each file it keeps (first time, a retry, or a Discord link signed again) to
look at straight away. One file at a time, a short pause between, at most four seconds of work every 30 seconds. A
demo hub keeps nothing ahead of time, so the walk fetches its own (local) demo files first. Inline `data:` media is
left alone. A message from the last two days is sent again to the apps once its file is looked at, so an open card
changes by itself; an older one shows it when next loaded. A new `SNIFF_VERSION` starts the walk over.

The viewer asks the file's `infoUrl` when a file it opens has not been looked at yet: the hub fetches the file (as
opening it would) and looks at it then. A chat attachment's is `GET /api/attachments/:id/info`, a mail file's
`GET /api/mail/messages/:id/attachments/:aid/info` (files.ts `FileSource`, docs/mail.md).

### Serving

`/media` keeps its protections (`packages/hub/src/mediaheaders.ts`): `nosniff`, a `sandbox` CSP, and anything but a
picture, video, audio, PDF or plain text as a download. Once the hub knows what a file is, one the network called
`application/octet-stream` (or a type just as empty) is served as what it is; a network's own specific type is left as
it said. A PNG sent as octet-stream then shows inline, and an HTML page sent as octet-stream is served as `text/html`,
which is still a download under the sandbox.

## The viewers

On a phone a viewer fills the screen. Wider than a phone it is a box over the app, below the title bar, with the app
dimmed around it: as wide as a page for text, code and PDFs (and as tall as the window allows, so it does not grow as
lines and pages arrive), narrower for an archive's list, and a click beside it closes it. In an installed app with the
window controls overlay, the viewers' bars start below the window's own buttons.

The header always has the name, what the card says, and Download. With the desktop helper paired and "open files in my
apps" on, or in the Android app, it has Open File too (the desktop's or the phone's app for the type), and with the
helper paired, Open With…, which lists the desktop's apps for the type the bytes say (and text editors for a kind of
text no app claims). The file menu has View File for these kinds as well.

Each viewer is a chunk of its own (`packages/web/src/ui/files/`), loaded the first time such a file is opened, and the
shell is in `packages/web/src/ui/Viewer.tsx` with the image viewer. The viewers import nothing from the app's own
modules but Preact (what they need comes in their props), because the bundler splits the startup code by which lazy
chunks share each module: as it is, the startup code gains two small chunks (Preact's hooks and JSX runtime), and the
page two `modulepreload` links.

| Kind | Viewer |
| --- | --- |
| Text and code | Monospace, line numbers, wrap on or off, light highlighting (`highlight.ts`: comments, strings, numbers, keywords, tags; one regular expression per family of languages, no library). 3,000 lines at a time |
| HTML, SVG, XML | The same, as source. Never rendered, never in a frame |
| Markdown | `marked` parses; the viewer turns its tokens into elements itself, so nothing in the file reaches the page as markup. Raw HTML is shown as text. Links are web and mail links only, opening as any link in the app does (through the desktop helper when it is on). A picture from elsewhere waits for a click (loading it would tell its host), then loads without a referrer; inline `data:` pictures show. Rendered or Source |
| JSON | A tree, two levels open, Expand all and Collapse all, 200 children at a time. Not valid, or cut off at the cap: shown as text |
| CSV and TSV | A table (RFC 4180 quoting; the delimiter from the type or name, else whichever of `,` `;` tab `\|` the first line uses most), 1,000 rows at a time. Rendered or Source |
| PDF | pdf.js from npm, page by page: a page is drawn when it comes near and dropped when far, at the pane's width, zoom 50 to 300% |
| Archives | The hub's list: names and sizes of the first 50 entries, and how many there are |
| Images, video, audio | As before: the image viewer, and the players in the timeline. A file the network called just a file whose bytes are a picture, a video or a sound now shows as one |

Text, Markdown, JSON and tables fetch the first 2 MB only and say so ("Showing the first 2 MB of 14 MB. Download the
file for the rest.").

### Why pdf.js, not the browser's own viewer

Chromium's own viewer does show a `/media` PDF in a frame, `sandbox` CSP and all (`scripts/verify-viewers.ts
--probe-pdf` photographs it in a tab and in a frame). But the Android app's WebView has no PDF viewer at all, and
Chromium's runs a PDF's own script. pdf.js is one viewer everywhere, under the app's own header: it parses in a worker,
paints to canvases, and runs none of a PDF's own script (the scripting build is not loaded). It costs a 446 KB chunk and a 1.3 MB worker, both loaded only when a PDF is opened. pdf.js lists a native canvas for Node
as an optional dependency; the root `package.json` overrides it with an empty stub (`packages/web/stubs/no-canvas`), so
installing installs no native binary.

## Testing

- `packages/hub/test/fileinfo.test.ts`: types a network got wrong, files cut short, hostile names, bounded reads (a big
  text file, a gzip bomb, a big PDF), the walk and its cursor, and `/media` serving the found type with the same
  protections.
- `packages/web/test/files.test.ts`: the guess before the hub has looked, the card's words, CSV parsing, highlighting.
- `bun scripts/verify-viewers.ts <demo hub> <dir>`: the demo's files (`packages/hub/src/demo.ts`: a text log, a Rust
  file Discord mislabels, Markdown and JSON sent as octet-stream, a CSV, a ZIP, an SVG with a script in it, the PDF,
  and a spreadsheet with no viewer), each opened from its card at desktop width and at 390 px, with screenshots; that a
  card updates by itself; that no viewer loads before a file is opened; that nothing in a Markdown file or an SVG runs
  or loads by itself; no page errors and nothing wider than a phone's screen.
- `scripts/verify-desk.ts` covers Open File from the viewer and a click on a file with no viewer.

## Not done

- PDF: no text layer, so no selecting or searching text, and no outline. A password-protected PDF says so and offers
  Download.
- Archives: 7z, RAR, xz, bzip2 and zstd are recognised but not listed. A tar inside gzip is listed from its first
  8 MiB.
- No preview for Office and OpenDocument files, TIFF, HEIC or fonts; they say what they are and open in an app.
- A WebM from a browser's recorder has no duration in its header, so none is shown.
- The Android app was not tried; the viewers are web pages and should work in its WebView as in Chromium.
