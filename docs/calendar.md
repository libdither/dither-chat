# Calendar

[dither-calendar](../../dither-calendar) is a calendar server of its own (port 8470 on functor) that keeps Google
Calendar in sync and finds plans in your chats. The hub links it as an **account of kind `calendar`**, whose one
setting is the calendar's address. While an enabled calendar account is there, the calendar is on: its web app as the
Calendar pane, the plans it found as chips under the messages that made them, its own chat ("Calendar"), and its
reminders as that chat's messages. Remove the account, or turn it off, and all of it goes. The calendar's own design is
in its repo (its `docs/chat-account.md` for its side of the account); this page is the hub's side.

## What works

- **The calendar account.** Accounts → Add → Calendar asks for the address (`http://127.0.0.1:8470` unless you say
  otherwise). One at a time: a second is refused until the first is removed. Removing it works like any account's, and
  the calendar's pane, tab, Ctrl+K entries, chips, chat and reminders go with it on every open page at once (a
  `calendar` event with `off`); adding it back brings them back. Settings → Notifications → Each device shows Calendar
  like any network with an account.
- **The Calendar chat.** A direct conversation with the calendar. What you write there is added to the calendar in
  words ("dentist friday 3pm at Dr Lee's"), and the calendar answers with what it added, or asks when it cannot tell
  (when, what, or 7 in the morning or the evening); "undo" takes the last one back. The calendar never reads this chat
  for plans.
- **The Calendar pane.** A calendar icon in the rail, after Mail, and a Calendar tab on a phone, on a hub with a
  calendar. It is the calendar's own web app, framed, at `#/calendar/<the calendar's hash>`: `#/calendar/day/2026-11-14`
  opens that day, and moving around inside the calendar keeps that address in step, so a reload or a copied link comes
  back to the same day. The calendar's own moves are history entries, as a browser keeps for any frame: Back steps back
  through the days you looked at, and the address follows. A dot while plans from chats wait for you
  there; its tooltip says when the hub does not reach it. Ctrl+K finds Calendar, Today, Tomorrow and Plans from chats.
- **Chips under messages.** Under the message that named the time (not the newest one when the plan was read):

  | The plan | The chip | Its buttons |
  |---|---|---|
  | a suggestion | title, "Fri 14 Nov 19:00", place | Add, Dismiss |
  | on your calendar | "On your calendar · title · time", the event's own time | — |
  | the chat moved it | "Moved to Sat 20:00" | Move it, Keep |
  | the chat called it off | "Called off" | Remove, Keep |
  | cancelled | "Called off", faded | — |

  A dismissed plan shows nothing, nor does a suggestion more than a day past. Clicking the chip opens the calendar
  where it is. The buttons answer the calendar (`POST /calendar/api/proposals/:id/accept|dismiss`, through the hub),
  show its answer at once, and the next `plans` event settles it.
- **Reminders.** The calendar decides when; the hub notifies. A reminder is a message from the calendar in its chat
  (`**Standup** in 10 min · 10:00–10:15 · Room 2`, and a Join link for a call), and triage makes it an alert: it
  sounds, on every device. In quiet hours it is held quiet instead (phones only, silent, "Held by quiet hours until
  …"), and it is not part of quiet hours' summary. Its notification is the Calendar chat's, so it opens that chat and
  leaves the phones when the chat is read. Device rules on **Calendar** (`network:calendar`, under Settings →
  Notifications → Each device) keep it off a device; Mentions only does too, since a reminder mentions no one. Muting
  the Calendar chat silences them, and List only keeps them to the list.

## How

### The account: `calendar-account.ts`

`CalendarAccounts` follows the accounts: the first enabled calendar account with a usable address is the one that is
on, and its `CalendarLink` (calendar.ts) reads that address. `sync()` runs at start and after `POST`, `PATCH`
(enabled) and `DELETE /api/accounts`; turning on sends pages `{t: 'calendar', reachable: false, waiting: 0}`, turning
off `{…, off: true}`, and a bootstrap without `calendar` turns it off too (web `plans.ts`). A demo hub never has one.

The account runs in the hub, never in dither-accounts (it is not in `MANAGED_KINDS`): its adapter is the supervisor's
in-process `CalendarBridge`, which dials `ws://<address>/api/chat-adapter` and relays the adapter protocol both ways.
Commands go to the service; one it cannot be asked (not connected, or the socket went before it answered) is answered
with an error at once. A dropped socket is offline at once and tried again after 1 s, doubling to a minute; not
answering for a minute, the account says so (attention). The bridge knows nothing about calendars.

**The first start with calendar accounts** (`seedCalendarAccount`, main.ts): a hub that had a calendar by
`DITHER_CALENDAR_URL` (or its default) gets a calendar account for that address, once, and writes down that it did
(meta `calendar_account_added`, also set when you add one by hand). Never on a demo hub, never with
`DITHER_CALENDAR_URL=off` or empty, and never again after that, so removing the account sticks. From then on the
account says where the calendar is; the variable is read only by this seed. A calendar account alone does not make a
demo world reopened as a real hub drop its demo accounts.

### The contract

What a calendar service answers at its address, so another one can replace dither-calendar by changing the account:

| | |
|---|---|
| `GET /api/chat-adapter`, a WebSocket | the adapter protocol (`packages/protocol/src/adapter.ts`), the hub dialling: the service sends events (`hello` with network `calendar`, `status`, identities, conversations, messages, `{t: 'reply'}` to each command with an `id`), the hub sends commands. Never `shutdown`: the hub closes the socket. Taken only from loopback without an Origin or forwarded headers |
| `GET /api/stream` | an event stream: `{t: 'hello'}` on connect, `{t: 'changed', what: [...]}` when proposals or events change, a keepalive at least every 70 s |
| `GET /api/chat/plans?since=<ms>` | `CalendarPlans` (`packages/protocol/src/calendar.ts`) |
| `POST /api/proposals/:id/accept`, `/dismiss` | the chips' buttons, through the proxy |
| everything else under `/` | its web app, framed at `/calendar/` |

A reminder is a message with `extra.reminder` (`CalendarReminderRef`: `id`, `eventKey`, `open`, `meetingUrl`, `late`).
Triage (triage.ts) makes any message so marked an alert unless its place is muted or List only; in quiet hours it is
held quiet and not counted for the summary. Its hello may declare `personRefs`: the hub then leaves
`<@person:per_…>` and `<@identity:idn_…>` in what you send as written (docs/mentions.md), and the service names them.

### The proxy: `/calendar/*`

`packages/hub/src/calendar.ts` `CalendarLink.proxy`. `GET /calendar` redirects to `/calendar/`; anything under
`/calendar/` goes to `<the account's address>/<rest>` with its query, streamed both ways, with `x-forwarded-host` (the
Host the browser used), `x-forwarded-proto`, `x-forwarded-prefix: /calendar` and `accept-encoding: identity`. A write
(anything but GET and HEAD) must pass the hub's own same-origin check first, as `/api/` writes do. A `Location` on the
calendar gets the prefix. An event stream is passed on as it comes (`cache-control: no-store, no-transform`, and
`compress()` never reads one).

The calendar trusts `x-forwarded-host` only from loopback (its `sameOrigin(req, ip)`), so the browser's writes through
the hub pass its own origin check. Caddy reaches both servers over the tailnet address, so nothing from another device
is loopback to either.

| | `/calendar/api/*` | anything else under `/calendar/` |
|---|---|---|
| no calendar on this hub | `404 {error: "calendar is off on this hub"}` | a small page, "Calendar is not set up on this hub" |
| the calendar does not answer | `502 {error: "the calendar is not answering"}` | a small page with Retry |

Neither is ever the chat app. The chat app's service worker leaves `/calendar` and everything under it alone, so the
calendar's own worker (scope `/calendar/`) and files are its own.

### Plans: `GET /api/plans`

The hub holds the calendar's event stream (`GET /api/stream`) over loopback. On its `hello` (a first connect, a
reconnect) it reads every plan (`GET /api/chat/plans?since=0`) and replaces what it kept; on a `changed` that names
`proposals` or `events`, a second later, those changed since five seconds before the last answer. It keeps the newest
2000. Each read goes to open pages as a `plans` event (`replace` for a whole list), and a change in whether the
calendar answers or how many plans wait as a `calendar` event. Both are of the moment, like `typing`: never journaled.
A dropped stream is tried again after 1 s, doubling to a minute; 70 s without a byte (the calendar writes a keepalive
every 25 s) counts as dropped.

`GET /api/plans` answers from what the hub kept: `{plans, reachable, waiting}`, dismissed plans included so a page can
drop their chips; 404 when the calendar is off. A page asks it when its live socket opens, and again on a `resync`.

A hub with a calendar adds `calendar: {path: '/calendar/', reachable, waiting}` to its bootstrap. Without one there is
no such field, nothing is asked for, and a message row draws nothing more: `calendarOn` (web `plans.ts`) is false, and
only the chip itself reads the plans' signal (`ui/calendar/lazy.tsx`). The card is a chunk of its own, loaded the first
time a plan shows.

## Running it

| Variable | |
|---|---|
| `DITHER_CALENDAR_URL` | read once, by the first start with calendar accounts: the address its calendar account gets, `http://127.0.0.1:8470` by default on a real hub; `off` or empty adds none. A `--demo` hub never has a calendar, whatever it says, so `check:boot`, `verify-perf` and the verify scripts never reach a live calendar |

A script that starts a hub without `--demo` sets `DITHER_CALENDAR_URL=off` (verify-e2ee, verify-accounts-matrix,
verify-telegram-approve), so its fresh data dir gets no calendar account. The calendar side needs
`DITHER_CALENDAR_REMINDERS=1` to post reminders, and its `chat.hubUrl` pointing at this hub for the plans and for
naming people.

**Deploying calendar accounts** (from a hub before them): deploy dither-calendar first, then the hub. The hub's first
start adds the account and its link dials the calendar's `/api/chat-adapter` at once. A reminder due while only one
side is new waits and is tried again: the new calendar keeps it until a hub connects; an old calendar's post to the
new hub's `/api/calendar/notify` gets 404, which it retries too. After the hub is up:

```sh
grep 'calendar: added a calendar account' ~/.local/share/dither-chat/hub.log   # once, at the first start
curl -N https://chat.tn.example.net/calendar/api/stream                         # hello at once, then a keepalive every 25 s
```

the Calendar account is online under Accounts and the Calendar chat has the calendar's welcome; and reload the
installed app twice (pwa.ts's update flow), so the new worker is the one in control.

## Testing

`packages/hub/test/calendar.test.ts` runs the hub against a fake calendar on port 0 that holds its event stream open
and writes to it on command: the redirect, the path, query and forwarded headers, the prefixed `Location`, a foreign
Origin refused, the event stream read through the proxy while it stays open, 502 when nothing answers and 404 (never
the chat app) when off, plans after `hello` and after a `changed`, `hello` replacing them. Then the account: the
first start's seed (once, never on a demo hub or with `off`, never after a removal), the calendar following the
account on and off, `POST /api/accounts` for a calendar; the bridge against a fake service's socket (both ways, a
command it cannot ask, a dropped socket, dialling again), and through the supervisor into the store; and reminders as
messages: an alert, held quiet and left out of the summary, muted or List only, device rules. `compress.test.ts`
checks an event stream passes through unread, `web/test/plans.test.ts` each chip and the calendar coming and going,
and `pages.test.ts` the `#/calendar/...` routes.

## Next

- **Event chats**: a conversation per event with its attendees, from the people the calendar keeps with an event
  (dither-calendar's `event_person`, filled from `<@person:…>` refs once mentions are lowered on send).
- A reminder's notification opens the Calendar chat; opening the calendar on its day and a Join button on the
  notification (the `calendar` ref the web and the worker still read) would need the message's notification to carry
  it.
