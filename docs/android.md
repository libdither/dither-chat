# The Android app

`apps/android` is a small native shell around the same web app the hub serves. It exists for what a browser tab
does badly on Android: starting fast, asking for permissions, keeping a call alive with the screen off, and push.
The release APK is about 250 KB.

## Design

One `Activity` with one `WebView` that loads the hub's own origin (`https://chat.example.net/`). Same origin means the
page is exactly what a browser gets: the same service worker, storage, `Origin` checks and API, with no CORS, and the
same sign-in ([login.md](login.md)): the page signs in once and the WebView keeps its session cookie. The app's own
requests (a reply from a notification, push registration, uploads, a notification's picture: `Hub.authorize`) carry
that cookie and the hub's origin as their `Origin`; signed out, they get 401. The hub's address is typed on first run
and kept in the app's preferences; nothing about it is built in.

Around the WebView:

| Need | How |
|---|---|
| Microphone, camera | `WebChromeClient.onPermissionRequest`, only for the hub's origin, mapped to `RECORD_AUDIO` / `CAMERA` runtime permissions, asked when the page asks |
| Attachments | `onShowFileChooser` with the system picker, several files where the page allows it. Photos and videos open the system photo picker (Android 13+), and `capture` the camera app writing to a file of the app's own when the camera is allowed ([uploads.md](uploads.md#on-a-phone)) |
| Links | Anything that is not the app's own page (other sites, downloads from elsewhere) opens in the system browser |
| Photos and files | The message box's panel shows the phone's gallery and folders itself (`Device.kt`; [uploads.md](uploads.md), "The panel"): lists over the bridge, bytes at a private path under the hub's origin that the WebView answers before the network |
| Files | The hub's `/media/` and `/emoji/` files are downloaded into the app's cache and offered with the system chooser, as `content://org.libdither.chat.files/<name>` (Files.kt). The page passes the file's name and type; older pages fall back to the hub's headers |
| Back | Walks the page's history: its routes, and the sheets and panels that push entries (`phone.ts`). At the start the app goes to the background and stays alive, so the next open is instant |
| Launch | Theme, splash and WebView background are the page's own colour (`#14151b`, or the light theme's after the page reports it), so there is no white flash |
| System bars | Edge to edge; the bars are padding around the WebView, and so is the keyboard for a page that doesn't keep its room itself (below) |
| Keyboard | A page that says it keeps the keyboard's room (`{ t: 'keyboard', page: true }`, after `info` lists `keyboard`) gets the WebView's whole height, and the keyboard's height over the navigation bar on every frame of its slide (`{ t: 'ime', h, done }`, from a `WindowInsetsAnimation` callback; Android 11+). The page then sizes itself to what the keyboard leaves, so the message box rides on the keyboard, and a panel can take the keyboard's place without the box moving ([phone.md](phone.md), "The keyboard and the panel"). Each new page starts with the app making room, until it says so again |
| Bridge | `WebViewCompat.addWebMessageListener` named `DitherAndroid`, with an allowed-origin rule of the hub's origin only, so no other page, frame or redirect target can post to it. Page side: `packages/web/src/android.ts` |
| Calls | `CallService`: a foreground service while the page says a call is live (`phoneCall`, and `microphone` once the microphone is allowed: [The call service](#the-call-service)), with an ongoing notification (Hang up, Mute, Audio route) |
| Playing in the background | `MediaService`: a `mediaPlayback` foreground service while the page plays a voice message or a sound file, with a media notification and session (play and pause, the position, Close, the lock screen, a headset's button). See [Playing in the background](#playing-in-the-background) |
| Audio route | `AudioManager.setCommunicationDevice` (Android 12+: speaker, earpiece, Bluetooth, wired, USB); speaker or earpiece before that. The notification's Audio button cycles; `android.setAudioRoute()` is there for the call UI. On the earpiece a proximity wake lock turns the screen off at the ear |
| History uploads | The History section's upload buttons open the system picker from the app, which then uploads in a `dataSync` foreground service, so it goes on with the app closed. Files, or a whole folder, which a WebView's picker can't do. See [History uploads](#history-uploads) |
| Push | UnifiedPush (below), registered from Settings → *Push on this device*. Tapping a notification opens its conversation; opening a conversation clears its notification; Reply in the notification goes through the hub's ordinary send, as `sw.js` does in a browser |

Why not something else:

- **Capacitor / Cordova / Tauri** would load the app from files bundled in the APK. That breaks same-origin (the page
  would need CORS and an auth story for a hub that has none), means a new APK for every web change, and adds about
  1-3 MB for plugins this needs five of. Hand-written, the shell is about 1,000 lines of Kotlin.
- **A Trusted Web Activity** (Chrome in full screen) would get Web Push through Google's relay for free. But it has no
  bridge, so no foreground service for calls, no audio routing and no native snapshot of startup state. Chrome also
  decides when it starts, and it requires Chrome. The WebView is updated by the Play Store, like Chrome.

### What a WebView can and cannot do (checked on the emulator's WebView 124)

| | |
|---|---|
| `PushManager`, `Notification` | Absent. A WebView has neither, hence UnifiedPush |
| Service worker | Yes, in a secure context: `https://`, or `http://localhost` |
| `getUserMedia` | Yes, after `onPermissionRequest` grants it. Secure context only |
| `encodedInsertableStreams` / `createEncodedStreams` | Yes |
| `RTCRtpScriptTransform` | No in WebView 124 (it reached Chromium later). `voice/discord.ts` already falls back to the encoded-streams path |
| Module worker from a `data:` URL, with top-level await | Yes |
| `AudioContext` | Yes, starts `running` (`mediaPlaybackRequiresUserGesture` is off) |
| Camera: `getUserMedia` video, `torch`, `facingMode` per camera, `MediaRecorder` | Yes on the Android 15 emulator's WebView (2026-11-10). `MediaRecorder` records WebM there, not MP4 |

### Calls with the screen off

Verified with a WebRTC loopback using the real microphone path, held for 45 s each way:

| App in the background for 45 s | Page timers | Audio received | Microphone (`dumpsys audio`) |
|---|---|---|---|
| With `CallService` (process state 4, foreground service) | every 1 s | yes | `silenced:false` |
| Without it (process state 15, cached) | every 1 s | yes | **`silenced:true`** |

Without the service, Android keeps the page running for a while but silences the microphone: the other side hears
nothing. With it, the call goes on. During a call the app also skips `WebView.onPause`, keeps the renderer at
`RENDERER_PRIORITY_IMPORTANT` while not visible, and holds a partial wake lock and a low-latency Wi-Fi lock.
Swiping the app away from Recents destroys the WebView, and with it the call.

### The call service

A page starts its call before the microphone is allowed: it opens the call's socket and tells the app the call is
live while Android is still asking. Android 14+ throws at `startForeground` with type `microphone` unless the app holds
`RECORD_AUDIO` at that moment, and the throw ends the app. Until 2026-11-16 that is what every first call did: the
app died behind the microphone prompt, the prompt went with it, so the microphone was never allowed and the next call
died the same way. A phone saw a frozen screen, then the app starting over.

So the service starts as `phoneCall`, which asks no runtime permission (`MANAGE_OWN_CALLS`, granted at install, is
what Android 14+ checks for it), and adds `microphone` once the microphone is allowed (the permission answer calls
`CallService.permissionsChanged()`). Only a change of types calls `startForeground` again; every other update just
re-posts the notification, since Android checks a `microphone` type against the app being in front each time and a
phase or route change can come with the screen off. A refused or failed `startForeground` is caught and reported
([Crashes](#crashes)), never thrown.

Permission prompts go one at a time (`MainActivity.ask`): Android answers a second request made while one is showing
at once, with nothing granted. Notifications are asked for once a call is live, not as it starts: a prompt showing
while the page asked for the microphone made the WebView cancel the page's request, which then never got an answer
and held the call at *Connecting*. A queued prompt whose page request was cancelled meanwhile is dropped.

### A ring

A push whose data has a `call` (`{id, tag, accountId, canAnswer, canDecline}`, from the hub's ringing,
[calls.md](calls.md#ringing-calls-you-are-not-in-from-here)) is a ring, not a message (`Notifications.ring`):

- On the `rings` channel (high importance, the phone's ringtone, as a ringtone), tagged `call:<id>`, so the hub's
  `push.clear` for that call takes it back once the call is answered elsewhere, declined or given up. It rings until
  then (`FLAG_INSISTENT`), for at most 3 minutes, as the hub's own `RING.maxMs`.
- Android 12+ shows it as its own incoming call (`CallStyle.forIncomingCall`), which lights a locked screen through a
  full-screen intent. Android 14+ grants those to calling apps only, so where it is not granted
  (`canUseFullScreenIntent`), it is a plain notification with the same two buttons.
- **Decline** goes to `RingReceiver`, which takes the ring away at once and posts `/api/calls/<id>/decline` (a failure
  posts "Call not declined").
- **Answer** opens the app on the chat with the call (`MainActivity`, `EXTRA_ANSWER`), which hands the page
  `{t: 'call.answer', call, conversationId, accountId}` once it says hello (warm or cold). The page joins the call from
  that account in the device's call mode (`src/android.ts`), waiting for its data on a cold start, and joins once
  (`onceListed` in `src/versions.ts`). Until 2026-11-20 the wait ran again on every change the join itself made to the
  call: a cold Answer joined a hundred times, each asking for the microphone and opening a socket, and the last socket
  could stay connecting, leaving the call at *Connecting* while the network still rang.

### Playing in the background

A voice message or a sound file goes on playing with the app in the background or the screen off, as a call does.
The page's tracker (`packages/web/src/nowplaying.ts`, [media-kinds.md](media-kinds.md#playing-in-the-background))
says what plays over the bridge, `{t: 'media', state: 'playing' | 'paused' | 'none', title, artist, album,
conversationId, duration, position, rate}`, and the app:

- starts `MediaService`, a `mediaPlayback` foreground service, when something plays. It starts only from `playing`,
  which a tap in the app starts while the app is in front: Android 12+ refuses a foreground service started from the
  background. While it plays the activity skips `WebView.onPause`, the renderer keeps `RENDERER_PRIORITY_IMPORTANT`,
  and the service holds a partial wake lock and a Wi-Fi lock (a file streams from the hub);
- shows a media notification (channel `playing`) with a `MediaSession`: title ("Voice message", or the file's name),
  the sender and the chat, the position bar, play and pause, and Close. Android 13+ draws these controls from the
  session's playback state, so Close is a custom action there as well as a notification button. The lock screen and a
  headset's button use the same session. Each control goes back to the page as `{t: 'media.do', action: 'play' |
  'pause' | 'stop' | 'seek', to}`, and the page answers with its new state;
- keeps the service while paused, so Play from the notification or a headset needs no new start from the background,
  and stops it after 10 minutes paused, at Close (or the notification swiped away), when the sound ends, when its
  page goes (a new page says hello, or the activity is destroyed: swiped from Recents), or when its player leaves the
  page (its chat closed);
- pauses it when headphones come out (`ACTION_AUDIO_BECOMING_NOISY`). A call starting pauses it (`call.ts
  startCall`).

A video is not played in the background: the WebView pauses a video once the app is hidden, and plays none while it
is, even from the media session (checked on the emulator's WebView, 2026-11-26). The page then drops it, so the
notification goes with it instead of offering a Play that does nothing.

On the emulator a sound plays on in the background without the service too: the app sits cached (process state 15)
for minutes and is neither frozen nor killed. What the service changes is the app's standing, process state 4 (a
foreground service) instead of the first in line when Android needs memory, which is what ends a long voice message on
a phone with other apps open. `scripts/verify-android-media.ts` checks the service, its notification and session, 30 s
in the background with the screen off, the headset's pause and play, Close, the end, and a video (below).

## Crashes

`Crashes.kt` keeps what took the app down for the hub's `traces/errors.ndjson` (docs/tracing.md, "Errors"), where the
bug watch sees it. A crash ends the process before anything can be sent, so it is written to `files/crashes.json`
(an uncaught exception's class, message and frames), and handed to the next page that says hello, which posts each
report to `/api/errors` as app `android`, `where` `/android/...`. Also kept: exits Android recorded since the last
look (ANR, native crash, initialization failure, excessive resource use; Android 11+), the page's renderer crashing
(not Android reclaiming it), and errors the app caught on purpose that should not happen (the call service refused).
At most 20 wait at a time.

## Push

A WebView has no Push API. The app uses [UnifiedPush](https://unifiedpush.org) instead. A distributor app on the
phone (for example [ntfy](https://f-droid.org/packages/io.heckel.ntfy/)) keeps one connection for every app that
uses it. It gives this app an endpoint and RFC 8291 keys, the same shape as a browser's push subscription. So the
hub's existing Web Push sender (`webpush.ts`) is reused unchanged: the app registers the endpoint at
`/api/push/subscribe` itself, and re-registers it whenever the distributor rotates it, even with the page closed. The
connector library decrypts each message on the phone, so the distributor's server sees when a push happens but not
what it says.

### Setting it up

Everything happens on the phone; the hub needs no setting.

1. Install [ntfy](https://f-droid.org/packages/io.heckel.ntfy/) (F-Droid or Google Play). If you run your own ntfy
   server, set it first in ntfy → Settings → Default server. Otherwise ntfy uses ntfy.sh.
2. Open ntfy once. On Android 14 and later it cannot start its connection from the background until it has been
   opened. When it asks, let it run in the background (or: App info → App battery usage → Allow background usage →
   Unrestricted). dither's Settings shows whether Android restricts ntfy, with a button to that screen.
3. In dither: Settings → *Push on this device* → *Turn on for this device*. Allow notifications, and pick the
   distributor if there are several. The app registers, sends a test, and waits for the phone to confirm it arrived:
   "It arrived. Push works on this device."
4. If your ntfy server is one the hub does not know yet, step 3 stops with "This device's push server is
   https://ntfy.example.net" and a button, *Allow notifications through ntfy.example.net*. One tap allows it and
   registers the phone; no second registration is needed. A server on a private address (a tailnet ntfy at 100.x)
   asks once more. A plain-http server is never allowed by one tap: type it under *Push servers*.

Changing ntfy's default server later does not move existing registrations: turn push off and on again in dither.

Verified end to end on the emulator against a demo hub (2026-11-02), with ntfy app 1.25.2:

- through ntfy.sh, allowed by default: one tap, test arrived and confirmed;
- through ntfy.sh after turning it off under *Push servers*: refused, *Allow notifications through ntfy.sh*, test
  arrived;
- through a local ntfy 2.28 server at `http://127.0.0.1:2586`: refused, typed under *Push servers*, confirmed as a
  private address, and the waiting registration went through without the phone asking again. The app build from
  before this change (which only shows the hub's error text) works with it too.

ntfy accepts the hub's VAPID-signed, aes128gcm Web Push as-is. Tapping a notification opens its conversation, and
Reply sends through the hub. Which devices get a message at all is up to each device's rules ([devices.md](devices.md)).

### How a message notification looks

A push says which tier its message is in ([notifications.md](notifications.md)): `tier` is `push` for an alert,
`quiet` for a Conversation and `digest` for a row of the ranked list, and `importance` (0 to 1) says where a list row
comes. A hub from before the tiers sends only `level`, which is read as a Conversation when it is `quiet` and as an
alert otherwise. Each has a channel, so Android's own settings can change one and leave the others: **Sound**
(`messages`, the only one that sounds), **Show (silent, in the shade)** (`messages-shade`) and **Ranked list
(silent)** (`list`). The `messages` id is older than the tiers and the scale, so a sound someone set on it stays.

**Show is minimized** (`IMPORTANCE_MIN`): in the shade only, with no sound, vibration, status-bar icon or lock-screen
card. Android never lowers the importance of a channel that is already there, so Show has a new id, and the app deletes
the channels it no longer uses at each start: the old silent one (`messages-quiet`, low) and the next look's bundle
(`next-look`), which went with the next look ([notifications.md](notifications.md#one-scale-loudness)).

**An alert or a Conversation** is a conversation notification, as Discord, Signal and Google Messages post them
(`Notifications.kt`, design in [research/notification-design.md](research/notification-design.md) §7–8):

- **One per conversation** (tag = conversation id), in `Notification.MessagingStyle` with the push's `lines`: the last
  few messages from others since you last read or wrote there, each with its author as a `Person` (name, key, round
  picture from `icons` or `sender.icon`). A group or channel (`conv.shape` not `direct`) has the conversation's title
  above the messages. A push from an older hub, without `lines`, shows as one message made from its title and body.
- **The picture on the left.** Each conversation has a long-lived dynamic shortcut `conv:<id>` (`pushDynamicShortcut`,
  with the people, a `LocusId` and an adaptive icon: the group's or server's picture, or for a DM the person's,
  scaled into the middle 72 of 108 so the mask leaves it whole). The notification names it with `setShortcutId` and
  `setLocusId`, so Android 11+ draws it in the conversation layout: the shortcut's picture in the icon slot, with the
  small icon, the network's mark in its colour, as a badge on it. No large icon. The shortcut opens the conversation.
  Without a valid long-lived shortcut Android falls back to the plain layout, with the picture missing.
- **A row of its own, when it sounds.** An alert is in a group of its own (`conv:<id>`, the shortcut's id) that never
  gets a summary, and Android shows a notification like that as a separate row in its Conversations section. With no
  group at all, Android 15 gathers an app's notifications into a bundle of its own making (`ranker_group`); it did that
  to five Conversations.
- **Show ones fold together.** A Conversation (Show) is in the shared group `dither-shade` under one silent summary,
  *N chats* with their names, so several quiet ones are one row of the shade. The fold is only how they look: each
  still comes when its message does, and the summary goes once the last of them is read or swiped away.
- **One notification through a change of tier.** The tag is the same for both tiers, so a Conversation that gets an
  alert, or an alert followed by a Conversation, stays one notification: it moves to the other channel, and into or
  out of the fold.
- **Bursts.** `setOnlyAlertOnce(!alert)`: a push with `alert: false` changes the text without sound, vibration or
  heads-up. When it is the conversation's first notification it is muted with `GROUP_ALERT_SUMMARY`: a notification
  in a group that leaves alerting to the group's summary never alerts, and its group has none. That is what
  `setSilent(true)` does on Android 12+, and it also works on 10 and 11.
- **Read elsewhere.** A `{ clear: <conversationId>, upTo }` push takes what was read off that conversation's
  notification, whichever kind it has, without any outcome event ([notifications.md](notifications.md#read-elsewhere-gone-here)).
  `upTo` is where it was read, in the hub's time: the messages at or before it go (a list row's lines, kept with
  their times in its extras, likewise), and the notification is re-posted quietly with the rest, or cancelled when
  nothing newer from anyone but you is left. A notice's notification goes when its `ts` (kept in its extras) is not
  newer. A clear without `upTo` cancels it whole, and a reminder or the quiet hours' summary (`keep`) stays whatever
  was read. Opening the conversation in the app cancels it whole too, and tells the system it is on screen
  (`setLocusContext`).
- **Reply** sends through the hub, then re-posts the notification (recovered from the one showing) with what you wrote
  as its newest message, quietly, and reports the shortcut as used. On failure it says why, with what you typed. It
  names the message it answers, and one the hub held because more came into the chat says "Reply waiting", with what
  you typed ([sync.md](sync.md#the-send-queue)).

**A row of the ranked list** is a plain notification: no shortcut and no `MessagingStyle`, so it stays out of the
Conversations section.

- **One per chat**, tag `list:<conversation id>`, on the `list` channel: the chat's title, its newest line as the
  text, and the push's `lines` in `InboxStyle`, each as "author: body" (only the body in a DM). A single message is
  shown whole, in `BigTextStyle`. The large icon is the chat's picture, round, with the network's badge; the small
  icon is the network's mark. A tap opens the chat. A request waiting on you is a row too (`list:request:<id>`,
  opening it under Requests).
- **One bundle.** Every row is in the group `dither-list`, with a summary ("N chats", the first six rows in the
  bundle's order, `GROUP_ALERT_CHILDREN` so it never sounds). Android shows the group collapsed in its Silent
  section. A tap on the collapsed bundle opens the inbox and takes the bundle off the shade.
- **Sorted.** `setSortKey` is `%04d-%014d` of 1000 − importance × 1000 and 99999999999999 − the newest line's time,
  so text order is the order wanted: the more important first and, between two as important, the newer first. A push
  without `importance` counts as 0.5. Android ranks a group's children by this key.
- **At most 20 rows.** A 21st takes the place of the row that comes last; if it would be last itself it is not shown
  (and reports no `shown`).
- **A chat shows once.** An alert or a Conversation cancels the chat's list row, and a list row cancels the chat's
  conversation notification. A clear takes what was read off whichever is there. The hub sends a push at the highest tier among the
  unread lines it carries, so a list message arriving in a chat whose alert or Conversation is still unread comes as
  that tier and only adds a line to the row that is there.
- **The summary's upkeep.** It is posted with the first row and re-posted on every change, from the rows the system
  says are showing. The system adds and removes them asynchronously, so for five seconds the app goes by its own note
  of what it just posted or cancelled. Cancelling a summary cancels its children, so it goes only once no row is
  left; with one row the system shows that row alone. A tap closes a row without telling the app, so the summary
  keeps its row count in its extras and is put right when the page opens the chat. Android drops updates beyond about
  five a second from one app, so after a burst the summary's own text can be a row behind until the next change; the
  bundle on screen is made of the rows themselves.

**Swiped away.** Every kind reports `dismissed` from its delete intent, a list row also when the whole bundle is
swiped. What the app cancels itself (a clear, a row that left the list, a mark) reports nothing.

**Answers** ([notifications.md](notifications.md#answers)) are buttons, after Reply where there is one. A chat
message's go to `/api/loudness/answers` as `{ messageId, answer, source: "notification" }`:

| Row | Button | `answer` | The row |
|---|---|---|---|
| Sounded | Worth it | `worth` | goes |
| Sounded | Could have waited | `could_wait` | goes |
| Shown now | Louder | `louder` | stays |
| List | Quieter | `quieter` | goes |
| List | Louder | `louder` | stays |

A notice keeps the marks from before, to `/api/messages/<id>/feedback`: *Not urgent* (`{ "alert": false }`) on one
that sounded, *Should have alerted* (`{ "alert": true }`) on a silent one, *Less like this* (`{ "less": true }`) and
*Should have alerted* on a list row. Mail (`mailThreadId`), any tier: *Less like this*, `{ "less": true }` to
`/api/mail/triage/<id>/vote`.

The next release after the scale is a minor one (the channels and the buttons change); its tag is pushed with the
other releases'.

A row that stays loses the button once the hub has taken the mark, so it shows that it went; if the hub could not be
reached the button is still there. A push without `messageId` (a request) has no marks.

Checked on the emulator's Android 15 (2026-11-10), with payloads from adb and a stand-in for the hub that wrote down
what the app sent: five Conversations as five rows in the Conversations section (one bundle without the group keys);
an alert in one of them, with sound and heads-up, the same row on the Alerts channel; a silent update and a silent
new conversation on that channel (no heads-up, no `notification_alert` event in `logcat -b events`); six list rows in
one bundle in the Silent section in the order of their sort keys, the summary listing them in that order; a 21st row
replacing the last; a chat moving between the list and a conversation notification, one row each time; a clear; a
swipe of one row and of the whole bundle; every mark; a reply appended, and one refused.

**Trying it without a hub's push.** A debug build (`src/debug`, never in a release) has a receiver that takes a
payload from adb as if it had come through UnifiedPush (`Push.arrived`: its notification, its copy kept, a test
confirmed): `adb shell am broadcast --include-stopped-packages -a org.libdither.chat.DEBUG_PUSH -n
org.libdither.chat.verify/org.libdither.chat.DebugPushReceiver --es b64 <the payload's JSON in base64>`. `--es hub
<origin>` sets the hub (for Reply and the marks), `--es cancel <tag>` cancels a notification.

### Which servers the hub sends to

The hub only POSTs to push servers it allows, so nobody on the tailnet can point it at another host (a router's
admin page, a cloud metadata address). It allows:

- the browser vendors' relays (Google, Mozilla, Apple, Microsoft), always;
- **ntfy.sh, by default.** It is the ntfy app's own server, so the common case needs no step. The hub encrypts every
  push for the device (RFC 8291) before it leaves, so ntfy.sh learns what a browser vendor's relay learns: when a push
  happens, its size, and a random topic, never the text. Turn it off under Settings → *Push servers* to use only your
  own server; that also removes the devices registered through it;
- servers allowed from the app: one tap on a refused device's server, or typed under *Push servers*. Only https,
  except plain http typed out (a tailnet server). An address that is not on the public internet (loopback,
  RFC 1918, link-local, 100.64/10, fd00::/8, or a name that resolves to one) needs a second confirmation. Allowing and
  removing is accepted only from the app's own page (a same-origin request with an Origin header), not from curl or
  another site. They are kept in the hub's database (`meta.push_servers`);
- origins in `DITHER_PUSH_RELAYS`, comma-separated, still read at start. The app lists them but cannot remove them.

A name that was public when allowed but resolves to a private address later is refused at send time, with the reason
on the device in Settings.

### When it does not arrive

Settings → *Devices with push* shows each device: which server carries it, when that server last took a push, when
a test last arrived on the device, or the last error. Each has *Send a test* and *Remove*.

- *ntfy has no phone listening on this topic yet* (ntfy's 507, code 50701): ntfy refuses UnifiedPush messages for a
  topic no phone is connected to. Right after registering this lasts a second or two, and the app's first test
  retries for that. If it stays, ntfy is not running: open it, and set its battery use to Unrestricted.
- *took the test, but the device has not said it arrived*: the server has it but ntfy did not deliver it. Same fix.
- *ntfy did not answer*: ntfy has never been opened. The app shows *Open ntfy*.

The older `DITHER_NTFY_URL` topic still works for anyone who set it: the hub also posts every push there as plain
text that the ntfy server can read, and Settings lists it with a test. It is no longer part of setting up push.

### Coming back to the app

Switching away and back, or a network blip, no longer reloads anything: the app resumes from its place in the hub's
change journal with one small request (about a kilobyte when little changed, against about 800 KB before), checks a
socket that may have died while the phone slept with a heartbeat, and says nothing unless the hub stays out of reach
for a few seconds. Why the app does not keep a socket open in the background instead, and the measurements:
[sync.md](sync.md).

### Why not a socket of our own

A persistent socket held by a foreground service would also work. But the hub drops idle sockets after 120 s, and
mobile NATs often after less, so it needs a keepalive about every minute. Each keepalive wakes the cellular radio,
which then stays up for its tail time. Published LTE measurements put one such wakeup at a few joules, up to about
10 J (about 1 W for an 11 s tail, Huang et al., MobiSys 2012). Carrier fast dormancy cuts that, sometimes by a lot.
At one to three wakeups a minute that is roughly 1-40 kJ a day, so 0.3-10 Wh against a 15-19 Wh phone battery,
plus a permanent notification. I did not measure battery here, so take that range as order of magnitude only. A
distributor pays this once for every app on the phone. With a Google-flavoured distributor (ntfy from Play with
ntfy.sh, or an FCM-backed one), the phone already pays it for Google Play services, so it costs nothing extra.

## What a start looks like

One sphere from tap to content (`ui/Loader.tsx`): the logo's dithered sphere, lit from a light that goes round it,
redrawn through the same 4×4 Bayer matrix at about 12 frames a second.

- **Android 12+ splash**: `res/drawable/splash_orb.xml`, an animated vector of the loader's first frame whose cells
  fade in by Bayer level (600 ms), 88 dp and centred. It is generated from the loader: `bun scripts/splash-orb.ts`
  after changing `frame` there. `MainActivity.holdSplash` keeps it up until the WebView reports its first visible
  frame (`onPageCommitVisible`), 1.5 s at most, and removes it without an exit animation.
- **The page before its script**: `index.html` draws the same first frame, still, in the same place.
- **The app**: the boot screen takes over from that frame and turns the sphere, with "Connecting to your hub…" or
  "Loading your conversations…" under it, and a hint after 8 s.
- **Switching views**: messages and lists show grey shapes as Discord does (a name, one to three lines, now and then
  a picture), with one shimmer crossing all of them; they wait 180 ms, so a quick load shows nothing.

## Starting fast

These live in the web app, so the PWA gets them too.

1. **The shell comes from the service worker's cache** (`public/sw.js`): navigations are answered with this build's
   cached `index.html`, so opening the app never waits on the network. The update flow is unchanged: `pwa.ts` also
   asks for a new worker 3 s after every start, the new build waits for the reload bar or for the app to be out of
   sight, and after the reload the new worker serves its own cache. A new deploy shows up one start later (or at
   the bar), not on the first start after it.

   The worker keeps the whole build: every file vite writes but the source maps, lazy chunks and workers included
   (about 4.3 MB, 1.3 MB as zstd, of which the PDF viewer's worker is 1.3 MB, 0.4 MB as zstd), and the icons `index.html` names
   (`vite.config.ts` lists them in `sw.js`). A new build's worker copies each hashed file (`/assets/`) that the
   old build's cache holds instead of downloading it, since a hashed name never changes content, so a deploy
   downloads only the files that changed; `index.html`, the manifest and the icons are fetched fresh. The old cache
   goes only once the new one is whole: an install that cannot get a file fails, and the build in use stays. Before
   2026-11-17 it kept only the entry chunk, what it imports itself and the CSS, and old caches went at each deploy, so
   the first start after one with the hub out of reach and the HTTP cache cold (a WebView's is small) stayed on the
   logo for good. `scripts/check-offline.ts` checks this in CI ([testing.md](testing.md#startup)).

   If the app's script or one it imports still cannot load, `index.html` does not leave the logo up for good: it
   asks the hub (`/api/health`) again when the network comes back and after 1 s, then twice as long each time up to
   30 s (the wait carries over reloads, in `sessionStorage`), and reloads once it answers (its own `{ok: true}`, not
   a Wi-Fi sign-in page), letting a build that waits for the page in first, since nothing in it ran. After a few
   reloads the hub is there but a file it lists is not (a bad build): a line under the logo says part of the app
   didn't load, and it asks every 5 minutes instead.
2. **A snapshot of the last screen** (`src/snapshot.ts`), in IndexedDB. It holds the bootstrap (every sidebar list,
   unread counts and last messages) and the inbox, and beside it the newest 40 messages of the 60 conversations opened
   or fetched ahead most recently, a record each with their authors, reactors and quoted messages
   ([sync.md](sync.md#kept-pages), [perf.md](perf.md#fetching-ahead-and-kept-pages-2026-11-11)).
   It is read before the network and painted at once, with what pushes brought since laid over it (the app keeps
   each push's copy of its message, `Arrived.kt`; [notifications.md](notifications.md#a-copy-in-the-push)). It also keeps its place in the hub's change journal, so the app then asks only for what changed since
   ([sync.md](sync.md)); a full bootstrap replaces it only when the hub cannot say. A kept conversation catches up
   the same way when opened. It is saved when the bootstrap arrives (the hub's own text, without
   serializing it again; at once when the device keeps none, so a device opened once can start offline) and again
   whenever the app goes out of sight. A save waits until things settle (1.5 s after the last change), but never more
   than 5 s after the first change it holds, however often things change (a run of chats fetched ahead). When the app
   goes out of sight or is closed, the pages and the snapshot are written side by side and committed at once, so the
   write is on its way before the page can go. While the app stays open, the save after
   a conversation opens writes only the rest (a record of its own) and the pages that changed, and keeps the stored
   bootstrap, unless that is
   over ten minutes old: writing the bootstrap again cost a phone a few hundred milliseconds each time. Caps: 12 MB of bootstrap (above that it is
   not kept, because reading it back would cost about what the network does), 1.5 MB for the rest and 3 million
   characters for the kept pages. Only a build
   with the same `packages/protocol` reads it back (the vite config hashes the protocol into
   `__SNAPSHOT_SCHEMA__`), and one that fails to render is dropped and the page reloads from the hub. Nothing in it
   is ever sent anywhere.
3. **Compression at the hub** (`packages/hub/src/compress.ts`): zstd, or gzip for clients without it, on every text
   response of 1 KB or more. A real bootstrap is 4.9 MB of JSON: 758 KB as zstd in 9 ms, 901 KB as gzip in 19 ms.
   Caddy passes it through untouched. The web build's own files are packed once with zstd at level 19 when the hub
   starts and kept, a sixth smaller than at level 3 ([docs/perf.md](perf.md#the-web-build-on-the-wire-2026-11-24)).
4. **Cheaper renders**. On a large hub every `rev` change re-rendered the whole app. Three fixes:
   - `directsOf()` scanned all 5,200 conversations once for each of 430 people (`people()`). It is now one indexed
     pass.
   - The date formatters are built once instead of on every call.
   - Off-screen rows of the phone's conversation list skip layout and paint (`content-visibility`, as messages
     already do). On a phone it renders about 400 rows, 7,000 nodes.

   On the emulator, a reload's main-thread layout and paint went from 1,109 ms to 201 ms, its JavaScript from 1.9 s
   to 1.3 s, and each later re-render from about 120 ms to about 60 ms.
5. **Pictures from the service worker's cache** (`dither-media-v1`, [files.md](files.md#serving)): avatars,
   emoji and image attachments, kept across deploys and starts. The WebView uses its HTTP cache and the service
   worker with its default settings (no `setCacheMode` here), but a WebView's HTTP cache is one fixed-size cache for
   everything the app loads, much smaller than Chrome's; Cache Storage is held to the origin's storage quota instead.
6. **Ordering**: the live socket opens first, a warm-up request opens the HTTP connection the bootstrap will use at
   the same time, and an open conversation asks for its page only once the socket is open, so nothing falls between
   the two and the bootstrap does not refetch it.

## Measurements

The hub's real data (5,210 conversations, 2,572 identities, 1,208 spaces; a 4.9 MB bootstrap) served through a
read-only proxy that refuses every write and drops what the page sends on the socket. A TCP shaper in front of it
stands in for a phone on the tailnet: 80 ms round trip, 20 Mbit/s down, 10 up, and 2 extra round trips per new
connection for TCP and TLS. The app runs on the emulator (`dither35`: Android 15, x86_64, WebView 124), release
build. "Before" is the deployed web build with no hub compression; "after" is this work. Medians of 5 runs (warm: 4).

**Native app, time to content** (the first frame with the app's layout in it, measured the same way for both
builds by a script the app injects):

| | Before | After | After, without hub compression |
|---|---|---|---|
| Cold start, in the page (from navigation start) | 4,491 ms | **1,029 ms** | 995 ms |
| Cold start, from process start (emulator, see below) | 4,663 ms | 3,942 ms | 4,023 ms |
| Warm start (process alive, new activity), from `onCreate` | 3,765 ms | **993 ms** | |
| Hot start (`am start -W` TotalTime; content already there) | 69 ms | 58 ms | 60 ms |
| First frame, cold (`am start -W` TotalTime) | 516 ms | 474 ms | 469 ms |
| Fresh data from the hub, cold start, in the page | 4,491 ms (same as content) | 4,173 ms | 5,864 ms |
| Fresh data, warm start, in the page | | 1,556 ms | |
| First launch after install (no cache, no snapshot), in the page | 4,389 ms | 1,778 ms | 3,870 ms |

The gap between "in the page" and "from process start" on a cold start after the change is an emulator artefact.
Its GPU is SwiftShader (software), and an atrace of that start shows WebView's GPU thread spending 2.1 s in
`glCreateProgram` and 1.2 s in `rcCreateSyncKHR`: shader compilation through the emulator's GL pipe, on the first
frame with content. The old build pays it while its loading screen is still up, which hides it. On a phone's GPU
this takes milliseconds, and Chromium caches compiled shaders. Without that stall, a cold start comes to about
1.3 s: the page starts about 250 ms after the process. The same main-thread stall delays the hub's fresh data on
cold starts; warm starts, which have no stall, show it at 1.6 s. The host GPU could not be used headless here.

Where the remaining cold second goes, from the page's own timing on the emulator: about 220 ms for the service
worker to start and answer `index.html` from a cold Cache Storage, about 100 ms for the scripts, 40-80 ms to read
the snapshot, and the rest to render about 10,000 nodes. A lighter first render (rendering only the visible part
of the conversation list) is the next step.

**The PWA in a browser** (headless Chromium on the host, same proxy and shaper, phone viewport, CPU slowed 4×; the
emulator image has no browser):

| | Before | After |
|---|---|---|
| First visit | 4,796 ms | 2,503 ms |
| Relaunch (service worker installed), median of 5 | 4,251 ms | **1,276 ms** |
| Fresh data from the hub on relaunch | (same as content) | 2,933 ms |

**Bootstrap against the live hub** (timing and size only):

| | |
|---|---|
| Size | 4.88-4.92 MB of JSON (the inbox: 232 KB) |
| Hub alone, on loopback | 72-100 ms to build and send |
| Through Caddy over HTTPS, from the same machine | 100-180 ms |
| zstd level 3 / gzip level 4 / gzip level 6 | 758 KB in 9 ms / 901 KB in 19 ms / 873 KB in 27 ms |
| Through the shaper (80 ms, 20 Mbit/s): uncompressed / zstd | 2.3 s / 0.83 s |
| Parse in the emulator's WebView | 32-36 ms |
| The app on the deployed build over real HTTPS, no shaping (same machine) | 2,541 ms to content, in the page |

## History uploads

A backup or export is often gigabytes, and a WebView stops uploading soon after the app leaves the screen. So in the
app the History section's buttons (account pane) don't use the page's file input. They ask the app over the bridge
(`upload.pick`), and the app does the upload itself (`Uploads.kt`):

1. The system picker: `ACTION_OPEN_DOCUMENT` for files, `ACTION_OPEN_DOCUMENT_TREE` for a whole folder, such as the
   one Molly backs up to. The app keeps read access to what was picked (`takePersistableUriPermission`), so it can
   read it again after a restart. It gives the access back when the job ends.
2. `UploadService` starts at once, while the app is still in front, because Android 12+ refuses to start a foreground
   service from the background. It lists the files (a folder recursively, with paths that start at the folder, as a
   browser's folder pick gives them). Then it carries on the hub's unfinished upload of the same paths and sizes for
   that account, or makes a new one (`POST /api/imports`).
3. Three senders `PUT` 8 MB pieces at their offsets, each file from what the hub already has of it. A `409` with
   `received` (a piece cut off midway) moves to the hub's count. A lost connection is tried again, with waits growing
   to a minute, twelve times in a row before it pauses. A partial wake lock and a Wi-Fi lock are held while it runs.
4. An ongoing notification shows the progress and has **Pause**. How it ended (uploaded, paused, stopped) is posted
   under a separate id, because Android re-posts a foreground service's last notification after it leaves the
   foreground, which would overwrite an outcome posted under the same id.

The job is kept in `files/upload.json`. Pause, **Carry on** and **Stop** are on the page as well (Stop forgets the job
on the phone; what reached the hub stays there). If Android stops the app, or Android 15's six-hour daily allowance for
`dataSync` runs out (`onTimeout`), the next time the app is opened the upload goes on from the hub's count.

Checked on the emulator (Android 15) against a demo hub, with the app on the home screen throughout: 400 MB at full
speed. Through a 400 KB/s proxy: Pause from the notification and Carry on from the page, which resumed at the hub's
16 MB. A force-stop partway through: the upload sat at 8 MB, then finished after the app was opened for 3 s. A folder
of 8 files in nested folders, one of them empty. Every file arrived byte-identical. Older app builds don't announce
`upload` in `opens`, so the page keeps its own upload for them.

## Building and installing

Needs JDK 21 and the Android SDK (platform `android-36.1`, build-tools `36.0.0`). The Gradle wrapper fetches the
rest.

```sh
cd apps/android
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
./gradlew assembleRelease          # app/build/outputs/apk/release/app-release.apk, ~250 KB
```

**Releases.** Pushing a tag `android-v<version>` makes `.github/workflows/android.yml` build a signed APK and publish
it as a GitHub release, so Obtainium (or any updater that follows GitHub releases) can install and update it. The
release key is kept outside the repo; CI reads it from the repository secrets `ANDROID_KEYSTORE_B64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Losing it means the next APK will not
install over the last one.

A local build signs with that key too when `DITHER_KEYSTORE`, `DITHER_KEYSTORE_PASSWORD`, `DITHER_KEY_ALIAS` and
`DITHER_KEY_PASSWORD` are set. Without them it uses the machine's debug key, and Android will refuse to install it over
a release build (or a build from another machine): uninstall first in that case.

On the phone: enable USB debugging and `adb install app/build/outputs/apk/release/app-release.apk`. Or copy the APK
to the phone and open it, allowing installs from that app. Then open *dither*, type your hub's address (the one you
open in a browser on the tailnet, with `https://`), and *Connect*.

The hub needs `https://` for calls, push setup and the offline start, because a WebView gives microphones and service
workers to secure contexts only. A plain `http://100.x.y.z:8460` loads but gets neither. Settings → *Use another hub*
changes the address later.

For debugging, `./gradlew assembleDebug` builds an 8.8 MB debuggable APK, as its own app
(`org.libdither.chat.verify`), so it installs beside a release build without touching it. Its WebView shows up in
`chrome://inspect`, and it logs the page's console under the tag `DitherWeb`. Both builds log start-up timings under
`DitherStartup`, and the activity reports itself fully drawn when content shows (`ActivityTaskManager: Fully drawn`).

## Testing on an emulator

`scripts/verify-android.ts` runs every emulator test of the app, as CI's `android-device` workflow does
([testing.md](testing.md#android-on-an-emulator)): the calls test below against a demo hub of its own (its rings
through the emulator's UnifiedPush distributor, such as ntfy, or through the test's own where it has none), then
`scripts/verify-android-media.ts` (playing in the background, [above](#playing-in-the-background)) against the same
hub, then `scripts/verify-android-arrived.ts`, a push's copy of its message (docs/notifications.md, "A copy in the push"): kept
with the app closed and the hub stopped, shown by an offline start from the notification's intent, a second push shown
by the open page, and both gone with the app's records once the hub is back.

```sh
emulator -avd <avd> -port 5584 -read-only -no-snapshot -no-window -no-audio \
  -no-boot-anim -gpu swiftshader_indirect          # wait for `getprop sys.boot_completed`
bun run web:build
(cd apps/android && ./gradlew :app:assembleDebug :uitest:assembleDebug :uitest:assembleDebugAndroidTest :testpush:assembleDebug)
bun scripts/verify-android.ts --serial emulator-5584 [--shots <dir>]
```

The debug build is its own package (`org.libdither.chat.verify`), so a release build on the same emulator is never
touched; each test clears its data first. The app's own logic that needs no device has unit tests on the JVM:
`./gradlew :app:testDebugUnitTest`.

## Testing calls

`scripts/verify-android-call.ts` runs calls in the app itself on an emulator: its WebView, its call service and
Android's own permission prompts, against a demo hub whose call room plays the far end. Each run clears the debug
build's data, so every call is a first call on a fresh install.

```sh
emulator -avd <avd> -port 5584 -read-only -no-snapshot -no-window -no-audio \
  -no-boot-anim -gpu swiftshader_indirect          # wait for `getprop sys.boot_completed`
bun packages/hub/src/main.ts --demo --data <temp dir> --port <port> --web packages/web/dist
(cd apps/android && ./gradlew assembleDebug)
bun scripts/verify-android-call.ts http://127.0.0.1:<port> --serial emulator-5584
```

It checks that the first call asks for the microphone, then for notifications once live, without the app restarting;
that the call goes live and is heard, with the service in the foreground as `phoneCall` and `microphone`; that it
holds 12 s with the app away and the screen off; that the notification has its buttons and leaving stops the service
and the far end's call; that a refused microphone still gives a live call, listening only, with the service as
`phoneCall` alone; and that logcat has no crash or ANR of the app and no crash report waits in it.

The prompts are answered without tapping: uiautomator cannot read a screen while the call's page animates (it waits
for an idle screen that never comes). A prompt is seen in `dumpsys activity` (`GrantPermissionsActivity` on top), what
it asks for is the app's own `asking for` log line (tag `DitherStartup`), "Allow" is `pm grant` while the prompt is up,
which closes it by itself, and "Don't allow" is Back. Never Back after a grant: on a slow machine it lands after the
prompt has gone, on the app, whose page goes back a page and reloads, ending the call. `--account` and
`--conversation` point it at another account that makes calls, on a hub with its own far end (a lab hub), so the same
run covers another network's call body.

Then the rings: the demo account is rung (the demo's `ring` action), and the run checks the ring notification
(channel, call style, Answer and Decline, insistent, full-screen) and presses its buttons: Decline is declined on the
network and the ring goes; a ring the caller gives up goes as missed; Answer with the app in the background brings it
up in the call; and Answer after Android killed the app (as for memory) starts it and joins. In those calls it also
presses the call notification's Mute and Hang up and checks the far end sees them. `--only calls|rings` runs one half.

Rings come through real push. An emulator with a distributor installed (ntfy, signed in to its server) uses it. One
without gets `apps/android/testpush` (`./gradlew :testpush:assembleDebug`; `--testpush <apk>`), a distributor with no
server of its own that the run installs and takes off again: it answers the app's connector as ntfy's app would, and
its server is in the test (`scripts/android-testpush.ts`), allowed on the hub from the app's page as a typed server
on a private address would be. The hub's encrypted request goes to the device over adb, and the connector decrypts
it, so only ntfy and its server are stood in for.

The notification's buttons are pressed through `apps/android/uitest`, a small test app that drives the shade with
UiAutomator with its idle wait turned off (`Shade#press`, run with `am instrument`): uiautomator's own `dump` waits
for an idle screen, and a call's notification redraws its timer every second. It instruments itself, not the app:
`am instrument` restarts the package it targets, which would end the call. Build it with
`./gradlew :uitest:assembleDebug :uitest:assembleDebugAndroidTest`; the run installs it (`--uitest <outputs dir>`).

`scripts/verify-call-pair.ts` calls between two devices on a hub with real accounts (a lab hub), each a computer
(headless Chromium) or the emulator: the caller presses Call, the other rings (the ring card, or the phone's
notification, answered from the shade) or joins the voice channel, and it checks both are in, hear each other, the
ring stopped, and hanging up (from the shade on the phone) ends the call on the hub.

```sh
bun scripts/verify-call-pair.ts <hub> --conversation <id> --caller <account>@phone --callee <account>@computer \
  [--mode bridge|direct] [--wav-callee speech.wav] --serial emulator-5584
```

When the two accounts see the call in different chats (two Signal accounts, each with its own DM to the other), name
the callee's with `--callee-conversation`. On Signal the caller is in the call only once it is answered.

The emulator reaches the hub through `adb reverse`, which carries TCP only: its call's media needs the hub's TURN
relay (on an address the emulator can reach, such as the computer's LAN address), since the far end offers only
`.local` host addresses, which the emulator cannot resolve. A phone hears through its WebView, which reports no
loudness without an audio device, so on the phone hearing is the far end's audio arriving.

## What is left

- The call UI has no audio-route picker yet; the notification has one button that cycles. `android.audio` and
  `android.setAudioRoute()` in `src/android.ts` are there for it.
- Calls in the app run end to end on the emulator against the demo call room (bridge mode, [Testing
  calls](#testing-calls)), rings included; direct mode and Discord calls between the app and a computer are checked by
  hand with `verify-call-pair.ts` on a lab hub. Audio routing has only been seen on the emulator, which offers a
  speaker and nothing else.
- Not tried on a physical phone.
- Notifications were checked on Android 15 only: not on 10 and 11, and not on Android 16, whose rules for bundling
  an app's notifications by itself may differ (a group without a summary is how a conversation gets a row of its own
  here; if a later Android bundles those, the Conversations show as one bundle inside their section). A conversation
  archived or left keeps its shortcut until Android drops it (`removeLongLivedShortcuts` is not called yet), and
  there are no bubbles.
- Changing the hub address leaves the old hub's push registration in place. Remove it in that hub's settings first.
- The first render still builds the whole conversation list; rendering only what is visible would cut the remaining
  cold-start time further.
