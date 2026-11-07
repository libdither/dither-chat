# Performance: measuring load and chat switching

`scripts/verify-perf.ts` times what the app feels like on a hub the size of the real one, and fails when a change
makes it slower. It runs on a machine with Chromium; CI has none, so run it before and after a change that touches
rendering, the sync model or the hub's hot queries.

```sh
bun scripts/verify-perf.ts                 # 3 runs each at 1× and 4× CPU, compared with scripts/perf-baseline.json
bun scripts/verify-perf.ts --update        # the same, then writes the medians as the new baseline
bun scripts/verify-perf.ts --runs 1 --cpu 4 --pages 5   # a quick look
```

Options: `--port` (8620; the hub it starts listens there), `--runs`, `--cpu 1,4`, `--pages` (older pages to load in the
biggest conversation, 15), `--web <dist>` (a build to use instead of building one), `--out <file.json>` (every run's
numbers), `--baseline <file>`, `--keep` (leave the temp dir with the world, the build and the hub's log), `--css <css>`
(added to every page, to try a style change without a build), `--work <dir>` (an empty dir to work in instead of a
temp dir, kept afterwards), `--size <w>x<h>` (1280x800; below 700 wide it emulates a phone, as `--size 390x844`).

It takes about five minutes. It builds the web app, seeds a world in a temp dir, starts its own demo hub on it
(`--demo`, with the demo's random chatter off, `DITHER_DEMO_CHATTER=0`), and drives a fresh headless Chromium per
run. Nothing touches a real hub.

## The world (`scripts/perf-world.ts`)

Shaped like the live hub in November 2026, from counts on a copy of its database:

| | live hub | seeded |
|---|---|---|
| conversations | 5,632 (4,477 channels, 704 threads, 300 DMs, 146 groups) | 5,632 (4,482, 700, 300, 150) |
| with messages | 1,397 (p50 12, p90 290; the biggest 177k, 119k, 52k) | 1,455 (the biggest 80k, 40k, 20k) |
| identities, spaces | 11,493, 1,193 | 11,502, 1,162 |
| messages | 675k, a third from the last week | 461k |
| triage in the last week | 219k | 160k |
| conversations with something unread | 898 | 971 |
| bootstrap | 4.9–5.4 MB | 4.4 MB |

Synthetic text only (mentions, room links, code, quotes, links, images, reactions and replies in about the real
shares), and the same world every run: a fixed random seed, and times counted back from the last midnight. Places and
people go through `Store.ingest`; messages and their triage are bulk inserts, with full-text search indexed once at
the end (row by row it took 17 times as long). Seeding takes about 15 s.

## What it measures

Desktop size (1280 × 800) unless `--size` says otherwise, at each CPU throttle, `runs` times; the medians are compared.

| metric | what |
|---|---|
| `hub.bootstrap.ms`, `hub.inbox.ms`, `hub.bootstrap.bytes` | the hub's own answer times (median of five) and the bootstrap's size |
| `cold.*` | a device that never saw this hub: time to the list painted, to the hub's data applied (`dither:fresh`), the longest task, App renders, layouts, DOM nodes |
| `open.first.*` | switching to six conversations for the first time (the two biggest channels, the biggest DM and group, a channel of a few thousand, a DM of a few dozen): median and slowest time to the `dither:timeline` mark, the longest task, renders of App, the inbox list and messages, and layouts, summed over the six |
| `open.again.*` | the same six again, from memory |
| `older.*` | `pages` older pages in the biggest conversation: the median and last page's time, messages loaded, and how many pages moved the view (the message that was first did not stay put) |
| `long.reopen.*` | away and back to that long timeline: time, longest task, App and message renders, layouts, DOM nodes, `.msg` and reply quote counts |
| `arrival.*` | a message from someone else arriving while it is open (the demo's `say` action): time to show, main-thread busy until things settle, App, message and inbox list renders, layouts |
| `relaunch.*` | the app opened again later, from the device's snapshot: time to the list, to fresh data, longest task, renders; then the six opened again |

Each step waits until nothing has rendered for half a second before it counts. A plain reload is not measured: it
swings 30–80% between runs, because the old page is still saving its snapshot on the way out.

### Pass or fail

Counts of the page's structure (DOM nodes, messages, reply quotes, pages that moved the view) fail when they go over
the baseline at all; renders and layouts when over by more than two or 10% (a frame boundary can move them by one);
bytes when over by 1%; a time when over baseline × 1.25 + 50 ms. Counts are the steady signal: structure does not move
between runs, and renders rarely, where times move 5–30% on a shared machine. The hub's journal must stand still for
five seconds before the first run, or that run meets the demo world still settling and counts ten times the renders. Times in the baseline are of the machine that wrote it, so compare like with
like: on another machine, write a baseline from `main` first (`--update --baseline /tmp/main.json`), then run the
branch against it.

Some render counts also have ceilings of their own (`CEILINGS` in the script), whatever the baseline says: at most
two App renders and three of the inbox list per switch, none of App and at most five messages for an arriving message,
and at most 250 messages drawn on a reopen. An `--update` over one of them fails and writes nothing.

## What the page tells it

- `dither:content` (main.tsx) and `dither:fresh` (state.ts): first content, and the hub's data applied.
- `dither:timeline` (Timeline.tsx): a conversation switched to shows its newest message, or the hub has answered.
  Its detail has the timeline's key and how many messages it holds.
- With `?perf=1` in the address, `window.__ditherPerf.renders` counts renders of `App`, `InboxSidebar`, `Timeline`
  and `MessageItem` (`packages/web/src/perf.ts`). Without it, each of those pays one check of a constant.

The harness adds a long-task observer before the app's scripts run, and reads `LayoutCount` and `TaskDuration` from
the DevTools `Performance.getMetrics`.

## Numbers

November 2026, on the seeded world, desktop size, medians of three runs. "Before" is `main` with only the harness
added; "after" has the fixes below.

| | 1× before | 1× after | 4× before | 4× after |
|---|---|---|---|---|
| cold load, list painted | 963 ms | 798 ms | 2,531 ms | 2,161 ms |
| longest task in it | 500 ms | 275 ms | 1,568 ms | 827 ms |
| first open of a conversation (median of six) | 348 ms | 209 ms | 1,196 ms | 914 ms |
| reopening one from memory | 84 ms | 87 ms | 347 ms | 284 ms |
| an older page | 2,249 ms | 202 ms | 4,984 ms | 807 ms |
| messages loaded after 15 older pages | 5,040 | 960 | 3,000 | 960 |
| that long timeline reopened | 7,005 ms | 502 ms | 18,489 ms | 2,048 ms |
| its DOM nodes | 241k | 50k | 151k | 50k |
| a message arriving: on screen after | 3,998 ms | 166 ms | 12,057 ms | 415 ms |
| main thread busy with it | 11,525 ms | 172 ms | 26,672 ms | 556 ms |
| App renders for it | 9 | 1 | 8 | 1 |
| MessageItem renders for it | 51,186 | 961 | 27,065 | 961 |
| relaunch, list painted | 916 ms | 397 ms | 5,998 ms | 1,490 ms |
| a conversation opened after it | 153 ms | 123 ms | 729 ms | 502 ms |
| hub: `/api/inbox` | 976 ms | 108 ms | | |

On a copy of the live hub's database, `Store.inbox()` went from 1,675 ms to 98 ms.

What made the difference:

- **Older pages loaded themselves.** At the very top of a timeline the browser keeps the view at the top as older
  messages come in above, so the page that just arrived was in view and asked for the next one, every half second,
  down to the conversation's start. Timeline.tsx now keeps the message that was first where it was. The long
  timeline and arrival "before" numbers are mostly this: 5,040 messages on screen where 960 were asked for.
- **Date formatting** made a new `Intl.DateTimeFormat` for every clock, tooltip and day line (format.ts), two to four
  per message per render.
- **Message bodies** rendered their Markdown again on every change anywhere; now only bodies with mentions or room
  links do, since only those read anything that can change.
- **Room links** and **reply quotes** were linear searches (every conversation, every loaded message) per message.
- **The unread total** (the app badge, the Home tab) worked out every conversation's notification level on every
  render; it now skips the ones with nothing unread and is counted once per change.
- **`useFlip`** measured every list row after every render, a forced layout of the whole sidebar; now only when the
  order changes.
- **`/api/inbox`** sorted a week of triage (200k rows on the live hub) for each of its picks. An index on the level
  and score (`triage_level_score`) lets each pick stop at its limit; `test/inbox-plan.test.ts` checks the plans.

## Scoped renders and a window

The second round, from the "next" list of the first. Medians of three runs on the same machine, `main` before (with
the first round in it) against this.

| | 1× before | 1× after | 4× before | 4× after |
|---|---|---|---|---|
| first open of a conversation (median of six) | 205 ms | 150 ms | 852 ms | 581 ms |
| App renders for the six | 30 | 6 | 30 | 6 |
| inbox list renders for the six | 30 | 14 | 30 | 13 |
| message renders for the six | 708 | 354 | 708 | 354 |
| longest task in them | 62 ms | 75 ms | 266 ms | 331 ms |
| reopening one from memory | 64 ms | 50 ms | 272 ms | 215 ms |
| an older page | 176 ms | 101 ms | 787 ms | 444 ms |
| that long timeline reopened | 437 ms | 98 ms | 2,058 ms | 413 ms |
| its DOM nodes | 50k | 16k | 50k | 16k |
| messages drawn in it | 960 | 150 | 960 | 150 |
| a message arriving: on screen after | 133 ms | 61 ms | 388 ms | 104 ms |
| main thread busy with it | 171 ms | 33 ms | 543 ms | 142 ms |
| App renders for it | 1 | 0 | 1 | 0 |
| message renders for it | 961 | 1 | 961 | 1 |
| relaunch, a conversation opened after it | 115 ms | 76 ms | 499 ms | 302 ms |

Cold load and relaunch to the list are unchanged (within noise). The longest task of a first open is longer: a
conversation's messages now come in one render where they came in two, so that one is bigger.

What changed:

- **Scoped versions** (`packages/web/src/versions.ts`). `rev` still moves on any change to `db` or the inbox, and the
  sidebars, the rail and the panes read it. `metaRev` moves only when names or settings may have: not for a
  conversation's new last message or unread counts (`conversationMetaChanged` in syncmodel.ts), the inbox ranking,
  or an identity sent again unchanged (`putIdentity` keeps the object it has). Each timeline has its own
  (`timelineRev`), for its messages, its loading and the messages its replies quote; loading a page no longer moves
  `rev` at all. model.ts memoizes on `dataVersion()`, a plain count that moves at once, so reading a model function
  subscribes nothing.
- **`App` reads no `rev`** (only on a place's profile page, which asks `db` where it lives). Every pane, list and
  layer under it reads its own; the app badge is a small `AppBadge`.
- **Memoised rows and messages** (`ui/memo.ts`). `MessageItem`, `ConvRow` and `PersonRow` render again only when
  their props change or `metaRev` moves. Updates replace a message or conversation object rather than change it, so
  the same object is the same thing. What a message would read that changes with every message (its thread's
  conversation, the message its reply quotes, where it came from in a merged timeline) the timeline passes in. A
  row's "5m" and a deleted message's "ago" are small components that still read `rev`, so they move on as before.
  Rows get the same `onClick` each time (`opener` in Sidebar.tsx), and people rows their `directs` as a prop.
- **Batched**: the signals move once the task that changed things is done (a timer), not on every change. Once per
  animation frame measured worse: the render then ran in the same task as the frame's layout and paint, and the
  longest task of a first open went from about 320 to 512 ms at 4×; a hidden page gets no frames either.
- **A window on long timelines** (Timeline.tsx). A timeline draws its newest 150 messages (`WINDOW`); the rest stay
  in memory. Nearing the top of what is drawn draws 100 more from memory, keeping the message that was first where it
  was, and only at the oldest held does it ask the hub for an older page, which is then drawn whole with everything
  above it. Back at the newest, it draws only the newest 150 again (what goes is above the view). A link to a held
  message (`?m=`) or a click on a reply's quote draws the 100 around that message and shows it; scrolling down from
  there draws more until the newest. The first message drawn gets its day line and is not grouped, as the first
  loaded one always was; the New line is placed over everything held and drawn when it is in the window; copies not
  yet sent show only while the newest is drawn. The DOM keeps the messages' order.
- **`content-visibility` on desktop**, tried again with the window (`--css '.msg{content-visibility:auto;contain-intrinsic-size:auto 64px}'`,
  4×): a first open 35% slower, layouts two to three times as many, and older pages moved the view (13 of 15) and
  loaded themselves again. It stays phones-only. At phone size (`--size 390x844`) the window keeps the view still
  too.

## Next

What these numbers point at, not done yet:

- **The bootstrap is 4.4–5.4 MB**, two thirds of it conversations, and most of those channels nobody has written in.
  On the live hub's copy, leaving out null and default fields saves 25%, leaving out the 3,489 channels without
  messages 43%, both 55%. It needs a snapshot schema change (snapshot.ts keeps the bootstrap as the hub sent it), so
  it is a change of its own.
- **A first open's longest task** is the first render of a conversation's page, 60 messages at once. Drawing the
  newest screenful first would split it.
