# Mail

Email beside your chats, through dither-accounts' `mail` interface. The design, with the owner's decisions, is
[mail-design.md](mail-design.md); it is built in slices (its §12). This page says what works now and how to run it.

## What works (slice 1: read-only mail, end to end)

- **Mail in the rail**, after People, once the hub can read mail. A dot while Inbox has unread threads. On a phone it
  sits in Home with the rest; Ctrl+K finds Mail, its views and each mailbox.
- **The list**: Inbox (ranked, or newest first), Updates and Everything across every account as chips under the
  Inbox's header, with **More ⌄** holding Starred and Sent (newest first, of the accounts showing) above each account's
  mailboxes (docs/inbox.md "Mail lists"). **Everything** is the whole of Inbox, Updates too, newest first (`v:all:<scope>`); the old People and
  Unread views have no chip but their links (`v:people:*`, `v:unread:*`) still list. Under "Mail", **whose mail** is two wheels (`ui/mail/ScopeWheel.tsx`):
  the platform (All mail, then Gmail, Proton, Outlook, Email: `mailPlatform`, by kind and address) when there is more
  than one, then the account (All of that platform's, or one) when it has more than one. Each shows the choice in use
  with dots for how many there are; a click turns it to the next (Shift+click back), as do the mouse wheel, a drag up or
  down and the arrow keys, and the words slide as it turns. A platform is the list key `v:<view>:k.<platform>`, paged by
  the hub over that platform's accounts. A right-click or long press opens the account menu: All accounts and each
  account with its colour's dot, the dot rows show before the sender's name when every account shows (the menu says
  so), its Inbox unread count, and a second line, its kind or what is wrong with it, with a way to it in dither-accounts.
- **Accounts that aren't working** get a small muted warning sign beside their name on the wheels (and beside the
  platform and All that hold them), the problem in its tooltip; with one account it links to dither-accounts. A problem
  says nothing for its first 10 seconds (`PROBLEM_GRACE_MS`, from the problem's `since`), so one that comes and goes
  never shows; lost access shows at once.
- **Ranked** (`web/src/mail/model.ts` `rankedThreads`): Inbox puts first the threads the one-list inbox scores (each
  mail `AttentionView`, below), in that inbox's own snapshot (`inbox.ts`), so a row moves only when the inbox's rows
  would: never while a pointer, a finger, a menu or the keyboard is on a list, and the thread open in the reader keeps
  its place until you leave it. Whatever score the hub sends is used, the learned order's too once it ranks mail. Under
  a faint "The rest, newest first" line come the threads with no score (mail you have not had for a week and owe
  nothing on, a sender nobody knows, anything not classified yet) by date, with the Updates row where its newest sorts
  among them. They get no made-up score: a cheap one would only reorder old mail by guesswork, and by date it pages
  as it always has. The hub pages Inbox by date (`<lastAt>:<id>` cursors) as before, and every scored thread comes in
  the bootstrap's window, so the ranked rows are all there from the start and paging never meets a moving score.
  **Newest**: tap the Ranked chip again (its two arrows say it turns) and Inbox is by date, the chip says Newest; tap it again to rank.
  The choice is this device's (`prefs.mailOrder`). Everything, Updates, Starred, Sent and mailboxes are always by date.
- **Rows**: threads newest first, bold while unread, with who wrote ("Alex, Jo, me"), how many messages, the subject, a
  star and a paper clip; each line ends in an ellipsis.
- **The reader**: a thread's messages oldest first. Unread messages and the latest are open, the rest fold to a line:
  who and the start of the text. Bodies ahead skip what you sent (and older mail), so when a thread opens the reader
  asks for the bodies of its folded messages that have no preview yet (the newest 20, after the open ones), which the
  hub fetches at once, as any body a page waits for. Each open message shows its sender with the address, To and Cc,
  and ▾ for the rest of the headers. The body is the message's text, with links, never Markdown; quoted text folds
  behind ···. An HTML-only message shows the text its HTML makes. On a phone the subject takes up to two lines, then an
  ellipsis.
- **Read here**: a thread that has been on screen for a second counts as read on the hub. Slice 4 (below) tells the
  server too, unless Settings says "only when I mark it".
- **Accounts** lists the mail accounts with the others, one list ([accounts.md](accounts.md), "One list"): a mail icon,
  a dot on it when something is wrong; the account's page has its Mail section (what is wrong, "Sign in to Proton in
  the live view" with the live view, "Sending is off: …", what is held, and "Hasn't synced in 3 h: <the last failure>"
  once its followed mailboxes have gone half an hour without a changes pass that worked while passes fail, or an hour
  with none failing; the account view's `sync.stateAt`, `error` and `failures`). **Settings → Mail** links to those pages.
  Proton Mail is added from Add account once dither-accounts lets the hub add it; the other kinds on the manager's page,
  or from Add account after asking ([accounts.md](accounts.md), "Adding mail").
- **When access ends** (the account leaves the manager's list, or the hub's grant goes), its mail stays readable for
  24 hours and then is deleted from the hub. "Delete now" does it at once.
- **Offline**: the page keeps the threads it was showing and the last threads and bodies it opened, so they show
  before the hub answers.

Big mailboxes (older mail, other folders, bodies ahead), search and notifications (slice 9) have sections of their
own below.

## People (slice 6)

The people you write to by mail join the people the hub already knows (`hub/src/mail/people.ts`).

- **Who becomes someone.** Everyone you wrote to (To or Cc, not a draft), and everyone who wrote in a thread you wrote
  in, gets an identity on the `email` network (its address is its id and handle) and a person of their own, as a DM
  partner does. Their name is the one on their latest From, else the one you wrote to them under. Anyone else who
  writes to you stays an address, unless classification (slice 8) calls their mail personal: then they get an
  identity, without a person. Newsletters and notifications never do. Your own addresses are identities of yours
  (the self person, "Mail as chats"), never anyone else's.
- **Never by name.** Sam by mail and Sam on Signal stay two people until you merge them. A profile's "Same name
  elsewhere" hint says who and where ("Alice Chen <alice@…>", "Alice Chen on Signal and Discord"), and the merge
  search finds people by an address too, and the email identities no person holds yet.
- **A profile's mail**, in its **Between you** list beside their messages: their newest threads across every mail
  account, how many there are, and All mail, the list `w:<person>` in Mail (`withList`: every thread they are on, in any mailbox). A merge carries the
  mail: the merged person's card and list hold every thread of every address of theirs, and a split takes it back.
  An email-only person asks no network for a profile, and has no chat banner.
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
`scripts/verify-profile.ts` (the mail in Between you on a desktop in the dark theme and a phone in the light one, the reader's
sender, all mail with them, the hint, the merge search by address, merge and split).

## Mail as chats

There is no Mail page of its own: mail is read where the chats are (`hub/src/mail/places.ts`, `mail/chatpage.ts`,
`hub/src/rungs.ts`). Ids stay mail's own (`mth_` threads, `mml_` messages): mail is read with the chats when a page is
asked for, never copied into the message table.

- **Where a thread goes** (`placeOf`): into the chat of the one person it is with, `person:<id>` (the chat that already
  holds their Signal, Discord and other direct messages, docs/chats.md), when it is not bulk and every other address on
  it (`mail_party`, less every one of your accounts' own) is an email identity of that same person, and that person
  is not you. Anything else is a chat of its own, keyed by the thread's id: more people, a sender with no person, a
  newsletter, a note to yourself. Worked out from who is on it each time it is asked, never stored, so a Cc added
  later, a merge or a split moves it at once.
- **Routes by email.** A person's chat gets a route (`ChatRoute`, network `email`) for each of your mail accounts and
  each address of theirs it has such threads with: `email:<account>:<address>` (address lower-cased), which is also
  the `conversationId` of its messages. A thread with two of their addresses goes on the route of the one that wrote
  last. `MailChatView` says the rest: its threads newest first (the latest is where a reply goes), unread messages,
  the latest subject and preview. These routes have no conversation row: a chat's default route may be one (the page
  sends that mail through `POST /api/mail/send`), but `POST /api/chats/:id/messages` never sends through one (asked
  for one by name, it answers 409).
- **Yours.** Each of your mail addresses is an email identity of the self person (`Store.ownEmailIdentity`, made as
  a chat account's own identity is, when mail is connected and when an account's addresses change), so the page's
  `isSelfIdentity` knows mail you sent. Someone with no identity (a newsletter) is given one in the page only, by the
  id an identity of that address would have.
- **A mail as a chat message** (`MessageView.mail`, `MessageMailView`): `ts` is when it reached the server, as mail
  sorts; the body is the words above the quote when the body is here, else the preview; `rich` when its HTML is more
  than plain text would show (what the reader's body renderers decide); `quoted` when there is quoted text under it;
  `blocks`, its words with their formatting, when its HTML can be told that way (below); 
  `opens` on the first message of its thread; `inReplyTo`, the Message-ID it answers. One mail that reached two of
  your accounts (two rows with one Message-ID) is shown once in a person's chat, as its earliest copy, with both
  accounts in `seenVia`. `only`, on a mail of yours in a thread with others that went to fewer of them than are on it
  (`mail_thread.participants`, less your addresses), lists who it went to, so the thread says "to Alice only".
- **Formatted words** (`MailBlock`, `MailInline`, hub `mail/blocks.ts`, tests `hub/test/mail-blocks.test.ts`): the hub
  walks the sanitised HTML (never the raw mail) with HTMLRewriter into a small tree: paragraphs (their lines split by
  breaks), headings, lists (ordered, with a start), quotes, code blocks and rules; bold, italic, underline, struck
  through, inline code, links (http(s) and mailto only) and line breaks. Whitespace collapses as HTML does, a `<div>`
  is a line, an empty line ends a paragraph, and it stops where the quoted mail starts (a quote the sanitiser marked
  that only more quotes follow, with an "On … wrote:" line right above it; a quote with an answer after it stays as a
  quote). Sent as `blocks` on the body's view (`MailBodyView.blocks`) and on a chat page's mail when the tree says
  more than the text part: formatting of its own, no text part (an HTML-only mail: the flattener's "• " and
  "text [href]" do not show), or HTML that is not plain (a personal mail with a logo keeps its bold). No tree for a
  designed mail: a table, a picture that is not small (over 200 × 120 px, or of no known size), more than three small
  ones (a small one is left out of the words), more than one element with a background; and none past 400 nodes or
  8 KB of JSON above the quote. Kept beside the sanitiser's cached result. `MessageView.body` stays the plain text,
  so search, excerpts and notifications are as they were. The chat (`ui/MailChat.tsx`) draws the tree as elements,
  never as HTML: headings sized for a chat row, code blocks and anything wide scrolling sideways inside the message; a
  link shows its words, or its address shortened when its words are its address, opens as chat's links do, and one
  whose words name another site asks first (`ui/mail/linkOut.tsx`, shared with the frame). Plain text is never read
  as Markdown: a text-only mail is drawn as before. Markdown sent from the chat box comes back drawn with its
  formatting, from the HTML it was sent as.
- **A designed mail** (`rich` with no `blocks`: newsletters, receipts, a letter with a photo in it) shows as it was
  sent, in place, without a click: the frame "Show as sent" opens (`HtmlBody`, the same picture and tracker policy,
  nothing loads that it would not load), mounted only once the message comes within 600 px of the view, its height
  capped at about 60% of the pane with a fade and "Show all" (`ui/mail/ChatMail.tsx` `Capped`). "Just the words" folds
  it back to its words (for the session), where … has "Show as sent" again.
- **Letter furniture** (`web/src/mail/letter.ts`, `web/test/mail-letter.test.ts`): a chat draws a mail's words as a
  chat message, in a person's chat and in a group thread alike. Folded behind a faint … at the end of the last line:
  only what is certainly not the message, what follows a `-- ` line (the delimiter itself is never drawn) and a last line that is only the sender's name (first name, full name, or
  their identity's, person's or your account's name). An unsure tail ("Best,\nSam", "Thanks!", "Love, Mom", "Sent from
  my phone") stays in place, small and faint. A greeting ("Hi both,") stays full size, with no blank line after it.
  A run of blank lines is one small gap. A link shows as its host and a short path (the middle cut out), the full
  address on hover and in its long-press menu. Formatted mail (`blocks`) has the same furniture (`letterBlocks`):
  each paragraph's lines are read as text for the name, the sign-off, the greeting and the signature's `-- `, and
  drawn with their formatting; a list, a quote or a code block is never furniture. The … shows only when it hides something: the folded lines, the quoted
  mail (unless it answers the message drawn right above it), and "Show as sent" for a mail whose HTML plain text would
  lose. A click or tap opens them under the message, and another closes them.
- **The line over the box** (web `ui/MailChat.tsx`) holds pills, not captions. In a person's chat, after "To Sam
  Rivera", the thread the mail goes into (`✉ Dinner on Friday? ⌄`): its list has "New subject…" first, then your
  threads with them newest first; New subject turns the pill into a field of its size, and Esc puts the thread back.
  In a thread's own chat, who the answer goes to: up to two names, else "Everyone · N", with Everyone, Only <each
  person> and Full editor. "Only Alice" sends the reply all to her alone (`mail/chatsend.ts`), says "Reply to Alice
  only" in the box, and is everyone again after the send. A pill at rest is a neutral fill; it is outlined while its
  list is open or when it is not at its default. Subjects are drawn without their Re: and Fwd: (`bareSubject`);
  what is sent keeps them.
- **The subject tag** in a message's head, where the thread changes, has the pill's envelope and bare subject. A
  click or tap opens the thread's card ("3 mails · with Sam Rivera · newest today") with Archive and Star;
  archiving says "Archived · Undo", and an archived thread's tags show the archive glyph. Every mail message's menu
  has the same two for its thread: "Archive “Dinner on Friday?”" (or Unarchive) and "Star thread" (or Unstar).
- **A person's chat** (`GET /api/chats/person:<id>/messages?before=<ts>:<id>&limit=`) is their chat timeline and the
  mail of their threads, merged newest first by `(ts, id)` under the one cursor: `limit` counts both, and `hasMore`
  is either side's. A person you only mail with has a chat too.
- **What they wrote elsewhere** (`MessagePage.elsewhere`, `ElsewhereView`): their messages, to you (To or Cc), in
  threads with others, in the page's range (from its oldest message, or the start on the last page, up to where the
  newer page began, or now), newest last. Each has its excerpt (three lines, 280 characters of the words above the
  quote) and `awaits`: to you, or naming you, under a week old, and you have neither written in nor opened the thread
  since (where mail's attention has folded the thread, the turn it says you owe must cover it). The chat
  (`ui/MailChat.tsx` `ElsewhereRows`) draws one row per thread, at their newest message there, under its own day line:
  `✉ <subject> · with <others> · <time> ⌄`. The whole line opens and closes the row; open, it shows the text and
  "Answer there" (or "Open there" when nothing awaits you), which opens the thread at that message with "Back to <their full name>" over it. A thread that awaits
  you starts open, the rest closed; one you closed while it waits says "Waiting on you" at the right. Right-click or
  long-press: "Open in <subject>" and "Hide in this chat"; hidden threads leave a faint "1 hidden thread · Show" line in
  their place. On a narrow row "with …" goes first, then the subject is cut.
- **Rungs** (`RUNGS`: `hidden`, `closed`, `open`): how a thread shows in a person's chat, when you chose
  (`PUT /api/rungs {view, place, rung}`, `null` takes it back; table `place_rung`; `view` is `person:<id>`, `place` the
  thread). Kept on the hub, so a row you closed on one device is closed on the others. Without a choice the row is
  open while it awaits you (`web/src/mail/elsewhere.ts` `rowOpen`). An open or closed choice is for the row it was
  made on: once newer mail of theirs comes to the thread (a row later than the choice), the row starts as rows do
  again. `hidden` stays until Show or Undo; hidden threads are still sent, for the line that counts them.
- **Other chats**: `GET /api/mail/chats/:id/messages?before=&limit=` pages a route by email (its threads only) or one
  thread `mth_…` (any thread, newsletters too) as a chat, in the same shape; `GET /api/mail/chats?person=<id>` lists a
  person's routes. The mail bootstrap carries every route (`MailBootstrap.chats`) and your rungs (`.rungs`).
- **A thread's name** (web `mail/model.ts` `threadName`, used by `mail/chats.ts` for the thread's conversation): its
  subject as drawn (`bareSubject`: no Re:, Fwd:, AW: and the like; what is sent keeps the subject), or with no subject
  its people by first name ("Alice, Jo"). The same in the inbox's row (with the envelope tile and "Jo: …"), the chat's
  header (the tile, the name, and beneath it up to two of the people on it, from its mails' From, To and Cc, then "+3",
  a click listing everyone), the mail
  lists' rows and search hits (the name over who wrote), and Ctrl+K and search's Jump to, which find it by its
  people's names and addresses too. Every thread has the same grey envelope tile. The header's filing is Archive, with
  Star and Trash in ⋯. In a mail message's menu the thread's trash comes last, under a line of its own.
- **Events**: `mail.chats` (routes changed, and `removed` route ids) goes out in the flush that sends `mail.threads`,
  for every person on a thread that changed (new mail, a read, a Cc, a merge or a split, which send their threads
  again); `rung` when one is chosen or taken back.
- **Marking read** what a chat showed: `POST /api/mail/flag {messageIds, seen: true}` marks only those messages.

Tests: `hub/test/mail-chats.test.ts`.

## Sending (slice 5)

- **Writing.** New email in the Inbox header's + (or `c` in a mail list or thread) starts a new message. Reply, Reply all and Forward sit under each message; on
  a phone a bar under the thread answers the latest (`r`, `a`, `f` on a desktop). The composer is a full-screen card on
  a phone and a panel docked at the bottom right on a desktop, so the list stays usable beside it. Its header has ✕ and
  the trash (discard); Attach, Aa (formatting) and Send are along the bottom, Send at the right. It has From (a picker
  when the account sends as several addresses, its status's `self.addresses`), To, Cc and Bcc (Cc and Bcc beside To
  open their lines; an empty one has ✕ to take it away again, and the caret goes to To), the subject and your text. A reply's quote is under
  the text, in sight (see "A forward or a quote" below; deleted, "Quote Sam" puts it back); a forward carries the
  original and its files, each of which can be taken off. Ctrl+Enter
  sends; ✕, Esc or back closes it and keeps the draft.
- **Out of the way, on a desktop** (`web/src/mail/dock.ts`, tested in `web/test/mail-dock.test.ts`): the header drags
  the panel anywhere on screen, and any edge or corner resizes it, the opposite edges staying put (at least 360 × 260,
  at most the window). ⤢ in the header maximizes it to the window, less a 16 px gap (none on a window under 720 × 520),
  and ⤡ puts it back at the size and place it had. − minimizes it to a bar on the bottom edge with the subject; a click
  on the bar or ⌃ opens it again. Minimized, the draft goes on saving, and Escape neither closes nor discards. A
  double-click on the header puts it back at the bottom right. Where it was, its size and whether it was minimized or
  maximized are kept per browser (`localStorage` `dither.mail.dock`, measured from the window's right and bottom edges)
  and it is kept wholly on screen as the window changes size. The phone's card does none of this.
- **Pictures and files, pasted or dropped**: a picture pasted anywhere in the composer (a screenshot, a picture's "Copy
  image") is attached, with a small picture of itself on its chip; one with no name of its own (browsers call them
  `image.png`) is "Pasted picture 2026-11-20 09.05.07.png", numbered when there are several (`web/src/mail/paste.ts`
  `pastedFiles`). When the clipboard also has text, the text is pasted: a document's copy carries a picture of the
  selection beside its text. Files dragged onto the composer are attached too (a dashed outline says it takes them).
  They go as attachments, under the same caps as Attach; not yet in the text (see "Formatting").
- **Recipients** are text until they are chips: Enter, a comma or leaving the box makes them chips, and what is not an
  address stays, marked. A chip opens back into text: Backspace at the start of the box opens the last one with its
  last letter gone (as if it had been text all along), a click opens any one whole; Enter puts it back in its place,
  with its name while the part before @ is the same. Ctrl+Backspace takes the last chip whole, × any one. Suggestions
  come from people (their email addresses), your mail (those you wrote to first) and the account's own server: Gmail's
  and Proton's completion, through dither-accounts' `mail.contacts` (`GET /api/mail/contacts?q=&account=`, the account
  written from first, then any other whose status says `details.contacts`; 2.5 s at most, kept a minute), shown as they
  arrive, each address once. Arrows pick; Enter takes the pick, or an address typed in full as typed.
- **Undo** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y to redo; the browser's own Undo too) goes back through the whole composer,
  not each box: typing (a step per word or pause), a chip made, opened or taken off, a file attached or taken off, the
  quote, From. Discard leaves "Discarded … Undo" in the strip for 8 s; Undo opens the draft again, and only then do
  the draft and its files go (a draft discarded as the page closes stays, rather than being lost).
- **Who a reply goes to** (`hub/src/mail/compose.ts`): the original's Reply-To, else its From; to your own message, its
  To again. Reply all adds its To and Cc without your addresses. `Re: ` once (`Fwd: ` for a forward), whatever markers
  the subject had. From is the address the original came to. The quote is "On Tue, Nov 3, 2026 at 10:42 AM, Sam Lee
  <sam@lee.example> wrote:" and the original's lines after `> `, in the page's time zone; the HTML part is the same text
  made into HTML, the quote in a `blockquote type=cite`.
- **Drafts** live on the hub (dither-accounts has no drafts op), saved 2 s after you stop typing, and on the device at
  once, so a draft written without the hub, or cut off by a reload, is still there. One per thread (`t:<thread>`:
  answering a thread that has one opens it) or `new:<uuid>`. "N drafts" under the views opens them. A draft's files
  stay on the hub an hour after it was last saved or opened (the uploads' own limit).
- **Writing** (`web/src/ui/mail/editor/`): one document, four ways to see and edit it, switched at the right of the
  format bar (Rich · Markdown · HTML · Plain). Each message opens in Rich, or in Plain if it was left there; the view
  is the draft's, not a setting. The old view fades and lifts away as the new one settles in, at the same place in the
  text (no animation with reduced motion). The rich document (Tiptap, a ProseMirror document, `schema.ts`) is the one
  truth: the other views are made from it when opened and put back into it when left, as one step of the editor's
  undo, with the undo before it kept. A view only looked at changes nothing, and every feature of the bar comes back
  the same from an edit in Markdown or HTML. The bar is one stop for Tab; the arrow keys move along it.
  - **Rich** (the default): text as it will look. Bold, italic, underline, struck, colour (eight swatches), link
    (Ctrl+K, or paste an address over the text), bullets, numbers, quote, heading (larger, then smaller, then off),
    code (in the line, or a block over several lines), alignment, a table, Remove formatting (Ctrl+\\); struck, colour,
    heading, code, alignment, tables and Remove formatting wait behind ⋯ (opened, it stays open on the device), so the
    bar and the switch between views are one row; on a phone the row scrolls sideways under the switch. Markdown's
    shortcuts work as you type (`**`, `# `, `- `, `> `). A picture pasted, dropped or chosen goes in the text where the
    caret is (a `data:` URL in the draft; over 5 MB, or not PNG, JPEG, GIF or WebP, it is attached instead); pasted
    anywhere else in the composer, it is attached. Aa hides the formatting buttons; the switch between views stays.
  - **Markdown** (CodeMirror, `livemd.ts`): the same document as Markdown, drawn as you type, as Obsidian does:
    headings big, bold bold, and the marks that make them fold away on every line but the caret's. A pasted picture
    stands in as `![name](dc-picture:id)` and shows as itself (a picture from an original too: its size and address
    come back with it). A quote is Markdown's `>`, a bar drawn for each level; `&lt;` and `\_` show as `<` and `_` off
    the caret's line. A block kept whole (`[[island:id]]`) is drawn as it will arrive, under a bar that names it ("Kept
    as its own HTML") with "Open in HTML view": Markdown with HTML in it, as CommonMark allows. What Markdown can't say
    (colour, underline, a centred or right-aligned paragraph or heading) stays as small pieces of HTML, and comes back
    as it was.
  - **HTML**: the mail's whole HTML, a forward's or a quote's inside folded, pasted pictures as `dc-picture:id`, with
    the mail as it arrives beside it, which stays in view with a scroll of its own. A docked composer grows to the
    window for it, and back when you leave it. On a phone a switch shows the HTML or the mail as it arrives. What you
    write there that the rich document can't hold as its own (a layout, a style sheet) stays exactly as written, as a
    block of its own.
  - **Plain**: plain text only, no HTML part (`MailDraft.plainOnly`): the text part exactly as it goes, a forward or a
    quote as its text, exactly as it goes, read-only under its name, with ✕ to take it out ("Put the forwarded message
    back" then goes back to Rich, an HTML part again). No formatting buttons; pictures in the text are left out, and one pasted or dropped
    here is attached. Markdown's marks stay as written; the bits of HTML it keeps (colour, alignment) go, their words
    kept, as the hub does for every text part. Rich again makes it HTML.
  - **A forward or a quote** is the document's own text when it can be without losing anything (`islandBlocks` in
    `MailEditor.tsx`: plain tags, left to right (Gmail's `dir="auto"` too, unless the text is right to left), and only
    styles the document keeps (a span's or a link's colour, a paragraph's alignment, a quote's bar) or that change nothing you see (Apple Mail's `line-break`, zero margins); every word and
    picture there after): the attribution ("On …, Sam wrote:") then the original in a mail quote (`blockquote type=cite`, as
    every quote the editor writes, nested as it was), or the forwarded-message lines then the original. It is edited
    like the rest (trim it, answer inside it), is `>` in Markdown, and goes as it reads. Pictures it brings keep the
    original's address (`data-dc-src`, and `data-dc-held` for a held one), so the pictures choice below applies to
    them and they are marked the same way. "Quote <name>" comes back once its attribution line and its first words are
    gone (a quote of your own does not count). A draft emptied of it stays so when it is opened again, and a forward's "Put the forwarded message back" once its lines are gone. An empty line goes
    as `<p><br></p>`, which every mail app draws (an empty `<p>` is drawn as nothing), and `<p><br></p>` or Gmail's
    `<div><br></div>` comes in as one empty line.
  - **Otherwise it is kept whole** (an island: a newsletter's layout, its own styles), drawn in a sandboxed frame with
    a bar: "Kept as its own HTML", its size, then its name (cut short on a phone; its tooltip says it all), Hide, Edit
    HTML, Make it text and ✕. Edit HTML opens its HTML in an editor right under the bar, and the block is drawn again
    below as you type; Done closes it (only opening it changes nothing). What was typed there, or in Markdown, HTML or Plain, a
    moment ago goes with a send, a close, a discard or a switch of view at once. Make it text turns it into ordinary text to edit and answer inside (`islandText`
    in `schema.ts`: its words, links, pictures, lists and quotes; its layout and styles gone, a layout's tables as their
    cells one after another, a table of data with headers kept), the caret at its start; Undo brings the block back.
    On a phone the bar's name has a line of its own, the buttons under it. The hub makes it (`hub/src/mail/island.ts`, `MailComposeStart.island`): the original's HTML with its style
    sheets written into each element's own `style`, so it keeps its look in mail apps that drop style sheets (Gmail);
    what can't go into one element (`@media`, `:hover`) stays in a sheet scoped to the block. Trackers are gone. Each
    picture from the web keeps its address, shown as your picture setting shows it in the reader (a held one as a
    striped box; one that will not go as the mail is sent, under the choice below, faded and dashed, here and in the
    HTML view's "As it arrives"). It starts open. The caret starts on the line above it, never on the block, so typing
    never replaces it. A block of HTML of your own has the same bar.
  - **The editor fetches nothing from the web** (`ui/mail/editor/schema.ts`): a picture address you write or paste
    (in any view) is a striped box the picture's shape, its host written on it, until it is sent, since your browser
    fetching it would tell its host you are writing; one that will not go says "left out" on it. The frames' policy
    lets in only this hub's pictures and pasted ones, and their `srcset` and `<picture>` sources are taken out (the hub
    takes them out when sending too). An address without its scheme (`//host/pic.png`) is the web's, over https.
  - **Pictures from the web** in it (a forward's, a quote's, an address written in the HTML view) go as the footer's
    button says ("70 · Link · 1 can tell", beside the size, in sight however long the forward is), which opens the
    choice (the last one made on the device is where a new mail starts; the untick below is that mail's alone): **Link** (the default: their app fetches them when they open it; one that can tell the
    original sender is left out unless you untick "Leave out the ones that can tell", `MailDraft.linkCanTell`; Link
    says how many can tell on itself, "Link · 2 can tell", and the footer's number is always what goes, "69 · Link · 1 left out", "0 · Leave out"; a phone leaves the number off for room), **Embed** (the hub fetches them now, through its image proxy, and sends them inside the mail:
    nothing is fetched on their end; never linked instead: one that can't be fetched is left out, and so is one that can
    tell unless the hub has it already, since fetching it now would tell the original sender; the choice says how many,
    and that loading it in the reader first lets it go inside)
    or **Leave out**.
    Backgrounds (a `background` attribute, a style's or a sheet's `url()` and `image-set()`'s first choice), an SVG
    `<image>` and a video's poster go the same way. Video and audio are linked as they are with Link, and taken out
    (their fallback text kept) with Embed and Leave out; this hub's own addresses never leave. What Embed left out is
    on the outbox item (`MailOutboxView.pictures`: `{ embedded, leftOut: { failed, canTell } }`), and the sending strip
    says it ("· 2 pictures left out"). Each says what it does
    to the size. Pictures inside the mail go as parts the HTML shows (`cid:`) when the account's status says
    `details.inlineParts` (dither-accounts' `OutgoingFile.contentId`), else as `data:` pictures, which Gmail hides.
  - **The text part** is plain text: the Markdown with every HTML tag in it taken out (its words kept, `<br>` and the
    ends of blocks as line breaks, a link as `[text](address)` or its address alone when that is its text, entities and
    Markdown's backslash escapes (`utm\_source`) undone; Markdown's own marks and code stay),
    with a forward's or a quote's text as a plain-text mail has it and pictures as `[picture: name]`. An island carries a fingerprint of its words (`data-dc-text`): once they were edited in the HTML
    view, or when the original had no text part, its text is made from its own HTML instead. `MailIsland.textBytes` is
    what an island adds to the text part as made, which the size meter counts while the island is unchanged. Plain sends that alone: no HTML part.
  - Drafts keep the HTML (`MailDraft.html`, with `pictures` and `plainOnly`); a draft from before it opens from its
    Markdown and is kept as HTML from then on. The hub takes scripts, frames, forms, `on…` attributes and the editor's
    own marks out before it goes, and never sends one of its own addresses (its proxy's, a part's): each is the
    picture's own address, or the picture.
- **Sizes.** The footer says "≈ 188 KB of 25 MB": the mail as it goes, pictures and files counted as base64 (a third
  bigger). It opens the breakdown: the text part, the HTML part, the pictures pasted in, the ones embedded, the files,
  the total, and what their app loads on their end (linked pictures, with the bytes the hub knows of them:
  `POST /api/mail/pictures/sizes`, which fetches nothing, one answer per address, with whether the hub has it already
  (`cached`, so the composer can say how many Embed would leave out); this hub's picture addresses, as a forward's
  backgrounds have, count as the picture they stand for). The account's cap counts files and pictures
  inside it by their own bytes, not their base64, as dither-accounts counts attachments; the footer turns red over it.
- **Undo a send.** Send gives the message to the hub's outbox (`hub/src/mail/outbox.ts`), once per `clientId`, after checking
  it: someone to send to (To, Cc and Bcc together at most the account's `details.maxRecipients`, else 500, 100 on
  Proton), From one of the account's addresses (422 otherwise), 25 MB a file and the files together at most its
  `details.sendCap` (else 35 MB, 25 MB on Proton; over it is 413, and the composer's count says the same cap). It is
  held 10 s (`DITHER_MAIL_HOLD_MS`) while a strip says "Sending … in 10 s · Send now · Undo"; Undo brings it back into the
  composer as it was, files and all, and Send now ends the hold (`POST /api/mail/outbox/:id/send`).
- **Going out.** Then its files move from the uploads into `<data>/mail-outbox/<id>/` and it goes to `mail.send` ahead
  of background work: files by `path` when the manager is on this machine (DITHER_ACCOUNTS_URL on loopback), else as
  base64; a forward's files are fetched from the server (`mail.attachment`) then. What the account answers:
  - sent: "Sent", and Sent is asked what changed, so the copy shows in the thread (it threads by In-Reply-To);
  - a dry run: "Dry run: … did not reach the account";
  - 503 (an extractor not ready yet, say), `limited`, the manager away or the account offline: tried again, from 2 s up
    to every 15 min (at once when the manager is back), for a day. While the account is offline no call is made;
  - no answer in time (504), a 502 (the page broke after the send), the manager's `unsure`, or `offline` once the call
    was out: "it may have been sent: look in Sent before sending it again". It is never sent again by itself;
  - `duplicate`: the manager had sent it already (a try whose answer was lost), so it shows as sent. Each try carries
    the send's id as `idempotencyKey`, the same every time; a manager that does not know the field ignores it;
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
message in; `POST /api/mail/send` (a `MailSendRequest`); `GET /api/mail/outbox`; `DELETE /api/mail/outbox/:id` is Undo; `POST /api/mail/outbox/:id/send` is Send now;
`POST /api/mail/outbox/:id/dismiss`; `GET /api/mail/drafts[?key=]`, `GET/PUT/DELETE /api/mail/drafts/:key`;
`GET /api/mail/addresses?q=` completes recipients from the hub's mail, `GET /api/mail/contacts?q=&account=` from the
accounts' servers; `POST /api/mail/accounts/:id/sending` is "Try sending again". The
`mail.outbox` event carries the outbox's whole list each time (it is not journaled: a sync answer carries it too).

For later slices: MailHub's `sent` event (`{ accountId, outboxId, messageId, replyTo, threadId, dryRun }`) says you
answered a thread. A reply or a forward quotes the original's own HTML when it has some, sanitised by slice 3
(`quotedHtml` in compose.ts: no images, style sheets or script), else its text.

Not yet: the reply showing in its thread before Sent's copy arrives (the strip says "Sent" meanwhile); a send with
files made without the hub surviving a reload of the page (its draft does).

## HTML, images and files (slice 3)

- **The HTML** shows in a frame on a white sheet, in every theme, scaled down to the width when the mail is wider than
  the screen. Plain HTML is the exception: when the sanitiser finds only text, paragraphs, line breaks, links, lists,
  quotes and what Markdown makes (bold, italic, underline, struck-through text, headings, code, rules; no images,
  tables, colours, backgrounds, fonts, alignment or style sheets; margins and a quote's bar are fine), it is drawn in
  the app's theme. Without formatting, and with a text part of its own, the body view says `html.plain` and the reader
  shows the text part, with its quote fold. With formatting its text part would lose (bold, headings, code: mail
  written here in Markdown, say), it says `html.formatted` too and the reader shows the HTML in the frame with the
  app's colours and font instead of the sheet (`HtmlBody.tsx` `themeFrame`, again when the theme changes). The frame,
  its sandbox, the CSP and the allowlist are unchanged; this only picks the part and the colours. `sanitize.ts`
  `plain` and `formatted`, `parts.ts` `hasTextPart`, tested in `mail-sanitize.test.ts` and `mail-parts.test.ts`. The hub sanitises it first (`hub/src/mail/sanitize.ts`, an allowlist on Bun's HTMLRewriter): no script,
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
- **Pictures and trackers** (`hub/src/mail/pictures.ts`). Each picture from the web is one of three kinds:
  - a **tracker**: a 1-2 px or hidden image, or a known open-tracking service or path (`/track/open.php`, `/wf/open`,
    …). Removed, by default; kept ("Trackers: Keep" in Settings → Mail), they load whenever any pictures load (Ones
    unlikely to tell or All) and are held under None. One
    mail's own choice comes first (`POST /api/mail/images { messageId, trackers: 'keep' | 'remove' | null }`; the
    reader's `pictures.trackersSource` says whether it was the mail's or the setting's).
  - **personal** ("can tell"): its address carries your address (plain, encoded, or hashed with MD5 or SHA), or an
    id made for one recipient in a path segment, a query value or a host label (but the last two): a UUID, 5+ digits
    alone, 10+ hex digits with a digit among them, 10+ letters and digits interleaved, 20+ letters and digits in one
    case, or 16+ in a random mix of cases; or an id-like query key (`uid`, `u`, `e`, `r`, `id`, `user`, `mc_eid`, …)
    with any value. Years (`/2024/`) and sizes (`1200x800`) are not ids. Fetching it can tell the sender you opened the mail. The rule leans this
    way: a file named by its content's hash is held needlessly, never the other way round.
  - **shared** ("unlikely to tell": a short id can slip through, so None is the only sure choice): the same address in every copy; seen in mail from another sender too counts as shared
    (not your own mail: your Sent copy of a forward carries the original's personal pictures; in that copy the
    original's sender is not enough either, it takes two senders who are not you, as in the composer).
  Settings → Mail, **Load pictures**: None, **Ones unlikely to tell** (the default) or All. A sender's rule (Always or
  Never from them) and a choice for one mail come first. The bar over a mail says what happened ("12 pictures loaded ·
  3 held back (they would tell Sam you opened it) · 2 trackers removed"; on a phone without the why), with Load all,
  and ⋯ for this mail's own
  choice (No pictures, Only the ones unlikely to tell, All pictures, or back to the usual), its trackers (kept or
  removed), the sender's rule, and **Details**: how many hosts the loaded ones come from, then every host, its kind,
  why, what happened to it and its size once the hub has it ("loads when shown" before). Links
  are not changed: a link can still tell the sender you clicked it. The bar stays when pictures that can tell were
  loaded ("12 pictures loaded, 2 of them could tell Sam"), so you know, and can take it back.
  Allowed pictures come through the hub (`GET /api/mail/img/<token>`, `hub/src/mail/images.ts`): the token is an HMAC
  of the message and the URL with the hub's key, so the proxy fetches only what that message names, and only while
  the message's policy still loads it. Public addresses only, checked for every address a name resolves to, and the
  request goes to the address that was checked (a name that changes its answer meanwhile gets nowhere); redirects
  checked again; no cookies or referrer; 10 MB at most; kept only if the bytes are an image (not SVG); 7 days in the
  media cache. A picture the cache already has loads under "Ones unlikely to tell" whatever its kind (fetching it again
  would tell no one).
- **Sizes of a mail you got.** The message's ▾ details have a Size row: the raw message as the server counts it, its
  HTML, text and files, and its pictures: how many loaded from how many hosts (`pictures.hosts`: the hosts of the
  loaded ones; `hostsAll` every picture's) and their bytes, how many load when shown (`unknown`: loaded, but the hub
  has not fetched them yet; such an item has `cached: false` and no `size`), how many not loaded.
- **`cid:` pictures** come from the message's own parts and always show.
- **Files** show under the message as chat's cards; pictures the HTML shows itself are not listed again. They come
  from the server with `mail.attachment` the first time they are opened, go into the media cache, and are looked at
  like chat files (`fileinfo.ts`), so a card says what a file really is; one that would run as a program says so.
  Text, code, Markdown, JSON, CSV, PDF and archives open in the file viewers, pictures in the image viewer, anything
  else in its app or as a download. A message the server deletes, or an account deleted 24 hours after its access
  ended, takes its files with it.
- **In a chat** a mail is drawn from its words' tree when it has one (bold, lists, links with their words, code: "Mail
  as chats", "Formatted words"), and a designed one shows framed in place; "Show as sent" is the same frame. A plain
  HTML part with a list, or a link whose words are not its address, is `formatted` too (its text part loses the list's
  shape or the link's words), so the reader shows it as its HTML in the app's theme. A held picture of no known size
  is marked `dc-img-unsized` in the sanitised HTML.
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
  folder they are in; an IMAP server's All mail is never emptied from here (Gmail would take that as a delete), while
  where ids are the message's (Proton) it moves out of All mail by its id. On Gmail, Inbox, and a label for a thread
  only in All Mail, only put the label on (over IMAP a copy from All Mail), so the thread stays there and keeps its
  labels; an archive on Gmail over IMAP is held back until its Undo is over ("Gmail" below). Nothing is ever deleted
  outright.
- **At once, then for real.** A change shows at once and the hub keeps it as pending (the row's time is greyed) until
  the server answers. It goes in batches of up to 1000 messages per account, op and value, at most one write call per
  220 ms. A message's latest change is the one sent: undone before it left, it never leaves. If the manager or the
  account is away, changes wait (through a hub restart too) and the list says how many; when it is back, what changed
  there is fetched first, then they go. A change the page could not hand to the hub waits in the page and goes when
  the connection is back, once.
- **When the server says no** (§3.7): 404 drops the change and fetches what changed; 403 undoes every change waiting
  for the account and makes it read only here; 422 (it applied none of it) undoes it; 501 undoes it and hides that
  button for the account from then on (Proton's `answered`); 410 lists the mailbox again and tries again. Trouble that
  may pass (a 503, `offline`, an extractor not ready yet, as Gmail "not attached yet") uses up no try: the account's
  changes wait for its next status, or from 2 s, doubling to 5 min, whichever comes first. Anything else is tried
  again, from 2 s, doubling, ten times, then undone. What failed shows above the list until you dismiss
  it.
- **In part.** A write may apply to some messages and not others (dither-accounts' google kind): the answer names
  the ids the server `refused` and those it could not find (`unknown`), and only those are undone here, with a line
  saying why; the rest stands. A move's null id for one of these means it stayed where it was; a null id it does not
  name means it moved and the next changes pass finds where. `unknown` asks what changed too. Each write call sends
  each message's thread beside its id (`threadIds`), which the google kind uses and IMAP and Proton ignore.
- **What an account writes.** An account's status may list the writes it makes now (`details.writes`: `seen`,
  `flagged`, `move` for archive, Inbox and folders or labels, `trash`, `junk`). Gmail on the web lists all but `junk`
  (dither-accounts does not report spam to Google for you). A kind it leaves out is refused at once with no call ("Gmail can't archive from here yet"), its buttons and
  menu items are hidden (web `canWrite`), and read in view keeps read state here only when `seen` is not listed. A
  status that lists a kind clears an earlier 501 for it. Without a list (IMAP, Proton) every kind is tried, as
  before. The hub keeps the list in `mail_account.writes` and shows it as the account's `writes`.
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
  who from), where its newest sorts; it opens the Updates view. **Everything** has them in place, by date.
- **"Not a person"** on a thread (its menu in Mail, the reader's ⋯, its row in the inbox) sends the thread and its
  latest sender to Updates, from now on. **"This is a person"** brings a sender back, and is offered for Updates and
  for a sender nobody knows. Nothing moves on the server: Updates is a view of Inbox. The hub emits `override`.
- **The one-list inbox** lists a thread from a person in Inbox, not muted, that is unread (last message within 30
  days), or owes a reply (to a message within 14 days), or had mail in the last week, or that you opened in the last
  two days (`MAIL_INBOX` in `hub/src/mail/attention.ts`). Archiving it takes it out, from here or another mail app.
  Mail from a sender nobody knows stays in Mail until triage puts it on the list or above (§14 Q4: slice 9).
- **Its order** is the chats' formula (`attention.ts`): you and one other is a DM, else a group of everyone on it; you
  in To is a mention, a reply to yours replies to you. How you answer someone counts all their mail threads and, once
  you merged them with a chat contact, their chats too, and the reverse: "You usually reply to Sam within 30
  minutes; unanswered for 2 hours" reads the same in both. An answer sent from here pays what you owe at once,
  before Sent's copy comes. The learned order with mail (slice 10) runs in shadow: a mail row keeps its formula
  points and carries the learned score as the view's `shadow`, to compare, until `DITHER_INBOX_MAIL=model` sorts by it
  (inbox.md, "Mail in the learned order").
- **A mail row** has the person's picture with the envelope where a chat's network goes, the subject before the start
  of the last message, the same ↩ and reasons on hover, and a menu (why, Open in Mail, Not a person). The inbox's
  filter shows mail under All and Mail; Direct messages and Groups are chats only (inbox.md). Tapping it opens the
  reader beside the inbox (`#/inbox/c/<thread>`).

How: `mail_message.class`/`class_why` and `mail_thread.class` are written by `MailStore.recomputed`'s hook in the
ingest's transaction; a sender who becomes known (you wrote to them, a merge) has their other threads classified again
a moment later; mail from before this slice is classified in the background. Your overrides are `mail_override`
(`schema-inbox.sql`; `PUT /api/mail/senders/:address {override: person|bulk|null}`, `PUT /api/mail/threads/:id/person
{person: true|false|null}`). `MailAttention` (`hub/src/mail/attention.ts`) folds each thread from a person from the
start when it changes (`mail_feature`, `mail_author_feature`) and is an `Attention` source: its views are
`AttentionView`s with `kind: 'mail'`, in the same `attention` events, bootstrap and sync as the chats'.
`mail_thread.listed` follows, and the bootstrap's window carries every listed thread. The page's inbox rows are
`{ kind: 'conv' } | { kind: 'mail' }` (`web/src/model.ts`). With no mail account the inbox is the chats' as before.
Opening a thread, from a mail row or the Mail page, is in the activity log as a `mail` stay on the thread's id
(`mth_…`; before 2026-11-20 a mail row's was a `conversation` stay with that id, and the Mail page's had none), with
its row and where the shadow order had it when it came from the inbox. The learned order with mail (slice 10) learns
from those (inbox.md, "Mail in the learned order").
Tests: `hub/test/mail-classify.test.ts`, `mail-attention.test.ts`, `web/test/inbox-mail.test.ts`; `verify-inbox.ts`
(mixed rows) and `verify-mail.ts` (the Updates and Everything chips in the Inbox's sidebar and an old People link on a
phone and a desktop in both themes, Not a person). Ranked: `mail-attention.test.ts` ("Mail's ranked Inbox": every
scored thread in the window, Inbox paged by date while a score changes), `web/test/mail-model.test.ts` (`rankedThreads`).

## Search (slice 7)

- **Where.** A mail list's search box, the Inbox header's (docs/inbox.md "Mail lists"), searches that list: the query
  starts with the list's operators (web `mail/model.ts` `listSearch`, read back by `searchIn`). A search is a list key,
  `s:<query>` (protocol `searchList`), so `#/inbox?mail=s%3A<query>` links to one and a thread opens beside its results
  as from any list. The search page gets a **Mail** group
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
  | `filename:lease` | an attachment's name ("Keeping all mail": for every account, once its body was fetched) |
  | `is:unread`, `is:read`, `is:starred` (or `is:flagged`) | as the hub has it |
  | `is:update` (or `is:updates`) | mail not from a person, the Updates list's; this hub's own sorting, so servers are not asked it |
  | `account:proton`, `account:me@x.org` | one mail account, by label, address, kind or id |
  | `before:`, `after:`, `during:`, `sort:oldest` | as in chat search, on when the server got it |

- **The hub's own index** (`hub/src/mail/schema-search.sql`, `mail/search.ts`): `mail_search` holds what each message is
  found by (its subject; From, To and Cc names and addresses; its body's search text once fetched, else its preview)
  beside what a search groups and filters by (account, thread, time, "only in Junk or Trash"), and `mail_fts` indexes
  it. Triggers on `mail_message`, `mail_text`, `mail_location` and `mailbox` keep both current, so anything that
  stores a message or a body is searchable without calling anything: the first sync, a server search, the reader, and
  bodies fetched ahead alike. The body's search text is slice 2's `mail_text` (the first 16 KB, or all of it up to 1 MB
  on an account that keeps all its mail, kept after the body cache lets the body go, under the one cap
  `DITHER_MAIL_INDEX_MB` that a kept account is outside of): a row stored sets it here, and a row the cap
  drops puts the preview back. Hits are threads, newest matching message first, with how many of their messages matched and the
  matched words marked; paged by cursor. As chat search does, nothing found as whole words searches inside words, and
  still nothing corrects misspelt words from `mail_fts_vocab`.
- **The servers.** `GET /api/mail/search?q=&cursor=&limit=&server=0|1|auto`. The page shows the hub's own hits at once,
  then asks the servers (`server=1`) when those are under 20 threads, or when you ask ("Search the servers too");
  `auto` is the same rule on the hub, and leaves out an account searched locally ("Keeping all mail"); the page's own
  ask is `auto`, its "Search the servers too" is `1`. Each account gets `mail.search` at P0, 50 at most, 20 s at most,
  and each answer is measured (`mail_search_measure`). Gmail gets the
  query in its own syntax (X-GM-RAW over IMAP; an account is Gmail as `MailStore.gmail` says, below); other IMAP servers
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

- **New mail from a person is triaged** with chat's own importance model and chat's marks
  (`hub/src/mail/triage.ts`, [notifications.md](notifications.md)). Mail has two of chat's three tiers. It is a row
  on the **List** when its importance is at or above your level, and **below the list** when it is not. It is an
  **Alert** only when its sender is set to Always alert. There is no Conversation tier for mail, and no local model
  reads it for urgency. Mail that arrives (`ingested` with `live`) is triaged and may notify; what a sync, a backfill
  or a search lists never notifies (but see "quietly" below). Bulk is never triaged: no notification, no list. Yours
  and drafts are not either.
- **Where importance starts.** At 0.8 for someone you correspond with (you wrote to them, they wrote in a thread of
  yours, or you merged them with a chat contact) who wrote to you or copied you in: what a mail client would have
  notified you about. For a list or Bcc from them, and anything from a sender nobody knows, lower, by how much it is
  about you (`0.05 + 0.75 ×` a score that starts at 0.15 and adds 0.2 for you in To, 0.2 for someone you know, 0.4
  for a reply to you, 0.15 for a question, 0.15 for urgency, and takes off 0.3 when it looks spoofed; at most 0.6).
  At the default level of 0.6, and before anything is learned, a stranger's mail is on the list only when it
  answers something you wrote and is to you (or asks or presses besides). What you did and what you marked move it
  from there, as in chat.
- **The facts** are chat's, from mail: network `email`, shape `mail`, the thread as the conversation, the mail
  account as the space, the author as their person (else identity), you in To as a mention, Cc or a list as
  `everyone`, a reply to one of yours, a question or urgency in the subject or text, a link, an attachment, long
  (over 1,500 characters above the quote), and `notify`: whether a mail client would have notified you (the first
  case above). The model reads the subject and the first 2 KB of text above any quote. `native` is left out, so
  mail leaves what chat learned about the networks' settings alone.
- **Shared with chat.** Marks on mail join chat's examples (`TriageVotes.others`), so "Less like this" on Sam's
  mail lowers Sam's importance on Signal once the two are one person, and the reverse. The author is read as it is
  now, so a merge after the mark counts. A mail notification you left alone teaches nothing: as in chat, only what
  you did counts.
- **What keeps it quiet**: from a sender set to Always alert, a body that warns of spoofing (a name that is another
  address, Reply-To elsewhere, a link that says one site and goes to another) is no alert ("No alert: …"), only a
  row on the list or below it. Quiet hours hold an alert as a list row, into chat's summary. Mail that reached the
  server over an hour before it came here (a catch-up), mail already read, mail outside Inbox and muted threads
  (silent) are rated but notify nobody.
- **The body first.** A new personal message's body is fetched on arrival (slice 2) and moved up to keep-up priority
  when it may notify; triage waits for it at most 5 s, then decides on what is there.
- **One notification per thread** (`Notifier.mail` in `hub/src/notify.ts`, `delivery.ts`): the sender as the title,
  "subject — start of the text" as the body, the person's picture with the email mark, and the thread's unread lines,
  the subject before the first. A list row is silent, goes only to phones, sorts by its importance, and is brought up
  to date at most every ten minutes a thread; an alert sounds once a burst, as chat's. Reading the thread anywhere
  (here, in another mail app, or answering) takes it off the phones. Its conversation is the thread, which opens the
  reader beside the inbox (`#/inbox/c/<thread>`, as a mail row does) in the browser and in the Android app as they
  are; the push and the live `notify` event also carry `mailThreadId`.
- **Device rules** (`devices.ts`): a mail thread's chain is the thread, its mail account, then Email. Settings →
  Notifications → Each device lists Email (and each mail account when there are several), so "Email off on the
  phone" works. "Mentions only" keeps mail with you in To or answering you.
- **One mark: "Less like this."** Mail has no alert marks. It is on How it sorts, where a mail thread is a line
  beside chat's with an envelope and "by email"; on the notification; and in the reader, where a triaged message has
  a Notification button with its tier, why, its importance and the mark. It goes to
  `POST /api/mail/triage/:id/vote { less: true | false }` (or to `POST /api/messages/:id/feedback` with the mail
  message's id, as chat's), and `false` takes it back. "Not a person" is "Less like this" on the thread's newest
  decision.
- **A sender nobody knows** reaches the one-list inbox only when the thread's newest message is on the list or
  above and you have not marked it "Less like this" (§14 Q4, `mailAttention(hub).triage`).
- **Quietly, what a sync found** (`MailTriage.sweep`). A stranger's thread that was already there when the account was
  added never arrived live, so it would never be rated and never listed. So the threads the one-list inbox could list
  (its window: unread within 30 days, mail in the last week, opened, owed; never a year of mail) from a sender
  nobody knows, whose newest message has no decision, are rated with the same facts and model, once their body is
  here (asked for, waited for at most a minute), 30 an account a pass, after a sync brings mail and every 5
  minutes. Such a decision has `quiet = 1` and says "Rated after a sync found it: no notification": it never
  notifies, is never held by quiet hours, is never a line of a later notification, and never counts as a
  notification you let stand; it only decides the listing, and shows on How it sorts and in the reader so you can mark
  it. On an account whose summaries carry no headers it waits until the steps below are done.

How: `mail_triage` (`schema-triage.sql`) keeps each decision with its facts, words, chances, whether it notified and
your mark (`feedback`: `drop` for "Less like this", else a vote from before the tiers); a message the server no longer
has keeps its row only if you marked it, and an account's mail going (§14 Q6) takes its rows, marked ones keeping
their facts but not their words. `GET /api/mail/triage?since=` is How it sorts' mail (`MailTriageItem`: the last week,
and the last two days of what fell below the list), and the tier for a mail row; each thread's view carries
its newest decision (`MailThreadView.triage`) and each message's its own (`MailMessageView.triage`), so both follow
new mail and reads live.

Decisions from before the tiers were converted once, as chat's ([notifications.md](notifications.md#the-migration)):
Important and Active mail became rows on the list, Digest went below it, each keeping what it was (`was`), and the
votes on them count half a mark.
Tests: `hub/test/mail-triage.test.ts`; `verify-notifications.ts`'s mail run.

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

## What the hub reads of an account's server

The extractor's `status` event says what its server is, in `details` (dither-accounts' extractors). The hub
keeps each in `mail_account` (store.ts `setStatus`); a status that leaves one out keeps what an earlier one said, and
until one says, the hub goes by the account's kind as it did before they existed:

| detail | column | what it changes | until it is said |
| --- | --- | --- | --- |
| `idPerMessage: true` | `id_per_message` | a message has one id in every mailbox (Proton, Gmail on the web): a move keeps it, a move out of All mail goes by it (`MailStore.idPerMessage`), and a summary without an emailId takes its id as one | true on Proton, false elsewhere |
| `sendCap` | `send_cap` | the most bytes of files one message may carry, checked before a send is held (413) and shown by the composer | 25 MB on Proton, 35 MB elsewhere |
| `maxRecipients` | `max_recipients` | the most recipients, To, Cc and Bcc together | 100 on Proton, 500 elsewhere |
| `provider: 'Gmail'` | `provider` | the account is Gmail (`MailStore.gmail`), whatever its address or mailboxes | its address or its `[Gmail]` mailboxes |
| `summaryHeaders` | `summary_headers` | "Summaries without headers" above | a summary that carried them |
| `backgroundLane: true` | `background_lane` | the archive's reads say `background: true` ("Keeping all mail"); a google-kind account's archive waits for it | never sent; a google-kind account keeps only a year |
| `searchIds: true` | `search_ids` | Gmail's audits page by ids instead of splitting windows ("Keeping all mail") | split |
| `backgroundStopped` | `background_stopped` | the archive stops (`challenge`, `signedOut`, `quota`, or a call's 503 `paused`); cleared by a status without it | going |
| `storage`, `storageUsed`, `storageTotal` | `storage` | shown on Settings → Indexing | not shown |

The account view carries the caps as `sendCap` and `maxRecipients` (protocol `MailAccountView`); Proton says all three
of the first now (`idPerMessage`, 25 MB, 100). `backgroundStopped` is the one a status clears by leaving it out: it is
there for as long as background reads are stopped. `raw` (`'original' | 'rebuilt'`) is not read yet (next PR, "Keeping
all mail"). Proton's search stays by its kind: that is how its server searches, not
how its ids are.

## Gmail

A Gmail account reaches the hub in one of two ways. As dither-accounts' **google** kind, Gmail read, marked, filed and
sent through the signed-in browser ("Gmail on the web", further below), a message has one id in every mailbox; this is
the way to add one. As its **Email (IMAP)** account with the provider `gmail` (its `extractors/imap`, with an app
password), its kind is `imap` and a message has an id per mailbox (below). The hub knows it is Gmail by the status's `details.provider` ('Gmail', which both say), by its
address, or by its `[Gmail]` (or `[Google Mail]`) mailboxes (`MailStore.gmail`), so a Workspace address works too.

What is Gmail the server's holds either way: its search syntax, Important as a view, a move out of All Mail that only
puts a label on, a sent message that is one message in Sent and All Mail (trash leaves it where it is), Trash and Spam
holding a message alone. What comes of an id per mailbox holds only over IMAP (`MailStore.gmailPerMailbox`): the label
put back on a summary, and the archive held for Undo.

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

### Gmail on the web

dither-accounts' google kind reads, marks, files and sends Gmail through the signed-in browser, the way Gmail's own
page does (its docs/google.md, "Gmail mail" and "Writing to Gmail"). Its status says `provider` 'Gmail',
`idPerMessage`, `summaryHeaders` (false), `writes` (every kind but `junk`), `canSend`, `sendCap` (25 MB) and
`maxRecipients` (100); its kind is `google`. Modelled by `fake.ts`'s `ids: 'gmail-web'` (its header says how):

- **Mailboxes** are labels with Gmail's own ids (`^i` Inbox, `^f` Sent, `^r` Drafts, `^k` Trash, `^s` Spam (`junk`),
  `^io_im` Important, `^x_<n>` each of yours, by path) and an All Mail made up from them (`all`: every message not in
  Trash or Spam). `fake.ts` names them as Gmail's API does (INBOX, `Label_<n>`); the hub goes by role and id, never by
  those names.
- **One message, one id** in each mailbox that lists it. The hub keeps a location per mailbox all the same, each with
  that id; nothing is put back on its labels (they come whole, from every mailbox).
- **Summaries without headers.** As dither-accounts reads Gmail's web protocol, a listed summary carries no
  Message-ID, In-Reply-To, References or list headers (`summaryHeaders` false; those that come from Gmail's sync, in
  `mail.changes` and `mail.arrived`, carry the first three); `mail.get` has them, as on Proton ("Summaries
  without headers"). Its `emailId` is its id, so the hub keys it `e:<id>` (store.ts `identify`); where a status says
  `idPerMessage`, a summary with neither a Message-ID nor an emailId gets its id as its emailId, and a message that has
  that emailId already is the one, so `mail.get`'s answer (with a Message-ID) finds the same row. The body fills in the
  Message-ID (`putBody`), for "a reply to yours" and threading by reference; threads are Gmail's.
- **Categories** come as labels: `Category/Promotions`, `Category/Social`, `Category/Updates`, `Category/Forums`, which
  classify as bulk (§4 rule 8) with no list headers to go by. They are labels, not mailboxes.
- **Filing** is a label change. `mail.move` names no mailbox it comes from, so it goes by the destination: its label on,
  Inbox's off unless it goes to Inbox (archive is into All Mail), Trash's and Spam's off unless it goes there. Into
  Inbox, and into a label from All Mail alone, it only adds the label: the hub keeps it where it was (ops.ts
  `copyFrom`, no copy made), so an archive undone after it went is as it was. Into a label from Inbox, Inbox comes off;
  the labels it has stay, and the hub does not take it out of them either. An archive goes at once (no hold: undoing it
  is putting \Inbox back). Trash and Spam hold it alone, so the hub drops its other places when the move is answered,
  and what you sent is not moved. Spam is not written: the google kind leaves `junk` out of its `writes`, so Report spam
  is hidden for it.
- **Sending** goes through Gmail's page too: the files uploaded, a draft saved, then sent, a reply in the thread of the
  message it answers with its In-Reply-To. What was sent comes back by Gmail's sync, as one message in Sent.

**Checked**: `hub/test/mail-gmail-web.test.ts` (what the hub reads of the status, with a Workspace address and no
`[Gmail]` mailbox; one message and one id through the first sync, the backfill and an opened label, also without a
Message-ID; Move to Inbox from All Mail, into a label from Inbox; archive and Undo, not held; trash and Undo; star,
read and unread; changes made in Gmail itself; search in Gmail's syntax; the send caps and writes from the status). Through the hub on a real google-kind account (2026-11-14, test messages
between the owner's own Gmail and Proton accounts): star and unstar, unread and read, archive and back to Inbox, into a
label (Inbox came off, as modelled here), trash and back (your labels stay), a new message with a file, and a reply
with a file (in the original's thread on both sides, with its In-Reply-To), each seen in Gmail itself.

**Adding one** (on the owner's side; nothing is added from here): on dither-accounts' page, **Add → Google**, and sign
in to Google once in its live view (dither-accounts' docs/google.md). The hub sees it under its existing `mail` grant.

Over IMAP instead:

1. In your Google Account turn on 2-Step Verification (myaccount.google.com → Security), then make an app password
   (Security → App passwords, named "dither-accounts", say). Google shows its 16 letters once. A Workspace account whose
   admin turned off app passwords or IMAP cannot be added this way.
2. On dither-accounts' page: Accounts → add → **Email (IMAP)**: your Gmail address, Provider `gmail`, the app password,
   and your name. Leave the server fields empty (the preset fills imap.gmail.com:993 and smtp.gmail.com:465) and Copy to
   Sent at `auto` (Gmail keeps its own).
3. The hub sees it within seconds under its existing `mail` grant and syncs it: Accounts lists it online; Mail's
   account menu has it, and the mailboxes menu its labels. Its "sync" detail should say CONDSTORE; dither-accounts'
   docs/mail.md has a checklist for what only a real mailbox shows.

## Setting it up

1. The hub runs with `DITHER_ACCOUNTS_URL` (docs/accounts.md). Set `DITHER_ACCOUNTS_PUBLIC_URL` too, for the links to
   the manager's page.
2. On its next start the hub asks dither-accounts for `mail` at `write`, on every account. Approve it on the manager's
   page. Until you do, Mail says so and links there; if you decline, Mail offers "Ask again".
3. Add the mail account: Proton Mail from Add account here (after approving the hub's `accounts` request for `proton`),
   or any kind on the manager's page. The hub sees it within seconds and syncs: Inbox's newest 50 first, then Sent's,
   then both down to 500.

A grant narrower than asked is respected: with `read`, the account says "read only: marked read here only". Proton
cannot send from the hub yet (`mail.send` answers 501 there); reading works.

Without `DITHER_ACCOUNTS_URL` there is no Mail entry; Settings → Mail says what to set.

### Numbers

`hub/src/mail/limits.ts` (`MAIL_LIMITS`), overridden by `DITHER_MAIL_SYNC_DAYS` (365: how far back slice 2 backfills,
plus all of Inbox), `DITHER_MAIL_MAX` (150,000 summaries an account), `DITHER_MAIL_CACHE_MB` (500 MB of bodies),
`DITHER_MAIL_INDEX_MB` (300 MB of search text) and `DITHER_MAIL_KEEP_FREE_GB` (10: the disk guard of "Keeping all
mail"). The first two and the caps apply to an account that does not keep all its mail.

## Big mailboxes (slice 2)

An account that keeps all its mail goes further than this: every mailbox to its end, every body, no caps ("Keeping all
mail", below). What follows is any account's first year, and all of an account that does not.

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

**Running it.** `bun test packages/hub/test/mail-load.test.ts` takes about 30 s, nearly all of it SQLite storing and
indexing the summaries. It runs on a clock of its own (`test/fixtures/clock.ts`, each call answered 20 ms later in that
clock's time), so the horizon, the progress line and the bodies ahead come out the same on every run.

A demo hub with a big mailbox: `DITHER_DEMO_MAIL_BIG=1` adds 40,000 Archive messages over three years, 400 older Inbox
messages and an unsynced "Projects" folder of 1,000, on a fake server that answers in 250 ms. `bun scripts/verify-mail.ts <hub> [shots] --big`
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

## Keeping all mail

The aim, in the owner's words: keep scraping until all search can be done locally, found out by seeing how much of the
server's search results the hub does not have, so that eventually all mail is stored in the same database. It is on
for every mail account (`MailHub`'s `keepAll`, which main.ts sets), with a switch per account on Settings → Indexing.
Gmail on the web gets it once its account has dither-accounts' slow lane (below); Proton's accounts have it now.
`hub/src/mail/keep.ts`, `schema-keep.sql`; tests in `hub/test/mail-keep.test.ts`.

**For a kept account:**

- **The walk** lists every mailbox to its end, after the year any account lists: All mail (else Archive), Inbox, Sent,
  Trash, Junk, Drafts, then each label or folder by path (`backfill.ts` `walkBoxes`). Not Starred or Important: they
  are views of All mail. Not a mailbox that only holds others (Gmail's `[Gmail]`). A mailbox the hub did not follow is
  kept up from then on (`follow = 'open'`), its state taken first. `mailbox.complete` says a mailbox is listed to its
  end. The cursor is kept as the server gave it, so the walk goes on from it after a restart (Gmail on the web's are
  opaque and last days).
- **No cap.** The 150,000 summaries and their hourly sweep do not apply (`bigSweep` leaves it out).
- **Every body** is fetched with `mail.get`, newest first, at P4: below the bodies fetched ahead (P2) and the walk (P3),
  in the same budget of two calls a second that waits 10 s after any call a page waited for. Two at a time are on
  their way, one in the background slot and one waiting. A body already here whose text was cut at 16 KB (fetched
  before the account was kept) is cut again from itself, with no call.
- **Recipients.** Gmail on the web's list rows carry no To or Cc; its `mail.get` answers do, and a message's body
  fills them in (`MailStore.fillRecipients`), with who it was addressed to (`to`, `cc`, or neither). Without them every
  message looks Bcc'd, every thread looks like you and one other, and what you owe by mail is wrong. Once every body is
  here, messages kept without either (from before the hub kept them) are read again one at a time at P5, mail from a
  person first, newest first, each once (`mail_recipients_read`).
- **Never evicted.** A rule per account, not a `keep` value on each body (`MailStore.keptSql`): a kept account's bodies
  are left out of the 500 MB cache's eviction and of the bytes counted against it. Turning keeping off puts them back
  under the cap as they are, with nothing to rewrite.
- **Whole text.** The search text (`mail_text`) holds all of each body's text up to 1 MB
  (`MAIL_LIMITS.keepTextBytes`), not its first 16 KB, outside the 300 MB index cap. `mail_text.cut` says where a text
  was cut (0: whole). A message with no text at all gets an empty row, so it counts as done.
- **Over 2 MB.** A kept account's body over 2 MB still goes 10 minutes after it was read, as for any account: its text
  stays (up to 1 MB) and is searched, which is what the archive is for here; what the 2 MB is made of is mostly HTML
  with pictures in it, and fetching it again when it is opened is one call. The original will come whole from
  `mail.raw` (next PR), and keeping a second copy of it in `mail_body` now would only be thrown away then.
- **The mailboxes' counts** (`mail.mailboxes`) are asked again every 30 minutes and once the walk is done: they say how
  much the server holds.
- **The disk guard**: no body is fetched while the disk holding the data dir has under 10 GB free
  (`DITHER_MAIL_KEEP_FREE_GB`); the account's row says "Disk guard" and the section says how much is free.

**Attachments' names** are searchable for every account, kept or not: `filename:forecast` looks only at them (Gmail's
operator, which Gmail's server is asked with too), and plain words find them as well. They come with the body
(`mail.get`'s parts) and stay when the body goes (`mail_search.files`, a fourth column of `mail_fts`; a database from
before it gets the column and its index made again once, at start). Their bytes are not fetched: they come with
`mail.raw` (next PR).

**Deleted on the server is deleted here**, kept or not, as before. Whether a kept account should keep what was deleted
on the server is an open question (below).

**The background lane** (dither-accounts, as agreed). Archive reads (the walk's pages, these bodies, the audits'
searches and gets) say `background: true` when the account's status says `details.backgroundLane: true`, and only
then; a page's reads never do. When the status says `details.backgroundStopped` (`challenge`, `signedOut`, `quota`), or
a background call answers 503 with the code `paused`, the walk, the bodies and the audits of that account stop at once
and nothing is tried again until a status no longer says so; the row says "Stopped by the account" and why. What a page
reads goes on as usual. `details.storage` ("4.2 GB of 15 GB" as Gmail shows it), `storageUsed` and `storageTotal`, when
the status has them, show on the row beside what the hub holds.

**A Google account waits for its lane.** dither-accounts' google kind reads Gmail through its own web page, under the
owner's real Google sign-in, so the hub's two calls a second must not go through it. While such an account's status
has not said `details.backgroundLane: true` (`MailStore.laneWaits`), it keeps only what any account keeps: the year,
all of Inbox, the cap, and the bodies fetched ahead (P2). The walk past the year, the kept bodies at P4, the counts and
Gmail's audits do not run; all three read one gate, `MailStore.keeping` (kept, not paused here, not waiting). Its row
says "Waiting" with the reason, `GET /api/mail/keep` reports `state: 'waiting'`, and it is not searched locally. It is
not the owner's Pause: it writes nothing to `mail_keep`, and Resume does not lift it. The first status that says
`backgroundLane: true` starts the archive at once (MailHub's `lane` event), with no restart. Proton and IMAP accounts,
Gmail over IMAP among them, are not held.

**Coverage** (`GET /api/mail/keep`, protocol `MailKeepPage`), per account:

- **Totals**: each walked mailbox's server count against the hub's locations there, and whether it is listed to its
  end; the account's total is All mail (else Archive) with Trash and Junk where there is one, else every mailbox walked.
- **Bodies**: messages with their whole text against messages held; the room the account takes (bodies and search text
  as stored; indexes come on top).
- **The search measure**: each time a page asks a server's search (`GET /api/mail/search` with the servers), each
  account's answer is a row of `mail_search_measure`: how many hits the server gave, how many of those the hub held
  before the search stored them, how many of those had their text here, and how many the hub's own search for the same
  query found. The query is not kept. The row shows the last 30 days ("Gmail's search found 412 in your last 30 days of
  searches: 405 held here, 391 found here"). Rows older than 30 days go, but never an account's last 20.
- **Audits, Gmail only** (its search takes dates; Gmail over IMAP and on the web, `MailStore.gmail`). Once the walk is
  done, the hub searches Gmail month by month with operators only, never words: `after:<s> before:<s>` in seconds
  since the epoch, which dither-accounts says both take, so a window is the same instant on both sides with no time
  zone to agree on (the first window is everything before the oldest month held: `before:` alone). The ids it answers
  are compared with what the hub holds, by native id, Message-ID or emailId as store.ts identifies messages; what the
  hub lacked is stored then (`caught`), and the window is searched again until it matches. Today mail.search answers
  at most 50, so a window that comes back full is split in halves until it is not, down to an hour (seconds allow
  less than the day dates would; an hour still full is marked `full`, and checked again weekly). Where the status says
  `details.searchIds: true`, a window is paged whole instead (`mail.search { query, limit: 500, idsOnly: true,
  cursor }` → `{ ids, next, estimate }`), with Gmail's estimate on the row, and nothing is split; what it lacks is
  fetched by id with `mail.get`. The pace: at most 30 searches an hour an account, at P5, the lowest priority, never
  while a page waits. Matched windows are searched again: the current month daily, the last three weekly, the last year
  monthly, older ones twice a year. Gmail's search leaves out Trash and Spam unless asked, so the audits do too.
- **Searched locally**: the walk is done, every message held has its text, every audited window matches (Gmail) or every
  mailbox holds at least what its server counts (other servers), and at least 20 server searches were measured and the
  last 20 found nothing the hub did not hold. Then `server=auto` does not ask that account's server: its answer says
  `local`, and the search page says "searched here, since this hub holds all of its mail" and still offers "Search the
  servers too". `server=1` asks it all the same, and measures. It is worked out each time, so a condition lost (a
  server search finding something new, a count growing past what is held) turns it off at once. The page's own ask,
  when the hub found under 20, is now `server=auto`; the button is `server=1`.

**Settings → Indexing → Mail** (`web/src/ui/mail/MailKeep.tsx`), under the index jobs, in their rows' looks: one row per
mail account with the Keep all mail switch (turning it off asks first), "12,400 of 14,000 messages held · 12,100 with
their text · 1.2 GB here", what the account says it uses, the walk ("Walking Archive: back to 3 Mar 2014 · 4 of 9
mailboxes listed", or "Every mailbox listed to its end"), Gmail's audits ("312 of 340 months match Gmail"), the search
measure, why searches still ask the server (or "Searched locally"), the state (Running, Up to date, Paused, Disk guard,
Stopped, Waiting, Offline, Not kept), and Pause or Resume. It asks the hub every 5 s while an account is running, else
every 30 s. `PUT /api/mail/keep/:accountId { keep?, paused? }` changes it. `scripts/verify-mail-keep.ts` drives it on a
demo hub, on a desktop in the dark theme and a phone in the light one. A demo hub keeps a year unless it is started
with `DITHER_DEMO_MAIL_KEEP=1` (the other verify scripts count on its receipt being found only on the server).

**Measured** (2026-11-11, on the shared 16-core machine while other agents ran, load 6 to 30, so the numbers are
rough):

| | |
|---|---|
| Walk and bodies at the budget | 2,050 messages over six years in four mailboxes: every mailbox listed and every body fetched in 1,033 s on the test clock, 2,060 background calls at 1.99 a second, never more than two in a second (`mail-load.test.ts`). 50,000 messages: about 7.0 hours (a body each and a list page each 200) |
| Database, 50,000 kept | 685 MB, of which the search tables 435 MB, for 161 MB of text; the same mail cut at 16 KB: 429 MB and 178 MB, for 57 MB of text (and the same 161 MB of bodies, which the cache would evict). Storing took about 3 minutes either way |
| Coverage of a 50,000-message account | about 90 ms (`GET /api/mail/keep`, and each `server=auto` search) once the indexes in schema-keep.sql carry `cut` and `bytes`; 850 to 2,000 ms without, as those columns sit after the text in their rows |

Search on the same 50,000 messages (`bun scripts/measure-mail-search.ts --long`, then `--kept`: one message in 25 a long
one of 20 to 120 KB, so 1,971 run past 16 KB; median of 7, the first page of 50 threads, ms):

| Query | cut at 16 KB | kept whole |
|---|---|---|
| a word in a quarter of them; its second page | 30; 29 | 24; 24 |
| a word in nearly all, like "the" | 127 | 82 |
| two words; a word and `after:` | 25; 24 | 23; 23 |
| `subject:` a word | 2.0 | 1.0 |
| `from:` someone; a word and `from:` | 40; 48 | 26; 48 |
| `is:unread`; `has:attachment in:archive` (filters only) | 80; 211 | 96; 69 |
| a phrase found nowhere (then inside words) | 419 | 497 |
| inside words; nothing matched at all | 439; 389 | 470; 439 |
| a misspelt word, corrected | 394 | 382 |
| a word only past the first 16 KB of one message | 339, not found | 0.2, found |

The machine was busy enough that one query differs two to five times from one run to the next (in a third run, at load
18 to 36, the "nearly all" word took 409 ms cut and 83 kept, `is:unread` 123 cut and 190 kept), so read the table for
its sizes, not its last digit: whole text costs nothing on a word the index has, and what reads through the text itself (inside words, nothing
found) costs what the text weighs.

**Not done yet**:

- Attachments' bytes, and originals: `mail.raw` (next PR).
- The search text is held three times for a kept account: `mail_body.text`, `mail_text.text` and `mail_search.body`
  (the index's content). The next PR makes `mail_body` a cache re-parsed from the original; an FTS5 table without its
  own content copy would take another.
- Gmail's Trash and Spam are walked and counted but not audited.
- A safe background pace from the status is not read yet: the archive goes at the hub's two calls a second.
- "Searched locally" needs 20 measured server searches first, so a new account asks its server until then.

**Open questions**:

- **Kept-deleted.** Mail deleted on the server is deleted here, as before. Should a kept account keep it, marked as
  deleted on the server (as chat keeps deleted messages, docs/history.md)? It would change what "searched locally"
  compares with, and what "deleted" means to you.
- **Attachments.** Fetch every file of a kept account (much bigger than bodies), only some kinds or sizes, or only
  with the originals?

**The next PR, once dither-accounts answers.** dither-accounts has been asked for:

- `mail.raw {message}`: the whole RFC 822 original, in the same answer shape as `mail.attachment`
  (`{ filename: null, mime: 'message/rfc822', base64, size }`, `rebuilt: true` on Proton, where the extractor builds it
  from what Proton gives); on Gmail this is Show original. The status says which (`details.raw: 'original' |
  'rebuilt'`, absent when there is none); this PR does not read it;
- an ids-only, paged `mail.search` with Gmail's estimate (`details.searchIds`, used here already);
- a safe background pace in the status, and an error code for an account challenge (`details.backgroundStopped` and 503
  `paused`, used here already);
- the storage the account uses, in its status details (`details.storage`, `storageUsed`, `storageTotal`, shown here
  already).

That PR stores each kept message's original as a compressed `.eml` file beside the database (rows and search stay in
hub.sqlite), and `mail_body` becomes a cache parsed again from the original instead of fetched again. On an account
whose status says `raw`, the archive fetches `mail.raw` once a message and takes the body and its text from the parsed
original: it does not call `mail.get` as well for the same message. On Gmail on the web the bodies then come from the
original, one fetch a message. Attachments' bytes come from it too. `bun scripts/accounts-sync.ts` then copies the new
interface types (the ids-only answer, `mail.raw`) into `protocol/src/mail-iface.ts`; until then the hub has its own
type for the ids-only answer (keep.ts). Once every Gmail extractor pages by ids, the splitting fallback
(`splitSearch`, `AUDIT_MIN_MS`) can go.

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

### When the account's side fails

Each failed call is sorted once (`mail/backend.ts` troubleOf): **transient** (a 503; the codes `unavailable`,
`offline`, `backoff`, `limited`, `paused`; an extractor saying it is not ready, as "not attached yet", "has not made a
sync call", "not open in the sandbox", "still loading", "not connected"; a read that timed out), **layout** (a 502:
the extractor could not read the service's page), **data** (any other 4xx: this one request) or **bug** (anything
else).

- **Backing off.** After a transient or layout failure the account's background work (everything but what a page
  waits for) waits 2 s, doubling with each failure in a row to 10 min, spread ±25%; a call that works ends the wait.
  A first sync that fails is tried again after a minute, doubling to 30 min. A failed changes pass leaves the
  mailbox's state where it was, so the next one asks for the same changes.
- **The bug watch** (`traces/errors.ndjson`, docs/tracing.md) hears of a bug at once, and of transient or layout
  trouble only once it has lasted 15 min (`MAIL_LIMITS.troubleReportMs`), once for each streak, with `kind`, `status`,
  `code`, `failures` and `minutes` in its `extra`. A 4xx about one request and an account stopping (`stopped`) are
  not reported.
- **On the account's page.** A failed changes pass or first sync is also counted (the account view's `sync.failures`
  and `error`, cleared by the next changes pass that works), and the Mail section says "Hasn't synced in …" from them
  and `sync.stateAt` (above).

### Skipped messages

An extractor may leave a message out of a `mail.changes`, `mail.list` or `mail.search` answer because it could not
parse it, and name its id in the answer's optional `skipped` (dither-accounts' interface). The server still has it, so
the hub keeps each such id pending (`mail_skipped`, schema-skipped.sql) per mailbox: a relist after a 410 never drops
its location, and `mail.get` reads it (sync.ts `readSkipped`, on the minute timer and when one is noted), a minute
after a failure, doubling to at most 6 hours; read, it is stored as its summary. A summary of it, the server's removing
it, or a 404 from `mail.get` ends it. Keep-all audits count a skipped id as the server's: held here it is held, else it
is fetched by id, and the window stays "missed" until it is read.

## Running it locally

- A demo hub has a mail account of its own, on a fake server (`hub/src/mail/fake.ts`, seeded by `seedDemoMail` in
  `hub/src/demo.ts`): a reply thread, a Cc'd thread with a file, list mail, an HTML-only message with a tracker and
  scripts, and an old receipt in a folder the hub does not follow, which only a search of the server finds.

      bun packages/hub/src/main.ts --demo --data /tmp/mail-demo --port 8700 --web <built web>
      bun scripts/verify-mail.ts http://127.0.0.1:8700 [screenshot dir]

  The demo's people answer what you send them 3 s later (`FakeOpts.answer`), so a demo hub notifies about mail.
  `DITHER_MAIL_HOLD_MS=500` shortens the 10 s Undo for scripts (`verify-notifications.ts` uses it).

  verify-mail drives it in headless Chromium on a phone (390 px, touch) and a desktop, in the dark and light themes:
  no page errors, nothing off the side of the screen; the Inbox's mail list (`#/inbox?mail=…`) with its four chips in
  one row; a person's mail as messages in their chat (yours too), with the subject tag and its card, the quote behind
  …, read here, and back on a phone; a thread of three or more as its own chat, its subject on one line beside
  Archive and ⋯ on a phone; the HTML-only message; and the reply it sends from the chat's box, under the subject pill,
  shown as text. Its `--proton` run (two accounts) also checks the account wheels over the Everything list.
  `DITHER_DEMO_MAIL_GMAIL=1` adds a Gmail account (a trip labelled Travel and marked Important, that you answered; Mom's photos under Family; a starred recipe; a booking
  archived under Travel; list mail), and `--gmail` checks it ("Gmail" above). Use a fresh data dir each run: reading marks threads read. With `--html` it also checks the
  frame (slice 3): no script runs in it, not even one put there by hand; no request leaves for anywhere but the hub;
  link clicks go through the opener, and a misleading one asks first; the image banner and the proxy; quotes, `cid:`
  pictures, files in the viewers; swiping back over a body. The demo's remote images are drawn by the hub itself
  (`hub/src/mail/demo-html.ts`), so a demo hub reaches nothing outside.
- Tests: `hub/test/mail-thread.test.ts` (threading, as a table), `mail-store.test.ts`, `mail-sync.test.ts` (the fake:
  first-sync order, `more`, 410, moves, Proton-like state, arrivals, gaps, the manager away, access ending, the delta
  sync), `mail-ops.test.ts` (writes on the fake: pending, batches of 1000, 404/403/501/410, a restart with changes
  waiting, the manager away, read in view and its setting, a read grant, `threadIds`, answers in part, an account's
  listed writes), `mail-gmail.test.ts` (a Gmail account: "Gmail" above) and `web/test/mail-model.test.ts`,
  `mail-text.test.ts`, `mail-ops.test.ts`.
- Slice 3: `mail-sanitize.test.ts` (a hostile corpus, each output parsed again against the allowlist),
  `mail-images.test.ts` (the token, private addresses in every spelling, DNS rebinding, redirects, not-an-image, size,
  headers) and `mail-parts.test.ts` (the routes on the fake).
- Writing: `web/test/mail-edits.test.ts` (the format bar's edits, lists going on, undo's steps, chips back to text,
  suggestions merged, rich text pasted as Markdown).
- Sending: `hub/test/mail-compose.test.ts` (recipients, subjects, quotes, the HTML part and its Markdown) and `mail-send.test.ts` (the
  fake: held and undone, 501 turning sending off with the message kept, a read grant, a dry run, retries and a timeout,
  files by path and by their bytes, a forward's files, From, a recipient or settings refused (422), a clientId sent
  once, a restart mid-send, the server's recipient suggestions).
  `mail-remote.test.ts` sends a reply through the SMTP sink and checks its headers and its copy in the thread.
  `verify-mail.ts` writes, undoes and sends on a phone (a reply from the chat's box held, undone and sent now; the full
  editor from a message's menu, a chip opened and undone, a bold reply drawn in the theme) and docks a new message on
  a desktop (the server's suggestions, a chip edited in place, B, the Markdown and HTML views, Ctrl+Z, a picture pasted in the text, a table and centred text kept through edits in HTML and
  Markdown, Plain, the reader's choice for one mail, a big newsletter forwarded with Link counting what can tell and
  its pictures embedded, discard and its Undo), last, since it sends. Start it a few seconds after the demo hub: the demo's two live notices
  arrive 4 s in, and their toasts would take its taps on a phone.
- `hub/test/mail-remote.test.ts` runs against a real manager with an `imap` account on dither-accounts' Dovecot and
  SMTP sink (ports 18580–18589). It needs the dither-accounts checkout (beside this repo, or `DITHER_ACCOUNTS_REPO`)
  and Dovecot (`DOVECOT_BIN`, or the binary dither-accounts' own imap tests found), and skips without them:

      DITHER_ACCOUNTS_REPO=~/Projects/dither-accounts bun test packages/hub/test/mail-remote.test.ts

- `hub/test/mail-remote-google.test.ts` does the same with a `google` account on dither-accounts' fake Google
  (test/fake-google.ts there): the first sync, a message arriving, and a Gmail page that stops answering and is
  reloaded, with no errors.ndjson line meanwhile. The google kind runs Chromium on Xvfb (and x11vnc), so it skips
  without them (and in CI); it takes a few minutes. `mail-gmail-web-contract.test.ts` runs one script of calls on the
  fake's `gmail-web` mode and pins where it differs from the google kind (mailbox and message ids, Starred), reading
  that extractor's protocol module when the checkout is there.

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
  event ("Not a person" is "Less like this"). `mailAttention(hub)` (`hub/src/mail/attention.ts`): `triage(threadId)`
  is where triage's rating lets a sender nobody knows into the inbox (on the list or above; no until slice 9),
  `triageFacts(messageIds)` gives the fold triage's pushes and questions, and `isListed`/`input`/`view` read a
  thread's listing and attention. A thread's class is `mail_thread.class` (`MailThreadView.class`, `unknown`), its
  owed time `MailThreadView.owedSince`, its inbox score `Attention.view(<thread id>)`.
- **Keeping all mail**: `keepOf(hub)` (`hub/src/mail/keep.ts`) is the hub's `Keeper`: `view(account)` measures an
  account against its server, `searchedLocally(id)` is what `server=auto` asks, `kick(id)` sets its work going.
  `MailStore.kept(id)` and `keptSql` say which accounts keep all their mail; `AccountSync.background(op, input)` is an
  archive read, `archiveGoes` whether one may go now.
- **Search** (slice 7): whatever stores a message, or a body's text in `mail_text`, is indexed by schema-search.sql's
  triggers, with no call. `mailSearchOf(hub)` is the hub's `MailSearch`; `local(q)` is the hub's own search,
  `search(q, { server })` adds the servers'. `mail_search.shut` marks messages only in Junk or Trash.
- **Triage** (slice 9): `mailTriage(hub)` (`hub/src/mail/triage.ts`): `rated(threadId)`, `factsOf(messageIds)`,
  `items(since)` (the board's), `chain(threadId)` for device rules, `gather`/`readTs` for delivery.ts. Each decision
  is a `mail_triage` row; `delivered` says a notification went out, `feedback` is your mark. The activity log's
  notification rows for mail carry the mail message and thread ids, which slice 10 can join to opens.
- `protocol/src/mail-iface.ts` is a copy of dither-accounts' interface types; `bun scripts/accounts-sync.ts --check`
  says when it differs.
