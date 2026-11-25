# Performance: measuring load and chat switching

`scripts/verify-perf.ts` times what the app feels like on a hub the size of the real one, and fails when a change
makes it slower. Run it before and after a change that touches rendering, the sync model or the hub's hot queries. CI
runs a small version on every push that judges its counts, never its times ([In CI](#in-ci---ci)), a nightly run keeps
every number at 1× and 4× and shows how they move ([Nightly trends](#nightly-trends)), and ordinary tests
hold sizes and counts of what the hub sends and the web build weighs ([Budgets](#budgets-sizes-and-counts-in-every-test-run)).
`scripts/verify-response.ts` clicks every control on each kind of page and fails on a click that draws a whole list
again ([Every click](#every-click-2026-11-20)).
`scripts/verify-memory.ts` goes round the same pages again and again and fails when what the page holds keeps growing
([Memory](#memory-2026-11-24)).

```sh
bun scripts/verify-perf.ts                 # 3 runs each at 1× and 4× CPU, compared with scripts/perf-baseline.json
bun scripts/verify-perf.ts --update        # the same, then writes the medians as the new baseline
bun scripts/verify-perf.ts --runs 1 --cpu 4 --pages 5   # a quick look
```

Options: `--port` (8620; the hub it starts listens there), `--runs`, `--cpu 1,4` (`0`: no desktop pass), `--phone-cpu 4`
(the phone pass's throttles, below; `0` leaves it out), `--ahead-cpu 4` (the fetching-ahead pass's, below; `0` leaves it
out), `--ahead-rtt 80` (its link's round trip in ms), `--slow-cpu 4` (the slow link's pass, below; `0` leaves it out),
`--slow-rtt 300`, `--slow-down 1.6` and `--slow-up 0.75` (that link's round trip in ms and its Mbit/s each way),
`--slow-queue fair` (or `fifo`: [below](#over-a-slow-link-2026-11-24)), `--pages` (older pages to load in the
biggest conversation, 15), `--web <dist>` (a build to use instead of building one), `--out <file.json>` (every run's
numbers), `--baseline <file>`, `--keep` (leave the temp dir with the world, the build and the hub's log), `--css <css>`
(added to every page, to try a style change without a build), `--work <dir>` (an empty dir to work in instead of a
temp dir, kept afterwards), `--size <w>x<h>` (1280x800; below 700 wide it emulates a phone, as `--size 390x844`),
`--scale` (the world's size against the live hub's, 1), `--ci` (below). For trying a change ([A/B a change](#ab-a-change)):
`--only <pass>[,<pass>]` (`desktop`, `phone`, `ahead`, `slow`), `--ab <distA>,<distB>[,...]`, `--keep-world <dir>`,
`--age <dir>` and `--world <dir>`. `--help` prints the script's own summary.

It takes about eight minutes, three of them the slow link's pass. It builds the web app, seeds a world in a temp dir, starts its own demo hub on it
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
| `home`, `forYou` (`catchUp` before 2026-11-15), `search`, `you`, `homeTab` | back to the list, then each tab: DOM nodes, App or list renders (and the Home tab's message renders: it brings back the conversation that was open), longest task, main-thread time (`busy`) |
| `people`, `person`, `mail` | People from the rail, a person's page (the biggest direct conversation's), Mail's list: DOM nodes, App and message renders, longest task, main-thread time |

Slow frames are a time in all but name (kind `frames`): judged locally like a time, never in CI.

Those passes fetch nothing ahead (`?ahead=0`), so their counts stay what they were. Then fetching ahead
([below](#fetching-ahead-and-kept-pages-2026-11-11)) at a phone's size and over a phone's link (80 ms round trip,
20/10 Mbit/s: on loopback a page from the hub takes no time to come, and fetching ahead saves only that),
`--ahead-cpu` (4× here, 1× in CI), its keys starting `a4x.`:

| metric | what |
|---|---|
| `ahead.pages`, `ahead.pictures`, `ahead.requests`, `ahead.bytes` | a device that never saw the hub loads the inbox and waits until fetching ahead is done: pages and pictures it fetched, its requests and their bytes on the wire |
| `ahead.open`, `ahead.served` | then the first five chats of the inbox (below) open one after another (median time to `dither:timeline`), and how many came from what was fetched ahead |
| `ahead.relaunch`, `ahead.relaunchServed` | the app opened again, and the next three rows open at once, before this start fetched anything: time, and how many came from the device |
| `noahead.open`, `noahead.relaunch` | the same in a browser that fetches nothing ahead (not in CI, which judges no times) |

The eight rows are the first eight chats among the 12 rows fetching ahead takes (`AHEAD`): conversations and people's
chats, in the order on screen; not a channel's row, which can open on a forum's cards, nor mail. Until 2026-11-24 the
pass took the first eight conversations wherever they were, so once people's chats and channels filled the top of the
list the eighth was the 13th row or lower, which nothing fetches ahead: `a4x.ahead.relaunchServed` read 2 in three of
the first nightly's five runs at 4× ("the next three rows were not all kept"), and the same at 1× locally once earlier
runs had moved the order. The app was right; the pass asked it for a row it never meant to have.

`ahead.served` and `ahead.relaunchServed` have floors (`FLOORS`): every open there should come from the device.

Last, a poor phone link ([below](#over-a-slow-link-2026-11-24)): 300 ms round trip, 1.6 Mbit/s down and 0.75 up, at a
phone's size, `--slow-cpu` (4× here, 1× in CI), its keys starting `s4x.`. Every request goes through one link, the
service worker's too, and fetching ahead is on, as in the app. Times are from the page's start.

| metric | what |
|---|---|
| `cold.content`, `cold.fresh` | a device that never saw the hub, not even the app: time to the list shown (`dither:content`) and to the hub's data in (`dither:fresh`) |
| `cold.toContent.*`, `cold.toFresh.*` | requests sent and bytes that reached the browser before each |
| `cold.<kind>.requests`, `cold.<kind>.bytes` | the same before the list showed, by kind: `document`, `script`, `style`, `bootstrap`, `api` (the rest of /api), `pages` (a conversation's messages), `pictures`, `precache` (the service worker's script and every file it keeps), `socket` (the live socket's upgrade and frames), `other` (the manifest) |
| `cold.bootstrap`, `cold.bootstrap.bytes` | the bootstrap on the wire: from asked to its last byte, and its bytes as sent (compressed) |
| `cold.competing.requests`, `cold.competing.bytes` | other requests whose bytes came down the link while the bootstrap was on it, and those bytes (not the socket's) |
| `cold.beforeBootstrap.precache`, `.pictures`, `.pages` | requests of each kind sent before the bootstrap's last byte |
| `open.ms` | then the first conversation in the list opened (to `dither:timeline`) |
| `precache.*`, `ahead.*` | the page stays until the service worker has kept the whole build and taken the page over (`precache.tookOver`, 1; at most 90 s) and fetching ahead is done: the precache's requests, bytes and when its last byte came; fetching ahead's requests and bytes. `cold.stay`: how long the page was open |
| `relaunch.content`, `relaunch.fresh`, `relaunch.fromSnapshot` | the app opened again: times to the list and to fresh data, and whether the list came from the snapshot (1) |
| `relaunch.toContent.requests`, `.answers`, `.bytes`, `.shell` | requests sent before the list showed, how many of them had their answer by then (the socket's health check and the activity report answer on their own while the list is drawn: the list waits on none of them), their bytes, and how many were the app itself (`document`, `script`, `style`): none once the service worker has the build |
| `relaunch.toFresh.*` | requests and bytes before the hub's data was in |
| `socket.resyncs`, `socket.opens`, `socket.drops`, `socket.closes`, `socket.pings`, `socket.pongMax` | over both starts: catch-ups with the hub (a bootstrap, or a sync from the journal: each marks `dither:fresh`) more than one a start, which is what a socket replaced costs (a sync of kept conversations alone is not one); live sockets opened (one a start, one more for a spare that races a late pong: state.ts `probe`), closed by the app (one given up on, or a spare that lost its race), closed from the hub's end, the heartbeat's pings, and the longest wait for a pong (a time). Once the bootstrap's first bytes have come on the cold start the pass sends the page a `focus`, as when someone comes back to the app while it loads, so one ping always goes out while the link is at its busiest |

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
and at most 250 messages drawn on a reopen. Over the slow link: one catch-up a start (`socket.resyncs` 0), and none of the
app's own files fetched on a relaunch; and floors: the service worker took the page over,
and the relaunch drew its list from the snapshot. An `--update` over one of them fails and writes nothing.

## A/B a change

Times on a shared machine move 5–30% between runs, so a change is measured against its base in the same hub, the
runs of each taking turns. Seeding a full-size world takes about 90 s on a loaded machine; keep one and reuse it.

```sh
# Each build into a directory of its own (packages/web, on the base and then on the change):
bunx --bun vite build --outDir /tmp/ab/base --emptyOutDir
bunx --bun vite build --outDir /tmp/ab/cand --emptyOutDir
# Seed once, and keep the world as seeded (a quick desktop run here; any passes will do):
bun scripts/verify-perf.ts --keep-world /tmp/ab/world --only desktop --cpu 4 --runs 1 --web /tmp/ab/base
# Then as often as you like: one hub, both builds in turn, five runs each.
bun scripts/verify-perf.ts --world /tmp/ab/world --ab /tmp/ab/base,/tmp/ab/cand --only desktop,phone --cpu 4 --runs 5
```

- **`--ab <distA>,<distB>[,...]`**: one hub on one world, serving each build in turn from one path (a link swapped
  between runs; the hub reads its files as they are asked for, so nothing restarts). The runs go A B, B A, A B… so a
  hub that drifts from run to run drifts under each build alike: each run's arriving message adds to the long
  timeline (`long.reopen.nodes` comes down by about five a run), and each run's opens move the inbox's order. Every
  run is a fresh browser with an empty profile, as in a normal run, so nothing of one build's device (its kept
  pages, its service worker, its HTTP cache) reaches the next. An A/B takes one warm-up run (`--warmup 1`) with A
  before each desktop throttle, so the first run on a fresh hub, which draws more, is no build's. The output is each
  build's median and range (lowest–highest) for every key, side by side, the difference from A in units and per cent,
  and `p`: an exact Mann-Whitney test of the two builds' runs, how often a random split of them lands as far apart.
  Under 0.05 is marked `*`; with five runs each the least it can be is 0.008 (every run of one build above every run
  of the other), with three 0.1, so take five. Ceilings and floors are judged for every build; no baseline is.
  `--out` writes `{ world, hub, ab: [{ label, dir, metrics, runs }] }`, which perf-trend.ts does not read.
- **`--only <pass>[,<pass>]`**: just those passes (`desktop`, `phone`, `ahead`, `slow`), as if the others' throttles
  were `0`.
- **`--keep-world <dir>`**: after seeding, a copy of the world as seeded, before the hub ever ran on it, with a
  `world.json` beside it: its scale, its day, the counts, the conversations the passes open, and a hash of each file
  that seeds it or lays out its database (perf-world.ts, the hub's demo.ts, store.ts and schemas, the protocol's ids).
- **`--world <dir>`**: a copy of a kept world instead of a seed (the kept one is never touched), in a second or two.
  Refused, never used as it is, when its scale is not this run's (`--scale`), when it was seeded on another day (the
  seed's messages are anchored at the last midnight, so a world kept yesterday is a day older than today's), or when
  one of those files changed; the error says which. The demo accounts date their own messages from when they were
  made (an `epoch` in their settings), so a reused world is given now as that time: what a seed made now would have.
- **`--age <dir>`**: the fetching-ahead pass measures an inbox whose order the passes before it have moved (their
  opens, the messages read, the arriving messages), and in a nightly-like run they take 20–30 minutes. `--age` keeps
  the hub as the ahead pass first finds it: right before that pass, its database copied while it runs (`VACUUM INTO`,
  a consistent copy) with the rest of its data dir, and once the pass's first run has looked, the inbox's first 12 rows
  as it saw them. Run the passes you want it aged by once, then reuse the result for the ahead pass alone:

  ```sh
  bun scripts/verify-perf.ts --age /tmp/ab/aged --cpu 1,4 --phone-cpu 1,4 --ahead-cpu 4 --slow-cpu 0 --runs 5 --warmup 1
  bun scripts/verify-perf.ts --world /tmp/ab/aged --only ahead --ab /tmp/ab/base,/tmp/ab/cand --runs 5
  ```

  An aged world runs only with `--only ahead` (or `ahead,slow`): any other pass would age it further. It is not
  dated again as a kept one is (what the earlier passes did happened when they did), so three things make sure the
  ahead pass measures the order a real run had at that point:

  1. **What a restart takes back is put back.** A real run never restarts its hub; a reuse starts one on the copy, and
     each demo account sends its world again as it starts, with each conversation's read point as the demo began it.
     The hub counts unread again from there: two demo direct chats that a first start leaves with nothing unread come
     back with two and three unread, and one of them jumped into the fourth row. So once the hub has settled, each
     conversation whose read point or unread count differs from the aged copy's is marked read again as the app marks
     it (`POST /api/conversations/:id/read`), up to the copy's read point, or up to its newest message where the copy
     had nothing unread.
  2. **The hub's scores are compared.** The aging run keeps the hub's 40 best inbox scores (the bootstrap's
     `attention`) with the world; the reuse prints any that moved more than a point or left the 40. They drift with the
     minutes since (a reply waited on grows older); the learned order's exploring (docs/inbox.md) does not move them
     here, since a seeded world has no opens old enough for the order to have learned from, so it samples nothing.
  3. **The rows are checked.** The ahead pass's first run must find the same 12 rows in the same order as the run that
     aged the world did, or the script stops, prints both lists and the scores that moved with their reasons, and says
     to age it again.

  Tested on 2026-11-24 ([below](#ab-a-change-tested-2026-11-24)).

### A/B a change: tested (2026-11-24)

On this machine with other agents' runs beside it (load average 8 to 42), a full-size world:

- **Keeping and reusing.** The kept world is 232 MB; a copy takes 0.1–3.5 s, against about 90 s to seed. The hub then
  starts in 3–7 s on a quiet machine and took 18–27 s at load 20–27 (its `startup:` line: models 8.2 s, adapters 4.4 s,
  first scoring 4.3 s, against 2.0, 0.7 and 0.2 s quiet). That went past the 30 s the script used to give a hub to
  answer in 6 of 14 starts; it now waits until the hub answers or its process ends (three minutes at most),
  and shows the end of its log when it does not.
- **Main against itself** (two copies of one build, `--only desktop,phone --cpu 4 --phone-cpu 4 --runs 5`): every count
  and tally the same; of about 150 keys, 2 had `p` under 0.05 (`p4x.typing.keyMax`, `p4x.you.busy`), fewer than chance
  gives one time in 20. Times were wide: the desktop's cold load 2.0–10.1 s in one build's five runs.
- **Main against a build that waits 200 ms before its first draw** (a busy loop before `render` in main.tsx), the same
  settings: the relaunch's longest task 337 → 551 ms (p 0.01), its list 630 → 841 ms (p 0.10), and App renders on a
  cold load 2 → 3 in every run (p 0.01). The cold load's list did not move (2,352 → 1,849 ms, p 0.22): since the
  bootstrap is asked for from `index.html` the first draw happens while it is still coming, so 200 ms there is off the
  critical path. On CI's tenth-size world at 1× the same build moved the cold list 466 → 766 ms (two runs each).
- **Aging.** On a tenth-size world (aged after `--cpu 1 --phone-cpu 1 --runs 2`) the first reuse found the demo's two
  chats unread again and one at the fourth row, and stopped; with them marked read again, reuses found the aging run's
  12 rows, and the second run's bytes fetched ahead matched the aging run's (23,173 and 20,706 against 23,172 and
  21,175). At full size (aged after `--cpu 4 --phone-cpu 4 --runs 1 --warmup 1`) the reuse found the same 12 rows and
  the hub's scores at the moment the page read them were the aging run's to the decimal. One earlier full-size aging
  did not: the phone pass's last visit, which its browser sends as it closes, reached the hub after the aging run's
  ahead pass had drawn its list, so the copy (which had it) put that chat third. The reuse stopped, as it should; aging
  now waits for the hub's journal to stand still before it copies.

When the ahead pass's check that the next three rows were kept fails ("the next three rows were not all kept"), it
prints what the device had: the rows it wanted, the first 20 rows on screen, each marked `K` when its page is in
IndexedDB and `F` when it was fetched ahead, the pages fetched ahead and where the opens came from, and every key in
the page store.

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

Last comes the slow link's pass (`s1x.`), once at 1×, about 21 s more (the job took about 2 min 10 s on 2026-11-24,
against its 10-minute limit); most of it is the precache, 1.35 MB over 1.6 Mbit/s. Five runs on GitHub's runners
(dispatched on its branch, 2026-11-24) set what is judged: 28 of its 55 numbers (with `socket.resyncs`, added by hand at 0). Judged: requests of each kind before
the list showed, the bootstrap's bytes, how many requests came down beside it, the socket's opens, drops, closes,
pings and extra catch-ups, and the relaunch's requests, answers and bytes before the list and requests before fresh data. Printed only:
every time; bytes that are the build's own sizes (scripts, stylesheet, index.html, the whole precache and its file
count), which budgets.json holds with reasons; and what moved with timing, such as the requests before the list (26 to
29) and the precache's requests before the bootstrap's end (7 to 9).

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

## Nightly trends

CI judges counts at 1× on a tenth-size world and never looks at a time, so a slow creep passes every check, and the
counts at 4× (renders batch differently on a slow CPU) were only ever looked at by hand. So once a night
`.github/workflows/perf-nightly.yml` runs verify-perf at both throttles and keeps what it measured:

```sh
bun scripts/verify-perf.ts --scale 1 --runs 5 --warmup 1 --cpu 1,4 --phone-cpu 1,4 --ahead-cpu 1,4 --slow-cpu 4 \
  --baseline <none> --out out/perf.json
```

The slow link's pass ([Over a slow link](#over-a-slow-link-2026-11-24)) runs at 4× only: its waits are the link's,
about a minute a run at full size, and 1× is what CI runs.

Then the memory check ([Memory](#memory-2026-11-24)) at full size and 4×, so a leak too slow for CI's six rounds on a
tenth-size world shows as a line that climbs night after night:

```sh
bun scripts/verify-memory.ts --scale 1 --cpu 4 --cycles 10 --phone-cycles 10 --out out/memory.json
```

A count it would fail on is a warning here, like verify-perf's ceilings; its numbers are recorded all the same, as
`memory.<pass>.<count>.growth` (round 2 to the last) and `.last`, the heap's growth as `memory.<pass>.heap.perRound`
(bytes a round), and the hub's resident memory as `memory.hub.rss.before`, `.after` and `.peak` (in MB). It adds
about 5 minutes on a standard runner: under a minute to build and seed, a warm-up round of about 40 s, then 22-25 s a
round on the computer and 18-20 on the phone, side by side (the first nightly run, 2026-11-24).

- **When:** 04:41 UTC every night on main (stress.yml runs at 07:17, android-device.yml at 09:23), and by hand from
  Actions > Perf nightly > Run workflow, which asks for the world's size, the runs, and whether to record the run.
  The measuring takes about 23 minutes on a standard runner (4 cores) and the memory check about 5 more.
- **Never red on a number.** It has no baseline: nothing is judged, and a ceiling or floor verify-perf reports is a
  warning on the run. It fails only when measuring breaks (the build, the hub, a page that never answers).
- **History:** each night is one JSON line on the `perf-history` branch (`history.jsonl`; a branch of data only,
  never merged): the date, the commit, the runner (CPU, cores, memory, image, browser), the settings, the world's
  counts, and every metric's median with the lowest and highest of its runs. A run on main is recorded; a run by hand
  on another branch only when asked (`record`), else it goes in the summary only. Only the small job that adds the
  line has write access to the repository; the one that runs the browser can only read.
- **What it shows:** the job's summary has the last night against the medians of the 7 and 30 nights before it
  (nights run with the same settings), flagging a time that moved more than 15% from the 7 nights' median (and 5 ms,
  or 2 slow frames), and a count, tally or byte size outside every value those 7 nights' runs came to: a count that
  never moves flags on any move, and one whose runs spread by themselves (the bytes fetching ahead pulls: 22 to 32 kB
  in one night) only when it leaves that spread. Then the counts that came out different at 1× and 4×; then every
  metric. Flags only: the job stays green. The artifact `perf-trend` is a page of small charts, one per step and
  pass, a line per throttle (the memory check's: one per count, a line for the computer and one for the phone),
  each night's median with the band of its runs, that needs nothing from the network
  (light and dark). The artifact `perf-night` has the night's line and verify-perf's and verify-memory's whole output.
- **No key list.** `scripts/perf-trend.ts night` records whatever is in `out/*.json`: a new verify-perf metric is
  recorded and charted the first night it appears. Another script's numbers are one line in the workflow, the script
  writing `out/<name>.json` as `{ "metrics": { "<key>": { "v": 12, "kind": "ms", "runs": [11, 12, 14] } } }`
  (verify-perf's own `--out` shape); its keys are kept as `<name>.<key>`. A kind of `ms` or `frames` is a time, any
  other a count.

The same page from the history, locally:

```sh
git fetch origin perf-history
bun scripts/perf-trend.ts report --html /tmp/perf-trend.html      # the table on stdout, the charts in the file
bun scripts/perf-trend.ts report --history <file.jsonl>             # a history of your own
```

Why the full-size world: on 2026-11-24 the same run took 18 minutes at a quarter of the size and 20 at full size (the
runs mostly wait for the page to settle), and only the full size has what a slow creep would show first: a bootstrap of
4.5 MB rather than 1.2 MB, conversations of 80,000 messages, and an arriving message that keeps the main thread busy for
63 ms at 1× rather than 23. Its counts also compare with the local baseline's (`scripts/perf-baseline.json`); its times are of another machine.

The first night (2026-11-24, medians of five on a 4-core runner):

| | 1× | 4× |
|---|---|---|
| desktop cold load, list painted | 587 ms | 1,340 ms |
| desktop first open (median of six) | 61 ms | 211 ms |
| desktop message arriving, main thread busy | 63 ms | 205 ms |
| desktop relaunch, list painted | 193 ms | 606 ms |
| desktop an older page | 57 ms | 318 ms |
| phone cold load | 516 ms | 1,306 ms |
| phone opening the biggest channel | 113 ms | 403 ms |
| phone keystroke to frame, p90 | 11 ms | 25 ms |
| phone, first five rows opened with fetching ahead (without) | 39 ms (147) | 148 ms (268) |

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
- Also with `?perf=1`, `window.__ditherPerf.components` counts every component's renders by its name, from preact's
  own render hook: `mounts` (first renders), `updates` (renders again), `live` (how many are on the page) and
  `again` (how many of those on the page at `__ditherPerf.fresh()` rendered again since, each counted once however
  often). A build
  with `--minify false` keeps the names; a minified one counts the same under short ones. Without `?perf=1` the hook
  is not installed.

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
  `test/inbox-plan.test.ts` checks the plans. Alerts and Conversations still sorted every one ever (the prune keeps
  them): 50 ms on the perf world and 250 to 370 ms on a copy of the live hub by 2026-11-24, growing. Their decisions
  now keep the message's time (`triage.message_ts`), and a partial index on it (`triage_notified`) lets that pick
  stop at its limit too: 2.5 ms and 4 ms, the whole inbox 93 to 41 ms on the perf world.

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
  deleted message's "ago" is a small component that still reads `rev`. An inbox row's "5m" and its ↩ and how long
  read `minute` (versions.ts), which moves once a minute while the page is shown and again when it is shown: a message
  or a visit draws its own row's time, not every row's. Rows get the same `onClick` each time (`opener` in
  Sidebar.tsx), and people rows their `directs` as a prop. The click check (below, "Every click") found more lists
  drawn whole, and these are memoised too: each inbox row with its ↩ button (`InboxRowView`; the inbox makes its rows
  again for each change, so a chat row is compared by its person and routes), the rail's places (Rail.tsx: the rail
  works out which is open and its counts and passes them in, so going somewhere draws the place left and the place
  opened), a server's channel rows (`ChannelRow`, given its threads, and the open conversation only when it is one of
  them, with one opener per tree) and the directory's cards (keyed, and compared field by field). What a parent hands a
  new object each time and that reads more than its props is memoised on what it shows (`memoOn`, a string it works
  out): a status dot (its person's state and tooltip, so a presence frame draws only the dots it changed, and a row
  drawn again does not draw its dot) and a profile's place pictures. A profile's Activity card compares its props by
  value and reads `minute`, not `rev`, so a nickname or a message leaves it alone.
- **Batched**: the signals move once the task that changed things is done (a timer), not on every change. Once per
  animation frame measured worse: the render then ran in the same task as the frame's layout and paint, and the
  longest task of a first open went from about 320 to 512 ms at 4×; a hidden page gets no frames either.
- **A window on long timelines** (Timeline.tsx). A timeline draws its newest 150 messages (`WINDOW`); the rest stay
  in memory. Nearing the top of what is drawn draws 100 more from memory, keeping the message that was first where it
  was, and only at the oldest held does it ask the hub for an older page, which is then drawn whole with everything
  above it. Back at the newest, it draws only the newest 150 again (what goes is above the view). A link to a held
  message (`?m=`) or a click on a reply's quote draws the 100 around that message and shows it; scrolling down from
  there draws more until the newest. A quoted message not held is fetched with the page around it, in the same view
  (`jumpTo`; `jumpInChat` in a person's chat), as a link to it is: the chat's address does not change. The first message drawn gets its day line and is not grouped, as the first
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
gave it (`js/shared/startup`).

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

### The startup chunk (2026-11-14)

Everything the entry imports statically, however deep, is one chunk, `shared/startup` (vite.config.ts, a
`codeSplitting` group on rolldown's `$initial` tag), with the stylesheet beside it: the startup set is four files (the
entry, rolldown's runtime, that chunk, its stylesheet). Before, a 34-file import cycle among the components (menus,
bits, Sidebar, ContextMenu…) made rolldown keep them in one shared chunk; once the cycles were gone
(docs/testing.md "Import cycles") it split the startup modules by which lazy chunks share them, into 34 files, every
one of them loaded at startup anyway. The group puts them back together: 1,072 KB (326 KB gzip) in 4 files, against
1,079 KB (335 KB gzip) in 10 on main the day before. A lazy chunk imports what it shares with startup from that chunk,
already loaded. A module only lazy chunks use is not in it.

### Left out of the first load (2026-11-24)

Coverage of a cold load (the DevTools protocol's precise coverage, mapped back through the source map) found three
quarters of the startup chunk never ran before the list showed. The biggest share no first screen uses were whole
pages, and those are now chunks of their own (ui/LazyPane.tsx `lazyPane`): a person's profile, a place's page,
Settings, the directory and How it sorts. Each loads when it is first opened, and all of them a few seconds after the
hub's data is in, one per idle moment, so a first open is drawn at once as before. Going to one of Settings' sections
(its nav, Adversarial features, Indexing) waits for the section to be drawn (bits.tsx `showSection`). The list of
sections, which the nav beside Settings reads, is in ui/settingsSections.ts.

Full-size world, 4× CPU, main against this, interleaved, medians of seven (the machine's load was 6 to 20, so the
times are rough; the bytes are exact):

| | before | after |
|---|---|---|
| `shared/startup` | 1,050 KB (352.6 KB gzip) | 857 KB (292.5 KB gzip) |
| desktop: list painted | 2,078 ms (1,776–2,431, and one stall of 17 s) | 1,960 ms (1,650–2,577) |
| desktop: script run before the list | 740 ms (652–925) | 697 ms (565–916) |
| phone: list painted | 2,740 ms (2,316–4,760) | 2,431 ms (1,809–3,963) |
| first open after a cold load, desktop: Settings, How it sorts | 180, 391 ms | 149, 308 ms |

Then the layers that draw nothing until they are opened: the picture and file viewer (Viewer.tsx), the index dialog
(Indexing.tsx; what the menus ask of it, whether a place can be indexed and opening the dialog, is in indexjobs.ts)
and Organize (OrganizeServers.tsx; the sort menu and the rows' slides stay in Reorganize.tsx). They load with the
pages, and a layer opened before its chunk is here shows a moment later. `shared/startup`: 857 KB (292.5 KB gzip) to
817 KB (279.2 KB gzip).

Then the conversation itself (Timeline.tsx, with the composer, attachments, pictures and the rest only it uses: a
chunk of 94 KB, 33 KB gzip). No first screen draws one (a phone starts on the list, a desktop on For you), but the next
tap usually opens one, so its chunk loads at once when the hub's data is in, or at the first tap or key if that comes
sooner (`whenTouched`), not at idle: loaded at idle, a conversation opened as the list came took twice as long, its
first page asked for only once the chunk was here. A start straight into a conversation (a link, a notification) loads
it as the app draws. `shared/startup`: 817 KB (279.2 KB gzip) to 718 KB (245.6 KB gzip).

The three together, main against this, full size, 4×, interleaved, medians of ten (load 6 to 12; the bytes are exact,
the times rough):

| | main | after |
|---|---|---|
| startup set | 1,332 KB (406.7 KB gzip) | 1,000 KB (299.7 KB gzip) |
| desktop: list painted | 3,006 ms (1,554–7,096) | 2,005 ms (1,590–6,027) |
| desktop: script run before the list | 737 ms (542–1,245) | 657 ms (510–908) |
| desktop: a conversation opened as the data came in | 758 ms (657–1,229) | 584 ms (432–1,240) |
| …opened 1.5 s later | 464 ms (330–1,284) | 355 ms (351–483) |
| phone: list painted | 2,470 ms (1,508–6,428) | 1,966 ms (1,458–6,900) |
| phone: script run before the list | 760 ms (592–1,551) | 619 ms (539–833) |
| phone: a conversation opened as the data came in | 644 ms (586–707) | 667 ms (607–738) |
| …opened 1.5 s later | 466 ms (396–1,448) | 419 ms (414–525) |

Then what the sidebar and App used of three files that are otherwise a conversation's or a layer's. The inbox's mail
chips and tiles are in ui/MailLists.tsx (and MailLists.css), the rest of mail in a chat (MailChat.tsx) went into the
conversation's chunk; a merge suggestion's picked pair and where it came from are in pairpick.ts, the page itself
(Pairs.tsx) went with the conversation too; the reaction picker and who reacted (Reactions.tsx) are a layer loaded with
the pages, and the emoji catalog still loads 4 s after start, as before. `shared/startup`: 718 KB (245.6 KB gzip) to
665 KB (228.3 KB gzip); the conversation's chunk grew from 94 KB to 128 KB (33 to 44 KB gzip).

Against the step before, full size, 4×, interleaved (load 9 to 22, so the times are rough): on a phone, medians of
twelve, the list painted at 2,447 ms (2,004–6,844) instead of 2,659 ms (2,074–10,827), with 2,050 ms of main-thread
work before it instead of 2,341; on a computer, in the seven pairs not overlapping a build, sooner in all seven (median
1,792 ms against 2,144). A conversation opened as the data came in or 1.5 s later was as fast as before (each of the
two quicker in half the pairs or more, within noise).

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
Since 2026-11-12 every hold of 200 ms or more, at any time, is also recorded with the spans on the thread and the
process's CPU time and page faults (`traces/event-loop-stalls.ndjson`, docs/tracing.md).

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
  transaction, and the frame goes to devices after the commit. It begins with the write lock (`BEGIN IMMEDIATE`):
  begun as a read, a commit from another connection between its reads and its first write failed it at once with
  `SQLITE_BUSY_SNAPSHOT`, which busy_timeout does not wait out.
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

### Mail's body cache, every six seconds (2026-11-13)

With NORMAL live (deploy 36) the ten minutes still read 113 holds of 200 ms or more, 79 of them 500–700 ms, and they
came every 5.9–6.1 s. That is mail's body cache (`mail/cache.ts`): each body the keep-all archive fetches (about one a
second) asks for a sweep 5 s later, and a sweep took 480–560 ms on a copy of the live database, where nothing was over
either cap:

- **The bodies too big to cache** were found with `keep = -1 AND used_at < ?` by the `used_at` index. Every body was
  older than ten minutes, so it read all 14,199 rows. `keep` is the last column, after the text and the html, so each
  read went through the body itself (519 MB), once to list them and once more to delete them: 175 ms each. A partial
  index on just those (`mail_body_big`, schema-big.sql) finds them in 0–2 ms. On the live hub there are none.
- **The caps** added up every row's bytes, bodies and search text, for the accounts that do not keep all their mail.
  On the live hub that is no account, which took 120 ms to find out. When every account with mail keeps all of it, the
  sweep now says 0 without adding up.
- The sweep notes itself (`mail: cache sweep`). Mail's other work that an answer from its backend sets off is noted
  and logged as `slow: <time> in <what>` past 500 ms: pages of summaries, bodies, its events.

The first sweep after a start reads those bodies from the disk, not from memory. It comes 5 s after the first body the
archive fetches, which can be minutes after the start. That is likely the single 5.6–6.4 s hold of every deploy's first
minutes, labelled only with the small adapter batches around it. The partial index removes that read as well.

On the copy, a body about every second through the hub's own MailStore and BodyCache, for 46 s:

| | main | this |
|---|---|---|
| holds of 100 ms or more | 8 (1,237 ms, then 460–520 ms, every ~6 s) | 0 |
| one sweep | 480–560 ms | 3–4 ms |

The index is new in the mail schema, so the first start with it copies the database aside before migrating (the
`pre-migrate copy` in the startup line, 7–26 s on the live hub). `test/stalls.test.ts` checks the plan, and that a
sweep with every account keeping all its mail adds up nothing.

## The snapshot after each open (2026-11-11)

Opening a conversation saves the device's snapshot 1.5 s later, when the page is idle (snapshot.ts). Opening one marks
it read, which changes `db`, so that save serialized the whole bootstrap again (4.5 MB on the perf world) and stored it
with the rest. Now it writes only the rest, as a record of its own (`rest`, newer than the one beside the bootstrap
when its `savedAt` is), and leaves the stored bootstrap, which carries its own sync position, to the save when the app
goes out of sight, or to the next quiet save once it is ten minutes old. Counted in the page at phone size and 4× CPU
over four opens: main wrote 4,544,244 to 4,655,541 characters per save, 134–156 ms in `JSON.stringify` and 116–154 ms
in the store's `put`, all on the main thread; the branch writes 98,213 to 164,072 characters in 2–6 ms.

### The first snapshot (2026-11-24)

On a device that keeps nothing yet (a first start, or a deploy that changed the protocol) the hub's first answer is
written at once, since until it is an offline start has nothing to show. Storing it is one `put` of the 4.5 MB text,
which the page holds as a two-byte string (a name with an emoji in it is enough), and IndexedDB's copy of it holds the
main thread: 61–77 ms at 4× in a cold load's CPU profile, while the list was still being drawn. It is now written at
the first idle moment within a second (`FIRST_WITHIN_MS`), and leaving the page writes it as before.

Storing it as a Blob instead takes no time in the `put`, but reading it back on a relaunch (`blob.text()`, 56–72 ms
on the main thread) costs what reading the string does (44–62 ms), and making a Blob or bytes from the string costs
80–95 ms: measured in Chrome at 4× on the perf world's bootstrap, seven rounds. So the format stays.

Six and two cold loads of each at 4× on the full-size world, interleaved, on a machine at load average 30–130: from
the hub's answer to the list, medians 1,540 → 1,210 ms and 1,161 → 826 ms, shorter in 7 of the 8 pairs. Relaunches
read the snapshot as before (written when the page was hidden).

## Fonts at the first layout (2026-11-25)

On Linux, Chrome's page asks the browser process for each font family by name, and the browser process asks
fontconfig; the page waits for the answer. A trace of a cold load at 4× on the full-size world (the `fonts` and
`disabled-by-default-fonts` categories: `FontDataManager::onMatchFamilyStyle` names each family) showed 14 lookups
before the list showed, 107–150 ms of the main thread with the fontconfig fallback and the per-size render settings:

- `ui-sans-serif`, the stack's first family, is a real family only in Safari. Chrome looks it up as a literal name,
  finds nothing, and does so once per weight: four lookups, about 30 ms. `system-ui`, next, gave the desktop's font.
- One emoji on screen (a ❤️) sends Chrome down the rest of the stack for that character: `-apple-system`, `Segoe UI`,
  `Roboto`, `Helvetica Neue`, `Arial`, then its standard font, each a lookup (about 25 ms), then fontconfig's search
  for a font that has it (`GetFallbackFontForCharacter`, 25–32 ms the first time, nothing after).
- The monospace stack is first looked up after the list shows; the emoji pickers' stacks only when one opens.

`--font` is now `system-ui, sans-serif`, which is the font the old stack showed wherever `system-ui` is known (every
current browser): San Francisco on Apple's systems, Segoe UI on Windows, Roboto on Android, the desktop's font on
Linux. In headless Chromium on Linux every text node on screen renders in the same faces before and after
(`CSS.getPlatformFontsForNode`: DejaVu Sans and its bold, Noto Color Emoji for emoji), on the inbox at desktop and
phone size and in two open conversations. Six cold loads of each at 4×, interleaved: 6 lookups instead of 14, and
the font time before the list 114 → 70 ms (medians). In verify-perf's A/B (`--only desktop --cpu 4 --runs 5`) that
is inside the noise: the list 1,378 → 1,362 ms (p 0.55), a relaunch's list 621 → 589 ms (p 1.0).

Tried and not kept:

- **`sans-serif` alone**: Chrome's sans-serif on Linux is Arial, which fontconfig gives as Liberation Sans, so the
  font changed, and it was no faster (74 ms). It would be Helvetica on a Mac and Arial on Windows too.
- **`system-ui, sans-serif, 'Noto Color Emoji'`**: the emoji is found by name, so fontconfig's search goes (45 ms
  instead of 70), but it puts that emoji font ahead of the one the system picks (a Linux desktop set to another emoji
  font, or Noto installed on Windows), and in the A/B it was no faster (1,465 ms, p 0.84).

What is left there is the per-size render settings (`GetWebFontRenderStyleForStrike`, a fontconfig match for each
face and size: 22 of them, about 30 ms) and the emoji search, each paid once per browser start, on Linux only.

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
  once the hub's data is in and again as the order changes. Those not held are fetched as a glance (what
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
- **The emoji picker draws 200 emoji first** (2026-11-14, ui/Reactions.tsx `FIRST_DRAWN`): the rest of its 1,900 stand
  in as empty boxes of their own height, so the scrollbar and the rail's jumps hold still, and are drawn just after
  that first frame is on screen. Drawing only what scrolls in (`content-visibility`) was tried before and made emoji
  flash in late. Desktop size, demo world, opening it from the hover bar: its first frame 64–84 ms → 12–14 ms, and
  ~320 ms → 49–62 ms at 4× CPU; the whole picker's work is the same, after that frame.

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
(`changed('shown')`; the first is `changed('identity')` now, [below](#who-wrote-the-inbox-and-a-sync-that-changed-nothing-2026-11-24)): people's names and pictures arriving with a page of messages, and what a message's reaction row
offers once a conversation's reaction context is known, both of which came with every first open; and a person, or an
account already here, changing (the walk came back once in a trace of Mail's first open, after a meta change this
did not name; these two are the likely ones, not checked). A folder opened or closed, here or from another device, moves
what is where and nothing a row or a message shows (`changed('open')`): `metaDataVersion` moves, `metaRev` stays, and
the rail, which reads `rev`, draws it.

`test/model-memo.test.ts` holds it: a read changes the counts and the order at once, with the same walk; the walk is
done again on a meta change; a level holds until a rule changes or a mute runs out.

### Who wrote, the inbox, and a sync that changed nothing (2026-11-24)

A cold load at 4× still worked out the rail, its counts and the badge four to six times after the bootstrap: every
change moved `dataVersion`, and four kinds of change that none of them read came in the first seconds. The inbox's
answer (`/api/inbox`) and the week's mail decisions; the 60 or so people who wrote what the inbox lists, each a
`changed('shown')`; the hub's list of devices, sent at every start and taken as a meta change, which walked every
server again; and, on a relaunch, the sync after the snapshot, which said `changed('meta')` whatever it brought.

Now they say what they are. `changed('identity')` (identities from a page, the inbox, a sync, a call, a change log)
moves `metaRev` for the names, `changed('inbox')` (the inbox's messages and the mail decisions) and
`changed('devices')` move `rev`; none of them moves `placesDataVersion` (versions.ts), which the memos of places,
counts, order, people's directs and the inbox's rows are keyed on (model.ts `placesMemo`). How it sorts' board reads
the inbox and stays on `dataVersion`. A sync moves only what its own fields changed: `meta` for your person or the
category provider, `shown` for the reaction usage, `list` for dither-accounts' view, `identity` for its identities;
its events are classified as the socket's are.

Counted in an instrumented build on the full-size world (each memo's runs, one cold load and one relaunch at 4×):
the cold load works out the badge's total, the rail's entries and the inbox's rows once, not four to six times, and
walks each server once, not twice (activity 172 runs, not 1,032; levels 1,166, not 2,330); the relaunch once, not two
to three times. In a CPU profile, six cold loads and relaunches of each, interleaved, medians at 4×: the rail, the
badge and the inbox list 415 → 284 ms of a cold load, the page's script in all 1,606 → 1,340 ms; a relaunch's script
976 → 892 ms. Times to the list did not move beyond the noise of a loaded machine: the work saved came after it.

What was still worked out again for every message or read (`changed('list')`): each server's activity and count, the
badge's total and the rail's order, all from the conversations' objects, though one conversation changed. Now it is
not ([below](#one-conversation-at-a-time-2026-11-24)).

Then the passes over every conversation that most of them leave at once: the badge's total asks whether a conversation
has anything unread before whether it is shown (most are read), the rail's added conversations and the inbox's hidden
rows look up the place's settings before making a default for it (`placePref` makes one for each of the 5,600 that
have none), the quiet shelf too, and `visibleConv` is a loop. Six cold loads of each at 4×, medians: the rail 214 → 166
ms, the badge 78 → 60 ms, the inbox list 96 → 86 ms; a relaunch's rail and badge 25–35 ms less in all.

### One conversation at a time (2026-11-24)

An arriving message is three frames from the hub: the conversation's new last message and counts, the reaction
picker's usage, and, a second later, the read. Each was a `changed('list')`, and each worked out every server's
activity and count, the badge's total, people's directs and the inbox's rows again from all 5,600 conversations.

Now a change says which conversations it changed, when that is all it changed: `changed('list', ids)`, from the
socket's events (state.ts `applyEvents`: a conversation's event that leaves its names and place alone, an inbox score,
a message, reactions' usage) and from the copies a notification brings before the hub answers (arrived.ts). versions.ts
keeps the last 64 of them by version (`convsChangedSince`); any other change, or more than 64 conversations at once,
reads as "anything". `placesMemo` then brings a value up to date from those conversations alone where it can:

- what is worked out from a server's conversations (their objects, its count, its activity, its channels' order) is
  kept when none of them is under it; a folder's, a channel's with its threads, the same;
- the badge's total is a sum kept by conversation: a changed one's part is taken out and put in again;
- people's directs: the person's list, with the new copy in the old one's place, sorted again;
- the inbox's rows: the changed conversations' own rows made again in their places, and the rows the hub has not
  scored yet (their order moves with the time), then grouped as before; a conversation that comes into the inbox or
  leaves it makes them all again;
- what reads only names, settings and what is where (a server's tree, your rules) is kept;
- with nothing changed that any of them reads (reactions' usage), all are kept.

A native mute that ran out since a value was worked out makes it all again: levels change then with nothing in `db`
changing (`levelsHeld`). `test/model-incremental.test.ts` runs random worlds through random runs of messages, reads,
new scores and time passing, and checks every few steps that what was brought up to date equals what working it all
out again gives.

Five runs of four arrivals each at 4× on the full-size world, CPU profiles, interleaved against the build before,
medians per arrival [spread]: `placesMemo` 65 [40–157] → 16 [10–35] ms, the rail 45 [28–113] → 18 [15–34] ms, the
badge 13 [8–30] → 1 [0–2] ms, the inbox list 15 → 8 ms, the page's script in all 148 [96–374] → 79 [71–180] ms. The
main thread's whole busy time per arrival, 772 → 694 ms, is mostly the rail's paints and within the noise. A cold load
and a relaunch work everything out the first time as before: in a benchmark of the same passes in Bun on this world's
bootstrap (least of 40 runs), working everything out after a meta change took as long as before, and after one
conversation's change 0.5–0.9 ms instead of 3–6.

Then the passes over every conversation that most of them leave at once: the badge's total asks whether a conversation
has anything unread before whether it is shown (most are read), the rail's added conversations and the inbox's hidden
rows look up the place's settings before making a default for it (`placePref` makes one for each of the 5,600 that
have none), the quiet shelf too, and `visibleConv` is a loop. Six cold loads of each at 4×, medians: the rail 214 → 166
ms, the badge 78 → 60 ms, the inbox list 96 → 86 ms; a relaunch's rail and badge 25–35 ms less in all.

### Memo keys (2026-11-24)

model.ts's memos were kept in one map each, by a key made of what is worked out and the place it is for:
`'lvl:' + id`, `'su:' + id`, `'under:' + id`. Each lookup built that string and hashed it, hit or miss, and a first draw
makes tens of thousands of them (every unread conversation's level in each count, each server's count, activity and
conversations). In a cold load's CPU profile at 4× the two memo wrappers' own time was 46 ms (`metaMemo` 30,
`placesMemo` 17), more than the levels they kept. Now each memo is kept by kind (a literal) and then by id, two maps,
and an id from the hub is a string already hashed once. The rules are looked up by scope and then target the same way,
and `unreadOf` is a loop rather than a filter and two maps.

CPU profiles of five cold loads and relaunches of each at 4× on the full-size world, interleaved against the build
before, medians of each function's own time [spread]: on a cold load `metaMemo` 37 [26–56] → 12 [6–15] ms, `unreadOf`
16 [10–42] → 8 [3–10], `placesMemo` 17 [12–22] → 15 [7–17], `effectiveLevel` 7 → 3: about 40 ms less; on a relaunch
about 16 ms less. In a benchmark of the same passes in Bun on this world's bootstrap (least of 40 runs), working the
rail, the badge, the servers' counts, the inbox and people out after a meta change took 8–9 ms instead of 10–14.

### A channel's threads (2026-11-24)

`indexThreads` (syncmodel.ts), run on each bootstrap and after every event that adds, moves or drops a thread, added
each thread to its channel by copying the channel's list: quadratic in a channel's topics. The perf world has two
threads a channel, but a busy Zulip or Matrix channel has a thousand topics or more. Now the lists grow in place, and
the edges and the places' categories are indexed with loops rather than `some`, `findIndex` and copies. A test checks
three channels with 1,000 to 3,000 topics index as before (`test/bootstrap-index.test.ts`). In Bun on the perf world's
bootstrap plus three such channels (6,000 topics, three interleaved runs, medians of 21): `indexThreads` 31–36 → 0.5–0.8
ms, applying the whole bootstrap 39–49 → 5–10 ms. On the perf world as it is, no change beyond noise.

### Times in lists (2026-11-24)

Every list row says how long ago its last message was (format.ts `ago`): "5m", "3h", "Tue", "Oct 12". Its formatters
were already made once, but each row older than a day still called one, and a formatter's call costs more than the
rest of `ago` together: about 16 ms of a cold load's main thread at 4× (CPU profiles, `ago`'s own time). A day's label
depends on its local date alone, so each weekday and each date is now formatted once and kept
(`test/format.test.ts` checks every 37 minutes over 400 days against formatting each time, in several time zones). In
Chrome at 4× over the perf world's 1,508 conversations' last-message times, three runs of nine rounds each, medians:
11.5–14 ms before, 0.6–6 ms with no label kept yet, 0.5–1.6 ms once kept (a list drawn again).

### The rail's order between messages (2026-11-24)

The rail's entries in order (model.ts `railEntries`) were worked out whole after every message or read: each
server's activity through its memo (173 servers on the perf world), each entry's settings, and a sort. Now the list
keeps what it was sorted from (each entry's settings, activity and where it was listed), and a message or a read
takes the activity again only of the servers holding a changed conversation (an index from conversation to server,
made once per list) and of folders whose conversations are a new list, then sorts that again; when no activity moved
(a read) it is the very same list. A changed conversation added to the rail on its own makes the list again, since
the entry holds its copy. Entries alike in everything the order looks at keep the order the stable sort gave them:
`test/model-incremental.test.ts` checks the order after runs of messages at a few shared times, with servers given the
same spot, pinned, hidden and empty, against that sort.

Arriving messages at 4× on the full-size world, CPU profiles of four arrivals each, base and branch interleaved on two
hubs and then swapped between them (the two copies of the world had drifted apart, and one cost twice the other in
the inbox), medians per arrival of `railEntries`' time: 6 → 2 ms on one hub and 14 → 4 ms on the other; the rail in
all, 19 → 13 and 42 → 34 ms. In Bun on the perf world's bootstrap, 0.20–0.43 → 0.03–0.10 ms.

## One setting at a time (2026-11-20)

Opening the details panel (the chat header's panel button) was slow: on the full-size world at 4× CPU, 160 to 260 ms
from the click to the next frame, and 120 to 135 ms to close it. The panel itself drew in 6 ms. Its open state is a
setting (`details`, kept on the device), and every setting lived in one signal, `prefs`: whatever read any setting
while it rendered rendered again on every `setPrefs`. Every message read one (`plainGifs`, and the hover bar's skin
tone), and so did the list, the rail and the app's badge, so one click drew all 60 messages on screen, the list and
the rail again. The theme's effect read the whole signal too, so it set every one of the theme's colours on the
page's root again and wrote them to localStorage, which restyles the whole page.

`prefs` is now private to state.ts. A setting is read with `pref('details')`, a computed signal per setting, so what
reads it renders again only when that setting changes. Opening the panel now renders App and the open timeline
(its header's button) and nothing else: at 1× on this machine 18 to 42 ms where it was 32 to 85, with 2 to 6 ms of
script where it was 16 to 60. What is left is the browser laying out the narrower conversation: style, layout, paint
and layers, 15 to 20 ms at 1×. Leaving the messages out of view unpainted (`content-visibility: auto`) saved little
and is not done.

The first run of [Every click](#every-click-2026-11-20) found another: a chat's members came in another order in
the hub's bootstrap (`SELECT * FROM participant`, in the order they were written) than in its events
(`conversationView`, by id), so the app read the first event about a chat (its read state, after opening it) as new
names, and every message and row on the screen drew again. Both read by id now, and the app compares members as a set
(packages/hub/test/conversation-view.test.ts, packages/web/test/versions.test.ts).

## Every click (2026-11-20)

`scripts/verify-response.ts` (CI's `response` job, in four parts) builds the app without minifying, so components
keep their names, and seeds the perf world at a tenth of its size behind a demo hub. On each kind of page (a channel,
a DM and a group with and without the details panel, a message hovered, For you, a server, a folder, People, a
person, a profile, About, Search, Notices, Requests, Accounts, Settings, the directory, Mail, Feed) it finds every
control on screen and clicks each kind once, with a real mouse, in the same order every run. The first page's
controls (the rail's, the list's) are clicked there only. Each page has a hub of its own on a fresh copy of one
settled world (its hub has looked at every attachment, which a hub does 15 s after it starts and sends the messages
again with), at a new address, so what an earlier page's clicks changed is not there and a page reads the same in
any of CI's four parts. Nothing that sends,
deletes, leaves, calls or signs out is pressed. After each click it waits for what the click set off to be done and
drawn, by what the page and the hub say rather than by a quiet spell, which a busy machine never gives: in the page,
no request out and no timeout a moment away (100 ms to 3 s) pending, then two frames; on the hub, no scores still to
come (`GET /api/attention/waiting`, which sends what changed first: a conversation folded again waits 5 s); on each
socket, a ping answered, so everything the hub sent before it has come. It goes round again while a round saw a
render, a request or an event. So what the click set off counts with it: a chat read 600 ms after it opens, the hub's
answers and scores, and the lists' re-sort, which waits until 4 s after the last touch and while the pointer is on a
list, and asks again every 1.5 s (so the mouse leaves after each click, as a hand does). A page still busy a minute on
fails, since what it was doing would land in the next click. Then Escape or the address takes the click back, and the
page is loaded again only when that did not get back to where it was.

The app's own clocks would land in whichever click is running when they strike, so the page holds them: every
`setInterval` of 5 s or more (the usage tick that counts a visit 3 s into a place, the minute's re-sort, the ping),
and the usage tracker's visits, which it answers itself instead of sending to the hub. Each page then has two cases of
its own before its clicks: "held: the app's clocks" runs every held interval once, and "hub: a visit counted" posts a
visit to the hub as another device would, and counts what the hub's event draws. A case that could not run fails. The
clocks case draws every "5m" and ↩ again, on purpose: that is the minute clock (`minute` in versions.ts), and it is on
the known list.

For each click it counts every component's renders (`window.__ditherPerf.components`), layouts and style
recalculations, and times the click to the next frame and the longest task. A click fails when it renders again at
least half of a component there are ten or more of on the page: every message, every row, every server in the rail.
Each one already on the page counts once however often it rendered (`again`): the hub's answer comes in one frame or
three depending on timing, a list drawn three times is no wider than one drawn once, and rows the click put on the
page render once or twice depending on when their data came. Its line also names the hub's events that came
while it settled (`[hub: attention sync×2]`).
Counts, not times (docs/testing.md, "No timing gates"); the slowest clicks go in the job's summary.

`scripts/response-known.json` lists the clicks that drew a list again when the check began, so that it fails only on
a new one. When one is fixed the run says so, and `--update` writes the list again; a pull request that adds to it
says why that click has to draw a whole list.

```sh
bun scripts/verify-response.ts                     # every page, about 12 minutes
bun scripts/verify-response.ts --only "a DM"       # pages whose name has this in it
bun scripts/verify-response.ts --only control:react  # controls whose name has this in it
bun scripts/verify-response.ts --cpu 4 --out x.json  # slower, and every click's numbers
```

## Over a slow link (2026-11-24)

The other passes run on loopback, or, for fetching ahead, over a link set on the page alone. The slow pass loads the
app as a phone on a poor link would. `scripts/slowlink.ts` is a TCP proxy between Chromium and the hub that holds
every byte as that link would: each direction sends one packet at a time at its rate, each packet arrives half a round
trip after it left, and a new connection waits a round trip (the handshake) before its first byte goes. DevTools' own
throttling (`Network.emulateNetworkConditions`) is not enough here: it is set on a page, and the service worker's
requests, its whole precache, go round it. The proxy reads each request's head (HTTP/1.1, one request at a time on
a connection: Chromium does not pipeline) and puts every byte the hub sends back to the request it answers, with the
time it reached the browser; the page's marks are on the same clock (`performance.timeOrigin`). Chromium asks for
zstd on loopback as it does over https, so the bytes are the ones a phone gets.

The link: 1.6 Mbit/s down, 0.75 up, a 300 ms round trip. The rates are
[Lighthouse's phone on "slow 4G"](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md), the
slowest link pages are commonly tested on. Its round trip is 150 ms where Lighthouse simulates the link and 562.5 ms
where it has DevTools throttle it (DevTools adds the latency per request, not per packet, so it scales it up to make
the same page as slow); 300 ms is between, a phone at the edge of 4G coverage or on good 3G, and a phone on the
tailnet sometimes goes through a relay as well. Which connection sends next: each in turn (`--slow-queue fair`, the
default), as a router that queues each flow on its own does and about what TCP's congestion control comes to when
flows share a bottleneck; or first come first served (`--slow-queue fifo`), a deep buffer shared by everything, as
many cellular links have.

First numbers, on main (2026-11-24, with #359; a full-size world, 4× CPU, fair, three runs on a machine at load
average 8 to 10, so the times are rough; counts are of the median run):

| | |
|---|---|
| cold start: list shown, hub's data in | 8.9 s, 8.2 s (8.8–9.0, 8.1–8.3) |
| on the link before the list showed | 54 requests, 1.24 MB: 5 scripts 349 KB, the stylesheet 60 KB, the bootstrap 435 KB, 34 of the precache's requests 377 KB, 10 other /api requests 22 KB |
| the startup script | 345 KB, from 0.65 s to 3.3 s: the longest wait before anything is drawn |
| the bootstrap asked for | 650–660 ms after the socket was: it waits for the socket to open (`resync` runs from `onopen`), a handshake and an upgrade, two round trips |
| the bootstrap on the wire | 3.8 s for 435 KB (3.5–3.9), beside 228 KB (160–254 KB) of 30 of the precache's requests, all sent before its last byte. Alone, 435 KB takes about 2.5 s here, and with `--slow-queue fifo`, where the precache queues behind it, it took 2.7–2.9 s |
| the precache | 81 requests, 1.37 MB, its last byte at 17.5–18.9 s (`/sw.js` asked for at 3.6 s, as soon as the app ran) |
| first conversation opened | 1.2–1.8 s |
| relaunch from the snapshot: list shown, hub's data in | 0.6–0.7 s, 1.0–1.1 s; none of the app from the network (the service worker had it), 3 requests answered before the list was drawn (the health check, the activity report, the manifest), none of which it waits on |
| the live socket | opened once a start, kept, one catch-up a start; the ping sent while the bootstrap came back in 319–324 ms |

With `--slow-queue fifo` the same ping waited 443 to 2,970 ms for its pong, the longest 30 ms short of `PONG_WAIT`
(3 s). At 1.2 Mbit/s down (`--slow-down 1.2 --slow-queue fifo`, one run, load average 26) the build before #359 dropped
one: the ping went out as the bootstrap began to come, no pong came in time, the app closed the socket at 10.1 s and
opened another, which took until 12.4 s to open behind the precache, and synced again. Since #359 a late pong is raced
by a new socket instead ([docs/sync.md](sync.md#a-bad-link)): the same run on it waited 4,280 ms for the pong, kept the
socket (two opened over both starts, none closed by the app) and caught up once a start.

**The bootstrap before the app's script** (2026-11-24). A cold start asked for the bootstrap only once the app's
script had come (3.3 s), the socket had opened (two round trips) and the snapshot read had found nothing: at 4.2 s.
Now `index.html` opens the socket itself and, on a device that keeps no snapshot, asks for the bootstrap as soon as
that socket is open, at 1.3 s here ([docs/sync.md](sync.md#the-client)). It then shares the link with the startup
script (405 KB came down beside it, so it takes 4.2 s on the wire rather than 3.5 s, and the script's last byte comes
at 4.8 s rather than 3.3 s), but both are in by about 5.5 s. Full size, 4×, fair, base and change in turn, three runs
each (load average 10 to 16):

| | before | after |
|---|---|---|
| slow link: list shown, hub's data in | 10.5 s, 9.7 s (8.5–15.3, 7.8–14.6) | 6.6 s, 5.7 s (6.3–8.3, 5.7–7.2) |
| slow link: relaunch, list and data | 0.65 s, 1.16 s | 0.68 s, 1.03 s |
| phone at 4×, loopback: list shown | 2.7 s (1.5–2.9) | 1.5 s (1.5–2.0) |
| desktop at 4×, loopback: list shown, data in | 1.8 s, 1.07 s | 1.9 s, 0.92 s (one run of three at 8.8 s, in a stall of the machine: its longest task 1.6 s) |

An earlier round of four runs each had the slow link's list at 9.3 s against 6.9 s (6.5–7.3), its data at 8.6 s
against 5.8 s (5.7–5.8). The first open after it, the relaunch and the socket's counts did not move.

Registering the service worker only once the list was shown and the data in (so that its precache does not share the
link with the bootstrap) took the bootstrap on the wire from 3.4 s to 2.8 s and the bytes before the list from 1.10
to 0.88 MB on its own, but the list only from 9.3 s to 8.6 s, and with the bootstrap asked for early it bought
nothing: the precache starts as the app runs, which is now about when the bootstrap ends (6.9 s and 5.8 s with it,
7.5 s and 5.9 s without). Started that late, all at once, it made the first conversation opened after the list wait
for its six connections (4.1 s once); two files at a time fixed that but took the precache from 19 s to 26 s. Not
kept. On the live hub, whose bootstrap is about twice this one on the wire, it may be worth trying again.

**A relaunch's catch-up on the socket** (2026-11-24). A relaunch had the list from the snapshot at about 0.65 s and
the hub's data about 0.35 s after: the catch-up (`POST /api/sync`) was asked once the socket had opened, one more
round trip. Now the socket asks from the snapshot's position (index.html reads it from `localStorage`, where
snapshot.ts keeps it) and the hub sends the catch-up as its first frame ([docs/sync.md](sync.md#on-the-socket)), so it
comes with the socket. Full size, 4×, fair, base and change in turn, six runs each (load average 10 to 20, so the
times spread):

| | before | after |
|---|---|---|
| slow link: relaunch, list shown | 0.78 s (0.58–1.50) | 0.63 s (0.61–1.27) |
| slow link: relaunch, hub's data in | 1.22 s (1.01–2.13) | 0.72 s (0.67–1.30) |
| from the list to the data | 483 ms (325–633) | 66 ms (17–104) |
| requests before the data | 12 | 8 to 10 |

The data now comes about as soon as the list is drawn: what is left before it is the socket's two round trips (a new
connection and its upgrade) and the snapshot's read and first draw, which take about as long.

## The web build on the wire (2026-11-24)

The hub compressed every file of the web build at zstd level 3 on each request (compress.ts), the startup script
and stylesheet included: 412 KB on the wire for the startup set. They are the same bytes every time, so now the hub
packs each once, at level 19, and keeps it (`PackedFiles` in compress.ts): it starts packing the whole build when it
starts listening, what index.html names first, one file at a time on the thread pool (89 files, 5.8 MB to 1.56 MB, in
2.9 s at load average 8), and a file asked for before it is packed, or changed since, goes out at level 3 as before
and is packed for the next ask. Each kept file carries the size and change time it was packed from, so a new build in
the same place is never answered with old bytes. Source maps are left out (only DevTools asks for them), as are gzip
clients, whom nothing changes for. The client unpacks level 19 as fast as level 3.

| on the wire, as zstd | level 3 | level 19 |
|---|---|---|
| the startup script | 349 KB | 294 KB (−16%) |
| the stylesheet | 60 KB | 44 KB (−26%) |
| the whole build (the service worker's precache) | 1.88 MB | 1.60 MB (−15%) |

Over the slow link (the slow pass alone, `--cpu 0 --phone-cpu 0 --ahead-cpu 0 --slow-cpu 4`, full size, nine runs of
main and of this taken in turn, at load average 8 to 14; medians and ranges, in ms from when the page was asked for,
since on a loaded machine the browser sometimes asked seconds late). Main here is from before the bootstrap was asked
for from `index.html` (above), when the script came alone; now the two share the link and both are wanted for the
list, so the script's 55 KB fewer come off that shared wait:

| | main | packed |
|---|---|---|
| the startup script's last byte | 3,306 (3,278–3,358) | 2,950 (2,837–3,034) |
| the bootstrap's last byte | 7,629 (7,476–8,718) | 7,459 (7,144–8,342) |
| hub's data in (`cold.fresh`) | 7,901 (7,688–9,006) | 7,710 (7,361–8,934) |
| list shown (`cold.content`) | 8,627 (8,399–10,259) | 8,461 (8,145–11,430) |
| the precache's last byte | 17,775 (17,634–22,518) | 16,956 (16,484–24,335) |
| relaunch: list shown, hub's data in | 1,004, 1,453 | 632, 1,194 |

The script's bytes are the steady part: 356 ms sooner in every run. The bootstrap gains less, because the
precache, its files smaller, gets further while the bootstrap comes (29 requests beside it in both).

### The bootstrap's window

zstd at level 3 looks back at most 2 MB for a match. A full-size bootstrap is 4.4 MB (the live hub's 4.9–5.4 MB), and
it names the same ids megabytes apart: each conversation's in `edges`, near the start, and again in `conversations`,
which runs from about 0.9 to 3.8 MB. Further back than 2 MB, an id went out again in full. Every zstd answer now has
a 4 MB window (`WINDOW_LOG` in compress.ts; browsers take up to 8 MB, RFC 9659). zstd fits the window to a smaller
answer by itself, so anything up to 2 MB comes out byte for byte as before: every budget at a tenth of the size is the
same. The full-size bootstrap is 406.7 KB on the wire against 389.5 KB (−4.2%; 430 against 411 KB with an empty
attention, on the perf world as verify-perf starts it), about 85 ms less over the slow link. It goes through
node:zlib's zstd, which takes a window, rather than `Bun.zstdCompress`, which does not: 10 ms rather than 7 for the
4.4 MB, on the thread pool.

What else the bootstrap's bytes are, at full size and level 3 with that window (each the bytes saved by leaving it out,
so as a share of 411 KB): conversations' ids 79 KB, topics 51 KB, last messages' ids 25 KB and texts 28 KB, the edges
of conversations (which repeat each conversation's `spaceIds`, with a position) 29 KB, of which their positions
12 KB. Leaving out every null, false and empty field of conversations saves only 7 KB on the wire (1.3 MB of the
4.4 MB before compression), identities' 2 KB, spaces' 1 KB. A higher level costs the hub's time on every bootstrap:
level 6 gives 396 KB in 37 ms, level 9 376 KB in 42 ms.

The edges of conversations are gone from the app's bootstrap since: it asks for `/api/bootstrap?edges=spaces`, whose
`edges` hold only those between spaces, and `conversationEdges` beside `conversations` the positions of each one's
edges, in its `spaceIds`' order (syncmodel.ts `indexEdges` makes the edges again). On the perf world at full size,
4,035 KB against 3,567 KB before compression (−11.6%) and 383 KB against 353 KB on the wire (−7.7%); at a tenth, 432
against 384 KB and 44.2 against 41.6 KB. Without `?edges=spaces` (an older page, dither-calendar, the scripts) the
bootstrap is as it was.
## Memory (2026-11-24)

`scripts/verify-memory.ts` (CI's `memory` job) looks for leaks: what the page holds growing as it is used. Against a
demo hub of its own on the perf world at a tenth of its size, a computer's page and a phone's go round the same pages
again and again, side by side: the six conversations the perf runs open and a thread, the top of the biggest channel
drawn (older messages from memory), the details panel opened and closed (on the computer), a person's page, their
profile, Settings, Mail and Feed, back, and the inbox again. After each round the page is let settle, the garbage is
collected twice (`HeapProfiler.collectGarbage`), and it counts:

| count | from |
|---|---|
| `heap` | `Performance.getMetrics`'s JSHeapUsedSize: printed only |
| `nodes`, `listeners`, `documents` | `Memory.getDOMCounters`: every DOM node alive, detached ones too, and event listeners |
| `detached` | `DOM.getDetachedDomNodes`: nodes off the page that something still holds |
| `elements` | the page's own elements |
| `intervals`, `timeouts`, `objectUrls`, `sockets`, `observers` | counted from the start by a script before the app's (its `INIT`): intervals set and not cleared, timeouts pending (printed only), `URL.createObjectURL` not revoked, sockets open, Resize-, Intersection- and MutationObservers still observing and not collected |
| `marks` | performance marks and measures kept |
| `held.*` | the app's own caches, from `window.__ditherPerf.held()` (`sized` in perf.ts, under `?perf=1`): timelines, messages held in them, quoted messages, kept pages, identities, mail bodies, the maps state.ts keeps for the page's life |

What is judged is growth from round 2 to the last (6 on the computer, 5 on the phone), never a size. The page's own
counts (elements, nodes, listeners) may move by 2% in all, once; what the app keeps running or holds not at all; and
nothing may grow in each of the last three rounds, however little: a leak grows every round, a clock's step once.
`scripts/memory-known.json` (none yet) is where growth known to be needed would go, with why. A count that grew past
what it may says where its new intervals, object URLs or observers were made.

The first round is the warm-up: it loads three older pages of the biggest channel from the hub, so that the later
rounds draw from memory. Every page from the hub stays in memory for as long as the page is open (`timelines` in
store.ts, by design), so a round that loaded one more each time would grow by a page whatever else it did. The app's
visits (`POST /api/usage`) are answered in the page, as in the click check, so the hub's order stays put.

```sh
bun scripts/verify-memory.ts                       # what CI runs, about two minutes
bun scripts/verify-memory.ts --cycles 50 --phone-cycles 0 --cpu 4 --scale 1   # the long run, below
bun scripts/verify-memory.ts --snapshots <dir>     # heap snapshots after round 2 and the last, for DevTools' Comparison
```

Other options: `--first` (the round growth is counted from), `--web <dist>`, `--out <file.json>` (every round's
counts, and under `metrics` the numbers the nightly run charts), `--keep`, `--verbose` (each step's time). The hub's
resident memory (`/proc/<pid>/status`, it has no endpoint for its heap) is printed before and after, never judged.

**Every night** it runs again at full size and 4×, ten rounds on each page ([Nightly trends](#nightly-trends)), and
its growth, last values, heap and the hub's memory are charted night to night: never judged there, only flagged when
a count leaves what the nights before came to.

**Steady.** Five runs here and five on GitHub's runners (dispatched with `gh workflow run ci.yml --ref <branch>`), on
2026-11-24: every judged count came out the same in rounds 2 to 6 and 2 to 5, in every run. The heap grew 190 to 260
KB a round on the computer and 145 to 170 KB on the phone, which is why it is printed and not judged. The job takes
about two minutes on a runner, beside `response`'s four, so the run takes no longer.

**It catches one.** A page made to leak an interval, a click listener and a detached `div` on every visit to Settings
failed on nodes, listeners and intervals, each +4 over four rounds.

**What it found.** Every chat opened added a `dither:timeline` mark (`markPainted`, perf.ts) to the page's list of
performance marks, which nothing emptied: nine a round, about 130 bytes each. Now each name keeps its last: the checks
that wait for them watch with a `PerformanceObserver`, which sees each. `marks` holds at 4.

**The long run** (2026-11-24, full-size world, 4× CPU, 50 rounds on the computer, a loaded machine, about 28 s a
round): elements, nodes, listeners, intervals, object URLs, sockets, observers and every cache held still from round 2
to 50, but for one step: the page's elements went 2,270 → 2,269 at round 11 and → 2,291 at round 22 (nodes 2,931 →
2,962, listeners back to 771), and stayed. That is the inbox's rows changing as the hub's attention rescores (every
five minutes), not growth, and why the page's counts may move once. The heap went from 17.5 MB after round 2 to 19.7
MB after round 50: about 160 KB a round to round 10, and 23 KB a round from round 20 to 50 (19.0 to 19.7 MB). The
hub's resident memory went from 230 MB before to 195 MB after (peak 389 MB).

What the heap's growth is, from heap snapshots (`--snapshots`, compared by constructor) on the tenth-size world. From
round 2 to 8 (the heap 11.1 to 12.2 MB): two thirds compiled code (V8's InstructionStream, Code, FeedbackVector: the
JIT warming up), and a quarter the tables of perf.ts's own WeakMap and WeakSet that count renders (only under
`?perf=1`). From round 10 to 30 (12.6 to 13.2 MB; the snapshots' totals 1.0 MB apart): compiled code again (about
620 KB), the response bodies DevTools keeps for the check's own `Network.enable` (160 KB), and the browser's
performance entries (long animation frames, paints, events). No object of the app's grew in number.

## Next

What these numbers point at, not done yet:

- **On a slow link the precache shared it with the bootstrap** ([above](#over-a-slow-link-2026-11-24)). Since the
  bootstrap is asked for from `index.html` it is mostly in before the precache starts, here; registering later did not
  help ([above](#over-a-slow-link-2026-11-24), the end). With a bootstrap the live hub's size it may.
- **The bootstrap now shares the link with the startup script** on a cold start: 405 KB of it came down beside the
  bootstrap. Each is wanted for the list; a smaller one of either is the next gain there.
- **The startup script, 196 KB compressed** (zstd at level 19, as the hub sends it) since [Left out of the first
  load](#left-out-of-the-first-load-2026-11-24) (294 KB before; 345 KB before the hub packed it at level 19,
  [above](#the-web-build-on-the-wire-2026-11-24)), is the longest wait of a cold start on a slow link before any of
  the app runs. Every KB off it is 5 ms there. Of what is left: Requests.tsx's page and a profile's connections (about
  10 KB), the details panel (about 8 KB), and calls (about 35 KB, tied up with ringing, which has to be there from the
  start).

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
