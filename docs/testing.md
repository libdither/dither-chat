# Testing

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to main, as jobs side by side:

| Job | What it runs | The same locally |
|---|---|---|
| `changes` | decides what the pull request needs (scripts/ci-changes.ts) | `git diff --name-only origin/main... \| bun scripts/ci-changes.ts` |
| `typecheck` | tsc on every project at once (scripts/typecheck.ts) | `bun run typecheck` |
| `test-hub` | the hub's tests but mail-load's, its files on 4 workers (`bun test --parallel=4`) | `bun scripts/test-all.ts hub -- --path-ignore-patterns=test/mail-load.test.ts` |
| `test-hub-mail` | the hub's mail-load tests (60k messages; 20 to 30 s, as long as the rest of the hub's) | `bun scripts/test-all.ts hub -- test/mail-load.test.ts` |
| `test-packages` | every other package's tests, all at once | `bun scripts/test-all.ts --except hub` |
| `web` | the web app's vite build | `bun run web:build` |
| `boot` | the built web app in Chrome against a demo hub (scripts/check-boot.ts) | `bun run check:boot` |
| `perf` | load and chat switching on a tenth-size world, a warm-up and one run, its counts against a baseline (docs/perf.md) | `bun scripts/verify-perf.ts --ci` |
| `check` | passes only when each job above passed, or was skipped because `changes` said so | |

- `check` is the one check branch protection requires, and what auto-merge waits on. A new job goes into its `needs`.
- A pull request that only changes docs (any `*.md`, anything under `docs/`) or the Android app (`apps/android/`)
  skips everything but `changes` and `check`. Anything else, or a diff that can't be read, runs everything. A push to
  main and a manual run (Actions > CI > Run workflow) always run everything.
- A new push to a pull request cancels its older run. Runs on main never cancel each other.
- The Android app has its own workflow (android.yml), which runs only when apps/android changes.
- The run takes as long as its slowest job, and every job sets up in a few seconds, so a long step gets a job of its
  own rather than waiting behind another: `perf` (about 45 s of browser runs), `test-hub-mail` (one file of 20 to
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

### Code that works in slices

Some hub code works for a few milliseconds at a time and leaves the rest for the next call: the inbox's `sync` and
`pump` (attention.ts) and mail's rescoring (mail/attention.ts). Each call takes at least one step, so the rest is never
stuck. A test that wants everything done calls again while `busy`. A test about the slicing itself sets
`budgetClock` to a test clock, and sees the cut every time instead of now and then (mail-attention.test.ts,
attention.test.ts).

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
  On a busy disk one fsync can take tens of milliseconds; one transaction around the setup makes it one.

### The hygiene check

`bun run check:tests` (scripts/check-tests.ts) runs in CI's typecheck job and takes about 0.1 s. It reads every
package's tests (`*.test.ts`, `*.test.tsx` and everything under a `test/` directory) and fails on:

- a `.only`, under any name test, it or describe is imported as;
- a retry: `retry:` in a test, `retry` in a bunfig.toml, `--retry` in a package.json, a workflow or a script;
- a `.skip` without its `// quarantine:` note;
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
