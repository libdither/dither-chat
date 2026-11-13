# @ mentions

Typing `@` in the composer opens a list of who this conversation can ping. Picking a row puts the network's own
mention in the message, so the person is notified the way that network notifies, from whichever app they read it in.

This page covers the picker, the hub's endpoint, the adapter command behind it, and what a mention becomes on each
network. Steps 1 and 2 of the design approved on 2026-11-13 are built: the people here, their roles, and @everyone where
you may write it. Step 3 adds a place setting for whom the picker offers (friends, everyone known, optionally only on the
chat's network), with `<@person:…>` and `<@identity:…>` tokens that the hub turns into native mentions on send.

## In a body

Canonical bodies (protocol `adapter.ts`, MessageFact) carry mentions as Discord writes them, whatever the network:

| Token | Meaning |
|---|---|
| `<@nativeId>` | One account: a Discord snowflake, a Signal ACI, a Matrix `@user:server` (so `<@@user:server>`), a WhatsApp JID, a Telegram user id |
| `<@&roleId>` | A Discord role |
| `<#convNativeId>` | A channel or room (not a mention: nobody is notified) |
| `@everyone`, `@here` | Discord: everyone who can see the channel, or those of them online |
| `@room` | Matrix: everyone in the room (Step 2) |

The web app draws these as chips (`markdown.ts`; Timeline.tsx's `useMdContext` names them from the hub's identities).

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

Keys, as in the emoji list: arrows move, Enter or Tab puts the row in, Escape closes the list for that `@` until a new
one is typed. The list listens on the composer in the capture phase, so the composer's own Enter (send) and Escape
(cancel the reply) never see those keys while it is open. On a phone, Enter in the list picks a row, and does not start a
new line. A pick replaces the `@query` with the row's `insert` (`<@nativeId> `, `<@&id> `, `@everyone `), through
`execCommand('insertText')`, so it can be undone. It adds a space unless one follows already.

The account asked is the one the composer sends from (the send-as chip, else the connected one).

## The endpoint

`GET /api/conversations/:id/mentionables?q=&account=` answers a `MentionablesView` (protocol `mentions.ts`). The code
is in `packages/hub/src/mentions.ts`; the route is one line in server.ts.

Sources, merged by identity:

- the conversation's stored participants, without your own accounts' identities (or the person marked as you);
- the authors of its last 3,000 stored messages (system lines left out), and when each last wrote;
- the network's answer, when the account that would send has the capability `mentionables` and is connected. The hub
  waits up to 1.5 s for it. With no answer in time, or a failed one, it answers what it knows, with `partial: true` when
  that may be short: a channel or thread, or a group whose participants it does not hold. A Signal or WhatsApp group
  lists its participants, so the hub alone answers for them and it is never partial.

Nothing from the network's answer is stored. A person the network names whom the hub has never seen gets a row without
`identityId`, its picture signed for the account that answered.

Every row is section `here` and `pings: true`. Its `insert` is `<@nativeId> ` for a person, `<@&id> ` for a role, and
`@everyone ` / `@here ` on Discord (`@room ` on Matrix) where the answer said `everyone`.

Order:

1. How well the name matches what was typed. The tiers are the whole name, its start, the start of one of its words, then
   anywhere. The names are the person's name, the account's nickname, display name and handle, and the network's name for
   them (a Discord server nickname).
2. How much you talk with them: the inbox's per-person tallies (attention.ts, `conv_author_feature`), meaning the turns
   they addressed to you and the ones you answered, decayed by a month's half-life, summed over every conversation.
3. When they last spoke here.

People come before roles, and roles before @everyone, when they match alike. At most 20 people go in an answer, plus
the roles and @everyone rows that match.

`scope` (Step 3) will add sections after these rows (`friends`, `everyone`) without changing them.

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

### Matrix and Telegram (Step 2)

- Matrix: the room's joined members whose name or id holds the letters typed. `everyone` is true when your power level
  reaches the room's `notifications.room` level (50 by default).
- Telegram: for a supergroup, the client's own member search (channels.getParticipants with a search filter); for a basic
  group, its members. A channel's subscribers are left out.

Signal and WhatsApp have no command. Their groups store their participants, so the hub's own sources cover them.

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
  @room, and that nothing is stored.
- `packages/web/test/mention-complete.test.ts`: when an `@` opens the list, matching, this device's rows, and merging.
- `scripts/verify-mentions.ts`: a demo hub of its own and headless Chromium, on desktop and phone width.
- dither-accounts `extractors/discord/test/mentionables.test.ts` and `hook-mentionables.test.ts`: the mapping, and the
  hook against a small replica of the client's stores.

The demo adapter answers `mentionables` for Discord and Matrix (`demo.ts`). Discord's libdither server has two
mentionable roles, and the main account is its admin, so it may write @everyone there and the alt may not. A Matrix
room offers @room from power level 50.
