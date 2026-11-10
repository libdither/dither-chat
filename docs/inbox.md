# The inbox: one list, ranked by "will I want this now"

The inbox used to be fixed sections (Needs you, Pinged you, Unread, Recent chats) with group chats in a separate
Groups view. It is now one list: DMs, group chats, rooms outside a space and notes to self, plus any other
channel or thread while it has an unread mention or pinged you. Accounts that need you (a QR to scan, a login)
stay on top. The hub scores every conversation by how much it needs you and by where you were just now (the
formula, below), then a model learned from what you open reorders it ([A learned order](#a-learned-order)); the
list goes by that score, with muted places last. Unread rows keep their bold title and badge wherever they land.

What needs you shows on the row, not in a section. A reply you owe that the hub still counts (they wrote last, the
row's `owedSince`, and it needs you, `needs`) has ↩ and how long it has waited, in the accent colour, beside the
unread count when there is one. An unanswered message from long ago, or from someone you rarely answer, has faded
below `needs` and has no ↩. Accounts that need you and the Requests row stay above the list.

**Sections, tried and removed.** From 2026-11-09 to 2026-11-10 the list had three sections, each in the learned order:
Waiting on you (a reply you owe that needs you), New (unread) and Earlier (the rest). They were removed because hard
sections override the learned order: every owed row sat above every unread row, and every unread row above the rest,
whatever the model said. The order should be one: likeliest first, with what is new found as you scroll, weighted by
how likely you are to open it and answer. In the replay ([below](#the-replay); 7 days, 354 opens, the last 2 days
held out with 118), the learned order put in those sections had a held-out MRR of 0.280 against 0.438 for the learned
order alone: a paired difference of −0.158 (95% interval −0.207 to −0.096), lower for 82 opens and higher for 11.
Against the formula's one list (0.449) it was −0.169 (−0.244 to −0.105). The median position of what you opened went
from 3rd to 11th.

Until 2026-11-07 a line, **Caught up**, split the list: above it what needed you, by score; below it everything
else by the latest message. A chat you had just answered no longer needed you, so it fell below the line, often
far down, about 45 minutes after you last wrote. Now there is one order, and the chat you were just in stays near
the top for a few hours ([You were here](#you-were-here)).

A filter button beside the search box opens a menu: **All**, **Direct messages** (DMs), **Groups** (the other
chats: groups, rooms, notes to self), **Mail** (with a mail account). With a filter on, the button is tinted and
says which (DMs, Groups, Mail). The choice is kept per device. Until 2026-11-09 these were chips under the search
box, with People and Unread: a stored People became Direct messages, and Unread became All, where unread rows are
bold.

**Mail from people** is in the same list (docs/mail.md, slice 8): a thread in Inbox from someone you know that is
unread, owes a reply, is recent or you just opened. It is scored by this formula on its own fold
(`hub/src/mail/attention.ts`: you and one other is a DM, you in To a mention), and how you answer someone sums their
mail and their chats. Its `AttentionView` has `kind: 'mail'` and the thread's id. The Mail filter shows only these;
Direct messages and Groups only chats. Tapping one opens the reader beside the inbox. With no mail account nothing
here changes.

The score uses metadata only: who wrote, when, who replied to whom, mentions, the conversation's shape and member
count, unread state, triage's decisions and time spent and where you were (`usage.ts`). It never reads message text. "Asks a question"
comes from triage's stored decision, not from the text.

Code: `packages/hub/src/attention.ts` (features and score), `rank.ts`, `rankhistory.ts` and `ranker.ts` (the
learned order), `packages/web/src/inbox.ts` (the order on screen), `ordering.ts` (the snapshot rules, shared with
the sidebar, and the filter: `filterKeeps`), `ui/Sidebar.tsx` (`InboxSidebar`).

## The score

This is the formula. It is the order on a fresh hub, the learned order's prior, and always the source of `needs`
and the reasons. In points, roughly 0 to 100. A conversation **needs you** at 20 or more, not counting `visited`: being there
lately moves a row, it does not make it need you.

```
score = max(owed, unread + pinged, live) + relationship + noise + recency + visited   (muted: −50 + recency)

owed         = 60 × p × curve(age)
unread       = 8 + 12 × min(addressed, 3) + 3 × min(other, 3)         when anything is unread
pinged       = 15                                                      triage pushed something still unread
live         = 30 × 2^(−since your last message / 30 min)              you and they wrote within an hour of each other
relationship = 25 × strength                                           strength 0..1
noise        = 20 × fit if fit < 0, else 8 × fit                       fit −1..1
recency      = 10 × 2^(−since last message / 1 day)
visited      = 30 × 2^(−since you were last there / 2 h)                a place you stayed in for a visit (3 s or more)
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
adds 8. An unread busy group you never take part in therefore does not need you, and a mention in it lifts
it. Pinged adds 15 when triage pushed a message you have not read.

### A conversation going on

Answering clears what you owed, so before this term the chat you had just answered fell among chats you had
finished with days ago. `live` keeps it needing you while the back-and-forth lasts: when your last message and
their last one are within an hour of each other, it starts at 30 and halves every 30 minutes after your last
message. With an ordinary relationship and recency it needs you for about 45 minutes, and longer if they keep
answering. A message of yours into a silent place is not a conversation and gets nothing. After that, `visited`
keeps it near the top for a few hours more.

### You were here

Most of the time you open a chat, it is one you were in a little while ago: in the activity log of a real hub
(2026-11-03 to 11-07), 36% of returns to a conversation came within an hour of the last stay there, and 54% within
three. So the time since you were **last there** counts: 30 points as you leave, half after 2 hours, an eighth after
6. "Last there" is the end of your latest stay, from the usage totals (`place_usage`: the later of `last_visit` and
the time the last batch was measured), for the person of a DM and the conversation otherwise. A place you only
passed through, never long enough to count a visit, gets nothing.

The device sends its usage half a second after a visit begins (`usage.ts`), and the hub scores those conversations
again at once (`Attention.visited`). While you are in a chat it keeps its place on screen (below); when you leave,
the next snapshot finds it near the top. The reason reads "You were here 5 minutes ago".

The weight and half-life were checked against the activity log with `scripts/inbox-replay.ts`: on the
conversations opened within 2 hours of a stay there, the median position went from 5th to 3rd, and the first five
rows held 74% of them instead of 54%. Over all opens the one list does about as well as the two parts did, a little
better ([the replay](#the-replay)).

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

A conversation muted on the hub (Nothing, Digest only) or on its network sits at −50 plus its recency, below
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
| visited | You were here 5 minutes ago |
| none of the above | Last message 3 days ago |

A row that needs you with a turn you owe shows a small ↩ with how long it has waited, beside its unread count if it
has one (until 2026-11-10 only with nothing unread).

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

The order is the hub's score, highest first, with muted places last; equal scores go by the latest message
(`rank` in `ordering.ts`). The order on screen is a snapshot (`inbox.ts`), taken by the same rule as the sidebar's automatic orders
(`shouldResort` in `ordering.ts`, [organize.md](organize.md#when-the-order-changes)): at start, when the app
comes back to the front, every 5 minutes, and with one more reason for the inbox, **activity**: any change in
the ranking (a new score, a new conversation, one gone). None of these happen while anything is in use: a
pointer over a list, a touch on one in the last 4 seconds, an open menu, a drag, or keyboard focus in a list.
They retry every 1.5 s until that ends. So the inbox is as current as a chat app's while you are not touching
it, and never moves under your pointer or finger.

The conversation you have open keeps its place across snapshots until you leave it (`inboxSnapshot`'s `hold`):
reading or answering it changes its score, and it should not jump away while you are in it. Leaving it asks for a
snapshot, so it settles where it now belongs once nothing is in use: with what `visited` adds, near the top.

Between snapshots rows keep their places. A new conversation goes at the end until the next one. Rows that are no longer listed go. Rows slide to their new
places when the order changes (`useFlip`). Before the hub has scored a conversation, or with
a hub that predates scores, it ranks unread first, then by recency.

The inbox button and the phone's Catch up tab count the Important messages of the last week that you have not read, by
where each is now (one you voted down to Active no longer counts), plus accounts that need you: the same count as the
push's. How it sorts' own "buzzed you (N unread)" is the same number, from the same lists (`packages/web/src/board.ts`).
A turn you owe does not raise a badge you cannot clear by reading.

## Catch up

What the right pane shows with no conversation open, and the phone's Catch up tab (`#/triage`, so old links land
here): the conversations that need you, to answer or read one after another without leaving the list
(`packages/web/src/ui/CatchUp.tsx`, the queue in `catchup.ts`).

**The queue.** The inbox's rows that need you (`needs`) with a reply you owe (`owedSince`) or something unread, in the
inbox's own order (the snapshot the list shows): one learned order, so a reply you owe sits where the list has it.
From 2026-11-09 to 11-10 replies you owed came first, as the list's sections did (above). Mail threads from people are
rows like any other. It is taken when the pane opens and then stays steady while you work through it: nothing reorders when scores
change, and a card that no longer needs you (read on another device, answered) stays where it is until the pane opens
again. Something that newly needs you joins the end, with a small "N new" note that jumps to it. For the first 3
seconds after opening, before you act, late arrivals (mail views, scores) are still part of the first queue, in order.

**A session.** Closing the pane and coming back within 30 minutes carries on: Later stays where you put it, what was
handled goes, what is new joins the end. Closed longer (or after a reload) the queue is taken afresh. Done is kept on
the device (`localStorage`, `dither-chat:catch-up-done`) with the conversation's latest message then: Done on a reply
you owe marks it read but leaves it owed, so it comes back only once a newer message arrives. Later keeps no state
anywhere.

**A card**, one per conversation: the picture with the network badge and account dots, the name (and community), "waiting
3h" when you owe a reply, and the level its messages landed on since you last read it (Important, Active or Digest:
the highest, by where each is now). Under it the messages since you last read it (or since the message you owe an answer,
whichever came first), the last 5 with "and N earlier" to show the rest, pictures as thumbnails that open the viewer.
Then a one-line reply box that grows, and Done, Later and Open. A mail card shows the subject and the newest snippet,
with Open and Done, and no reply box.

- **Done** marks it read (a mail thread too) and takes it off the queue.
- **Later** moves it to the end of the queue.
- **Open** opens the conversation (or the thread in the reader).
- **A reply** goes out through the conversation's own send path (`state.ts` `send`, as the composer's: the account
  the conversation sends as, the outbox, the same `clientId` and echo matching), and marks the conversation read. Its
  draft is the composer's, so a half-written reply is there when you open the conversation. The card stays, marked
  Replied, with the message in it (pending until it is sent, then the message, once), and focus moves to the next card.
  Where the composer cannot send (an open message request, an encrypted room without keys) the card says why in
  place of the box.

Opening the pane or looking at a card marks nothing read: only Done, a reply, or opening the conversation does. The
messages load lazily, for the cards on screen or near it and the 3 after the focused one, into the conversation's own
timeline (`loadTimeline` with `glance`): what the hub stored, without asking the network for newer history and
without taking a place in the device's start-up snapshot. Opening the conversation then shows them at once and asks
the network as a first open does.

**Keys** (desktop, with a hint line under the cards): `j` and `k` move between cards, `Enter` opens the focused one,
`e` is Done, `l` is Later, `r` puts you in its reply box, and `Esc` leaves the box. No key does anything while you type,
or with a menu, sheet or dialog open.

**The header**: "Catch up · N waiting" (cards not yet answered), Mark all read (with its confirm; for 10 seconds after
it, the cards that no longer need you leave as the reads come in, and replies you owe stay), and How it sorts
([notifications.md](notifications.md#voting)). Accounts that need you (a sign-in, a QR) are one line under it, each
name a link to its page. With nothing waiting: "All caught up", when the last message came, and How it sorts.

`scripts/verify-catchup.ts` drives it on a fresh demo hub: the queue and its order, j/k/e/l, a reply from a card
(exactly one message in the conversation), Done marking read, a new arrival, the empty state and the phone's tab.

## Jump to (Ctrl+K)

The switcher ranks by how well the name matches times the inbox's score: `match × 2^(score / 50)`
(`switcherOrder`, `inboxLift` in `ordering.ts`). So the score doubles a match's weight every 50 points: among names
that start with what you typed, the one you are likelier to want comes first, and a name that only contains it can
come first when its score is much higher (about 50 points). A muted place counts half. A person scores as their best
DM; communities, folders and views have no score and count once. With nothing typed it shows the top of the inbox,
in the order on screen, a DM as its person, then the rest by the latest message.

## API

| | |
|---|---|
| bootstrap `attention` | `AttentionView[]`: `{ id, score, needs, reasons, owedSince, at }` for every listed conversation, and `kind: 'mail'` with a mail thread's id for each listed thread |
| event `{ t: 'attention', items, removed }` | changed scores, and conversations no longer listed |
| `GET /api/attention` | `{ now, items }` |
| `GET /api/attention/:conversationId` | everything about one score: the formula's parts, noise, relationship, reply rate, usual reply time; `learned`: the model's open and send chances and points |
| `GET /api/attention/model` | the learned order: its mode, when it last learned and from how many opens, its prior, and what it learned as changes to weights on named features |
| `POST /api/attention/rebuild` | `{ conversations?: string[] }`: fold these, or all, again from the start |

The bootstrap's and the events' `score` is the learned order's when it is on (the default), the formula's otherwise.
A mail thread keeps the formula's until the learned order learns mail (mail-design.md §12, slice 10).

Old `#/groups` and `#/groups/c/<id>` links open the inbox and the same conversation, and the address bar shows
the new link.

## A learned order

The formula's weights are guesses. The learned order is fitted to what you actually open. For each listed
conversation it predicts two chances from its metadata (`rank.ts`), each a logistic regression:

- **open**: you open it within the next 3 hours, given it is listed;
- **send**: you write in it, given you open it.

They combine into one expected value, `open × (1 + send)`: an open that leads to a message counts twice. That value
is turned back into the formula's points (the formula score whose prior open chance would give it), so the client
still sorts by one `AttentionView.score` and Ctrl+K's lift means the same. Under the prior the points are exactly
the formula's. Muted places keep the formula's score and stay at the bottom; `needs` and the reasons stay the
formula's. When the learned score is 10 points or more away from the formula's, one reason says so: "Higher: you
often open chats like this at times like this", or "Lower: …".

**"See a chat if it is listed"** is the third chance. It depends on where the row is, not on the chat: you look at
the rows near the top more, so they get opened more whatever they are. That is the examination chance,
`(1 + position)^−0.5` (`examination`). It does not reorder anything by itself, since putting the likeliest rows
where you look most is already what sorting by value does. What it changes is the learning: an open from an inbox row
counts `1 / examination(position)` times, with the position the visit log kept (at most 10 times). An open from a
notification, Ctrl+K or search counts once.

**Features**, all metadata: the formula's score, how long since you were there (an hour and a day half-life, and
never), since the latest message (the same two), since you wrote, unread messages and mentions, the owed and
conversation-going-on parts, a push still unread, relationship strength, noise, decayed visits and minutes, and
the shape (DM, group, notes). Never what was said.

**Prior.** The open chance starts as a function of the formula's score alone, `logit = −5.1 + 0.66 × score/10`:
1 in 160 at 0 points, 1 in 7 at 50, even odds at 77. That was fitted to the opens of the choosing days below
(`--calibrate`). So a fresh hub, or one with no activity log, orders exactly as the formula does. The send chance
starts at one in six. Fitting adds weights on top of the prior and pulls them back toward it (L2: 1 for the
prior's two weights, 30 for the rest), so a few days of opens move the order a little and a few weeks more.

**Learning in the hub** (`ranker.ts`), like triage's refits (`learn.ts`):
- It rebuilds the inbox as it was at each open in the activity log's last 60 days (at most 1,500 opens), with
  the replay's code (`rankhistory.ts`).
- It keeps every conversation you opened within the next 3 hours, the 40 with the latest message or stay, and
  40 drawn from the rest, each counting for as many as it stands for. Then it fits both chances again from the
  prior and saves the result in `meta`.
- It refits at start if it has never learned, a day after the last refit, and after 10 more opens have had their
  3 hours.
- The work runs on a read-only connection of its own, at most about 25 ms at a time. Measured on a copy of the
  real hub (184 opens, 675K messages): the longest the hub was held was 86 ms, and the whole refit took about 10 s
  in the background. Scoring all 484 listed conversations took 185 ms with the model, the same as without.
- Clearing the activity log puts it back to the prior at the next check (every 30 minutes).

`DITHER_INBOX_RANK`: `model` (the default) sorts by it; `shadow` works it out and shows it in
`GET /api/attention/:id` without sorting by it; `off` does neither.

**Why it is the default.** In the replay below, refitted each day on the days before as the hub does, it beat the
formula's one list on the held-out days. MRR went 0.366 → 0.526; the paired difference was +0.160, with a 95%
bootstrap interval of 0.078 to 0.245. It ranked the opened conversation higher for 20 of 34 opens and lower for 4,
and the median position went 8.5th → 2nd. On opens from elsewhere, which inbox position cannot have favoured, the
difference was +0.139 (0.027 to 0.289). On the choosing days, where its first refits had a day or two of opens, it
was about even: +0.025 (−0.006 to 0.058). Every regularisation from 3 to 300 and position correction from 0 to 1
did better than the formula on the held-out days (`--model-grid`: MRR 0.42 to 0.52). The choosing days could not
tell them apart, so the shipped ones were fixed before looking. Two held-out days is little; the hub keeps
learning, and the replay can be run again as the log grows. Run again on 2026-11-09 (7 days, 354 opens, 118 held
out), the two were even on the held-out days: −0.011 (−0.057 to 0.028), higher for 48 opens and lower
for 33; on opens from elsewhere the formula did better, −0.063 (−0.140 to −0.002).

**Why it is only even (2026-11-10).** The same 7 days (359 opens), now with the last 3 held out (180 opens): the
formula 0.419, the learned order 0.433, a paired +0.014 (−0.023 to 0.057). Every day after the first is out of
sample for the learned order (each day's model learned only from the days before), and over those 305 opens it is
+0.011 (−0.023 to 0.048), the sum of two parts that cancel:

- on opens of a conversation you had not been in for 2 hours it is better, +0.043 (0.010 to 0.080, 179 opens);
- on going back to one you were in within 2 hours it is worse, −0.035 (−0.088 to 0.008, 126 opens), and on opens
  where you wrote, −0.066 (−0.131 to 0.003, 78 opens).

It learned "you were here" as worth less than `visited`'s 30 points (an hour's half-life −1.2 in log-odds, a day's
−0.7). Part of that is the guessed position correction: it counts an open from far down up to 10 times, and opens
from far down are seldom going back, so they outweigh the returns from the top. With no correction (η 0) going
back held up on the held-out days (MRR 0.631 against 0.591 with 0.5), but over all opens neither was clearly
better. A curve fitted to your own opens should replace the guess. Inbox clicks also favour the order that was on
screen then, the learned order since 2026-11-07, so its +0.037 on clicks from the inbox (−0.001 to 0.069) overstates
it; on opens from elsewhere it was −0.029 (−0.065 to 0.015).

Nothing in `--model-grid` was clearly better than what ships, so nothing changed. Against the shipped settings
(choosing days; held out):

| setting | tried | best, choosing days | best, held out | note |
|---|---|---|---|---|
| pull to the prior λ × position correction η | 3 to 300 × 0, 0.5, 1 | λ 100, η 0: +0.017 (−0.004 to 0.031) | the same: +0.015 (−0.018 to 0.043) | stronger pulls a little better; no interval above 0 on both |
| horizon | 30 min, 1 h, 3 h, 6 h | 30 min: +0.001 | 30 min and 1 h: +0.005 | 6 h worse on both: −0.025 (−0.045 to −0.006), −0.017 (−0.029 to −0.002) |
| cap on an open's weight | 2, 3, 10, 30 | 2: +0.009 (−0.006 to 0.022) | 3: −0.000 | every open from the inbox was in its first 100 rows, where η 0.5 stays under 10, so 10 and 30 are the same |
| learn from the last | 2, 3, 5 days, all | 2 days: +0.008 (0.001 to 0.017) | 3 days: +0.007 (−0.021 to 0.032) | the 60-day and 1,500-open windows do not bind yet: 7 days, about 360 opens |

What it learned on the real hub, in short: the time since the latest message counts much more than the formula's
`recency` gives it, mentions and relationship a little more, and "you were here" a little less than `visited`'s
30 points.

## The replay

`scripts/inbox-replay.ts` replays the activity log against a copy of a hub (made read-only with `VACUUM INTO`) and
asks, at every moment you opened a conversation, at which position each ordering would have shown it. It rebuilds
the world at that moment: every candidate's features folded up to then (the same fold as the hub), what was unread
(messages from others since you last wrote or stayed there; before the log starts, everything counts as read),
where you had been (the log's stays) and the mutes as they are now. App starts and resuming are not choices and are
left out; a person's page counts as the best of their DMs. The earlier days are for choosing weights, the last three
are held out (two until 2026-11-10). It writes counts and rates only.

```
bun scripts/inbox-replay.ts --live .data/hub.sqlite --out <scratch dir> [--holdout 3] [--grid] [--model-grid] [--calibrate]
```

`--model-grid` replays the learned order with other settings, each against the shipped one on the same opens: the
pull to the prior and the position correction, the horizon (from moments built with 6 hours, so a shorter one is
exact), the cap on an open's weight, and how many days back it learns from. The report also splits every day after
the first by how you got there, going back or not, and writing.

The learned order is replayed as the hub runs it: refitted at the start of each day on the opens before it whose
3 hours had passed, from the same rebuilt moments and the same sampling, and asked at every open of the day.

On a real hub, 2026-11-03 to 11-07 (184 opens of a listed conversation; about 400 rows listed). MRR is the mean of
1/position; R@5 the share opened from the first five rows:

| | choosing days, all (150) | held out, all (34) | back within 2 h, choosing (57) | held out (6) |
|---|---|---|---|---|
| two parts, "caught up" line | MRR 0.273 · R@5 0.44 · median 7th | 0.355 · 0.41 · 6th | 0.323 · 0.54 · 5th | 0.559 · 0.83 · 2nd |
| one list (now) | 0.285 · 0.47 · 6th | 0.366 · 0.41 · 8.5th | 0.410 · 0.74 · 3rd | 0.769 · 0.83 · 1st |
| latest message first | 0.283 · 0.42 · 7.5th | 0.294 · 0.41 · 6.5th | 0.368 · 0.61 · 4th | 0.579 · 0.67 · 2nd |
| learned order (default) | 0.310 · 0.47 · 6th | 0.526 · 0.68 · 2nd | 0.470 · 0.72 · 3rd | 0.852 · 0.83 · 1st |

Five days is little: differences of a few hundredths are noise. Clicks on inbox rows favour the order that was on
screen then (the two parts), so the replay also reports opens from elsewhere (notifications, Ctrl+K, search) apart;
there the latest message does best, since a notification is about the latest message. `--grid` tries weights 15 to
60 and half-lives of 1 to 4 hours for `visited`: more weight helps "back" on the choosing days and does nothing
for the held-out ones, so it stays at 30 and 2 hours.

Run again on 2026-11-09, to weigh the sections (11-03 to 11-09, 354 opens; 118 held out, the last two days).
`sectioned` is the learned order inside the three sections of 2026-11-09:

| | choosing days, all (236) | held out, all (118) | held out, from the inbox (82) | held out, elsewhere (36) |
|---|---|---|---|---|
| one list, the formula | MRR 0.336 · R@5 0.47 · median 6th | 0.449 · 0.58 · 4th | 0.494 · 0.65 · 2.5th | 0.346 · 0.42 · 7.5th |
| learned order | 0.353 · 0.47 · 6th | 0.438 · 0.60 · 3rd | 0.506 · 0.68 · 2nd | 0.283 · 0.42 · 7th |
| sectioned | 0.275 · 0.34 · 13th | 0.280 · 0.28 · 11th | 0.302 · 0.31 · 11th | 0.229 · 0.22 · 14.5th |

Sectioned minus the learned order: −0.078 (−0.120 to −0.046) on the choosing days, −0.158 (−0.207 to −0.096) held
out, and −0.054 (−0.121 to 0.019) on held-out opens from elsewhere.

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

`AttentionJudge` in `attention.ts` is the interface. Its `rank` is the learned order's way in (above). Its `judge`:
given a few candidate conversations (the top of the ranking with an open turn, say) and their latest message ids,
it answers per conversation
`{ needsReply: 0..1, importance: 0..1, reason }`. Answers go in `Attention.judged`, and `scoreConversation`
already uses them: `p` becomes the mean of the reply rate and `needsReply`, `importance` adds up to 10 points,
and the reason shows as "Model: …". Nothing implements it yet. It should follow triage.ts's `askModel`:
Ollama at `DITHER_OLLAMA_URL`, a few recent messages as context, a short timeout, and your corrections as
few-shot examples. Those would come from triage's votes (▲/▼ on a message's level) and, once added, a "doesn't need me" action on
an inbox row. Run it off the ingest path, on a timer or after a sync, for a handful of conversations at a time.
This is the only part that would read message text, and only in the local model.

What you actually did with notifications and chats, as labelled data for this model and for triage's, is in the
activity log ([activity.md](activity.md)): open rate after a push, time to open, dwell, replies after opening, and
how often you open a place nobody pushed you about. `GET /api/attention/:id` includes those features; the formula does
not use them. The learned order learns from the same log (above).
