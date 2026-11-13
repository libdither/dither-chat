# A writer thread for the hub? (2026-11-13)

The question: move every write the hub makes onto a thread of its own (a Worker with its own connection to
`hub.sqlite`), so the main thread only reads, works things out and sends. This is a write-up, not a change.

## What the hub's writes are

- **Many, and spread out.** 38 of the 92 files in `packages/hub/src` write: about 560 write statements, 496 `.run()`
  calls and 66 transactions. `store.ts` has 199 of those statements, `mail/store.ts` 63, `activity.ts` 27,
  `mail/ops.ts` 26, `attention.ts` 21 and `jobs.ts` 20. The rest are in devices, push, usage, the media archive,
  embeddings and others.
- **Mixed with reads.** Most writes sit in the middle of reads that decide them, in one synchronous function and often
  one transaction:
  - an ingest reads the row that is there, builds its view before and after, writes, and compares
    (`Store.message`, `placeSig`);
  - attention's fold reads its state, folds the new messages and writes it back;
  - triage reads a dozen things to decide, then writes the decision;
  - the journal reads its last position and writes the next.
- **Relied on being synchronous.** These assumptions all depend on one thread doing a write and what follows it with
  no gap:
  - an ingest's dirty marks feed the flush;
  - the flush's journal position must match what each device was sent;
  - attention's in-memory views must match its rows;
  - a held adapter event must keep its account's order (supervisor.ts);
  - a request that writes then answers with what it wrote (a send, a mark read, a rename) reads its own write.

## What it would take

- **A writer worker.** bun:sqlite works in a Worker (the checkpoint thread is one). A Database cannot be shared
  between threads, so the writer has a connection and prepared statements of its own, and the main thread sends it
  messages (structured clone) and waits for the answer.
- **Every write site becomes asynchronous, and so does every caller.** `Store.ingest` is synchronous and called from
  the supervisor, the flush is synchronous, and triage, attention and mail call the store synchronously throughout.
  Making them async means touching most of `store.ts`'s write half and all its callers, and the 1,300-odd hub tests
  that use a synchronous Store.
- **Logic moves with the writes.** A transaction that reads to decide what to write (most of the ingest) has to run
  whole on the writer, or it races with other writes. In practice the writer would become a second store: the ingest,
  the fold, triage's write path and the journal would move into it, with its own caches (self identities, signed
  links, typing). That is a split of `store.ts` (3,300 lines) along a line it was not written for.
- **Read-your-writes by hand.** In WAL mode the main connection sees a commit at its next read, so a request that
  writes must wait for the writer's answer before it reads. Every such path needs that await, and missing one gives a
  stale answer rather than an error.
- **Order across two queues.** Adapter events, requests and timers would each send writes; the writer would apply them
  in the order received, but the main thread's view of "what changed" (dirty marks, attention's views, the journal)
  would have to follow the writer's results, not its own calls. The journal would have to be the writer's.

## What it would buy, after synchronous = NORMAL

With NORMAL (2026-11-13) a commit no longer waits for the disk, so what a write costs the main thread is SQLite's own
CPU for the statement: B-tree updates, index upkeep, the message FTS trigger. The profile of the hub's holds on the
sealed copy with replayed traffic and a fresh browser (time sampled inside holds of 200 ms or more):

| time inside holds of 200 ms or more | FULL (main) | NORMAL (#146) and this change |
|---|---|---|
| holds, time sampled in them | 75, 30.1 s | 48, 10.5 s |
| SQLite reads | 74% | 83% |
| SQLite writes (statements and their commits) | 15% | 2% |
| JSON and compression | 5% | 3% |
| other JavaScript | 5% | 12% |
| of it, `GET /api/bootstrap` | 45% (41% its reads) | 86% (76% its reads) |

Both are the same six minutes of replayed traffic, with four devices on the live socket, the bootstrap polled every
5 s for four minutes and a fresh browser at four minutes, profiled. The NORMAL run was at a lower load (1.5–5 against
5–8). In the NORMAL run nothing held the hub for 500 ms or more; the longest was 0.32 s.

So a writer thread would take writes off the main thread, which are 2% of what still holds it, and leave the
reads, which are most of it, where they are.

## Risks

- Bugs that show as stale or out-of-order data rather than errors: a device sent a frame before the journal has it, a
  view built from the row before the write, a held event applied after a later one.
- A second thing that can stop: a writer that dies or falls behind takes every write with it. Its queue is in memory,
  so what is queued at a crash is lost unless it is journalled first.
- Twice the statement caches and twice the schema knowledge. Migrations and the startup copy have to run before
  either thread starts.
- A long change to the hub's core, while other work goes on in the same files.

## Alternatives

- **Fewer commits per message** (done: one per batch of adapter events, one per flush, one per triage decision).
  NORMAL makes each one cheap, so there is little left here.
- **Batch writes per tick** (a group commit). With NORMAL, a commit's cost is about the statement's own, so batching
  saves little more.
- **Move the slow readers instead.** The holds that are left are mostly reads, and a reader is far easier to move than
  a writer: it needs a read-only connection, its inputs, and nothing written back.
  - **The bootstrap** is the biggest. It is pure: it reads, builds JSON and compresses. It could be built in a worker
    with its own read-only connection, at the journal position it reports, and handed back as bytes.
  - Activity's 90-day reads and the five-minute rescore's reads could follow the ranker, which already rebuilds on a
    read-only connection of its own.
- **Keep slicing** the long work that is left (#107, #116, #132 and this change), and watch the stall log after each
  deploy.

## Recommendation

Not now. After NORMAL, writes are a small share of what still holds the hub (2% of the time in holds on the copy,
against 83% for reads). A writer thread would touch about 560 write statements in 38 files and break the one-thread
assumptions the journal, the flush and attention rely on, for that small share. Better next steps, in order:

1. Build the bootstrap in a reader worker (read-only connection, same bytes, same journal position).
2. Move activity's and the rescore's big reads to read-only connections, as the ranker's are.
3. Revisit a writer thread only if, after those, write statements lead the stall log's holds.
