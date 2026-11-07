# On a desktop: themes, the title bar, and opening things elsewhere

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

## Opening links and files in your own apps

An installed app runs in the browser that installed it, so a link opens in another Chromium tab and a file in
Chromium's viewer. **dither-desk** (`packages/desk`) is a small helper on the same computer that hands them to the
desktop instead: links to your default browser (`xdg-open`, so whatever `xdg-settings get default-web-browser`
says), files to the app registered for their type, or one you pick with **Open With…** in a file's menu.

Without the helper, or with it switched off or not answering, everything opens as it did before.

### Running it

It needs Bun and, for Open With…, `gio` (GLib). As a systemd user service,
`~/.config/systemd/user/dither-desk.service`:

```ini
[Unit]
Description=dither-desk: open dither-chat links and files in this desktop's apps
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=/usr/bin/env bun /path/to/dither-chat/packages/desk/src/main.ts
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now dither-desk.service
```

It must run inside your graphical session, since `xdg-open` needs `DISPLAY` or `WAYLAND_DISPLAY`. If the session
does not pass them to the user manager (on niri and other compositors started by hand), run
`systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP` when the session starts.

Settings, all optional, as `Environment=` lines:

| Variable | Default | |
| --- | --- | --- |
| `DESK_PORT` | 8475 | Settings → Desktop helper asks on this port; change it there too |
| `DESK_DOWNLOAD_DIR` | `$XDG_DOWNLOAD_DIR/dither`, else `~/Downloads/dither` | Where opened files are saved |
| `DESK_OPEN_CMD` | `xdg-open` | Split on spaces and run without a shell, the link or file appended |
| `DESK_GIO_CMD` | `gio` | For `gio mime` (Open With…'s list) and `gio launch` |
| `DESK_MAX_BYTES` | 512 MiB | The largest file it downloads |
| `DESK_CONFIG_DIR` | `$XDG_CONFIG_HOME/dither-desk` | Where the pairing is kept |

### Pairing

1. Open Settings → Desktop helper in the app. It says the helper is running and not paired.
2. In a terminal: `bun packages/desk/src/main.ts pair` (or `pair https://chat.example.net` to accept only that
   address). It prints a code like `K7QD-3MWX`, valid for five minutes and five tries.
3. Type the code in Settings and press Pair. The terminal says which address took it; if that is not yours, run
   `bun packages/desk/src/main.ts unpair`.

Two switches then appear, both on: open links in the default browser, and open files in your apps. Unpair is in the
same place; `main.ts status` shows the pairing from the terminal. The helper keeps one pairing: pairing another
address, or the same one in another browser profile, replaces it.

Chromium may ask whether the hub's page may reach devices on your local network (Local Network Access); allow it.

### What it lets a page do, and what it does not

- It listens on 127.0.0.1 only, and refuses a request whose `Host` is not a loopback name, so a site that points its
  own name at 127.0.0.1 (DNS rebinding) gets nothing.
- Before pairing, any page may ask `/hello` whether it is there, and nothing else. Pairing needs the code, which
  only the terminal shows. The code is stored hashed, and five wrong tries void it.
- After pairing, every request must carry the token (kept in that page's localStorage) and come from the paired
  origin exactly; a browser sets `Origin` itself, so another page cannot claim it. Cross-origin answers, and the
  `Access-Control-Allow-Private-Network` preflight, go to that origin only. Even `/hello` is refused to others.
- `paired.json` and `pending.json` are 0600 in a 0700 folder.
- `/open` takes `http:`, `https:` and `mailto:` URLs only, and runs `xdg-open <url>` as an argument list, never
  through a shell.
- `/open-file` downloads only `/media/` and `/emoji/` paths on the paired hub, without following redirects and up to
  the size cap, into the download folder under a cleaned, unique name (no path separators, control or direction
  characters, leading dots or dashes), 0600. It does not open with the default handler a file that could run code
  (`.desktop`, scripts, executables, a file without an extension, or one that starts like an ELF, `#!` or PE
  binary): that one is saved and the page says so. Open With… can still open it with an app you choose.
- With Open With…, the app must be one that `gio mime` lists for the file's type at that moment; it is started with
  `gio launch <its .desktop file> <the file>`.

What it does not protect against: the hub's own page is trusted, so script running on it (which could already read
every message) can open links and files through the helper too. Other programs running as you can read the token
file, as they could run `xdg-open` themselves.

### Testing it

`bun test` in `packages/desk` runs against a fake hub, with `test/fixtures/record.ts` standing in for `xdg-open` and
`gio`: it records its arguments and opens nothing. `bun scripts/verify-desk.ts <demo hub> <free port> <dir>` does the
same end to end in headless Chromium: pairs through Settings with the code `pair` prints, clicks a link, uses Open
Link, Open With… and a click on the demo's PDF, and unpairs. Neither ever opens a browser, file or app on the desktop.
