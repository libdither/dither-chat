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
  you can no longer remove people or take it back). Anyone in a group may **Change picture** or remove it.
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
covers which menu entries show where. In dither-accounts, `extractors/discord/test/hook-threads.test.ts` runs hook.js's
section against a replica of the client, and `test/threads.test.ts` the mapping, the About parts and the refusals.

None of it has run against a real Discord account.
