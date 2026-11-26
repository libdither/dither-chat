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
  the name (for a person of one account, with a pencil on hover for that account's nickname, also under More), then a
  line of what it is: a person's handle (click to copy), or for someone with several accounts their
  networks' marks and "N accounts", which scrolls to them; a place's network, kind,
  member and channel counts. Tags under it: pronouns, one per kind of connection with the networks' marks (Friend,
  Contact, You follow, Follows you, Request sent, Blocked: "Connections" below), Wants to be friends, You, Bot;
  for a place End-to-end encrypted, Age-restricted, Only admins send, your role there, Muted. A person's status line
  last, a custom emoji in it as its picture where a profile gave one (`status.emojiUrl`: Zulip's organization emoji),
  else as `:name:`.
- **Actions.** One row. A person: Message (straight to your chat with them, every route together, where the message
  box's line chooses the accounts; with no chat yet, starting one, a menu where there are several ways: each account's
  own menu always has it), Merge (opens the search for someone to merge in; again closes it), Copy (a menu: the
  handle, id and profile link, a submenu per account for someone with several), Block (a menu, only where one of your
  accounts can block them: Block or Unblock on each such network), More. A place: Open, Their profile (a DM), Mark
  read, Mute, Search, Copy link, More. **More** is the same menu the person or place has everywhere else, minus what
  the row already has, plus Ask the Networks Again for a person, and Ignore on a network
  whose account can (docs/account-self.md). Copy has no Open on
  <network>: the browser is rarely signed in to the network's site, so Copy holds the profile link instead.
- **Two columns**, one on a phone (under 900 px). Left: what it is and what you share. Right: how you stand with it.

## A person

It grows with the person: someone with one account has one row in Accounts, someone with several a row each. Two
columns: who they are and what passes between you on the left, their accounts and what you share on the right. A
screen 900 px wide or less has one column, which takes the first part of each before the rest: the glance, About,
Between you, Accounts and In common, then Activity and the others. Cards are tight (10 px inside, 10 px apart).
Before 2026-11-25 the page had separate Recent messages, Mail, Mutual friends, Close to, Connections, Notifications and
Note cards, about half again as tall; four layouts were drawn on the demo world (tidier columns, tabs, a folded digest,
three columns; the PR has the pictures) and the owner picked the tidier columns.

Left:
- **At a glance**, not on your own page: a line or three of how you stand, what you share and when you last heard from
  them: "Friends on Discord, in your contacts on Telegram, Signal and WhatsApp. You share libdither, Climbing crew and
  Book club and 3 friends (Ravi, Jordan and Theo). Last heard 49m ago in your Signal chat; last mail 1h ago."
- **Maybe the same person**: up to four Same person? suggestions with this person in them (docs/same-person.md), each
  with the other side's name and accounts, the chance, the strongest three pieces of evidence, Merge and Not the same;
  All opens the whole list. Only when there are some, and never on your own page.
- **About**: each account's bio, its links as links (an address with or without `https://`, a Markdown link, and on
  X an @handle; `links.ts`, `bits.tsx` Linked), the main account's first, then the longest, labelled by network when
  there is more than one (with the account's name too when two are on one network, and "main" on the main one's; a network's
  stock line such as WhatsApp's "Available" is left out); their links (connected accounts, GitHub, a phone number
  written two ways once); On Discord since; facts a network adds (Business), the people a fact names (a bot's owner,
  a Zulip person field: `facts[].people`) each a link to their profile; their **Local time** where the network
  says their time zone (`PersonAbout.timeZone`, an IANA name, else a "Time zone" fact from an older adapter: Zulip,
  Matrix's `m.tz`), with how far it is from yours; how many of their messages
  the hub has, since when; follower, following and post counts (X). A network that could not be asked says why, in a line.
  Badges, the frame on their picture and their profile's colours, where the network shows them. On your own page,
  under your bio: your name, pronouns and banner on each network that lets you change them here
  (docs/account-self.md); your picture is the hero's ("Changing a picture", below).
- **Between you** (on your own page, **Your messages**): their recent messages and your mail threads with them in one list,
  newest first, six at a time with All for the rest. With both, chips choose All, Messages or Mail with their counts.
  A message has the place's picture (the server's icon for a channel), the place, and when; a feed item says what they
  did ("X notifications", "Liked your post: “…”"). A thread (docs/mail.md, "People") says "Mail" and who wrote, with
  its subject bold while unread and its start, and opens in Mail; All mail opens every thread with them. Absent when
  there is neither.
- **Activity** (ui/ActivityCard.tsx): the current status and since when, and their presence now (from the log when it
  is logged, else the status dot's words: "Online on Zulip"); then
  the activity chart (below, "Activity"); then, with adversarial features shown (docs/history.md), the logged status
  history and presence history (each stretch with how long it lasted), each collapsed until opened. Absent when there
  is no status, nothing logged and no message or conversation with them.
- **Recent posts** (X, [feed.md](feed.md#profiles)): their posts as their profile said them, pinned, reposts, replies
  and quotes marked, with pictures, counts and a link to each. A post opens its thread ([feed.md](feed.md#threads)),
  and each is logged as a message.
- **Voice** (ui/VoiceClose.tsx; below, "Voice"): with the adversarial voice log on and something in it, their minutes in
  voice channels this month and in the past 30 days, who they are usually in voice with, and their latest stretches in
  a channel.
- **Events** (docs/events.md, "People"): the Luma and Partiful events any of their accounts hosted or went to, hosting
  first, then upcoming soonest, then the past, each with when, where and their part; one opens the event's page.
- **History**: what changed about them, except statuses, presence and voice (ui/HistoryCard.tsx), and, while changes are kept,
  the roles and user groups they were given or lost in a place ("was given designers in Example Org"), which are
  kept against the place and show in its History too.


Right:
- **Accounts**: a row an account, grouped by network
  (`AccountRow` in ui/Profile.tsx). Each has the account's own picture with its network's badge, its name as you see
  it (your nickname for it, else its display name, else handle, else id; with a nickname, the account's own name
  beneath it, muted: "their name: kitty"), its handle or address as a chip that copies, the network and since when
  they are on it, and **Main** or **Picture** when it speaks for them (below, "Which account speaks for them"). Its
  bio is in About. A button goes to the account: its chat (the person's page, sending there), else Start a chat on that
  network where an account of yours can, else Email. **Edit** opens the account's menu as buttons under the row (a
  right-click or a hold opens it as a menu): Make Main Account, Use Its Picture, Set Nickname… (Change Nickname… and
  Remove Nickname once it has one, editing the name on the row in place; only you see it, docs/chats.md "Names"), Copy
  the handle and the id, Open on the network, Split Into Its Own Person. A line under the rows says which account
  speaks for them, whether you chose it or the hub did, and which account their picture is from. Under each row, how
  each of your accounts stands with it ("Connections", below: In your Telegram contacts, Friends on Discord from
  alt and from main), each with its Remove friend or the like. A row whose name is the person's leads with its handle
  instead of repeating the name. A hint when someone elsewhere has the same name, saying where ("Alice Chen on
  Signal", "Alice Chen <alice@…>"), and the merge search, which finds people by any name or handle (an email address
  too) and email addresses no person holds yet (`GET /api/persons/candidates`), sit under it. Before 2026-11-23 each account was a
  tile with its bio on it and its menu behind ⋯; before 2026-11-11 the hero had a chip per handle and the right
  column a plain row per identity, with one picture for the person.
- **In common** (on your own page, your friends and **Your places**): **People**, the friends you share and the people
  they talk with most, in one list (`PeopleInCommon` in ui/VoiceClose.tsx; below, "People in common"), how many of each
  on top, eight shown with All for the rest; then **Places**, a row each server and group chat you are both in, with
  their nickname and roles there or how many of their messages the hub has in it (below, "Message counts"), the bio
  and pronouns they set for that server in its tooltip, and for a group its kind and how many messages are from them.
  Discord's mutual servers count even where they never wrote; the rest comes from messages and member lists the hub
  has. On your own page, **Friends and contacts** (`FriendsCard`): your Discord friends, Signal and WhatsApp contacts
  and Matrix direct chats, each person once, a chip per network with its count in its own word ("5 friends", "4
  contacts", "mutuals" for a follow network) that shows only that network's, each row ending with its networks'
  badges.
- **Safety number** (Signal, capability `safetyNumbers`; below, "Safety numbers").
- **Yours**: **Always alert**, a person rule `all`: every message of theirs is an alert
  ([notifications.md](notifications.md#rules)); a place you muted still stays silent. Stars left the app on
  2026-11-10 and the hub cleared the old ones once (`clearStars`, packages/hub/src/store.ts), so Always alert is the
  only way to have someone always get through. Then your **note**: yours only, kept on the hub, and on a network that
  keeps notes too (below, "Your nickname and note on the network"). On your own page only the note, as **Note**.

More on a person also has **Block on <network>…** (asks first) or **Unblock on <network>** where an account can
(capability `block`: `POST /api/identities/:id/block { unblock? }`). Nothing from someone your account's list says you
blocked alerts (triage: "From someone you blocked"); on Signal their messages stop coming at all.

### Which account speaks for them

Someone with several accounts shows one name, one picture and the bios of all of them. One account speaks for them,
their face (docs/chats.md "Names"): the hub chooses the one you talked with last until you choose. Its name as you
see it is theirs everywhere (with your nickname for it, if you gave one), its picture is theirs, its bio comes first
in About, and its banner shows where it has one (else Discord's). They follow it: the network renaming the account, a
new picture, a nickname you give it. **Make Main Account** on one of their accounts (its Edit, or its menu) keeps
that one; pressing it again (checked, **Main Account**) lets the hub choose again. **Use Its Picture** on another
account takes the picture from that one instead, while it has one; pressing it again goes back to the main account's,
and so does making that account main or splitting it off. The hub keeps both on the person (`person.face_id` with `face_pinned`, and
`person.picture_identity_id`, set with `PATCH /api/persons/:id { face, picture }`, an identity id of theirs or null;
`PersonView.faceId`, `facePinned`, `pictureIdentityId`). Not on your own page: your own accounts go by the names you
gave them on their networks.

### Your own bio

On your own page, the bio on each network whose adapter can change it (capability `editProfile`: Discord, Signal,
WhatsApp; Matrix has no bio) shows with a pencil. Editing shows how many characters the network still takes
(`BIO_LIMIT` in about.ts: Discord 190, Signal 140, WhatsApp 139, an emoji counting once) and will not save past it.
Saving is `PUT /api/identities/:id/about` with `{ bio }` ('' clears it): the hub takes it only for an account's own
identity (403 otherwise), only where the adapter lists `editProfile` (409), checks the limit again (400), then sends
the adapter `setProfile` and keeps what it answers like any profile it was asked for. A network that refuses says
why (502). On Signal and WhatsApp the About is also the status line, so the identity's status changes with it.
Someone else's bio never has a pencil.

Where the adapter's answer lists more under `editable` (Signal: `name`, `emoji`, `avatar`, `username`), the rest of
your profile there shows under the bio: your name, the emoji by your About and your username (Set, Change, Delete; Signal adds the number after the name). The same `PUT` takes
`{ name }`, `{ emoji }` ('' clears it), `{ avatar: <upload id> | null }` and `{ username: <name> | null }`; the hub
refuses a field the last answer did not list (409). Signal shows a username's link only when it sets one, so the link,
and its code under My code (docs/add.md, "QR codes"), come from the last time it was set here.

### Changing a picture

A hero's picture you may not change is a button that opens it full screen in the image viewer (ui/Viewer.tsx), to
zoom and pan; one you may change has **View Picture** first in its menu.

Where you may change a picture, the hero's picture is a button with a camera on it ("Change" over it on hover):
a group's or server's where its About says `fields.avatar.canEdit`, and yours on each network whose profile lists
`avatar` under `editable`. It opens a menu (a sheet on a phone): **View Picture** (where there is one), **Upload a
Picture…**, **From This Chat's Pictures…** (a conversation), **An Earlier Picture…** (where it had one), and **Remove Picture** where the network
can take it away (a Discord group, your own profile; not a Signal group or a server's icon). A picture dropped
anywhere on the page, or pasted where nothing is being typed, opens the editor too.

The editor (`ui/PictureEditor.tsx`, a chunk of its own; the crop's arithmetic in `src/picturecrop.ts`) crops to the
shape the network draws, a circle for a person and a rounded square for a place: drag to move, the wheel, a pinch,
the slider or + and − to zoom, arrows to nudge; the frame always stays covered. Beside it the picture as it shows
at three sizes, a button for another file, and pictures to pick instead: this chat's (`in:<conversation> has:image`,
spoilers and explicit ones left out), the ones it had before (its History, `…/changes?fields=avatar`), and on your
own page your picture on each network now. Nothing is sent until **Save**. What is sent is the square in the frame,
at most 1024 pixels a side, JPEG where the file was a JPEG and PNG otherwise; a GIF can be sent as it is instead,
uncropped, so it keeps moving.

On your own page the editor lists each network you may change it on (by handle where two accounts share one) and
ticks only the one you came from: the account the page was opened by, else the one whose picture the hero shows.
An account tile's menu has **Change Picture…**, ticked to that account. Saving uploads the picture once per network
and sends it the way that page always has: `PUT /api/identities/:id/about { avatar }` for yours, a group's
`POST /api/conversations/:id/picture` where the account has `groupPicture`, else the About change
(`{ key: 'avatar', value: <upload id> }`, docs/group-settings.md). The toast says where it changed, names a network
that refused, and has **Undo**, which sends each network the picture it had before (fetched back from the hub) or,
where it had none, takes the new one away.

### Safety numbers

On Signal, a person's page shows your safety number with them: the 60 digits in Signal's 12 groups of 5, **Show the
code** (the bytes Signal's own QR holds, drawn as one for their phone's camera), and Verified or Not verified. **Mark
as verified** asks first (only after comparing it with theirs, in person or on a call you trust, or their phone
scanning the code), then sends `POST /api/identities/:id/verify { safetyNumber }`; the adapter refuses if it changed
since. **Clear verification** sends `{ clear: true }`. A number that changed since this device first saw it says
**Changed** with when, and your 1:1 with them gets the line "Your safety number with X has changed." (dither-accounts
docs/signal.md). Signal keeps trusting a changed key, as its apps do; it is just no longer verified.

### Your nickname and note on the network

Signal keeps a private nickname and note for each contact, synced to your phone. Its adapter sends both (capability
`contactNotes`, IdentityFact `nickname` and `note`), and the hub keeps what it last said (`identity.net_nickname`,
`net_note`):
- A nickname from the network becomes yours when you had none, or still had what it said before. When both changed,
  yours stays here and the phone keeps its own. Yours, set or removed here (docs/chats.md "Names"), goes to the network
  (`setContact`).
- A note from the network becomes the person's note when theirs was empty or still what it said before, or when it
  holds all of yours. When both changed and neither holds the other, they are joined (yours, a blank line, the
  network's) and the joined note goes back, so neither side's text is lost. Your note, changed here, goes to each of
  their accounts on a network that keeps notes.
A change while the account is offline is kept here and not sent later: change it again once it is connected.

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
| Matrix | | | where the server keeps them | | has a DM | (hub's own) | | DM partners | matrix.to | time zone (`timeZone`) |
| X | bio | | | from the profile | following, Follows you | (hub's own) | | | website | follower, following and post counts; recent posts |
| Zulip | the first long-text field | custom status (an organization emoji as its picture) | the pronouns field | joined | | the organization, with their role and user groups | | | link and external-account fields | role, profile fields (person fields and a bot's owner linked, dates in words), time zone (`timeZone`) |

**X** also answers with the person's recent posts (`PersonAbout.posts`, up to 20, a pinned one first), shown in a
**Recent posts** card after About; its counts go in About and its following and `followsYou` under the account in Accounts
([feed.md](feed.md#profiles), below). The
people in your X notifications have their profile kept without asking (a `personAbout` event): their page shows it at
once, says it came from your notifications, and still asks X when opened, for their posts.

### Connections

How each of your accounts stands with them, under each of their accounts in Accounts, in **one vocabulary across networks** (2026-11-13, from the owner: "discord
friends and twitter follows should be similar kinds of things"). Code: `packages/web/src/connections.ts` (pure),
`ProfileConnections` in ui/Requests.tsx; the data is the accounts' lists (`ProfileView.links`, docs/add.md
"Relationships") and what each network's profile said (`relationship`, `followsYou`).

| Kind | What it covers | The row says | Ends with |
|---|---|---|---|
| **Friend** | a Discord friend; an X (or Instagram) account you follow and that follows you | Friends on Discord · You follow each other on X | Remove friend · (Unfollow, once X can) |
| **Contact** | in your Telegram, Signal or WhatsApp address book (Google Messages too) | In your Telegram contacts | Remove contact |
| **You follow** | you follow them, they do not follow you | You follow them on X | (Unfollow, once X can) |
| **Follows you** | they follow you, you do not follow them | Follows you on X | nothing |
| **Request sent** | a friend request of yours waiting | Friend request sent on Discord | Cancel request |
| **Blocked** | blocked | Blocked on Discord | Unblock |

- **Each stays per account**: one row per account of yours and account of theirs, with the network's badge, its own
  word for it, which of their accounts (with several) and which of yours ("alice.chen ⇄ main"), and since when where
  the network says. Rows are grouped under the kind, in the order above, each group a list named for its kind. The
  hero has one tag per kind with the networks it is on ("Friend" with Discord and X marks, "Contact" with Telegram,
  Signal and WhatsApp); a screen reader hears what it stands for ("Friend: Friends on Discord; You follow each other
  on X"), the hover shows the same. Two Remove friend buttons (Discord main and alt) are named apart by account.
- **Nothing X cannot do.** Neither X adapter (the extractor nor the demo) can follow or unfollow (no `connect` or
  `disconnect` capability), so an X row has no Unfollow and the hero no Follow or Follow back. They come with those
  capabilities, through the same `connect` and `remove` paths as Discord's (docs/add.md).
- **Changed on the page.** Ending one or making one (Remove friend, Unblock, Add friend, Accept) shows at once and
  stays until the profile is fetched again: Remove friend and then Add friend says Request sent (connections.ts
  `withChanges`).
- **Counts are not connections.** Followers, following and posts are facts about their account: they stay in About.
  Someone asking to be your friend is a request, not yet a connection: the hero says "Wants to be friends" and has
  Accept and Decline.
- **Only what the networks say.** A follow back counts only when the same account of yours follows them and its
  profile of them says `followsYou`. X keeps no list the hub reads, so its follows are as of each account's last
  profile of them (asked, or in your notifications); the network is asked again when the page opens. A profile seen
  in a notification that leaves the follow fields out keeps the account's last known ones; a profile asked for is the
  whole answer, so one without them means no follow. An account that keeps a list (`relationships`) is believed over
  its profiles, so someone dropped from the list is gone even if an older profile said following. Your own identities
  are never a connection (your second X account following your first).
- **The profile says what People says.** `ProfileView.links` carries the same follows from kept profiles as People's
  lists (hub add.ts `profileLinksOf`), per account, so with two X accounts the one that followed them months ago still
  counts though the other asked last.
- **People's lists use the same words.** Friends has Discord friends and the X accounts you follow each other with;
  Contacts the address books; Following everyone you follow. The Friends and Following chips show where an account
  keeps such a list, and for any X or Instagram account that reads profiles. A row says when you last talked, or
  else what the link is ("You follow each other on X"), with the networks' marks when it is on several. The hub adds
  the profile-made follows to `GET /api/people` (`from: 'profile'`, docs/add.md), reading only the kept profiles that
  say following (index `about_following`).

Before 2026-11-13 the right column said **How you stand** in each network's own label (Friend, In your contacts, You
follow them), the hero left out follows and requests (disabled **Following** and **Request sent** buttons said them),
and About had X's **Follows you** tag beside the counts. Three ways were drawn on the demo world (the PR has the
pictures): one Connections card grouped by kind (built); the connection as a chip on each of their account tiles,
with no card (left: your friendship is per account of yours, Discord main and alt, which a tile of theirs cannot
hold, and someone with one account has no tiles); and a table of each network, you to them and them to you (left: the
phone networks have no direction, so half of it is empty, and it reads heavier than the list). Since 2026-11-25 the
card is gone: each connection is a line under the account of theirs it is with, in Accounts, which holds one line per
account of yours.

Checked by `scripts/verify-profile-relationships.ts` against a fresh demo hub, on a desktop and a phone, and by
`packages/web/test/connections.test.ts` and `packages/hub/test/links.test.ts`.

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

The profile's In common rows show it ("≥120 seen; ~1,400 estimated, 900–2,100", rounded to two figures), with the
share, the server's own estimated total and what it rests on in the tooltip.

### Voice

From the voice log (the adversarial "Record who is in voice channels", docs/history.md, docs/calls.md "Voice
channels"): `GET /api/persons/:id/voice` (or `/api/identities/:id/voice`) answers `{voice, identities}`, `voice` a
`PersonVoiceView` (hub voicetime.ts), null while the log is off. A stretch in a channel runs from a join to the person's
next logged move, or to now while they are still in it; one with no end heard is left out, and none counts for more
than 12 hours (a leave missed while the account was away). The card says their minutes this month, in the past 30 days
and since the log first has them; **Usually in voice with**: who was in the same channel at the same time for 5 minutes
or more at once, most minutes first, over the past 90 days (up to 8); and their latest 20 stretches, each with its
channel, its server, how long, and "in it now". A channel opens its page. Hidden when they have no stretch.

### People in common

The friends you share and the people they are most tied to, one row a person (`tiesOf` and `PeopleInCommon` in
ui/VoiceClose.tsx). The ties are the people graph's (docs/people-graph.md "Ties and circles"): replies, reactions, turns
in a small chat, time in voice together and friendships, faded to now with your tuning's fade and voice weight, each
divided by how much both have of it all. `GET /api/persons/:id/close` (or `/api/identities/:id/close`, `?limit=` up to
200, 12 by default; the page asks for 200) answers `{close, identities}`: `CloseView`s, strongest first, each with what
it counted. The friends are each of their profiles' mutual friends, and a tie marked `friends`, which a friend's own
profile naming them gives: friendship counts either way, so someone whose own profile came through one of your
accounts still shows the friends another of your accounts sees them with. Each row says why ("friends" with the
network's badge, "58 replies", "3 h in voice", the turns in its tooltip) and has a bar for how strong the tie is. The
small places two people share, which the graph also counts, are left out. Not on your own page. Before 2026-11-25
these were two cards, Mutual friends and Close to.

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

## Status dots

A small dot on a person's picture says how they are on their networks right now: green online, amber idle, red do not
disturb, a hollow ring offline. No dot: nothing known. Where: DM and group rows in the inbox and the sidebar, people
rows, a DM's header, the profile's picture, member lists on About, and the @ picker. On a row whose picture carries
the network's badge in its bottom corner, the dot sits at the top.

- **One person, one dot.** Their most present account wins (online, then do not disturb, then idle, then offline, as
  the Activity chart merges), and the tooltip names where: "Online on Zulip", "Idle on Discord and Matrix". An account
  not yet joined to a person is its own dot.
- **Groups** show a dot only while someone in them is around (online, busy or idle), the most present of them, and the
  tooltip names up to three ("Around: Bo (online), Ann (idle)"). Offline people are no dot there.
- **Kept always, unlike presence over time.** The hub keeps each identity's latest state whatever the adversarial
  presence switch says (docs/history.md): it is what the network's own app shows. It is in memory and in
  `presence_now`, so a restart keeps it (adapters tell a state once, when it changes).
- **Unknown rather than stale.** A state is hidden (sent as unknown) while no account that heard it is online
  (offline, connecting, needing attention, error, disabled, or the hub cut off from dither-accounts), and shows again
  when one is back: adapters tell only changes, so what one told is still its word then, and anything newer comes as a
  change. It goes with the last account that heard it, and when it has not been heard for three days (online, idle,
  busy) or a week (offline). The hub keeps it only for people it already knows: presence makes no identity.
- **Cheap on a big server.** Presence goes to the page in the bootstrap and as `presence` frames on the live socket, at
  most one every two seconds, each identity once at its newest (hub presence.ts); the journal keeps it by identity
  (docs/sync.md). On the page it moves `presenceRev` only (versions.ts), so a change draws again the dots it changed and
  not the rows or lists they sit in; a row drawn again for something else leaves its dot alone (`memoOn`, docs/perf.md). The offline snapshot keeps it too.
- **Which networks say it** (`{t:'presence'}` in packages/protocol adapter.ts, from dither-accounts' extractors):
  Discord (friends and people with a DM, with devices), Matrix (people with a direct chat, `m.presence`), Zulip
  (everyone in the organization, read once a minute as Zulip's apps do), and Telegram (contacts and people with a
  DM, from the status updates Telegram pushes to every client anyway). Signal, WhatsApp, Google Messages, X and the
  Meta apps say none. WhatsApp could, but only by subscribing to each person, which its own app does only for the chat
  on screen: left out on purpose. Slack has no account kind here yet.

Code: hub `presence.ts`; web `presence.ts` (which dot), `ui/PresenceDot.tsx` (drawing it). Tests:
`packages/hub/test/presence.test.ts`, `packages/web/test/presence.test.ts`, and `scripts/verify-presence.ts`
(a demo hub in headless Chromium: dots on each place, both themes).

## A place

Left: **About** (the description, editable where you may; facts the network adds), **Settings** (each with its
control or a lock and the reason), **Pinned** (hidden when there is nothing and you cannot pin), **Channels** for a
server (the most active twelve), **Members** by role.

Right: **Seen as** (when several of your accounts are there: each may see and change different things),
**Notifications** (the place's rule: Automatic, Always alert, List only or Mute, and under Automatic what holds here
and from where; [notifications.md](notifications.md#rules)), **Secure session** (a Signal 1:1: Reset secure session, for
messages from them that could not be decrypted; it asks first, since they see it: [messages.md](messages.md)),
**Blocking** for a Signal group (Block group asks first, then `POST /api/conversations/:id/block`; About.blocked says
it is), **Invite link**, **Who can do what**, **Details** (your role, the account it is seen as, the native id to copy,
when the network last said).

Everything that changes something goes through the same checks as before (docs/group-settings.md): the network's
rules, then a fresh About through the account whose view it is.
