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

## Networks that run only in dither-accounts

`telegram`, `gmessages` (Google Messages: SMS and RCS through the phone), `messenger`, `instagram` and `x` (X's direct
messages) have no adapter here: their extractors live in dither-accounts (its docs/telegram.md, docs/gmessages.md,
docs/messenger.md and docs/x.md), so they work only in remote mode. Messenger, Instagram and X run the real web app
in a sandboxed browser there; you sign in in its live view, and a new chat with someone starts there too for now. The hub knows
them as networks (labels, addressing a new chat by @username or phone number, the add dialog's fields, the QR, code,
password, emoji and cookie steps of their sign-in).

A hub registered before these kinds existed asks the manager on its next start to manage them too
(`kindsToAsk` in remote.ts): approve that request on the manager's page. A request still open, or one you denied, is
not asked again.

## Approving a Telegram sign-in

Telegram asks a device that is already signed in to approve each new sign-in: the new device shows a QR code, and the
old one scans it. A Telegram account's page here can be that device, so the phone app is not needed. Its **Signed-in
devices** section (`ui/TelegramSignIns.tsx`) uses three account actions of dither-accounts' Telegram extractor (its
docs/telegram.md) through `POST /api/accounts/<id>/action`, and works only while the account is online:

- **Approve a sign-in** opens a scanner: the camera, read by the browser's `BarcodeDetector` where it has one and by
  jsQR (Apache-2.0, a chunk loaded only when a scanner opens) elsewhere; a field to paste the `tg://login?token=…`
  link; or a picture of the code. Only `tg://login?token=` links go further (`tglogin.ts`); any other code is "not a
  Telegram sign-in code". The camera stops when the scanner closes, when a code is read, and while the page is hidden.
- A code read never approves by itself. It leads to a warning: only approve a code your own device is showing you,
  because whoever gets you to scan their code gets your account. Telegram names the other device only after it is
  approved, so the warning can only ask. While this hub's own session is under a day old it also says there is no
  undo yet: Telegram lets only a session a day old sign others out. The approve button arms a second after the
  warning shows, so a tap meant for the step before cannot land on it.
- Approving (`approveLogin {link}`) shows the new session's device, app and place, with **That wasn't me: sign it
  out** (`endSession {hash}`).
- The list (`sessions`) shows each session's device, app, place and when it was last active, this hub's own first and
  marked, with no sign-out. Every other row signs out after a short confirm.

Refusals (expired, already used, not a sign-in, a session too new to end others) are shown as the extractor words
them. `hash` is an opaque string: Telegram's 64-bit ids may be negative. On the Android app the WebView asks for the
camera the way calls do (`MainActivity.onPermissionRequest`). `scripts/verify-telegram-approve.ts` runs all of it
against a throwaway manager with the fake Telegram and a fake camera; never point it at a real account.

## Accounts the manager holds

The page works the same for an account whatever runs it; for one the manager runs:

- **Log and live view.** "Adapter log" asks the manager (`admin log`), and the live view goes through the manager's
  socket for the account (`/consumer/liveview/<id>`, on the hub's token), so both work for an account whose session
  is not in the hub's data.
- **Names and disabling follow both ways.** A rename here tells the manager; a rename or a disable on its page shows
  here. The last rename wins.
- **Not running there.** While the manager reports why it is not running an account, the account here is `error`
  with an attention that starts "Not running in dither-accounts:". It clears when the manager's error does.
- **Leaving the manager's list** (forgotten there, or the hub lost its grant). The hub runs it itself only if its
  session is in the hub's data: its directory holds more than `adapter.log` and `extractor.lock`, as an imported
  account's does. Any other account gets status `error`, "Removed from dither-accounts…". Accounts the manager ran
  before are held to the same rule at startup.
- **Removing it here** keeps its session in dither-accounts unless "Also delete its session" is ticked
  (`DELETE /api/accounts/<id>?purge=1`). The box shows only when the manager holds the session (`managedBy.origin`
  is not `import`), and the manager deletes only directories it made. Deleting a Signal or WhatsApp session does not
  unlink the device on the phone.
- **New accounts while the manager is unreachable** are refused (503, "dither-accounts is not reachable…") rather
  than run here: the manager is where accounts live.
- **Accounts another app or the manager's page added** show here too, under their network, in the first free colour.

Views say who runs an account: `managedBy` (`{ url, origin }`) on an account the manager lists, and `accountsManager`
in the bootstrap and sync answers. With `DITHER_ACCOUNTS_PUBLIC_URL` set (the manager's page as your browser reaches
it), the page links to the account there and to the manager from the account list and the add dialog.

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

- **Calls, the Discord live view, Signal and WhatsApp linking** go through the same events and commands. They are
  verified only with the Matrix testbed (`scripts/verify-accounts-matrix.ts`) and the fake chat extractor
  (`test/remote.test.ts`), never on a live account.
- **The adapters still have a copy here** (`packages/adapter-*`) until dither-accounts is published, so this repo
  runs on its own. The hub prefers dither-accounts' copy when it is next to this checkout; `accounts-sync.ts --check`
  says how far this one is behind.
