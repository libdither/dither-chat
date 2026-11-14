# Calls

Voice calls on Discord accounts, in two modes you can switch between in Settings → Calls. Both keep the account's
login token on the hub and both make Discord see the hub's address, never the device's.

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
opaque: it cannot read the app's storage or make credentialed requests to the hub.

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
devices, and checks joining (and how fast), hearing and being heard, the join, leave, mute and camera sounds, mute
reaching the far end and the other device, the camera both ways, sharing a screen and watching it from the other
device, watching the bot's Go Live, leaving, and a device with no microphone joining to listen.

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
  pages show a ring card instead (`ui/Ringing.tsx`). A mute on the chat, the caller, the account, the network or
  everything, quiet hours, and a device's own rules keep it off devices; the card shows either way.
- **It stops everywhere.** As soon as the network says it no longer rings you (answered or declined on any device, or
  given up), or you decline here, the ring card goes and the Android app's notification is taken back (`push.clear`).
  A browser keeps its notification until it is tapped: a browser must show something for every push.
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
| `{op: 'stage', action, user?}` | `stage` | `raiseHand`, `lowerHand`, `speak` (when invited, or as a moderator), `listen`; a moderator's `invite` and `audience` for `user` |
| `{op: 'sounds'}` → `{t: 'sounds', sounds, reason?}` | `soundboard` | this server's sounds and Discord's defaults, as the client has them, where Use Soundboard allows |
| `{op: 'sound', sound, guild}` | `soundboard` | play one to everyone in the call |
| `{op: 'video', camera, screen, screenAudio?}` | `callVideo` | this device's camera and screen are on or off (bridge mode only) |
| `{op: 'watch', user, on}` | `watchStreams` | watch someone's Go Live, or stop (bridge mode only) |

The call's state adds, per person: `streaming`, `serverMuted`, `serverDeafened`, `volume` and `localMute` (the
client's own values, so the device and the client agree), and `stage` (`speaker`, `audience`, `hand`, `invited`); and
for a stage `stage: {topic, moderator}`. `{t: 'effect', effect: {who, emoji?, sound?}}` is a sound or emoji someone
sent in the call. Server mute, deafen, move and disconnect are `moderate` actions (docs/moderation.md), offered from
the voice channel's About.

The web: the open call dock is a chunk of its own (`ui/CallPanel.tsx`): tap someone for their volume and mute for you,
a stage moderator's invite or move to the audience, and a server moderator's actions, each after a confirm; a stage's
topic and your own hand at the top; the soundboard below. Someone's camera and Go Live show as a camera and a LIVE tag
there and on the voice channel's people. Settings → Calls has this device's noise suppression and sensitivity, its
microphone and camera (with a six-second microphone test), and the call sounds on or off. The dock's mute button has a
ring that follows the microphone's level (from what WebRTC says it sends), so a silent microphone shows.

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
- **On the device.** Video floats beside the dock (on a phone, at the top): others' cameras and streams with their
  names, and what it sends (its own camera mirrored). A tap goes full screen. Someone LIVE has Watch in the open dock.
  The dock's camera and screen buttons show only in bridge mode, where the account can (`callVideo`); screen sharing
  only where the browser has `getDisplayMedia` (not phones).
- **Cost.** The sandbox decodes and encodes each video again (measured above). Discord's own clients send H.264; the
  bridge sends the device VP8.

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
