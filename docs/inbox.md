# The inbox: one list, ranked by "will I want this now"

The inbox used to be fixed sections (Needs you, Pinged you, Unread, Recent chats) with group chats in a separate
Groups view. It is now one list: DMs, group chats, rooms outside a space and notes to self, plus any other
channel or thread while it holds an unread mention, or an unread message that triage made an alert, a Conversation
or a row on the list ([notifications.md](notifications.md)), unless the place is muted. Accounts that need you (a QR
to scan, a login) stay on top. The hub scores every conversation by how much it needs you and by where you were
just now (the formula, below), then a model learned from what you open reorders it
([A learned order](#a-learned-order)); the list goes by that score, with muted places last. A conversation with an
alert you have not seen comes before everything else. Unread rows keep their bold title and badge wherever they
land.

**One row per chat.** Someone you reach by several routes ([chats.md](chats.md): several networks, or several of
their accounts or yours) is one row, not one per DM (`convRows` in `packages/web/src/model.ts`, the merge in
`chatroutes.ts`). Its key is `person:<id>`, so ranking, the kept snapshot and the hold on the open row all see one
thing. It scores the highest of its routes, needs you if any does, is owed since the earliest, sums their unread, and
is muted only if every route is; its reasons are the top route's. It looks like any DM row: the person's picture with
the badge of the route that has the latest message, that message as the preview, the summed count. A click opens the
conversation of the latest message, so a reply goes where they last wrote, unless a route was picked on their page
this session. It is active whichever of their DMs is open, and its menu acts on the whole chat: Mark As Read reads
every route, Mute and the rule go on each, and search looks in every chat with them.

**One row per channel.** A channel's threads are one row, not one per thread: a Zulip channel's topics, a Discord
text channel's threads and a forum's posts, a Matrix room's threads (`convRows` in `packages/web/src/model.ts`, the
fold in `channelrows.ts`). Its key is `channel:<id>`, so ranking, the kept snapshot and the hold on the open row see
one thing, as for a person's chat; the channel open, or any thread of it, holds it. A place with threads that would
have had a row of its own (a Matrix room, a Discord channel the hub scored) is that same row, keyed `channel:<id>`
whether or not a thread of it is listed now, so the key does not change under you as its threads are read or come
unread. A thread of a DM keeps a row of its own: a DM's row is the person's. The row scores the highest of its parts,
needs you if any does, is owed since the earliest and is muted only if every part is; a muted thread does not lift it
(its score, ↩ and time count only while every part is muted), and the ↩ marks go on the parts that are not muted.
The fold is the page's alone: the hub scores each thread as before (`Attention.input`), so a thread still reaches the
inbox only by a mention or a message that notified you, and a followed Zulip topic still does not alert by itself.

The row shows the channel's name and place, the latest listed thread's name and its last message, the unread summed
over every thread of the channel (listed or not, a muted one only for a mention, the place's own messages added; a
forum's own count or its threads', the larger), and a red @ count when you are mentioned in it. A Matrix room keeps
a group's lock, typing and red count of its own messages. A chevron at the end of its top line opens it in place on
its unread threads, those that mention you first, then the latest, each with its own count (red where it mentions
you), and the thread open now, which stays once read; the row stays open on this device (`collapsed` under
`inbox:<id>`, kept as `false`). A thread under it opens that thread; the row itself opens the channel as the sidebar
does (`openChannelRow` in `ui/Sidebar.tsx`). Its menu is the channel's, and its Mark As Read reads the channel and
every thread of it at once, with no confirm. Fetching ahead (`ahead.ts`) loads what the row leads to: the channel's
messages, or for a forum, which opens on its cards, its latest listed thread's. `scripts/verify-channel-rows.ts`
checks it in a browser on the demo world's Zulip organization.

What needs you shows on the row, not in a section. A reply you owe that the hub still counts (they wrote last, the
row's `owedSince`, and it needs you, `needs`) has ↩ and how long it has waited, in the accent colour, beside the
unread count when there is one. An unanswered message from long ago, or from someone you rarely answer, has faded
below `needs` and has no ↩. A turn whose chance of an answer has fallen under 5% (`OWED_SHOWN`, owed.ts) has no
`owedSince` at all, so a row that needs you for something else does not say "↩ 14w". Accounts that need you, the Requests row and a network's notifications ([feed.md](feed.md), a row per feed under
Requests) stay above the list. A feed is never one of the ranked rows, and its unread count is on no badge.

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
chats: groups, rooms, notes to self), **Mail** (with a mail account: chats with mail in them). With a filter on, the button is tinted and
says which (DMs, Groups, Mail). The choice is kept per device. Until 2026-11-09 these were chips under the search
box, with People and Unread: a stored People became Direct messages, and Unread became All, where unread rows are
bold.

### Mail lists

With Mail on, a row of chips under the search box goes to mail's other lists, shown in the inbox's place (docs/mail.md
"Mail as chats"): always exactly **Inbox**, **Updates**, **Everything** and **More ⌄**, in one row that neither wraps
nor scrolls, on a computer and a phone. More's menu has Starred and Sent, then each account's mailboxes; with one of
them open, More is lit and says its name ("Starred ⌄"). The open list's chip is filled with the accent colour, in both
themes, since the title stays "Inbox".

A list keeps the Inbox's own header (`ui/Sidebar.tsx` `InboxSidebar` with `mail`, the list under it from
`ui/mail/MailSidebar.tsx`): the title, the search box, the Mail filter and its +, which has New email. Nothing above the
list moves as you change lists. The search box says which list it searches ("Search Updates") and keeps to it: Enter
runs a mail search that starts with the list's operators (`mail/model.ts` `listSearch`: `in:inbox is:update` for
Updates, `in:inbox` for Everything, `is:starred`, `in:sent`, `in:<mailbox>`, and `account:` for one account's), so the
list's chip stays lit over its results; emptied, the list is back. In the Inbox chip the box is the app's search, as
without the filter.

From the Inbox a list is a step of its own; from one list to another replaces it, so back, and Escape, go to the Inbox
chip first (`ui/MailChat.tsx` `toInboxChip`). Turning the Mail filter off goes back to the whole inbox. Chat requests and
notices are not mail: under the Mail filter there is no Requests row.

**Mail from people** is in the same list (docs/mail.md, slice 8): a thread in Inbox from someone you know that is
unread, owes a reply, is recent or you just opened. It is scored by this formula on its own fold
(`hub/src/mail/attention.ts`: you and one other is a DM, you in To a mention), and how you answer someone sums their
mail and their chats. Its `AttentionView` has `kind: 'mail'` and the thread's id. Mail is chats (docs/mail.md "Mail as chats"): a thread
between you and one person is folded into that person's row (web `model.ts` `foldMailIntoChats`), so their chat and
their mail are one row ranked by the better of the two; a thread with more people is a row of its own and opens as a
group chat, named by its subject: the envelope tile, the subject without Re: or Fwd:, and "Jo: …" (`mail/model.ts`
`threadName`, `threadSnippet`). Ctrl+K and search's Jump to find it by its people's names too. The Mail filter keeps rows with mail in them; Direct messages keeps people's rows, mail or not; Groups the
rest. With no mail account nothing here changes.

The score uses metadata only: who wrote, when, who replied to whom, mentions, the conversation's shape and member
count, unread state, triage's stored decisions (the tier and the importance) and time spent and where you were
(`usage.ts`). It never reads message text. "Asks a question" comes from triage's stored decision, not from the text.

Code: `packages/hub/src/attention.ts` (features and score), `rank.ts`, `rankhistory.ts` and `ranker.ts` (the
learned order), `packages/web/src/inbox.ts` (the order on screen), `ordering.ts` (the snapshot rules, shared with
the sidebar, and the filter: `filterKeeps`), `ui/Sidebar.tsx` (`InboxSidebar`).

## The score

This is the formula. It is the order on a fresh hub, the learned order's prior, and always the source of `needs`
and the reasons. In points, roughly 0 to 100. A conversation **needs you** at 20 or more, not counting `visited`: being there
lately moves a row, it does not make it need you.

```
score = max(owed, unread + pinged, live) + importance + relationship + noise + recency + visited
                                                                       (muted: −50 + recency)

owed         = 60 × P(needs a reply)                                  needsreply.ts, over the owed table (owed.ts)
unread       = 8 + 12 × min(addressed, 3) + 3 × min(other, 3)         when anything is unread
pinged       = 15, and 40 more for an alert                            an alert or Conversation message, unread, unseen
importance   = 25 × triage's importance, 0..1                          of the newest message in a tier, unread, unseen
live         = 30 × 2^(−since your last message / 30 min)              you and they wrote within an hour of each other
relationship = 25 × strength                                           strength 0..1
noise        = 20 × fit if fit < 0, else 8 × fit                       fit −1..1
recency      = 10 × 2^(−since last message / 1 day)
visited      = 30 × 2^(−since you were last there / 2 h)                a place you stayed in for a visit (3 s or more)
```

Something to **answer** (owed), something to **read** (unread, pinged) and a **conversation going on** (live) are one
need, not three, so the largest counts (`parts.overlap` takes off the rest). Importance is added apart from them.
Reading clears what there was to read; only answering, or time, clears what you owe. So reading a message from someone
you answer leaves the conversation where it was, and reading one you would not answer lets it go. Before, the two
added up, and reading a fresh message took its points away while the owed part was still near zero: the conversation
you were in sank below chats you had finished with.

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

- `p` is your reply rate: answered turns over addressed ones, decayed (half-life 30 days). It is pooled per
  person over all your conversations with them, pulled toward ½ while there are few, and then used as the prior
  for this conversation's own rate: `p = (answered_here + 2·p_person) / (addressed_here + 2)`.
- `chance(shape, p, age)` is the **owed table** (owed.ts): of your past turns of that shape (a DM, or anything else)
  and reply rate that were still open at that age, the share you answered within the 3 days. It falls as the turn
  ages, since every hour it stays open says something, and it is 0 from 3 days on. Rates fall in five buckets (edges
  0.8, 0.9, 0.95, 0.98); between two buckets' mean rates, and between the table's ages (0, 15 and 30 minutes, 1, 2,
  3, 6, 12 and 18 hours, 1, 1.5, 2 and 2.5 days), it is drawn straight, so a higher rate never weighs less. Below the
  lowest bucket it falls to 0 at a rate of 0. A bucket with few turns leans on its shape's row, and a shape with
  fewer than 200 on the default table (DEFAULT_OWED_TABLE, fitted on one person's history before 2025).

**Mail owes for two weeks.** An email is answered more slowly than a chat: of the emails one person answered in
2024-26, 87% were answered within 3 days, 94% within a week and 97% within two weeks, and in threads they had answered
before, 8% of the turns still open at 3 days were answered later. So a mail thread's turns (mail/attention.ts) settle
within 14 days (`MAIL_WINDOW`, passed to the fold as `Place.window`), its reply rates count an answer up to then, and
its chance is mail's own table (`DEFAULT_MAIL_OWED_TABLE`): ages from 0 to 14 days (0, 1, 3, 6 and 12 hours, 1, 2, 3,
5, 7 and 10 days) and rate buckets far lower than chat's (edges 0.1, 0.25, 0.5, 0.75), since most mail from a person
is never answered. The hub fits it once a day on its own mail turns (`mail_owed_turn`, and those still open) as it
fits chat's, and keeps it in `mail_setting`. Someone new (a rate of ½) is still shown as owed after 5 days and not
after 10; someone you never answer about never. Changing the window folds every mail thread again (its version in
`mail_setting`).

With the default table, someone you answer 97 times in 100 is worth about 57 points as soon as they write and about
40 six hours later, and needs you; after a day and a half about 20, after two and a half days under 10. Someone you
answer 1 time in 10 stays under 10 and does not.

**Fitted on your history.** The fold keeps every turn it closes (`owed_turn`: when it began, whether and when you
answered, the shape and the author, never what was said), and the turns still open count as unanswered once their 3
days are over. A reaction carries no time, so reacted turns count toward the reply rates but not toward the table.
Each turn is rated as it began, from the turns over by then. The hub fits the table once a day, when the fold has
nothing left to do (after a `FEATURE_VERSION` bump it folds everything again first), keeps it in `meta`
(`owed_table`), and scores everything again with it; mail and the learned order use the same table. `explain` shows
`owed`: the age, the rate and its bucket, the chance and its points, what the formula before gave (`before`), and the
table's fit time and turns per bucket.

**Why.** Until 2026-11-12 the owed points were `60 × p × curve(age)`, with `curve` 1 through the first day and then
halving every 2 days: a turn kept almost all its weight for a day whatever its age said. In
`scripts/owed-replay.ts` (fitted on turns before 2025, measured after), 64% of the hours DMs spent above the line on
their owed points alone in 2025-26 were on turns you never answered; with the table 42%, keeping 83% of the hours on
turns you did answer, with the same order among open turns (AUC 0.75 at 1 h and 6 h against 0.76) and a far better
log loss (0.50 against 0.66 at 1 h). In the hub era: 53% to 25%, keeping 86%.

### Needs a reply

The owed points are `60 × P(needs a reply)`: the chance you answer this turn within the 3 days, given that it is still
open at its age. The owner's definition of "needs a reply" is "I'll want to answer it, on reflection"; whether you
did answer is the label it learns from, and your marks overrule it. `needsreply.ts` works it out with a logistic
model per shape (DMs, and everything else) over:

- the owed table's chance (above), and the age;
- how you answer this person (everywhere) and this conversation **once a turn is that old**: from the latency
  histogram of the tallies the fold keeps, the share of turns still open at that age that you answered, pulled
  toward the table's chance and then the person's (`lateRate`), and how many turns each has;
- for a group, how the turn came to be owed: a mention, a reply, or a small group's question;
- the turn's messages so far, as flags and counts worked out in SQLite (`FACTS_SQL`): whether the newest asks a
  question (a "?") and whether any did, whether any mentions or replies to you, the newest's length, whether it is a
  link, media or sticker, or a short closer ("ok", "thanks", "lol", an emoji), how many messages, how many in a row
  from the same person, and whether someone other than who opened the turn wrote last. No text reaches JavaScript
  except a closer's few characters, and none is kept.

**Fitted on your turns, then calibrated.** Once a day, after the owed table, the hub fits it a slice at a time
(`Attention.fitNeeds`, slices.ts): the 20,000 most recent turns that are over, each at the ages it was still open
(15 and 30 minutes, 1, 2, 3, 6 and 12 hours, 1, 1.5 and 2 days), with the tallies as they stood at that moment and
the turn's first 60 messages from others over two days (one read on `message_conv_ts` per turn). Older turns count
less (half after a year). Then a Platt step fitted on the last 90 days, pulled toward leaving the chances as they are,
keeps "70%" meaning about 70 in 100. It is kept in `meta` (`needs_model`); a fit that fails is tried again an hour later. A shape with fewer than 300 turns keeps the
table's chance. While scoring, an open turn younger than 3 days reads its messages once (again when a message
arrives). "Reply needed" holds the chance at 1, "No reply needed" settles the turn (below); mail uses the table alone.

**Shown.** Each inbox row that owes a reply carries the chance (`needsReply`, to 5 points) beside its ↩: faint after
the age, and as the ↩'s tooltip, "Likely needs a reply: 70%" (from 50%) or "May need a reply: 30%". The owed reason
ends with the same words, so the row's tooltip and its menu's "Why it's here" say it too. A held "Reply needed" shows
no percentage.

**Calibration over time.** The chance shown is kept once per open turn at 15 minutes, 1 hour, 6 hours and 1 day of age
(`needs_prediction`, with the table's chance beside it; a year), and checked against what you did once the 3 days are
over. `GET /api/attention/needs-reply` gives, by the day each turn began, how many, how many answered, the mean
chance, the Brier score and log loss (and the table's Brier on the same turns), and all of them together in ten bins
with AUC. How it sorts shows the bins under "Needs a reply", and the scorecard ([scorecard.md](scorecard.md)) has it day
by day: the mean chance shown against the share answered, and the Brier score of the chance and of the table alone.

**Why, from the backtest** (`scripts/needs-reply-backtest.ts`: every turn folded with the hub's own fold, each model
fitted only on turns over before the year it is tested on, 2022 to the hub era). Turns still open at 15 minutes, 1
hour, 6 hours and 1 day; answered within 3 days:

| 2022 to the hub era | DMs (18,457): AUC | log loss | Brier | groups (5,634): AUC | log loss | Brier |
|---|---|---|---|---|---|---|
| the owed table | 0.768 | 0.523 | 0.176 | 0.726 | 0.443 | 0.140 |
| needs a reply (as the hub fits it) | 0.813 | 0.487 | 0.162 | 0.762 | 0.430 | 0.137 |

Answered within 1 day instead, DMs: AUC 0.725 to 0.754, log loss 0.617 to 0.586. Most of the gain is the per-person
and per-conversation rates at the turn's age; the message flags add a little in DMs (0.810 to 0.813) and nothing in
groups. In the hub era (276 DM turn-ages, 81% answered) AUC 0.926 against 0.914, with the model a little low (more of
your turns were answered than before). Tried and left out: the local model jev asked "Is this a question or request
the reader is expected to answer?" on the newest message (AUC 0.53 alone; 0.819 to 0.822 with it in DMs, worse in
groups), and stays you left without answering (lowered the chance as expected in DMs, 60% answered after one such
stay against 82% with none, but made the model worse out of sample on the 338 turn-ages the visit log covers). The
calibration step is about neutral over the years and helps when your habits move. The inbox replay
(`scripts/inbox-replay.ts --needs`) puts the learned order about even: held-out MRR 0.479 to 0.463, R@5 0.675 to
0.686; on the choosing days MRR 0.396 both, R@5 0.584 to 0.596.

### Marks: "No reply needed" and "Reply needed"

What the table learns from is whether you answered. That stands in for what matters, whether you will want to answer.
A mark says that outright, and overrides it (replymarks.ts, since 2026-11-12):

- **No reply needed** (`none`) on a message settles what was owed up to it, as a reaction does. It counts as
  dismissed (the tally's `dismissed`, and `owed_turn.dismissed`), not as answered and not as addressed, so it does not
  change how often you answer. What they write after it is owed afresh.
- **Reply needed** (`needs`) keeps the turn owed in full (60 points, `owed.held`) at any age for a week from the mark
  (`NEEDS_HOLD`), until you answer. On a message that was not meant for you (a group's chatter) it makes a turn of
  its own (`kind: 'marked'`). The row says "You marked it Reply needed", and its `AttentionView` has
  `replyMark: 'needs'`. It moves the row and never notifies: triage and the phone do not read it.

A mark is on a message, and covers the whole chat as you see it. On a DM of a chat of several routes
(docs/chats.md), No reply needed also settles each other route whose open turn began by then, up to its newest
message from them at or before the one you marked (rows with `origin_id`); undoing it undoes those. The person and
the chat are things a model may learn from later, not rules a mark sets.

**Where.** On inbox rows, by gesture (`ui/ReplyMark.tsx`, since 2026-11-13; until then both were menu items, under
"Why it's here" in a row's menu and in a message's menu):

- **On a computer**, a row's ↩ is a button laid over the ↩ the row draws. Hovered, it shows ✕ and says "No reply
  needed"; a click marks the row without opening the chat. A row with no ↩ shows a faint ↩ in the same place while the
  pointer is on it, "Reply needed". A held row shows its ↩, so a click on it lets the hold go ("No reply needed"). The
  button sits beside the row's own button, so Tab reaches it from the row and a screen reader names it.
- **On a phone**, the same button lies unseen over the ↩ the row draws, so a tap on the ↩ is "No reply needed". A row
  with no ↩ has no Reply needed on a phone; its button is there for a screen reader, out of sight. Rows are not swiped
  (from 2026-11-13 to 11-14 a left swipe marked them): a left swipe on the list is the pager's, bringing back the page
  peeking at the edge.

On a row, No reply needed marks the newest message from them in each route's open turn; Reply needed the newest of them
all. Where the open turn was not meant for you (a group's chatter, so the row API has nothing to mark), Reply needed goes
on the row's newest message through the message endpoint, which makes a turn of its own. Reply needed is offered only
where someone else wrote last and not in notes to self: where you wrote last nothing waits on you. The ↩ goes, or
comes, at once; the hub folds the conversation again a few seconds later, as for your reactions. A toast offers Undo for
10 s. Mail threads in the inbox have No reply needed the same way (hover or a tap on the ↩, on the thread's newest message from
them since the reply you owe began); a thread with no ↩ has no Reply needed, since the mail row's mark needs a reply
owed. Mail's own list (ui/mail/Filing.tsx) keeps its swipes: right archives, left marks read or unread.

**The pager.** With a page peeking at the edge (`rest-peek`), a left swipe anywhere on the lists brings the page back,
and tapping the card does too. Inbox rows take no swipe of their own.

**Kept.** `reply_mark` (one row per message: `target_kind` message or mail, its conversation or thread, the mark,
when, where it was made, the device, `undone_at`). A change goes out with the message's view (`MessageView.replyMark`)
and through the journal like any message change. Marks are not part of the activity log: deleting the log keeps them.

### Unread, alerts and importance

DM messages and mentions count 12 each (up to 3). An unread `@everyone`, `@all`, `@here` or `@topic` counts 6 (up
to 3): it pinged you along with everyone else (`vantage.wildcards`, from the network's own count where it gives one,
else from the messages the hub holds). Other unread messages count 3 each (up to 3). Anything unread adds 8. In the
learned order's `mentions` feature an `@everyone` is half a mention. An unread busy group you never take part in therefore does not need you, and a mention in it lifts
it.

Where triage put the conversation's newest unread message that it put in a tier at all (an alert, a Conversation or
the list: [notifications.md](notifications.md)) counts too (`Attention.input`):

- **A Conversation message** adds `pinged`, 15 points, and the row's reason is triage's first reason for it.
- **An alert** adds those 15 and 40 more (`alerted`), and 1,000 on top of the whole score, the formula's or the
  learned one (`ALERT_PIN`): a conversation with an alert you have not seen sorts before everything else, whatever
  the order learned. Its reason starts "Alerted you:". The pin lasts a day at most (`PIN_FOR`): what could not wait
  an hour is, a day later, an unread message like any other.
- **Its importance**, 0 to 1, adds 25 times itself, whatever its tier. For a message on the list that is the row's
  reason: "On your list: importance 72%".

**Seen.** All three last until you read the conversation, or swipe its notification away on the phone: the app
reports the swipe as `dismissed` ([activity.md](activity.md)), a dismissal at or after that message is read as
seen, and the conversation is scored again at once (`POST /api/activity/notifications` in `server.ts`). It needs the
activity log to be on. The conversation stays unread and no read receipt goes anywhere, but its place at the top, its boost and its
importance stop counting until a newer message lands in a tier.

**Server channels and threads** are not in the list by themselves. One is listed while it holds an unread mention,
or an unread message on the list or above, and is not muted or set to List only; before the tiers it took a mention
or a notification. Swiping its notification away leaves it listed, as an unread row with nothing more to say, until
you read it.

A mail thread has two of the three (`mail/attention.ts`): an alert about an unread message of it is `pinged` and
pinned as a chat's is, with triage's first reason, and a notified message on the list adds its importance. Mail has
no Conversation tier. A swipe is read as seen there too.

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

Per place: messages from others per day, those of them triage put in a tier per day (`pushed`: alerts,
Conversations and list rows), and your engagement (your messages plus visits) per day, all from decayed sums. Then

```
fit = clamp(log2((1 + 4 × engaged) / (1 + received + pushed)) / 5, −1, 1)
```

200 messages a day that you never touch gives −1 (−20 points). A quiet place you answer when it speaks gives a
few points up. The same volume you take part in is not noise. These numbers are kept per place for triage to
use later (`Attention.placeNoise`); triage does not use them yet.

### Muted

A conversation set to Mute or List only on the hub, or muted on its network, sits at −50 plus its recency, below
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
| owed, the chance (after any of the four above) | . Likely needs a reply: 70% · . May need a reply: 30% |
| unread | 2 unread messages · 1 unread mention, 4 more unread · 1 unread mention, 2 @everyone |
| an alert you have not seen | Alerted you: (triage's first reason) |
| an unread Conversation message | triage's first reason as it stands: A direct message · You wrote here in the last day |
| importance, for a message on the list | On your list: importance 72% |
| relationship ≥ 0.3, by its largest part | You talk with Sam often: about 12 messages a week · You spend time here: 2 hours lately · You wrote here 3 hours ago · You answer here 80% of the time · It goes both ways here |
| noise | Busy (about 200 messages a day) and you rarely take part · Quiet, and you take part when it speaks |
| muted | Muted: (where the mute comes from) |
| visited | You were here 5 minutes ago |
| none of the above | Last message 3 days ago |

A row that needs you with a turn you owe shows a small ↩ with how long it has waited, beside its unread count if it
has one (until 2026-11-10 only with nothing unread), and faintly the chance it needs a reply ("Needs a reply" above).

## Features, kept incrementally

The hub keeps per conversation (`conv_feature`) a JSON state folded over its messages in `(ts, rowid)` order up
to a cursor: decayed counts of messages from others, from you and of those triage put in a tier (half-life 30
days), totals, the last times, the open turn, the last message triage put in a tier (`lastPush`), and a tally of
addressed and answered turns with a reply-latency histogram
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
  it, `Attention.triaged` adds the tier or the question; a later full fold reads the stored decision instead.
- **Time**: every 5 minutes all listed conversations are scored again, since an unanswered message ages and
  recency fades. A change in notification rules scores everything at once.

Measured on a copy of a real hub (93,439 messages, 5,234 conversations, 403 listed): folding everything took
1.9 s in 59 steps of at most 35 ms; scoring all 403 takes about 55 ms; the features take 384 KB. That is about
20 µs a message, so a million imported messages fold in about 20 s of background steps. Since the fold also looks
for your reactions (version 2), it is slower: 129,600 messages in 5.7 s on a later copy, about 44 µs a message.
Version 3 counts list rows, with alerts and Conversations, as what triage put in a tier, so a hub's first start with
the tiers folds everything again.

Not followed: a message deleted or edited after it was folded (its mention or reply target) keeps counting
until the conversation folds again. Merging two people leaves their old author rows under the old person until
then too. `POST /api/attention/rebuild` folds again.

## When the list moves

The order is the hub's score, highest first, with muted places last; equal scores go by the latest message (`rank` in
`ordering.ts`). An alert you have not seen is 1,000 points in that score, so it is first. The order on screen is a
snapshot (`inbox.ts`), taken by the same rule as the sidebar's automatic orders (`shouldResort` in `ordering.ts`,
[organize.md](organize.md#when-the-order-changes)): at start, when the app comes back to the front, every 5 minutes,
and with one more reason for the inbox, **activity**: any change in the ranking (a new score, a new conversation, one
gone). None of these happen while anything is in use: a pointer over a list, a touch on one in the last 4 seconds, an
open menu, a drag, or keyboard focus in a list. They retry every 1.5 s until that ends. So the inbox is as current as
a chat app's while you are not touching it, and never moves under your pointer or finger.

The conversation you have open keeps its place across snapshots until you leave it (`inboxSnapshot`'s `hold`; a
person's chat by its one row, whichever of their DMs is open):
reading or answering it changes its score, and it should not jump away while you are in it. Leaving it asks for a
snapshot, so it settles where it now belongs once nothing is in use: with what `visited` adds, near the top.

Between snapshots rows keep their places. A new conversation goes at the end until the next one. Rows that are no longer listed go. Rows slide to their new
places when the order changes (`useFlip`). Before the hub has scored a conversation, or with
a hub that predates scores, it ranks unread first, then by recency.

The inbox button counts the alerts and the Conversation messages of the last week that
you have not read, plus accounts that need you (`inboxBadge` in `packages/web/src/model.ts`). The list does not
count. How it sorts shows the same two numbers beside its Alerts and Conversations, from the same lists
(`packages/web/src/board.ts`). A turn you owe does not raise a badge you cannot clear by reading.

## For you

With no conversation open the right pane is For you, and a phone has a For you tab: single messages from channels,
threads and big groups that triage rated, one per burst, in an order that stays put while you read
([foryou.md](foryou.md)). It replaced Catch up (a queue of the rows that need you, with a reply box on each card) on
2026-11-15: what needs you is the inbox's own rows, ↩ and all. `#/triage`, Catch up's address, opens For you.

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
| bootstrap `attention` | `AttentionView[]`: `{ id, score, needs, reasons, owedSince, replyMark?, needsReply?, at }` for every listed conversation, and `kind: 'mail'` with a mail thread's id for each listed thread |
| event `{ t: 'attention', items, removed }` | changed scores, and conversations no longer listed |
| `GET /api/attention` | `{ now, items }` |
| `GET /api/attention/:conversationId` | everything about one score: the formula's parts, noise, relationship, reply rate, usual reply time; `learned`: the model's open and send chances and points, and the sampled points the inbox sorts by while exploring |
| `GET /api/attention/needs-reply` | `?days=60`: how the "needs a reply" chances held up (`NeedsReplyCalibration`): by day, in bins, against the table's |
| `GET /api/attention/model` | the learned order: its mode, when it last learned and from how many opens, its prior, what it learned as changes to weights on named features, the examination curve (fitted, the guess, and how often the list was on screen down to each row), and exploring (`explore`) |
| `GET /api/attention/waiting` | `{ waiting }`: whether scores are still to come out of what already happened (a conversation to send, to fold, or stale and waiting out its 5 s); scripts/verify-response.ts waits for false after each click |
| `POST /api/attention/rebuild` | `{ conversations?: string[] }`: fold these, or all, again from the start |
| `POST /api/messages/:id/reply-mark` | `{ mark: 'none' \| 'needs' \| null, surface?, device? }` on a message from someone else: set, change or take back a mark (null) → `{ mark, marked }`, the messages it touched (other routes included) |
| `POST /api/mail/messages/:id/reply-mark` | the same on a mail message |
| `POST /api/reply-mark` | `{ targetKind: 'conversation' \| 'mail', ids, mark, device? }`: an inbox row (each route of a chat, or a thread). `none` and `needs` as above; null takes back Reply needed on the open turn → `{ mark, marked }` |

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
the rows near the top more, so they get opened more whatever they are. That is the examination chance
(`examination`). It does not reorder anything by itself, since putting the likeliest rows where you look most is
already what sorting by value does. What it changes is the learning: an open from an inbox row counts
`1 / examination(position)` times, with the position the visit log kept (at most 10 times). An open from a
notification, Ctrl+K or search counts once.

### Seeing a row

Until 2026-11-10 the examination chance was a guess, `(1 + position)^−0.5`: half at the 4th row, a third at the 9th.
Now each refit also fits it to your own opens, as a position-based click model: an open from the inbox at position
k happens with chance examination(k) × the open chance, and the two are fitted in turn (`curveFit`, `FIT` in
`rank.ts`):

1. the open chance, with the guess;
2. the curve that makes your inbox opens likeliest given that open chance: per stretch of rows (1, 2, 3, 4–5, 6–8,
   9–12, 13–20, 21–35, 36–60, 61–100, 101 and on), the value where the opens there match what the rows not opened
   there say, relative to the top row;
3. the open chance again with that curve; then 2 and 3 once more.

Rows opened from elsewhere say nothing about the inbox and are left out of step 2. Where a row stood is the
visit log's position for what you opened, and the formula's one list at that moment for the rest (the log keeps
only the first; the formula is what the inbox showed, near enough). Each stretch is pulled toward the guess by 3
opens' worth, so a few far-down opens cannot move it much; it never rises further down (pooled where it would), and
it stays between 0.1 and 1, so an open still counts at most 10 times.

On the real hub (2026-11-10, 346 opens) it is flat over the first screenful and then falls: 1 for rows 1 to 8, 0.69
for 9 to 12, 0.41 for 13 to 100, and 0.1 from 101. The guess said 0.33 by the 9th row, so it counted opens from rows 2
to 12 up to three times too much and opens from far down too little. `GET /api/attention/model` shows it beside the
guess (`examination.rows`), and `fittedFrom`, how many rows opened from the inbox it was fitted from.

In the replay (7 days, 359 opens, the last 3 held out with 180), the fitted curve against the guess: +0.017 (95%
interval 0.001 to 0.030) on the choosing days, +0.014 (−0.006 to 0.034) on the held-out days, +0.018 (0.003 to 0.033)
over every day after the first (305 opens), and +0.053 (0.020 to 0.087) on held-out opens from elsewhere, which the
order on screen cannot have favoured. Going back to a chat you were just in no longer loses: against the formula it
went from −0.035 to +0.008 (−0.039 to 0.044), and the learned order against the formula from +0.014 to +0.028
(−0.003 to 0.064) held out, +0.029 (0.001 to 0.052) over every day after the first. Regression-EM (Wang et al.
2018), which instead counts a row not opened as possibly wanted but unseen, found the same shape a little lower
(0.55 at rows 9 to 12, about 0.22 from 13 to 60) and did no better than the guess held out (−0.001), so the weights stay inverse
propensities (`--curve` in the replay compares the three).

**How far down you looked.** Since 2026-11-10 each stay in the activity log also keeps `depth`: the deepest inbox row
that was on screen during it, when the list was on screen (on a desktop, beside the conversation; on a phone, the
inbox screen). Only the number, never which rows ([activity.md](activity.md)). `GET /api/attention/model` shows, per
stretch of rows, the share of those stays that showed it (`onScreen`). It is what the fitted curve can be checked
against, and a ceiling a later fit can use: a row that was never on screen cannot have been seen.

**Features**, all metadata: the formula's score, how long since you were there (an hour and a day half-life, and
never), since the latest message (the same two), since you wrote, unread messages and mentions, the owed and
conversation-going-on parts, an alert or Conversation message still unread (`pinged`), relationship strength, noise,
decayed visits and minutes, and the shape (DM, group, notes). Never what was said. Triage's importance reaches it
only through the formula's score. The inbox as rebuilt for learning (`seenAt` in `rankhistory.ts`) reads alerts,
Conversations and importance as the live score does; it does not replay a swipe, so a row swiped away counts a
little more there than it did.

**What triage knows, tried as features (2026-11-10, before the tiers).** Under the four levels the tiers replaced:
where triage put the newest unread message it decided on (Important, Active, Digest, Not interesting, or none: your
vote if you had cast one by then, else its decision), and your votes on the conversation's messages lately, up and
down (decayed, half-life two weeks), as features of both chances (`TRIAGE_FEATURES` in `rank.ts`). No hand-set
weight for importance: if opens and replies follow it, the features would carry it. In the replay they did not help:
with them the learned order was −0.003 (−0.008 to 0.001) on the choosing days, −0.007 (−0.019 to 0.003) held out
(180 opens) and −0.016 (−0.042 to 0.004) on held-out opens from elsewhere; the level of the newest message read or
not did no better (−0.002). What the level said was mostly there already: a notification still unread was `pinged`,
and unread and mentions count the rest. And there were 28 votes in all, none of them up, so the vote features had
almost nothing to learn from. So the hub keeps them at the prior's 0 (an infinite pull in `LAMBDA`) and does not
work them out; `inbox-replay.ts --triage` learns them again. They still read the stored codes and the votes from
before the tiers; marks are not among them. Since the tiers, what triage knows is in the formula itself: `pinged`,
the alert's place at the top and `importance` ([above](#unread-alerts-and-importance)).

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
  prior, with the examination curve ([Seeing a row](#seeing-a-row)), and saves the result in `meta`.
- It refits at start if it has never learned or its saved model predates the fitted curve and exploring, a day after
  the last refit, and after 10 more opens have had their 3 hours.
- The work runs on a read-only connection of its own, at most about 25 ms at a time. Measured on a copy of the
  real hub (184 opens, 675K messages): the longest the hub was held was 86 ms, and the whole refit took about 10 s
  in the background. Scoring all 484 listed conversations took 185 ms with the model, the same as without. On a
  later copy (2026-11-10, 346 opens, 30,172 rows) the refit took 17.3 s with the fitted curve and 16.7 s with the
  guess; the longest hold was about 125 ms either way. Working out how sure it is ([Exploring](#exploring)) adds
  about half a second in the same steps (17.5 to 18.0 s, 348 opens) and nothing to the longest hold; the model
  saved in `meta` grows to about 10 KB.
- Clearing the activity log puts it back to the prior at the next check (every 30 minutes).

`DITHER_INBOX_RANK`: `model` (the default) sorts by it; `shadow` works it out and shows it in
`GET /api/attention/:id` without sorting by it; `off` does neither. `DITHER_INBOX_EXPLORE`: `1` (the default) sorts
by a sample of it ([Exploring](#exploring)); `0` sorts by its mean, exactly as before exploring. `DITHER_INBOX_MAIL`:
the order with mail ([Mail in the learned order](#mail-in-the-learned-order)).

### Mail in the learned order

Mail threads from a person are rows of the same inbox (mail.md). One model for both: a second model, **the order with
mail**, learns from the opens of chats and mail threads alike, and when it is turned on chats and mail compete in one
ranking. Until then it runs in shadow.

- **Mail opens** are in the visit log as `mail` stays on the thread's id (`mth_…`), from a thread's chat or an inbox
  row, with the row's position when opened from the inbox, as a chat's (`web/src/activity.ts`). A person's chat open on
  their email route counts as a stay on that route's newest thread. Before 2026-11-20 a mail row's open was a
  `conversation` stay with the thread's id, and the Mail page's (gone since 2026-11-23) had none; the rebuild reads
  both.
- **The rebuild** (`rankhistory.ts`, `loadWorld`'s `mail`) adds every thread the one-list inbox may have listed: from a
  person, in Inbox, not muted, on an account not hidden, and, if personal only because the sender looks human, rated
  by mail triage. Their messages fold in the same time order as the chats' (a second query, merged by time), as
  `mail/attention.ts` folds them; each moment lists a thread by `MAIL_INBOX`'s rules as of then. What is not replayed
  is as it is now: the account, flagged, the class, roles and mutes.
- **The features** are the chats' where they mean the same thing (the formula, unread, To you as a mention, the reply
  you owe, a conversation going on, you were here, relationship, direct or group), and mail's own (`MAIL_FEATURES` in
  `rank.ts`), 0 on every chat's row: `mail`; how the latest message from someone else reached you, `mailTo` or `mailCc`
  (neither: Bcc or a list); `mailUnknown`, a person only because they look human; `mailFlagged`; the account,
  `mailGoogle` or `mailProton` (IMAP neither); `mailKnown`, the sender is a person the hub knows; and `mailBond`, how
  close you are to them, from the people graph's closeness (people-graph.md "Who matters"): their months before this
  one, each halved every three months back, as log(1 + x) / 5. All start at 0 and are pulled to it as the rest are.
- **Fitting**: each refit rebuilds once and fits both: the first model on the moments of chats alone (unchanged by
  mail), the order with mail on every moment. It is saved apart (`meta` `inbox_rank_mail`) with its version
  (`MAIL_MODEL_VERSION`): a model of another version is the prior, and fitted again at the next check. So a refit
  does about twice the fitting it did, in the same slices, and asks the people graph for its closeness (worked out on
  its own thread, kept for half an hour).
- **In shadow** (`DITHER_INBOX_MAIL=shadow`, the default) every row, chat or mail, carries the order with mail's score
  as `AttentionView.shadow` (its mean, in the formula's points, with an alert's pin): chats keep the first model's
  score, mail rows the formula's. Muted places have none. A device opening an inbox row records where the row would
  have stood had the inbox been sorted by `shadow` (`shadowRank`, `web/src/visits.ts` `shadowRankOf`), beside the
  `rank` it was at.
- **Comparing**: the scorecard's "Mail in the inbox" chart, day by day: the mean of 1 ÷ row as shown and in the
  shadow order, for every row and for mail rows alone, over the same opens (scorecard.md). Rows were seen where they
  were shown, so the order shown has the better of it there; the shadow order closing the gap says more than its
  level. The replay's `--mail` compares them without that lean ([The replay](#the-replay)).
- `DITHER_INBOX_MAIL=model` sorts chats and mail by the order with mail (with exploring, as the first model); a mail
  row moved far from its formula says "Higher: you often open mail like this …". `off` neither fits nor scores it.
  `GET /api/attention/model` shows both models (`withMail`); `GET /api/attention/:id` the row's `learned.withMail`,
  and for a mail thread what the order read of it (`learned.mail`).

### The floor

Some things can only count for a row, never against it: something unread, a mention, a reply you owe, a
conversation going on, an alert or a Conversation message waiting, a DM (`FLOORED` in `rank.ts`: `unread`,
`mentions`, `owed`, `live`, `pinged`, `direct`). When the open chance is fitted, the weights of these may rise above
the prior's and may not fall below it (`fitSteps`' `floor`, part of `FIT`). The prior gives each of them 0 on top of
what the formula's score already carries, so the model can add to what the formula gives them and never take away.
The send chance has no floor.

**Why.** A week of opens once taught the model that unread DMs you owe a reply in are opened less. They were at the
top of the list anyway, so every open of something else counted against them, and a fresh DM sank to row 14.

**What it costs.** Next to nothing. In the replay of 2026-11-10 (8 days, 443 opens of a listed conversation, the
last 3 days held out with 207; `--floor` adds `no-floor`, the same model fitted without it), the held-out MRR is
0.400 with the floor and 0.400 without. Paired on the same opens, taking the floor away is worth −0.004 (95% interval
−0.015 to 0.008) on the choosing days, −0.000 (−0.015 to 0.013) held out, and −0.003 (−0.012 to 0.009) over every day
after the first (389 opens): each interval spans zero. Only on the 74 held-out opens from elsewhere is the model
without the floor a little ahead, +0.014 (0.002 to 0.029). Flooring the formula's own weight as well (`floor-formula`
in the replay) was tried and is worse, −0.013 (−0.025 to −0.002) over every day after the first, so the formula's
weight stays free. In that run the learned order with the floor was ahead of the formula's one list by +0.051 (0.018
to 0.077) held out, and by +0.042 (0.025 to 0.062) over every day after the first.

### Exploring

An order that only ever shows what it already believes in learns little about the rest: a conversation it ranks low
is seldom opened from the inbox, so it stays low. So the order is a Thompson sample of the model, not its mean
(`rank.ts`: `posteriorSteps`, `drawZ`, `predict` with a draw; `ranker.ts`):

- **How sure it is.** At each refit, the uncertainty of each chance's weights, by the Laplace approximation: the pull
  to the prior is a Gaussian prior, so near the fit the weights are about Gaussian, with covariance the inverse of the
  Hessian there (the rows' `w·p(1 − p)·xxᵀ` plus the pulls). An open is a row of every moment in the 3 hours before
  it, about 7 on the real hub, so the rows say each open several times over; the open chance's covariance is widened
  by that count (`cov.repeat`). Features kept at the prior have none.
- **One row's doubt** is the spread of its log-odds, `sd = sqrt(xᵀΣx)`: small for a row like many it has seen, larger
  for an unusual one (one you never visited, a shape or a mix of signals it has rarely seen).
- **The sample.** Each chance's log-odds moves by `sd × z`, with `z` a standard normal draw clipped to ±2, one per
  chance per conversation, seeded by the conversation and the epoch. The epoch changes every 30 minutes and at every
  refit, so between them a row's draw holds and live updates move it only as its features change; the client's
  snapshot rules ([When the list moves](#when-the-list-moves)) still decide when the order on screen changes. A row
  the model is sure of barely moves, so a reply you owe someone close stays where it was; one it knows little about
  sometimes rises into view.
- **A floor.** Each spread is at least 0.4 in log-odds (`EXPLORE_FLOOR`). As opens piled up the fit grew sure of
  nearly every row, and the sample all but stopped straying: by 2026-11-14 a row lifted 10 points or more came into
  the first ten at 0.3% of held-out opens, against 7% to 26% when exploring began. The order you see is then the mean,
  and what sits lower down stays there. With the floor every row moves a little, a sure one included (with the draw's
  clip, at most 0.8 in log-odds, about 12 points), so something from further down comes into view now and then.
- **Why.** A row the sample lifted by 10 points or more says so, first: "Shown higher to learn: not much history with
  this one yet", in its tooltip and menu, and on How it sorts' *Why* for that conversation.
- **Still learning without bias.** The visit log keeps the position the row had on screen when you opened it, which
  with exploring is where the sample put it, and that is the position the examination weighting and the curve's fit
  use ([Seeing a row](#seeing-a-row)). Rows not opened are placed by the formula's list, as before.

`GET /api/attention/:id`'s `learned` has the mean (`points`) and the sample the inbox sorts by (`sampled`);
`GET /api/attention/model` has `explore`: on or off, whether the model has a covariance yet (a fresh hub, on the
prior, does not explore), the epoch, the clip and the floor.

**What it costs.** In the replay (`--explore`: the learned order sorted by 20 seeds' samples against its mean; 7 days,
the last 3 held out): MRR 0.436 against 0.447 on the held-out days (−0.011, 95% interval −0.020 to 0.003; across seeds
0.418 to 0.453), and −0.016 (−0.030 to −0.006) over every day after the first. Where the model had little to go on,
on the first days, it explores more and costs more: −0.025 (−0.042 to −0.002). A row lifted 10 points or more came
into the first ten at 7% of held-out opens and 26% over every day after the first. The median row's spread was
0.20 in log-odds, the largest 1.25. The rule was to keep the cost under about 0.02; it is.

**The floor's cost** (2026-11-14; 12 days, 757 opens, the last 3 days and 274 opens held out; `--explore-floor`).
Without a floor the sample cost −0.013 on the held-out days (95% interval −0.022 to −0.003) and lifted a row into
the first ten at 0.3% of them; the median spread had fallen to 0.13. By floor, held out:

| floor | MRR, sampled minus mean (95% interval) | a row lifted into the first ten |
|---|---|---|
| none, 0.2 | −0.013 (−0.022 to −0.003) | 0.3% of opens |
| 0.3 | −0.016 (−0.025 to −0.004) | 1.6% |
| **0.4** | −0.019 (−0.029 to −0.007) | 21% |
| 0.5 | −0.023 (−0.035 to −0.010) | 42% |

0.4 brings the lifts back to about where they were when exploring began, for −0.006 more than no floor, and keeps
inside the 0.02 rule; 0.5 does not. Over every day after the first: −0.018 (−0.023 to −0.013), lifts at 29% of
opens.

**What it buys cannot be measured here.** The replay can only score orders against what you opened from the orders
you were shown; what exploring is for, opens of conversations the mean order would have kept out of view, and the
better model they make, only shows in the activity log once it has run. Rerun the replay after a few weeks: a
learned order that keeps pulling further ahead of the formula is the sign. `DITHER_INBOX_EXPLORE=0` turns it off.

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
better. A curve fitted to your own opens replaced the guess ([Seeing a row](#seeing-a-row)). Inbox clicks also favour the order that was on
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

Day by day, live, the scorecard follows the order too: the mean of 1 ÷ row and the share of opens from the first
8 rows, for opens from an inbox row ([scorecard.md](scorecard.md)).

`scripts/inbox-replay.ts` replays the activity log against a copy of a hub (made read-only with `VACUUM INTO`) and
asks, at every moment you opened a conversation, at which position each ordering would have shown it. It rebuilds
the world at that moment: every candidate's features folded up to then (the same fold as the hub), what was unread
(messages from others since you last wrote or stayed there; before the log starts, everything counts as read),
where you had been (the log's stays) and the mutes as they are now. App starts and resuming are not choices and are
left out; a person's page counts as the best of their DMs. The earlier days are for choosing weights, the last three
are held out (two until 2026-11-10). It writes counts and rates only.

```
bun scripts/inbox-replay.ts --live .data/hub.sqlite --out <scratch dir> [--holdout 3] [--grid] [--model-grid] [--calibrate] [--curve] [--triage] [--floor] [--explore] [--mail]
```

`--mail` adds mail threads to the world ([Mail in the learned order](#mail-in-the-learned-order)): `learned` is then
the order with mail, and `learned-now` the inbox while it runs in shadow (chats by the learned order fitted on chats
alone, mail by the formula's points). The report's "Mail in the learned order" compares the two on mail opens and on
chat opens, and lists mail's weights at the start of the last day.

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

The backtest above asked jev this on the newest message of each turn and found almost nothing over the per-person
rates ("Needs a reply"), so nothing asks it. `AttentionJudge` in `attention.ts` is the interface. Its `rank` is the learned order's way in (above). Its `judge`:
given a few candidate conversations (the top of the ranking with an open turn, say) and their latest message ids,
it answers per conversation
`{ needsReply: 0..1, importance: 0..1, reason }`. Answers go in `Attention.judged`, and `scoreConversation`
already uses them: `p` becomes the mean of the reply rate and `needsReply`, its `importance` adds up to 10 points
(the `judged` part, apart from triage's importance above), and the reason shows as "Model: …". Nothing implements it
yet. It should follow the way triage asks its one question about an alert (`triage.ts` `judge`, `main.ts`
`alertJudge`): the machine's local model, a fixed question, a short timeout, and going on without an answer. Your
corrections would come from triage's marks and, once added, a "doesn't need me" action on an inbox row. Run it off
the ingest path, on a timer or after a sync, for a handful of conversations at a time. In the inbox this is the only
part that would read message text, and only in the local model.

What you actually did with notifications and chats, as labelled data for this model and for triage's, is in the
activity log ([activity.md](activity.md)): open rate after a push, time to open, dwell, replies after opening, and
how often you open a place nobody pushed you about. `GET /api/attention/:id` includes those features; the formula does
not use them. The learned order learns from the same log (above).
