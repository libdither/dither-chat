# Notifications per device, and what they look like

The notification rules in Settings apply to every device. Triage reads them once per message and decides whether it
is worth a notification at all (push, digest or silent), and the inbox ranks conversations by the same rules. Some
choices belong to one device only, though. On a phone that also has the Signal app, a Signal message should come
from Signal there, while the laptop, with no Signal app, should show it from dither. Muting Signal everywhere did that
for the phone, but it also took Signal off the laptop and sank every Signal chat to the bottom of the inbox.

So each device has rules of its own, applied after triage.

## Rules

A device rule covers a network, an account, a community (space) or a conversation, and has one of three levels:

| Level | On that device |
|---|---|
| Notify | whatever the shared rules let through (the default) |
| Mentions only | only notifications about a message that mentions you or replies to you |
| Off | nothing |

The most specific rule on the device wins, in triage's own order: conversation, thread parent, communities (nearest
first), accounts, network (`devices.ts` `chain`). Device rules only ever take notifications away. They do not
change triage's decision, the digest, quiet hours or the inbox's ranking, and they never make a device show what the
shared rules hold back. Notify on a conversation is kept only to override a wider rule on the same device.

"Off" covers everything that device would show: its push, the in-app toast, and the browser notification an open
page raises. The hub works out which devices stay quiet (`Devices.quietOn`), leaves them out when it sends the push,
and lists them in the live `notify` event (`quiet`), so their open pages show nothing either. The activity log still
records the notification, with the devices it actually went to.

Set them in **Settings → Notifications → Each device**, which lists every device with its networks (and accounts, where
a network has more than one), or for one place from its menu: **On This Device**. Any device can change any other
device's rules, so the phone can be set up from the laptop.

## What a device is

A device is a page install: the random id the page keeps in localStorage (`dither-chat:device`), the same one the
activity log uses ([activity.md](activity.md)). On every connect the page says hello (`POST /api/devices/hello`) with
that id, a label ("Linux, Chrome", "Android app, Pixel") and the push endpoint it holds, if any. The hub then ties
that push registration to the device.

A push registration no page has claimed yet (the phone has not opened the app since it turned push on) is listed as a
device of its own, under its push id, and rules can be set on it. When a page claims it, those rules move to the page's
device. Forgetting a device drops its rules; its push registration stays and is listed on its own again.

API: `GET /api/devices`, `POST /api/devices/hello`, `PUT /api/devices/rules {device, scope, target, level|null}`,
`DELETE /api/devices {id}`. The list reaches clients in the bootstrap (`devices`) and as a journaled `devices` event
([sync.md](sync.md)).

## What a notification looks like

The push payload and the `notify` event carry the network and a picture (`Store.notifyLook`): the sender's (their
person's, else their identity's), else the conversation's, as a signed hub media path. An inline picture goes only when
it is under 1.5 KB, since a push carries about 4 KB.

- **Browsers** (`public/sw.js`): the service worker draws the picture as a circle with the network's badge in a corner
  (its colour behind its white mark) as the notification's icon, and the network's mark alone as its badge, the small
  monochrome icon Android shows in the status bar. Without a picture, the title's first letter on a plain disc. An
  open page without push hands its notifications to the worker, so they look the same. Where a worker cannot draw
  (no `OffscreenCanvas`), the app icon as before. The worker's glyphs and colours are copies of `web/src/brand.ts` and
  the protocol's `NETWORK_META`; a test keeps them equal.
- **The Android app** (`Notifications.kt` `Looks`): the network's mark (`res/drawable/ic_net_*.xml`, generated from the
  same glyphs with every path number written out, since Android's path parser misreads packed arc flags) as the small
  icon, tinted in the network's colour, and the same round picture with its badge as the large icon. The picture is
  fetched from the hub on a background thread, with a 4 s limit.
- **In-app toasts** show the same picture with the network badge.

## Verified

`scripts/verify-devices.ts` against a demo hub in headless Chromium: the page says hello and Settings lists it; Off for
Signal from Settings; a Signal answer arrives marked quiet for this device and shows no toast, while a Discord answer
shows with its picture and badge; clearing the rule brings Signal back; the worker draws both kinds of icon and badge.

On the emulator (release build, ntfy.sh): the app's page claimed its push registration; with Signal off on the phone, a
Signal answer went to no device while a Discord one arrived, showing Discord's mark and the sender's picture with its
badge; with the rule cleared a Signal answer arrived with Signal's mark; a real avatar (Discord's default, through the
hub's media proxy) showed as the large icon. Unit tests: `hub/test/devices.test.ts`, `web/test/sw.test.ts`.
