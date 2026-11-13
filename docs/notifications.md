# Notifications: three tiers, and what they learn from you

Triage puts every new message from someone else in one of three tiers, below them, or silences it:

| Tier | `decision` | Decided by | Phone | Desktop | Inbox |
| --- | --- | --- | --- | --- | --- |
| **Alert** | `push` | the alert chance at 0.5 or more, or a rule of yours (a person or place set to Always alert, a keyword) | sounds, with a heads-up | a notification, and a toast in an open page | first in the list until you have seen it |
| **Conversation** | `quiet` | a rule, no model: a DM, a mention of you or a reply to you, a chat you wrote in during the last day, or one where you usually answer | a silent row of its own, in Android's Conversations section | nothing | a boost while it is unread |
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
2. **An alert by rule**, when its author is a person set to Always alert, it matches one of your keywords, or its
   place is set to Always alert. No chance decides, and the local model is not asked.
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
| it mentions you by name or replies to your message (`@everyone` does not count) | About you |
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
answer. When the rate was chosen (an earlier count over the same days, which had 14 chats a day at 0.1), a rate of
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
elsewhere. Before any mark the alert chance is

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
  every message, and a mention of you, a reply to you or `@everyone` in a place it notifies on mentions.
- **Otherwise** `0.05 + 0.75 × addressed`, at most 0.6, where `addressed` is triage's own sense of how much the
  message is about you (`Triage.addressed`): from 0.15, mentions you +0.5 (or `@everyone` +0.2), replies to you +0.4,
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

## Marks

What you tell triage about a decision. Any decision that is not silent can be marked, from wherever it shows:

- **In the app**, two toggles on a message (its menu, the bell among its hover actions, and the phone's long-press
  sheet): **Should have alerted**, which reads **Alert was wrong** on a message that alerted, and **Less like this**.
  A ticked one is taken back by picking it again.
- **On the notification itself** (the Android app, and `sw.js` in a browser): an alert has **Not urgent**, the same
  as "Alert was wrong"; a Conversation row has **Should have alerted**; a list row has **Less like this** and
  **Should have alerted**.
- **On How it sorts** (`#/model`; from Catch up's header, the inbox button's menu and Settings → Notifications),
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
- **List only is a cap, not a boost.** A keyword, or a person set to Always alert, still alerts there.
- **On a person**, Always alert is the one rule there is: triage reads no other (`decideByRules`), and
  `PUT /api/rules` refuses any other level on a person or a keyword. People set so can also pass quiet hours, where
  you allow it.
- **Keywords** (`scope: 'keyword'`, level `all`): a message that has the word, whole and in any case, in what was
  typed (mention tokens aside) is an alert.
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
  and ending with this one; each `{ author, key, body, ts }`), `icons` (a picture per author `key`), `count` (unread
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
- **The phone's list.** A list row reaches the phones only as [the phone's list](#the-phones-list) allows.
- **The list's ten minutes** (`LIST_EVERY`). A list row is not pushed when any push about its chat went out in the
  last ten minutes, so a busy channel is one row brought up to date now and then, not a stream of pushes. The message
  is still on the list in the app, and the row's next push carries it among its lines. In the replay that was about
  126 list pushes a day while you were away.
- **Read elsewhere, gone here.** Every five seconds the hub looks at the conversations it notified about; one read
  since then (in the app, in the network's own client when it reports reads, or by writing there) gets a push
  `{ clear: conversationId }`, which closes it. That goes only to registrations that said they take it
  (`clears: true` on `POST /api/push/subscribe`, the Android app from 0.7): a browser must show something for every
  push, and an older app would show an empty one. A registration made before an app said so keeps its endpoint and
  so never registers again: the app's page also says it in its device hello (`clears: true` on
  `POST /api/devices/hello`, sent when the app reports version 0.7 or later), which sets it on that endpoint's
  registration. Notifications are followed for three days (`FORGET_MS`).
- **Seen.** Swiping a notification away is reported as `dismissed` (`POST /api/activity/notifications`), and the hub
  reads that as seen: the conversation stays unread, but its place at the top, its boost and its importance stop
  counting in the inbox until something new arrives ([inbox.md](inbox.md#unread-alerts-and-importance)).
- **In a browser** (`sw.js`): the lines become the body (`Author: text` in groups), a group's title counts them, and
  `renotify`/`silent` follow `alert`. The icon is `conv.icon` for a group or channel (as on Android), else the
  sender's `icon`; with neither, the first letter of the title on a grey disc. A Discord group without a picture of
  its own has the default one Discord's client shows for it (the extractor reads it from the client).
- **On Android**: see [android.md](android.md).
- **Pictures arrive first.** Before a push goes, the hub fetches the pictures it names into its media cache, waiting
  3 s at most, since the device fetches them while it draws the notification and a busy hub could take longer than
  that for one it had never seen. The Android app keeps the last 300 on disk, fetches a push's at once, and waits 8 s.

The burst state is kept in memory. At start the hub rebuilds it from the activity log's notifications of the last
three days (`Delivery.restore`), so a chat notified before a restart still leaves the phones when it is read, and its
burst goes on where it was. Mail threads are not rebuilt, and with the activity log off nothing is.

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

**Episodes** (`phone_episode`): a chat's run on the list, from its first list message that asked for the phone until
it ended, with its day, why it went (`arm`: `prior`, `keep`, `trial`) or was held (`gated`), the coin's chance
(`propensity`) for `trial` and `gated`, how many pushes it took, and how it ended (`outcome`: `tapped`, `dismissed`,
`cleared`, `read`, `expired`, `superseded`). A held episode ends when its chat is read anywhere past its first message,
or at twelve hours. Snoozes are in `phone_snooze`. Both are kept whether or not the activity log is on, so a restart
keeps the count, the snoozes and the day's coins; taps and swipes come through the activity log, so with it off only
reading and expiry end an episode. Episodes go after 90 days. Once an hour the log has a line: what was sent and held,
and how many rows are open.

**`DITHER_PHONE_LIST`**: `on` (the default); `shadow`, every list row goes out as before and the episodes and the
hourly line say what the gate would have done (`sent` is what it would have sent; nothing is cleared at twelve hours);
`off`, as before this, nothing kept. Turning it off is the rollback: no app change was needed for any of it.

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
- **@everyone suppressed.** A server set in Discord to suppress @everyone and @here (`NativeMute.suppressEveryone` on
  its space) makes an @everyone there something the network would not have notified you about, so its importance
  starts lower (`Triage.suppressesEveryone`). Role mentions suppressed are kept (`suppressRoles`) but not used yet.
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
network notified you about. Always alert (on the person, a keyword or the feed) does not change that, while Mute
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
  computer shows its notification.
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
`PUT /api/rules`, `GET`/`PUT /api/quiet-hours`, `GET /api/inbox`.

A message's `triage` (`P.TriageView`): `decision`, `score` (its importance), `reasons`, `decidedBy`, `probs`
(`{ alert, important }`), `judge` (the local model's answer, when it was asked) with `bar` (the bar it was held to), `marks`, and `feedback` (a vote from
before the tiers).

Storage: `triage` (`decision`, `score`, `reasons`, `decided_by`, `facts` as JSON, `probs` and `shadow` as JSON
chances, `alert_mark`, `less_mark`, `marked_at`, `was`, and from before the tiers `feedback`, `explore`,
`propensity`); the models in `meta` (`triage_policy`: `model`, `rejected`, and `candidate` for the shadow);
`list_level`, `quiet_hours` and `tiers_at` in `meta` too; the phone's list in `phone_episode` and `phone_snooze`. Triage rows older than 90 days go when nothing can be
learned from them ([deploy.md](deploy.md#backups-and-upkeep)).
