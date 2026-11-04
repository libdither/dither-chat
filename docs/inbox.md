# The inbox: one list, ranked by "does this need me"

The inbox used to be fixed sections (Needs you, Pinged you, Unread, Recent chats) with group chats in a separate
Groups view. It is now one list: DMs, group chats, rooms outside a space and notes to self, plus any other
channel or thread while it has an unread mention or pinged you. Accounts that need you (a QR to scan, a login)
stay on top. The hub ranks every conversation by how much it needs you; a line, **Caught up**, marks where that
ends. Above the line, rows go by score; below it, by the latest message, as a chat app's list would, with muted
places last. Unread rows keep their bold title and badge wherever they land.

Filter chips: **All**, **People** (DMs), **Groups** (everything else), **Unread**. The choice is kept per device.

The score uses metadata only: who wrote, when, who replied to whom, mentions, the conversation's shape and member
count, unread state, triage's decisions and time spent (`usage.ts`). It never reads message text. "Asks a question"
comes from triage's stored decision, not from the text.

Code: `packages/hub/src/attention.ts` (features and score), `packages/web/src/inbox.ts` (the order on screen),
`ordering.ts` (the snapshot rules, shared with the sidebar), `ui/Sidebar.tsx` (`InboxSidebar`).

## The score

In points, roughly 0 to 100. A conversation **needs you** at 20 or more.

```
score = max(owed, unread + pinged, live) + relationship + noise + recency   (muted: −50 + recency)

owed         = 60 × p × curve(age)
unread       = 8 + 12 × min(addressed, 3) + 3 × min(other, 3)         when anything is unread
pinged       = 15                                                      triage pushed something still unread
live         = 30 × 2^(−since your last message / 30 min)              you and they wrote within an hour of each other
relationship = 25 × strength                                           strength 0..1
noise        = 20 × fit if fit < 0, else 8 × fit                       fit −1..1
recency      = 10 × 2^(−since last message / 1 day)
```

Something to **answer** (owed), something to **read** (unread, pinged) and a **conversation going on** (live) are one
need, not three, so the largest counts (`parts.overlap` takes off the rest). Reading clears what there was to read; only answering, or time, clears what
you owe. So reading a message from someone you answer leaves the conversation where it was, and reading one you would
not answer lets it go. Before, the two added up, and reading a fresh message took its points away while the owed part
was still near zero: the conversation you were in sank below chats you had finished with.

### Owed reply

Messages from others since your last one form a **turn**. A turn is **addressed to you** from its first message
that is:

- in a DM,
- a mention of you,
- a reply to your message,
- in a small group (6 or fewer, you included): a question (triage said "asks a question"), or the first message
  within an hour after yours.

Bots never address you, and neither does @everyone or @here (`mentions_all`): those notify like a mention and count as
one while unread, but owe no answer. Your next message **settles** the turn: answered, with how long it took, if within
3 days (`REPLY_WINDOW`), otherwise unanswered. A turn that runs past 3 days counts as unanswered, and the next
addressed message starts the clock again.

A **reaction** of yours settles it too: a 👍 is often the whole reply. Reactions carry no time, so it counts where the
message you reacted to is: what was owed up to there is answered, and what they wrote after it is owed afresh. It
counts toward how often you answer, not how fast. Adding or taking back a reaction folds the conversation again from
the start (`Store.selfReacted`), a few seconds later.

While a turn is open, `age` is the time since its first addressed message, and

- `curve(age)` is 1 from the moment the message arrives through the first day, then halves every 2 days. After
  3 days it is 0.5, after a week 0.125. (It used to rise over the time you usually take to answer, which made a
  just-read message weigh almost nothing.)
- `p` is your reply rate: answered turns over addressed ones, decayed (half-life 30 days). It is pooled per
  person over all your conversations with them, pulled toward ½ while there are few, and then used as the prior
  for this conversation's own rate: `p = (answered_here + 2·p_person) / (addressed_here + 2)`.

So someone you answer 9 times in 10 is worth about 50 points as soon as they write, and needs you. Someone you answer
1 time in 10 stays near 10 and does not.

### Unread and pinged

DM messages and mentions count 12 each (up to 3). Other unread messages count 3 each (up to 3). Anything unread
adds 8. An unread busy group you never take part in therefore stays below the line, and a mention in it lifts
it. Pinged adds 15 when triage pushed a message you have not read.

### A conversation going on

Answering clears what you owed, so before this term the chat you had just answered fell below the line, among chats
you had finished with days ago. `live` keeps it above the line while the back-and-forth lasts: when your last message
and their last one are within an hour of each other, it starts at 30 and halves every 30 minutes after your last
message. With an ordinary relationship and recency it stays above the line for about 45 minutes, and longer if
they keep answering. A message of yours into a silent place is not a conversation and gets nothing. Once it lets go,
it is the newest row below the line, which goes by the latest message, so it is still the first place to look.

### Relationship strength

A weighted sum, 0..1:

| Part | Weight | What |
|---|---|---|
| talk | 0.25 | `1 − e^(−your messages per week / 5)` |
| time | 0.20 | `1 − e^(−minutes spent / 60)`, decayed minutes from `usage.ts` (the person, for a DM) |
| mutual | 0.15 | your messages against theirs, smaller over larger |
| recent | 0.15 | `2^(−since your last message / 14 days)` |
| reply | 0.15 | answered over addressed |
| speed | 0.10 | `1 / (1 + usual reply time / 2 h)` |

### Noise

Per place: messages from others per day, pushes per day, and your engagement (your messages plus visits) per
day, all from decayed sums. Then

```
fit = clamp(log2((1 + 4 × engaged) / (1 + received + pushed)) / 5, −1, 1)
```

200 messages a day that you never touch gives −1 (−20 points). A quiet place you answer when it speaks gives a
few points up. The same volume you take part in is not noise. These numbers are kept per place for triage to
use later (`Attention.placeNoise`); triage does not use them yet.

### Muted

A conversation muted on the hub (Nothing, Digest) or on its network sits at −50 plus its recency, below
everything else, and never needs you. Notes to self are silent by default because you do not notify yourself.
That is not a mute, so they rank normally.

## The reasons

Each part that weighs 2 points or more becomes a sentence, ordered by weight, at most four. They are shown as
the row's tooltip and at the top of its right-click menu (a sheet on a phone):

| Part | Sentence |
|---|---|
| owed, usual time known for the person | You usually reply to Sam within an hour; unanswered for 5 hours |
| owed, known only for the place | You usually reply here within 15 minutes; unanswered for a day |
| owed, reply rate known (3+ turns) | You reply to Sam most of the time / about half the time / rarely; unanswered for 2 days |
| owed, otherwise | Sam wrote to you / mentioned you / replied to you / asked the group something / answered you 3 hours ago; not answered yet |
| unread | 2 unread messages · 1 unread mention, 4 more unread |
| pinged | Pinged you: (triage's first reason) |
| relationship ≥ 0.3, by its largest part | You talk with Sam often: about 12 messages a week · You spend time here: 2 hours lately · You wrote here 3 hours ago · You answer here 80% of the time · It goes both ways here |
| noise | Busy (about 200 messages a day) and you rarely take part · Quiet, and you take part when it speaks |
| muted | Muted: (where the mute comes from) |
| none of the above | Last message 3 days ago |

A row above the line with nothing unread but a turn you owe shows a small ↩ with how long it has waited.

## Features, kept incrementally

The hub keeps per conversation (`conv_feature`) a JSON state folded over its messages in `(ts, rowid)` order up
to a cursor: decayed counts of messages from others, from you and pushed (half-life 30 days), totals, the last
times, the open turn, the last push, and a tally of addressed and answered turns with a reply-latency histogram
(buckets from 5 minutes to 3 days). Per conversation and author (a person, else an identity) there is the same
tally (`conv_author_feature`), so a person's reply rate is a sum over a few rows.

- **On ingest**: the store notes each new message's conversation and timestamp. At the next flush (every 80 ms),
  appended messages are folded (up to 500 per conversation) and the conversation is scored again. A changed
  score goes out as an `attention` event.
- **Older messages** (backfill, imported history): a new message older than the cursor marks the conversation
  stale. Once nothing older has arrived for 5 seconds, its features are dropped and folded again from the
  start. The fold over the same messages gives the same state, so this is idempotent. So is the ingest, so
  importing the same history twice changes nothing.
- **In the background**: a pump folds whatever is behind its cursor, at most 5000 messages and about 30 ms per
  step, until nothing is. A new hub, or a `FEATURE_VERSION` bump, folds everything this way.
- **Triage after the fold**: triage decides a moment after the message is stored. If the fold already passed
  it, `Attention.triaged` adds the push or the question; a later full fold reads the stored decision instead.
- **Time**: every 5 minutes all listed conversations are scored again, since an unanswered message ages and
  recency fades. A change in notification rules scores everything at once.

Measured on a copy of a real hub (93,439 messages, 5,234 conversations, 403 listed): folding everything took
1.9 s in 59 steps of at most 35 ms; scoring all 403 takes about 55 ms; the features take 384 KB. That is about
20 µs a message, so a million imported messages fold in about 20 s of background steps. Since the fold also looks
for your reactions (version 2), it is slower: 129,600 messages in 5.7 s on a later copy, about 44 µs a message.

Not followed: a message deleted or edited after it was folded (its mention or reply target) keeps counting
until the conversation folds again. Merging two people leaves their old author rows under the old person until
then too. `POST /api/attention/rebuild` folds again.

## When the list moves

The order on screen is a snapshot (`inbox.ts`), taken by the same rule as the sidebar's automatic orders
(`shouldResort` in `ordering.ts`, [organize.md](organize.md#when-the-order-changes)): at start, when the app
comes back to the front, every 5 minutes, and with one more reason for the inbox, **activity**: any change in
the ranking (a new score, a new conversation, one gone). None of these happen while anything is in use: a
pointer over a list, a touch on one in the last 4 seconds, an open menu, a drag, or keyboard focus in a list.
They retry every 1.5 s until that ends. So the inbox is as current as a chat app's while you are not touching
it, and never moves under your pointer or finger.

The conversation you have open keeps its place across snapshots, on the same side of the line, until you leave it
(`inboxSnapshot`'s `hold`): reading or answering it changes its score, and it should not jump away while you are in
it. Leaving it asks for a snapshot, so it settles where it now belongs once nothing is in use.

Between snapshots rows keep their places, and the line stays after the rows that needed you then. A new
conversation goes at the end until the next one. Rows that are no longer listed go. Rows slide to their new
places when the order changes (`useFlip`). Under **Unread**, a row that was unread at the snapshot stays until
the next, so reading it does not pull it out from under you. Before the hub has scored a conversation, or with
a hub that predates scores, it ranks unread first, then by recency.

The inbox button and the phone's Triage tab count what pinged you and is still unread, plus accounts that need
you, as before. A turn you owe does not raise a badge you cannot clear by reading.

## API

| | |
|---|---|
| bootstrap `attention` | `AttentionView[]`: `{ id, score, needs, reasons, owedSince, at }` for every listed conversation |
| event `{ t: 'attention', items, removed }` | changed scores, and conversations no longer listed |
| `GET /api/attention` | `{ now, items }` |
| `GET /api/attention/:conversationId` | everything about one score: its parts, noise, relationship, reply rate, usual reply time |
| `POST /api/attention/rebuild` | `{ conversations?: string[] }`: fold these, or all, again from the start |

Old `#/groups` and `#/groups/c/<id>` links open the inbox and the same conversation, and the address bar shows
the new link.

## Seams for what comes next

### Importing old history from a scraper

Turn the scraper's output into the adapter facts a live adapter sends (`identity`, `conversation`, and
`message` events with `live: false`), keyed by the network's own ids. Then feed them through `Store.ingest`
for the account that owns them, the same path the supervisor uses. That ingest is idempotent: messages are
keyed by `(network, native_id)` and stored once, with no triage and no notifications for non-live messages.
The attention side needs nothing more: older messages mark their conversations stale, and each folds again
once the import has been quiet for 5 seconds. New conversations are picked up by the pump. If an importer
writes to the database some other way, call `Attention.invalidate(ids)` or `POST /api/attention/rebuild`
afterwards. Import in transactions of a few thousand messages so the hub keeps answering in between.

### A local model for "needs a reply from me?"

`AttentionJudge` in `attention.ts` is the interface: given a few candidate conversations (the top of the
ranking with an open turn, say) and their latest message ids, it answers per conversation
`{ needsReply: 0..1, importance: 0..1, reason }`. Answers go in `Attention.judged`, and `scoreConversation`
already uses them: `p` becomes the mean of the reply rate and `needsReply`, `importance` adds up to 10 points,
and the reason shows as "Model: …". Nothing implements it yet. It should follow triage.ts's `askModel`:
Ollama at `DITHER_OLLAMA_URL`, a few recent messages as context, a short timeout, and your corrections as
few-shot examples. Those would come from triage's thumbs up/down and, once added, a "doesn't need me" action on
an inbox row. Run it off the ingest path, on a timer or after a sync, for a handful of conversations at a time.
This is the only part that would read message text, and only in the local model.

What you actually did with notifications and chats, as labelled data for this model and for triage's, is in the
activity log ([activity.md](activity.md)): open rate after a push, time to open, dwell, replies after opening, and
how often you open a place nobody pushed you about. `GET /api/attention/:id` includes those features; the score does
not use them yet.
