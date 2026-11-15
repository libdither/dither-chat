# Indexing and network search

Two ways to find what the hub has not stored. Each one fetches through your own accounts, at the network's pace.

- **Index jobs** fetch a server, a folder of servers or a conversation whole. You can fetch every channel's history
  back to its start, its member list, or both. It is DiscordChatExporter's job done inside the hub, so what it fetches
  is searchable here and kept like any backfill. Unlike an exporter, it reads at a person's pace: see
  [Reading pace](#reading-pace).
- **Network search** asks the networks' own search (Discord's, Matrix's) for one query. It asks a few places at a time,
  in the order jev ranks them, and keeps what it finds.

Mail has its own: every message of each mail account and its whole text kept on the hub, measured against the server,
with a row per account under Settings → Indexing → Mail. It runs on mail's own machinery, not as an index job:
[mail.md "Keeping all mail"](mail.md#keeping-all-mail).

Hub: `packages/hub/src/jobs.ts`, `packages/hub/src/readingpace.ts`, `packages/hub/src/netsearch.ts`. Types: `packages/protocol/src/jobs.ts`. Adapter
commands: `history` (now with `oldest`), `search`, `walkMembers` (`packages/protocol/src/adapter.ts`). The adapters
live in dither-accounts (`extractors/discord`, `extractors/matrix`). The web UI is `ui/Indexing.tsx` and the "On the
networks" part of `ui/Search.tsx`.

## Index jobs

Start one from a server's About page or its menu (**Index This Server…**), from a folder's menu (**Index Servers in
This Folder…**), or from a channel's menu (**Index This Channel…**). Settings → **Indexing** lists the jobs. Each job
shows its progress, what it is working on, a Repeat setting (once, daily, weekly) and a priority. You can pause, run
now or delete it.

**Planning.** A run starts by planning its tasks from what the target holds at that moment, so a repeat picks up
channels added since the last run.

- A **history** task is one conversation: every channel under the server, found through `space_edge` and its
  categories, plus the threads under each channel.
- A **threads** task per channel lists its threads first, active then archived, so threads nobody opened are found
  too. On Discord this is the thread browser's list (`/channels/{id}/threads/search`, DiscordChatExporter's route for a
  user account). It comes from Discord's search index: a new thread shows there a minute or two later, and a 202
  ("still indexing") is waited out up to ten times. Threads the hub already knows get their history tasks either way.
- A **members** task is one community space.
- Each task goes to an account that sees the place and has the capability (`history` or `walkMembers`). An online
  account is preferred.
- A place no account can fetch is counted as skipped. A job with nothing it can do fails with "None of your accounts
  can fetch this."

**Running.**

- Each account works through its tasks one at a time. The highest-priority job goes first, then the oldest.
- It goes at the [reading pace](#reading-pace), on top of the adapter's own pacing. The Discord extractor spaces
  requests 1.5–3 s apart and waits out a 429.
- A rate limit is never counted as a failure: the task waits 30 s and asks again.
- An adapter can answer a page with `deferMs` instead: it can't read that way just now (on Discord, you are using the
  account's live view, or a call is on). Nothing is counted, and the page is asked again after that long.
- Progress lives in `job_task`, with a cursor per conversation, so a restart carries on where it stopped.

**History, and why a repeat is cheap.**

- A conversation is paged backwards from now, 50 messages per request: what Discord's client loads each time you
  scroll up.
- Each request says `pace: 'read'`, and after the first it carries `cursor`: the last page's `next`, the network's own
  name for where it ended (on Discord, the oldest message's id). So each page goes back from a real message, as
  scrolling does, not from a made-up id at a time. The cursor is kept with the task (`job_task.walk`), so a restart
  keeps it, and it is dropped whenever the walk jumps over a span.
- Each page is recorded in `history_span` as a stretch known to be whole. Spans that touch are merged, and a span
  reaching the start has `from_ts` 0.
- Before each request, the walk jumps over any span the cursor is in. A span that reaches the start ends the walk.
- So a channel already walked costs one page on the next run: its newest page meets the old span, and the walk stops.
- The adapter's `history` reply names the ts of the page's oldest message (`oldest`). For an adapter that leaves it
  out, the hub takes the n-th newest stored message below the cursor, which can only make the next page overlap a
  little, never skip anything.

**Members.**

- A walk lists the most recently joined members, 1,000 a page, each page starting after the one before (Discord's op
  35, the list behind a server's Members page). Discord lists the 10,000 newest this way, to an ordinary member too,
  so a server up to that size is listed whole in a few requests: one of 2,390 took three.
- A bigger server is listed as far as that list goes, the newest 10,000, and no further. Until 2026-11 the rest was
  walked by name prefix through the member search (gateway op 8), "a", "b", "c" and on, which no person does; that is
  gone for Discord.
- Only an adapter without a recent list is walked by name prefix: a to z, 0 to 9, never `''`. A prefix that came back
  full (100) is asked again one character longer (and with a space, `_` or `.`), up to four characters.
- What a walk lists is stored with `source = 'walk'`, even when the passive "members seen" setting is off: you asked
  for it by starting the job. The job counts them as it goes. The About's "seen N of M" shows them only while that
  setting is on, as it does any member list.

## Reading pace

Index jobs and the [gap fill](import-discord.md) fetch through your own accounts, so they go the way you would read
back through a chat, not the way an exporter pages it (`readingpace.ts`):

- **Your hours only:** 9:00 to 1:00 local time by default. Reading starts up to 40 minutes after the hour, not on it.
- **Sessions:** 5 to 20 minutes of reading, then a break of 10 to 45.
- **A pause per page:** 2.5 to 5 s, plus a quarter to 0.7 s for each message on it, so a page of 50 is 15 to 40 s.
  Moving on to another channel adds 3 to 10 s.
- **A daily cap:** 3,000 messages per account a day. A day runs from the start of the hours to the next start, so
  reading past midnight counts toward the day it started in.
- **One reader per account:** a job and the gap fill never read through one account at the same time.
- Each draw is the mean of two random ones, so values sit around the middle more often than at the ends.

The state lives in `meta` (`pace:<account>`), so a restart neither resets the day's count nor cuts a break short. A
job waiting on the pace shows why in Settings → Indexing ("Taking a break, reading again today at 14:05").

So a big server takes days: 3,000 messages a day is 60 pages. That is the point.

Settings, in the hub's environment: `DITHER_INDEX_HOURS=9-1` (start and end hour; `0-0` is all day),
`DITHER_INDEX_DAILY=3000`, and `DITHER_INDEX_PACE=brisk` for the old pace: 1.5 s between pages, at any hour, with no
cap. A demo hub (`--demo`) always runs brisk.

On Discord, the extractor also reads each page the way the client does: it opens the channel in its page and loads
older messages with the client's own scroll-up loader, so the requests, the page address and the gateway's channel
subscriptions match a person reading there (dither-accounts `docs/chat.md` "Reading like a person"). It never marks
anything read.

**Left out.**

- Media is kept by the media archive (`mediaarchive.ts`) as it is for any message, not by the job itself.
- No export file is written. The hub's database and media cache are the archive, and the nightly backup copies them.

## Network search

On the search page, under the hub's own results: **Search Discord, Matrix and Telegram too**. It names only the networks your
accounts can search. It never runs as you type. When the hub found little, the button is the primary one.

**Which places, in what order.**

- **Candidates.**
  - Discord: every server and every DM or group DM an account with the `search` capability sees. Two accounts in the
    same place make one candidate, asked through the account that is online.
  - Matrix: one candidate per account, because `/search` covers every room in one request.
  - Telegram: one candidate per account too. Words alone go to `messages.searchGlobal`, which covers every chat
    and channel the account is in. `in:` searches those chats one at a time with `messages.search` (a forum topic
    by its topic). `from:` with no chat named searches every private chat and basic group at once, and with words
    adds a global search held to that person, which reaches supergroups and channels. `has:` becomes one of
    Telegram's filters (photos, videos, voice, files, links); `has:sticker`, `has:reaction`, two kinds at once and
    `mentions:` of anyone but you fail the place with a reason. One search makes at most 8 requests (chats × people).
    Telegram pages newest first, so `sort:oldest` orders the newest 25 oldest first.
- **Filters.**
  - `network:` and `account:` narrow the accounts.
  - `in:` narrows to the servers holding those channels, and to those channels inside them.
  - `from:` and `mentions:` become the network's own author and mention ids. A name with nobody of that name on a
    network leaves that network out.
  - `is:deleted` searches nothing: the networks do not keep deleted messages.
- **Order.** Each place's rank is
  `0.6 × jev + 0.3 × local + 0.1 × recency`.
  - **jev** is jev's P(yes) to "Would people here talk about *query*?". It comes from the categorizer's probe
    (`categorize.ts`), which judges names, topics and channel names, never messages. If jev is not running, the probe
    falls back to keyword matching. A place the probe does not cover (a DM) gets a prior of 0.15. A whole-account
    place (Matrix, Telegram) gets 0.6.
  - **local** is the hub's own hits for the query in that place, as a share of the best place's.
  - **recency** decays over 30 days from the place's last message.
  - jev gets at most 6 s. After that the places are ordered without it.
  The page says which ordering was used, and shows each place's "fit" only when jev did the ordering.

**Asking.**

- The first six places are asked. **Search N more places** asks the next six.
- Each account searches one place at a time, whatever query asked: 3 s apart on Discord, 1 s apart elsewhere.
- There is a cap of 120 searches per account per hour. A place past the cap shows "Held back" instead of being asked.
- When Discord is still indexing a place (a server or DM nobody searched before), it answers 202. The hub asks again
  after the wait Discord gave (2 to 15 s), three times in all. After that the place shows "Discord is still indexing
  this place. Try again in a minute." rather than looking searched with nothing found.
- Hits arrive as ordinary message facts, so they are stored and the hub's own search finds them from then on. Each
  place shows how many it found and how many were new to the hub. The page leaves out hits the local results already
  show.
- A search stays on the hub for 15 minutes after it was last looked at.

**Routes.** `POST /api/search/network {q}` returns a `NetSearchView`. Follow it with `GET /api/search/network/:id`
every second while `running`. `POST /api/search/network/:id/more` asks the next few places.

## Checked on a live account

On 2026-11-10 the Discord side ran on a live client with a throwaway account, through an isolated test hub's own API
(`POST /api/jobs`, `POST /api/search/network`). It used the account's own test server, seeded with 300 messages in a
channel, threads (one archived) and a forum post, and a public server of 2,390 members the account was already in.
The client's side of each request is in dither-accounts' `docs/chat.md`.

- **History.** A 300-message channel paged to its start in four requests (100, 100, 100, then none), and every
  conversation got a span reaching the start. Run again, the job cost one history page per conversation, plus two
  thread-list requests per channel and one member page.
- **Threads.** The thread browser's list works for a user account on a text channel (active and archived) and on a
  forum. It lists a new thread a minute or two after it is made. Voice and stage channels refuse it, so they get no
  threads task. A forum's own history holds nothing, so it gets none either.
- **Members.** The recent-members list answered an ordinary member and listed the 2,390 whole in three requests. A
  prefix query is a valid op 8. Its answer comes back in one batch, without chunk numbers, and the client keeps a
  nonce off query requests.
- **Search.** The client's REST module sends arrays as repeated keys and resolves a 202 rather than rejecting it. A
  server or DM nobody searched before answers 202 for a little while. The hub asks up to three times, then says the
  place is still being indexed instead of showing it as searched. Hits in threads come with their threads.
- **Not seen live.** A 202 from the thread list, and the prefix walk of a server over 10,000 beyond a few queries.
  Matrix's search has run only against the testbed.
