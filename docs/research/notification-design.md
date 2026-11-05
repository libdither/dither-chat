# Notification triage, from first principles: a design report

Research notes, 2026-11-05. Nothing here is built yet. It covers what a good notification is for this hub, which
labels and features to learn it from, whether message embeddings help, how to run experiments honestly, how to group
several messages into one notification (Android and web push), and why the Android avatar sits on the wrong side.

Every number below is an aggregate from a `VACUUM INTO` copy of the live database taken on 2026-11-05. No message
text, names or ids are quoted. Embedding timings come from a throwaway CPU-only Ollama in a scratch directory, using
made-up texts.

## TL;DR

1. **Keep the hierarchical logistic model as the core.** It is the right shape: a prior from the networks, an L2
   residual from votes, cheap enough to refit on every vote, and it can explain itself. What it lacks is labels and
   features, not model capacity.
2. **The conversation decides most of it.** In a 4-day replay, a per-conversation "how often do you answer here"
   rate, computed only from earlier data, ranks messages with **AUC 0.993** for "you wrote there within 30 minutes".
   At the current ping volume it matches or beats today's decisions (precision 0.27 vs 0.24, recall 0.66 vs 0.60).
   Add interaction features (reply rate per conversation and per author, whether you are already engaged, time since
   you last read, push open rate) before anything to do with content.
3. **Split deciding from alerting.** One notification per conversation, updated in place, which buzzes only on the
   first message of a burst (a 5-minute lull) or when the level goes up. On the last two days this turns
   **136 Important notifications/day into about 48 alerts/day** without changing a single decision. It is the
   biggest and cheapest win.
4. **Embeddings: yes as a feature, no as a single centroid.** The responded-to set is dominated by DMs where you
   answer nearly everything, so its centroid encodes "casual chat register", not "needs me". Use centered,
   instruction-prompted embeddings as (a) a cross-fitted linear probe whose logit is one feature and (b) a kNN
   similarity to labelled positives and negatives. Model: **Qwen3-Embedding-0.6B** behind a new `jev` `/v1/embed`
   (EmbeddingGemma-300M is the cheaper alternative). Embedding every message costs about 24 CPU-minutes a day on
   CPU alone, and less on the GPU.
5. **Evaluate offline first, on a rolling time-split replay of a DB copy.** The replay is biased by the current
   policy, but in a known, conservative direction. Use labels that exist whether or not a message was pushed
   (replies, reactions, unprompted opens, votes). Then add **logged-propensity exploration** that is only ever
   *silent*: ≤3 extra Active notifications a day near the threshold, and a small holdout that demotes Important to
   Active. That makes proper off-policy estimates (IPS/SNIPS) possible later.
6. **Android avatar fix:** use `MessagingStyle` with a `Person` per author, plus a long-lived dynamic shortcut per
   conversation (`setLongLived`, `setPerson`, `setLocusId`, `pushDynamicShortcut`) and `setShortcutId` on the
   notification. Stop setting `largeIcon`. On Android 11+ the avatar then takes the icon slot, the network glyph
   becomes its badge, and the notification lands in the Conversations section.

---

## 1. What the data says today

### Volume and where it comes from (last 3 days, per day)

| Where | Incoming/day |
| --- | ---: |
| Discord channels | ~34,000 (98%) |
| Signal groups | ~490 |
| Matrix channels | ~80 |
| Signal DMs | ~54 |
| WhatsApp groups | ~29 |
| Discord DMs + group DMs | ~25 |

- **27% of incoming bodies are empty** (attachments, stickers, embeds). Text length: median 27 characters, p90 117,
  p99 429. Anything that reads content must handle "no text".
- **Your own messages:** ~30–100 a day. Over the last 14 days: Signal DMs 281, Discord DMs 170, Signal groups 42,
  Discord channels 15, the rest a handful.
- **Response events** (your first message after someone else's, within 30 minutes) over 7 days: 165, in 34
  conversations. The message you answered had been decided as: push 109, digest 24, *silent* 18, quiet 1, untriaged 13.
  So about a third of what you answer was not pushed. That is the recall gap, and the silent ones are places you set
  to Nothing but still answer, presumably when you are already at a computer.

### What triage does now

- **Pings are well below the ~860/day projected at ship.** Last 24 hours: 247 push decisions across 24
  conversations. The top conversation is 43% of them, the top 3 are 66%, the top 10 are 89%. By network: Signal groups
  156, Signal DMs 47, Discord channels 37. Over the last 2 days: 136 push/day, 209 push+quiet/day.
- **Votes: 9 in total**, all downward (7 Important→Active, 2 Active→Digest), across 8 conversations. The model so far
  rests almost entirely on the prior.
- **Activity log** (running since ~2026-11-02, so thin): 420 message notifications; devices confirmed delivery of 131,
  89 were shown and 47 suppressed (a page was open), 9 tapped, 5 dismissed, 0 replied from the notification. Median
  time to tap 1.9 min (p75 4.9, p90 9.5). Of the 420, 96 were opened by any route within an hour (85 within 15 min),
  and 47 were followed by your message within 30 min. 181 visits: 147 desktop Chrome, 34 Android app.
- **`triage_input` has 0 rows**: `DITHER_ACTIVITY_FEATURES` is off on the live hub, so no point-in-time features are
  being kept. Turning it on is step 1 of the build order. It changes no decision.

### A first replay (the harness in §5, in miniature)

Setup: the last 4 days. Test messages are those from others **not** arriving while you were already engaged (you had
written there in the previous 15 min): 33.8k/day. Label: you wrote in that conversation within 30 min. 134 positives
in 4 days, a **base rate of 0.10%**. Positives are 90 in DMs, 37 in groups and 7 in channels, and fall in 21 of 715
active conversations.

| Policy | Volume/day | Precision | Recall |
| --- | ---: | ---: | ---: |
| Current decisions = push | 83 | 0.244 | 0.604 |
| Current push or quiet | 112 | 0.197 | 0.657 |
| Per-conversation reply rate (Beta-smoothed, earlier data only), top-k at the same volume | 83 | 0.265 | 0.657 |
| … at half the volume | 42 | 0.355 | 0.440 |
| … at a quarter | 21 | 0.373 | 0.231 |

The reply rate alone has AUC 0.993. Two caveats. First, this label is partly *caused* by pushes, which favours the
current policy. Second, at a 0.1% base rate AUC is flattered by the ~34k/day of channel chatter that nobody answers,
so precision and recall at a fixed budget are the honest numbers. Even so, a one-feature model matches the current
policy. **Interaction features come first.**

---

## 2. The objective: what is a good notification here?

A notification is an **interruption bought with your attention**. Its value is not "is this message interesting" but
"is it worth more to see it *now* than at the next time you would look anyway":

```
value(ping m) ≈ P(you act on m | you see it) × (value of acting now − value of acting at your next natural check) − cost(interruption)
```

Three things follow, and the current model ignores them:

1. **Timeliness, not interest.** A great message in a channel you check hourly is Digest. A dull "here, at the door"
   is Important. Interest belongs to the *interesting* head. *ping* is about being late.
2. **Your current state.** If you are already in the chat, or active on the desktop, the counterfactual "next check"
   is seconds away and a phone buzz is worth about nothing. The page already suppresses toasts when focused; the hub
   should use the same fact when deciding to alert at all.
3. **Diminishing returns within a burst.** The tenth message of a running group conversation adds little over the
   first, because the first already brought you there. That is a delivery concern (§6), not a per-message one.

Operationally, define the three heads as:

| Head | Means | Positive evidence |
| --- | --- | --- |
| **ping** | you would want to act within ~15 min, and later is worse | vote Important; reply/reaction ≤15 min while not engaged; tap ≤5 min with dwell ≥20 s |
| **active** | worth seeing on the lock screen soon, no sound | vote ≥Active; opened or replied within an hour; a ping positive |
| **interesting** | worth reading at all | vote ≥Digest; read and dwelled in the chat; opened from the digest or board |

Then optimise **recall of ping-positives under an alert budget** (alerts per day, chosen by the user), the
constrained form LinkedIn and Pinterest use for notification volume. Thresholds are probabilities (0.8 means 80% sure),
so the model must be **calibrated**. The replay should report a reliability curve, not only a ranking.

---

## 3. Labels: which are reliable, and how much each counts

### Reliability

| Signal | What it measures | Bias | Use for |
| --- | --- | --- | --- |
| **Explicit vote** | value, in your own words | rare (9 so far); mostly on what you were notified about, so it fixes false positives; only the Not-interesting board yields false-negative votes | all heads; the gold standard for tuning everything else |
| **Reply / reaction to it** (`reply_to_id`, your reaction, or your next message in the conversation) | you acted | exists **whether or not it was pushed**, so the least policy-dependent label; but in a DM you answer the burst, not one message | ping/active positive; attribute to an explicit `reply_to`, else the last message before your reply |
| **Opened quickly** (tap ≤5 min, or any route ≤15 min) with dwell ≥20 s | attention | caused by the push itself, so it only says something about pushed messages | active positive; ping positive if fast |
| **Read soon after, no action** | mild interest | depends on the policy | interesting, weak positive |
| **Dismissed unopened** (Android delete intent) | "not now" | reliable on Android; missing on the web means nothing | ping negative only; says nothing about interesting |
| **Shown, never opened in 24 h** | ignored | the phone might have been off; "delivered" is only confirmed where code runs | weak ping/active negative |
| **Tapped, left in <5 s** | false alarm | rare | ping negative |
| **Native mute, or setting a place's level** | place-level preference | n/a | already a rule; keep it as the prior |
| Suppressed (page focused), `seenLive`, quiet hours | nothing | n/a | **exclude** |

### Proposed weights (start here, then tune on held-out votes)

| Label | Weight | Heads it informs |
| --- | ---: | --- |
| vote | 1.0 (decaying as now) | all three, as `labels()` does today |
| reply/reaction ≤15 min, not engaged | 0.5 | ping=1, active=1, interesting=1 |
| reply/reaction 15 min–3 h | 0.3 | active=1, interesting=1 (ping unknown) |
| tap ≤5 min and dwell ≥20 s | 0.3 | active=1, interesting=1; ping=1 if not in a burst you were already reading |
| opened ≤1 h (any route), no action | 0.1 | interesting=1 |
| dismissed unopened (Android) | 0.3 | ping=0 |
| shown, not opened within 24 h | 0.1 | ping=0, active=0 |
| tapped and left <5 s | 0.3 | ping=0 |
| unprompted open of an unpushed burst ≤1 h (`openedWithoutPush`) | 0.2 | active=1 on the burst's first message |

Two changes to `learn.ts` and `votes.ts` follow from this:

1. **Per-head label masks.** `Example.label: Level` becomes `y: Partial<Record<Head, 0 | 1>>`. A dismissal says
   nothing about *interesting*. `train` skips the heads an example does not label. This is a small change in the inner
   loop.
2. **Replace "stood" with outcomes.** Today a notification you let stand counts 0.05 as "that was fine". That is
   self-confirming: the prior pushes, nobody votes, and the push counts as right. Once there are outcomes, a push that
   stood *and was opened or answered* is a positive, and one that stood *and was never opened* is a weak negative for
   ping. "Stood" alone should go to 0.

Votes stay gold. The implicit weights are hyperparameters, chosen in the replay to maximise agreement with **held-out
votes** (time-split). This mirrors Gmail Priority Inbox, which learned importance from actions (open, reply, archive,
delete) within a time window, and combined a global model with a per-user model by adding their log-odds. Here the
network prior plays the role of the global model.

### Interaction features worth having

All computed **point-in-time** (only from what happened before the message), stored with the decision in
`triage_input` so training never sees the future. Ranked by expected value:

| Feature | Source | Form | Worth |
| --- | --- | --- | --- |
| Your reply rate in this conversation (decayed, 30-day half-life) | `attention.ts` `Tally` (`conv_feature`) | logit of a Beta-smoothed rate, numeric | **high**: AUC 0.993 alone |
| Your reply rate to this author, here and across networks | `conv_author_feature`, person-level sum | same | high |
| Engaged now: you wrote here in the last 15 min / alternations in the last 30 min | messages | flag + count | high; *lowers* ping (you are there), raises active |
| Time since you last read or opened this conversation | `visit.read_to_ts`, `place_usage.last_visit` | log-bucketed | medium–high |
| Active on another device now (a visit active in the last 2 min) | `visit` | flag | medium: phone ping is less useful while you sit at the desktop |
| Push open rate / median time to open / unprompted-open rate here | `activity.ts` `placeFeatures` | numeric with counts | medium, once there is data (only ~9 taps so far) |
| Position in burst (messages since the last alert here) | messages | log count | medium; mostly handled by delivery coalescing |
| Hour of day / weekday | ts | cyclic | low for now: too little data |

`learn.ts` features are binary or fractional today. Add **numeric** ones (`rr:conv`, `rr:author`, `since:read`…)
with their own `lambda` (around 10: a few votes should not swing a global slope). Keep the per-conversation
indicator, since it absorbs what the rates miss.

---

## 4. Recommended architecture

```
message ─► facts (triage.ts) ───────────┐
          interaction features ─────────┤  (point-in-time, kept in triage_input)
          content: embedding probe/kNN ─┤  (jev /v1/embed, every message with text)
          content: jev yes/no answers ──┤  (gated: only near a threshold)
                                        ▼
            prior(network settings) + hierarchical L2 logistic residual  ──►  ping / active / interesting
                                        │                                     (calibrated; shadow copy logged)
                                        ▼
            exploration (silent only, logged propensity)
                                        ▼
            DELIVERY: per-conversation notification, alert-or-update, burst coalescing,
                      desktop-active suppression, alert budget, clear-on-read
```

- **Decision** stays per message (the Triage board, digest ranking and votes all need it).
- **Delivery** becomes per conversation. It decides whether this update makes a sound, whether to send at all
  (another device active), and when to clear (you read it elsewhere).
- **Shadow mode.** Any new model writes its chances next to the live ones (`triage.shadow` JSON) for a week before it
  decides anything. The board shows "the new model would have pinged 40 fewer and missed 1 you answered".
- **Training** keeps the current loop (refit on every vote, daily refit), with examples from §3 instead of votes +
  stood.

---

## 5. Embeddings: the verdict

### Can jev do it?

No. jev exposes only `/v1/judge` and `/v1/choose`. Its Ollama (0.40.0 on :11435) serves only
`Qwen3-Reranker-4B`, and `POST /api/embed` on it answers *"This server does not support embeddings"*. A reranker is
not an embedding model anyway. The same Ollama can serve a real embedding model next to it: the reranker takes
4.3 GB of the 8 GB, and a 0.6B embedder about 0.65 GB.

### Which model

Measured on CPU only (a scratch Ollama, Vulkan off, batches of 64 made-up messages of ~40 chars, 16 cores):

| Model | Size | Dims | Throughput (CPU) | One day (38k msgs) on CPU |
| --- | --- | --- | ---: | ---: |
| `qwen3-embedding:0.6b` (Q8_0) | 639 MB | 1024 (Matryoshka, truncate to 256) | 26/s | ~24 min |
| `embeddinggemma:300m` (BF16) | 622 MB | 768 (Matryoshka, 128–768) | 69/s | ~9 min |

The steady state is 0.44 messages/s, so either runs on CPU with room to spare. A 200k-message backfill takes about
2 h on CPU (Qwen), or minutes on the GPU. **Recommendation: Qwen3-Embedding-0.6B**, served from jev's Ollama on the GPU
when it is free and on CPU otherwise. It is instruction-aware, so one model can embed "what this message asks of the
reader", it is multilingual, and it ranks higher on MTEB. Keep EmbeddingGemma as the cheaper candidate and let the
replay choose between them. Add **`POST /v1/embed {texts, instruct?, dims?}` to jev**, cached in its `cache.db` like
judgments, so other local projects get embeddings too.

Storage: truncate to 256-d, center, and quantise to int8: 256 B/message, ~10 MB/day. Keep them in a **separate**
`embeddings.sqlite` next to the hub DB, so hub backups stay small and they can be regenerated. Keep 30 days of
everything, plus every labelled example indefinitely. Embeddings are derived from message text: never put them in the
sync journal, activity exports or logs.

What to embed: `instruct + [shape] text`, with the replied-to message's first ~100 characters prefixed when the text
is short ("lol" replying to *your* message is a different thing). Empty bodies get the attachment kind, file name or
embed title. If there is nothing, the feature is missing and contributes zero.

### Centroid vs kNN vs linear probe

The idea of comparing each message to the average of messages you responded to has four problems:

1. **The responded set is mostly DMs**, where you answer almost everything. The reason you answered is the person,
   not the content. Its centroid encodes "casual one-to-one register", which matches chatter in busy servers.
2. **There are no negatives.** Similarity to positives cannot tell "a topic you care about" from "a generic short
   message". All short chat messages sit at cosine 0.5–0.7 from each other (anisotropy). In a toy run with four
   made-up "reply-worthy" anchors and raw embeddings, "lmaooo" and "gm everyone" scored *above* "can you review my PR".
   After subtracting the mean embedding of background chatter and adding a task prompt, chatter fell to about 0, while
   "want to grab lunch thursday?" stayed at 0.5–0.6. **Centering is mandatory**. (With 4 anchors this toy is an
   illustration, not evidence.)
3. **Interests have several modes** (friends' plans, a work bug, a game's patch notes). One centroid averages them into
   a point that matches none of them well.
4. **It double-counts the conversation**, which the model already knows exactly.

What to do instead:

- **Linear probe** (the main one). Logistic regression on centered 256-d embeddings, per head, trained on the §3
  examples (positives *and* negatives), with the conversation's own weight already in the model so the probe learns
  the *within-conversation* residual. Feed its **cross-fitted** logit (out-of-fold, to avoid leakage) to `learn.ts` as
  one numeric feature `emb` with λ≈5. It stays explainable: "reads like messages you answer (+0.8)".
- **kNN similarity** (the few-shot part). For each head, the mean cosine to the k=5 nearest labelled positives minus
  the same for negatives, restricted to the same scope when it has ≥10 examples (author, then conversation, then
  everything). This catches "you always answer when someone asks about X" from three examples, before the probe has
  data. It is one feature, `knn`.
- **No dense 256-weight block inside `learn.ts`.** It would swamp the hierarchy and the "why" text.

Where it should help, and where it will not: it will help **within busy conversations where you answer some messages
and not others**, which is exactly where the ping volume is (the busy Signal groups), and with **digest ranking** in
channels. It will not help DMs, where conversation identity and the reply rate already say everything. Ship it only
if the replay shows a gain in **within-conversation** ranking (PR-AUC computed per conversation, averaged over
conversations with ≥5 positives) and at-budget recall.

### jev yes/no answers as features

At ~0.1 s per text on the GPU, all 38k/day would take about an hour of GPU a day, so gate it: ask only when the model
is uncertain (ping in 0.3–0.95, or active ≥0.2), roughly 1–2k messages/day. Ask 2–3 fixed questions ("asks the reader
to reply, decide or do something?", "time-sensitive: needs attention today?", "about plans that include the
reader?"). Use `logit(p)` as numeric features: P(yes) is uncalibrated (a made-up actionable request scored 0.22, plain
chatter 0.01–0.02), so the regression calibrates it. Questions must be fixed strings so jev's cache works and features
stay comparable over time.

---

## 6. Experiment methodology

### Replay first, live second

Iterate offline. Live, you get ~24 response events and a vote or two per day, which is too slow for model
development. Offline, ~2 weeks of history replays in seconds. Go live only with (a) shadow mode and (b) silent
exploration.

### The replay harness (`scripts/triage-replay.ts`, new)

1. **Copy.** Open the live DB read-only with bun:sqlite and `VACUUM INTO '<scratch>/hub-copy.sqlite'`. Never open
   `Store` on the live DB, because migrations write. `Store` on the copy is fine, and is needed for `Triage.factsFor`.
2. **Examples.** For every message from others in the window: facts (from `triage.facts`, else `factsFor`),
   point-in-time interaction features (folded in time order, from strictly earlier messages and visits), content
   features (embeddings from `embeddings.sqlite`, jev answers from its cache), and the §3 labels with their head masks,
   read from the *future*. Mark `engaged`, `seenLive`, quiet-hours and suppressed messages, and exclude them from
   ping metrics.
3. **Rolling time split.** For each day *d* in the window: train on examples labelled before *d* (votes with
   `feedback_at < d`), predict day *d*, and step forward. This matches the daily refit and never leaks.
4. **Policies.** P0 network prior only; P1 the live model; P2 + interaction features; P3 + embeddings; P4 + jev. Each
   is run with and without delivery coalescing.
5. **Metrics, per day and averaged across folds:**
   - **Volume**: notifications/day, *alerts/day* after coalescing, max alerts in any hour.
   - **Ping precision**: share of alerted bursts followed by a reply or reaction within 15 min, and by an open within
     15 min (the open metric is shown separately because it is biased).
   - **Recall at budget**: of reply/reaction events (not engaged), the share whose message was pushed/alerted at
     ≤N alerts/day. Also the share of up-votes covered.
   - **Missed importance**: unprompted-open bursts that were not notified.
   - **Vote agreement**: held-out votes, as `backtest` does now, but time-split.
   - **Calibration**: reliability curve and Brier score per head (0.8 must mean 80%).
   - **Latency**: median time from message to your reply, for alerted vs not alerted.
   - **Paired tests**: compare policies on the *same* messages (McNemar on the positives). With ~134 positives in 4
     days, the standard error on recall is ±0.04, so expect two weeks of data to detect a 10-point difference.
6. **Output.** A markdown table and a JSON file in the scratch dir, never message text. Later, a `--report` mode the
   board can show.

### Honesty about the logging policy

We only see what you did given what the current policy did.

- **Policy-independent labels first.** Replies, reactions, unprompted opens and Not-interesting-board votes occur
  whether or not a message was pushed. Opens caused by taps exist only for pushed messages: report them, but do not
  optimise on them alone.
- **The bias is conservative for a new policy.** Messages the new policy would push but the old did not carry labels
  from the unpushed world, where you saw them later or never, so their precision is *under*estimated. Messages the old
  policy pushed and the new would not carry labels from the pushed world, which inflates them, so the recall loss is
  *over*estimated. If a new policy wins the replay, it probably wins live. Report the "agree" and "disagree" slices
  separately so this is visible.
- **IPS is impossible today.** The live policy is deterministic (propensity 0 or 1), so inverse-propensity estimates
  cannot evaluate where policies disagree. Exploration with *logged propensities* fixes that going forward, and then
  SNIPS or doubly-robust estimates become possible for the Active head.
- **Uplift, not response.** What a ping should maximise is the *difference* it makes (you would have answered anyway
  if you were already there). Excluding engaged and seen-live messages is the cheap approximation. The demotion
  holdout below measures the real effect.

### Live exploration (safe by construction)

- **Upward, silent only.** With probability ε (2%, capped at **3 a day**), promote a Digest or Not-interesting message
  whose `active` chance is in the top band below threshold to **Active** (a silent notification, never a buzz). It
  carries a "Trying this one: worth it?" line so the vote buttons are the answer. Log `explore: 'up'` and the
  propensity on the `triage` row.
- **Downward holdout.** In conversations with ≥10 pushes/day, demote 5% of Important to **Active** (still shown,
  silently), at most once per conversation per day. This measures how much the buzz itself matters: time-to-open with
  vs without sound.
- **Never explore** in places set to Nothing, during quiet hours, for starred people or keywords, for a direct mention
  or a reply to you, or in a DM's first message after a lull.
- **Shadow before switching.** Every model change runs in shadow for ≥7 days. It is switched on only if the replay
  *and* the shadow week agree it is better at the same or lower alert volume.

---

## 7. Grouping several messages into one notification

### Today

- Web: `sw.js` `show()` uses `tag = conversationId`, so a new message *replaces* the old one and shows **only the
  latest message**, with `renotify: true` for Important, which buzzes on every message.
- Android: `nm.notify(tag = conversationId, ID = 1)` also replaces. Every Important message re-alerts (HIGH channel,
  no `setOnlyAlertOnce`), and the content is just the latest message in `BigTextStyle`.

### How Discord and Signal do it

On Android, both post **one notification per conversation**, using `MessagingStyle` with the last several messages,
each carrying its sender's `Person` (name and avatar). The notification is linked to a long-lived conversation shortcut
(next section). Each conversation's notification is a child in **one app group with a summary** that lists the
conversations. Updates within a conversation use `setOnlyAlertOnce` or explicit alert logic so a burst does not buzz
on every message, and Android adds its own cooldown on repeated sounds. When you read the conversation on another
device, the notification is cancelled. Inline reply appends your message to the style instead of dismissing it.

### Recommended design

**Hub (`main.ts` `deliver`, `webpush.ts` payload).**

- Add `lines`: the last ≤6 messages from others in this conversation since your last read or last own message (only
  those triage decided at Digest or above), each `{ author, authorKey, body (≤200 chars), ts }`. Add `count` (unread
  since then), `sender: { name, key, icon }`, `conv: { title, shape, icon }`, and **`alert: boolean`**. Trim bodies and
  then drop the oldest lines to stay under ~3.5 KB (the web-push limit is ~4 KB). Inline pictures only when tiny, as
  `notifyLook` does now.
- **Alert rule** (per conversation, kept in memory and in `meta`): `alert = level === 'push' && (no message here in
  the last 5 min || level rose since the last alert || it mentions/replies to you)`. Otherwise the notification is
  updated silently. Measured on the last 2 days: 136 → 48 alerts/day at 5 min (62 at 2 min, 38 at 15 min).
- **Skip the buzz when another device is active.** If a visit was active on any device in the last 2 minutes, send it
  with `alert: false`.
- **Clear on read.** When the conversation is read anywhere (a visit with `read_to_ts`, or a read receipt from the
  network for your own account), send `{ clear: conversationId }` to the phones. sw.js closes the notification by
  `tag`; Android calls `cancel(tag, ID)`. This avoids stale notifications, and "cleared by reading elsewhere" is itself
  a useful label.

**Android (`Notifications.kt`).** One notification per conversation (tag = conversation id, as now), built with
`Notification.MessagingStyle` from `lines`. Call `setOnlyAlertOnce(!alert)` so an update without `alert` changes the
text silently. Move between the Important and Active channels by re-posting with the same tag and id. Add
`setGroup("dither-messages")` to every message notification and post a summary
(`setGroupSummary(true)`, `InboxStyle` with one line per conversation,
`setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)`) once two or more are showing. The digest gets its own group.
After an inline reply, re-post with your message appended (`addMessage(text, now, null)`, where null means you) and
`setOnlyAlertOnce(true)`, instead of `clear()`.

**Web (`sw.js`).** The web has no `MessagingStyle`, so merge bodies:

```js
const prev = (await self.registration.getNotifications({ tag }))[0];
const lines = d.lines ?? [...(prev?.data?.lines ?? []), { author: d.senderName, body: d.body }].slice(-5);
const title = d.conv?.shape === 'direct' ? d.title : `${d.conv?.title ?? d.title}${lines.length > 1 ? ` (${d.count ?? lines.length})` : ''}`;
const body = lines.map((l) => (d.conv?.shape === 'direct' ? l.body : `${l.author}: ${l.body}`)).join('\n');
await self.registration.showNotification(title, { tag, body, renotify: !!d.alert, silent: !d.alert, data: { ...data, lines }, ... });
```

`renotify` needs a `tag`. Chromium honours it; other browsers vary (MDN), so `silent` carries the real intent. Keep
the existing "close if a window is focused" logic, and add a `push` handler for `{ clear }` that closes by tag.

---

## 8. The Android avatar: what Discord does, and what to change

### Why the picture is on the right

`Notifications.post` uses `Notification.Builder` with `BigTextStyle` and sets the sender's picture with
`setLargeIcon`. In the standard template the large icon is drawn on the right, and the left slot is the small icon,
here the network glyph. That is correct for a non-conversation notification.

### What Discord (and Signal, Google Messages) do

Android 11 added **conversation notifications**. A notification that (1) uses `MessagingStyle`, (2) has a `Person`
for its messages, and (3) is linked with `setShortcutId` to a **valid long-lived dynamic or cached sharing shortcut**
is drawn in the *conversation layout*:

- The **conversation icon** (the shortcut's icon: the person for a DM, the group's or channel's for a group) sits in
  the icon slot on the left.
- The **small icon becomes a small badge** on that avatar. Here that is the network glyph in its colour, which gives
  the "avatar with a network badge" look for free.
- It lands in the **Conversations section** at the top of the shade, gets per-conversation settings (Priority, Silent,
  its own channel created by the system on demand), and can be made a bubble.
- `setLocusId` on both the shortcut and the notification helps the system rank and dismiss it.

Without a shortcut on API 30+, the system falls back to the ordinary layout, which is what we see now.

### Exactly what to change in `Notifications.kt`

All of these are platform APIs (no androidx needed). Guard API 30 calls, since minSdk is 29.

```kotlin
import android.app.Person
import android.content.LocusId
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.os.Build

private fun shortcutId(conv: String) = "conv:$conv"

/** One long-lived shortcut per conversation: what makes Android draw a conversation notification (avatar on the left). */
private fun publishConversation(c: Context, conv: String, title: String, icon: Icon?, people: List<Person>, hash: String) {
    val sm = c.getSystemService(ShortcutManager::class.java) ?: return
    val b = ShortcutInfo.Builder(c, shortcutId(conv))
        .setShortLabel(title.take(25)).setLongLabel(title)
        .setIntent(Intent(c, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_HASH, hash))
        .setLocusId(LocusId(shortcutId(conv)))
        .setPersons(people.toTypedArray())
        .setCategories(setOf("org.libdither.chat.category.CONVERSATION"))
    icon?.let { b.setIcon(it) }                       // adaptive: Icon.createWithAdaptiveBitmap(padded avatar)
    if (Build.VERSION.SDK_INT >= 30) { b.setLongLived(true); sm.pushDynamicShortcut(b.build()) }
    else runCatching { sm.addDynamicShortcuts(listOf(b.build())) }
}

// in post(), for a message notification:
val me = Person.Builder().setName("You").setKey("self").build()
val style = Notification.MessagingStyle(me)
    .setConversationTitle(if (group) convTitle else null)
    .setGroupConversation(group)
for (l in lines) style.addMessage(Notification.MessagingStyle.Message(l.body, l.ts, personFor(l)))  // Person: name, key, Icon.createWithBitmap(square avatar)
publishConversation(c, conv, convTitle, convIcon, people, hash)
b.setStyle(style)
 .setShortcutId(shortcutId(conv))
 .setLocusId(LocusId(shortcutId(conv)))
 .setOnlyAlertOnce(!alert)
 .setGroup("dither-messages")
// and stop calling setLargeIcon for message notifications: the conversation layout uses the shortcut's icon.
```

Details that matter:

- **Icons.** A `Person` icon is a *square* bitmap: the system crops it to a circle, so pass the plain picture, not the
  ringed and badged drawing `Looks.draw` makes. The shortcut icon should be `Icon.createWithAdaptiveBitmap`, with the
  picture scaled into the central 72/108 safe zone. For a DM it is the person's avatar; for a group or channel, the
  group/server icon, with sender avatars on each message inside. Keep `Looks.draw` for the digest and other
  non-conversation notifications.
- **Payload.** `store.notifyLook` returns one `icon` today (the sender's, else the conversation's). Split it into
  `sender.icon` and `conv.icon`, plus `sender.name` and `sender.key`.
- **`MainActivity`.** When a conversation is open, call `setLocusContext(LocusId(shortcutId(conv)), null)` (API 29),
  so the system knows the conversation is on screen. Report shortcut use
  (`ShortcutManager.reportShortcutUsed`) when you send there.
- **Cleanup.** `removeLongLivedShortcuts(listOf(id))` (API 30) when a conversation is archived or left. Android caps
  dynamic shortcuts at about 15 per activity and evicts the lowest-ranked; shortcuts referenced by notifications are
  cached by the system, so this is fine. The `CONVERSATION` category is optional for the notification layout; a
  share-target declaration in `shortcuts.xml` with that category would also make the conversations appear in the
  Share sheet, a free extra.
- **Bubbles** (`BubbleMetadata`) are possible later; they need a resizable activity able to show one conversation.
- **Android 10 (API 29)**: `MessagingStyle` works but there is no conversation section. It is only the API 30 calls
  that need guards.

---

## 9. Build order

| # | What | Why now | Effort |
| --- | --- | --- | --- |
| 1 | Turn on `DITHER_ACTIVITY_FEATURES` on the live hub (no decision change); add `explore`/`propensity`/`shadow` columns to `triage` | every day without it is lost point-in-time training data | 0.5 d |
| 2 | **Delivery**: per-conversation alert/update with 5-min burst coalescing, desktop-active suppression, `lines` payload, clear-on-read push; sw.js merged bodies | 136 → ~48 alerts/day without touching the model; the biggest felt improvement | 1–1.5 d |
| 3 | **Android conversation notifications**: `MessagingStyle` + `Person` + long-lived shortcut + `setShortcutId`/`LocusId`, group summary, `setOnlyAlertOnce(!alert)`, reply appends | the avatar fix and Discord-like grouping; needs 2's payload | 1 d (+ emulator check on `dither35`, API 35) |
| 4 | **Replay harness** `scripts/triage-replay.ts` with rolling splits and §6 metrics; baselines for P0/P1 | every later change needs it to be judged | 1.5–2 d |
| 5 | **Labels**: per-head masks in `learn.ts`, implicit labels from replies/opens/dismissals, replace "stood"; weights tuned on held-out votes | votes are too few (9) to learn from alone | 1–2 d |
| 6 | **Interaction features** (reply rates per conversation/author, engaged, since-read, other device active, open rates) as numeric features | the strongest signal measured (AUC 0.993 alone) | 1 d |
| 7 | Shadow mode + silent exploration with logged propensities; board line "would have pinged N fewer" | makes going live safe and off-policy evaluation possible | 1 d |
| 8 | **Embeddings**: jev `/v1/embed` (Qwen3-Embedding-0.6B), `embeddings.sqlite`, backfill, cross-fitted probe + kNN features; ship only if the replay shows within-conversation gains | the help is in busy groups and digest ranking | 2 d |
| 9 | jev yes/no questions as gated features | marginal after 6 and 8; cheap once 4 exists | 0.5 d |
| 10 | Later: alert budget mode (a daily cap tuned in the replay), mark-as-read action, bubbles, share targets | | — |

Steps 2–3 and 4–6 are independent and can proceed in parallel.

---

## Sources

- Android: [People and conversations](https://developer.android.com/develop/ui/views/notifications/conversations) ·
  [About notifications and conversations](https://developer.android.com/social-and-messaging/guides/communication/notifications-conversations) ·
  [Android 11 features](https://developer.android.com/about/versions/11/features) ·
  [People & messaging codelab](https://codelabs.developers.google.com/people-messaging) ·
  [`Notification.Builder.setShortcutId`](https://learn.microsoft.com/en-us/dotnet/api/android.app.notification.builder.setshortcutid?view=net-android-36.0) ·
  [Bubbles & Conversations in Android 11 (Kodeco)](https://www.kodeco.com/18503960-bubbles-conversations-in-android-11-getting-started)
- Web: [MDN `Notification.renotify`](https://developer.mozilla.org/en-US/docs/Web/API/Notification/renotify)
- Gmail: Aberdeen, Pacovsky, Slater, [*The Learning Behind Gmail Priority Inbox*](https://storage.googleapis.com/gweb-research2023-media/pubtools/pdf/36955.pdf) (2010)
- LinkedIn: Gao et al., *Near Real-time Optimization of Activity-based Notifications* (KDD 2018) ·
  [*Near Real Time AI Personalization for Notifications at LinkedIn*](https://arxiv.org/pdf/2202.03867v1.pdf) (WSDM 2022) ·
  [*Multi-objective Optimization of Notifications Using Offline Reinforcement Learning*](https://arxiv.org/pdf/2207.03029) (KDD 2022)
- Pinterest: Zhao et al., [*Notification Volume Control and Optimization System at Pinterest*](https://dblp.dagstuhl.de/rec/conf/kdd/ZhaoNOE18.html) (KDD 2018) ·
  [User-state-based notification volume optimization](https://medium.com/pinterest-engineering/user-state-based-notification-volume-optimization-7764118f73ff)
- Off-policy evaluation: Li, Chu, Langford, Wang, *Unbiased Offline Evaluation of Contextual-bandit-based News Article
  Recommendation* (WSDM 2011) · Dudík, Langford, Li, *Doubly Robust Policy Evaluation and Learning* (ICML 2011) ·
  Swaminathan, Joachims, *The Self-Normalized Estimator for Counterfactual Learning* (NeurIPS 2015) ·
  [IPS for uplift modelling](https://ar5iv.labs.arxiv.org/html/1811.10158)
- Embedding models: [qwen3-embedding](https://ollama.com/library/qwen3-embedding) ·
  [embeddinggemma](https://ollama.com/library/embeddinggemma)
