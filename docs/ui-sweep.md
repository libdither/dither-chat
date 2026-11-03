# UI sweep, 2026-11-03

A walk through the whole web app on fresh demo hubs, in headless Chromium (`scripts/browser.ts`), at 1440×900,
1024×700 and 390×844 (touch), in Dither dark, Dither light, Discord dark, AMOLED, High contrast light and
Solarized light. Every view and most transient states were screenshotted and looked at; the list below is what
was found, what was done, and what was left and why.

Screenshots are in `/tmp/dither-sweep/` (not in the repo):

- `before/` and `after/`: `<size>-<theme>-<view>.png` for every route (inbox, DM, group, notes, server, channel,
  forum, thread, Matrix room, WhatsApp group, folder, people, person, profile, directory, spaces, triage, accounts and
  each account, settings, search, empty search), `i-<theme>-<state>.png` for transient states (hover bar, message
  menu and keyboard, forward dialog, emoji picker, `:` autocomplete, long/RTL/list/code messages, toast, Ctrl+K,
  theme picker, new message, rail sort menu, Organize, an open folder, image viewer, voice channel, focus rings,
  every settings section, hub unreachable, a send while offline, person menu).
- `before/phone/`, `after/phone/`, `before/menus/`, `after/menus/`, `after/inbox/`: the screenshots
  `verify-phone.ts`, `verify-menus.ts` and `verify-inbox.ts` save (sheets, the details panel, swipe states).
- `before/real-matrix-*.png`: a Matrix account on a throwaway hub without `--demo` (a fake account pointed at a
  closed port), for the error state, the "Needs attention" block and the Encryption section, which demo accounts
  never show; and the empty inbox, people list and directory of a hub with no data.

No console errors or warnings on any route at any size (the only errors were the expected
`ERR_INTERNET_DISCONNECTED` while the offline state was being tested). No long tasks were reported on navigation.

## Fixed

| # | Found | Fix | Before → after |
|---|---|---|---|
| 1 | **Rail: closed folders were not full width**, so their unread pill sat on the tile's left edge instead of the rail's, and their count badge sat in the middle of the tile instead of at its corner like every other badge | `.rail-folder { width: 100% }` | `before/wide-dither-dark-inbox.png` → `after/wide-dither-dark-help.png` |
| 2 | **Rail: a folder's emoji was drawn on top of its 2×2 mini icons**, covering them | A closed folder shows only its minis (as Discord's does); the emoji replaces the generic folder icon when it is open | same |
| 3 | **Rail: the unread count covered the network badge**, which peeked out from behind it | The network badge hides while a count is shown; counts get a ring of the rail's colour, cut out of the icon as in Discord | same |
| 4 | **Rail: a closed folder did not show where you are** when the open server or chat is inside it | It takes the active pill and shape, as in Discord | `after/wide-dither-dark-help.png` (Rust folder) |
| 5 | Rail: a folder with fewer than three items stretched its minis into tall slivers | `grid-template-rows: 1fr 1fr` | `after/wide-dither-light-channel.png` |
| 6 | **Dither light: the rail's buttons were white discs on the dark rail**, and the sort button's icon was faint on it | New theme tokens `--rail-btn`, `--rail-ink`, `--rail-active`, `--rail-active-ink`: derived from the rail when it is far from the list's colour (only Dither light today), the list's otherwise. Checked at AA by `themes.test.ts` | `before/wide-dither-light-channel.png` → `after/wide-dither-light-channel.png` |
| 7 | **Header breadcrumbs had uneven gaps** ("Rust Programming Language ␣␣› Help ›␣␣#help"): the links were `<button>`s with the browser's padding | `padding: 0` on crumbs | `before/wide-dither-dark-thread.png` → `after/wide-dither-dark-thread.png` |
| 8 | At 1024 px the breadcrumbs wrapped onto a second line, splitting "via" from them | One line: the server's name gives way first (ellipsis, never below a few letters), categories and the network stay whole; a phone keeps its fade | `before/narrow-dither-dark-channel.png` → `after/narrow-dither-dark-channel.png` |
| 9 | **Triage's "Mark all read" wrapped to three lines** at 1024 px | `.btn` never wraps its label; the header text takes the slack | `before/narrow-dither-dark-inbox.png` → `after/narrow-dither-dark-inbox.png` |
| 10 | **Settings, a profile and an account page had their scrollbar in the middle of the window**: the scrolling box itself had the 760 px reading width | The box is full width; its children keep the reading width | `before/wide-dither-dark-settings.png` → `after/wide-dither-dark-settings.png` |
| 11 | An account page's status pill and "N capabilities · added …" were pushed to the far right under the title (a `margin-left: auto` meant for list rows) | Left-aligned under the title | `before/wide-dither-dark-acct-whatsapp-personal.png` → `after/…` |
| 12 | "Carries 1 spaces", "1 places across your accounts" | Singular forms | same |
| 13 | **A forum post's preview showed a raw mention**, `Bea: <@1045047754069182781> that's clean…`; thread chips under a message, sidebar previews and triage cards could show raw Markdown (`**`, ```` ``` ````, `[text](url)`) | One plain-line helper (`plainBody` / `plainMarkdown` in `model.ts`) used by all of them | `before/wide-dither-dark-help.png` → `after/wide-dither-dark-help.png` |
| 14 | **Search results showed raw Markdown** (```` ```rust fn … ``` ````, `**New stable release is out!**`, `[code of conduct](https://…)`) | Snippets go through `plainMarkdown`, keeping the highlighted matches | `before/wide-dither-dark-search.png` → `after/wide-dither-dark-search.png` |
| 15 | **Right-to-left messages were laid out left to right**, scrambling Hebrew with an English word inside | `unicode-bidi: plaintext` on message bodies, row previews and ping cards: each paragraph takes its direction from its first letter, as Discord does | `before/i-dither-dark-long-messages.png` → `after/i-dither-dark-long-messages.png` |
| 16 | **Markdown lists were not rendered** (`- one` stayed a dash), unlike Discord | `markdown.ts` renders consecutive `- ` / `* ` lines as a list, and a blank line between a quote and a list still shows; `test/markdown.test.ts` | same |
| 17 | **The Forward dialog's search box was not focused** on open, so typing went nowhere: Preact leaves `autoFocus` to the browser, which honours it only during page load | Focused in an effect, on a desktop only (no keyboard popping up on a phone) | `before/i-dither-dark-forward-search.png` → `after/i-dither-dark-forward-search.png` |
| 17b | The Forward dialog jumped up and down while typing in its search, as the list shrank and the centred dialog re-centred | The list has a fixed height | `after/i-dither-dark-forward-search.png` |
| 18 | Every channel in a server seen through one account repeated that account's dot, which the header's "via" already says | Dots in the channel tree only when the server is seen through more than one account | `before/wide-dither-dark-channel.png` → `after/wide-dither-dark-channel.png` |
| 19 | A server with no channel open said "Communities — Pick a channel from the server or space on the left"; a folder said "Folder" | The server's or folder's own name | `before/wide-dither-dark-space.png` → `after/wide-dither-dark-space.png` |
| 20 | Copy listed three networks ("across Signal, Discord and Matrix") in the People list, the People welcome and Settings → About; WhatsApp was missing | "across every network"; About lists all four | `after/wide-dither-dark-people.png` |
| 21 | The People pane on an empty hub said "Pick a person…" with nobody to pick; the directory said "Nothing matches" with no filter set | "No one here yet" / "Nothing here yet" with a line on when they fill | `before/real-matrix-empty-*.png` |
| 22 | The title bar used a person icon for Accounts (the rail uses power) and `#` for threads, forums and voice channels (the header uses their own icons) | Same icons as the rail and the header | — |
| 23 | Search's From and In fields were blank boxes | Placeholders "Anyone", "Anywhere" | `after/phone-dither-dark-search.png` |
| 24 | On a phone, in a person's merged chat, the "send as" chip (network, account name, chevron) squeezed the message field into a narrow column that wrapped its placeholder over four lines | Below 820 px the chip shows the network's mark and the account's dot only; its menu still spells them out | `before/phone-dither-dark-person.png` → `after/phone-dither-dark-person.png` |

## Looked at and left as is

| Found | Why left |
|---|---|
| A profile has two ways to star someone: the "Star" button with the other actions and the "Star" checkbox under Notifications | The checkbox sits beside "Always notify, without starring" and explains what a star does; the button is the quick action. Both show the same state |
| An account page says "Online" twice (header pill and Connection → Status) | The header pill is what you see first; the table is the full record. Harmless |
| The open folder's tint spans the whole rail width; Discord's is a narrower pill around the icons | Narrowing it would move the unread pills of the items inside off the rail's edge. Not worth a structural change |
| Mini icons in a closed folder show clipped initials ("RP", "CC") | 16 px tiles; Discord's minis are the same size and use pictures. Servers with icons look right |
| The digest icon is shown on every channel left at Digest | It is the "muted" marker; a server defaulting to Digest marks all its channels. Correct, if busy |
| Voice channels say "Voice isn't relayed" and the call dock could not be exercised | Demo accounts have no call capability; calls are covered by `scripts/verify-call.ts` against a real setup (docs/calls.md) |
| WhatsApp's link card (QR / pairing code) | Only shown for a real, unlinked account; a demo hub refuses to add accounts, and starting the real bridge contacts WhatsApp. The Matrix error, "Needs attention" and Encryption section were checked on a throwaway non-demo hub instead |
| Phone sheets put icons on the left, desktop menus on the right | That is Discord's own split between its apps |
| Very long code lines scroll inside their block; long words and URLs wrap anywhere | As intended |
| The composer itself (layout, buttons) | Being changed in parallel (typing indicators); only the phone "send as" chip's text was hidden, in CSS |

## Verified

- `bun test` (602 pass), `bunx tsc --noEmit -p packages/web`.
- `scripts/verify-phone.ts`, `verify-menus.ts`, `verify-inbox.ts`, `verify-sync.ts`, each on its own fresh demo hub: all
  passed.
- `themes.test.ts` now also checks the rail's icons on their buttons, on the rail, and hovered or selected, in every
  theme.
