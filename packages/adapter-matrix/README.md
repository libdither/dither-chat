# @dither-chat/adapter-matrix

The Matrix adapter: one Client-Server API session per hub account, plain `fetch`, no SDK, plus the Rust crypto library for end-to-end encryption if you turn that on.
The hub spawns it as `bun packages/adapter-matrix/src/main.ts` with the `DITHER_*` environment
described in `packages/protocol/src/adapter.ts`.

```
src/main.ts      entry: linkHub, one-syncer-per-account lock, orphan watchdog
src/adapter.ts   login, /sync loop, timeline -> facts, commands
src/rooms.ts     joined-room state, spaces graph, shapes, names, power levels, push-rule mutes
src/messages.ts  event content -> message kind/body/attachments, relations, mentions
src/format.ts    Matrix HTML <-> canonical Markdown (protocol MessageFact.body)
src/db.ts        private state in $DITHER_ACCOUNT_DIR/matrix.sqlite (bun:sqlite)
src/e2ee.ts      end-to-end encryption: the OlmMachine and the requests it asks for, backup, verification
src/cryptostore.ts  IndexedDB for that library under Bun, written through to crypto.sqlite
src/recovery.ts  recovery key format and Secret Storage
src/http.ts      tiny CS API client (rate limits, retries, typed errors)
testbed/         local continuwuity homeserver with users and sample traffic
test/            unit tests (bun test) and an end-to-end harness with a fake hub
```

## Account setup

Config (`DITHER_ACCOUNT_CONFIG`, non-secret): `{ "homeserver": "https://matrix.org", "userId"?: "@you:matrix.org" }`.
Without `homeserver` it is discovered from the user id's `.well-known/matrix/client`.

Secret (`$DITHER_ACCOUNT_DIR/secret.json`): `{ password?, accessToken?, deviceId?, userId?, e2ee? }`.
With only a password the adapter logs in (`m.login.password`, device name "dither-chat"), saves
`accessToken`, `deviceId` and `userId`, and drops the password. If the token is later rejected
(`M_UNKNOWN_TOKEN`, 401) the account goes to status `attention` / `login`; fix it with

```sh
bun packages/hub/src/cli.ts action <accountId> relogin '{"password":"..."}'
```

or by editing `secret.json` (re-read every 15 s while waiting). The device id is reused.

Actions: `resync` (drop the since token, full initial sync, everything re-sent as backfill),
`relogin {password}`, `status`, and for encryption `setupEncryption {recoveryKey?}`, `encryptionStatus`,
`addRecoveryKey {recoveryKey}`, `verifyDevice {step: start|accept|confirm|mismatch|cancel}`.

## How Matrix maps onto the ontology

| Matrix | dither-chat |
| --- | --- |
| room with `m.room.create` type `m.space` | `SpaceFact` kind `community`; parents from `m.space.child` (non-empty `via`, `order` -> position) and validated `m.space.parent` |
| room in `m.direct` | `direct`, participants you + peer, peer identity `contact: true` |
| only you in the room | `self` |
| child of a joined space | `channel` with `spaces` (several parents allowed) |
| public join rule or > 20 members | `channel` without spaces |
| otherwise | `group` (full member list fetched once via `/joined_members`) |
| `m.thread` relation | thread conversation `<roomId>\|<rootEventId>`, name = root text (60 chars), root gets `threadRoot` |
| members can't post (power levels) | variant `announcement` |
| push rules: override rule with no notify / room rule with no notify | native mute `none` / `mentions` |

Messages: `m.text`, `m.notice`, `m.emote`, `m.image`/`m.file`/`m.video`/`m.audio` (attachment url is the
`mxc://` URL; the hub fetches it with `fetchMedia`, authenticated media first, legacy download as fallback),
`m.sticker`, `m.location`, polls, and an `m.room.encrypted` event that cannot be decrypted as kind `encrypted` with an empty body.
`formatted_body` is converted to canonical Markdown (pills become `<@@user:server>`); a plain `body` is
used as typed, with the legacy reply fallback stripped. Edits re-emit the target with `editedTs`
(fetching the target if it is older than anything seen), redactions emit `delete` (or a tombstone plus
`delete` for messages first seen already redacted), reactions are indexed so a redacted reaction can be
removed, and backfilled messages carry a reaction snapshot from that index.

Sync: lazy-loading filter, 50-event timeline window. The initial sync is backfill (`live=false`),
incremental syncs are live, except a newly joined room's history before your join. A limited
incremental timeline (more than 50 events while the adapter was down) is closed by paging back to the
last event seen. Recent threads are discovered per room with `/threads` so a thread older than the window
still shows up. Read state: `unread_notifications` counts plus your `m.read` receipt or `m.fully_read`.
The since token, per-room back-pagination tokens and the relation indexes live in `matrix.sqlite`, so a
restart resumes where it left off.

## End-to-end encryption

Off per account until you press **Set up encryption** on the account's page (or run
`cli.ts action <id> setupEncryption '{"recoveryKey":"..."}'`). Setting up creates this device's keys and
publishes them on the account, so your other clients show a new, unverified device. There is no switch to
take that back: to undo it, set `e2ee.on` to false in `secret.json` and remove the device from another client.
While it is off, encrypted rooms show `encrypted` messages and refuse every write, and the composer says where to set it up.

**The library.** [`@matrix-org/matrix-sdk-crypto-wasm`](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm), the Rust crypto
Element uses. No Olm or Megolm is implemented here. Both candidates load under Bun on NixOS. The native
`matrix-sdk-crypto-nodejs` has a SQLite store of its own, but its API has no way to import a room key
and no verification at all, so it could never read old messages. The WebAssembly build has both and needs nothing
installed besides `bun install`, but its only persistent store is IndexedDB, which Bun does not have.
`src/cryptostore.ts` closes that gap: [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB) holds the store in memory, and every
committed transaction is written synchronously to `crypto.sqlite` (0600, `synchronous = FULL`) before the
library carries on, then replayed at startup. Values are already encrypted by the library with `e2ee.storeKey` from `secret.json`.
Losing that key or `crypto.sqlite` loses the device: log in again as a new device. Cost: about 90 MB
of memory per account with encryption on, plus about 3 KB per room key, since the whole store lives in memory.

**Receiving.** To-device messages, `device_lists` and the key counts go to the library before a sync's
timelines, and the since token only moves after, so keys are not lost to a crash. Timeline, history, thread and
bundled events are decrypted as they are processed. Cleartext is what `matrix.sqlite` and the hub store, so
search works. What has no key yet stays kind `encrypted` and goes into the `utd` table by session; when a key arrives
(to-device, backup, another device) those events are re-emitted in place. Edits and reactions wait the same way, without a bubble of their own.
A plaintext edit cannot replace an encrypted message, and a plaintext message in an encrypted room gets a warning in the timeline.

**Sending.** Everything goes through `sendEvent` and `uploadFile`. In an encrypted room they share the room
key with every device of every member (invitees too, unless history is `joined`), encrypt, and send `m.room.encrypted`.
If any step fails the write fails. There is no path to plaintext, and `test/never-plaintext.test.ts` holds that
with crypto off, with it failing, and with a state event pretending encryption was turned off. Encryption stays on once a room has it.
Files upload as ciphertext, without name or type, under the `file` key. Devices are not filtered by trust, like Element's default.

**Encrypted media.** An attachment's URL is `mxc://server/id#<event id>`. `fetchMedia` takes the key from that
event, checks the hash, decrypts, and answers with the sender's media type only from a short list (no HTML or SVG on the hub's origin).

**Old messages.** The recovery key can be any of: the backup's own key, a Secret Storage key, or a Secret Storage
passphrase. It is saved in `secret.json` only after it has opened something. A key for a session
is fetched from the backup when an event needs it, one session at a time, rather than all at once: a whole backup is
huge and most of it would never be read. So everything the hub has stored, and everything you scroll back to, decrypts.
Room keys this device receives are uploaded to the same backup.

**Verification.** With a Secret Storage key, the adapter imports the cross-signing keys and signs its own device,
so it shows verified everywhere. Otherwise, emoji verification (SAS) with another of your devices, started from
either side, shows through the account's attention card without taking the account offline. After it, the other device
sends over the backup key and cross-signing keys if it has them.

Not done:

- **Other people.** No verifying other users, no marking of messages from unverified senders or devices. Only the plaintext warning above shows.
- **QR verification**, and verification requests inside a room. Emoji only, to-device only, your own devices only.
- **Creating cross-signing** or a backup, if the account has neither. Use another client for that once. It would reset what is there, so the adapter never does it.
- A late key updates the message but sends no new notification: the push for it said "Encrypted message".
- Decrypted text and media are at rest in `matrix.sqlite`, the hub's database and its media cache, protected by file modes only.

Verified: `bun test`, and `test/integration.ts` against continuwuity with two other clients built on the same library,
both directions, in full: text, replies, edits, reactions, threads, late keys, media, restart, backup, Secret Storage, SAS.
`scripts/verify-e2ee.ts` runs setup, composer, image and search through the real hub and PWA in headless Chromium.
Once by hand, not in the repository: matrix-nio 0.26 (Python, its own attachment crypto, vodozemac for Olm) exchanged text, an edit, a reaction
and files both ways with the adapter through a real hub. **Never run:** Element, or matrix.org or any other real homeserver. continuwuity
lacked nothing this needs. A room key request answered by another device was not exercised.

## Local testbed homeserver

`testbed/testbed.ts` runs [continuwuity](https://continuwuity.org) from nixpkgs on `127.0.0.1:6167`
(server name `dither.test`, federation off, registration by token) and seeds it. All state, including
the generated passwords and the registration token, is in `.data/matrix-testbed/` (gitignored):
`testbed.json` (credentials, room ids), `db/`, `server.log`, `server.pid`, `continuwuity.toml`.

```sh
bun packages/adapter-matrix/testbed/testbed.ts up        # start if needed, seed what's missing, print status
bun packages/adapter-matrix/testbed/testbed.ts start     # just (re)start the homeserver; data is kept
bun packages/adapter-matrix/testbed/testbed.ts stop
bun packages/adapter-matrix/testbed/testbed.ts status    # pid, rooms, and the hub "add" command with zyan's password
bun packages/adapter-matrix/testbed/testbed.ts chatter --every 15          # alice/bob post every 15 s (Ctrl-C)
bun packages/adapter-matrix/testbed/testbed.ts chatter --every 3 --count 5 --room general
bun packages/adapter-matrix/testbed/testbed.ts say alice dm "hello"        # one message (rooms by key, see status)
bun packages/adapter-matrix/testbed/testbed.ts tail general 20             # what the homeserver has
bun packages/adapter-matrix/testbed/testbed.ts reset --yes                 # delete everything
```

Every command is idempotent: seeding runs in steps that are recorded in `testbed.json`, and `up` on a
running server only fills in what is missing. The binary is found via `$CONTINUWUITY_BIN`, `conduwuit`
on `PATH` (the repo's dev shell has it), or `nix build nixpkgs#matrix-continuwuity`.

What gets seeded (users `@zyan`, `@alice`, `@bob`, `@carol` on `dither.test`; zyan is the account
for the hub):

- space **Dither Testbed** (with an icon) > `#general`, `#dev`, `#announcements` (only moderators can post),
  `#archive` (120 messages for scrollback), and the subspace **Off-topic** > `#memes`, `#crossposts`
- space **Rust Friends** > `#crossposts`, so `#crossposts` has two parents
- a DM zyan <-> alice, marked in `m.direct` on both sides (with a text file)
- private unencrypted group **Weekend plans** (zyan, bob, carol), **Notes to self** (zyan only),
  public **Lobby** outside any space, and **Secret plans** (encrypted, one event nothing can decrypt)
- in `#general`: a reply with a legacy fallback, an edit, reactions, a redacted reaction, a redacted
  message, formatting, an emote, an image upload, and a message that mentions zyan
- in `#dev`: a thread with fallback and genuine in-thread replies, a notice, a reaction
- in `#archive`: a reaction, an edit and a thread reply posted late against early messages

To point a hub at it:

```sh
bun packages/hub/src/main.ts --data /tmp/dither-matrix-test --port 8481
bun packages/adapter-matrix/testbed/testbed.ts status     # prints the matching "cli.ts add matrix ..." line
```

## Tests

```sh
bun test packages/adapter-matrix                      # format, crypto store, recovery keys, never-plaintext
bun packages/adapter-matrix/test/integration.ts       # needs the testbed: real adapter + fake hub, every command, encryption
bun scripts/verify-e2ee.ts                            # needs the testbed: encryption through a real hub and the PWA in Chromium
bunx tsc -p packages/adapter-matrix --noEmit
```

The integration harness logs in as a fresh zyan device (logged out again at the end) and writes its
test messages to "Notes to self" and the `#dev` thread, redacting them afterwards. Its encryption half
(`test/integration-e2ee.ts`) makes a new encrypted room each run and leaves it again, and replaces zyan's cross-signing keys and backup on the testbed.

## Not done yet

- Invites are logged, not surfaced (the protocol has no invite fact). State changes (joins, renames)
  are not rendered as system messages.
- Typing notifications and presence, outgoing (no protocol commands for them).
