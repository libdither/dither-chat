# Mail

Email beside your chats, through dither-accounts' `mail` interface. The design, with the owner's decisions, is
[mail-design.md](mail-design.md); it is built in slices (its §12). This page says what works now and how to run it.

## What works (slice 1: read-only mail, end to end)

- **Mail in the rail**, after People, once the hub can read mail. A dot while Inbox has unread threads. On a phone it
  sits in Home with the rest; Ctrl+K finds Mail, its views and each mailbox.
- **The list**: Inbox, Unread, Starred and Sent across every account, and any mailbox from the folder button. The views
  are one row of chips that scrolls sideways, without a scrollbar: its edge fades while more chips lie past it, and the
  chosen one is scrolled into view. With several accounts, the line under "Mail" ("All accounts", or the account) is
  the picker: a menu of All accounts and each account, each with its colour's dot, the dot rows show before the
  sender's name when every account shows (the menu says so). Threads newest first, bold while unread, with who wrote
  ("Alex, Jo, me"), how many messages, the subject, a star and a paper clip; each line ends in an ellipsis.
- **The reader**: a thread's messages oldest first. Unread messages and the latest are open, the rest fold to a line:
  who and the start of the text. Bodies ahead skip what you sent (and older mail), so when a thread opens the reader
  asks for the bodies of its folded messages that have no preview yet (the newest 20, after the open ones), which the
  hub fetches at once, as any body a page waits for. Each open message shows its sender with the address, To and Cc,
  and ▾ for the rest of the headers. The body is the message's text, with links, never Markdown; quoted text folds
  behind ···. An HTML-only message shows the text its HTML makes. On a phone the subject takes up to two lines, then an
  ellipsis.
- **Read here**: a thread that has been on screen for a second counts as read on the hub. Slice 4 (below) tells the
  server too, unless Settings says "only when I mark it".
- **Accounts → Mail** and **Settings → Mail** list the mail accounts: online or not, what is wrong ("Sign in to Proton
  in the live view"), "Sending is off: …" when dither-accounts says so, and a link to the account on the manager's
  page. Accounts are added there, never here.
- **When access ends** (the account leaves the manager's list, or the hub's grant goes), its mail stays readable for
  24 hours and then is deleted from the hub. "Delete now" does it at once.
- **Offline**: the page keeps the threads it was showing and the last threads and bodies it opened, so they show
  before the hub answers.

Not yet: notifications (9). Big mailboxes (older mail, other folders, bodies ahead) and search have sections of
their own below.

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
  - 422 `recipients`: the extractor won't send to someone on it (Proton: a pinned key in your contacts, say). Its
    sentence shows, each "recipient N" (or "recipients N and M") replaced by the addresses (counted To, then Cc, then Bcc, an address once);
  - 422 `settings`: your Proton settings sign mail to outside addresses or attach your public key, which dither-chat
    can't do yet. The extractor's sentence shows;
  - 422 `from` or no code: "That From is not one of this account's addresses.";
  - 422 with the manager's `failed` (it passes no extractor code on before dither-accounts' Proton send change): the
    extractor's sentence, recipients replaced as for `recipients`;
  - 403 (a read grant), anything else: why.

  A 422 fails only that message: sending stays on for the account.

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
  the screen. Plain HTML is the exception: when the sanitiser finds only text, paragraphs, line breaks, links, lists,
  quotes, bold and italic (no images, tables, headings, colours, backgrounds, fonts, alignment or style sheets; margins
  and a quote's bar are fine) and the mail has a text part of its own, the body view says `html.plain` and the reader
  shows the text part, with its quote fold, in the app's theme (a reply sent from here, say). The frame, its sandbox,
  the CSP and the allowlist are unchanged; this only picks the part. `sanitize.ts` `plain`, `parts.ts` `hasTextPart`,
  tested in `mail-sanitize.test.ts` and `mail-parts.test.ts`. The hub sanitises it first (`hub/src/mail/sanitize.ts`, an allowlist on Bun's HTMLRewriter): no script,
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
  Move to…, Mark as junk (Not junk in Junk). On a phone only Archive and ⋯ sit beside the subject; Star and Move to the
  trash are in ⋯. Each open message has its own Star. Filing it away goes back to the list.
- **In a list**: on a phone, swipe a row right to archive it and left to mark it read or unread. A long press picks
  a thread; then taps pick more, and a bar over the header archives, marks, stars, trashes or moves them all. On a
  desktop the avatar or Ctrl/Shift-click picks, and right-click opens the same menu. "Archived · Undo" shows for a
  few seconds after a move. Keys: `e` archive, `#` trash, `s` star, `u` unread, `!` junk, Escape lets the selection go.
- **What moves.** Archive takes the thread's messages out of Inbox (into Archive, or All mail on Gmail). Trash, junk
  and a folder take the whole thread except what you sent, which stays in Sent. Back to Inbox takes them out of the
  folder they are in; an IMAP server's All mail is never emptied from here (Gmail would take that as a delete). On
  Gmail, Inbox, and a label for a thread only in All Mail, are a copy from All Mail instead, so the thread stays there
  and keeps its labels; a Gmail archive is held back until its Undo is over ("Gmail" below). Nothing is ever deleted
  outright.
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

## From a person, and mail in the inbox (slice 8)

- **Each message gets a class** by the first of §4's rules that matches (`hub/src/mail/classify.ts`): your override;
  yours; in a thread you wrote in; from someone you wrote to (or who wrote in a thread of yours); from someone you
  merged with a chat contact or know by another address; in Junk; list or machine headers (List-Id,
  List-Unsubscribe, Precedence bulk/list/junk, Auto-Submitted, from a summary or, on Proton, from the body); a
  category label (Gmail's, or Proton's `Category/Social`, `Promotions`, `Updates`, `Newsletters` and `Transactions`:
  receipts and sign-in codes are a machine's mail); an automated address
  (no-reply, notifications, …); more than 10 recipients with you in neither To nor Cc; anything else is from a
  person nobody knows yet (`unknown`). People come before the bulk rules, so a newsletter's author you write to is a
  person. A thread is from a person if any message in it is. The rule that decided is kept (`class_why`).
- **Mail → Inbox** leaves newsletters and notifications out: they fold into one **Updates** row ("Updates · 3 new",
  who from), where its newest sorts; it opens the Updates view. **People** is the rest of Inbox, from people.
- **"Not a person"** on a thread (its menu in Mail, the reader's ⋯, its row in the inbox) sends the thread and its
  latest sender to Updates, from now on. **"This is a person"** brings a sender back, and is offered for Updates and
  for a sender nobody knows. Nothing moves on the server: Updates is a view of Inbox. The hub emits `override`.
- **The one-list inbox** lists a thread from a person in Inbox, not muted, that is unread (last message within 30
  days), or owes a reply (to a message within 14 days), or had mail in the last week, or that you opened in the last
  two days (`MAIL_INBOX` in `hub/src/mail/attention.ts`). Archiving it takes it out, from here or another mail app.
  Mail from a sender nobody knows stays in Mail until triage rates it Active or above (§14 Q4: slice 9).
- **Its order** is the chats' formula (`attention.ts`): you and one other is a DM, else a group of everyone on it; you
  in To is a mention, a reply to yours replies to you. How you answer someone counts all their mail threads and, once
  you merged them with a chat contact, their chats too, and the reverse: "You usually reply to Sam within 30
  minutes; unanswered for 2 hours" reads the same in both. An answer sent from here pays what you owe at once,
  before Sent's copy comes. Until the learned order learns mail (slice 10), a mail row keeps its formula points.
- **A mail row** has the person's picture with the envelope where a chat's network goes, the subject before the start
  of the last message, the same ↩ and reasons on hover, and a menu (why, Open in Mail, Not a person). All and Unread
  include mail; People includes threads between you and one other, Groups the rest. Tapping it opens the reader
  beside the inbox (`#/inbox/c/<thread>`).

How: `mail_message.class`/`class_why` and `mail_thread.class` are written by `MailStore.recomputed`'s hook in the
ingest's transaction; a sender who becomes known (you wrote to them, a merge) has their other threads classified again
a moment later; mail from before this slice is classified in the background. Your overrides are `mail_override`
(`schema-inbox.sql`; `PUT /api/mail/senders/:address {override: person|bulk|null}`, `PUT /api/mail/threads/:id/person
{person: true|false|null}`). `MailAttention` (`hub/src/mail/attention.ts`) folds each thread from a person from the
start when it changes (`mail_feature`, `mail_author_feature`) and is an `Attention` source: its views are
`AttentionView`s with `kind: 'mail'`, in the same `attention` events, bootstrap and sync as the chats'.
`mail_thread.listed` follows, and the bootstrap's window carries every listed thread. The page's inbox rows are
`{ kind: 'conv' } | { kind: 'mail' }` (`web/src/model.ts`). With no mail account the inbox is the chats' as before.
Opening a mail row is in the activity log as a stay on the thread's id (`mth_…`): the learned order skips it for now
(no chat candidate has that id) and slice 10 learns from it.
Tests: `hub/test/mail-classify.test.ts`, `mail-attention.test.ts`, `web/test/inbox-mail.test.ts`; `verify-inbox.ts`
(mixed rows) and `verify-mail.ts` (Updates and People on a phone and a desktop in both themes, Not a person).

## Search (slice 7)

- **Where.** Mail's search button (beside the folders) puts a search box in place of the list. A search is a list key,
  `s:<query>` (protocol `searchList`), so `#/mail/l/s%3A<query>` links to one and a thread opens beside its results as
  from any list, and back returns to them. Chips: Unread, Starred, Attachment. The search page gets a **Mail** group
  above the chats' results: the hub's own top five threads and the way into Mail's search. It shows only while the hub
  has mail and the query means something in mail (`mailSearchable`), and it is a request of its own, drawn by Mail's
  chunk, so the chats' results never wait for it (docs/search.md).
- **The language** is chat search's (docs/search.md: words in any order, the last a prefix, `"phrases"`, `-word`, accents
  folded) read with mail's operators, `parseSearch(q, now, 'mail')`. Chat's own operators are words there, and mail's
  are words in chat search:

  | Operator | Means |
  |---|---|
  | `from:sam` | the sender's name or address contains it, or the sender is someone whose name (or any of whose identities' names, on any network) does; a person's or identity's id works too |
  | `to:jo`, `cc:jo` | the same, in To or Cc |
  | `with:alex` | either side: From, To or Cc |
  | `subject:lease` | words in the subject (the last a prefix) |
  | `in:archive`, `in:"Work/Clients"`, `in:anywhere` | a mailbox by role (inbox, sent, drafts, archive, spam or junk, trash), name or path. Junk and Trash are searched only when named, or with `in:anywhere` |
  | `label:work` | a Gmail or Proton label, or a folder of that name |
  | `has:attachment` | with a file |
  | `is:unread`, `is:read`, `is:starred` (or `is:flagged`) | as the hub has it |
  | `account:proton`, `account:me@x.org` | one mail account, by label, address, kind or id |
  | `before:`, `after:`, `during:`, `sort:oldest` | as in chat search, on when the server got it |

- **The hub's own index** (`hub/src/mail/schema-search.sql`, `mail/search.ts`): `mail_search` holds what each message is
  found by (its subject; From, To and Cc names and addresses; its body's search text once fetched, else its preview)
  beside what a search groups and filters by (account, thread, time, "only in Junk or Trash"), and `mail_fts` indexes
  it. Triggers on `mail_message`, `mail_text`, `mail_location` and `mailbox` keep both current, so anything that
  stores a message or a body is searchable without calling anything: the first sync, a server search, the reader, and
  bodies fetched ahead alike. The body's search text is slice 2's `mail_text` (the first 16 KB, kept after the body
  cache lets the body go, under the one cap `DITHER_MAIL_INDEX_MB`): a row stored sets it here, and a row the cap
  drops puts the preview back. Hits are threads, newest matching message first, with how many of their messages matched and the
  matched words marked; paged by cursor. As chat search does, nothing found as whole words searches inside words, and
  still nothing corrects misspelt words from `mail_fts_vocab`.
- **The servers.** `GET /api/mail/search?q=&cursor=&limit=&server=0|1|auto`. The page shows the hub's own hits at once,
  then asks the servers (`server=1`) when those are under 20 threads, or when you ask ("Search the servers too");
  `auto` is the same rule on the hub. Each account gets `mail.search` at P0, 50 at most, 20 s at most. Gmail gets the
  query in its own syntax (X-GM-RAW; an account is Gmail by its address or its `[Gmail]` folders); other IMAP servers
  and Proton get the words, with the values of `from:`, `to:`, `with:` and `subject:` as words. What they answer is
  stored as listed summaries (so it opens like any other, and `ingested` goes out), the query's other operators are
  checked here, and only threads the hub's own search had not found (with what it held before) show, after its own,
  under "On the server". **Proton's server matches subjects and addresses only**: its answer says so (`note`), and a
  Proton message's text is found here once its body has been fetched. A server that fails or is offline says so under
  the results; the hub's own hits show regardless.
- **Speed**, from `bun scripts/measure-mail-search.ts` on a made-up mailbox of 50,000 messages in 16,658 threads, every
  message with a fetched body (the worst case for the index: 25.8 MB of search text; 95 MB for `mail_text` and the
  search tables together, in a 203 MB database; storing them took 85 s), on the shared 16-core machine, median of 7,
  the first page of 50 threads:

  | Query | ms |
  |---|---|
  | a rare word (in 0.2% of messages) | 1.4 |
  | a word in a quarter of them; its second page | 12; 12 |
  | a word in nearly all, like "the" or a domain | 74 |
  | two words; a word and `after:` | 11; 11 |
  | `subject:` a word | 0.8 |
  | `from:` someone; a word and `from:` | 21; 21 |
  | `is:unread`; `has:attachment in:archive` (filters only) | 47; 62 |
  | inside words (no whole word matched); nothing matched at all | 103; 65 |
  | a misspelt word, corrected | 100 |

  The first version took 358 ms for the "nearly all" word: joining every match to `mail_message` and checking its
  mailboxes one by one. The columns beside the text and marking the snippet in JS rather than with FTS5's `snippet()`
  brought it under 80.
- **Tests**: `hub/test/mail-search.test.ts` (the operators; people by any of their names; inside words, CJK and
  corrections; paging; a body fetched ahead found with no call; the text kept past the body cache, and the preview
  back under slice 2's cap; Junk moves and thread moves; the hub's hits then the server's; deduplication; operators
  on server hits; Proton's note; a failed and an offline server; the route); `verify-mail.ts`'s search run.

## Triage and notifications (slice 9)

- **New mail from a person is triaged** like a chat message (`hub/src/mail/triage.ts`): one of the four levels
  (Important, Active, Digest, Not interesting), from chat's own decision model and chat's votes
  ([notifications.md](notifications.md)). Mail that arrives (`ingested` with `live`) is triaged and may notify; what a
  sync, a backfill or a search lists never notifies (but see "quietly" below). Bulk is never triaged: no
  notification, no digest. Yours and drafts are not either.
- **Where it starts.** Someone you correspond with (you wrote to them, they wrote in a thread of yours, or you merged
  them with a chat contact) who wrote to you (To): Important. The same in Cc: Active. A list or Bcc from them, and
  anything from a sender nobody knows: the digest, if it says enough ("to you", a question, a reply to you, urgency),
  else below it. A starred person: Important. Your votes move it from there, as in chat.
- **The facts** are chat's, from mail: network `email`, shape `mail`, the thread as the conversation, the mail
  account as the space, the author as their person (else identity), you in To as a mention, Cc or a list as
  `everyone`, a reply to one of yours, a question or urgency in the subject or text, a link, an attachment, long
  (over 1,500 characters above the quote). The model reads the subject and the first 2 KB of text above any quote.
  `native` and `notify` are left out, so mail votes leave what chat learned about them alone.
- **Shared with chat.** Votes on mail join chat's examples (`TriageVotes.others`), so one vote on Sam's mail moves
  Sam's chances on Signal once the two are one person, and the reverse. The author is read as it is now, so a merge
  after the vote counts. With no mail votes, chat's policy and decisions are what they were (checked on a demo hub
  against origin/main: the same 54 decisions, the same policy before and after a chat vote).
- **What keeps it quiet**: a body that warns of spoofing (a name that is another address, Reply-To elsewhere, a
  link that says one site and goes to another) holds it at Active at most, whatever was learned. Quiet hours hold
  Important and Active as chat's, into the same summary. Mail that reached the server over an hour before it came
  here (a catch-up), mail already read, mail outside Inbox and muted threads (silent) are rated but notify nobody.
- **The body first.** A new personal message's body is fetched on arrival (slice 2) and moved up to keep-up priority
  when it may notify; triage waits for it at most 5 s, then decides on what is there.
- **One notification per thread** (`deliverMail` in `hub/src/main.ts`, `delivery.ts`): the sender as the title,
  "subject — start of the text" as the body, the person's picture with the email mark, and the thread's unread
  lines, the subject before the first. It buzzes once a burst, as chat's; reading the thread anywhere (here, in
  another mail app, or answering) takes it off the phones. Its conversation is the thread, which opens the reader
  beside the inbox (`#/inbox/c/<thread>`, as a mail row does) in the browser and in the Android app as they are; the
  push and the live `notify` event also carry `mailThreadId`.
- **Device rules** (`devices.ts`): a mail thread's chain is the thread, its mail account, then Email. Settings →
  Notifications → Each device lists Email (and each mail account when there are several), so "Email off on the
  phone" works. "Mentions only" keeps mail with you in To or answering you.
- **Votes**: on the Triage board, where mail is listed beside chat with an envelope and "by email"; from the
  notification (Important: ▼ Active, ✓ Right; Active: ▲ Important, ▼ Digest); and in the reader, where a triaged
  message has a Notification button with why, the three chances and the four levels. They go to
  `POST /api/messages/:id/feedback` like chat's (or `POST /api/mail/triage/:id/vote`). "Not a person" is a vote
  down on the thread's newest decision.
- **A sender nobody knows** reaches the one-list inbox only when triage rates the thread's newest message Active or
  above, by the model or your vote (§14 Q4, `mailAttention(hub).triage`).
- **Quietly, what a sync found** (`MailTriage.sweep`). A stranger's thread that was already there when the account was
  added never arrived live, so it would never be rated and never listed. So the threads the one-list inbox could list
  (its window: unread within 30 days, mail in the last week, opened, owed; never a year of mail) from a sender
  nobody knows, whose newest message has no decision, are rated with the same facts and model, once their body is
  here (asked for, waited for at most a minute), 30 an account a pass, after a sync brings mail and every 5
  minutes. Such a decision has `quiet = 1` and says "Rated after a sync found it: no notification": it never
  notifies, is never held by quiet hours, is never a line of a later notification, and never counts as a
  notification you let stand; it only decides the listing, and shows on the board and in the reader so you can vote
  on it. On an account whose summaries carry no headers it waits until the steps below are done.

How: `mail_triage` (`schema-triage.sql`) keeps each decision with its facts, words, chances, whether it notified and
your vote; a message the server no longer has keeps its row only if you voted on it, and an account's mail going
(§14 Q6) takes its rows, voted ones keeping their facts but not their words. `GET /api/mail/triage?since=` is the
board's mail (`MailTriageItem`); each thread's view carries its newest decision (`MailThreadView.triage`) and each
message's its own (`MailMessageView.triage`), so the board follows new mail and reads live. The daily digest
notification still counts chat only.
Tests: `hub/test/mail-triage.test.ts` (bulk, a known sender in To, quiet hours, "Email off", a vote on Sam's mail
and Sam on Signal, the inbox for strangers, what a sync found rated quietly, spoofing, late and read mail, lines and
reads, the routes);
`verify-notifications.ts`'s mail run (a demo person answers what you send; the toast, the board, a vote, the reader,
Email off, a phone and the light theme).

## Summaries without headers (Proton)

Proton's lists, events and searches give a message's metadata only: In-Reply-To, References and the list headers
(List-Id, List-Unsubscribe, Precedence, Auto-Submitted) come only with its body (`mail.get`). Until then a newsletter
looks like a stranger's mail. What the hub does about it (`hub/src/mail/headerless.ts`):

- **Which accounts.** The status's `details.summaryHeaders` (dither-accounts: false for Proton, true for IMAP); without
  it, an account none of whose summaries has carried any of those headers yet (`MailStore.headerless`,
  `mail_account.summary_headers` and `headers_seen`).
- **The body's headers count.** `MailStore.putBody` keeps mail.get's list headers in `mail_message.bulk` (threading
  headers it already took), and the thread is classified again in the same transaction.
- **Proton's own sorting.** Its summaries carry Proton's categories as labels (`Category/Newsletters`, also for a
  newsletter subscription, `Category/Transactions`, `Category/Promotions`, `Category/Social`, `Category/Updates`),
  which classify as bulk (§4 rule 8), body or not. Whether an account has Proton's categories turned on is Proton's
  rollout; a newsletter subscription gives `Category/Newsletters` regardless.
- **Once, for mail stored before.** On the first start after this (when the account can work), its mail is listed
  again from the newest, Inbox and then All mail (or Archive), down to the oldest held, at most 5,000 a mailbox
  (`MAIL_LIMITS.relabelMax`), as background pages in the budget: it only refreshes labels and flags, and removes
  nothing. Then the bodies kept before their list headers were, of Inbox mail inside the window still classed
  `unknown`, are fetched again. Each step is marked in `mail_setting` (`relabeled:<account>`, `rebodied:<account>`);
  an account added later lists its mail with the labels already, so it is marked done at once.
- **Bodies ahead for the window.** Besides the 14 days of personal mail, such an account's Inbox mail inside the
  one-list inbox's window (30 days) still from a sender nobody knows has its body fetched ahead, in the same budget
  and the same 300 at most, so its headers say whether it came from a list or answers you. Then triage rates what is
  left, quietly (above).

Tests: `hub/test/mail-headerless.test.ts` (a newsletter leaving the inbox once its body comes, which accounts, the
one-time steps on a restart and not on the next, an account added later, an account with headers).

## Gmail

A Gmail account reaches the hub as dither-accounts' **Email (IMAP)** account with the provider `gmail` (its
`extractors/imap`, with an app password), so its kind is `imap`. The hub knows it is Gmail by its address or by its
`[Gmail]` (or `[Google Mail]`) mailboxes (`MailStore.gmail`), so a Workspace address works too.

**What comes in** (read from the extractor's code, `extractors/imap/src/{imap,ids,config,smtp}.ts` there, and modelled
by `fake.ts`'s `ids: 'gmail'`):

- **Mailboxes**: INBOX; `[Gmail]`, which only holds the others (IMAP \Noselect: no counts, and listing it is 404);
  `[Gmail]/All Mail` with the role `all` (there is no Archive); Drafts, Sent Mail, Spam (`junk`), Starred (`flagged`),
  Trash; `[Gmail]/Important` with the role `important` (from its \Important flag, RFC 8457); and each label as a
  mailbox named by its path (`Travel`, `Work/Clients`). Starred and Important are views, as All Mail is: Move to… does
  not offer them, and filing never moves a message out of them.
- **One message, several places.** A message is a copy in Inbox, All Mail, each of its labels, Starred and Important at
  once, with an id in each (`<mailbox>.<UIDVALIDITY>.<UID>`), and the same `emailId` (X-GM-MSGID) in all of them. The
  hub keys a message by its Message-ID, or without one by that `emailId`, so it stays one message with several
  locations, whichever mailboxes list it and in whatever order. A row stored before summaries had `emailId` (one per
  place) takes it the next time its place is listed and stays the message; Proton's summaries have none, and its rows
  are as they were.
- **Labels** are Gmail's (X-GM-LABELS: `\Inbox`, `\Important`, `\Starred`, `\Sent`, and yours by path). Gmail never names
  \Trash, \Spam or All Mail there, and leaves out the label of the mailbox the message was listed from. The hub puts that
  one back as it stores a summary, so a message's labels read the same whichever mailbox listed it last, and the views
  show only the labels a person gave (`shownLabels`: none starting with `\`).
- **Threads** are Gmail's (X-GM-THRID), your replies included.
- **No categories.** Gmail's Promotions, Social, Updates and Forums are not exposed over IMAP, so §4's rule 8 never
  fires for this account. List mail is known by its headers (List-Id, List-Unsubscribe, Precedence, Auto-Submitted),
  which the extractor puts on every summary.
- **Keeping up** is CONDSTORE (the account's "sync" detail says `CONDSTORE (UID list kept)`): a flag or label changed
  anywhere shows as changed in every mailbox the message is in. IDLE watches Inbox; All Mail and Sent are asked every 15
  minutes, and when the hub's own change touched them.
- **Search** goes to All Mail in Gmail's own syntax (X-GM-RAW, search.ts `serverQuery`).
- **Sending**: Gmail keeps the copy in Sent itself (the preset's Copy to Sent is `server`), and the extractor finds it by
  its Message-ID. It shows once, in its thread, with places in Sent Mail and All Mail.

**Filing on Gmail.** Gmail's MOVE takes the source mailbox's label off and puts the destination's on. Out of All Mail
the extractor COPYs instead, into anything but Trash or Spam (a MOVE out of All Mail is a delete on Gmail): the
destination's label goes on, the message stays in All Mail, and the answer is the copy's id (ops.ts `copyFrom`).

- **Archive** is Inbox → All Mail: \Inbox comes off, the labels stay, and the answer is the All Mail id the hub already
  had, so no new row. It waits 7.5 s before it goes (`MailOps.gmailArchiveHoldMs`), so the page's Undo (7 s) calls it
  off before Gmail hears of it. An Undo after it went (or a slow page) is Move to Inbox, a copy from All Mail.
- **Trash and junk**: Gmail then shows the message in Trash or Spam alone, so the hub drops its other places as soon as
  the move is answered (it is out of All Mail and its labels at once, not after the next changes pass). What you sent is
  not moved: its copy in All Mail is the same message as Sent's, and moving it would take it out of Sent.
- **Back to Inbox** from All Mail is a copy: \Inbox goes back on and its labels stay, from wherever the thread was
  listed, so an archive undone after it went is as it was. The reader offers it (Move to Inbox) for a thread in All
  Mail and not Inbox, and its Undo archives again. From Spam or Trash, where Gmail has it alone, it is a move.
- **Move to a label** from Inbox or another label is a move (that label comes off); from All Mail alone it is a copy.
- **Star, read, unread** are the message's flags: a call on its Inbox copy changes them everywhere; Starred gains or
  loses it.
- `in:archive` (search) is Archive where an account has one, else All Mail without Inbox, Sent or Drafts; Gmail's server
  gets `-in:inbox -in:sent -in:drafts`.

**Checked**: `hub/test/mail-gmail.test.ts` (one message in Inbox, All Mail and a label through the first sync, the
backfill and an opened label, and by `emailId` without a Message-ID, an older row keeping its id; Gmail's thread;
labels from any mailbox; a label as a mailbox and `[Gmail]` never followed; Important's role; archive, Undo before it
goes and after it went, Move to Inbox and to a label from All Mail alone (copies), trash out of All Mail, junk and Not
junk, star, read and unread; changes made in Gmail itself;
search in Gmail's syntax with what only the server has; a reply shown once when Gmail's Sent copy comes; list mail
classified by its headers) and `verify-mail.ts --gmail` (above). **Not checked** against a real Gmail account: a few
of Gmail's ways come from reports, not from seeing them: that X-GM-LABELS leaves out the listing mailbox's label (the
hub copes either way), that MOVE from Inbox to All Mail answers the All Mail id the message had (a new one would only
replace it), that a MOVE out of All Mail deletes (the extractor copies instead), and that a COPY into a mailbox the
message is in already answers the id it has there (a new one would be found by the next changes pass, as the same
message).

**Adding one** (on the owner's side; nothing is added from here):

1. In your Google Account turn on 2-Step Verification (myaccount.google.com → Security), then make an app password
   (Security → App passwords, named "dither-accounts", say). Google shows its 16 letters once. A Workspace account whose
   admin turned off app passwords or IMAP cannot be added this way.
2. On dither-accounts' page: Accounts → add → **Email (IMAP)**: your Gmail address, Provider `gmail`, the app password,
   and your name. Leave the server fields empty (the preset fills imap.gmail.com:993 and smtp.gmail.com:465) and Copy to
   Sent at `auto` (Gmail keeps its own).
3. The hub sees it within seconds under its existing `mail` grant and syncs it: Accounts → Mail shows it online; Mail's
   account menu has it, and the mailboxes menu its labels. Its "sync" detail should say CONDSTORE; dither-accounts'
   docs/mail.md has a checklist for what only a real mailbox shows.

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
`DITHER_MAIL_INDEX_MB` (300 MB of search text).

## Big mailboxes (slice 2)

- **How far back.** After the first sync, each account goes on listing older mail in the background, 200 summaries a
  page: Inbox and Sent back a year (`DITHER_MAIL_SYNC_DAYS`), then All mail (else Archive) back a year, then the rest of
  Inbox to its end (the design's §14 Q2). It stops at 150,000 summaries an account (`DITHER_MAIL_MAX`).
- **Older than that, as you scroll.** A list loads its next page as you near its end. When the hub has no more of it
  and the mailbox has more on the server, the hub fetches the next page then, ahead of anything in the background, and
  waits up to 8 s for it; past that the list says "Fetching older mail from the server…" and the rows come as they
  arrive.
- **Other folders** (Junk, your own) are listed the first time you open one: its first page at once, the rest as you
  scroll. From then on the hub keeps it up like the others, every minute while a page shows it.
- **Bodies ahead**: the newest 300 personal messages of the last 14 days (once the sync reaches back past those 14
  days in every mailbox it follows, so mail still on its way does not push more in), new personal mail as it arrives,
  and the first 20 rows of each list you open, so their previews show. On an account whose summaries carry no
  headers, also its Inbox mail of the last 30 days still from a sender nobody knows ("Summaries without headers"). "Personal" is the message's class once slice 8 sets it;
  until then, mail to you or Cc'd to you, without list headers, from an address that does not look automated.
- **The body cache**: 500 MB (`DITHER_MAIL_CACHE_MB`); past it, the least recently read go first, down to 90%. Starred
  mail stays, and so does a body an outbox item needs (`mail_body.keep = 1`). A body over 2 MB is kept only while it is
  read (10 minutes). An evicted body is fetched again when it is opened or its HTML, a `cid:` picture or a file is
  asked for (slice 3's files stay in the media cache), and its row keeps its preview.
- **Search text**: the first 16 KB of each body's text (`mail_text`), kept after the body goes; 300 MB in all
  (`DITHER_MAIL_INDEX_MB`), the oldest mail's going first.
- **The summary cap**: past 150,000, an hourly sweep drops the oldest summaries outside Inbox (not starred, not in a
  thread opened in the last week). Each mailbox they left goes back to where its listing can find them again
  (`mail_page`), so scrolling there fetches them.
- **The progress line** under the list: "Syncing · 2,300" during the first sync, "Syncing older mail · 12,400, back to
  3 Mar 2025" during the backfill, "Refreshing…" while a mailbox is listed again after a 410.
- **Timers**: a mailbox a page showed in the last 2 minutes is checked every minute; on a server that syncs by
  comparing flags, a mailbox over 10,000 messages every 30 minutes instead of 15.

**The budget.** Each account's queue has four priorities and two slots (`hub/src/mail/queue.ts`). What a page waits for
(a body, a page past what the hub holds) and keeping up go at once. Bodies ahead and the backfill together start at most
2 calls a second, on one of the two slots, and none for 10 s after a call a page waited for, so reading and scrolling
never queue behind the backfill (`hub/src/mail/backfill.ts` `Budget`). The manager's own limit is 50 reads a second.

**What pages are sent.** During a backfill threads change all the time. A changed thread goes to the pages
(`mail.threads`) only when it is among the newest 200 of a mailbox it is in, listed in the one-list inbox, opened in
the last hour, or asked for by a page in the last 10 minutes. The rest send `mail.lists {stale}`, naming the lists they
are in (`w:*` for every list of mail with someone); it is journaled, so a page that was away hears it too. A stale list
keeps showing what it has and loads again when it next shows.

**Measured** (`hub/test/mail-load.test.ts`, 2026-11-08, on the shared machine, which was busy). 60,000 messages on a
fake server: Inbox 12,000, Sent 6,000 and Archive 42,000, each spread over three years, in threads of three.

| | |
|---|---|
| First screen | after 3 calls (mailboxes, Inbox's state, Inbox's newest 50): 34-41 ms |
| First sync (Inbox and Sent to 500) | 0.2 s |
| Backfill, unthrottled | 28,200 summaries in 9,334 threads: 147 list pages and 300 bodies, 7-18 s in the test (it stops to measure the heap), about 4 s without |
| Backfill at the budget | about 3.7 minutes for those 447 calls; the demo hub ran at 2 pages, 400 summaries, a second |
| Database | 25.8 MB for 28,200 summaries: about 960 bytes a summary with its indexes and slice 6's people (50,000: about 48 MB) |
| Heap | flat: 77-82 MB from 5,000 to 28,000 summaries held, within 1 MB in each run |
| Threads sent to pages during the backfill | 600 of 9,334 |
| A page past the horizon | 100-400 ms: one list call, ahead of the background |

The test prints these on every run. Bodies' sizes depend on the mail, so the body cache was measured only by count.

**Running it.** `bun test packages/hub/test/mail-load.test.ts` takes about 30 s. A demo hub with a big mailbox:
`DITHER_DEMO_MAIL_BIG=1` adds 40,000 Archive messages over three years, 400 older Inbox messages and an unsynced
"Projects" folder of 1,000, on a fake server that answers in 250 ms. `bun scripts/verify-mail.ts <hub> [shots] --big`
then checks endless scroll, the progress line, a folder opened for the first time, and older mail fetched past what the
hub holds, at 390 px and on a desktop in both themes, before its usual checks.

**For later slices.**

- Search (7) follows `mail_text` (message_id, text) with triggers (schema-search.sql): it has the first 16 KB of each
  fetched body's text by the time MailHub's `body` event fires, for bodies fetched ahead too; `searchText(store, id)`
  (`hub/src/mail/cache.ts`) reads it. A row goes with its message (`ON DELETE CASCADE`) and under the cap.
  `deleted` also fires for summaries the cap drops.
- Classification (8): once `mail_message.class` is set, bodies ahead go by it; `mail_thread.listed = 1` keeps a
  thread in the live window.
- Triage (9): a new personal message's body is fetched on arrival; its `body` event says when it is here.
- Filing (4): `bigOf(hub)?.window.want(threadIds)` (`backfill.ts`) sends threads you acted on as they change.
- Sending (5): `UPDATE mail_body SET keep = 1` keeps a body out of eviction.

## How it keeps up

Mail lives in its own tables in the hub's database (`hub/src/mail/schema.sql`). A message is keyed by its account and
Message-ID, so a move on the server keeps the hub's message, its thread and its body; the extractor's ids are only
where it is. Without a Message-ID it is the server's `emailId` (Gmail's X-GM-MSGID, the same in every mailbox) that
makes it one message; with neither, each place is a message of its own (store.ts `identify`). Threads come from the server's thread ids (Gmail, Proton), else from In-Reply-To and References (on
summaries since dither-accounts 515f26d, and from bodies), else, provisionally, from the subject and the people on it.

On the first sync the hub takes a `mail.changes` state for Inbox, Sent and All (or Archive) before listing, so nothing
that arrives meanwhile is missed. After that: `mail.arrived` is stored at once, `mail.changed` queues a changes pass,
and a timer checks Inbox every 5 minutes and the rest every 15 in case an event was lost. The manager coming back, a
gap, the account coming online and the hub starting each catch up the same way. A state that is too old (410) lists
the mailbox again and drops what is no longer there. A message removed from one mailbox is deleted only after the
others were asked, because an IMAP move is a removal there and an addition elsewhere.

## Running it locally

- A demo hub has a mail account of its own, on a fake server (`hub/src/mail/fake.ts`, seeded by `seedDemoMail` in
  `hub/src/demo.ts`): a reply thread, a Cc'd thread with a file, list mail, an HTML-only message with a tracker and
  scripts, and an old receipt in a folder the hub does not follow, which only a search of the server finds.

      bun packages/hub/src/main.ts --demo --data /tmp/mail-demo --port 8700 --web <built web>
      bun scripts/verify-mail.ts http://127.0.0.1:8700 [screenshot dir]

  The demo's people answer what you send them 3 s later (`FakeOpts.answer`), so a demo hub notifies about mail.
  `DITHER_MAIL_HOLD_MS=500` shortens the 10 s Undo for scripts (`verify-notifications.ts` uses it).

  verify-mail drives it in headless Chromium on a phone (390 px, touch) and a desktop, in the dark and light themes:
  no page errors, nothing off the side of the screen, list → thread → back on a phone, the quote fold, read here, and
  the HTML-only message; the views in one row of chips, every folded message with a snippet (yours too), the phone
  reader's subject whole or on two lines beside Archive and ⋯, and the reply it sends shown as text. Its `--proton` run
  (two accounts) also checks the account picker under "Mail". `DITHER_DEMO_MAIL_GMAIL=1` adds a Gmail account (a trip
  labelled Travel and marked Important, that you answered; Mom's photos under Family; a starred recipe; a booking
  archived under Travel; list mail), and `--gmail` checks it ("Gmail" above). Use a fresh data dir each run: reading marks threads read. With `--html` it also checks the
  frame (slice 3): no script runs in it, not even one put there by hand; no request leaves for anywhere but the hub;
  link clicks go through the opener, and a misleading one asks first; the image banner and the proxy; quotes, `cid:`
  pictures, files in the viewers; swiping back over a body. The demo's remote images are drawn by the hub itself
  (`hub/src/mail/demo-html.ts`), so a demo hub reaches nothing outside.
- Tests: `hub/test/mail-thread.test.ts` (threading, as a table), `mail-store.test.ts`, `mail-sync.test.ts` (the fake:
  first-sync order, `more`, 410, moves, Proton-like state, arrivals, gaps, the manager away, access ending, the delta
  sync), `mail-ops.test.ts` (writes on the fake: pending, batches of 1000, 404/403/501/410, a restart with changes
  waiting, the manager away, read in view and its setting, a read grant), `mail-gmail.test.ts` (a Gmail account:
  "Gmail" above) and `web/test/mail-model.test.ts`, `mail-text.test.ts`, `mail-ops.test.ts`.
- Slice 3: `mail-sanitize.test.ts` (a hostile corpus, each output parsed again against the allowlist),
  `mail-images.test.ts` (the token, private addresses in every spelling, DNS rebinding, redirects, not-an-image, size,
  headers) and `mail-parts.test.ts` (the routes on the fake).
- Sending: `hub/test/mail-compose.test.ts` (recipients, subjects, quotes, the HTML part) and `mail-send.test.ts` (the
  fake: held and undone, 501 turning sending off with the message kept, a read grant, a dry run, retries and a timeout,
  files by path and by their bytes, a forward's files, From, a recipient or settings refused (422), a clientId sent
  once, a restart mid-send).
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
  itself calls these rather than writing flags or locations. (Not a person files nothing: Updates is a view.)
- **Stopping**: `MailHub.stopping` takes what a slice stops with the hub (its timers and background steps): slice 2's
  sweeps and prefetch timers and slice 8's background steps are there, so nothing touches the database after `stop()`.
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
- **Classification and the inbox** (slice 8): `mailClassifier(hub)` (`hub/src/mail/classify.ts`): `changed` (after
  a thread's class or `unknown` changed), `person()`/`setSender()`/`setThread()` for overrides, and the `override`
  event ("Not a person" is a vote down). `mailAttention(hub)` (`hub/src/mail/attention.ts`): `triage(threadId)` is
  where triage's rating lets a sender nobody knows into the inbox (Active or above; no until slice 9),
  `triageFacts(messageIds)` gives the fold triage's pushes and questions, and `isListed`/`input`/`view` read a
  thread's listing and attention. A thread's class is `mail_thread.class` (`MailThreadView.class`, `unknown`), its
  owed time `MailThreadView.owedSince`, its inbox score `Attention.view(<thread id>)`.
- **Search** (slice 7): whatever stores a message, or a body's text in `mail_text`, is indexed by schema-search.sql's
  triggers, with no call. `mailSearchOf(hub)` is the hub's `MailSearch`; `local(q)` is the hub's own search,
  `search(q, { server })` adds the servers'. `mail_search.shut` marks messages only in Junk or Trash.
- **Triage** (slice 9): `mailTriage(hub)` (`hub/src/mail/triage.ts`): `rated(threadId)`, `factsOf(messageIds)`,
  `items(since)` (the board's), `chain(threadId)` for device rules, `gather`/`readTs` for delivery.ts. Each decision
  is a `mail_triage` row; `delivered` says a notification went out, `feedback` is your vote. The activity log's
  notification rows for mail carry the mail message and thread ids, which slice 10 can join to opens.
- `protocol/src/mail-iface.ts` is a copy of dither-accounts' interface types; `bun scripts/accounts-sync.ts --check`
  says when it differs.
