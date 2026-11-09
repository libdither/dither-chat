# Coming back without starting over

A phone loses the live socket whenever the app goes to the background for a while or the network blips. Until now
every return cost a full `/api/bootstrap` (4.9 MB of JSON, about 800 KB as zstd, on the real hub), the inbox, the
usage totals and the first page of every open conversation again, and the app said "Reconnecting to the hub…" in
the meantime. Now a return asks the hub for what changed since the last thing it saw, and shows nothing unless the
hub stays out of reach.

## The journal (`packages/hub/src/journal.ts`)

Every frame the hub broadcasts on `/api/live` that changes something gets the next position (`seq`), and ends with
`{ t: 'sync', seq }`. The journal is a table, `sync_change`, with one row per changed object: `(kind, id)` at the
position of its latest change, plus the conversation for a message, and whether it was removed. It holds ids only:
what an object is now is read from its own table when a client asks. Being compacted, it grows with the number of
objects that changed, not with the number of changes.

- **Kinds**: `account`, `identity`, `person`, `space`, `conversation`, `message` (with its conversation),
  `attention` (the inbox score of a conversation), `usage` (`kind:id` of a place), and the lists kept whole, under id
  `*`: `folders`, `placePrefs`, `categories`, `rules`, `arrange`, and `attention:*` / `usage:*` for "all of them".
  Typing, notifications and mark-all-read progress are of the moment and not kept.
- **Epoch**: a random id for the journal. Every position belongs to one; a position from another epoch is void.
  The epoch changes when the journal cannot vouch for what happened: the hub did not stop cleanly last time (a crash
  or a kill can lose the last 80 ms of changes, which were in the database but not yet in a frame), the demo world was
  reset, or the database is new. A clean stop flushes and marks the journal closed (`main.ts`).
- **Floor**: rows older than 14 days, or beyond the newest 250,000, are dropped hourly. The newest dropped position is
  the floor; a client from before it starts over.
- **Version**: `SYNC_VERSION` in `packages/protocol`. A client of another version starts over.
- `/api/bootstrap` carries `sync: { v, epoch, seq }`, read after a flush so it covers what the bootstrap shows.

Attention scores live in memory and are worked out again at every start, so a start journals `attention:*`, and a
client from before it gets the whole list once.

## `POST /api/sync` (`packages/hub/src/sync.ts`)

```
{ v, epoch, since, timelines: [{ key: 'c:<conversation>' | 'p:<person>', seq, newest, oldest, newer?, conversationIds? }] }
```

The answer is either `{ full: true, reason }` (another version, another epoch, older than the floor, or ahead of the
journal, as after restoring an older database) or:

- `events`: the live socket's own events for everything changed after `since`, read as it is now: `account`,
  `identity`, `person`, `space` (with its edges), `conversation`, the `*.removed` ones, `folders`, `placePrefs`,
  `categories`, `rules`, `attention`, `usage`, `arrange`. The client applies them exactly as it applies live frames.
- `inbox`: triaged, not silent, last 7 days, changed since (at most 300, which is the inbox's own size).
- `timelines`: for each one the client holds, the messages after its newest, and the ones it holds (between `oldest`
  and `newest`) that changed since its `seq`: edits, deletions, reactions, triage, forwards. When there are more than
  a page (60) of new ones, when the timeline's `seq` is older than the floor, or when a person timeline now spans
  other conversations (people merged or split), it gets `replace: true` and the newest page instead.
- `selfPersonId`, `categoryProvider`, and `reactionUsage` (only when messages changed), the identities the messages
  name, and the messages their replies quote.

Without `since`, only the timelines: that is how a conversation kept in the snapshot catches up when it is opened.

## What counts as a change

Each mutation a client can see goes through the store's `dirty` sets, `Store.flush()` turns them into events, and
`HubServer.broadcast` journals every frame, so the live socket and the journal cannot disagree. The audit for this
found places where neither the socket nor anything but a new bootstrap carried a change, now fixed:

- identities created in passing (a message author, a participant, a reactor) and the author of a backfilled last
  message were never sent, though a bootstrap lists them;
- a new contact's person did not update the direct conversations that show it;
- removing an account did not update places another account still sees (their vantages), nor identities whose
  person went with it;
- a removed space or conversation left its edges behind in the client;
- an inbox score that had not changed in substance was replaced with a newer timestamp the client never got;
- time spent in places and sort settings had no events at all: the app fetched them on every return. Now `usage`
  and `arrange` events carry them, and the app fetches them only when it has never had them.

And the other way: adapters announce every channel again on each (re)connect, and the store used to mark every one of
them changed. Spaces, conversations and messages are now compared with what was stored and only real changes are
news, so a Discord reconnect costs clients nothing. (This also stops a new message from re-sending its conversation's
whole page: the old client reloaded an open timeline whenever a conversation event named a last message it did not
hold yet, which the frame's own message event was about to deliver.)

`packages/hub/test/sync.test.ts` holds the hub to it: a real hub over HTTP and a real socket goes through every kind of
change above, and after each step a client applying the socket's frames, a client syncing a delta after every step,
and one syncing once at the end are each compared, through the web app's own reducer (`packages/web/src/syncmodel.ts`),
with a fresh bootstrap: every list, edge and score, the identities a bootstrap carries, the held timelines against
fresh pages, the inbox, and the usage totals. It also covers each refusal, restarts clean and unclean, pruning, an
adapter announcing the same things again, and a send retried after a lost answer going out once.

## The client (`packages/web/src/state.ts`)

- **Resume**: when the socket opens, the app syncs from the position in its copy of the state, which the snapshot
  keeps too, so a cold start resumes from the snapshot rather than starting over. It waits for the snapshot read
  (at most 1.5 s) before asking. Only a refusal leads to a full bootstrap. Frames that arrive while a sync is in
  flight are held and applied after its answer, in order, so the answer cannot undo them.
- **Timelines**: held ones are caught up in the same request; one kept in the snapshot catches up from its own
  position when opened. A pull to refresh still reloads everything.
- **Heartbeat**: a `ping` text frame every 25 s while in sight, and at once on `visibilitychange`, `focus`, `online`
  and `pageshow`. Without a `pong` within 3 s the socket is dropped and a new one opens at once, rather than waiting
  for TCP to notice a socket that died while the phone slept.
- **Quiet**: no banner for a drop. The small notice ("Can't reach the hub · showing what this device has") appears
  only when the hub has not answered for 4 s, counted from the unanswered ping, or at once when a send is waiting.
  It never blocks anything. The loading screen is only for a first start with nothing kept.
- **Sends** without the hub wait, marked "Waiting for the hub, sends when it is back", and go out when the sync after
  reconnecting is done. Each carries a `clientId`; the hub answers a repeat of one it is sending or sent in the last
  15 minutes with the first answer, so a send whose answer was lost goes out once. Until the hub has taken it, a send
  is kept on the device (IndexedDB, with its files, `outbox.ts`): after a reload or the system closing the app it is
  shown again and goes out after the first sync, under the same `clientId`. One the hub refused stays, with the
  reason, to try again or discard. Its files upload as they are attached, a piece at a time ([uploads.md](uploads.md)):
  a send waits for the ones still uploading, an upload carries on after a reload, and the hub keeps them across its
  own restart.
- **The pending copy** of a send goes when its message is here. The hub's answer carries `messageId`, the hub id of the
  message the network says it sent (ids are derived from the network's, so it is known before the message is stored),
  and the copy goes when that message arrives, live, in a sync or in a page, or at once if it is already here. Only an
  answer without an id (a network that did not say) falls back to the text, matched to the oldest message of ours
  there with the same text that no other copy took.
- **Before the answer.** On a slow link the message comes back on the socket before the answer to the POST, and both
  used to show until the answer came. Now the copy gives way as soon as its message is here: the hub says on the
  socket which message a send became (`sent`, with the send's `clientId`, not journaled) as soon as the network names
  it, and without that the page matches by itself, in send order, a copy that went to the hub to a message of ours
  that came on the socket after it, from the same account, with exactly its text and number of files, no other copy
  took. The copy is hidden, and its outbox entry kept, until the answer comes. If the answer is a failure but the
  message came, it went out: no failed copy is shown, and nothing is kept to retry. Only a refusal (4xx: the hub
  never handed it on) shows the copy again as failed. A copy whose message never comes keeps the 30 s rule.
- `pwa.ts` used to fetch `sw.js` on every return. It now checks when the hub process changed (the sync says which
  process answered), at most every 10 minutes on a return, and hourly.

## Keeping a connection open

**Decision: no persistent connection; the app resumes cheaply instead.**

- **The PWA cannot.** A browser freezes a page in the background (Chrome on Android within minutes, sooner with the
  screen off) and its sockets die with it. Nothing a page can do keeps one open, and a service worker cannot hold a
  WebSocket either.
- **The Android app could**, with a foreground service holding the socket (or the WebView kept un-paused). It would
  need a keepalive about every minute, each one waking the cellular radio for its tail time: roughly 0.3-10 Wh a day
  against a 15-19 Wh battery, plus a permanent notification (the estimate is in
  [android.md](android.md#why-not-a-socket-of-our-own)). For a chat app whose pushes already arrive through
  UnifiedPush, the only gain would be skipping the resume below, which now costs about a kilobyte.
- Calls already keep the app alive with their own foreground service while they last (android.md).

## Numbers

Measured from the same machine as the hub, so they show what the hub and the client do, not the tailnet. On a phone,
transfer time scales with the bytes. `scripts/measure-sync.ts` compares the two ways back: "full" is what every
reconnect did before (`/api/bootstrap`, `/api/inbox`, `/api/usage`, and the page of each open timeline), "delta" one
`POST /api/sync`. Medians of 5.

| Hub | Way back, nothing changed | On the wire | JSON | Hub time |
|---|---|---|---|---|
| Demo world (51 conversations), 3 open timelines | full | 24 KB | 128 KB | 4 ms |
| | delta | 0.4 KB | 0.4 KB | 1 ms |
| Copy of the real database (5,240 conversations, 96,000 messages), 1 open timeline | full | 796 KB | 5,100 KB | 430 ms |
| | delta | 0.2 KB | 0.2 KB | 2 ms |
| The same, 3 open timelines | full | 809 KB | 5,166 KB | 429 ms |
| | delta | 0.4 KB | 0.4 KB | 1 ms |

The copy has no adapters running, so nothing changes in it by itself. To see what a real absence costs, the
changes of a window before the copy was taken were marked in the copy's journal (every conversation with a message in
it, every message in it) and a client holding the 3 busiest conversations as they were before the window asked for
the delta. That over-counts: on the real hub, backfilled messages are not journaled.

| Away | Changed | Delta on the wire | JSON | Hub time | In it |
|---|---|---|---|---|---|
| 30 min | 43 conversations, 262 messages | 61 KB | 301 KB | 28 ms | 65 timeline messages, 253 inbox messages |
| 2 h | 103 conversations, 1,438 messages | 82 KB | 405 KB | 38 ms | 100, 300 |
| 8 h | 258 conversations, 8,415 messages | 114 KB | 542 KB | 83 ms | 122 (2 timelines replaced), 300 |
| 24 h | 423 conversations, 32,992 messages | 142 KB | 668 KB | 311 ms | 125 (2 replaced), 300 |

Against 809 KB every time before. Most of a longer delta is the inbox list, which is capped at its own size.

In headless Chromium at 4x CPU throttling against the copy: a full bootstrap took 385 ms from request to the data
being applied, 231 ms of it parsing and applying (and then the whole app rendered again); a resume after a 3.6 s drop
took 17 ms from the network coming back to the data being current, for a 332-byte answer. In `verify-sync.ts` on a demo
hub, a message sent while the browser was offline was on screen 100 ms after the network came back.

## Verifying

- `bun test packages/hub/test/sync.test.ts`
- `bun scripts/verify-sync.ts <demo hub> [--restart "<command that restarts it>"]`, in a browser: a short drop shows
  nothing and costs one delta; a message sent meanwhile appears from it; a long drop shows the notice and it goes; a
  send without the hub waits and goes out once; a cold start from the snapshot resumes with a delta; and a restarted
  hub is caught up from its journal.
- `bun scripts/verify-sends.ts <demo hub> --stop "<cmd>" --start "<cmd>"`: one send is one message after its echo,
  two identical sends stay two; with the answer to a send held back 3 s (the socket not), never two on screen, by the
  hub's `sent` event and by the page alone, for two identical quick sends too, and a 504 whose message came shows no
  failed copy; and a send made with the hub stopped survives a reload and goes out once when it is back. `bun test packages/web/test/outbox.test.ts` for the outbox and the matching.
- `bun scripts/measure-sync.ts <hub> [--open N]` for the table above.

## Limits

- An unclean stop makes every client start over once, by design.
- Restoring the hub's database from a backup taken while it ran starts a new epoch (the backup is "not closed"); one
  taken from a stopped hub keeps the epoch, and a client that saw positions past the backup then has a position the
  hub has not reached: refused while the hub is behind it, but a client whose position the restored hub has passed
  again could miss what happened in between. Restart the journal after such a restore
  (`DELETE FROM meta WHERE key = 'sync_epoch'`).
- Messages backfilled into the middle of a held range (older history arriving later) do not reach that timeline;
  they never did live either.
- A demo hub re-dates its world when it restarts, so its first delta after a restart is most of its state.
