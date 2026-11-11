# Indexing and network search

Two ways to find what the hub has not stored. Each one fetches through your own accounts, at the network's pace.

- **Index jobs** fetch a server, a folder of servers or a conversation whole. You can fetch every channel's history
  back to its start, its member list, or both. It is DiscordChatExporter's job done inside the hub, so what it fetches
  is searchable here and kept like any backfill.
- **Network search** asks the networks' own search (Discord's, Matrix's) for one query. It asks a few places at a time,
  in the order jev ranks them, and keeps what it finds.

Hub: `packages/hub/src/jobs.ts`, `packages/hub/src/netsearch.ts`. Types: `packages/protocol/src/jobs.ts`. Adapter
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
  categories, plus the threads the hub knows under each channel.
- A **members** task is one community space.
- Each task goes to an account that sees the place and has the capability (`history` or `walkMembers`). An online
  account is preferred.
- A place no account can fetch is counted as skipped. A job with nothing it can do fails with "None of your accounts
  can fetch this."

**Running.**

- Each account works through its tasks one at a time. The highest-priority job goes first, then the oldest.
- The hub waits `PAUSE_MS` (1.5 s) between requests, on top of the adapter's own pacing. The Discord extractor already
  spaces requests 1.5–3 s apart and waits out a 429.
- A rate limit is never counted as a failure: the task waits 30 s and asks again.
- Progress lives in `job_task`, with a cursor per conversation, so a restart carries on where it stopped.

**History, and why a repeat is cheap.**

- A conversation is paged backwards from now, 100 messages per request.
- Each page is recorded in `history_span` as a stretch known to be whole. Spans that touch are merged, and a span
  reaching the start has `from_ts` 0.
- Before each request, the walk jumps over any span the cursor is in. A span that reaches the start ends the walk.
- So a channel already walked costs one page on the next run: its newest page meets the old span, and the walk stops.
- The adapter's `history` reply names the ts of the page's oldest message (`oldest`). For an adapter that leaves it
  out, the hub takes the n-th newest stored message below the cursor, which can only make the next page overlap a
  little, never skip anything.

**Members.**

- A walk asks for names by prefix: `''` first. If that brings everyone (the count is under the limit and reaches the
  total), the walk is over. Otherwise it goes through a–z and 0–9.
- A prefix that came back full (100) is asked again one character longer, up to four characters. A big server is
  listed in a few hundred small requests rather than one request for everyone.
- On Discord the request is the client's own member search (gateway op 8), the same one the @mention picker makes.
- What a walk lists is stored with `source = 'walk'`, even when the passive "members seen" setting is off: you asked
  for it by starting the job.
- A server Discord will list only partly (only its online members, past a size) stays partial. The About's "seen N of
  M" shows how far it got.

**Left out.**

- Archived threads the hub has never seen are not found yet. Discord lists them per channel, which needs another
  adapter command.
- Media is kept by the media archive (`mediaarchive.ts`) as it is for any message, not by the job itself.
- No export file is written. The hub's database and media cache are the archive, and the nightly backup copies them.

## Network search

On the search page, under the hub's own results: **Search Discord and Matrix too**. It names only the networks your
accounts can search. It never runs as you type. When the hub found little, the button is the primary one.

**Which places, in what order.**

- **Candidates.**
  - Discord: every server and every DM or group DM an account with the `search` capability sees. Two accounts in the
    same place make one candidate, asked through the account that is online.
  - Matrix: one candidate per account, because `/search` covers every room in one request.
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
    place (Matrix) gets 0.6.
  - **local** is the hub's own hits for the query in that place, as a share of the best place's.
  - **recency** decays over 30 days from the place's last message.
  - jev gets at most 6 s. After that the places are ordered without it.
  The page says which ordering was used, and shows each place's "fit" only when jev did the ordering.

**Asking.**

- The first six places are asked. **Search N more places** asks the next six.
- Each account searches one place at a time, whatever query asked: 3 s apart on Discord, 1 s apart elsewhere.
- There is a cap of 120 searches per account per hour. A place past the cap shows "Held back" instead of being asked.
- When Discord is still indexing a place, it answers 202. The hub asks once more after the wait Discord gave, at most
  15 s.
- Hits arrive as ordinary message facts, so they are stored and the hub's own search finds them from then on. Each
  place shows how many it found and how many were new to the hub. The page leaves out hits the local results already
  show.
- A search stays on the hub for 15 minutes after it was last looked at.

**Routes.** `POST /api/search/network {q}` returns a `NetSearchView`. Follow it with `GET /api/search/network/:id`
every second while `running`. `POST /api/search/network/:id/more` asks the next few places.

## Not tried on a live account

Everything here has run against the demo hub and the extractors' fakes. Nothing has run against a real Discord or
Matrix account. The two things most likely to need adjusting on the live client are listed in dither-accounts'
`docs/chat.md`:

- the shape of the Discord client's member requester module, and the gateway request it falls back to;
- whether the client's REST module resolves or rejects a 202 from search. Both are handled.
