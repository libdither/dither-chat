# Testing

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to main, as jobs side by side:

| Job | What it runs | The same locally |
|---|---|---|
| `changes` | decides what the pull request needs (scripts/ci-changes.ts) | `git diff --name-only origin/main... \| bun scripts/ci-changes.ts` |
| `typecheck` | tsc on every project at once (scripts/typecheck.ts), then the checks below: test hygiene, stylesheets, import cycles, unused code | `bun run typecheck`, `bun run check:tests`, `bun run check:css`, `bun run check:cycles`, `bun run knip` |
| `test-hub` | the hub's tests but mail-load's, its files on 4 workers (`bun test --parallel=4`) | `bun scripts/test-all.ts hub -- --path-ignore-patterns=test/mail-load.test.ts` |
| `test-hub-mail` | the hub's mail-load tests (60k messages; 20 to 30 s, as long as the rest of the hub's) | `bun scripts/test-all.ts hub -- test/mail-load.test.ts` |
| `test-packages` | every other package's tests, all at once | `bun scripts/test-all.ts --except hub` |
| `web` | the web app's vite build | `bun run web:build` |
| `boot` | the built web app in Chrome against a demo hub (scripts/check-boot.ts), then the sign-in screen against a hub behind the login, clicked and typed into (scripts/verify-login.ts) | `bun run check:boot`, `bun run web:build && bun scripts/verify-login.ts` |
| `perf` | load and chat switching on a tenth-size world, a warm-up and one run, its counts against a baseline (docs/perf.md) | `bun scripts/verify-perf.ts --ci` |
| `check` | passes only when each job above passed, or was skipped because `changes` said so | |

- `check` is the one check branch protection requires, and what auto-merge waits on. A new job goes into its `needs`.
- A pull request that only changes docs (any `*.md`, anything under `docs/`) or the Android app (`apps/android/`)
  skips everything but `changes` and `check`. Anything else, or a diff that can't be read, runs everything. A push to
  main and a manual run (Actions > CI > Run workflow) always run everything.
- `perf`, the longest job, does not wait for `changes`: it starts at once, runs the same script itself, and skips its
  steps when `changes` would skip it, so on such a pull request it passes rather than reads as skipped.
- A new push to a pull request cancels its older run. Runs on main never cancel each other.
- The Android app has its own workflow (android.yml), which runs only when apps/android changes.
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
- `perf`, beside it: `verify-perf --ci`, a warm-up and one run on a tenth-size world, judging renders, layouts, DOM
  nodes and bytes against `scripts/perf-baseline-ci.json` and printing the times without judging them (docs/perf.md,
  "In CI"). A change that moves a count on purpose updates that baseline with `--ci --update --runs 5` and says why.
- The hub's tests start the hub on databases older hubs left (`packages/hub/test/old-database.test.ts`): it must copy
  the database aside, migrate, log `startup: ready` and read back what the old hub stored. `bun scripts/old-db-fixture.ts
  <commit> <name>` adds a fixture from another commit's demo hub (demo data only; it checks), for a migration that
  should be tried from a new schema era. docs/deploy.md has the startup line.

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
  opens again from its file can be `new Store(':memory:', …)`, with no disk at all (jobs.test.ts). `strace -f -c -e
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
(but DITHER_CHROMIUM and DITHER_DAVE_DIR, paths to tools tests skip without). The hub and the adapters read their
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
