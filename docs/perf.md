# Performance: measuring load and chat switching

`scripts/verify-perf.ts` times what the app feels like on a hub the size of the real one, and fails when a change
makes it slower. Run it before and after a change that touches rendering, the sync model or the hub's hot queries. CI
runs a small version on every push that judges its counts, never its times ([In CI](#in-ci---ci)), and ordinary tests
hold sizes and counts of what the hub sends and the web build weighs ([Budgets](#budgets-sizes-and-counts-in-every-test-run)).

```sh
bun scripts/verify-perf.ts                 # 3 runs each at 1× and 4× CPU, compared with scripts/perf-baseline.json
bun scripts/verify-perf.ts --update        # the same, then writes the medians as the new baseline
bun scripts/verify-perf.ts --runs 1 --cpu 4 --pages 5   # a quick look
```

Options: `--port` (8620; the hub it starts listens there), `--runs`, `--cpu 1,4` (`0`: no desktop pass), `--phone-cpu 4`
(the phone pass's throttles, below; `0` leaves it out), `--ahead-cpu 4` (the fetching-ahead pass's, below; `0` leaves it
out), `--ahead-rtt 80` (its link's round trip in ms), `--pages` (older pages to load in the
biggest conversation, 15), `--web <dist>` (a build to use instead of building one), `--out <file.json>` (every run's
numbers), `--baseline <file>`, `--keep` (leave the temp dir with the world, the build and the hub's log), `--css <css>`
(added to every page, to try a style change without a build), `--work <dir>` (an empty dir to work in instead of a
temp dir, kept afterwards), `--size <w>x<h>` (1280x800; below 700 wide it emulates a phone, as `--size 390x844`),
`--scale` (the world's size against the live hub's, 1), `--ci` (below).

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

Then a phone (390 × 844, touch), `--phone-cpu` (4× here, 1× in CI), its keys starting `p4x.`: a cold load, then what
a phone does that the desktop run does not:

| metric | what |
|---|---|
| `cold.*` | time to the list, longest task, layouts, DOM nodes |
| `listScroll.*` | a touch flick down the inbox list: frames slower than 50 ms (`slowFrames`), list renders, layouts |
| `open.*` | the biggest channel opened: time, longest task, layouts, message renders |
| `tlScroll.*` | a flick up its timeline: slow frames, message renders, longest task |
| `typing.*` | 28 keys into the composer, two seconds after the open settled, then taken back (nothing is sent): each key to the frame after it (`keyP90`, `keyMax`), and renders of App, the list and messages (none) and layouts (about one a key) |
| `home`, `catchUp`, `search`, `you`, `homeTab` | back to the list, then each tab: DOM nodes, App or list renders (and the Home tab's message renders: it brings back the conversation that was open), longest task, main-thread time (`busy`) |
| `people`, `person`, `mail` | People from the rail, a person's page (the biggest direct conversation's), Mail's list: DOM nodes, App and message renders, longest task, main-thread time |

Slow frames are a time in all but name (kind `frames`): judged locally like a time, never in CI.

Those passes fetch nothing ahead (`?ahead=0`), so their counts stay what they were. Then fetching ahead
([below](#fetching-ahead-and-kept-pages-2026-11-11)) at a phone's size and over a phone's link (80 ms round trip,
20/10 Mbit/s: on loopback a page from the hub takes no time to come, and fetching ahead saves only that),
`--ahead-cpu` (4× here, 1× in CI), its keys starting `a4x.`:

| metric | what |
|---|---|
| `ahead.pages`, `ahead.pictures`, `ahead.requests`, `ahead.bytes` | a device that never saw the hub loads the inbox and waits until fetching ahead is done: pages and pictures it fetched, its requests and their bytes on the wire |
| `ahead.open`, `ahead.served` | then the first five conversations of the inbox open one after another (median time to `dither:timeline`), and how many came from what was fetched ahead |
| `ahead.relaunch`, `ahead.relaunchServed` | the app opened again, and the next three rows open at once, before this start fetched anything: time, and how many came from the device |
| `noahead.open`, `noahead.relaunch` | the same in a browser that fetches nothing ahead (not in CI, which judges no times) |

`ahead.served` and `ahead.relaunchServed` have floors (`FLOORS`): every open there should come from the device.

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

## In CI (`--ci`)

CI's `perf` job runs a small version on every push and pull request that changes code (docs/testing.md), in the
runner's browser, beside the other jobs:

```sh
bun scripts/verify-perf.ts --ci                          # what CI runs: compared with scripts/perf-baseline-ci.json
bun scripts/verify-perf.ts --ci --update --runs 5        # a new CI baseline, and which of its numbers are steady
```

Its phone pass runs once at 1× after the desktop's (about 20 s more), and CI judges only those of its counts that came
out the same in five runs on GitHub's runners. On 2026-11-11 (#103's run and four dispatched with `gh workflow run
ci.yml --ref <branch>`) 24 of its 25 did: DOM nodes on each screen, renders and layouts of the flicks, the open and
typing (none of App or messages, one of the list, 35 layouts), the tabs, the person's page. Its cold load's layouts
(8 to 10) did not, and are printed only.

It seeds the same world at a tenth of the size (`--scale 0.1`: 574 conversations, 150 with messages, 22k messages,
the biggest 8,000), then does a warm-up run that is not counted and one run at 1×, with five older pages. Only
counts, renders, layouts and bytes are judged, by the rules above, with one difference: a count of the page's
structure may go 1% (at least two) over its baseline, not none. Each run's arriving message moves the long timeline's
window of 150 by one message, so `long.reopen.nodes` comes down by about five a run (8214, 8209, 8205, 8199, 8194): CI's
one run reads 8214 against the baseline's median of five, 8205, and a change that only moves which message falls out
of the window should not fail. A new part on every message (about 750 nodes on that timeline) or a list row (rows are
in `cold.nodes`) still does.

Of those, only the ones the CI baseline marks `"gate": true` are judged. `--ci --update` sets that from the spread of
its runs (it wants five): steady when the runs spread over at most half what the number may go over by (a tally,
within one), so that noise alone cannot fail it. Every time, and anything not steady, is printed with its runs and goes
in the job's summary (`GITHUB_STEP_SUMMARY`), never compared: a shared runner's times say little, and a time gate would
fail at random. No run is tried again in CI. The script takes about 50 s on a runner, the job about a minute.

The warm-up also stands in for the wait until the hub's journal stands still: the demo world settles about five
seconds after its accounts come online, while the warm-up runs, and the hub's own numbers (`hub.*`) are taken after
it. Without a warm-up (the local default) the script waits.

What made the warm-up necessary (2026-11-10, five runs on this world): the first run on a fresh hub drew more than
the rest, as at full size (474 against 354 message renders at 1×, not at 4×, which runs after): 428 against 308
message renders for the six first opens, 13 against 9 inbox list renders, 36 against 19 layouts, and the reopens
too. It is not that the hub's first answers are slow. A warm-up that hurried (100 ms without a render before each
step, not 500) drew 308 itself on a fresh hub, and left the excess to the run after it: 436 message renders and 13
inbox list renders. The timeline marks a conversation read once it has drawn nothing for 300 ms, so one left sooner
stays unread, and the first run at the real pace is the one that marks the six read: marking them read through the
API after the hurried warm-up took away the first opens' excess, though not the reopens' (368 against 308). So the warm-up has to be a whole run at the real pace: it leaves the hub
as the runs after it find it.

Why one run after it is enough (2026-11-10, 12 runs of `--ci` on GitHub's runners): every gated number stayed within
its baseline in every run, and 23 of the 30 came out the same as the baseline every time. The seven that moved moved
about as much when CI took three runs and their median (five runs of main, in brackets): App renders on a cold load 2
or 3 (2 or 3); layouts on a cold load 8 or 9 (9 or 10), on the six first opens 15 to 19 (15 to 18) and on the six
after a relaunch 16 to 18 (17 or 18), all within the two a tally may go over, the first opens' the closest, 19 against
the 21 that fails; `long.reopen.nodes` 8214, the first run's (above); and the bootstrap's bytes, by an arriving message
or so (`hub.bootstrap.bytes`, taken after the warm-up now, 539,634 against 539,665; `cold.bootstrapBytes` 539,733
against 539,932).

## Baselines and when to update them

- **`scripts/perf-baseline-ci.json`** (CI). Update it in the same pull request as a change that moves a count on
  purpose (more DOM nodes for a new part of each message, a render saved), with `--ci --update --runs 5`, and say in
  the pull request which count moved and why. A count that went up by accident is the thing CI is there to catch:
  fix it rather than update the baseline. The ceilings (`CEILINGS`) still hold: an update over one fails and writes
  nothing.
- **`scripts/perf-baseline.json`** (local, full size, 1× and 4×). Its counts follow the same rule. Its times are of
  the machine that wrote them: update them only on a quiet machine, and compare a branch against a baseline written
  from `main` on the same machine, as above.

The local baseline of 2026-11-07 failed three of its counts on main by 2026-11-10, none of them a slowdown, and was
written again:

- `1x.long.reopen.nodes` and `4x.long.reopen.nodes`, 16,395 to 17,148 (+753). +630 came with e4a80e64 (#59, the inbox
  as one list again), where a row you owe a reply on shows its ↩ and age beside its unread count too, not only when
  nothing is unread; the cold load's nodes moved by the same 649. About +100 came on 11-08 with the mail and Add
  slices (+88 from 20562ee to dc9371e, +15 more by 950a49e; not narrowed further), the same in the cold load's nodes, so
  in the inbox list or the rail, not the messages. Both are what those changes are for.
- `4x.cold.layouts`, 9 to 12 (13, 12 and 8 in three runs; 10–11 at 1×). Layouts on a cold load moved from 8–9 to
  10–12 over 11-09's inbox changes, in single runs on a loaded machine; nothing in the times follows it.

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
- **The unread total** (the app badge, the Home tab) worked out every conversation's notification rule on every
  render; it now skips the ones with nothing unread and is counted once per change.
- **`useFlip`** measured every list row after every render, a forced layout of the whole sidebar; now only when the
  order changes.
- **`/api/inbox`** sorted a week of triage (200k rows on the live hub) for each of its picks. An index on the tier
  and score (`triage_tier_score`; `triage_level_score` before the tiers) lets each pick stop at its limit;
  `test/inbox-plan.test.ts` checks the plans.

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

## Mail (docs/mail.md)

Mail stays out of chat's way: its events move a signal of their own (`mailRev`, versions.ts), so chat's lists do not
draw again for them, and its screens are a chunk loaded the first time Mail opens (`ui/mail/lazy.tsx`, 13 KB), like the
people graph's. What the first load carries of it is its model, the Accounts and Settings rows and the rail's entry:
3 KB of script, and 9 DOM nodes (the four `*.nodes` counts in the baseline moved by those, by hand, not with
`--update`). The demo world, and so the perf world, has a mail account with 24 messages: the bootstrap is 10 KB bigger.

Measured on 2026-11-07 on a machine with a load of about 6 on 16 cores, so the times moved by up to 40% between runs
of the same code; runs alternated, origin/main between two of the branch. Renders were the same (App 3 on a cold load
and 6 for the six opens, message renders 354; sidebar renders 13 to 15 either way). Times of the same build bracketed
main's: a cold load at 4× took 3,692 ms on main, 2,533 and 3,777 ms on the branch; a first open 1,113 ms on main,
710 and 1,050 ms. Nothing there says mail slows chat, and nothing that noisy could show a few percent.

## Budgets: sizes and counts in every test run

Times are too noisy to fail CI on; sizes and counts are not. Two ordinary tests measure what a cold start costs and
hold each number to a budget in `budgets.json` at the repo root, so a change that makes startup or a page fetch heavier
fails `bun run test`, locally and in CI. Each takes about a second.

**What the hub sends** (`packages/hub/test/budgets.test.ts`). The perf world at a tenth of the size (`seedWorld` at
scale 0.1: 574 conversations, 22k messages, a week of triage), the demo's mail account, and a hub wired like main.ts's
for what it sends (attention with the learned order's prior, devices, activity, mail, the read queue). The clock is
stopped at 2026-11-10 12:00 UTC and the sync journal's epoch fixed, so every number is the same on every run, machine
and time zone. Through the same HTTP and socket paths the web app uses on a cold start, in its order:

| key | what |
|---|---|
| `bootstrap.*` | `/api/bootstrap`: bytes, zstd bytes (what Chromium is sent), fields, and its rows: conversations, identities, persons, spaces, edges, attention, mail threads |
| `inbox.*` | `/api/inbox`: bytes, zstd, fields, items |
| `coldStart.*` | everything a cold start fetches, added up: health, activity, devices/hello, bootstrap, read-all, inbox, mail triage, usage, retention |
| `page.first.*`, `page.older.*` | the biggest conversation's first page of 60 and the one before it |
| `live.message.*`, `live.triaged.*` | the live socket's frame for one message arriving, and the one for its triage |
| `sync.missed.*` | `/api/sync` for a device that was away for that message (a relaunch from its snapshot) |

`fields` counts every field of every object in a payload. A field added to each conversation is about 1.5% of the
bootstrap's bytes, inside their headroom, but hundreds of fields, and fields have none.

**What the web build weighs** (`packages/web/test/bundle.test.ts`). It runs `vite build` with vite.config.ts into a temp
dir, then measures bytes and gzip bytes (level 6, as vite prints them) of every chunk, the stylesheet and the workers,
and of the startup set: what index.html loads before the app runs (its script, its modulepreloads and the stylesheet),
added up, and how many files that is. Chunks are named by what they stand for, not their hashed file names: `js/entry`,
a lazy chunk by its module (`js/src/ui/files/PdfView.tsx`, `js/jsqr/dist/jsQR.js`), a shared chunk by the name rolldown
gave it (`js/shared/Accounts`).

**Passing.** A value over its budget fails. Bytes have 2% of headroom; counts and fields none. A value well under its
budget, a measure with no budget yet (a new chunk), or a budget nothing measures any more prints a hint; only the
new measure fails, until it has a budget.

```sh
bun scripts/budgets.ts                                   # both tests
bun scripts/budgets.ts --update                          # write measured values, lower budgets, add new ones, drop old ones
bun scripts/budgets.ts --update --reason "why it grew"   # also raise the ones that went over
```

One test alone: `BUDGETS_UPDATE=1` (and `BUDGETS_REASON=…`) with `bun test test/budgets.test.ts` in packages/hub or
`bun test test/bundle.test.ts` in packages/web. Commit `budgets.json` with the change.

**Raising a budget** needs a reason beside it in `budgets.json`; `--update` will not raise one without `--reason`, and
the tests fail when a budget went up since the base commit without a new reason (on GitHub Actions the base is `HEAD^1`,
main's head for a pull request, so the checkout fetches two commits; locally the merge base with origin/main, or
`BUDGETS_BASE=<ref>`). Nobody reviews a pull request before it merges, so the reason is the record. Raise when the
bytes are what the change is for and cannot be had cheaper: a field the app reads on most rows, a screen that is on the
first screen. Not when a default could be left out (send a field only when it is not null, false or its default), when
a screen that is not on the first screen joins the startup set through a static import (import it lazily, as Mail's
screens and the people graph are), or to make a red check green without looking at why it went red. Lower budgets
whenever a hint says so: a budget that sits well above its value lets a regression through unseen.

On GitHub Actions both tests add a table of measured against budget to the job summary. Two pull requests that each
stay inside a budget can, merged together, go over it; main's next run then fails, and the next change there lowers
something or raises the budget with a reason.

### The startup set (2026-11-10)

907 KB (278 KB gzip) in ten files: the entry (269 KB), `shared/Accounts` (353 KB), `shared/state` (72 KB), the
stylesheet (182 KB), and six small ones. The chunk called Accounts is not Accounts.tsx: rolldown made it of the 72
modules the entry shares with the lazy chunks (Mail's screens, the people graph, `lazy`), Sidebar, Requests, model.ts,
icons and menus among them, and named it after one. It is in the startup set because the entry imports from it.

What making one import lazy would take out of the startup JS (725 KB, 243 KB gzip), estimated from each module's share
of it, everything only it imports included:

| lazy | saves | gzip |
|---|---|---|
| Settings.tsx (Push, themes, Adversarial) | 55 KB | 18 KB |
| Accounts.tsx (Imports, Telegram sign-ins, QR codes) | 54 KB | 18 KB |
| Profile.tsx (the activity card and chart) | 44 KB | 15 KB |
| Requests.tsx | 20 KB | 7 KB |
| Reorganize.tsx | 19 KB | 6 KB |
| CatchUp.tsx | 18 KB | 6 KB |
| NewMessage.tsx | 14 KB | 5 KB |
| PlaceProfile.tsx | 13 KB | 4 KB |
| HowItSorts.tsx, Search.tsx, Directory.tsx, Details.tsx | 9–11 KB each | 3–4 KB each |

Those twelve together are about 280 KB (93 KB gzip), more than a third of the startup JS. The emoji data (429 KB, 82 KB
gzip) is not in the set: Reactions.tsx loads it four seconds after a conversation opens.

## The hub's own stalls (2026-11-11)

The hub answers everything on one thread, so a slow query holds up every device's requests behind it, the page of
messages a phone is waiting for included. A CPU profile of a demo hub while a browser opened the six (`bun --cpu-prof`)
found two:

- **Which account sends** (`pickAccount` in server.ts), asked when a conversation opens (its history from the
  network), for every push (whether to offer Reply) and before a send. It looked for the last message you wrote
  there, newest first, which reads every message of a conversation you never wrote in, or wrote in long ago. On a copy
  of the live hub's database that took 0.2 to 3.4 s for 9 of its 12 biggest channels (on a busy machine), and each of those
  has one account, so there was nothing to choose. Now it reads messages only when two or more connected accounts can
  act there (11 of 6,388 conversations on the live hub). The perf world's biggest channel: `POST /history` 1.9–2.8 s
  before, 1 ms after; while it ran, the timeline's own page, a script file and everything else waited.
- **The triage prune** (`pruneTriage`, every six hours) walked every row below the list by tier to find the old
  ones: 0.9 s on the live copy with none old enough. It walks by age now (`triage_created`): 0 ms.
  `test/pick-account.test.ts` and the prune's plan test in `test/hardening.test.ts` keep them so.

### After a restart (2026-11-12)

After each restart of the live hub its `startup: ready` came in 2.5–12 s, but `/api/bootstrap` then took 2–56 s, twice
over 60 s, for two to six minutes. A copy of the live database (878k messages) on a hub sealed off from the network
did the same: a network namespace with only loopback, a stand-in for dither-accounts' client that lists the nine
accounts as online (and can replay adapter events as the manager does after a restart), a stand-in jev, and a timer
in the process that logged how late it fired. A CPU profile put the holds on the embedder's refit
(docs/embeddings.md):

- Its models live in memory, so a start refits at the embedder's first step, 10 s in. "Caught up" lived in memory
  too, so a start that had new messages to embed (every live one) refit again at its first idle step.
- A refit ran straight through with three pauses: `loadTurns` (3–9 s: its half for the conversations you reacted in
  read every message in conversation order rather than starting from your 57k reactions), then 26 fits of the probe
  (20 to choose λ, five out-of-fold, one more).
- New messages after a start were looked into for jev's questions: two reads of each conversation's last 30 days,
  3.6 s for 2,000 messages in busy channels, though no questions are asked.
- Smaller, every minute while any are due: the media archiver found its retries' and expired links' attachments by
  hashing every attachment's URL, 1–3 s at once.

What changed:

- **Slices** (`packages/hub/src/slices.ts`). Work of seconds is a generator that yields the rows it worked through
  every few thousand (`SLICE_ROWS`: a row read, or an example visited once), and `sliced` runs it 20 ms at a time with
  a turn of the event loop between. The refit (`loadTurns` a page at a time, the probe's fits, reading and marking
  vectors) and the media archiver's three walks run so. The probe's loops are plain functions over a range of rows that
  the generator calls (written inside the generator they ran 30% slower), and its answers are the same to the last bit:
  checked against main's at three sizes, and in the test.
- `loadTurns` starts from your reactions: the same 118 conversations in the same order, 0.2 s instead of 3.4 s.
- A start refits once: a backfill done before the start does not finish again.
- `askJev` returns at once while there are no questions.

The copy, sealed, at a load of 6 to 25 on 16 cores; `/api/bootstrap` every 5 s from the hub's first answer:

| | main | this |
|---|---|---|
| no events: bootstrap, slowest of 60 | 28.1 s (11.4, 28.1, 7.1 s in the first minute) | 0.75 s (median 0.28 s) |
| no events: longest hold after it listens | 28.0 s | 0.84 s (attention's first scoring, before `ready`) |
| 2,000 messages replayed: bootstrap, slowest | over 90 s (83, 13, 3, >90, 33, 19, 3.5 s, then 0.3 s from 278 s) | 0.57 s (median 0.28 s) |
| 2,000 messages replayed: longest hold | 125 s | 0.53 s |

What is left: a bootstrap is itself 0.25–0.7 s of the hub's thread on this database, and attention's rescoring of
everything (every five minutes, and after the inbox ranking refits) 0.4–0.8 s.

**The stall log** (`stalls.ts`, docs/deploy.md). For ten minutes from when it listens, the hub logs every hold of
200 ms or more with the work that began in it (`noteWork`: each slice of a job, each request by its path without
ids, each batch of adapter events, triage, the five-minute rescore), then holds of two seconds or more; at ten
minutes one line sums them up. After a restart, `grep -E '^stalls?:'` in the hub's log says whether anything still
holds it.

`test/stalls.test.ts` keeps it so by counts: a clock that ends a slice at every chance, and `onSlice` for each
slice's rows. No slice of the refit, the probe or the archiver's walks goes over its rows; the refit's features and the
probe's weights sliced are the same as straight through; a start refits once; picking for jev with no questions looks
into nothing. The refit's times are printed (and on GitHub Actions put in the job's summary), not judged.

### Live traffic (2026-11-12)

With #107 deployed, the first restart's bootstrap answered in 0.4–1.1 s from the first poll, but the stall log's ten
minutes said `82 of 200 ms or more`, the longest 7.2 s, 11 over a second, nearly all of them `triage` and small
batches of adapter events: ordinary traffic, every minute or so, not only after the start. The same sealed copy with
the copy's own last eleven minutes of traffic replayed through the manager's stand-in, at their pace (353 messages,
mostly in busy Discord channels, with their replies, mentions and attachment kinds but made-up text, each author
typing first, a tenth edited, presence changes and reactions at the copy's rates), did the same. The profile put it
on triage's activity features (`activity.ts`, docs/activity.md), on with `DITHER_ACTIVITY_FEATURES=1` as on the live
hub: for each conversation a decision read every message of its last 90 days with its triage row, and again every
one of them to find yours, cached for five minutes. A busy channel is 80k messages there: 0.6–1.2 s at a load of 5,
on the first message after each five minutes, and at a start for every busy channel at once. Over ten minutes it was
10.5 s of the holds.

- **Activity's features**: the messages come a page of 2,048 at a time, as a generator that triage runs in slices
  (`featuresSliced`), and one walk gives both what others wrote and what you wrote. The features are the same: 100
  of the copy's conversations (the 40 busiest, 60 DMs) compared with main's, sliced and straight through; worked out
  straight through, those 100 took 3.4 s against main's 13.8 s (with the change below).
- **The identities that are you** (`SELF_SQL` in interact.ts and rankhistory.ts, activity's, the embedder's
  `selfIdentities`, the profile's and the graph's) are found from the person marked as you: the hub has 690 persons
  and 15,791 identities, and the old plan read every identity and looked up its person, 28–55 ms (at a load of 15
  to 60) each time, at least twice for every message triage decided on (the interaction fold's catch-up, the embedder
  getting a new message ready) and once more for every read of activity's pages. 0.05 ms now, the same identities;
  `test/stalls.test.ts` checks the plan.
- Work that the stall log showed as `nothing noted` notes itself: attention's first scoring (the 702 ms at 0 ms),
  the five-second notification sweep, the minute's votes, upkeep, categories, media info, mail's sync, and a flush
  that sent something.
- **One commit for a decision**: what triage writes for a message (the decision, the features it saw, attention's
  note of it, the end of its pending row) is one transaction instead of four. The hub's database keeps SQLite's
  default `synchronous` (FULL) in WAL mode, so every commit waits for an fsync, and bun:sqlite waits on the hub's
  thread: on a machine whose disk is busy that wait is most of what is left. Counted with `strace -c` over three
  minutes of the replay (86 messages): 876 fsyncs on main, 666 with this, about 7.7 a message (the ingest, its pending
  row, the decision, the flush's journal and attention writes, the embedding, presence lines).

The copy, sealed, main and this side by side over the same ten minutes of replayed traffic (each pair at the same
load, which other work on the machine moved a lot), the hub's own stall lines; "without polls" leaves out the holds
that had one of the test's own bootstrap requests in them (60 in ten minutes, each 0.2–1.5 s of the hub's thread):

| | main | this |
|---|---|---|
| load 14 → 6: holds of 200 ms or more, their sum, the longest | 90, 41.9 s, 3.1 s | 64, 34.5 s, 2.7 s |
| the same without polls | 58, 29.0 s, 1.5 s | 37, 23.5 s, 1.7 s |
| load 3 → 42: holds, sum, longest | 118, 58.8 s, 1.9 s | 82, 40.1 s, 1.8 s |
| the same without polls | 62, 29.5 s, 1.8 s | 24, 13.1 s, 1.7 s |
| load 3–5, three minutes, under the profiler | | 10, 2.3 s, 0.38 s (none over 700 ms) |

What is left is mostly the machine's load: at a load of 3 to 5 nothing of the traffic holds the hub for long, and
under 40 to 80 the same few hundred milliseconds of writes and fsyncs a message take seconds. `PRAGMA synchronous =
NORMAL`, the usual setting with WAL, would take the fsync out of each commit (they would come at checkpoints): no
corruption on a crash, but a power cut could lose the last commits. That is a choice about the data, not made here.

`test/stalls.test.ts` holds it: deciding on a message in a channel of 1,200 messages reads them a hundred at a time
(a test's page) with a turn between, gets the features one read gets, and reads nothing the next time.

### Checkpoints, long batches and the rest (2026-11-13)

After #116 the live hub's first ten minutes still read 60–64 holds (24–34 s), one to three over a second (5.2–5.6 s),
and later single events held it for 5 s and bursts of hundreds of events for 2–10 s. The same sealed copy reproduced
them, with:
- the copy's own traffic replayed as above;
- four devices on the live socket;
- a synthetic media cache with the live one's 78,882 names;
- big batches as the live log shows them: a history fetch of 1,340 messages, a snapshot of 300 conversations and 300
  identities, a member list of 1,000, eight pages of 20.

The profile, by hold:

- **Checkpoints.** The 6–10 s holds were single small commits (an ingest, a pending-triage row) spending seconds in
  SQLite's `run`. That is SQLite's automatic checkpoint: the commit that takes the write-ahead log past 1,000 pages
  copies the log back into the 1.4 GB database file and fsyncs it, inside itself. After a burst of writes the copy is
  big, and it is why `flush` (which commits the journal) led the live log's labelled totals. The hub's connection
  now does no checkpoints (`wal_autocheckpoint = 0`). A worker thread with its own connection runs a passive one every
  second (`checkpoint.ts`): it waits for nobody and nobody waits for it, and commits are as safe as before. In ten
  minutes of the replay it ran 599–601, the longest 0.5–1.6 s on its own thread. If the worker stops, the hub's
  connection checkpoints again as SQLite would.
- **Long batches** from the manager were applied one event at a time, each in its own transaction, all at once: 2.5 s
  for the 1,340 and 2.7 s for the snapshot. `Supervisor.apply` now applies a batch of more than 32 events, or one
  queued behind others, 32 at a time. Each slice is one transaction, with a turn of the event loop between. Small
  batches go in at once, as before, but in one transaction. Same events, same order. An account held for a locked
  database (#124) keeps its queued batches behind what it holds.
- **Upkeep at 60 s** (and every six hours) listed and stat'ed the media cache's 78,882 names, then checked every
  `.mime` again: 3 s on the live hub. It is now a generator, 512 names a slice (`pruneMediaCacheSteps`), and the same
  files go.
- **A flush** commits once: attention's folds (a transaction for each conversation) and the journal are one
  transaction, and the frame goes to devices after the commit.
- **Attention's rescore of everything** (every five minutes, after the learned order refits, and the first scoring at
  each start) scores 64 conversations a slice. Devices get the whole list once the first scores are done; a bootstrap
  before then works them out as it did.
- **The bootstrap** compresses its zstd on the thread pool (`Bun.zstdCompress`, the same bytes) and remembers each
  picture's signed link (`mediaSigner`), which was 15k HMACs a bootstrap on the live hub. Its bytes are unchanged
  (budgets.json).

Main and this side by side over the same ten minutes of replayed traffic, at the same load (6–14), from the hub's own
stall lines. "Without polls" leaves out the holds that had one of the test's 60 bootstrap requests in them:

| | main | this |
|---|---|---|
| holds of 200 ms or more, their sum, the longest | 101, 53.6 s, 5.3 s | 90, 39.6 s, 2.3 s |
| over a second | 10 | 5 |
| without polls | 52, 34.4 s, 5.3 s | 49, 26.4 s, 2.3 s |
| with a poll in them, the longest | 1.9 s | 0.73 s |
| the first minute | 7, 2.4 s, 0.69 s | 4, 1.5 s, 0.52 s |

A profiled run of this at a lower load put it at 46 holds, 19.4 s, the longest 1.8 s.

What is left is commits waiting for a busy disk. Each one fsyncs (`synchronous` stays FULL), and a few of them in a
row take a second or two when other work on the machine has the disk: in the comparison run the checkpointer's own
copies took up to 1.6 s on its thread. A message is now about four commits (its batch, its triage decision, the
flush, the embedder's own database). Fewer would need the writes on a thread of their own, or `synchronous = NORMAL`,
which is the owner's choice.

`test/stalls.test.ts` holds it, by counts:
- a cache walk takes 512 names a slice and lets the same files go;
- a 1,000-event batch is applied 32 to a transaction with a turn between, in order;
- with the checkpointer the hub's commits copy nothing back, and its thread copies all of the log;
- a flush writes inside one transaction and sends after it;
- the sliced rescore gives the same scores, 64 at most between turns.

### synchronous = NORMAL (2026-11-13)

With #132 deployed, the live hub's ten minutes still read 178 holds of 200 ms or more (74.7 s, six over a second, the
median 332 ms). Most were "adapter events" and "flush": commits, each waiting on the hub's one thread for an fsync of
the log (`synchronous` was SQLite's default, FULL), about eight for each message. The longest, one of 5–6 s in each
deploy's first minutes, was a few small commits waiting on the disk ("The first minutes after a start", below).

The owner chose `synchronous = NORMAL` (store.ts, embeddings.ts). In WAL mode a commit is then written to the log
without waiting for the disk, and the log reaches the disk at checkpoints, which the checkpoint thread runs about every
second (checkpoint.ts). A clean stop checkpoints everything first (main.ts). A power cut or a crash of the machine can
lose about the last second; a crash of the hub loses nothing; nothing can be corrupted (docs/deploy.md, "Durability").

The sealed copy with the copy's traffic replayed, four devices on the live socket, the bootstrap polled every 5 s for
four minutes, and a fresh headless Chromium profile loading the app after that (one browser at a time):

| | FULL (main) | NORMAL |
|---|---|---|
| fsyncs in three minutes of the replay (66 messages) | 543, all on the hub's thread | 19, all on the checkpoint thread |
| the 90 s after the fresh browser loads: holds, sum, longest | 21, 16.0 s, 3.1 s | 4, 1.2 s, 0.34 s |
| the whole run: holds of 200 ms or more, sum, longest | 62, 30.1 s, 3.1 s | 50, 19.4 s, 2.3 s |
| without the bootstrap polls' holds | 28, 19.0 s, 3.1 s | 16, 8.4 s, 2.3 s |

What is left is mostly reads: the first scores at a start, the five-minute rescore's reads, and the bootstrap's own.

### The first minutes after a start (2026-11-13)

Deploys 32 to 35 each had one hold of 5.2 to 6.4 s, somewhere 115 to 304 s after the start, labelled only small
batches of adapter events and a flush. At first it seemed to follow the deploy's check, a fresh browser profile loading
the app; deploy 35 had it at 115 s with the check run only after the ten minutes, so it is not that. On the sealed copy
with the copy's traffic replayed, a fresh browser at four minutes gave a 3.1 s hold on main, as a burst of writes to
the disk makes the hub's fsync of each commit wait behind it (`synchronous` FULL). With NORMAL (#146) that browser's
90 s held the hub 1.2 s in all, 0.34 s at most.

A single hold of seconds made of a few small transactions fits a commit waiting on the disk. In the first minutes after
a start much of the database is written (the triage and attention catch-up, mail's first sync, the embedder) and the
checkpoints copy it back, so an fsync can wait behind a lot. NORMAL takes the fsync out of the commit. To be sure, a
write transaction that takes 500 ms or more is now logged with what it was (`timedWrite`, stalls.ts):
`slow write: 5.6 s in one transaction (adapter events (2))`. It is a transaction of adapter events, a flush, or a triage
decision.

What the profile found besides, each a single statement that reads from the disk when its pages are not in memory
(after a start, or after a new device's first load has read widely):

- **Activity's 90-day walk** read 2,048 messages a page: one page took 2.85 s cold. Now 512 a page.
- **The five-minute rescore** read what to score in three queries before its first slice: 1.96 s cold. Each query is
  a slice now.
- **The first scores at a start** are worked out a slice at a time (#132), but a bootstrap that came first worked them
  all out at once: 1.6–2.0 s at 0 s on the copy and on deploy 35 ("attention: first scoring, attention: rescore all,
  GET /api/bootstrap ×2"). A bootstrap now waits for them.

`test/stalls.test.ts` holds each: the slow-write line, the rescore's three reads a slice each, and a bootstrap that
waits for the first scores instead of asking for them.

With NORMAL and these together, the same six minutes on the copy (a fresh browser at four minutes, profiled, at a low
load) held the hub 24 times for 200 ms or more, 5.6 s in all, the longest 0.32 s; without the test's own bootstrap
polls, 4 times and 1.1 s. What is left is mostly the bootstrap's reads. Whether to move the hub's writes to a thread of
their own: [writer-thread.md](writer-thread.md) (not now; move the bootstrap's build to a reader first).

## The snapshot after each open (2026-11-11)

Opening a conversation saves the device's snapshot 1.5 s later, when the page is idle (snapshot.ts). Opening one marks
it read, which changes `db`, so that save serialized the whole bootstrap again (4.5 MB on the perf world) and stored it
with the rest. Now it writes only the rest, as a record of its own (`rest`, newer than the one beside the bootstrap
when its `savedAt` is), and leaves the stored bootstrap, which carries its own sync position, to the save when the app
goes out of sight, or to the next quiet save once it is ten minutes old. Counted in the page at phone size and 4× CPU
over four opens: main wrote 4,544,244 to 4,655,541 characters per save, 134–156 ms in `JSON.stringify` and 116–154 ms
in the store's `put`, all on the main thread; the branch writes 98,213 to 164,072 characters in 2–6 ms.

## The loading orb (2026-11-11)

`1x.open.first.layouts` read 48–50 on main on 2026-11-11 against the baseline's 17 (#85, 2026-11-10), in two runs of
three at 1×; the counts in CI's smaller world did not move. Two things made it:

- **The orb** (#89, 8245b7b) replaced the timeline's CSS skeleton and spinner. It turned by writing its SVG path's `d`
  every 85 ms, and each write is a style recalculation and a layout: 12 a second for as long as anything loads.
- **The hub stalled** on the two biggest channels (`pickAccount`, above), so their pages loaded for seconds and the
  orb turned all that time. A trace of one first-open pass: 73 frame layouts during the 40k channel's open, 28 during
  the 6,000 one's, each with an "SVG resource invalidated" from Loader.tsx.

The same hub as main before the hub fix (it stalls) with three builds of the web app, one run each at 1×, `--pages 2`,
load about 4: from before #89, 36 layouts on the six first opens; #89, 78; this change, 38. The orb now shows its
frames side by side in a strip (an SVG `<symbol>` for the whole page) and slides it one frame at a time with a CSS
`steps()` animation of `transform`, which the compositor runs without the page: while a timeline's first page was held
back for three seconds at phone size and 4×, 2 layouts and 297–373 ms of main thread, against 42 layouts and 751 ms.
It looks the same: the same 36 frames, 85 ms apart, and the 600 ms dither-in, as a strip of its 16 steps.

## Long lists draw a window (2026-11-11)

The inbox list drew every row it had: 495 on the perf world, 8,756 DOM nodes of the page's 11,018 at phone size,
where a phone shows 11 rows. All of them were built on a cold load, and again each time the list came back (the Home
tab, back from a page or Mail), since a phone's page replaces the list. The people list and the rail did the same.
Each now draws its first 60 rows (`ui/more.tsx`, `FIRST_ROWS`) and 100 more whenever the view comes within 1,200 px of
the last one drawn, so scrolling reaches every row (checked to the end: 495 inbox rows, 174 rail entries, All
communities last).

Phone size (390 × 844), 4× CPU, one run each, the branch first (load 15, then 11 and 33 for main):

| | main | windowed |
|---|---|---|
| cold load: list painted | 5,206 ms | 1,564 ms |
| its main-thread time, longest task | 7,056 ms, 2,567 ms | 1,866 ms, 442 ms |
| its DOM nodes | 11,018 | 2,124 |
| back to the list with the Home tab: longest task | 1,632 ms | 277 ms |
| back to the inbox from Mail: longest task | 1,062 ms | 73 ms |
| flicking the inbox list: frames over 33 ms, the longest | 4, 167 ms | 0, 17 ms |
| flicking the people list: frames over 33 ms, the longest | 8, 300 ms | 1, 67 ms |

The baselines' DOM node counts moved by hand: `cold.nodes` 11,402 to 2,562 and `long.reopen.nodes` 16,984 to 8,133
(desktop, full size), and in CI's 2,353 to 2,111 and 7,875 to 7,634.

CI's `1x.cold.layouts` is no longer judged (`"gate": false`): its first run of this change read 12 against 9, and runs
of main and branches of it had read 9, 9, 9, 10, 10 and 11, more than a steady tally spreads. Traced on CI's world, a
cold load lays out the same 15 times for either build, then a varying few more as Catch up's cards fill in.

## Fetching ahead and kept pages (2026-11-11)

Asked: open the conversation or person you are likely to open next at once, from the device, even right after a
start or while the hub restarts, without hammering the hub or the phone's data.

**What there was.**

| | |
|---|---|
| Message pages | asked of the hub on open: `GET …/messages?limit=60` after the socket is open, then the network's latest (`POST …/history`). Nothing fetched before a click |
| The snapshot | the bootstrap, the inbox and the newest 40 messages of the 12 conversations opened last, in one record that was written whole after every open; a kept one opened at once and caught up with a delta |
| The service worker | the shell (index.html and this build's assets), cache first; nothing of the API or `/media` |
| The hub's headers | `/assets/` a year, immutable; index.html and other static files `no-cache`; `/media` and `/emoji` 7 days (files on disk without `immutable`); the API none |
| Android | the WebView's defaults (HTTP cache on, `LOAD_DEFAULT`, the service worker works); its own cache is only for notification pictures. A WebView's HTTP cache is one small fixed-size cache for everything the app loads |

**Gaps**: a conversation not among the last 12 opened always waited for the hub, after a start too; pictures lived
only in the HTTP cache; a kept page whose catch-up got no answer while the socket stayed up stayed stale until the next
reconnect; and nothing measured how often an open came from the device.

**What changed** (#104, #106, and this):

- **Pictures** ([files.md](files.md#serving)): `/media` and `/emoji` a year, immutable (a signed path stands for one
  stored URL's bytes for good); untyped bytes a day. The service worker keeps images up to 512 KB in a cache of its
  own, at most 4,000 or 64 MB, oldest out first, and answers from it first; those of an account that left go.
- **Kept pages** ([sync.md](sync.md#kept-pages)): a record per conversation in IndexedDB, 60 at most (3 million
  characters), least recently used out first, written only when its messages changed and parsed only when opened. A
  catch-up that got no answer tries again by itself.
- **Fetching ahead** (`prefetch.ts`, `ahead.ts`): the first 12 rows of the inbox (conversations, and a person's chat
  of several routes as the one timeline it opens) in its own (learned) order,
  once the hub's data is in and again as the order changes. Those not held are fetched as Catch up's cards are (what
  the hub stored, no network history); those kept on the device are caught up with a delta, so the open shows what is
  there now. One page at a time, 1.5 s after the last touch or key and when the page is idle, never while out of
  sight, on Save-Data, a cellular network or 2G, at most 30 pages in ten minutes; then the avatars and small images of
  each page (at most 12). A row or person pressed (a mouse at once, a finger after 40 ms unless it turns into a
  scroll) or rested on by a mouse for 120 ms is fetched at once, within a budget of its own. Fetched pages are kept
  like opened ones, so the next start has them; at most 24 fetched and not opened stay in memory, since each one in
  memory is in every reconnect's catch-up (the hub reads 100). The page counts where each open came from
  (`window.__ditherAhead` under `?perf=1`).

**Choosing how many** (`bun scripts/inbox-replay.ts … --prefetch`, a copy of the live database, 9 days, 521 chosen
opens): every open against the pages a device keeps (the most recently used) and the first k rows of the learned order
fetched ahead while the app was in use just before (not after a tap on a system notification, which may wake it from
the background). A first page of 40 messages is 4.7 KB on the wire as zstd (median; mean 5.9 KB, p90 10.4 KB).

| kept | ahead | from the device | pages fetched ahead a day |
|---|---|---|---|
| 12 (before) | 0 | 60.5% | 0 |
| 40 | 0 | 77.5% | 0 |
| 40 | 12 | 83.5% | 6 |
| 60 | 0 | 80.2% | 0 |
| **60** | **12** | **86.2%** | **5** |
| 60 | 20 | 89.4% | 10 |
| 100 | 20 | 90.8% | 9 |

Keeping more is most of it; fetching ahead adds 6 points at 12 rows and 9 at 20. With 12 kept, fetching more than 8
ahead does worse: what it fetches pushes out what you opened. Pages fetched a day are counted only at the moments you
opened something, so the real number is higher, but each is a few kilobytes. 12 rows ahead and 60 kept.

**Measured** (verify-perf's `ahead` pass: a phone's size, an 80 ms link at 20/10 Mbit/s, medians of three runs; the
machine's load was 20 to 70, so the times are rough and the counts are what holds):

| | CI's world, 1× | full size, 4× |
|---|---|---|
| fetched ahead on a cold load: pages, requests, bytes | 12, 12, 17.9–23.3 KB | 12, 12, 26–32 KB |
| the first five rows opened: from what was fetched ahead | 5 of 5 | 5 of 5 |
| …time to their newest message, median (without fetching ahead) | 42 ms (175 ms) | 311 ms (363 ms); runs 303–405 (282–602) |
| the next three right after a relaunch: from the device | 3 of 3 | 3 of 3 |
| …time, median (without) | 40 ms (137 ms) | 311 ms (402 ms); runs 213–486 (350–493) |

What fetching ahead saves is the wait for the hub over the link: about two round trips and the page, more when the
hub is slow, as right after it restarts. What is left at 4× is the first render of a conversation's page, the same
either way.

Not done:

- The hit rate is the replay's and the demo world's. The page counts its own (`__ditherAhead`), but nothing reports it
  to the hub; the activity log's visits could carry where each open came from.
- Fetching ahead is off on a cellular network, so a phone away from Wi-Fi gets only its kept pages.
- Changing the hub (Android: Settings, Use another hub) leaves the old hub's kept pages and pictures on the device,
  in that origin's storage, until Android clears it; removing them needs the app (`WebStorage.deleteOrigin`), a new APK.
- Kept pages among the first rows are caught up ahead one `POST /api/sync` each (about 330 bytes); one request for
  all of them would do.

## First opens draw in slices (2026-11-11)

The phone audit left a person's page, Mail and the You tab with a long task of 0.2–0.7 s on their first open at 4×,
and a slow frame in the first flick up a long timeline. Traced at phone size and 4× (scripts/browser.ts with the
DevTools `Tracing` and `Profiler` domains, the profile's samples cut by each long task), on an unminified build:

- **A conversation's page drew its 60 messages in one task.** Most of it was Preact making DOM nodes, about 40 a
  message, and a third of those were the hover bar (quick reactions, reply, forward, more and their icons), which a
  touch screen never shows (`display: none` under `(hover: none) and (pointer: coarse)`). The person's page is one
  conversation's page; the Home tab after another tab draws the list and the conversation that was open again.
- **Lists drew 60 rows at once** (#101): the inbox and People, where a phone shows 11–14.
- **You drew every Settings section**, 1,600 nodes, then laid them all out in the next task.
- **Mail measured its chip row in a layout effect**, which laid out the whole page inside the task that drew it.
- **The flick's slow frame was not the timeline.** The open marks the conversation read 300 ms after it draws, and the
  rail and the app's badge then worked everything out again: the walk under each of 1,100 servers for their unread
  counts and activity, and each unread conversation's notification level (model.ts). That is the next section.

What changed:

- **A timeline draws in slices** (`packages/web/src/slices.ts`): its newest 15 messages when it shows, then 15 more each
  time the page is idle, up to its window of 150. Until the drawn ones fill the view, a slice more before it is
  painted. Nearing the top of what is drawn draws the next slice at once, and an older page from the hub comes in the
  same way, a slice at a time. Counted from the newest end, so a message arriving or a page coming in moves nothing
  drawn. A slice drawn above holds the first message in view where it is: the first one drawn can lose its name line
  to the message drawn before it (grouped with it), and holding that one moved the view by a line (one older page of
  five, in CI's world, until it was the one in view).
- **No hover bar on a touch screen** (`touchOnly`, phone.ts), nor the time's tooltip: a long-press opens the same
  actions. The open timeline went from 4,700 DOM nodes to 3,000.
- **Long lists draw a screenful first** (ui/more.tsx): rows for the screen's height (the screen's, since reading the
  window's while drawing lays the page out), the rest of the first 60 once the page is idle, then 100 at a time as
  the view nears the end, as before.
- **Settings draws what is below the first screen once it is up** (ui/Later.tsx), in four parts, one per idle
  moment. Going to a section (the desktop's list, the phone's Sections sheet, the links to Adversarial features and
  Indexing) draws them all first.
- **Mail's chunk loads while the app is idle**, three seconds after it starts (Rail.tsx), as the palette's does: a
  phone has no pointer to hover the rail with. Mail opening on its first chip no longer measures the chip row before
  it is painted (a ResizeObserver sets its edges once it is laid out).

Phone size, 4× CPU, the phone pass of `verify-perf --cpu 0 --phone-cpu 4`, five runs each on the same machine, the
branch first (load 7–11), then `main` (11–27): medians, and the spread of the longest task.

| first open | longest task, main | this | main thread, main | this | DOM nodes, main | this |
|---|---|---|---|---|---|---|
| a conversation (the biggest channel) | 490 ms (426–572) | **137 ms** (108–181) | 1,535 ms | 773 ms | – | – |
| Catch up | 183 ms (172–217) | **103 ms** (94–125) | 948 ms | 533 ms | 2,562 | 2,563 |
| You | 167 ms (156–207) | **56 ms** (53–98) | 669 ms | 529 ms | 1,645 | 1,645 |
| the Home tab, after You | 485 ms (464–587) | **133 ms** (93–172) | 967 ms | 619 ms | 4,703 | 3,023 |
| People | 211 ms (190–264) | **125 ms** (89–142) | 657 ms | 431 ms | 4,564 | 2,884 |
| a person's page | 223 ms (201–290) | **69 ms** (55–74) | 715 ms | 542 ms | 4,546 | 2,806 |
| Mail | 162 ms (139–241) | **73 ms** (62–101) | 469 ms | 384 ms | 3,661 | 1,921 |
| the flick up its timeline | 0 ms (0–0) | 66 ms (0–70) | | | | |

`main`'s runs met more load than the branch's. Three runs each an hour earlier, at a load of 11–13 for both, moved
less and not all one way: the open 234 → 177 ms, the Home tab 237 → 170, the person 115 → 74, You 112 → 75, but
Catch up 99 → 164, People 108 → 130 and Mail 85 → 110, with more main-thread time on the branch. Traced at a load of
7–13 (one run each, the CPU profile cut by long task), the branch was shorter on every one: the open 350 → 134 ms,
Catch up 112 → 91, You 115 → 52, the Home tab 295 → 102, People 136 → 91, Mail 270 → 88. Times on this shared machine
move by tens of percent between runs; the DOM nodes, renders and the traces' make-up of each task do not.

The longest task left in most of them is the frame's layout after the first slice is drawn (Next, below). The flick's
task is the rail, the badge and the list drawn again after the conversation is marked read, 300 ms after it last
drew: the same work `main` does (without the walk under every server since the next section), which the slices move
later, into the flick. Messages are drawn once each (61 for 60: the first one drawn is drawn again when the one before
it comes, to group with it).

The layouts went up: each slice is one, so a first open has three or four more on a phone and on a desktop. On a
phone, messages and rows off screen skip their layout (`content-visibility`), so a slice's layout is small; on a
desktop it lays out only the slice's own messages above the view. CI's baseline was set by hand for these
(`perf-baseline-ci.json`'s note), and the changed layout tallies are printed, not judged, until five runs on GitHub's
runners show how they spread.

## What depends on what is where (2026-11-11)

model.ts memoizes on `dataVersion`, which moves with every change: a message arriving, a conversation read. What the
rail and the app's badge show was then worked out again from the start each time, though most of it depends only on
what is where (which servers, channels and threads there are, your rules and settings, the networks' own mutes):

- the walk under each of the world's 1,100 servers for the conversations in it (`convsUnder`), for its unread count
  and its activity, with each conversation's threads sorted on the way;
- each unread conversation's notification level (`effectiveLevel`, 970 of them), for the badge;
- the rail's sort, which looked up each entry's place settings (a string key and a map) in every comparison;
- the map of conversations by their network's id that room links read (`convByNative`), 5,600 entries.

Opening a conversation marks it read 300 ms after it draws, so this ran in the middle of the first flick up its
timeline: the flick's slow frame on the phone pass (a task of 100–120 ms at 4×, more than half of it the rail).
Traced after the change, at a load of 18: the same task 92 ms, the rail 23 ms of it, the walk gone (`metaMemo` 3 ms).

Now those are memoized on `metaDataVersion` (versions.ts), which moves only with `changed('meta')`: names and
settings and what is where, the changes that move `metaRev`. They hold conversations' ids, not the objects (a message
replaces its conversation's object), and what reads the objects (unread counts, activity) is still worked out on
`dataVersion`, from the ids. A notification level that depends on a native mute with an end is kept no later than
that end (`metaMemo`'s `until`). Two kinds of change moved `metaRev` without changing what is where, and now say so
(`changed('shown')`): people's names and pictures arriving with a page of messages, and what a message's reaction row
offers once a conversation's reaction context is known, both of which came with every first open; and a person, or an
account already here, changing (the walk came back once in a trace of Mail's first open, after a meta change this
did not name; these two are the likely ones, not checked).

`test/model-memo.test.ts` holds it: a read changes the counts and the order at once, with the same walk; the walk is
done again on a meta change; a level holds until a rule changes or a mute runs out.

## Next

What these numbers point at, not done yet:

- **The bootstrap is 4.4–5.4 MB**, two thirds of it conversations, and most of those channels nobody has written in.
  On the live hub's copy, leaving out null and default fields saves 25%, leaving out the 3,489 channels without
  messages 43%, both 55%. It needs a snapshot schema change (snapshot.ts keeps the bootstrap as the hub sent it), so
  it is a change of its own.
- **A layout of a new page** is now the longest task of most first opens on a phone at 4×: 70–150 ms for the frame
  after a conversation, the Home tab or People is drawn, 2,000 to 2,500 layout objects, a few hundred of them dirty
  (traced on 2026-11-11). The `.app` element's classes change with every page on a phone (`rest-*`, `narrow`, `tabs`),
  which restyles and lays out the whole tree; scoping those to the parts that move would shrink it.
- **Attention's rescoring of everything** (`rescoreAll`, every five minutes and after the inbox ranking refits) is
  one run of 0.4–0.8 s on the live copy: after a bootstrap's own, the longest hold left after a restart. A sliced one would
  need care where `list()` and `sync` read the views it is writing.
