# Profile pages

One page for anyone and anywhere: a person, or a conversation, group, channel or server. The same frame for each,
so the same things are always in the same place.

**Getting there.** The picture or the name at the top of a chat opens it: the person's page in a DM, the place's page
anywhere else. Also: Profile in a person's menu, About This … in a conversation's or space's menu, the info button
in a space's header, an author's name or avatar, and links (`#/p/<person>`, `#/i/<identity>`, `#/about/c/<conv>`,
`#/about/s/<space>`). A place's page keeps the list it lives in beside it: a channel's its server, a group the inbox.

Code: `packages/web/src/ui/ProfileShell.tsx` (the frame), `Profile.tsx` (a person), `PlaceProfile.tsx` (a place, built
from the About pieces in `About.tsx`, docs/group-settings.md); `packages/hub/src/people.ts`; the `profile` adapter
command (`packages/protocol/src/about.ts` `PersonAbout`).

## The frame

- **Hero.** A banner (their Discord banner, else their accent colour, else the network's), the picture overlapping it,
  the name, then a line of what it is: a person's handle on each network (click to copy), a place's network, kind,
  member and channel counts. Tags under it: pronouns, Friend / In your contacts (with the networks' marks), You, Bot;
  for a place End-to-end encrypted, Age-restricted, Only admins send, your role there, Muted. A person's status line
  last.
- **Actions.** One row. A person: Message (one network: straight there; several: a menu of each network, the merged
  thread, and starting a chat where there is none), Star, All chats, More. A place: Open, Their profile (a DM), Mark
  read, Mute, Search, Copy link, More. **More** is the same menu the person or place has everywhere else, minus what
  the row already has, plus Open on <network>, Merge Another Identity In and Ask the Networks Again for a person.
- **Two columns**, one on a phone (under 900 px). Left: what it is and what you share. Right: how you stand with it.

## A person

Left:
- **About**: each network's bio, the longest first, labelled by network when there is more than one (a network's
  stock line such as WhatsApp's "Available" is left out); their links (connected accounts, GitHub, a phone number
  written two ways once); On Discord since; facts a network adds (Business, Time zone); how many of their messages
  the hub has, since when. A network that could not be asked says why, in a line.
- **In common** (on your own page, **Your places**): servers as tiles with their icon, their nickname and roles
  there, or how many messages they wrote in it; then group chats with their picture, kind, and how many messages are
  from them. Discord's mutual servers count even where they never wrote; the rest comes from messages and member
  lists the hub has. A server they wrote in says how many of their messages the hub holds there, and an estimate of
  how many they posted when one can be made (below, "Message counts").
- **Recent messages**: each with the place's picture (the server's icon for a channel), the place, and when.
- **Status**, collapsed until opened (ui/StatusCard.tsx): the current status and since when, and with adversarial
  features shown (docs/history.md) the logged status history and presence (now, and each stretch with how long it
  lasted). Absent when there is no status and nothing logged.
- **History**: what changed about them, except statuses and presence (ui/HistoryCard.tsx).

Right:
- **Mutual friends** (Discord), or on your own page **Friends**: your Discord friends, Signal and WhatsApp
  contacts and Matrix direct chats, each person once. Click one for theirs.
- **Accounts**: each identity, with Open on the network and Unmerge; a hint when someone elsewhere has the same name,
  and the merge search.
- **Notifications**: Star, and Always notify without starring.
- **Note**: yours only, kept on the hub.

### Your own bio

On your own page, the bio on each network whose adapter can change it (capability `editProfile`: Discord, Signal,
WhatsApp; Matrix has no bio) shows with a pencil. Editing shows how many characters the network still takes
(`BIO_LIMIT` in about.ts: Discord 190, Signal 140, WhatsApp 139, an emoji counting once) and will not save past it.
Saving is `PUT /api/identities/:id/about` with `{ bio }` ('' clears it): the hub takes it only for an account's own
identity (403 otherwise), only where the adapter lists `editProfile` (409), checks the limit again (400), then sends
the adapter `setProfile` and keeps what it answers like any profile it was asked for. A network that refuses says
why (502). On Signal and WhatsApp the About is also the status line, so the identity's status changes with it.
Someone else's bio never has a pencil.

### Asking the networks

The page shows at once what the hub has and what each network said last (`ProfileView.abouts`), then asks again for
each identity (`GET /api/identities/:id/about`), at most once every ten minutes unless More → Ask the Networks Again
(`?fresh=1`). Only when someone opens a profile, one identity at a time, as the network's own app does when you
open someone's profile; never in bulk or on a timer.

`people.ts` picks the account that asks: yours, for your own identity; else one that shares a conversation with
them; else any connected one on their network. The adapter answers a `PersonAbout` in native ids; the hub keeps it
(the `about` table, keyed by identity) and turns it into hub ids: mutual servers into the hub's spaces (`spaceId`
null for one it does not have), friends into identities, pictures into signed media paths.

| | Bio | Status | Pronouns | Since | Relationship | Mutual spaces | Mutual friends | Your friends | Links | Facts |
|---|---|---|---|---|---|---|---|---|---|---|
| Discord | bio | custom status | yes | from the id | friend, requests, blocked | servers, with nick and roles | yes | friends list | connections | |
| Signal | About | About emoji | | | contact, blocked | (hub's own) | | contacts | phone | |
| WhatsApp | About | | | | contact, blocked | (hub's own) | | address book | phone | business |
| Matrix | | | where the server keeps them | | has a DM | (hub's own) | | DM partners | matrix.to | time zone |

### Message counts

`GET /api/persons/:id/activity` (or `/api/identities/:id/activity`, `?space=` for one server) says, per server they
wrote in, how many messages they posted there, from the messages the hub already holds. It asks no network and
fetches nothing (hub msgcount.ts). It never claims more than the data supports:

- **Seen** (`observed`): their messages the hub holds there, deleted and imported ones included. Exact, and a lower
  bound: "≥120 seen".
- **Share**: their part of all the messages the hub holds there, with a 95% Wilson score interval, which stays honest
  for small samples and for someone who wrote none or all of them.
- **An estimate** (`estimate`, `low`, `high`), only on Discord and only where the data supports one. Discord ids are
  snowflakes, but one id stream serves all of Discord, so the spacing of ids in a channel says nothing about how many
  messages it had. A channel's own id does say when it was made. So, per channel: the hub's messages are assumed to
  cover everything from the oldest one held to the newest (history pages and live sync come without holes). That
  window is cut into up to 24 bins of a week or more, and a bin with nothing held may be a hole (a recent page and an
  old reply fetched alone look like years held), so a channel with one gets no estimate. Held back to its start
  (`complete`): the count is the count. Otherwise the stretch from when the channel was made to the oldest message
  held is filled at the channel's own rate (`snowflake-lifetime`): its mean for the estimate, its quietest and
  busiest week-long bins for the range, and their share of it with its Wilson interval. Only time after they could
  have posted counts: after their Discord account was made, and after they joined where the adversarial members
  setting kept that (a join after their first message held is a rejoin, and ignored). Channel ranges add up as they
  are, so the range is wide on purpose: it means "if the unseen time was like some stretch we saw", not a confidence
  interval, since a server's activity drifts.
- **No estimate** (`share`, "≥120 seen (total unknown)") when the window held has an empty bin, is under a week or
  under a fifth of the channel's life, or holds under 20 messages; on networks whose ids carry no time (Matrix, Signal, WhatsApp, Telegram,
  Google Messages); or when channels with no estimate hold over a tenth of their messages. `reason` says which.
  Under a tenth, those are counted as seen only and named (`unestimated`), and the page puts a "+" on the top of the
  range: it is not a ceiling then.

The profile's In common tiles show it ("≥120 seen; ~1,400 estimated, 900–2,100", rounded to two figures), with the
share, the server's own estimated total and what it rests on in the tooltip.

## A place

Left: **About** (the description, editable where you may; facts the network adds), **Settings** (each with its
control or a lock and the reason), **Pinned** (hidden when there is nothing and you cannot pin), **Channels** for a
server (the most active twelve), **Members** by role.

Right: **Seen as** (when several of your accounts are there: each may see and change different things),
**Notifications** (the place's level, or Default with what it inherits and from where), **Invite link**, **Who can
do what**, **Details** (your role, the account it is seen as, the native id to copy, when the network last said).

Everything that changes something goes through the same checks as before (docs/group-settings.md): the network's
rules, then a fresh About through the account whose view it is.
