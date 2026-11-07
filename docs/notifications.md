# Notification levels, and the decision model that learns from your votes

Triage puts every message at one of four levels, or silences it:

| Level | `decision` | Phone | Desktop |
| --- | --- | --- | --- |
| **Important** | `push` | buzzes (the *Important messages* channel) | a notification, and a toast in an open page |
| **Active** | `quiet` | a silent notification (the *Active messages (silent)* channel, a `silent` web notification) | nothing: it is a row in the inbox |
| **Digest** | `digest` | nothing; counted in the daily digest, listed on the Triage board by how much it matters | nothing |
| **Not interesting** | `drop` | nothing; unread in its chat, nowhere else | |
| silent | `silent` | the unread badge only (the place is set to Nothing) | |

On Android an Important or Active message shows in its conversation's notification, with the last few messages, and
an update with `alert: false` changes it without sounding ([android.md](android.md#how-a-message-notification-looks)).

Code: `packages/hub/src/triage.ts` (where a message starts, the decision), `learn.ts` (the model, pure), `votes.ts`
(votes, training, the policy view, the shadow model), `labels.ts` (labels from what you did), `interact.ts`
(interaction features), `shadow.ts` (exploration, the shadow summary), `main.ts` `deliver` (who gets what);
`scripts/triage-replay.ts` (the offline replay, docs/triage-replay.md); `packages/web/src/triage.ts`,
`ui/TierVote.tsx`, `ui/Inbox.tsx` (the Triage board), `board.ts` (its lists and counts, and the badge), `public/sw.js`;
`apps/android/.../Notifications.kt`. `scripts/verify-triage.ts` checks the board's counts, a vote and the words in a browser.

## The three chances

For every new live message from someone else (whatever its place's level, unless silenced) the model predicts three
chances:

- **ping**: worth buzzing you. At **80%** or more it is Important.
- **active**: worth at least a silent notification. Else at 50% or more, Active.
- **interesting**: worth the digest at all. Else at 50% or more, Digest; below, Not interesting.

How much a message matters (`score`, the mean of the three) orders the digest. The chances are shown with a message's
"why" (the bell among its hover actions) as three bars.

### Where it starts: the networks' own settings

Each chance starts from a **prior**, set by where the message would land without any votes:

- **A place you set** (a conversation, a server, an account, a network, everything) keeps its level as before:
  Every message is Important; Mentions makes a mention or a reply to you Important, `@everyone` Active, the rest
  Digest; Smart scores it (below); Digest only is Digest.
- **A place you did not set** goes by what the network itself would do (`nativeLevel`): its own notification setting
  for the channel, then its category, then its server, as Discord, Element or WhatsApp report them, a mute that has run
  out no longer counting; else the network's default: DMs and group chats every message, channels mentions only.
  **What the network would notify you about is Important**: every message where it notifies on every message; a
  mention, a reply to you or `@everyone` where it notifies on mentions. The rest starts as Digest. Signal does not
  say which groups you muted in the app (signal-cli keeps no group mutes), so Signal groups notify on every message
  until you vote them down.
- Starred people and keywords: Important. Bots, unless they mention you or the place notifies on everything: Digest.

Important starts at ping 0.9, Active at ping 0.2 and active 0.85; Digest at ping 0.03 and active 0.1, with
interesting 0.2 plus how addressed to you it is (the Smart score: mentions you +0.5, `@everyone` +0.2, replies to you
+0.4, a question +0.15, sounds urgent +0.3, a small group +0.1, you were talking there +0.25, an announcement channel
−0.1, from 0.15), so plain chatter in a busy server falls below the digest and a question where you were talking makes
it. A place you set to Digest only starts at interesting 0.9.

With a local model (`DITHER_TRIAGE_MODEL`, Ollama), places set to Smart ask it for the three chances instead, from the
decision prompt and the place's last eight messages; its answer is the starting point.

Quiet hours hold Important and Active alike, as before.

### What it learns

On top of the prior, in log-odds, one weight per **feature** and per chance (`features`): the conversation, the
author (their person, else identity), the server and categories, the network, the shape; flags (mentions you,
`@everyone`, replies to you, a question, urgent, a bot, you had been talking there, an attachment, a link, long, from
someone you know) and their absence where it says something; what the network does there and whether it would
notify; each of the conversation, the server and the author **with whether it is about you** (mentions or replies to
you), so "this server, unless it is about you" is one weight; and the message's **words** (distinct, three letters or
more, no links, mentions or common words), together worth one feature.

Weights are fitted by L2-regularised logistic regression, cyclic coordinate Newton, after every vote (well under a
second on the live hub) and once a day. The regularisation is the hierarchy (`lambda`): a conversation moves on one
vote, a person and words on a few, a server on several, a network, a shape or a flag across every place only on many;
a scope with "about you" moves before the bare scope. So two votes in one Signal chat change that chat, not all of
Signal (the decision list this replaced learned "all of Signal → Digest" from exactly that).

Counted:

- **Votes**, in full when new, halving over three months, never under a quarter.
- **Notifications you let stand** (Important or Active, not voted on, older than half a day): the 10 newest of each
  conversation from the last 30 days, at 0.05 each, as "that was fine". A digest entry that stood says nothing: it was
  likely never looked at.

**The backtest**: the model against every vote, and the priors alone against them, shown on the board. **Forget**
(× beside a learned weight) leaves that feature out of training for good; *Learn again* undoes it.

### The shadow model

Next to the live model a **candidate** learns, and only watches (`votes.ts`, `shadow.ts`). Its chances are kept with
every decision (`triage.shadow`); it decides nothing. It is switched on only if the replay (docs/triage-replay.md)
*and* a week in shadow agree it is better at the same or lower alert volume. It differs from the live model in two
ways:

**Labels from what you did** (`labels.ts`), besides your votes, which stay the gold standard. Each says something
about only some of the three chances (the others are left out of training for it, `Example.y`), with a weight
against a vote's 1:

| What happened after a message | Weight | Says |
| --- | ---: | --- |
| you answered it within 15 min, not already there | 0.5 | ping, active, interesting |
| you answered it while there, or within 3 h; or reacted to it | 0.3 | active, interesting |
| you tapped its push within 5 min and stayed 20 s | 0.3 | active, interesting; ping too unless already there |
| you opened its conversation within an hour, nothing more | 0.1 | interesting |
| you dismissed its push unopened | 0.3 | not ping |
| its push showed and was not opened in a day | 0.1 | not ping, not active |
| you tapped and left within 5 s | 0.3 | not ping |
| you opened its conversation within the hour although nobody was notified (first of the burst) | 0.2 | active |
| nothing at all in 3 h after the first message of a burst (not about you) | 0.03 | not ping, not active |

"Answered" is your next message in the conversation, attributed to the message it replies to, else the last message
before it. "Already there": you wrote there in the 15 minutes before, a visit spanned the message, or an open page kept
its notification to itself. Reactions carry no time, so they count as a late answer. The last row is not in the
design report: without it nearly every label is positive and the model only learns to notify more; its weight was
chosen in the replay. Decisions that merely stood count for nothing here.

**Interaction features** (`interact.ts`), numbers worked out as of each message from only what came before, kept
with the decision in `triage_input` (docs/activity.md) and learned as one slope each across all places
(regularisation 10, `NUMERIC` in `learn.ts`):

| Feature | What |
| --- | --- |
| `rr:conv`, `rr:author` | how often you write in the conversation within half an hour of a message there, and after this author's messages anywhere: decayed (30-day half-life), Beta-smoothed, as log-odds against 5% |
| `engaged`, `alt` | you wrote there in the last 15 min; how often you answered someone there in the last half hour, log(1 + n) |
| `since:seen` | log(1 + hours) since you last opened the conversation (or its DM peer) or wrote there, less a day's worth |
| `device:active` | a visit on any device was in use in the last 2 minutes |
| `open:rate` | how often you opened its pushes within the hour, as log-odds against 30% |

Numeric features from elsewhere (content: embeddings, local-model answers) are added the same way: a name in
`Example.x` and the `x` argument of `predict`, and a kind in `NUMERIC` for their regularisation and words.

The candidate learns at every vote and once a day, from your votes and from what you did over the last two weeks
(read again at most every 6 hours, a pass over two weeks of messages). On the Triage board, under what the live model
learned, one line says what it would have done over the last week: "would have pinged 40 fewer (120 instead of 160),
missed 1 message you answered within 15 minutes, and caught 2 more" (`GET /api/triage/shadow`, counts only).

### Exploration (off unless `DITHER_TRIAGE_EXPLORE` is `1` or `up`)

To learn about what the current decisions never show, the hub can change a few, only ever toward silence or toward a
silent notification, and log the chance it did so with (`triage.explore`, `triage.propensity`), so that off-policy
estimates become possible later:

- **Up**: a Digest or Not-interesting message whose Active chance (the live model's or the shadow's) is in 25–50% is
  tried as **Active** with probability 2%, at most 3 a day. Its first reason says "Trying this one as Active: worth
  it?", so the vote buttons are the answer.
- **Down** (only with `1`, not `up`): in a conversation with 10 or more pings in the last day, an Important message
  becomes **Active** with probability 5%, at most once there a day: how much does the buzz itself matter?

The live hub runs with `up`: it only ever adds a silent notification.
- **Never** during quiet hours, for starred people or keywords, for a mention of you or a reply to you, for a DM's
  first message after 5 quiet minutes, or in a place set to Nothing.

`propensity` is the chance of what was done when the draw happened (2% or 98% up, 5% or 95% down) and NULL when no
draw could happen.

**Content features** from message embeddings and jev's yes/no answers (`emb`, `knn`, `jev:<q>`), behind
`DITHER_EMBEDDINGS=1`: the shadow model weighs them as numeric features (regularisation 5), the live one does not.
They are made just before each decision (`Embeddings.prepare`, giving up after 800 ms) and kept with it in
`triage_input`; for training they are read afresh, since a labelled message's probe score is cross-fitted. jev is asked
only about messages in conversations you wrote or reacted in during the last 30 days. See
[embeddings.md](embeddings.md).

### The decision prompt

Each time it learns, a prompt for a local model is written (`writePrompt`): the three questions, the strongest
weights in words, and up to six votes it still gets wrong, described by their features (never their text). The board
shows it under *Decision prompt*, with or without a model.

## Voting

Every decision that is not silent can be voted **up** or **down** a level from where it is now (your last vote, else
the decision). Up on Important, or down on Not interesting, says it was right: that counts too. Voting it to the level
it already has takes the vote back. A vote's labels for the three chances: Important is worth a ping (so also Active and
the digest); Active is not worth a ping but worth a notification; Digest only interesting; Not interesting none.

- **The Triage board** (Inbox → Triage, the phone's Triage tab): Important and Active for the last week, newest first;
  the Digest, what matters most first; *Not interesting*, the closest 30 of the last two days, to vote up. Each message
  with ▲ and ▼ around its level; a vote moves it to the other list at once. The counts at the top are the lists'
  lengths, and the Triage button's badge is the Important list's unread messages (`packages/web/src/board.ts`), so a
  vote changes them together.
- **The three chances** are shown under the same names: Important (ping), Active (active) and Digest (interesting), each
  bar marked at the hub's own threshold (`GET /api/triage/policy`'s `thresholds`). A place's notification setting that
  sends everything to the digest is called *Digest only*, to keep it apart from a message's Digest level.
- **A message's notification menu** (the bell among its hover actions): why, the three chances, and the four levels
  side by side, triage's choice marked with a dot.
- **The notification itself.** Important: Reply, *▼ Active*, *✓ Right*. Active: *▲ Important*, *▼ Digest*, Reply. In a
  browser that shows only two actions, the votes come first. The vote goes to `POST /api/messages/:id/feedback {vote}`
  from the service worker or the app, like a reply from a notification does.

`POST /api/messages/:id/feedback` takes `{ vote: 'up' | 'down' }` or `{ feedback: 'push' | 'quiet' | 'digest' | 'drop' |
null }` and answers with the new vote and the policy. `GET /api/triage/policy`, `POST /api/triage/policy/relearn`,
`POST /api/triage/factors/:key {rejected}`, `GET /api/triage/shadow` (P.TriageShadowView).

Storage: `triage` (`decision`, `score`, `reasons`, `facts` as JSON, `probs` as JSON `{ ping, active, interesting }`,
`feedback`; `shadow` as JSON chances, `explore`, `propensity`), the models in `meta` (`triage_policy`: `model`, and
`candidate` for the shadow). A triage table from before `drop` is set aside and copied over on
start (`store.ts` `setAsideTriage`); the decision list that came before is dropped and the model trained from the
votes.

## One notification per conversation

Triage decides per message; delivery is per conversation (`packages/hub/src/delivery.ts`). A device keeps one
notification for each conversation (its tag is the conversation id), and every push about it carries the conversation's
unread lines, so the notification grows instead of being replaced by the latest message.

- **What a push carries**, besides `title`, `body`, `icon` and the rest: `lines` (the last six messages from others
  since you last read the conversation or wrote there, at Digest or above, oldest first and ending with this one; each
  `{ author, key, body, ts }`), `icons` (a picture per author `key`), `count` (unread from others), `conv`
  (`{ title, shape: 'direct' | 'group' | 'channel', icon }`, a channel's icon being its server's), `sender`
  (`{ name, key, icon }`), and `alert`. The oldest lines go first when the push would pass about 3.5 KB.
- **When it sounds** (`alert`): an Important message that is the first in five minutes here, or that comes after only
  Active ones in this burst, or that mentions or replies to you. Every other update changes the notification silently.
  Active never sounds. Nothing sounds while a page on a computer has been in use in the last two minutes (a visit
  from a device whose label is not a phone's): you are already looking.
- **Read elsewhere, gone here.** Every five seconds the hub looks at the conversations it notified about; one read since
  then (in the app, in the network's own client when it reports reads, or by writing there) gets a push
  `{ clear: conversationId }`, which closes it. That goes only to registrations that said they take it (`clears: true`
  on `POST /api/push/subscribe`, the Android app from 0.7): a browser must show something for every push, and an older
  app would show an empty one.
- **In a browser** (`sw.js`): the lines become the body (`Author: text` in groups), a group's title counts them, and
  `renotify`/`silent` follow `alert`. A hub from before this sends no `alert`, and every Important message sounds.
- **On Android**: a conversation notification, see docs/android.md.

The burst state is kept in memory: after a restart, the next message in each conversation sounds.

## Elsewhere

- The inbox ranking (docs/inbox.md) counts Active like Important: "pinged you" while unread.
- Device rules (docs/devices.md) still only take notifications off a device. Active also skips every push registration
  that is not a phone, going by its label (Android, iPhone, iPad, iOS); an ntfy topic gets it at low priority.
- The activity export's weak label maps a vote for Important or Active to `should_push` and one for Digest or Not
  interesting to `should_not_push`.
