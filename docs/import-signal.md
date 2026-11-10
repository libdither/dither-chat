# Importing Signal history from a backup

signal-cli is a linked device, so the hub only has Signal messages from the day it was linked. The rest of the
history is on the phone, in Molly, and the only way to get it off the phone is a backup. This is the design for
reading one and merging it into the hub; the shared pipeline (sources, readers, plan, conflicts, apply) is
`docs/import.md`. Built: uploading a backup from the Signal account's History section, a census that reads its
structure and counts (`packages/hub/src/imports/signal-backup.ts`, also `scripts/signal-backup-probe.ts`), and readers
for both formats: new-format snapshots (`signal-v2.ts`, *Reading it* below) and legacy `.backup` files
(`signal-legacy.ts`, *Reading a .backup*), which also brings in what Molly keepmsg kept (*Kept content*).

## Sources

| Source | What it holds | How it is protected | Verdict |
|---|---|---|---|
| **Legacy `.backup`** (Signal/Molly "on-device backups", also phone-to-phone transfer) | The whole SQLite database as SQL statements, plus every attachment, sticker and avatar | 30-digit passphrase, AES-256-CTR plus truncated HMAC per frame | **Primary.** It's the only format the keepmsg fork writes kept messages into |
| **Backup v2, local folder** (`SignalBackups/signal-backup-<time>/{metadata,main}` + shared `files/`) | Typed protobuf frames (`lib/archive/.../Backup.proto`). Attachments live in `files/`, named by content hash | `main`: AES-CBC + HMAC under keys derived from the account entropy pool (the 64-character recovery key) and the ACI. Each attachment has its own key, stored in its frame | **Second.** Cleaner to map, but it holds no keepmsg content (see below) |
| **Molly's live database** | Everything | SQLCipher, with the key wrapped by the Android keystore (and Molly's passphrase lock) | **No.** It can't be read off the device without root and the keystore |
| **Signal Desktop profile** (`~/.config/Signal`, on this machine) | Only what Desktop saw while it was linked. Here that's a ~4 MB `sql/db.sqlite`, ~180 attachment dirs, last written 2024–2026 | SQLCipher. The key in `config.json` (`encryptedKey`) is wrapped by the desktop keyring (`safeStorageBackend`) | **Optional extra.** Same message identity, so it merges the same way |
| signal-cli data dir | Keys and contacts. It keeps no message history | n/a | Nothing to import |

I only checked file names, sizes and dates. **No `.backup` file or `SignalBackups` folder exists on this machine**
(searched `/`, `/home`, `/persist`). The backups are on the phone, or wherever the user copied them.

## What the Molly fork changes

The fork, `mollyim-keepmsg` (private), is upstream Molly plus `keepmsg.patch`. A local checkout of the patched
source is in `~/Repos/molly`. It changes what a backup contains, not its format:

- **Disappearing messages** are kept, not deleted. Rows get `message.keepmsg_expired = 1` and are hidden.
  Upstream Molly leaves every message whose timer has started out of a legacy backup. The fork's exporter keeps
  them (`isNonExpiringMessage` returns true), along with their attachments, reactions, mentions and polls.
- **Remotely deleted messages** keep their body, quote, attachments and earlier revisions. `deleted_by` is set,
  but the content isn't blanked.
- **Backup v2 (new-format local, Secure Backups, link-and-sync)** behaves like stock: disappeared messages are
  left out and deleted ones become empty placeholders. Kept attachments aren't copied in.
- The **per-chat "stop keeping" opt-out** isn't in a legacy backup (it's not one of the settings that travel).

So the legacy `.backup` is the only artifact with the full history. It's also the only one with content the user
deliberately hid. The importer has to treat that content as a choice (see *Kept content*).

When legacy backups exist: since Molly switched formats, `.backup` files are only written if legacy backups were
already on, or after restoring from a `.backup`. Settings → Backups → On-device backups shows which format is
active. Upgrading that screen deletes the existing `.backup` files.

## Legacy `.backup` format

Read from `app/src/main/java/org/thoughtcrime/securesms/backup/` (`BackupRecordInputStream`, `FullBackupBase`,
`FullBackupExporter`) and `app/src/main/protowire/Backups.proto`:

```
u32be len | BackupFrame{ header: { iv[16], salt[32], version } }      plaintext
repeat:
  u32be len (AES-CTR encrypted when version >= 1)
  ciphertext[len-10] | hmac[10]                                        BackupFrame
  if the frame is attachment/sticker/avatar: ciphertext[length] | hmac[10]
until BackupFrame{ end: true }
```

- Key: `k = SHA-512(salt ‖ pass ‖ pass)`, then `k = SHA-512(k ‖ pass)` for 250 000 rounds in total. `pass` is the
  30 digits with spaces removed; keep the first 32 bytes. Then `HKDF-SHA256(k, info="Backup Export")` gives 64
  bytes: cipher key, then MAC key.
- IV: the header IV with its first 4 bytes replaced by a big-endian counter. The counter starts at the IV's own
  first word and goes up by one per frame and per blob. In version 1 the 4-byte length is the start of the frame's
  CTR stream and is covered by the MAC. A blob's MAC covers its IV and then its ciphertext.
- Frames: `statement` (SQL plus typed parameters), `preference`, `keyValue` (KeyValueStore entries, including
  `account.aci`), `attachment{rowId, attachmentId, length}`, `sticker`, `avatar`, `version` (the database's
  schema version), `end`.
- Statements are `CREATE TABLE …` copied from `sqlite_master`, then `INSERT INTO <table> VALUES (?,…)` in column
  order. Session, prekey, sender-key and FTS tables are skipped, so there are no session keys. The identity key
  pair is in the `keyValue` frames, though. **The decrypted stream is as sensitive as the phone.**

The easiest way to decode a legacy backup is to replay the statements into a scratch SQLite database (in memory,
or on tmpfs) and read it with SQL. That's what Molly's own `FullBackupImporter` does.

## Backup v2 format

- `metadata`: `Metadata{version, backupId}`.
- `main`: IV ‖ AES-256-CBC(gzip(varint-delimited frames)) ‖ HMAC-SHA256. The keys are libsignal's
  `MessageBackupKey`, derived by HKDF from the account entropy pool and the ACI.
- After decryption the first record is `BackupInfo{version, backupTimeMs, …}`, then `Frame`s: `account`,
  `recipient` (contact with an ACI, group with a masterKey, self, …), `chat`, `chatItem`, `stickerPack`, …
- `ChatItem{chatId, authorId, dateSent, revisions[], incoming|outgoing|directionless, standardMessage{text{body,
  bodyRanges}, quote{targetSentTimestamp, authorId}, attachments[FilePointer], reactions[{emoji, authorId,
  sentTimestamp}]} | stickerMessage | remoteDeletedMessage | updateMessage | poll | …}`.
- A group recipient carries only its masterKey. The group id signal-cli uses is derived from it with zkgroup
  (`GroupSecretParams.deriveFromMasterKey(mk).getPublicParams().getGroupIdentifier()`), so the importer needs
  libsignal or an equivalent.

`bun scripts/signal-backup-probe.ts v2 <file>` counts the frames of a plaintext stream. It was checked against
Signal's own test vectors in `~/Repos/molly/app/src/androidTest/assets/backupTests/*.binproto` (synthetic, public
data): quotes, reactions, attachments, edits (`revisions`) and remote deletes are all counted correctly.

### Reading it (built: `packages/hub/src/imports/signal-keys.ts`, `signal-v2.ts`)

No native library: the derivations are ported and checked against libsignal-client's own output (pinned in
`test/signal-v2.test.ts`), and group ids against all 75 of a real signal-cli account's groups.

- Recovery key (Molly → Settings → Backups → On-device backups → View recovery key; Molly shows `#` for O and `=`
  for 0) → backup key `HKDF(pool, "20240801_SIGNAL_BACKUP_KEY")`. The hub stores only this backup key
  (`<source>/backup-key`, 0600), never the recovery key, which could restore the account.
- `metadata` → backup id: AES-256-CTR under `HKDF(backup key, "20241011_SIGNAL_LOCAL_BACKUP_METADATA_KEY")`, its
  12-byte nonce and a counter from 0. So the ACI isn't needed.
- `main`: HMAC key ‖ AES key = `HKDF(backup key, "20241007_SIGNAL_BACKUP_ENCRYPT_MESSAGE_BACKUP:" ‖ backup id)`.
  The MAC is checked before anything is decrypted; a wrong key is told apart there.
- Attachments: `files/<2 hex>/hex(SHA-256(plaintextHash ‖ localKey))`, sealed as Signal seals attachments
  (IV ‖ AES-256-CBC ‖ HMAC-SHA256 under the 64-byte `localKey`), padded; the reader trims to `size` and checks
  the plaintext hash. They go to `<data>/imports/media/<sha256[0:2]>/<sha256><ext>` like Discord's.
- Group ids: zkgroup's `Sho` (HMAC-SHA256 ratchet) over the master key with
  `Signal_ZKGroup_20200424_GroupMasterKey_GroupSecretParams_DeriveFromMasterKey`, 32 bytes, base64.
- Mapping follows the live adapter word for word where it has a line: text through `fromSignal` (styles and
  mentions from `BodyRange`), quotes → `replyTo` + `extra.quote`, reactions, edits (the original's timestamp names
  the message, `editedTs` the latest), stickers (pack id hex), view-once as a placeholder, contacts, polls, calls,
  timers and group changes as call/system lines. Left out and counted: SMS, deleted messages, authors without an
  ACI, and updates the hub has no line for (profile changes, safety numbers, pins, …).
- The newest snapshot is read; older ones in the same folder are ignored.

### Reading a .backup (built: `packages/hub/src/imports/signal-legacy.ts`, reader `signal-legacy@2`)

1. **Unpack.** Every frame is decrypted and its MAC checked. Only the tables an import reads are replayed into a
   private SQLite file: message, recipient, thread, attachment, reaction, mention, groups, group_membership and the
   poll tables. Keys, sessions, settings and key-value frames are never written. The file is
   `<data>/imports/work/<source>/legacy.sqlite` (0600), stamped with the source's hash in `legacy.json` so a new
   mapping doesn't decrypt again, and it goes when the source is removed. Each attachment's bytes go to the media store
   under their SHA-256, the same name the new-format reader gives the same file, so files both formats hold are stored
   once. Avatars and stickers' own blobs are skipped.
2. **Map.** SQL rows become the same facts as the table above. Old edit revisions (`latest_revision_id` set) are left
   out. The latest revision gives the words and the original's `date_sent` names the message. Reactions on either are
   kept. Quote thumbnails (`attachment.quote = 1`) go into `extra.quote`, and long text (`text/x-signal-plain`)
   becomes the body. Left out and counted: stories, safety-number and session lines, MMS never downloaded
   (`m_type` 130), and updates the hub has no line for.
3. **SMS and MMS** (no secure/push bit, base type 20–28) come in with `extra.sms` = `'sms'` or `'mms'` (`m_type` 128
   sent, 132 received). With someone who has an ACI they go into that person's Signal chat, as the phone showed them.
   Someone without one is `tel:<number as stored>` (short codes have no `+`) or `mailto:<email>`, in a chat
   `sms:<self ACI>:<that id>`. An MMS group (`recipient.type` 1, `__signal_mms_group__!<hex>`) is a group chat
   `mms:<hex>`, its members from `group_membership`. The Signal adapter sends only to `dm:` and `group:`, so these
   chats are history: a reply there fails with "not a Signal conversation of this account".

On a real backup (72k rows, 6.9 GB), the unpack and the mapping together take about 20 s. Attachments the new-format
import had already stored hash to the same files.

## Existing tools

- **signalbackup-tools** (bepaald, C++, in nixpkgs as `signalbackup-tools`). The most complete tool: it decrypts
  legacy `.backup` files to a plain SQLite database (`--output`), exports HTML/CSV, and also reads Signal Desktop
  databases. It tracks Signal's schema closely. It doesn't know `keepmsg_expired` but copies unknown columns
  through. **Recommended as the decoder** for a first import: run it locally, keep its output on tmpfs, never
  upload it.
- **signal-backup-decode** (Rust). Legacy only and unmaintained against current schemas. Not recommended.
- **Molly's own code**: `FullBackupImporter` (legacy) and `backup/v2/importer` (v2). These are the reference
  for edge cases.
- **libsignal `message-backup`** (Rust): a validator and JSON dumper for v2 streams, plus the key derivation.
  The natural decoder for v2.
- **sigtop / signal-export** for Signal Desktop. These need the Desktop key, which comes from the keyring.

None of these needs network access. The importer must not use any hosted service.

## Mapping onto dither-chat

Identity in the hub is deterministic: `hubId(prefix, 'signal', nativeId)` (`packages/protocol/src/ids.ts`).
`packages/adapter-signal/src/mapping.ts` defines the native ids, and the importer has to produce **exactly** these:

| Hub | Native id | From a legacy backup (SQL) | From backup v2 |
|---|---|---|---|
| identity | ACI uuid, lowercase | `recipient.aci` | `Contact.aci` (16 bytes → uuid) |
| self | ACI | keyValue `account.aci` | `Recipient.self` + `AccountData` |
| 1:1 conversation | `dm:<selfAci>:<peerAci>` (Note to Self: `dm:<self>:<self>`, shape `self`) | `thread.recipient_id` → recipient with an `aci` | `Chat.recipientId` → contact |
| group conversation | `group:<base64 groupId>` | `recipient.group_id` = `__signal_group__v2__!<hex>` → hex-decode → base64 | derived from `Group.masterKey` (zkgroup) |
| message | `<authorAci>:<dateSent>` | `message.from_recipient_id` → aci, `message.date_sent` | `ChatItem.authorId` → aci, `dateSent` |
| reply | `replyTo = <quoteAuthorAci>:<quote_id>` plus `extra.quote{author, ts, text}` | `quote_id` (target's date_sent), `quote_author` (recipient id), `quote_body` | `Quote{targetSentTimestamp, authorId, text}` |
| edit | original native id, `editedTs` = the latest revision's date_sent, body from the latest | rows chained by `original_message_id` / `latest_revision_id`. Only the original's `date_sent` names the message | `ChatItem.revisions[]` (oldest first). The outer item is the latest |
| reaction | `ReactionFact{key: emoji, authors:[aci]}` | `reaction(message_id, author_id, emoji, date_sent)` | `StandardMessage.reactions[]` |
| attachment | `AttachmentFact{nativeId, kind, mime, name, size, w, h, url: file://…}` | `attachment(_id, message_id, content_type, file_name, data_size, width, height)` + the blob frame with the same `attachmentId` | `FilePointer` + `files/<mediaName>` (decrypt with its key) |
| sticker | `kind 'sticker'`, `extra.sticker{packId, stickerId}` | `message` sticker columns + `sticker` table/blobs | `StickerMessage` |
| deleted | `deleted = 1`, empty body | `deleted_by IS NOT NULL` (older schemas: `remote_deleted = 1`) | `remoteDeletedMessage` |
| system/call | `kind 'system' / 'call'` | `message.type` bits (`MessageTypes`) | `updateMessage` |

Body formatting: `message.message_ranges` (BodyRangeList protobuf) and the `mention` table carry the same
information as signal-cli's `textStyles` and `mentions`. Feed them through `fromSignal()` in
`adapter-signal/src/markdown.ts`, so imported Markdown is byte-identical to what the live adapter would have
produced.

Message types: incoming and outgoing are bits in `message.type` (`MessageTypes.BASE_*`). Outgoing messages have
`from_recipient_id` = self, so their author is the self ACI, as in signal-cli's sent transcripts. Skip stories
(`story_type != 0`) and group-story replies. SMS/MMS (`MessageTypes.isSms…`) are read since signal-legacy@2,
see "Reading a .backup".

### Dedupe and merge with live data

Signal's message identity is (author ACI, sent timestamp). signal-cli's envelope timestamp and Molly's
`date_sent` are the same value, so a message the hub already has from live sync gets the same `msg_…` id from the
import. Overlap is the normal case: a backup taken today covers everything since the link.

`Store.message()` is an upsert that **replaces body, kind and attachments** of an existing row. Fed backup rows
naively, that would:

- give a row the hub already knows was deleted (`deleted = 1`, body `''`) its body back. The `deleted` flag is
  never cleared, and with keepmsg the backup still holds the content;
- overwrite a newer edit with an older one, if the backup predates the edit;
- replace live attachment rows (served from signal-cli's dir) with imported ones.

So import needs its own ingest mode, **fill-only**:

1. If the message id exists, leave it alone. At most, add reactions the hub doesn't have (add only, never remove)
   and fill in `reply_to_id` if it's empty.
2. If it doesn't exist, insert it with `live = false`. No triage, no notification, no unread change. Mark it
   `message_seen` for the Signal account and record `extra.imported = <backup id>`.
3. Move `last_message_at` only forward (the existing code already does this), so old history never reorders the
   inbox.
4. Mark the conversation's attention features stale (`conv_feature.stale_at`), so the inbox recomputes from the
   new, older messages.
5. Write `sync_change` rows through the normal dirty path, so clients pick up the new history. A large import
   should go in batches, in one transaction per conversation.

Conversations, identities and groups use the existing `ensureConversation` / identity upserts. These are already
safe to repeat, but the importer shouldn't overwrite a name or avatar that live sync set more recently: only fill
empty fields.

### Kept content (keepmsg)

A legacy backup from the fork contains messages the user's own phone hides: disappeared ones
(`keepmsg_expired = 1`, gone at `expire_started + expires_in`) and the content of deleted ones (`deleted_by` set,
gone at `keepmsg_deleted_at` from keepmsg.6). The hub already keeps these from live sync as an adversarial feature
(docs/history.md: `deleted`, `gone_how`, `gone_at` on the message, body and files left in place). An import keeps
the backup's the same way: a fact with `gone: { how, at }` goes in as a kept deleted or disappeared message.

- **The same gate as live sync.** While adversarial features are hidden, kept messages are served empty
  ("Deleted message", nothing to Show). Turning on Settings → Adversarial features shows them, collapsed, and
  `is:deleted` finds them. Message history → Forget erases them like any other kept message.
- **Not your own deletes.** A message you deleted yourself keeps nothing, as live sync does ("deleted by you" in the
  run's left-out counts, and the hub's copy isn't filled either).
- **Filling the hub.** A message the hub has as deleted and emptied (it heard the delete while not keeping deleted
  messages) gets the backup's words and files, still deleted. A message the hub has as normal and the backup has as
  disappeared or deleted (the timer ran out on the phone, or the hub missed the delete) is marked gone, and keeps the
  hub's words. Both count as `filled`. A run's `kept` counts every message that is now kept as gone, new or filled.
- **Nothing kept, nothing imported.** A stock-deleted message (empty) isn't brought in ("deleted, nothing kept").
- The per-chat "stop keeping" opt-out doesn't travel in a backup. A chat that was set to stop keeping has nothing
  kept in it, so nothing comes in from it.

### Attachments

Imported files go under the hub's data dir, because `server.ts` serves `file://` URLs only under `dataDir`:
`<dataDir>/imports/signal/<backup-id>/<sha256>.<ext>`, mode 0600, deduplicated by content hash. They are written
during the decode pass, and only for messages that are actually imported. Skip view-once media (it was meant to
be gone) and anything `keepmsg` that wasn't opted in. A typical backup is mostly attachments, so the importer
should print totals (the probe already does) and let the user cap it (`--max-attachment-bytes`, or `--no-media`
for text only).

## Recommended pipeline

```
phone: Molly → on-device backup, with "Include kept messages" (writes SignalBackups/ and a legacy .backup)
phone: dither-chat → Accounts → Signal → History → upload the folder, or the folder as one .zip (a phone's browser
       picks files, not folders), or the .backup alone (resumable; it goes to <data>/imports/sources/; a zip is
       unpacked beside it)
hub, in a worker:
  1. header check: is it a legacy backup, which version                 done on upload
  2. passphrase / recovery key → census                                 done; a wrong secret is forgotten
     (.backup: counts, date range, keepmsg rows; snapshots: chats, items, months)
  3. read → facts                                                       snapshots: done (signal-v2@1);
                                                                         .backup: done (signal-legacy@2)
  4. plan: new / same / fill / conflict / skip, per conversation         dry run, shown in the History section
  5. apply, fill-only, inside the hub                                    conflicts wait for review (docs/import.md)
```

Everything runs **inside the hub process**: the reader in a worker, apply through `Store` in fill-only mode. Then FTS
triggers, the journal, attention staleness and the dirty sets all stay consistent. Writing the database from outside
while the hub runs would bypass all of that and race the WAL. The reader reuses `adapter-signal/src/mapping.ts`
(`msgId`, `dmId`, `groupConvId`, `attachmentKind`) and `markdown.ts` (`fromSignal`), so ids and Markdown can't drift
from live sync.

### Prototype plan

1. **Done:** `scripts/signal-backup-probe.ts`. Reads the legacy header. With a passphrase it decrypts, checks
   every MAC, and counts frames, rows per table, blob bytes, keepmsg/deleted/edit rows and the month range. It
   prints the column lists of the tables an import reads. For v2 it counts frames of a plaintext stream. It
   never prints a value. `selftest` round-trips a synthetic backup (this only shows the reader matches the
   prototype's own writer). Compatibility with a real Molly backup is unverified until the user runs step 2 on
   one.
2. `decode-legacy.ts`: replay statements into `bun:sqlite` `:memory:`, and write blobs to a content-addressed
   temp dir. Test against a backup made by Molly's unit-test exporter (`app/src/test/.../backup`), not a real
   one.
3. `map-legacy.ts`: scratch DB → facts, as pure functions with fixture tests like `mapping.test.ts`. Covers the
   edit chain, quote → replyTo, group id hex → base64, keepmsg policy, SMS/MMS chats, and skipping stories/view-once.
4. Hub: `Store.importMessage()` (fill-only) and `/api/import/signal`, with a test that a live-deleted message
   stays deleted after an import that contains its content.
5. v2: decrypt `main` with libsignal (or a small HKDF + AES-CBC port, cross-checked against libsignal's test
   vectors) and derive group ids with zkgroup. Map it with the same fact builders.
6. Optional: a Signal Desktop source, through the same mapper. Desktop's `messages` table has `sent_at` and
   `sourceServiceId`, which give the same native ids.

## Open questions for the user

1. **Which backups exist, and where?** None are on this machine. Is legacy (`.backup`) backup still on in the
   keepmsg build, and where does it write? Or do you have a `SignalBackups` folder (v2)?
2. **Kept content:** should disappeared messages and deleted-message content from the fork come into the hub at
   all? If yes, hidden behind a reveal, or shown normally?
3. **Media:** import all attachments, a size cap, or text only?
4. **Signal Desktop:** `~/.config/Signal` holds a separate, older linked-device history. Import it too? That
   needs unlocking its key from the desktop keyring once.
5. **Which hub account** do imported messages belong to, if a second Signal account is ever added? The plan
   assumes the one linked account, whose self ACI must match `account.aci` in the backup. The importer refuses
   on a mismatch.
