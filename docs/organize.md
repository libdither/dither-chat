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

**Where it goes.** The device accumulates in memory and `localStorage`, and sends a batch every minute
and when the page is hidden (`fetch` with `keepalive`). Each batch has an id; the hub ignores an id it has
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
| Groups lists | Recent, Smart, A–Z | Recent (today's) |

People and groups have no manual order to keep, so "Manual" there is not offered.

In every mode **pinned places stay first, in your manual order** (starred people in the People list).
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
Animations, skipped with reduced motion). Smart order in the People and Groups lists is snapshotted the
same way; Recent there stays live, as in any chat app, and A–Z only changes on a rename.

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
  its contents (folders do not nest); a folder a move empties is removed.
- **Suggested folders** come from the categorizer (`categorize.ts`): for each category, the loose
  (unpinned, not in a folder) rail places that belong to it, at least two, or one if a folder of that
  name exists ("Add to …"). *Create* makes the folder in the category's colour; *Edit* selects its places
  and opens the name field so you can change both; *×* dismisses it. A dismissal remembers the places it
  suggested and is shared by your devices; a new place in that category brings the suggestion back.

## API

| | |
|---|---|
| `GET /api/usage` | `{ now, halfLife, places: UsageView[], arrange }` |
| `POST /api/usage` | `{ batch, deltas: [{ kind, id, seconds, visits, at, lastVisit }] }` → `{ applied }` |
| `DELETE /api/usage` | everything, or `{ kind, id }` |
| `PATCH /api/arrange` | `{ sort?: { rail?, people?, groups? }, dismissed?: { [categoryId]: string[] \| null } }` |

Tables `place_usage`, `usage_batch`, `arrange_setting` are created by `schema.sql` like every other
table, so an existing hub gets them on start with nothing to migrate.

## Limits

- Settings and usage reach your other devices when they next come to the front or within a minute, not
  live over the socket.
- Time is counted per device in the foreground; two devices open on the same place at once both count.
- The idle cutoff counts up to 5 minutes of reading without touching anything; reading longer than that
  without input stops counting.
