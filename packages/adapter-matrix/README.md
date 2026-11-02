# @dither-chat/adapter-matrix

The Matrix adapter: one Client-Server API session per hub account, plain `fetch`, no SDK.
The hub spawns it as `bun packages/adapter-matrix/src/main.ts` with the `DITHER_*` environment
described in `packages/protocol/src/adapter.ts`.

```
src/main.ts      entry: linkHub, one-syncer-per-account lock, orphan watchdog
src/adapter.ts   login, /sync loop, timeline -> facts, commands
src/rooms.ts     joined-room state, spaces graph, shapes, names, power levels, push-rule mutes
src/messages.ts  event content -> message kind/body/attachments, relations, mentions
src/format.ts    Matrix HTML <-> canonical Markdown (protocol MessageFact.body)
src/db.ts        private state in $DITHER_ACCOUNT_DIR/matrix.sqlite (bun:sqlite)
src/http.ts      tiny CS API client (rate limits, retries, typed errors)
testbed/         local continuwuity homeserver with users and sample traffic
test/            unit tests (bun test) and an end-to-end harness with a fake hub
```

## Account setup

Config (`DITHER_ACCOUNT_CONFIG`, non-secret): `{ "homeserver": "https://matrix.org", "userId"?: "@you:matrix.org" }`.
Without `homeserver` it is discovered from the user id's `.well-known/matrix/client`.

Secret (`$DITHER_ACCOUNT_DIR/secret.json`): `{ password?, accessToken?, deviceId?, userId? }`.
With only a password the adapter logs in (`m.login.password`, device name "dither-chat"), saves
`accessToken`, `deviceId` and `userId`, and drops the password. If the token is later rejected
(`M_UNKNOWN_TOKEN`, 401) the account goes to status `attention` / `login`; fix it with

```sh
bun packages/hub/src/cli.ts action <accountId> relogin '{"password":"..."}'
```

or by editing `secret.json` (re-read every 15 s while waiting). The device id is reused.

Actions: `resync` (drop the since token, full initial sync, everything re-sent as backfill),
`relogin {password}`, `status`.

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
`m.sticker`, `m.location`, polls, and `m.room.encrypted` as kind `encrypted` with an empty body.
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
  public **Lobby** outside any space, and **Secret plans** (encrypted, one undecryptable event)
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
bun test packages/adapter-matrix                      # format conversion unit tests
bun packages/adapter-matrix/test/integration.ts       # needs the testbed: real adapter + fake hub, every command
bunx tsc -p packages/adapter-matrix --noEmit
```

The integration harness logs in as a fresh zyan device (logged out again at the end) and writes its
test messages to "Notes to self" and the `#dev` thread, redacting them afterwards.

## Not done yet

- **End-to-end encryption.** Encrypted events show as kind `encrypted`; nothing is decrypted or
  encrypted, and the device publishes no keys. Sending, editing and adding reactions in an encrypted
  room are refused, because they would reach the server in plaintext. Media in encrypted rooms (`file` instead of `url`)
  would be served as ciphertext.
- Invites are logged, not surfaced (the protocol has no invite fact). State changes (joins, renames)
  are not rendered as system messages.
- Sending media, typing notifications and presence (no protocol commands for them).
