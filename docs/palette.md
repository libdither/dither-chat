# The palette: Ctrl+K and New as one box

Ctrl+K, the title bar's search button, the + in the sidebar and Add people on a group's page all open one box: the
palette. It has pages. The root jumps anywhere, as Ctrl+K always did; New, New group, Add people, a preview card and
the QR codes are pages pushed on top of it. The pages under the one you are on show as crumbs before the input ("New
›", "New › Add people to a group ›"), and each crumb is a button back to its page. A phone has no room for crumbs: it
shows one back arrow and then the page's whole title, up to two lines.

## Opening it

| From | Opens at |
|---|---|
| Ctrl+K, the title bar's button | the root |
| the + in the Inbox and People headers | New |
| "New…" (the root's last row with nothing typed), "New message", "Join a server or group", "Add someone" in the root | New, the last three with their own title, placeholder and rows |
| "Add people to a group", "Scan a code", "My code" in the root or in New | that page |
| "New group" in the root (found by "group", "new group", "group chat", "gc") or in New | New group's people page |
| "New group with <name>" in New, while a 1:1 DM is on screen | New group's people page, that person picked |
| an invite link pasted into the root ("Join …") | New with the link in it, and its card on top |
| a click on an invite link in a message, or Preview Invite in its menu | New with the link, at its card |
| Message on a profile or a person's menu, for someone with no conversation on that network | "Message X on Network" |
| Add people on a group's page | that group's picker |

A palette opened straight at a page has that page as its bottom: backing out of it closes the palette. A page reached
from the root backs out to the root, with what was typed there still in the box. Ctrl+K while it is open goes to the
root (a fresh one when the palette was opened at a page), and closes it from the root. The one way in for code is
`openPalette(page, text?)` in packages/web/src/ui/Palette.tsx; `pushPage` puts a page on top.

## Back

Four ways back one page, each the same:

- **Escape**, wherever the focus is in the box;
- **Backspace** in an empty input, or on a page with no input. On a page with people picked, it first un-picks the
  last one picked;
- **a crumb**, which goes back to its page (the magnifier is the root). On a phone, the back arrow before the title
  goes back one page, and on the bottom page to the root;
- **the back button** on a phone (and `history.back()`): the palette is one layer (packages/web/src/phone.ts) whose
  history entry is made again while pages are left.

Escape at the bottom page closes. A click beside the box, the ×, or dragging the sheet down on a phone closes it whole.
While a group is being made, none of these does anything: a group half made must not look cancelled.

## Keys

Arrows move the highlight, round the ends; Enter takes the highlighted row. Tab is left to the browser, so it reaches
the buttons on a card. On a page that picks several people, Enter picks or un-picks the highlighted row and
Ctrl+Enter (or the button under the list) goes on. Every row is also a plain click or tap. Rows carry `data-key`, and
the old dialogs' classes stay on the new elements (`.new-message`, `.add-reading`, `.add-card`, `.add-mem`, `.fwd-row`,
`.qr-scan-btn`), so scripts find them.

What was typed on a page is kept on its entry: leave it for a page on top and come back, and it is still there. A page
pushed fresh starts empty unless it was opened with text (a pasted link).

## The pages

| Page | What it is |
|---|---|
| Root | Jump anywhere: the top of the inbox with nothing typed, then the match times the inbox's score ([inbox.md](inbox.md)), a person matched by their name or any of their accounts' display names, handles and nicknames; "Join …" first for a pasted invite, "Search messages for …" last; "New…" last with nothing typed |
| New | With nothing typed, its rows: "New group with <them>" when a 1:1 DM is on screen, "Add people to <the group on screen>" or "Add people to a group", New group, Scan a code, My code, then the people you would most likely message (the inbox's score, then the latest message). Typed or pasted, everything [add.md](add.md) reads, by its rules: a link is looked up on paste or Enter, a bare word only when its row is clicked or taken with Enter |
| Message | Someone known on several networks: which one. Someone with a DM on the network chosen goes straight there |
| Message X on Network | Send as, what opening does there, Open conversation (Enter) |
| Card | A reading looked up: the preview, its account chooser and actions, check-first, confirm-first, pending and done, the live view (`AddCard` in NewMessage.tsx, the same card as under a message) |
| Scan a code | The camera or a picture; what it holds fills the New page it was opened from, as a paste would. A scan never acts |
| My code | Each account's own code |
| Add people to a group | The groups one of your connected accounts could add people to, most recent first; typing narrows them |
| Add people to <group> | The picker ([group-settings.md](group-settings.md), "Adding people"): the network's rule in a line, search by typing, the picked as chips, the count and Add (Invite on Matrix). Where the group's About says no, the reason and nothing else |
| New group | Everyone any of your accounts could put in a group, one row per person with the networks they can be in one on; a line above says where the picked fit so far; up to 10; Next ([group-settings.md](group-settings.md), "Making a group") |
| Where to make it | The accounts that could hold some of the picked, best first, each saying what it makes and with whom ("Group DM with 2 of 3: not Mom"); under them, why the others cannot. Skipped when one account holds everyone |
| New <noun> on <account> | The input is the name. Under it the account, the people, who is left out and why, and Make group DM, Make group or Make room (Enter), off with the rule's words while the name is missing or too long |

On a phone (narrower than 820 px) the palette is a bottom sheet, full width, its list scrolling inside it. The
keyboard comes up only on pages about typing (the root, New, a new group's name) and on any page on a desktop; a page
opened by a tap that is a list or a card leaves it down, as the dialogs did. New's placeholder is shorter there ("Name,
link, @name or phone"). While the palette is open, a page behind it that takes the focus (a conversation's message
box, as it loads) gives it back.

## Code

- packages/web/src/palette.ts: no browser needed, tested in packages/web/test/palette.test.ts. The stack (push, pop,
  back to a crumb, the root), what each key does (`keyAct`), the root's rows (`rootKeys`), New's menu and people,
  the group list, and picking several (the cap, toggling, un-picking the last).
- packages/web/src/ui/Palette.tsx: the way in, the box, the history layer, Ctrl+K. It is in the app's first load; the
  pages are not.
- packages/web/src/ui/PalettePages.tsx: the pages, a chunk loaded once the app is idle after it starts, or when the
  palette first opens: ui/Switcher.tsx (the root), ui/NewPages.tsx (New, Message, the card, the codes) and
  ui/AddMembers.tsx (the groups and the picker) and ui/NewGroup.tsx (New group, Where, the name), each drawn in
  ui/PaletteFrame.tsx (crumbs, input, rows, keys).
- packages/web/src/groups.ts: New group's rules that need no browser, tested in packages/web/test/groups.test.ts:
  candidates merged into one row per person, the fit line, the accounts that could hold the picked and their order,
  who is left out, the button and its problem, the toast.
- packages/web/src/ui/MultiPick.tsx: picking several people (rows with a check, chips, the count and the button), for
  any page that picks people. It assumes no single account or network.

scripts/verify-palette.ts drives it in headless Chromium against a demo hub: each way back, the root's query kept,
the crumbs, a name to a message, a pasted invite to Join, Add people from the root and from a group's page through to
an add, keyboard-only runs, a light theme, and a phone. scripts/verify-groups.ts does the same for New group: a group
on each demo network, Where, the rules before any request, the day's limit, backing out, keys alone, a DM, a phone.
