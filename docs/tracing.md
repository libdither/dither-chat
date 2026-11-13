# Tracing: where the hub's time goes

The hub writes down every unit of work it does at a boundary (a request, a batch of adapter events, a command to an
adapter, a triage decision, a background job) as a **span**: its name, how long it took, its trace and parent, a few
attributes, and whether it failed. Every finished span is one line in `traces/hub.trace.ndjson` in the data directory,
and every hold of the event loop of 200 ms or more is one line in `traces/event-loop-stalls.ndjson`. Nothing is
chosen when it is written: the slow and the failed are found afterwards, by a query.

```sh
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat            # per span name, last hour
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --slow 20  # the slowest spans and their trace ids
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --trace <id>   # one trace as a tree
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --stalls   # holds of the event loop
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --errors   # errors by source, where and name
```

Other options: `--since 30m|6h|2d|all`, `--name <part of a name>`, `--failed`, `--top N`, `--json`. It reads the files
directly, so it works while the hub is stuck or stopped.

## Why (2026-11-12)

The first real group made from the app (Discord) took 6.4 s to come back, while Discord itself had made and named the
group within 0.4 s of the hub accepting the request. The hub's log has no times, its stall log only logs holds of 2 s
or more after its first ten minutes, and nothing records where a request spends its time between the hub, the
accounts manager, the adapter and Discord. The 6 s could not be placed. The plan follows what T3 Code does
(its docs/operations/observability.md): always write every span locally, rotate by size, and query later; keep an
always-on event-loop monitor in a file of its own; export to OpenTelemetry only if wanted.

Logging only what is slower than expected was the other option. It needs an expectation per kind of work, which is a
baseline the hub would have to keep anyway, and it loses the fast cases that a slow case is compared against. Writing
everything costs about 200 bytes a span and a write a second.

## What is in it

**Spans** (`packages/hub/src/trace.ts`). `span(name, attrs, fn)` runs `fn` as a span: sync or async, its result
unchanged, a throw or rejection marks it failed and is passed on. The parent is carried by AsyncLocalStorage, so a span
started inside another, across awaits, is its child. `currentSpan().set({...})` and `.event('name')` add to the span the
code is in; `startSpan` is for work that is not one function (the 80 ms flush, which is dropped when it sent nothing).
Every span also notes itself for the stall log (`noteWork`), so the stall log names what it named before.

With no sink set (tests, scripts, `DITHER_TRACE=0`) a span is a function call: nothing is kept, no context is carried.

| Span | Where | Attributes |
|---|---|---|
| `GET /api/conversations/:id/messages` and every other request | server.ts `guarded` | `http.method`, `http.route` (the path without ids), `http.status`; failed at 500 and up. A `traceparent` header joins its trace. It ends when the response starts, so a streamed body is not in it |
| `adapter events` | remote.ts, each batch from the manager | `account`, `events`, `kinds` (`message×3,typing`) |
| `adapter event <t>` | supervisor.ts, each event from a local adapter | `account` |
| `command <op>` | remote.ts (through the manager) and supervisor.ts (local) | `account`, `op`, `via` |
| `triage` | main.ts, each message decided | `decision`, `unjudged` |
| `flush` | server.ts, when it had events to send | `events` |
| a sliced job (`embeddings refit`, `activity features` inside a `triage`) | slices.ts `sliced` | `slices`, `busyMs` (the slices' time on the thread in all) |
| `upkeep`, `categories`, `votes and held alerts`, `notifications: read and requests`, `attention: first scoring`, `attention: rescore all` | main.ts timers | |

Making a group adds `network`, `people`, `named`, then `added`, `invited`, `failed`, and the events `paced` and
`adapter answered`, to its `POST /api/groups` span, whose child is `command createGroup`.

**Attributes are never content.** Ids, counts, kinds, statuses and route shapes only: no message text, no names, no
group names, nothing a person wrote. The files are in the data directory, private to the hub's user, like the database.

**The stall record** (`stalls.ts`). Every hold of 200 ms or more, at any time (the log line keeps its old rule: 200 ms
for ten minutes after a start, then 2 s), goes to `event-loop-stalls.ndjson` with:

- `work`: what noted itself in the hold, as the log line says;
- `spans`: the spans still open, or that finished in the hold, with their trace ids (up to 8);
- what the process did from the tick before the hold to its end: CPU time (`cpuUserMs`, `cpuSystemMs`), page faults
  (`minorFaults`, `majorFaults`) and context switches. CPU near the hold's length is JavaScript work; little CPU is a
  wait (a synchronous write waiting for the disk, memory being paged in). The counters are the whole process's, so
  Bun's own threads count too. `--stalls` labels each hold `cpu`, `waiting` or `mixed` by that.

**Files** (`NdjsonFile`). Batched (written every second, or at 256 KB), rotated by size: the trace at 10 MB keeping
10 older files (`hub.trace.ndjson.1` is the newest of them), the stall file at 2 MB keeping 3. A failed write is
reported once and its batch dropped; tracing never stops the hub. `DITHER_TRACE=0` (or `--trace 0`) turns both off.

**The record** follows OpenTelemetry's span where it can (`traceId`, `spanId`, `parentSpanId`, W3C `traceparent`),
so an exporter can be added later without changing what the hub records.

## Reading it after a deploy

```sh
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --since 15m          # what the start cost
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --stalls --since 15m # and what held it
```

For a slow request: `--slow` or `--name 'POST /api/groups'` gives its trace id; `--trace <id>` shows its children
(the command to the adapter and when it answered); `--stalls` over the same minutes shows whether the hub's thread was
held while it waited, and by which spans.

## Across processes: the manager and the adapters

A command to an account the manager runs carries its span's `traceparent` (the `call` message's `trace` field, in
dither-accounts' client and spec; a client before it leaves it out). In dither-accounts:

- the manager's span for the call, `call <op>` (attributes `app`, `account`, `op`, and `outcome` when it fails), is a
  child of the hub's `command <op>`, with the events `to the extractor` and `the extractor answered`;
- the extractor gets the call's own traceparent with the command (`trace`; the shared link drops it from an op's input);
- the Discord extractor's span, `discord <op>`, is a child of the manager's: `paced` (how long it waited for its turn in
  the pace queue) and, for making a group, the hook's phases as events (`hook: friends checked`, `hook: group made`,
  `hook: group in the store`, `hook: named`, then `hook answered`). It goes up as a `log` event whose msg is `trace`,
  which the manager writes into its trace rather than the adapter's log;
- the manager writes `<its data>/traces/manager.trace.ndjson` and its own `event-loop-stalls.ndjson`
  (`DITHER_ACCOUNTS_TRACE=0` turns them off).

`scripts/trace-summary.ts` reads the manager's traces directory beside the hub's (`--accounts-data`, else
`$DITHER_ACCOUNTS_DATA`, else `~/.local/share/dither-accounts`), so `--trace <id>` shows one request from the hub
through the manager to Discord's client, and `--stalls` labels each hold with the process it held.

## Errors

Every real error, the hub's and the page's, is one line of `traces/errors.ndjson` in the data directory
(`packages/hub/src/errors.ts`), rotated by size like the trace (5 MB, keeping 5 older files). It is off with the trace
(`DITHER_TRACE=0`).

**This format is a contract**, read by dither-accounts' bugwatch extractor (kind `bugwatch`): it groups the lines by
fingerprint, raises a notice in dither-chat for each new bug and starts a thread to fix it. Fields may be added, as
optional ones; none is renamed or dropped.

```
{ "v": 1,
  "at": 1763000000000,            // ms epoch
  "app": "hub" | "web",
  "source": "uncaught" | "rejection" | "request" | "job" | "attempt" | "client",
  "where": "POST /api/accounts/:id/action",   // route TEMPLATE (ids replaced by :id), span or job name, or the web page's route template
  "name": "SQLiteError",          // error class / name
  "message": "database is locked",// one line, at most 300 chars, from the Error only
  "stack": ["at fn (packages/hub/src/x.ts:12:3)", ...],  // at most 10 frames, paths relative to the repo root (web: bundle file names as they are)
  "status": 502,                  // optional: the HTTP status answered or received
  "trace": "…",                   // optional: the trace id, so `bun scripts/trace-summary.ts` can show the trace
  "version": "29d2d7ac",          // optional: the running build's git short sha, when known
  "extra": { "account": "acc_…", "network": "discord" },   // optional, ids and short words only
  "count": 3 }                    // optional: occurrences folded into this line (see dedup)
```

`count`, when present, is how many occurrences the line stands for; absent means one. `version` is `DITHER_VERSION`,
else the checkout's `git rev-parse --short=8 HEAD`, for the hub; the page's is its build's (vite's `__BUILD_SHA__`).

**Sources**, all through `reportError()`:

| source | what | where |
|---|---|---|
| `uncaught`, `rejection` | `process.on('uncaughtException' / 'unhandledRejection')` in main.ts; the hub keeps running, and the console line stays | `process` |
| `request` | a request answered with 5xx (server.ts `guarded`): a throw in a handler (500), or a 500/502 the handler answered, its message the answer's `error` | method and route template, `GET /api/conversations/:id/messages` |
| `job` | a span a throw ended (trace.ts's hook, but for requests and `command <op>` spans: a command's caller says what came of it); the hub's `console.error` / `console.warn` sites that mean something went wrong: triage, upkeep, push, flush, attention, the ranker, embeddings, categorizing, backups, checkpoints, adapter events that failed or met a locked database, the manager's admin calls, mail's sync/outbox/ops/classify/people/triage, notices, jobs (but rate limits) | the span's or the job's name: `triage`, `flush: mail`, `adapter events`, `mail: changes` |
| `attempt` | attempts.ts: making a group or adding people failed (500, 502, 504), or went through with someone refused (`name` `Partial`); a candidates lookup that failed. The hub.log lines stay | `groups: create`, `members: add`, `groups: candidates`, `members: candidates`; `extra` { what, account, network, conversation, people, failed } |
| `client` (app `web`) | `POST /api/errors` from the page (packages/web/src/errors.ts): `window.onerror`, `unhandledrejection`, and `api()` answers of 5xx and fetches that did not reach the hub | the page's route template, `#/inbox/c/:id` |

**Left out:** 4xx answers, 429 and rate limits, captchas and terms prompts (refusals, 4xx), aborted requests and a
client that went away, 503 (an account offline, the manager not reachable: states the page shows) and 504 (timeouts
the page explains; an attempt's 504 is still an `attempt` line), the hub stopping under a job (a closed database),
adapters' own log lines, and the page's reports while it is offline. When unsure, it is reported: the watcher has an
ignore list.

**Storms.** The same (source, where, name, message) is written at most once per 10 s; the occurrences in between are
folded into the `count` of the next line written for it (a sweep every 10 s writes the folded ones whose window ended).
One Error object reported twice (thrown through a span, then caught and logged) is one line, and a request's 5xx is
not a second line when something inside it was reported already (an attempt). The file takes at most 600 lines per
10 min; hub.log says when the cap starts dropping (`errors: over the cap …`) and how many it dropped once the window
ends.

**The page** sends `POST /api/errors` with `{ name, message, stack, where, status?, version }` and `keepalive`,
at most 20 reports a minute and the same one at most once a minute, never while offline, never throwing. The hub
answers 204, 400 for a body that is not a report (a `where` that is not a route template, `#` or `/` then words, `:`
and `/`), 413 over 16 KB, and 429 past 60 a minute from one address; it is authorised like every owner route (this
machine or the tailnet, the page's own origin).

**Privacy.** `message` is only ever an Error's message, one line of at most 300 characters. `where` is a template, never
an id, a name, search text or a query string; stacks are code locations with the hub's address taken off; `extra` is ids
and counts. No message content, drafts, names, request bodies or query strings.

```sh
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --errors --since 6h      # occurrences by source, where, name
bun scripts/trace-summary.ts --data ~/.local/share/dither-chat --errors --name groups   # where containing "groups"
```

## Next

1. **The page.** `api()` sends a `traceparent` for actions a person waits on (making a group, sending, opening a
   chat), so the hub's span joins the page's trace, and the page reports its own span (click to drawn) to the hub,
   which writes it with the rest. T3 Code does this through its server.
2. **The failure watcher** reads `traces/errors.ndjson` (above) instead of matching lines of `hub.log`: dither-accounts'
   bugwatch extractor.
3. **More of the adapters' phases**, as the Discord hook's group making has them, where a command is slow.
4. **OpenTelemetry export**, only if a Grafana stack is ever run: an OTLP exporter beside the file, off by default.
