# Message embeddings as triage features

Status: built, **off by default** (`DITHER_EMBEDDINGS=1` turns it on). It decides nothing: it produces a numeric
feature map per message, which only the candidate model weighs, in shadow
([notifications.md](notifications.md#the-shadow-model)). The design and the reasons behind it are in
[research/notification-design.md](research/notification-design.md) §5. This page covers what was built, how to
evaluate it, and the evaluation's verdict.

Since the three tiers (2026-11) the features are made for one chance, a message's importance, where there were
three (ping, active, interesting), and jev is asked no questions for them. The evaluation and its results below are
from before the tiers: they scored the old ping label, an answer within 15 minutes.

## What it does

`packages/hub/src/embeddings.ts`:

- **jev embeds.** The machine's local model service (`~/Projects/jev`, not in this repo) has
  `POST /v1/embed {texts, instruct?, dims?}` → `{embeddings, model, dims}`, served by `qwen3-embedding:0.6b` in the
  same Ollama as its reranker. It fits on the GPU next to the reranker (about 6.1 of 8 GB with a 512-token context)
  and embeds about 45 short messages a second. jev caches every vector (float16), like its judgments. Nothing leaves
  the machine: the client refuses a URL that is not local or private.
- **What is embedded:** `[shape] text` under a fixed instruction ("what it asks of them, who it involves and how soon
  it needs them"). A body under 40 characters that replies to something carries the first 100 characters of that
  message, and whether it was yours. An empty body uses its first attachment's kind and file name, else its link
  title. With nothing to embed, there is no vector, and the features are missing.
- **Where it is kept:** `embeddings.sqlite` in the hub's data dir, its own file. It is never in the sync journal,
  exports or logs, and it can be regenerated, so backups need not include it. Each vector is 256-d (Matryoshka
  truncation), **centred** on a background mean, scaled to unit length, and stored as int8 with one scale (256 B a
  message). The mean comes from a random sample of 512 messages of the last 30 days. It is fixed once set, so stored
  vectors stay comparable. A different model, size or instruction empties the store and starts over. Retention: 30
  days, plus every labelled example (marked or voted, answered, or notified), which is kept indefinitely.
- **The embedder** runs in the background and never blocks triage. New messages are picked up by rowid every few
  seconds in batches of 64. With nothing new, it backfills the last 30 days slowly: up to 256 rows a step, with a
  4-second pause between steps (on the live hub, about 140k messages and roughly 1.5 h of mostly idle GPU). If jev is
  down, a step fails, it waits 5 minutes and tries again, and meanwhile the features are missing (they count as
  zero). `prepare(ids, timeoutMs)` embeds a message at once, with a deadline, for a caller that wants the feature
  before deciding.
- **jev's questions**: none now (`QUESTIONS` is empty). Before the tiers there were three, `ask` (asks the reader to
  reply, decide or do something?), `soon` (time-sensitive, needs attention today?) and `plans` (plans that include
  the reader?), as features for the shadow model only; on real messages they answered yes about 1% of the time. The
  one question that decides anything now, whether a message cannot wait, is triage's own (`triage.ts`
  `STOP_QUESTION`, [notifications.md](notifications.md#alert)). The code that asks is still here for a question added
  later: about messages in conversations you wrote or reacted in during the last 30 days, before triage decides
  (`prepare`), at most 2000 a day, as fixed strings so jev's cache works and the features keep their meaning.
  Answers kept from the three old questions are not features any more.

## The features

`embeddings.features(messageId, head = 'important')` → `{ emb?, knn? }`, and a `jev:<q>` for each question in
`QUESTIONS` (none now). A key is absent when it is unknown.

| Feature | What it is |
| --- | --- |
| `emb` | A linear probe's logit: L2 logistic regression on the centred vector. It is trained on top of each example's conversation answer rate (an offset), so it learns only the within-conversation part. **Cross-fitted:** a labelled example gets the logit from a probe fitted on the other four time-blocks. Any other message is scored by the probe fitted on all of them. |
| `knn` | The mean cosine to the 5 nearest labelled positives minus the same for negatives. It uses the narrowest scope (the same author, else the conversation, else everything) that has ≥10 examples of both kinds. An example leaves itself out. |
| `jev:<q>` | `logit(P(yes))`, clipped at 0.001. P(yes) is uncalibrated, and the learning model's weight calibrates it. |

Labels for the probe and kNN, refitted daily (`refit()`):

- important: answered (a reply, a reaction, or your next message there) within 3 hours; not important: not
  answered by then. Only messages from others in conversations where you wrote or reacted in the last 30 days, and
  not those you were already engaged with (you wrote there in the 15 minutes before). They count half.
- "Less like this" as not important, and the votes from before the tiers (Important or Active as important, Digest
  or Not interesting as not), at full weight.
- It is fitted only with ≥10 positives and ≥10 negatives. Otherwise `emb` and `knn` are missing.

How it is wired in: the candidate model weighs `emb` and `knn` as numeric features of importance, each held by 5
(`NUMERIC` in `learn.ts`; `triage.content` in `main.ts`). They are read when deciding, made just before if jev
answers within 800 ms, and for training they are read afresh, so a labelled message's probe score never learned
from its own label. The live decision does not use them.

## Evaluating it: `scripts/embed-eval.ts`

```sh
bun scripts/embed-eval.ts --db .data/hub.sqlite --scratch <scratch dir> [--days 30] [--engaged] [--fresh]
```

1. It copies the hub DB with `VACUUM INTO` (a read-only connection to the live file) and works on the copy.
2. Examples are the messages from others in conversations where you wrote or reacted in the window. Each is labelled
   by the §3 rule: answered within 15 minutes = 1, else 0. Messages you were engaged with are left out unless
   `--engaged` is given. Reactions carry no time on the networks, so a reaction counts as immediate.
3. It embeds them and asks jev every question in `QUESTIONS` about all of them: three when the results below were
   made, none now, so a run today leaves the jev rows empty. Both are cached in `<scratch>/eval-embeddings.sqlite`.
4. **Rolling time split:** for each day after a 2-day warm-up, everything (probe, kNN, centroids, the stacking
   weights) is fitted on examples whose label was known before that day began. Then that day is scored. The
   conversation answer rate is point-in-time, from labels known by each message's own time.
5. **Metric:** PR-AUC within each conversation, averaged over conversations with ≥5 positives among the scored days.
   It also reports how many of those conversations beat the rate alone, and pooled PR-AUC and ROC-AUC for context.
   Combinations are a logistic regression on out-of-fold columns ("stacking").

It prints and writes (`<scratch>/embed-eval.json`) aggregate numbers only.

## Results (2026-11-05, before the tiers)

These come from a `VACUUM INTO` copy of the live database, 30-day window, probe λ=10 unless stated. The label is the
old ping label (answered within 15 minutes), and "the §5 gate" and "Active" below are the three chances of that time.
The data is small: the hub has held full traffic for about 6 days, and you wrote or reacted in about 50 conversations.

**Main run (engaged messages left out, as §3 defines the ping label):** 1483 examples, 138 answered within 15 min,
48 conversations. Scored: 1408 (123 positive) over 18 rolling days. **7 conversations** have ≥5 positives, and chance
PR-AUC within them is 0.303.

| Method | Within-conversation PR-AUC | Beats the rate in | Pooled PR-AUC | Pooled ROC-AUC |
| --- | ---: | ---: | ---: | ---: |
| conversation reply rate | 0.287 | — | 0.243 | 0.812 |
| rate + probe (`emb`) | 0.335 | 7/7 | 0.259 | 0.818 |
| rate + probe, λ=1 | 0.414 | 6/7 | 0.278 | 0.816 |
| rate + probe, λ=100 | 0.306 | 5/7 | 0.252 | 0.816 |
| rate + kNN | 0.376 | 6/7 | 0.262 | 0.820 |
| rate + probe + kNN | 0.385 | 6/7 | 0.258 | 0.818 |
| rate + jev answers (every message) | 0.402 | 6/7 | 0.276 | 0.823 |
| rate + jev answers (gated as §5) | 0.292 | 3/7 | 0.247 | 0.815 |
| rate + probe + kNN + jev | 0.398 | 5/7 | 0.279 | 0.824 |
| rate + probe + kNN + jev (gated) | 0.385 | 6/7 | 0.258 | 0.818 |
| centroid of answered, raw | 0.374 | 5/7 | 0.192 | 0.686 |
| centroid of answered, centred | 0.384 | 5/7 | 0.230 | 0.755 |
| rate + centroid, centred | 0.307 | 5/7 | 0.261 | 0.826 |

**With engaged messages kept (`--engaged`), a bigger but noisier set:** 1966 scored (329 positive) over 24 days,
**18 conversations** with ≥5 positives, and chance 0.381. Within-conversation PR-AUC: rate 0.364; + probe 0.394
(beats the rate in 12/18); λ=1 0.427 (14/18); + kNN alone 0.371 (9/18); + probe + kNN 0.406 (13/18); + jev answers
0.399 (14/18); everything 0.417 (14/18); centroid raw 0.420, centred 0.448 (13/18); rate + centred centroid 0.383.
Pooled ROC-AUC: rate 0.785, everything 0.797, centroid raw 0.692, centred 0.761.

Cost on the live machine: jev embedded about 2500 texts (eval set plus the 1024-message mean sample) in 94 s,
including database reads. The 4449 yes/no judgments took 473 s, about 0.11 s each.

### What it says

- **Content does help within a conversation, and only there.** Within a chat, the rate alone ranks at chance, as it
  must. Every content feature lifts it. The probe beats the rate in 7 of 7 conversations in the main run (a sign test
  gives p ≈ 0.008) and in 12 to 14 of 18 with engaged messages. The size of the gain is uncertain: +0.03 to +0.13
  PR-AUC over chance, from 7 conversations and 123 positives. Pooled over all conversations, the gain is small (ROC
  0.81 → 0.82), because the conversation already explains most of it, exactly as §5 predicted.
- **The centroid works within a conversation, but not across them.** Centred, it ranks about as well as the probe
  inside a chat (0.384 and 0.448). Across chats it is clearly worse than the rate (pooled ROC 0.69 raw, 0.76 centred,
  vs 0.81): it ranks "casual DM register" above "the group chat where you answer". Centring helps it in both runs.
  Stacked with the rate on pooled data, its weight comes out small, and it loses most of its within-chat gain. That is
  an argument for a conversation-relative feature (centroid or kNN computed per conversation), which `knn` already is
  when a scope has enough examples.
- **The probe's regularisation matters**, and λ=1 beat λ=10 in both runs. That was chosen on the test days, so it is
  optimistic. The daily refit should pick λ by its own cross-validation rather than using a fixed default.
- **jev's answers help as much as the probe, but the §5 gate kills them.** The gate (ping 0.3–0.95 or Active ≥0.2)
  lets through only 14–16% of these messages, and gated answers add nothing. The messages that matter are the ones
  in conversations where you take part, about 350 a day lately, and asking jev's three questions about all of them
  costs about 2 minutes of GPU a day.

### Recommendation

**Do not let these features decide anything yet. Turn them on in shadow.** Set `DITHER_EMBEDDINGS=1` on the live hub
now: it is cheap (256 B a message, about 1.5 h of slow backfill, about 45 messages/s on the GPU next to the reranker),
and every day without it is lost data. Wire `emb` and `knn` into `learn.ts` as numeric features (λ≈5) **in shadow
mode** (§4). Re-run this evaluation after two more weeks, when there should be 15–20 conversations with ≥5 positives
without engaged messages. Switch on if the within-conversation gain holds (the probe beating the rate in most
conversations) and at-budget recall does not drop.

Done (2026-11-05): `DITHER_EMBEDDINGS=1` is on, the shadow model weighs `emb`, `knn` and the jev answers
(docs/notifications.md, "The shadow model"), and the two changes below are in. Since the tiers the jev answers are
gone again: the three questions fed only the shadow model and answered yes about 1% of the time, and the one
question that decides anything is the alert's.

1. **Change the jev gate** from "triage is unsure" to "a conversation you wrote or reacted in during the last 30
   days" (about 350 messages a day). Under the §5 gate the answers are useless here, and ungated they are among the
   best features.
2. **Choose the probe's λ by inner cross-validation** in `refit()` (`chooseLambda`, from 1, 3, 10 and 30, by
   out-of-fold log loss on the time folds).

Do not ship the plain centroid as a feature: across conversations it is worse than nothing.
