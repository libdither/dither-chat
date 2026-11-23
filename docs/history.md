# Message history: what changes, and what the networks take back

The hub keeps what the networks let go of or rewrite, each switchable in Settings → Message history (or, for the
first two, statuses, presence and server members, Adversarial features), everywhere or per network or account:

| | What is kept | Where it shows |
|---|---|---|
| **Deleted messages** (adversarial) | the words and files of a message someone deleted (not ones you delete yourself) | in full in the chat, marked "Deleted · 3m" under it |
| **Disappearing messages** (adversarial) | a Signal or WhatsApp message whose timer ran out | the same, marked "Disappeared" |
| **Edits** | each earlier version of an edited message | click "(edited)" on it |
| **Reactions taken back** | who took back which reaction and when, with when they had added it; reactions a moderator cleared | Message History in the message's menu; Taken back in a reaction's list of who reacted (docs/reactions.md "When") |
| **Read receipts** | who got, read and played your messages, and when (Signal, WhatsApp, Matrix) | ticks beside your messages; click for who |
| **Changes** (one switch) | names, descriptions, pictures, settings, members and roles of conversations and spaces; pins; people's names, usernames, pictures, bios, pronouns and banners | History on the profile page (docs/profile.md); a pin mark on pinned messages |
| **Statuses** (adversarial) | each change to people's custom statuses (the About on Signal and WhatsApp); the current one is kept either way | the Activity section of a profile: a list, and marks above its chart (docs/profile.md) |
| **Presence** (adversarial) | each time people you follow come online, go idle or do not disturb, or go offline, and on which devices; nothing at all while off | the Activity section of a profile: a list, and a band under its chart (docs/profile.md) |
| **Server members** (adversarial, passive) | who your accounts' clients saw as a member of each server, with nick, roles and when they joined, and the server's member and online counts: only what the client loaded anyway (message authors, the member list in view), never a walk of the list | "Members seen: 5 of 1,287 listed" on a server's About; the server under In common on a profile; its links in the people graph (docs/people-graph.md) |
| **Profiles** (adversarial) | people's profiles opened in the background, one at a time per account and slower than a person would (docs/same-person.md "Collecting profiles"), and each distinct version of a profile as it changes; nothing collected while off | Same person? (People), and the profile pages |
| **Voice channels** (adversarial, passive) | who is in each Discord voice channel when you are not, as your accounts' clients are told anyway, and each join and leave; nothing while off | a voice channel's row, its page and its chat (docs/calls.md "Voice channels") |

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

Turning off a switch that keeps or shows kept things (deleted, disappearing, statuses, presence, members, profiles, the whole
section, or a network's or account's deleted or disappearing) is asked first in the app, and the hub refuses it
without `confirm: true` (409). `PUT /api/retention` changes only the fields sent: a device that has not loaded the
settings yet can no longer put the defaults back (the voice switch, missing from what it carried until 2026-11-17,
could not stay on before then). On 2026-11-10 that, or an accidental Hide, turned them all off for a
day and the hub emptied the messages deleted meanwhile. Every change is logged with the device's user agent
(`GET /api/retention/log`, the newest 200, and the hub's log).

Devices keep their own copy of each chat and ask the hub only for what changed since (docs/sync.md). What the hub
changes behind the journal's back would never reach them, so these make every device reload its chats (a `resync`,
which starts a new journal epoch): showing or hiding adversarial features (kept messages are then served with or
without their words), an import that added or filled messages, undoing an import, and Forget.

`ui/Adversarial.tsx`, `keeping.ts` (what is kept now, for Message history's note and Forget); `ADVERSARIAL_KEEPS` and
`KEPT_KINDS` in packages/protocol. A demo hub started with `--adversarial` shows them
from the start (scripts/verify-history.ts); scripts/verify-adversarial.ts checks the gate.

## Storage

Three tables, by what they hang off:

- **`message`** itself for deleted and disappeared messages: `deleted`, `gone_how` (`deleted` or `disappeared`),
  `gone_at`, and the body and attachments left in place when kept. Timelines, search and counts need nothing special;
  `message_gone`, a partial index on `gone_how`, finds them for Forget without reading every message.
- **`message_event`** (message_id → message, ON DELETE CASCADE): `kind` (`edit`, `unreact`, `pin`, `unpin`), `data`
  (JSON: an edit's previous `{ body }`, an unreact's `{ key, style, cleared?, exact?, added?, addedExact? }`: `exact`
  when `at` is the network's own time rather than when the hub heard, `added` when the reaction had been made, as
  `reaction.at` had it), `actor_id`, `at`, `account_id`. It
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
- **`profile_version`** (identity, account): each distinct answer to a profile request (`data`, the `about` row's JSON
  without posts), written when it differs from the last one kept, and the answer before the first change too. Written
  only while `adversarial` and `profiles` are on; Forget's "Profile versions" erases them. The last answer itself stays
  in `about` either way, as it always has.
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
(`{ t: 'retention' }`). A device asks for them again on every reconnect, so one that started out of the hub's reach, or
was away while they changed, catches up without a reload.

## Changes

`GET /api/{conversations|spaces|identities|persons}/:id/changes`, newest first (a person's covers all their
identities), with the identities they name; `GET /api/messages/:id/history` for a message's versions, events,
reactions with a known time (docs/reactions.md "When") and receipts.

- Conversations and spaces: name, description (topic), picture, as their facts arrive. A conversation first known
  from a message, with no name yet, filling in is not a change.
- Group members: who joined and who left, once the members were known (`shape: 'group'` only).
- Roles: an adapter's `role` event (Discord roles from member updates, Matrix power levels, admin on Signal and
  WhatsApp, a Zulip role or user group), with who gave or took it where the network says. Kept against the place; a
  person's changes (`/api/persons/:id/changes`, `/api/identities/:id/changes`) have theirs too while changes are kept.
- Pins: an adapter's `pin` event, with who.
- Settings: each About answer is compared with the last one kept through the same account.
- People: display name, username and picture as identity facts arrive; status from an adapter's `customStatus`
  event (Discord friends' custom status, WhatsApp contacts' About, Matrix status messages of people you DM) or a
  profile answer; bio, pronouns and banner when a profile is opened. On Signal and WhatsApp the About is the status.
- Nothing said is no change: networks often leave fields out. A description, bio, status or pronouns may go from
  nothing to something and back; a name or picture is only replaced.

## A message's history

One list for everything that happened to a message (ui/MessageHistory.tsx, rows in `messageHistory.ts`), oldest first
so the latest is at the bottom, as in a chat, and it opens scrolled there. What the message says now sits above it.

- **Sent**, with what it first said when it was edited since.
- **Each edit**, as the words it took out (struck) and put in, with three words either side and `…` for the rest
  (`wordDiff.ts`); "Whole text" shows that version whole with its changes marked.
- **Reactions** made and taken back, each with its time (docs/reactions.md "When"); those already there when the hub
  first saw the message, with no time, in one row at the top, with how many the network counts but does not name.
- **Pins** and unpins, with who.
- **Your own message's receipts**: every delivery in one row, and the reads (and plays) between two edits in one row
  each, so it says who read which version. A click on a row lists each person with their time.

It opens on one part or on all of it, never with filters: from "(edited)" or the words an edit put in on its edits,
from a reaction on its reactions, and from the ticks or Message History in the message's menu (by its reactions) on
all of it. On a computer a right-click opens it as a click does on all of these, a reaction too; on a phone a long
press on a reaction does. "All history" goes from either part to all of it. On a computer it hangs below what opened it (above, when
there is no room); on a phone it is a page of its own, which back closes. It is a chunk of its own, loaded the first
time one opens.

**In the chat**, the words a message's last edit put in are underlined, quietly, and a click on them opens its edits.
The hub sends the version before (`MessageView.prevBody`, the body the last edit event kept), and the web app
compares the two as rendered text, so markdown's marks are not words (`markChanged`). A right-click on them opens the
edits too; elsewhere on the message it is the message's menu. Nothing is underlined when the edit only took words out,
or when no word of the old text is left; "(edited)" is there either way.

## Not logged

A server's own membership (joins and leaves in big servers, which Discord does not send to user clients without the
member list open), channels made, renamed or removed in a server. Presence only as above, and only of people the account follows.
