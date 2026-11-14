# @ mentions

Typing `@` in the composer opens a list of who this conversation can ping. Picking a row puts the network's own
mention in the message, so the person is notified the way that network notifies, from whichever app they read it in.

This page covers the picker, the hub's endpoint, the adapter command behind it, and what a mention becomes on each
network. Steps 1 to 3 of the design approved on 2026-11-13 are built. Steps 1 and 2: the people here, their roles, and
@everyone where you may write it, on Discord, Matrix and Telegram (dither-accounts), and from the hub alone elsewhere.
Step 3: a place setting for whom the picker offers (friends, everyone you know, optionally only on the chat's network),
with `<@person:…>` and `<@identity:…>` references that the hub lowers on send.

The owner's words: "allow channels to have a configuration option to have @ where it searches friends or everyone
known, optionally filtered by same platform (i.e. for like a future calendar chat where I might want to refer to a
specific friend or a specific friend on a platform)."

## In a body

Canonical bodies (protocol `adapter.ts`, MessageFact) carry mentions as Discord writes them, whatever the network:

| Token | Meaning |
|---|---|
| `<@nativeId>` | One account: a Discord snowflake, a Signal ACI, a Matrix `@user:server` (so `<@@user:server>`), a WhatsApp JID, a Telegram user id |
| `<@&roleId>` | A Discord role |
| `<#convNativeId>` | A channel or room (not a mention: nobody is notified) |
| `@everyone`, `@here` | Discord: everyone who can see the channel, or those of them online |
| `@room` | Matrix: everyone in the room (Step 2) |
| `<@person:per_…>` | A hub person, by reference (Step 3). Lowered on send, see [References](#references-and-lowering) |
| `<@identity:idn_…>` | One of a person's accounts, by reference (Step 3). Lowered the same way |

The web app draws these as chips (`markdown.ts`; Timeline.tsx's `useMdContext` names them from the hub's identities).
A reference is a chip too: a person's name, or an account's name and network ("Alice · Signal"), opening their page.
You see them in a Calendar chat, where they stay, and in your own message until the network's copy comes back. One this
device does not know reads `@someone`, never the id.

## The picker

`ui/MentionComplete.tsx` sits in the composer next to the emoji list. It is all the app carries at start: it watches
the box for an `@` being typed (`mentionComplete.ts`) and loads the list the first time one is. The list
(`ui/MentionPicker.tsx`, `mentionRows.ts`, `ui/mentions.css`) is a chunk of its own, about 3 KB gzipped.

When it opens. As for the `:` emoji list: after a space, the start of a line, or an opening bracket or quote. So
`name@host`, a mail address and a written `<@id>` never open it, and nor does an `@` inside `code`, a ``` block or a
URL. A bare `@` opens it on the people here before anything is typed. The query runs to the caret, up to 32 characters,
with no space, `@`, `<`, `>` or backtick in it.

Rows. They come at once from what this device holds: the conversation's participants, and who wrote in its loaded
messages, best name match first, then who spoke last. 150 ms after the typing stops, the hub is asked, and its rows
replace them. The hub's rows include what it stores and what the network says, in the hub's order. An answer is kept for
a minute, so typing back over a name draws at once and asks nothing. An answer without the network's part (`partial`) is
not kept, and the rows this device had stay below it. While the hub is asked, the head says "asking Discord…"; after a
partial answer it says the network did not answer.

Each row shows a picture with its network's badge, the name, the handle, and a bell: the network notifies them. A row
with a struck-through bell is text only: the others see a plain @Name and nobody is notified (Step 3's friends from other
networks). A role row is drawn in the role's colour. @everyone and @here appear only when the network says you may write
them here.

Sections. Past the people here come Friends and Everyone you know, as the place's setting says (below), each under a
header; with the people here alone there are no headers. A person's row shows the networks they are on. Its bell is
struck through when they have no account on this chat's network: you get a plain @Name.

Keys, as in the emoji list: arrows move, Enter or Tab puts the row in, Escape closes the list for that `@` until a new
one is typed. On someone with several accounts, → (or the arrow at the row's end) opens them, each as "Alice ·
Discord", "Alice · Signal" with its own bell; a person from friends or everyone comes first, as what their row puts in.
Enter or a click on such a person opens them too, while on someone here it puts in their mention here, as before. ← or
Escape goes back to the list. Tab always puts the row in as it is.

A row here for someone the hub knows as one person on other networks too carries those accounts (`accounts`), so you
can name one of them: in a Discord channel, Theo's Signal account is put in by reference and goes out as plain @Theo K. The list listens on the composer in the capture phase, so the composer's own Enter (send) and Escape
(cancel the reply) never see those keys while it is open. On a phone, Enter in the list picks a row, and does not start a
new line. A pick replaces the `@query` with the row's `insert` (`<@nativeId> `, `<@&id> `, `@everyone `), through
`execCommand('insertText')`, so it can be undone. It adds a space unless one follows already. A person, an account or
a role goes in as a chip, which the box shows as its name ([In the message box](#in-the-message-box)); `@everyone` and
`@here` go in as the text they are.

The account asked is the one the composer sends from (the send-as chip, else the connected one).

## In the message box

A mention in the box reads as its name, "@Quinn", drawn as a chip, while the body keeps its token: the box is not a
rich text editor, it holds plain text, and a mention is drawn as one piece only while it is all there, as a font draws a
ligature only while all its letters are. The owner asked for it on 2026-11-13: the box showed `<@700000000000000001>`.

How it is held (`packages/web/src/composerChips.ts`). The box's text holds a chip as its `@`, then the token in
invisible Unicode tag characters (U+E0020 to U+E007E, one for each ASCII character of `<@…>`), then the rest of the
name, then a cancel tag (U+E007F). So the box's text says everything by itself: undo and redo, a draft, a paste and the
caret keep a chip whole, and nothing is kept beside it. The tags go after the `@`, not before it: a browser counts tag
characters as one character with the one before them, so with the tags first a selection could not start at the
chip, and deleting it left the tags behind. The composer keeps the body (`text` in Timeline.tsx's Composer, the draft
in localStorage): `toBody` takes each chip back to its token and drops any other tag character, so none is ever sent.
`toShown` makes the box's text for a body (a draft, a message being edited), as chips where this device can name the
token: its person or account in the db (as a message names it, Timeline.tsx `useMdContext`), else the name the @ list
gave it this session (a server member the hub never stored, a role). A token it cannot name, or one inside code, stays
as written.

What rides in the app (`ui/ChipBox.tsx`, `useChipBox`): the box's text for the body, the body for what is typed, and two
rules on each edit the box makes by itself (a word deleted, a keyboard's correction, typing over a selection). A chip
the edit cut into but did not take whole is taken out whole (`cuts`, the edit found where the old and new text differ,
ending at the caret). A token typed whole becomes a chip at its `>` (`typedToken`). Undo and redo are left as they come.

The chips themselves (`ui/ChipLayer.ts`) are a chunk of their own, about 2 KB gzipped, loaded the first time a chip is
in the box; until it loads the box already reads "@Quinn". It is drawn with `h`, not JSX, and gets everything that
reads the db as props: either would split a file of its own out of the app's start. It draws:

- Each chip's background, behind the box's own text: a copy of the box's text, laid out with the box's font, padding,
  borders, width and scrollbar, placed under it and scrolled with it. The box (`textarea.chip-box`) is lifted over the
  copy, so the caret, the selection and the text are the box's own. The chip is `--accent-soft`, 2 px wider than the name
  on each side.
- One piece. A caret put inside a chip, by a click or an arrow, goes to the end it was moving towards (or the nearer
  one). Backspace right after a chip, or Delete right before one, takes it whole, and so does typing over a selection
  that cuts into one, each as one step to undo (`beforeinput`). A selection made by dragging or with Shift takes the
  chips it cuts into whole once it is made.
- Copy and cut: `text/plain` reads the names ("hi @Quinn"), and `text/x-dither-chat-body` carries the body; a paste in
  a message box reads that first, else turns tokens in plain text into chips.
- A click on a chip opens the person's page (an account by reference, or by its id on this network, opens its own),
  only in a box that had the caret already: the tap that puts the caret in the box never leaves the chat. Over one that
  opens, the pointer is a hand and the box's tooltip says whose page. A role, or a member the hub does not hold, has no
  page.

The @ list does not open right after a chip (`mentionComplete.ts`), as its name ends in a tag character.

## The setting: "@ finds"

A place pref (`place_pref.mention_scope`, `place_pref.mention_same`; PlacePrefView `mentionScope`, `mentionSameNetwork`,
set with `PATCH /api/place-prefs`) on a conversation, a space or a folder:

| `mentionScope` | The About shows | The list offers |
|---|---|---|
| `here` | People here | who can be pinged here (section `here`) |
| `friends` | Here and friends | and section `friends` |
| `everyone` | Everyone you know | and sections `friends` and `everyone` |

`mentionSameNetwork` ("Only on Discord", named after the chat's network) narrows friends and everyone to the people with
an account on the chat's network, and shows only those accounts.

Each of the two is inherited on its own from the nearest place that sets it: the conversation; a thread's channel; its
spaces, nearest first (a channel's category, then its server); then a folder that holds any of those, or for a direct
chat its person. `null` in a patch takes a setting away. Set nowhere, it is `here` on a messaging network and
`everyone` in a chat whose account has `personRefs` (the Calendar chat), and every network. Hub `mentionSetting`
works it out; the web app's About shows what it inherits and from where (`ui/MentionFinds.tsx`).

Where it is set: a chat's or a space's About has an "@ finds" card (a space's sets it for all its channels), with the
switch hidden where there is no one network to keep to (a Calendar chat). A folder's menu has "@ Finds". The schema
change is two nullable columns on `place_pref`, added by `addColumns` on start.

## The endpoint

`GET /api/conversations/:id/mentionables?q=&account=&scope=&same=` answers a `MentionablesView` (protocol
`mentions.ts`). The code is in `packages/hub/src/mentions.ts`; the route is one line in server.ts. `scope` (`here`,
`friends`, `everyone`) and `same` (`1` or `0`) override the place's setting; the answer says which it used (`scope`,
`sameNetwork`).

Sources, merged by identity:

- the conversation's stored participants, without your own accounts' identities (or the person marked as you);
- the authors of its last 3,000 stored messages (system lines left out), and when each last wrote;
- the network's answer, when the account that would send has the capability `mentionables` and is connected. The hub
  waits up to 1.5 s for it. With no answer in time, or a failed one, it answers what it knows, with `partial: true` when
  that may be short: a channel or thread, or a group whose participants it does not hold. A Signal or WhatsApp group
  lists its participants, so the hub alone answers for them and it is never partial.

Nothing from the network's answer is stored. A person the network names whom the hub has never seen gets a row without
`identityId`, its picture signed for the account that answered.

Every row of these is section `here` and `pings: true`. Its `insert` is `<@nativeId> ` for a person, `<@&id> ` for a
role, and `@everyone ` / `@here ` on Discord (`@room ` on Matrix) where the answer said `everyone`.

Order:

1. How well the name matches what was typed. The tiers are the whole name, its start, the start of one of its words, then
   anywhere. The names are the person's name, the account's nickname, display name and handle, and the network's name for
   them (a Discord server nickname).
2. How much you talk with them: the inbox's per-person tallies (attention.ts, `conv_author_feature`), meaning the turns
   they addressed to you and the ones you answered, decayed by a month's half-life, summed over every conversation.
3. When they last spoke here.

People come before roles, and roles before @everyone, when they match alike. At most 20 people go in an answer, plus
the roles and @everyone rows that match.

### Friends and everyone you know

After the rows here, ranked the same way (the match, then how much you talk with them), at most 20 in each:

- `friends`: persons with an account you are friends with or have as a contact on any network (`person_link`,
  relationship `friend` or `contact`), starred persons, and persons you have a direct chat with.
- `everyone`: every other person the hub has. With nothing typed it reads your friends and who wrote in the newest
  2,000 messages anywhere, so the hub never ranks every person it knows; a name typed searches them all by their name
  and their accounts' names and handles (at most 300 read).

You are never offered, and a person already shown here is not repeated. A row is `kind: 'person'` with `accounts`, one
`kind: 'identity'` row for each of their accounts (only those on this network with `same`).

What a row puts in:

| | An account on this chat's network | None |
|---|---|---|
| A person | `<@nativeId> `, pings (the account the hub would lower a reference to: one in the conversation, else the one who wrote here last, else the newest) | `<@person:per_…> `, does not ping |
| One of their accounts | `<@nativeId> `, pings | `<@identity:idn_…> `, does not ping |

In a chat whose account has `personRefs` (the Calendar chat) every person and account row puts in a reference, and so
does a row here for an account the hub stores; none pings, since the calendar notifies nobody.

## References and lowering

`<@person:per_…>` and `<@identity:idn_…>` mean nothing to a network, so the hub lowers them in every body it sends
(`packages/hub/src/mentionrefs.ts`, `lowerForSend`), unless the account sending has the capability `personRefs`:

- `<@identity:idn_…>`: on the chat's network, `<@nativeId>`; otherwise plain `@Name`, the account's display name (else
  its handle, else its person's name; never your private nickname for them, never its native id).
- `<@person:per_…>`: their account on the chat's network becomes `<@nativeId>` (one in the conversation first, then the
  one who wrote here last, then the newest); with none, plain `@PersonName`.
- An id the hub does not know becomes `@someone`. The raw id is never sent.
- References inside code (an inline span or a fenced block) are left as written.
- A name is written so it can make no token and ping nobody: every `<` and `@` in it is followed by a zero-width
  space, and so is the leading @ before everyone, here, room, channel or all.
- Roles, `<@nativeId>` and @everyone are left as they are.

**The owner's decision (2026-11-13): a friend who is not on the chat's network gets the plain `@Name` text only.** The
hub never sends them a DM or any other notification outside the chat.

Where it runs: the send (`POST /api/conversations/:id/send` and a chat's `POST /api/chats/:id/messages`, server.ts
`sendNow`), so Send later too, which keeps the reference as written and lowers it when the message goes; an edit
(`POST /api/messages/:id/edit`), so a body edited to hold a reference is lowered; and a forward's note, for each
destination (forward.ts). A forwarded message's own references go on as names. Adapters only ever see `<@nativeId>` or
plain text; the calendar, which declares `personRefs`, is given references and names them itself (docs/calendar.md).

## The adapter command

```ts
{ t: 'mentionables'; id; conversation: string; query: string; limit: number }  // reply: Mentionables
```

An adapter with the capability `mentionables` answers who a conversation can ping that the hub may not store: the
`people` (best first, at most `limit`), the `roles` that may be pinged, and `everyone`, meaning you may write @everyone
or @room there. An empty `query` asks for who spoke there lately, with no member search. A search on the network runs
only for letters typed. The adapter emits nothing for it: no identity facts and no members events.

### Discord (dither-accounts `extractors/discord`)

`hook.js` `mentionables` answers from the client's stores, and `src/mentionables.ts` ranks and maps the answer. The
capability comes in the hello once ChannelStore, UserStore, GuildMemberStore and PermissionStore are found.

- A DM or a group DM: its recipients. No roles, and no @everyone.
- A server channel with nothing typed: the authors of the messages the client holds for it (MessageStore), newest
  first, each with when they wrote.
- A server channel with letters typed: the members the client has loaded whose nickname, display name or username holds
  them (GuildMemberStore). Then the client's own member search for them, as its @ autocomplete makes it: op 8
  REQUEST_GUILD_MEMBERS through `requestMembers(guild, query, 10, false)`, at most 10 people, waited on for up to 1 s.
  Its chunks go to the search, never down the passive members path.
- Each person only if they can see the channel. This is worked out as Discord does, from what the client holds: the
  owner; else @everyone's and their roles' permissions, with Administrator letting them see everything; then the
  channel's overwrites, applied @everyone first, then their roles, then them by name. A thread goes by its parent. Someone
  the client holds no member for (an author who left) is kept.
- Roles from GuildRoleStore, @everyone itself left out: the mentionable ones, or all of them while you have Mention
  Everyone in the channel. They come highest first, with their colour.
- `everyone`: PermissionStore says you have Mention Everyone in the channel.

It is not paced. Typing is not paced either, the hub keeps answers a minute, and the web app waits for a pause.

### Matrix and Telegram (Step 2, dither-accounts)

- Matrix (`extractors/matrix/src/mentions.ts`): the room's joined members, as its state holds them. Lazy loading brings
  the senders of recent events, so with nothing typed these are about who spoke lately. Letters typed in a room whose
  members are not all loaded fetch `/joined_members` once, kept five minutes in memory. Members match by display name or
  user id. `everyone` is true when your power level reaches the room's `notifications.room` level (50 unless the room
  sets it).
- Telegram (`extractors/telegram/src/mentions.ts`, `adapter.ts mentionables`): a DM's other person, or a basic group's
  members (one messages.getFullChat). In a supergroup, nothing with nothing typed (the hub knows who wrote there); for
  letters typed, Telegram's own member search, channels.getParticipants with channelParticipantsSearch, as its @ list
  asks. A broadcast channel offers nobody. Telegram has no @all. The people found are remembered so a mention of them can
  be sent, and no identity goes to the hub.

Signal and WhatsApp have no command. Their groups store their participants, so the hub's own sources cover them.
WhatsApp leaves out the participants of a group over 256 members. Such a group offers who wrote there, marked partial.

Incoming, Telegram's plain `@username` (a messageEntityMention) becomes `<@id>` when it names a user this account knows,
as a mention by name (messageEntityMentionName) already did. Matrix's `@room`, as `m.mentions.room` or (no `m.mentions`,
an older client) as `@room` in the body, sets `mentionsSelf` and `mentionsAll` when its sender may notify the room. That
is the way Discord's @everyone does.

## What a mention becomes, and who is notified

| Network | Sent as | Notifies |
|---|---|---|
| Discord | `<@id>` as it is; `<@&role>`; `@everyone`/`@here` | The person, if they can see the channel; a role's members; everyone (online ones for @here) only if you have Mention Everyone, otherwise it is plain text |
| Signal | A one-character placeholder with a body range naming their ACI (`mentions` in signal-cli's send) | They see their name, and are notified as their Signal's mention setting for the group says |
| Matrix | Their display name in `body`, a pill `<a href="https://matrix.to/#/@user:server">Name</a>` in `formatted_body`, and their id in `m.mentions.user_ids` | Clients notify on `m.mentions` (intentional mentions). A reply adds the replied-to sender. `@room` sets `m.mentions.room: true` where your power level allows it (Step 2) |
| WhatsApp | `@<number>` in the text, their JID in `contextInfo.mentionedJID` | The person, by name |
| Telegram | Their name with a `messageEntityMentionName` entity (`inputMessageEntityMentionName` on send) | The person, including one with no @username |
| Google Messages | Plain `@Name`: SMS and RCS have no mentions | Nobody beyond the message itself |

Incoming mentions of you set `mentionsSelf` (and `mentionsAll` for @everyone, @here and, from Step 2, Matrix's
`@room`). The inbox and notifications treat them as addressed to you (docs/notifications.md).

## Testing

- `packages/hub/test/mentions.test.ts`: the endpoint against the demo world's adapters run in process. It covers the
  rows and their order, the account asked, partial answers, Signal and WhatsApp groups from the hub alone, Matrix's
  @room, and that nothing is stored. Step 3: the sections, what a person and an account put in, same network, the
  setting's inheritance (server, channel, folder, null) and a `personRefs` account.
- `packages/hub/test/mentionrefs.test.ts`: lowering alone (escaping, unknown ids, several references, code), what the
  store resolves each to, and every path that sends: the send, a chat's send, an edit, Send later's Send now, a
  forward's note, and a `personRefs` account given them as written.
- `packages/web/test/mention-complete.test.ts`: when an `@` opens the list, matching, this device's rows, and merging.
- `packages/web/test/composer-chips.test.ts`: chips in the box's text: the body and the names they read as, a body
  made into the box's text, a typed token, an edit that cuts into a chip, and where a chip's name and page come from.
- `packages/web/test/markdown.test.ts`: references as chips.
- `scripts/verify-mentions.ts`: a demo hub of its own and headless Chromium, on desktop and phone width. Step 3: the
  About's setting changes the sections, the switch filters, a friend with no account here sends as plain `@Name`, and
  one on this network as `<@id>`. Chips: drawn under the name, the caret stepping over them, Backspace and undo, the
  draft, a typed token, copy and paste, and a click opening the page only once the box has the caret.
- dither-accounts `extractors/discord/test/mentionables.test.ts` and `hook-mentionables.test.ts`: the mapping, and the
  hook against a small replica of the client's stores.
- dither-accounts `extractors/matrix/test/mentions.test.ts` (members, the cache, @room both ways) and Telegram's
  `adapter.test.ts` (mentionables against the fake Telegram) and `entities.test.ts` (an @username it knows).

The demo adapter answers `mentionables` for Discord and Matrix (`demo.ts`). Discord's libdither server has two
mentionable roles, and the main account is its admin, so it may write @everyone there and the alt may not. A Matrix
room offers @room from power level 50.
