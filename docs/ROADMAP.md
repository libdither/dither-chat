# Roadmap

Compared with Discord, Element and Signal, from reading this code in October 2026. Value and cost are rough: **H**igh, **M**edium, **L**ow.
Status is *done*, *next*, *later*, or *blocked* (by a network or its protocol).

## What is next, in order

1. **Matrix E2EE.** The largest gap for replacing Element: encrypted rooms can be neither read nor written, and most Matrix DMs are encrypted. Costly, because it needs a crypto store, device verification and key backup in the adapter.
2. **Try it on a real phone.** Install, Web Push and notification clicks have only run in desktop Chromium. No code until something breaks, and everything about notifications depends on it.
3. **Login beyond tailnet membership.** Anyone on the tailnet can read everything, which matters as soon as another person or a shared device joins it.
4. **Replying from a notification.** It finishes what Web Push started.

## Organising and finding

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Drag to reorder the sidebar, mouse and touch | H | M | done | Hub-side, follows you across devices |
| Folders that mix networks, open and closed in the rail | H | M | done | Dropping one place on another makes a folder |
| Pin and hide; Signal groups and rooms in the sidebar | H | L | done | Hiding does not mute. Notifications are a separate setting |
| Full-screen list with seven orderings | H | M | done | Recent, active, unread, name, network, your order, category |
| Categories as yes/no questions, with overrides | M | M | done | Keywords by default, local Ollama optional, no hosted provider |
| Full-text search with filters, snippets, jump to message | H | M | done | FTS5 and a query language. Only searches what the hub has stored |
| Quick switcher (Ctrl+K) | H | L | done | |
| Search inside one conversation, from its header | M | L | done | A button in the header scopes search by conversation id |
| Server-side history search on the network | M | H | blocked | Discord's search needs its client's private API; Signal has no server history; Matrix cannot search encrypted rooms |
| Reorder channels inside a server | L | M | later | The network's order is usually what people want |

## People

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Profile page: identities, shared places, recent messages, note | H | M | done | Opens from any author, member or mention |
| Merge and unmerge, with same-name hints | H | L | done | Hints never merge on their own |
| Start a new DM, from a profile or a "New message" dialog | H | M | done | Pick someone known, or type a Matrix ID or Signal number; choose which account when several can. Verified against a local homeserver and the demo adapter. Discord's is only unit-tested against a replica of the client, and Signal's only against a fake signal-cli. New Matrix rooms are unencrypted until E2EE lands |
| Discord bio, roles, mutual servers | M | M | later | A new adapter command, testable only on a live account |
| Matrix and Signal extended profiles | L | L | blocked | The protocols hold little more than name and avatar |
| Presence (online, idle) | M | M | later | Discord and Matrix report it; Signal does not |
| Block, ignore | M | M | later | Differs per network |

## Messaging

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Edit and delete your own messages | H | L | done | Verified on the demo adapter, not yet on a live network |
| Drafts per conversation | M | L | done | On each device, not synced |
| Send attachments and images | H | M | done | Paste, drop or pick. Sent live on Discord, against a local homeserver on Matrix, on the demo adapter. Signal's live send is unverified: only a fake signal-cli has seen it. Refused in encrypted Matrix rooms |
| Mark all read | M | L | done | Everywhere, or per server, folder or person. A paced queue on the hub tells the networks and survives restarts |
| Typing indicator, outgoing | L | L | later | Shown incoming, not sent |
| Pinned messages, polls, stickers from the picker | M | M | later | |
| Voice and video | M | H | blocked | Each network's media stack; out of scope for a text hub |
| Matrix E2EE rooms | H | H | next | They show as encrypted today. Needs a crypto store in the adapter |
| Discord server channels live while idle | H | ? | blocked | Discord pushes nothing for unopened channels, so they update when opened |

## Notifications

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Web Push with VAPID, per-device opt-in, test button | H | M | done | Verified through Google's relay on Chromium. iOS and Android not tried on a device |
| Unread badge on the app icon | M | L | done | Where the platform supports it |
| ntfy, fully self-hosted | M | L | done | Off unless `DITHER_NTFY_URL` is set |
| Reply from the notification | M | M | next | Android and desktop allow actions with input; iOS does not |
| Quiet hours | M | L | done | Holds pushes on a daily schedule, optionally letting starred people through, with one summary when they end |
| Daily digest delivered as one notification | M | M | done | Off by default, at a local time. Counts and the busiest places since the last one, and nothing on a day with nothing. Quiet hours hold it until they end, and it replaces their summary. Catches up once after downtime |

## Hosting

| Feature | Value | Cost | Status | Notes |
|---|---|---|---|---|
| Installable PWA over HTTPS | H | M | done | [deploy.md](deploy.md). A private CA remains as the fallback without DNS-01 |
| Updates reach installed apps | H | L | done | Reload bar, or automatic when the app is out of sight |
| Public certificate through DNS-01 | M | L | done | Let's Encrypt wildcard through a Caddy on the hub's machine. No per-device step |
| Login, beyond tailnet membership | M | M | next | Anyone on the tailnet can read everything today |
| Offline reading of recent messages | M | M | later | The shell works offline; data does not |
| Backups of `.data` | M | L | later | |
