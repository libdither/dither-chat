# Notification levels, and learning from your votes

Triage puts every message at one of three levels, or silences it:

| Level | `decision` | Phone | Desktop |
| --- | --- | --- | --- |
| **Important** | `push` | buzzes (the *Important messages* channel) | a notification, and a toast in an open page |
| **Active** | `quiet` | a silent notification (the *Active messages (silent)* channel, a `silent` web notification) | nothing: it is a row in the inbox |
| **Digest** | `digest` | nothing; counted in the daily digest | nothing |
| silent | `silent` | the unread badge only (the place is set to Nothing) | |

Code: `packages/hub/src/triage.ts` (decides), `learn.ts` (rules from votes, pure), `votes.ts` (votes, backtests,
relearning, the policy view), `main.ts` `deliver` (who gets what); `packages/web/src/triage.ts`, `ui/TierVote.tsx`,
`ui/Inbox.tsx` (the Triage board), `public/sw.js`; `apps/android/.../Notifications.kt`.

## Triage's own rules

The place's notification level (`effectiveLevel`, unchanged) picks the start:

- **Every message** (DMs by default): Important.
- **Mentions** (channels and threads by default): a mention by name or a reply to you is Important; `@everyone` and
  `@here` are Active, since they reach you without being about you; the rest is Digest.
- **Smart** (group chats by default): the score as before (mentions you +0.5, `@everyone` +0.2, replies to you +0.4, a
  question +0.15, sounds urgent +0.3, a small group +0.1, you were talking there +0.25, an announcement channel −0.1,
  from 0.15). At 0.55 or more Important, at 0.3 or more Active, else Digest. With a local model
  (`DITHER_TRIAGE_MODEL`), the model picks the level instead, from the prompt below.
- **Digest only**: Digest. **Nothing**: silent.
- Starred people and keywords: Important. Bots, unless they mention you or the place notifies on everything: Digest.

Quiet hours hold Important and Active alike, as before.

Then the rules learned from your votes (below) may move it. A silenced place is never moved: change its level instead.

## Voting

Every decision that is not silent can be voted **up** or **down** a level from where it is now (your last vote, else
the decision). Up on Important, or down on Digest, says it was right: that counts too, as a vote for where it is.
Voting it to the level it already has takes the vote back.

- **The Triage board** (Inbox → Triage, the phone's Triage tab): Important, Active and Digest for the last week, each
  message with ▲ and ▼ around its level. A vote moves it to the other list at once; a dashed outline marks one you
  moved, a tick one you said was right.
- **A message's menu** and the pill beside a message (desktop): the three levels side by side, triage's choice marked
  with a dot.
- **The notification itself.** Important: *Not important* (to Active), next to Reply. Active: *Important* and
  *Digest*. In a browser that shows only two actions, those come first. The vote goes to
  `POST /api/messages/:id/feedback {vote}` from the service worker or the app, like a reply from a notification does.

`POST /api/messages/:id/feedback` takes `{ vote: 'up' | 'down' }` or `{ feedback: 'push' | 'quiet' | 'digest' | null }`
and answers with the new vote and the policy (below).

Before this, votes were "should have pinged" / "shouldn't have pinged". They came across as votes for Important and
for Digest (`store.ts` `adoptOldTriage`, which also rebuilds the table for the new decision).

## What it learns

Every decision keeps its **facts** (`triage.facts`, JSON): the network, the conversation's shape, the conversation,
its spaces (nearest first), the author (their person, else identity), and flags: from a bot, mentions you by name,
`@everyone`, replies to you, asks a question, sounds urgent, you had written there in the half hour before, has an
attachment; and triage's own level before any learned rule (`base`). No text. Votes on older messages get their facts
computed when they are voted on.

A **rule** is a condition and a level: "In #general · Hub, that does not mention you → Digest". A condition is one
scope (a conversation, a person, a space, a network, a shape) alone, or with one flag or its absence ("does not
mention you", "is not a question") or with triage's own level ("would have been Important"); or a flag with triage's
own level across every place. The rules form a list, most specific first (a conversation, then a person, then a
space, a network, a shape; more conditions before fewer): the first that matches sets the level.

They are learned greedily (`learn`): every condition one of your votes suggests is a candidate; take the one that gets
the most right, put it where its specificity says, and again, while a step still gains 0.4 and up to 24 rules. Counted:

- **Votes**, in full when new, halving over three months, never under a quarter.
- **Decisions you let stand**: the 10 newest of each conversation from the last 30 days, older than half a day,
  at 0.05 each. Enough to keep a rule from reaching past your votes (two votes in a server's channels while the
  mentions there stood make "in that server, unless it mentions you", not "in that server"), never enough to outvote
  one.
- A rule over one conversation needs one vote; over anything wider, two that agree. At least 70% of the votes a rule
  matches must agree with it.

**The backtest** (`backtest`): the rules against every vote: how many they get wrong, and how many triage's own rules
alone would. After each vote, if the rules get more than **10%** wrong, they are learned again, and the new set kept
if it fits better. They are also learned again once a day, as votes age and decisions stand. The Triage board shows the
rules, the counts, and when and why they were last learned.

**Keep** a rule (the star) and relearning will not drop it. **Drop** one (×) and neither it nor a narrower version of it
at the same level is learned again; *Allow again* under "dropped" undoes that.

### The decision prompt

Each time the rules are learned they are also written into a prompt for a local model (`writePrompt`): what the three
levels mean, the rules in words, and up to six votes the rules still get wrong, described by their facts. With
`DITHER_TRIAGE_MODEL` set, smart places ask the model with it, plus the place's last eight messages, and the model
answers with a level. The learned rules still apply after the model. Without a model the rules apply on their own; the
board shows the prompt either way, under *Decision prompt*.

`GET /api/triage/policy`, `POST /api/triage/policy/relearn`, `POST /api/triage/rules/:key {pinned?, rejected?}`.

## Elsewhere

- The inbox ranking (docs/inbox.md) counts Active like Important: "pinged you" while unread.
- Device rules (docs/devices.md) still only take notifications off a device. Active also skips every push registration
  that is not a phone, going by its label (Android, iPhone, iPad, iOS); an ntfy topic gets it at low priority.
- The activity export's weak label maps a vote for Important or Active to `should_push` and one for Digest to
  `should_not_push`.
