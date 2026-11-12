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
(the phone pass's throttles, below; `0` leaves it out), `--pages` (older pages to load in the
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
| `home`, `catchUp`, `search`, `you`, `homeTab` | back to the list, then each tab: DOM nodes, App or list renders, longest task |
| `people`, `person`, `mail` | People from the rail, a person's page (the biggest direct conversation's), Mail's list: DOM nodes, longest task, message renders |

Slow frames are a time in all but name (kind `frames`): judged locally like a time, never in CI.

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
out the same in five runs on GitHub's runners (below, "The phone pass in CI").

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

## Next

What these numbers point at, not done yet:

- **The bootstrap is 4.4–5.4 MB**, two thirds of it conversations, and most of those channels nobody has written in.
  On the live hub's copy, leaving out null and default fields saves 25%, leaving out the 3,489 channels without
  messages 43%, both 55%. It needs a snapshot schema change (snapshot.ts keeps the bootstrap as the hub sent it), so
  it is a change of its own.
- **A first open's longest task** is the first render of a conversation's page, 60 messages at once. Drawing the
  newest screenful first would split it.
