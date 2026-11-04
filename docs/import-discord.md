# Importing old Discord history

Status: research and design, nothing implemented. A sibling note covers Signal (`docs/import-signal.md`). The hub
side of both should be one shared path (see "Hub side").

All numbers below come from `scripts/import/discord-export-census.py`. It reads structure only: it counts markup and
snowflakes and never prints message text, names or ids.

## What exists

**The tool: DiscordChatExporter CLI** (Tyrrrz/DiscordChatExporter, nixpkgs `discordchatexporter-cli`). The nix store
holds a 2.43.3 build and a 2.48 derivation, and 2.48 is the latest upstream release. It was run through nix rather than
installed, so shell history has no record of it. None of the user's GitHub repos or stars is a Discord export tool.

**Exports, one per Discord account, taken 2026-05-02/03:**

| | account A (main) | account B (alt) |
|---|---|---|
| HTML, `~/Documents/Discord-<account>/` | 127 files, 282 MB | 135 files, 40 MB |
| what | 121 DM/group-DM channels + 6 channels of one server | DM/group-DM channels only |
| message elements | 360,447 (185k DM, 176k server) | 40,324, of which 30,897 are unique |
| span | 2016-12 → 2026-05-03 (busiest: 2021 100k, 2022 95k) | 2023-06 → 2026-05-02 |
| distinct authors | 287 | 114 |
| attachments / replies / reactions / edited | 11,048 / 10,254 / 5,977 / 18,656 | 3,454 / 2,769 / 2,782 / 1,222 |
| embeds / stickers / system / threads | 11,697 / 147 / 1,003 / 0 | 1,370 / 79 / 250 / 0 |
| media, `~/Pictures/Discord-<account>-images/` | 6.0 GB, 9,308 files | 2.1 GB, 3,015 files |
| local `file://` links | 8,032, all but 14 present | 2,644, all present |
| CDN attachment links not downloaded | 5,743, nearly all signed (`ex=`), so expired | 1,204, same |

- Format: DCE HTML (dark theme), exported with `--media --media-dir <abs dir>`. Links are absolute `file:///home/...`
  paths, and files use DCE's legacy name scheme `<stem≤42>-<5 hex>.<ext>`. The media folders also hold avatars, custom
  emoji (`<emojiId>-<hash>.<ext>`) and embed images, not only attachments. 942 files have no extension.
- Account B exported 4 channels twice under two file names (a renamed DM), so 9,427 message ids appear twice. The two
  accounts' exports share no message or channel ids.
- The largest file is one server channel: 170,719 messages, 134 MB. A reader must stream it.
- `~/Sessions/discord-image-export/restamp.py` (the user's own) writes snowflake timestamps into the downloaded
  images' EXIF data. It shows the HTML is parseable by `data-message-id`.
- This machine has no Discord data package (`package.zip`, `messages/c<id>/`) and no JSON or CSV exports.

### What the HTML keeps and what it loses

Kept exactly: message id (`data-message-id`), and the timestamp derived from it. Author id (`data-user-id`) and name
(`title`). The id of the replied-to message (`scrollToMessage(event,'<id>')`). Channel id (`[<id>]` in the file name).
Server id (in the server icon URL in the preamble). Attachment file and name. Custom emoji id (from the image file
name). Reaction emoji and count. System-message text.

Lost or approximate:
- The body is rendered HTML, not Markdown. It has to be converted back.
- Mentions are `<span title="<name>">@display</span>` with no id. Names of people who wrote in the same export can
  be resolved to ids; the rest stay plain `@name`. The same goes for channel mentions and roles.
- The edit time is a localized string, accurate to the minute.
- Reactions record who reacted only as a count.
- Downloaded attachments have no attachment id, size or MIME type. The file on disk gives size, and the extension
  gives MIME.
- Direct and group DMs share the `Direct Messages - …` file name.
- Categories are names without ids.
- Embeds keep only the rendered markup.

## Sources, ranked by fidelity

1. **Live adapter `history`** (already built: `packages/adapter-discord/src/main.ts`, paced 1.5–3 s per page). It
   produces exactly what live sync produces, but only for channels the account can still open, and it runs through the
   real account. Fetching 390k messages at 100 per page is about 4k requests, roughly 2–3 h.
2. **DCE JSON with `--markdown false`.** `content` is raw Discord Markdown with `<@id>` mentions, which is already the
   hub's canonical body. JSON also gives attachment `id/fileName/fileSizeBytes`, `reactions[].users` (one API call per
   reaction), `reference.messageId`, `timestampEdited`, `channel.type`, `guild.id`, `categoryId`, stickers, embeds and
   `forwardedMessage`. It needs the token and a fresh run, and only reaches channels that still exist.
   `--reuse-media --media-dir` skips files already downloaded. DCE 2.48 renames legacy 5-hex names in place, so point
   it at a copy.
3. **Discord data package** (Settings → Privacy → Request data). It holds only your own messages, but in every channel
   ever, including deleted DMs and servers you left. Layout: `messages/index.json` (channel id → name), and
   `messages/c<id>/channel.json` (`id`, `type`, `recipients`, `guild`) plus `messages.json` (`ID`, `Timestamp`,
   `Contents`, `Attachments`; older packages use `messages.csv`). Bodies are raw Markdown. It is useful for filling gaps.
4. **DCE HTML** (what exists now). Lossy as described above, but it is a snapshot of channels that may no longer be
   reachable, and its media is already on disk.

## Mapping onto the schema

Hub ids are `hubId(prefix, 'discord', nativeId)` (`protocol/src/ids.ts`), the same function the live adapter uses.
So an imported message with snowflake S **is** the live message S: one row, keyed `UNIQUE(network, native_id)`.

| export | fact / table | notes |
|---|---|---|
| file `[channelId]`, JSON `channel` | `ConversationFact` → `conversation` | shape: JSON `channel.type`, data package `type`, else what the hub already has for that id, else a heuristic (more than 2 authors means `group`). Guild channel: `shape:'channel'`, `spaces:[guildId]` |
| server (preamble icon URL / JSON `guild`) | `SpaceFact kind:'community'` → `space` | HTML: no category id, so no `section`. JSON: `categoryId` becomes a section |
| author `data-user-id` + `title`, avatar file | `IdentityFact` → `identity` | fill empty fields only, because live names are newer. Never create `person` rows. `seen_via` = the importing account |
| `data-message-id` / `id` | `MessageFact.nativeId`, `ts = snowflakeToMs(id)` | reuse `snowflakeToMs` from `adapter-discord/src/map.ts` |
| body | `message.body` | JSON: `content` + `normalizeMentions()`. HTML: converted back to Markdown (below) |
| reply link / `reference.messageId` | `replyTo` → `reply_to_id` | may point at a message never imported; the schema allows that |
| edited title / `timestampEdited` | `editedTs` | HTML: parsed in the exporting machine's time zone, accurate to the minute |
| system notification / JSON `type` ≠ Default, Reply | `kind:'system'` | body = the rendered text, like `systemMessageText` |
| stickers | `kind:'sticker'`, body `[sticker: name]` | the same fallback as `bodyFallback` |
| attachment | `AttachmentFact` → `attachment` | `nativeId` = attachment id when known (JSON, or the CDN URL `/attachments/<chan>/<att>/`). `kind` from `attachmentKind` rules / extension. `url` = `file://` under the hub data dir (see Media) |
| reactions | `ReactionFact{key, count, authors}` | key: the unicode emoji, or `name:id` for custom ones (`reactionKey`). HTML: `authors: []` plus `count`. JSON: the full `users` list |
| custom emoji in body | `<:name:id>` / `<a:name:id>` in body, `custom_emoji` row | the id and animation (`.gif`) come from the image file name |
| embeds | `extra.embeds` (the `embedExtra` subset) | JSON only. HTML embeds are skipped in v1 |
| every imported message | `extra.import = {src, at}` | `src` ∈ `dce-json`, `package`, `dce-html`. Marks the row as not live |

Converting the HTML back to Markdown: `strong`→`**`, `em`→`*`, `u`→`__`, `s`→`~~`, inline `pre`→`` ` ``,
multiline `pre`→```` ```lang ````, `chatlog__markdown-spoiler`→`||`, `chatlog__markdown-quote`→`> `. A mention span
becomes `<@id>` when its `title` matches an author's `title` in the same export, else `@display`. `img.chatlog__emoji`
becomes its alt text (unicode) or `<:name:id>`. `a[href]` becomes the bare URL, or `[text](url)` when the text differs.
Bun's built-in `HTMLRewriter` streams this, which matters for the 134 MB file.

## Dedupe and the hub side

Live ingest (`Store.message`) **overwrites** `body` and `kind`, and replaces attachments and reactions on conflict. That
is right for the network, but wrong for an import that may be older than what live sync holds. So imports do not go
through `ingest()`. They use a new path, shared with the Signal import:

`Store.importFacts(acc, batch, src)`, one transaction per ~2k messages:
- **Message exists and is live** (no `extra.import`): leave it alone. Only add `message_seen(acc)`. Live always wins.
- **Message exists from a lower-ranked import** (`dce-html` < `package` < `dce-json`): replace it, so a later JSON
  re-export upgrades rows that came from the HTML.
- **Message is new**: insert it with its attachments and reactions, plus `message_seen`.
- Never touch `vantage.unread` or `mentions`, never write `triage` or `notification`, and never push. For a
  conversation that exists only through the import, create the vantage with `last_read_ts` = its newest imported `ts`.
- Update `conversation.last_message_*` only when the new message is later, as now. Old imports almost never move it.
- Journal: mark only the touched conversations dirty, not 390k messages. Clients load timelines on demand. FTS stays
  current through the existing triggers, and `conv_feature` refolds through `ingested`/`stale_at` as it does for
  backfill.
- Duplicates inside one run (account B's renamed DMs): first wins, since the snowflake is the key.
- A later live ingest of an imported id overwrites it as usual. That is fine, because live is authoritative. It drops
  `extra.import`; keep `extra.import.media` (below) when replacing attachments with expiring CDN URLs.

**Which account:** the import is attached to one hub account (`--account acc_…`). Sanity check before writing: that
account's `self_identity` native id must be among the export's authors. Otherwise refuse, since it was probably
exported from the other account.

**Gaps:** the exports end 2026-05-03, and live sync starts whenever each account was added. For each conversation,
if the newest imported snowflake is older than the oldest live one, queue the adapter's existing `history` command with
`beforeTs` = the oldest live `ts`, until the two ranges meet. That uses the existing paced backfill, with no new
network code.

## Media

The hub serves `file://` only under its data dir (`server.ts` `fetchMedia`). So the importer copies the referenced
files to `<DITHER_DATA>/import/discord/<accountId>/<name>`, using a hardlink when on the same filesystem, and writes
those paths as attachment URLs. Only referenced attachments, avatars and emoji are copied, not whole folders. The 14
missing files and the expired CDN links (about 7k) become attachments with their original URL. A later pass could
refresh them through the logged-in client (Discord's `attachments/refresh-urls`), but that is optional.

The real hub runs on another machine. The exports are about 8.4 GB with media and must be copied to it over an
encrypted channel, the same way `docs/deploy.md` moves `.data`.

## Plan

1. `packages/adapter-discord/src/import/`, network-specific readers that yield fact batches:
   `dce-json.ts` (easy, nearly 1:1), `dce-html.ts` (HTMLRewriter, as above), `package.ts`. They reuse `map.ts`
   helpers. Tests use small synthetic fixtures with fake ids, never real exports.
2. Hub: `Store.importFacts` with the rules above, and `POST /api/import/:accountId` taking NDJSON batches and returning
   counts (`inserted`, `already live`, `upgraded`, `skipped`). Add a `--dry-run` that counts without writing.
3. CLI: `bun packages/adapter-discord/src/import/cli.ts <export-dir> --account acc_… [--media DIR] [--data DIR]
   [--dry-run]`. It runs on the hub's machine against the running hub, so no restart is needed.
4. Gap fill through `history`, as above.
5. UI: imported-only conversations are probably best `archived` or held out of the inbox's "owed" ranking.
   Attention decays over 30 days, but 100+ old DMs whose last message is someone else's should not compete with live
   chats. Test on a copy first.

Recommended order: **import the existing HTML now** (no Discord API calls, and it covers 2016–2026-05). Then run the
gap fill. Then optionally re-export as JSON (`--markdown false`) for the channels that still exist. The ranking rule
upgrades those rows in place, which recovers mention ids, reactors and attachment ids. Request the data package if old
DMs or servers are missing from the HTML.

## Open questions for the user

- Re-export as DCE JSON, which is better data but means another token run against the live account? Or is the HTML
  enough?
- Request a Discord data package for your own messages in DMs and servers that are gone?
- Should imported-only conversations (old DMs not in the current list) show in the sidebar, be archived, or be
  search-only?
- Account B's duplicated channels are renamed DMs. Should the import take the name from the newer file?
- Copy media into the hub's data dir (about 8 GB, hardlinks where possible), or attachments only (smaller)? Avatars
  and emoji are a few hundred MB.
- Which hub accounts map to A and B? The importer checks the self id, but the CLI needs the account id.
