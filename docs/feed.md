# The feed: a network's notifications about you

X tells you who liked, reposted, replied to or quoted your posts, mentioned you and followed you. dither-chat shows
that on **the Feed page** (the rail's Feed button), as its Activity, apart from conversations: a page of cards, one
per post of yours. Everyone in it becomes a person on the hub with their profile logged, and an X profile shows the
person's recent posts. The same page puts your accounts' home timelines together in feeds of your own, in an order you
swap at will, and posts as several accounts at once.

Only X has a feed so far. The shapes are not X's own, so another network's notifications could arrive the same way.

Code: `packages/protocol/src/feed.ts` (the shapes), `packages/hub/src/feed.ts` (what makes a feed, its refusals, its
messages' `feed` for the page), `people.ts` (`keepAbout`: unasked profiles), `triage.ts` (its notifications),
`timelines.ts` (home timelines, your feeds, posting to several accounts, drafts), `demo-x.ts` (the demo's two X
accounts); `packages/protocol/src/mix.ts` (a feed's orders, pure);
`packages/web/src/feed.ts` (units by post, pure), `ui/feed/` (the Feed page, threads and a profile's posts, a lazy
chunk; `FeedPage.tsx` the page, `Units.tsx` the notification cards, `Post.tsx` a post). The X extractor is in
dither-accounts.

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

## The Feed page

Posts live on a page of their own, opened by the rail's **Feed** button (on a phone, the Feed tab), shown once an
account has posts (X) or notifications. The inbox has no row for them any more: a link to a notifications
conversation (`#/inbox/c/<feed>`, an old notification's) opens that account's Activity here.

**On a computer**, the list on the left: **Feeds** (Following, Discover, any you made, each with its order, and
**New feed**), then **Yours** (Activity, Your posts, Drafts). The open feed's head has its order (a menu) and
**Tune**; a post's thread or the feed's tuning opens beside the posts.

**On a phone** (the Feed tab):

- the head: **Feed**, the **bell** (Activity, with how many new) and **⋯** (Your posts, Drafts, Tune, New feed);
- the feeds as **tabs** across the top (Following, Discover, yours, then **+** for a new one), the open one marked by
  a bar under its name;
- under them, the feed's **order** (a sheet to swap it), when it was read, and **Tune** (a tall sheet);
- the posts, and the **pencil button** at the bottom right: the composer in a sheet, Post at its top right;
- Activity, Your posts and Drafts are pages with Back; a post's thread takes the list's place.

| Source | Route | What it shows |
| --- | --- | --- |
| Following | `#/feed/following` | a feed: every account's Following, newest first; a post two accounts follow once |
| Discover | `#/feed/discover` | a feed: every account's For you, taking turns, each with its reason ("Alice Chen liked") |
| a feed you made | `#/feed/m-<id>` | the timelines you chose, in the order you chose |
| Activity | `#/feed/activity` | every account's notifications, by post ([The feed's page](#the-feeds-page)); a filter picks one account (`#/feed/<account>:activity`) |
| Your posts | `#/feed/mine` | what your accounts posted, newest first; posts made in one press as one entry with "Also posted as"; a filter picks one account (`:mine`) |
| Drafts | `#/feed/drafts` | posts kept for later and scheduled ones, with when and as whom |
| one timeline alone | `#/feed/<account>:following`, `:foryou` | an account's own Following or For you, in its order (from Tune, a timeline's name) |

`#/feed/home`, Home's old route, is Following.

A post opens its thread ([Threads](#threads)) beside the list on a wide screen and in its place on a narrow one
(`#/feed/<source>/p/<post key>`); Back closes it.

### Feeds

A feed is home timelines from any of your accounts (and, later, any network) in one list. Each timeline in it has a
**share**: Off, Less, Even, More or Most (weights 0, ½, 1, 2, 4). A post two timelines show is in it once, its card
saying which timeline it came through ("@you · For you (+1)") when the feed takes more than one, and acting as that
timeline's account. Following and Discover are always there; **New feed** makes another (every Following, taking
turns, named "New feed" for you to change); you can change any of them, delete yours, and put Following or Discover
back as they were.

**The order** is swapped from the feed's head (a sheet on a phone) or in Tune, and shows at once: the same posts the
hub holds, put in the new order, nothing asked of the networks.

| Order | How it puts the posts |
| --- | --- |
| Newest first | every timeline that is on, by when each was posted (a repost, when it was reposted); shares do not count |
| Taking turns | the timelines take turns, each in its own order (a For you as the network ranks it); a share twice another's gets twice the places (smooth weighted turns), however busy each is |
| Most liked | likes, plus reposts, replies and quotes counted twice, against age as Hacker News ranks (`(n + 1) / (hours + 2)^1.5`), times the share |
| Spread out | newest first, each person's second post three hours further down, their third six, so no one fills the list |

Newest first and Taking turns stop where a timeline that has more at the network runs out of what the hub holds:
what comes after waits for its next page, so a post is never placed above one it should follow. Scrolling on reads
it, and the list goes on.

**Tune** holds the feed's name, its order, and a row per timeline (its account, which timeline, its share as a slider,
and what part of the posts showing now came from it, with a bar of the same). A timeline's name opens it alone.

**Reading.** A timeline is read only when it is looked at: opening a feed shows what the hub holds at once, then
asks the networks for its timelines not read in the last minute (as a person opening their Home tab would), and
**Read again** in the header asks now. Scrolling past the end brings the hub's older entries, then the networks' next
pages (their Bottom cursors). Nothing is marked seen on the network. Each post read is logged as a message in the account's
quiet posts conversation, as a thread's are; `feed_item` keeps which timeline showed it, where, and why.

**Cards.** A post as a thread draws it: who, when, the words, pictures, the post it quotes, and its bar (reply,
repost or quote, like, views). Over it, why it is there (For you's reason) and, in a feed of several timelines, which
it came through, with that timeline's colour from Tune. A conversation X shows with it (a reply and the post above) is joined by a line. **Likes,
reposts and replies go as the account whose timeline showed it**: a post only your work account follows is liked
as that account. A post of yours has **⋯ → Delete…**, asked again ("Delete it from X"), then gone from the network
and from every source; when it was posted to several accounts, the next copy takes its place.

**The composer**, on top of a feed and Your posts on a computer; on a phone, in a sheet from the pencil button:

- **Post as**: the picture of each account that can post, pressed in (ringed and ticked) or out (faded), one or
  several at once, and "Posting as @you and @work" beside them. It starts on the accounts last posted as (on one
  timeline alone, its account). "Post to 2" says how many.
- One text for all of them, or **Write each apart**: a box per account, each counted against its network.
- The counter as X counts ([The composer, as X counts](#the-composer-as-x-counts)). **Too long for one post**, it
  posts as a thread (`splitThread`: paragraphs kept whole, short ones sharing a post, a long one cut between
  sentences), saying "Posts as a thread: 3 posts on @you", or **Keep it one post**.
- **Who can reply** (X: everyone, accounts you follow, only accounts you mention, verified accounts), set on the
  first post.
- **Pictures or a video** (X: four pictures or one video), sent to the hub as they are added, a thumbnail each.
- **Save** keeps it in Drafts; the clock **schedules** it (a date and time), and the hub posts it then, each account
  once. A scheduled post whose account is not connected waits, and after 30 minutes is held in Drafts as failed,
  saying why. Pictures are not kept with drafts yet.
- **Post**: every account at once. One that fails says why under the box, with **Post again where it failed**
  (only those); "it may have posted" when no answer came. Each press has a key: pressed twice, posted once.

**Hub.** `GET /api/feed/sources` (accounts and what each can do: `home`, `publish`, `postMedia`, `unpublish`, its
notifications conversation; your feeds; the drafts count); `PUT /api/feed/mixes/:id { name?, order?, sources? }` (a
feed changed, or made), `DELETE /api/feed/mixes/:id`; `GET /api/feed/entries?source=…[&before=…]` (what the hub
holds, in the source's order; for a feed or a timeline `before` is how many came before, and `next` says where the
page after starts once older posts were read);
`POST /api/feed/read { source, older? }` (ask the networks, then the same); `POST /api/feed/publish { key,
destinations: [{ accountId, text, parts? }], media?, replies? }`; `POST /api/posts/:network/:post/delete { account? }`;
`GET /api/feed/drafts`, `PUT|DELETE /api/feed/drafts/:id`. Tables, made by `timelines.ts`: `feed_item`, `feed_read`
(cursors and when), `feed_mix` (your feeds: name, order, each timeline's share), `post_group` (posts made in one
press), `post_draft`.

**Adapters.** Capability `home` and the `home` command (`{ feed: 'following' | 'foryou', cursor?, count? }` →
`HomePage`: items with their reason and the posts above, the Bottom and Top cursors), `unpublish` (`{ post }`), and
`postMedia` (`publish` with `media`, uploads as attachments); `publish` takes `replies`.

### One card for every network

A post card draws whatever a `PostFact` carries, so a network that brings these needs no card of its own: `title`
(Reddit, Lemmy, Hacker News, a forum), shown over the words; `warning` (Mastodon's content warning, a spoiler), the
words and pictures folded behind it until **Show**; `place` (a subreddit, a community, a channel), "in r/rust" over
it; `replies`, who may reply. The composer reads the network's rules (`compose.ts`: limit, how it counts, pictures,
reply gates, a title). Only X brings posts so far.

## The feed's page

The Feed page's Activity (every account's, or one's), then the feed **by post**, newest activity first, and no
composer: a card opens the post's thread, where you can answer.
It was a list of notifications, one card per thing that happened ("Theo, Maya K. and 3 others liked your post");
drawn by post, it reads as what it is: your posts and what came of them.

- **One card per post of yours** that something happened to (feed.ts `feedUnits`). At its head your post, small,
  since you know it: "Your post", when, its words clipped to three lines, its first picture as a thumbnail; it opens
  the post's thread. Under it, **what people said, in full**: each reply and quote as a post (picture, name, handle,
  time, words with links, pictures, counts), newest first, joined by a line on the left, "new" on what came after
  you last read, "quoted" on a quote. Three show, then "N more". **The thread: N replies** opens the whole thread.
- **Likes and reposts are one quiet line** at the card's foot: the counts as X gives them (a heart 41, a repost
  3; the faces named when X gave no count), "Liked by Theo, Maya K. and 3 others" and up to four faces. It opens
  **who reacted**: Likes and Reposts, each person with their picture, name, handle and when, opening their profile.
  The list comes from the hub (`GET /api/posts/:network/:post/activity`, every feed message about the post in any
  account's feed, nothing asked of the network), so it is whole whatever pages of the feed the page holds. X names
  only some of the people who liked a post in its notifications, so when it counts more the list says so: "X counts
  41; your notifications named these 5."
- **A mention**, or a reply the feed carries no post of yours for, is their post on its own card under "mentioned
  you" ("replied to you", "quoted you").
- **Follows** one after another are one slim row: their faces (each opening their profile), "Sam and Lee followed
  you", when. Anything else X notifies about is a slim row in X's words.

- **What was new when it opened** is marked with a coloured edge, and stays marked while the page is open. The page
  marks the feed read on the hub as it shows.
- **The bar**, on the notifications conversation's own page: "Replies, likes and follows happen on X." and **Open on
  X** (x.com/notifications).

Older pages load as it scrolls; a post's card gathers what an older page adds to it. Dark and light come from the
theme.

**Why by post.** The notifications list said the same post again on every card about it, and gave likes, which come
by the dozen and ask nothing of you, as much room as a reply. By post, the post shows once, what people said is what
the card is about, and likes are a number with names behind it. Four layouts were drawn before this one (the PR has
them): replies first with likes folded into lines; by post with mentions and followers in sections after; tabs as
on X's own page; mentions in a section first and the like list open in place. By post, in one stream ordered by
activity, kept the most context for the least reading. A "Replies and mentions" filter came with it at first and
went: with likes already one line per post, everything is barely longer than talk alone.

### A feed of posts, for any network

Nothing in the page is X's. A unit is **a post and what came of it**: the post, what people said under it (posts
that answer it), and who reacted and how (identity ids by kind, with the network's own counts). That is also:

| | The post | What people said | Who reacted |
| --- | --- | --- | --- |
| X | your post | replies, quotes | likes, reposts (named in notifications) |
| Mastodon | your toot | replies, quote posts | favourites, boosts (named) |
| Reddit | your post or comment | comments, as a tree | score only (no names) |
| YouTube | your video or comment | comments, one level of replies | likes, a count only |
| Discourse | your topic or post | replies | likes (named) |

The pieces are shared: `ui/feed/Post.tsx` draws a post the same in a thread, under your post in the feed, in the
posts the hub logged and on a profile (`Row`, `Pics`, `Counts`, `QuotedIn`); `feed.ts` `feedUnits` makes the units
from a feed's messages, whatever network sent them; `PostThread` is a post's comment section. A network that names
no one who reacted shows the count alone: the line opens no list.

## Profiles

- **Recent posts** (X): a card from `PersonAboutView.posts`, after About, each post drawn as a thread draws it
  (`Post.tsx` `Row`), opening its thread. A pinned post first with "Pinned", a repost under "<name> reposted", a reply
  under "Replying to @handle", a quote with the quoted post inside. Each has its words with links, pictures, counts
  (replies, reposts, likes, views) and time. Someone with several X
  accounts has each account's under its handle.
- **About** gains followers, following and posts counts, as facts about the account. Whether you follow them and they
  follow you is a connection, in the hero's tags and **Connections** in the same words as a Discord friend or a
  contact: following each other is **Friend**, else **You follow** or **Follows you**
  ([profile.md](profile.md#connections)). X cannot follow or unfollow from here yet, so there is no Follow back. Until 2026-11-13 About carried a **Follows you** tag.
- **Feed actors' profiles** show what the hub logged (bio, counts, links, how you follow each other) at once, without
  asking.
  Asking X then brings their posts. Their feed items are in **Recent messages** ("X notifications", "Liked your post:
  “…”") and open the feed. The feed is not listed in **In common**.

## Threads

**Any post opens in the app.** Your post at the head of a card in the feed, a reply or mention in it, a profile's recent
post, a post quoted in another, a reply in a thread: each opens that post's thread beside the inbox, where a
conversation would open (`#/inbox/c/pst_<network>_<post id>`, feed.ts `postKey`), full screen with Back on a phone.
Links, @handles, pictures, names and Open on X inside a card keep doing what they do.

**The page** (`ui/feed/Thread.tsx`, in the feed's chunk): what the post answers, oldest first, each joined to the next
by a line from its picture; the post itself, large, with its full time, its counts and Open on X; then **Replies** as a
comment section; **Show more replies** while X has more. The header says whose post it is.

**Read ahead.** A reply's hidden answers ("N more replies") are read as they come within about two screens, two at a
time and at most 24 per thread opened (each is one TweetDetail read, about 7 s on X), and the next page of replies as
the end of the list nears, up to eight pages. What is read waits behind its button, so nothing moves in under the
reader, and the button says so by a dot: hollow not read yet, pulsing being read, filled read already (a press shows it
at once, and a page says how many it holds: "Show 7 more replies"). A press on one not read yet reads it then; one
being read shows it as it comes. A branch where X has nothing it shows goes quiet.

**Translated.** A post in another language (X's `lang`) is translated by itself, under the original or in its place:
docs/translate.md.

**Back from a sub-thread.** A thread opened from inside another (a reply's time, Continue this thread, a post above
the post, a toast's View) remembers the one it was opened from: a line under the header says where Back goes ("Back
to Maya's post"), and so does the header's Back. Back brings that thread as it was left, with nothing read again: its
branches, folds and what you did, scrolled where it was, the reply you went into lit for a moment. Each step back
goes one thread up; opening a thread from anywhere else (the feed, a profile, a search) starts afresh. These are steps
back through history, so the phone's back button, the swipe and the header's Back all agree, and a post's thread
opened from the feed, a profile or search results goes back there rather than to the inbox (docs/phone.md "Back").

**Replies as a tree** (`ui/feed/tree.ts`, `Comments.tsx`). Every post known under the post goes under the one it
answers: X's chains (a reply and the first answers under it), the branches the hub logged before (`logged`, below),
and the branches opened since. Siblings keep the order they first came in, X's order: the author's own continuation
first, then what X ranks highest. Where X counts more replies under a post than are known, **N more replies** reads
that post's thread and puts its replies in place, as Reddit's "load more comments". Four ways to draw it, chosen in a
quiet menu beside Replies ("Tree ▾", each with what it is like) and kept on the device:

- **Tree** (the default, as Reddit, with LessWrong's thin lines): each reply's picture (small, by the name), name, OP
  on the post's author, time (which opens the reply as a thread of its own), words, pictures and likes; under it its
  replies, a short step in, with a hairline down its left that **folds the branch** when clicked ("Alice Chen · 8
  more replies", Show to unfold). **A reply with one answer goes on in its column** (a run, `tree.ts` `runOf`): a
  back-and-forth reads down the page, joined by a line, instead of stepping right each turn, and only a reply with
  two answers or more indents. A run longer than eight shows its first three and last two, the rest behind "5 more
  between Theo and You" (`runPair`, when two people take turns). Six levels in, **Continue this thread** opens the
  branch as a thread, what it answers above it.
- **Compact** (as Hacker News): the same tree and runs without pictures or counts, [–] and [+] to fold.
- **Flat** (as YouTube and Discourse): each reply to the post, then everything under it one level in, oldest first,
  each saying whom it answers ("to @ravi_routes"), folded with Hide replies.
- **Chains** (as X): each branch as a chain joined by its pictures, a branch's other answers as chains after it.

A network that gives its comments as a tree (Reddit, Mastodon) gives the same tree; a network with one level of
replies (YouTube) is the Flat style already.

**Where it comes from.** `GET /api/posts/:network/:post/thread[?cursor=]` (posts.ts): the hub asks an X account that
can (capability `posts`, the `post` command, `PostThread`: `focal`, `ancestors`, `replies` as chains, `more`), the way
X's own post page asks (TweetDetail). Nothing else is sent: nothing liked, viewed or marked. Two devices opening the
same thread ask once, and a thread read in the last two minutes is answered from that read (back and forth between a
post and its replies asks X once; the view is made again from that read, so what was logged since comes with it).
The hub waits up to 150 s: the extractor paces its reads. A page of more replies that brings none, or the same cursor
back, ends Show more. With the thread come **the posts logged under it before** that X did not show this time
(`logged`: any depth to 10, any account, at most 500, through `message_post_reply`), so a branch opened once stays
in the tree. No account connected, or X failing: the thread comes back from what the hub logged, saying why
(`stored`): what it answers, back through the posts logged, and the replies logged under it (the author's first),
with no Show more.

## Answering

Posts are no longer only read: under every post in a thread (the post large, each reply in every style) is **the
bar X has**: Reply, Repost, Like, and the views X counts. Code: `protocol/src/compose.ts` (the rules), `hub/src/posts.ts`
(`act`, `publish`, `reactors`), `hub/src/reactors.ts` (the ranking), `web/src/ui/feed/Actions.tsx` and `Composer.tsx`.

- **Like and Repost are one press each** (`POST /api/posts/:network/:id/act`, `{ act: 'like' | 'unlike' | 'repost' |
  'unrepost' }`, the `postAct` command, capability `postActions`). They show at once, filled pink or green, the count
  one more; if the network says no they go back, with a toast saying why. The logged post follows: `extra.post.viewer`
  says what you did, its count changes by one only when the state does (pressing Like on a liked post counts nothing).
  Repost asks first, as X does: **Repost** (or Undo repost) or **Quote**.
- **Reply and Quote open a composer** where you are: under the post a thread is about there is always a one-line "Post
  your reply" box (X's), and Reply under any reply opens one under it, focused, "Replying to @handle". Quote opens one
  with the post quoted under it. What you post goes first in the tree, marked OP, and a toast offers View.
  `POST /api/posts/:network/publish` (`{ text, replyTo?, quote?, key }`, the `publish` command, capability `publish`)
  checks the text with the same count the page shows, and posts once per `key` (a composer's own id): a double press or
  a retried request within ten minutes is answered with the first post. Too long or empty is refused (422) before
  anything is sent.
- **Nothing is sent but the press.** No like, view or read is sent on its own; reading a thread still tells X nothing.

### The composer, as X counts

The rules are data (`POST_RULES`), one composer draws them all:

| | X | Reddit (for when a Reddit account comes) |
| --- | --- | --- |
| Limit | 280, weighted | 10,000 characters |
| Counting | twitter-text v3: Latin, Greek, Cyrillic and common punctuation one, other characters (CJK) two, each emoji two (a ZWJ family, a flag: one emoji), every link 23 however long | graphemes |
| Counter | a ring that fills; from 20 left it grows and shows the number (yellow), at the limit red, past it a negative count in red, and the ring goes past -10 | "1,204 left" from 1,000 left |
| Past the limit | what is too much marked red in the text itself; Post greyed | the same |
| Words | Post, Reply, Quote; "Post your reply" | Comment; "Add a comment"; Markdown |
| Likers | only the author sees who liked (X since 2024) | nobody: a score only |

Ctrl/Cmd+Enter posts, Escape closes; what you write is kept on the device per post answered until it is posted.

### Who reacted

**Hover the Like or Repost button for a moment** (a long press on a phone, as Discord shows who reacted; a sheet
from the bottom) and a list shows who did it, **most relevant first**, each opening their profile. The feed's
reactions line opens the same list. `GET /api/posts/:network/:id/reactors?kind=like|repost[&cursor=]`:

- **From X when it can be asked** (the `postReactors` command, capability `postReactors`; X's own "Liked by", asked
  with its ranking on). X names who liked a post only to its author, so likers show only on your posts; who reposted
  shows on any. Without X, the people your notifications named, saying so.
- **Ranked for you** (`reactors.ts`), each part 0 to 1: how much you talk with their person in direct chats over half
  a year (0.32), how often they react to your posts (0.18), whether you follow each other (0.20), how many follow them
  (0.22, a million is full) and X's own order (0.08). Each says why: "You talk often", "You follow each other",
  "Reacted to your posts 3 times", "184K followers".

### Posts are logged as messages

Every post the hub reads, in a thread or a profile's recent posts (and a repost's original or a quoted post inside
one), is kept as a **message**: one conversation per X account, `posts:<your id>`, variant **`posts`**, named "X
posts". The message's id is `post:<post id>`, its author the post's author, its body the post's words, its reply the
post it answers, its pictures attachments (each an image; a video's is its poster), and `extra.post` the post as X
showed it last (its counts change at every read). A post read again is the same message: its words and counts
updated, nothing doubled; a post already logged through another account stays where it is. A copy seen inside another
post (quoted, or a repost's original) only logs a post the hub does not have: X clips a quoted post and stops nesting
two deep, so such a copy never replaces the post as logged nor counts as an edit. The thread read back from what was
logged follows `reply_to_id` across every account's posts (index `message_post_reply`).

**Why messages, not a store of their own.** Mail has its own tables (`mail_*`, its own `mail_fts` and search,
docs/mail-design.md) because a mail is not a chat message: subjects, folders and labels, threads by headers, bodies of
megabytes, a server to keep in step with. A post is a short text by an identity, answering another post, with
pictures: what a message already is. As a message it gets, with no code of its own: search (full text,
`from:`, `has:image`, `network:x`, misspellings, `in:"X posts"`); the person's Recent messages, activity and message
counts; the history of an edit; the media archive keeping its pictures; sync to devices; and the thread read back
when X cannot be asked, through `reply_to_id`. What a post has that a message lacks (counts, the quoted post, the
thread's first post as `root`) rides in `extra.post`, as the feed's `FeedItem` does in `extra.feed`.

**Quiet, as the feed is.** The posts conversation is read-only (a message, reaction, edit or setting is refused:
"X's posts are read-only here", feed.ts `feedRefusalFor`), never unread (store.ts skips its unread count), never
triaged (logged as backfill, not live), out of the inbox's rows, every unread total (web `isQuietConv`), attention's
scores and a profile's In common, and the forward picker. Nothing learns from it, as from a feed (feed.ts
`QUIET_VARIANTS`): it is not embedded, not a place where you owe answers, not in the interaction fold, the inbox's
rank history or its refolds. The hub never asks the network for its history (or a feed's): there is no such chat on
X. Everyone in a thread is an identity, not a person: no person is made for them, as
one is for someone in your notifications. Opening the conversation lists what was logged, newest first; a message
of it (a search hit, Recent messages) opens its thread (`GET /api/messages/:id/thread`).

## The demo world

The demo hub has two X accounts (`demo-x.ts`, made up throughout): yours and a work account, each with a feed and
home timelines (Following two pages, For you with reasons, a post both follow, a reply with the post above; the work
account's own). Posts made there show on Following; `homeLog` lists what was read. Five likes on one post, a repost of it,
a reply, a quote, a mention, two follows and two likes on another post. The newest four arrive live on the first run,
so triage decides them. `personAbout` for everyone in it, and profiles with posts (pinned, a repost, a reply, a
quote, pictures). Your routing post has a thread: you continuing it, Ravi and you going back and forth, two more
replies and two on a second page (cursor `more-1`); any other post it knows opens with what it answers. Two bios have
links. Its markRead, typing and send are logged (actions `readLog`, `typingLog`, `sendLog`), and the threads asked
for (`postLog`), so a script can see the hub sent nothing else. scripts/perf-world.ts leaves it out (`createDemoAccounts(store, { x: false })`): the perf
baselines predate it.

## Checked by

- `packages/hub/test/feed.test.ts`: messages carry `feed` with hub ids, it survives a resend and an edit, actors are
  persons, `personAbout` kept unless older and logged in History, the profile still asks X after an unasked one and
  keeps the posts after, likes silent and replies on the list even from someone set to Always alert, a muted feed
  silent, and the hub refusing a send, a reaction, an edit and settings, keeping reads and typing from X.
- `packages/web/test/feed.test.ts`: units by post (likes, reposts, replies and quotes on one post as one, by its
  newest activity), mentions and follows on their own, what is new, the reactions line's words
  and counts; cards, names as X says them.
- `packages/hub/test/posts.test.ts`: a thread read in hub ids with the author's chain first, each post logged once as
  a quiet message (no unread, no triage, no persons), more replies by cursor, a reply's ancestors, search finding
  logged posts, the thread read back without X, a profile's posts logged, the routes, and nothing sent to X.
- `packages/web/test/links.test.ts`: links in bios.
- `scripts/verify-x-threads.ts`: in a real browser on a fresh demo hub, desktop and phone: links in bios, a feed card,
  a profile's post and a search hit opening their threads, the replies as a tree, hidden branches and the next page
  read ahead while scrolling, a ten-turn back-and-forth as one run, folding, the Compact, Flat and Chains styles, a
  reply opened as its own thread and Back to where you were (two deep), a reply with what it answers,
  the logged branches coming back, the posts conversation out of the inbox, nothing sent to X but the reads. With
  `--shots`, a tour (`tour-01` … `tour-09`).
- `packages/protocol/test/mix.test.ts`: each order: Newest first stopping where a timeline with more runs out,
  Taking turns by share (twice the share, twice the places) and skipping a post already shown, Most liked against
  age and share, Spread out spacing one person's posts.
- `packages/hub/test/timelines.test.ts`: the sources, Following and Discover from the start, nothing read until
  looked at, Following merging both accounts (a post both follow once), `home` as Following, read again within a
  minute not asked, For you's order and reasons, older pages by cursor; a feed of one account's Following and the
  other's For you taking turns by share, an order swapped at once with nothing asked of X, pages following on, a
  feed with nothing on, bad orders and shares refused, Following changed and put back;
  one press to both accounts as one entry with a copy, the same press twice posted once, a thread as replies with
  who can reply on the first only, one account refused while the other posts, a delete leaving the other copy;
  drafts, a scheduled post going out at its time as a thread, held when its account was not connected.
- `scripts/verify-feed-page.ts`: in a real browser on a fresh demo hub, every press real input (and only once
  nothing moves or covers what it presses): the list, Following merged, a conversation joined, Discover taking turns
  with its reasons, the order swapped from its menu (the same posts, X not asked), Tune (a timeline turned off, put
  back), a feed made, named and deleted, posting as both accounts, a thread with who can reply, a picture,
  scheduling, Drafts and Edit, Delete leaving the other copy, a like and a reply going as the account that saw the
  post, a thread beside the list, Activity and its filter, an old link landing on Activity, and a phone (the tabs,
  the order sheet, Tune as a sheet, the composer sheet from the pencil button, the bell, ⋯, a thread in the list's
  place, Back). `--shots <dir>` keeps screenshots.
- `scripts/verify-x-feed.ts`: against a fresh demo hub in a real browser, on a desktop and a phone, dark and light,
  with screenshots (`--shots <dir>`). It checks Activity on the Feed page, the feed by post (your post small, the reply under it, the
  reactions line, the list of who liked and reposted it, the quote, the mention, the follows),
  the bar, nothing sent to X, a profile's posts, counts and that you follow each other, and the decisions.
- `packages/hub/test/posts.test.ts` also checks `GET /api/posts/:network/:post/activity`, and the branches logged
  before coming back with a thread (also from the two-minute read).
- `packages/protocol/test/compose.test.ts`: X's count (CJK, emoji sequences, links), its counter (the ring, 20 left,
  past the limit, past -10, where it goes over), Reddit's rules, and `splitThread` (paragraphs whole, short ones
  together, a long one by sentences, a long word cut).
- `packages/hub/test/posts.test.ts` "answering": a like once (and counted once), a reply posted once per key and
  logged under its post, a quote, too long or empty refused with nothing sent, who liked ranked with why, someone
  else's post's likers (X: the author's only), without X the notifications' list; the routes refusing bad input.
- `scripts/verify-x-answer.ts`: in a real browser, desktop and phone: the bar, who liked on hover (ranked, more,
  opening a profile), like and repost reaching the demo X once each, Repost asking Repost or Quote, the counter at 100,
  15 left, 6 over (marked), CJK and links, a reply to the top of the tree, a reply to a reply, Escape, a quote with
  Ctrl+Enter, the style menu, a long press on a phone showing a sheet, and X getting exactly the presses made.
- `packages/web/test/tree.test.ts`: chains and logged branches as one tree, a post seen twice, posts outside the
  thread, cycles, what is hidden to load, the tree read back as chains.

Not run against a real X account.
