# Testing

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to main, as jobs side by side:

| Job | What it runs | The same locally |
|---|---|---|
| `changes` | decides what the pull request needs (scripts/ci-changes.ts) | `git diff --name-only origin/main... \| bun scripts/ci-changes.ts` |
| `typecheck` | tsc on every project at once (scripts/typecheck.ts), then the checks below: test hygiene, stylesheets, import cycles, unused code, Escape handlers | `bun run typecheck`, `bun run check:tests`, `bun run check:css`, `bun run check:cycles`, `bun run knip`, `bun run check:escape` |
| `test-hub` | the hub's tests but mail-load's, its files on 4 workers (`bun test --parallel=4`) | `bun scripts/test-all.ts hub -- --path-ignore-patterns=test/mail-load.test.ts` |
| `test-hub-mail` | the hub's mail-load tests (60k messages; 20 to 30 s, as long as the rest of the hub's) | `bun scripts/test-all.ts hub -- test/mail-load.test.ts` |
| `test-packages` | every other package's tests, all at once | `bun scripts/test-all.ts --except hub` |
| `web` | the web app's vite build | `bun run web:build` |
| `boot` | the built web app in Chrome against a demo hub (scripts/check-boot.ts), then the sign-in screen against a hub behind the login, clicked and typed into (scripts/verify-login.ts), then notifications closing once their chat is read, pushed to the service worker over DevTools (scripts/verify-clear.ts), then the start with the hub out of reach right after a deploy (scripts/check-offline.ts), then the hub out of reach and back, tapped and clicked (scripts/verify-offline.ts), then a push's copy of its message shown offline and replaced once the hub answers (scripts/verify-arrived.ts) | `bun run check:boot`, `bun run web:build && bun scripts/verify-login.ts`, `bun scripts/verify-clear.ts`, `bun run web:build && bun scripts/check-offline.ts --web packages/web/dist`, `bun run web:build && bun scripts/verify-offline.ts`, `bun run web:build && bun scripts/verify-arrived.ts` |
| `back` | back from every kind of page and layer, by Escape and the browser's back, on a computer and a phone, against a demo hub of its own (scripts/verify-back.ts, docs/desktop.md "Escape and back") | `bun run web:build && bun scripts/verify-back.ts` |
| `response` | every control on each kind of page clicked, in four parts side by side: a click that draws most of a list again (every message, every row) fails unless scripts/response-known.json has it (scripts/verify-response.ts, docs/perf.md "Every click") | `bun scripts/verify-response.ts` (`--shard 1/4` for a part) |
| `perf` | load and chat switching on a tenth-size world, a warm-up and one run, its counts against a baseline (docs/perf.md) | `bun scripts/verify-perf.ts --ci` |
| `check` | passes only when each job above passed, or was skipped because `changes` said so | |

- `check` is the one check branch protection requires, and what auto-merge waits on. A new job goes into its `needs`.
- A pull request that only changes docs (any `*.md`, anything under `docs/`) or the Android app (`apps/android/`)
  skips everything but `changes` and `check`. Anything else, or a diff that can't be read, runs everything. A push to
  main and a manual run (Actions > CI > Run workflow) always run everything.
- `perf`, the longest job, does not wait for `changes`: it starts at once, runs the same script itself, and skips its
  steps when `changes` would skip it, so on such a pull request it passes rather than reads as skipped.
- A new push to a pull request cancels its older run. Runs on main never cancel each other.
- The Android app has workflows of its own, outside `check`: android.yml (unit tests and the APK, when apps/android
  changes) and android-device.yml (the app on an emulator; [below](#android-on-an-emulator)).
- The run takes as long as its slowest job, and every job sets up in a few seconds, so a long step gets a job of its
  own rather than waiting behind another: `perf` (about 50 s of browser runs), `test-hub-mail` (one file of 20 to
  30 s) and `test-hub` (the other 69 files) run side by side. A code pull request's run took about 70 s on 2026-11-10,
  against 140 s with verify-perf inside `boot`.

`bun run test` runs every package at once, the hub on 4 workers, and prints each package's output whole when it
finishes. Flags after `--` go to each package's `bun test`, e.g. `bun scripts/test-all.ts hub -- -t "gap fill"` or
`-- --parallel=8`, and so do files: `-- test/mail-load.test.ts` runs that one, `-- --path-ignore-patterns=<glob>` all
but those, as CI splits the hub. The hub in one process, as before: `cd packages/hub && bun test`.

## Startup

- `boot` builds the web app, starts a demo hub on a fresh data dir, and loads it in headless Chrome at a desktop's and
  then a phone's size: the inbox list, a conversation, Settings. Any uncaught page error, `console.error`, failed
  request (unless `EXPECTED` in the script lists it with its reason) or a service worker that does not register fails
  it. The browser is the first of `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable` on PATH, or
  `$DITHER_CHROMIUM` (scripts/browser.ts).
- Then, in the same job, `check:offline` (scripts/check-offline.ts, 10-20 s) at a phone's size against a demo hub: it
  loads the app twice and opens a conversation, waits for the snapshot and that conversation's kept page, then deploys a
  new build (a new id in `sw.js`) while every hashed file is gone from the hub and the HTTP cache is empty, so the new
  worker can only install from the old build's cache. It then stops the hub, empties the HTTP cache again and reloads:
  the conversation must show from the snapshot with every file from the worker's cache. Last, it deletes a file the
  app's script imports from that cache and reloads with the hub still gone: the start must fail and say so
  (`dither:boot-failed`), and come back by itself once the hub is started again. Before the whole build was precached,
  that offline start stayed on the logo (docs/android.md, "Starting fast").
- `perf`, beside it: `verify-perf --ci`, a warm-up and one run on a tenth-size world, judging renders, layouts, DOM
  nodes and bytes against `scripts/perf-baseline-ci.json` and printing the times without judging them (docs/perf.md,
  "In CI"). A change that moves a count on purpose updates that baseline with `--ci --update --runs 5` and says why.
- The hub's tests start the hub on databases older hubs left (`packages/hub/test/old-database.test.ts`): it must copy
  the database aside, migrate, log `startup: ready` and read back what the old hub stored. `bun scripts/old-db-fixture.ts
  <commit> <name>` adds a fixture from another commit's demo hub (demo data only; it checks), for a migration that
  should be tried from a new schema era. docs/deploy.md has the startup line.

## Android on an emulator

The Android app is tested in three layers, outside the required `check`:

- **Unit tests on the JVM** (`apps/android/app/src/test`, `./gradlew :app:testDebugUnitTest`, in android.yml): the
  app's logic that needs no device, such as the records `Arrived.kt` keeps for a push's copy and what a push's payload
  means to `Notifications.kt` (its tier, marks, chat, lines and pictures). A few seconds. `org.json` is the real
  library there (a test dependency): android.jar's copy is stubs that throw off a device. Logic that wants a test
  takes a `File` or a `JSONObject` rather than a `Context`, as `Arrived` does.
- **The app on an emulator** (`.github/workflows/android-device.yml`): `scripts/verify-android.ts` runs
  `verify-android-call.ts` (calls and rings: prompts, the call service, the shade's buttons; docs/android.md,
  "Testing calls") against a demo hub, then `verify-android-arrived.ts` (a push's copy kept and shown offline;
  docs/notifications.md, "A copy in the push"). The debug build, an API 35 x86_64 emulator with KVM on a standard
  runner, its booted snapshot cached between runs. About 4 minutes of tests on a local emulator, plus the builds and
  the boot. It runs on pull requests that change `apps/android/`, the web files that talk to the app
  (`packages/web/src/android.ts`, `arrived.ts`) or these scripts, on main for the same, and every night on main.
  The push test's pushes reach the app through the debug build's `DebugPushReceiver`, which takes the same path as a
  UnifiedPush message (`Push.arrived`). The calls test's rings come through real push: the hub's Web Push request,
  the app's UnifiedPush connector registering, decrypting and handing it on. Where the device has no distributor
  (CI's emulator) the test brings one, `apps/android/testpush`, whose server runs in the test
  (`scripts/android-testpush.ts`): the hub sends to it as to ntfy's server, and each body goes to the device over adb.
  A device with its own distributor (ntfy on a local emulator) uses that instead. A failed run uploads its
  screenshots (`android-shots`).
- **Required once steady.** The emulator job reports and does not block a merge until it has passed 20 runs on main
  in a row: `bun scripts/android-device-streak.ts` counts them. Making it required then means running it on every
  pull request, with a `changes`-style skip like ci.yml's, since a required check behind a `paths` filter never
  reports on a pull request outside those paths and holds it forever.

Locally (docs/android.md, "Testing on an emulator"):

```sh
bun run web:build
(cd apps/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug :uitest:assembleDebug :uitest:assembleDebugAndroidTest :testpush:assembleDebug)
bun scripts/verify-android.ts --serial emulator-5584
```

What none of this covers in CI: a real distributor (ntfy) and its server delivering, and what can hold them up (a
connection that dropped, ntfy's 507 before it has connected); Doze and phone makers' battery savers; and a phone's
own WebView version. ntfy runs on a local emulator with it installed; the rest needs a phone.

## Flaky tests

A test that fails now and then teaches everyone to run it again until it passes, and then a real failure gets run
again too. So:

- **No retries.** No `--retry`, no `{ retry: N }`, no `retry` in a bunfig. A flaky test is fixed, or quarantined
  (below) until it is.
- **No sleeps.** A test waits for the event it needs: a promise, a callback, the flush that carries the change. A
  sleep long enough on one machine is too short on a busy CI runner, and long enough there makes the suite slow.
- **No timing gates.** No `expect(elapsed).toBeLessThan(…)`. Guard speed with what can be counted: the rows a query
  sorts, bytes, calls, features per example (docs/perf.md, "Budgets"). Times may be printed, never compared.
- **No `.only`.** It runs one test and quietly skips the rest.
- **A skip says why.** `test.skip` or `describe.skip` needs `// quarantine: <reason or issue>` on its line or the line
  above. A test that needs something a machine may not have uses `skipIf(!have)`.

### Ports

CI runs the hub's test files four at a time, and the stress run 15 times over. A port picked at random from a range
two files share (`19460 + random * 500`) is sooner or later picked by both ("Is port 19602 in use?"). So a server a
test starts listens on port 0 and the test reads the port it got:

```ts
hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
port = hub.start().port!;
```

The same for `Bun.serve`, `Bun.listen` and a dither-accounts manager (`createManager({ port: 0 })`), and for the hub's
plain listener beside TLS (`plainPort: 0`, then `hub.plain.port`). Something told its port before it listens (a hub
run from main.ts, Dovecot) gets one the OS picked: `freePorts(n)` in packages/hub/test/fixtures/port.ts. A port
nothing listens on, for a test of what happens then, is port 1.

### Code that works in slices

Some hub code works for a few milliseconds at a time and leaves the rest for the next call: the inbox's `sync` and
`pump` (attention.ts) and mail's rescoring (mail/attention.ts). Each call takes at least one step, so the rest is never
stuck. A test that wants everything done calls again while `busy`. A test about the slicing itself sets
`budgetClock` to a test clock, and sees the cut every time instead of now and then (mail-attention.test.ts,
attention.test.ts).

Longer background jobs are generators that yield the rows they worked through every few thousand (`slices.ts`): the
embedder's refit and the media archiver's walks (docs/perf.md, "After a restart"). `sliced` runs one with a turn of the
event loop between slices; `whole` runs it straight through. A test passes slice options that end a slice at every
chance (`clock: () => 0, budgetMs: 0`) and an `onSlice` that collects each slice's rows: it then holds the most rows
a slice may work through, and the answer to be the same as straight through (stalls.test.ts). No times.

### Finding a race

A race rarely shows on an idle machine. Run the test many times with the machine busy:

```sh
cd packages/hub
for i in 1 2 3 4; do timeout 300 sh -c 'while :; do :; done' & done   # at most 6 on a shared machine, time-limited
bun test test/mail-attention.test.ts -t "Sam wrote to you" --rerun-each=300
bun test --rerun-each=3 --parallel=4                                  # or the whole suite
kill %1 %2 %3 %4                                                       # or let timeout end them
```

- Judge by counts: "2 of 300" before a fix, "0 of 300" after.
- Once it fails, log what the code decided at that moment (a budget cut, a timer firing) and match it to the
  failures. Then write a test that makes that ordering happen every time (a test clock, a promise held back) rather
  than by load.
- `--rerun-each` runs a file again in the same process: modules it imports keep their state. A test may not lean on
  what an earlier run left there. The demo world kept the groups that about.test.ts renamed until a new world began
  resetting them.
- A `beforeAll` that times out under load is often many small writes, each its own transaction and its own fsync.
  On a busy disk one fsync can take tens of milliseconds; one transaction around the setup makes it one. When the
  writes are the code under test, one at a time (the media archiver's, in gapfill.test.ts), `PRAGMA synchronous = OFF`
  on the test's database drops their fsyncs: nothing in a test has to outlive the process. A store the test never
  opens again from its file can be `new Store(':memory:', …)`, with no disk at all (jobs.test.ts). When the syncs
  can't be switched off (secret files, the checkpointer's own connection), put the test's files on a memory
  filesystem: `memTempDir` (test/fixtures/memdir.ts) makes the directory under `/dev/shm`. `strace -f -c -e
  trace=fsync bun test <file>` counts them, and `strace -f -w -c` shows the wall time they take.
- A test clock moved hours on steps through every timer due on the way: a loop that looks for work every 5 s fires
  17,000 times in a day, each with a few turns of the event loop and its queries (0.6 s of jobs.test.ts's repeat run).
  Stop the loop, `advance` the clock to just before what the test waits for, then start the loop again.

### The hygiene check

`bun run check:tests` (scripts/check-tests.ts) runs in CI's typecheck job and takes about 0.1 s. It reads every
package's tests (`*.test.ts`, `*.test.tsx` and everything under a `test/` directory) and fails on:

- a `.only`, under any name test, it or describe is imported as;
- a retry: `retry:` in a test, `retry` in a bunfig.toml, `--retry` in a package.json, a workflow or a script;
- a `.skip` without its `// quarantine:` note;
- a port picked with `Math.random()`, or written as a number of 1024 and up: a port-named key or variable set to one
  (`port: 18460`, `const IMAP_PORT = 18580`), `.listen(8080)`, `'--port', '8494'` ("Ports" above). One that has to
  be fixed says why with `// fixed-port: <reason>` on its line or the line above;
- more real-time waits or clock reads in a file than scripts/test-waits.json allows.

The ratchet counts four things per file: `Bun.sleep(…)` (not `Bun.sleep(0)`, which only yields), `setTimeout` used
as a wait (a resolver handed to it, or inside a `new Promise`), `performance.now()`, and `Date.now()` less a variable
or compared with one. Comments and strings don't count.

- A file's count may go down. The check then says so, and `bun run check:tests --update` writes the lower number.
- A count never goes up, and `--update` never raises one. A new file starts at 0.
- A wait that has to be real (a test of a real timer, a script against a live server) ends its line with
  `// wall-clock: <reason>`, so the reason shows in review.

At the start (2026-11-10): 105 sleeps, 0 setTimeout waits, 6 performance.now() and 27 Date.now() deltas, most of them
in the mail tests' `until` helpers and the adapters' tests.

### The stress run

`.github/workflows/stress.yml` runs `bun scripts/stress.ts --rerun-each=15 --parallel=4` once a day (07:17 UTC), and
by hand from Actions > Stress > Run workflow, which asks how many runs. That is every hub test file 15 times, about
10 minutes. Any failure fails the job, and the job's summary lists each failing test with how many of its runs
failed. Nothing else happens: no issue, no message beyond GitHub's own.

The same locally: `bun scripts/stress.ts --rerun-each=3`, and after `--`, files or `-t` for bun test. What it finds
gets fixed. If that can't happen at once, the test is quarantined with a note naming the issue.

## Checks across the code

Three checks look at the whole code base rather than one feature, cheap enough for every run (CI's typecheck job). The
first two follow checks T3 Code has (apps/mobile/src/dependency-graph.test.ts, its `knip:check`, apps/web's
chunk-cycle guard), the third its test environment (packages/shared/src/testing/providerEnv.ts).

### Import cycles

`bun run check:cycles` (scripts/check-cycles.ts, under a second) fails on any static import cycle among the files of
one package's src/: a imports b, and b imports a, through any number of files. In a cycle the order modules run in
depends on which is loaded first, so a value one reads while it loads (a constant, a signal, a class it extends) can
be read before it exists: a TDZ error, or `undefined`, that shows in one load order and not another, or only after the
bundler moves code between chunks. Type-only imports, `import()` and tests do not count.

The way out is a module of its own for what both sides need, that imports neither. On 2026-11-14 there were four:
- the web app's state.ts, snapshot.ts and ringing.ts: the client's data is in store.ts and the HTTP call in api.ts now,
  and state.ts re-exports both;
- 34 components through menus.tsx and bits.tsx: one account's menu is in ui/accountMenu.tsx, opening a conversation
  (openConv, homeRoute, openAbout) in opening.ts, the long-press in ui/longpress.ts, the picture viewer's signal in
  viewer.ts, and openPlaceMenu in menus.tsx;
- the hub's attention.ts and owed.ts: the reply tallies are in tally.ts;
- the hub's store.ts, accountself.ts and triage.ts: quiet hours are in quiethours.ts.

The web build fails on a cycle between its output chunks too (vite.config.ts `chunkCycleGuard`): rolldown can make one
from modules that have none, and a chunk that runs before one it imports from blanks the app at load, in a production
build only.

### Escape and back

`bun run check:escape` (scripts/check-escape.ts, about a second) holds two things (docs/desktop.md "Escape and back"):
every handler in the web app that acts on Escape calls `preventDefault()`, or says why not in a comment starting
`escape:` just before it, and listens from a `useLayoutEffect` (one added in a `useEffect` starts after the next paint,
so an Escape the moment its popover is drawn would go past it and leave the page); and scripts/verify-back.ts covers
every route view in routes.ts and every component that opens a layer (`pushLayer` or `useLayer`), or names it in its
`UNCOVERED` with the reason. A new page or overlay fails the check until its way back is checked, or the reason it
cannot be is written down.

### Unused code

`bun run knip` ([knip](https://knip.dev), config in knip.json) runs two passes, as T3 Code's `knip:check` does:
- over every package: a file nothing imports, a dependency no file uses, and an import of a package its package.json
  does not list (one that resolves here only because the workspace hoists it, and breaks on a clean install);
- over the hub, the web app, the protocol, desk, deploy and the scripts: an export nothing imports, an exported type,
  class member or enum member nothing uses, and a thing exported twice. The adapters are left out: dither-accounts'
  extractors are where they are written (scripts/accounts-sync.ts), and these copies only fall further behind.

knip follows static imports from each package's entry points in knip.json: its main, the workers, the tests, the
Discord lab's scripts (the sandbox reads them by path), and in the web app every module it loads with `import()`. A
module loaded that way is kept in a variable and read later (`typeof import('./CallPanel.tsx')`, `p?.CallPanel`), which
knip cannot follow, so its exports would all look unused: a new lazily loaded module goes into the web app's `entry`
list.

The compiler reports the rest: tsconfig.base.json has `noUnusedLocals`, so an unused import, variable, function or
private member fails `bun run typecheck` (the adapters' tsconfigs turn it off, for the same reason as above). An export
knip finds unused loses its `export`; if nothing in its file uses it either, the compiler then says so and it goes.

On 2026-11-14 that was 552 exports nothing outside their file used, in about 220 files: 536 lost their `export`, and
16 went with their code, nothing using them at all. The compiler then found the unused imports, constants and functions
(`quietHere`, `replacePage`, `railCommunities`, `emptyDraft`, a script's thread reader among them), deleted too. Seven
scripts imported `@dither-chat/protocol` with the root package.json not listing it.

### The environment

Each package's bunfig.toml preloads scripts/test-env.ts, which clears every DITHER_* variable before the tests run
(but DITHER_CHROMIUM, DITHER_DAVE_DIR and DITHER_ACCOUNTS_REPO, paths to tools and checkouts tests skip without). The hub and the adapters read their
settings from those variables, and a test that starts a hub passes its environment on, so a shell with one set (for a
demo hub, a lab, a replay) ran the tests on other settings than CI's: with DITHER_MEDIA_ALLOW_PRIVATE=1 three of the
media fetcher's address-guard tests failed. A test that needs a setting sets it. `DITHER_TEST_KEEP_ENV=1` keeps them,
to try a test on a setting on purpose.

## Stylesheets

A component's own stylesheet (any `.css` under packages/web/src but styles.css, imported by the component: ui/feed/feed.css,
ui/mentions.css…) is global once it loads. A rule in it applies to every element on the page, so a rule that names
only classes the rest of the app uses too changes the rest of the app, and only after that component has been shown
once in the session: a bug that comes and goes. On 2026-11-14 the X feed's `.composer { … }` (its post box) drew a
second frame around the chat's message box once the feed had been opened, and the @ picker's `.mc-note` and `.mc-more`
restyled the mail composer's own (the picker's classes are `mp-` now).

`bun run check:css` (scripts/check-css.ts) runs in CI's typecheck job and takes about a second. Each such stylesheet
is owned by the files that import it and the files only they import; one in a directory of its own under ui/ by every
file in that directory. A class is the sheet's own when it is written in those files and in no other (as a word in a
string or template literal whose words could all be classes). Then:

- every selector in it names at least one class of its own (`.thread-focal .post-composer`, not `.composer`, `.on`,
  `button` or `textarea:focus` alone);
- a class it styles as a whole selector (`.x`, `.x:hover`) is not styled that way in styles.css or another
  component's sheet too.

The fix is a class of the component's own: rename the shared one, prefix it (`post-`, `mp-`), or put the component's
root class in front. A box the rest of the app draws for the component (the feed's `.feed-pane`) is styled in
styles.css, so it holds before the component loads. A rule that must reach out says why, in the comment right before
it: `/* css-scope: <reason> */`.

### Sideways overflow

A box that scrolls up and down (a chat, a list, Settings) scrolls sideways too as soon as anything in it is wider than
it is. A flex or grid item is never narrower than its longest word unless told so (`min-width: 0`, `minmax(0, 1fr)`),
so one long unbroken word (a web address, a long name) in a row widens the row past the window, the whole chat gets a
sideways scrollbar, and a focus can then shift it sideways. On 2026-11-20 a chat beside the details panel did.

So `body` sets `overflow-wrap: anywhere`: a word breaks where it must instead of holding its box open, and text that
fits is laid out as before. What stays on one line on purpose (`white-space: nowrap`: a name, a handle) ends in "…"
(`overflow: hidden; text-overflow: ellipsis`) or is the app's own short words; initials in a picture keep `nowrap`.
The chat's `.timeline-inner` clips sideways (`overflow-x: clip`) as a safety net for what still gets through.

`bun scripts/check-overflow.ts` (`bun run check:overflow`, in CI's boot job, about a minute) opens the demo world's
pages (a chat of each network and shape, profiles, Settings, the feed, mail, search…) at a computer's size, with the
details panel open, a narrow window's and a phone's, and fails when a box that scrolls up and down is wider inside than
it is, as drawn or with one of the hub's texts (a string from an `/api/` answer) made 40 characters longer with an
unbroken word. A box meant to scroll sideways sets `overflow-x` in a rule of its own (a code block, a row of chips).
