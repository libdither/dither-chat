# Mail

Email beside your chats, through dither-accounts' `mail` interface. The design, with the owner's decisions, is
[mail-design.md](mail-design.md); it is built in slices (its §12). This page says what works now and how to run it.

## What works (slice 1: read-only mail, end to end)

- **Mail in the rail**, after People, once the hub can read mail. A dot while Inbox has unread threads. On a phone it
  sits in Home with the rest; Ctrl+K finds Mail, its views and each mailbox.
- **The list**: Inbox, Unread, Starred and Sent across every account (or one account, with the picker when there are
  several), and any mailbox from the folder button. Threads newest first, bold while unread, with who wrote ("Alex, Jo,
  me"), how many messages, the subject, a star and a paper clip.
- **The reader**: a thread's messages oldest first. Unread messages and the latest are open, the rest fold to a line.
  Each shows its sender with the address, To and Cc, and ▾ for the rest of the headers. The body is the message's
  text, with links, never Markdown; quoted text folds behind ···. An HTML-only message shows the text its HTML makes.
- **Read here**: a thread that has been on screen for a second counts as read on the hub. Slice 4 (below) tells the
  server too, unless Settings says "only when I mark it".
- **Accounts → Mail** and **Settings → Mail** list the mail accounts: online or not, what is wrong ("Sign in to Proton
  in the live view"), "Sending is off: …" when dither-accounts says so, and a link to the account on the manager's
  page. Accounts are added there, never here.
- **When access ends** (the account leaves the manager's list, or the hub's grant goes), its mail stays readable for
  24 hours and then is deleted from the hub. "Delete now" does it at once.
- **Offline**: the page keeps the threads it was showing and the last threads and bodies it opened, so they show
  before the hub answers.

Not yet: search (7), mail in the one-list inbox (8), notifications (9). Only the newest
500 of Inbox and Sent are synced (older mail and other folders come with slice 2), and a thread shows the start of its
last message only once you have opened it (slice 2 fetches bodies ahead).

## People (slice 6)

The people you write to by mail join the people the hub already knows (`hub/src/mail/people.ts`).

- **Who becomes someone.** Everyone you wrote to (To or Cc, not a draft), and everyone who wrote in a thread you wrote
  in, gets an identity on the `email` network (its address is its id and handle) and a person of their own, as a DM
  partner does. Their name is the one on their latest From, else the one you wrote to them under. Anyone else who
  writes to you stays an address, unless classification (slice 8) calls their mail personal: then they get an
  identity, without a person. Newsletters and notifications never do. Your own addresses are never anyone.
- **Never by name.** Sam by mail and Sam on Signal stay two people until you merge them. A profile's "Same name
  elsewhere" hint says who and where ("Alice Chen <alice@…>", "Alice Chen on Signal and Discord"), and the merge
  search finds people by an address too, and the email identities no person holds yet.
- **A profile's Mail card**: their newest threads across every mail account, how many there are, and "All mail with
  Sam", the list `w:<person>` in Mail (`withList`: every thread they are on, in any mailbox). A merge carries the
  mail: the merged person's card and list hold every thread of every address of theirs, and a split takes it back.
  An email-only person asks no network for a profile, and has no chat banner and no empty Recent messages card.
- **In the reader**, the sender's name opens their page. Thread and message views name the identity and person
  behind each address (`MailAddressView.identityId`, `personId`; `MailThreadView.personIds`).
- **When an account's mail is deleted** (24 h after access ended), the identities and persons only it held go too;
  a person you merged or named keeps its address.
- Email-only people are not in the People list (it lists people you have chats with) or in the graph.

How: `mail_party` (`schema-people.sql`) holds who is on each thread and how (sent, written to, in a thread you wrote
in, the name used), kept by `MailStore.recompute`'s hook in the same transaction, so `mailPeople(hub).sender(address)`
is right as soon as an ingest returns: whether you correspond (`known`, `wroteTo`, `tookPart`), and whether their
person has a chat identity (`chat`). Identities and persons follow each ingest at once; a big change (an account's
own addresses becoming known, mail from before this slice on a first start) goes 300 threads a step in the
background. Views work out the person behind each address as they are made (so `mail_thread.person_ids` stays unused),
and a merge, a split or a new person sends that person's threads again. The profile's card comes with `GET /api/persons/:id/profile` (`ProfileView.mail`), the merge search is
`GET /api/persons/candidates?q=&except=`. Tests: `hub/test/mail-people.test.ts`, `web/test/mail-people.test.ts`, and
`scripts/verify-profile.ts` (the Mail card on a desktop in the dark theme and a phone in the light one, the reader's
sender, all mail with them, the hint, the merge search by address, merge and split).

## Sending (slice 5)

- **Writing.** ✎ in Mail's header (or `c`) starts a new message. Reply, Reply all and Forward sit under each message; on
  a phone a bar under the thread answers the latest (`r`, `a`, `f` on a desktop). The composer is a full-screen card on
  a phone and a panel docked at the bottom right on a desktop, so the list stays usable beside it. It has From (a
  picker when the account sends as several addresses, its status's `self.addresses`), To, Cc and Bcc as chips that
  complete from your mail and from people's email addresses, the subject and your text. A reply's quote can be left
  off; a forward carries the original's text and its files, each of which can be taken off. Ctrl+Enter sends; ✕, Esc
  or back closes it and keeps the draft.
- **Who a reply goes to** (`hub/src/mail/compose.ts`): the original's Reply-To, else its From; to your own message, its
  To again. Reply all adds its To and Cc without your addresses. `Re: ` once (`Fwd: ` for a forward), whatever markers
  the subject had. From is the address the original came to. The quote is "On Tue, Nov 3, 2026 at 10:42 AM, Sam Lee
  <sam@lee.example> wrote:" and the original's lines after `> `, in the page's time zone; the HTML part is the same text
  made into HTML, the quote in a `blockquote type=cite`.
- **Drafts** live on the hub (dither-accounts has no drafts op), saved 2 s after you stop typing, and on the device at
  once, so a draft written without the hub, or cut off by a reload, is still there. One per thread (`t:<thread>`:
  answering a thread that has one opens it) or `new:<uuid>`. "N drafts" under the views opens them. A draft's files
  stay on the hub an hour after it was last saved or opened (the uploads' own limit).
- **Undo.** Send gives the message to the hub's outbox (`hub/src/mail/outbox.ts`), once per `clientId`, after checking
  it: someone to send to (at most 500; 100 on Proton), From one of the account's addresses (422 otherwise), 25 MB a
  file and 35 MB together (25 MB on Proton). It is held 10 s (`DITHER_MAIL_HOLD_MS`) while a strip says "Sending …
  in 10 s · Undo"; Undo brings it back into the composer as it was, files and all.
- **Going out.** Then its files move from the uploads into `<data>/mail-outbox/<id>/` and it goes to `mail.send` ahead
  of background work: files by `path` when the manager is on this machine (DITHER_ACCOUNTS_URL on loopback), else as
  base64; a forward's files are fetched from the server (`mail.attachment`) then. What the account answers:
  - sent: "Sent", and Sent is asked what changed, so the copy shows in the thread (it threads by In-Reply-To);
  - a dry run: "Dry run: … did not reach the account";
  - 503, `limited`, or the manager away: tried again, from 2 s up to every 15 min (at once when the manager is back),
    for a day;
  - no answer in time: "it may have been sent: look in Sent before sending it again";
  - 501: sending is off for the account, with the extractor's words (Proton today). It stays off while the account's
    status still says it can send, until "Try sending again";
  - 403 (a read grant), 422 (From), anything else: why.

  Whatever does not go out goes back to the drafts, with its files: a failed send is never a lost message. A send the
  hub stopped in the middle of says it may have been sent. The strip shows failures on every device until dismissed,
  with "Open draft".
- **When it cannot send.** A read grant shows no reply buttons, and the reader says why. An account that cannot send
  (`details.canSend` false with its `sendNote`, or a 501) says so under the thread and in the composer, whose Send is
  off; drafts still save, and reading, archiving and starring work as before. A dry run grant shows "Dry run: nothing
  reaches the account" in the composer.
- **Without the hub**, Send waits in the composer ("Waiting for the hub") and goes when the hub is back, under the same
  `clientId`; meanwhile the draft is on the device.

Routes (`sendRoutes` in outbox.ts): `GET /api/mail/compose?kind=new|reply|replyAll|forward&message=&account=&tz=` fills a
message in; `POST /api/mail/send` (a `MailSendRequest`); `GET /api/mail/outbox`; `DELETE /api/mail/outbox/:id` is Undo;
`POST /api/mail/outbox/:id/dismiss`; `GET /api/mail/drafts[?key=]`, `GET/PUT/DELETE /api/mail/drafts/:key`;
`GET /api/mail/addresses?q=` completes recipients; `POST /api/mail/accounts/:id/sending` is "Try sending again". The
`mail.outbox` event carries the outbox's whole list each time (it is not journaled: a sync answer carries it too).

For later slices: MailHub's `sent` event (`{ accountId, outboxId, messageId, replyTo, threadId, dryRun }`) says you
answered a thread. A reply or a forward quotes the original's own HTML when it has some, sanitised by slice 3
(`quotedHtml` in compose.ts: no images, style sheets or script), else its text.

Not yet: the reply showing in its thread before Sent's copy arrives (the strip says "Sent" meanwhile); a send with
files made without the hub surviving a reload of the page (its draft does).

## HTML, images and files (slice 3)

- **The HTML** shows in a frame on a white sheet, in every theme, scaled down to the width when the mail is wider than
  the screen. The hub sanitises it first (`hub/src/mail/sanitize.ts`, an allowlist on Bun's HTMLRewriter): no script,
  frame, object, form, svg, math, meta or base survives; no `on…` attribute; links are http(s), mailto or a place in
  the mail; style keeps its looks but loses `url()`, `@import`, `expression()` and `behavior`. Every kept attribute is
  written again from its decoded value, so `jav&#x61;script:` is read as the browser would read it, and a tag left
  open at the end of the input is dropped (it would close on the markup after it).
- **Two more walls.** The frame is `sandbox="allow-same-origin"` with no `allow-scripts`, and the hub serves the HTML
  (`GET /api/mail/messages/:id/html`) with `sandbox allow-same-origin; default-src 'none'`, images only from this
  hub's mail routes and `data:`, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'self'`, nosniff and no
  referrer. `allow-same-origin` is there so the page can reach in: it sizes the frame, folds the quote, catches link
  clicks and forwards touches. Opened in a tab on its own, the URL is still sandboxed by its CSP.
- **Quotes** (`blockquote type=cite`, Gmail's, Proton's, Yahoo's, Thunderbird's and Outlook's marks) fold behind ···
  when only more quotes follow them and something is left above.
- **Links** open the way chat's do: the desktop helper, else a new tab (Android: the system browser). The frame never
  follows one. A link whose text names another site ("paypal.com" going to evil.example) asks first, showing where it
  really goes; the message's ▾ details say so too, with a Reply-To that goes elsewhere and a name that is itself
  another address.
- **Remote images** are held back: "4 remote images hidden · Load · Always from Sam", with placeholders of their size.
  Allowed, they come through the hub (`GET /api/mail/img/<token>`, `hub/src/mail/images.ts`): the token is an HMAC of
  the message and the URL with the hub's key, so the proxy fetches only what that message names. Public addresses
  only, checked for every address a name resolves to, and the request goes to the address that was checked (a name
  that changes its answer meanwhile gets nowhere); redirects checked again; no cookies or referrer; 10 MB at most;
  kept only if the bytes are an image (not SVG); 7 days in the media cache. A tracker (1-2 px, or hidden by its
  style) is dropped even when images are allowed: a pixel fetched through the hub still reports the open.
- **`cid:` pictures** come from the message's own parts and always show.
- **Files** show under the message as chat's cards; pictures the HTML shows itself are not listed again. They come
  from the server with `mail.attachment` the first time they are opened, go into the media cache, and are looked at
  like chat files (`fileinfo.ts`), so a card says what a file really is; one that would run as a program says so.
  Text, code, Markdown, JSON, CSV, PDF and archives open in the file viewers, pictures in the image viewer, anything
  else in its app or as a download. A message the server deletes, or an account deleted 24 hours after its access
  ended, takes its files with it.
- **Offline**, the frame cannot load and the text part shows instead. A body kept from an earlier session is asked
  for again once, so images allowed on another device show.
- **Swipe back** works over the body on a phone: the frame's touches go to the pager (`Pager.ts forwardTouches`).

As built, where it differs from §7: "Always from" is its own table, `mail_sender_images` (schema-html.sql), for slice 8's
`mail_sender` to take over; there is no `PUT /api/mail/senders/:address` yet, `POST /api/mail/images` takes
`{ messageId }` or `{ sender, allow }`. A mail file's id in URLs is a hash of the extractor's id.

## Filing (slice 4: shared read state, star, archive, move)

- **Read on the server.** A thread on screen for a second is marked read on the server as well, so your other mail
  apps agree (§14 Q3). Settings → Mail → "Mark read on the server" offers "only when I mark it": then it is read here
  only until you choose Mark read. The setting is the hub's, so every device follows it.
- **In the reader**: Archive (Move to Inbox when it is not in Inbox), Move to the trash, Star, and ⋯ for Mark unread,
  Move to…, Mark as junk (Not junk in Junk). Each open message has its own Star. Filing it away goes back to the list.
- **In a list**: on a phone, swipe a row right to archive it and left to mark it read or unread. A long press picks
  a thread; then taps pick more, and a bar over the header archives, marks, stars, trashes or moves them all. On a
  desktop the avatar or Ctrl/Shift-click picks, and right-click opens the same menu. "Archived · Undo" shows for a
  few seconds after a move. Keys: `e` archive, `#` trash, `s` star, `u` unread, `!` junk, Escape lets the selection go.
- **What moves.** Archive takes the thread's messages out of Inbox (into Archive, or All mail on Gmail). Trash, junk
  and a folder take the whole thread except what you sent, which stays in Sent. Back to Inbox takes them out of the
  folder they are in; an IMAP server's All mail is never emptied from here (Gmail would take that as a delete), so a
  Gmail thread that is only in All mail cannot go back to Inbox from here yet. Nothing is ever deleted outright.
- **At once, then for real.** A change shows at once and the hub keeps it as pending (the row's time is greyed) until
  the server answers. It goes in batches of up to 1000 messages per account, op and value, at most one write call per
  220 ms. A message's latest change is the one sent: undone before it left, it never leaves. If the manager or the
  account is away, changes wait (through a hub restart too) and the list says how many; when it is back, what changed
  there is fetched first, then they go. A change the page could not hand to the hub waits in the page and goes when
  the connection is back, once.
- **When the server says no** (§3.7): 404 drops the change and fetches what changed; 403 undoes every change waiting
  for the account and makes it read only here; 501 undoes it and hides that button for the account from then on
  (Proton's `answered`); 410 lists the mailbox again and tries again; anything else is tried again, from 2 s,
  doubling, ten times, then undone. What failed shows above the list until you dismiss it.
- **A read grant** keeps read state here only (as slice 1 did) and shows no filing buttons.

Moved into Trash or Junk, a message keeps its new place here, but those mailboxes are not kept up by the hub (slice 2
follows mailboxes you open), so what happens to it there later reaches the hub only once they are.

## Setting it up

1. The hub runs with `DITHER_ACCOUNTS_URL` (docs/accounts.md). Set `DITHER_ACCOUNTS_PUBLIC_URL` too, for the links to
   the manager's page.
2. On its next start the hub asks dither-accounts for `mail` at `write`, on every account. Approve it on the manager's
   page. Until you do, Mail says so and links there; if you decline, Mail offers "Ask again".
3. Add the mail account on the manager's page (Email (IMAP) or Proton Mail). The hub sees it within seconds and syncs:
   Inbox's newest 50 first, then Sent's, then both down to 500.

A grant narrower than asked is respected: with `read`, the account says "read only: marked read here only". Proton
cannot send from the hub yet (`mail.send` answers 501 there); reading works.

Without `DITHER_ACCOUNTS_URL` there is no Mail entry; Settings → Mail says what to set.

### Numbers

`hub/src/mail/limits.ts` (`MAIL_LIMITS`), overridden by `DITHER_MAIL_SYNC_DAYS` (365: how far back slice 2 backfills,
plus all of Inbox), `DITHER_MAIL_MAX` (150,000 summaries an account), `DITHER_MAIL_CACHE_MB` (500 MB of bodies) and
`DITHER_MAIL_INDEX_MB` (300 MB of search text). Slice 1 keeps every body it fetched (eviction is slice 2's).

## How it keeps up

Mail lives in its own tables in the hub's database (`hub/src/mail/schema.sql`). A message is keyed by its account and
Message-ID, so a move on the server keeps the hub's message, its thread and its body; the extractor's ids are only
where it is. Threads come from the server's thread ids (Gmail, Proton), else from In-Reply-To and References (on
summaries since dither-accounts 515f26d, and from bodies), else, provisionally, from the subject and the people on it.

On the first sync the hub takes a `mail.changes` state for Inbox, Sent and All (or Archive) before listing, so nothing
that arrives meanwhile is missed. After that: `mail.arrived` is stored at once, `mail.changed` queues a changes pass,
and a timer checks Inbox every 5 minutes and the rest every 15 in case an event was lost. The manager coming back, a
gap, the account coming online and the hub starting each catch up the same way. A state that is too old (410) lists
the mailbox again and drops what is no longer there. A message removed from one mailbox is deleted only after the
others were asked, because an IMAP move is a removal there and an addition elsewhere.

## Running it locally

- A demo hub has a mail account of its own, on a fake server (`hub/src/mail/fake.ts`, seeded by `seedDemoMail` in
  `hub/src/demo.ts`): a reply thread, a Cc'd thread with a file, list mail, and an HTML-only message with a tracker and
  scripts.

      bun packages/hub/src/main.ts --demo --data /tmp/mail-demo --port 8700 --web <built web>
      bun scripts/verify-mail.ts http://127.0.0.1:8700 [screenshot dir]

  verify-mail drives it in headless Chromium on a phone (390 px, touch) and a desktop, in the dark and light themes:
  no page errors, nothing off the side of the screen, list → thread → back on a phone, the quote fold, read here, and
  the HTML-only message. Use a fresh data dir each run: reading marks threads read. With `--html` it also checks the
  frame (slice 3): no script runs in it, not even one put there by hand; no request leaves for anywhere but the hub;
  link clicks go through the opener, and a misleading one asks first; the image banner and the proxy; quotes, `cid:`
  pictures, files in the viewers; swiping back over a body. The demo's remote images are drawn by the hub itself
  (`hub/src/mail/demo-html.ts`), so a demo hub reaches nothing outside.
- Tests: `hub/test/mail-thread.test.ts` (threading, as a table), `mail-store.test.ts`, `mail-sync.test.ts` (the fake:
  first-sync order, `more`, 410, moves, Proton-like state, arrivals, gaps, the manager away, access ending, the delta
  sync), `mail-ops.test.ts` (writes on the fake: pending, batches of 1000, 404/403/501/410, a restart with changes
  waiting, the manager away, read in view and its setting, a read grant) and `web/test/mail-model.test.ts`,
  `mail-text.test.ts`, `mail-ops.test.ts`.
- Slice 3: `mail-sanitize.test.ts` (a hostile corpus, each output parsed again against the allowlist),
  `mail-images.test.ts` (the token, private addresses in every spelling, DNS rebinding, redirects, not-an-image, size,
  headers) and `mail-parts.test.ts` (the routes on the fake).
- Sending: `hub/test/mail-compose.test.ts` (recipients, subjects, quotes, the HTML part) and `mail-send.test.ts` (the
  fake: held and undone, 501 turning sending off with the message kept, a read grant, a dry run, retries and a timeout,
  files by path and by their bytes, a forward's files, From, a clientId sent once, a restart mid-send).
  `mail-remote.test.ts` sends a reply through the SMTP sink and checks its headers and its copy in the thread.
  `verify-mail.ts` writes, undoes and sends on a phone and docks a new message on a desktop, last, since it sends.
- `hub/test/mail-remote.test.ts` runs against a real manager with an `imap` account on dither-accounts' Dovecot and
  SMTP sink (ports 18580–18589). It needs the dither-accounts checkout (beside this repo, or `DITHER_ACCOUNTS_REPO`)
  and Dovecot (`DOVECOT_BIN`, or the binary dither-accounts' own imap tests found), and skips without them:

      DITHER_ACCOUNTS_REPO=~/Projects/dither-accounts bun test packages/hub/test/mail-remote.test.ts

## Where later slices plug in

- **Routes**: `hub/src/mail/routes.ts` has a table, `ROUTERS`. A slice writes a `MailRouter` in its own file and adds
  one line there. A router runs once when `MailHub` is made, so it is also where a slice subscribes to the hub.
- **MailHub's events** (`hub.on(…)`, `hub/src/mail/index.ts`): `ingested` (new messages, `live` for ones that just
  arrived), `deleted`, `opened`, `read` (threads read here), `body` (a body arrived), `account` (added, changed, ended,
  deleted). Slice 4 adds `filed` (`hub/src/mail/ops.ts`): a write made here as it shows, before the server confirms it
  (`read`, `unread`, `star`, `unstar`, `archive`, `inbox`, `trash`, `junk`, `move`), and again with `undone` when the
  server refused it. Changes made in other mail apps arrive through sync instead, as `mail.threads` with new `roles`
  and `unread`.
- **Writes**: `mailOps(hub)` (`hub/src/mail/ops.ts`) has `flag`, `move` and `settings()`; a slice that files mail
  itself (Not a person → Updates) calls these rather than writing flags or locations.
- **Tables**: a slice's own go in `hub/src/mail/schema-<name>.sql`, loaded after schema.sql.
- **The page**: `web/src/ui/mail/slots.tsx` has `BODY_RENDERERS` (the first that answers draws a body; `TextBody` is
  last), `MESSAGE_ACTIONS` (under a message), `THREAD_ACTIONS` (the reader's header or bottom bar) and `ROW_WRAPPERS`
  (around each thread row: swipes). The queue's `gate` and `onStart` (`hub/src/mail/queue.ts`) take slice 2's budgets.
- **The protocol**: `protocol/src/mail.ts` already has every view and event of the design's §5; fields a later slice
  fills say which.
- **People** (slice 6): `mailPeople(hub)` (`hub/src/mail/people.ts`): `sender(address)` for classification and
  triage, `settle(threadIds)` after classifying mail outside an ingest, `profile(identityIds)`. The page's
  `composeTo.run` (`web/src/mail/people.ts`) is where a composer plugs in: a profile then offers "Email <address>".
- **A body's view**: `MailStore.bodyExtras` takes functions that add to it (slice 3 fills `html`, `attachments`,
  `warnings`).
- **Quoting HTML**: `quoteFragment(html)` in `hub/src/mail/sanitize.ts` is a message's HTML made safe to quote (no
  images, style sheets or script); slice 5's `quotedHtml` (compose.ts) uses it.
- **Files and touches on the page**: `files.ts` `FileSource` and `openFileSource` open any file in the viewers;
  `Pager.ts` `forwardTouches(frame)` hands a same-origin frame's touches to the pager.
- `protocol/src/mail-iface.ts` is a copy of dither-accounts' interface types; `bun scripts/accounts-sync.ts --check`
  says when it differs.
