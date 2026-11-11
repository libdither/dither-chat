# The triage replay

`scripts/triage-replay.ts` replays the hub's history day by day through the three tiers
([notifications.md](notifications.md)) and reports what each way of learning would have done: how many alerts,
Conversations and list rows a day, and how the list compares with what you opened. Every change to what triage learns
from is judged here first. It is also the dry run of the migration from the four levels.

```sh
bun scripts/triage-replay.ts --live <data dir>/hub.sqlite --out <scratch dir>   # copy, then replay
bun scripts/triage-replay.ts --db <scratch dir>/hub-copy-….sqlite --out <dir>  # replay an existing copy
  [--days 14] [--level 0.6] [--tz -8] [--min-per-day 500] [--labels] [--no-judge] [--jev <url>]
```

- **It never writes to the live database.** It opens it read-only and `VACUUM INTO`s a copy in `--out`, then works on
  the copy.
- **It is the migration's dry run.** The copy is opened by the hub's own `Store`, so a copy from before the tiers is
  migrated first, exactly as the hub would migrate it (`store.ts` `toTiers`). The first line it prints says how long
  opening took, and the hub's own line says how many decisions moved and how many Smart rules became Automatic. What
  the tables then show is what the tiers would have done with that database.
- **Message text goes to the local model and nowhere else.** For the alert question the replay asks jev, on this
  machine, about each Conversation message, as the hub does (`--jev`, else `DITHER_JEV_URL`, else `127.0.0.1:7862`).
  jev caches its answers, so a second run asks nothing new. `--no-judge` leaves it out: nothing then alerts.
- **Output**: `replay.md` (the tables) and `replay.json` in `--out`. Counts and rates only: never message text, names
  or ids.
- `--level` is the list's level (0.6, the hub's default), `--days` how far back to go (14), `--tz` the hours from UTC
  that split the days (the machine's by default), `--min-per-day` the fewest decisions a day needs to count (500).

## What it replays

1. **Examples.** Every message from someone else that triage decided on in the window (silenced places aside), with
   - its **facts**: as kept with the decision, else rebuilt by the rules as the settings are now (`Triage.rulesFor`).
     Whether its place is kept to the list (List only, or muted on its network) is always as it is now;
   - whether the **Conversation rule** held then, and why (`tiers.ts`): from a fold of who wrote when, over every
     message from two months before the window, so only earlier messages count (`interact.ts`);
   - the **local model's answer**, if it is a Conversation and has text (the first 500 characters);
   - its **words**, for the model (read in memory, never written out);
   - its **outcome**, read from the future (`labels.ts` `gatherOutcomes`): your next message there and whether it
     answers this one, your reaction, whether you were already there, its notification and what became of it, the
     next open and how long you stayed;
   - its **label** from that outcome (`implicitLabel`): what it says of importance, and when that could be known;
   - what triage **decided at the time**, by the level it had then, and your vote from before the tiers, if any.
2. **A rolling split by day.** Local days; a day with fewer than `--min-per-day` decisions is an edge and left out.
   The first day only teaches, and the last is left out while its outcomes are still coming in. For each other day,
   each policy fits on what was known before its midnight (votes cast before it, labels from the two weeks before it
   whose outcome was known by then), then decides that day's messages.
3. **Deciding** is the hub's own (`learn.ts` `tierFrom`): an alert when a Conversation message's alert chance is 0.5
   or more, a Conversation when the rule holds, else the list at `--level` or below it. History holds no marks, so no
   place is alert-eligible by a mark, and the alert chance is its start in every policy.

"Away" below means you were not already there: you had not written in the chat in the 15 minutes before, and no
visit to it spanned the message.

## How to read each table

**The first lines.** How many decisions and days, how many days were tested, how many votes from before the tiers
there are, how many messages the local model read, how many days the visit log covers (opens are known only for
those), the level and the bars. Then what the four levels did on the same days: Important messages a day while you
were away, sounds a day (at most one an hour per conversation, as below), and chats a day with a notification.

**The tiers, by policy.** One row per policy.

| Column | What |
| --- | --- |
| Alert sounds a day (most) | alerts while you were away, counting at most one an hour per conversation: the mean over the tested days, and the most on one day |
| Alerts: DM or about you / taking part | alerts while you were away over all tested days together, split by why the message was a Conversation: a DM or about you, against a chat you wrote in or usually answer in |
| Conversation chats a day (most) | chats with a message in the Conversation tier (alerts among them): the median day, and the most |
| Silent Conversation updates a day | Conversation messages that came after five minutes without any message there, while you were away: how often a conversation's row would change. The mean |
| List chats a day (most) | chats with a message on the list: the median day, and the most |
| List pushes a day | list messages while you were away, at most one per chat every ten minutes (`LIST_EVERY`). The mean |

**The list against what you opened.** The unit is a chat on a day, outside the Conversation tier: its best
importance that day, whether any of its messages reached the list, and whether you opened it within a day of one of
its messages while away.

| Column | What |
| --- | --- |
| Opened chat-days on the list | of the chat-days you opened, how many the list held |
| Unprompted ones on the list | the same, among those you opened though no notification had gone out for them |
| Listed chat-days you opened | of the chat-days on the list, how many you opened |
| AUC of importance | the chance that a chat-day you opened has a higher best importance than one you did not: 0.5 is a coin, 1 is perfect |
| Held-out votes it agrees with | of the votes cast on or after the day they are tested on (so not learned from), how many the policy sides with: a vote for Important or Active with the list or above, a vote for Digest or Not interesting with below it |

**The list at each level.** For each level from 0.1 to 0.9 and each policy: how many chat-days a day reach that
importance, and in brackets how many of the opened chat-days are among them. It says what setting the level would
buy.

**The alert bars, nothing learned.** The `start` policy with other bars: sounds a day (and the most), and the alerts
over all tested days in DMs or about you, and where you only take part.

**Why messages are Conversations.** Messages a day, by the first reason that held: `dm`, `about` (a mention of you or
a reply to you), `wrote` (you wrote there in the last 24 hours), `answers` (you answer openings there at 10% or more).

## Policies

| Name | What |
| --- | --- |
| `start` | no learning: the network's setting as the start for importance, the local model against the bars for alerts |
| `votes` | the start plus the votes from before the tiers, at half weight |
| `live` | as the hub learns: the votes, and what you did (answers, reactions, opens: `labels.ts`), the newest ten in each conversation |
| `all you did` | as `live`, with everything you did in each conversation, not only the newest ten |

With `--labels`, three more, each `live` with other weights for what you did (`LABEL_WEIGHTS`), to see which kind of
label earns its place:

| Name | What |
| --- | --- |
| `with swipes` | a list row swiped away and not opened within a day counts as "not important", at 0.3 |
| `with nothing` | nothing at all happening after the first message of a burst counts as "not important", at 0.03 |
| `opens only` | answers and reactions count for nothing: only opens |

To try another way of learning, add a policy to `POLICIES` in the script: a name, what it is, and a `fit(cut, all)`
that returns the model as of `cut` from what was known before it.

## How to read it: the limits

- **The alert chance cannot be replayed.** There are no marks in history, so every policy has the same alerts: the
  local model's answer against the bars. What marks would teach shows only once there are some.
- **Alerts by rule are not replayed.** A message from a person set to Always alert, in a place set so, or with one
  of your keywords is decided here like any other, so the alert columns count only what the local model raised.
- **You mostly opened what had notified you.** Opens are the label for importance, and under the four levels a
  notification is what led to most of them. So "opened chat-days on the list" flatters a list that keeps what was
  notified before. The unprompted ones are free of that, and there are few of them.
- **Facts from before 2026-11-04 are rebuilt by today's rules**, since facts were not kept with decisions until
  then; and which places are kept to the list is as of now throughout.
- **The visit log is shorter than the window.** Opens are known only for the days it covers; answers and reactions
  for all of them.
- **Small numbers.** A few dozen opened chat-days and a few dozen votes: a difference of one or two is noise.

## Results

A copy of the live hub taken 2026-11-10, run with `--labels`. 328,566 decisions over 12 days, 10 of them tested; a
third of the facts were rebuilt from the rules. 33 votes from before the tiers. The local model read 2,267
Conversation messages. The visit log covers 7.5 days. List level 0.6; bars 0.05 (DMs, about you) and 0.2 (elsewhere).

Before the tiers, on the same days: 63.6 Important messages a day, 25.3 sounds a day, 23.8 chats a day with a
notification.

**The tiers, by policy**

| Policy | Alert sounds a day (most) | Alerts: DM or about you / taking part / by a rule of yours | Conversation chats a day (most) | Silent Conversation updates a day | List chats a day (most) | List pushes a day |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| start | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 14.5 (22) | 74.1 |
| votes | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 14 (21) | 69.1 |
| live | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 17 (25) | 126.2 |
| all you did | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 36 (68) | 185.2 |
| with swipes | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 16 (25) | 125.3 |
| with nothing | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 14 (22) | 99.1 |
| opens only | 2.6 (5) | 26 / 3 / 1 | 17.5 (20) | 58.5 | 16 (25) | 125.5 |

**The list against what you opened**

| Policy | Opened chat-days on the list | Unprompted ones on the list | Listed chat-days you opened | AUC of importance | Held-out votes it agrees with |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 43 of 54 | 2 of 10 | 43 of 156 | 0.953 | 22 of 29 |
| votes | 43 of 54 | 2 of 10 | 43 of 149 | 0.971 | 21 of 29 |
| live | 43 of 54 | 2 of 10 | 43 of 172 | 0.971 | 22 of 29 |
| all you did | 50 of 54 | 6 of 10 | 50 of 378 | 0.971 | 21 of 29 |
| with swipes | 42 of 54 | 2 of 10 | 42 of 169 | 0.964 | 23 of 29 |
| with nothing | 42 of 54 | 2 of 10 | 42 of 152 | 0.945 | 22 of 29 |
| opens only | 43 of 54 | 2 of 10 | 43 of 170 | 0.970 | 22 of 29 |

**The list at each level**: chat-days a day, and how many of the 54 opened ones are among them.

| Level | start | votes | live | all you did | with swipes | with nothing | opens only |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.1 | 322.2 (54) | 322.2 (54) | 341.4 (54) | 347.6 (54) | 341.4 (54) | 151.8 (52) | 336.5 (54) |
| 0.2 | 54.8 (52) | 55.7 (52) | 244.9 (54) | 254.7 (54) | 244.9 (54) | 38.3 (46) | 212.8 (54) |
| 0.3 | 54.7 (52) | 54.7 (52) | 74.4 (53) | 192 (54) | 59.5 (52) | 24.3 (43) | 58.5 (52) |
| 0.4 | 15.6 (43) | 28.5 (50) | 56.2 (52) | 74.1 (53) | 56.1 (52) | 20 (43) | 39.8 (50) |
| 0.5 | 15.6 (43) | 15.6 (43) | 38.5 (50) | 40.7 (50) | 38 (49) | 15.8 (43) | 35.5 (50) |
| 0.6 | 15.6 (43) | 14.9 (43) | 17.2 (43) | 37.8 (50) | 16.9 (42) | 15.2 (42) | 17 (43) |
| 0.7 | 15.6 (43) | 14.7 (43) | 16.5 (43) | 17.7 (43) | 16.3 (42) | 12.8 (39) | 16.4 (43) |
| 0.8 | 15.6 (43) | 12.9 (38) | 16.2 (43) | 16.7 (43) | 15.3 (40) | 7.4 (23) | 16.1 (43) |
| 0.9 | 0 (0) | 0.3 (3) | 8.6 (30) | 9.9 (34) | 6.9 (24) | 2.4 (15) | 5.1 (20) |

**The alert bars, nothing learned**

| Bar: DMs and about you | Bar: elsewhere | Sounds a day (most) | Alerts in DMs or about you | Alerts where you take part | Alerts by a rule of yours |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.03 | 0.1 | 5.5 (12) | 45 | 24 | 1 |
| 0.03 | 0.2 | 3.7 (9) | 45 | 3 | 1 |
| 0.03 | 0.3 | 3.5 (8) | 45 | 1 | 1 |
| 0.05 | 0.1 | 4.4 (8) | 26 | 24 | 1 |
| **0.05** | **0.2** | 2.6 (5) | 26 | 3 | 1 |
| 0.05 | 0.3 | 2.4 (5) | 26 | 1 | 1 |
| 0.1 | 0.1 | 3.5 (6) | 15 | 24 | 1 |
| 0.1 | 0.2 | 1.7 (3) | 15 | 3 | 1 |
| 0.1 | 0.3 | 1.5 (3) | 15 | 1 | 1 |

**Why messages are Conversations**, a day: `wrote` 83.5, `answers` 61.7, `dm` 50.9, `about` 1.7.

What it says:

- **Sounds fall by nine tenths.** 2.6 alert sounds a day, 5 on the loudest day, against 25.3 before. 26 of the 30
  alerts in ten days were in DMs or about you, 3 in chats you take part in, and 1 was by a rule of yours (a person
  or place set to always alert, or a keyword, as the rules are now). Between 28,000 and 29,000 messages a day fall below the list under
  every policy.
- **The bars are where the volume is decided.** In DMs and messages about you, 0.03 gives 45 alerts in ten days,
  0.05 gives 26, 0.1 gives 15. Elsewhere 0.1 gives 24 and 0.2 gives 3: in chats you only take part in, a small step
  in the bar is a large step in alerts. Hence 0.05 and 0.2.
- **The Conversation tier is a steady size**: a median of 17.5 chats a day and never more than 20, with 58.5 silent
  updates. Most of it is chats you had written in that day and chats where you usually answer.
- **At the default level the list is about 17 chats a day** (25 at most) and holds 43 of the 54 chat-days you
  opened. A quarter of what it lists you opened (43 of 172).
- **Learning from what you did ranks better and makes a stricter level possible.** At 0.6 the same 43 are held with
  or without learning, but the ranking improves (0.953 to 0.971), and the importances spread out: the start has
  nothing above 0.8, while `live` at 0.9 keeps 30 of the 54 in 8.6 chats a day. Below 0.6 the learned list grows
  fast, 38.5 chats a day at 0.5 and 56.2 at 0.4, which is why the level starts at 0.6.
- **The votes alone already give the ranking** (0.971), and every policy agrees with 21 to 23 of the 29 held-out
  votes: the votes cannot tell the policies apart.
- **Everything you did is too much.** Without the cap of ten per conversation the list is a median of 36 chats a day
  (68 at most): seven more opened chat-days held, for more than twice the list (378 listed against 172). It is the
  only policy that finds more of the unprompted opens (6 of 10 against 2), which says the chats you go to by
  yourself are not found by the list yet.
- **A swipe is not a no.** With swiped rows as "not important" the list loses one opened chat-day at 0.6 and six at
  0.9 (24 against 30), and ranks worse (0.964).
- **Neither is nothing happening.** With it the ranking falls below the start's (0.945 against 0.953), and at 0.9
  the list keeps 15 of the 54 where `live` keeps 30. With only what you did, nearly every label is a yes, so the
  level is what holds the list's size; "Less like this" is the no.
- **Answers earn their place.** With opens alone the list at 0.6 is the same, and at 0.9 it keeps 20 instead of 30.
- **List pushes** are 126 a day with `live`, in about 17 chats: a busy chat's row is brought up to date every ten
  minutes at most, silently.

The replay from before the tiers (five policies over the four levels, with precision and recall of pings against
quick replies, and the weight of "nothing happened" tuned for the three chances) is in this file's history; its
conclusions were about another question, whether a message was worth a buzz, and do not carry over.
