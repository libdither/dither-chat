# Button counts

Which of the app's buttons you actually press, counted per day, so a redesign of the Inbox, Catch up and
the People list can follow real use. Off unless you switch it on, on each device. Everything stays on your hub:
no analytics service, nothing sent anywhere else.

## Switching it on

Settings → **Usage** → "Count which buttons I press". The switch is per device (it lives in the device's own
preferences, `prefs.countClicks`), so a phone and a desktop can be compared. Off, nothing is counted and nothing is
sent; switching it off drops whatever this device had not sent yet.

Under the switch, a table shows the most pressed buttons over 7 or 30 days, split into phone and desktop, from every
device that has it on. **Forget…** deletes every count on the hub.

## What is counted

One number per day, key, page and kind of device:

- **day**: the device's own date (YYYY-MM-DD). Nothing finer.
- **key**: a string written in the app's code, such as `inbox: row (DM, unread)`, `catch up: done` or
  `keys: Ctrl+K (switcher)`. Never a name, a message, an id or an address.
- **page**: the kind of screen it was pressed on (`inbox`, `conversation`, `triage`, `model`, `people`, `settings`, …), from
  the route: never which conversation or person.
- **device**: `phone` or `desktop`, from the layout in use (the phone layout is the one below 820 px).

### How a click becomes a key

`packages/web/src/clicks.ts`, from one capture listener on the document (`clicklog.ts`):

- A control says what it is with `data-track="vote up"`. A key without `: ` takes the name of the nearest
  `data-track-area` around it (`<section class="pane catchup" data-track-area="catch up">` makes it `catch up: done`),
  else the page's. A key with `: ` is complete.
- The nearest control to the click decides: a `button`, link, form field, `summary` or an element with a button-like
  role. If it has no key, the click counts as `<page>: other`, so what is not tagged yet still shows, and an untagged
  button inside a tagged row is not taken for the row.
- A click on no control (text, empty space) counts as nothing. A click on a `label` counts as the click on its
  control that the browser sends next.
- Shortcuts and gestures that are not clicks are counted where they are handled, with `countKey`: Ctrl+K, Ctrl+F,
  Enter and Esc in the composer, a context menu's letter keys, mail's keys, Enter in a search box, and on a phone
  the swipes (back, to and from the details, forward, to reply) and pull to refresh, and Catch up's keys.

Context menu items carry their key in the menu's spec (`track` on an item, the area as `track` on the spec), never
their label, which can hold a name ("Message Ann").

### What is tagged

| Area | Keys |
|---|---|
| `inbox` | `row (DM\|group\|notes\|channel\|thread\|mail[, unread\|, owes a reply])`, `filter` (the button), `filter (All\|Direct messages\|Groups\|Mail)` (its menu; until 2026-11-09 chips `filter (All\|People\|Groups\|Unread)`), `search`, `search (Enter)`, `search (suggestion)`, `requests row`, `new message`, `row (account needs you)`, `section toggle (Needs you\|Waiting on you\|New\|Earlier)` (until 2026-11-09 `section toggle`, in every list) |
| `catch up` | `done`, `done (mail)`, `later`, `open`, `open (mail)`, `reply box`, `reply sent`, `reply sent (Enter)`, `earlier`, `picture`, `new note`, `mark all read`, `how it sorts`, `how it sorts (all caught up)`, `account needs you`, `reply: try again`, `reply: discard`, `leave the box (Esc)`, `key j`, `key k`, `key Enter`, `key e`, `key l`, `key r` |
| `how it sorts` | `open`, `open (mail)`, `why`, `why (close)`, `vote up`, `vote down`, `show all`, `not interesting (open)`, the learned rules' buttons; inside Why (`how it sorts (why)`): `message`, `message (mail)`, `vote up`, `vote down`, `show all` |
| `people` | `chip (chats\|friend\|contact\|following)`, `accounts` (the account menu) and its `account (all\|one)` (until 2026-11-09 chips `account chip`, `account chip (all)`), `order` and its `order (Last talked\|A to Z)` on a list, `filter box`, `row (person[, unread])`, `row (friend\|contact\|following)`, `remove (…)` (from a row's menu), `people graph`, `new message`, `section toggle (Starred\|Direct messages)` |
| `chat header` | `picture`, `name`, `crumb (community\|parent)`, `profile`, `all chats`, `join call`, `about`, `search here`, `notification level` and its choices, `details`, `network chip` |
| `message` | the hover actions: `edit`, `delete`, `reply`, `forward`, `more`, `triage note` |
| `message menu` (and `attachment menu`, `link menu`) | `reply`, `edit`, `forward`, `copy text`, `copy link`, `add reaction`, `quick reaction`, `view reactions`, `open thread`, `go to replied`, `go to original`, `profile`, `history`, `delete`, `copy message id`, `copy dither-chat id`; `… (key R)` when picked by its letter |
| `composer` | `text box`, `send`, `send (Enter)`, `attach`, `send as`, `cancel reply`, `cancel edit`, `cancel … (Esc)` |
| `rail` | `inbox`, `people`, `mail`, `community`, `chat`, `folder (open\|close)`, `all communities`, `order`, `accounts`, `settings` |
| `inbox menu` (the inbox button's) | `mark everything read`, `how it sorts` |
| `tabs` (phone) | `Home`, `Catch up`, `Search`, `You` |
| `settings` | `section <name>` for each section, from the side list or the phone's Sections sheet; `how it sorts` |
| `pager` | `back button`, `swipe back`, `swipe to details`, `swipe from details`, `swipe forward`, `swipe to reply`, `pull to refresh`, `back to the page`, `close details` |
| `keys` | `Ctrl+K (switcher)`, `Ctrl+F (search)`, `mail e\|#\|!\|s\|u` |

Android's own back button is not counted: it reaches the page as a history step, like any other.

## Sending and keeping

The device keeps its counts in localStorage until they are sent: every minute, when the app is hidden and on
`pagehide` (with `keepalive`), in batches of up to 200 entries. Each batch has an id, and the hub ignores one it has
seen, so resending after a lost answer counts once.

The hub (`packages/hub/src/clicks.ts`) adds each entry into `click_count (day, key, page, device, n)` with
`ON CONFLICT DO UPDATE SET n = n + excluded.n`, and keeps 400 days.

| Route | |
|---|---|
| `POST /api/usage/clicks` | `{ batch, counts: [{ day, key, page, device, n }] }` → `{ applied }`. Refused from another site (403) like every write; a body over 64 KB is refused (413); at most 500 entries; keys up to 80 and pages up to 32 printable ASCII characters; a day within a year back and two days ahead; `n` from 1 to 10 000. Anything else is dropped |
| `GET /api/usage/clicks` | `?days=N` (1 to 365, default 7), `&by=device` (each key's `phone` and `desktop` too) or `&by=page` (a row per key and page), `&limit=` (default 200) → `{ days, since, total, keys: [{ key, n, … }] }`, most pressed first |
| `DELETE /api/usage/clicks` | forget everything |

For development, `bun scripts/clicks.ts [hub URL] [--days 30] [--top 40] [--by device|page]` prints the table from
a hub (default `http://127.0.0.1:8460`).
