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

(probe: a docs-only change, to see CI skip the work; this pull request is closed unmerged)
