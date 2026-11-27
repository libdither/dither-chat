# Calls

Voice and video calls, in two modes you can switch between in Settings → Calls. Both keep the account's login token on
the hub and both make the network see the hub's address, never the device's.

Bridge mode is the same for every network: the account's own client, in its sandbox, is in the call, and the device
talks to it over one WebRTC connection whose slots are fixed (`BRIDGE_MIDS`: microphone in and the call's mix out,
camera, screen, screen audio, and four slots of others' video). Nothing in the hub or the web app knows how the client
gets its media; that is the adapter's. Discord's client is the first (below); any adapter that advertises `calls` and
answers the `call` command's ops the same way gets the same call view, ringing, video and sounds. Direct mode is the
device speaking the network's own voice protocol, which only exists for Discord: asked for elsewhere, the hub carries
the call in bridge mode and its `joined` says so, and the device follows. In a call that is not Discord's, the device
plays its own chimes rather than Discord's recordings.

| | Bridge (default) | Direct |
|---|---|---|
| Who joins the call | the account's own Discord client, in its sandbox | this device |
| Media path | Discord ↔ sandbox Chromium ↔ WebRTC ↔ device | Discord ↔ TURN on the hub ↔ device |
| Encryption (DAVE) | Discord's client, in the sandbox | Discord's libdave, in an opaque-origin worker on the device |
| What the device gets from the account | nothing | one voice-server token for this one connection |
| Discord code on the device | none | libdave (extracted by the hub, never in this repo) |
| Breaks when Discord changes | the in-page join and audio tap | the in-page join, the voice protocol, or libdave's API |

## How a call starts

1. The device opens `/api/call` and sends `join` with the account, the conversation and the mode. It does so while the
   browser is still asking for the microphone, so the account starts joining at once; a device with no microphone
   joins listening only, muted.
2. The hub asks the account's adapter to join. Before its client selects the channel, the hook sets the client's mute
   and deafen to the device's (the client keeps its own across sessions, so one left muted would have joined muted and
   never sent the device's microphone), and a client whose audio was never enabled (no microphone was ever granted in
   its sandbox) enables it, which asks getUserMedia and so gets the device's microphone. The adapter's in-page hook calls Discord's own
   `selectVoiceChannel`, the same action its voice channel button runs, so the gateway's voice state, mute flags
   and participant list stay the client's.
3. Bridge: the hook hands the client the device's microphone (a Web Audio track fed by the bridge's peer connection)
   when it asks for one (from `navigator.mediaDevices.getUserMedia` both on the prototype and on the page's own wrapper,
   an own property that holds the original it took at load and that a patch of the prototype alone never reached), taps the remote audio of the client's own peer connection, mixes it, and sends the mix
   back over the bridge. The device offers; the sandbox answers. Signalling goes through the hub.
4. Direct: one Dispatcher interceptor catches `VOICE_SERVER_UPDATE` and swallows it, so the page's own voice
   connection waits for an endpoint forever and never connects. The endpoint and token go to the device, which
   opens the voice socket through the hub (`/api/call/<id>/voice`, forwarded only to `*.discord.media`) and its
   media through the hub's TURN relay (`iceTransportPolicy: relay`).

What every network's call body has to take (any adapter that answers the `call` command): a `leave` can come while
its `join` is still waiting (the device's socket closed: its app crashed, the network dropped, the person hung up at
once), and the join then starts nothing more (no ring, no channel joined), lets go of what it opened, and fails. And on
the device, the call starts before the microphone is allowed: the Android app's call service must not need it to start
(docs/android.md, "The call service"). `scripts/verify-android-call.ts` runs the app's side against any account that
makes calls (`--account`, `--conversation`), on a hub with a far end of its own.

Participants and mute state come from the client's own stores in both modes. Speaking comes from the client in
bridge mode and from the voice server's SPEAKING messages in direct mode. The call's state also carries the client's
own state (`self`: connected, muted, deafened, camera, streaming, the streams it watches): in bridge mode the dock says
"Connecting to Discord…" until the client's own voice connection is up, since only then do others hear the device.

Each step of joining is timed from the click (`ActiveCall.timing`: socket, mic, joined, live, connected, firstAudio;
the dock's `data-call-timing`). Between the two test accounts on one machine (2026-11-14, bridge): the call socket at
0.12 s, joined 0.28 s, the bridge live 0.31 s, the call heard 0.73 s, Discord's voice connection up 0.97 s; direct:
connected 0.22 s, heard 0.63 s.

## Discord's voice protocol, as the web client speaks it

What the direct client implements (`packages/web/src/voice/`), from a study of the public web client's behaviour:

- Voice gateway `wss://<endpoint>/?v=9`, JSON `{op, d}` frames plus binary frames for DAVE
  (server → client `[seq u16][op u8][payload]`, client → server `[op u8][payload]`).
  Identify (0) with `max_dave_protocol_version`; heartbeat (3) `{t, seq_ack}` at most every 5 s;
  select protocol (1) with `protocol: "webrtc"` and the local offer filtered to its ICE, extension, fingerprint
  and codec lines; session description (4) carries the server's single transport description and
  `dave_protocol_version`; speaking (5) maps users to SSRCs; clients connect/disconnect (11/13).
- The server is ICE-lite and gets no candidates. The client builds the remote answer itself from the server's
  description: every section copies the server transport, `a=setup:passive`, directions mirrored, and each remote
  user's audio gets a receive-only section naming its SSRC. Renegotiation after that never reaches the server.
- DAVE ops 21–31 drive an MLS group (libdave `Session`); the key ratchets go to an `Encryptor` and one
  `Decryptor` per user, which an `RTCRtpScriptTransform` runs on every frame. Our own key is installed on the
  first commit or welcome, or when a prepared transition executes.
- A client alone in a channel has no group and therefore no key: Discord's client sends no audio until someone
  joins, and neither does ours. A channel that requires DAVE closes a client that offers none with 4017.

## The DAVE library (direct mode only)

`scripts/dave/update.ts` fetches the public web client anonymously, finds the libdave glue and wasm by stable anchors
(export names and emscripten strings, never module ids or file names), wraps them as an ES module, runs a smoke test
that builds a real MLS group and round-trips encrypted frames, and only then promotes them. It keeps the last good
pair and records a fingerprint of the voice protocol so a breaking change is reported even when libdave itself is
unchanged. See `scripts/dave/README.md`.

The output lives in `DITHER_DAVE_DIR` (default `<data>/dave`) and must never be committed. The hub serves it at
`/voice/dave/<id>/libdave.mjs`. The device imports it inside a worker created from a `data:` URL, whose origin is
opaque: it cannot read the app's storage or make credentialed requests to the hub. So the library's two files answer
without a session (docs/login.md): it is Discord's public code, named by its hash. Until 2026-11-17 they did not, the
worker got a 401, and direct mode joined offering no DAVE, which a channel that requires it closes with 4017.

Run it on a timer:

```ini
# ~/.config/systemd/user/dither-dave.service
[Service]
Type=oneshot
WorkingDirectory=%h/Projects/dither-chat
ExecStart=/path/to/bun scripts/dave/update.ts --root %h/.local/share/dither-chat/dave

# ~/.config/systemd/user/dither-dave.timer
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
```

## The TURN relay (direct mode only)

coturn as a user service, listening on the tailnet address and relaying from the LAN address. It refuses to relay
into private, tailnet or loopback ranges, so a device cannot use it to reach anything but the internet. The hub mints
credentials per call from the shared secret (coturn's `use-auth-secret`).

```sh
nix profile add nixpkgs#coturn
# config: ~/.config/dither-chat/turnserver.conf (0600), unit: ~/.config/systemd/user/dither-turn.service
```

Hub environment: `DITHER_TURN_URLS=turn:<tailnet ip>:3478?transport=udp,turn:<tailnet ip>:3478?transport=tcp` and
`DITHER_TURN_SECRET=<static-auth-secret>`. Without them direct mode connects to Discord from the device's own address.

## Testing

```sh
bun scripts/verify-call.ts <hub> <voice conversation id> bridge|direct [seconds] [speech.wav]
bun scripts/measure-call.ts <hub> <conversation> <account> <data dir> [seconds] [speech.wav] [bridge,direct]
```

Only join a voice channel the test account owns. Media only flows with a second participant in the channel.

### Demo calls

A demo hub's Discord accounts have calls too (`calls`, `callVideo`, `watchStreams`). The far end of every demo call is
the **call room** (`packages/hub/src/demo-callroom.html`, served at `/demo/callroom.html` on demo hubs only, talking
to the hub over `/api/demo/callroom`; `democalls.ts`): open it in any browser tab and it plays the account's client for
every call at once. It answers each device's bridge offer, mixes everyone's microphone for everyone else, carries
cameras and shared screens between devices on the bridge's slots, and brings a bot (Lev) who talks, has a camera on and
is live. Without it, a join is refused in words.

```sh
bun packages/hub/src/main.ts --demo --data /tmp/x --port 8579 --web packages/web/dist
bun scripts/verify-calls-demo.ts http://127.0.0.1:8579
```

The script runs two devices as the two demo Discord accounts and the room, each in headless Chromium with fake
devices, and checks joining (and how fast), hearing and being heard, the bot's speaking ring (round, with words a screen
reader hears), the join, leave, mute and camera sounds, the mic button's note when talking while muted (moving
nothing else), mute
reaching the far end and the other device, the camera both ways, sharing a screen and watching it from the other
device, watching the bot's Go Live, leaving, and a device with no microphone joining to listen. A last device, at
phone size, checks the call bar (below): the dock on the call's own chat and the bar elsewhere, in one place at the top
with nothing under it, no Leave on it and 44 px buttons, the row's mark, mute from the bar, a tap opening the sheet in
place, back folding it, Go to chat; then at computer size with the list hidden, the bar under the page, the dock over it
on a tap, Escape folding it, and leaving from there. Last, a ring on the main account's DM shows the ring card and
rings aloud on the page in front, stops when the caller gives up, and with the chat muted shows the card quietly.

The libdither server also has a stage, `office-hours` (`demostage.ts`), with the topic "Office hours: routing
questions": the room's bot and two invented people speaking (their speaking takes turns), an audience of twenty
invented people, two of them with a hand up (each with when it went up), and the main demo account a moderator there.
A speaker's camera and Go Live show (the bot's camera is on); a listener's never do. The call room carries the devices'
audio and video as for any call; the demo stage lays the
roles and ranks over the room's state, tells each device what it may do (`can`, `canOn`), and answers the stage
actions by the same rule the device's buttons follow (`stageRights`), so a hand, an invitation, speaking and moving back
to the audience all work from either device, and a simulated person invited to speak says yes a moment later. Everyone
joins in the audience, and the stage starts over once the last device leaves.

```sh
bun scripts/verify-stage-demo.ts http://127.0.0.1:8579 [screenshot dir]
```

It joins the stage from both demo Discord accounts and checks the room beside the channel's chat, the zones, the
counts and the ranks, that a listener has no microphone open (the browser is never asked until they speak) and no
camera or screen button, one Leave on screen at each width, "+N more" opening the whole audience (search, Esc, a
moderator's Invite there), a moderator's Speak without Ask to speak, the requests oldest first, a hand going up, the
invitation said aloud, Speak opening the microphone, the moderator moving the speaker back (the microphone closes), a
simulated person accepting, and on a narrow pane the Room / Chat switch with the requests' count, the requests above
the audience, a call left from Chat opening as a room next time, and Leave quietly. With a directory it saves the room
listening (beside the chat), with a hand up, invited, speaking, as the moderator with requests, the whole audience, and
at phone width (the room and the chat).

`bun scripts/verify-call-window.ts <hub>` checks the video window the same way ("The video window" below).

A demo account can also be rung: the account action `ring` (`{conversation, caller?, video?}`, the conversation's
native id) makes the caller ring it there, as a network's ring would, and `ringStop` is the caller giving up
(`DemoRings`). Answering joins the room's call, and declining ends it as declined. The Android run uses it
([android.md](android.md#testing-calls)).

## Call lab

`scripts/call-lab.ts` measures latency, quality and cost with real media both ways between two Discord
accounts. Run it against a separate hub, never the one your devices use:

- start a hub with its own data dir, on loopback, with `DITHER_LAB=1`;
- add two Discord accounts to it with `"lab": true` in their config (copies of existing sandbox profiles work);
- put both accounts in a voice channel you own.

Lab sandboxes get `src/lab/probe.js` and `src/lab/lab.js` inside their hook, and the hub answers
`POST /api/lab/<account>` from loopback. Lab commands can run arbitrary code in the account's client, so
neither exists unless both the hub's environment and the account's config ask for it.

Scenarios `bridgeVideo` and `bridgeGoLive` run the device through dither-chat's own UI in a bridge call: its camera
on and the peer's, each seeing the other; then the device shares its screen and the peer watches it, and the peer goes
live and the device presses Watch.

Every sender loops a speech recording (Discord's default noise cancellation and voice activity detection pass
only speech, not test tones) or draws a test card whose top rows carry the send time in milliseconds. Every
receiver records the loudness envelope of each incoming track and decodes the test card of each incoming
frame. Both ends run on one machine, so latency is arrival minus send on a single clock; audio latency comes
from correlating 2 s windows of the received envelope with the recording's.

### Results (2026-11-02, one machine, Discord voice servers ~10 ms away)

Audio, mouth to ear, median of ~45 windows each (p10–p90 within ±15 ms). "The device" is the account under test; in the first row it is that account's own Discord client:

| Path | To the device | From the device | Device link |
|---|---|---|---|
| Discord client ↔ Discord client | 181 ms | 192 ms | Opus 62 kbit/s |
| Bridge (device ↔ sandbox client ↔ Discord) | 309 ms | 304 ms | Opus 30 kbit/s to the sandbox |
| Direct (device ↔ TURN ↔ Discord) | 203 ms | 80 ms | Opus 61–68 kbit/s |

- About 100 ms of every path that leaves a Discord client is that client's own send-side processing (noise
  cancellation and its buffers): direct mode's device sends without it and arrives in 80 ms.
- The bridge adds about 95 ms each way on top of the sandbox client (the sandbox heard the far end at 213 ms,
  the device at 309 ms): a second jitter buffer, a Web Audio mix, and a second Opus encode at the browser's
  default 30 kbit/s.
- No loss in any run; concealment under 0.7 %, jitter 2–5 ms, jitter buffers 30–65 ms.

Cost while talking (CPU as % of one core, on this machine):

| | Bridge | Direct |
|---|---|---|
| Device (test browser, with the probe) | 22 % | 21–24 % |
| The account's sandbox | 37 % | 6 % (idle client) |
| Hub | 0.7 % | 0.6 % |
| TURN | 0 | 0.7 % |

Video, both clients' own (not yet through dither-chat):

| | Camera (both ways) | Go Live |
|---|---|---|
| Glass to glass, median (p10–p90) | 64–70 ms (47–110) | 50 ms (36–65) |
| Codec, size, rate | H.264 1280×720 at 27–29 fps | H.264 1280×720 at 29 fps |
| Bitrate | 2.0 Mbit/s each way | 2.0 Mbit/s |
| Encode / decode per frame | 8 ms / 1.2 ms (software) | 8 ms / 1.2 ms |
| Sandbox CPU | ~155 % per client | 113 % streamer, 143 % viewer |

Go Live is a second peer connection to a separate stream server. A sandbox that relays video would
spend one to one and a half cores per call on software encoding, decoding and drawing the call view, so video
belongs in direct mode.

### Results (2026-11-14, the two test accounts, one machine, quiet)

| | Audio to the device | Audio from the device | Video to the device | Video from the device |
|---|---|---|---|---|
| Bridge | 251–288 ms | 283–299 ms | camera 74–77 ms at 25–26 fps; Go Live 61 ms at 30 fps | camera 59 ms at 26 fps; Go Live 58 ms at 28 fps |
| Direct | 187 ms | 101 ms | — | — |

Video is 1280×720 (the bridge sends VP8 to the device; Discord's leg is H.264). Before the fix of 2026-11-14 nothing the
device said reached the far end in bridge mode (0 of 27 speech windows): the sandboxed client was muted.

Cost (CPU, % of one core): an audio call through the bridge, device 29 %, its account's sandbox 39 %; cameras both ways,
the sandbox 196–208 % (it decodes the peer's camera and encodes it again for the device, and the device's for Discord),
the device's test browser 116–118 %; one Go Live each way, the sandbox 129–139 %. The hub stays under 4 %.

## Ringing: calls you are not in from here

Every call the networks tell an account about, apart from the ones a device joined through the hub, goes through one
model (`packages/hub/src/callstate.ts`, the adapter's `callState` event, `CallFact` in `packages/protocol/src/call.ts`):
ringing, going on, or over, with how it ended for you (answered, answered on another device, missed, declined, busy,
no answer) and how long it lasted where the network says.

- **A ring alerts once.** A call that rings you is an alert on every device (the highest tier), titled "Ann is
  calling", with Answer where the account can join calls from here and Decline where it can stop the ringing. Open
  pages show a ring card instead (`ui/Ringing.tsx`): a computer's service worker closes the notification while a page
  is in front, and the Android app skips it while it is on screen, so the page in sight rings aloud itself
  (`ringtone.ts`, loaded with the first such call) while this device is in no call. A mute on the chat, the caller,
  the account, the network or everything, quiet hours, and a device's own rules keep it off devices and keep the page
  quiet (the call's `alerts`); the card shows either way. A page nobody has clicked yet may not be let make sound by
  the browser: its card still shows. Quiet hours let
  a call through from a chat or person set to always alert when they let starred messages through, as for messages
  (`ringGate`). Each ring sent is logged as a notification of kind `ring` (docs/activity.md), so the phones' delivered
  and shown reports say whether it rang there; one that is held says so in the hub's log (`ring: <id> not sent`).
- **It stops everywhere.** As soon as the network says it no longer rings you (answered or declined on any device, or
  given up), or you decline here, the ring card goes and the Android app's notification is taken back (`push.clear`).
  A browser keeps its notification until it is tapped: a browser must show something for every push.
- **Answer only while it lasts.** The Android notification's Answer opens the app, which joins the call
  (`android.ts` `answer`) only while the hub still has that call ringing or going on (`answerable` in `ringing.ts`).
  Joining a one-to-one call that is over places a new one, so an Answer handed over again later (the app brought
  back from Recents, or after Android stopped it, comes with the intent it first started from) joins nothing. The
  app itself also answers only a fresh tap.
- **Never again.** The hub remembers each call it rang for, so an adapter reconnecting and saying it all again rings
  nothing. A call that started more than 90 s (`RING.freshMs`) before the hub heard it ring is old news and never
  rings: the call's own time, not the hub's. A ring left hanging for 3 minutes (`RING.maxMs`) is over, as missed.
- **Forward only.** A call goes ringing → going on → over; an over call heard ringing again (an old event replayed)
  stays over. Declined here stays declined, though Discord only says you were not in it.
- **The call line.** Each call's own message in the timeline is worded as the call went, the same on every network
  (`callLine`): "📞 Missed call", "📞 Call, 12 min", "📞 Declined call", "📞 Call, answered on another device".
  Rewording it is not an edit.

`GET /api/calls/ringing` (what rings and goes on now, and the last hour's; `?conversation=` for one chat's), `POST
/api/calls/<id>/decline`, and the `calls` client event. `GET /api/calls` is the calls this hub carries (`Calls.stats`).

### Discord

The hook listens to what the gateway tells the client: `CALL_CREATE`/`CALL_UPDATE` (`ongoingRings`: who is rung, and by
whom), `CALL_DELETE`, and the voice states of the call's channel. A call is its call message (type 3), so its start
time is the message's snowflake. Decline is the client's own incoming-call Decline, `CallActions.stopRinging(channel)`
(`POST /channels/{id}/call/stop-ringing`). Answer is the existing join. The header's Call button in a DM or group DM
(capability `ringCalls`) joins, then rings the others with the client's own `CallActions.ring`, as its call button
does; with a call going on there it says Join. The call message reads its `call.participants` and `ended_timestamp`.

### Signal

Passive: what a linked device already receives. An offer rings you. The caller's hangup to your other devices says how
it went: ACCEPTED (answered on another device; once they hang up, how long), DECLINED, BUSY (on another device),
NEED_PERMISSION or NORMAL before anyone answered (missed). Busy and answer messages only answer offers this device
made, which it never makes.

Not built: Decline and Answer from dither. signal-cli 0.14.8 tracks a call only while some client is subscribed to call
events (`subscribeCallEvents`); a subscribed signal-cli answers every incoming offer by spawning its media tunnel
(`signal-call-tunnel`, found through `SIGNAL_CALL_TUNNEL_BIN` or next to its install), and the nix build ships no
tunnel. The spawn fails and signal-cli ends the call with `tunnel_spawn_error`, which sends the caller a hangup: every
call to you would end on your phone too. `rejectCall` needs that tracked call. What it would take: a packaged
`signal-call-tunnel` (RingRTC built for this machine), virtual audio devices for its input and output, and a bridge from
those to the device's WebRTC, the same shape as Discord's bridge mode. Nothing of it is small, and none of it can be
tested against the fake signal-cli.

### Voice channels

Who is in which Discord voice channel when you are not in it comes from `VOICE_STATE_UPDATES` for the servers the
client has loaded, and the client's voice state store after it connects: what it was sent anyway, never a request. It is
someone's behaviour, so the hub keeps it only with the adversarial `voice` setting on (docs/history.md): who is in each
channel now, on the channel's row, its page and its chat, and each join and leave in the change log under the person,
like presence (their newest 1000). A channel's status line ("playing chess", `VOICE_CHANNEL_STATUS_UPDATE` and the
client's own `CHANNEL_INFO`) is the channel's, kept whatever the setting. `GET /api/voice`, the `voice` client event.

Not built: voice history and hangouts (`/channels/{id}/voice-history`): a request of ours, not something the client is
sent.

## The call bar

One call has several sizes, smallest first: a mark on its chat row, the bar, the dock, the video window. The dock (the
call's name, its buttons, and when open its people; `CallDock` in `ui/Call.tsx`) is the call while you chat beside it.
The bar (`ui/CallBar.tsx`, its choices in `callbar.ts`) is the call while you look at something else, like a music
player: a slim row with whoever is talking (call.ts `featuredSpeaker`, drawn with `CallAvatar` and the shared speaking
ring), how long the call has gone (`callStatus`, so also Connecting to Discord… and the still-muted hint), and at most
two buttons from `callControls`. Nobody talking, the face is a few of the others' pictures overlapping (the call's
own picture when nobody else is in it), with the call's phase as a dot in the corner.

- **Its buttons, by role.** Never Leave: that is in the expanded call, away from where a thumb rests. A speaker (or
  anyone in a call without an audience) gets mute and deafen, or mute and the camera or the screen while one is on, so
  it can be turned off from anywhere. With no microphone, deafen alone. A stage's audience gets deafen and its hand,
  or Speak once invited. Mute and deafen keep one name with `aria-pressed`; their tooltips say what a press does.
- **A row of the layout.** It never sits over anything. On a computer the app's grid gives it a row of its own under
  the list (`.app.with-bar`), the rail and the page running down beside it; with the list hidden (All communities, the
  calendar) the row is under the page. The call's video stands above it. On a phone it is the top of the screen
  wherever you are, the lists, a page and the details all starting below it, so it is in one place whether over the
  lists or on another chat.
- **A tap expands it in place.** On a phone a sheet hangs from the bar over the page you're on: every button (Leave
  among them), Go to chat, and the people. On a computer the dock stands on the bar. Back, Escape or another tap folds
  it; it never changes the page.
- **Where it shows.** Phone: whenever you're in a call and the page on screen isn't the call's chat (any route of the
  same chat counts, docs/chats.md); on the call's own page the dock shows at the top, as before. Computer: the dock as
  before, except where the list is hidden or dragged to 260 px or narrower.
- **The mark:** on the call's row in the lists (a DM, a chat's row, a voice channel), three small bars, green in your
  call and moving while anyone talks. A conversation with a call going on that you aren't in (the hub's calls,
  `callIn`) gets them in grey.

### In a call now

Who is in a call or a voice channel right now shows on their rows: a small green speaker (the `voice` icon,
`VoiceNowMark` in ui/CallBar.tsx) beside a person's name on People, on their DM or chat row in the inbox, and on a
voice or stage channel's own row in the inbox when someone is in it. Its tooltip says where: "In voice in #hangout ·
Dither", "In a call with you" (a one-to-one call going on), "In a call in Weekend plans" (a group's), or on a
channel's row "In voice: Lev, Mara"; one line a place when someone is in two. A place the row's own call mark already
shows (the call in that DM) is left out, as is the call you're in on its channel's row. You are never marked.

It is one lookup, `voiceNow` (voicenow.ts, built by voiceplaces.ts), from the voice channels' people (`voice`,
ringing.ts), the hub's calls that are going on and not ringing (`liveCalls`) and the call this device is in
(`activeCall`), with names and people from `db` behind `metaRev`. It is made as text first, so a mute, a camera or a
speaking light changes nothing and no row hears of it; a join or a leave redraws only the icons. The voice channels'
people come only with the adversarial `voice` setting on ("Voice channels" above): with it off, the icon shows for
calls alone. The demo has Lev, Mara and Alice in the hangout now; `scripts/shots-in-call.ts` screenshots Alice's
rows and checks that the icon follows a `voice` frame without a reload.

## In a call: what each of Discord's call features takes here

Plan and state for the rows of docs/research/discord-gaps.md "Voice, video, calls, streaming" beyond ringing and
presence (net-gaps, package discord-video). Nothing here has been tested live: only against fakes (the hook's
replica clients, the hub's tests, the web's unit tests). The client modules named are as read from Discord's web
build of 2026-11-12, never copied or run.

How audio flows decides most of it:

- **Bridge mode**: the sandbox's own Discord client is in the call. It receives every person's audio on its own peer
  connection and plays each through an `<audio>` element of its own (its browser engine's per-user output: that is
  where its per-user volume and local mute apply). The hook taps those same remote tracks, mixes them in its own
  Web Audio graph and sends one mixed track to the device. So the device cannot tell people apart: anything per
  person happens in the sandbox. Anything the client does for itself (settings, soundboard, stage requests,
  moderator actions) is the client's own action, as a click would run it.
- **Direct mode**: the device speaks the voice protocol, with one receive slot per person (`voice/discord.ts`
  `assigned`: mid → user). Per-person audio exists on the device. The page in the sandbox joined the channel but
  never connected media, so it still has the voice states, and its actions that are plain gateway or REST requests
  (stage, moderation, soundboard) work the same in both modes.

| Row | Bridge mode | Direct mode | Here |
|---|---|---|---|
| Per-user volume, mute for me | The client's own `AudioActions.setLocalVolume(user, volume)` and `toggleLocalMute(user)` (its user menu's slider and Mute). Its browser engine applies them to its own `<audio>` elements, which the bridge does not hear, so the hook also puts a gain per tapped track in its mix: it finds the track's owner among the client's per-user outputs (`MediaEngineStore.getMediaEngine().eachConnection` → `outputs[user].stream`) and reads the volume back from `MediaEngineStore.getLocalVolume/isLocalMute`. A track whose owner it cannot find stays at full volume, as before | The same client settings are kept (so both modes and Discord's own app on that profile agree), and the device applies them itself: a muted person's track is left out of what plays, and a person at another volume plays through a gain node | **built** |
| Input sensitivity, noise suppression | The device's microphone keeps the browser's noise suppression (or not), and the client's own `AudioActions.setNoiseSuppression` and `setMode('VOICE_ACTIVITY', {threshold, autoThreshold})` decide when it sends: it is the client that transmits | The browser's noise suppression on the microphone, and the device's own level gate (`startVad`) at the chosen threshold | **built**, per device (Settings → Calls) |
| Server mute, deafen, move, disconnect | The client's own `GuildActions.setServerMute`, `setServerDeaf`, `setChannel` (null disconnects), as its member menu runs them, after `PermissionStore.can(MUTE_MEMBERS / DEAFEN_MEMBERS / MOVE_MEMBERS, channel)` | the same: it is the page's action, not the media's | **built** as `moderate` actions (voiceMute, voiceDeafen, move, disconnect), one click and a confirm each |
| Stage channels | Who speaks and who listens, and raised hands, are voice-state fields (`suppress`, `requestToSpeakTimestamp`); the topic is the stage instance's (`StageInstanceStore`). Raise or lower your hand, become a speaker when invited, move back to the audience: `PATCH /guilds/{g}/voice-states/@me`, the requests the client's stage module sends; a moderator's invite to speak and move to the audience: `PATCH /guilds/{g}/voice-states/{user}` | the same | **built** |
| Seeing camera and Go Live | `selfVideo` and `selfStream` on voice states | the same | **built**: shown on the call's people and in voice channels |
| Receiving camera video | The client's call view (opened once someone has video) asks for people's video; each remote video track on its own connection is put on one of the bridge's receive slots (see "Video") | Needs: identify with `video: true` and a `streams` list; codecs H264/VP8/VP9 with RTX in select protocol; the server's op 12 (each user's video SSRCs) and op 15 media sink wants to ask for a stream; a receive-only video section per wanted SSRC in the made-up answer; and DAVE decryption of video frames (libdave's Decryptor is codec-aware; the worker is told the audio codec only) | **built** in bridge mode; direct mode: design in "Video in direct mode" |
| Watching Go Live | The client's own watch (`STREAM_WATCH`, stream key `guild:<g>:<channel>:<user>` or `call:<channel>:<user>`) opens a second connection (context `stream`); its video track goes on a slot like a camera | A second voice-gateway session to the stream server (`STREAM_SERVER_UPDATE`'s endpoint and token, `server_id` = the stream's `rtc_server_id`), with its own DAVE group: the hook would intercept `STREAM_SERVER_UPDATE` the way it intercepts `VOICE_SERVER_UPDATE` | **built** in bridge mode (Watch on someone LIVE in the open dock) |
| Sending camera video, sharing a screen | The device's camera and screen come up the bridge and become the client's camera (`getUserMedia` with video, `setVideoEnabled`) and its Go Live (`getDisplayMedia`, its web Share Your Screen start); the client encodes again | op 12 with our own video SSRCs, simulcast encodings, DAVE encryption of video frames; Go Live a second session again | **built** in bridge mode (the dock's camera and screen buttons; a window or a tab is the browser's own choice in its picker) |
| Soundboard | Play: `POST /channels/{id}/send-soundboard-sound` with the sound's id (and its server, when not a default sound), as the client's soundboard sends it, from the sounds `SoundboardStore` has for this server and Discord's defaults, where `USE_SOUNDBOARD` allows. Hear: a sound is not in anyone's audio; every client plays it itself on `VOICE_CHANNEL_EFFECT_SEND`, so the hook plays it into the bridge's mix | Play the same way. Hear: the device would fetch the sound itself, which shows Discord the device's address: not done | **built** (play; heard in bridge mode only) |
| Voice channel effects (emoji bursts) | Shown: `VOICE_CHANNEL_EFFECT_SEND` with an emoji, in the call you are in | the same | **built** (shown); sending one is **not built**: its animation ids and Nitro-only kinds come from the client's own tables |
| Activities | An app in an iframe from the activity's own origin, with its own SDK talking to the client over postMessage | — | **not built**: it would mean running a third party's app on the device with the account's client as its host |
| Clips | A desktop-app feature (it records the last seconds of the call locally) | — | **not built**: not in the web client |
| Call sounds | Discord's own join, leave, mute, deafen, camera and stream sounds, played on the device (see "Sounds") | the same | **built** |
| Custom call sounds | The join sound someone with Nitro picked, played by each client (`CUSTOM_CALL_SOUNDS`) | — | **not built**: cosmetic, Nitro-only |

Whatever shows other people's behaviour beyond the call you are in (who is in voice elsewhere, who is streaming
there) stays behind the adversarial `voice` setting, as before. What happens in the call you are in (who speaks,
raised hands, sounds and effects played in it) is shown as Discord's own call view shows it.

### As built

Device → hub, on `/api/call` (protocol call.ts), each only where the account's adapter has the capability; the hub
checks the shape, turns hub identity ids into native ones and refuses the rest in words:

| Message | Capability | Does |
|---|---|---|
| `join` with `input` | `callInput` | the microphone's handling from the start (bridge: the account client's voice settings) |
| `{op: 'local', user, volume?, muted?}` | `callVolume` | one person's volume (0 to 200 %) or mute, for this account only |
| `{op: 'input', input}` | `callInput` | noise suppression on or off; sensitivity automatic or a level in dB |
| `{op: 'stage', action, user?}` | `stage` | `raiseHand`, `lowerHand`, `speak` (when invited, or with a rank), `listen`; a moderator's `invite` and `audience` for `user` (each only as the stage's `can` and `canOn` allow) |
| `{op: 'sounds'}` → `{t: 'sounds', sounds, reason?}` | `soundboard` | this server's sounds and Discord's defaults, as the client has them, where Use Soundboard allows |
| `{op: 'sound', sound, guild}` | `soundboard` | play one to everyone in the call |
| `{op: 'video', camera, screen, screenAudio?}` | `callVideo` | this device's camera and screen are on or off (bridge mode only) |
| `{op: 'watch', user, on}` | `watchStreams` | watch someone's Go Live, or stop (bridge mode only) |

The call's state adds, per person: `streaming`, `serverMuted`, `serverDeafened`, `volume` and `localMute` (the
client's own values, so the device and the client agree), `stage` (`speaker`, `audience`, `hand`, `invited`),
`stageRank` (`host`, `cohost` or `moderator`, where the adapter knows) and `askedAt` (ms epoch a hand went up, so
requests are answered oldest first); and for a stage:

```ts
stage: {
  topic: string | null;
  can?: ('raiseHand' | 'lowerHand' | 'speak' | 'listen')[]; // what this account may do now, for itself
  canOn?: ('invite' | 'audience')[];                         // what it may do to others (each where it fits their role)
  listeners?: number;                                        // how many listen in all, when only some are sent (a Space)
}
```

The device draws its buttons from `can` and `canOn` alone. An adapter that leaves them out gets them worked out from
your role and rank (`stageRights`, protocol call.ts): listening, Ask to speak, or Speak with a rank; hand up, Lower hand
(and Speak, with a rank); invited, Speak or Stay in the audience; speaking, Move to the audience; any rank invites and
moves others. An adapter from before `can` sent `moderator: boolean`; the hub reads that as `canOn` (`hubStage`,
calls.ts). `{t: 'effect', effect: {who, emoji?, sound?}}` is a sound or emoji someone
sent in the call. Server mute, deafen, move and disconnect are `moderate` actions (docs/moderation.md), offered from
the voice channel's About.

The web: the open call dock is a chunk of its own (`ui/CallPanel.tsx`): tap someone for their volume and mute for you,
a stage moderator's invite or move to the audience, and a server moderator's actions, each after a confirm; a stage's
topic, your role and Speak or Move to the audience at the top (your hand is a button on the dock's bar); the
soundboard below. Someone's Go Live shows as a LIVE tag there and on the voice channel's people (cameras show in the
video window, so the dock has no camera icon). Settings → Calls has this device's noise suppression and sensitivity,
its microphone and camera (with a six-second microphone test), and the call sounds on or off. The dock's mute button
has a ring that follows the microphone's level (from what WebRTC says it sends), so a silent microphone shows.

### Who is speaking

Every place that shows a call (the dock now; the call bar, a room and the video window as they come) reads the same
pieces, so none works these out again:

- **Held, so it doesn't blink** (`speakingHold`, `callmarks.ts`). Voice activity switches off between words. `call.ts`
  holds what the network says where it changes the call's people: each participant's `speaking` in `activeCall` is
  the held value, on at once and still on 250 ms after the last word; then the ring fades over 180 ms (CSS). Nothing
  else needs to remember a hold.
- **Who to feature** (`featuredPicker`, `call.ts` `featuredSpeaker`): the latest person to start talking, never you,
  kept at least 1.5 s before someone else (or nobody) takes it, and while they still talk someone else takes over only
  after a second of talking (`FEATURE_TAKE_MS`), so a quick "yeah" doesn't snatch it. The dock names
  them first in its "is talking" line; the call bar's face and the video window's Speaker use it.
- **The face** (`ui/CallAvatar.tsx`): `CallAvatar` draws only what it's given (id, name, picture, size, speaking,
  level, tone, badge): the picture in a fixed square box with the ring 4 px around it, so it's round at every size.
  `callMarks(call, person)` works those out for someone in the call you're in, or (with no call) for someone a voice
  channel lists, as the list's voice channels do. Its words ("Lev, speaking, muted") are what a screen reader hears.
- **One ring** (`.speak-ring`, styles.css): a layer around its element, or inside its edge (`--ring-inset: inset`, as
  video tiles have it), with its distance, width, colour, corner and strength as CSS variables.
- **Its strength**: in direct mode each person has a receive slot of their own, so while someone speaks their ring's
  strength follows their level (read on the microphone meter's own tick, only while someone speaks; yours is your
  microphone's). Bridge mode gets one mixed stream, so it never shows a level per person: the ring is on or off.
- **One badge**, bottom right, the most important way someone differs from their role's default (`callBadge`): in a
  stage's audience, where muted is normal, a hand up and then an invitation; for a speaker, or anyone in a call without
  an audience, muted or deafened by a moderator (filled red), deafened, muted, then muted for you. It grows with the
  face (`badgeSize`, a third of it). No network badge: the call already names its network. The dock also keeps a ✋
  beside the name of someone asking to speak.
- **Muted but talking**, for you only: while you are muted, a copy of your microphone is listened to here (a Web Audio
  analyser, only while muted) against your sensitivity, or the automatic gate's −36 dB (`AUTO_GATE_DB`). After about
  half a second of talk (`talkGate`; gaps between words don't restart it) the mic button gets an amber ring and a
  small "You're muted" note anchored to it, which moves nothing else; three seconds of quiet clears it. A live region
  beside the button, always there, says it to a screen reader.
- **The buttons and the status line** (`callControls`, `callStatus` in `call.ts`; `ui/CallControls.tsx` draws them).
  Your role gets its buttons: a speaker, or anyone in a call without an audience, gets mute, deafen, camera and share
  where video goes, and Leave; on a stage the rest are what the stage lets you do (`stageCan`, from `can` and
  `canOn`): a hand to raise or lower, Speak, Move to the audience (Stay in the audience when invited). The audience
  never gets the microphone, a camera or a screen, and leaves quietly. The status line is Connecting…, Connecting to Discord… (bridge mode
  before the account's own client is in), the time (1:15:03 past the hour) or why it ended, with "The account is still
  muted: tap to try again" when it is.

### The room view

Every live audio thing is a room with roles: a call is a room where everyone speaks, a stage (a Discord stage, later an
X Space) one where a few speak and the rest listen. `web/src/room.ts` sorts a call's people into the room's zones by
role (`CallParticipant.stage`), with nothing network-specific in it, and `ui/CallRoom.tsx` (a chunk of its own, with Try
again when it could not load) draws them:

- the header: the network, the stage's topic, "N speakers · N listening" (the stage's `listeners` when it sends only
  some of them);
- Speakers: the call window's tiles ("The video window" below), moved into the room at its size: each speaker's
  camera, or their face (`CallAvatar`, ringed while speaking, its one badge), named by rank (Host, Co-host, Moderator)
  or Speaker, with a moderator's moves in a menu on each tile; 64 px faces while the window floats instead or is still
  loading;
- who asks to speak, oldest first (`askedAt`): for someone who may invite, "Asking to speak" with Invite on each; for
  others, "Hands up" by name. Above the audience at every width;
- Audience: 32 px faces, you first, then hands up, then the invited, then the rest; past 18, "+N more" opens everyone
  listening, searchable, people you know first (starred, then those you have a direct chat with), with Invite on each
  for a moderator; Esc or Done closes it;
- the buttons: the call's own (`CallControls`, by your role and what the stage lets you do), with "You're invited to
  speak" said in a status line above them.

A face with something you may do to them (a moderator's Invite to speak or Move to the audience) is a button that opens
a menu; otherwise it is a plain element. Joining a stage channel (the header's Join, where the account has `calls` and
`stage`) makes the room the conversation's page. On a wide pane the channel's chat (the real timeline and composer)
sits beside it; on a narrow pane (a container query on the pane, not the screen) a Room / Chat switch shows one of
them, and Room carries a count of the requests for someone who may invite (`roomRequests`, call.ts, for a call bar
too). A room with no chat has only the room. Opening a stage you are not in shows its chat, as before.

One set of buttons at a time: while the room is on screen the dock leaves out its buttons (and its open body's Speak or
Move), and the header has no Join or Leave for a room you are in; on a narrow pane showing Chat the dock has them back.

A stage is joined listening, without the microphone: the browser is not asked for one, and the call sends a silent
track. Speak asks for it (from the click) and goes ahead once it is open; being made a speaker opens it too. Going back
to the audience, by your own button or a moderator's move, closes it again (`takeMic`, `releaseMic`, call.ts; the
transports swap the track they send, `setMic`).

Direct mode's sensitivity is the device's own level gate: the level in dB is the microphone's loudness (RMS, dBFS);
"automatic" is the gate's own −36 dB. Discord's own slider is on its own scale, so the same number may not feel the
same in the two modes.

Not tested live: the client modules and requests named here are as read from its bundle, and the hook was run
against replicas of them (extractors/discord/test/hook-incall.test.ts in dither-accounts). In particular unknown:
whether a soundboard sound's link plays into the bridge's mix (it needs the CDN to allow it cross-origin; if not, the
device hears nothing of it and nothing else changes), and whether the client's per-person outputs keep the shape the
mix reads (if not, every track stays at full volume, as before).

### Video (bridge mode), as built

The bridge's peer connection has a fixed m-line for each kind of media (protocol `BRIDGE_MIDS`), offered by the device
up front, so turning a camera on or a remote video changing never renegotiates:

| mid | Direction (device) | Carries |
|---|---|---|
| 0 | sendrecv | the device's microphone up, the call's mix down |
| 1 | sendonly | the device's camera |
| 2 | sendonly | the device's screen, a window or a tab |
| 3 | sendonly | the screen's sound, when the browser shares one |
| 4–7 | recvonly | others' video: cameras, and the streams the device watches |

- **Sending.** The device `replaceTrack`s its camera (1280×720 at up to 30 fps, 1.5 Mbit/s) or screen (2.5 Mbit/s,
  content hint `detail`) into its m-line and sends `video`. The hook hands those tracks to the client: its
  `getUserMedia` with video answers with the device's camera (with a stand-in camera in `enumerateDevices` when the
  sandbox has none, or the client never asks), its `getDisplayMedia` with the device's screen; then the client's own
  camera setting (`setVideoEnabled`) and its web Go Live start (the module that picks the quality, calls
  `getDesktopSource` and starts the stream) send them as Discord's own client would. Off: `setVideoEnabled(false)`
  and the streaming module's stop. The browser's own "Stop sharing" ends it on the device too.
- **Receiving.** Once someone in the call has video (or the device watches a stream), the hook opens the call's
  channel in the client (an audio call never pays for drawing it): its call view is what asks the voice server for
  people's video. Each remote video track on the client's connections says whose it is (its stream id is
  `<user>-<ssrc>`), and the connection says what (context `default`: a camera, `stream`: a Go Live). The hook puts
  them on the slots, streams first, then cameras, keeping what plays where it is, and the state's `video` says whose is
  on which; a camera turned off or a stream no longer watched frees its slot.
- **On the device.** Video shows in one window ("The video window" below): others' cameras and streams with their
  names, and what it sends (its own camera mirrored). A click shows a tile big. Someone LIVE has Watch in the open dock.
  The dock's camera and screen buttons show only in bridge mode, where the account can (`callVideo`); screen sharing
  only where the browser has `getDisplayMedia` (not phones).
- **Cost.** The sandbox decodes and encodes each video again (measured above). Discord's own clients send H.264; the
  bridge sends the device VP8.

### The video window

The call is one window of tiles (`ui/CallWindow.tsx`, a chunk of its own loaded once the call has video or a room is on
the page; the layout itself is `src/callLayout.ts`, pure and unit-tested). A tile is a person, not a video: everyone in
the call (on a stage, its speakers), drawn as their camera when it is on and otherwise as their face (`CallAvatar`, with
the same speaking ring and badge), and a tile for each screen being shared. A camera's ring is drawn inside its edge
(`.call-video.speak-ring`); its badge sits in the caption. Your own tile and your own screen are yours (`mine`), so
neither is ever the big tile by itself.

It has no title bar. Its buttons sit at its top right, shown on hover (always on a touch screen): Move (a grip that
takes the arrow keys), Full screen, and the layout menu, which opens upward when there is no room below it. The menu
has three rows of radios (one tab stop a row, the arrow keys move through it):

- **Arrange**: Auto, Grid (everyone the same size, in the columns that make them largest) or Speaker (one fills the
  window, the rest in a strip below). Speaker's big tile is someone else's shared screen, else whom the call features
  (`featuredSpeaker`, call.ts: the latest to start talking, never you, kept at least 1.5 s, and while they still talk
  someone else takes over only after a second of talking), else the one it showed last, else the first that isn't
  yours. Auto is Grid, or Speaker while someone shares a screen, and on a phone.
- **Your camera**: your tile like the others, a small inset in a corner (drag it; it settles in the nearest corner), or
  hidden. When it is the only tile, it is shown whatever the choice.
- **Place**: Floating over the app (drag it anywhere on it; resize from its lower right corner, or by the arrow keys on
  that corner; it stays on screen and never covers the call bar), Above chat, or Fill. Above chat and Fill apply on the
  call's own chat only: there the page has a slot under its header (`ui/CallSlot.tsx`), and the window moves into it,
  animating from where it was. Above chat is a strip in the chat's flow, the header and its buttons above it and the
  messages below, with a divider at its foot (a separator in the tab order that takes the arrow keys) for its height.
  Fill is the whole page under the header. On a stage the room is the window at full size: Above chat, Fill and Auto
  put it in the room's speakers zone. On any other page (another chat, Settings) the window steps down: to the floating
  window on a computer, to the call bar on a phone. Dragging the floating window to the top of the call's chat docks
  it; dragging a docked or filling window down floats it.

A click on a tile (or Enter on it) shows it big, as Speaker, and another puts it back; the tile is marked with a pin
and its name says "shown big". That is never kept as a choice: Arrange stays what you picked. F on a tile, or the
Full screen button, puts the whole window full screen, with its captions, your inset and the call's buttons. A resize
or a divider drag ends with the height that fits the tiles with no bars around them (of the heights that do, the
nearest). Filling a page or the screen, cameras are cropped to fill their tiles; a shared screen never is.

On a phone the window carries the call's buttons (`CallControls`) and a button for the call's people and settings, so
the dock's strip steps aside while it shows. A phone starts as Speaker, docked under the chat's header, you in the
corner.

Every change moves the same tile elements to their new places with a transition, so a switch morphs rather than
redraws. The choices are kept on the device (`dither-chat:call-window` in localStorage, with the floating window's
place and size and the docked height); each is absent until you pick it, and Auto takes it out again.

`scripts/verify-call-window.ts` checks it on a demo hub: tiles as people, the menu and its keys, each arrangement and
camera choice moving the tiles, showing a tile big by click and by Enter without keeping it, full screen, moving,
resizing (by pointer and keys), the menu opening upward, docking into the chat's slot under the header, the divider,
another chat floating it, Fill, floating again, the choices kept, a call ending mid-drag, and a phone (docked with the
call's buttons, the bar on another page). `--shots <dir>` saves screenshots of each. `scripts/verify-stage-demo.ts`
checks the room's speakers as the window's tiles.

### Sounds

The device plays the sounds a call makes, named as Discord names its own (protocol `CALL_SOUNDS`): `user_join` when the
account is in (its client's voice connection is up) and when someone joins, `user_leave`, `disconnect` on leaving,
`mute`/`unmute`, `deafen`/`undeafen`, `camera_on`/`camera_off`, `stream_started` (yours, or someone going live) and
`stream_ended`. A burst of the same news plays once (`callsounds.ts`). They play through the call's own AudioContext,
on this device only.

The recordings are Discord's own: `scripts/dave/update.ts` copies them from the public web client next to libdave
(`scripts/dave/sounds.ts`: the client's sound table is a webpack context module keyed `./user_join.mp3` and so on, each
entry a module exporting the file's URL; found by that anchor, never by module ids), into `DITHER_DAVE_DIR/sounds`.
The hub serves them at `/voice/sounds/<name>.mp3` and lists them at `/api/voice/sounds`; never commit them. A hub
without them, and every demo hub, plays short chimes of the device's own instead. Settings → Calls turns them off.

### Video in direct mode: what it would take

Nothing of this is built: video goes through bridge mode.

**Direct mode, receiving.** `voice/discord.ts` would need, in order:

1. Identify (op 0) with `video: true` and a `streams` list (`[{type: 'video', rid: '100', quality: 100}]`).
2. Select protocol (op 1) with video codecs (H264, VP8, VP9, AV1 as the browser offers them, each with its RTX
   payload type) beside Opus.
3. Read op 12 from the server (each user's `video_ssrc`, `rtx_ssrc` and streams) and give each a receive-only video
   section in the answer it makes up, as audio slots are given now.
4. Ask for the video with op 15 media sink wants (`{<ssrc>: 100}`; today it sends `{any: 100}` for audio).
5. DAVE: tell the worker each video SSRC's codec, so libdave's decryptor leaves the codec's unencrypted ranges (H264
   NAL headers) alone; today it is told the audio codec only. The smoke test in `scripts/dave/update.ts` would need a
   video round trip.
6. Go Live: a second voice-gateway session to `STREAM_SERVER_UPDATE`'s endpoint, with `server_id` the stream's
   `rtc_server_id` and a DAVE group of its own; the hook would swallow `STREAM_SERVER_UPDATE` as it swallows
   `VOICE_SERVER_UPDATE` today, and hand the device the endpoint and token.

The test accounts in the call lab are a real voice server to check it against; the bridge carries video in the
meantime.

**Direct mode, sending a camera or a screen.** Op 12 with our own video SSRCs and simulcast encodings, DAVE encryption
of video frames, and for Go Live the second session again.
