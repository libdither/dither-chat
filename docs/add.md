# Adding: joining servers and groups, adding people, answering requests

One box does it all: the **New** box (the + in the sidebar, "New message", "Join a server or group" and "Add
someone" in Ctrl+K, or an invite link pasted into Ctrl+K). Type a name to message someone you know, as before, or
paste or type what you have from elsewhere: an invite link, a Matrix address, an @username, a phone number. The box
says what it could be, an account on that network looks it up, and you get a preview card with what you can do:
Join, Ask to join, Add friend, Follow, Add contact, Message.

Status (2026-11-08): the protocol, the hub, the page and the demo adapters are done (slice A). **No real adapter has
it yet**: the adapters live in dither-accounts and are built from this contract next. Until an account says it can
(the capabilities below), the box says so in a plain line ("Joining from Discord invites isn't built for this account
yet") and offers no button. Messaging someone by Matrix ID, phone or Telegram @name works as it always did.

Slice B (next) shows requests in the inbox with Accept, Decline and Block, notifies them, and puts buttons on
profiles. Slice C turns invite links in messages into cards with Join.

## What the box reads

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
  its row is clicked; nothing per keystroke.
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

  Past it the hub answers 429 with a sentence that says when the next frees up. A network's own flood wait comes back
  as its error sentence, saying when, and is shown as it is.
- **Waiting:** 30 s for a lookup, 90 s for a join, a request or an answer (a join may wait on the network). A join that
  times out may still have gone through, and the box says so.
- **A check is never an error.** When the network wants something only you can do (a captcha, proving it is you, a
  verified phone, Discord's server rules), the card says "Discord wants a check first … Nothing was done", with a
  button to the account's live view: on this hub when it carries one, else the account's page on dither-accounts,
  else the account here.
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

- Capabilities: `resolve` (look it up), `join` (join and ask), `connect` (friend, follow, contact), `requests`.
- Commands: `resolve { ref }` → `AddPreview`; `add { ref, action }` → `AddResult` (Message goes through `openDirect`);
  `answer { request, answer }` → `AddResult`. Facts first (identities, spaces, conversations), then the reply.
- Events: `requests { requests }`, `request { request }`, `requestGone { nativeId }`.
- `AddPreview.partial`, `AddResult.check` (`captcha`, `verify`, `phone`, `rules`), `AddResult.notes`.
- `PersonRelationship` gains `following` (you follow them: X, Instagram).

## API

| Route | |
|---|---|
| POST /api/add/resolve `{accountId, ref}` | `AddPreviewView`: hub ids, the hub's media URL for the picture, the inviter as an identity (its view in `identities`), `joined` as hub ids, and only the actions this account can do (Message needs `openDirect`, Join and Ask `join`, the rest `connect`) |
| POST /api/add `{accountId, ref, action}` | `AddResultView`: the conversation to open (its view), the space, the identity, `pending`, `check`, `notes`, and where the check is done (`liveView`, `managerUrl`). Message is refused here: it is POST /api/directs |
| GET /api/requests | `{ requests: RequestView[] }` |
| POST /api/requests/:id `{answer}` | `AddResultView` |

Refusals: 400 for a reading `parseAdd` would not give or one from another network, 404 for no such account or request,
409 for an account that cannot (with the plain line) or is not connected, 429 past the pace, 502 with the network's
sentence, 504 when it did not answer. The bootstrap carries `requests`, and the live socket a `requests` event with
the whole list whenever it changes (journaled like `rules`, docs/sync.md).

## Per network

What each network will do once its adapter has it. **None of the real adapters do yet.**

| Network | Look up | Join | Add | Requests |
|---|---|---|---|---|
| Discord | invites with server, counts, inviter and expiry; usernames only partly (no lookup without sending the request) | Join; captcha and server rules come back as a check | Add friend (pending until they accept) | friend requests |
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

After connecting, the demo sends three requests: a Discord friend request, a Matrix room invite, and a Signal message
request whose conversation stays out of the inbox. A demo account's `capabilities` action (`{ without: [...] }`) says
hello again without some, to see the page without them.
