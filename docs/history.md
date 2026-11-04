# Message history: what changes, and what the networks take back

The hub keeps four things the networks let go of, each switchable in Settings → Message history, everywhere or per
network or account:

| | What is kept | Where it shows |
|---|---|---|
| **Deleted messages** | the words and files of a message someone deleted (not ones you delete yourself) | a collapsed line in the chat, "Deleted message · 3m · Show" |
| **Disappearing messages** | a Signal or WhatsApp message whose timer ran out | the same, "Disappeared message" |
| **Edits** | each earlier version of an edited message | click "(edited)" on it |
| **Changes** | names, descriptions, pictures, settings and members of conversations and spaces; people's display names, usernames, pictures, bios, statuses, pronouns and banners | History on the profile page (docs/profile.md) |

"Deleted and disappeared messages in chats" picks a collapsed line or nothing at all (they are still kept, and come
back with the setting). Forget what was kept erases each kind for good.

Code: `packages/hub/src/store.ts` (`gone`, `logChange`, `logChanges`, `keeps`, `changes`, `messageHistory`,
`eraseKept`), `about.ts` (settings), `people.ts` (profiles); `packages/web/src/history.ts`, `ui/HistorySettings.tsx`,
`ui/HistoryCard.tsx`, `ui/Timeline.tsx` (`Gone`, `Edited`).

## Deleted and disappeared

An adapter's `delete` event carries `reason: 'expired'` when a disappearing timer ran out (Signal's and WhatsApp's own
sweeps), else it is a deletion. The hub marks the message `deleted`, with `gone_how` (`deleted` or `disappeared`) and
`gone_at`. When the source keeps that kind, the body and attachments stay; else they are emptied, as before. A
message you deleted yourself is always emptied: you meant it. A kept message the network sends again empty (Matrix
sends a redacted event's shell) keeps what was kept.

Files: what the hub keeps is the attachment's address. Signal's adapter removes its downloaded copy of an expired or
deleted message's files, as Signal clients do, so for Signal the words stay and the files may not open.

Which settings apply, most specific first: the account's (`sources[accountId]`), its network's (`sources.signal`),
then the global switch. Settings live in the hub (`meta.retention`, `GET/PUT /api/retention`) and reach every
device (`{ t: 'retention' }`).

## Changes

`change_log`: target (conversation, space, identity, message), field, old and new as text, when, and the account that
saw it. `GET /api/{conversations|spaces|identities|persons}/:id/changes`, newest first (a person's covers all their
identities); `GET /api/messages/:id/history` for a message's versions.

- Conversations and spaces: name, description (topic), picture, as their facts arrive. A conversation first known
  from a message, with no name yet, filling in is not a change.
- Group members: who joined and who left, once the members were known (`shape: 'group'` only; big channels list
  members lazily, so their lists are not news).
- Settings: each About answer is compared with the last one kept through the same account (disappearing timer,
  who can edit, join approval, …). Name, description and picture come with the conversation and are logged there.
- People: an identity's display name, username and picture as identity facts arrive; bio, status, pronouns and banner
  when a profile is opened and the network says something new.
- Nothing said is no change: networks often leave fields out. A description, bio, status or pronouns may go from
  nothing to something and back; a name or picture is only replaced.
- A change straight back within a day cancels the first (a Discord name that flips between a server nickname and the
  global one).
- Edits: the old body, at the time of the edit, when the source keeps edits.

## What else could be logged

Not yet: reactions taken back, pins and unpins, roles given and taken (Discord, Matrix power levels), channels made,
renamed or removed in a server, someone's presence or custom status over time, read receipts, and a server's own
membership (joins and leaves in big servers, which Discord does not send to user clients without the member list
open). Each is a field in the same log; the first three are cheap where the adapter already sees the event.
