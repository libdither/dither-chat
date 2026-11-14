# Organizing servers: automatic order and bulk rearranging

The rail could already be arranged by hand: drag, folders, pin, hide (`layout.ts`, `ui/Organize.tsx`,
`place_pref`). This adds two things: an order that follows how much you use each place, and a view for
rearranging many servers at once.

## Usage tracking

**What is measured.** Time actually spent in a place, visits, and the last visit. Nothing else: ids,
seconds and times, never message content or who was there.

**Which place.** The open route decides (`usage.ts`, `keysOfRoute`):

| Open | Counts for |
|---|---|
| a community, or a channel in it | the community (`space:<root community>`) and the channel |
| a DM, from anywhere | the person (`person:<id>`), so all their networks count as one |
| a group chat or room | the conversation |

Threads count for their parent channel. Folders get nothing of their own: they are scored from their
members.

**When it counts.** Only while the page is visible, the window has focus, and there was input in the
last 5 minutes (`IDLE_AFTER`). A tick never counts for more than 30 s, so a laptop that slept does not
count the night. A visit counts once you have been in a place for 3 s (`VISIT_AFTER`), so passing through
a server on the way to another does not; coming back after 30 minutes away counts as a new visit.

**Where it goes.** The device accumulates in memory and `localStorage`, and sends a batch every minute,
when the page is hidden (`fetch` with `keepalive`), and half a second after a visit begins, so the inbox knows
where you are by the time you leave ([inbox.md](inbox.md#you-were-here)). Each batch has an id; the hub ignores an id it has
seen, so resending after a lost answer does not count twice. Offline, batches wait in an outbox. The
measuring itself is `tracker.ts`, pure and tested.

**How it is kept.** The hub (`packages/hub/src/usage.ts`, table `place_usage`) keeps per place a
*decayed* total of seconds and of visits, as of a time `score_at`, plus all-time seconds and visits and
the last visit. Adding a batch measured at `t` to a total at `T` (`addDecayed` in
`packages/protocol/src/usage.ts`):

- `t ≤ T`: `score += seconds · 2^(-(T - t) / H)`
- `t > T`: `score = score · 2^(-(t - T) / H) + seconds`, and `score_at = t`

with half-life `H` = 7 days. The result does not depend on the order batches arrive in, so two devices
sending late or out of order agree. A place untouched for 90 days whose total has decayed to nothing is
deleted. Sanity limits on the hub: known kinds only, at most an hour and 100 visits per entry, times
clamped to the last 30 days.

**Reset.** "Reset Usage History…" in the sort menu deletes it everywhere (`DELETE /api/usage`; with
`{kind, id}` for one place). Your sort mode stays.

## Sort modes

Per scope, shared by your devices (`arrange_setting` table):

| Scope | Modes | Default |
|---|---|---|
| Rail (and the phone's Spaces list, the same arrangement; folder contents too) | Manual, Smart, Recent activity, A–Z | **Manual**: today's order, unchanged for existing users |
| People list | Recent, Smart, A–Z | Recent (today's) |

People have no manual order to keep, so "Manual" there is not offered. Group chats used to have a list and a
scope of their own; they are in the inbox now, which has one order, by how much each conversation needs you
([inbox.md](inbox.md)). A `groups` scope an older hub stored is ignored.

In every mode **pinned places stay first, in your manual order**. The People list has no pinned section: starred
people sort with everyone else since stars left the app (2026-11-10).
A **folder sorts as one unit by its best member** (highest score, latest message), and its contents sort
the same way inside. Manual mode keeps the folder's own order.

### Smart: the formula

In minutes of reading (`smartScore`):

```
smart = time + visits + recent + mentions
time     = decayed seconds / 60                    (half-life 7 days)
visits   = decayed visits × 1                       (half-life 7 days)
recent   = 20 × 2^(-(now - last visit) / 1 day)
mentions = 10 × min(unread badge, 3)
```

Why these weights:

- **Time** is the main signal: it is what "how much you use it" means. Decay with a week's half-life
  means the order reflects this week's habits, and an old obsession fades in a few weeks. At steady
  state a place read 30 min a day sits near 320.
- **Visits** at a minute each give weight to places you check often but briefly: ten 5-second checks a
  day settle near 140, which time alone would rank far too low.
- **Recency** (up to 20, halving each day) separates places with similar habits by which one you were in
  last, and makes a place you just started using show up without waiting for a week of data. It is
  small next to a habit, so yesterday's one-off visit does not take the top.
- **Mentions** nudge a place up a little (10 per unread mention or DM message, at most 30). Enough to
  lift it among peers, never enough to beat a real habit: an alert is not usage, and the badge already
  shows it.

With no usage at all the score is 0 and the order falls back to the latest message, then the name, so a
fresh install looks like "Recent activity", not random.

**Recent activity** sorts by latest message, **A–Z** by name (case-insensitive, numbers as numbers).

### When the order changes

A list that reshuffles under the pointer is worse than no sorting. So an automatic order is a
*snapshot* (`arrange.ts`), taken:

- when the app starts (once the places and the hub's usage are both loaded; until then the last
  snapshot from this device is shown, so starting does not jump),
- when the app comes back to the front,
- on a timer, at most every 5 minutes (`RESORT_EVERY`),
- at once when you pick a mode, choose "Sort Again Now", or make a folder in the Organize view.

The automatic ones (start, front, timer) wait while anything is in use: a drag, an open menu, the
Organize view, the pointer over the rail or a list, a touch on one in the last 4 s, or keyboard focus in
one. They retry every 1.5 s until that ends (`shouldResort` in `ordering.ts` is the rule, tested).

Between snapshots, places keep their snapshot position; a new place goes after them; a removed one
just goes (`stabilize`). Moves animate: each row slides from its old position (`useFlip`, Web
Animations, skipped with reduced motion). Smart order in the People list is snapshotted the same way;
Recent there stays live, as in any chat app, and A–Z only changes on a rename. The inbox uses the same rule
with one more reason to take a new order, `activity`: any change in its ranking, still waiting for nothing
to be in use ([inbox.md](inbox.md)).

### Freezing

"Freeze This Order" writes the order on screen as your manual order once (positions for the top level,
item order inside folders) and switches the rail to Manual. Dragging a server, or Move Up/Down from its
menu, while an automatic order is on does the same first, so the move is relative to what you see, and
says so in a toast. Dropping into a folder does not need it.

## Organize view

Rail sort button → "Organize Servers…", or the same entry at the end of any place's menu. One list of
every rail entry in the current order, folder members indented under their folder, hidden places in a
section at the end, each with its network, folder, categories, and usage ("1 h 20 min lately · opened
1h").

- **Select**: click, Shift+click for a range; keyboard ↑/↓ (or j/k), Space or Enter, Shift+↑/↓ to extend,
  Ctrl+A for all, `/` to filter.
- **Act on the selection**: Move to… (`M`, a menu of folders plus New Folder), New folder (`N`, name it
  inline), Pin/Unpin (`P`), Hide/Show (`H`), Out of folder (`U`). Selecting a folder for a move moves
  the folder itself into a folder that may hold it (below), else its contents; a folder a move empties is removed.
- **Suggested folders** come from the categorizer (`categorize.ts`): for each category, the loose
  (unpinned, not in a folder) rail places that belong to it, at least two, or one if a folder of that
  name exists ("Add to …"). *Create* makes the folder in the category's colour; *Edit* selects its places
  and opens the name field so you can change both; *×* dismisses it. A dismissal remembers the places it
  suggested and is shared by your devices; a new place in that category brings the suggestion back.
  Each card has a **sensitivity** slider: toward *More* it takes in places the model is less sure of, toward
  *Fewer* only the surest. It moves the category's threshold (below), saved when you let go; the card list keeps
  its order while you drag.
- **By meaning** (the button in the filter): what you type is asked of every server and group as a question
  ("rust and systems" becomes "Is this community about rust and systems?"; a question you type ending in `?` is
  asked as it is), after a pause or on Enter. The list shows what matches, surest first, with how sure the model
  is; a sensitivity slider decides how sure it must be. *Select all* selects the matches for a move, *Save as
  category* keeps the question as a category with that threshold, so its folder is suggested and new servers are
  scored for it too. Nothing is saved by asking (`POST /api/categories/probe`).

## Folders inside folders

A folder can hold folders, one level deep: a folder that holds folders sits at the top, and a folder inside one holds
only places. It is meant for a level above topics, such as one folder per account (two Discord accounts for two
lives), with that account's folders and loose servers inside.

- **Storing it.** A `folder` item in `FolderView.items` (`PUT /api/folders`) puts that folder inside; the hub keeps it
  as `folder.parent_id` and `parent_pos`, in the same order as the parent's places. A deeper or circular nesting keeps
  the first link it reads; the rest stay at the top.
- **Arranging it.** Drop a folder on a folder to put it in, or use Move to Folder in its menu (`layout.ts` `mayHold`
  says where it may go). Dragging it out of the open parent, or Take Out Of, brings it back to the top. Deleting a
  folder inside a folder moves what it held up into the outer one; deleting the outer one leaves its folders at the top.
- **Showing it.** In the rail an open folder shows its folders as folders, each opening in place on a deeper tint; a
  closed folder of folders shows the first places of its folders. On a phone a folder inside a folder is a row that
  opens it, and its page says which folder it is in.
- **What reads it.** Counts, mark-as-read, index jobs and the @ list's "@ finds" take a folder's folders in with it;
  a folder inside a folder inherits "@ finds" from the outer one when it says nothing.

## Quiet shelf

A quiet server is one you never opened here (no visit in the usage history), with nothing unread and nothing new in
180 days (`quiet.ts`). Two or more of them in a list sit on a shelf at its end, closed: a dashed pill with their
count, at the end of the rail, of each open folder and of the phone's lists. A click lays them out, dimmed; another
puts them away. It is display only: nothing leaves a folder, and a quiet server you open, pin or get a message in
comes off the shelf by itself. The order menu's **Quiet Servers on a Shelf** turns it off for every device
(`ArrangeSettings.quietShelf`).

Why a shelf and not an "Old" folder: on a real sidebar of 165 servers, 60 were quiet by this rule, and most of them sat in
school folders kept on purpose, not in the folder for old servers. Quiet says how a server is used, not what it is.

## Suggested layout

The Organize view opens with a suggested layout (`protocol/src/folderplan.ts`, shown by `ui/SuggestedLayout.tsx`): what
the rules below would do, as a tree you tick, and one button to take it. Nothing you arranged moves: only servers
outside your folders (or loose inside an account's folder) are placed, and a folder of the same name is added to
rather than made twice. A toast undoes it.

The rules, in the order they claim servers:

1. **The network's folders.** Each folder Discord keeps (`AccountSelfView.folders`) becomes one, named as there. An
   unnamed one waits for rule 2.
2. **Shared words.** A word in the names of 3 or more of one account's servers makes a folder of the servers that
   have it ("Lakeside", "Westbrook"). Filler words do not count ("server", "club", "official"…), and a word of five
   letters or more also matches its first four run together ("HackLakeside" for "Lakeside"). An unnamed network
   folder at least half on such a word goes in whole; otherwise it stays a folder of its own.
3. **One folder per account.** With two or more accounts of 5 or more servers on one network, each gets a folder of
   its own, in its colour, holding its folders and its other servers. A server two of them see is the bigger
   account's; one on a network where you have one account is your biggest account's.

A server no rule places is left where it is, with its two nearest folders beside it in the list ("Move to" chips):
nearest by the words of its name, topic and channel names (tf-idf) and by the categorizer's scores. They are
suggestions, never filed by themselves.

### Backtest

`packages/protocol/test/folderplan.test.ts` runs the rules on a made-up sidebar like the demo's servers scenario
(`FOLDERPLAN_PRINT=1` prints the numbers); `scripts/backtest-folders.ts <hub copy>` runs them on a copy of a real hub
against the folders there, read-only. On a real sidebar of 165 servers in 13 folders, filed by hand (2026-11-13; "placed right": the
server lands in a folder standing for the one they chose; "together wrongly": pairs put in one folder that they keep
apart):

| Rules | Placed right | Together wrongly | Loose |
|---|---|---|---|
| The network's folders | 48% | 0% | 52% |
| + one folder per account | 48% | 0% | 52% |
| + shared words | 67% | 2% | 32% |
| + every loose server into its first suggestion | 75% | 40% | 0% |
| No network folders: shared words and accounts | 25% | 1% | 75% |

A server taken out and put back by the word rule or the suggestions: first guess right 41%, one of the first two 57%.
So the first three rules are applied as one suggestion, and topic stays a suggestion per server. On the made-up
sidebar the first three rules place 68% with no pair wrong. The earlier study that chose these rules, with the local
model's embeddings and judgments, is not in the repo.

## Categories and the model

The categorizer (`packages/hub/src/categorize.ts`) asks each category's question of every community and named group,
from its name, topic and up to 25 channel names, never its messages. On the live hub the answers come from **jev**, the
machine's local reranker (`~/Projects/jev`, Qwen3-Reranker-4B, 127.0.0.1:7862): one batched call per question, about
0.1 s a place the first time, cached by jev after that. `DITHER_CATEGORY_MODEL` picks another: `keyword` (words
only, the demo hub's default, so its world is the same each run) or an Ollama model name; `DITHER_JEV_URL` moves jev.
When the model fails, those places are scored by keywords and asked again on the next run (every 5 minutes).

jev's P(yes) is uncalibrated and low: a Rust server scores about 0.5 for "programming", a near miss 0.02. So a place
belongs to a category when its score is at least the category's **threshold**: yours if you moved its slider (in the
Organize view or in Directory → Edit categories, where each category shows how many places match), else 12% for jev
and 50% for keywords (`categoryThreshold` in the protocol). The slider is logarithmic, from 100% down to 0.1%. Your
Yes/No on a place still beats any score.

## API

| | |
|---|---|
| `GET /api/usage` | `{ now, halfLife, places: UsageView[], arrange }` |
| `POST /api/usage` | `{ batch, deltas: [{ kind, id, seconds, visits, at, lastVisit }] }` → `{ applied }` |
| `DELETE /api/usage` | everything, or `{ kind, id }` |
| `PATCH /api/arrange` | `{ sort?: { rail?, people? }, dismissed?: { [categoryId]: string[] \| null }, followArchive?, quietShelf? }` |
| `PUT /api/folders` | `{ folders: FolderView[] }`, every folder; a `folder` item nests one |
| `POST /api/categories/probe` | `{ question }` → `{ provider, question, scores: [{ kind, id, p }] }`, nothing saved |
| `PATCH /api/categories/:id` | `{ threshold }` among the rest; `null` goes back to the provider's default |

Tables `place_usage`, `usage_batch`, `arrange_setting` are created by `schema.sql` like every other
table, so an existing hub gets them on start with nothing to migrate.

## Limits

- Settings and usage reach your other devices when they next come to the front or within a minute, not
  live over the socket.
- Time is counted per device in the foreground; two devices open on the same place at once both count.
- The idle cutoff counts up to 5 minutes of reading without touching anything; reading longer than that
  without input stops counting.
