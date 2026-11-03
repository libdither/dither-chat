# WhatsApp

The WhatsApp adapter links the hub to your WhatsApp account as a **linked device**, the same kind of companion
WhatsApp Web is. It does this through [whatsmeow](https://github.com/tulir/whatsmeow), the Go library that
mautrix-whatsapp and Beeper use, in a small sidecar process. Your phone stays the primary device.

## The decision

What mattered most was keeping your real account from being banned, then robustness, resource use, and maintenance.
The evidence below was gathered on 2026-11-02.

| | (a) Real WhatsApp Web in the sandbox (wa-js / WPPConnect style) | (b1) whatsmeow sidecar (chosen) | (b2) Baileys (TypeScript) |
|---|---|---|---|
| How WhatsApp sees it | The real web client | A web-protocol companion with the same handshake, noise keys and multi-device signal sessions | Same as whatsmeow, but it has advertised identities WhatsApp has since retired |
| Ban reports, personal use | Hit by the same 2025 warning wave as protocol clients ([whatsmeow#810](https://github.com/tulir/whatsmeow/issues/810)) | Rare. Maintainers say "just using the bridge shouldn't cause any bans" ([mautrix docs](https://docs.mau.fi/bridges/go/whatsapp/authentication.html)). Isolated reports are closed as not planned ([mautrix/whatsapp#792](https://github.com/mautrix/whatsapp/issues/792)). Automatic temp-ban recovery was declined in Oct 2026 as not worth it ([mautrix/whatsapp#1005](https://github.com/mautrix/whatsapp/pull/1005)) | Many, but the user base is mostly bots: [#1869 "High number of bans"](https://github.com/WhiskeySockets/Baileys/issues/1869) (2025-10), [#2309](https://github.com/WhiskeySockets/Baileys/issues/2309) (2026-01) |
| Maintenance | wa-js is active. whatsapp-web.js breaks on WhatsApp Web refactors: the module-system change ([#2789](https://github.com/wwebjs/whatsapp-web.js/issues/2789)) and the Sept 2026 id rename that left sessions "detached" ([#201919](https://github.com/wwebjs/whatsapp-web.js/issues/201919)) | Daily commits (2026-11-02: app-state rate-limit backoff; 2026-10-31: protocol bump). mautrix-whatsapp ships monthly (v0.2610.0, 2026-10-16) and Beeper runs it at scale | Last code change 2026-08. v7 is still a release candidate. WhatsApp's retirement of WIN32 broke it until [#2741](https://github.com/WhiskeySockets/Baileys/pull/2741) |
| What an update breaks | Our injected hook, any time WhatsApp Web ships (weekly) | A library bump when WhatsApp refuses an old version (405). The bridge also fetches the current web version at start, so that happens less | The same, plus a slower fix cadence |
| RAM per account | About 600 MB (measured on the Discord sandbox: Xvfb + Chromium) | **About 50 MB measured** (adapter 25 MB + bridge 22 MB, before linking); more during the first history sync | About 50 MB (vendor figure) |
| History on link | Whatever the web client loads | WhatsApp's own history sync for companions, then on-demand history from the phone | Same as whatsmeow; full sync needed a Desktop identity that broke in 2026 |
| Media | Pulled out of the page | Downloaded and decrypted by the library, with re-upload requests for expired media | Same |

**Chosen: (b1), whatsmeow in a sidecar.**

- There is no evidence that driving the real web client is any safer. WhatsApp's enforcement targets behaviour
  (bulk or repetitive sends, new or VoIP numbers, messaging non-contacts, posting statuses, datacenter IPs), and
  browser-based clients appeared in the same warning wave as protocol ones.
- The browser route costs ten times the RAM. It also adds a moving internal-module surface that breaks every few
  weeks. The Discord adapter needed it because Discord bans user tokens used outside its client. WhatsApp's
  multi-device protocol is the same one its web and desktop clients use.
- Among protocol clients, whatsmeow has the best track record for exactly this use: Beeper runs it for a large number
  of personal accounts. Its maintainer tracks protocol changes within days.

**Not an option: WhatsApp's own EU interoperability (DMA).** It launched in November 2025 for providers who sign
Meta's reference offer and run their own server ([TechCrunch](https://techcrunch.com/2025/11/14/whatsapp-to-launch-third-party-chat-integration-in-europe-soon),
[Meta engineering](https://engineering.fb.com/2024/03/06/security/whatsapp-messenger-messaging-interoperability-eu/)).
It has no groups and does not give you your existing chats, so it cannot serve a personal aggregator.

### Keeping the account safe

The adapter only does what a person using WhatsApp Web would cause:

- **It never marks itself online.** WhatsApp then keeps sending notifications to your phone. The cost is that typing
  indicators from others mostly do not arrive. Your own typing goes out as a chat state, which is not a presence
  ([typing.md](typing.md#whatsapp-and-why-typing-does-not-mark-you-online)).
- **It never looks up phone numbers on its own.** A number is checked only when you start a chat with it.
- **It fetches profile pictures only when one is shown**, and only for contacts, chats and groups, not for every
  stranger in a big group.
- **It never fights over a session.** If another copy of this device connects ("stream replaced"), it stops and waits
  for you to press Reconnect. Two connections taking turns looks like a broken client.
- **A temporary ban stops it.** It reports the ban, stays disconnected until the ban ends, and only then reconnects.
- **It shows up honestly** in WhatsApp → Linked devices as "dither-chat" (account config `deviceName`, `platform`).

Your part:

- Use your long-standing number from the hub at home, not from a VPS.
- Open WhatsApp on the phone at least every two weeks. WhatsApp unlinks companions after 14 days without the phone.
- Do not use dither-chat to start bulk chats with numbers that are not your contacts.

No unofficial client is risk-free, and no ban rates are published.

## Linking (the one thing only you can do)

1. Deploy (below). Then in the app: **Accounts → Add account → WhatsApp**, with a label such as "personal".
2. The first start builds the bridge with nix, which takes about a minute. Then the account page shows **Link this hub
   as a WhatsApp device** with a QR code. A new code replaces it every 20–60 s.
3. On your phone: **WhatsApp → Settings → Linked devices → Link a device**, and scan the code.
   If the only screen you have is that phone, type your number (with country code) under the code instead and press
   **Get a pairing code**. On the phone choose **Link with phone number instead** and type the 8-character code shown.
4. The account turns online. Your phone sends the history sync: chats, the recent messages in each, names and
   read state. This can take a few minutes on a big account. Groups, communities and contacts are fetched right
   after linking.

To unlink, remove "dither-chat" under Linked devices on the phone. The account then shows a new QR code. Or use the
account's `relink` action.

## What maps to what

| WhatsApp | dither-chat |
|---|---|
| Chat with a person | `direct`, native id = their JID |
| "Message yourself" | `self` |
| Group | `group` |
| Community | a `community` space. Its groups are `channel`s in it; the announcement group comes first, as `announcement` |
| Name in your address book, else the name they chose (push name) | identity display name; `contact: true` for address-book entries |
| Phone number vs LID (WhatsApp's new per-user id) | one identity. Each JID is pinned to the id it was first seen under, phone number preferred, so nobody splits in two |
| Text formatting `*b* _i_ ~s~ ```code``` ` | canonical Markdown, both ways. Mentions become `<@id>` |
| Image, video, voice note, audio, document, sticker | attachments, downloaded on demand through the hub's media proxy (`wa-media:`). Expired media is requested again from the phone |
| Reply, forward marker, mention of you | `replyTo`, `forward`, `mentionsSelf` |
| Reaction (one per person) | `reaction`; a new one replaces yours (`REACTION_RULES.whatsapp.exclusive`) |
| Edit, delete for everyone, delete for me | message re-sent with `editedTs`, `delete` |
| Disappearing messages | removed when their timer runs out; what you send in such a chat carries the timer |
| View-once media | a line saying to open it on the phone. Nothing is kept that could open or forward it |
| Poll, location, contact card, event, call log | readable text (vote on the phone) |
| Read on your phone, chat marked read or unread | `read` |
| Mute, archive | conversation `mute`, `archived` |
| Status updates, channels (newsletters), broadcast lists' own chats | not shown |

Commands: send (text, files, replies, mentions), react, edit (your own, first 15 minutes), delete, mark read (read
receipts follow your WhatsApp privacy setting), forward natively (same media, marked forwarded, your note after it),
older history from the phone, open a chat by phone number, typing. Actions: `startLink` / `refreshLink`,
`pairPhone {phone}`, `relink`, `logout`, `reconnect`, `resync`, `typing {conversation}`, `status`.

## Pieces

- `packages/adapter-whatsapp/bridge/` holds the Go sidecar (`main.go`, about 700 lines). It keeps the session
  (`whatsmeow.db` in the account dir) and prints whatsmeow's events as JSON lines. Messages go out as protojson. It runs
  the commands the adapter sends and does no mapping.
  - `package.nix` builds it, and the repo flake exposes it as `.#wa-bridge`. The adapter looks for
    `$WHATSAPP_BRIDGE_BIN`, then `dither-wa-bridge` on PATH, then runs a nix build of `package.nix` and caches the
    result per source hash.
  - The repo flake only sees files git tracks, so `nix build .#wa-bridge` works after the bridge is committed. The
    adapter's own build does not depend on that.
- `packages/adapter-whatsapp/src/` holds the mapping (`mapping.ts`, `format.ts`) and the adapter (`adapter.ts`):
  linking, reconnects, bans, commands. `state.db` keeps the alias table, the chat list, and per message the keys
  needed to reply, react, forward and download.
- Tests: `bun test packages/adapter-whatsapp`.
  - Mapping runs against fixtures the bridge prints from real whatsmeow types (`dither-wa-bridge --print-fixtures >
    test/fixtures/events.jsonl`), so field names are WhatsApp's own.
  - The adapter is driven end to end through a fake bridge process: linking, command translation, read state,
    history, media, and reconnect, unlink, ban and replaced-session handling.

### When WhatsApp changes something

If the account shows "WhatsApp says this client is too old", or a protocol error starts showing up in the adapter log,
update whatsmeow:

```sh
cd packages/adapter-whatsapp/bridge
nix shell nixpkgs#go -c go get go.mau.fi/whatsmeow@latest && nix shell nixpkgs#go -c go mod tidy
# set vendorHash in package.nix to lib.fakeHash, build once, paste the hash nix prints
```

Then restart the account. Old builds stay cached by source hash, so nothing else needs clearing.

## Not done

- Calls (whatsmeow has no calls).
- Status updates and channels (newsletters).
- Voting in polls. Polls show as text; vote on the phone.
- Typing indicators from others, mostly. WhatsApp sends them to devices marked online, and that stops your phone's
  notifications. The few that arrive are shown ([typing.md](typing.md)).
- Profile "about" texts, and the per-person "seen" receipts on your messages.
- A real link. Everything above is verified against fixtures, a fake bridge, and the real bridge up to a fresh QR code
  from WhatsApp, not against a linked account.
