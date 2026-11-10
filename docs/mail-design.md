# Email in dither-chat: design

Status: design, 2026-11-07, with the owner's answers to §14. Slice 1 (read-only mail, end to end) is built: docs/mail.md
says what works and how to run it. The rest is built slice by slice (§12). Paths are relative to the repo root unless
they start with `dither-accounts/`.

**As built in slice 1**, where it differs from or adds to the text below:

- §13's fields landed on dither-accounts master (515f26d). Message-IDs keep their angle brackets everywhere
  (`messageId`, `inReplyTo`, `references`), and the hub compares them as they stand, in its message key and in
  threading alike. Plain-IMAP threads therefore follow references from the summaries, not only after bodies arrive.
- Tables gain a few columns: `mail_account.addresses` (status.self.addresses) and `synced_at` (the first sync
  finished); `mail_thread.mailboxes` (the ids beside `roles`) and `preview`, `last_from_me`; `mail_message.thread_by`
  (native, ref, subject or new: a provisional thread is fixed when references come) and `bulk` (§13's headers, kept
  for slice 8). A later slice adds its own tables as `hub/src/mail/schema-<name>.sql`.
- Read here is `POST /api/mail/threads/:id/read`, sent after a second in view. `MailMessageView.seenHere` and
  `MailAccountView.deleteAt` are new. Inbox, Sent and All (else Archive) are followed from the start; listing goes only
  to the newest 500 of Inbox and Sent (backfill is slice 2).
- The numbers in §2.5 and §3.3 are `MAIL_LIMITS` in `hub/src/mail/limits.ts`.

**As built in slice 4** (`hub/src/mail/ops.ts`, `schema-ops.sql`):

- `mail_op` gains `sent_at` (a call is out with it; cleared on restart, so it goes again). `mail_unsupported` keeps
  the ops an account answered 501 to, and `mail_setting` the read setting (`GET/PUT /api/mail/settings`).
- A move waiting for the server leaves `mail_location` alone: `pending.move = { to, hide }`, and threads and mailbox
  lists show the message moved. The answer's ids replace the location it left; with a null id the next changes pass
  finds it. A message whose move is on its way is not deleted as an orphan meanwhile.
- Trash is a move into the Trash mailbox, never `mail.trash` (which deletes outright what is in the trash already).
  Nothing is deleted from here. Back to Inbox never moves out of an IMAP server's All mail; on Gmail it copies from
  there (as built for Gmail, below).
- MailHub gains the `filed` event; `MailThreadView.pending` and `MailAccountView.ops` are new.

**As built for Gmail** (docs/mail.md "Gmail", `hub/test/mail-gmail.test.ts`, fake.ts `ids: 'gmail'`):

- An account is Gmail by its status's `details.provider` ('Gmail'), its address or its `[Gmail]`/`[Google Mail]`
  mailboxes (`MailStore.gmail`); over IMAP its kind stays `imap`. One message is in several mailboxes with an id in each; the (account, Message-ID) key keeps it one message,
  and without a Message-ID the summary's `emailId` (X-GM-MSGID) does (store.ts `identify`, below).
- §2.4: labels are stored as the summary gives them with the listing mailbox's own label put back (Gmail leaves it
  out), and views leave out those starting with `\` (`shownLabels`). Rule 8's `CATEGORY_*` never comes from the imap
  extractor: Gmail's IMAP has no categories (only a Gmail API extractor could give them).
- §3.7: into Trash or Junk, the move's answer drops the message's other locations (Gmail shows it there alone), and a
  message in Sent or Drafts is not moved there (its All Mail copy is the same message). An archive over IMAP waits
  `gmailArchiveHoldMs` (7.5 s), so the page's Undo calls it off before it goes.
- §3.7, copies: dither-accounts (5e8079a) makes `mail.move` out of Gmail's All Mail into anything but Trash or Spam a
  COPY, answering the copy's id. `copyFrom` plans one: into Inbox whenever the message is in All Mail (so its labels
  stay, and an archive that went is undone as it was), into a label when it is in no folder; never for what you sent.
  `pending.move` gets `copy` (All Mail's id) and an empty `hide`, so the lists show it in both; the answer adds the
  destination's location and leaves All Mail's. The web's `archivedInAll` offers the reader's Move to Inbox for such a
  thread, `movedView` keeps its labels, and `undoTarget` archives it again.
- `[Gmail]/Important` has the role `important` (the extractor's roleOf reads \Important, RFC 8457): a view, as Starred
  is (`NOT_FOLDER` in ops.ts and web filing.ts), and the label the store puts back when it lists a message
  (`ownLabel`).
- Identity (store.ts `identify`): a Message-ID gives `m:<Message-ID>`, as before. Without one, `emailId` finds the
  message that has it (`mail_message.email_id`, a nullable column added in place, indexed where set); else the row at
  that very place from before emailIds came, which takes it and keeps its id; else a new `e:<emailId>`. With neither,
  `x:<mailbox>/<id>` as before. No existing row is rewritten: Proton's summaries carry no `emailId`.
- A mailbox the server cannot list (IMAP \Noselect: Gmail's `[Gmail]`, 404) stops being followed when a page opens it;
  the page's mailbox menu and Ctrl+K leave out mailboxes with no counts that hold others (web `holdsOnlyMailboxes`).
- §11: `in:archive` is Archive, else All mail without Inbox, Sent or Drafts; Gmail's server query says
  `-in:inbox -in:sent -in:drafts`.

**What the status says, not the kind** (docs/mail.md "What the hub reads of an account's server"): the hub keeps the
status's `details.idPerMessage`, `sendCap`, `maxRecipients` and `provider` in `mail_account` (nullable columns added in
place) and reads them where it once asked whether the kind was `proton`: `MailStore.idPerMessage` (a move out of All mail
by the message's id, ops.ts `leaves`), `sendCapOf` and `maxRecipientsOf` (the outbox's checks, `MailAccountView.sendCap`
and `maxRecipients` for the composer), and `gmail()` by its provider. Until a status says, each is what the kind gave
before: Proton one id a message, 25 MB, 100; elsewhere an id per mailbox, 35 MB, 500. Proton's server search stays by
its kind. Gmail splits in two: what is the server's (search syntax, Important, All Mail left by a move only into Trash
or Spam, a sent message staying out of the trash, Trash and Spam holding a message alone) holds for both ways in;
`gmailPerMailbox` (Gmail and not `idPerMessage`) keeps the X-GM-LABELS put-back and the archive hold to Gmail over IMAP.
Gmail on the web (dither-accounts' google kind, fake.ts `ids: 'gmail-web'`, `hub/test/mail-gmail-web.test.ts`) files
by label: a move into Inbox, or into a label from All Mail alone, keeps every place it had (`copyFrom`, nothing copied),
and into a label it leaves Inbox only, as its `mail.move` names no source.

**As built in slice 8** (`hub/src/mail/classify.ts`, `attention.ts`, `schema-inbox.sql`):

- Overrides are `mail_override (scope 'sender'|'thread', key, class)`, not `mail_sender.override`: slices built side
  by side each keep a table of their own (slice 3's images are `mail_sender_images`). Routes: `PUT
  /api/mail/senders/:address` and `PUT /api/mail/threads/:id/person`. "Not a person" moves nothing on the server.
- Rule 4 also counts a sender who wrote in a thread you took part in, and rule 5 a person you know by another address
  (`mailPeople(hub).sender()`'s `tookPart` and `known`). Rule 6 counts a move to Junk still waiting for the server.
- §10's listing window is bounded: unread with its last message within 30 days, owed to a message within 14 days
  (`MAIL_INBOX`), so a year of synced mail is not a year of inbox. `mail_feature` holds the fold and `owed_since`,
  `unknown` and `sent_at` (a send from here, until Sent's copy comes); `mail_author_feature` is keyed by address and
  summed by person at scoring time, so a merge needs no new fold. Tallies are summed both ways (`Attention.otherTallies`).
- Mail rows reach the client through `Attention.sources`, so `server.ts` and `sync.ts` are unchanged.

**As built in slice 9** (`hub/src/mail/triage.ts`, `schema-triage.sql`; docs/mail.md "Triage and notifications"):

- `mail_triage` gains `thread_id`, `account_id`, `address` (whose person the author is, read again at training so a
  merge after a vote counts), `level` (the rating before quiet hours held it), `words` and `delivered`. No foreign key:
  a voted row outlives its message.
- A sender you know in Bcc or on a list starts at the digest, not Active; the spoofing warnings of slice 3 cap a
  message at Active. Late mail (over an hour), mail already read and mail outside Inbox are rated without notifying.
- A notification opens `#/inbox/c/<thread>` (slice 8's reader beside the inbox), not `#/mail/t/<thread>`: the push's
  conversation is the thread, so the browser and the Android app open it as they are; `mailThreadId` rides along.
  The Android app shows its own mark for mail until a build adds an envelope (`Looks.NETWORKS`).
- Votes share chat's route (`POST /api/messages/:id/feedback` takes a mail message id) besides
  `POST /api/mail/triage/:id/vote`; `TriageVotes.others` is where mail's examples join chat's.

## 0. In one page

| Decision | Where |
|---|---|
| Mail lives in new `mail_*` tables under a new `packages/hub/src/mail/` module, fed by the `mail` interface on the manager connection the hub already has | §2, §3 |
| A Mail section shows everything; threads from people also rank in the one-list inbox with the chat attention formula; bulk never alerts | §6, §10 |
| "From a person": local rules first, then the hub's triage model, whose votes are shared with chat | §4, §10 |
| An address is an `identity` with network `email`; it joins a person by your merge, never by name | §9 |
| HTML is sanitised on the hub, served under a `sandbox` CSP, shown in a script-free iframe; images only through a signed proxy | §7 |
| Sending goes through a hub outbox (10 s undo) to `mail.send` | §8 |

**Where I push back on the brief:**

1. **"Can't send" is not "read-only".** Proton's `mail.send` answers 501, but flagging, moving and trash work there. Only
   sending is turned off; only a `read` grant makes an account read-only.
2. **No From picker yet.** `OutgoingMail` has no `from`, and nothing lists an account's addresses (§13).
3. **Message-ID threading needs headers that summaries lack.** `inReplyTo`/`references` come only from `mail.get`, so
   plain-IMAP threads are provisional until bodies arrive, unless §13 lands (§2.3).
4. **The image proxy hides your IP, not the open.** A pixel fetched through the hub still reports the open, so allowing
   images still drops pixel-shaped ones (§7).
5. **Bodies "on demand" is not enough for triage.** Both kinds answer `preview: null`, so personal mail is prefetched on
   arrival, bounded (§3.5).

## 1. What the `mail` interface gives, and what it forces

| Fact (dither-accounts) | Consequence here |
|---|---|
| IMAP message ids are `<mailbox>.<UIDVALIDITY>.<UID>` and change on a move. Proton ids survive moves. | The hub keys a message by **(account, Message-ID)**, and keeps the extractor ids in a separate location table. A move keeps the hub message, its thread, its triage and its cached body. |
| Gmail (imap) and Proton fill `threadId`; other IMAP servers do not. Only `mail.get` gives `inReplyTo`/`references`. | Threading has three steps (§2.3). |
| `preview` is always null (imap and proton). | The hub writes previews from bodies, and the list shows sender and subject until a body exists. |
| `mail.changes` state is per mailbox (imap) or one event id for the whole account (proton). 410 means list again. Proton's `removed` may name ids that were never in that mailbox. | States are stored per mailbox. 410 starts a relist (§3.4). Unknown removed ids are ignored. |
| imap IDLE watches only the inbox. Other mailboxes report only this app's own changes. Proton polls its event loop every 30 s and covers every mailbox. | Mailboxes other than the inbox are polled on a timer, more slowly on servers that sync by "UID + flags diff" (the imap status reports it in `details`). |
| Manager rate limits per app and account: read 50/s (burst 1000), write 5/s (burst 100). `mail.flag` and `mail.move` take up to 1000 ids. | The hub's own budget stays well under this (§3.5), and writes are batched. |
| Proton `mail.search` matches only subject and addresses (bodies are encrypted on the server). | Local full-text search over cached bodies matters most for Proton (§11). |
| Proton `mail.flag {answered}` answers 501, and `mail.send` answers 501 on live Proton. Its "send path" layer is `failed`. | Send is turned off with the extractor's words (§8). `answered` is never sent to Proton. |
| `mail.attachment` gives at most 25 MB, as base64. `OutgoingFile` can name a local `path`. | Attachments are cached in the hub's media cache. Uploads go out as a `path`, since the hub and the manager share a machine. |
| No drafts op. | Drafts live on the hub (`mail_draft`), not on the server. |

The hub depends on the interface's types, not on dither-accounts' code. `packages/protocol/src/mail-iface.ts` is a copy
of `dither-accounts/packages/interfaces/src/mail.ts`'s types, and `scripts/accounts-sync.ts --check` reports when the
two differ.

## 2. Data model

### 2.1 Ids

`mailId(prefix, accountId, key)` in `protocol/src/ids.ts`: base64url of sha256(`accountId NUL key`), 12 bytes, like
`hubId`. Prefixes: `mbx_` (mailbox), `mml_` (message), `mth_` (thread), `mob_` (outbox). The manager's account id is
used as it is. Email identities use the existing `hubId('idn', 'email', lowercased address)`. That means adding
`'email'` to `Network` (not to `NETWORKS`, the chat list) and filling the `Record<Network,…>` tables: `NETWORK_META`
(name "Email"), `REACTION_RULES` and `ATTACHMENT_LIMITS` (25 MB), `ABOUT_RULES`, `READ_PACE`, `NET_HELP`,
`WHAT_NETWORKS_SHARE`.

### 2.2 Tables (`packages/hub/src/mail/schema.sql`, loaded by `MailStore`)

```sql
mail_account (id PK  -- the manager's account id
  , kind, label, address, display_name, color
  , level            -- grants.mail: 'read' | 'write' | NULL once access ends
  , dry_run, online, problem JSON   -- {layer, message}: attention, else the first layer not ok
  , send JSON        -- {ok: bool|null, why, at}
  , sync_mode        -- status.details.sync (imap) or 'events' (proton)
  , summary_headers, headers_seen   -- status.details.summaryHeaders, or a summary that carried them
  , id_per_message, send_cap, max_recipients, provider   -- status.details: NULL until it says (then by kind)
  , hidden, gone_at, created_at)

mailbox (id PK, account_id FK, native_id, name, path, parent_id, role, unread, total
  , follow           -- 'always' (inbox, sent, all|archive) | 'open' (kept up while recently opened)
  , state, state_at  -- the mail.changes state
  , list_next        -- mail.list cursor for paging further back
  , horizon          -- oldest receivedAt synced without gaps from the top
  , complete, relist_gen, opened_at, UNIQUE(account_id, native_id))

mail_message (id PK  -- mml_: key 'm:'+Message-ID, else 'e:'+emailId, else 'x:'+mailbox native id+'/'+native id
  , account_id, thread_id, message_id_hdr, native_thread, in_reply_to, refs JSON
  , from_addr, from_name, to_json, cc_json, subject, date, received_at, size, has_attachments
  , preview          -- made here from the body: 200 chars, quotes and signature cut
  , seen, flagged, answered, draft, labels JSON
  , pending JSON     -- local flag changes the server has not confirmed yet
  , seen_local       -- read here only (an account with a read grant)
  , addressed        -- 'to' | 'cc' | 'hidden' (Bcc, list) | 'self' (you sent it)
  , class, class_why -- 'personal' | 'bulk' | 'self', and the rule that decided (§4)
  , images_allowed)

mail_location (mailbox_id, native_id, message_id, seen_gen, PRIMARY KEY (mailbox_id, native_id))
mail_thread (id PK, account_id, native_thread, subject_key, subject, first_at, last_at, last_message_id
  , count, unread, flagged, attachments, participants JSON, roles JSON  -- mailbox roles holding any of it
  , class, person_ids JSON, muted, opened_at, opened_ms, listed)        -- listed: in the one-list inbox
mail_ref (account_id, ref, thread_id, PRIMARY KEY (account_id, ref))   -- Message-IDs seen, for threading
mail_body (message_id PK, text, html, parts JSON, reply_to JSON, bcc JSON, bytes, fetched_at, used_at, keep)
mail_fts  fts5(subject, people, body)                                  -- rowid = mail_message.rowid; body ≤ 16 KB
mail_sender (address PK, name, first_at, received, wrote_to, replied, opened
  , hints JSON, override  -- 'person' | 'bulk' | NULL, set by you
  , images)               -- 'allow' | NULL
mail_triage (message_id PK, decision, score, reasons, decided_by, feedback, feedback_at, facts, probs, created_at)
mail_feature (thread_id PK, cursor_ts, state)                          -- attention.ts ConvState
mail_author_feature (thread_id, author_key, tally, PRIMARY KEY (thread_id, author_key))
mail_op (id PK, account_id, op, args JSON, message_ids JSON, attempts, next_at, error, created_at)
mail_outbox (id PK, client_id UNIQUE, account_id, kind, reply_to, draft JSON, uploads JSON
  , state, hold_until, attempts, error, sent_message_id, created_at, updated_at)
mail_draft (key PK, account_id, data JSON, updated_at)
```

The tables are separate from `message` and `triage` because those carry chat foreign keys. The two places where mail
meets chat are `identity` rows and the shared triage model.

### 2.3 Threading (`mail/thread.ts`, pure, with a DB adapter)

Threads stay within one account, so a reply always goes out through the account that received the mail.

1. **The server's thread.** With `threadId` present (Gmail, Proton), the thread is `mailId('mth', account, 'n:'+threadId)`.
   An account that has given one keeps using them.
2. **References.** Otherwise the hub looks up `inReplyTo` and then `references` (newest first) in `mail_ref`, and joins
   the first thread it finds. A new message whose own Message-ID is already referenced by a thread joins that thread
   (the parent arrived late). A message that links two threads merges them into the older one, and both ids are
   journaled.
3. **Provisional, by subject.** Without references (summaries from plain IMAP), the hub matches the same normalised
   subject (`Re:`, `Fwd:`, `AW:` and list tags stripped), at least one shared participant, and a gap of 14 days or less.
   Subjects that are empty or generic ("hi", "hello", "question") never merge. When `mail.get` later brings references,
   the message moves to its real thread.

Every Message-ID and reference goes into `mail_ref`, pointing at its thread.

### 2.4 Folders, labels, flags, read state

- **Mailboxes come from `mail.mailboxes`.** Their role decides what is followed. Gmail labels and Proton labels (`labels`
  on a summary) are shown as chips and searchable as `label:`. They are not mailboxes.
- **The server's flags are the truth.** A local change is applied at once, and recorded in `pending` and `mail_op`
  (§3.7). While it is pending, a server change to that flag is ignored. Once acknowledged, the server's value wins.
- **Read state is shared.** With a `write` grant, opening a thread marks it seen on the server through `mail.flag`. With
  a `read` grant, it is marked here only (`seen_local`), and the reader says so.
- **Thread state.** A thread is unread if any of its messages is. It is in Inbox if any of its messages has an inbox
  location (`roles`). Archive moves only that thread's messages that are in the inbox.

### 2.5 Retention and cache limits

| What | Kept | Limit (setting) |
|---|---|---|
| Mailboxes, counts | always | – |
| Summaries | all of Inbox; Sent and All/Archive back to the horizon; other folders as far as opened | 365 days (`DITHER_MAIL_SYNC_DAYS`), 150k per account (`DITHER_MAIL_MAX`); past either, the oldest outside Inbox go first |
| Bodies (text and HTML) | when opened; prefetched for personal mail of the last 14 days and the first 20 rows of any list | 500 MB total, least recently used first (`DITHER_MAIL_CACHE_MB`). Starred mail and mail involved in an outbox item are kept. A body over 2 MB is never cached |
| Search text | first 16 KB of each fetched body | 300 MB, oldest first (`DITHER_MAIL_INDEX_MB`); it outlives the body cache |
| Attachments | on demand, in the media cache, with `media_info` sniffing | the media cache's existing cap (housekeeping.ts); never prefetched |
| Proxied images | in the media cache | 7 days, 10 MB each |
| Mail removed on the server | deleted from the hub at once (summary, body, index); triage rows with a vote are kept | – |
| Access withdrawn (left the manager's list, or grant revoked) | everything of that account deleted 24 h later; "Delete now" in Settings | Q6 |

## 3. Hub sync

### 3.1 Parts (all new, under `packages/hub/src/mail/`)

| File | Job |
|---|---|
| `backend.ts` | `MailBackend`: `accounts()`, `call(account, op, input, timeoutMs)`, `onEvents`, `onAccounts`, `onConnection`, `onGap`. `ManagerMailBackend` sits on `RoutedSupervisor`'s `AccountsClient` |
| `fake.ts` | `FakeMailBackend`: in-memory mailboxes, used by tests and by `--demo` (§12.2) |
| `store.ts` | `MailStore`: the schema, ingest, the views, dirty sets flushed with `Store.flush` |
| `thread.ts`, `classify.ts` | §2.3 and §4 |
| `sync.ts`, `queue.ts` | one `AccountSync` per account; one priority queue per account |
| `bodies.ts` | `mail.get`, the body cache and its eviction, previews, the search text |
| `ops.ts`, `outbox.ts`, `compose.ts` | writes, sending, building replies and forwards |
| `sanitize.ts`, `images.ts` | §7 |
| `people.ts`, `attention.ts`, `triage.ts`, `search.ts` | §9–§11 |
| `routes.ts` | `/api/mail/*`, a table of sub-routers so parallel slices add files rather than edit one |
| `index.ts` | `MailHub`: wires these together; emits `ingested`/`changed` for classify, people, attention and triage to subscribe to |

### 3.2 The grant

`remote.ts` changes in three places:

- **Asking.** A new registration also asks for `{ interface: 'mail', level: 'write', accounts: '*', reason: 'Show your
  email beside your chats; mark, file and send mail as you ask' }`. A hub that is already registered asks once through
  `requestAccess`, with `mailToAsk(info)` (a sibling of `kindsToAsk`): no grant and no open or denied request for
  `mail`.
- **Accounts.** `accountsChanged` passes accounts with `interfaces.includes('mail') && grants.mail` to `MailHub`.
  `grants.mail` (`read` or `write`) and `dryRun` set the account's `level` and `dry_run`.
- **Events.** `onEvents` routes a mail account's events (`hello`, `status`, `mail.arrived`, `mail.changed`) to `MailHub`.
  `onGap` makes a mail account catch up through `mail.changes`, without a restart.

`MailAccess.state` is `off` (no `DITHER_ACCOUNTS_URL`), `unreachable`, `pending`, `denied` or `granted`. While it is
`pending` or `denied`, the hub reads `self()` every 60 s and on each account list. The page shows what to do (§6.6):
pending gives a link to the manager's Apps page, denied gives "Ask again", which sends a new `requestAccess`. A grant
narrower than asked (read, some accounts, dry run) is respected and explained where it bites. The hub never asks for
`accounts` on `imap` or `proton`: mail accounts are added on the manager's page (Q5).

### 3.3 First sync and paging

When an account first appears:

1. `mail.mailboxes`. Followed mailboxes are Inbox, Sent, and All (Gmail, Proton) or else Archive.
2. For each followed mailbox, `mail.changes` without a state, stored **before** listing, so nothing that arrives during
   the list is missed.
3. **Inbox, newest 50**, broadcast right away, so the screen fills after one call. Then Sent's newest 50 (needed for
   §4's "you wrote to them").
4. Inbox and Sent up to 500 messages or 30 days.
5. **Backfill**: All/Archive (else Inbox and Sent further back), 200 a page, down to the horizon. Messages already held
   (same Message-ID) only gain a location.
6. **Body prefetch** for personal threads of the last 14 days, newest first, at most 300.

Other folders are listed when you open them: first page at once, more as you scroll. A page beyond what the hub holds
is fetched on demand at user priority. `GET /api/mail/threads` waits up to 8 s for it and otherwise answers with
`pending: true`, followed by a `mail.threads` event. Progress (`phase`, `synced`, `oldest`) goes out as `mail.progress`
(not journaled) and shows as one line under the list.

### 3.4 Keeping up

| Trigger | Action |
|---|---|
| `mail.arrived {message}` | Ingest the summary at once (fast path for notifications), classify it, prefetch the body if personal (wait at most 5 s), then triage |
| `mail.changed {mailboxId, state}` | If followed and the state differs from the stored one: queue `mail.changes` (coalesced, keep-up priority) |
| Timers | Inbox every 5 min without any event (insurance). Other followed mailboxes every 15 min, or 30 min on `diff` servers for mailboxes over 10k messages. A mailbox a page has shown in the last 2 min: every 60 s |
| Manager reconnect, `onGap`, hub start | `mail.changes` on every followed mailbox |

Applying a `mail.changes` answer:

- `added`: ingest, with a location.
- `changed`: flags and labels, skipping flags with pending local ops.
- `removed`: drop the location. A message with no location left is deleted, and its thread is recomputed. Unknown ids
  are ignored.
- `more`: call again with the new state.

**410 means a relist.** The hub bumps `relist_gen`, takes a fresh state, lists from the newest down to the old horizon
marking `seen_gen`, then deletes the locations it did not see. Rows stay on screen throughout, with "Refreshing Inbox…"
under the list. An IMAP move appears as `removed` in one mailbox and `added` in the other, and Message-ID matching keeps
it the same message.

### 3.5 Load shedding for a big mailbox

Each account has one queue with four priorities, and at most two calls in flight:

| Priority | Calls | Budget |
|---|---|---|
| P0 user | a list page for an open mailbox, the bodies a reader needs, server search, ops, sends | unthrottled |
| P1 keep-up | `mail.changes` | – |
| P2 prefetch | `mail.get` for personal mail and visible rows | P2 and P3 together at most 2 calls/s per account; paused for 10 s after any P0 call |
| P3 backfill | `mail.list` pages of 200 | as above |

The manager's `limited` error backs off from 2 s, doubling. Ingest writes 200 summaries per transaction. During a
backfill the hub broadcasts only threads in the live window (the newest 200 of each followed mailbox, plus threads
listed in the inbox or changed by you). Other changes become `mail.lists {stale}`, and a page that holds such a list
refetches it when it next shows. A 50k-message mailbox costs about 250 list pages: some minutes of background, with the
first screen after one call. By estimate (not measured) the summaries take about 35 MB with their index; slice 2 measured
about 960 bytes a summary with its indexes and slice 6's people rows, so about 48 MB (docs/mail.md).

### 3.6 Offline and reconnect

- **Manager down** (`connected=false`). Background calls stop, and cached lists and bodies are still served. Ops and
  outbox items persist. On reconnect: changes, then ops, then the outbox.
- **Account offline** (status `offline` or `attention`). Its background work pauses. A user call answers 503, and the
  page shows the account's problem line from its status, e.g. "Proton Bridge running: not running" or "Sign in to Proton
  in the live view", with a link to the account on the manager's page.
- **The page offline.** The snapshot keeps the mail state window and the last 50 opened bodies (IndexedDB). Sends wait
  in the page's outbox, as chat sends do (`outbox.ts`), and go when the socket returns. They carry a `clientId`, so a
  retry sends once.

### 3.7 Writes (`ops.ts`)

Every write is applied in the hub first (`pending`), then queued in `mail_op` and batched per account, op and value, up
to 1000 ids. Moves use the location ids current at send time. The hub retries with backoff (writes stay under 5/s).

| Answer | What happens |
|---|---|
| 404 | Dropped, then a changes call. |
| 403 (grant) | Reverted; the account becomes read-only. |
| 501 | Reverted, and that op is marked unsupported for the account (Proton's `answered`). |
| Success | `move` returns new ids: null ones are found by the next changes call. |

## 4. "From a person"

Each message gets a `class`, decided by the first rule that matches, and the rule is kept in `class_why`. A thread is
`personal` if any message in it is.

| # | Rule | Class |
|---|---|---|
| 1 | Your override for the thread or the sender ("Not a person" / "This is a person") | as set |
| 2 | Sent from one of your addresses | `self` |
| 3 | The thread contains a message you sent | personal |
| 4 | You have written to this address before (Sent recipients, `mail_sender.wrote_to`) | personal |
| 5 | The address is an identity in a person who also has a chat identity (you merged them) | personal |
| 6 | In a `junk` mailbox | bulk (never surfaces) |
| 7 | Bulk hints, when the extractor gives them (§13): List-Id, List-Unsubscribe, `Precedence: bulk/list/junk`, `Auto-Submitted` other than `no` | bulk |
| 8 | Category labels: Gmail `CATEGORY_PROMOTIONS/SOCIAL/UPDATES/FORUMS`, or Proton's `Category/Social/Promotions/Updates/Newsletters/Transactions` | bulk |
| 9 | The local part looks automated: `no-?reply`, `do-?not-?reply`, `notifications?`, `alerts?`, `news(letter)?`, `mailer-daemon`, `postmaster`, `bounce`, `marketing`, `updates?`, `digest` | bulk |
| 10 | More than 10 recipients and you only in Bcc or undisclosed | bulk |
| 11 | Anything else (an unknown sender who looks human) | personal, `unknown` |

Rules 3–5 come before the bulk rules, so a newsletter author you write to still counts as a person. All of this is
local and uses metadata only. Triage (§10) adds the content signal on its own model. A personal-but-unknown thread
appears in the one-list inbox only if triage puts it at Active or above (Q4). "Not a person" on any row or message sets
rule 1 for the sender, moves the thread to Updates, and counts as a vote down.

## 5. Protocol and API (`packages/protocol/src/mail.ts`)

```ts
export interface MailAccess { state: 'off' | 'unreachable' | 'pending' | 'denied' | 'granted'; managerUrl: string | null }
export interface MailAccountView {
  id: string; kind: string; label: string; address: string | null; name: string | null; color: string;
  level: 'read' | 'write' | null; dryRun: boolean; online: boolean;
  problem: { layer: string | null; message: string } | null;
  send: { ok: boolean | null; why: string | null };
  sync: { phase: 'first' | 'backfill' | 'idle' | 'relist'; synced: number; oldest: number | null };
  managedUrl: string | null;
}
export interface MailboxView { id: string; accountId: string; name: string; path: string; parentId: string | null; role: MailboxRole | null; unread: number | null; total: number | null; followed: boolean }
export interface MailAddressView { name: string | null; email: string; identityId?: string; personId?: string }
export interface MailThreadView {
  id: string; accountId: string; subject: string; firstAt: number; lastAt: number; count: number; unread: number;
  flagged: boolean; attachments: boolean; from: MailAddressView[]; participants: number; preview: string | null;
  mailboxIds: string[]; roles: MailboxRole[]; labels: string[];
  class: 'personal' | 'bulk' | 'self' | null; unknown: boolean; personIds: string[];
  lastFromMe: boolean; owedSince: number | null; muted: boolean;
}
export interface MailMessageView {
  id: string; threadId: string; accountId: string; messageId: string | null;
  from: MailAddressView; to: MailAddressView[]; cc: MailAddressView[];
  subject: string; date: number; receivedAt: number;
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean }; pending: boolean;
  labels: string[]; mailboxIds: string[]; hasAttachments: boolean; preview: string | null;
  addressed: 'to' | 'cc' | 'hidden' | 'self'; body: 'cached' | 'none' | 'loading' | 'failed';
}
export interface MailBodyView {
  messageId: string; text: string | null; quoteAt: number | null;   // where quoted text starts in `text`
  html: { url: string; remoteImages: number; trackers: number; imagesShown: boolean } | null;
  bcc: MailAddressView[]; replyTo: MailAddressView[]; attachments: MailAttachmentView[];
  warnings: string[];   // display-name spoofing, Reply-To elsewhere, links whose text names another site
}
export interface MailAttachmentView { id: string; name: string | null; mime: string; size: number; inline: boolean; url: string; infoUrl: string }
export interface MailOutboxView { id: string; clientId: string; accountId: string; subject: string; state: 'held' | 'queued' | 'sending' | 'sent' | 'failed'; holdUntil: number | null; error: string | null }
```

**Bootstrap** gains `mail?: { access, accounts, mailboxes, threads }`, where `threads` is the live window: listed
threads plus each account's newest Inbox page, at most 300.

**Events**, added to `ClientEvent`:

```ts
| { t: 'mail.access'; access: MailAccess }
| { t: 'mail.account'; account: MailAccountView } | { t: 'mail.account.removed'; id: string }
| { t: 'mail.mailboxes'; accountId: string; mailboxes: MailboxView[] }
| { t: 'mail.threads'; threads: MailThreadView[]; removed: string[] }
| { t: 'mail.lists'; stale: string[] }            // list keys: 'mb:<mailbox>' or 'v:<view>:<account|*>'
| { t: 'mail.progress'; accountId: string; sync: MailAccountView['sync'] }   // not journaled
| { t: 'mail.outbox'; items: MailOutboxView[] }
```

`AttentionView` gains `kind?: 'mail'` (§10), and `notify` gains `mailThreadId?`. The journal gets kinds `mailAccount`,
`mailboxes` (id = account), `mailThread` (live window only) and `mailOutbox:*`. `SyncRequest` gains
`mailLists: { key, seq }[]`, and `SyncResponse` gains `mail: { threads, removed, stale }`. Everything new is optional,
so `SYNC_VERSION` stays.

**REST** (`mail/routes.ts`):

| Route | Answer |
|---|---|
| `GET /api/mail` | `{ access, accounts, mailboxes }` |
| `GET /api/mail/threads?list=<key>&before=<cursor>&limit=50` | `{ threads, next, complete, pending }` (views: `inbox`, `people`, `updates`, `unread`, `starred`, `sent`) |
| `GET /api/mail/threads/:id` | `{ thread, messages, identities }`; marks it opened (for "you were here") |
| `GET /api/mail/messages/:id/body` | `MailBodyView`; fetches it if not cached (waits up to 60 s) |
| `GET /api/mail/messages/:id/html?images=0\|1` | sanitised HTML with §7's headers |
| `GET /api/mail/messages/:id/cid/:cid` | an inline part |
| `GET /api/mail/messages/:id/attachments/:aid[/info]` | the bytes (fetched and cached), or `FileInfo` |
| `GET /api/mail/img/:token` | a proxied remote image |
| `POST /api/mail/flag` | `{ threadIds? , messageIds?, seen?, flagged? }` |
| `POST /api/mail/move` | `{ threadIds, to: mailboxId \| 'archive' \| 'inbox' \| 'junk' \| 'trash' }` |
| `POST /api/mail/images` | `{ messageId } \| { sender, allow }` |
| `PUT /api/mail/senders/:address` | `{ override?, images? }` |
| `POST /api/mail/send` | `{ clientId, accountId, kind: 'new'\|'reply'\|'replyAll'\|'forward', replyTo?, to, cc, bcc, subject, text, quote: boolean, uploads: string[], forwardParts?: {messageId, attachmentId}[] }` → `{ ok, outboxId }` |
| `DELETE /api/mail/outbox/:id` | undo while held |
| `GET/PUT/DELETE /api/mail/drafts/:key` | hub-side drafts |
| `GET /api/mail/search?q=&cursor=&server=1` | §11 |
| `POST /api/mail/refresh/:accountId` | pull to refresh: changes now |
| `POST /api/mail/triage/:messageId/vote` | `{ level }` |

## 6. UI (`packages/web/src/ui/mail/`, `packages/web/src/mail/`)

### 6.1 Where it goes

- **Route** `{ view: 'mail', list?, thread?, compose? }` in `state.ts`: `#/mail`, `#/mail/l/<listKey>`,
  `#/mail/t/<thread>`, `#/mail/new`. `App.tsx`: `centerFor` (reader), `sidebarFor` (`MailSidebar`), `isDetail` (the
  reader is a card).
- **Rail:** a Mail entry after People when `access` is not `off`, with an unread dot for personal mail. The phone's tab
  bar is unchanged: Mail sits in Home beside People. Ctrl+K lists Mail, its views and mailboxes.
- **Accounts and Settings:** mail accounts show in `AccountsSidebar` under "Mail" with their problem line and a link to
  the manager; Settings gains a `set-mail` block.

### 6.2 Phone: the list

```
┌──┬───────────────────────────────┐
│◉ │ Mail                        ✎ │
│✉•│ ● All accounts ▾              │
│👤│ [Inbox] People Unread Starre  │
│  │───────────────────────────────│
│▣ │ (S) Sam Lee             10:42 │
│▣ │     Dinner on Friday?      📎 │
│  │     Are you free after 7? I…  │
│  │───────────────────────────────│
│  │ (A) Alex, Jo, me  3     09:10 │
│  │     Re: Lease renewal         │
│  │     I signed page 2 and…      │
│  │───────────────────────────────│
│  │ ▸ Updates · 14 new            │
│  │   GitHub, Bank, Rust Weekly…  │
│  │───────────────────────────────│
│  │ Syncing older mail · 12,400   │
├──┴───────────────────────────────┤
│   Home    Triage   Search   You  │
└──────────────────────────────────┘
```

In Inbox, bulk threads fold into one **Updates** row; opening it is the `updates` view. Bold means unread. Each row
carries an account colour dot when more than one account shows. The views are one row of chips that scrolls sideways
(no scrollbar, its edge fading while more lies past it, the chosen one scrolled into view). With several accounts the
line under "Mail" picks the account: a menu of All accounts and each account with its dot's colour, which also says
what the dot is. Single-line text in a row ends in an ellipsis. **Swipes:** right archives, left marks read or unread.
**Long-press** opens the menu: Archive, Move to…, Star, Not a person, Mute, Trash. ⋯ opens the mailbox tree per
account. Pull down refreshes.

### 6.3 Phone: the reader (a card over the list)

```
┌──────────────────────────────────┐
│ ‹  Re: Dinner on Friday?     ⤓  ⋯│
│──────────────────────────────────│
│ (S) Sam Lee  Hey! Are… Tue 18:02 │  ← older messages fold to one line
│──────────────────────────────────│
│ (S) Sam Lee <sam@lee.example>    │
│     to me, Jo · 10:42          ▾ │
│ ┌ 3 remote images hidden ─────┐  │
│ │ Load · Always from Sam      │  │
│ └─────────────────────────────┘  │
│ ┌─ white sheet, fit to width ─┐  │
│ │ Are you free after 7? …     │  │
│ │ ···  (quoted text)          │  │
│ └─────────────────────────────┘  │
│ [📄 menu.pdf · 2 pages · 180 KB] │
│──────────────────────────────────│
│  ↩ Reply    ⇇ Reply all   ↪ Fwd  │
└──────────────────────────────────┘
```

- **The header** on a phone: the subject on up to two lines, then an ellipsis; Archive (or Move to Inbox) and ⋯ beside
  it, with Trash and Star in ⋯. On a desktop Trash and Star are buttons too, and the subject one line.
- **Folding:** unread messages and the latest are open; the rest are one line each: who and the start of the text (the
  reader asks for the bodies of folded messages without a preview when the thread opens, so yours have one too).
  **Headers** always show the address beside the name; ▾ adds To, Cc, Reply-To and labels, and `warnings` show there
  in amber.
- **Quoted text** folds behind ···: `quoteAt` for text, the hub's `dc-quote` markers for HTML (`blockquote[type=cite]`,
  `.gmail_quote`, `.protonmail_quote`, `#divRplyFwdMsg`, `.yahoo_quoted`).
- **Plain text** renders as text with links, never Markdown. **HTML** renders in the frame (§7) on a white sheet in every
  theme, scaled down to fit the width, unless it is plain and the mail has a text part: then the text shows (§7).
- **Attachments** are chat's file cards, opened by `openAttachment` or the in-app viewers through a `FileSource { url,
  infoUrl, name, mime, size }` (a small refactor of `files.ts`/`fileopen.tsx` off `/api/attachments/:id`).
- **Swipe back** works over a body: the page forwards the frame's touch events to `Pager.ts` (it is same-origin).

### 6.4 Composer (a full-screen card on a phone, a docked panel on desktop)

```
┌──────────────────────────────────┐
│ ✕  Reply                  Send ▶ │
│ From  me@proton.me               │
│ To    [Sam Lee ×] |              │
│ Cc Bcc                           │
│ Subject  Re: Dinner on Friday?   │
│──────────────────────────────────│
│ Yes, 7:30 works.|                │
│                                  │
│ ··· Sam Lee wrote:  (quoted)     │
│──────────────────────────────────│
│ 📎 [ticket.pdf 1.2 MB ×]  + Add  │
└──────────────────────────────────┘
```

Recipients are chips completing from people (email identities first) and `mail_sender`. From is fixed text until §13.
The body is plain text, sent as `text` plus a simple `html` from it. Attachments use chat's upload flow (`startUpload`)
with the account's limits shown. Drafts save to the hub every 2 s, keyed by thread or `new:<uuid>`. Send shows
"Sending… Undo" for 10 s.

### 6.5 Desktop

```
┌──┬──────────────────────┬────────────────────────────────────────┐
│◉ │ Mail  All ▾   🔍  ✎  │ Dinner on Friday?          ⤓  🗑  ★  ⋯  │
│✉ │ ▾ Views              │ (S) Sam Lee <sam@lee.example>    10:42 │
│👤│   Inbox          12  │     to me, Jo                          │
│  │   People          3  │ 3 remote images hidden · Load · Always │
│▣ │   Updates        40  │ ┌────────────────────────────────────┐ │
│▣ │   Starred · Sent     │ │ sanitised HTML in a sandboxed frame│ │
│  │ ▸ me@proton.me       │ └────────────────────────────────────┘ │
│  │ ▸ me@gmail.com       │ [menu.pdf]                             │
│  │ ──────────────────── │ ↩ Reply   ⇇ Reply all   ↪ Forward      │
│  │ Sam Lee   10:42  📎  │                                        │
│  │ Dinner on Friday?    │                                        │
│  │ Alex, Jo (3)  09:10  │                                        │
│  │ Re: Lease renewal    │                                        │
└──┴──────────────────────┴────────────────────────────────────────┘
```

The same components, with the sidebar holding views and mailboxes above the thread list. Keys: `j`/`k` move, `e`
archives, `r` replies, `a` replies all, `f` forwards, `c` composes, `#` trashes, `s` stars, `u` marks unread, `/`
searches.

### 6.6 States

| State | What shows |
|---|---|
| `access: off` | No Mail entry. Settings → Mail: "Mail comes through dither-accounts. Set DITHER_ACCOUNTS_URL on the hub." |
| `pending` | Mail: "dither-chat asked dither-accounts for your email (read and send). Approve it on the manager's page." [Open dither-accounts] |
| `denied` | "You declined mail access." [Ask again] |
| granted, no mail accounts | "No mail accounts in dither-accounts. Add Email (IMAP) or Proton Mail there." [Open] |
| first sync | skeleton rows, then the first 50; "Syncing · 2,300 of about 14,000" |
| empty mailbox | "Nothing in Archive." / Inbox at zero: "Inbox is empty." |
| account problem | a strip over its threads: the problem line and [Open in dither-accounts]; cached mail stays readable |
| read grant | reader footer: "dither-accounts lets dither-chat read this account, not change it. Read here only." No archive, star or send. [Change] |
| can't send | reply bar and ✎ off for that account: "me@proton.me can't send from here: Proton's send path was not found in the page (dither-accounts answered 501). Reading, archiving and starring work." |
| dry run | composer banner: "Dry run: nothing reaches the account." |
| offline | the existing reconnect bar; ops and sends say "waiting for the hub" |

## 7. Safety: HTML, images, links, files

**Sanitising** happens on the hub (`sanitize.ts`) with Bun's built-in `HTMLRewriter` (no new dependency), from an
allowlist. `script`, `iframe`, `object`, `embed`, `form` and its controls, `link`, `meta`, `base`, `svg`, `math`,
`template` and `noscript` go with their content. All `on*` attributes go; `href` may be http(s), mailto or `#`; `src` and
`srcset` are rewritten. `style` stays, minus `url()` (a proxy token when images are allowed), `@import`, `expression` and
`behavior`. Quotes get the `dc-quote` class. Remote images and trackers are counted; a tracker (1–2 px, or hidden by its
style) is always dropped. The output is cached in memory by (message, sanitiser version, images).

**Serving** (`/api/mail/messages/:id/html`):

- `content-security-policy: sandbox allow-same-origin; default-src 'none'; img-src <hub origin>/api/mail/ data:;
  style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'`
- `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cache-control: private`

The page loads it in `<iframe sandbox="allow-same-origin" referrerpolicy="no-referrer">`. No script runs in the frame:
neither `sandbox` grants `allow-scripts`, and the CSP forbids script. `allow-same-origin` is there only so the **page**
can reach in to size the frame, fold quotes, forward touches and catch clicks. The media player already uses the same
pairing (`PLAYER_CSP`). Opened on its own in a tab, the URL is still sandboxed by its CSP.

**Plain HTML shows as text.** The sanitiser also says whether the HTML is plain (`Sanitized.plain`): only text,
paragraphs, line breaks, links, lists, blockquotes, bold and italic; no images, tables, headings, colours, backgrounds,
fonts, alignment or style sheets (margins, how lines wrap and a quote's left bar are allowed). When it is, and the mail
has a text part of its own (not the text the hub made from the HTML, and not a stub much shorter than it: parts.ts
`hasTextPart`), the body view says `html.plain` and the reader shows the text part (TextBody, with its quote fold) in
the app's theme, so a reply sent from here does not open as a white sheet among dark text. Anything styled keeps the
sheet. This only chooses which part to show: the frame, its sandbox, its CSP and the allowlist are as above, and the
HTML is still served for anyone who asks.

**Links.** The page listens for clicks on the frame's document in the capture phase, prevents the default, and passes
the href to the same opener chat links use (`desk.ts`: the desk helper, `window.open`, or Android's system browser).
When a link's visible text names a different host than its href, a sheet asks first, showing the real host.

**Remote images** are blocked by default and replaced by a neutral placeholder. The banner offers "Load" (this message,
`images_allowed`) and "Always from <sender>" (`mail_sender.images`). Sanitising with images allowed rewrites each URL to
`/api/mail/img/<token>`, where the token is an HMAC (with the hub's media key) of the message id and the URL, so the
proxy fetches only URLs that appear in that message. `images.ts` fetches through `fetchPublicToFile`: public addresses
only, every redirect checked, no cookies, no Referer, a generic User-Agent, at most 10 MB. It keeps a response only if
its bytes sniff as an image, and serves it with `SANDBOX_CSP`. Images are fetched when shown, never on arrival, because
prefetching would tell senders that the address is live. `cid:` images come from the message's own parts and always
show.

**Files** go through the media cache with fileinfo sniffing, so a card says what the file really is. They open in the
same viewers or the same native handoff as chat files. A file whose bytes are an executable or a script gets the cards'
existing warning.

## 8. Sending (`outbox.ts`, `compose.ts`)

As built in slice 5: docs/mail.md "Sending" says what differs (drafts one per thread, the send body is a `MailDraft`,
a 501 keeps sending off until you ask again, the outbox event carries the whole list).

- **`compose.ts`** builds `OutgoingMail`. Reply: To is the original's Reply-To, else its From; `Re: ` once; `replyTo` is
  its current native id. Reply all adds its To and Cc, minus your addresses. The quote is "On <date>, <name> wrote:" with
  `> ` lines, and in HTML a `blockquote type=cite` around the sanitised original without images. Forward: `Fwd: `, a
  header block, the original's text and HTML, and its attachments (fetched into the cache, attached by `path`).
- **The outbox:** `POST /api/mail/send` saves a row (once per `clientId`), `held` 10 s, then `queued` for `mail.send`.
  Uploads go as `path`s when the manager is on loopback, else base64; 25 MB a file, and the files together at most the
  status's `details.sendCap` (else 35 MB, 25 MB on Proton), checked before queueing.
- **Answers:** success links the row to Sent's copy by `messageId` (a local "Sent" message shows until then). 503 or a
  timeout retries; a timeout after the call reached the extractor says "may have been sent", as chat does. 501 fails the
  item, keeps its draft and sets the account's `send` to `{ ok: false, why: <the extractor's message> }`. 403 means a read
  grant. 422 fails the item by its code: `from` or none is "That From is not one of this account's addresses.";
  any other code is the extractor's sentence with each "recipient N" (or "recipients N and M") replaced by those addresses (To, then Cc, then Bcc,
  an address once; a number past the last stays): `recipients`, `settings` (Proton signs outside mail or attaches your
  key), and the manager's `failed`, which is all an extractor's 422 carries until the manager passes its code on. A 422 leaves `send` as it was: only that message is refused.
- **Before any attempt**, `send.ok` is false when a status layer matching `send path` or `SMTP` has failed, true after a
  success, else null (sending allowed). §13's `canSend` would replace the name matching.

## 9. People

- **Identities:** every personal sender (§4) and every recipient of your mail becomes an `identity` (`network: 'email'`,
  lowercased address, name from the latest From). Bulk senders stay in `mail_sender` only.
- **Persons:** an email identity gets its own person, as a DM partner does, once you have written to it or it wrote to
  you in a thread you took part in. It joins an existing person only by your merge (the merge search now finds email
  identities). Nothing links by name: the profile's "same name elsewhere" hint covers email ("Sam Lee <sam@…> may be Sam
  Lee on Signal: Merge"). Linking through dither-accounts' `contacts` interface is a later slice.
- **Profiles** gain a **Mail** card (recent threads, how many, "All mail with Sam" = `with:<address>`), and Message's menu
  adds "Email <address>". `ProfileView` gains `mail?: { threads: MailThreadView[]; total: number }`.
- **The graph** counts mail threads on a person's card. Email-only people have no places, so they are hidden by default.

## 10. Inbox ranking, triage and notifications

**Which threads are listed in the one-list inbox.** A thread is listed (`listed`) when all of these hold:

- it is personal (unknown senders only at Active or above, Q4), not muted, and in Inbox;
- and it is unread, or you owe a reply, or its last message is under 7 days old, or you opened it in the last 2 days.

Archiving removes it.

**The score.** `mail/attention.ts` folds each listed thread's messages with `attention.ts`'s pure `foldMessage` into
`mail_feature`, and scores it with `scoreConversation`. The mapping:

| attention.ts input | From mail |
|---|---|
| `Place.shape`, `members` | `direct` for you and one other, else `group` with the participant count |
| `mentionsMe` | you are in To |
| `repliesToMe` | `In-Reply-To` is one of your messages |
| `question` | triage's reason |
| `unread`, `mentions` | the thread's unread messages, and those with you in To |
| `pinged` | triage pushed an unread message |
| `usage` | `opened_at`/`opened_ms` |
| author tally | the person's mail and chat tallies summed (`mail_author_feature` + `conv_author_feature`) |

So "you usually reply to Sam within an hour", "Sam wrote to you; not answered yet" and "you were here" read the same
for mail. The result is an `AttentionView` with id `mth_…` and `kind: 'mail'`, sent in the same `attention` events.
Until the learned order is retrained with mail (slice 10), a mail row keeps its formula points; under the learned
order's prior those are the same scale.

**The web side.** `InboxRow` in `model.ts` becomes a union, `{ kind: 'conv', conv } | { kind: 'mail', thread }`, keyed
by id in `inbox.ts` and `ordering.ts`. `Sidebar.tsx` gets a `MailRow`:

```
│ (S)✉ Sam Lee                 10:42 2│
│      Dinner on Friday? — Are you f… │
│ (M)  Maya                    10:30 1│
│      ok see you                     │
```

It has the person's avatar with an envelope badge in the network-badge spot, the subject before the preview, the same
↩ owed mark and the same reasons on hover. Chips: All and Unread include mail, People includes one-to-one threads,
Groups the rest. Tapping a row opens the reader.

**Triage.** `mail/triage.ts` builds learn.ts `Facts` per new personal message: `network: 'email'`, `shape: 'mail'`,
`conversation: <thread>`, `spaces: [<mail account>]`, `author` (person, else identity), `known`, `mention` (in To),
`everyone` (Cc or a list), `reply` (to you), `question`/`urgent` from subject and text, `link`, `long`, `media`. Its
`base` is `push` for a known sender with you in To, `quiet` for one in Cc, `digest` for an unknown sender. It runs
`predict` with the live model on words from the subject and the first 2 KB of text, and stores the result in
`mail_triage`. **Bulk is never triaged**: `drop`, with no notification and no digest. Votes (notification, How it sorts (once the Triage board),
the reader's ⋯) join `votes.ts`'s examples; the author feature is the person, so voting Sam's mail up raises Sam on
Signal too, and the reverse. Quiet hours hold mail as they hold chat.

**Delivery.** `deliverMail` in `main.ts` reuses `push.notify`, `server.notify` and `activity.notification` with
`conversationId = <thread>`. The title is the sender, the body is subject — preview, the picture is the person's avatar
with the email mark. `devices.ts` gets a mail chain (`network:email`, `account:<mail account>`), so "Email off on the
phone" works. `delivery.ts` groups a thread's lines as a chat's. `public/sw.js` and Android open `#/mail/t/<thread>` when
`mailThreadId` is set, and reading the thread calls `push.clear`. How it sorts (once the Triage board) lists mail with an ✉ mark.

## 11. Search

- **Local** (`mail/search.ts`): FTS5 over `mail_fts` (subject, people, cached body text) through `parseSearch`, with
  mail operators added (`from:`, `to:`, `with:`, `subject:`, `in:<mailbox>`, `label:`, `has:attachment`, `is:unread`,
  `is:starred`, `account:`, dates). Instant, paged by cursor, with chat search's inside-words and spelling fallbacks.
- **Server:** with `server=1`, or when the local page has under 20 hits, `mail.search` on each account (P0, limit 50).
  Gmail gets X-GM-RAW; Proton matches only subjects and addresses, and the results say so.
- **Merge:** server hits are ingested as summaries (so they open like any other), deduplicated by hub id, newest first,
  and marked "from the server" when only the server had them.
- **Where:** Mail's 🔍 searches mail; the app's search page gains a **Mail** group (local, top 5, "More in Mail").
- **As built (slice 7):** `mail_fts` indexes `mail_search` (the text, and the account, thread, time and "only in Junk or
  Trash" a search filters by), kept by triggers, with the body's text from slice 2's `mail_text` under its one cap. Hits
  are threads; `server=auto` does the "under 20" rule, and the page asks the hub first, then the servers. docs/mail.md's
  Search section has the rest and the timings.

## 12. Build slices

### 12.1 The slices

Slice 1 goes first and alone. Slices 2–7 can run in parallel once it lands. 8 needs 6, 9 needs 8, and 10 comes later.
Each slice adds files under `hub/src/mail/` and `web/src/ui/mail/`. Shared files get small hooks created by slice 1: the
`routes.ts` table, `MailHub`'s events, and slots in `MessageCard` (body renderer, actions) and `ThreadRow` (swipes).

| # | Slice | Needs | Files | Tested by |
|---|---|---|---|---|
| **1** | **Read-only mail, end to end**: grant request, mailboxes, Inbox and Sent's newest 500, keep-up via events and changes, 410 relist, threading steps 1–3, list, reader showing text (an HTML-only message shows its text part), local read state, demo seed | – | protocol `mail.ts`, `mail-iface.ts`, `ids.ts`, `ontology.ts` ('email' and its Record entries, incl. web `Accounts.tsx`, `Profile.tsx`, hub `readqueue.ts`, `about.ts`), `api.ts`, `index.ts`; hub `mail/{schema.sql,store,thread,backend,fake,sync,queue,routes,index}.ts`, `remote.ts`, `server.ts` (mount, bootstrap), `sync.ts`, `main.ts`, `demo.ts`; web `state.ts`, `App.tsx`, `Rail.tsx`, `Switcher.tsx`, `syncmodel.ts`, `snapshot.ts`, `mail/{model,api}.ts`, `ui/mail/{MailSidebar,ThreadList,ThreadRow,Reader,MessageCard,TextBody}.tsx`, `Accounts.tsx` (Mail group), `styles.css` | `hub/test/mail-thread.test.ts` (threading table), `mail-store.test.ts`, `mail-sync.test.ts` (fake: order of first sync, `more`, 410, moves with new ids, Proton-like account-wide state and unknown removed ids, arrived before changes, gap, manager down and back), `mail-remote.test.ts` (§12.2); `web/test/mail-model.test.ts`, `mail-text.test.ts` (quote folding); `scripts/verify-mail.ts` (demo hub, phone and desktop) |
| 2 | **Big mailboxes**: backfill to the horizon, priorities and budgets, pages on demand, body prefetch and LRU eviction, search text cap, progress line, live window and `mail.lists` | 1 | `mail/{backfill,bodies,cache}.ts`, hooks in `sync.ts`; web `ThreadList.tsx` (endless scroll), progress line | `mail-load.test.ts`: fake with 60k messages; first screen within 3 calls; background ≤ 2 calls/s; P0 overtakes P3; eviction keeps starred mail; horizon respected; memory flat. Timings into `docs/mail.md` |
| 3 | **Safe HTML and files**: sanitiser, CSP route, frame host, quote folding in HTML, image banner and proxy, `cid:`, attachments and viewers | 1 | `mail/{sanitize,images,parts}.ts`, a sub-router; web `ui/mail/{HtmlBody,ImageBanner,MailFiles}.tsx`, `files.ts`/`fileopen.tsx` (`FileSource`), `Pager.ts` (forwarded touches) | `mail-sanitize.test.ts` (a hostile corpus: script, `on*`, `javascript:`, meta refresh, base, forms, svg, `url()`, `@import`, srcset, encoded tricks); `mail-images.test.ts` (token, private address, not an image, size, headers); `verify-mail.ts --html` in Chromium: no script runs in the frame, no request leaves except to the hub, a click goes through the opener, swiping back over a body works |
| 4 | **Shared read state and filing**: mark read on open, star, archive, move, trash, junk, op queue, offline, multi-select | 1 | `mail/ops.ts`; web reader actions, `ThreadRow` swipes, selection | `mail-ops.test.ts` (fake: optimistic and pending, batches of 1000, 404/403/501, restart with queued ops); `mail-remote.test.ts`: a second IMAP client sees \Seen; a move gives a new UID and the same hub message |
| 5 | **Sending**: composer, reply, reply all, forward, attachments, drafts, hold and undo, send-disabled and read-only states | 1 (3 for HTML quotes) | `mail/{compose,outbox}.ts`; web `ui/mail/Composer.tsx`, `mail/drafts.ts` | `mail-compose.test.ts` (pure: recipients, subjects, quotes); `mail-send.test.ts` (fake: hold and undo, 501 → send off with the message, read grant, dry run, retries, path vs base64, `clientId` once); remote: the SMTP sink receives it, and a reply threads; `verify-mail.ts` composer on a phone |
| 6 | **People**: email identities and persons, merge search and hint, profile Mail card, `with:` | 1 | `mail/people.ts`, small edits to `store.ts` (merge search), protocol `ProfileView.mail`; web `Profile.tsx` | `mail-people.test.ts` (who gets a person; no merge by name; a merge carries mail), `verify-profile.ts` addition |
| 7 | **Search**: FTS, operators, server merge, Mail group in search | 1 (2 for body text) | `mail/search.ts`, protocol `search.ts` operators; web `ui/mail/MailSearch.tsx`, `Search.tsx` | `mail-search.test.ts` (operators, local then server, deduplication, Proton's no-body note) |
| 8 | **Classification and the one-list inbox**: §4 rules, Updates fold, People/Updates views, overrides, thread attention, inbox union | 1, 6 | `mail/{classify,attention}.ts`, `attention.ts` (author tallies summed), protocol `AttentionView.kind`; web `model.ts`, `inbox.ts`, `ordering.ts`, `Sidebar.tsx` (`MailRow`) | `mail-classify.test.ts` (each rule, order, overrides); `mail-attention.test.ts` (owed, unread, the listing window, archive removes); `web/test` inbox with mixed rows; `verify-inbox.ts` mixed |
| 9 | **Triage and notifications** | 8 | `mail/triage.ts`, `votes.ts`, `main.ts` (`deliverMail`), `devices.ts`, `delivery.ts`, `push.ts` payload, `public/sw.js`, Android `Notifications.kt`; web board, `DeviceRules.tsx` | `mail-triage.test.ts`: bulk never notifies; a known sender in To pushes; quiet hours hold; device rule "Email off"; one vote on Sam's mail moves Sam's chat chance; `verify-notifications.ts` mail |
| 10 | Later: the learned order trained with mail opens (`rankhistory.ts`, `ranker.ts`, a `shape:mail` feature); a From picker (after §13); contacts-based linking | 8, §13 | – | the replay (`inbox-replay.ts`) with mail opens |

Slices 1–4 add up to read, file and keep up in sync for any number of accounts. Slice 5 adds sending, and 8–9 make mail
part of the inbox.

### 12.2 What the tests need

- **`FakeMailBackend`** (`hub/src/mail/fake.ts`, slice 1) implements `MailBackend`, not the wire, so hub tests are fast
  and `--demo` can seed a mail account (a few people, a newsletter, an HTML message with a tracker and a hostile script,
  an attachment). Options: ids that change on a move (imap), not (proton), one per mailbox a Gmail message is in
  (gmail: its labels, CONDSTORE, MOVE and search as Gmail has them), or one for the message in every label (gmail-web:
  dither-accounts' google kind), the status's `details`, `threadIds` on or off, an account-wide
  state, `send: 'ok' | 501`, `refuseRecipient` (422 `recipients`), status layers, and failures per op (410, 503, 404,
  `limited`, latency). It emits
  `mail.arrived`/`mail.changed` IDLE-like (inbox only) or event-loop-like (every mailbox).
- **`mail-remote.test.ts`** checks the real wire, like `remote.test.ts`. It starts a throwaway manager on a temp
  directory from the dither-accounts checkout, with one `imap` account against that repo's test servers
  (`extractors/imap/test/servers.ts`: Dovecot 2.4 from nix and the SMTP sink, on 127.0.0.1). Use ports 18580–18589:
  dither-accounts' own tests use 18550–18569. It approves the hub's requests over the manager's API, then checks the
  first sync, keep-up via IDLE events, 410 after a UIDVALIDITY change, flags seen by a second client, a move, and a
  send that arrives. It is skipped without the checkout or Dovecot, so a plain `bun test` stays fast.
- The Proton read-only path uses the fake (501). The real Proton fake needs Chromium and belongs to dither-accounts'
  suite.
- No test or script ever points at `.data` or at the live hub or manager.

## 13. Asks of dither-accounts (optional; one small PR there, parallel to slice 1)

All are optional fields, so existing extractors stay valid, and dither-chat works without them, only worse.

1. **`MailSummary.inReplyTo` and `references`** (up to 20). Plain IMAP gets them cheaply: In-Reply-To is in ENVELOPE,
   and References is one `BODY.PEEK[HEADER.FIELDS (REFERENCES)]`. Without them, plain-IMAP threads are provisional
   until bodies are fetched.
2. **`MailSummary.bulk?: { listId, unsubscribe, precedence, autoSubmitted }`**, from the same header fetch (Proton:
   `ParsedHeaders` where the list gives it). Without it, §4 loses its strongest bulk signal.
3. **`OutgoingMail.from?: string`**, and the account's sending addresses in `status.self.addresses`. Without them,
   there is no From picker.
4. **`status.details.canSend: boolean`, with `sendNote`**, so apps need not match layer names.

## 14. Decisions (the owner, 2026-11-07)

1. **§13's fields: yes.** They landed on dither-accounts master as 515f26d (`inReplyTo`, `references`, `bulk`,
   `OutgoingMail.from`, `status.self.addresses`, `details.canSend` and `sendNote`). All are optional: the hub uses
   them when present and works without them.
2. **How far back: one year plus all of Inbox**, with older mail fetched on demand when you scroll or search
   (`MAIL_LIMITS.syncDays`, `DITHER_MAIL_SYNC_DAYS`). Slice 1 lists only the newest 500 of Inbox and Sent; the horizon
   and the backfill are slice 2.
3. **Mark read on the server after the message has been in view for 1 s**, with a setting for "only when I mark it"
   (slice 4). Slice 1 keeps read state on the hub only, set after the same second in view, and never calls
   `mail.flag`.
4. **Unknown senders who look human reach the one-list inbox only when triage rates them Active or above** (slice 8).
5. **Mail accounts are added on the dither-accounts manager's page**, not from dither-chat. The Accounts screen's Mail
   group lists them and links there; there is no add form here.
6. **When access to an account ends, its cached mail is deleted after 24 hours**, with "Delete now" in Settings (and
   in the Accounts screen's Mail group). Built in slice 1: the account's level becomes null, `gone_at` is set, a sweep
   deletes it a day later, and coming back on the list before then keeps everything.
