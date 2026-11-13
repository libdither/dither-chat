# Typing indicators

Who is typing, on every network, shown the way Discord shows it, and your own typing told to the networks the way
their own clients tell it.

## What you see

- A line just above the composer: three animated dots and "**Alice** is typing…", "**Alice** and **Bob** are
  typing…", "**Alice**, **Bob** and **Carol** are typing…", or "Several people are typing…" for four or more. Names
  are bold. The line is always there, empty or not, so someone starting to type never moves the timeline
  (`ui/Typing.tsx`, the "typing" section at the end of `styles.css`). A person's merged timeline shows typing from
  any of their conversations.
- Small dots on the avatar of a DM or group row in the inbox and the people list, where Discord puts them.
- Never yourself: not your other accounts, and not an identity merged into you.
- A typer lasts as long as their network's own clients show one without a refresh (Discord 10 s, Signal 15 s, Matrix
  30 s while the server lists them, WhatsApp 25 s). A stop from the network, or their message arriving, ends it at
  once.

## Both directions

```
network ──typing {conversation, author, stop?, ttl?, name?}──▶ hub ──typing {conversationId, identityId, ttl | stop, name?}──▶ clients
clients ──POST /api/conversations/:id/typing {accountId?, stop?}──▶ hub ──command typing {conversation, stop?}──▶ adapter ──▶ network
```

- **Nothing is stored or journaled.** The hub relays typing on the live socket only (`store.ts`, `typing.ts`). It
  never goes into the change journal (docs/sync.md), the database or the snapshot: a client that reconnects just
  does not see a typer it missed. A typer the hub has never heard of (a stranger in a big channel) comes with a name
  from the network instead of a stored identity.
- **Your typing goes through the account that would send**: the send-as choice in a conversation, the chosen
  network in a person's timeline, else the account the hub would pick.
- **Throttled like Discord's client** (`TypingSender` in `packages/protocol/src/typing.ts`): a start at the first
  keystroke, again at a keystroke 8 s after the last start, and a stop when you send, clear the text, leave the
  composer or the conversation, hide the app, or type nothing for 10 s. Editing a sent message is not typing. The
  hub adds its own guard (`TypingGate`): at most one start per account and conversation every 5 s, and a stop only
  after a start, whatever its clients do.
- **Settings → Privacy → "Show others when I'm typing"** (on by default) is one choice for every network, kept on the
  hub (`GET`/`PUT /api/privacy`), which refuses a start when it is off. A stop always goes out. You still see others.

## Per network

| | Incoming | Outgoing | Verified |
|---|---|---|---|
| Discord | `TYPING_START` from the client's own dispatcher, with the server nickname or display name. Its "stop" is their message | The client's own typing action (`startTyping`, which dispatches `TYPING_START_LOCAL`; the client sends `POST /channels/:id/typing` and throttles it). A stop only clears the client's own state: Discord has no stop request | Unit tests on the hook and the mapping. Live on the throwaway account in its test server, through a lab hub: the client sent `POST /typing` (204) for a start and for the 8 s refresh. Incoming not seen live (it needs a second person) |
| Signal | signal-cli `typingMessage` STARTED and STOPPED, 1:1 and groups | `sendTyping`, with `stop` for STOPPED. Not in Note to Self, not in a message request, and not when your phone's typing-indicator setting is off (read from signal-cli's database; not known: sent, see [messages.md](messages.md#your-phones-settings-signal)) | signal-cli's JSON fixtures and the fake signal-cli. Not live: that needs your phone |
| Matrix | `m.typing` in `/sync`: each new list is compared with the last, so someone leaving it is a stop. A list the server keeps unchanged is refreshed every 20 s, for at most two minutes | `PUT /rooms/:id/typing/:user` with a 15 s timeout, `typing: false` to stop. Typing in a thread is typing in its room, as Matrix has no other | Unit tests, and live both ways against the local continuwuity testbed (`test/integration-typing.ts`) |
| WhatsApp | `chat_presence` "composing" (also when recording a voice note) and "paused". Rarely arrives, see below | A chat state ("composing", then "paused"), never a presence | Fixtures printed from real whatsmeow types, and the fake bridge. Not live: the account is not linked |

### WhatsApp, and why typing does not mark you online

The adapter never sends presence "available": while a companion device is online, WhatsApp stops sending
notifications to the phone (docs/whatsapp.md). So:

- **Outgoing**: a chat state (`<chatstate>`, whatsmeow's `SendChatPresence`) is not a presence. It is what
  mautrix-whatsapp sends by default (`send_presence_on_typing: false`, whose only other path marks you online first).
  Whether WhatsApp passes it on from a device that is not online is not documented, and could not be tested without
  a linked account. If it does not, nothing is lost: the setting's text says WhatsApp may not pass it on.
- **Incoming**: WhatsApp sends others' chat states to companions that are online. This one never is, so they mostly
  do not arrive. Whatever does arrive is shown.

## The demo world

Demo DMs that answer type first ("Mom is typing…" for a few seconds, then her reply). Sending into a demo group makes
up to four of its members type for a few seconds and stop. Background chatter types before it speaks. The demo
accounts keep the typing they are told about for the verify script (`typingLog` action).

## Verifying

- `bun test packages/hub/test/typing.test.ts packages/web/test/typing.test.ts` and each adapter's tests.
- `bun scripts/verify-typing.ts <demo hub> [shots dir]`: your typing reaching the sending account and stopping on
  send, blur and the privacy switch; "Mom is typing…" before her answer, with the row dots, and gone when it
  arrives; three typers and "Several people"; the timeline not moving; the send-as account; the phone layout.
- `DITHER_TESTBED_DIR=… bun packages/adapter-matrix/test/integration-typing.ts` against a testbed homeserver.

## Limits

- Discord: server channels report typing only while the client is subscribed to them, as with their messages
  (README, Status).
- WhatsApp, as above.
- One device typing and another one open on the same conversation: the other device does not show you typing,
  by design.
