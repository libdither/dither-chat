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

To deploy a new version: `git pull && bun install && bun run web:build && systemctl --user restart dither-chat`.
Installed apps notice the new service worker when reopened (or within an hour) and show a reload bar.

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

Settings → *Push on this device* opts one device in. Web Push passes through the browser vendor's relay (Google, Apple, Mozilla or
Microsoft). The payload is encrypted end to end, but the relay sees when a push happens and for which device. For no third party at all, set
`DITHER_NTFY_URL` (and `DITHER_NTFY_TOKEN`, `DITHER_PUBLIC_URL`) to a topic on your own ntfy server. `DITHER_PUSH_SUBJECT` sets the VAPID
contact, a `mailto:` or `https:` URL. The keys live in `.data/vapid.json` (0600); replacing them invalidates every subscription.

A subscription belongs to the origin it was made on, so changing the hub's address means opting in again on each device.

On a hub started with `--demo`, simulated messages are real pushes to any device that opted in.

## Categories and local models

Categories use keyword matching by default. Set `DITHER_CATEGORY_MODEL=<model>` for a local Ollama model, and `DITHER_OLLAMA_URL` if it is not on
`127.0.0.1:11434`. The hub refuses to send to a public address unless `DITHER_CATEGORY_ALLOW_REMOTE=1`. It only ever sends names, topics and channel names.

## Moving the hub to another machine

One Discord or Signal session must not run from two hubs at once.

1. Stop the source hub: `systemctl --user stop dither-chat`, and leave it stopped.
2. Copy `.data/` over an encrypted channel (`rsync -a` over Tailscale). It holds `accounts/<id>/secret.json`, Signal keys and Discord browser profiles.
3. Start the destination and check every account on the Accounts page. Discord may ask for a captcha or re-login from a new
   machine; do that in the live view yourself. Signal linked devices move with their keys.
4. Point Caddy at the new address. The app keeps its origin, so devices need nothing.
5. Delete `.data` from the source only after the destination has run cleanly for a while.
