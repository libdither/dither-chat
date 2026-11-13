# Roadmap

Compared with Discord, Element and Signal, from reading this code in October 2026. Value and cost are rough: **H**igh, **M**edium, **L**ow.
Status is *done*, *next*, *later*, or *blocked* (by a network or its protocol).
Everything the networks' own clients can do that dither cannot, feature by feature, from mining Discord's web client and signal-cli 0.14.8 (2026-11-12): [research/discord-gaps.md](research/discord-gaps.md) and [research/signal-gaps.md](research/signal-gaps.md).

## What is next, in order

1. **Matrix E2EE on a real account.** Built: reads and writes encrypted rooms, opt-in per account. It has only run against a local homeserver with test clients, never against Element or matrix.org.
2. **Try it on a real phone.** Install, Web Push, notification clicks and replying from one have only run in desktop Chromium. The phone layout and its gestures have run with touch input in a headless phone emulation ([phone.md](phone.md)), never in iOS Safari or on a real keyboard. No code until something breaks, and everything about notifications depends on it.
3. **Login beyond tailnet membership.** Anyone on the tailnet can read everything, which matters as soon as another person or a shared device joins it.
4. **Search reach.** Attachment filenames and embed text. Network search and index jobs are built ([indexing.md](indexing.md)) and need a live Discord test.
5. **Calls without media.** Built for Discord and Signal ([calls.md](calls.md) "Ringing"); needs a live test, and Matrix's.

## Organising and finding

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Drag to reorder the sidebar, mouse and touch | H | M | done | Hub-side, follows you across devices |
| Folders that mix networks, open and closed in the rail | H | M | done | Dropping one place on another makes a folder |
| Pin and hide; Signal groups and rooms in the sidebar | H | L | done | Hiding does not mute. Notifications are a separate setting |
| Full-screen list with seven orderings | H | M | done | Recent, active, unread, name, network, your order, category |
| Categories as yes/no questions, with overrides | M | M | done | Keywords by default, local Ollama optional, no hosted provider |
| Full-text search with filters, snippets, jump to message | H | M | done | FTS5 and a query language. Only searches what the hub has stored |
| Catch up: the conversations that need you, a card each | H | M | done | Owed or unread, in the inbox's one learned order (owed replies no longer first, 2026-11-10) and steady while you work through it; reply from the card through the composer's send path, Done, Later, Open, j/k/e/l/r keys. Replaces the Triage board; its decision view is How it sorts ([inbox.md](inbox.md#catch-up)). Verified on the demo world, not the live hub |
| Quick switcher (Ctrl+K) | H | L | done | Ranked by how well the name matches times the inbox's score; opens on the top of the inbox (docs/inbox.md) |
| Search inside one conversation, from its header | M | L | done | A button in the header, or Ctrl+F, scopes search by conversation id |
| Discord-style search: suggestions as you type, recent searches, grouped results with context, sort, more operators | H | M | done | docs/search.md. Also typo correction and arrow keys through results |
| Search Japanese and other unspaced text | H | L | done | Scans inside words, so unspaced text is found. Slower than the index on a large database; a trigram index would fix that |
| Index attachment filenames and embed text | M | L | next | Only message bodies are searched today, and a picture's alt text when no message text matches ([rich-messages.md](rich-messages.md)) |
| Search Discord and Matrix themselves, on an explicit click | M | M | done | [indexing.md](indexing.md): places in jev's order, six at a time, paced per account, hits kept. Run against the demo and the extractors' fakes, not a live account |
| Index jobs: a server, a folder of servers or a channel fetched whole, members walked, repeating | H | M | done | [indexing.md](indexing.md). Repeats fetch only what is new (history spans). Archived threads the hub never saw are not found yet. Not run on a live account |
| Signal history beyond what the hub received | L | H | blocked | A linked device gets no history |
| Reorder channels inside a server | L | M | later | The network's order is usually what people want |

## People

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Profile page: identities, shared places, recent messages, note | H | M | done | Opens from any author, member or mention |
| Merge and unmerge, with same-name hints | H | L | done | Hints never merge on their own |
| Start a new DM, from a profile or a "New message" dialog | H | M | done | Pick someone known, or type a Matrix ID or Signal number; choose which account when several can. Verified against a local homeserver and the demo adapter. Discord's is only unit-tested against a replica of the client, and Signal's only against a fake signal-cli. New Matrix rooms are unencrypted until E2EE lands |
| Join servers and groups, add people, answer requests (docs/add.md) | H | M | next | One New box for links, addresses, @names and phones; previews first, paced per account. The hub, page and protocol are done and tested against the demo adapters; no real adapter does it yet (dither-accounts builds them). Requests have their inbox row, cards, notifications and profile buttons (slice B); flagged requests show the network's words and confirm only on Accept anyway, each account's friends, contacts and follows are kept and listed in People, a DM shows a friend request either way, and Remove friend and the like ask first ("Relationships"); invite cards and QR codes are their own rows below |
| Make a group: a Discord group DM, a Signal group, a Matrix room, a Telegram group (docs/group-settings.md, "Making a group") | M | M | next | With people one account knows, on its own network; paced and logged as adding people is. The hub, protocol and demo adapters are done and tested; the page is done (New group in the palette: pick people across your accounts, where, a name; scripts/verify-groups.ts). The real adapters are in dither-accounts. No group has been made on a real network. WhatsApp is left out on purpose |
| Invites in messages (docs/add.md, "Invites in messages") | M | M | done | An invite link in a message gets a card that says what it is; Preview looks it up only on a click and joins with the New box's own card; the hub keeps previews for an hour, so a reload or another device shows them without asking again; a click on the link opens the New box on it. Works against the demo adapters until the real ones resolve |
| QR codes for joining and adding (docs/add.md, "QR codes") | M | L | done | Scan in the New box (camera, or a picture chosen, pasted or dropped) only fills the box; My code shows each account's own link as a code, built from its identity without asking the network, numbers hidden until tapped; Show QR beside a place's invite link. Signal: your username's link as a code once you set the username from your profile (signal-cli shows the link only then); tested against a fake signal-cli only |
| Discord bio, roles, mutual servers | M | M | later | A new adapter command, testable only on a live account |
| Servers: scheduled events with Interested, leaving, invite links with limits, your nickname, rules, applications and onboarding answered from a server's page ([servers.md](servers.md)) | M | M | next | Discord only. Hub, page, protocol and demo done and tested; the Discord extractor is in dither-accounts, tested against fakes of the client, never on a live account. Events go to dither-calendar through `/api/calendar/network-events`, which the calendar does not read yet |
| Change your own bio from your profile | M | L | done | Discord, Signal and WhatsApp (`setProfile`, adapters in dither-accounts); Matrix has no bio. The hub and page are tested against the demo adapter; Signal's adapter only against a fake signal-cli and WhatsApp's against a fake bridge. Signal also your name, About emoji, picture and username (PersonAbout.editable, net-gaps), untested live |
| Signal safety numbers, blocking, nicknames and notes (docs/profile.md) | M | M | done | Safety number on a profile with its code, Mark as verified, a line in the 1:1 when it changes; Block and Unblock people and groups; your nickname and note kept on Signal both ways; archived 1:1s followed (Settings → Appearance); captchas as a check card on the account. Hub and page tested with a stub adapter, the adapter against a fake signal-cli: nothing of it has run against a real account |
| Matrix and Signal extended profiles | L | L | blocked | The protocols hold little more than name and avatar |
| Presence (online, idle) | M | M | next | An adversarial feature (docs/history.md): the hub logs the `presence` event and shows it in a profile's Activity section (a list, and a band on its chart); the Discord and Matrix adapters that emit it are in dither-accounts. Signal does not report it |
| Server members seen (passive, adversarial) | L | M | done | Who your accounts' clients loaded anyway, and "seen N of M listed" on a server's About. Hub side done; Discord's emitter lives in dither-accounts. Walking the member list is an index job's (indexing.md) |
| Message counts per server, estimated | M | S | done | From stored messages only (docs/profile.md): seen, share with a Wilson interval, and on Discord a total from each channel's age and rate, with a range; none where the data cannot support one |
| People graph: who shares which servers and groups | M | M | done | From the People header (docs/people-graph.md). Links from group participants, profiles' mutual servers, and members seen when recorded; WebGL with a worker layout, capped at 6,000 nodes by default. Not checked against the live hub's data in a browser |
| Block, ignore | M | M | next | Signal's block (row above) and Discord's, through the same `block` command; Ignore on Discord (docs/account-self.md): an ignored or blocked person never alerts. Discord untested on a live account |
| Your account itself: notices, status, sessions, folders (docs/account-self.md) | M | M | next | Discord: what it wants done as cards on the account page (never done for you), your status and custom status with an opt-in Do not disturb in quiet hours, where you are signed in, its server folders brought into your sidebar once, privacy as words; its note on someone and your name, picture, pronouns and banner through Signal's shared paths. Hub and page tested on the demo world, the extractor on fakes; untested on a live account |

## Mail

Built in slices from [mail-design.md](mail-design.md) (its §12); what works now is in [mail.md](mail.md).

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Read-only mail, end to end (slice 1) | H | M | done | Inbox and Sent's newest 500 per account, kept up by events and `mail.changes`, 410 relists, threads by server id, references or subject; text bodies with quotes folded; read here only. Verified against dither-accounts' Dovecot and the fake server, not a real mailbox |
| Big mailboxes: backfill to a year, bodies ahead, eviction (slice 2) | H | M | done | A year plus all of Inbox in the background at 2 calls a second; older pages and other folders when you scroll; bodies ahead, LRU with starred mail kept. Measured on a 60k fake (docs/mail.md), not a real mailbox |
| Safe HTML, images through a proxy, attachments (slice 3) | H | M | done | Sanitised on the hub, served under a sandbox CSP into a frame without scripts; images only through the hub's proxy, after you allow them; `cid:` pictures; files in chat's viewers. Checked in Chromium on the demo, not on a real mailbox |
| Read on the server after a second, star, archive, move (slice 4) | H | M | done | Shown at once, pending until the server answers; batches of 1000; 404/403/501 handled; waits through the manager going away and a restart. Swipes, long-press selection, Undo, keys; "only when I mark it" in Settings. Verified on the fake and against dither-accounts' Dovecot, not a real mailbox |
| Sending, replies, drafts, undo (slice 5) | H | M | done | Composer, reply, reply all, forward with files, drafts on the hub, 10 s Undo, retries; a 501 turns sending off with the draft kept (Proton today). Verified through dither-accounts' SMTP sink and the fake, not a real account |
| People: email identities and persons, merge search and hint, a profile's Mail card, all mail with someone (slice 6) | H | M | done | Never merged by name. Verified against the fake server and the demo world, not a real mailbox |
| Classification and mail in the one-list inbox (slice 8) | H | M | done | §4's rules with your overrides; Inbox folds bulk into Updates, People view; threads from people rank among the chats by the same formula, tallies summed with chat. Proton's summaries have no headers: its categories classify, list headers come from bodies, and a stranger's mail in the inbox's window has its body fetched ahead and is rated quietly. Verified on the fake and the demo world, not a real mailbox |
| Search: the hub's own index, then the servers' (slice 7) | H | M | done | Mail's operators in chat's language; Proton's server cannot search text, so the hub's index matters most there. A Mail group on the search page. Measured on a made-up 50,000-message mailbox (docs/mail.md) |
| Triage and notifications (slice 9) | H | M | done | New mail from people gets its importance from chat's model, with chat's marks ("less like this" on Sam's mail moves Sam on Signal once merged): a row on the phone's list or below it, and an alert only from a sender set to Always alert; bulk never notifies; one notification per thread, quiet hours and device rules (Email off) as for chat; a sender nobody knows reaches the inbox only when on the list. Verified on the fake and the demo world, not a real mailbox; the Android app shows mail with its own mark, not an envelope, until a new build |

## Messaging

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Edit and delete your own messages | H | L | done | Verified on the demo adapter, not yet on a live network |
| Drafts per conversation | M | L | done | On each device, not synced |
| Send attachments and images | H | M | done | Paste, drop or pick. Each file uploads as it is attached, with progress and a cancel, in pieces that carry on after a dropped connection; uploads survive a hub restart; a file that cannot go says why ([uploads.md](uploads.md)). Sent live on Discord, against a local homeserver on Matrix, on the demo adapter. Signal's live send is unverified: only a fake signal-cli has seen it. In encrypted Matrix rooms only once encryption is set up. On a phone, Signal's way: + for the system photo picker or a file, a camera in the app, and a send screen with a caption (2026-11-10); checked in headless Chromium with a fake camera and in the Android app on an Android 15 emulator, not yet on a real phone |
| See what a file is, and view it in the app | H | M | done | The hub reads each kept file's type, pages, lines, entries, size and length from its bytes, in the background; text and code, Markdown, JSON, CSV, PDF (pdf.js) and archive viewers in chunks of their own, HTML, SVG and XML as source ([files.md](files.md)). Verified in headless Chromium against the demo's files, not on the live hub's or in the Android app |
| Mark all read | M | L | done | Everywhere, or per server, folder or person. A paced queue on the hub tells the networks and survives restarts |
| Typing indicator, outgoing | L | L | done | Both ways on every network, with a privacy switch ([typing.md](typing.md)) |
| What a message carries besides its text: a reply's quote from before linking, link previews, contact cards, story replies, who a send missed, files not downloaded, voice notes and captions ([messages.md](messages.md)) | M | M | done | Any network can fill them (`MessageFact.extra`, protocol extra.ts); Signal's adapter in dither-accounts does. Only signal-cli's JSON fixtures, a fake signal-cli and the hub's tests have seen them, not a live account |
| Signal: messages that could not be decrypted, Reset secure session, viewed receipts, link previews you send ([messages.md](messages.md)) | L | L | done | Viewed receipts, typing and previews follow your phone's settings, read from signal-cli's database. Previews are fetched by the hub under the media proxy's rules. Not verified live. A group message some members missed cannot be resent to only them (signal-cli has no way) |
| Pinned messages and polls on Discord and Signal: poll cards with counts, voting, making and ending polls, pin and unpin, the whole pinned list ([polls.md](polls.md)) | M | M | done | net-gaps; checked against fakes only. Discord voters are never asked for |
| Sending stickers from the picker (receiving them is done) | M | M | later | |
| Rich messages: a bot's controls, Components V2, silent messages, voice messages, spoilers, alt text, role pings, full embeds | H | M | done | [rich-messages.md](rich-messages.md): read-only (pressing a button is later); Discord only so far. Checked against fakes and a real hub Store, not on a live account |
| Calls without media: timeline events, ringing push, link out, who is in Discord voice | M | M | done (Discord, Signal) | One call model in the hub for both networks ([calls.md](calls.md) "Ringing"): a call that rings you alerts once, with Answer and (Discord) Decline, and stops on any device; call lines say missed, declined, answered elsewhere and how long; a Call button in Discord DMs and groups rings the others; who is in Discord voice channels behind the adversarial voice setting, and their status lines. Tested on fakes only, nothing live yet. Matrix calls not done |
| Matrix calls through Element Call | M | H | later | Standalone is cheapest but is a second login. Self-hosting needs LiveKit and a homeserver you control. MatrixRTC is unmerged |
| Signal 1:1 voice | L | H | later | signal-cli has it experimentally since 0.14.2, voice only, with no packaged tunnel binary (the nix build of 0.14.8 ships none), and would need a WebRTC bridge to the PWA. Declining from dither waits on it too: signal-cli tracks a call only while subscribed to call events, and then hangs up on every caller when it cannot start the tunnel ([calls.md](calls.md) "Signal") |
| Discord voice | M | H | done | Through the account's own client in its sandbox (bridge), or from the device with Discord's libdave and the hub's TURN relay (direct) ([calls.md](calls.md)). Video is not done |
| Matrix E2EE rooms: read, write, media, edits, reactions | H | H | done | Opt-in per account, with the Rust crypto library. Verified on a local homeserver only, against clients built on the same library and matrix-nio, not Element |
| Matrix E2EE: old messages through the key backup | H | M | done | Recovery key, Secret Storage key or passphrase. Keys come per session when a message needs them |
| Matrix E2EE: verifying this device | M | M | done | Emoji with another of your devices, or a Secret Storage key. No QR |
| Matrix E2EE: verifying other people, sender warnings | M | M | later | Messages from unverified senders look like any other. A plaintext message in an encrypted room is flagged |
| Discord server channels live while idle | H | ? | blocked | Discord pushes nothing for unopened channels, so they update when opened. Mentions in them are no longer blocked: see the next row |
| Discord mentions in unopened channels | H | M | done | From Discord's own recent-mentions list, asked after connecting and when its notification center says something came, at most every five minutes; triaged as live only while under ten minutes old ([notifications.md](notifications.md#from-the-network-itself)). Built against fakes only (2026-11-12, net-gaps), not yet run on a live client |
| Discord message requests and spam, mutes both ways, Mark Unread, bulk read | M | M | done | Message requests and spam DMs under Requests (spam never notifies); mutes changed in Discord arrive at once and "Mute on Discord" with a timer on a place's About; Mark Unread both ways; mark-all in bulk. Built against fakes only (2026-11-12, net-gaps) |

## Notifications

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Web Push with VAPID, per-device opt-in, test button | H | M | done | Verified through Google's relay on Chromium. iOS and Android not tried on a device |
| Unread badge on the app icon | M | L | done | Where the platform supports it |
| ntfy, fully self-hosted | M | L | done | The Android app pushes through ntfy (UnifiedPush): ntfy.sh by default, your own server allowed with one tap. The older plain-text `DITHER_NTFY_URL` topic still works |
| Reply from the notification | M | M | done | A Chromium extension, not in the Notifications standard: `type: 'text'` actions and `event.reply` confirmed in Chromium 155 on desktop, and documented for Android. Firefox has actions but no `reply`, iOS Safari has no actions, so there the notification opens the conversation. Uses the normal send, which now enforces the composer's refusals on the hub. Not offered through ntfy, where it would need an endpoint outside the same-origin check. Never tried with a real typed reply: headless Chromium shows no notification UI |
| Three tiers: Alert, Conversation, List | H | H | done | [notifications.md](notifications.md): an alert sounds and is for what cannot wait (one question to the machine's local model, set against a bar, and your marks); a Conversation is people talking with you, by rule, a silent row of its own; the list is whatever else is important enough, a silent ranked bundle, at a level you set. Two marks teach it: "should have alerted" and "less like this". Replaced the four levels, the Smart level, level votes, exploration and the daily digest notification (2026-11). Replayed on ten days of the live hub's history ([triage-replay.md](triage-replay.md)): about 3 sounds a day where there were 25 |
| Quiet hours | M | L | done | Holds alerts on a daily schedule, optionally letting people set to always alert through, with one summary when they end. Conversations and the list are silent anyway and keep coming |

## Hosting

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Installable PWA over HTTPS | H | M | done | [deploy.md](deploy.md). A private CA remains as the fallback without DNS-01 |
| Phone layout with Discord's panels and gestures | H | M | done | [phone.md](phone.md): swipe back to the page's own list (and the back buttons with it) and to the details, swipe to reply, sheets, back closes layers, image viewer, keyboard, parity audit. Emulated only |
| Links and files open in your own apps | M | M | done | Desktop: dither-desk, a paired loopback helper, sends links to the default browser and files to their apps, with Open With… ([desktop.md](desktop.md#opening-links-and-files-in-your-own-apps)). Android: a file is downloaded and offered with the system chooser. Run against a recording opener and the emulator only, not yet in the installed PWA with Floorp |
| Updates reach installed apps | H | L | done | Reload bar, or automatic when the app is out of sight |
| Public certificate through DNS-01 | M | L | done | Let's Encrypt wildcard through a Caddy on the hub's machine. No per-device step |
| Login, beyond tailnet membership | M | M | next | Anyone on the tailnet can read everything today |
| Fast on a big hub | H | M | next | [perf.md](perf.md): a harness with a baseline, the quick wins done, and the bytes and rows of a cold start, pages and the web build held to budgets in CI. Next: a switch that renders only the timeline, long timelines windowed, a smaller bootstrap |
| Offline reading of recent messages | M | M | later | The shell works offline; data does not |
| Count which buttons you press, for the redesign | M | L | done | [button-counts.md](button-counts.md): opt-in per device in Settings → Usage; per day, key, page and phone or desktop, kept on the hub only; `bun scripts/clicks.ts` prints the top. Not yet run on a real phone |
| Backups of `.data` | M | L | done | A nightly `VACUUM INTO`, the newest seven kept, and a copy before any schema change ([deploy.md](deploy.md#backups-and-upkeep)) |
| Names the hub answers to, media from public addresses only | H | L | done | A Host allowlist against DNS rebinding, and the media proxy refuses private addresses and caps sizes ([deploy.md](deploy.md#who-can-reach-it)) |
