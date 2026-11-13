# Rich messages: what a message carries beyond its text

A message is more than its text and files. A bot puts buttons and selects on it, or writes it only in components
(Discord's Components V2), so it has no text at all. Its sender may have sent it silently. A picture may carry alt
text, be a spoiler, or be flagged as explicit. A voice message has a length and a waveform. An embed has a colour, a
footer, a time and a video. The text may ping a role, name a time, or link to another message. This page says what
dither keeps of all that and how it shows it. Discord is the only network that sends most of it today; the shapes are
the protocol's, so another adapter can fill them in (Telegram's silent messages, Signal's voice notes).

Everything here is read-only. Nothing is fetched to show it: what the network's own client received is what there is.

## What comes through

| What | Protocol | Hub | Web |
|---|---|---|---|
| Sent silently (Discord's @silent) | `MessageFact.silent` | kept in the message's `extra`; triage never alerts on it | a crossed-out bell beside the time |
| A bot's buttons and selects | `extra.components` (rows of `ButtonFact` / `SelectFact`), `extra.application` | passed on as `MessageView.rich` | drawn under the message; link buttons open their link, the rest say they cannot be pressed from dither yet |
| Components V2 (no content, no embeds) | flattened by the adapter into `body` and `attachments` | as any message | as any message |
| Only you can see it, the server's own, a suspended author, previews hidden | `extra.marks` | previews hidden: no embeds in the view | small words beside the time |
| A crosspost from a followed channel | `extra.crosspost` (channel and server names) | `rich` | "from #channel in Server" above the text |
| "X used /cmd" | `extra.interaction` | `rich` | a line above the text |
| An activity invite | `extra.activity` | `rich` | a line under the text: answer it on the network |
| Roles named as `<@&id>` | `extra.roles` (name and colour) | `rich` | `@Role` in its colour |
| A ping to a role you hold | the adapter sets `mentionsSelf` | a mention, as everywhere | a mention |
| Alt text | `AttachmentFact.alt` | the attachment's `alt` column, searched | the picture's alt and title, and an ALT mark on it |
| A spoilered picture or video | `AttachmentFact.spoiler` | the attachment's `extra` | blurred, "Spoiler" on it, until clicked |
| Explicit media | `AttachmentFact.explicit` | the attachment's `extra` | blurred, "May be explicit", until clicked |
| A voice message | `AttachmentFact.voice` (seconds, waveform as base64) | the attachment's `extra` | a player: play and pause, the waveform filling as it plays, a click on it seeks, the length |
| Embeds in full | `EmbedView` color, footer, footerIcon, timestamp, authorIcon, authorUrl, video | pictures through the hub's media proxy | a colour bar, the author's icon, the footer with its icon and time, and a video |
| A link to a Discord message the hub has | none: the hub reads the body | `rich.linked` | a quote under the message; a click opens it there |
| `<t:…>` timestamps | the body as it came | as it came | in the style asked for (t, T, d, D, f, F, R), a relative one moving on as the list does |
| `<id:guide>`, `<id:customize>`, `<id:browse>` | the body | the body | "#Server Guide", "#Channels & Roles", "#Browse Channels" |
| Numbered and nested lists | the body | the body | `1.` lists keep their first number; two spaces nest a list in the item before |

A message link the hub has no message for stays a link: the hub never asks the network for it. One it has, but
deleted, also stays a link.

## Silent messages and notifications

Triage decides as it always does ([notifications.md](notifications.md)), and then a message sent silently that came
out as an alert is put back where it would be without the alert: a Conversation, or a row on the list, both silent.
Its first reason says so: "Sent silently: it never alerts". This holds against your own rules too (a keyword or a
person set to Always alert), as Discord's own @silent does: the sender asked that it not sound. It still counts as
unread, and a mention in it still counts as a mention.

## A bot's controls, and pressing them later

Controls are kept so that a later `interact` command can press them without a new shape: each control has its `id`
(Discord's `custom_id`), the message has its `application` (the bot's application id), and a select says what it
picks from (`string`, `user`, `role`, `mentionable`, `channel`) with its options. Pressing is not built: a non-link
button is drawn disabled, and a select opens to show its options and says it cannot be used from here yet.

A Components V2 message is flattened by the adapter: text displays become paragraphs, a container is a block (a
spoilered one's text becomes `||…||` and its files spoilers), a separator with a divider is a `───` line, media
galleries and thumbnails are pictures with their descriptions as alt text, and a file is an attachment. A file the
message carries anyway (`attachment://name`) is not added twice: the component's description and spoiler go onto it.

## Video embeds

A video embed whose video is a player page (YouTube, Twitch, Vimeo) shows its thumbnail with a play button, and loads
the player only when clicked: nothing of the player's site is loaded before. YouTube's is loaded from its no-cookie
host, and Twitch's is told the page it is on (it refuses to play otherwise). The frame is sandboxed. Any other video
plays from Discord's own media proxy (never from the host the embed names), and a GIF embed (`gifv`) loops silently.

## Web code

`ui/rich/parts.tsx` is in the main bundle: the lines above the text, the marks, the veil over spoilers and the ALT
mark. `ui/rich/Rich.tsx` is a chunk of its own, loaded the first time a message has controls, a linked message, an
activity invite, a voice message or a video: the controls, the quotes, the player and the video. It uses classic JSX
and takes the app's helpers as a `kit` prop, so loading it splits nothing off the app's start.

## Discord specifics

What the Discord extractor (dither-accounts `extractors/discord`) reads, all from what the client already has:

- `flags` on the message: SUPPRESS_NOTIFICATIONS, EPHEMERAL, SUPPRESS_EMBEDS, IS_CROSSPOST, IS_COMPONENTS_V2,
  IS_GUILD_OFFICIAL, HIDDEN_SUSPENDED_USER; on attachments IS_SPOILER and CONTAINS_EXPLICIT_MEDIA (and a `SPOILER_`
  file name).
- `components`, from the gateway's raw object or the client's own record (camelCase); `application_id`.
- `mention_roles`, and the names and colours of the roles a message names from the client's role store.
- Your own roles in each server from the client's member store, for you only: in the snapshot, with a server joined
  (GUILD_CREATE), and as GUILD_MEMBER_UPDATE of you changes them. No member request is made.
- `interaction_metadata` (or the older `interaction`), `activity` and `application`.
- `description`, `duration_secs` and `waveform` on attachments; `color`, `footer`, `timestamp`, `author.icon_url`
  and `video` on embeds, Discord's proxies preferred.
- MESSAGE_DELETE_BULK (a moderator's purge) deletes each message; MESSAGE_REACTION_ADD_MANY adds each reaction (poll
  votes that come the same way are left to polls).
- A send AutoMod blocks (Discord's codes 200000 and 200001) comes back as "This server's AutoMod blocked it: …".
- System message types that read as generic or wrong before (13 a stream, 14 to 17 Server Discovery, 22, 25 to 41,
  45, 64, 66 and Discord's notices) have words.

## Not built

- Pressing buttons and selects (a later `interact` command), modals.
- Polls and their results, pins, DM call messages: other work owns them.
- Edits pushed while idle in channels the client has not opened: Discord sends MESSAGE_UPDATE only for channels the
  client subscribed to, and getting them otherwise would be traffic a person's client does not make.

## What was checked, and what needs a live check

Checked: the extractor's tests with hand-written raw and record shapes (`extractors/discord/test/rich.test.ts`,
`hook.test.ts`), one of them feeding the facts into a real hub Store; the hub's tests (`packages/hub/test/rich.test.ts`:
silent triage, attachments, embeds, `rich`, linked messages, alt-text search); the web's Markdown tests; a web build
within its budgets. Not checked: any of it against a live Discord account. The shapes of the client's records for
components and embeds were read from its code, not seen live.
