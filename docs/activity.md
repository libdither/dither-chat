# The activity log: what you open, how you got there, and what notifications led to

Triage decides per message whether to push, digest or stay silent ([inbox.md](inbox.md), `triage.ts`). To learn
whether those decisions were right, the hub needs labelled data: which notifications you opened, how fast, what
you did then, and which chats you opened without being told to. Usage (`place_usage`, [organize.md](organize.md))
only keeps decayed totals per place, so it cannot answer that. The activity log can. It is the training and
evaluation data for the planned local decision model, and its derived features are already available to triage
and the inbox's ranking behind a flag. The inbox's learned order learns from its visits: which conversations you
opened, from which row, and whether you wrote ([inbox.md](inbox.md#a-learned-order)).

Everything stays on the hub. It is not in the sync journal and not sent to other clients ([sync.md](sync.md)).
Devices only send to it.

## What is recorded

**Never message text, and never what you typed into search.** Only ids, times, counts and where you came from.

### `visit`: one row per stay on a screen or place

| Column | |
|---|---|
| `id` | made by the device; the device sends the same visit again while it lasts |
| `device`, `device_label` | a random id per install (localStorage), and "Firefox on Linux" / "Android app" |
| `view` | `inbox`, `triage`, `conversation` (any open timeline: DM, group, channel, thread), `space`, `person`, `people`, `profile`, `folder`, `spaces`, `search`, `settings`, `accounts`, `directory` |
| `conversation_id`, `space_id`, `person_id` | the place: the open conversation, its community, and for a DM the person |
| `start_at`, `end_at` | when the stay began, and when it was last in use |
| `active` | seconds in use, by the usage rules: page visible, window focused, input in the last 5 minutes, at most 30 s per tick |
| `source` | how you got there (below) |
| `push_id` | the notification tapped, for `notification` and `toast` |
| `rank`, `score`, `needs` | from an inbox row: its position (0 = top), its attention score, and whether it needed you (before 2026-11-07, whether it was above the "caught up" line: the same thing) |
| `depth` | the deepest inbox row on screen during the stay (0 = top, counted as `rank` is), when the inbox's list was on screen: how far down you could have looked. A number, never which rows (since 2026-11-10) |
| `read_to_id`, `read_to_ts` | the latest message when the conversation was marked read during the stay |
| `sent`, `reactions`, `history`, `threads`, `attachments` | messages sent, reactions added, older pages loaded, threads and attachments opened |
| `next_view` | where you went next; null while it lasts or when the app went away |
| `closed` | over: no more updates will come |

**Sources.** `notification` (a tap on a push: sw.js or the Android app), `toast` (the in-app notification),
`inbox` (a row of the ranked inbox), `triage` (Catch up or How it sorts), `rail` (the rail or the phone's tab bar), `list`
(another sidebar list: a space's channels, People), `search` (a result, or the Ctrl+K switcher), `link` (a link,
mention, reply or thread chip in a timeline), `back`/`forward` (history), `start` (the app opened here), `resume`
(back after 30 minutes away, still here), `other`.

**When a stay is a stay.** A route change closes the current stay and opens one at the new place. Coming back
after more than 30 minutes away (`NEW_VISIT_AFTER`, as for usage) starts a new stay at the same place. A stay is
kept if it was in use for at least 3 s (`VISIT_AFTER`), or a notification led there, or something was done in it.
Passing through on the way elsewhere is not kept.

### `notification` and `notification_event`: every push and digest, and what came of it

Each push and digest gets an id when it is sent (`activity.notification` in `main.ts`). It rides in the payload
as `nid`, with `device`, the push registration it was sent to, and in the in-app `notify` event. A tap opens the
app at a hash carrying it (`#/inbox/c/<conv>?n=<nid>`), so the page knows which visit it led to and the address
bar drops it.

`notification` keeps the kind (`message`, `held` for the quiet-hours summary, `digest`, `request` for a request
waiting on you, docs/add.md), the message and
conversation, when it was sent, how many registrations it went to and how many push servers took it, the first
time any device said each outcome, and the visit the tap led to. `notification_event` keeps each device's word,
once per device and outcome.

| Outcome | Web Push (sw.js) | Android app |
|---|---|---|
| `delivered` | the worker got the push | the UnifiedPush receiver got it |
| `shown` / `suppressed` | shown, or closed at once because a window was focused | posted, or not because the app was on screen |
| `blocked` | not knowable: a browser with notifications off has no push subscription | notifications are off for the app |
| `inapp` | the open page showed it as a toast (page device id) | same |
| `tapped` | `notificationclick`, and again from the page when it opens | from the page when it opens (the intent carries `?n=`) |
| `dismissed` | `notificationclose`: Chrome fires it for most swipes, Firefox on some systems, Safari not at all, and "clear all" often not. **A missing dismissal means nothing.** | the delete intent: swipes and "clear all"; a tap is not a dismissal |
| `replied` | an answer typed into the notification went out (Chromium only) | same, from the reply action |

Delivery is only confirmed where the device runs code for the push. A push server that took the push
(`accepted`) does not mean it arrived: a phone that is off or a distributor that is not running drops it.

### `triage_input`: what triage knew when it decided

With the flag on (below), the features triage saw are kept with its decision, so training uses what was known then,
not outcomes that came later: `{ conversation, person, x }`, where `x` holds the interaction features as of the
message (`interact.ts`: how often you answer here and after this author, engaged now, time since you last looked,
another device in use, push open rate; docs/notifications.md "The shadow model").

## How outcomes link

- **Tap → visit.** A visit with `source = 'notification'` (or `toast`) and a `push_id` sets the notification's
  `visit_id` (its first such visit) and its `tapped_at` if no device had said so. Time to tap is `tapped_at - sent_at`.
  A tap while already on that conversation starts a new stay, so it still has a visit; a tap that brought the app
  to the front relabels the stay that had just begun.
- **Opened.** A push counts as opened if it was tapped, or the place was opened by any route within an hour
  (`OPEN_WINDOW`). A push while you were already there (a visit spans its time) is not an example either way.
- **Dwell.** The active seconds of the visit the tap led to, else of the first visit after the push.
- **Reply after open.** A message from you in that conversation within 10 minutes (`REPLY_AFTER`) of opening,
  from any device or network: the hub reads it from the messages, not from the visit.
- **Opened without a push.** Messages from others that triage did not push are grouped into bursts (a gap of 30
  minutes, `BURST_GAP`, or a push between them ends one). A burst was opened anyway if a visit began between its
  first message and an hour after its last. Bursts you were already looking at, and opens that a push came before,
  are left out. This is the missed-importance signal: places you keep opening unprompted are ones triage should
  perhaps push.

## Derived features

Per place over the last 90 days (`FEATURE_WINDOW`), from `activity.ts` `placeFeatures`. For a DM there is a second
set for the person, over all their DMs on every network. Rates are null with nothing to count, and come with the
counts so a consumer can weigh small numbers (smoothing toward a prior is the consumer's choice).

| Feature | |
|---|---|
| `pushes`, `tapped`, `opened` | pushes sent (minus those while you were there), and of those tapped, and opened by any route within an hour |
| `tapRate`, `openRate` | `tapped / pushes`, `opened / pushes` |
| `medianTimeToOpen` | ms from push to open, of those opened |
| `medianDwell` | active seconds of the visit after an opened push |
| `repliedAfterOpen`, `replyAfterOpenRate` | of opened pushes, those with your message within 10 minutes |
| `unpushedBursts`, `openedWithoutPush`, `openedWithoutPushRate` | bursts nobody was pushed for, and how many you opened within an hour anyway |
| `visits`, `activeSeconds` | stays in the place and their time |

`ActivityStore.features(conversationId)` gives `{ conversation, person }` and caches it for 5 minutes. Settings →
Privacy → "What it has learned" shows them for the busiest places; `GET /api/activity/features` returns them.

### Where they plug in

- **Triage**, behind `DITHER_ACTIVITY_FEATURES=1` (or `--activity-features`): `Triage.decide` adds one reason, such
  as "Activity: you opened 4 of 5 pushes, usually within 2 min; replied after 50% of them; opened it unprompted 3 of
  4 times", and the features go with the decision into `triage_input`, with the interaction features (`x`). **Live
  decisions do not change**: only the shadow model uses `x`. Without the flag nothing is computed.
- **Attention**: `Attention.activity` is set, and `GET /api/attention/:id` (`explain`) includes the features. The
  score does not use them yet.

### How the local model would use them

The model that would replace triage's smart score (`askModel` in `triage.ts`, Ollama) and the `AttentionJudge`
([inbox.md](inbox.md#a-local-model-for-needs-a-reply-from-me)) get, per candidate message:

1. **Features as context.** A line per place and person: "You open 80% of pushes from here, usually within 2
   minutes, and reply after half of them; you opened it unprompted 3 of 4 times it was not pushed." A low open
   rate with a short dwell says the pushes from here are noise; a high unprompted rate says a digest-only place
   matters more than its rules say.
2. **Examples from your own history**, not only your thumbs up/down: the export below gives every triaged message
   with what you did. Pick a few nearest to the message at hand (same place, same person, same shape) with their
   outcome as the label.
3. **Evaluation before trusting it.** Run the model over the exported examples (decisions made before the model
   existed) and compare with the labels: how many pushes it would have dropped that you opened within minutes, and
   how many unprompted opens it would have pushed. Only then let its answers change decisions, and keep the rules'
   floor (starred people, keywords, "Nothing").

The simplest first use needs no model at all: a place with 20+ pushes and an open rate under 10% could be suggested
for Digest, and one with a high unprompted rate for Smart or All, as suggestions in Settings, never silent changes.

## Exports

Both are JSON lines, downloadable from Settings → Privacy.

- **`GET /api/activity/export`**: the log as kept. A header line `{type: 'activity-log', settings}`, then every
  visit `{type: 'visit', ...}` and every notification `{type: 'notification', ..., events: [{device, event, at}]}`.
- **`GET /api/activity/examples`**: one line per triaged message within retention, for training and evaluating the
  model. Its metadata (conversation, network, shape, variant, members, kind, mentions you, replies to you, in a
  thread, bot, starred, author's person), triage's decision, score, reasons (a model's reason is replaced by
  "Model", since it may paraphrase the message), and your feedback; `inputs`, what triage knew from the log then (if
  kept); and `outcome`: notified, delivered, shown, suppressed, in-app, tapped, time to tap, dismissed, replied from
  the notification, seen live, opened after, dwell, replied after, and how long it was observed (up to a day). Then a
  `label`:
  - your feedback (`should_push` / `should_not_push`) when you gave it;
  - else `should_push` if you opened it within 15 minutes and replied or stayed 20 s;
  - `should_not_push` if you tapped and left within 5 s, or nothing opened it within a day;
  - null otherwise, and when you were already looking (`seenLive`).

  These weak labels are a starting point, and the raw outcome is there to choose other rules.

## Privacy and control

Settings → Privacy → **Keep an activity log** (on by default):

- **Off**: the hub refuses new visits and outcomes, pushes carry no id, devices stop recording and drop what they
  had not sent. What is kept stays until deleted or past retention.
- **Keep it for** 30, 90, 180 days or a year (default). Shortening it deletes the older rows at once. Whatever the
  retention, at most 200,000 visits and 100,000 notifications are kept, oldest first out (`MAX_VISITS`,
  `MAX_NOTIFICATIONS`). Pruning runs at start and at most every 10 minutes as data arrives.
- **Export my activity log** and **Export training examples**: the two files above.
- **Delete activity log…**: everything in `visit`, `notification`, `notification_event` and `triage_input`. Usage
  totals, which order the sidebar, are separate and stay ("Reset Usage History…" in the sort menu clears those).
  The inbox's learned order goes back to its prior within half an hour, since what it learned came from the log.

On a device, what is not yet sent waits in localStorage (`dither-chat:activity-outbox`) and goes with the next
batch: every minute and when the page is hidden. The hub keeps the latest snapshot of each visit (counts and times
only grow), so a resent batch changes nothing.

## API

| | |
|---|---|
| `GET /api/activity` | `{ settings, visits, notifications, oldest, featuresInTriage }` |
| `PUT /api/activity/settings` | `{ enabled?, retentionDays? }` (30, 90, 180, 365) |
| `POST /api/activity/visits` | `{ visits: VisitRecord[] }` → `{ applied, enabled }` |
| `POST /api/activity/notifications` | `{ events: [{ id, event, device?, at? }] }` → `{ applied, enabled }` |
| `GET /api/activity/features` | `?conversation=<id>`: `{ conversation, person }`; without: `{ places }`, the busiest |
| `GET /api/activity/export`, `/examples` | JSON lines, as attachments |
| `DELETE /api/activity` | delete everything |

The code: `packages/hub/src/activity.ts` (store, derivation, exports), `packages/web/src/visits.ts` (the recorder,
pure) and `activity.ts` (wiring), `ui/ActivityLog.tsx`, sw.js, and `Notifications.kt` in the Android app.

## Not done yet

- Decisions do not use the features; a model does not exist yet (above).
- The Android WebView does not handle `download` links, so the exports are for a browser.
- A visit's `personId` for a DM is filled in from the device's data; on a cold start before the data is there it is
  missing, and the hub matches DMs by conversation instead.
- A push sent by the old plain ntfy topic (`DITHER_NTFY_URL`) carries no id and reports nothing.
