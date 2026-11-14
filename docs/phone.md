# dither-chat on a phone

The phone app is the installed PWA: the same Preact components as on a desktop, laid out differently below
820px wide. There is no native wrapper and nothing here needed one.

![Home: the rail, the list and the tab bar](screenshots/36-phone-home.png)

## How it is laid out

Discord's app is the model. The rail (Inbox, People, then your servers, spaces and folders) and the
list beside it sit underneath. The page you open, a conversation, a profile, an account, is a card that
slides in over them. A tab bar along the bottom shows whenever the lists do:

| Tab | What it is |
|---|---|
| Home | The rail and the list you were last on |
| Catch up | The conversations that need you, a card each to answer, mark Done or put Later; accounts that need you; Mark all read; How it sorts |
| Search | Search with every filter; a search for a name also lists matching people, communities and channels |
| You | Settings, with your accounts first and Add account |

The card and the panels are moved by `src/ui/Pager.ts`; `src/gesture.ts` holds the arithmetic (axis lock,
release velocity, when a swipe commits, rubber banding) and is unit tested. `src/phone.ts` has the layers the
back button closes, the keyboard handling and the sheet drag. Wider than 820px nothing of this applies, and
the desktop is unchanged apart from the fixes listed below.

## Gestures

| Gesture | Where | What it does |
|---|---|---|
| Swipe right | Any page, from the edge or anywhere | Back to the page's own list (below), never to whatever was open before it. The page follows the finger and settles beside the list with its edge showing, as in Discord |
| Swipe left from the edge, or tap it | A page left peeking beside the list | Brings it back. A left swipe on the list beside it brings it back too, except on an inbox row that can be marked, which takes the swipe (next line) |
| Swipe an inbox row left | Inbox | Its reply mark: "No reply needed" on a row with ↩, "Reply needed" on any other, shown under the row as it slides; Undo on the toast ([inbox.md](inbox.md) "Marks"). A tick when it crosses the line |
| Swipe left | A page with details (conversation, person) | The details panel: source, accounts, notifications, members, threads |
| Swipe right, tap the page, or back | The details panel | Closes it |
| Swipe a message left | Conversation | Reply to it. A tick when it crosses the line |
| Long-press | A message | Its action sheet (below) |
| Long-press | A reaction | Who reacted |
| Long-press, or hold and drag | A rail entry, a row, a card in All communities | The arrange sheet; or drag to reorder and make folders |
| Drag down | A sheet's grabber or header; anywhere in it once scrolled to its top | Dismisses it. A short drag springs back |
| Pull down | The top of a list or Catch up | Reloads everything from the hub, or reconnects |
| Pinch, double-tap, drag | An image | Zoom and pan, up to 5x, or to twice the picture's own pixels where that is further. A double tap on a long screenshot or a panorama fills the screen's width (or height) |
| Swipe sideways, swipe down | An image | Next or previous image of the message; close |
| Flick sideways or up | A toast | Dismisses it |

Every motion is a transform that follows the finger, and the release decides by distance and by speed: a
quick flick commits, a slow short drag springs back, and the rest of the way takes as long as the finger's
speed implies. With `prefers-reduced-motion` the panels and sheets still follow the finger, but settle at once
and open without animating. `navigator.vibrate` ticks on a long-press, on a reply swipe crossing its line and
on a pull crossing its line, and nowhere else.

**Back.** Every sheet, menu, dialog, viewer and the details panel is a layer with a history entry of its own,
so Android's back button (or `history.back()`) closes the top one before it leaves the page. Navigating from
inside one takes over its entry instead of stacking a new one. The palette ([palette.md](palette.md)) is one layer
whose entry is made again while pages are left, so back takes one page off at a time and closes it at its bottom
page. Installed iOS apps have no back gesture of their own; the swipe right is it.

Leaving a page, as in Discord, shows the list it belongs to: a channel's server, the inbox for a conversation
opened there (a notification opens one there too) and for Requests, People for a person, Mail's list for a
thread, and for a conversation opened from search the list it lives in. The swipe, the page's back button and the phone's back
button all do this. A list's page keeps its list right under it in history: opening one from anywhere else (a
search hit, a link, a notification, another server's channel) writes the list's entry and then the page's, and
the entry the app opened on gets the same. So the phone's back from the page shows the list with the page
peeking, and back once more goes to whatever was open before. Where the entry before a page is not its list
(history from a wider window), the swipe puts the list in the page's place. A profile, a place's About page, a
search in one conversation, an account page and All communities open on top of the page you were on, as
Discord opens a profile or a search over the channel: back closes them onto that page, or goes to their list
when they were opened directly. `src/pages.ts` decides all of this and is unit tested.

**Keyboard.** The viewport asks Chromium to resize the layout for the keyboard
(`interactive-widget=resizes-content`). Where only the visual viewport shrinks (iOS Safari), the app is
sized and moved to it while a field has focus, so the composer sits just above the keyboard. Fields are 16px
so iOS does not zoom into them. The notch and the home indicator are kept clear with the safe-area insets;
while the keyboard is up the bottom inset is dropped and the tab bar steps aside. On a touch keyboard Enter makes a new line (there
is no Shift+Enter) and the send button sends; Ctrl+Enter also sends.

**The message box** grows with the text, as Discord's does, up to about five lines on a phone and never more than
40% of what is visible above the keyboard; past that it scrolls inside. It shrinks as text is deleted and is one
line again after a send. The desktop keeps its ten lines (220px), also held to 40% of a short window. The cap is CSS
(`max-height` against `100dvh`, which the keyboard resizes, or phone.ts's `--app-h` on iOS), so the keyboard opening
or the window changing needs no measuring. Chromium sizes the box to its text by itself (`field-sizing: content`);
other browsers measure it as the text changes, never while it is empty (`ui/grow.ts`). Catch up's reply box works
the same way.

Before, the box was measured to its text and held at a fixed 220px, about nine lines at a phone's 16px. With the
keyboard up that was half of what was visible, so a long message, a pasted one or a long draft restored from Catch
up or a reload pushed the timeline to nothing; with files or a reply above it on a small phone the send button went
under the keyboard. It happened only with long text and the keyboard up, hence "sometimes".

## Parity: everything the desktop does, on a 390x844 touch screen

"Before" is the phone layout as it was before this work: five tabs (Inbox, People, Groups, Spaces, More),
no rail, hover actions hidden, a long-press sheet with reactions, reply, copy, edit and delete.

| Desktop capability | How on a desktop | Before, on a phone | Now, on a phone |
|---|---|---|---|
| Inbox: one ranked list of DMs, groups, rooms outside a space and notes ([inbox.md](inbox.md)) | Sidebar | Inbox tab | Home, Inbox in the rail |
| Catch up: the conversations that need you, to answer, Done or Later | Center pane with nothing open | **Unreachable**: the inbox tab showed the list | Catch up tab |
| How it sorts: Alerts, Conversations, List and Below the list, each line with its two marks, and the counts | Catch up's header, the inbox button's menu, Settings | **Unreachable** | Catch up's header, Settings |
| Mark all read, everywhere | Catch up's header | **Unreachable** | Catch up tab; per place in its arrange sheet |
| People, merged DM timeline, one network's chat | Rail, sidebar, header chips | People tab; chips wrapped | Rail; the chips scroll sideways, and the details panel lists each chat |
| Group chats (now in the inbox), spaces with channel trees and threads, folders | Rail and sidebar | Groups and Spaces tabs, no rail | The inbox, and the rail and its list, as in Discord |
| Open a folder in the rail; open it as a list | Click; arrange menu | Spaces tab | Tap in the rail; arrange sheet |
| Arrange: drag to reorder, folders, pin, hide, move up/down, rename, delete folder, add a group to the sidebar | Drag; right-click menu | Hold and drag; popup menu sized for a mouse | Hold and drag; the menu is a bottom sheet |
| All communities: seven orderings, network filter, hidden places, manual order by drag | Rail grid button | Spaces tab | Rail grid button; chip rows scroll sideways |
| Categories: edit the questions, per-place yes/no/auto | Dialogs | Centered dialogs | Bottom sheets |
| Per-place notification rule, whole server | Header menu | Small dropdown | Bottom sheet |
| Per-place overrides list, clear one | Settings | More tab | You tab |
| Conversation header: where it is, via which account, search in it, profile, details; a direct conversation says where your message goes (the network, your account), and someone reached by several routes adds a pill (`+7 ▾`, `only this ✕`) that opens the list of their chats (docs/chats.md) | Header | Wrapped to four lines | One line that fades; "via" is in the details panel; Profile in the details panel; the list of chats stays, unfaded |
| Details panel: source, accounts, native id, open in the network's app, notification rule, members, threads | Toggle in the header | Full-screen overlay | Swipe left, or the header button; a panel with the page peeking |
| Person details: identities, split, merge, always alert, chats | Details panel | Full-screen overlay | Panel |
| Profile and the merge flow | Avatar, member or mention | Reachable | Reachable; swipe back |
| New message (start a DM), send-as account, join, add, scan, add people to a group | Plus in the Inbox and People headers, Ctrl+K's "New…"; the palette's New page ([palette.md](palette.md)) | Centered dialog | Plus in the headers; the palette as a bottom sheet, each page a step the back button undoes; the keyboard only on New itself |
| Make a group (pick people across your accounts, where, a name) | New group in the palette's New and Ctrl+K ([group-settings.md](group-settings.md), "Making a group") | **Unreachable** | The palette's New group pages as a bottom sheet; a back arrow and the whole title in place of the crumbs; the keyboard only on the name |
| Quick switcher | Ctrl+K, the title bar's button | **Keyboard only** | Search tab: searching a name lists people, communities and channels to jump to; the palette's root is the crumb before New |
| Search with filters, scope to one conversation, jump to a message | Sidebar box, header button | Reachable | Search tab; searching a conversation is a page with a way back to it |
| Hover bar on a message: three reactions, picker, edit, delete, reply | Hover | Long-press: reactions, reply, copy, edit, delete | Long-press: also the author's profile, the thread, the message it replies to |
| Exact time of a grouped message | Hover | **Hidden** | Sheet header |
| Which account a message came through, its encryption warning, the author's handle | Tooltips | **Hidden** | Sheet header; profile |
| Which tier a message landed in and why, and the two marks | The bell among its hover actions; its menu | **Invisible pill** for silent and digest | Sheet: the reasons and both marks |
| Who reacted | Right-click a pill | Long-press | Long-press, as a sheet |
| Reaction picker, skin tone, super reactions, search | Popover | Sheet without drag | Sheet that drags away |
| Reply, edit, cancel either | Hover bar; Escape | Sheet; X | Swipe or sheet; X |
| New line in a message | Shift+Enter | **None**: Enter always sent | Enter |
| Attach files: pick, paste, drop | Button, paste, drop | Button, paste | + for Photos & videos (the system photo picker) or File; a camera in the box; a send screen with the media large and a caption, as in Signal ([uploads.md](uploads.md#on-a-phone)); paste (dropping files is desktop only) |
| Images | Opened a new tab | Left the installed app | Viewer: zoom, pan, page, swipe down; "Open the original" |
| Threads, forums, voice text chat, jump to latest, older history | Click; scroll | Reachable | Reachable; older history loads as you scroll, with a skeleton |
| Accounts: status, add, restart, disable, log, remove | Rail button | **Unreachable** except through a "needs you" row | You tab: accounts first, Add account |
| Account live view with paste, fit or actual size | Account page | Reachable only when it needed you | Reachable; back closes it |
| Signal link code, full screen | Account page | As above | Reachable; back closes it |
| Matrix encryption setup, recovery key, emoji verification | Account page | As above | Reachable. Not in the demo, so checked in the code only |
| The list's level, your rules, notifications while open | Settings | More tab | You tab; the section list on a desktop now scrolls to each section |
| Web Push opt-in, devices | Settings | More tab | You tab |
| Quiet hours | Settings | More tab | You tab; time fields at 16px |
| Keywords that always alert | Settings | More tab | You tab |
| Theme, demo accounts, reset demo | Settings | More tab | You tab |
| Any one Settings section (Message history, Adversarial features) without scrolling past the rest | Section list beside Settings | More tab, scrolled | Sections in Settings' header: a sheet of the sections, two taps |
| Adversarial features' warning and its Yes | Dialog | Not there yet | Bottom sheet whose words scroll, Yes pinned at its bottom |
| Toasts, open the conversation from one | Bottom right | Covered the composer | At the top; tap to open, flick to dismiss |
| Unread and mention badges | Rail | None on the tabs | Rail, and the Home and Catch up tabs; You has a dot when an account needs you |
| Collapse sections and categories | Click | Tap, under 44px | Tap, 40-44px |
| Escape closes things | Keyboard | Nothing | Back button, swipes, tap outside |

Also fixed on the way, on every screen size: a message held for the digest had an empty line under its
author (the pill borrowed the digest card's padding), and the settings list on the left did nothing.

**Left as they are.** Folder names and confirmations use the browser's own `prompt` and `confirm`, which
phones show as system dialogs: they work, but are not styled like the rest. Dropping files onto the composer
has no phone equivalent beyond the attach button and paste. A phone held sideways is wider than 820px and
gets the desktop layout, with finger-sized targets. The live view of a sandboxed client works on a phone,
but solving a captcha on a phone-sized copy of a desktop browser is fiddly. The old Spaces tab is gone; the
rail does its job, and hidden places are under Hidden in All communities.

## Checked how

`bun scripts/verify-phone.ts <demo hub url> [screenshot dir]` drives a private headless Chromium emulating a
390x844 phone (mobile metrics, touch emulation, a 47px notch and a 34px home indicator) with real touch input
through `Input.dispatchTouchEvent`. Run it against a fresh demo hub:

```sh
bun run web:build
bun packages/hub/src/main.ts --demo --data "$(mktemp -d)" --port 8470 --host 127.0.0.1 --web packages/web/dist
bun scripts/verify-phone.ts http://127.0.0.1:8470 docs/screenshots
```

It swipes the card back and forward and checks it follows the finger mid-swipe, that a short slow swipe
springs back and a short fast flick commits; opens and closes the details panel by swipe, button and back;
swipes a message to reply; long-presses for the sheet, checks what it carries, and that sliding the finger
on afterwards does not drag the page under it; long-presses a reaction for who reacted; drags sheets and dialogs
away and lets a short drag spring back; walks the back button through a sheet, then out of the conversation,
then forward; pinches, double-taps and swipes away the image viewer; swipes back from a profile, an account
and a scoped search; goes back from pages that used to land elsewhere (a search hit, a channel in another
server opened by a link, a DM opened by a notification while the app was open and one the app started on) by
swipe, back button and `history.back()`, and checks each shows the page's own list with the card sent to peek;
shrinks the layout (Android) and the visual viewport (iOS) under a focused composer; pulls a list to refresh
and waits for the hub; flicks a toast; and on every main screen, scrolled top to bottom, checks nothing scrolls
sideways or runs off the right edge; and that touch targets in the tab bar, rail, lists, conversation header,
composer and settings are 40px or more.

`bun scripts/verify-composer.ts [--port 8690]` checks the message box's size on a demo hub of its own: typed,
pasted, deleted, sent, restored from a draft and with files attached, with the keyboard imitated for Android (a
smaller layout) and iOS (a smaller visual viewport), at 390x844, 360x330 and on a desktop.

`bun scripts/verify-attach.ts [--port 8700]` drives the + sheet, the camera (Chromium's fake cameras) and the send
screen on a demo hub of its own, and the camera's fallback when it is refused or missing.

**What headless cannot show.** It is Chromium on Linux pretending: not iOS Safari, which handles the
keyboard, the visual viewport, `100%` heights and installed apps in its own way, and was only imitated here by
faking the visual viewport. No real keyboard was opened; its effect was imitated by resizing. Frame rate on a
real phone is unknown: the motion is transforms only and every finger move is one style write, but whether it
holds 60fps on a mid-range phone with a long timeline has not been measured. Haptics, safe areas on real
hardware, the Android back button itself (as opposed to `history.back()`) and Web Push are untested on a
phone. ROADMAP's "Try it on a real phone" still stands.

## Screenshots

From the demo hub, at 390x844:
[home](screenshots/36-phone-home.png),
[conversation](screenshots/37-phone-conversation.png),
[mid swipe back](screenshots/38-phone-swipe-back.png),
[page peeking beside the list](screenshots/39-phone-peek.png),
[details panel](screenshots/40-phone-details.png),
[swipe to reply](screenshots/41-phone-swipe-reply.png),
[message sheet](screenshots/42-phone-message-sheet.png),
[image viewer](screenshots/43-phone-image-viewer.png),
[Catch up tab](screenshots/44-phone-catchup.png),
[You tab](screenshots/45-phone-you.png),
[account](screenshots/46-phone-account.png),
[a menu as a sheet](screenshots/47-phone-menu-sheet.png),
[arrange sheet](screenshots/48-phone-place-menu.png),
[All communities](screenshots/49-phone-directory.png),
[keyboard up](screenshots/50-phone-keyboard.png),
[search](screenshots/51-phone-search.png),
[profile](screenshots/52-phone-profile.png),
[pull to refresh](screenshots/53-phone-pull-to-refresh.png),
[a dialog as a sheet](screenshots/54-phone-dialog-sheet.png),
[light theme](screenshots/55-phone-light.png).
