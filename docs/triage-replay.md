# The triage replay

`scripts/triage-replay.ts` replays the hub's history day by day against several decision policies and reports how
each would have done. Every change to triage's model is judged here first, then in shadow for a week
(docs/notifications.md "The shadow model"). The method is docs/research/notification-design.md §6.

```sh
bun scripts/triage-replay.ts --live <data dir>/hub.sqlite --out <scratch dir>   # copy, then replay
bun scripts/triage-replay.ts --db <scratch dir>/hub-copy-….sqlite --out <dir>  # replay an existing copy
  [--days 14] [--budget 48] [--tz -5] [--min-per-day 500] [--tune] [--extra my-features.ts]
```

- **It never writes to the live database.** It opens it read-only and `VACUUM INTO`s a copy in `--out`, then works on
  the copy (opening `Store` on it runs migrations there, which is fine).
- **Output**: `replay.md` (tables) and `replay.json` in `--out`. Counts, rates and test statistics only: never message
  text, names or ids. A run over a week of a busy hub takes one to two minutes, most of it rebuilding facts.

## What it does

1. **Examples.** Every message from someone else that triage decided on in the window (silenced places aside), with
   - its **facts**: as kept with the decision, else rebuilt by the rules (`Triage.rulesFor`) as the settings are now;
   - its **words**, for the model (read in memory, never written out);
   - its **interaction features** as of the message (`interact.ts`): a fold over every message in time order from two
     months before, plus the activity log at that moment;
   - its **outcome**, read from the future (`labels.ts` `gatherOutcomes`): your next message there and whether it
     answers this one, your reaction, whether you were already there, the push and what became of it (shown,
     dismissed, tapped and for how long), the next open, bursts and unprompted opens;
   - its **label** from that outcome (`implicitLabel`), with the chances it says something about.
2. **Rolling time split.** For each day after the first (local days, `--tz` hours from UTC; days with fewer than
   `--min-per-day` decisions are edges and left out): each policy fits on what was known before midnight (votes given
   before it, labels whose outcome was known before it), then decides that day.
3. **Delivery**, with and without **coalescing** (design §7): an Important decision sounds only on the first message
   of a run after a 5-minute lull, or a rise from Active, or when it mentions or replies to you.
4. **Metrics** over the test days, per policy, coalesced or not:
   - volume: notified/day, pings/day, alerts/day, the most alerts in any hour;
   - **precision**: of alerts when you were not already there, the share followed by your message there or your
     reaction within 15 minutes; and, separately because the push itself causes it, by an open within 15 minutes;
   - **recall**: of reply events (your answer within 15 minutes to a message, not already there), the share where
     something sounded in that conversation in the half hour before, up to your answer;
   - **recall at a budget** of alerts/day (`--budget`, default what was logged): the ping threshold that hits it,
     chosen per policy on the test days themselves, so it compares rankings at equal volume;
   - **missed unprompted opens**: bursts nobody was notified about that you opened within the hour anyway, which this
     policy would not have notified either;
   - **held-out votes**: each vote scored by the model fitted before the day it was given; right level, and log loss;
   - **calibration**: Brier score and a reliability table per chance against fixed reference outcomes (ping: you
     acted within 15 min, not already there; active: answered within 3 h, reacted, opened within the hour, or opened
     unprompted; interesting: anything at all);
   - **latency**: median minutes to your answer, alerted or not;
   - **paired tests**: exact McNemar on the same reply events, each policy against P1 (and P0);
   - **agree / disagree** with what was logged: precision where the logged decision also pinged, and where it did not;
   - **exploration**: how many messages a day each policy would let exploration draw on (shadow.ts).
5. With **`--tune`**, a grid over the implicit-label weights (a scale on the design's weights, and the weight of
   "nothing happened"), each scored on held-out votes, recall, precision and recall at the budget.

## Policies

| Name | What |
| --- | --- |
| L | what triage actually decided then; rules and models changed during the window, so this is history, not a policy |
| P0 | the network prior only: where the networks' own settings put it |
| P1 | the live model: votes and decisions that stood, refitted daily (votes.ts) |
| P1+labels | P1 with labels from what you did (labels.ts) instead of decisions that stood |
| P2 | P1+labels with interaction features (interact.ts): the shadow model the live hub runs |

**Adding a policy** (P3 embeddings, P4 local-model answers): write a module and pass it with `--extra`.

```ts
import type { Extra, ReplayExample } from './triage-replay.ts';
export const features: Extra['features'] = async (examples: ReplayExample[], db) => {
  for (const e of examples) e.x['emb'] = probeLogit(e);  // as of e.ts: cross-fitted, no future
};
export const policies: Extra['policies'] = (learned) => [
  learned('P3', 'P2 with the embedding probe', (ctx) => [...ctx.votes(ctx.cut, keep), ...ctx.implicit(ctx.cut, undefined, keep)], keep),
];
const keep = (k: string) => /^(rr|engaged|alt|since|device|open|emb)(:|$)/.test(k);
```

`learned(name, about, examples, x)` fits learn.ts's model on `examples(ctx)` before each day and decides with the
numeric features `x` keeps. Give a new kind of numeric feature its regularisation in `NUMERIC` (learn.ts).

## How to read it: the biases

- **Facts before 2026-11-04 are rebuilt by today's rules**: what the networks would notify, your rules, starred
  people. Those were not the rules of the day, so P0 and P1 decide by today's settings throughout, and L differs.
- **The logging policy shapes the labels.** Taps and push opens exist only for what was pushed: reported, not
  optimised alone. Answers, reactions and unprompted opens exist either way. Messages a new policy would ping that
  were not pinged carry labels from a world where you saw them later, so its precision is *under*estimated; messages
  it would not ping that were pinged carry labels the push helped cause, so its recall loss is *over*estimated. The
  agree / disagree table shows this. A policy that wins here probably wins live.
- **Small numbers.** A week of data has a few dozen reply events and a dozen votes: a 10-point difference in recall
  is about two standard errors only with two weeks or more. The McNemar p-values say how much of a difference is noise.
- **"Already there"** (you wrote there in the 15 minutes before, a visit spanned it, or an open page kept the
  notification to itself) is excluded from ping metrics: a buzz is worth nothing then.

## Results

First run: a copy of the live hub taken 2026-11-05. 177,561 decisions over 7 days (from 2026-10-30, when triage
began keeping them), 6 test days (5.5 days of data, 174,282 decisions). 12 votes, all on pings. 37 reply events (a
quick answer when you were not already there). Interaction features were rebuilt in the replay, since `triage_input`
was empty until then. The budget is what was logged, coalesced: 35 alerts a day.

| Policy | Pings/day | Alerts/day (coalesced) | Max alerts/h (coalesced) | Precision, reply ≤15 min (coalesced) | Recall | Recall at 35 alerts/day | Held-out votes right |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| L (logged) | 89.7 | 35.0 | 15 | 0.221 | 0.757 | (0.757) | 2 / 12 |
| P0 | 303.1 | 94.4 | 18 | 0.099 | 0.946 | cannot be cut | 2 / 12 |
| P1 | 290.8 | 92.4 | 18 | 0.099 | 0.919 | 0.595 | 2 / 12 |
| P1+labels | 278.1 | 83.3 | 17 | 0.110 | 0.919 | 0.838 | 4 / 12 |
| P2 | 156.0 | 55.4 | 12 | 0.170 | 0.919 | 0.838 | 8 / 12 |

What it says:

- **Today's rules ping far more than was logged.** P0 and P1 decide by today's settings, where Signal groups notify
  every message; L is history under older rules. The live hub pinged about 260 times on 2026-11-05, in line with P1.
- **Coalescing alone cuts alerts by two thirds** (P1: 291 pings, 92 alerts a day) and changes no decision.
- **P2, the shadow model, pings about half as often as P1 (156 against 291 a day; 55 against 92 alerts) at the same
  recall** (34 of 37 reply events each), with precision 0.17 against 0.10. Uncoalesced, where P2 agrees with what
  was logged its precision is 0.38. Where it pings something that was not pinged, it is 0.07, and the bias above
  makes that number pessimistic.
- **At an equal budget of 35 alerts a day, the labels are what matter**: recall 0.84 for P1+labels and P2 against 0.60
  for P1. Paired on the same events, P2 covers 9 that P1 misses and P1 none that P2 misses (McNemar p = 0.004).
  P1+labels covers 12 that P1 misses and misses 3 (p = 0.035).
- **Calibration improves but is still poor for ping.** Brier score for ping: P1 0.0071, P2 0.0045, against a base rate
  of 0.07%. Both still put 0.8–0.9 on every message in a chatty group. The *interesting* chance gets worse (0.130 to
  0.160): no label says "not interesting", so it only learns to go up. It decides nothing yet, but it needs negatives
  (a digest entry seen and left) before it can.
- **Votes**: P2 gets 8 of the 12 held-out votes right, P1 2. With 12 votes from 8 conversations, all of them "a ping
  that should have been Active", that is a hint, not evidence.
- **Exploration**: with P1 deciding, no message a day falls in the 25–50% Active band, so up-exploration could never
  fire on the live model's chances alone. With P2 about 9 a day do, which is why the shadow's chance counts too
  (at 2% that is one every week or so). About 217 Important messages a day are in conversations busy enough for the
  down holdout.

**Tuning the label weights** (`--tune`, P2's shape). Scaling the design's weights by 0.5, 1 or 2 changes almost
nothing. The weight of "nothing happened" decides it:

| "Nothing happened" weight | Votes right | Alerts/day | Recall | Precision | Recall at budget |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 (the design's table alone) | 4 | 85.5 | 0.919 | 0.105 | 0.595 |
| 0.01 | 7 | 77.6 | 0.919 | 0.116 | 0.811 |
| **0.03** (chosen) | **8** | 55.4 | 0.919 | 0.170 | 0.838 |
| 0.1 | 6 | 44.9 | 0.865 | 0.195 | 0.784 |
| 0.3 | 6 | 36.4 | 0.811 | 0.232 | 0.784 |

At 0.03 the votes agree best and recall holds; above it, recall starts to drop. Without it, 8,235 of the 8,710 labels
are missing, nearly all the rest are positive, and the model can only learn to notify more. With 12 votes and 37
reply events this rules out the extremes. It does not fine-tune anything. Run it again after two more weeks of
`triage_input`, and with exploration's labels.

That table was chosen and scored on the same days, so its best row looks better than it is. Since 2026-11-06
`--tune` splits the test days in two: weights are chosen on the first half (validation) and reported on the second
(holdout). Run on 2026-11-06 (7 test days, 19 votes): the first four days hold only 2 votes, so the validation choice
(scale 0.5, nothing 0.1) is noise and gets 7 of 17 holdout votes right, where nothing 0.03 gets 10 or 11 of 17 at
about 44 alerts a day. 0.03 stays. The split will mean something once the validation half has a few dozen votes.
