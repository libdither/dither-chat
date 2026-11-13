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

## Reply without a ping

Every reply used to ping its author on Discord: the hook sent only the message reference. The reply bar now has an
**@ On / Off** toggle, where the account can (capability `replyMention`). Off sends the reply as Discord's own reply bar
does with its @ toggle off: `allowedMentions: { parse: ['users', 'roles', 'everyone'], replied_user: false }` in the
client's own `sendMessage` options (on the REST path, `allowed_mentions` in the body). The choice is remembered per
account on this device (`localStorage`, `dither-chat:reply-mention:<account>`), as Discord's own toggle sticks; on is
the default. The send command's field is `mentionReplied: false`; the hub passes it only with a reply, and refuses
(409, nothing sent) when the account does not say it can, rather than sending with a ping after all.

## Send silently

The send button's menu (the small arrow beside it) has **Send silently** where the account can (capability
`silentSend`): Discord's @silent, flag `SUPPRESS_NOTIFICATIONS` (4096) in the client's own send options. It is for one
message, as @silent is: the next send is loud again. The bell-off icon on the arrow says it is on. A message sent
silently by anyone never alerts here either ([rich-messages.md](rich-messages.md)).

Signal's `send --no-urgent` is not the same thing and is not offered: it only leaves out the push that wakes the
recipient's phone, so the message arrives late and still notifies when their app next connects
([research/signal-gaps.md](research/signal-gaps.md)).

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
  reminder is not Catch up's Later (which lasts a session), and "kept messages" are history kept when deleted
  ([history.md](history.md)): none of them means what Discord's save means, so each side keeps its own and nothing here
  changes the other.

## Remove Embeds, Report

- **Remove Embeds** on your own Discord message with link previews (capability `suppressEmbeds`): the patch the
  client's own button sends (`flags` with `SUPPRESS_EMBEDS` added to the flags the message has; a message the client
  has not loaded is read first, as jumping to it does). The message comes again without its previews. There is no
  way back, as in Discord.
- **Report on Discord** on someone else's Discord message opens it in Discord's own app, where reporting is done. No
  report request is made from here.

## Search and the emoji picker

- The reaction picker's custom emoji come in each server's own order of most used, from the client's `TopEmojiStore`
  (persisted; its emoji picker fetches it, never this). No request.
- **DMs-wide search** in one request (Discord's `SEARCH_TABS_DMS`) and **search tabs**: not built. The client's code
  that sends it is in a chunk not among those read, so its request body is unknown, and sending a guessed one is not a
  click. The hub's network search keeps asking each DM on its own ([indexing.md](indexing.md)).
- Smart search, synced recent searches: not built (gated, server-side; dither keeps its own).

## Not built

- **Channel summaries** (Discord's topic summaries of busy channels): they come only when a channel is opened in
  Discord's own UI, behind a per-server gate; the adapter does not open channels, so nothing would arrive.
- **Discord's AI features** (translate, summarize a thread, fix grammar, titles): gated and server-side.
