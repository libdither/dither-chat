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

1. The device opens `/api/call` and sends `join` with the account, the conversation and the mode.
2. The hub asks the account's adapter to join. The adapter's in-page hook calls Discord's own
   `selectVoiceChannel`, the same action its voice channel button runs, so the gateway's voice state, mute flags
   and participant list stay the client's.
3. Bridge: the hook hands the client the device's microphone (a Web Audio track fed by the bridge's peer connection)
   when it asks for one, taps the remote audio of the client's own peer connection, mixes it, and sends the mix
   back over the bridge. The device offers; the sandbox answers. Signalling goes through the hub.
4. Direct: one Dispatcher interceptor catches `VOICE_SERVER_UPDATE` and swallows it, so the page's own voice
   connection waits for an endpoint forever and never connects. The endpoint and token go to the device, which
   opens the voice socket through the hub (`/api/call/<id>/voice`, forwarded only to `*.discord.media`) and its
   media through the hub's TURN relay (`iceTransportPolicy: relay`).

Participants and mute state come from the client's own stores in both modes. Speaking comes from the client in
bridge mode and from the voice server's SPEAKING messages in direct mode.

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

## Call lab

`scripts/call-lab.ts` measures latency, quality and cost with real media both ways between two Discord
accounts. Run it against a separate hub, never the one your devices use:

- start a hub with its own data dir, on loopback, with `DITHER_LAB=1`;
- add two Discord accounts to it with `"lab": true` in their config (copies of existing sandbox profiles work);
- put both accounts in a voice channel you own.

Lab sandboxes get `src/lab/probe.js` and `src/lab/lab.js` inside their hook, and the hub answers
`POST /api/lab/<account>` from loopback. Lab commands can run arbitrary code in the account's client, so
neither exists unless both the hub's environment and the account's config ask for it.

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
