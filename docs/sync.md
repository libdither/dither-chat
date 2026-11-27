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
  `attention` (the inbox score of a conversation), `usage` (`kind:id` of a place), `presence` (an identity's status
  dot, docs/profile.md), and the lists kept whole, under id
  `*`: `folders`, `placePrefs`, `categories`, `rules`, `arrange`, and `attention:*` / `usage:*` for "all of them".
  Typing, notifications (and `cleared`, which closes them) and mark-all-read progress are of the moment and not kept.
- **Epoch**: a random id for the journal. Every position belongs to one; a position from another epoch is void.
  The epoch changes when the journal cannot vouch for what happened: the hub did not stop cleanly last time (a crash
  or a kill can lose the last 80 ms of changes, which were in the database but not yet in a frame), the demo world was
  reset, or the database is new. A clean stop flushes and marks the journal closed (`main.ts`).
- **A write that fails** (a full disk, a file that will not open): the frame still goes out to every connected device,
  with no position, and its changes are held in memory and go in with the next frame that is written, at that frame's
  position. No position is handed out for them, so a client resuming from before has missed nothing. A flush whose own
  transaction fails takes back what the journal thought it wrote (`mark`/`undo`). A clean stop with changes still held
  leaves the journal open, so the next start is a new epoch.
- **Floor**: rows older than 14 days, or beyond the newest 250,000, are dropped hourly. The newest dropped position is
  the floor; a client from before it starts over.
- **Version**: `SYNC_VERSION` in `packages/protocol`. A client of another version starts over.
- `/api/bootstrap` carries `sync: { v, epoch, seq }`, read after a flush so it covers what the bootstrap shows.

Attention scores live in memory and are worked out again at every start, so a start journals `attention:*`, and a
client from before it gets the whole list once.

## `POST /api/sync` (`packages/hub/src/sync.ts`)

```
{ v, epoch, since, timelines: [{ key: 'c:<conversation>' | 'p:<person>' | 'k:<channel>', seq, newest, oldest, newer?, conversationIds? }] }
```

The answer is either `{ full: true, reason }` (another version, another epoch, older than the floor, or ahead of the
journal, as after restoring an older database) or:

- `events`: the live socket's own events for everything changed after `since`, read as it is now: `account`,
  `identity`, `person`, `space` (with its edges), `conversation`, the `*.removed` ones, `folders`, `placePrefs`,
  `categories`, `rules`, `attention`, `usage`, `arrange`. The client applies them exactly as it applies live frames.
- `inbox`: triaged, on the list or above (not silent, not below the list), last 7 days, changed since (at most 300,
  which is the inbox's own size).
- `timelines`: for each one the client holds, the messages after its newest, and the ones it holds (between `oldest`
  and `newest`) that changed since its `seq`: edits, deletions, reactions, triage, forwards. When there are more than
  a page (60) of new ones, when the timeline's `seq` is older than the floor, or when a person timeline now spans
  other conversations (people merged or split), or when a message moved out of it since (a Zulip topic renamed or
  moved: the journal keeps a `movedOut` row for the conversation it left), it gets `replace: true` and the newest page
  instead. A client open at the time drops the moved message from the old timeline as the live event comes. A
  channel's stream (`k:<channel>`, docs/threads.md "The channel stream") spans the channel and its threads as they are
  now: a thread new since needs no fresh page (its messages are newer than the held ones, or come as changes), and its
  answer says the conversations it spans (`conversationIds`).
- `selfPersonId`, `categoryProvider`, and `reactionUsage` (only when messages changed), the identities the messages
  name, and the messages their replies quote.

Without `since`, only the timelines: that is how a conversation kept in the snapshot catches up when it is opened.

### On the socket

The same answer, without timelines, can come as the live socket's first frame, so a socket that opens is already
caught up, with no request after it and no round trip more. The client asks for it on the socket's URL,
`/api/live?v=<v>&epoch=<epoch>&since=<seq>`, offering the subprotocols `dither-live` and `dither-resume`
(`LIVE_PROTOCOL`, `LIVE_RESUME` in `packages/protocol`). A hub that can answers `dither-resume`, and when the socket
opens, in one task: flushes, reads the answer for that position (`{ resume: <the answer> }`, or `{ resume: null }` if
it failed), sends it, and only then adds the socket to the ones it broadcasts to. Every frame after it is newer, so
nothing falls between the answer and the live frames and nothing comes twice, which a POST cannot promise: its answer
and the socket's frames come over different connections. An answer over 2 KB goes gzip'd as a binary frame, as the
POST's answer goes compressed; the client reads it with `DecompressionStream`, and one without it never asks.

An older hub takes the first subprotocol offered (Bun does that by itself) or none, and sends nothing of the kind; an
older client never asks. Either way the catch-up is the POST, as before.

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
- **On the socket** ([above](#on-the-socket)): a socket the app opens after a drop asks from its copy's position, and
  `index.html`'s from the stored snapshot's, which `snapshot.ts` keeps in `localStorage` (`dither-chat:sync-from`)
  once the snapshot is written, never before. The app uses the answer only for a copy at that position or past it in
  the same journal, and only if the answer is not older than the copy; anything else, or no answer within the wait
  after which a POST would be asked again (below, [A bad link](#a-bad-link)), and it asks by POST as before. Held
  timelines are not in it: they are asked for by POST beside it, and the frames that come meanwhile are held until
  both are in. A relaunch over a slow link has the hub's data a round trip sooner (docs/perf.md). A spare socket racing
  a late pong never asks: the old socket's frames could be newer than its answer.
- **Before the app's script**: `index.html` opens the live socket itself, so it is open by the time the app's script
  has come (seconds on a slow link), and `connect` takes it over with the frames it got meanwhile, which are held as
  any others. On a device that keeps no snapshot (it looks in IndexedDB for one, without making the database), it
  also asks for the bootstrap once that socket is open: the same order as the app's own, socket first, so nothing
  that happens in between is missed, and the bootstrap no longer waits for the script, the snapshot read and a second
  handshake. The app reads that answer as its own; a snapshot found after all, or the socket replaced before the
  answer was read, gives it up.
- **Timelines**: held ones are caught up in the same request (beside the socket's answer, in a request of their own); a kept page ([below](#kept-pages)) catches up from its
  own position when opened. A pull to refresh still reloads everything.
- **Heartbeat**: a `ping` text frame every 25 s while in sight, and at once on `visibilitychange`, `focus`, `online`
  and `pageshow`. Without a `pong` within 3 s a new socket races it: if the new one opens first, the old one was dead
  and the new one takes its place at once, with nothing shown, rather than waiting for TCP to notice a socket that
  died while the phone slept; if the pong comes first, the link was only busy and the new one is closed. A new socket
  refused, or neither within 5 s more, and the socket is dropped ([A bad link](#a-bad-link)).
- **Quiet**: no banner for a drop. Only when the hub has not answered for 4 s, counted from the unanswered ping (or
  later, once the race above is lost: up to 8 s on a link that swallows everything without a word), or at once when a
  send is waiting, the rail's logo becomes the loader's sphere turning slowly in amber (on a phone page
  that covers the rail, a small one at the start of the page header's buttons), the row over the message box ends
  with "Offline · sends when the hub is back" ("Offline · sends later" on a phone, and only "Offline" where the route
  beside it leaves no room for more), and the top of a timeline says "Older messages load when the hub is
  back" instead of spinning; those pages are asked for once it is. A tap on the orb says since when, and its Try now
  opens a new socket at once rather than at the end of the backoff (`ui/Offline.tsx`). Nothing covers anything, and
  all of it goes the moment the hub answers. The inbox says it too ([below](#what-the-inbox-says)), and its list goes
  a shade quieter. The loading screen is only for a first start with nothing kept.
- **Sends** go to the hub's queue for their chat ([The send queue](#the-send-queue)), which answers as soon as it
  has them. Until then a send is kept on the device (IndexedDB, with its files, `outbox.ts`), marked with a clock:
  without the hub it waits ("On this device: goes to the hub when it is back") and goes after the sync on
  reconnecting; after a reload or the system closing the app it is shown again and goes the same way. Each carries a
  `clientId` the hub keeps for good, so sending it again is always safe: a repeat is answered with the row the first
  one made, never sent twice. A device copy is never in doubt for that reason; only the hub can say a send may have
  gone out. One the hub refused (a 4xx: nothing went out) stays, with the reason, to try again or discard. A device
  sends one chat's copies one after the other, in the order they were written. Its files upload as they are attached,
  a piece at a time ([uploads.md](uploads.md)): a send waits for the ones still uploading, an upload carries on after
  a reload, and the hub keeps them across its own restart.
- **The hub's rows** (bootstrap `sends`, the `sends` event): every device shows the same rows of a chat's queue under
  its last message once the hub has them, with one tick, two once the network named the message it became, until
  that message is here (or 30 s, for a network that never echoes it; the chat is drawn again then). A row still being
  sent, or sent by a network that named no message, is not shown once a message of yours with its text came after you
  pressed Send: that is its echo, come before the account's answer. The device copy goes as soon as the hub's row
  is there. A device copy waits behind an older one of its chat that could not reach the hub, so the hub takes them
  in the order they were written. The hub's row carries `messageId`, the hub id of the message the network says it sent (ids are derived
  from the network's, so it is known before the message is stored).
- **Restarts**: a hub that is stopping (SIGTERM, which is how the deployer restarts it) says so to every socket first,
  `{ t: 'stopping', usualMs }`, not journaled, and keeps when it stopped in its data dir (`restarts.json`,
  `packages/hub/src/restarts.ts`); the next start counts the time from that stop to answering, and `usualMs` is the
  middle of the last seven. The app then calls it a restart, not a lost link: no offline notice, a try every second
  instead of the backoff, and "Hub restarting, back in about 9 s" beside "Inbox". Once caught up it says "Hub
  updated" when the hub runs other code than before (`build`, its git commit, in the bootstrap and each sync answer),
  or "Hub restarted". A restart not back within two minutes (or four usual ones) is the hub out of reach as any other.
- `pwa.ts` used to fetch `sw.js` on every return. It now checks when the hub process changed (the sync says which
  process answered), at most every 10 minutes on a return, and hourly.

### The send queue

The hub keeps each chat's sends in a queue (`packages/hub/src/sendqueue.ts`, table `send_queue`, protocol
`sendqueue.ts`) and sends them one at a time, in order. Why: a send handed to an account that stopped answering may be
out or not, and the hub used to keep only 15 minutes of answers in memory, so a restart forgot what it had sent and a
retry could send twice. And a message written to a chat that has moved on while it waited (on a slow link, or behind
a slow send) can land after what made it wrong.

- **One row per send**, under its `clientId` (the hub makes one, `hub-…`, for a caller that gives none), kept for
  good. It holds the chat, the account, the body and every field `POST /send` takes (reply, files, sticker, voice,
  GIF, view once, silent, ping on reply), what the sender could see (`seen_ts`, `seen_id`), when Send was pressed,
  and its state, error, tries, why it is held and the countdown's end.
- **`POST /api/conversations/:id/send`** writes the row in one transaction. With `ack: 'hub'` (the app) it answers at
  once with the row (`SendAccepted`, 200). Without it (the notification reply in the browser and the Android app,
  older callers) the answer comes after the network's, as before: 200 with `messageId`, a refusal's status, 504
  `SendUnsure`, or 202 with the row when it is held or waits behind one that is. Those callers say "Reply waiting"
  themselves on a 202, so the hub sends no "is waiting" notification of its own for their rows. A repeat of a
  `clientId` is answered with the row as it is now and never sends again by itself, a `failed` one too: that goes
  again only when you press Try again (`POST /api/sends/:clientId` `{ action: 'send' }`), since an error the hub cannot
  read may hide a send that went out. A send refused at once (no account, the account not allowed there, empty, an
  upload gone) makes no row.
- **One worker per chat** sends only the head of its queue. A held or in-doubt head blocks the rows behind it; a
  failed one does not (the account refused it). The account's own call and its timeouts are as before: the network's answer
  makes it `sent`, a refusal `failed`, an unknown outcome (`outcome.ts unknownOutcome`: its adapter timed out or
  dropped mid-command; the accounts manager's client gave up waiting, its connection dropped mid-call, or it was
  closed with the call waiting; the manager gave up on the account or lost it while it had the call) `unsure`.
- **A restart**: rows left `sending` become `unsure` ("The hub restarted while sending it"), and `queued` rows go
  again. An answer the account gives while the hub is stopping is kept, so a send that went out is not put in doubt.
- Every change goes out on the socket (the `sends` event: the open rows, and those sent in the last 2 minutes, with
  the hub's clock) and is journaled (list `sends`). The bootstrap, and every sync answer while there are rows, carry
  the list whether or not it changed: a restart puts rows in doubt before any socket is open, and a page's kept
  copy holds no rows, so a page back from either has them as they are now. (A deleted chat takes its rows with it;
  a page draws none for a chat that is gone.)

| State | Mark | Means | What you can do |
|---|---|---|---|
| (device copy) | clock | only this device has it; goes when the hub is reachable | wait; Discard if it was refused |
| `queued` | one tick | the hub has it; goes when the ones before it in the chat are through | |
| `sending` | one tick | handed to the account now | |
| `sent` | two ticks | the network named the message it became | then the message's own receipts |
| `held` | pause | the chat moved on while it waited | Send, Edit, Cancel; a countdown while watched |
| `unsure` | alert | in doubt: handed on, no answer said whether it went | Send again, Discard |
| `failed` | alert | refused; goes again only when you say | Try again, Discard |
| `cancelled` | (gone) | taken back before it went | |

A queued row behind a held or in-doubt one says "The hub has it · waiting on the message above".

**Held when the chat moved on.** The app sends `seenUpTo` (the id and time of the newest message the chat showed when
Send was pressed) with each send; a reply from a notification sends the id of the message it answers, and the hub
takes its time. At accept and again right before sending, the hub looks for messages in the chat after that one: newer
by time, and stored after it (a demo world re-dated at start, or a message given a later time, is not news). Expected
are only the messages this device's earlier sends in the queue became (by `messageId`, or by text for a row whose
network named no message). Everything else counts: someone else's message, your own from another device or from the
network's own app, and another dither-chat device's send through the hub. No grace time and no age rule. A send without
`seenUpTo` is never held. A held send says "N new messages came in since you wrote this", those messages are marked
with a bar at their side, and it has:

- **Send**: it goes as it is (and is not checked again).
- **Edit**: it is cancelled and its text goes back into the box, after what is there; its files do not (a tooltip says
  so), so attach them again.
- **Cancel**.

**The countdown.** While any device shows the chat (a computer or a phone: the `watching` the app says on its socket
every 30 s), a held send counts down and goes by itself at the end, by the hub's clock (`holdUntil`). When no device
shows it any more, the countdown stops, nothing goes, and you are told once: a notification "Your message to … is
waiting" (the hub's push, under quiet hours' rules), and the row in the chat says "It waits for you". It survives a
restart, starting again from the start: a device that comes back by its end sees it go, and nobody is told that it
waits before then. Settings → Sending sets its length
(`GET`/`PUT /api/send-settings`, kept on the hub): 0 to 120 seconds, default 10; 0 means no countdown, it always waits
for you.

**Not covered yet:** the account (dither-accounts) does not take the `clientId` as its own idempotency key, so an
`unsure` row is still the person's call; send later and Forward do not go through the queue; two tabs of the same
browser each keep their own device copy until the hub has it.

## What the inbox says

What the app is doing with the hub goes in the room the "Inbox" title leaves (`ui/InboxStatus.tsx`, its words in
`statusline.ts`), never a bar over the list or a screen in the way, and nothing at all while all is well:

| When | It says |
|---|---|
| A catch-up taking longer than 180 ms (on a relaunch it rarely does) | a small turning orb, "Catching up…", then "14 new · up to date" or "Up to date" for 1.6 s |
| The hub out of reach (the notice above) | the logo's amber orb, "Offline", "since 6:01 PM · next try 3 s" (or "saved 6:01 PM" before this page ever reached the hub); a tap tries at once. Short of room (a phone's list beside a page) "since" goes, and the rail's orb still tells it |
| The hub restarting ([above](#the-client-packageswebsrcstatets)) | "Hub restarting", "back in about 9 s" (or the seconds so far, before it knows a usual time), then "Hub updated" or "Hub restarted · up to date" |
| A new version of the app, reloaded from its pill | "New version · up to date" once caught up |

A first start with nothing kept is the loading screen: its orb fills from the bottom as the bootstrap's bytes come
(the hub says the unpacked size in `x-uncompressed-length`, `compress.ts`), "Downloading your inbox · 1.2 of 4.0 MB",
then runs to full while the page sets the inbox up, a step with no bytes to count: a sixth to a quarter of the wait
on a slow phone link. That part is a CSS transition the compositor plays (`firstload.ts`), as setting the list up holds
the page for up to a second at a time.

## Opening a chat

What this device kept shows at once (memory, a page fetched ahead, a kept page); a 2 px line along the foot of the row
over the message box fills while the rest comes (`ui/OpenBar.tsx`, `waits.ts`), in steps: reaching the hub, the hub's
page (or what changed since the kept copy), and, for Discord and the networks the hub asks for the latest on open, the
network's answer. What the hub stored shows while the network is asked. Each step's share of the line is its usual
time on this device (the middle of its last 15, by network for the network's step); within a step the line slows as
it nears the step's end and never claims it done. Nothing shows for the first 180 ms, which is most opens; past 1.5 s
the row says which step it waits on, "Waiting on your hub · 2 s" or "Waiting on Discord · 4 s", and once a step is
three times its usual time (and 2 s), in amber with "usually 0.4 s". Nothing spins in the timeline for an open (older
messages still have their small orb at the top). Out of reach of the hub, none of it: the row says "Offline" already.

`scripts/verify-loading.ts` checks all of this in headless Chromium against a demo hub it slows, restarts and stops.

## A bad link

Taking the network away and giving it back (verify-sync.ts, verify-offline.ts) is the easy case: every request fails at
once. A phone meets worse: a connection that stays open and carries nothing (it slept, it switched networks, a NAT
forgot the mapping), requests that hang rather than fail, a link that drops every few seconds, and a slow link full of a
download. `scripts/verify-link.ts` puts a TCP proxy between the page and a demo hub (`scripts/link-proxy.ts`) that can
silence one connection or all of them, hang a request, cut everything, or shape the hub's bytes through one queue at a
rate, and drives the app's clocks itself (the heartbeat's interval and the catch-up's quiet timeout are held; a probe is
a `focus` event). What it found, and what the app does now (times are real, from one run on a laptop):

| Case | Before | Now |
|---|---|---|
| The live socket goes silent | found by the next probe; a new socket 3.0 s after it, one delta, no notice | the same |
| `POST /api/sync` hangs, the socket answers | stuck for good: frames held and never applied, a send's copy never cleared, every later catch-up queued behind it | given up after 20 s with nothing coming, the held frames applied, a new socket and one delta 1 s later |
| Every open connection dies, new ones work (a phone waking) | the catch-up after the new socket could go onto one of the browser's dead idle connections and wait until that closed (here never; on a phone, TCP's timeout of many minutes) | the catch-up asked again on another connection after 1 s; caught up 3 to 4 s after the probe |
| Every connection cut as soon as the socket is back, 6 times, a send in the middle | one socket per cut, about 1 s apart; the send stored once, nothing shown twice | the same |
| 1.5 Mbit/s with a router's queue of 1 s, filled by a download, then a probe | pong after 1.0 s, kept | the same |
| The same with a queue of 4 s (common on mobile networks) | pong after 4 s, past the 3 s wait: a healthy socket dropped, and its replacement's handshake waits behind the same queue | the race's new socket waits behind the queue too; the pong comes first and the socket stays, no notice |

So:

- **The catch-up and the bootstrap give up** (`hubFetch` in `api.ts`): after 20 s with nothing coming (no answer yet,
  or no more of a long one: a big bootstrap on a slow link keeps going as long as bytes do), and at once when the socket
  they were for is found dead or replaced. Given up is no answer, like a fetch that could not connect: on the socket in
  use, that socket goes and a new one after the backoff asks again; one already replaced has its own catch-up queued.
- **The catch-up is asked again alongside** (`hedged` in `api.ts`) when no answer has begun after 4 times the round
  trip the socket took to open (at least 1 s), up to 8 tries, two waiting at most (the older given up, which closes its
  connection). After a phone sleeps, the browser keeps its idle connections to the hub and puts the next request on one;
  a dead one swallows it without a word. Each try takes another connection. On a link that is only slow the first try
  answers first and the rest are given up; the hub answers a catch-up from the journal, so asking twice costs nothing
  else.
- **Sends** are given up with their socket too, and go again under the same `clientId` after the next catch-up:
  the hub answers a repeat with the row the first made ([The send queue](#the-send-queue)). A send has no quiet
  timeout of its own: the hub's queue waits for the network for up to 3 minutes with files, and makes the row
  `unsure` itself.
- **A late pong is not a dead socket**: the race described under Heartbeat above. A fixed wait cannot tell a socket
  that is dead from one whose pong is behind 4 s of someone else's bytes; a new socket asked for at the same moment
  can, because it waits in the same queue.

Not covered: a link that loses packets without closing anything (TCP retransmits, which the shaping cannot show), and
uploads over a flapping link ([uploads.md](uploads.md) has their own retries).

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

## Kept pages

The newest 40 messages of each conversation (or person's chat) opened most recently, or fetched ahead
([perf.md](perf.md#fetching-ahead-and-kept-pages-2026-11-11)), are kept on the device, a record
each in IndexedDB beside the snapshot (`packages/web/src/keptpages.ts`, store `pages` of the `dither-chat` database),
with the journal position they are current to, the people they name and the messages their replies quote. Opening one
shows them at once, before the hub has answered, after a start or while the hub is restarting or out of reach; then
`POST /api/sync` with that position brings it up to date: messages after the newest, and edits, deletions and
reactions inside it. A page too far behind (more than a page new, or a position older than the journal or of another
epoch) is replaced by the hub's newest page; when the hub cannot say at all, the page is fetched and kept messages the
hub no longer has in its range go. A catch-up that got no answer while the socket stayed up is tried again by itself
(2 s, then twice as long each time, up to 30 s), unless a reconnect's sync caught it up first.

- **Bounds**: 60 pages and 3 million characters of JSON, the least recently used going first. 60 kept served 80% of
  a week's opens from the device in a replay, 40 77.5%, the 12 of before 60.5% (perf.md).
- **Writes**: a page is written only when its messages changed (a new one, an edit, a reaction: the client replaces
  the message object), the conversations a person's chat spans changed, or its position's epoch did. The live socket
  moving the position along is not a change: the page keeps its older position, which is still right (catching up
  from it asks for a little more). One loading, a window around an old message, or one never opened or fetched ahead
  (a page fetched ahead) is not written.
- **Reads**: at start every record is read as text in the snapshot's transaction, and a page is parsed only when it
  is opened. Who wrote it and what it quotes go into the client's state then, where it holds no copies of its own.
- **Removal**: a conversation or person the hub removes (an account removed takes what only it saw) takes its page
  along, and every save drops the pages of conversations the hub no longer lists. A start that cannot render the
  snapshot drops all of them.
- Before 2026-11-11 the snapshot's rest held the 12 most recently opened timelines. A build with the page store
  reads those once as kept pages and writes them as records; an older build cannot open the database (version 2) and
  starts from the hub.

`test/sync.test.ts` keeps pages through the whole list of changes above, at the start and after the edits at the
position from before them, and checks each one caught up from where it was kept is the hub's page.

## Verifying

- `bun test packages/hub/test/sync.test.ts`
- `bun scripts/verify-sync.ts <demo hub> [--restart "<command that restarts it>"]`, in a browser: a short drop shows
  nothing and costs one delta; a message sent meanwhile appears from it; a long drop shows the notice and it goes; a
  send without the hub waits and goes out once; a cold start from the snapshot resumes with a delta; pages opened before
  it are kept, open without the hub at once, and are caught up with a delta when it is back; and a restarted hub is
  caught up from its journal.
- `bun scripts/verify-sends.ts <demo hub> --stop "<cmd>" --start "<cmd>"`: the hub answers a send with its row at
  once, and the row names the message; one send is one message, two identical sends stay two; with the answers held
  back on a slow link, never two on screen; and a send made with the hub stopped survives a reload and goes out once
  when it is back. `bun test packages/hub/test/sendqueue.test.ts` for [the send queue](#the-send-queue) (order behind a
  slow send, repeats across a restart, a restart mid-send, blocking heads, holds, the countdown under a fake clock,
  older callers); `bun test packages/hub/test/hardening.test.ts` for each way an outcome is lost (504 `unsure`, never
  sent twice); `bun test packages/web/test/sendrows.test.ts packages/web/test/outbox.test.ts` for the marks, the
  handover from device copy to hub row, the held line and its countdown, and what a failed POST becomes.
- `bun scripts/measure-sync.ts <hub> [--open N]` for the table above.
- `bun scripts/verify-link.ts` for [a bad link](#a-bad-link): starts its own demo hub and proxy, and prints the numbers
  in that section's table. `bun test packages/web/test/hedged.test.ts` for giving up and asking again.

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
