# Importing history

The hub only holds what its adapters have seen since each account was linked. Older history lives in backups and
exports: a Signal/Molly `.backup`, DiscordChatExporter output, Discord's data package. This is the shared design for
bringing those in. The network specifics are in `docs/import-signal.md` and `docs/import-discord.md`.

Goals:

- **Reproducible.** The same sources, reader versions, policy and decisions always give the same hub state. Nothing
  is a one-off script run by hand. Everything can be redone after a reader bug is fixed, and undone.
- **Merges with live data.** An imported message and its live copy are one row, because both derive the hub id from
  the network's own message identity. Live data is authoritative.
- **Conflicts are kept, not guessed.** Where a source disagrees with the hub, the hub keeps its version, records the
  disagreement, and lets you review and decide it. A decision is remembered and replayed on every rerun.
- **Raw sources are kept.** The bytes you gave the hub are never modified, so a better reader can come back to them.

Status: built for Discord. Sources (upload of files or folders, rsync, hash, census), the DiscordChatExporter HTML
reader, the fill-only apply with provenance, conflicts and undo, the review UI, the gap fill through the account and
the media archive are in. Signal has upload and census only: no reader yet. Where the code differs from the design
below, the code section at the end says so.

## Stages

```
source  ──read──▶  facts  ──plan (+ hub state, + decisions)──▶  plan  ──apply──▶  hub
 raw bytes          normalized,        new / same / upgrade /        fill-only writes,
 never changed      cached by          conflict / skip, per          provenance rows,
                    (source hash,      object                        open conflicts
                     reader@version)
```

### 1. Sources (built)

A source is a directory, `<data>/imports/sources/<id>/`:

| file | written by | meaning |
|---|---|---|
| `source.json` | whoever added it | network, kind, label, account, `addedAt`, `addedBy`, notes. The hub edits only the label and account |
| `raw/` | the upload, or rsync | the bytes as they came; never modified |
| `state.json` | the hub | sha256 identity, size, file count, census, status, errors. Derived: delete it and the hub recomputes it |
| `passphrase` | the hub, from the UI | a Signal backup's passphrase, 0600 |

A source has no database row, so one copied in by hand or by rsync shows up on the next listing. Its identity is
its sha256: of the file for a single-file upload, or of the sorted `path\tsize\tsha256` lines for a folder. Two
copies of the same export are the same source.

Ways in:
- **Upload**, from the account pane's History section. The file goes up in 8 MB pieces, each a `PUT` at its byte
  offset, so a dropped phone connection resumes where it stopped. The hub then hashes the file, recognizes a Signal
  backup by its plaintext header, and asks for the passphrase. With the passphrase, a worker reads the backup
  through, checking every frame's MAC, and reports counts only (messages, date range, attachments, rows hidden by
  keepmsg, deletes, edits). A wrong passphrase is detected on the first frame and forgotten.
- **Copy in** a folder: `raw/` plus a `source.json`. This is how the DiscordChatExporter exports arrived.

API (tailnet-only, like the rest of `/api`): `GET /api/imports`, `POST /api/imports` `{accountId, name, size}`,
`PUT /api/imports/:id/data?offset=N`, `POST /api/imports/:id/passphrase`, `POST /api/imports/:id/check`,
`PATCH /api/imports/:id` `{label, accountId}`, `DELETE /api/imports/:id`.

### 2. Readers: source → facts

A reader is a pure, versioned function from a source's raw bytes to the protocol's own facts (`IdentityFact`,
`ConversationFact`, `SpaceFact`, `MessageFact` with attachments and reactions). It reuses the live adapter's
mapping code, so ids, Markdown and kinds can't drift from what live sync writes:

| kind | reader | reuses |
|---|---|---|
| `signal-backup` | decrypt, replay statements into an in-memory SQLite, map rows | `adapter-signal/src/mapping.ts` (`msgId`, `dmId`, `groupConvId`, `attachmentKind`), `markdown.ts` (`fromSignal`) |
| `signal-backup-v2` | decrypt `main` with the account entropy pool, walk the frames | the same |
| `dce-html` | stream the HTML through `HTMLRewriter` and convert bodies back to Markdown | `adapter-discord/src/map.ts` (`snowflakeToMs`, `reactionKey`, `normalizeMentions`) |
| `dce-json`, `discord-package` | JSON, nearly 1:1 | the same |

Output is cached at `<data>/imports/work/<sourceId>/<reader>@<version>/`:
- `facts.ndjson.gz`, in a stable order (conversation, then ts, then native id);
- `manifest.json`: `{sourceSha256, reader, version, options, counts, factsSha256}`;
- `media/`: files the reader extracted, e.g. attachments decrypted from a backup. They are named by sha256 and
  hardlinked into the shared `<data>/imports/media/` on apply.

A cache is valid when its manifest matches the source hash, reader version and options. Bumping a reader's
version invalidates its caches, which is how a fixed reader re-reads everything. Facts are the review boundary:
they are the whole of what an import can do to the hub, and they can be counted and diffed without touching the
database.

Reader options are part of the cache key. They are explicit, never ambient: `keepDisappeared`, `keepDeleted`
(Signal keepmsg content), `skipConversations`, `media: all | attachments | none`.

### 3. Plan: facts × hub state × decisions → plan

The planner reads facts and the current hub database, and writes nothing to the hub's message tables. For every
message fact it decides one outcome:

| outcome | when | apply does |
|---|---|---|
| `new` | no row with this id | insert it, with origin |
| `same` | the row exists and matches (body, kind, attachments by name and size, edit) | add origin only |
| `upgrade` | the row came only from imports, all ranked below this source | replace it, with origin |
| `fill` | the row exists and the fact only adds something: a reply target, more reactors, an attachment size | fill the empty fields; reactions add only |
| `conflict` | the row exists and the fact contradicts it | nothing, until decided; a conflict row records both sides |
| `skip` | policy: a story, an SMS, view-once media, a keepmsg row not opted in, an unknown conversation | nothing; counted by reason |

Rank, highest first: **live** > `dce-json` > `signal-backup` / `signal-backup-v2` > `discord-package` > `dce-html`.
Ties go to the newer source (`addedAt`), then the lower sha256, so the order is always defined.

Conflict kinds:
- `body`: both have text and it differs, with no edit time that orders them. If the hub's edit is later, it's
  `same`; if the source's is later and the hub row came from an import, it's `upgrade`.
- `deleted`: the hub row is deleted (a live remote delete) but the source has its content, as keepmsg backups do.
  The default decision is `keep-hub`, and these are grouped separately in review.
- `attachments`: different files on the same message.
- `identity`: the same message id with a different author or conversation. This should never happen; it marks a
  reader bug (e.g. a wrong DM id), so the run stops before applying.

Identity, conversation and space facts never conflict. They fill only the fields the hub doesn't have, because
live names and avatars are newer.

### 4. Decisions

A decision is keyed by `(message_id, kind, sha256 of the source's side)`. It applies to that exact disagreement
from any source that brings the same value, and a source with a different value raises a new conflict. Values:
`keep-hub` (the default if you never decide), `take-source`, and `ignore` (stop showing it). Decisions are stored in
the hub database (`import_decision`) and exported with `GET /api/imports/decisions`, so they survive rebuilding the
hub from sources.

Bulk decisions are rules (`kind = deleted ⇒ keep-hub`). They are stored the same way, with a `rule` key instead of a
message id, and the most specific one wins.

### 5. Apply

Apply runs a plan inside the hub process, through `Store`, in one transaction per conversation batch:
- writes go through a fill-only `Store.importFacts`, never `Store.message`, which overwrites;
- `live = false` throughout: no triage, no notifications, no unread or mention counts. A conversation that exists
  only through the import gets a vantage read up to its newest imported message;
- `conversation.last_message_at` only ever moves forward, so old history never reorders the inbox;
- touched conversations are marked dirty for the journal (`docs/sync.md`) and `conv_feature.stale_at` is set
  (`docs/inbox.md`). Messages aren't journalled one by one, since clients load timelines on demand;
- FTS stays current through the existing triggers.

New tables:

```sql
-- Which sources a message came from. A message with origins and no live sighting is import-only.
CREATE TABLE import_origin (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  source_sha TEXT NOT NULL,        -- the source's identity, not its directory name
  run_id     TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  fact_sha   TEXT NOT NULL,        -- sha256 of the fact as applied
  PRIMARY KEY (message_id, source_sha)
);
-- message.live INTEGER NOT NULL DEFAULT 1: Store.message sets 1; importFacts inserts 0.

CREATE TABLE import_run (
  id TEXT PRIMARY KEY, source_sha TEXT NOT NULL, source_id TEXT NOT NULL, account_id TEXT,
  reader TEXT NOT NULL, options TEXT NOT NULL, facts_sha TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
  counts TEXT                     -- JSON {new, same, upgrade, fill, conflict, skip: {reason: n}}
);

CREATE TABLE import_conflict (
  message_id TEXT NOT NULL, kind TEXT NOT NULL, value_sha TEXT NOT NULL,
  source_sha TEXT NOT NULL, run_id TEXT NOT NULL,
  hub_value TEXT NOT NULL, source_value TEXT NOT NULL,   -- JSON, shown side by side in review
  detected_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind, value_sha)
);

CREATE TABLE import_decision (
  key TEXT PRIMARY KEY,           -- "msg:<id>:<kind>:<value_sha>" or "rule:<kind>[:<conversation>]"
  decision TEXT NOT NULL CHECK (decision IN ('keep-hub', 'take-source', 'ignore')),
  decided_at INTEGER NOT NULL
);
```

Conflict rows are derived. A rerun of the plan rewrites them, and decided ones drop out once applied. Only
`import_decision` holds anything you can't recompute.

**Undo** a source: delete messages whose only origin is that source and that were never seen live
(`live = 0`), then the source's origin rows. Rows it upgraded fall back to the next-ranked origin's fact on the
next apply of that source.

**Rerun**: re-plan everything from the cached facts. New rows and fills from sources applied before come out
`same`, so a rerun converges and is cheap. After a hub rebuild from scratch (e.g. a new database), applying every
source in rank order with the stored decisions reproduces the imported history exactly.

### 6. Review UI

The account pane's History section lists sources. Each source gets:
- **Plan**: a dry run that shows counts per outcome and skip reason, per conversation;
- **Apply**: enabled when there are no `identity` conflicts. Open conflicts are left as they are and don't block
  the rest;
- **Review conflicts** (n): grouped by kind, then by conversation. Each entry shows both sides as messages, with
  *Keep hub*, *Take source*, *Ignore*, and *same for all of this kind here*;
- **Undo import**.

Imported messages are marked in the timeline (a small "imported" note in message info, not on the bubble).
Conversations that exist only through imports are archived by default, so a hundred old DMs don't crowd the inbox.

### 7. Automatic pipeline

Once a reader and the planner are trusted for a kind, a completed upload runs everything in the background, one
job at a time in a worker: census → read → plan → apply when the plan has no `identity` conflicts and the account
matches the backup's self id. Other conflicts wait in review. The source's row shows each stage. A failure leaves
the source and everything before the failed stage intact.

## Order of work

1. ✅ Sources: upload (one file, or a folder picked whole), copy-in, hashing, Signal census, History section.
2. ✅ DCE HTML reader (`imports/discord-html.ts`) and the import itself (`imports/engine.ts`, `Store.importBatch`):
   dry run, import, review of differences, undo. Tested on a copy of the live database with both real exports:
   390k messages in about 3½ minutes, unread counts untouched, a second run changing nothing.
3. ✅ Gap fill through the Discord account (`imports/gapfill.ts`) and the media archive (`mediaarchive.ts`).
4. Signal: a reader for the new Molly folder (`SignalBackups/` plus the "Include kept messages" `.backup`), then the
   same import path. Kept content goes in through the hub's own kept-message mechanism (docs/history.md).
5. Automatic pipeline on upload; decisions as rules; DCE JSON and the Discord data package.

## What the code does (and where it is simpler than the design)

- **One pass, not plan-then-apply.** `Store.importBatch` classifies and applies in the same transaction; a dry run
  is the same pass with every write skipped. Outcomes: new, same, filled (a reply link or attachments the hub
  lacked), conflict. There is no rank or upgrade yet: an existing row is never replaced by an import.
- **Provenance.** `message.imported = 1` on rows an import inserted, cleared when the network sends the message;
  `import_origin (message_id, source_sha)` for every message a source carried; `import_run` per run.
  Undo deletes rows with `imported = 1` that no other source brought.
- **Conflicts** are kept in `import_conflict` with the source's side; the hub's side is the row itself. A decision is
  per conflict: *Use the export's* replaces the body and keeps the hub's words as an earlier version (an `edit`
  message_event), *Keep the hub's* hides it. System lines ("… started a call") never conflict: each renderer words
  them its own way.
- **Unread counts** are put back after each slice, so an import never makes anything unread; a conversation only the
  import knows is created archived and read.
- **Facts** are cached per source and reader at `<data>/imports/work/<source>/<reader>/facts.ndjson`, keyed by the
  source's sha256 and the account's own id; the files they point at are hardlinked (copied across filesystems) into
  `<data>/imports/media/<sha256[0:2]>/<sha256><ext>`.
- **Slices** of 150 messages, each its own transaction, with the event loop let go between them.
- **Gap fill** (`/api/history-gaps/:account`): per conversation of the account, from the oldest message above the
  newest imported one, `history` pages of 100 going back until a page brings nothing above the import (or the chat's
  start when nothing was imported). Direct and group chats, and the channels an import reached; every server channel
  only when asked. Progress in `gap_fill`; a restart carries on.
- **Media archive**: every attachment with a remote URL is fetched into `media-cache/` soon after it arrives (a
  rowid cursor in `meta`), one at a time; failures are tried three times, six hours apart (`media_archive_fail`).
  The cache is no longer trimmed unless `DITHER_MEDIA_CACHE_MB` is set. Discord links that expired before the
  archive saw them can't be fetched: the extractor has no `attachments/refresh-urls` yet.
