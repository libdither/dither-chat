# Notifications: one loudness scale, the tiers beside it, and what they learn from you

Every new message from someone else gets a **loudness**, 0 to 100, on [one scale](#one-scale-loudness): what it is
worth to see it now rather than later, against what an interruption costs at that moment. Where it falls says how it
reaches you: it sounds, shows silently in the shade, sits in the inbox, or stays unread in its chat. It learns mostly
from your answers: Louder and Quieter on a message, Sound, Show or Inbox on [the calibration
feed](#the-calibration-feed), and the buttons on a notification.

The scale replaces [the three tiers](#the-tiers) (Alert, Conversation, List) once it is switched on. Until then it is
worked out beside them, in shadow: shown on each message's bell and scored, while the tiers still decide what is sent.
`DITHER_ATTENTION` on the hub picks: `tiers` (the scale off), `shadow` (the default) or `on`.

## One scale: loudness

| Band | Loudness | Reaches you |
| --- | --- | --- |
| **Sound** | 80 to 100 | sounds, with a heads-up; a notification on a computer |
| **Show** | 30 to 80 | silent and minimized: in the phone's shade only (no sound, status-bar icon or lock-screen card); a silent notification on a computer |
| **Inbox** | 10 to 30 | nothing sent; listed in the inbox |
| **Unread** | 0 to 10 | unread in its chat only |

The number is worked out from four separate parts (`packages/hub/src/loudness.ts`):

- **Want**: the chance you would be glad to have seen it at all. It starts from the importance (below) and the
  Conversation reasons (a DM, about you, one of your keywords, a chat you wrote in, one where you answer), each with a
  strong start.
- **Can wait**: how long it can wait, as a chance over four half-lives (10 minutes, an hour, 6 hours, a week). It
  starts from the local model's answer to the alert question, where it was asked, and the same reasons.
- **Owed**: a person waiting on your reply (people only, never a channel), growing with how long they have waited.
- **The moment's cost**: what a sound costs now. It starts at one and is dearer while a computer is in use, at night,
  and minutes after another sound. It is learned for each kind of moment, from your answers about sounds then.

What is lost by waiting is `want × Σ wait_k (1 − 2^(−delay/h_k)) + owed × min(delay, day) / day`. The hub weighs five
steps, each with its delay and its interruption cost (a sound 3 minutes; worth showing within 20 minutes, 55 to 80;
worth showing within 3 hours, 30 to 55; the inbox 8 hours; unread a day); the step picked is the one worth most, and
the number sits within that step's range by how clearly it won. The two middle steps are both **Show**: they keep the
number where it was before the bands were four, so nothing that sounded sounds more or less. There is **no budget**:
nothing caps the sounds a day. Settings shows how many sounded today, for your information, and has one nudge on what
was learned: **Less readily / As it learned / More readily**.

Your rules stay absolute: Always alert is 100, Mute 0, List only caps it at a quiet row (below 55), quiet hours take
the sound band away (it shows silently instead), and a message its sender sent silently goes no higher than show.
Nothing explores on sounds: no message is made louder to learn from it. A notification's row keeps its loudest band
for an hour, so a quieter message after a sound does not take its place silently.

Several Show notifications fold into one row of the shade on Android, *N chats* ([android.md](android.md)); the fold is
only how they look, each still comes when its message does. Browsers group an app's notifications themselves.

The decision codes stay the tiers' (`push`, `quiet`, `digest`, `drop`): with the scale on, sound is `push`, show
`quiet`, the inbox `digest`, unread `drop`. A message's `triage` carries `loudness`, the number; its bell fetches the
whole of it (`GET /api/messages/:id/loudness`: band, parts and reasons).

**Next look went** (2026-11-25). There was a fifth band, 30 to 55, held for one silent bundle when you unlocked the
phone, opened the app or at set times. It is gone, with its unlock and set-time sending and its settings: what fell in
it shows now, minimized. The hub's migration (`bandsWithoutNextLook` in `store.ts`, once) rewrote what was stored as
next look to show: the scale's view on each message (`triage.loud_view`), the old check-ins' bands, the answers'
bands (`attn_answer.band`), and dropped the `next_look` table and the `nextLook` and `times` settings. The model's
targets are kept by answer, not by band, so they needed nothing; the replay reads next look as show.

### Why, on every message

A message's bell shows its tier's reasons, then the scale: where it sits, its band, and the reasons with how many
points each moved it (each taken away in turn). Under them, **Louder** and **Quieter** for this person and for this
chat, and *What it learned*, which opens its part of Settings.

### Answers

What you say about a message. Each answer changes only the part of the model it names.

| From | Answers |
| --- | --- |
| A message's bell, menu or the phone's sheet | **Louder**, **Quieter** (for its kind, or for the person or chat) |
| A notification that sounded | **Worth it**, **Could have waited** |
| A silent one | **Louder** |
| A list row | **Quieter**, **Louder** |
| The calibration feed | **Sound**, **Show**, **Inbox**, and what it was wrong about |

An answer from a notification's button takes the notification's place with a silent one: **Noted: Worth it** and what
it changes ("More like this will sound."), which closes itself after four seconds once the hub has the answer, or
**Answer not saved** and why (the hub refused it, or could not be reached), which stays.

After Louder, Quieter, Could have waited or Shouldn't have reached me it may ask **why**, once, and it can be skipped:
chips (it could have waited, not this chat, not this person, not this topic, a bad moment, already seen it; or, for
louder, time-sensitive, this person matters, this chat matters, this topic matters, I was free), how long it could
have waited (or when you'd have wanted it), your own words, and an optional end date (*until …*). Your words are read
by the local model on the hub's machine and mapped to a chip; they are not kept (the hub stores only the chip, and the
local model's cache keeps only a hash of the question and the words, with its answer). It asks at most once a chat a day,
and never twice in a row for the same answer.

A reason routes the answer: *not this chat* moves only that chat's want, *not this person* the person's, *not this
topic* the words, *it could have waited* and the wait chips only the can-wait part, *a bad moment* only the moment's
cost. Louder and Quieter also stand as the marks they replace (below), so the tiers keep learning from them: Louder as
Should have alerted; Quieter as Alert was wrong on an alert and Less like this elsewhere; Could have waited on an
alert as the old Not urgent; Shouldn't have reached me as Less like this (and Alert was wrong on an alert). A mark
taken back on the old route takes back the answer it stood as.

### The calibration feed

One page, **Notification calibration** (`#/calibration`, `calfeed.ts`, `CalibrationPane.tsx`), of the last three
days' notifications as they looked, each with three answers: **Sound**, **Show**, **Inbox**. Nothing pops up for it
anywhere: the inbox has a quiet row with the count of cards waiting, like Requests and Notices (no sound, no push), and
Settings → *Ask me* links to it.

Each item draws the notification as you came across it: its picture, network, who, the text and the time, in the look
it had (the phone's shade, a toast or browser notification, or only a row in the app when none went out). Under each
answer a bar, on a fixed scale of 0 to 100%:

- its fill is the chance the model gave that answer, and a whisker how unsure it was;
- **▲** marks what you did, read from how soon you opened, tapped or answered it (within 10 minutes of a sound or
  shown: Sound; within 3 hours: Show; later or never: Inbox);
- the underlined answer is what the model did (it sounded, showed silently, or sent nothing).

The chances are the loudness blurred by how few answers there are about that person or chat (a normal spread of 30
points with none, down to 4), cut at the bands. Tapping an answer sends it and draws the chances again as the model
gives them after learning it, with a dashed line at the old one. **What was it wrong about?** then opens six parts: the
person, the chat, the topic, can wait, the moment and the delivery, each with a small bar of which way it pushed this
one (from taking that part away). Picking parts routes the answer to them only and draws the after-bars again: the
person moves only want and owed for that author, the chat only that chat's, the topic only the words, can wait only the
wait, the moment only the moment's cost, and the delivery (it went to the wrong device, or late) teaches the scale
nothing. With no part picked the answer moves all of them a little. The parts picked are kept with the answer
(`attn_answer.parts`). The context line (where it was seen, whether it sounded, while a computer was in use) and what
moved it, by how many points, are under a closed `<details>`, as is **Open the chat**.

**Worth asking.** Each notification gets a score:

```
surprise    = −log₂ P(what you did), capped at 5 bits
unsure      = spread of its guess (entropy over the three, 0 to 1) × few answers (1 / (1 + n/5))
worth asking = (0.6 · surprise/5 + 0.4 · unsure) × 2^(−age / 3 days)
```

Those over 0.5 may open as **cards**, about three a day (*Ask me*: never, one a day, up to three): each is drawn at
random with a chance in proportion to its score, `min(1, per day × worth / the day's total)`, and that chance is kept
(`cal_item.chance`). The scorecard and the learner weigh a card's answer back by it (`min(3, max(1, 0.5 / chance))`),
so the cards' lean towards surprises does not tilt what is learned. The rest are compact **rows**, three small bars
each; tapping one opens it in place as a card. The hub draws once an hour, and when the page or the inbox row asks.

**A past answer comes back once**, as a dashed card a day after you gave it, when the model had given that answer
under 20%: what you said, its guess then and its guess now. **Keep** leaves it learned; **Only that once** says it was a
one-off: it stays in the history but teaches nothing from then on (`attn_answer.until`); **Undo** takes it back, with
the mark it stood as.

**The ones it is sure of** sit under a closed *N it was sure of* at the end, only when all of these hold: it gave
what you did 95% or more, there are 30 or more answers about that person or chat, none of them against it in 30 days,
and it was not a sound held back (quiet hours, a computer in use, a burst). One in 20 of them is still shown, at
random, and says so.

On a phone: one column; **×** at a card's or row's top right skips it, and so does a swipe of about 100 px sideways,
with **Undo** on the toast. On a computer: the list on the left, the chosen one open on the right; × shows on hover,
**1**–**3** answer, **x** skips, **j** and **k** move, **w** opens what it was wrong about. Escape goes back, as
everywhere ([desktop.md](desktop.md)). Cards and past answers wait up to two weeks; a skip is kept and never counts as an
answer. A late answer counts a little less in what is learned: in full within a day of the message, then in a straight
line down to half at two weeks (`lateWeight`).

#### Where you saw it

Each item's look and context line come from what the hub keeps (`seen.ts`): the notification as the hub composed it
(title, body, the grouped lines with who wrote each, the chat, the tier, whether it was meant to sound, whether a
computer was in use; `notification.title`, `body`, `look`, `computer_in_use`, kept 15 days, `WORDS_KEPT`, then
cleared), each push registration it went to (`notification_device`: its label then, the Android app or a browser), and
each device's own word on where it showed it (`notification_event.seen`, codes and ids only):

| | Android app | Web Push (sw.js) | The open page |
|---|---|---|---|
| where | lock screen (keyguard locked), heads-up (an alert with the screen on), shade, or a row of the phone's list | a browser notification | its toast (`inapp`) |
| sound | silent for what is not an alert or under Do Not Disturb; else the ringer: sound, vibrate, silent | as the hub asked (a browser cannot say what the system did) | silent |
| beside it | the tags of our other notifications showing | not known: asking the browser while another push is still being drawn drops that one for good | |
| also | locked, screen on | whether a page of the app was open | |

Then the push it skipped (`push_skip`: watched on a computer, or capped) and the first time you opened its chat after
it came and from which list (`visit.source`, on which device). All of it stays in the hub's database. A demo world
seeds every kind of item with invented devices (`demo-calibration.ts`): cards in the shade, as a toast and as a row,
past answers, rows, and sure ones.

### What it learns from

Answers count most (weight 1; a feed answer late a little less, and a card's weighed by its chance: above), as do the
marks from before. Then what you did: a reply 0.3, an open of five seconds or more 0.1 (never one right after a sound,
which says only that it sounded), a swipe 0.05. Each part is fitted with the same L2 pooling as the importance. *What
it learned* in Settings lists what moved most, each with **Forget**. A feed answer also stands as a mark: Show or
Inbox on one that sounded as Alert was wrong, Sound on one that did not as Should have alerted.

### Settings

Settings → Notifications: how readily it sounds, **the computer comes first** (while a computer is in use, a chat
open and read there sends nothing to the phone), how many cards a day open on the calibration feed, a note on people
you're drifting from, and what it learned. Quiet hours stay where they were.

### The replay

`scripts/loudness-replay.ts` runs the scale as it starts (no answers yet) over the last 30 days of a hub's decisions,
on a copy of its database, and writes counts only. On one person's hub (22 days with 50 or more decisions, 632,575
decisions):

| A day | Loudness | Tiers |
| --- | --- | --- |
| Messages that would sound | 4 | 5.8 |
| Sounds on the devices (once a chat's five minutes) | 4 | 3.5 |
| Busiest day's sounds | 9 | 17 |

Of the 1,056 messages answered within 30 minutes, the scale put 84.7% at show or louder; the tiers made 82.1% an
alert or a Conversation. Most of the rest are group messages with no Conversation reason, which the tiers miss too.

## The tiers

What decides until the scale is switched on (`DITHER_ATTENTION=on`). Triage puts every new message from someone else in one of three tiers, below them, or silences it:

| Tier | `decision` | Decided by | Phone | Desktop | Inbox |
| --- | --- | --- | --- | --- | --- |
| **Alert** | `push` | the alert chance at 0.5 or more, or a rule of yours (a person or place set to Always alert) | sounds, with a heads-up | a notification, and a toast in an open page | first in the list until you have seen it |
| **Conversation** | `quiet` | a rule, no model: a DM, a mention of you, a reply to you or one of your keywords, a chat you wrote in during the last day, or one where you usually answer | a silent row of its own, in Android's Conversations section | nothing | a boost while it is unread |
| **List** | `digest` | its importance is at or above your level (0.6 until you set it) | a silent row in one collapsed bundle, sorted by importance, when [the phone's list](#the-phones-list) lets it through | nothing | listed, and its importance counts toward its place |
| **Below the list** | `drop` | its importance is under your level | nothing | nothing | unread in its chat, nowhere else |
| silent | `silent` | a place you muted, a message request you have not accepted, a like, repost or follow in a [feed](#the-feed) | nothing | nothing | the unread badge only |

An Alert is for what cannot wait an hour or two. A Conversation is people talking with you. The List is whatever else
is important enough for a ranked list on the phone. The rest stays unread in its chat.

The stored codes (`push`, `quiet`, `digest`, `drop`, `silent`) are those of the four levels the tiers replaced. Only
what they mean and what the app calls them changed (`TIER_LABEL` in `packages/protocol/src/ontology.ts`). If you knew
the levels, [What was removed](#what-was-removed) and [The migration](#the-migration) say what became of them.

Two chances are worked out for a message, each from 0 to 1 (`P.TriageProbs`): `alert`, that it cannot wait, and
`important`, that you would want to see it. `TriageView.score` is the importance. Whether a message is a Conversation
is a rule, not a chance.

The numbers quoted on this page come from replaying ten days of one person's hub
([triage-replay.md](triage-replay.md)), unless it says otherwise.

Code: `packages/hub/src/triage.ts` (the decision, the rules, quiet hours), `tiers.ts` (the Conversation rule),
`learn.ts` (the two chances and how they are learned, pure), `votes.ts` (marks, training, the policy view, the
candidate model), `labels.ts` (labels from what you did), `interact.ts` (who wrote when: the openings tally, and the
interaction features), `shadow.ts` (the shadow summary), `delivery.ts` (one notification per conversation),
`phonelist.ts` (which list rows reach the phones), `notify.ts` (sending), `main.ts` (`judgeLate`, `alertJudge`),
`attention.ts` and `rank.ts` (the inbox, [inbox.md](inbox.md)), `mail/triage.ts` (mail); `scripts/triage-replay.ts` (the offline replay); `packages/web/src/triage.ts`,
`ui/HowItSorts.tsx` (How it sorts), `public/sw.js`; `apps/android/.../Notifications.kt` ([android.md](android.md)).

## The decision

For every new live message from someone else, in this order (`triage.ts`, `Triage.decide`):

1. **Silent**, when its place is muted (a rule of Mute on the conversation or on anything above it) or it is in a
   message request you have not accepted. Nothing more is worked out, and such a decision cannot be marked.
2. **An alert by rule**, when its author is a person set to Always alert, or its place is set to Always alert. No
   chance decides, and the local model is not asked. A keyword is not such a rule: it makes the message about you
   ([Rules](#rules), Keywords).
3. **Its importance**, a chance, for every message ([Importance](#importance)).
4. **Is it a Conversation?** A rule over who wrote when ([Conversation](#conversation)).
5. **Does it alert?** If it is a Conversation, or you marked this place or this person "should have alerted" in the
   last 90 days, the local model reads it, and it is an alert when its alert chance is 0.5 or more
   ([Alert](#alert)).
6. **Otherwise** a Conversation stays one, and anything else is on the list when its importance is at or above your
   level, and below the list when it is not.

A place kept to the list (you set it to List only, or it is muted on its own network) is never a Conversation and
never read for an alert: its messages are on the list or below it. A message its sender sent silently (Discord's
@silent) never alerts, whatever decided it: it stays a Conversation or a list row ([rich-messages.md](rich-messages.md)).
Quiet hours come last and hold alerts only.

Every decision is stored with its reasons in words, the deciding one first ("A direct message", "Reads as urgent: the
local model's answer is 0.31 against a bar of 0.05", "On the list: importance 72%, at or over your level of 60%"), so
the app can say why, and with the facts it was made from (`learn.ts` `Facts`), so your marks can be learned from. When
what was learned moved a message out of the tier it would have started in, the first reason says so ("Alert, learned
from your marks (was Conversation)") with the one or two features that moved it most, and `decidedBy` is `learned`.
Raised onto the list it says "List, learned from what you opened (was Below the list)": importance learns its yes from
what you opened and answered, and only "Less like this" says no (`learn.ts` `learnedFrom`).

Triage decides one message at a time, in the order they came, so notifications keep that order. A message waiting
when the hub stops is decided at the next start if it is under half an hour old.

## Conversation

People talking with you. A rule over who wrote when, never over what was said, and nothing in it is fitted
(`tiers.ts` `conversing`). A message is a Conversation when its place is not kept to the list, it is not from a bot
and not in your notes to self, and the first of these that holds:

| | Its reason |
| --- | --- |
| it is in a DM | A direct message |
| it is in a post you follow: a reply the hub's check found ([feed.md](feed.md#following-a-post)) | A reply to a post you follow |
| it mentions you by name, or a group you are in (a Zulip user group, a Discord role you hold), or replies to your message (`@everyone` does not count) | About you |
| it says one of your keywords ([Rules](#rules)) | Says “…”, one of your keywords |
| you wrote in its chat in the last 24 hours (`TOOK_PART`) | You wrote here in the last day |
| you answer openings there at 10% or more (`ANSWER_RATE` 0.1) | You usually answer here |

A group chat is not a Conversation by being a group: you have to be taking part in it.

**How often you answer** (`interact.ts` `answerRate`). An *opening* is someone else's message after five minutes
without any message in its chat (`OPENING_LULL`), when you had not written there in the 15 minutes before (`ENGAGED`):
someone starting to talk while you were away. It counts as answered when you write there within three hours
(`OPENING_ANSWER`). The rate is

```
answerRate = answered / (openings + 5)
```

with both counts losing half their weight every 30 days (`RATE_HALF_LIFE`), so the last months count most, and with
five openings' worth of "not answered" to begin with (`OPENING_PRIOR`), so one answer in a new chat is 1 in 6 and a
chat you never wrote in is 0. An opening counts only once you answered it or its three hours have passed, so the
rate never includes what was not yet known. Messages that arrive well behind the newest (history being filled in)
open nothing. The hub keeps the tally in memory: the first decision after a start folds the last two months of
messages, about a second on a busy hub, and every later one folds what arrived since.

**How large it is.** A median of 17.5 chats a day were in the Conversation tier (20 at most), with 58.5 silent
updates a day: messages that came after a five-minute lull while you were away. By the first reason that held, a
day: 51 messages in DMs, 2 about you elsewhere, 84 where you had written in the last day, 62 where you usually
answer. Those last two are held to one push per chat per ten minutes
([A Conversation's ten minutes](#one-notification-per-conversation)). When the rate was chosen (an earlier count over the same days, which had 14 chats a day at 0.1), a rate of
0.05 made it 16 and 0.02 made it 19 with twice the silent updates.

## Alert

An alert sounds, so it is kept to what cannot wait. Besides your rules, it comes from one question put to a local
model about the text, set against a bar, and from what your marks taught on top.

**Who is read.** Only a message in the Conversation tier, or one in a place or from a person you marked "should have
alerted" in the last 90 days (`MARKED_FOR`), and only when its place is not kept to the list. A message a rule
already made an alert is not read, and neither is one with no text. That is about 200 messages a day.

**The question** (`triage.ts` `STOP_QUESTION`), asked of the first 500 characters of the message (`JUDGE_CHARS`):

> Does this message need the reader to stop what they are doing and act or reply within the next hour or two?

**What answers it.** jev, the machine's local model service (`~/Projects/jev`, not in this repo; `DITHER_JEV_URL`,
`127.0.0.1:7862` by default). It runs a reranker, a language model asked a yes/no question about a text, and answers
with its chance of "yes" (`POST /v1/judge`). The hub's client refuses an address that is not on this machine or a
private network, so the text goes nowhere else. jev caches its answers by question and text, which is why the
question is a fixed string. Its answers are low and uncalibrated: on real messages 19 in 20 are under about 0.055.
So the answer is not used as a chance. It is set against a bar.

**The bars** (`learn.ts` `ALERT_BAR`): 0.05 in a DM and for a message that mentions you or replies to you, 0.2
elsewhere (a mention of a group you are in too). Before any mark the alert chance is

```
alert = sigmoid(logit(answer) − logit(bar))
```

which is 0.5 exactly at the bar, so a message alerts when the local model's answer reaches its bar. The bars differ
because the same answer means less in a chat you only take part in: with nothing learned, these bars gave 2.6 alert
sounds a day (5 at most, counting one an hour per conversation), 27 alerts in ten days in DMs and messages about you
and 3 in chats you only take part in. With 0.1 for the second bar those 3 are 24. With 0.1 for the first, the 27
are 15. Before the tiers the same days had 25.3 sounds a day. On a made-up set of 76 messages, 14 of them urgent, 13
of the 14 passed 0.05 and 4 of the other 62 did; at 0.2, 4 of the 14 and 1 of the 62. So in a chat you only take part
in, most urgent messages stay silent Conversations until a mark of yours raises them. That is the price of not
sounding many times a day.

**When it is slow or absent.** A decision waits for the local model at most three seconds (`judgeTimeoutMs`). Then the
message goes out as it would without an alert, a silent Conversation or a list row, and 20 seconds later it is decided
once more (`main.ts` `judgeLate`): jev keeps an answer once it has one, so if it has come and the message is an alert
after all, it goes out as one then, on the same row. When jev is down or gives no answer, nothing alerts by chance:
only your rules do. A message without an answer has an alert chance of 0.02 (`UNJUDGED`) and cannot alert whatever was
learned.

`DITHER_ALERT_MODEL` chooses what reads: `jev` (the default), `keyword` (a demo hub's default, so its world is the
same every time: 0.6 for a text with an urgent word such as "urgent", "asap", "call me" or "tonight", 0.01 without),
or `off` (only your rules alert).

**What it learns** is in [How the chances are learned](#how-the-chances-are-learned): "Should have alerted" and
"Alert was wrong" in full, and a little from what stood. Nothing you do without marking teaches it: answering or
opening something says it mattered, not that it could not wait.

## Importance

The chance that you would want to see a message. It decides the list for everything that is not a Conversation or an
alert, sorts the phone's list, and counts in the inbox's order. No language model reads anything for it.

**Where it starts** (`learn.ts` `prior`): from the network's own notification setting for the place.

- **0.8** (`NOTIFIED`) where the network itself would have notified you: every message in a place it notifies on
  every message, and a mention of you or of a group you are in, a reply to you or `@everyone` in a place it notifies
  on mentions. A followed Zulip topic with Zulip's followed-topic notifications on is a place that notifies every
  message: it starts here, and like any other it alerts only when the local model says so.
  A message that says one of your keywords starts here too, wherever it is.
- **Otherwise** `0.05 + 0.75 × addressed`, at most 0.6, where `addressed` is triage's own sense of how much the
  message is about you (`Triage.addressed`): from 0.15, mentions you +0.5 (or a group you are in +0.35, or
  `@everyone` +0.2), replies to you +0.4,
  a question to you or in a group chat +0.15, sounds urgent +0.3, a small group of six or fewer +0.1, you wrote there
  in the half hour before +0.25, an announcement channel −0.1.
- **Half** of either from a bot.

What the network would do (`Triage.nativeLevel`) is its own setting for the conversation, then its parent channel,
its categories, its server, as Discord, Element or WhatsApp report them; a mute that has run out no longer counts,
and with several accounts the loudest wins. Where nothing is set it is the network's default: DMs and group chats
notify on every message, channels and threads on mentions. Signal does not say which groups you muted in its app
(signal-cli keeps no group mutes), so every Signal group starts at 0.8 until you say otherwise here.

So before anything is learned, the list at the default level is what the network would have notified you about and
is not a Conversation, with the few messages elsewhere that are strongly about you. That was a median of 14.5 chats
a day (22 at most).

**What it learns from**, on top of the start (`votes.ts`, `labels.ts`):

| Example | Says | Weight |
| --- | --- | ---: |
| you marked it "Less like this" | not important | 1, fading as marks do |
| you answered it within three hours, or reacted to it | important | 0.5 |
| you tapped its notification, or opened its chat within a day, and stayed five seconds or more | important | 0.5 |
| a vote from before the tiers: Important or Active | important | 0.5, fading |
| a vote from before the tiers: Digest or Not interesting | not important | 0.5, fading |

"Answered" is your next message in the conversation, credited to the message it replies to, else to the last message
before it. Opening a chat says nothing about a message you watched arrive (you wrote there in the 15 minutes before,
a visit spanned it, or an open page kept its notification to itself); an answer or a reaction still counts. A label
is used only once it could be known: an answer when you wrote it, an open when you opened.

- **Only what you did counts.** Two "you did not" labels exist in `labels.ts` and are switched off (`LABEL_WEIGHTS`:
  `dismissed` 0, `nothing` 0), because the replay showed both make the list worse. With "nothing happened after the
  first message of a burst" as a no, the list held 42 of the 54 chats you opened on a day (43 without it), ranked
  them worse (0.945 against 0.971, as the chance that an opened chat scores above one you left), and at the strictest
  level held 15 where what you did alone holds 30. With "you swiped its list row away and did not open the chat" as a
  no: 42 of 54, and 24 against 30 at the strictest level. A swipe says you read the row, not that it did not matter.
  "Less like this" is the way to say no.
- **Ten per conversation.** Of what you did, the live model takes the newest ten in each conversation
  (`IMPLICIT_PER_PLACE`), so one busy chat cannot outweigh the rest. With everything you did, the list doubled: a
  median of 36 chats a day (68 at most) instead of 17 (25), to hold 50 of the 54 opened instead of 43.
- **Two weeks.** What you did is read from the last 14 days (`IMPLICIT_WINDOW`), again at each daily refit; a mark
  made in between refits on it as last read. Messages you marked are left out of it: the mark says more.

Learned this way from the days before, the list at 0.6 was a median of 17 chats a day (25 at most) and held 43 of the
54 opened; at 0.9 it was about 9 chats a day and still held 30, where the start alone has nothing that high.

## How the chances are learned

Both chances are learned the same way (`learn.ts`). Each is a logistic regression on top of its start:

```
log-odds(chance) = log-odds(start) + the sum of the weights of the message's features
```

with one weight per feature and per chance. The **features** of a message (`features`): its conversation, its author
(their person, else their identity), its server and categories (the three nearest), its network, its shape; flags
(mentions you, `@everyone`, replies to you, a question, sounds urgent, a bot, you had been writing there, an
attachment, a link, long, from someone you have as a person) and, where it says something, their absence; what the
network does there and whether it would notify; each of the conversation, the server and the author together with
whether the message is about you, so "this server, unless it is about you" is one weight; and the words it uses
(distinct, three letters or more, no links, mentions, code or common words), all of a message's words together
counting as one feature.

**Fitting** (`train`) finds the weights that best explain the examples, each example counting by its weight and only
for the chance it says something about, while every weight is held toward zero (L2-regularised logistic regression,
by coordinate Newton steps). It runs again after every mark and once a day, over everything, and takes well under a
second; the daily one first reads again what you did, a few seconds on a busy hub.

**The hierarchy is the penalties** (`lambda`): how firmly each kind of weight is held at zero.

| Feature | Held by | Moves on |
| --- | ---: | --- |
| a conversation | 0.5 | one mark |
| a person; the words | 1 | a few |
| a server or category | 4 | several |
| a network, a shape, a flag | 40 | many |
| "anything" | 80 | very many |

A scope together with "about you" is held half as firmly as the scope alone, so it moves first. So two marks in one
group chat change that chat, not every group chat on its network.

**What kind of model each part is**, and is not:

- **The local model** is a language model run as a yes/no judge, used as it comes. Nothing here fits it. Its answer
  enters only as the start of the alert chance.
- **The alert chance and importance** are each the regression above. They are not a mixture: the start and what was
  learned add up in log-odds, and no single weight says how far to trust the network against your marks. The weights
  per place and person do that job where it matters, one place at a time.
- **Bayesian in one sense only.** Holding a weight toward zero is the same as believing beforehand that it is near
  zero (a Gaussian prior, tighter for a network than for a conversation), and the fit is the single most likely set
  of weights under that belief. The penalties are set by hand, not learned, and no uncertainty is kept. The inbox's
  order is the part that keeps its uncertainty and explores with it ([inbox.md](inbox.md#exploring)).
- **The Conversation rule** is not a model: a decayed count against a fixed bar.
- **Text reaches a language model in one place only**, the alert question. The words of a message as features are
  counted, not read.

**What each chance learns from** (`votes.ts` `examples`):

| | Alert | Importance |
| --- | --- | --- |
| Your marks | "Should have alerted" as yes, "Alert was wrong" as no | "Less like this" as no |
| What you did | nothing | answers, reactions and opens, as yes ([above](#importance)) |
| What stood | an alert the model made that you left unmarked for 12 hours, as yes; a Conversation message it read and did not raise, as no | nothing |
| Votes from before the tiers | nothing: there were no alerts | at half weight |

A mark counts 1 when new, half after three months, and never under a quarter (`voteWeight`). What stood counts 0.05
(`STOOD`), the newest ten of each kind in each conversation, from the last 30 days and only since this hub took up
the tiers; an alert a rule made says nothing of the model and is left out.

**What it learned** is shown in words (`GET /api/triage/policy`, on How it sorts): the strongest weights ("More
likely to alert: In #general · Hub, about you"), with how many marks each was part of; how many marks the model gets
wrong, against how many the starts alone would (`backtest`); when and why it last learned. **Forget** leaves a
feature out of training for good (`POST /api/triage/factors/:key { rejected }`), and *Learn again* undoes it.
`POST /api/triage/policy/relearn` fits again at once.

**How well it is doing** is under it, day by day: the scorecard ([scorecard.md](scorecard.md)) scores each day's
logged chances, the candidate's and the start's against what you did next (notifications followed within 3 hours,
chats opened within a day, quick answers), once the day's outcomes are in.

## Marks

What the tiers learn from. The app's **Louder** and **Quieter** stand as these marks (Louder as "Should have
alerted", Quieter as "Alert was wrong" on an alert and "Less like this" elsewhere), and the route below still takes
them as they were, from a page or a notification shown before the scale: each such mark is kept as an answer too.

- **In the app**, Louder and Quieter on a message (its menu, the bell among its hover actions, and the phone's
  long-press sheet). Mail keeps **Less like this**.
- **On the notification itself** (the Android app, and `sw.js` in a browser): the answers in [Answers](#answers). A
  notice keeps the marks: **Not urgent** on an alert, **Should have alerted** on a Conversation, **Less like this**
  and **Should have alerted** on a list row.
- **On How it sorts** (`#/model`; from For you's header, the inbox button's menu and Settings → Notifications),
  which lists the last week under Alerts, Conversations, List and Below the list, one line per conversation with
  its importance, the two toggles and *Why*. The hub gives it the alerts and Conversations, newest first, the list
  by importance, and the 40 most important of the last two days that fell below it (`GET /api/inbox`, `store.ts`
  `inboxQueries`). Under the lists it shows what was learned.

One route takes them: `POST /api/messages/:id/feedback`, with `{ alert: true | false | null }`,
`{ less: true | false | null }` or both. Each key given is set and the other stays; `null` (or `less: false`) takes
a mark back. It answers `{ marks, policy }`, the marks as they now stand and the policy after learning from them. A
message's marks come with it (`TriageView.marks`), and its bell shows them with its tier, the reasons, its
importance and, where the local model was asked, its answer and the bar it was set against.

| Mark | Body | Teaches |
| --- | --- | --- |
| Should have alerted | `{ alert: true }` | the alert chance: messages like this one alert. Its place and its author may also alert for the next 90 days, Conversation or not |
| Alert was wrong | `{ alert: false }` | the alert chance: messages like this one do not |
| Less like this | `{ less: true }` | importance: messages like this one matter less |

"Like this one" is the message's features: one mark moves its conversation, and its person, its words and its server
a little, as the penalties allow. The 90 days (`MARKED_FOR`) are there because only Conversation messages are read
for alerts: without them, a mark in a channel you do not take part in would teach weights that are never used. A
place kept to the list still does not alert.

A mark never changes the message it was made on: that message keeps its tier, and the next ones like it land
differently. A mail message takes only "Less like this" ([Mail](#mail)).

## Rules

What you set on a place or a person. No rule is **Automatic**: the tiers decide.

| Rule | `level` | What it does |
| --- | --- | --- |
| **Always alert** | `all` | on a place, every message there is an alert; on a person, every message of theirs is, anywhere that is not muted |
| **List only** | `digest` | on a place: never a Conversation and never an alert by chance. Its messages are on the list or below it, by importance. It does not raise importance |
| **Mute** | `none` | on a place: silent. No notification, no list, the unread badge only |

`PUT /api/rules { scope, target, level }` sets one, with `level: null` for Automatic, and refuses any other level
(`RULE_LEVELS`, `RULE_LABEL` in the protocol). For a place the most specific rule wins: the conversation, its thread
parent, the spaces that contain it (nearest first), its account, its network, everything. The app offers the choice
on a chat and on a server; there is no picker for a whole network or for everything.

- **Mute is absolute.** Not even a keyword or a person set to Always alert gets through a muted place.
- **List only is a cap, not a boost.** A person set to Always alert still alerts there; a keyword there only puts
  the message on the list.
- **On a person**, Always alert is the one rule there is: triage reads no other (`decideByRules`), and
  `PUT /api/rules` refuses any other level on a person or a keyword. People set so can also pass quiet hours, where
  you allow it.
- **Keywords** (`scope: 'keyword'`, level `all`, stored so for older apps): a message that has the word, whole and
  in any case, in what was typed (mention tokens aside) counts as **about you**, like a mention. It never alerts by
  itself. It is a Conversation, its importance starts at 0.8 as if the network had notified you, and the local model
  reads it for urgency like any Conversation, held to the bar of messages not to you (0.20), so a keyword alerts only
  when what was said cannot wait. In a place kept to the list it is a row on the list. Matching is a feature the
  model learns from (`keyword`, "says one of your keywords"), so your marks can move it either way. Keywords used to
  alert outright; a common word or a project's name alerted on every message that said it. Only what a person typed: never a bot's message, a feed's item, or a
  message on a network a machine writes (`MACHINE_WRITTEN` in `triage.ts`: T3 Code's threads, whose agents name the
  repository and its files in every other turn, and calendars, whose reminders alert on their own). Notices
  ([notices.md](notices.md)) keep them: a comment there was typed by someone.
- **An older rule of `mentions`** may still be stored from before the tiers. It reads as "the network notifies only
  mentions here": in that place importance starts at 0.8 only for a mention of you, a reply to you or `@everyone`.
  Where a place's rule is shown it says "Mentions only (older setting)", and it cannot be chosen any more.

**The network's own settings** are not rules of yours, and they feed two things. What the network would notify you
about is where importance starts ([above](#importance)). And a place **muted on its network** (a channel, its
category or its server, a timed mute until it runs out) is kept to the list, as List only is, with the reason
"Muted in Discord: kept to the list"; its importance starts from how much the message is about you.

## The list's level

The importance at which a message reaches the list: 0.6 to begin with (`learn.ts` `THRESHOLDS`), and yours to set in
Settings. `PUT /api/triage/level { level }` takes 0.01 to 0.99 and answers the policy view; it holds for messages
decided from then on. `GET /api/triage/policy` gives `thresholds: { alert: 0.5, important: <your level> }`,
`bars: { direct: 0.05, other: 0.2 }` and `preview`, so the setting can say what a level means before you choose it:
for each of the levels 0.1 to 0.9, how many chats a day the list would have held over the last week. A chat counts
once a day, when one of its messages outside the Conversation tier reached that importance (`votes.ts` `preview`).
A week of decisions takes a second or more to read on a busy hub, so it is read in the background, six hours of them
at a time, and stands for an hour (`refreshPreview`); only the first request for the policy after a start waits for it.

In the replay, with what the model learns from the two weeks before: 0.6 was about 17 chats a day, 0.5 about 38,
0.4 about 56, and 0.9 about 9.

## Quiet hours

Quiet hours hold alerts, and nothing else: Conversations and list rows are silent already and keep coming. An alert
decided during them stays where it would be without the alert, a Conversation or a list row, with "Held by quiet
hours until 07:00" as its first reason, and is counted. When they end, one notification says "Quiet hours are over"
and how many were held. People set to Always alert get through when you allow it (`QuietHours.allowStarred`). The
window is a daily one in the time zone of the device that set it, on the weekdays you choose
(`GET`/`PUT /api/quiet-hours`).

## One notification per conversation

Triage decides per message; delivery is per conversation (`packages/hub/src/delivery.ts`). A device keeps one
notification for each conversation (its tag is the conversation id), and every push about it carries the
conversation's unread lines, so the notification grows instead of being replaced by the latest message.

- **Who gets what** (`notify.ts` `Notifier.message`). An alert goes to every device its own rules do not keep it off
  ([devices.md](devices.md)) and to open pages. A Conversation message and a list row go only to push registrations
  whose label says they are a phone (Android, iPhone, iPad, iOS), and to open pages as an entry in the list, never as
  a toast or a desktop notification: the live event is `{ t: 'notify', …, level }` with `level` `quiet` or `digest`,
  and no `level` for an alert. An ntfy topic (`DITHER_NTFY_URL`) gets all three, at low priority unless it is an
  alert.
- **What a push carries**, besides `title`, `body`, `icon` and the rest: `tier` (`push`, `quiet` or `digest`),
  `importance` (0 to 1, where known), `messageId` (so the row can be marked from where it shows), `lines` (the last
  six messages from others since you last read the conversation or wrote there, on the list or above, oldest first
  and ending with this one; each `{ author, key, body, ts }`, where a body's mentions and channels read as names,
  `@Ann` and `#general`, never as their ids), `icons` (a picture per author `key`), `count` (unread
  from others), `conv` (`{ title, shape: 'direct' | 'group' | 'channel', icon }`, a channel's icon being its
  server's), `sender` (`{ name, key, icon }`), and `alert`. The oldest lines go first when the push would pass about
  3.5 KB. `level` is still sent for an app from before the tiers and is only ever `push` (an alert) or `quiet`
  (everything silent); an app reads `tier` and falls back to `level` when a hub does not send it.
- **A row keeps its highest tier.** The push's `tier` is the highest among the lines it shows (`Grouped.tier`), not
  only this message's: a list message in a channel where a mention of you is still unread updates that Conversation
  row, it does not turn it into a list row, and a later message in a chat with an unread alert leaves it an alert's
  row. Only this message's own tier decides whether it sounds and which devices get it.
- **When it sounds** (`alert`): only for an alert, when it is the first push about the conversation in five minutes
  (`BURST_MS`), or comes after only silent ones in this burst, or mentions or replies to you. Every other update
  changes the notification silently. Nothing sounds while a page on a computer has been in use in the last two
  minutes (a visit from a device whose label is not a phone's): you are already looking.
- **Read here, not pushed there** (`server.ts` `watched`). A message's push is not sent at all, to any device, while
  its chat is open at its newest message on a computer in use, unless a rule of yours made it an alert (Always
  alert). The page says so itself over its live socket (`{ t: 'watching', label, conversationIds }`,
  `P.ClientWatching`, from `activity.ts` `noteNewest`): the chats a timeline shows scrolled to its newest message
  while the page is visible, focused and used in the last five minutes, none otherwise. It says it whenever that
  changes, on each new socket, and again every 30 s (`WATCH_EVERY`) while it watches something; the hub forgets it
  after a minute without word or when the socket closes. A page whose label says phone does not count. Such a page
  marks the chat read as each message comes, so a push would only buzz the phone about what is being read: in a week
  before this, 143 pushes (8% of the phone's) went out while their chat was open on the computer, and 129 were shown.
  The page still gets its `notify` event. Each skip is logged (`push_skip`, `why` `watched`,
  [activity.md](activity.md#push_skip-pushes-not-sent)).
- **A Conversation's ten minutes** (`CONVERSATION_EVERY`, `delivery.ts` `capped`). A silent Conversation that is not
  in a DM and not about you (not a mention of you, a reply to you, one of your keywords or a reply to a post you
  follow), that is, one there because you wrote in its chat in the last day or usually answer there, is not pushed
  when any push about its chat went out in the last ten minutes. Its line goes with the chat's next push, as a list
  row's does, and reading the chat anywhere ends the ten minutes, so the next message pushes at once. DMs, messages
  about you and alerts are never held. Each held one is logged (`push_skip`, `why` `capped`).
  Why: on 2026-11-15 one Discord channel you had written in pushed 1,155 times ("You wrote here in the last day"),
  and on 2026-11-23 four Signal groups 1,102 times, for the same reason. Replayed over the two weeks to 2026-11-24
  (5,918 pushes; a chat's ten minutes ended by a visit to it, standing in for a read), Conversation pushes went from
  352 a day (median 151, 1,366 at most) to 105 (median 79, 197 at most), and all pushes from 423 a day to 176. Of
  582 times a chat was opened after a push, none would have lost its only push; with no read ending the ten minutes
  it would have been 25. Five minutes kept 120 a day, fifteen 98 and thirty 90: past ten little more goes.
- **The phone's list.** A list row reaches the phones only as [the phone's list](#the-phones-list) allows.
- **The list's ten minutes** (`LIST_EVERY`). A list row is not pushed when any push about its chat went out in the
  last ten minutes, so a busy channel is one row brought up to date now and then, not a stream of pushes. The message
  is still on the list in the app, and the row's next push carries it among its lines. In the replay that was about
  126 list pushes a day while you were away.
- **Read elsewhere, gone here.** A notification closes on every device once its chat is read anywhere: open pages,
  the Android app and, within limits, desktop browsers ([below](#read-elsewhere-gone-here)).
- **Seen.** Swiping a notification away is reported as `dismissed` (`POST /api/activity/notifications`), and the hub
  reads that as seen: the conversation stays unread, but its place at the top, its boost and its importance stop
  counting in the inbox until something new arrives ([inbox.md](inbox.md#unread-alerts-and-importance)).
- **In a browser** (`sw.js`): the lines become the body (`Author: text` in groups), a group's title counts them, and
  `renotify`/`silent` follow `alert`. The icon is `conv.icon` for a group or channel (as on Android), else the
  sender's `icon`; with neither, the first letter of the title on a grey disc. A Discord group without a picture of
  its own has the default one Discord's client shows for it (the extractor reads it from the client). Its data keeps
  `ts`, the newest message it shows (the push's `ts`, else its last line's), so a clear closes it only up to where the
  chat was read, and `keep` when no read may close it ([below](#read-elsewhere-gone-here)).
- **On Android**: see [android.md](android.md).
- **Pictures arrive first.** Before a push goes, the hub fetches the pictures it names into its media cache, waiting
  3 s at most, since the device fetches them while it draws the notification and a busy hub could take longer than
  that for one it had never seen. The Android app keeps the last 300 on disk, fetches a push's at once, and waits 8 s.

The burst state is kept in memory. At start the hub rebuilds it from the activity log's notifications of the last
three days (`Delivery.restore`), so a chat notified before a restart still leaves the phones when it is read, and its
burst goes on where it was. Mail threads are not rebuilt, and with the activity log off nothing is.

### Read elsewhere, gone here

Every five seconds the hub takes the chats, mail threads and groups of notices it notified about that were read
since (`Delivery.read`: in the app on any device, in the network's own client when it reports reads, or by writing
there), each once, with `upTo`, the newest message any of its notifications showed (`packages/hub/src/clears.ts`).
Their notifications go:

- **From open pages.** They get the live event `{ t: 'cleared', reads: [{ id, upTo }] }` (of the moment, like
  `typing`: not journaled) and close those notifications up to `upTo`, as a clear push does: one showing a newer
  message stays, even before the page hears of that message. One without a time (a page's own) closes unless the
  page holds something unread there. A page also closes a notification whenever it sees a read itself
  (`packages/web/src/shade.ts`): a chat read at the bottom of its timeline, also one it already held as read because
  another device read it first; a mail thread read; the last unread notice of a group read, when the page holds the
  notice its notification shows. After every catch-up with the hub (a start, a reconnect) it goes through
  `getNotifications()` and closes each it can tell is read: a chat's whose `ts` is at or below the chat's read
  marker, a mail thread's with nothing unread whose `ts` is no newer than the thread's newest message, a group of
  notices' with nothing unread whose notice the page holds as read. Nothing unread is not enough: a notification
  with no `ts`, or a newer one (an alert that came between the catch-up and this tidy), stays. So a browser that was
  closed or offline while you read elsewhere tidies up when the app opens.
- **Never what is kept.** A notification whose data has `keep` is closed by no read, here or elsewhere, by no
  `cleared` and by no clear push: only a tap or a swipe ends it. That is a reminder you set on a network
  (Discord's "Remind me") and the summary when quiet hours end (`Notifier.message` kind `held`, which also says
  `keep` on the page's `notify`), and "Reply not sent" and "Reply waiting" (`sw.js` `sendReply`), the only copy of
  what you typed in the notification. They
  share their chat's tag and show no message's time.
- **From the Android app.** A push `{ clear: tag, upTo }` for each read, only to registrations that said they take
  it (`clears: true` on `POST /api/push/subscribe`, the Android app from 0.7): an older app would show an empty
  notification. A registration made before an app said so keeps its endpoint and so never registers again: the app's
  page also says it in its device hello (`clears: true` on `POST /api/devices/hello`, sent when the app reports
  version 0.7 or later), which sets it on that endpoint's registration. From 0.15 the app drops only the messages at
  or before `upTo` (a list row's lines too), and closes the notification only when none newer than it is left; one
  that came after the read stays, without sounding again. Without `upTo` (a read in the app itself) the whole
  notification goes, and a kept one (`keep`) stays either way. Older apps close the whole notification.
- **From desktop browsers with no page in use.** One push to each for everything it shows that was read:
  `{ clear, upTo, more: [{ clear, upTo }, …] }`. In `sw.js` each closes the notification with its tag only when that
  shows nothing newer than `upTo` (its `ts`), so a clear that comes late never closes an alert that came after the
  read; one without `upTo` (from an older hub) closes whatever shows.

Chromium's `getNotifications()` lists only what it sees on screen, or what was written after the call began: one
written just before it and still on its way to the screen is deleted from the list for good, though it still shows,
and then no read closes it. A page's tidy that runs while a push is being shown can do that, rarely; nothing here
works around it. `sw.js` marks `dither:shown` (with the tag) once a notification is on screen, and
`scripts/verify-clear.ts` reads the worker's notifications only after the marks of what it pushed.

A browser must show something for every push (`userVisibleOnly`), and a clear shows nothing, so each browser's rules
decide what one costs, and the hub sends them only where they are cheap or capped:

- **Only what it showed there.** A clear goes only to a registration the hub sent an alert for that chat
  (`push_shown`, kept until it is cleared, tapped, swiped or three days old), and only up to what it showed; never
  for a calendar reminder or a ring, whose tags are their own. A tap, a swipe, a reply or an alert closed at once
  because the app was in sight (`POST /api/activity/notifications`) takes it off `push_shown`, and so does a kept
  notification (a reminder, the quiet hours' summary) that took its place under the same tag.
- **Not to a page in use.** A browser whose page was in use in the last two minutes (its device's latest stay, as
  visits report it, not over) gets none: the page closes it itself, and it stops counting as showing there. Most
  reads at a computer are made in its own page, and would otherwise spend the cap meant for reads on another device.
- **Chrome** (an endpoint on `fcm.googleapis.com`, or on `/fcm/send/` at one of the `jmt<N>.google.com` hosts that
  Chrome now gives its subscriptions; nothing else on google.com): a push is free while another of the app's notifications still
  shows there, or the app's tab is in front; otherwise it costs 2 of a budget that earns 12/24 × engagement/100 an
  hour (engagement is Chrome's 0 to 100 for how much the site is used), and with the budget spent Chrome shows its
  own "updated in the background" notification. A clear that closes the last notification there goes at most 2 times
  in 24 hours (`CHROME_COSTLY_PER_DAY`: 4 points a day, which an engagement of 33 earns), and clears of any kind at
  most 6 (`CHROME_PER_DAY`), since "another still shows" is the hub's guess. It counts as still showing only what it
  sent there in the last four hours (`SHOWING_MS`): the system lets older ones go, and "clear all" closes them,
  without a word to the hub. A clear may still close one up to three days old.
- **Firefox** (Mozilla's push service, `*.push.services.mozilla.com`): 3 s after a push with none of the app's
  notifications left showing, the subscription's quota loses 1, and at 0 Firefox drops the subscription without
  telling the site. A push that arrives while a tab of the site is open sets the quota to 16; the first push after a
  visit in the browser's history sets it to min(16, 8 × days since that visit ^ −0.8). The hub cannot see a
  notification swiped away, nor which of its visits the history holds (a tab restored with the session is none), so
  every clear counts, and the count starts again only at a refill it is sure of: a push that reached the browser
  while its page was in use (`refilled_at` on the registration). At most `firefoxAllowance` since then: the quota
  less one, 8 at most and fewer as that gets older (2 after three days, none from about eight and a half). A visit
  since, which may have set the quota by its own age, is younger than the refill and so allows more than the hub does.
  None before the first refill: the first push after a registration sets the quota by the last visit in history,
  which may be days older than the page that registered (a tab restored with the session). Lowering the cap instead
  (to 3) would not be safe: a reset at a visit Firefox did not count can meet a quota already down to 1.
- **Never** Safari (its push service drops all of a site's subscriptions after three pushes that show nothing), any
  other push service (Edge's, ntfy), a phone's browser (its label says Android, iPhone or iPad), or a registration
  whose label says Safari.
- **Ten minutes, one topic.** A clear lives 600 s at the push service (`TTL`): a browser away longer tidies up when
  the app opens. It has the header `Topic: clear` (RFC 8030: at most 32 URL-safe base64 characters, per
  subscription), so a clear still waiting at the push service is replaced by the next one rather than queued behind
  it, and a browser that comes back gets one push, which costs at most once. Because a replaced clear never arrives,
  each clear carries again everything the clears of the last ten minutes carried (`more`, 40 tags at most); `upTo`
  keeps that harmless. Alerts have no topic, so a clear never takes an alert's place. A push service that ignores
  the topic delivers each clear, and the hub has counted each one against the cap.
- **Counted before it goes,** so a slow push service cannot let two clears past one cap; one the push service did not
  take is not counted and its notification is still known to show. What an alert shows is noted as each browser's
  push is taken, not once every push server has answered, so a tap or a swipe reported meanwhile is not lost.

### A copy in the push

A message's push carries a copy of the message and where its conversation stands (`arrived`, protocol
`PushArrived`, hub `src/arrived.ts`), so that tapping the notification opens a chat that already has it, before
the hub answers and offline too. Without it, the app started from its snapshot (docs/android.md, "Starting fast"),
which can be hours old, and the message showed only once the catch-up came back.

- **What goes**: the message without embeds, reactions or the optional extras; its attachments only when they fit; the
  conversation's last message, its time and each account's unread and mention counts, as the hub has them when it
  sends. Only beside the notification's own fields, within 3,900 bytes of JSON (a push's encrypted record is at most
  4,096): the attachments go first, then the body is cut to the longest that fits; either way the copy is marked as not
  whole (`cut`, shown with "…"). With less than 40 characters left, or a message of attachments alone that do not fit,
  no copy goes. The list's preview of the same message carries no text of its own when it would repeat the body: the
  device fills it in. A held push (a reminder, a summary) carries none. The plain-text ntfy topic never carries it.
- **Kept on the device**: the service worker (`public/sw.js`) keeps each copy, and each read elsewhere a clear push
  carries (one per conversation, the furthest; a clear without `upTo` is the hub taking a phone-list row back, not a
  read, and is not kept), in IndexedDB `dither-arrived`. It keeps the copy before anything else the push does, so a hub
  that never answers the push's own requests (a phone off its network) cannot cut it short; those requests give up
  after ten seconds. The Android app, which has no service worker push, keeps the same records in a file
  (`Arrived.kt`, read and written off the main thread) and hands them to each page that says hello. Both also hand
  each new one to a page that is open. At most 300, none older than three days, here or when shown. Signing out, or
  a 401 asking to sign in, deletes them, in the app too.
- **Shown as a layer** (`packages/web/src/arrived.ts`): a start from the snapshot lays them over it. A message no
  newer than the snapshot's last one in its conversation is left out; a conversation's row takes the newest push's
  state; a read elsewhere after that push, up to its last message, leaves it read. The copies go in the timelines and
  the inbox, marked, under a line that says earlier messages may be missing until the hub is back: only messages that
  notify are pushed, so the ones between may not be here yet, and a reply typed then is typed without them. A copy
  changed in place (a reaction, a mark) stays one. A row the hub's own data replaced while the layer shows (frames
  released after a failed catch-up) is left to the hub from then on.
- **Never data**: nothing of the layer is saved (the snapshot is not written while it shows), a timeline's catch-up
  asks from the newest message the hub sent, not from a copy, and the layer is taken away whole right before the
  hub's answer is applied, in the same task: each row it changed gets its object from before back (unless something
  else replaced it meanwhile), and copies the hub's own messages have not replaced leave the timelines and the inbox;
  what they pushed off the end of a full inbox comes back. A chat still loading its own page (the one a notification
  opened) keeps its copies until that page comes, so the message does not leave and come back. The hub's absolute
  counts then stand, so nothing is counted twice, and a copy of a message the hub no longer has (deleted meanwhile)
  goes.
- **Then deleted**: each time the hub catches the app up, the records kept before that request was made go, from the
  worker's store and the app's (`arrived.done`). One that came while it was asking stays, and the next start leaves it
  out as no newer than its snapshot.
- Sends typed on a copy (a reply to it) wait in the outbox as any offline send does, and go once the hub has
  answered; the copy's id is the message's real id, so a reply quotes it.
- `scripts/verify-arrived.ts` (CI `boot`) checks it end to end in Chromium, and `scripts/verify-android-arrived.ts`
  (CI `android-device`) in the Android app on an emulator: the copy kept with the app closed, shown by an offline
  start from the notification's intent, a second push shown by the open page, and both gone with the records once the
  hub answers.

## The phone's list

Triage puts a message on the list; what reaches the phone is decided once more, per chat
(`packages/hub/src/phonelist.ts`), because what importance learns from is "you opened this chat somewhere within a
day", mostly at a computer, and that lifts channels the network itself keeps silent. Since the tiers, 3,661 list
decisions in 34 hours came from 29 chats, and 3,404 of them were neither something the network would have notified you
about nor to you: learning alone had lifted them. The decision, its tier, How it sorts and the inbox do not change: only which list rows go to phones
(and to the ntfy topic). A held row is sent nowhere, as one within the list's ten minutes is.

- **The gate.** A list row goes to the phones when the start alone puts it on the list: the network would have
  notified you (`Facts.notify`), or it is to you (a mention of you, a reply to you, a DM). Or the chat has a keep mark:
  a message in it marked **Should have alerted** in the last 90 days (`MARKED_FOR`), the one mark that says "more from
  here" (there is no mark of its own for "keep these rows"). Everything else on the list stays off the phones. Of the
  3,661 list decisions above, 257 (in 19 chats) pass, all because the network would notify; of the 394 list rows that
  were sent, 105.
- **Trials.** So a held chat can still show it is worth a row, up to three a day (`TRIALS_PER_DAY`) go anyway. At a
  chat's first held message of the day (the hub's local day) one coin is tossed for it, with the chance
  `3 / the chats held a day`, read from the coins of up to seven days before (from two days of them on; before that,
  from the last three days' list decisions the gate would have held), and 0 once the day's three are spent. A won coin
  sends the row as any list row. One coin a chat a day, so a busy channel is no likelier to be tried than a quiet one,
  and the chance kept is exactly the one tossed with.
- **Eight at most.** At most eight list rows are open on the phones at once (`LIST_CAP`), by the hub's own count of
  what it sent and has not seen tapped, swiped, read anywhere, replaced by a Conversation or an alert, or expired. At
  eight, a new chat's row waits; a chat already showing is still brought up to date.
- **A swipe snoozes.** After the phone swipes a chat's row away (one row, or Clear all), that chat's list rows wait six
  hours (`SNOOZE_MS`), or until a Conversation or an alert comes in it. Dismissals from one device within two seconds
  (`BULK_MS`) are a clear-all: the episodes end as `cleared`, never as a swipe of that chat, and nothing learns a "no"
  from either (`labels.ts` weighs dismissals at 0). Only a phone's word counts: its push registration, or the page of
  the app that registered it (`push_subscription.device`); a computer's toast or tap says nothing here.
- **Twelve hours.** A list row twelve hours old (`EXPIRE_MS`) leaves the phones: a `{ clear }` push to the
  registrations that take one, so the shade matches the hub's count. The Android app's own cap of 20 rows stays, above
  the hub's eight.
- **Five pushes a day.** With the gate alone the phones still had 60 to 200 list pushes a day, and about 1% of them
  were followed by opening the chat within three hours, so the list has a daily budget (`DAILY_BUDGET`, the hub's
  local day). Every list push spends one: a new row, or an open row brought up to date. Spent, the rest of the day's
  list rows wait (an open row stays as it was; a new chat gets none until tomorrow). So the budget goes to the day's
  most important rows rather than its first, a push also needs its importance (triage's, the list's own order) at the
  day's **bar**: on each of the last seven days, the importance of the fifth most important push the list was asked
  for (0 on a day with fewer), and the median of those. On a day like the last ones about five clear it, early or
  late; a busy day spends the budget sooner, a quiet one may leave some. With fewer than two days kept the bar is 0,
  first come first served. A push of unknown importance passes the bar. A trial needs only the budget, and once the
  budget is spent the day's coins are 0, so their chances stay exact.

**Episodes** (`phone_episode`): a chat's run on the list, from its first list message that asked for the phone until
it ended, with its day, why it went (`arm`: `prior`, `keep`, `trial`) or was held (`gated`), the coin's chance
(`propensity`) for `trial` and `gated`, how many pushes it took, and how it ended (`outcome`: `tapped`, `dismissed`,
`cleared`, `read`, `expired`, `superseded`). A held episode ends when its chat is read anywhere past its first message,
or at twelve hours. Snoozes are in `phone_snooze`. Both are kept whether or not the activity log is on, so a restart
keeps the count, the snoozes and the day's coins; taps and swipes come through the activity log, so with it off only
reading and expiry end an episode. Each push the list was asked for that passed the gate, the snoozes and the cap is
kept in `phone_push`, with its importance and whether the budget sent it: the bar is read from it, and a replay can
be. Episodes and pushes go after 90 days. Once an hour the log has a line: what was sent and held (`held budget` for
the budget or the bar), how many rows are open, and how much of the day's budget is spent and at what bar.

**`DITHER_PHONE_LIST`**: `on` (the default); `shadow`, every list row goes out as before and the episodes and the
hourly line say what the gate would have done (`sent` is what it would have sent; nothing is cleared at twelve hours);
`off`, as before this, nothing kept. Turning it off is the rollback: no app change was needed for any of it.
**`DITHER_PHONE_LIST_BUDGET`**: list pushes a day, a whole number (5 by default; 0 sends none), or `off` for no
budget and no bar.

Alerts and Conversations are not touched: their pushes are the same byte for byte with the gate on
(`test/phonelist.test.ts`). They end a chat's list episode and lift its snooze. Requests (a row on the list) and
mail's list rows: requests are not gated; mail goes through the same gate (the start puts it on the list for someone
you correspond with who wrote to you or copied you in).

## Mail

New mail from people goes through the same importance model, with the same marks
([mail.md](mail.md#triage-and-notifications-slice-9)): its facts are chat's with network `email` and shape `mail`,
and "Less like this" on someone's mail moves their chats once they are one person. Mail has no Conversation tier and
nothing reads it for urgency: it is an alert only when its sender is set to Always alert, and otherwise a row on the
list or below it, by importance. Importance starts at 0.8 for someone you correspond with who wrote to you or copied
you in. Bulk mail is never triaged. Mail is on How it sorts with an envelope and notifies with one notification per
thread; quiet hours hold its alerts and device rules hold it as they hold chat.

## Notices

What your accounts and services tell you through dither-accounts (GitHub's notifications, the manager's word about an
account that needs you) is triaged with the same model and marks ([notices.md](notices.md)): no Conversation tier;
the chances start from the source's urgency (high: an alert; normal: the local model reads it; low: below the list)
and move with your marks. One notification per group (a repository, an app), opening `#/notices/<id>`.

## Requests

A new friend, follow or join request, an invite, or a message request, from someone you know (they have a person
here, or share a conversation, group or server with the account it came to) notifies once, as a **row on the list**:
silent on phones, nothing on a computer, and no toast in an open page ([add.md](add.md)). It is not a message, so it
has no tier of its own and nothing to mark. Its push carries `tier: 'digest'`, an importance of 0.8 (it sorts as
something the network would have notified you about), `requestId` and no `conversationId`: its own notification (tag
`request:<id>`) that opens `#/requests/<id>`. Strangers' requests only count on the inbox's Requests row. It goes
through `deliverRequest` in main.ts, judged by `packages/hub/src/requestnotify.ts` 20 seconds after it arrives and
only when under two days old. Quiet hours do not hold it, since it is silent; an account, a network or everything set to
Mute, and device rules for its account or network, keep it off. Its activity log kind is `request`.

A request the network filed as spam (Discord's spam folder, `RequestFact.spam`) never notifies, whoever it is from: it
waits last under Requests, under "Filed as spam", and the inbox's Requests row says how many without counting them.

## From the network itself

What a network knows about your attention beyond messages as they come (protocol `attention.ts`; Discord's side in
dither-accounts' docs/chat.md "Attention"). None of it makes the phone sound more often, except a true mention that
arrives a little late.

- **Mentions heard late.** Discord's client does not load every server channel, so a mention in one nobody opened can
  reach the hub only through its own recent-mentions list, which the account asks for after it connects and when its
  notification center says something new came (never more often than every five minutes). Each hit is a message with
  `late` (capability `mentions`). The hub keeps it as it keeps backfill, unread and counted as a mention, so the inbox
  sees it; and while it is younger than ten minutes by its own time (`LATE_NEWS_MS`, `latenews.ts`) it is triaged as a
  live message is, so a mention found a minute late can still be a Conversation or an alert. Older, it never notifies.
  A message the hub already had is never news again. @everyone, @here and role mentions found this way are
  `mentionsAll`, never "about you".
- **@everyone suppressed.** A Discord server set to suppress @everyone and @here, or a Zulip channel or topic with
  wildcard mentions off (`NativeMute.suppressEveryone`), makes an @everyone there something the network would not have
  notified you about, so its importance starts lower (`Triage.suppressesEveryone`). The most specific place that says
  either way decides: the conversation, its parent channel, then its spaces, so a followed Zulip topic whose wildcards
  notify (Zulip's followed-topic setting) counts them in a channel that has them off.
- **Groups you are in.** A mention of a Zulip user group or a Discord role you hold, and not of you by name
  (`MessageFact.mentionsGroup`), is about you (a Conversation) but held to the higher alert bar (0.2), and weighs
  between your name and `@everyone`. A Discord server set to suppress role mentions (`suppressRoles`) makes one
  there something it would not have notified you about. An older extractor sends a role ping as a mention by name.
- **Mutes changed in Discord** come at once: a mute set, changed or cleared in any Discord app, or running out,
  sends the place's fact again; a cleared one carries an empty `mute` (`{}`), which clears the hub's (a fact without
  `mute` leaves it as it was). "Muted on the network" in triage follows.
- **Muted on the network.** A place's About has, under Notifications, the network's own mute beside dither's: "Mute on
  Discord…" for 15 minutes, an hour, 3, 8 or 24 hours, or until turned off, and "Unmute on Discord" while one is on
  (capability `mute`, POST `/api/(conversations|spaces)/:id/native-mute`, `nativemute.ts`). It goes through every
  connected account that sees the place and can, and stops Discord's own apps too. dither's Mute is unchanged: it
  only decides what dither notifies, and the two are separate on purpose.
- **Marked unread.** Mark Unread on someone's message (the message menu) moves the read point back to just before it
  on every account that sees the chat, counts again, and tells each network that can (capability `markUnread`,
  Discord's manual ack; POST `/api/messages/:id/unread`, `unread.ts`); the page goes back to the inbox, as the open
  chat would read it again at once. Marked unread in Discord's own app, it comes the other way: a `read` with
  `manual`, the one read event that moves the read point back.
- **Many read at once.** Mark all read's paced queue sends an account that can (capability `markReadMany`, Discord's
  bulk ack) up to 50 conversations in one request instead of one each.

## The feed

A network's notifications about you (X's likes, reposts, replies, mentions, quotes and follows, [feed.md](feed.md))
arrive as messages in a feed conversation. Likes, reposts, follows and anything else X notifies about are **silent**.
A reply, a mention or a quote is kept to the list as List only keeps a place: **at most a silent row on the List**,
never a Conversation or an alert, and the local model is not asked. It starts at the importance of something the
network notified you about. Always alert (on the person or the feed), or a keyword, does not change that, while Mute
silences it. [feed.md](feed.md#notifications) says why.

## Reminders

A calendar reminder from dither-calendar ([calendar.md](calendar.md)) is a message from the calendar in its chat,
marked `extra.reminder`: the calendar says when, and triage makes it an **alert** ("A reminder from Calendar"),
sounding on every device, unless the Calendar chat is muted or List only. Quiet hours hold it quiet instead (phones
only, silent, "Held by quiet hours until …"), and it is not in quiet hours' summary. Its notification is the Calendar
chat's, like any message's, so reading the chat clears it. Device rules on Calendar (`network:calendar`) keep it off
a device, and Mentions only does too, since a reminder mentions no one. A retried reminder is the same message, and
notifies once. (Before calendar accounts it came as POST /api/calendar/notify, with activity log kind `reminder`.)

## Elsewhere

- **At a computer, the phone stays quiet.** While a page on a computer has been in use in the last two minutes
  (`delivery.ts` `elsewhere`, `ACTIVE_MS`), no push sounds: the alert still arrives on the phone, silently, and the
  computer shows its notification. While the chat itself is open there at its newest message, nothing is pushed
  at all unless a rule made it an alert ([Read here, not pushed there](#one-notification-per-conversation)).
- **The inbox** ([inbox.md](inbox.md)) puts a conversation with an alert you have not seen first, lifts one with an
  unread Conversation message, and adds the importance of an unread message on the list. Server channels are listed
  while they hold an unread message on the list or above.
- **Device rules** ([devices.md](devices.md)) only take notifications off a device. They change no tier.
- **The activity log** ([activity.md](activity.md)) keeps what became of every notification: what was learned from
  what you did reads it.

## The shadow model

Next to the live model a **candidate** learns, and only watches (`votes.ts`, `shadow.ts`). Its chances are kept
with every decision (`triage.shadow`); it decides nothing. It learns from the same marks and old votes, and from
everything you did in the last two weeks, not only the newest ten in each conversation. And it weighs more:

- **Interaction features** (`interact.ts`), numbers worked out as of each message from only what came before, kept
  with the decision in `triage_input` when `DITHER_ACTIVITY_FEATURES=1` ([activity.md](activity.md)), and learned as
  one slope each across all places (held by 10, `NUMERIC` in `learn.ts`):

  | Feature | What |
  | --- | --- |
  | `rr:conv`, `rr:author` | how often you write in the conversation within half an hour of a message there, and after this author's messages anywhere: decayed (30-day half-life), smoothed, as log-odds against 5% |
  | `engaged`, `alt` | you wrote there in the last 15 minutes; how often you answered someone there in the last half hour, log(1 + n) |
  | `since:seen` | log(1 + hours) since you last opened the conversation (or its DM peer) or wrote there, less a day's worth |
  | `device:active` | a visit on any device was in use in the last 2 minutes |
  | `open:rate` | how often you opened its pushes within the hour, as log-odds against 30% |

- **Content features** from message embeddings (`emb`, `knn`), behind `DITHER_EMBEDDINGS=1` (held by 5): made just
  before each decision (`Embeddings.prepare`, giving up after 800 ms); for training they are read afresh, since a
  labelled message's probe score is cross-fitted. See [embeddings.md](embeddings.md).

It has no say in alerts or Conversations, so what it would change is the list. `GET /api/triage/shadow`
(`P.TriageShadowView`, counts only) says so for the last week: of the decisions outside the Conversation tier that
have a shadow (`decided`), how many were on the list as decided (`live`), how many its importance would have put there
at your level (`shadow`), and how many both did (`both`). How it sorts says it in one line under what the live model
learned. It is switched on only if the replay and a week in shadow agree it is better at the same size of list or a
smaller one. In the replay, learning from everything you did (without the extra features) made the list twice as long
for seven more opened chats ([above](#importance)).

## What was removed

With the loudness scale (2026-11):

- **The marks' buttons**: *Should have alerted*, *Alert was wrong*, *Less like this* on a chat message, and *Not
  urgent* on a notification. Louder and Quieter (and Worth it / Could have waited on a notification) took their place;
  `POST /api/messages/:id/feedback` still takes the marks, and mail keeps Less like this.
- **The tiers' names in the app**, once the scale is on: Alert, Conversation and List are its sound, show and next
  look bands. Their codes stay.

For someone who knew triage before the tiers (2026-11):

- **The four levels** (Important, Active, Digest, Not interesting). Their codes are the tiers' now: `push` is Alert,
  `quiet` Conversation, `digest` List, `drop` Below the list. Important was "worth a buzz" and fired about 64 times
  a day, 25 sounds; an Alert is "cannot wait an hour or two", about 3 sounds a day.
- **The three chances** (`ping`, `active`, `interesting`), their thresholds, and `score` as their mean. There are two
  now, `alert` and `important`, and `score` is the importance.
- **The Smart level**, a local model asked for the chances in places set to Smart (`DITHER_TRIAGE_MODEL`), and the
  **decision prompt** written for it. The score Smart used, how much a message is about you, lives on as part of
  where importance starts. Rules set to Smart were deleted: those places are Automatic.
- **Levels on everything, a network or an account.** The app has no such picker any more. A rule stored at one of
  those scopes is still read if it is Always alert, List only or Mute.
- **The daily digest**: its notification, its setting, `/api/daily-digest` and `P.DailyDigest`. The list on the phone
  is what it was for.
- **Exploration** (`DITHER_TRIAGE_EXPLORE`): no decision is changed to learn from it. `triage.explore` and
  `triage.propensity` stay on old rows.
- **Level votes**: ▲ and ▼ a level, the four-level picker, ✓ Right. Marks replaced them. `TriageView.feedback` still
  carries a vote from before, read-only; nothing writes it.
- **jev's three content questions** (asks something, time-sensitive, plans with you). They fed only the shadow model.
  The one question asked now is the alert's.

## The migration

The first start of a hub with the tiers converts what it has, once (`store.ts` `toTiers`, marked by `tiers_at` in
`meta`). The hub copies the database first, as before any schema change (`MIGRATIONS` 2 to 3,
[deploy.md](deploy.md#backups-and-upkeep)), and the step runs in the migration's one transaction.

| Before | After |
| --- | --- |
| a decision of Important or Active, in a DM or a group chat | Conversation |
| a decision of Important or Active, anywhere else | List |
| a decision of Digest or Not interesting | Below the list |
| silent | silent |
| its Active chance | its importance (`score`) |
| what it was | kept in `triage.was` |
| a vote | kept in `triage.feedback`: half a mark's worth for importance |
| a rule of Smart | deleted: Automatic |
| rules of Every message, Digest only, Nothing | the same rows, now called Always alert, List only, Mute |
| a rule of Mentions | kept as it is ([Rules](#rules)) |
| the daily digest's setting and state | deleted |
| the saved model | started over: it predicted other chances. It learns at once from the old votes, and from what you did at the first tick, within a minute |

No old message becomes an alert, and nothing that stood before the migration counts as an alert you let stand.
Mail's decisions convert the same way, without the Conversation tier: Important and Active mail becomes a list row,
Digest goes below the list (`mail/triage.ts` `toTiers`). The inbox folds every conversation again in the background,
since list rows now count as something waiting (`FEATURE_VERSION` 3).

**The codes were kept on purpose.** `push`, `quiet`, `digest`, `drop` and `silent` mean something new and are spelled
as before, in the database, the API and the push payload. So the schema only gains columns (`was`, `alert_mark`,
`less_mark`, `marked_at`) and the triage table is updated where it stands, not rebuilt; an app that was not updated
still shows everything (it reads `level`, which says `push` for an alert and `quiet` for the rest) and its votes
still land: `{ vote: 'up' }` is read as "should have alerted", `{ vote: 'down' }` as "alert was wrong" on an alert
and "less like this" on anything else; and the build from before the migration can still open the database. The
replay ([triage-replay.md](triage-replay.md)) opens a copy with the hub's own code, so running it is the migration's
dry run.

## API and storage

`POST /api/messages/:id/feedback` (marks), `GET /api/triage/policy`, `PUT /api/triage/level`,
`POST /api/triage/policy/relearn`, `POST /api/triage/factors/:key { rejected }`, `GET /api/triage/shadow`,
`PUT /api/rules`, `GET`/`PUT /api/quiet-hours`, `GET /api/inbox`, `GET /api/model/scores` ([scorecard.md](scorecard.md)).

The scale: `GET /api/loudness/state` (the mode, your settings, sounds today, cards asked and answered today, what
waits and what it learned), `PUT /api/loudness/prefs`, `GET /api/loudness/feed/count` (`{ pending }`, the row's
count), `GET /api/loudness/feed` (`CalFeedView`: the cards, past answers and rows, and the sure ones apart),
`POST /api/loudness/feed/:id { answer }` (`{ answerId, before, after }`), `POST /api/loudness/feed/:id/parts
{ parts }` (`{ after }`), `POST /api/loudness/feed/:id/settle { settle: keep | once | undo }`,
`POST /api/loudness/feed/:id/skip { skip }`, `POST /api/loudness/answers { messageId, answer, source, scope? }`
(answers `{ answerId, why? }`), `POST /api/loudness/why { answerId, reason?, wait?, text?, until? }`,
`POST /api/loudness/forget { key, rejected }`, `GET /api/messages/:id/loudness`. Types in
`packages/protocol/src/loudness.ts`.

A message's `triage` (`P.TriageView`): `decision`, `score` (its importance), `reasons`, `decidedBy`, `probs`
(`{ alert, important }`), `judge` (the local model's answer, when it was asked) with `bar` (the bar it was held to), `marks`, `feedback` (a vote from
before the tiers), and `loudness` (0 to 100, where the scale was worked out).

Storage: the scale's number and view in `triage.loud` and `triage.loud_view`; answers in `attn_answer` (never your
words; a feed answer with its `parts` and the `chance` its card was drawn with), the calibration feed in `cal_item`
(each item's kind, chance, surprise, unsure, the model's chances and what it and you did, your answer and the chances
after it, and when a past answer comes back), the old check-ins in `checkin` (history only), what each notification
looked like and where it went in `notification` (`title`, `body`, `look`, `computer_in_use`), `notification_device`
and `notification_event.seen`; the scale's model in `meta` (`attn_model`) and your settings (`attention_prefs`). `triage` (`decision`, `score`, `reasons`, `decided_by`, `facts` as JSON, `probs` and `shadow` as JSON
chances, `alert_mark`, `less_mark`, `marked_at`, `was`, and from before the tiers `feedback`, `explore`,
`propensity`); the models in `meta` (`triage_policy`: `model`, `rejected`, and `candidate` for the shadow);
`list_level`, `quiet_hours` and `tiers_at` in `meta` too; the phone's list in `phone_episode` and `phone_snooze`; the scorecard in `model_score`; what each desktop browser was alerted about and the clears it was sent in `push_shown` and `push_clear` (ids and times only), and when a push last reached a Firefox while its page was in use in `push_subscription.refilled_at`. Triage rows older than 90 days go when nothing can be
learned from them ([deploy.md](deploy.md#backups-and-upkeep)).
