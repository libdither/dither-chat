# For you

What the right pane shows with no conversation open, and the phone's For you tab (`#/foryou`; Catch up's old address
`#/triage` opens it too). It replaced Catch up on 2026-11-15. Not the X notifications feed ([feed.md](feed.md)), which
is a network's own conversation of likes and replies.

Code: `packages/hub/src/foryou.ts` (candidates, order, snapshots, logging), `packages/web/src/ui/ForYou.tsx` (the
pane), `packages/web/src/foryou.ts` (what counts as seen), `labels.ts` `foryouLabel` (the label a ranker will learn
from). `scripts/verify-foryou.ts` drives it on a fresh demo hub.

## What is in it

Single messages, never whole conversations: from channels, threads, and groups of seven or more members, when the
message is not to you. DMs, small groups and anything in the Conversation tier or above stay in the inbox, which keeps
what needs you (↩ rows, alerts, accounts that need you).

A message is a candidate when, in the last two days:

- triage put it in the List or below (`digest` or `drop`) with an importance of at least 0.1;
- someone else wrote it, it does not mention you (or @everyone you) and does not reply to you;
- its chat is not muted by your rules, hidden, or an open message request;
- you have not read past it (the chat's read point on any of its accounts).

**Seeing an item marks nothing read.** Only opening its chat reads it, as any open does.

## The order (v1)

- **Score**: triage's importance times freshness, which halves every eight hours.
- **Bursts**: messages in one chat closer together than 30 minutes are one burst, cut after two hours. A burst is one
  item, its best message by score; the footer says "+N more in #x" (the messages from others in its span).
- **Replies**: a reply shows what it answers as one muted quoted line. When both are candidates the reply stays and
  the original goes.
- **Cross-posts**: the same text from the same author in several chats within ten minutes is one item, "also in …".
- **Diversity**: at most two items from one chat and one from one author in any ten in a row. When nothing fits, the
  best goes in anyway.
- **Exploration**: in each ten, the 4th and 9th items are drawn at random from outside the 30 best, with weight
  `exp(score / 0.25) × novelty`, novelty `1 / √(1 + times that chat was shown in 14 days)`. Each such item logs the
  exact chance it was drawn with, and says "Trying: new to you". Ranked items log a chance of 1.

**Cost.** The hub reads what triage decided from the `triage_created` index a page of 2,048 rows at a time, keeps
the two days' candidates in memory, and after the first read only reads what came since. Only the 3,000 most
important are looked up (message, chat, author), at most 9,000 lookups. All of it runs in slices (`slices.ts`), so a
request waits at most a slice behind it. On a copy of a real hub (about 200,000 rows of triage in two days) the first
snapshot took 330 ms in 83 slices, the longest 27 ms; one 30 seconds later 31 ms.

## Snapshots

The hub takes a snapshot of up to 200 items when the pane opens and serves it 20 at a time: nothing reorders under
you, and scrolling to the end fetches the next 20 of the same snapshot. Every minute while the pane is open the page
asks how many new items a fresh snapshot would bring (messages triage decided since, folded as above), and shows
"N new"; pressing it takes a fresh one. Leaving the pane (opening an item, another tab) and coming back within 30
minutes keeps the snapshot and the scroll position; after longer, or after a reload, it is taken afresh. The hub keeps
the last eight snapshots in memory: asked for one it no longer has (it restarted), it takes a fresh one and says so.

- `GET /api/foryou?epoch=&from=&limit=` → `ForYouPage` `{ epoch, at, items, next, quoted, identities, reset? }`.
- `GET /api/foryou/fresh?epoch=` → `{ fresh, known }`.
- `POST /api/foryou/events` `{ events: ForYouEvent[] }`.
- `GET /api/foryou/stats?since=` → served, shown, clicked, the click rate on shown items, and the share of shown
  items from exploration.

## An item

The place (network › community › channel) and the age; the author's picture and name; the message it replies to as
one quoted line; the text, six lines with "more"; pictures as thumbnails that open the viewer; "+N more in #x". Hover
(always shown on a phone) gives **More like this** (+), **Less like this** (also triage's own "Less like this" mark,
[notifications.md](notifications.md#marks)) and **Hide** (×). Its tooltip says why it is there.

**Clicking an item** opens its chat at that message, in context (`{ view: 'inbox', conv, msg }`, the timeline's
focus). Back returns to For you on the same snapshot where you were: on a phone the chat stacks on the tab
(`pages.ts` `stacksOn`). There is no reply box: answer in the chat.

**Keys** (desktop, with a hint line): `j` and `k` move, `Enter` opens, `x` hides.

**The header**: "N new", How it sorts, and the inbox's menu (Mark Everything As Read, How It Sorts), so both are in
reach on a phone. The phone's tab has no badge: nothing here is urgent. Home's badge counts what is.

## What is logged

So a ranker can be trained and an order replayed without bias, the hub keeps what it served and what each device
said of it, as part of the activity log ([activity.md](activity.md)): written only while the log is on, pruned with
its retention (and at 200,000 items), deleted with it. Ids and numbers only, never text.

- `foryou_item`: one row per item served (its id `epoch.position`), with the message, chat and author ids, position,
  slot (`rank` or `explore`), propensity, score, triage's importance, its age when served, its burst's size, its
  text's length, and whether it is a reply.
- `foryou_event` (item, device, kind): `shown` (first time at least half of it, or half the pane for a tall one, was
  on screen while the page was visible and in use, usage.ts `inUse`, and the milliseconds it stayed so, summed and
  sent again as they grow), `clicked`, `more`, `less`, `hidden`. Each device's first of a kind stays.

A visit opened from an item has the source `foryou`, with the item's position as its rank.

**Labels** (`foryouLabel`, not trained on yet): opened, answered or reacted is 1 (weight 1), More like this 1
(weight 2), Hide or Less like this 0 (weight 2). On screen at least a second and then passed (a later item was shown)
in less time than reading it takes (0.8 s + 25 ms a character) is 0 (weight 1). A fling, the last item when the page
was left, an item read in place without a word, or one whose chat you were already in, say nothing. An exploration
item's weight is divided by its propensity, at most 10.

## Later

- A learned head, `P(engage | on screen)`, as a residual on importance, fitted in slices from `foryouLabel`; shadow
  scores logged in `foryou_item.score` before it sorts.
- Scroll-pasts as "no" labels for importance (behind a switch, checked in the replay first).

## Worth seeing

Once a day one card asks **Worth seeing?**, with *Glad I saw this* and *Not for me* (`ForYouItem.ask`, a check-in,
[notifications.md](notifications.md#check-ins)). The card is picked at random from the first page, with the chance it
had kept, so the scorecard can weigh the answers back. For you never sends a push. With the loudness scale on, an
item's score is multiplied by what the answers say of its chat and its author (0 to 2, 1 knowing nothing), and the
page sorted again.

## On the scorecard

How it sorts' scorecard ([scorecard.md](scorecard.md)) charts, day by day, the share of items on screen that you
opened, for all items and for exploration slots alone (`foryou.clicked`, `foryou.clicked_explore`), and the share of
asked cards you were glad to see, weighted back (`foryou.worth`).
`GET /api/foryou/stats` gives the same over any span.
