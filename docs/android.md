# The Android app

`apps/android` is a small native shell around the same web app the hub serves. It exists for what a browser tab
does badly on Android: starting fast, asking for permissions, keeping a call alive with the screen off, and push.
The release APK is about 250 KB.

## Design

One `Activity` with one `WebView` that loads the hub's own origin (`https://chat.example.net/`). Same origin means the
page is exactly what a browser gets: the same service worker, storage, `Origin` checks and API, with no CORS and no
login. The hub's address is typed on first run and kept in the app's preferences; nothing about it is built in.

Around the WebView:

| Need | How |
|---|---|
| Microphone, camera | `WebChromeClient.onPermissionRequest`, only for the hub's origin, mapped to `RECORD_AUDIO` / `CAMERA` runtime permissions, asked when the page asks |
| Attachments | `onShowFileChooser` with the system picker, several files where the page allows it |
| Links | Anything that is not the app's own page (other sites, the hub's `/media/` files, downloads) opens in the system browser |
| Back | Walks the page's history: its routes, and the sheets and panels that push entries (`phone.ts`). At the start the app goes to the background and stays alive, so the next open is instant |
| Launch | Theme, splash and WebView background are the page's own colour (`#14151b`, or the light theme's after the page reports it), so there is no white flash |
| System bars | Edge to edge; the bars and keyboard are padding around the WebView |
| Bridge | `WebViewCompat.addWebMessageListener` named `DitherAndroid`, with an allowed-origin rule of the hub's origin only, so no other page, frame or redirect target can post to it. Page side: `packages/web/src/android.ts` |
| Calls | `CallService`: a `microphone` foreground service while the page says a call is live, with an ongoing notification (Hang up, Mute, Audio route) |
| Audio route | `AudioManager.setCommunicationDevice` (Android 12+: speaker, earpiece, Bluetooth, wired, USB); speaker or earpiece before that. The notification's Audio button cycles; `android.setAudioRoute()` is there for the call UI. On the earpiece a proximity wake lock turns the screen off at the ear |
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
Reply sends through the hub. A message notification has the network's mark as its small icon and the sender's picture,
with the network's badge, as its large icon; which devices get it at all is up to each device's rules ([devices.md](devices.md)).

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

## Starting fast

These live in the web app, so the PWA gets them too.

1. **The shell comes from the service worker's cache** (`public/sw.js`): navigations are answered with this build's
   cached `index.html`, so opening the app never waits on the network. The update flow is unchanged: `pwa.ts` also
   asks for a new worker 3 s after every start, the new build waits for the reload bar or for the app to be out of
   sight, and after the reload the new worker serves its own cache. A new deploy shows up one start later (or at
   the bar), not on the first start after it.
2. **A snapshot of the last screen** (`src/snapshot.ts`), in IndexedDB. It holds the bootstrap (every sidebar list,
   unread counts and last messages), the inbox, and the newest 40 messages of the 12 most recently opened
   conversations, with their authors, reactors and quoted messages. It is read before the network and painted at
   once. It also keeps its place in the hub's change journal, so the app then asks only for what changed since
   ([sync.md](sync.md)); a full bootstrap replaces it only when the hub cannot say. A kept conversation catches up
   the same way when opened. It is saved when the bootstrap arrives (the hub's own text, without
   serializing it again) and again whenever the app goes out of sight. Caps: 12 MB of bootstrap (above that it is
   not kept, because reading it back would cost about what the network does) and 1.5 MB for the rest. Only a build
   with the same `packages/protocol` reads it back (the vite config hashes the protocol into
   `__SNAPSHOT_SCHEMA__`), and one that fails to render is dropped and the page reloads from the hub. Nothing in it
   is ever sent anywhere.
3. **Compression at the hub** (`packages/hub/src/compress.ts`): zstd, or gzip for clients without it, on every text
   response of 1 KB or more. A real bootstrap is 4.9 MB of JSON: 758 KB as zstd in 9 ms, 901 KB as gzip in 19 ms.
   Caddy passes it through untouched.
4. **Cheaper renders**. On a large hub every `rev` change re-rendered the whole app. Three fixes:
   - `directsOf()` scanned all 5,200 conversations once for each of 430 people (`people()`). It is now one indexed
     pass.
   - The date formatters are built once instead of on every call.
   - Off-screen rows of the phone's conversation list skip layout and paint (`content-visibility`, as messages
     already do). On a phone it renders about 400 rows, 7,000 nodes.

   On the emulator, a reload's main-thread layout and paint went from 1,109 ms to 201 ms, its JavaScript from 1.9 s
   to 1.3 s, and each later re-render from about 120 ms to about 60 ms.
5. **Ordering**: the live socket opens first, a warm-up request opens the HTTP connection the bootstrap will use at
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

For debugging, `./gradlew assembleDebug` builds an 8.8 MB debuggable APK. Its WebView shows up in
`chrome://inspect`, and it logs the page's console under the tag `DitherWeb`. Both builds log start-up timings under
`DitherStartup`, and the activity reports itself fully drawn when content shows (`ActivityTaskManager: Fully drawn`).

## What is left

- The call UI has no audio-route picker yet; the notification has one button that cycles. `android.audio` and
  `android.setAudioRoute()` in `src/android.ts` are there for it.
- A real call (bridge or direct mode) has not been run inside the app. The pieces are verified one by one: the
  microphone permission flow, WebRTC with the screen off, the foreground service, the notification actions reaching
  the page, the WebRTC features direct mode uses. Audio routing has only been seen on the emulator, which offers a
  speaker and nothing else.
- Not tried on a physical phone.
- Changing the hub address leaves the old hub's push registration in place. Remove it in that hub's settings first.
- The first render still builds the whole conversation list; rendering only what is visible would cut the remaining
  cold-start time further.
