# Right-click menus and forwarding

Every message, conversation, place, person, account, file and link has a right-click menu. The model is
Discord's: its item names, its order, groups with a line between them, destructive items in red at the bottom,
and the IDs last. An item is only here if this app can actually do it, so some of Discord's are missing (listed
below with the reason).

One component draws them all (`packages/web/src/ui/ContextMenu.tsx`); what each menu holds is in
`packages/web/src/ui/menus.tsx`.

## How the menu behaves

- **Desktop**: opens at the pointer, flips or shifts to stay inside the window, and scrolls if it is still too
  tall. Submenus open on hover (after 120 ms, so crossing an item does not open it) or with →, and open to the
  left when there is no room on the right.
- **Keyboard**: ↑ ↓ move (wrapping), Home and End, → or Enter opens a submenu, ← or Escape closes only the
  submenu, Escape closes the menu, Tab closes it. Items that show a letter (Reply **R**, Edit **E**, Forward
  **F**, Copy Text **C**, Delete **Del**) are picked by that key while the menu is open. Discord uses the same
  letters for actions on a focused message.
- **Closes on**: a click or a wheel turn outside it, scrolling, resizing, the window losing focus, Escape, or
  back on Android.
- **Shift+right-click** gives the browser's own menu, as in Discord (for spelling suggestions, "Inspect", and
  so on).
- **The innermost thing wins**: a right-click on an image in a message opens the image's menu, followed by the
  message's items, as in Discord. The same goes for links, mentions and the author's name or avatar.
- **Phone**: the same items in a bottom sheet (`Sheet.tsx`), opened by a long press (`useLongPress` in
  `Reactions.tsx`, the press that already opened the message sheet). Sidebar rows keep `dnd.tsx`'s rule: hold
  and lift without moving for the menu, hold and drag to move. A submenu replaces the sheet's list and adds a
  back row. The message sheet keeps what the old one had: the author and exact time at the top, six quick
  reactions, and "why did this notify" at the bottom.

## Per surface

### A message

| Group | Items |
|---|---|
| Reactions | quick-reaction row (your 4 most used here), Add Reaction › (6 + Other Reactions…), View Reactions › (who reacted, per emoji) |
| Actions | Edit Message **E** (own, where the network allows), Reply **R**, Forward **F**, Open Thread, Copy Text **C**, Copy Message Link |
| Going places | Go to Replied Message, Go to Original Message (forwards), Profile |
| Red | Delete Message **Del** (own, where the network allows) |
| Developer | Copy Message ID (the network's), Copy dither-chat ID |

Copy Message Link gives the network's own link where there is one (`discord.com/channels/…/…/…`,
`matrix.to/#/room/event`) and this app's link otherwise (Signal has none).

Left out: **Pin** and **Mark Unread** (no adapter command, and read state cannot go backwards on the networks
here), **Create Thread**, **Apps**, **Speak Message**, **Report**. The hover bar gains Forward and a More (…)
button that opens this menu.

### A conversation or channel (sidebar rows, the channel tree, the header)

Mark As Read · Profile and All Chats with Them (DMs) · About This Channel (or Group, Chat: its settings, members
and who may change what, [group-settings.md](group-settings.md)) · Search in Channel · Copy Link · Mute Channel and
Notification Settings › (Use Default, All Messages, Smart, Only @mentions, Digest, Nothing: the hub's own levels)
· Pin to Top, Add to Sidebar, Move Up/Down, Move to Folder › (with New Folder…), Take Out of folder, Hide ·
Copy Channel ID, Copy dither-chat ID.

In the inbox the menu starts with **Why it's here**: the hub's reasons for the row's place, the same ones its
tooltip shows ([inbox.md](inbox.md)). They are text, not items, so the arrow keys pass over them.

Muting sets the level to Nothing; Discord's timed mutes have no counterpart in the hub's rules, so there is
no "for 1 hour" submenu.

### A server or space (rail, Spaces list, directory, the sidebar header, categories in the tree)

Mark As Read · About This Server (where Discord has Server Settings: [group-settings.md](group-settings.md)) ·
Mute Server and Notification Settings › · the arrangement items above · Copy Link, Copy Server ID, Copy
dither-chat ID. Discord's names are used for Discord ("Server"), the network's own noun otherwise ("Space"); a
category says "Category" and has no arrangement or link. Left out: Invite (the About panel shows the link where
the network has one), Privacy Settings, Leave Server.

### A folder

Mark Folder As Read · Open/Close in Sidebar, Open as List, Rename Folder… · Pin, Move Up/Down · **Delete
Folder** (red; what is in it stays).

### A person (author, avatar, mention, member list, people list)

Profile · Message (their merged chat, or a new conversation where an account can start one) · Mark As Read ·
Copy, a submenu: Copy Username, Copy User ID and Copy Profile Link (where the network has a profile page: Discord,
Matrix, WhatsApp), or with several identities one submenu per network (with the handle when two share a network)
holding those. No Star: stars left the app on 2026-11-10 and the hub cleared them (Always notify does their job). Left out:
Mention (the composer has no way in from outside it yet), Call, Add Note, Block.

### An account (the accounts button in the rail lists all of them; account chips; "Needs you" rows)

Open Account Page · Reconnect · Disable/Enable · Copy Account ID.

### The inbox button

Mark Everything As Read. Discord's home button has no menu, but this inbox spans every account.

### Images, files and links

Open Image (the viewer) · Open Original · Copy Image (as PNG) · Save Image · Copy Link, then the message's
menu. A file the app has a viewer for (text and code, Markdown, JSON, CSV, PDF, archives: [files.md](files.md)) has
View File first. Files, video and audio say Open/Save File (Video, Audio); a file the hub only serves as a download
(HTML, SVG, anything but a picture, video, audio, PDF or plain text) has Save alone. With the desktop helper paired
([desktop.md](desktop.md#opening-links-and-files-in-your-own-apps)), every file has Open, which opens it in the
desktop's app for its type, and Open With… lists the others; in the Android app, Open offers it with the system's
chooser. A link: Open Link · Copy Link, then the message's menu; Open Link goes to the default browser through the
helper when it is on. An invite link (a click opens the New box on it, [add.md](add.md#invites-in-messages)): Preview
Invite · Open in Browser · Copy Link.

## Forwarding

**Forward** opens a dialog like Discord's: search every conversation on every account and network, pick up to
five (Discord's limit), add an optional message, Send. Each destination says how it will arrive: *Forward*
(the network's own) or *Copy* / *Copy to Matrix*. Places the composer would refuse (an encrypted Matrix room
without encryption set up) are shown greyed with the reason.

`POST /api/messages/:id/forward { targets: [{ conversationId, accountId? }], note? }` answers per
destination: `{ conversationId, ok, mode: 'native' | 'resend' | 'cross', accountId, error?, skipped? }`.

### Which account sends

The account you chose to send as in that conversation (the composer's "send as") is used when you chose one.
Otherwise, for a forward within a network, an account that can read the original as well as write the
destination is preferred, since only that account can forward natively; failing that, the hub's usual choice
(the last account you wrote there with, else any connected one). Across networks it is always the usual choice.

### Per network

| | Within the network | Into it from another network |
|---|---|---|
| Discord | **Native**: a message with no content and `message_reference: { type: 1 (FORWARD), channel_id, message_id, guild_id }`, sent through the web client's own `MessageActions.sendMessage`, whose `_sendMessage` handles forwards itself. The note follows as its own message, as Discord's dialog sends it. | text + files again |
| Matrix | **Native as far as Matrix goes**: Matrix has no forward, clients send the content again. The adapter copies the original event's content (latest edit, no reply fallback, no relations, nobody mentioned), keeps files by their existing `mxc://` URI so nothing uploads twice, and adds `dev.dither.forwarded: { room_id, event_id, sender, origin_server_ts }`, the fields MSC2723 proposes for forwards, under our own key. A file encrypted for one room is not handed to an unencrypted one (or the reverse): the adapter answers `fallback` and the hub re-uploads it instead. | text + files again |
| Signal | **The content again**: Signal has no forward either, and its own app sends the text and attachments again with nothing added, so a re-send within Signal adds no line. | text + files again |

"Text + files again" (`packages/hub/src/forward.ts`): the hub sends, through the destination account's ordinary
`send` command,

```
<note>

↪ Forwarded from **Alice** (#general · Rust, Discord)
> the original text
```

with mentions turned into plain names (nobody is pinged twice), and the files fetched through the media proxy and
handed to the destination adapter's existing attachment path. Files larger than the destination allows, or
past its count, stay behind and are reported (`skipped`).

### Showing forwards

A forward shows as a card: a bar down the side, *Forwarded* and who wrote it, the content, and where it came
from (click to go to the original if the hub has it).

- **Discord forwards to you** arrive with `message_reference.type === 1` and `message_snapshots`; the adapter maps
  them to `MessageFact.forward` and the snapshot's content becomes the body. Discord does not say who wrote the
  original; the hub fills it in when it has the original stored.
- **Matrix** forwards carrying `dev.dither.forwarded` show the same way. Other clients' forwards are plain copies
  and show as ordinary messages, as they do in Element.
- **Signal** marks nothing, so forwards from others are ordinary messages.
- **Forwards you send** are remembered by the hub (`forward_sent`, keyed by the message they became), so a copy
  sent across networks shows as a card here even though the network only has the text: the note above it, the
  original text inside it, not the attribution line.

## Verified

- `bun test packages/hub/test/forward.test.ts`: which account sends and how, the attribution text, the whole
  route through the hub (native, cross-network with files re-uploaded, size limits, fallback, refusals).
  `packages/adapter-discord/test/map.test.ts` and `packages/adapter-matrix/test/forward.test.ts` cover the
  network ends.
- `bun scripts/verify-menus.ts http://127.0.0.1:<port>` against a demo hub: menus by mouse and keyboard,
  Shift+right-click, staying inside the window, submenus, a rule set from the menu, the forward dialog, a native
  (demo) and a cross-network forward arriving as cards, and the phone's long-press sheet.
- Discord native forwarding on the throwaway account, between the two channels of its own test server, through
  a lab hub: both forwards went out through the client's `sendMessage`, came back as type-1 references with
  snapshots, were shown as forwards, and the note followed. History fetched afterwards maps the same way.
- Not verified: Matrix's native forward against a homeserver (unit-tested only), and anything on Signal beyond
  the hub's copy path, which is the same `send` the composer uses.
