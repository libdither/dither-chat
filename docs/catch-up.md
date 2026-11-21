# Catching up

The hub keeps every message that reaches it, but some never do. Catching up is how the hub notices that it may be
missing messages, works out where (a stretch of time across one account's chats, or one chat), fetches them through
the account's own history at the [reading pace](indexing.md#reading-pace), and keeps track of each hole until it is
filled, found whole, or known to need another source.

Hub: `packages/hub/src/catchup.ts` (with `historyspan.ts`, shared with the index jobs). Types:
`packages/protocol/src/catchup.ts`. The adapter's `gap` event: `packages/protocol/src/adapter.ts`. Web:
`packages/web/src/ui/CatchUp.tsx`, Settings → Catching up.

## How the hub falls behind

Each way a message can fail to arrive, what the hub can know about it, and what tells the catch-up:

| What happens | What the hub can tell | Report |
|---|---|---|
| The hub crashes (or is killed) while events wait in its queue to be applied | A marker in `meta` says events were waiting, from which accounts and back to which live message; the journal says the stop was not clean. A history page or a snapshot that waited holds old messages the network still has: it does not stretch the hole back | `lost`, sure, per account, up to the marker's last save |
| A clean stop cannot save what still waits (`Supervisor.settle` reports lost events) | The count, at the stop | `lost`, sure |
| One event fails to be stored (a bug, a constraint) | The message, its chat and its time | `lost`, sure, that chat; once a day per message, so a message that always fails is not fetched forever. The moment around it stops counting as whole (`history_span` is cut in two there) |
| dither-accounts' manager drops what it held while the hub was away (more than it keeps) | The manager's `gap`; since when the hub was away (`catchup:away`, or when it last heard the account) | `dropped`, sure, per account |
| The manager restarts while the hub is away, or an extractor did not hold its events | The manager's `gap` too (`markGap`) | `dropped` |
| An account is offline, turned off, or out of the hub's reach for a while | It was not online from one look to the next, for at least 2 minutes (turned on again days later, it checks those days; an account that never came up after a start is offline from the start) | `offline`, possible: most networks replay what an account missed when it comes back (Signal's server queues, Telegram's difference, Matrix's sync), so this is only checked |
| A network connection the adapter could not resume (Discord's gateway sends no replay after a new session) | Only the adapter knows | the adapter's `gap` event, likely |
| The network says a chat's newest message is newer than any the hub holds | `ConversationFact.lastMessageAt` from the adapter, after 2 minutes for its messages to follow | `behind`, likely, that chat; once per claim |
| Someone notices ("Sam says they wrote last night") | — | `POST /api/catch-up/report` |
| Several chats of one account turn out to miss messages around the same time | Their chat holes | `nearby`, likely, the account |

What it does not cover: a network that never told anyone (a message that never reached the account at all), and old
history the hub never had, which is the index jobs' business. A hole looks back at most 14 days.

## Holes

A report lands in a **hole**: one account's chats over a stretch of time (`account`), or one chat (`chat`). A report
within 30 minutes of an open hole of the same scope joins it: the stretch widens, the strength takes the surer of the
two, and its cause and note are added. A hole is planned a minute after its first report, so the reports of one trouble
(an offline account whose manager also dropped events) are planned once.

**Strength.**

- `sure`: the hub knows it lost something.
- `likely`: something says so but cannot say what (an adapter's gap, a network's claim).
- `possible`: the hub cannot tell (an account was offline). A possible hole checks before it fetches.

**Planning an account hole.** Every chat of the account (direct chats, groups, channels, threads; not archived, not
forums, whose posts are threads) gets an *expected* count: its messages in the 14 days before the stretch, as a rate,
times the stretch's length. Then:

- Direct chats and groups are all checked, but for the quietest: those left out together were expected to have had
  fewer than 0.5 messages between them. Each costs a page, missing or not, so a one-minute stretch over eighty quiet
  direct chats fetches nothing, while six hours over the same eighty (four or so messages between them) fetches most.
  One with a message within 30 minutes of the stretch is never left out (a conversation that started that day has no
  pace yet).
- Channels you do not read (not opened here, and not read on the network, in 30 days) are left out: there are
  hundreds of them on Discord, and the reading pace allows 3,000 messages a day.
- Channels expected to have had fewer than 0.3 messages are left out as quiet.
- The rest are ranked by expected count, a direct chat or group counting three times a channel's, and the first 60
  kept.

What was left out is counted, with why, and **Check every chat** plans the hole again with all of them.

**Checking a possible hole.** The three chats likeliest to have had messages then (expected at least one, or half for a
direct chat) are fetched first. If none of them was missing anything, the hole is `clear` and the rest are skipped. If
any was, or one of them could not be read (an error is not a sign that it was whole), the hole becomes likely and
fetches the rest. When no chat was busy enough to check, the hole is clear at once; so is a hole with no chat worth a
page (a chat hole on a channel you do not read, unless someone named it).

**Time or chat?** A chat hole that finds missing messages looks for other chat holes of the same account in the last
day, close in time, that found some too. Three or more mean the trouble was the account's, not those chats': the
account's other chats are checked for that stretch (`nearby`), once. The other way, an account hole checks chat by
chat, so its list shows which chats were actually missing messages.

**Fetching.** Each chat is paged back from the end of the stretch to its start, 50 messages a page, `pace: 'read'`, as
an index job pages (docs/indexing.md). It jumps over what is known whole (`history_span`), so a chat that two holes, or
a hole and an index job, both cover is fetched once. A page that reaches the chat's start ends it. One chat stops after
60 pages (3,000 messages) and says so. A stretch that grows starts its pages again: grown further back, the walk goes
on from where it was; grown at the end, it reads the new end and then jumps to where it was.

A page's messages come as events, and a remote account's come after its answer (the manager sends events on a short
timer and the answer at once; the supervisor applies a big batch in slices). So after each answer the worker waits for
them to land: nothing queued in the supervisor, the chat's count below the cursor holding still, and, when the answer
said where the page ended (`oldest`), at least as many held in that stretch as the page had. Only then does it count
what it found, and only inside the stretch (older history a page reaches is not missing). Looks while the queue is busy
do not count against it; after 10 s of quiet looks, or 5 minutes in all, the page is asked again 30 s later, nothing
recorded, and what it brings is counted from what was held before the first asking. A page that held fewer than it
said, with nothing changing for 2 s, is taken as in (kinds the hub does not keep).

Only a page that says where it ended (`oldest`: Discord, Matrix, T3) is recorded in `history_span` as whole. From one
that does not (Telegram, WhatsApp, X, Meta, Google Messages), the hub cannot tell which held messages were the page's,
so it guesses the next cursor (the `count`-th newest below the old one) and records nothing. A page that answers with
newer messages than asked for (a network that cannot fetch by time) fails the chat. A hole stopped or planned again
while a page was out keeps its new state: the page's answer is not written over it. The account's worker takes the surest hole first,
then the oldest, and goes through the shared reading pace as reader `catchup`: in your hours, in sessions, under the
day's cap, never at once with an index job on the same account. A rate limit waits 30 s; an adapter that cannot read
just now (`deferMs`) is asked again later; an account that goes offline pauses its holes until it is back.

**Done, with what failed.** A hole ends when no chat is left to fetch, said each tick too, so a restart or a check
whose only chats were its first ones cannot leave it open. A hole whose chats could not be read says how many. A hole
reported while its account is turned off waits to be planned until it is on again.

**Unfetchable.** An account without the `history` capability (Signal: its servers keep no old messages) cannot fetch.
Its holes are planned all the same, listing the chats likely to have had messages then (expected 0.3 or more), and
stay `unfetchable`: an import from a linked Signal Desktop, or a phone backup, can fill them (docs/import.md,
docs/import-signal.md).

**States.** `checking`, `fetching`, `done`, `clear`, `unfetchable`, `stopped`. Holes that ended are kept 30 days; a
removed account's holes go at the next hourly sweep.

## What it keeps

- `catchup_hole` and `catchup_task` (schema.sql): the holes and their chats, with each chat's cursor and the
  adapter's own cursor (`walk`), so a restart carries on where it was.
- `catchup_claim`: the latest claim already checked per chat, so an adapter announcing its chats again on each
  reconnect does not open the same hole twice.
- `meta`: `catchup:heard` (when each account was last heard, saved each minute and at a stop), `catchup:away` (since
  when the manager was out of reach, or the hub stopped), `catchup:offline` (accounts offline since), and
  `catchup:backlog` (while events wait to be applied: since when, per account the oldest message among them; removed
  once the queue is empty and at a clean stop that saved everything).

The supervisor tells it what comes, waits and is lost through `EventWatch` (supervisor.ts: `heard`, `queued`, `lost`,
`gap`, `conversation`), and remote.ts what the manager does (`dropped`, `connection`). These touch memory only, never
the database, and the supervisor drops whatever they throw: a locked database must never cost an event. The catch-up
saves and turns them into reports on its next tick (every 5 s), each step on its own, so one that fails (a locked
database) delays only itself; reports and the marker's removal wait for the next tick rather than being lost. The waiting events' marker is saved when it changes and every 30 s while events wait,
so a crash's time is known to within that.

## Routes

- `GET /api/catch-up`: `{ holes }`, newest first, at most 100.
- `GET /api/catch-up/:id`: one hole with its chats (`list`).
- `POST /api/catch-up/report` `{ accountId? , conversationId?, from, to?, strength?, note? }`: a report from a person or
  a script. A chat's report needs no account; one is picked that sees the chat and can fetch.
- `POST /api/catch-up/:id/stop`, `POST /api/catch-up/:id/all` (check every chat), `DELETE /api/catch-up/:id`.

## The page

Settings → Catching up lists every hole: the account or chat, the stretch, why (its causes and the latest note), a
progress bar of chats, how many missing messages it found in how many pages, what it is fetching now, or why it waits
("Outside your usual hours, reading again today at 09:12"), and what it left out. **Show chats** lists each chat with
its state, what it found or how many messages were expected, and why it was skipped; a chat's name opens it. **Stop**,
**Check every chat** and **Put away** act on the hole.

## Not built yet

- **Adapters saying so.** The protocol has the `gap` event and the hub acts on it, but no extractor sends it yet.
  Discord's should, whenever its gateway starts a new session instead of resuming one.
- **Discord's claims.** Discord's extractor does not send `lastMessageAt`; its `READY` names every channel's
  `last_message_id`, a snowflake that is a time. With it, every reconnect checks every chat for free. Telegram, X,
  WhatsApp, Google Messages, Meta and T3 send it already.
- **Signal from its Desktop.** A linked Signal Desktop holds what the account received. An extractor that reads it
  could answer `history`, making Signal's holes fetchable without an import by hand. It needs the owner's say-so to
  read that profile.
- **Index jobs' guessed spans.** An index job still records a span for a page that did not say where it ended (its
  guess), and the whole chat when a page never arrived (jobs.ts). The catch-up trusts spans and jumps over them, so a
  stretch an index job guessed wrong is not checked again. The fix is the catch-up's rule there too; it makes a
  repeat of an index job on those networks read again what it read before.
- **Orphans.** A reaction or edit for a message the hub does not have is dropped today (store.ts); with Discord's and
  Signal's ids, which carry a time, it could report a chat hole at that time.
- **The chat itself.** An open chat inside a hole could say so in its timeline ("Messages from 03:40 to 15:49 may be
  missing here: fetching"), and an unfetchable one could offer the import.
- **dither-accounts acknowledging delivery.** The manager forgets events once handed over; with an acknowledgement
  from the hub, it would keep them until they are stored, and a hub crash would lose nothing.
