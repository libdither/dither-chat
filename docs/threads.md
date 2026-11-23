# Threads, forums and group DMs

What Discord's threads, forums and group DMs have beyond their messages: which threads you follow and how each one
notifies you, starting a thread or a forum post, archiving and locking, a forum's tags and its posts' first messages,
a channel's archived threads, publishing in an announcement channel, and running a group DM you own. Discord first;
the protocol is shaped so another network can say the same (`packages/protocol/src/threads.ts`).
The Discord side lives in dither-accounts (`extractors/discord/src/threads.ts`, hook.js's "threads" section, its
docs/chat.md "Threads, forums and group DMs"); the demo world answers the same way (`packages/hub/src/demothreads.ts`).

## What works

- **Following a thread.** Discord tells you about a thread's messages only while you are in it (a mention of you
  reaches you either way). The adapter says which threads each account is in, at start (every thread it has joined)
  and as that changes, here or in another app. A thread you are not in reaches triage as "mentions only", the way
  Discord's own apps treat it; one you follow notifies as its own setting says, else as its channel. A thread's menu
  and its About page have **Follow Thread** / **Unfollow Thread**, and, once followed, **Thread Notifications** (All
  messages, Only @mentions, Nothing) and a mute with Discord's timers. These are Discord's own settings: its apps on
  your phone follow them too. The hub's own rules (Mute, Alert) still decide what this app notifies.
- **Starting threads.** **Start Thread** in a text or announcement channel's menu (a name, a first message, Private
  for one only people you add see), and **Create Thread** on a message in one (named from the message's first words,
  as Discord does). The new thread opens.
- **Forums.** A forum or media channel's page lists its posts: each with its tags as chips, its first message as the
  preview (where the hub has it: posts listed from Discord's thread search bring theirs), who started it, how many
  messages, and when it was last active; pinned posts first. Order by latest activity or newest first (the forum's own
  default first); filter by tags; show archived posts too. A media channel lays its posts out as a gallery of each
  post's first picture. **New post**: a title, a message, the forum's tags (a tag only moderators may use says so),
  files; a forum that requires a tag says so before anything is sent. The message box is not shown on a forum page:
  messages go in its posts.
- **Archived threads.** **Browse Threads** (a channel's menu, and "Show archived threads" in its details panel) lists
  the active ones, the archived ones a page at a time from Discord's own thread search, and your private archived ones
  (Discord's thread browser's Private tab). A forum's **Load archived posts** does the same.
- **Archiving and locking.** A thread's About page has Archive / Unarchive and Lock / Unlock. Who started a thread
  may archive it while it is open; Manage Threads may do both; a locked thread only Manage Threads opens again. Each
  is checked against a fresh read of the account's permissions before Discord is asked, and the reason shows where you
  may not. Renaming a thread is its About page's name, as before (whoever started it, or Manage Threads).
- **Publishing.** **Publish** on your own message in an announcement channel sends it to every channel that follows
  this one (after a confirm: it cannot be taken back from there). A published message shows "Published".
- **Group DMs.** **Leave** on a group DM's About page asks, then asks whether to leave without telling the others
  (Discord's own choice). On a 1:1 DM it is **Close**: Discord only hides it, and it comes back when either of you
  writes, so the hub keeps it. The group's owner gets a Group card: **Remove** someone, **Make owner** (with a confirm:
  you can no longer remove people or take it back). Anyone in a group may change its picture or remove it, from the page's big picture ([profile.md](profile.md#changing-a-picture)).
- **Voice channels' text chat.** A voice or stage channel's page shows its messages and a message box (checked; it
  was already so).
- **Newer channel types** (Discord's 17 to 21): a media channel's post is a thread, a game's DM a DM, a game lobby a
  group, a server "space" or app channel a channel, so none of them vanish or break anything.

## How

| Route | |
|---|---|
| `POST /api/conversations/:id/follow {follow, accountId?}` | `ThreadFact` as it now stands (`followThread`) |
| `POST /api/conversations/:id/thread-notify {notify?, muted?, minutes?, accountId?}` | `ThreadFact` (`threadNotify`); minutes one of `MUTE_TIMERS` |
| `POST /api/conversations/:id/thread-state {archived?, locked?, accountId?}` | the About as it now stands, after a fresh About's `thread` says it may (`threadState`) |
| `POST /api/conversations/:id/threads {name, message?, private?, body?, attachments?}` | `CreatedThreadView` (`createThread`) |
| `GET /api/conversations/:id/threads?archived=1&mine=1&offset=N[&account=]` | `ThreadPageView`: one page asked of the network (`threads` with `mine`) |
| `POST /api/conversations/:id/posts {name, body, tags?, attachments?}` | `CreatedThreadView`, checked by `postProblem` against the forum's tags (`createPost`) |
| `POST /api/messages/:id/crosspost {accountId?}` | `{ok}` (`crosspost`), only in an announcement channel |
| `POST /api/conversations/:id/members/:identityId/(remove\|owner)` | the About, after a fresh `ownership` says it may (`removeMember`, `setOwner`) |
| `POST /api/conversations/:id/picture {upload: id \| null}` | the About (`setPicture`), a picture from the uploads spool |
| `POST /api/conversations/:id/leave {silent?}` | as servers.md: now a Discord group DM (`silent`) or DM too |

Writes need the page's own Origin. Each leaves a line in the account's log (`[thread]`, `[group]`). The hub keeps each
account's thread facts (`thread_info`) and each forum's (`forum_info`) as the adapter last said them
(`hub/src/threads.ts`) and adds them to the conversation's view: `ConversationView.thread` (who follows it, its
setting, tags, owner, first message and the first picture of it) and `ConversationView.forum` (its tags, order and
layout).

Protocol (`packages/protocol/src/threads.ts`, all additive): capabilities `followThreads`, `createThreads`,
`forumPosts`, `threadState`, `myThreads`, `crosspost`, `removeMembers`, `transferOwner`, `groupPicture`;
`ConversationFact.thread` (`ThreadFact`) and `.forum` (`ForumFact`); `About.thread` (`AboutThread`) and
`About.ownership` (`AboutOwnership`); commands `followThread`, `threadNotify`, `threadState`, `createThread`,
`createPost`, `crosspost`, `removeMember`, `setOwner`, `setPicture`; `threads`'s `mine` and `ThreadsResult.ids`;
`MessageMarks.published`. The general `leave` (servers.ts) now covers Discord group DMs and DMs. An adapter without a
capability gets nothing new offered.

The forum view, the thread browser and forms, and the About cards are a lazy chunk (`web/src/ui/Threads.tsx`); the
menu entries are `web/src/threads.ts`.

## Zulip: channels are forums, topics their threads

A Zulip account (dither-accounts' `zulip` kind, its docs/zulip.md) says each channel as a forum (`variant: 'forum'`)
and each topic as a thread of it. A channel's page is its stream, as Zulip's channel view is: every topic's messages
together by time, a header where the topic changes, and a message box with a topic chip ([below](#the-channel-stream)).
Its **Topics** switch shows the topics as cards instead, newest first. **New topic** starts one: its name and first
message (`createPost`), from the cards or by naming it on the stream's chip. A topic's menu has Follow and Mute,
which are Zulip's own (`user_topics`: followed, muted, unmuted). Everything says Zulip's words: topics, not posts or
threads, and Resolved, not Archived (`model.ts` `threadWords`).

- **The sidebar** lists under each channel its unread topics and the open one, as Zulip's does (a muted topic only
  for a mention), not its six latest; a Discord forum keeps its six latest posts, since a busy forum's posts are mostly
  ones you never opened. A forum's own count is its threads' summed (unread and mentions; a Discord forum's open posts
  only): a Zulip channel takes no messages of its own, so its own count is always 0. Each topic stays its own row in the inbox.
- **Resolved topics** (Zulip's ✔ in front of the name) are archived here, but stay in the channel's list with a
  Resolved chip, the ✔ left out of the shown name (`resolvedTopic`); the name the hub keeps, and searches, still has
  it. Resolving does not hide the topic as a network's archive hides a chat (`Store.conversation`): it is done, not
  put away. The topics an older hub hid that way are shown again once (`Store.showResolvedTopics`). A moved message's
  mark leaves resolving out, as Zulip does: its `last_moved_timestamp` is not set by resolving or unresolving.
- **Topic cards** show their unread count (a red one for mentions) and a muted mark. "Newest first" is offered only
  where some post says when it started; Zulip's topics do not, so it would sort as "Latest activity" does.
- **Links**: Open in Zulip, Copy Link and Copy Message Link are Zulip's own narrow links, built from the native ids:
  `#narrow/channel/<id>-<name>`, `/topic/<name as written>`, `/near/<message id>`, `#narrow/dm/<ids>-dm` (`-group`
  for three or more), and `#user/<id>` for a person, encoded as Zulip's web client does (`encodeHashComponent` in
  [web/src/internal_url.ts](https://github.com/zulip/zulip/blob/7bb11b60d91def4644f6c74be6611fcc85488b06/web/src/internal_url.ts#L7-L24)).
- **A moved message** shows "(moved)" beside "(edited)", with when in its tooltip (`extra.movedAt`, docs/messages.md).

Renaming a topic or moving messages to another one moves them here too: the adapter sends each again with
`moved: true`, and the hub moves the message, its saved mark and its reply mark to the new conversation; the topic it
left falls back to its own newest message (`Store.message`, `packages/hub/test/moved.test.ts`).

## The channel stream

A channel's threads, read as one timeline: every thread's messages together by time, and the channel's own where it
takes any (a Matrix room does; a Zulip channel takes none). Where the conversation changes, a header bar says the
thread's name (a resolved Zulip topic with its Resolved chip, the ✔ left out), and a click on it opens that thread
alone; Escape or back from there comes back to the stream where it was. Among a room's own messages again, the bar
says the room's name. Under a header, messages group by author as anywhere else; a new day starts a header again.

- **What opens on it.** A Zulip channel, and a Matrix room that has threads, open on the stream. A Discord forum still
  opens on its post cards (its posts are long), and a Discord text channel on its own messages; each offers the stream
  on the same switch once it has threads. The switch over the timeline says the network's words: **All messages** and
  **Topics** on Zulip, **Threads** on Matrix, **Posts** on a forum, **Channel** and **With threads** on a text
  channel. What you pick is kept on this device, per channel (`channelViews`, `web/src/stream.ts`).
- **The message box** sends to the thread on its chip, the line over the box ("To <thread>"): the thread of the
  message you last clicked or replied to, else that of the newest message (in a room, the room itself: "No thread"),
  else the thread with the latest activity. The chip's card finds another by name; where the channel starts topics (a
  Zulip channel, a forum), a name no thread has starts a new one, its first message sent through `createPost`. Editing
  a message of another thread moves the chip there. The half-written message is the stream's, whichever thread it
  goes to.
- **Read.** Reaching the newest end marks read the threads whose messages are drawn: what you saw, not every topic of
  the channel.
- **Links.** A message link to the channel (`#/inbox/c/<channel>?m=<message>`) pages back through the stream to it;
  one further back than ten pages opens in its thread alone.

The stream's timeline is `k:<channel>` (docs/sync.md): `GET /api/conversations/:id/stream?before=<ts>:<id>&limit=`
pages it (`Store.channelStream`, `Store.mergedTimeline`), sync brings it up to date as it does a person's chat, and a
live message joins the stream of its thread's channel, a thread new since included. A message moved to another topic
of the channel stays in the stream; one moved to another channel leaves it (`syncmodel.ts` `leaveOtherTimelines`).
The page and its chip are a lazy chunk (`web/src/ui/Stream.tsx`); the headers and the switch are in the timeline
(`web/src/ui/Timeline.tsx`). Under the last message, `StreamFoot` is the place for "Next unread topic".

**Matrix.** A Matrix thread (`m.thread`) is a thread of its room (`shape: 'thread'`, its native id `room|root`, the
room its parent: `packages/adapter-matrix/src/adapter.ts`). Its root message stays in the room, so the stream shows
the root among the room's messages and the replies under the thread's header. "No thread" on the chip sends to the room.

## Not built

- Forum unread counts per post (Discord's FORUM_UNREADS): they come only when its own forum view asks, which the
  sandbox does not run; the hub's own unread counts per post stand in.
- Thread members (who is in a thread): not fetched, as no member lists are (owner's decision).
- Following a channel into one of your servers (Discord's announcement follow): a server-admin act, left for later.
- Making, deleting or reordering channels and categories, permission overwrites, webhooks: moderator tools, not
  built; open Discord.
- Linked lobbies, game SDK DMs and server "spaces" beyond showing them as above; channel icons and emoji in channel
  names: not read.
- Editing a post's tags after it is made, and a forum's guidelines or default reaction: not built.
- Sticker or poll posts, and voice messages as a post's first message.

## Testing

`packages/hub/test/threads.test.ts` runs the hub against the demo world's adapters in process: the forum's tags and a
post's facts in the views, an unfollowed thread as "mentions only", follow and unfollow, notification settings and a
mute, archiving refused on someone else's thread and done (with locking) on your own, a thread from a message, a post
with tags and a file, archived and private archived threads with first messages, publishing, and a group DM's owner
removing someone, handing it over (and then refused), its picture, and leaving it silently. `web/test/threads.test.ts`
covers which menu entries show where. The channel stream: `packages/hub/test/stream.test.ts` (the route, paging,
a room's own messages, and sync of `k:` with a new thread and a message moved away), `web/test/stream.test.ts` (what
opens on it, where headers go, the chip's thread), `web/test/moved.test.ts`, and `scripts/verify-back.ts` (a header
opens its thread; Escape and back come back to the same place). In dither-accounts, `extractors/discord/test/hook-threads.test.ts` runs hook.js's
section against a replica of the client, and `test/threads.test.ts` the mapping, the About parts and the refusals.

None of it has run against a real Discord account.
