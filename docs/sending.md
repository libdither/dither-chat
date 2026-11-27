# Sending with more than words

A reply that does not ping its author, a message sent silently, sending later, taking the link previews off your own
message, and what you saved on Discord with its reminders. Built in net-gaps (send-extras), from the rows of
[research/discord-gaps.md](research/discord-gaps.md) "Messages: writing and actions" and "Search and discovery".
Protocol: `packages/protocol/src/sending.ts`. Hub: `sendextras.ts` (routes), `sendlater.ts`, `saved.ts`. Page:
`web/src/sending.ts`, `sendtimes.ts`, `ui/SendExtras.tsx`, `ui/SendLists.tsx` (a chunk of its own),
`ui/sendingMenu.tsx`. The Discord side is dither-accounts' `extractors/discord/src/sending.ts` and hook.js "sending
extras".

**Nothing here has run against a live account.** The hub's side is tested in `hub/test/sending.test.ts` (with the demo
world's Discord account, `hub/src/demosending.ts`), the Discord side against replicas of its client's modules
(dither-accounts `test/hook-sending.test.ts`, `test/sending.test.ts`), the page's pure parts in
`web/test/sendtimes.test.ts`.

## The box on a computer

Everything in the box sits on its last line, as tall as the send button, so a long draft grows up and away from the
controls rather than splitting them (`styles.css`, "A computer's box"). From left to right:

- **The + menu** (`Timeline.tsx`, `plusItems`): what this chat's network takes besides words, and only that. Today:
  **Upload a file** (with the network's size limit), **Poll** where an account here has `pollCreate`
  ([polls.md](polls.md)), **Sticker** where it has `sendStickers` ([media-kinds.md](media-kinds.md)), and **GIF** on
  Discord or wherever files go (media-kinds.md "GIFs"); the pickers open beside the +. Where files are all the network takes (Matrix, Telegram, WhatsApp and the rest), the + is
  a paperclip that opens the file picker at once. Nothing that does not work here is shown, disabled or not.
  Dropping or pasting files still attaches them without it.
- The text, then the emoji picker.
- **Send, with its menu as the narrow right half** of the same button (Send silently, Send later, Disappearing messages). An empty box shows
  the microphone in send's place ([media-kinds.md](media-kinds.md)).

Which of your accounts sends, where two or more are in the chat, is on the line above the box ("To #general · via
main", [chats.md](chats.md)); until 2026-11-16 it was a chip at the box's start.

A phone keeps its own row: + outside the box opening the attach sheet, sticker and camera inside it.

## Reply without a ping

Every reply used to ping its author on Discord: the hook sent only the message reference. The reply bar now has an
**@ On / Off** toggle, where the account can (capability `replyMention`). Off sends the reply as Discord's own reply bar
does with its @ toggle off: `allowedMentions: { parse: ['users', 'roles', 'everyone'], replied_user: false }` in the
client's own `sendMessage` options (on the REST path, `allowed_mentions` in the body). The choice is remembered per
account on this device (`localStorage`, `dither-chat:reply-mention:<account>`), as Discord's own toggle sticks; on is
the default. The send command's field is `mentionReplied: false`; the hub passes it only with a reply, and refuses
(409, nothing sent) when the account does not say it can, rather than sending with a ping after all.

## Send silently

The send button's menu (its narrow right half on a computer; on a phone, hold the send button, as in Signal and
Telegram, or right-click it with a mouse) has **Send silently** where the account can (capability
`silentSend`): Discord's @silent, flag `SUPPRESS_NOTIFICATIONS` (4096) in the client's own send options. It is for one
message, as @silent is: the next send is loud again. A bell-off icon says it is on: on the arrow on a computer, on the
send button's corner on a phone. A message sent
silently by anyone never alerts here either ([rich-messages.md](rich-messages.md)).

Signal's `send --no-urgent` is not the same thing and is not offered: it only leaves out the push that wakes the
recipient's phone, so the message arrives late and still notifies when their app next connects
([research/signal-gaps.md](research/signal-gaps.md)).

## Disappearing messages

On Signal and WhatsApp the same menu has **Disappearing messages**, with the chat's timer at its end ("Off", "1 week").
It opens the network's own timers under it; a pick changes the chat's timer for everyone in it, as the About panel
does ([group-settings.md](group-settings.md), "In the message box"). While a timer is on, the line above the box ends in
it ("· 1w"), and each message that will disappear shows its timer after its time.

## Send later

**Send later…** in the same menu, on every network, needs nothing from an adapter: the hub sends it.

- Pick a time: in an hour, the next 9:00 and 13:00, Monday 9:00 (Discord's own choices), or any time from a minute to a
  year ahead. What the composer holds goes, files too (uploaded first, then kept by the hub until it sends: the upload
  sweep leaves them, `uploads.ts held`), with its reply, silent and ping choices. The composer empties as after a send.
- It waits in `send_later` (made by `sendlater.ts`, no migration number). Every 10 seconds the hub sends what is due,
  through the ordinary send (`sendOnce`) with all its refusals, under its own id as the send's `clientId`, so a retry
  never sends it twice.
- **Its account not connected**: it stays waiting and says so ("Waiting for Discord · main to connect"), and goes once
  the account is back.
- **Never more than half an hour late without asking** (`SEND_LATER_LATE_MS`): past that it is **held**, and goes only
  when you say Send now (or you cancel it). A restart in the middle of a send leaves it failed with "it may have been
  sent", never sent again by itself.
- **Refused** (a message request, the network said no): **failed**, with the reason. Edit it and pick a time, Send
  now, or Cancel.
- A line above the box says what waits in this chat and when the first goes ("1 message goes out tomorrow at 9:00";
  red when one is held or failed). **View** opens the list: this chat or everywhere; each with Edit (text and time),
  Send now and Cancel. Sent ones stay ten minutes, then go. The list follows the hub's `scheduled` events.
- **Discord's own scheduled messages** (capability `nativeScheduled`) are read into the same list when it is opened, as
  "Scheduled on Discord: it sends it, even with the hub down", and can be cancelled. Only where Discord's client offers
  them to the account: its experiment `2026-08-scheduled-messages` decides, read through the client's own gate
  function; with it off, nothing is asked. The list is the request its Scheduled list makes
  (`GET /users/@me/scheduled-messages`), cancel its own cancel action. Making one natively is not built: the hub's Send
  later covers it, on every network.

Routes: `GET /api/scheduled` (`?network=1` adds the networks' own), `POST /api/scheduled` (`ScheduleBody`: a chat and
route, or a conversation and account; `dueAt`), `PATCH /api/scheduled/:id` (`body`, `dueAt`), `POST
/api/scheduled/:id/send`, `DELETE /api/scheduled/:id`.

## Saved on Discord, and reminders

Discord's saved messages ("bookmarks") and **Remind Me** (capability `savedMessages`). The message menu has **Save
Message** (or **Remove From Saved**), **Remind Me** (in 30 minutes, 1 hour, 3 hours, tomorrow, next week, or a picked
time) and **Saved Messages**, the list: reminders first (overdue ones marked), then saved messages newest first, each
with Open and Remove, and More while Discord has more.

- Through the client's own modules: its save and remove functions (where its menu's Save and Remind me end), its Saved
  list's fetch when the list is opened, and its `SavedMessagesStore`. What it loads by itself on connecting
  (`SAVED_MESSAGES_UPDATE`: the reminders whole, the rest only by id) and what the gateway says
  (`SAVED_MESSAGE_CREATE/DELETE`) come through as `saved` and `unsaved` events. Discord's limits are its own: 50
  reminders, 500 saved.
- **A reminder that comes due** notifies here like an alert ("Reminder: Ann", the message's text), held quiet in quiet
  hours: the client's own timer says `MESSAGE_REMINDER_DUE`, the adapter says `reminderDue`. One that came due while the
  account was away is not notified late; it shows as overdue in the list.
- The hub keeps what it last heard (`saved_message`), so the menu knows Save from Remove without asking Discord.
- **Not mapped onto the hub's own marks.** A saved message is not "Reply needed" ([inbox.md](inbox.md), "Marks"), a
  reminder is not a Later of the app's own, and "kept messages" are history kept when deleted
  ([history.md](history.md)): none of them means what Discord's save means, so each side keeps its own and nothing here
  changes the other.

## Remove Embeds, Report

Taking the link previews off a message, where the network lets you (capability `suppressEmbeds`,
`POST /api/messages/:id/remove-previews`). The hub's copy keeps none once the network said yes: it drops them from
the stored message itself, since an edit can come back with no extra at all and would leave them (`dropPreviews`).

- **Remove Embeds** on your own Discord message with link previews: the patch the client's own button sends (`flags`
  with `SUPPRESS_EMBEDS` added to the flags the message has; a message the client has not loaded is read first, as
  jumping to it does). The message comes again without its previews. There is no way back, as in Discord. A moderator
  can do the same to someone else's ([moderation.md](moderation.md)).
- **Remove Link Preview** on your own Signal or Telegram message with one. Neither network has a way to take a preview
  off on its own: their apps do it by editing the message and closing the preview, so this does that, after a confirm
  that says it will show as edited. Signal: `send --edit-timestamp` with the same words (the hub sends them along as
  the command's `body`; signal-cli keeps no copy) and the same quote, and no preview. Telegram: `messages.editMessage`
  with the message's own text and entities and `no_webpage`. Only while the message can still be edited, as their
  apps allow (`previewsRemovable` in the protocol): Signal 24 hours (Note to Self always), Telegram 48 (Saved
  Messages and a channel's posts always). Signal's apps offer no edit after that, so the adapter refuses one too.
- Matrix and WhatsApp: not offered. A Matrix room's previews are made by each reader's own app from the link, so there
  is nothing on the message to take off; WhatsApp's adapter reads no previews.

The demo world has a message with previews of each kind (libdither's #general, yours and Lev's; yours to Alice on
Signal), and `bun scripts/verify-previews.ts <demo hub> [screenshot dir]` clicks through all three in headless
Chromium. Not run against a live account.
- **Report on Discord** on someone else's Discord message opens it in Discord's own app, where reporting is done. No
  report request is made from here.

## Search and the emoji picker

- The reaction picker's custom emoji come in each server's own order of most used, from the client's `TopEmojiStore`
  (persisted; its emoji picker fetches it, never this). No request.
- **DMs-wide search** in one request (Discord's `SEARCH_TABS_DMS`) and **search tabs**: not built. The client's code
  that sends it is in a chunk not among those read, so its request body is unknown, and sending a guessed one is not a
  click. The hub's network search keeps asking each DM on its own ([indexing.md](indexing.md)).
- Smart search, synced recent searches: not built (gated, server-side; dither keeps its own).

## Ticks and held sends

Every send goes through the hub's queue for its chat ([sync.md](sync.md#the-send-queue)), and shows how far it got
under the chat's last message: a clock while only this device has it, one tick once the hub has it, two once the
network named the message, then the message's own receipts.

A send is **held** when anything came into its chat after what you could see as you pressed Send (someone else's
message, or your own from another device or app): "N new messages came in since you wrote this", with those messages
marked, and **Send**, **Edit** (it is cancelled and its text goes back into the box; attach its files again) and
**Cancel**. The sends behind it in the chat wait with it. A reply from a notification is held the same way when more
came after the message it answers, and the notification says "Reply waiting".

**Settings → Sending**: how long a held send counts down before it goes by itself, from 0 to 120 seconds, default 10
(kept on the hub, the same on every device). It counts only while one of your devices shows the chat; with nobody
looking it waits, and you are told. 0: no countdown, it always waits for you. Send later keeps its own hold (above),
and does not go through the queue yet.

## Not built

- **Channel summaries** (Discord's topic summaries of busy channels): they come only when a channel is opened in
  Discord's own UI, behind a per-server gate; the adapter does not open channels, so nothing would arrive.
- **Discord's AI features** (translate, summarize a thread, fix grammar, titles): gated and server-side.
