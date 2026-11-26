# The login

The hub holds every message of every account and drives signed-in browsers (an account's live view), so being on
this machine or the tailnet is not enough to use it. `packages/hub/src/auth.ts` is the login; `server.ts` puts it in
front of every route (`route`, before anything else is matched).

Being on loopback grants nothing: the proxy on this machine (Caddy) reaches the hub from this machine's own
addresses, so "it came from here" says nothing about who sent it. Every request goes through the same check.

## What needs it, and what does not

| Needs a session (or the service token) | Does not |
|---|---|
| every `/api/*` route, including the live socket (`/api/live`), calls (`/api/call`, `/api/call/:id/voice`), the live view (`/api/liveview/:id`), `/api/errors` and `/api/sessions` | `GET /api/login`, `POST /api/login`, `POST /api/logout` |
| `/media/*` and `/emoji/*` (pictures and files), `/voice/*`, `/calendar/*` (dither-calendar through the hub), `/demo/*` | `GET /api/health`: only `{ ok, now }` without a session (with one, also `gapRestarts`) |
| | the web app's own files: anything else is a file of the build or its `index.html` (`static()`), whatever the path |
| | `/voice/dave/<id>/libdave.mjs` and `libdave.wasm`: Discord's public DAVE library (docs/calls.md), which direct mode's worker fetches with no cookie |
| | `/adapter` (local adapters, with their own per-account token, from loopback only, as before), `/ca.crt` |

Without a session a gated path answers 401 `{ error, login: true }` (and `setup: true` while no password is set).
The router is never reached without one, so a route added later is behind the login without anyone listing it.
`packages/hub/test/login.test.ts` checks that: it reads every path the hub's sources name (string literals and the
regexes the router matches, about 300) and asks each one with every method, from loopback, with and without an
`Origin`, and as a socket, and expects 401 for all of them.

## The password

```sh
bun packages/hub/src/cli.ts set-password                # typed twice on a terminal, not echoed
bun packages/hub/src/cli.ts set-password --file <file>  # or from a file, or stdin: never from argv
```

Run it on the hub's machine, from any checkout or release folder of this repo. It writes to the hub's data dir:
`--data <dir>`, else `$DITHER_DATA`, else `~/.local/share/dither-chat` when that exists, else the repo's `.data`. The
hub need not be running, and does not need a restart: it reads the file again when it changes.

At least 10 characters. It is kept only as an argon2id hash (Bun.password, 64 MiB, t=3) in `<data>/login.json`
(0600), with the fixed username `admin`. Setting it again signs every device out.

**Until a password is set the hub is shut**: every gated path answers 401 with `setup: true`, the page shows how to
set one, and the hub logs the command at each start. A demo world (`--demo`, below) is the only hub that runs open.

## Sessions

- Signing in makes a 32-byte random token, sent as the cookie `dchat_session`: HttpOnly, SameSite=Lax, Path=/, and
  Secure when the page is served over https (directly, or `X-Forwarded-Proto: https` from the proxy on this machine).
  The hub keeps only its sha256, with when it was made and last used, the user agent and the address, in
  `<data>/auth.sqlite` (0600), apart from the hub's database.
- It slides: it ends 90 days after its last use, and a year after it signed in at the latest. Its last use is written
  at most once a minute; the cookie's Max-Age is renewed at most once a day. When that write fails (a full disk), the
  request still goes through, and the cookie is renewed on a later request, once the last use is saved.
- Settings → Signed-in devices lists them, signs one out, or all others, or this one. From the machine:
  `cli.ts sessions` and `cli.ts revoke-sessions [id]` (they open `auth.sqlite` directly, so they work while the hub runs).

## Failed sign-ins

Per address (behind the proxy, the `X-Forwarded-For` it sets, trusted only from this machine's own addresses), five
tries are free, then each failure doubles the wait from 1 s up to 15 minutes; a success clears it. Past 50 failures
overall the same doubling applies to everyone.

## Cross-site requests

The cookie is SameSite=Lax, so other sites' POSTs and sockets do not carry it. As a second lock, every write a browser
makes with the cookie (anything but GET and HEAD) and every socket must carry an `Origin` (or, without one, a `Referer`)
whose host is the request's `Host`. One with neither is refused: a missing `Origin` is no longer read as "not a
browser" (`sameOrigin` in `server.ts`). That includes `/api/login` and `/api/logout`.

## Programs: the service token

Programs that read the hub without a browser send `Authorization: Bearer <token>`, the token in `<data>/api.token`
(0600). The hub makes it at its first start and keeps it; `cli.ts token --rotate` makes a new one, and the hub reads the
file again when it changes. A request with the token is not asked for an `Origin`. Anyone who can read the data dir can
already read the database, so the token adds no new way in.

Who sends it:

| Program | What it reads |
|---|---|
| the deployer (`packages/deploy`, [deploy.md](deploy.md)) | `/api/health` (`gapRestarts`), `/api/bootstrap`, `/api/notices`, `/api/calls`, from `$DITHER_DEPLOY_HUB_DATA/api.token` |
| this CLI (`accounts`, `add`, `remove`, `action`, `log`) | from the data dir above |
| dither-calendar ([calendar.md](calendar.md)) | the bootstrap, the live socket, a conversation's messages; its own `DITHER_CALENDAR_HUB_TOKEN_FILE`, else the usual data dir on its live service |
| scripts that run a throwaway hub that is not a demo world (`verify-e2ee`, `verify-telegram-approve`, `verify-accounts-matrix`) | `scripts/hub-login.ts`: a password and a token in the throwaway data dir, and the browser signs in |
| `scripts/clicks.ts`, the call lab (`scripts/call-lab.ts`, its config's `dataDir`) | the token of the hub they read; a browser they drive gets a session from `POST /api/sessions` (the token only), set as its cookie. The lab hub needs a password set |

The Android app's own requests (a reply from a notification, push registration, uploads, a notification's picture)
carry the page's session instead: the WebView's cookie for the hub, and the hub's origin as their `Origin`
([android.md](android.md)).

**File tickets.** The desktop helper fetches a file to open it in another app ([desktop.md](desktop.md)) and has no
session. The page asks `POST /api/ticket { url }` first: the same `/media` or `/emoji` path with `?ticket=<expiry>.<mac>`,
an HMAC of the path with the hub's secret, good for 5 minutes and for that path only.

## The page

A 401 with `login` (from the bootstrap, any API call, or `/api/login` after the live socket was refused) puts the
sign-in screen in place of the app (`packages/web/src/login.ts`, `ui/Login.tsx`). It is a plain form a password manager
fills (`username`, `current-password`); signing in reloads the page. With no password set it says how to set one.
The screen removes `index.html`'s start logo (`#boot-static`, a full-screen layer the app's own first render takes
over), which would otherwise sit on top of the form and take every tap. `scripts/verify-login.ts` (CI's `boot` job)
signs in with real clicks and typing on a cold start.

What the device kept of the hub is forgotten on a 401 and on signing out: the snapshot and kept pages (IndexedDB) and
the kept pictures (the service worker's `dither-media-*` cache). The service worker never keeps the hub's other answers
(`/api/*`, `/calendar/*`, `/voice/*`, `/demo/*` go past it). Signing out also answers with `Clear-Site-Data: "cache",
"storage"`, which a browser honours over https. Settings in localStorage (the theme, layout) stay on a 401.

One gap: a device that was signed out elsewhere and opens the app offline still paints its snapshot until it reaches
the hub. Push notifications to a device go on until its push subscription is removed (Settings → Push, or the
device's own sign-out, which unregisters its service worker over https).

## Demo worlds and tests

A hub started with `--demo` (invented data, its own data dir, and it refuses to start on one with real accounts) runs
open: no login, and the old cross-site check that lets a request without an `Origin` through. Tests make their hubs
with `open: true` (`ServerOpts.open`; `main.ts` sets it only for `--demo`). Tests of the login itself make a closed
hub.
