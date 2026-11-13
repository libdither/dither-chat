# An account's own self

What a network says of your account itself, and ignoring someone there. Protocol `packages/protocol/src/self.ts`, hub
`packages/hub/src/accountself.ts`, web `ui/AccountSelf.tsx` and `ui/ProfileSelf.tsx` (each a chunk of its own, with
its own styles). Discord is the first network with it (its extractor lives in dither-accounts, docs/chat.md "The
account itself"); the protocol names are network-neutral, so another adapter adds its own by saying the same
capabilities. Blocking, your note on someone on the network, and your profile's name and picture are the shared paths
Signal brought (docs/profile.md: Block, "Your nickname and note on the network", "Your own bio"): Discord now speaks
them too.

Nothing here was run against a real account: the Discord side is built from the client's own code and tested on
fakes, the hub and page on the demo world.

## What the network wants done

An account can be stopped by its network until you do something: verify a phone or an email, agree to new terms,
solve a captcha, finish an age or safety check; or it can be limited or suspended. The adapter says each as a notice
(`notices` event, the whole list each time): a kind, a few words, a plain sentence, and whether the live view is where
to do it.

- They show as cards on the account's page (above everything but the account's own attention), and the first one's
  title in the accounts list.
- dither never does any of it, and never dismisses one: a notice goes when the network stops saying it. The time it
  first came is kept across restarts.

On Discord: the gateway's required action and, once the client has read it itself, the account's standing.

## Your status

With `setPresence`: online, idle, do not disturb or invisible, and a status line (text, an emoji, and when it clears:
30 minutes, an hour, 4 hours, today, or never), on the account's page. The account says what it is now in its
`selfState` events, set here or elsewhere.

**Do not disturb during quiet hours** is a toggle on that page, off unless you turn it on, per account. With quiet
hours on (Settings, Push and quiet hours), the hub sets the account to Do not disturb when they begin and back to what
it was when they end. A status you choose in between is yours: the end leaves it. Already Do not disturb or invisible
when they begin: nothing changes either way. A change the network refuses is tried again ten minutes later.

## Where you are signed in

With `sessions`: "Where is Discord signed in?" on the account's page asks once (never in the background) and lists
each device, its rough place and when it was last used, the hub's own sandbox marked. Signing others out needs your
password on Discord, so that is a link to the live view.

## Folders and privacy

`selfState` also carries the network's own arrangement of spaces (Discord's server folders) and its privacy settings
as plain lines ("Direct messages from server members: Allowed in new servers, off in 2 servers"; the age check).

**Add Discord's folders to your sidebar** makes a dither folder for each of them, after yours, once you click it. A
server already in one of your folders stays where you put it; a folder whose servers are all placed already, or that
the hub has none of, is skipped and said. It can be run again to bring in what is new; nothing is ever moved or
removed.

## Ignore, and block

In a person's menu (More): **Ignore on Discord** (or Stop Ignoring), for each of their accounts on a network one of
your connected accounts can do it on, and not for someone you blocked. An ignored person shows an Ignored tag. Whom
each account ignores comes as the `ignored` event (the whole list), and is set at once when you do it here. Messages
from someone any of your accounts ignores never alert: triage makes them silent before anything else weighs them ("You
ignore them on Discord").

**Block on Discord…** is the shared `block` command (people.ts, docs/profile.md), with Unblock: Discord's adapter says
`block` and does it with the client's own Block (a person only; Discord has no blocking of groups). Nothing from
someone blocked alerts (triage's blockedByYou).

## Your note on them

Discord's adapter says `contactNotes`, as Signal's does: your private note on someone comes with their identity when
their profile is opened (never for everyone), and the hub joins it with your dither note so neither text is lost, then
sends the joined note back (docs/profile.md, "Your nickname and note on the network"). Discord keeps 256 characters: a
joined note longer than that is refused there and stays whole here. Discord's nickname for a friend is not read or
written (your choice, docs/chats.md).

## Your own profile

On your own profile, under your bio: your name and picture (SignalPeople.tsx's OwnProfileExtras) and your pronouns,
banner and banner colour (ProfileSelf.tsx), each where the profile's `editable` lists it; Discord's lists `bio`, `name`,
`avatar`, `pronouns`, `banner` and `accent`. All go through `PUT /api/identities/:id/about`. Discord's limits are
checked by its adapter (32 characters for a name, 40 for pronouns, pictures up to 10 MB); a banner picture without
Nitro is Discord's refusal, said as it said it.

A profile also shows what the network adds beyond text: badges, the frame on the picture, and the profile's colours.

## API

| Route | What |
|---|---|
| `POST /api/self/people/:identity/ignore` | `{ ignored, accountId? }`: `{ ignored }` |
| `PUT /api/identities/:identity/about` | (shared) also `{ pronouns?, banner?, accent? }`, the banner as an upload id (docs/uploads.md) or null |
| `GET /api/self/:account/sessions` | SessionsResult |
| `POST /api/self/:account/presence` | `{ state?, status? }` (`status: null` clears it): OwnPresence |
| `POST /api/self/:account/folders/import` | FolderImportResult |
| `PUT /api/self/:account/dnd-quiet` | `{ on }` |

Writes come from the app only (an Origin header). The account's view carries the rest as `AccountView.self`.

## Not built

Friend suggestions and Discord's affinities (its own ranking of whom you talk to most) are left out: dither ranks from
your own history (docs/inbox.md), and an outside prior would need a replay to show it helps. Friend nicknames stay
unread (your choice, docs/chats.md); friends' rich presence stays out on purpose. Requesting a data export, streamer
mode, MFA, password and email are done in the live view.
