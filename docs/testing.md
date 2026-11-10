# Testing

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to main, as jobs side by side:

| Job | What it runs | The same locally |
|---|---|---|
| `changes` | decides what the pull request needs (scripts/ci-changes.ts) | `git diff --name-only origin/main... \| bun scripts/ci-changes.ts` |
| `typecheck` | tsc on every project at once (scripts/typecheck.ts) | `bun run typecheck` |
| `test-hub` | the hub's tests, its files on 4 workers (`bun test --parallel=4`) | `bun scripts/test-all.ts hub` |
| `test-packages` | every other package's tests, all at once | `bun scripts/test-all.ts --except hub` |
| `web` | the web app's vite build | `bun run web:build` |
| `boot` | the built web app in Chrome against a demo hub (scripts/check-boot.ts), then load and chat switching on a tenth-size world, its counts against a baseline (docs/perf.md) | `bun run check:boot`, `bun scripts/verify-perf.ts --ci` |
| `check` | passes only when each job above passed, or was skipped because `changes` said so | |

- `check` is the one check branch protection requires, and what auto-merge waits on. A new job goes into its `needs`.
- A pull request that only changes docs (any `*.md`, anything under `docs/`) or the Android app (`apps/android/`)
  skips everything but `changes` and `check`. Anything else, or a diff that can't be read, runs everything. A push to
  main and a manual run (Actions > CI > Run workflow) always run everything.
- A new push to a pull request cancels its older run. Runs on main never cancel each other.
- The Android app has its own workflow (android.yml), which runs only when apps/android changes.

`bun run test` runs every package at once, the hub on 4 workers, and prints each package's output whole when it
finishes. Flags after `--` go to each package's `bun test`, e.g. `bun scripts/test-all.ts hub -- -t "gap fill"` or
`-- --parallel=8`. The hub in one process, as before: `cd packages/hub && bun test`.

## Startup

- `boot` builds the web app, starts a demo hub on a fresh data dir, and loads it in headless Chrome at a desktop's and
  then a phone's size: the inbox list, a conversation, Settings. Any uncaught page error, `console.error`, failed
  request (unless `EXPECTED` in the script lists it with its reason) or a service worker that does not register fails
  it. The browser is the first of `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable` on PATH, or
  `$DITHER_CHROMIUM` (scripts/browser.ts).
- Then `verify-perf --ci`: a warm-up and three runs on a tenth-size world, judging renders, layouts, DOM nodes and
  bytes against `scripts/perf-baseline-ci.json` and printing the times without judging them (docs/perf.md, "In CI").
  A change that moves a count on purpose updates that baseline with `--ci --update --runs 5` and says why.
- The hub's tests start the hub on databases older hubs left (`packages/hub/test/old-database.test.ts`): it must copy
  the database aside, migrate, log `startup: ready` and read back what the old hub stored. `bun scripts/old-db-fixture.ts
  <commit> <name>` adds a fixture from another commit's demo hub (demo data only; it checks), for a migration that
  should be tried from a new schema era. docs/deploy.md has the startup line.
