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
| `needs.predicted`, `needs.answered` | for owed replies whose 3 days ended that day, the mean "needs a reply" chance shown (`needs_prediction`, kept at 15 min, 1 h, 6 h and a day of age) and the share answered within the 3 days ([inbox.md](inbox.md#needs-a-reply)) | chances kept |
| `needs.brier`, `needs.brier_table` | the same: the Brier score of the chance shown, and of the owed table's chance alone | chances kept |

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

## Seams

- **The feed.** A feed to replace Catch up, with impressions logged, is being built. Once it logs them, add its
  click-through rate the same way.
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
