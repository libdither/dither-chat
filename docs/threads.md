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
and each topic as a thread of it, so a channel's page is its topics, newest first, and the message box is in the
topics. **New topic** starts one: its name and first message (`createPost`). A topic's menu has Follow and Mute,
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

## Next unread, and reading a channel at once

**Next unread topic** (Zulip's name and key; "thread" or "post" elsewhere, `threadWords`) goes to the next unread
thread after the one you are in:

1. the channel's other unread threads, one that mentions you first, then by latest activity;
2. then the next channel with one, in sidebar order, through the rest of its space and round to its first channels;
3. then the spaces after it in the rail's order (and those in its folders), and round to the ones before.

A channel's own unread messages (a Discord text channel's, a Matrix room's) count as one more thing to read in it.
A muted thread, or one kept to the list, is skipped unless it mentions you (one muted here with a Mute rule too,
though the sidebar leaves that out). Zulip's resolved topics count; another network's archived threads do not. What
you went on from is passed over until something new comes in there, so two unread threads don't send you back and
forth before the one you left is read. A channel listed under two servers goes on from the one you are looking at.
From a channel's stream (every thread of it together), next is the next channel with anything unread.

- **`n`** (Caps Lock's too), when you are not typing and nothing is over the page (a menu, a sheet, a dialog, a layer
  Back closes), with a conversation open in the inbox, a server, a folder or search. Nothing else in the app takes a
  bare N; after a G (docs/desktop.md "Keys to the places") an N is no place, so it puts the card away and goes on, as
  any other key does. A chat you open yourself puts the caret in its message box, where N is a letter: click the
  messages first. Going there with `n` or the bar leaves the caret out of the box, so `n` goes on working; click the
  box to write. With nothing left, a toast says so.
- **The bar** at the bottom of a thread's timeline, once the newest message is drawn and there is a next one:
  "Next: <name> · N unread" (the channel first when it is another one, an @ for a mention), in the network's color.
  A click goes there. It has one mount, at the end of `Timeline` (`NextUnreadBar`), so a channel's stream gets it too.

The order is one pure function, `nextUnread` (`web/src/nextunread.ts`), asked channel by channel so it looks only as
far as the first hit; `ui/NextUnread.tsx` (a chunk of its own, loaded by `ui/NextUnreadLazy.tsx`) gathers the
channels in sidebar order and each one's threads, and draws the bar.

**Mark As Read on a channel** reads the channel and every thread of it, on every network: a Zulip channel's topics, a
Discord text channel's threads and a forum's posts, a Matrix room's threads, archived ones too (`readScope` in
`web/src/threads.ts`). It asks nothing first: a channel is a small scope. A server, a folder or everything still asks.
Each goes to its network through the read queue (`POST /api/read-all`), and read state can't be taken back there, so
there is no Undo. Their notifications on this device close, and the row counts as read without an answer
([inbox.md](inbox.md)), as a chat's own Mark As Read does.

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
covers which menu entries show where; `web/test/nextunread.test.ts` the next-unread order (same channel, next
channel, next space, muted, a mention, none left, a stream) and what a channel's Mark As Read covers;
`scripts/verify-next-unread.ts <demo hub>` (with `DITHER_DEMO_SCENARIO=zulip`) presses `n` and clicks the bar on the
demo's Zulip organization in headless Chromium, and marks a Zulip channel and a Discord text channel read. In dither-accounts, `extractors/discord/test/hook-threads.test.ts` runs hook.js's
section against a replica of the client, and `test/threads.test.ts` the mapping, the About parts and the refusals.

None of it has run against a real Discord account.
