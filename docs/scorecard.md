# The scorecard

How well the notification and inbox models are doing, day by day (`packages/hub/src/scorecard.ts`). The models refit
themselves: triage's alert and importance chances daily and after each mark (`votes.ts`, [notifications.md](notifications.md)),
the inbox's order after ten opens or a day (`ranker.ts`, [inbox.md](inbox.md#a-learned-order)). The scorecard says
whether a refit helped: each day's live decisions, scored against what you did afterwards, kept, and drawn on How it
sorts under what was learned.

## How a day is scored

- **Once its outcomes are in.** A local day (the hub's zone) is scored a day and an hour after it ends
  (`MATURE_AFTER`): its longest window is a day, and a device sends a visit again while it lasts. Nothing is scored
  before its windows close, and a day is scored once: what was known then is what counts.
- **Backfilled.** The first run scores every day the data covers (the oldest decision, notification or visit, at most
  120 days back), then each run (three minutes after a start, then hourly) scores the days that matured since.
- **Off the request path.** A generator run in slices (`slices.ts`, span `scorecard`), every query bounded by a day,
  or a quarter hour of decisions, and on an index. On a real hub's copy (35,000 decisions a day) a day takes about
  0.3 s in all and no step holds the thread 16 ms.
- **What the hub logged, as it was.** Triage keeps with each decision its chances (`triage.probs`), the candidate's
  (`triage.shadow`) and the facts its start comes from (`triage.facts`). The scorecard scores the logged chance, the
  candidate's and the start's (`learn.ts` `prior`: where a message begins before anything is learned) on the same
  messages and the same outcomes. That is the "learned against learning nothing" line, prequential: each decision was
  made before its outcome, by the model of the day.
- **Numbers only.** `model_score(day, metric, value, n, extra, at)`: a value, how many it is of, and a few more counts
  as JSON. No ids, no text. Scores are kept when the activity log is deleted: they hold nothing from it but numbers.
- **When a metric changes meaning**, bump `SCORE_VERSION`: the next run deletes every row and scores every day again
  from what the database still holds (triage rows go after 90 days, the log after its retention).

## The metrics

Opens are visits to the chat of 5 s or more in use (`labels.ts` `OPEN_DWELL`), on any device, by any route.

| Metric | Value | n |
| --- | --- | --- |
| `alert.opened`, `conversation.opened`, `list.opened` | the share of notifications after which you opened that chat within 3 hours | notifications that day that a push server took (`accepted`), by the tier of their message (push = Alert, quiet = Conversation, digest = List) |
| `importance.auc` / `_start` / `_candidate` | for each chat with messages that day outside the Conversation tier, its highest importance against whether you opened it within a day of one of them: the chance an opened chat outranks one not opened (AUC) | chats |
| `importance.ap` / `_start` / `_candidate` | the same chats sorted by importance: average precision, how near the top the opened ones are | chats |
| `alert.auc` / `_start` / `_candidate` | Conversation messages the local model read (and not kept to the list): the alert chance against whether you wrote in that chat within 3 hours | messages |
| `marks.alert_wrong` | "Alert was wrong" marks on the day's alerts | alerts decided |
| `marks.should_alert` | "Should have alerted" marks on the day's messages | Conversation messages and alerts decided |
| `unprompted.list` | of the chats you opened that day with no notification about them in the day before, the share with a message at the list or above in that day | those chats |
| `inbox.mrr` | for opens from an inbox row (`visit.source = 'inbox'`, `visit.rank`), the mean of 1 ÷ row | those opens |
| `inbox.top8`, `inbox.deep` | the share of them from the first 8 rows, and from below row 20 | those opens |
| `inbox.mrr_live`, `inbox.mrr_shadow` | for the opens from an inbox row whose device said where the row stood in the shadow order with mail (`visit.shadow_rank`, [inbox.md](inbox.md#mail-in-the-learned-order)), the mean of 1 ÷ row as shown, and as it would have stood in that order | those opens |
| `inbox.mail_mrr`, `inbox.mail_mrr_shadow` | the same, for mail rows alone (`extra.opens`: every mail open from the inbox that day) | those mail opens |
| `needs.predicted`, `needs.answered` | for owed replies whose 3 days ended that day, the mean "needs a reply" chance shown (`needs_prediction`, kept at 15 min, 1 h, 6 h and a day of age) and the share answered within the 3 days ([inbox.md](inbox.md#needs-a-reply)) | chances kept |
| `needs.brier`, `needs.brier_table` | the same: the Brier score of the chance shown, and of the owed table's chance alone | chances kept |
| `foryou.clicked`, `foryou.clicked_explore` | of the For you items on screen that day (a `shown` event, [foryou.md](foryou.md)), the share opened from it; and the same for exploration slots alone, which no order chose | items shown, and those from exploration slots |
| `attn.sounds` | notifications that sounded that day ([below](#the-cost-side)) | notifications a push server took |
| `attn.sounds_computer_hour` | the sounds in clock hours a computer was in use, over those hours | those hours |
| `attn.stale` | the share of message notifications sent while that chat was open on a computer in use and read past the message there | message notifications a push server took |
| `attn.stale_shown` | notifications tapped or swiped away after a stay on a computer read their chat past them | notifications tapped or swiped |
| `attn.checks` | app opens with nothing at the list or above since the last look | app opens |
| `people.wait`, `people.wait_p90` | for the replies you gave people that day, the median and the 90th-percentile wait, in hours | those replies |
| `people.owed_3d` | at the day's end, the people waiting on a reply from you for over 3 days | conversations with people with a turn in the 30 days before |
| `people.breadth`, `people.breadth_before` | the people you wrote to in the 30 days to the day's end, and in the 30 days before those (`extra.kept`: in both) | the same |

Why each:

- **Notifications followed** is the plainest check on the tiers: an alert you did not open within 3 hours probably
  did not need to sound, and a list row nobody opens is noise. A busy chat's row brought up to date ten times is ten
  notifications, as the phone shows them.
- **Importance** decides the list, so it is scored where the list is decided: outside the Conversation tier. AUC
  counts every pair, and with hundreds of quiet channels a day nearly every one is easy, so it sits near 0.98 for
  learned and start alike. Average precision looks at the top of the order, where the list is, and tells them apart.
- **The alert chance** has few marks to learn from, so its learned line sits on the start's until there are some.
  Answering within 3 hours is the nearest thing to "it could not wait" that the log has.
- **Unprompted opens** are the chats you go to by yourself: the list should hold them, and the triage replay found it
  rarely does.
- **Needs a reply** is a chance shown on the row, so it should mean what it says: the two lines of the first chart
  close together, and the chance's Brier under the table's. A turn is scored on the day its window ends, which a day
  has always passed by the time it matures; "No reply needed" counts as not answered.

## The cost side

The metrics above say whether the models ranked well; these say what notifying cost, and how the people who write to
you are doing. They are tracked before any change to how notifications are decided, as the baseline to beat. There is
no budget: the counts are kept and shown as they are.

- **A sound** is a notification that played a sound where it went: an alert that starts a burst (delivery.ts `alert`:
  the first push about its chat in five minutes, one after only silent ones, or one to you, and none while a computer
  was in use in the last two minutes), a call ringing, quiet hours' summary. The hub keeps it with the notification
  (`notification.alert`, written when the push servers answer: notify.ts `sounded`), and counts it when a push server
  took the push. Before that was kept, the scorecard plays the hub's rule back over the log: the chat's triage
  decision, the burst, a mention of you, and the computer stays then; mail's and notices' alerts have no triage row
  there and are not played back, so days before the column count none of theirs. A device in Do Not Disturb, or a
  phone set silent, still counts: the hub cannot know.
- **At a computer** is a stay (`visit`) with time in use from a device whose label is not a phone's (delivery.ts
  `PHONE`). An hour is a computer hour when such a stay overlaps it.
- **Stale** (`attn.stale`) is a push that came while the chat was open on a computer: a stay there spanning the push,
  whose read point (`read_to_ts`, else `seen_to_ts`) reached the message. `attn.stale_shown` is what the devices can say
  about a notification left up after its chat was read on a computer: only the ones you then tapped or swiped away
  after such a stay. A phone does not report that a clear closed a notification, a desktop browser is sent one only within
  limits ([notifications.md](notifications.md#read-elsewhere-gone-here)), and a notification left alone reports
  nothing, so the count is a floor, not the whole.
- **A check with nothing new** (`attn.checks`) is an app open, a stay on any device that begins ten minutes or more
  after every earlier stay ended (`LOOK_GAP`), with no chat message triage put on the list or above, and no such mail,
  between the end of the last look and the open.
- **People** are the other side of a DM, or of a group of six or fewer (attention.ts `SMALL_GROUP`), on a network of
  people: not channels, threads, feeds, mail, the Calendar chat or an agent's threads (`PEOPLE_SQL`); not bots.
  - **The wait** is how long after a turn addressed to you (owed_turn, [inbox.md](inbox.md#needs-a-reply)) you
    answered it, for the turns answered that day; a reaction (no known time) and "No reply needed" are left out.
  - **Owed over 3 days** takes each conversation with people's latest turn begun in the 30 days before the day's end
    (`OWED_LOOKBACK`), from owed_turn and the turns still open (the fold's state, read once a run), and counts those
    begun 3 days or more before the end, not answered by then and not marked "No reply needed". Older turns ran out
    long since and are left out.
  - **Breadth** is everyone else in the conversations with people you wrote in, by person (or by account where there
    is none).

## The weekly report

`GET /api/attention/report` (`attnreport.ts`, `AttentionReport`), drawn by the page **Your attention**
(`ui/AttentionReport.tsx`, a chunk of its own), reached from Settings → Notifications and from How it sorts:

- **Sounds each day** for the last 14 scored days, as bars (hover, a tap or the arrow keys show the day, with its
  sounds an hour at a computer), and the last 7 days' mean against the 7 before. No budget line.
- **People waiting on you**: the inbox's owed replies (`owedSince`) in conversations with people, begun in the last
  30 days, the longest waiting first (8 listed, and how many more); the median and 90th-percentile wait for your
  replies over the last 7 days against the 7 before (read from owed_turn, not averaged from days); and how many
  waited over 3 days, on the last scored day against a week before.
- **Who you talk with**: breadth on the last scored day, against the 30 days before it.
- **Drifting**: at most one person a week, chosen from the week's Monday (`weekStart`) so it holds all week: someone
  you wrote to in at least 4 of the 12 weeks before the last 4, with no message either way in any of those
  conversations since (`conversation.last_message_at`); the one with the most such weeks. It is in the report only:
  never a push, never a row.
- **Checks with nothing new** and notifications still up after reading, as totals over 7 days against the 7 before.

The report holds ids for the app to name from what it already has, and numbers; no names and no text.

## On How it sorts

`GET /api/model/scores?days=60` (`P.ModelScoresView`): the scored days, oldest first, and for each metric a value and
an n per day (null where a day had nothing to score), and the newest day still waiting for its outcomes.

The page (`ui/Scorecard.tsx`, a chunk of its own) draws a small line chart per question (`SCORE_CHARTS` in
`protocol/src/scorecard.ts`), each with one y-axis and its lines of one kind; the second line of a chart is dashed.
The legend gives each line's last 7 days against the 7 before (weighted by n). Hover, a tap or the arrow keys show a
day's values and their n; a table under them lists every day. The demo world seeds three invented weeks
(`seedDemoScores`), so a demo hub has something to draw.

## The script, and a weekly loop

```sh
bun scripts/scorecard.ts --db <copy of hub.sqlite> [--days 28] [--stored] [--json]
```

It scores every matured day of a copy as the hub would, without writing (read-only), and prints a table per chart and
each line's last week against the week before. `--stored` prints what the hub kept instead; `--json` the API's shape.
Days are the machine's: set `TZ` to the hub's zone when it differs. Make the copy with
`sqlite3 <live db> "VACUUM INTO '<file>'"`, never a plain copy of a live database.

The loop, for an agent once a week:

1. Copy the live database (as above) and run `bun scripts/scorecard.ts --db <copy>`. Read each chart's last week
   against the week before, and the learned lines against "learning nothing".
2. Pick the weakest place: a tier whose notifications are rarely followed, learned importance no better than the
   start, a falling inbox order, unprompted opens the list misses.
3. Try a change in a replay on the same copy: `scripts/triage-replay.ts` for triage ([triage-replay.md](triage-replay.md)),
   `scripts/inbox-replay.ts` for the inbox order ([inbox.md](inbox.md#the-replay)), `scripts/needs-reply-backtest.ts`
   (and `scripts/owed-replay.ts`) for needs reply.
4. Open a pull request only if the change wins in the replay at the same size of list (or fewer notifications), and
   say so in its description with the replay's numbers. After it deploys, the scorecard's next days say whether it
   held live.

## On a real hub: the cost side (copy of 2026-11-24)

Days 2026-11-09 to 11-22 (the log begins 11-03; the column that keeps sounds did not exist yet, so every day is
played back):

- **Sounds**: 0, 0, 1, 1, 2, 0, 1 a day in the first week, 2, 1, 0, 4, 4, 4, 11 in the second: 3.7 a day against
  0.7. In computer hours, 0.1 an hour against under 0.1.
- **Stale pushes**: 10% of 1,144 in the second week (4% of 2,638 the week before, the noisy 11-15 among them);
  notifications still up after reading: 1 against 7.
- **Checks with nothing new**: 0 of 38 opens against 2 of 74. Busy channels put something on the list nearly
  every ten minutes, so an open almost always finds something.
- **The wait**: median 5 minutes over the last 7 days (4 minutes the week before), 90th percentile 22 hours (3 hours).
- **Owed over 3 days**: 15 at the end of 11-22, 23 a week before.
- **Breadth**: 79 people written to in 30 days, against 76 in the 30 before.

## Seams

- **Replay headlines** are not recorded: a replay's numbers go in its pull request and its doc.

A new scorer is a generator over one day (`DayContext`: the day's bounds, your identities, opens by chat) that yields
how many rows it read and returns its rows; add it to `SCORERS`, its chart to `SCORE_CHARTS`, and bump
`SCORE_VERSION` if an existing metric changed.

## Limits

- **Before the tiers (2026-11-10)** the same decision codes meant the four levels, and `probs` held other chances: the
  notification lines before then are the old levels', and the chance lines start with the tiers.
- **Notifications lead to opens.** A notified chat is opened more because it was notified; the learned and start lines
  share that, so their difference is fair, but a tier's share is not what it would be without notifying.
- **Small numbers.** A few alerts a day: a day's share swings by a third on one open. Read the tooltip's n, and the
  week against the week before.

## On a real hub (copy of 2026-11-14)

Days 2026-11-03 to 11-12 (the 13th had not matured):

- **Alerts** 6 of 6 opened within 3 hours (11-11 and 11-12); the next day's 17 were still maturing.
- **Conversations** 64–89% a day since 11-07 (9–40% before, under the four levels).
- **The list** 0–2% a day since 11-10 (11–56% before): list rows are almost never followed.
- **Importance**: AUC 0.98–0.99 learned and start alike; average precision 0.34 and 0.39 learned against 0.13 and
  0.25 for the start, and 0.32 and 0.38 for the candidate.
- **Alert chance**: AUC 0.76 and 0.70, the same learned and start (one mark in all).
- **Unprompted opens**: 2 to 21 a day, almost none held by the list.
- **Inbox order**: mean 1 ÷ row from 0.26–0.38 (11-03 to 11-05) to 0.47–0.58 (11-06 to 11-12); 90% of opens from the
  first 8 rows in the last week against 78% the week before.
