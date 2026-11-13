# Moderating groups and servers

What an admin or moderator does to a group's or server's members and to other people's messages there, from the
place's page and the message menu: on Signal, removing, banning and unbanning, making and unmaking admins, ending a
group and answering requests to join; on Discord, kicking, banning (with how much of their history to delete),
unbanning, timing out and giving or taking a role, deleting someone else's message and taking reactions off. Also your
own member label in a Signal group, a group's or server's picture, Signal's link approval, a Discord server's
description and a channel's thread-hiding, user limit and bitrate, and leaving a Signal group as its only admin.

The owner's real accounts are ordinary members almost everywhere, so this is lean: what matters is that nothing is
offered where the account may not, and that a refusal says why. Everything here was built and tested against fakes and
the demo world only (2026-11-12, net-gaps): no live account has run any of it.

The protocol is `packages/protocol/src/moderation.ts`; the hub side `packages/hub/src/moderation.ts`; the page
`packages/web/src/ui/Moderation.tsx` (a chunk of its own, loaded only where the About says the account may moderate,
set a label, change the picture or must name who takes over) and `src/moderate.ts` for the message menu. The adapters
are dither-accounts' `extractors/signal/src/groups.ts` and `extractors/discord/src/moderation.ts` with the hook's
"moderation" section.

## The rules

- **Only from a click**, one action at a time, after a confirm in the app. Nothing is batch: there is no select-many,
  and the hub takes at most `MOD_PER_HOUR` (30) actions an hour from one account. Every write route wants a browser's
  Origin, as the other write routes do.
- **A fresh look first.** The hub asks the network for the place's About again (for messages, the conversation's
  reaction context) and refuses with the network's own reason unless it says this account may, to this person, now.
  The adapter checks again against the same read, and Discord's hook once more against the client's own permission and
  hierarchy checks (`PermissionStore.can`, `canManageUser`), failing closed. The network has the last word; its
  refusal comes back as its sentence.
- **Who outranks you is never offered.** A member's menu shows only what this account may do to them. Someone above
  you (a higher or equal Discord role, the server's owner) gets one line saying so instead.
- **Logged** in the account's log: `[moderate] kicked …`, `banned … and deleted their messages from the last day`,
  `gave … the Helper role`, `timed out … for an hour`, `deleted a message by …`, `removed every 👍 reaction …`.

## Signal

signal-cli 0.14.8. Signal's servers enforce who may do what and signal-cli does not, so every change is gated by the
same `listGroups` read the About is made from (groups.ts). One field per `updateGroup`, as for settings
([group-settings.md](group-settings.md)); every change is followed by a fresh read and a line in the group saying what
changed.

| What | How | Who |
|---|---|---|
| Remove someone | `updateGroup --remove-member` | admins |
| Ban, unban | `updateGroup --ban` (takes them out too) / `--unban`; the banned are listed on the page from `listGroups.banned` | admins |
| Make or unmake an admin | `updateGroup --admin` / `--remove-admin` | admins |
| End the group | `terminateGroup`: nobody can send or change anything again. The page asks you to type the group's name first | admins |
| Requests to join | `listGroups.requestingMembers` of a group you admin are requests (`join:<group>:<person>`, kind `join`) under Requests, notified like the others; Accept is `updateGroup --member`, Decline `--remove-member` | admins |
| Delete someone else's message | `sendAdminDelete` from the message menu ("Delete Message (Moderator)") | admins |
| Your member label | `updateGroup --member-label`, then `--member-label-emoji` (two calls, one field each); everyone's labels show by their names in the member list | any member |
| The picture | `updateGroup --avatar <file>`: the page uploads it to the hub, which hands the adapter a `file://` path in its spool | as the name |
| Link approval | `updateGroup --link enabled-with-approval` / `enabled`, with the link on. signal-cli does not say whether approval is on, so the panel offers it as "Unknown: set it…" (`AboutSetting.writeOnly`) | admins |
| Leave | `quitGroup`; as its only admin with others in it, signal-cli wants `--admin`, so the page asks who takes over first. `--delete` (forget the group on this device) is a box of its own with its own confirm | any member |

Leaving keeps the group's history in the hub, read-only, as Signal's apps keep a group you left: no `leave` event.
Nobody can remove someone else's reaction on Signal, so that is never offered.

Not built: the group revision (`JsonGroupInfo.revision`) to name who did what when several changes come together.
`listGroups` gives no revision, so there is no baseline to compare an update against after a restart. The 10-person
cap on making a group (`GROUP_RULES.signal.max`) stays: it is the hub's "a few at a time" pacing, the same as
`ADD_MEMBERS_MAX` for adding, and the Signal adapter's own guard (`createGroupParams`) relies on it.

## Discord

Through the account's own client in its sandbox. The hook finds the client's moderation module (`kickUser`,
`banUser`, `unbanUser`, `setCommunicationDisabledUntil`, as its member menu calls them) and the server module the
servers page already uses (`updateMemberRoles`); without them, its REST helper with the same requests. Reading costs
no request: permissions, roles, members' roles and timeouts are in the client's stores. The Bans list is one read of
up to 1,000, on a click ("Show who is banned"), as the server settings page makes it.

| What | Permission | Notes |
|---|---|---|
| Kick | Kick Members | below your top role |
| Ban, with "delete their last …" | Ban Members | the ban dialog's choices: none, an hour, 6 or 12 hours, a day, 3 or 7 days |
| Unban | Ban Members | from the Bans list on the page |
| Time out, end a timeout | Timeout Members | the client's choices: a minute, 5 and 10 minutes, an hour, a day, a week |
| Give or take a role | Manage Roles | only roles below your own top role, never @everyone or a role an integration or boosting manages |
| Delete someone else's message | Manage Messages | the message menu |
| Take reactions off: all, one emoji's, one person's | Manage Messages | the message menu ("Remove Reactions"); one person's from the list of who reacted |
| Server description | Manage Server | Community servers only |
| Server icon | Manage Server | PNG, JPEG, GIF or WebP, up to 8 MB, sent as a data URI. A group DM's icon is the group DMs work, not here |
| Hide threads after inactivity | Manage Channels | text, announcement, forum and media channels: an hour, a day, 3 days, a week |
| User limit, bitrate | Manage Channels | voice channels; bitrate up to 96, 128, 256 or 384 kbps by the server's boosts |

Not built, by decision ("open Discord" on the page): the audit log, AutoMod rules, pruning, emoji, sticker and
soundboard management, integrations, moderator reports and raid actions. Role member lists and member search for
moderators are never read (member scraping). Server mute, deafen and moving people in voice wait for the voice work.

## Hub API

| Route | Does |
|---|---|
| POST `/api/(conversations\|spaces)/:id/moderate` `{ action, accountId? }` | one `ModAction`, `who` a hub identity id; answers the AboutView |
| GET `/api/(conversations\|spaces)/:id/bans` | who is banned, with their identities |
| POST `/api/conversations/:id/label` `{ text, emoji?, accountId? }` | your own member label |
| POST `/api/messages/:id/moderate-delete` | someone else's message, as a moderator |
| POST `/api/messages/:id/clear-reactions` `{ key?, identityId? }` | all, one emoji's, or one person's reactions |
| POST `/api/(conversations\|spaces)/:id/about` `{ change: { key: 'avatar', value: <upload id> } }` | a new picture |
| POST `/api/(conversations\|spaces)/:id/leave` `{ admins?, forget? }` | leaving, naming who takes over |

Capabilities: `moderate` (members, the message menu), `memberLabels`, `setPicture`, and `leave` on Signal. An adapter
without them gets nothing offered, and an old hub never sends the new commands.
