# Deploying the hub as an installable PWA

A browser only installs a PWA, runs its service worker and shows notifications in a **secure context**.
A plain `http://name.tailnet:8460` is not one, so the hub has to be reached over HTTPS.

## What runs where

One hub holds the accounts, on a machine that is always on. Phones and laptops are clients. A laptop that sleeps
makes a poor hub: it misses live messages and pushes.

| Piece | Where | Notes |
|---|---|---|
| Hub and adapters | hub-machine, `http://100.64.0.10:8460` | Plain HTTP. Answers loopback and tailnet addresses, everything else gets 403 |
| HTTPS | Caddy on hub-machine, `https://chat.tn.example.net/` | Let's Encrypt wildcard for `*.tn.example.net`, bound to tailnet addresses only |
| Clients | Any device on the tailnet | Open the address and install. No certificate step |

## Certificates: Let's Encrypt through DNS-01 (current)

The certificate comes from a DNS-01 challenge, so the name never has to be reachable from the internet. Public DNS points
`*.tn.example.net` at the machine's tailnet addresses, so the names only lead anywhere from inside the tailnet. They
cannot sit under `ts.example.net`, because MagicDNS answers NXDOMAIN there for names it does not know. Tailscale's own
`tailscale cert` and `serve` need Headscale 0.30, which is unreleased.

The Caddy config is in the system's NixOS config, not this repo. The hub's line is:

```
chat.tn.example.net {
	reverse_proxy 100.64.0.10:8460
}
```

**Caddy must reach the hub through the tailnet address, never loopback.** The hub trusts loopback with `/adapter`, so
proxying from `127.0.0.1` would hand that endpoint to every tailnet client. Coming from the tailnet address, `/adapter`
returns 403 through the proxy. Check it after any change:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://chat.tn.example.net/adapter   # 403
```

The upstream must also see the client's Host, or the hub's same-origin check refuses every write and the live socket.
Caddy does this by default for an HTTP upstream.

### The service

`~/.config/systemd/user/dither-chat.service`:

```ini
[Service]
WorkingDirectory=%h/Projects/dither-chat
Environment=DITHER_DATA=%h/Projects/dither-chat/.data
Environment=DITHER_PORT=8460
Environment=DITHER_PUBLIC_URL=https://chat.tn.example.net
ExecStart=/path/to/bun packages/hub/src/main.ts --web packages/web/dist
Restart=always
[Install]
WantedBy=default.target
```

Without `loginctl enable-linger $USER` a user service stops when you log out and does not start at boot.

### Who can reach it

The hub answers loopback and tailnet addresses only. Two more settings narrow that:

- `DITHER_HOST` takes several addresses, comma-separated, and opens one listener on each:
  `DITHER_HOST=127.0.0.1,100.64.0.10` (this machine's tailnet address) keeps the hub off the LAN entirely. The
  default `0.0.0.0` relies on the address check alone, and 100.64.0.0/10 is also carrier-grade NAT space.
- The `Host` a request names must be one the hub has: an IP address, `localhost`, this machine's name and its
  MagicDNS name (`<machine>.<tailnet>.ts.net`), the host of `DITHER_PUBLIC_URL`, or one listed in
  `DITHER_ALLOWED_HOSTS` (comma-separated). Anything else gets 421. Without this, a web page open on any tailnet
  device could point its own domain at the hub (DNS rebinding) and use it as you.

Media the hub fetches for a message (an embed's image, an avatar) comes from public addresses only, with each
redirect checked again, up to `DITHER_MEDIA_MAX_MB` (500) per file. `DITHER_MEDIA_ALLOW_PRIVATE=1` lifts the
address check for a testbed whose homeserver runs on this machine. Adapters the hub starts get its environment
without its own secrets (anything named like a secret, token, password or key).

Attachments are served from the hub's own origin, so a message cannot run script there: every `/media/` and `/emoji/`
response carries `X-Content-Type-Options: nosniff` and a CSP with `sandbox` that loads nothing but the file itself
(video and audio keep `allow-same-origin`, which the browser's own player needs; never script). Images other than SVG,
video, audio, PDF and plain text show in a tab; anything else (HTML, SVG, XML, scripts, unknown types) is sent as a
download (`packages/hub/src/mediaheaders.ts`). An account's log and an export carry the same headers.

### Backups and upkeep

The hub keeps its data directory private to its user (umask 077, and older files other users could read are closed
at start). It copies the database every night at 04:00 (`DITHER_BACKUP_HOUR`) to `backups/auto-<time>.sqlite` with
`VACUUM INTO` from a separate process, and keeps the newest seven (`DITHER_BACKUP_KEEP`). After downtime it copies at
the first chance. Copies you made yourself are never removed. Before opening a database with a schema it has not
seen, the hub also copies it to `backups/pre-migrate-<time>.sqlite` (newest five kept), and every migration runs in
one transaction. Mail's schema files (`packages/hub/src/mail/schema*.sql`) count as the schema too.

Every six hours it clears partial downloads from `media-cache/`. The cache itself is kept indefinitely: the media
archive (`packages/hub/src/mediaarchive.ts`) fills it with every remote attachment soon after it arrives, because Discord's links
expire. Each kept file is then looked at once for what it really is (`mediainfo.ts`, [files.md](files.md)), in the
background, a few seconds of work every half minute. Setting `DITHER_MEDIA_CACHE_MB` caps the cache again, least
recently shown first. Adapter logs rotate at 10 MB.
Triage rows older than `DITHER_TRIAGE_KEEP_DAYS` (90) go when nothing can be learned from them: below the list or
silent, never marked (nor voted on before the tiers), in conversations you never wrote in.

To restore, stop the hub, move `hub.sqlite`, `hub.sqlite-wal` and `hub.sqlite-shm` aside, copy a backup to
`hub.sqlite`, and start it. Clients notice and download everything again.

To deploy a new version: `git pull && bun install && bun run web:build && systemctl --user restart dither-chat`.
Installed apps notice the new service worker when reopened, when the hub comes back after the restart, or within an
hour, and show a reload bar. A page in sight never reloads by itself (`packages/web/src/update.ts`): the new build goes
in when you tap the bar, or when the app goes out of sight with nothing in progress (text typed, a call, an open sheet,
menu, dialog or picture, an old message jumped to, a message not yet through to the hub). Another tab of the app that
is in sight keeps its build and shows the bar too: a tab out of sight lets the new worker in only while no other window
of the app is in sight (`sw.js`), and a tab updated by another one reloads only when it is out of sight and idle.
`bun scripts/verify-update.ts <demo hub> --dist <its --web dir>` checks all of this in a browser.

### How long a start takes

Once it answers requests, the hub logs one line with how long each part of its start took
(`packages/hub/src/startup.ts`), from the process starting:

```
startup: ready in 1.1 s (code 81 ms, data dir 1 ms, db open 6 ms, pre-migrate copy 16 ms, migrations 13 ms, journal 1 ms, activity log 1 ms, models 14 ms, categories 3 ms, mail 14 ms, server 30 ms, mail start 9 ms, adapters 813 ms, http listen 3 ms, attention 17 ms, the rest 1 ms, queued work 30 ms)
```

`pre-migrate copy` and `search backfill` show only when they ran, `accounts manager` only with dither-accounts.
`queued work` is what the start left for the event loop before it could answer. Restarts have taken 86–332 s to come
back; `journalctl --user -u dither-chat | grep 'startup: ready'` shows where a start's time went. The old process's
stop is not in it. Nothing waits on it or fails on it.

CI starts the hub on databases older hubs left (`packages/hub/test/old-database.test.ts`, fixtures in
`packages/hub/test/fixtures/old-db/`): it must copy the database aside, migrate, log that line and read back what the old
hub stored. `bun scripts/old-db-fixture.ts <commit> <name>` makes another fixture from an older commit's demo hub
(demo data only; it checks), when a migration should be tried from a new era. `hub-2026-11-11` is the first with mail
tables (main before #95): `packages/hub/test/mail-migrate.test.ts` opens each such fixture with MailStore and checks it
ends up with a new database's columns, indexes and triggers, rows kept. A column added to a mail table after the table
was first made goes in its CREATE TABLE and in `MAIL_COLUMNS` (`mail/store.ts`), which MailStore adds to an older
table before the schema files run, since their indexes and triggers may name it (#95's index on `mail_text.cut` did,
and the live hub could not start).

Check a deployment with a private browser that trusts nothing extra:

```sh
bun scripts/verify-pwa.ts https://chat.tn.example.net/
```

Test through a browser and not only curl. A WebSocket can be refused while `curl /` returns 200.

## Installing

Join the tailnet and open **https://chat.tn.example.net/**.

- **Android:** Chrome → menu → Install app.
- **iOS / iPadOS:** Safari → Share → Add to Home Screen. iOS allows Web Push only for apps added this way (16.4+).
- **Desktop:** Chromium or Chrome → the install icon in the address bar. Firefox on desktop cannot install web apps.

## Fallback: a private CA, without DNS-01

If you cannot do DNS-01, the hub can speak HTTPS itself with a private CA:

```sh
scripts/tls-init.sh .data <dns-name> <ip>...
bun packages/hub/src/main.ts --tls-cert .data/tls/server.crt --tls-key .data/tls/server.key
```

This writes `.data/tls/` (ignored by git; keys are 0600). The CA is name-constrained to the tailnet's DNS domain and Tailscale's
address ranges, so a device that trusts it cannot be fooled about any other site even if the key leaks. Re-running keeps the
CA and issues a new server certificate, which lasts 397 days, the most browsers accept.

The main port then speaks HTTPS, and `--plain-port` (default: the next port up) serves `/adapter` to loopback and `/ca.crt` and `/trust`
to the tailnet. Every device has to trust the CA once from `http://<dns-name>:<plain-port>/trust`, which links the certificate and shows
its fingerprint. On iOS you must also turn it on under Settings → General → About → Certificate Trust Settings. Chrome on Android may be unable
to mint a full WebAPK for a site on a private CA. Keep `.data/tls/ca.key` on the hub.

## Notifications

Push needs nothing on the hub. Each device opts in from Settings → *Push on this device*, which registers it, sends a
test, and shows whether the device confirmed it arrived.

- Browsers use Web Push through their vendor's relay (Google, Apple, Mozilla or Microsoft). The payload is encrypted
  end to end, but the relay sees when a push happens and for which device. Firefox and Chrome on Android get theirs
  through Google Play services, so on a phone without them use the Android app.
- The Android app (`apps/android`) registers through a UnifiedPush distributor, normally the ntfy app, and the hub
  sends the same encrypted Web Push to ntfy's server. ntfy.sh is allowed by default; any other server is allowed with
  one tap when a phone first registers through it, or typed under Settings → *Push servers*. See
  [android.md](android.md#push) for the steps and what the allowlist protects.

`DITHER_PUSH_SUBJECT` sets the VAPID contact, a `mailto:` or `https:` URL. The keys live in `.data/vapid.json` (0600);
replacing them invalidates every subscription. `DITHER_PUSH_RELAYS` (comma-separated origins) still adds push servers
from the environment, and `DITHER_NTFY_URL` (with `DITHER_NTFY_TOKEN`, `DITHER_PUBLIC_URL` for the click link) still
posts every push as plain text to one ntfy topic; neither is needed any more.

A subscription belongs to the origin it was made on, so changing the hub's address means opting in again on each device.

On a demo hub (`--demo`), simulated messages are real pushes to any device that opted in.

## Categories and local models

Categories use keyword matching by default. Set `DITHER_CATEGORY_MODEL=<model>` for a local Ollama model, and `DITHER_OLLAMA_URL` if it is not on
`127.0.0.1:11434`. The hub refuses to send to a public address unless `DITHER_CATEGORY_ALLOW_REMOTE=1`. It only ever sends names, topics and channel names.

Alerts start from one question put to jev, the machine's local model service, about a message's text
([notifications.md](notifications.md#alert)): `DITHER_JEV_URL` says where it is (`127.0.0.1:7862`), and the hub
refuses an address that is not on this machine or a private network. `DITHER_ALERT_MODEL=off` asks nothing, so only
your rules alert; `keyword` is the demo hub's stand-in. Without jev running the hub works the same way as with `off`.

## Moving the hub to another machine

One Discord or Signal session must not run from two hubs at once.

1. Stop the source hub: `systemctl --user stop dither-chat`, and leave it stopped.
2. Copy `.data/` over an encrypted channel (`rsync -a` over Tailscale). It holds `accounts/<id>/secret.json`, Signal keys, Matrix crypto stores and Discord browser profiles. A Matrix device's `crypto.sqlite` must only ever run in one place: an old copy started later breaks its sessions.
3. Start the destination and check every account on the Accounts page. Discord may ask for a captcha or re-login from a new
   machine; do that in the live view yourself. Signal linked devices move with their keys.
4. Point Caddy at the new address. The app keeps its origin, so devices need nothing.
5. Delete `.data` from the source only after the destination has run cleanly for a while.

## Demo and test hubs

A hub is either real or a demo world, never both. `--demo` seeds four simulated accounts and uses its own data
dir (`.data-demo` unless `--data` says otherwise); it refuses to start on a data dir that holds real accounts,
and a demo hub refuses to add real ones. A real hub started without `--demo` removes any demo accounts left
from older versions, with everything only they saw. So never put `--demo` in the service that serves your
devices.

Screenshots, `scripts/verify-*.ts` and the call lab (`scripts/call-lab.ts`, see docs/calls.md) each run their
own hub on another port with its own data dir.

`bun run check:boot` (`scripts/check-boot.ts`, run by CI) builds the web app, starts a demo hub on a fresh data dir
and a free port (`--port` to choose one), and loads it in headless Chromium at a desktop's size and then a phone's:
the inbox list, a conversation, Settings. It fails on an uncaught error on the page, a `console.error`, a request
that fails (unless `EXPECTED` in the script lists it with its reason) or a service worker that does not register. It
takes about 10 s. The scripts look for `chromium`, `chromium-browser`, `google-chrome` and `google-chrome-stable` on
PATH in that order (`findBrowser` in `scripts/browser.ts`); `DITHER_CHROMIUM` names another.
