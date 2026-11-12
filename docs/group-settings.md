# About and settings for conversations and spaces

One panel shows what a group, channel, server, room, space or community *is* and how it is set up: its name,
description and picture, its members and their roles, who may change what, its invite link, disappearing
messages, slow mode, the age flag, announcement-only, join approval and pinned messages. Every setting says
whether **your account** may change it there, and why not when it may not. Notification rules are not here:
they are the hub's own, set from the menus and the details panel (docs/notifications.md, docs/devices.md).

The protocol is in `packages/protocol/src/about.ts`; the hub side in `packages/hub/src/about.ts`; the panel in
`packages/web/src/ui/About.tsx`. The headless check is `scripts/verify-about.ts`.

## What each network has

Legend: **R** we read it, **W** we change it (when the account may), **r** the network has it and we could read
it but do not yet, **w** the network allows the change but we do not offer it, **—** the network has no such thing.

| Setting | Discord | Signal | Matrix | WhatsApp |
|---|---|---|---|---|
| Name | R W (channels, threads, group DMs, categories, servers) | R W (groups) | R W (rooms, spaces) | R W (groups, communities) |
| Description / topic | R W (channels); server description R | R W | R W | R W |
| Picture | R w | R w | R w | R w |
| Members | R: the ones the client has loaded (up to 200), with their top role and its colour; group DM recipients | R, with admin | R (`joined_members`, up to 500), with power level | R, with admin / owner |
| Adding people | W: group DMs, friends only, 10 in all | W (as `addMembers` allows) | W: an invite (power level `invite`) | w: left out on purpose |
| Roles | R (server roles by position) | admin / member | Owner (room v12 creators) / Admin / Moderator / Level N | owner / admin / member |
| Who may do what | R (the client's own permission check, failing closed) | R W (`editInfo`, `addMembers`) | R (power levels) | R W (`editInfo` = locked, `addMembers` = add mode) |
| Invite link | r w | R W (make, reset, turn off) | R (matrix.to: the alias, else the room id with `via`) | R W (admins: see it, make a new one; WhatsApp has no "off") |
| Disappearing messages | — | R W (groups, 1:1, Note to Self) | — (MSC2228 abandoned) | R W (groups and 1:1: 24 h / 7 d / 90 d) |
| Slow mode | R W | — | — | — |
| Age-restricted | R W (channel NSFW) | — | — | — |
| Only admins send | R | R W | R W (`events_default` against `users_default`) | R W |
| Join approval | r | R: unknown (signal-cli does not say) | as `joinRule: ask` | R W |
| Join rule | — | — | R W (open / invite / ask / space) | — |
| History visibility | — | — | R W | — |
| Encryption | — | R (always on) | R W (on only) | R (always on) |
| Pinned messages | r w | r w (events only: no list) | R W (`m.room.pinned_events`) | r w (events only: no list) |

"r" and "w" are left out on purpose: Discord's pins and invites need REST calls (a paced read each time the
panel opens, and writes nobody has tried on a live account yet); Signal and WhatsApp keep no list of pins to read
(one would have to be built from pin events); and pictures upload differently on every network (JPEG only on
WhatsApp, a file path on Signal, a data URI on Discord, an upload then a state event on Matrix), so they could
only be checked against fakes. Adding people to a group is offered where the network's own client offers it to
you (below, "Adding people"), except on WhatsApp, whose enforcement looks for it. Removing people, changing roles
and banning are not offered anywhere.

## Discord

The adapter drives Discord's own web client in a sandbox; `extension/hook.js` reads the client's stores. Almost
everything is in those stores already, so reading costs no request.

| Capability | Where it comes from | Change | Gated by |
|---|---|---|---|
| Name | `ChannelStore` / `GuildStore` | `PATCH /channels/{id}` `{name}`; `PATCH /guilds/{id}` `{name}` | Manage Channels; Manage Server; thread: Manage Threads or its owner; group DM: any member |
| Topic | `channel.topic`, `guild.description` | `PATCH /channels/{id}` `{topic}` | Manage Channels (server description: Manage Server, Community servers only) |
| Picture | guild icon, group DM icon | `PATCH` with a data URI | Manage Server; group DM: any member |
| Members | `GuildMemberStore.getMember` (only members the client has loaded; the full list is lazy, op 14/37, and `GET /guilds/{id}/members` is closed to user accounts); group DM `recipients` | — | — |
| Roles | `GuildStore.getGuild().roles` or `GuildRoleStore.getSortedRoles` (newer builds) | `PATCH /guilds/{g}/roles/{r}` | Manage Roles, below your top role |
| Who may do what | `PermissionStore.can(bit, channel or guild)` for your account | — | — |
| Invites | `GET /channels/{id}/invites`; vanity in `guild.vanityURLCode` | `POST /channels/{id}/invites`, `DELETE /invites/{code}` | Create Instant Invite; listing: Manage Channels |
| Slow mode | `channel.rateLimitPerUser` | `PATCH /channels/{id}` `{rate_limit_per_user: 0..21600}` | Manage Channels |
| NSFW | `channel.nsfw`; `guild.nsfwLevel` (set by Discord) | `PATCH /channels/{id}` `{nsfw}` | Manage Channels |
| Only admins send | the @everyone overwrite denies Send Messages; for you, `can(SEND_MESSAGES)` | editing overwrites (Manage Roles) | — |
| Verification, screening | `guild.verificationLevel`, `features` | `PATCH /guilds/{id}` | Manage Server |
| Pins | `GET /channels/{id}/pins` (legacy) or `/messages/pins` | `PUT`/`DELETE` | Pin Messages (bit 51, split out in 2025) or Manage Messages; anyone in DMs |
| Owner, created | `guild.ownerId`, `channel.ownerId`; snowflake time | — | — |

Notes:

1. `PermissionStore.can` already folds ownership, Administrator, timeouts, threads inheriting their parent and
   the overwrite order. The about view uses it, **failing closed**: the reaction check (hook.js `reactionContext`)
   answers yes when it cannot tell, which is right for reacting and wrong for settings.
2. Bits: Create Invite 1<<0, Kick 1<<1, Administrator 1<<3, Manage Channels 1<<4, Manage Server 1<<5, Send
   Messages 1<<11, Manage Messages 1<<13, Manage Roles 1<<28, Manage Threads 1<<34, Pin Messages 1<<51.
3. Store records are camelCase (`rateLimitPerUser`, `permissionOverwrites`); dispatches carry snake_case.
4. Edits go through the client's own REST module (`mod.Rest`), with its headers and session, and through the
   adapter's write pace. Raw `fetch` from the page would look automated.
5. Only the throwaway account, in its own test server, may be used for a live check (see below).

## Signal

signal-cli 0.14.x over JSON-RPC. `listGroups` already returns everything the adapter needs, and the adapter
re-reads a group (`refreshGroup`) whenever a group update arrives.

| Capability | Read | Change | Gated by |
|---|---|---|---|
| Name, description | `listGroups` `name`, `description` | `updateGroup {groupId, name}` / `{description}` | `permissionEditDetails` (`EVERY_MEMBER` or `ONLY_ADMINS`) |
| Picture | `avatars/group-<id>` file | `updateGroup {groupId, avatar: <path>}`; cannot be removed | as name |
| Members, admins | `members[] {uuid, number, isAdmin}` | `member`, `removeMember`, `admin`, `removeAdmin`, `ban` | add: `permissionAddMember`; the rest: admins |
| Pending, requesting | `pendingMembers[]`, `requestingMembers[]` | approve: `member`; deny: `removeMember` | admins |
| Who edits info, who adds | `permissionEditDetails`, `permissionAddMember` | `setPermissionEditDetails` / `setPermissionAddMember`: `every-member` or `only-admins` | admins |
| Only admins send | `permissionSendMessage` | `setPermissionSendMessages` (plural) | admins |
| Invite link | `groupInviteLink` (URL or null) | `link: enabled / enabled-with-approval / disabled`; `resetLink: true` | admins |
| Disappearing | `messageExpirationTime` (seconds); 1:1 from `listContacts` | `updateGroup {expiration}`; 1:1 `updateContact {recipient, expiration}` (sends the peer an update) | group: `permissionEditDetails`; 1:1: either side |
| Pins | events only (`pinMessage`, `unpinMessage`) | `sendPinMessage`, `sendUnpinMessage` | 1:1: either side; groups unverified |

Notes:

1. Am I an admin: `members.some(m => m.uuid === selfAci && m.isAdmin)`. Match on `uuid`: `number` is null when
   someone hides it. Can I edit: member, group not terminated, and admin or `EVERY_MEMBER`.
2. **`updateGroup` without `groupId` creates a new group.** The adapter refuses to call it without one.
3. `updateGroup` is not atomic: each field is its own group change and message. One field per call, then re-read.
4. If you are only *invited*, any `updateGroup` accepts the invitation. Invited-only groups never reach the hub.
5. Join approval cannot be read: `groupInviteLink` is set whether or not approval is on, so the panel says so.
6. The server enforces permissions, signal-cli does not (except sending in announcement groups): an unauthorized
   change comes back as a generic error, so controls are gated up front.
7. Blocking has side effects on your phone (a message-request response, a profile key rotation) and is not
   offered here.
8. Someone made admin or unmade comes as a plain group update: the adapter compares `members[].isAdmin` with its
   last read and sends `role` events, by the update's sender (by nobody when only a later read shows it). A pin with
   a duration (`pinDurationSeconds`, -1 for good) ends on each client by itself, so the adapter unpins it then.

## Matrix

The adapter keeps every state event of every joined room (`rooms.ts`, persisted in `db.ts`), except member events,
which sync loads lazily.

| Capability | State event | Gated by |
|---|---|---|
| Name, topic, picture | `m.room.name`, `m.room.topic` (plus `m.topic`), `m.room.avatar` | `events[type]`, else `state_default` (50) |
| Members, roles | `GET /rooms/{id}/joined_members`; level from `users[u] ?? users_default`; room v12 creators have infinite power | — |
| Who may do what | `m.room.power_levels`: `ban`, `kick`, `invite`, `redact`, `events{}`, `events_default`, `state_default`, `users{}`, `users_default`, `notifications.room` | `events["m.room.power_levels"]` and auth rule 10 |
| Invite link | `m.room.canonical_alias`, else the room id with up to three `via` servers | anyone who can join |
| Join rule | `m.room.join_rules`: public / invite / knock / restricted / knock_restricted | `events[...]`, else `state_default`; knock needs room v7+, restricted v8+ |
| History | `m.room.history_visibility` | as above |
| Encryption | `m.room.encryption`; can be turned on, never off | as above |
| Only admins send | `users_default < events["m.room.message"] ?? events_default` | power levels |
| Pinned | `m.room.pinned_events` `{pinned: [eventId]}` | `events[...]`, else `state_default` |
| Server ACL, tombstone, version | `m.room.server_acl`, `m.room.tombstone`, `m.room.create.room_version` | read-only here |

Notes:

1. Defaults when a field is missing: ban 50, kick 50, redact 50, invite 0, `state_default` 50, `events_default` 0,
   `users_default` 0, `notifications.room` 50. With no power-level event at all, the creator is 100 and everyone
   else 0, with `state_default` 0.
2. Changing power levels (announcement-only does): you need the power-levels level, and every value you change
   must be at most your own, before and after. The adapter writes the whole event back from its stored copy.
3. Writes are `PUT /rooms/{id}/state/{type}/{key}`; the local room updates when the event comes back in sync.
4. There are no disappearing messages, slow mode or NSFW flag in the spec.

## WhatsApp

A whatsmeow sidecar (`bridge/main.go`). `groups`/`group` already return `isLocked`, `isAnnounce`, `ephemeral`,
`created` and per-member `admin`/`superAdmin`; the bridge now also passes the owner, the add mode, join approval
and the topic id.

| Capability | whatsmeow | Gated by |
|---|---|---|
| Name | `GroupName`; `SetGroupName` | everyone unless locked, else admins; communities: community admins |
| Description | `GroupTopic` (+ `TopicID`); `SetGroupTopic(jid, previousID, newID, topic)` | as name |
| Picture | `GetProfilePictureInfo`; `SetGroupPhoto` (JPEG only) | as name |
| Members | `Participants[] {IsAdmin, IsSuperAdmin}`; `UpdateGroupParticipants` | admins (adding: everyone under `all_member_add`) |
| Who edits info | `GroupLocked.IsLocked`; `SetGroupLocked` | admins |
| Who adds | `MemberAddMode` (`admin_add` / `all_member_add`); `SetGroupMemberAddMode` | admins |
| Invite link | `GetGroupInviteLink(jid, reset)`; 401 when not allowed | admins |
| Join approval | `GroupMembershipApprovalMode`; `SetGroupJoinApprovalMode`; requests via `GetGroupRequestParticipants` | admins |
| Disappearing | `GroupEphemeral.DisappearingTimer`; `SetDisappearingTimer(chat, d, ts)`, only 0 / 24 h / 7 d / 90 d | groups: as name; 1:1: either side |
| Only admins send | `GroupAnnounce.IsAnnounce`; `SetGroupAnnounce` | admins; a community's announcement group always is |
| Pins | no list; `PinInChatMessage` messages | probably as name (unverified) |

Notes:

1. Your own entry may be addressed by LID or by phone: match both (`mapper.isSelf`).
2. Editing a group's own settings is ordinary linked-device behaviour. **Adding people** (especially strangers,
   or in bulk) matches WhatsApp's enforcement patterns and is not offered. Making a new invite link breaks the
   old one: the panel asks first.
3. `SetGroupTopic` wants the previous topic id; without it whatsmeow fetches the group first.
4. Settings changes come back as `events.GroupInfo`; the bridge forwards `group_change` and the adapter
   re-reads the group, so the hub hears of changes made elsewhere.

## Adding people

**Add people** (Invite people on Matrix) is on a group's page: the Members card and the row of actions under its name.
It shows only where the account may add someone now; where it may not, the Members card says why (only admins add
here, a Discord group is full, WhatsApp is left out). It opens the palette ([palette.md](palette.md)) at a picker of the
people this account could add, as the network allows, people you talked with lately first: you pick a few, and who
could not be added stays listed with the network's own reason. Escape closes it; an add refreshes the page's members.

The same picker is reachable without the group's page: "Add people to a group" in New and in Ctrl+K lists the groups
one of your accounts could add to (its network has `addMembers` for it), most recent first, and typing narrows them;
picking one opens its picker, a page you can back out of to the list. When the group on screen is one of them, New
offers "Add people to <its name>" first. Where the group's About says this account may not add people now, the picker
says why and offers nothing.

| Network | Where | Who can be picked | What adding does | Gated by |
|---|---|---|---|---|
| Discord | group DMs (not servers, which have invites; not a 1:1 DM, where adding makes a new group) | your friends | `PUT /channels/{id}/recipients/{user}` through the client's REST module, one person at a time | any member; 10 people in all |
| Signal | groups | anyone the account knows | one `updateGroup {groupId, member: [...]}`; someone whose profile key it lacks comes in invited | `permissionAddMember`: admins, or every member |
| Matrix | rooms you have joined | anyone the account knows | `POST /rooms/{id}/invite` per person: in once they accept | power level `invite` (0 by default) |
| Telegram | groups, supergroups, channels | anyone the account knows (their privacy settings may refuse) | `messages.addChatUser` per person (basic groups, 200 in all), one `channels.inviteToChannel` | admins with Invite Users, or members where the group allows it |
| WhatsApp | — | — | left out: adding people (especially strangers, or in bulk) matches its enforcement patterns, and the bridge has a test that it never calls `UpdateGroupParticipants` | — |

The rules the hub keeps:

- **Only from a click** on the hub's page (the route wants a browser's Origin), a few at a time: at most 10 people in
  one go (`ADD_MEMBERS_MAX`), never more than the group has room for.
- **A fresh look first.** The hub asks the network for the group's About again and refuses (403, with the network's
  reason) unless it says this account may add people there now.
- **Paced per account**, one slot per person, in `add_pace` like joining (docs/add.md): 30 a day, 15 on Telegram,
  whose PEER_FLOOD comes early. Past it the whole add is refused with when the next slot frees up and how many would
  fit; nothing goes out. A refusal by the adapter's own check gives the slots back.
- **Who is offered** (GET `/api/conversations/:id/members/candidates`): where the network adds only friends, the
  account's friends (`person_link`); otherwise its friends and contacts, the people it has a direct conversation with
  and, where anyone it knows can be added, the people in its other groups. Never someone in it already, the account
  itself, a bot, or someone whose request still waits on you (adding them would answer it).
- **Logged** in the account's log: `[add] added …; invited …; could not add … (group)`.
- One person refused (privacy settings, not a friend, banned) does not stop the others: each comes back with its
  sentence. A timeout may still have gone through, and the panel says so.

## The protocol

```ts
// what the adapter answers to { t: 'about', target: { kind, nativeId } }
interface About {
  noun?: string;                     // "Group", "Server", "Room", "Community"
  fields: { [K in AboutKey]?: { value: AboutValues[K] | null; canEdit: boolean; reason?: string } };
  members?: { list: { id; role?; rank?; color? }[]; total?: number; complete: boolean };
  roles?: { id; name; color?; rank; count? }[];
  rules?: { what: string; who: string; you: boolean }[];   // "who can do what", in words
  you?: { role?: string; rank?: number };
  invite?: { link: string | null; canCreate: boolean; canRevoke?: boolean; reason?: string; derived?: boolean };
  pinned?: { messages: string[]; canEdit: boolean; reason?: string };
  facts?: { label: string; value: string }[];              // room version, verification level, created
}
// { t: 'configure', target, change } changes one thing and answers with the new About
type AboutChange = { key: AboutKey; value } | { key: 'invite'; op: 'create' | 'revoke' } | { key: 'pin'; message; remove? };
// About.adding: whether this account may add people here now, whom, and how (capability 'addMembers')
interface AboutAdding { can: boolean; reason?: string; who: 'friends' | 'contacts' | 'known'; mode: 'add' | 'invite'; room?: number }
// { t: 'addMembers', target, people } adds them (native ids, at most ADD_MEMBERS_MAX) and answers with
interface AddMembersResult { added: string[]; invited?: string[]; failed?: { id; reason }[]; about?: About }
```

The settings (`AboutValues`) are one vocabulary: `name`, `topic`, `avatar`, `disappearing` (seconds),
`slowMode` (seconds), `nsfw`, `announceOnly`, `editInfo` and `addMembers` (`everyone` / `admins`),
`joinApproval`, `joinRule` (`open` / `invite` / `ask` / `space`), `history`, `encrypted`. Where networks agree they
share a key (Signal's `permissionEditDetails` and WhatsApp's `locked` are both `editInfo`; Matrix's `knock` is
`joinRule: ask`, while Signal's and WhatsApp's approval is `joinApproval`). What only one network has stays its
own key (`slowMode`, `history`) or goes in `facts`.

`ABOUT_RULES` says, per network, which keys exist for conversations and for spaces, in the order its own client
shows them, and the choices it offers (WhatsApp's three timers, Signal's eight plus any number of seconds,
Discord's slow-mode steps), as `REACTION_RULES` does for reactions. What is allowed in one place comes from the
adapter, as `ReactionContext` does. `aboutChangeProblem` checks a change against the rules; the hub refuses
anything else before an adapter sees it.

Capabilities: `about` (the adapter reads settings) and `configure` (it changes them). An adapter without `about`
still gets a panel: the hub builds it from what it stores (name, topic, picture, participants), all read-only.

## The hub

- `GET /api/conversations/:id/about` and `GET /api/spaces/:id/about` (`?account=` to see it as one of several
  accounts) ask the adapter and keep the answer in the `about` table, per target and account. When the account
  is offline the last answer comes back with `stale` set and nothing editable.
- `POST` to the same path with an `AboutChange`: the hub checks it against `ABOUT_RULES`, asks the adapter for a
  fresh About, refuses (403, with the network's reason) unless that says this account may, then sends
  `configure` and keeps the answer. Every refusal is in words, shown under the control.
- Members come back as identity ids (the adapter emits identity facts first, as for `reactors`); pinned messages
  as the messages the hub has, plus a count of the ones it has not.
- `adding` comes back as the adapter said it, locked while the answer is stale; for a group whose account has no
  `addMembers`, the hub says why (`addMembersNotBuilt`: on WhatsApp, that it is left out on purpose).
- GET `/api/conversations/:id/members/candidates` (`?account=`) and POST `/api/conversations/:id/members`
  `{ identities, accountId? }` (answers `{ added, invited, failed, about }`, identity ids): "Adding people", above.

## The panel

**About** in a conversation's or space's right-click menu, the conversation header's info button, the details
panel and the space header. A dialog on the desktop, a sheet on a phone: picture, name and description at the
top (with a pencil where you may change them), then Settings (a switch, a choice or a field where you may, the
value and a lock with the reason where you may not), Invite link, Pinned, Members (with roles, as Discord's member
list groups them), Who can do what, and Details. With more than one of your accounts in a place, a chooser says
whose view it is.

## What was checked, and what needs a live check

Checked:

- The protocol's rules (`aboutChangeProblem`) and the hub (`packages/hub/test/about.test.ts`, against the demo
  world's adapters run in process): what each account may change and why not, refusals before anything reaches a
  network, the last answer while an account is offline, the read-only panel for adapters without `about`.
- Each adapter: Signal against its fake signal-cli (`updateGroup` always one field with a group id; a test proves
  the guard), WhatsApp against its fake bridge (the Go side builds and passes `go vet`), Matrix with unit tests
  and once against the local testbed homeserver (every state write accepted on a room v12, a member refused by the
  server as the panel predicts), Discord against the fake page in `hook.test.ts`.
- The panel, end to end on a demo hub: `scripts/verify-about.ts` (opening it from the header, the menu and a
  space; renaming; changing a timer; a member's locked view with reasons; two accounts' views of one server;
  pins; strangers named; the phone sheet).
- Adding people: the hub's rules in `packages/hub/test/add-members.test.ts` (who is offered, the fresh look, room,
  pace, Discord's friends-only, Matrix's invites, WhatsApp's line); the picker end to end in
  `scripts/verify-add-members.ts`; each adapter against its fake (dither-accounts).

Not checked against a real network, and worth a look before relying on it:

- **Adding people**, on every network: no add has gone to a real one. Discord's recipient PUT and its refusal for
  someone who is not a friend; Signal's `updateGroup` with `member` (which of them come back pending); Matrix's invite
  errors; Telegram's privacy refusals and how early PEER_FLOOD comes.
- **Discord**: the store field names the hook reads (`rateLimitPerUser`, `nsfw`, `permissionOverwrites`, the role
  and member-count stores) against the current client build, and any change. Only on the throwaway account, in
  its own test server: rename a channel, set slow mode, flip NSFW, rename the server.
- **Signal**: `updateGroup` and `updateContact` against a real signal-cli, on a test number only; whether
  `updateContact` with your own ACI sets Note to Self's timer; what a non-admin's refused change says.
- **Matrix**: a full hub plus adapter run on the testbed (the renamed room reaching the hub, the sync echo
  changing nothing).
- **WhatsApp**: every new bridge call (`SetGroupName`, `SetGroupTopic`, `SetGroupAnnounce`, `SetGroupLocked`,
  `SetGroupMemberAddMode`, `SetGroupJoinApprovalMode`, `SetDisappearingTimer`, `GetGroupInviteLink`); whether a
  community's parent group lists you with your admin status; that `SetGroupTopic` takes the topic id we pass.
