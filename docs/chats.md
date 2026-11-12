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

**A nickname is one account's.** You can give any account of someone's a nickname of your own (`identity.nickname`):
only you see it, the hub never sends it to a network, and no sync overwrites it (a network's own nicknames, a Discord
friend nickname or a Signal contact name, stay what the account's display name says). Wherever that account's name
shows, the nickname shows instead: an account's name as you see it is your nickname for it, else its display name,
else its handle, else its id (`accountName` in `chatroutes.ts`, `identityName` in `model.ts`, `shownName` and `SHOWN`
in the hub's `store.ts`).

**A person's name is made of their accounts' names**, never set on the person:

- one account: that account's name as you see it, so a nickname for it is their name everywhere (header, inbox row,
  people list, message box, notifications), and the network renaming the account changes nothing while it has one;
- several accounts: the name a merge kept, one of their accounts' names. It follows the account it was taken from:
  giving that account a nickname, or taking it away, renames them. A nickname on another of their accounts names only
  that account, so telling one alt apart ("Kit, raid nights") does not rename Kit.

Merging two people keeps the name of the one kept; the nicknames are the accounts' and go along with them. Splitting
an account off keeps its nickname, which names the new person; the person it left takes their name from their
accounts again when one is left, or when the name was the account's that went.

The chat has one name, the person's: the header, the inbox row, the people list and the message box's line ("Message
Kit on Telegram") say it. **The messages name accounts.** On a page of several routes every message head shows the
sending account's own picture and its name as you see it, theirs and yours alike, so Kit's Discord account and Kit's
Telegram account look like what they are, and so do yours. A bot or anyone else in a DM keeps its own name, as before.

Two accounts on one side of the chat can show the same name on the same network: Mo is "Mo" on two Discord accounts.
Then, and only then, the head adds that account's handle after the name, muted (`Mo  mo.codes`, `Mo  mo.draws`), and
leaves it out where it would say no more than the name. The same name on two networks needs no handle, because the
network's badge on the picture already tells them apart: Kit is "Kit" on Discord and on Telegram, and Sam Rivera's
Signal phone number never lands beside their name. Names are compared as you see them (a nickname counts), ignoring
case, among the accounts in the routes the page shows (`headIdents` in `chatroutes.ts`, `headNames` in `Pairs.tsx`).
Messages group only while the same account writes on the same route: another account of theirs starts a new head,
since its picture and name differ.

With one route picked from the list, the page shows that route alone: each side has one account, so the names are
plain. A person with one route has no chat page of its own: theirs is the conversation's page, which names them by
the person's name as every conversation does.

**Where you set one.** On a person's profile, each account's tile has Set Nickname…, Change Nickname… and Remove
Nickname in its menu (⋯), which edit the name on the tile in place; a tile with a nickname shows it as the name and
the account's own beneath it, muted ("their name: kitty"). A person of one account has a pencil by the name at the
top of their profile, and the same entries under More. The menu of an author, a picture or a mention has them for that
account. A chat of one route has the pencil by its name, for the account at the other end; a chat of several routes
has none, since its name is made of the accounts' (it links to the profile, where the tiles are). Leaving the editor
empty takes the nickname away. Your own accounts take none.

`person.name_source` says where a person's name came from:

| value | means |
| --- | --- |
| `network` | one account: its name as you see it, kept up to date |
| `merge` | several accounts: the name a merge kept, one account's |

Until 2026-11-11 a nickname was the person's (`user`), set with `PATCH /api/persons/:id` or `PATCH
/api/chats/person:<id>` with `name`, and it stood for every account's name in the chat's title while the messages
showed the accounts' own. Those calls now answer 400 and name the new one. On its first start with nicknames by
account, the hub moves them once (`nicknamesToAccounts`, meta `nicknames_by_account`; MIGRATIONS 4 → 5, so the
database is copied first): each person named `user` gives that name as a nickname to each of their accounts that has
none, then has one account's name (`network`) or keeps the name, now an account's (`merge`).

Earlier still (an earlier review of this page) every message of theirs showed the person's name and yours your own
person's name, and only the picture varied, by account; the route tag said which account. Before that, the page
renamed messages by account (`kit.exe`, `@kit:matrix.org`) unless you gave a nickname, and with one showed the account
in a pill beside it. Before `name_source` the hub had only `manual` ("merged or renamed by you"); it sorted those out
once (meta `name_source_set`, MIGRATIONS 2 → 3): a name one of their accounts went by became `merge`, any other `user`.

## API

| call | does |
| --- | --- |
| `GET /api/chats/:id` | `ChatView`: name, `nameSource`, `routes` (each with their identity, yours, last message time, unread), `route` (the default route, with `why: 'chosen' \| 'latest'`) |
| `PATCH /api/chats/:id` | `{ route: { conversationId, accountId } \| null }` chooses a route, or forgets the choice (409 if it is not a route of this chat). `name` is refused (400): a nickname is an account's |
| `PATCH /api/identities/:id` | `{ nickname: string \| null }` gives one account your nickname, or takes it away (null or empty); answers `{ identity }`, and other open views hear of it as an `identity` event (and a `person` event when their name follows). 400 for your own accounts, 404 for an unknown one |
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

- **The message heads** name the account that wrote, by its own picture and name (above, [Names](#names)).
- **The route tag.** Where the route changes between two messages, grouping breaks (the message gets its picture and
  head line), and the head line has a small, quiet tag after the time: what of the route's label the head has not
  already said (`tagTells`). The head names the author's account, so after their message the tag is your account
  where yours differ (`via zyn.alt`), after yours it is theirs where theirs differ (`to kit.work`), and the network's
  icon leads where the chat spans networks. Where nothing is left (Mo's messages: the head already says `mo.codes` or
  `mo.draws`), there is no tag. It is a button: a click sends through that route, and its title says so in full
  ("Send as zyn.alt to kit.work on Discord"). A long run on one route reads like that conversation's own page, with
  the accounts' names. Until 2026-11-11 a row of its own (the network's icon, their name, yours, and "sending here")
  stood above each run, and then, for a day, the tag said the route's whole label.
- **The picture's badge**, the same badge an inbox row has (the network, and dots for your account), only when it
  would differ between the chat's routes: more than one network, or more than one of your accounts on a network
  (`badgeDiffers`). Mo's page has none, and neither has a page showing one route picked from the list.
- **Under the name, where your message goes**, in the same words as a direct conversation of one route says it
  (`SendLine` in `Pairs.tsx`): the network's icon and name, then `via` and your account's chip where you have more
  than one account (the rule every conversation's header has, and a window under 820 px wide leaves the chip out, as
  everywhere). Where their accounts on that network differ, it names theirs too (`Discord · to mo.draws · via
  zyansheep`), by the same rule as the tags. It is the route messages go to now, the one the message box's line names.
  The picture's badge in the header is that route's network, always. A direct conversation's header says no more
  (until 2026-11-11 it had a crumb, `Discord › Direct messages › Ahzek`, that repeated the name; groups, channels and
  servers keep their crumbs). **A chat of several routes adds one control after the line**, a pill of the other
  routes' networks (their icons, at most three, left out on a phone) and how many routes more: `+7 ▾`. The whole line
  opens the list: press and drag down to a row and let go, click and click again, or Enter (or ↓) then the arrows,
  Enter and Escape. Picking a route shows its history alone and sends through it, without leaving the address; the
  line then says that route and the pill becomes `only this ✕`, whose ✕ returns to all chats together.
- **The list** is a card: their picture, name and what they come to ("7 accounts · 8 chats · 4 networks", leaving out
  a count of one), with All, which shows every route together. Then the routes. A network with two or more routes
  has a small heading in its colour (Discord, Matrix) over them; routes alone on their network come after those,
  without a heading, and their small line starts with the network's name in its colour. Each row is their account
  there, by its own picture with the network's badge and its name as you see it, its handle where that says more than
  the name (never a phone number), and `via ● zyn.alt` where your accounts on that network differ (`tells`); on the
  right, unread, and when it was last active. Rows go newest first within their part. The route messages go to says
  `➤ sending`, and the one the page shows alone is highlighted. The foot links to their profile. Until 2026-11-11 the
  line under the name was the networks' icons and "N chats", which said nothing of where a message went, and the list
  was rows of `their handle ⇄ yours  Network`.
- **The name** links to their profile, with no pencil: it is made of their accounts' names, and each account's
  nickname is set on its tile there (Names, above).
- **The message box's line** takes the placeholder's place and says where a message goes, by the same rule and no
  more (`leadTells`), in the words of the line under the name: "Message Kit on Signal", "Message Kit on Discord · to
  kit.work", and "· via zyn.alt" only when the account of theirs it goes to can be reached from several of yours. The
  parts that can change switch: two options toggle, more open a menu. It sits exactly where the box's own text will
  (its top padding and line height). On a phone the line only says where the message goes ("To Kit on Signal", or
  "Kit on Discord · to kit.work" where a "to" follows) and can't be tapped. Tapping the box is for typing, so the route is switched from the list or a tag.
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
