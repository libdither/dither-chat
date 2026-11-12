# Calendar

[dither-calendar](../../dither-calendar) is a calendar server of its own (port 8470 on functor) that keeps Google
Calendar in sync and finds plans in your chats. The hub puts it beside the chats: its web app as the Calendar pane,
the plans it found as chips under the messages that made them, and its reminders as notifications. The calendar's own
design is in its repo; this page is the hub's side.

## What works

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
- **Reminders.** The calendar decides when; the hub notifies. A reminder is an alert: it sounds, on every device. In
  quiet hours it is held quiet instead (phones only, silent, "Held by quiet hours"), and it is not part of quiet hours'
  summary. Its notification is one per event (tag `calendar:<eventKey>`), opens the calendar on its day, and has a Join
  button when the event has a video link. Device rules on **Calendar reminders** (`network:calendar`, a row of its own
  under Settings → Notifications → Each device) keep it off a device; Mentions only does too, since a reminder mentions
  no one.

## How

### The proxy: `/calendar/*`

`packages/hub/src/calendar.ts` `CalendarLink.proxy`. `GET /calendar` redirects to `/calendar/`; anything under
`/calendar/` goes to `${DITHER_CALENDAR_URL}/<rest>` with its query, streamed both ways, with `x-forwarded-host` (the
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

### Reminders: `POST /api/calendar/notify`

From loopback, with no Origin header; anything else gets 403. The body is a `ReminderNotice`
(`packages/protocol/src/calendar.ts`): title, time and place, the calendar's own words for when ("in 10 min ·
14:00–14:30"), the calendar hash to open and a meeting link. Never a description or message text. The answer is a
`ReminderResult`: 200 with the tier and how many devices it went to, 400 for a bad body, 503 when it could not be
delivered. The calendar retries on a network error or a 5xx with the same `id`; the hub remembers ids it delivered
(2000, for 48 hours), so a repeat is answered `duplicate: true` and notifies nothing. Two posts of one id at once
notify once.

`ReminderDelivery` (calendar.ts), wired in main.ts: activity log kind `reminder`, device rules by
`devices.quietOn('calendar:reminders')` whose chain is `network:calendar`, the `notify` event with `calendar: {open,
eventKey, reminderId, meetingUrl}`, the push with the same plus `tier` and `level`. An ntfy topic's tap opens
`#/calendar/<open>`. The Android app shows it as a plain notification that opens the app.

## Running it

| Variable | |
|---|---|
| `DITHER_CALENDAR_URL` | the calendar, `http://127.0.0.1:8470` by default on a real hub; `off` or empty for none. A `--demo` hub never has one, whatever it says, so `check:boot`, `verify-perf` and the verify scripts never reach a live calendar |

A script that starts a hub without `--demo` sets `DITHER_CALENDAR_URL=off` (verify-e2ee, verify-accounts-matrix,
verify-telegram-approve). The calendar side needs `DITHER_CALENDAR_REMINDERS=1` to post reminders, and its
`chat.hubUrl` pointing at this hub.

After a deploy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://chat.tn.example.net/api/calendar/notify   # 403: not from loopback
curl -N https://chat.tn.example.net/calendar/api/stream                                            # hello at once, then a keepalive every 25 s
```

and reload the installed app twice (pwa.ts's update flow), so the new worker, which leaves `/calendar/` alone, is the
one in control.

## Testing

`packages/hub/test/calendar.test.ts` runs the hub against a fake calendar on port 0 that holds its event stream open
and writes to it on command: the redirect, the path, query and forwarded headers, the prefixed `Location`, a foreign
Origin refused, the event stream read through the proxy while it stays open, 502 when nothing answers and 404 (never
the chat app) when off, plans after `hello` and after a `changed`, `hello` replacing them, who may post a reminder,
and the reminder's tier, quiet hours, a device rule and a repeated id. `compress.test.ts` checks an event stream passes
through unread, `web/test/plans.test.ts` each chip, and `pages.test.ts` the `#/calendar/...` routes.
