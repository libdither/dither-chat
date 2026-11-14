# Servers

What a community has beyond its channels: its scheduled events and your Interested, leaving it, its invite links,
your nickname there, and what it asks of you on joining (its rules, an application, onboarding). Discord's servers
first; the protocol is shaped for the others (a Signal group or a Discord group DM leaves with the same command).
The Discord side lives in dither-accounts (`extractors/discord/src/servers.ts`, hook.js's "servers" section, its
docs/chat.md "Servers"); the demo world answers the same way (`packages/hub/src/demoservers.ts`).

## What works

- **Opening a server.** On a computer, opening a server (its icon on the left, Ctrl+K, a search result, a link to it)
  goes to the channel you last opened in it, here or from the inbox or search, while its channel list stays beside
  it. A server never opened, or whose last channel is gone, opens on its first channel to read (text, announcements
  or rules, in list order through its categories), as Discord does; one with none shows its list. On a phone the
  server's list is still the page it opens. Remembered per device, in the browser (`web/src/lastchannel.ts`).
- **Events.** A server's page has an Events card, and an Events button in its header when it has any: each event's
  cover, when (with "Every week" for a repeating one, and how many coming occurrences were called off), where (a voice
  or stage channel, or a place outside), its description, how many are interested and who made it. **Interested** turns
  your answer on and off through the account whose view the page is; the refresh button asks the network again (what
  opening the server's events list in Discord does: your answers, then each event's count). Events arrive passively:
  every server's after the account connects, a server's when it is joined, and each change as Discord's gateway sends
  it. Only the count and your own answer are kept, never who else is interested.
- **For the calendar.** `GET /api/calendar/network-events?since=<ms>` lists every account's events, each once, in
  dither-calendar's terms (`NetworkEvents` in `packages/protocol/src/calendar.ts`): title, place in words, start and end
  in UTC, the RRULE, called-off occurrences as EXDATEs, moved ones with their RECURRENCE-ID, your Interested and a link
  to open it. dither-calendar does not read it yet: that side is still to build (see "Not built").
- **Leaving.** A Leave button in a server's header. It asks first ("You stop getting its messages, and need an invite
  to come back"); where you own the server it says why you cannot instead: "You own this server: Discord lets you leave
  only after you give it to someone else (Server Settings → Members) or delete it, in Discord." After leaving, the
  server, its categories and channels go from the sidebar.
- **Invite links.** On a Discord server the invite card lists every link the account may see (all of them for
  someone with Manage Server, as Discord's Invites tab; else the ones made from here), each with its uses, limit and
  expiry, a QR code, and Turn off where you may. Making one shows Discord's own choices first: expire after 30 minutes
  to never (7 days by default), and a use limit (none by default). A server's vanity address is shown, and never runs
  out.
- **Your nickname.** A "Your nickname here" card: set or clear it, where you have Change Nickname.
- **Rules, applications and onboarding.** After a join that comes back with Discord's rules check (docs/add.md), the
  server's page shows a card with what it asks now, one step at a time:
  - *Rules:* the rules as written, a tick box "I have read and agree to the rules", and Agree. Never agreed for you:
    the hub, the adapter and the hook each refuse an answer without your tick.
  - *Apply:* its questions (a line, a paragraph, or a choice), and Send application. Then "Your application is waiting
    for a moderator", until it is approved (the card goes) or turned down (the card says so, with their reason).
  - *Onboarding:* its questions with the channels and roles to pick, and Finish.

## How

| Route | |
|---|---|
| `GET /api/spaces/:id/events[?account=&fresh=1]` | `SpaceEventsView`: kept events, soonest first; `fresh` asks the network (`scheduledEvents`) |
| `POST /api/spaces/:id/events/:eventId/rsvp {interested, occurrence?, accountId?}` | `ScheduledEventView` as it now stands (`rsvp`) |
| `GET /api/events?from=&to=` | every account's events, each once |
| `GET /api/calendar/network-events?since=` | `NetworkEvents`, changed since then (0: all) |
| `POST /api/(spaces\|conversations)/:id/leave {accountId?, silent?}` | `LeaveResult`, after a fresh About's `leaving` says it may |
| `GET /api/spaces/:id/gate` / `POST {answer, accountId?}` | `SpaceGateView` / `GateResult`, the answer checked by `gateAnswerProblem` against a fresh read |
| `POST /api/spaces/:id/nick {nick, accountId?}` | the About as it now stands (`setNick`) |
| `POST /api/spaces/:id/about {change: {key: 'invite', op, maxAge?, maxUses?, code?}}` | as any setting (group-settings.md) |

Writes need the page's own Origin, as adding people does. Each leaves a line in the account's log (`[event]`,
`[leave]`, `[join]`, `[nick]`). The hub keeps each account's events (`scheduled_event`) and gates (`space_gate`) as
the adapter last said them (`hub/src/servers.ts`).

Protocol (`packages/protocol/src/servers.ts`, all additive): capabilities `events`, `rsvp`, `leave`, `gates`,
`inviteLinks`, `nick`; events `scheduledEvents`, `scheduledEvent`, `scheduledEventGone`, `gate`; commands
`scheduledEvents`, `rsvp`, `leave`, `gate`, `answerGate`, `setNick`; `About.leaving`, `About.nick`,
`AboutInvite.links/vanity/options`, and `maxAge`, `maxUses`, `temporary`, `code` on the invite change. An adapter
without a capability gets nothing new offered: the page reads as before.

The page's parts are a lazy chunk (`web/src/ui/ServerParts.tsx`), loaded the first time a server's page opens.

## Not built

- dither-calendar reading `/api/calendar/network-events` (its own repo), and events in the hub's Ctrl+K.
- Making or editing events (L): Discord's form has many parts (place, picture, recurrence); open the event in Discord.
- Leaving a Signal group: the command and `About.leaving` are shaped for it. A Discord group DM (silently, where
  asked) and closing a DM are built: docs/threads.md.
- Friend invites (links that add you as a friend): accepting works (docs/add.md); making one is left out.
- Per-server profiles (avatar, bio, banner), server tags, role connections: not read yet.
- Discovery, templates, boosting, the shop and role subscriptions, the server guide and home, themes: not built.

## Testing

`packages/hub/test/servers.test.ts` runs the hub against the demo world's adapters in process: events kept and
ordered, a fresh read, Interested and back with the count, one occurrence, the calendar feed, links with limits and
turned off, the nickname, rules then onboarding (never answered without the tick), and leaving refused for the owner
and done for a member. `web/test/servers.test.ts` covers the words and checks the page shows. In dither-accounts,
`extractors/discord/test/servers.test.ts` maps events, rules and the About and runs the hook's commands against fakes
of the client's modules. Nothing here has run against a live Discord account.
