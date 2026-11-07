# Accounts in dither-accounts

[dither-accounts](../../dither-accounts) is one place for signed-in accounts. Its extractors hold each account's
session, apps ask for access, you approve, and its manager routes their calls and the accounts' events between them,
keeping none of it. dither-chat's adapters moved there (`extractors/<kind>`), and this hub is one of its apps.

With `DITHER_ACCOUNTS_URL` set, the hub hands accounts to the manager **one at a time**:

- **Accounts the manager lists for this hub are remote.** Their adapters run under the manager, on the same session
  directories as before (imported in place). Their events reach the hub through the manager and take the same path as
  a local adapter's: ingest, triage, calls. Commands go out as the manager's calls. Starting, stopping, restarting,
  secrets, new accounts and deletions go through its account administration.
- **Every other account runs here, exactly as without the manager.**

Without `DITHER_ACCOUNTS_URL` nothing changes: that is the rollback.

The code is `packages/hub/src/remote.ts`: `RoutedSupervisor` is the hub's `Supervisor` with each method routed by
account. It loads the manager's client from a dither-accounts checkout beside this repo (`DITHER_ACCOUNTS_CLIENT`
overrides the path), so dither-chat does not depend on dither-accounts.

## What the hub asks for

On its first start in this mode, the hub registers as the app `dither-chat` and keeps `{ app, token }` in
`$DITHER_DATA/accounts-app.json` (0600). It asks for two things:

- **`chat` at manage, on all accounts:** read, write and settings.
- **`accounts` at manage, for discord, signal, matrix and whatsapp:** add, sign in, start, stop and remove the chat
  accounts it sets up.

Approve both on the manager's page or with `bun ~/Projects/dither-accounts/packages/manager/src/cli.ts apps` and
`… approve <request>`.

If the manager forgets the app, the hub registers again on its next start.

## While the hub restarts

The manager keeps running the remote adapters. Their events wait for the hub in the manager's memory, never on disk.
If more wait than the manager keeps (100,000 events or 64 MB), it drops that account's and tells the hub (a gap). The
hub then restarts that adapter, and its fresh snapshot fills the hole.

An account that becomes remote while the manager already has it online is also restarted once, for the same reason:
its snapshot went by before the hub could see it.

The hub remembers which accounts the manager ran (`accounts-app.json`). A hub that starts while the manager is down
leaves those alone, so they are offline rather than run twice.

## One process per account

The hub takes `<account dir>/extractor.lock` before it starts an adapter, and so does the manager. Both also refuse
while any live adapter process for the account exists, which covers adapters left behind by a crash.

A refused account says "Not started here: …" on its card and is tried again every 15 s. An adapter from before a crash
that reconnects to the hub is left to run.

## Moving an account

Matrix first, then Signal and WhatsApp, Discord last. The hub must already be a build with this code (`lock.ts`) and
the manager must be running with the hub registered and approved.

```sh
systemctl --user stop dither-chat.service                       # the hub's adapters stop with it
bun ~/Projects/dither-accounts/packages/manager/src/cli.ts import-dither-chat \
    --hub-data ~/Projects/dither-chat/.data --accounts <id>      # in place; the manager starts it
systemctl --user start dither-chat.service                      # the account is remote now, the rest local
```

Check it:
- `cli.ts accounts` shows it online in the manager.
- `ps` shows its process under `dither-accounts/extractors/`, and none under `dither-chat/packages/adapter-`.
- Its card in the hub is online.
- New messages arrive.

The adapter log stays where it was: the account's `adapter.log`, which the manager now writes.

## Rollback

- **One account:** `cli.ts forget <id>`. The manager stops the account and drops it, keeping its directory, and the
  hub, seeing it gone, runs it itself again. No restart is needed.
- **Everything:** remove `DITHER_ACCOUNTS_URL` from the hub's unit, stop the manager, and restart the hub. Every
  account runs here again on its own directory.

Either way the hub runs the same code the manager did: an account the hub runs itself starts from
`../dither-accounts/extractors/<kind>` when that checkout sits next to this one, then from `DITHER_ADAPTERS_DIR`
(`<dir>/<kind>/src/main.ts`, colon-separated), and only then from this repo's `packages/adapter-<kind>`
(`adapterEntry` in supervisor.ts). A rollback never opens a newer session store with older code.

## Keeping the two in step

The protocol is written here and copied there; the adapters are written there.

```sh
bun scripts/accounts-sync.ts           # copy packages/protocol over dither-accounts' packages/chat-protocol
bun scripts/accounts-sync.ts --check   # exit 1 if they differ; also lists adapter files that differ
```

Every hello carries `PROTOCOL_VERSION` (protocol adapter.ts; the shared client adds it). An adapter that names
another version gets an attention on its account saying which side to update; one from before versions is taken as
it is. Bump the number when an event or command changes in a way the other side cannot read.

## Not done

- **New accounts' logs.** An account added while this mode is on lives in the manager's data dir, so the hub's
  "adapter log" view does not show its log.
- **Calls, the Discord live view, Signal and WhatsApp linking** go through the same events and commands. They are
  verified only with the Matrix testbed (`scripts/verify-accounts-matrix.ts`) and the fake chat extractor
  (`test/remote.test.ts`), never on a live account.
- **The adapters still have a copy here** (`packages/adapter-*`) until dither-accounts is published, so this repo
  runs on its own. The hub prefers dither-accounts' copy when it is next to this checkout; `accounts-sync.ts --check`
  says how far this one is behind.
