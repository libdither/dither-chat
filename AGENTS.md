# dither-chat: notes for agents

One inbox for every chat network: a hub (`packages/hub`) that keeps the messages, a web app and PWA (`packages/web`)
that shows them, and the accounts themselves, which run in dither-accounts beside the hub. The repo is public, so it
holds code and generic docs only. Notes about the owner's machine, deployment and accounts are in `AGENTS.local.md`
(untracked): read it when it exists.

## Keep concrete data out of the repo

- **Never commit:** real names, handles, phone numbers or email addresses; real account, chat, channel, server or
  message ids; message content from a real account; hostnames, domains, tailnet or LAN addresses, and paths on the
  owner's machine; secrets, tokens, cookies and session dumps. That holds for code, comments, docs, tests, fixtures,
  commit messages and PR text.
- Never commit a network's own client code: libdave's output stays in `DITHER_DAVE_DIR` (docs/calls.md).
- Tests and examples use invented data and the demo world.
- **Before every commit**, read `git diff --cached` for the above, then sweep what you added:
  `git diff --cached -U0 | grep '^+' | grep -nIE '[0-9]{15,}|@[a-z0-9-]+\.[a-z]{2,}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|192\.168\.|\.ts\.net|/home/|acc_[A-Za-z0-9_-]{8,}'`.
  Then look for names by eye: a pattern can't find them.

## Real accounts

The owner's accounts are real, and a ban or a stray message can't be taken back.

- Never send, react, link a device, accept terms of service or solve a captcha on a real account. Test with the
  demo world, the Matrix testbed (`packages/adapter-matrix/testbed`), or the throwaway account named in
  `AGENTS.local.md`, and only where that file says.
- Never read or print private message content from live data. Counts, ids you were given and timings are fine.

## Working on it

- Bun. `bun install`, then `bun run typecheck`, `bun run test` (`scripts/test-all.ts`) and `bun run web:build`.
  `bun run hub -- --demo --data <temp dir> --port <free port>` starts a hub on a seeded demo world.
- Work in a `git worktree` on a branch, never in a checkout someone else may be using: don't switch, reset or
  stash a shared checkout.
- Every change goes through a pull request that merges itself when the required `check` passes
  (`gh pr create`, then `gh pr merge --auto --squash`). The PR title becomes the commit's title:
  "Area: what changed, in a plain sentence".
- CI (docs/testing.md): no retries, no new sleeps or timing gates in tests; fix or quarantine a flaky test. Byte
  budgets live in `budgets.json`; a raise needs a reason that names the change.
- Deploys are automatic: a deployer ships each merge to main once CI is green (docs/deploy.md, "Deploying itself").
  Never deploy by hand. Label a PR `hold-deploy` to hold it and everything merged after it.
- Never start a second hub on the live data directory, and never open the live database read-write. A copy of it is
  made with `sqlite3 <db> "VACUUM INTO '<file>'"` only: another connection can lock out the hub's writes.
- Tests and trial hubs use a free port of their own and a temporary data directory (docs/deploy.md, "Demo and test hubs").
- Models run locally (docs/deploy.md, "Categories and local models"); never send message data to a hosted service.
- Keep docs/ true: when a change makes a doc wrong, fix the doc in the same PR.
