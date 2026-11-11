# Chats: one person, many routes

Someone you talk with on several networks, or through several of your own accounts, is one chat. Each way to reach
them is a **route**: a conversation, plus one of your accounts in it. Kit with seven accounts, who talks with four of
yours, comes to eight routes, and their page shows them as one history. There is one page per person, whichever DM of
theirs you open it from, and one row in the inbox.

Code: `packages/hub/src/chats.ts` (the hub), `packages/web/src/chatroutes.ts` (the rule below, and the inbox's one row),
`packages/web/src/ui/Pairs.tsx` (the parts the page adds), and `PersonChat` in `ui/Timeline.tsx` (the page).

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

The page adds guesses in front of that, because it knows things the hub doesn't. From first to last:

1. the route of the message you are replying to;
2. the route you picked on this page (a tag in the timeline, the message box's line, the list under the name), while
   the page stays at the address it was picked at;
3. **the DM the address names**: opened as one of their DMs (from the inbox, a notification, search, a link), the
   page sends through that DM;
4. opened as the person (`#/people/<id>`), **where you came from**, if that was a conversation:
   - their DM itself;
   - otherwise a DM through the account you were reading on (coming from a Discord server on `zyansheep`, the DM
     through `zyansheep`);
   - otherwise a DM on that network;
5. the route you chose (from the hub);
6. the route of the latest message.

The inbox's row for them opens the DM of the latest message, or the route picked this session if there is one, so
the two agree.

Choosing a route stores it as the chat's route with
`PATCH /api/chats/person:<id>`, so the next visit and your other devices start there. A route that no longer exists
(after a split, or with an account removed) is passed over, not followed.

The route that the browser kept before this (`prefs.via`, by conversation) moves to the hub the first time the page
opens, then leaves the browser.

## Names

One person, one name: on their page every message of theirs shows the person's name, on every route, whether it is
your nickname or not. Which account wrote it is the route tag's job (below). Your own messages show one name too, the
name of your own person (`db.selfPersonId`), or else what a plain conversation shows. A bot or anyone else in a DM
keeps its own name.

`person.name_source` says where a person's name came from:

| value | means |
| --- | --- |
| `network` | one account, its own name, kept up to date |
| `merge` | a merge kept this name (one of their accounts' names) |
| `user` | your nickname for them |

A rename (`PATCH /api/persons/:id` with `name`, or `PATCH /api/chats/person:<id>` with `name`) makes the name a
nickname. Saving an empty name, or sending `name: null`, removes the nickname. A person with one account then follows
that account's name again. A merged person takes the name of the account that wrote most recently. A merge keeps a
nickname from either side.

Until 2026-11-11 the page renamed messages by account (`kit.exe`, `@kit:matrix.org`) unless you gave a nickname, and
with one showed the account in a pill beside it. The route tag replaced both.

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

A chat of several routes is one page: the page any conversation has (`PersonChat` uses the same header, timeline and
message box as `ConversationPane`), with every route interleaved. Opening any DM of theirs, from anywhere, shows it,
sending through that DM; `#/people/<id>` shows the same page. With one route, a person's page is that conversation's
page, exactly.

It adds detail only as the chat needs it. **One rule decides everything it adds** (`tells` in `chatroutes.ts`): for a
route among the chat's routes, what tells it apart. Of the routes on the same network as this one:

- it is the only one: the **network** alone (`Signal`);
- they differ in their account: **their account's name** there (`kit.work`);
- they differ in yours: **your account's name** (`via zyn.alt`);
- both differ: both (`kit.work ⇄ zyn.alt`).

The network's icon goes in front only when the chat spans more than one network. So Sam, on Signal and Matrix, has
routes called Signal and Matrix; Mo, with two Discord accounts talking with one of yours, has `mo.codes` and
`mo.draws`; Ravi, one Discord account talking with two of yours, has `via zyansheep` and `via zyn.alt`; Kit has all of
these at once.

What it adds to a conversation's page:

- **The route tag.** Where the route changes between two messages, grouping breaks (the message gets its picture and
  head line), and the head line has a small, quiet tag after the time: the route's label. It is a button: a click
  sends through that route, and its title says so in full ("Send as zyn.alt to kit.work on Discord"). A long run on
  one route looks exactly like that conversation's own page. Until 2026-11-11 a row of its own (the network's icon,
  their name, yours, and "sending here") stood above each run.
- **The picture's badge**, the same badge an inbox row has (the network, and dots for your account), only when it
  would differ between the chat's routes: more than one network, or more than one of your accounts on a network
  (`badgeDiffers`). Mo's page has none, and neither has a page showing one route picked from the list.
- **Under the name**, where a conversation says its network and your account: the networks' icons and "N chats", the
  button of the list. Press and drag down to a row and let go, or click and click again. The list keeps every route
  in full (their name ⇄ yours, the network, unread), the one place that does. Picking a route shows its history alone
  and sends through it, without leaving the address; the button then shows that route's label, and the list's first
  row, All chats together, returns to all.
- **The name** has a pencil, shown on hover, for the nickname.
- **The message box's line** takes the placeholder's place and says where a message goes, by the same rule and no
  more (`leadTells`): "Message Kit on Signal", "Message Kit on Discord (kit.work)", and "from zyn.alt" only when the
  account of theirs it goes to can be reached from several of yours. The parts that can change switch: two options
  toggle, more open a menu. On a phone the line only says where the message goes ("To Kit on Signal") and can't be
  tapped. Tapping the box is for typing, so the route is switched from the list or a tag.
- **The header's buttons** are a conversation's: profile, call, search, notifications, details. With all chats shown
  they act on every route: search is `in:<person id>` (the hub reads a person's id as every direct conversation with
  them), and a notification rule is set on each. With one route picked, search is `in:<conversation>`. A call goes
  through the route in use. The details panel is the person's, also when the address names one of their DMs.

Everything else is a conversation's, over every route: reading reads every route, the unread divider sits at the
first unread of any, typing shows from any, a reply goes through the route of the message replied to, and pending-link
banners and held requests show as they do on a DM.

**Opened at a message** (`?m=`: a search hit, a link): the page pages back through the interleaved timeline until it
holds the message (up to 10 pages of 60, `jumpInChat` in `state.ts`), then shows it there like any other. The hub has
no page around a message across conversations, so one further back opens in its route alone, as if picked from the
list (which then says so; one pick returns to all). A quoted reply's jump works within what the timeline holds.

## Not yet

- **Groups as one chat.** The same group on two networks (every member on both) needs a stored link, `group_link`,
  that you make. `chatRef` would then accept a group id.
- **Read state per route.** Reading the chat reads every route. Reading with one route picked reads that conversation only,
  as before.
- **Mute.** Muting a person is already a person rule, so it covers routes that come later. A mute on one conversation
  stays on that conversation.
- **A route choice reaching other devices live.** Another device sees it the next time it opens the page, not at once.
