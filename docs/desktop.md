# On a desktop: themes and the title bar

## Themes

Every theme is a palette in [`packages/web/src/themes.ts`](../packages/web/src/themes.ts); `ui/Themes.tsx`
sets the chosen one as CSS variables on `<html>`, and `styles.css` only reads the variables. To refine a theme,
change its colours there; to add one, copy a theme and give it a new id. Only the first block of tokens is
required: text on a coloured fill, links, code and the title bar have defaults.

`bun test packages/web/test/themes.test.ts` checks every theme at WCAG AA (4.5:1): body, secondary and faint
text on every surface, including hovered and selected rows; the accent, links, danger, ok and warning colours
used as text; your own name in a mention; code; text on the send button and on unread counts. Network names
written as text (the Discord / Signal / Matrix chips) take as much of the network colour as still reads, and the
rest from the theme's text colour (`--net-ink`). Avatars without a picture use one OKLCH lightness for every
hue, so white initials read on all of them. Account colours are only dots; on light themes they get a thin
dark edge so a pale one still shows.

The picker is the palette button at the right of the title bar (hover a theme to see it on the whole app,
click to keep it), and Settings → Appearance. On a phone it is Settings → Appearance → Theme, a sheet. "Match
the system" keeps one dark and one light theme and follows the device's `prefers-color-scheme`; picking a theme
in that mode replaces the dark or the light one.

The browser's `theme-color` follows the theme: the title bar colour on a desktop, the list's colour on a
phone (Android's status bar). `index.html` repeats the last theme before any script runs, so a reload never
flashes the default.

## The title bar

The desktop layout has a 34 px bar across the top: where you are, a button for the Ctrl+K switcher, and the
theme picker. In a browser tab, or an installed app with the normal title bar, it is just that.

The manifest asks for `"display_override": ["window-controls-overlay", "standalone"]`. In Chromium (Chrome,
Edge, Brave; since about version 105, on Windows, macOS and Linux) an installed app then has a small chevron (^)
button in its title bar that switches to the **window controls overlay**: the browser's title bar goes away
except for its own minimize, maximize and close buttons, and the app draws the rest. Our bar then sits in
`env(titlebar-area-x/y/width/height)`, its empty parts move the window (`app-region: drag`; double-click
usually maximizes), and its buttons opt out (`app-region: no-drag`). The chevron turns it back off; Chromium
remembers the choice per app. Firefox and Safari ignore `display_override` and use `standalone`.

What is not possible, and why there are no buttons of our own: in overlay mode the browser always draws its
window buttons, and they cannot be hidden or restyled beyond following `theme-color`. The web has no
minimize or maximize call, and `window.close()` only closes windows a script opened, so a close button of
ours could not be relied on. Duplicating the browser's buttons would only give two sets.

On Linux the overlay needs Chromium to draw its own window frame. With "Use system title bar and borders"
switched on (Chromium's appearance settings), there is no overlay: the app runs as `standalone`, under the
system's title bar, with our bar inside the window.

### niri (and other tiling Wayland compositors)

What to expect when the app runs as a Chromium window on niri:

- **Started with `chromium --app=https://…`** (an app window, not an installed app): the manifest's display
  modes do not apply, so there is no overlay. The window has Chromium's thin frame, or nothing at all if niri
  asks for server-side decorations (`prefer-no-csd` in niri's config; niri then draws only its focus ring and
  border). The app's own bar is at the top of the window either way, and the window title (which niri shows
  in its overview and in `niri msg windows`) follows the place you are in: `beginners · dither-chat`.
- **Installed as an app and started with `chromium --app-id=<id>`** (the id is in `chrome://web-app-internals`),
  with `prefer-no-csd` off: Chromium draws its own title bar with the chevron; switch to the overlay and our bar
  is the title bar. Dragging it asks niri for an interactive move (in a tiled layout that moves the column, or
  floats the window, depending on niri's version and settings); double-click toggles maximize, which niri
  shows as a full-width column. Close works. niri has no minimize, so that button does nothing (or is not shown,
  if the Chromium version reads the compositor's window capabilities).
- **Installed, with `prefer-no-csd` on:** no Chromium frame, so no overlay, and the app looks as in the first
  case.

None of this was tried on niri itself: the overlay can only be checked in an installed app with a visible
window, which headless Chromium is not.
