# Message history: what changes, and what the networks take back

The hub keeps what the networks let go of or rewrite, each switchable in Settings → Message history (or, for the
first two, statuses, presence and server members, Adversarial features), everywhere or per network or account:

| | What is kept | Where it shows |
|---|---|---|
| **Deleted messages** (adversarial) | the words and files of a message someone deleted (not ones you delete yourself) | in full in the chat, marked "Deleted · 3m" under it |
| **Disappearing messages** (adversarial) | a Signal or WhatsApp message whose timer ran out | the same, marked "Disappeared" |
| **Edits** | each earlier version of an edited message | click "(edited)" on it |
| **Reactions taken back** | who took back which reaction; reactions a moderator cleared | Message History in the message's menu |
| **Read receipts** | who got, read and played your messages, and when (Signal, WhatsApp, Matrix) | ticks beside your messages; click for who |
| **Changes** (one switch) | names, descriptions, pictures, settings, members and roles of conversations and spaces; pins; people's names, usernames, pictures, bios, pronouns and banners | History on the profile page (docs/profile.md); a pin mark on pinned messages |
| **Statuses** (adversarial) | each change to people's custom statuses (the About on Signal and WhatsApp); the current one is kept either way | the Activity section of a profile: a list, and marks above its chart (docs/profile.md) |
| **Presence** (adversarial) | each time people you follow come online, go idle or do not disturb, or go offline, and on which devices; nothing at all while off | the Activity section of a profile: a list, and a band under its chart (docs/profile.md) |
| **Server members** (adversarial, passive) | who your accounts' clients saw as a member of each server, with nick, roles and when they joined, and the server's member and online counts: only what the client loaded anyway (message authors, the member list in view), never a walk of the list | "Members seen: 5 of 1,287 listed" on a server's About; the server under In common on a profile; its links in the people graph (docs/people-graph.md) |

Each adversarial switch says where what it keeps shows, in the words of the last column ("Where it shows: in full in
the chat, marked Deleted"). "Deleted and disappeared messages in chats" is Shown or Hidden, and each chat can say
otherwise on its page under Kept messages (`showIn`, by conversation id; `showsGone` in packages/protocol). Hidden only
hides: they are still kept, and come back with the setting.

Forget what was kept erases each kind for good. It offers a red button for each kind that is kept now, or has
anything kept from before (`GET /api/retention/kept`, which looks for one row of each); the rest are listed as
"Nothing kept, so nothing to forget". While nothing adversarial is kept (hidden, or each of their switches off),
Message history says so at its top: "Deleted and disappearing messages, statuses, presence and server members are not
being kept", with a button to Adversarial features.

On a desktop, Settings' sections are listed beside it. On a phone, Sections in Settings' header opens them in a sheet,
so any section, Adversarial features included, is two taps from anywhere in Settings.

Code: `packages/hub/src/store.ts` (`gone`, `logChange`, `logChanges`, `messageEvent`, `receipt`, `setStatus`, `setPresence`, `keeps`,
`changes`, `messageHistory`, `eraseKept`), `about.ts` (settings), `people.ts` (profiles); adapters emit `pin`, `role`,
`customStatus`, `presence`, `receipt` and `members` (packages/protocol/src/adapter.ts); `packages/web/src/history.ts`,
`ui/HistorySettings.tsx`, `ui/HistoryCard.tsx`, `ui/ActivityCard.tsx`, `ui/MessageHistory.tsx`, `ui/Timeline.tsx` (`Gone`, `Edited`, `Marks`).

## Adversarial features

Keeping what others deleted, keeping what a disappearing timer was meant to erase, logging people's statuses
and presence over time, and recording who is in which server all work against what the people on the other end expect. They are off by default (`adversarial: false`),
and the hub does none of them, whatever their own switches or per-source overrides say, until Settings →
Adversarial features → "Show adversarial features" has been through its warning: a popup saying why, whose "Yes, I
really want to do this" stays greyed for 15 seconds. Its words scroll and the Yes stays at the bottom, so a phone's
sheet has it on screen from the start, with "This shows their switches. Each starts off." under it. Ticking it shows
the switches, each still off: Settings scrolls to them and says "Next, turn on the ones you want. Each starts off."
(also whenever they are first seen all off). Finishing the warning alone keeps nothing. "Hide adversarial features"
(asked first) only hides them: each switch stays as it is, and deleted and disappearing messages go on being kept as
their switches say, so hiding never loses a message. Statuses, presence and members are logged only while shown.
While hidden, what was kept stays in the database but out of sight: kept deleted messages are served empty, status
and presence history are left out of the profile, server members and coverage are left out of About and profiles,
and the section says "Still keeping deleted messages, out of sight". Message history → Forget erases it.

Turning off a switch that keeps or shows kept things (deleted, disappearing, statuses, presence, members, the whole
section, or a network's or account's deleted or disappearing) is asked first in the app, and the hub refuses it
without `confirm: true` (409). `PUT /api/retention` changes only the fields sent: a device that has not loaded the
settings yet can no longer put the defaults back. On 2026-11-10 that, or an accidental Hide, turned them all off for a
day and the hub emptied the messages deleted meanwhile. Every change is logged with the device's user agent
(`GET /api/retention/log`, the newest 200, and the hub's log).

`ui/Adversarial.tsx`, `keeping.ts` (what is kept now, for Message history's note and Forget); `ADVERSARIAL_KEEPS` and
`KEPT_KINDS` in packages/protocol. A demo hub started with `--adversarial` shows them
from the start (scripts/verify-history.ts); scripts/verify-adversarial.ts checks the gate.

## Storage

Three tables, by what they hang off:

- **`message`** itself for deleted and disappeared messages: `deleted`, `gone_how` (`deleted` or `disappeared`),
  `gone_at`, and the body and attachments left in place when kept. Timelines, search and counts need nothing special;
  `message_gone`, a partial index on `gone_how`, finds them for Forget without reading every message.
- **`message_event`** (message_id → message, ON DELETE CASCADE): `kind` (`edit`, `unreact`, `pin`, `unpin`), `data`
  (JSON: an edit's previous `{ body }`, an unreact's `{ key, style, cleared? }`), `actor_id`, `at`, `account_id`. It
  goes with its message, so leaving a conversation leaves nothing behind.
- **`receipt`** (message_id → message, ON DELETE CASCADE; key message, identity, state): the first time each person
  got, read or played each of your messages. Others' messages are not kept: nobody's receipts but yours are news.
- **`change_log`** for places and people (`target_kind` conversation, space or identity): `field`, `old` and `new`
  as JSON (a setting keeps its own type: seconds, true or false; a status is `{ text, emoji }`; presence
  `{ state, devices? }`; a role
  `{ identityId, role, color }`; a member an identity id), `actor_id` where the network says who, `at`, `account_id`.
  Indexed by target, field and time.
- **`membership`** (key space, identity): `joined_at`, `roles` (JSON names), `nick`, `source` (`seen`; `walk` is
  reserved), `first_seen`, `last_seen`, `account_id`. Seen again, last seen moves on, and a nick or roles the event
  leaves out stay as they were. **`member_coverage`** (key space): the network's `total` and `online` counts as last
  given. Coverage is seen / total, honest about how little that may be: Discord lists a big server's online members
  at most. Both go with the space when no account sees it any more. Written only while `adversarial` and `members`
  are on; at most 500 members per event.
- **`identity.status`**: the custom status (or About) as last heard, `{ text?, emoji?, at }`; `{ at }` alone is
  cleared, NULL is nothing heard yet, so the first status is where history starts rather than a change.

Rules that keep it honest and small:

- The same change seen by a second account within ten minutes is one change (`change_log` and `message_event`).
- A change straight back within a day cancels the first (a Discord name flipping between a server nickname and the
  global one), except for statuses, members and roles, where going back is the story.
- Presence is a `change_log` row (field `presence`) only while adversarial features are shown and presence is on
  (and changes are kept, as for statuses); otherwise the event is dropped. The newest row is how they are now, so a
  change is anything else: the same heard from a second account, or again after a restart, is nothing new. The first
  heard is a row from nothing. Changes straight back are kept (going back is the story).
- Statuses keep each person's newest 100, presence each identity's newest 1000; strangers (identities with no person) keep their newest 20 names and pictures.
- The first change log (text values, edits mixed in) is migrated on start: values to JSON, edits into
  `message_event`.

## Deleted and disappeared

An adapter's `delete` event carries `reason: 'expired'` when a disappearing timer ran out (Signal's and WhatsApp's own
sweeps), else it is a deletion. When the source keeps that kind, the body and attachments stay; else they are emptied,
as before. A message you deleted yourself is always emptied: you meant it. A kept message the network sends again
empty (Matrix sends a redacted event's shell) keeps what was kept.

Files: what the hub keeps is the attachment's address. Signal's adapter removes its downloaded copy of an expired or
deleted message's files, as Signal clients do, so for Signal the words stay and the files may not open.

Which settings apply, most specific first: the account's (`sources[accountId]`), its network's (`sources.signal`),
then the global switch. Settings live in the hub (`meta.retention`, `GET/PUT /api/retention`) and reach every device
(`{ t: 'retention' }`).

## Changes

`GET /api/{conversations|spaces|identities|persons}/:id/changes`, newest first (a person's covers all their
identities), with the identities they name; `GET /api/messages/:id/history` for a message's versions, events and
receipts.

- Conversations and spaces: name, description (topic), picture, as their facts arrive. A conversation first known
  from a message, with no name yet, filling in is not a change.
- Group members: who joined and who left, once the members were known (`shape: 'group'` only).
- Roles: an adapter's `role` event (Discord roles from member updates, Matrix power levels, admin on Signal and
  WhatsApp), with who gave or took it where the network says.
- Pins: an adapter's `pin` event, with who.
- Settings: each About answer is compared with the last one kept through the same account.
- People: display name, username and picture as identity facts arrive; status from an adapter's `customStatus`
  event (Discord friends' custom status, WhatsApp contacts' About, Matrix status messages of people you DM) or a
  profile answer; bio, pronouns and banner when a profile is opened. On Signal and WhatsApp the About is the status.
- Nothing said is no change: networks often leave fields out. A description, bio, status or pronouns may go from
  nothing to something and back; a name or picture is only replaced.

## Not logged

A server's own membership (joins and leaves in big servers, which Discord does not send to user clients without the
member list open), channels made, renamed or removed in a server. Presence only as above, and only of people the account follows.
