# Chats: one person, many routes

Someone you talk with on several networks, or through several of your own accounts, is one chat. Each way to reach
them is a **route**: a conversation, plus one of your accounts in it. Kit with seven accounts, who talks with four of
yours, comes to eight routes, and the person page shows them as one history.

Code: `packages/hub/src/chats.ts` (the hub), `packages/web/src/ui/Pairs.tsx` (the parts the page adds), and
`PersonChat` in `ui/Timeline.tsx` (the page).

## The model, and why it is small

Every network is a graph of accounts and the channels between them. Merging people makes a quotient of those graphs:
your accounts are one point, Kit's seven are another, and every direct conversation between the two is an edge. A chat
is one edge of that quotient, and its routes are the edges it was made from.

The hub only needs your side of that. It never stores the whole graph, and it never stores a chat as a row. A chat is
read from tables that already exist:

- `person:<id>` is every direct conversation (`conversation.shape = 'direct'`) that has one of the person's identities
  among its participants. One route is listed for each of your accounts with a vantage on that conversation.
- A conversation id on its own is that conversation as a chat, one route per account of yours in it.

So a merge, a split, a new account or a new DM changes the chat as soon as the tables change. There is nothing to keep
in step. Group chats that are "the same group on two networks" would need a stored link. That is not built (see
[Not yet](#not-yet)).

## Where a message goes

Routes are listed newest first. A message without a route goes through the chat's **default route**:

1. the route you chose (`chat_route`), while the chat still has it;
2. otherwise, the conversation of the latest message, through the account that last sent there.

The person page adds two guesses in front of that, because it knows things the hub doesn't. From first to last:

1. the pair you picked on this page this session;
2. **where you came from**, if that was a conversation:
   - their DM itself;
   - otherwise a DM through the account you were reading on (coming from a Discord server on `zyansheep`, the DM
     through `zyansheep`);
   - otherwise a DM on that network;
3. the route you chose (from the hub);
4. the pair of the latest message.

Opened as one of their DMs, the page sends through that DM, whatever was chosen.

Choosing a pair (the list under the name, a label in the timeline, the message box's line, a reply) stores it as the chat's route with
`PATCH /api/chats/person:<id>`, so the next visit and your other devices start there. A route that no longer exists
(after a split, or with an account removed) is passed over, not followed.

The route that the browser kept before this (`prefs.via`, by conversation) moves to the hub the first time the page
opens, then leaves the browser.

## Names

`person.name_source` says where a person's name came from:

| value | means | shows as |
| --- | --- | --- |
| `network` | one account, its own name, kept up to date | that name |
| `merge` | a merge kept this name (one of their accounts' names) | each message shows the name of the account that sent it (`kit.exe`, `@kit:matrix.org`) |
| `user` | your nickname for them | the nickname on every message, with the sending account in a small pill beside it |

A rename (`PATCH /api/persons/:id` with `name`, or `PATCH /api/chats/person:<id>` with `name`) makes the name a
nickname. Saving an empty name, or sending `name: null`, removes the nickname. A person with one account then follows
that account's name again. A merged person takes the name of the account that wrote most recently. A merge keeps a
nickname from either side.

Before this, the hub had only `manual` ("merged or renamed by you"). On its first start with `name_source`, the hub
sorts out the old names once (meta `name_source_set`; MIGRATIONS 2 → 3, so the database is copied first). A merged or
renamed person whose name is one of their accounts' display names or handles becomes `merge`. Any other name becomes
`user`.

## API

| call | does |
| --- | --- |
| `GET /api/chats/:id` | `ChatView`: name, `nameSource`, `routes` (each with their identity, yours, last message time, unread), `route` (the default route, with `why: 'chosen' \| 'latest'`) |
| `PATCH /api/chats/:id` | `{ route: { conversationId, accountId } \| null }` chooses a route, or forgets the choice (409 if it is not a route of this chat). `{ name: string \| null }` sets or removes the nickname (persons only) |
| `GET /api/chats/:id/messages?before=<ts>:<id>&limit=` | every route's messages as one timeline, newest page first |
| `POST /api/chats/:id/messages` | sends. The route is the one in `route` if given (409 if it is not this chat's), else the route of the message in `replyTo`, else the default route. Otherwise it behaves like `POST /api/conversations/:id/send`: the same body, the same `clientId` retry handling |
| `POST /api/chats/:id/read` | reads every route, here and on each network |

`:id` is `person:<person id>` or a conversation id. The web app's person timeline (`p:<id>`) loads through
`/api/chats/person:<id>/messages`. `/api/persons/:id/timeline` still answers, with the same cursor, for older clients
and dither-calendar.

### The cursor

A person's timeline spans conversations, so two messages can share a millisecond. Paging by time alone (`ts < before`)
skipped the other one. `before` is now `<ts>:<message id>`, the oldest message held. Messages are ordered by
`(ts, id)`, and a page holds what comes before that pair. A cursor with only a time still works the old way.

## The page

A chat over several routes is the page any conversation has (`PersonChat` uses the same header, timeline and message
box as `ConversationPane`). It is reached two ways, and both are the one page:

- the person, from People: **all chats together**, or one pair picked from the list;
- one of their DMs, from the inbox or anywhere else: that pair alone. Picking another pair from the list opens that
  DM, and "All chats together" opens the person.

What it adds to a conversation's page:

- **The list under the name**, where a conversation says its network and your account: "All chats 8", or the pair
  shown (`kit.exe ⇄ zyansheep`). Press and drag down to a row and let go, or click and click again. Picking a pair
  shows its history alone and sends through it. It takes the place of the header's old All chats button.
- **The name** has a pencil, shown on hover, for the nickname.
- **Messages** look as they do anywhere: the person's picture, the usual grouping. **Names** are the accounts' own
  (yours too: `zyn.alt`, `@zyansheep`), unless you gave them a nickname (see [Names](#names)). Only the pair's two
  accounts are renamed, so a bot in a DM keeps its name.
- **All chats together** puts the network's badge on each picture, as rows in the lists have, and a small label where
  the pair changes (the network's icon, their name there ⇄ yours, and "sending here" on the pair in use). Clicking a
  label sends through that pair. A long run of one pair looks like that conversation's own page.
- **The message box's line**, "Message Kit (kit.exe) from zyn.alt", takes the placeholder's place. Each name switches:
  two options toggle, more open a menu. On a phone the line only says where the message goes ("To kit.exe from zyn.alt")
  and can't be tapped. Tapping the box is for typing, so the pair is switched from the list.
- **The header's buttons** are a conversation's: profile, call, search, notifications, details. With all chats
  together they act on every chat: search is `in:<person id>` (the hub reads a person's id as every direct
  conversation with them), and a notification rule is set on each. A call goes through the pair in use.

With one route, a person's page is that conversation's page.

## Not yet

- **Groups as one chat.** The same group on two networks (every member on both) needs a stored link, `group_link`,
  that you make. `chatRef` would then accept a group id.
- **Read state per route.** Reading the chat reads every route. Reading one pair alone reads that conversation only,
  as before.
- **Mute.** Muting a person is already a person rule, so it covers routes that come later. A mute on one conversation
  stays on that conversation.
- **A route choice reaching other devices live.** Another device sees it the next time it opens the page, not at once.
