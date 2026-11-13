# Adding: joining servers and groups, adding people, answering requests

One page does it all: **New**, a page of the Ctrl+K palette ([palette.md](palette.md)). It opens from the + in the
sidebar, from "New…", "New message", "Join a server or group" and "Add someone" in Ctrl+K, and from an invite link
pasted into Ctrl+K. Type a name to message someone you know, as before, or paste or type what you have from
elsewhere: an invite link, a Matrix address, an @username, a phone number. New says what it could be, an account on
that network looks it up, and you get a preview card, a page of its own, with what you can do: Join, Ask to join, Add
friend, Follow, Add contact, Message.

Adding someone to a group you are already in is **Add people**: on the group's page, and as "Add people to a group"
in New and in Ctrl+K (docs/group-settings.md, "Adding people").

Status (2026-11-08): the protocol, the hub, the page and the demo adapters are done (slice A). **No real adapter has
it yet**: the adapters live in dither-accounts and are built from this contract next. Until an account says it can
(the capabilities below), New says so in a plain line ("Joining from Discord invites isn't built for this account
yet") and offers no button. Messaging someone by Matrix ID, phone or Telegram @name works as it always did.

Slice B shows requests in the inbox with Accept, Decline and Block, notifies them, and puts buttons on profiles
("Requests on the page", below). Slice C turns invite links in messages into cards with Join. Relationships (2026-11-09,
below) adds the network's warning and confirm to requests, each account's list of friends, contacts and follows, a
DM's friend-request banner, and Remove friend and the like.

## What New reads

`parseAdd` (packages/protocol/src/add.ts) gives every reading of the input, most specific first. A link gives one; a
bare word or an @name may give several, one row per network that has a connected account here.

| Input | Reading |
|---|---|
| `discord.gg/CODE`, `discord.com/invite/CODE`, `discordapp.com/invite/CODE` | Discord invite |
| `discord.com/users/ID` | Discord person |
| a bare lowercase username (`[a-z0-9_.]{2,32}`, no `..`) | Discord person, last |
| `chat.whatsapp.com/CODE` | WhatsApp invite |
| `wa.me/PHONE` | WhatsApp person (+PHONE) |
| `t.me/+HASH`, `t.me/joinchat/HASH`, `telegram.me/…`, `tg://join?invite=HASH` | Telegram invite |
| `t.me/NAME`, `t.me/s/NAME`, `tg://resolve?domain=NAME`, `@NAME` | Telegram name: a person or a place, resolve says which |
| `t.me/+PHONE` | Telegram person |
| `signal.group/#…` | Signal invite (the code is the whole URL: signal-cli takes the URI) |
| `signal.me/#eu/…` | Signal person (the URL); `signal.me/#p/+PHONE`: Signal person (+PHONE) |
| `name.12` | Signal username with its number |
| `matrix.to/#/#alias:server?via=…`, `matrix.to/#/!id:server?via=…`, bare `#alias:server`, `!id:server` | Matrix place, with its via servers |
| `matrix.to/#/@user:server`, `@user:server` | Matrix person |
| `+PHONE`, any spacing | person on Signal, WhatsApp, Telegram and Google Messages |
| `x.com/NAME`, `twitter.com/NAME`; `instagram.com/NAME`; `facebook.com/NAME`, `m.me/NAME` | person on X; Instagram; Messenger |
| `@NAME` | also X and Instagram, after Telegram, where it fits their rules |
| any other scheme (`javascript:`, `ftp:`, `mailto:`), any other host, junk | nothing |

The hub takes back only a reading that `parseAdd` itself gives (`validAddRef`), so a page cannot send it anything
else.

## The rules

- **Only from a click.** Every lookup, join, request and answer happens because you clicked on the hub's page. There is
  no background or bulk path. A link resolves when it is pasted or Enter is pressed; a bare word or an @name only when
  its row is clicked or taken with Enter; nothing per keystroke.
- **Look before acting.** `resolve` says what it is without joining, following or telling anyone. Some networks will
  not say more without acting (a Signal group link, a Discord username): the preview is then *partial*, the card says
  "Can't preview this without joining" (or "without asking"), and the buttons are still there. Not found and expired
  come back as the network's own sentence ("This invite has expired or was revoked"), shown on the card.
- **Paced per account**, in a table (`add_pace`), so a restart does not reset it. The numbers are `ADD_LIMITS` in
  packages/hub/src/add.ts:

  | What | Limit | WhatsApp |
  |---|---|---|
  | looking up (`resolve`) | 60 an hour | 20 an hour (its +phone lookup is a watched usync query) |
  | joining and asking to join | 10 a day | 5 a day |
  | friend, follow, contact | 20 a day | 20 a day |
  | removing: unfriend, cancel a request, unblock, remove a contact, unfollow | 20 a day | 20 a day |
  | making a group (`groups`), plus one `members` slot per person in it | 5 a day, 3 on Telegram | left out |

  Past it the hub answers 429 with a sentence that says when the next frees up. A network's own flood wait comes back
  as its error sentence, saying when, and is shown as it is.
- **Waiting:** 30 s for a lookup, 90 s for a join, a request or an answer (a join may wait on the network). A join that
  times out may still have gone through, and the card says so.
- **A check is never an error.** When the network wants something only you can do (a captcha, proving it is you, a
  verified phone, Discord's server rules), the card says "Discord wants a check first … Nothing was done", with a
  button to the account's live view: on this hub when it carries one, else the account's page on dither-accounts,
  else the account here. Discord's rules (and an application, and onboarding) can be answered from the server's page instead,
  by you, where the account's adapter has `gates` ([servers.md](servers.md)).
- **A confirm is the owner's.** When the network wants a confirm first (Discord: "You must confirm the friend request
  to add this user."), nothing was done: the card shows its words and Accept anyway or Add anyway, which sends the
  same thing again with `confirm: true`. An adapter confirms only when the command says so. Such a slot is given back
  to the pace.
- **Logged.** What you joined, asked, added or answered goes in the account's log on the hub (`--- <time> [add] …`),
  shown with the account's adapter log, also for accounts dither-accounts runs.

## Requests

A request waits on you: someone wants to be friends, to follow you, has invited you somewhere, has messaged you
without being a contact (Signal, Instagram, Messenger, X), or asks to join a group you run.

- The hub keeps them in `add_request`. An adapter sends its whole list after it connects (`requests`), then each new or
  changed one (`request`) and each that went (`requestGone`). The list stays as it is until a `requests` event comes:
  connecting, disconnecting or restarting clears nothing (Instagram, Messenger and X only know theirs a few minutes
  after connecting). They go with the account when it is deleted.
- **A message request is kept quiet.** Its conversation stays out of the inbox and its notifications (triage decides
  silent), and the hub never sends `markRead` or `typing` for it, from a read, mark-all-read or the composer, until it
  is accepted: on Signal, Instagram, Messenger and X, opening a request tells the sender. The adapter still sends the
  conversation and its messages as usual.
- Answering: POST /api/requests/:id with one of the answers the request offers.

## Protocol (packages/protocol/src/add.ts, adapter.ts)

Additive; `PROTOCOL_VERSION` stays 1.

- Capabilities: `resolve` (look it up), `join` (join and ask), `connect` (friend, follow, contact), `requests`,
  `relationships` (the account's list), `disconnect` (remove).
- Commands: `resolve { ref }` → `AddPreview`; `add { ref, action, confirm? }` → `AddResult` (Message goes through
  `openDirect`); `answer { request, answer, confirm? }` → `AddResult`; `remove { identity, relationship }` →
  `AddResult`. Facts first (identities, spaces, conversations), then the reply.
- Events: `requests { requests }`, `request { request }`, `requestGone { nativeId }`, `relationships { list }`,
  `relationship { fact }`.
- `AddPreview.partial`, `AddResult.check` (`captcha`, `verify`, `phone`, `rules`), `AddResult.confirm` (the network's
  words), `AddResult.notes`, `RequestFact.warning` (the network's words when it flagged a request).
- `PersonRelationship` gains `following` (you follow them: X, Instagram). `RelationshipFact { identity, relationship,
  since? }`, where relationship is friend, requested, blocked, contact, following, or stranger for gone.

## API

| Route | |
|---|---|
| POST /api/add/resolve `{accountId, ref}` | `AddPreviewView`: hub ids, the hub's media URL for the picture, the inviter as an identity (its view in `identities`), `joined` as hub ids, and only the actions this account can do (Message needs `openDirect`, Join and Ask `join`, the rest `connect`) |
| POST /api/add `{accountId, ref, action, confirm?}` | `AddResultView`: the conversation to open (its view), the space, the identity, `pending`, `check`, `notes`, and where the check is done (`liveView`, `managerUrl`). Message is refused here: it is POST /api/directs |
| GET /api/requests | `{ requests: RequestView[] }` (each with `warning`) |
| POST /api/requests/:id `{answer, confirm?}` | `AddResultView` (with `confirm`, the network's words, when it wants one first) |
| GET /api/people `?relationship=&account=` | `PeopleLinksView`: the accounts' list entries (friend, requested, blocked, contact, following), by name, with their identities |
| POST /api/people/:identityId/remove `{relationship, accountId?}` | `AddResultView` with the relationship after. Only from the page (a browser's Origin, same-origin); without accountId, the one account whose list says so |

Refusals: 400 for a reading `parseAdd` would not give or one from another network, 404 for no such account or request,
409 for an account that cannot (with the plain line) or is not connected, 429 past the pace, 502 with the network's
sentence, 504 when it did not answer. The bootstrap carries `requests`, and the live socket a `requests` event with
the whole list whenever it changes (journaled like `rules`, docs/sync.md).

## Per network

What each network will do once its adapter has it. **None of the real adapters do yet.**

| Network | Look up | Join | Add | Requests |
|---|---|---|---|---|
| Discord | invites with server, counts, inviter and expiry; usernames only partly (no lookup without sending the request) | Join; captcha and server rules come back as a check | Add friend (pending until they accept) | friend requests; message requests and spam DMs (`message:<channel>`, spam ones `spam`) |
| Matrix | `#alias` and `!id` with via servers; users by profile | Join, Ask (knock) | none; Message opens a DM | room and space invites |
| Telegram | invites, @names (a person, group or channel) | Join, Ask (join requests) | Add contact, which does not share your number | join requests to groups you run |
| Signal | group links only partly (signal-cli has no preview); usernames and phones | Join (admin approval is pending) | none; Message | message requests, group invites |
| WhatsApp | group invite links; phones | Join (approval is pending) | none; Message | group join requests you approve |
| Google Messages | phones | none | none | none: its spam folder has nothing to accept |
| Instagram, X, Messenger | handles, profile names | none | Follow (Instagram, X) | message requests, follow requests |

### What a dither-accounts adapter would call

| Network | Calls |
|---|---|
| Discord | the web client's own `InviteActions` (resolve, accept) and `RelationshipActions` (send a request, accept, ignore, block), in the sandbox, so it looks like the client |
| Matrix | `GET /directory/room/{alias}` to resolve, `POST /join/{roomIdOrAlias}?server_name=…`, `POST /knock/{roomIdOrAlias}`, `invite_state` from sync for invites, `/profile/{userId}` for people |
| Telegram | `messages.checkChatInvite`, `messages.importChatInvite`, `contacts.resolveUsername`, `channels.joinChannel`, `contacts.addContact` (without `add_phone_privacy_exception`), `messages.hideChatJoinRequest` |
| Signal | signal-cli `joinGroup` (the URI), `updateGroup`, `sendMessageRequestResponse` (accept, delete, block) |
| WhatsApp | whatsmeow `GetGroupInfoFromLink`, `JoinGroupWithLink`, `JoinGroupWithInvite`, `UpdateGroupRequestParticipants` |

## The demo world

`--demo` hubs have something for every path, for scripts/verify-add.ts and for trying it:

| Paste or type | What happens |
|---|---|
| `discord.gg/libdither` | a server you are in already: Open |
| `discord.gg/pixelart` | Pixel Art Club: Join adds the server with two channels |
| `discord.gg/speedrun` | Join comes back as a captcha check |
| `discord.gg/oldparty` | "This invite has expired or was revoked" |
| a Discord username (`mara`) | partial; Add friend is pending |
| `#rust-gamedev:matrix.org` | a room: Join; `#private-lab:matrix.org` asks (a knock); `#nixos:nixos.org` you are in |
| `t.me/+FilmSwap2026x` | a Telegram group: Join; `t.me/+ClimbAsk2026` asks |
| `@dithernews` | a Telegram channel; `@lena_k` a person: Message or Add contact |
| `chat.whatsapp.com/MapleGardenSwap26` | a WhatsApp group: Join |
| any `signal.group/#…` link | partial; Join adds a group |

After connecting, the demo sends five requests: a Discord friend request to main, two to alt that Discord flagged (one
as possible spam, one from someone it shares nothing with: Accept without confirm comes back with Discord's confirm
sentence, and Message to the spam one is refused), a Matrix room invite, and a Signal message request whose
conversation stays out of the inbox. The Discord and Telegram accounts send their lists: main's friends and a block,
alt's friends and a request it sent (Mara), Telegram's contacts and a block; each can be removed. Add friend on a
Discord username nobody in the demo has (`kestrel.dev`) wants a confirm first. A demo account's `capabilities` action
(`{ without: [...] }`) says hello again without some, to see the page without them, and `relate` (`{ who,
relationship }`) puts someone on its list, for a kind no demo network has (following).

## QR codes

New has **Scan a code** and **My code** among its rows (each a page), and a place's invite link has **Show QR** beside it.
The code is in packages/web/src/qr.ts (pure: the links, what a scan is, drawing) and ui/QrCodes.tsx.

### Scan

Scan opens the camera (packages/web/src/qrscan.ts: the browser's BarcodeDetector where it has one, else jsQR). Where
there is no camera, as on most desktops, or it is not allowed, the page says so; a picture of the code works
everywhere: choose one, paste one (Ctrl+V) or drop one on the page.

- A code that holds a link or an address `parseAdd` reads goes into New exactly as a paste would: a link is
  looked up at once and lands on its preview card; an `@name`, `+phone` or `#alias:server` shows its readings. So a
  Signal group code, a WhatsApp group or contact link, a `t.me` link, a `matrix.to` link and a Discord invite code all
  work, and so does every code in My code below.
- **A scan never acts.** It only fills New: joining, asking, adding and messaging stay buttons on the card.
- Anything else (a Wi-Fi code, a plain web page, a bare word) is shown as text with "This code isn't an invite or a
  profile link". A Telegram sign-in code (`tg://login`) also says to approve sign-ins only from the Telegram account's
  page (docs/accounts.md), never from here.
- The camera runs only while Scan is open and the page is in view.

### My code

One code per account, picked by its chip, for the link that adds or messages you on that network. It is built from
the account's own identity as the hub knows it (its native id and handle), without asking the network. Every link is
kept only if `parseAdd` reads it back as you on that network, so our own Scan understands each one; a phone's camera
opens it in the app, which is the point for networks with no QR codes of their own.

| Network | The code holds | Notes |
|---|---|---|
| Matrix | `https://matrix.to/#/@you:server` | matrix.to hands it to their Matrix app |
| Telegram | `https://t.me/<username>` | without a username: `https://t.me/+<number>`, hidden until tapped, which Telegram opens only for people your privacy settings let find you by number |
| WhatsApp | `https://wa.me/<number>` | always a number: hidden until tapped. An account known only by its LID has none |
| Discord | `https://discord.com/users/<id>` | opens your profile, where they can send a friend request |
| Signal | `https://signal.me/#p/+<number>` | hidden until tapped. A username code needs the adapter: Signal makes username links (`signal.me/#eu/…`) on its servers, and the page says so |
| X | `https://x.com/<handle>` | |
| Instagram | `https://instagram.com/<username>` | |
| Messenger | `https://m.me/<username>`, else `https://www.facebook.com/profile.php?id=<id>` | |
| Google Messages | none | people reach you by your phone number |

Each code has its link under it, Copy, and Share where the device has a share sheet (`navigator.share`).

**Privacy.** A phone number is never drawn or written until you tap "Show my number's code", under a warning that
anyone who sees or scans the code gets your number. It is hidden again whenever My code opens or you pick another
account, and "Hide my number" hides it at once. A profile link says who you are on that network to anyone who scans
it; that is what it is for, so show it to the people you mean to.

### A place's code

Where a place's About shows its invite link (InviteSection in ui/About.tsx: Discord servers, Signal and WhatsApp
groups, Matrix rooms' `matrix.to` links), **Show QR** draws the same link. It never makes, resets or turns off a link;
those stay the buttons below it.

### Drawing

Codes are always black on white with a four-module quiet zone and square edges (`qrSvg`, uqr, error correction M), on
a white tile whatever the theme: phone scanners need the contrast. They are at most 264 px wide in the palette (220 px in
About), and fit a phone's sheet.

scripts/verify-qr.ts checks all of it against a demo hub: every demo account's code decodes (from a screenshot, with
jsQR) back to the link under it in a dark and a light theme, the numbers stay hidden until tapped, a picture of
`discord.gg/pixelart` lands on its preview, a Wi-Fi code shows the plain line, the Signal climbing group's invite QR
decodes to its link, and My code fits a phone.

## Invites in messages

An invite link in a message gets a card under it, the way Discord shows invites: Discord, WhatsApp and Telegram
invites, Signal group links, Matrix rooms by `matrix.to` link, and Telegram `t.me/name` links (a person, a group or a
channel; the lookup says which). Links written without `https://` count (`t.me/+…`, `discord.gg/…`) and are linked in
the text, as Telegram links them. A link inside code, a link to one message in a room or channel, and a link to a
person get no card, and one message gets at most three. Mail is not covered.

- **What it is at once, looked up only on a click.** The card shows the network, what kind of link it is ("Discord
  server invite", "Matrix room") and a Preview button. Nothing is asked of a network while chats scroll by: each look
  is a request from your account and counts against the pace. Preview asks the account the message came through, when
  it can, and then the card shows what New's card shows (name, picture, members and online, description, who invited,
  when it runs out, partial and other notes) with the same actions and the same check and pending screens, from the
  same components (`AddCard`, `actOn` in packages/web/src/ui/NewMessage.tsx). An expired or revoked invite
  shows the network's sentence.
- **Kept for an hour.** The hub keeps each preview it got, per account and reading, for an hour (`PREVIEW_CACHE` in
  packages/hub/src/add.ts: in memory, up to 500, the least recently used out first; a restart forgets them, and errors
  are never kept). Looking the same thing up again within the hour, from any page or device, gets the kept answer
  without asking the network and without counting against the pace. A card asks the hub what it kept when it is drawn,
  so reopening the chat, a reload or another device shows the preview without a click:

  | Route | |
  |---|---|
  | POST /api/add/cached `{refs}` | `{ previews: AddPreviewView[] }`: what the hub kept of these readings (up to 50), one per account that looked. Never a request to a network, never paced |

- **Joined.** After a join from a card or from New, the kept preview says joined; after an ask, that you asked. A
  preview of a server, group or room the hub already holds says joined too, and so does a Matrix room link by its
  `!id`, without any lookup. The card then says Joined, with Open.
- **A click on the link** opens New on it, at its card, as if it were pasted, instead of the browser or the desktop helper.
  Its menu (right-click, or hold) has Preview Invite, Open in Browser and Copy Link. A click with Ctrl, Cmd, Shift or
  the middle button opens it in a tab as before.
- **No account can look it up:** the card still says what it is, with the plain line ("Joining from Discord invites
  isn't built for this account yet", or "No connected Discord account here can join this.") and no button.

Code: packages/web/src/invites.ts (which links get a card and what kind they are, tested alone),
packages/web/src/ui/InviteCard.tsx (the card) and the cache in packages/hub/src/add.ts. scripts/verify-invites.ts tries
it end to end on a demo hub, where the `addLog` account action says how many lookups each demo account was asked for.

## Requests on the page (slice B)

What waits on you has one row in the inbox and a view of its own; a message request opens read-only; a request from
someone you know notifies once; and a profile has the buttons for how you stand with them.

- **The Requests row.** While anything waits, the one-list inbox has a **Requests** row at its top, under "Needs you",
  whatever the filter: how many, who asked, and when the newest came. It counts on no badge: a request is not unread.
  What a network filed as spam (Discord's spam DMs) is not counted or named there either, only said ("2 filed as
  spam"), and waits last in the view under "Filed as spam"; it never notifies.
  Opening it is the Requests view (`#/requests`; `#/requests/<id>` shows one card, outlined). On a desktop it is the
  main pane, beside the inbox; on a phone a full-screen list over it, with Back.
- **A card per request**, grouped in this order: friend requests, invites (to groups, servers and rooms), message
  requests, follow requests, and people asking to join a group you run. A card says who (their picture with the
  network's badge; the name opens their profile), what ("invited you to Nix Hackathon 2026", the place's member count
  when the network says), the network and the account it came to, and when; then the buttons the request offers
  (Accept, Decline, Block, from its `answers`). Block asks once more. An error from the network shows on the card. An
  accepted invite or message request lands where it leads (the room, the server, the conversation), with the
  network's notes as a note; an accepted friend request says so. A `check` result shows the same "Discord wants a
  check first … Nothing was done" as New's card, with the live-view button (`CheckFirst` in NewMessage.tsx), and the
  request stays.
- **A message request opens read-only.** Its card shows the last thing they wrote and says plainly: accepting tells
  them you saw it, and on Signal, Instagram, Messenger and X even opening it on another device does; here it does not,
  since the hub sends that network no read receipts and no typing for it until Accept. "Read what they wrote" opens
  the conversation with a bar in place of the composer: the same line and Accept, Decline, Block. Accepted, the
  composer comes back; declined or blocked, the page goes back to Requests. The page marks it read on the hub as it
  does any conversation, and the hub keeps that from the network (`requestHeld`). The hub also refuses to send there
  ("Accept the message request first"), and the conversation stays out of People and of every unread total.
- **Notifications.** A new request from someone you know notifies once, as a **row on the phone's list**: silent,
  sorted among the list's rows as something the network would have notified you about, and nothing on a computer
  (docs/notifications.md "Requests"). Someone you know: they have a person here (for a message request, one you named,
  set to Always alert or merged: its own conversation made one), or they share a conversation or group with the
  account it came to, are a member of a server it sees, or wrote in a channel it sees. Requests from strangers,
  message requests among them, only count on the row. Each request is judged once (`add_request_seen`), 20 seconds
  after it arrives so the account's first sync has said who people are, and only when it is under two days old
  (`REQUEST_NOTICE`, packages/hub/src/requestnotify.ts). Quiet hours do not hold it (they hold alerts, and this is silent); an account,
  a network or everything set to Mute keeps it off the list too, and device rules for its account or network keep it
  off that device. The notification opens the
  Requests view at its card (sw.js, the Android app, an ntfy topic's click). Requests the hub held before this was
  built are not news.
- **Profile buttons.** From what each network says about how you stand with them (`relationship`): a stranger gets
  **Add friend** (Discord), **Follow** (X, Instagram) or **Add contact** (Telegram), through `POST /api/add` with a
  reading made from their identity, as the account that asked about them where it can; someone who asked you gets
  **Accept** and **Decline** for that open request; a request you sent says **Request sent**, someone you follow
  **Following**. Nothing shows where no connected account has the capability (`connect`, `requests`) or the network
  has no such way. The hub writes the new relationship into the profile it keeps, so a reload says the same until
  the network is asked again. Code: packages/web/src/requests.ts (pure), ui/Requests.tsx.

Checked by scripts/verify-requests.ts against a demo hub: the row with 5, the buttons on the requester and on a
stranger (and none without `connect`), the view on a phone, grouped cards, the Matrix invite accepted into its room,
the Signal message request opened with no read receipt to Signal (the demo account's `readLog` action) and accepted
into a composer, and the Discord friend requests declined, taking the row with them.

## Relationships

How each of your accounts stands with someone, and ending it (2026-11-09). An incoming request is still a request
(above); everything else is the account's list.

- **The list.** An adapter with `relationships` sends its whole list after it connects and each change after. The hub
  keeps it in `person_link (account_id, identity_id, relationship, since)`: a `relationships` event replaces the
  account's rows, a `relationship` event changes one, and `stranger` removes it. A request accepted, an Add friend
  and a remove write their result there at once when the account has a list. A profile's relationship comes from it
  when the account has them on it, else from the network's profile (people.ts).
- **Flagged requests.** A request the network flagged carries its words (`warning`): Discord's "Discord filed this
  request as possible spam" or "Discord says you share no server or friend with them". The card shows them above the
  buttons, and Accept takes a second click: the step repeats the words and says "Nothing is accepted yet. Accept it
  anyway, or message them first to see who they are." Accept anyway sends `confirm: true`. An answer that comes back
  with `confirm` shows the same step with the network's sentence.
- **The card** also says plainly which account it came to ("to your Discord account main"), and its avatar and name
  open the profile. **Message** opens the DM with them on that account, or starts it through POST /api/directs; a
  network that will not open it says why, on the card.
- **A DM's banner.** A direct conversation's view carries `pending` when a friend or follow request waits between one
  of its accounts and the other person: theirs (from `add_request`, with the request to answer) or yours (the list
  says `requested`). The page shows it under the header, as Discord does: "Wren wants to be friends" with Accept,
  Decline and Block (and the warning), or "Friend request sent" with Cancel.
- **Removing.** POST /api/people/:identityId/remove asks the adapter (`remove`) to end what the owner saw: friend →
  unfriend, requested → cancel, blocked → unblock, contact → remove the contact, following → unfollow. The adapter
  refuses when the network says otherwise now ("That changed; look again"). Only on a click on the hub's own page,
  paced on its own at 20 a day per account. Every button asks first, naming the account.
- **Where.** A profile's **How you stand** card lists each account's entry with its button. People has chips for
  Friends, Contacts and Following beside Chats, each shown where an account here keeps that kind of list (Discord
  friends; Telegram, Signal, WhatsApp and Google Messages contacts; X and Instagram follows). In each list:
  - **One row per person** (`linkRows`: by person, else by identity). An identity is one per network and native id,
    so a friend of two Discord accounts is one identity with two links, and one row. With several accounts on the
    list, the row has a dot in each account's colour, named in the dots' tooltip.
  - **The second line** says when you last talked: the latest message in your DMs with them, on any network
    ("talked 3 days ago"), else nothing. Presence never reaches the page unless the adversarial presence log is on,
    so the list does not say who is online. "Friends since" is in the row's tooltip (and on the profile).
  - **An account menu** under "People" when the list has people on several accounts, like Mail's: All accounts, or
    one, each with its colour, and a line saying what the dots are.
  - **The order**: last talked first (people you never talked with after, by name), or A to Z, from the order
    button in the header; kept per device. A **filter box** narrows the list by name, on the page (Chats has it too).
  - **Removing** is in the row's menu (right-click, or a long press on a phone): Remove friend, Cancel request,
    Unblock, Remove contact or Unfollow, one item per account when they are on several. It asks first, as on the
    profile. Until 2026-11-09 each row had a × for it, one slip away on a phone.

| Network | List | Remove |
|---|---|---|
| Discord | friend, requested, blocked | unfriend, cancel, unblock (the client's own actions, dither-accounts) |
| Telegram | contact, blocked | delete the contact, unblock |
| X, Instagram | following, later | unfollow |

Code: packages/hub/src/add.ts (person_link, the routes), packages/web/src/requests.ts (pure: the lines, the rows,
`sortLinkRows`, `nameMatches`, `talkedLine`), ui/Requests.tsx (`Answers`, `LinkBanner`, `ProfileLinks`, `PeopleLinks`,
`PeopleAccountPicker`, `RemoveDialog`), `PeopleSidebar` in ui/Sidebar.tsx, ConfirmFirst in
ui/NewMessage.tsx. Tested by packages/hub/test/links.test.ts and scripts/verify-people-links.ts, which drives every
screen at a desktop and a phone width on a demo hub.
