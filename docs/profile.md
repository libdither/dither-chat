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
  the name, then a line of what it is: a person's handle (click to copy), or for someone with several accounts their
  networks' marks and "N accounts", which scrolls to them; a place's network, kind,
  member and channel counts. Tags under it: pronouns, Friend / In your contacts (with the networks' marks), You, Bot;
  for a place End-to-end encrypted, Age-restricted, Only admins send, your role there, Muted. A person's status line
  last.
- **Actions.** One row. A person: Message (one network: straight there; several: a menu of each network, the merged
  thread, and starting a chat where there is none), All chats, More. A place: Open, Their profile (a DM), Mark
  read, Mute, Search, Copy link, More. **More** is the same menu the person or place has everywhere else, minus what
  the row already has, plus Merge Another Identity In and Ask the Networks Again for a person. It has no Open on
  <network>: the browser is rarely signed in to the network's site, so Copy holds the profile link instead.
- **Two columns**, one on a phone (under 900 px). Left: what it is and what you share. Right: how you stand with it.

## A person

It grows with the person. Someone with one account looks as a single profile does: one handle under the name, the
bio in About, the account on the right. Someone with several gets **Accounts** at the top of the left column instead.

Left:
- **Accounts**, for someone with several accounts (Kit's seven, Mo's two, yours): a tile each, grouped by network
  (`AccountTile` in ui/Profile.tsx). Each has the account's own picture with its network's badge, its own name (its
  display name, else handle, else id), its handle or address as a chip that copies, the network and since when
  they are on it, and that account's bio (three lines, the network's stock lines left out). A button goes to the
  account: its chat (the person's page, sending there), else Start a chat on that network where an account of yours
  can, else Email. ⋯, a right-click or a hold opens the account's menu: the same, Copy the handle and the id, Open on
  the network, Split Into Its Own Person. The merge hint and search sit under the tiles. Before 2026-11-11 the hero
  had a chip per handle and the right column a plain row per identity, with one picture for the person.
- **About**: each network's bio (on the account tiles instead, for someone with several), the longest first, labelled
  by network when there is more than one (a network's
  stock line such as WhatsApp's "Available" is left out); their links (connected accounts, GitHub, a phone number
  written two ways once); On Discord since; facts a network adds (Business, Time zone); how many of their messages
  the hub has, since when. A network that could not be asked says why, in a line.
- **In common** (on your own page, **Your places**): servers as tiles with their icon, their nickname and roles
  there, or how many messages they wrote in it; then group chats with their picture, kind, and how many messages are
  from them. Discord's mutual servers count even where they never wrote; the rest comes from messages and member
  lists the hub has. A server they wrote in says how many of their messages the hub holds there, and an estimate of
  how many they posted when one can be made (below, "Message counts").
- **Mail** (docs/mail.md, "People"), for someone with an email address: their newest threads across your mail
  accounts, how many, and All mail with them. A thread opens in Mail.
- **Recent messages**: each with the place's picture (the server's icon for a channel), the place, and when. Not
  shown for someone known only by mail.
- **Activity** (ui/ActivityCard.tsx): the current status and since when, and their presence now when it is logged; then
  the activity chart (below, "Activity"); then, with adversarial features shown (docs/history.md), the logged status
  history and presence history (each stretch with how long it lasted), each collapsed until opened. Absent when there
  is no status, nothing logged and no message or conversation with them.
- **History**: what changed about them, except statuses and presence (ui/HistoryCard.tsx).

Right:
- **Mutual friends** (Discord), or on your own page **Friends**: your Discord friends, Signal and WhatsApp
  contacts and Matrix direct chats, each person once. Click one for theirs.
- **How you stand**: each of your accounts that has them on its list (friend, request sent, blocked, contact,
  following), from the accounts' own lists, else what a profile said, with Remove friend, Cancel request, Unblock,
  Remove contact or Unfollow where the account can; each asks first (docs/add.md, "Relationships").
- **Accounts**, for someone with one account: it, with Open on the network; a hint when someone elsewhere has the
  same name, saying where ("Alice Chen on Signal", "Alice Chen <alice@…>"), and the merge search, which finds people by any name
  or handle (an email address too) and email addresses no person holds yet (`GET /api/persons/candidates`).
- **Notifications**: Always alert, a person rule `all`: every message of theirs is an alert
  ([notifications.md](notifications.md#rules)). Stars left the app on 2026-11-10 and the hub cleared the old ones
  once (`clearStars`, packages/hub/src/store.ts), so Always alert is the only way to have someone always get through.
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

### Activity

When someone is around, from what the hub already holds; it asks no network. `GET /api/people/:id/activity?days=30&tz=<zone>`
(`:id` a person, all their identities, or one identity; `days` 1 to 365, 30 when missing; `tz` the page's IANA zone, or
`offset` in minutes east of UTC) answers an `ActivityChartView` (hub activitychart.ts). Hours are the owner's local
wall-clock hours, so a day always has 24: the hour a clock skips at a DST change stays empty and the hour it repeats
holds both. The zone's offset is found where it changes, and each piece of the range is counted in SQL with its own
offset, along `message_author_ts`: about 5 to 20 ms for someone with thousands of messages a year, on a hub holding
hundreds of thousands.

The page offers 7, 30 and 90 days (the choice is remembered on the device) and shows:

- **A summary in words**: "Usually around 9pm–12am; 412 messages and 37 reactions in 30 days, mostly in DMs. You sent
  230 messages where they are." The usual hours are the shortest run of hours holding half their messages (at most 8),
  said only from 8 messages up.
- **Bars of their messages** per hour or per few hours (7 days) or per day (30 and 90 days): every message they wrote
  that the hub holds, deleted and imported ones too, not system lines (joins), counted by where (a DM with you, a group,
  a server) and network.
- **Your messages mirrored under the axis**, in grey, on the same scale: what you wrote in DMs and groups they are in
  (not servers). Not on your own page.
- **Reactions they gave**, in the summary, the tooltip and the table, placed at the message they reacted to: the hub
  keeps who reacted, not when.
- **Their presence as a band under the bars**: online, idle, do not disturb, offline, merged across their identities
  (online wins, then do not disturb, then idle, then offline), from the logged presence changes. The states differ by
  height as well as colour, and do not disturb has a bar through it.
- **Status changes as marks above the bars**, with the status on hover.
- **When they're around**: a weekday-by-hour grid of their messages, yours, or the share of the logged time they were
  online or do not disturb.
- Hover, a tap or the arrow keys give the numbers for a bar, a mark or a cell; Numbers by day lists them as a table.

The presence band, the status marks and the grid's Online need adversarial features (docs/history.md): the hub sends
`presence` only while presence is logged and `statuses` only while statuses are (shown, and their switches on), and
leaves the fields out otherwise rather than sending zeros. Until then a line under the chart says they appear once
those are turned on, with a link to Settings → Adversarial features. The rest needs nothing turned on.

## A place

Left: **About** (the description, editable where you may; facts the network adds), **Settings** (each with its
control or a lock and the reason), **Pinned** (hidden when there is nothing and you cannot pin), **Channels** for a
server (the most active twelve), **Members** by role.

Right: **Seen as** (when several of your accounts are there: each may see and change different things),
**Notifications** (the place's rule: Automatic, Always alert, List only or Mute, and under Automatic what holds here
and from where; [notifications.md](notifications.md#rules)), **Invite link**, **Who can do what**, **Details** (your
role, the account it is seen as, the native id to copy, when the network last said).

Everything that changes something goes through the same checks as before (docs/group-settings.md): the network's
rules, then a fresh About through the account whose view it is.
