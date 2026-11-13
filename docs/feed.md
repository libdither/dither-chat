# The feed: a network's notifications about you

X tells you who liked, reposted, replied to or quoted your posts, mentioned you and followed you. dither-chat shows
that as **a thread of its own, like Requests**: a row at the top of the inbox and a page of cards. Everyone in it
becomes a person on the hub with their profile logged, and an X profile shows the person's recent posts.

Only X has a feed so far. The shapes are not X's own, so another network's notifications could arrive the same way.

Code: `packages/protocol/src/feed.ts` (the shapes), `packages/hub/src/feed.ts` (what makes a feed, its refusals, its
messages' `feed` for the page), `people.ts` (`keepAbout`: unasked profiles), `triage.ts` (its notifications),
`demo-x.ts` (the demo's X account); `packages/web/src/feed.ts` (cards and the row's words, pure), `ui/FeedRow.tsx`
(the row), `ui/feed/` (the page and a profile's posts, a lazy chunk). The X extractor is in dither-accounts.

## What the network sends

- **One conversation per account**: `{ nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications' }`,
  in no space. Variant `feed` is the only variant that changes routing (ontology.ts).
- **One message per person per thing they did.** Three people liking a post are three messages, each written by the
  one who did it. Each person's profile and history then hold what they did. Ids by type: `like:<post>:<user>`,
  `repost:<post>:<user>`, `follow:<user>`, `reply:<their post>`, `mention:<their post>`, `quote:<their post>`,
  `other:<notification id>:<user or ->`. Like, repost, follow and other are kind `system` with a short body ("liked
  your post"). Reply, mention and quote are kind `text` with their post's words. The meaning is in `extra.feed`
  (`FeedItem`): the type, your post (`post`), their post (`theirs`), X's link, and X's own sentence for `other`.
  Posts are `PostFact`s: id, link, time, author (a native identity id), text, what it answers, reposts or quotes,
  counts, pictures.
- **Identity facts first**, for everyone in a notification and every post's author.
- **`personAbout` events**: X's notification shows each person's profile, so the extractor passes it on
  (`{ t: 'personAbout', who, about, ts }`) with no posts.
- **`PersonAbout.posts`, `counts` and `followsYou`** in answers to `profile` (capability `profile`): up to 20 recent
  posts, a pinned one first.

## The hub

**Read-only.** Nothing is sent to the network for a feed. A message, a reaction, an edit or a change of its settings
is refused with "X's notifications are read-only here: answer on X" (409), which is also what the composer and a
push's reply button would say. Forwarding to it is refused the same way. The reaction picker is told it cannot react,
and the network is not asked. Typing there goes nowhere. Reading it, from the page or Mark all read, marks it read on
the hub only: no `markRead` reaches the network, as with an unaccepted message request (docs/add.md). Fetching
X's notifications never marks them seen on X either. That is the extractor's rule.

**Its messages carry what they did.** `MessageView.feed` is the `FeedItem` with post authors as hub identity ids and
pictures as the hub's signed media paths. It goes wherever a message view goes: the live socket, a page of history,
a sync, backfill. A message sent again without `extra` keeps the one it had. A reply edited on X is an edit like any
other. A system line worded anew is not.

**Everyone in it is a person** (`store.ts` `message`): the author of a feed message who is not you gets a person the
first time, as the other side of a DM does. They have no DM, so they are not in People's lists. They show up where
the app looks people up by name (New, merging), and their profiles open from the cards. Someone seen only in a
channel still gets a person only when you first do something on their profile.

**What X showed is kept as their profile.** A `personAbout` is stored in the `about` table as an answer to `profile`
would be (`people.ts` `keepAbout`), unless an answer newer than its `ts` is held. Bio, pronouns and banner changes go
into their History as an asked profile's do. It never holds posts, so it keeps the posts of the last asked answer
and is marked `unasked`. Opening the profile then still asks X, even within the ten minutes in which an asked
answer counts as fresh. A profile kept that way says so in About: "As X showed them in your notifications."

**Out of the inbox's ranking.** Attention never scores a feed (`attention.ts`): it has its own row. The page leaves it
out of the ranked rows and of every unread total, the app badge and the Home tab included, as it does a message
request.

## Notifications

Feed messages go through triage like any message (`triage.ts`), with rules of their own:

| | Decision | Why |
| --- | --- | --- |
| like, repost, follow, other | **silent**: nothing anywhere | Never worth a sound or a row on a phone. They wait in the feed |
| reply, mention, quote | **at most a silent row on the List** (`digest`, or `drop` below your level) | Kept to the list as a List-only rule keeps a place: never a Conversation, never an alert, and the local model is not asked |

A reply, mention or quote starts at the importance of something the network notified you about (0.8). That is on
the list at the default level of 0.6, a silent row in the phone's bundle and nothing on a computer. Your marks move
it as they move anything ("Less like this" takes it below the list).

**Why not more.** The three tiers ([notifications.md](notifications.md)) keep Alert for what cannot wait an hour or
two, and Conversation for people talking with you where you answer them. A public reply to your post is someone
talking with you, but not in a place you answer from here: answering happens on X, and nothing in a public reply
needs you within the hour that would not also reach you as a DM. A Conversation row would sit in Android's
Conversations section with a Reply button that cannot work. Likes and follows are counts, not messages: on a post
that does well they come by the hundred. So likes are silent, and a reply is at most what the List is for:
"important enough for a ranked list on the phone".

**Rules.** A person set to Always alert, a keyword, or Always alert on the feed itself does not make a feed message an
alert. Muting the feed (or the account, or X) silences replies too. List only changes nothing, since it is that
already.

## The inbox row

Under Requests, one row per feed, while it has something unread or something from the last day (`feedRow`, RECENT):

- the network's badge and "X notifications", with how many are new (unread on the hub) in an accent count;
- up to four faces of who did the new things, newest first;
- what the newest card says, "Cam replied to your post, and 2 more"; before the feed's page is held, the last message;
- when the newest came.

Its words come from the feed's newest page, fetched as a glance (what the hub stored, without asking X) when the row
shows with something unread. It counts on no badge. Opening it is the feed's page (`#/inbox/c/<feed>`). On a
desktop that is the main pane beside the inbox, and on a phone a full-screen page with Back.

## The feed's page

The conversation's header (search, mute, About), then cards, newest first, and no composer:

- **A card is one thing that happened.** The same type on the same post, one after another, is one card: "Theo, Maya
  K. and 3 others liked your post", with their pictures in a row (up to eight, then +N). Each picture and name opens
  their profile. Up to three people are named; more are two names and "N others", with the rest in the tooltip. Likes,
  reposts and follows group (follows need no post). Something else in between splits a group, as X's own list does.
- **Your post quoted under it**: who and when, its text clipped to three lines, its first picture as a thumbnail, each
  linking to the post on x.com.
- **A reply, mention or quote** is a card of its own: their picture with a small badge of what it is, name, handle
  and time; "replied to your post: “…”" with your post clipped and linked; their words with links; their pictures (up
  to four); for a quote, your post quoted under it; and Open on X.
- **What was new when it opened** is marked with a coloured edge, and stays marked while the page is open. The page
  marks the feed read on the hub as it shows.
- **The bar** in place of the composer: "Replies, likes and follows happen on X." and **Open on X**
  (x.com/notifications).

Older pages load as it scrolls. Likes are pink, reposts green, the rest the accent. Dark and light come from the theme.

## Profiles

- **Recent posts** (X): a card from `PersonAboutView.posts`, after About. A pinned post first with "Pinned", a repost
  under "<name> reposted", a reply under "Replying to @handle", a quote with the quoted post inside. Each has its words
  with links, pictures, counts (replies, reposts, likes, views), time, and Open to x.com. Someone with several X
  accounts has each account's under its handle.
- **About** gains followers, following and posts counts and a **Follows you** tag.
- **Feed actors' profiles** show what the hub logged (bio, counts, links, Follows you) at once, without asking.
  Asking X then brings their posts. Their feed items are in **Recent messages** ("X notifications", "Liked your post:
  “…”") and open the feed. The feed is not listed in **In common**.

## The demo world

The demo hub has an X account (`demo-x.ts`, made up throughout) with a feed. Five likes on one post, a repost of it,
a reply, a quote, a mention, two follows and two likes on another post. The newest four arrive live on the first run,
so triage decides them. `personAbout` for everyone in it, and profiles with posts (pinned, a repost, a reply, a
quote, pictures). Its markRead, typing and send are logged (actions `readLog`, `typingLog`, `sendLog`) so a script
can see the hub sent none. scripts/perf-world.ts leaves it out (`createDemoAccounts(store, { x: false })`): the perf
baselines predate it.

## Checked by

- `packages/hub/test/feed.test.ts`: messages carry `feed` with hub ids, it survives a resend and an edit, actors are
  persons, `personAbout` kept unless older and logged in History, the profile still asks X after an unasked one and
  keeps the posts after, likes silent and replies on the list even from someone set to Always alert, a muted feed
  silent, and the hub refusing a send, a reaction, an edit and settings, keeping reads and typing from X.
- `packages/web/test/feed.test.ts`: grouping into cards, names as X says them, what is new, the row's words.
- `scripts/verify-x-feed.ts`: against a fresh demo hub in a real browser, on a desktop and a phone, dark and light,
  with screenshots (`--shots <dir>`). It checks the row, the cards, the bar, nothing sent to X, a profile's posts,
  counts and Follows you, and the decisions.

Not run against a real X account.
