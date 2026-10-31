# Deploying the hub as an installable PWA

A browser only installs a PWA, runs its service worker and shows notifications in a **secure context**.
A plain `http://name.tailnet:8460` is not one, so a tailnet hub has to speak HTTPS.

## What runs where

| Port | Protocol | Answers |
|---|---|---|
| 8460 | HTTPS | Everything, for loopback and tailnet addresses |
| 8461 (`--plain-port`) | HTTP | `/adapter` from loopback, `/ca.crt` and `/trust` for the tailnet, redirects everything else to HTTPS |

Requests from any other address get 403, including the LAN. `/adapter` is loopback-only on both ports.
Adapters connect over plain `ws://127.0.0.1:8461`, so they need no certificate.

## Certificates: private CA (current)

Headscale 0.28 cannot issue `tailscale cert`, so the hub uses a private CA:

```sh
scripts/tls-init.sh .data laptop.ts.example.net 100.64.0.20 fd7a:115c:a1e0::20
```

This writes `.data/tls/` (ignored by git; keys are 0600). The CA is **name-constrained** to the tailnet's DNS
domain and Tailscale's address ranges, so a device that trusts it cannot be fooled about any other site even if
the key leaks. Run the same command to renew: it keeps the CA, so devices stay trusted, and issues a new server
certificate. **The server certificate lasts 397 days**, the most browsers accept. Restart the hub afterwards.

### The service

`~/.config/systemd/user/dither-chat.service`:

```ini
[Service]
WorkingDirectory=%h/Projects/dither-chat
Environment=DITHER_DATA=%h/Projects/dither-chat/.data
Environment=PATH=/etc/profiles/per-user/%u/bin:/run/current-system/sw/bin
ExecStart=/etc/profiles/per-user/%u/bin/bun packages/hub/src/main.ts --demo --web packages/web/dist --tls-cert .data/tls/server.crt --tls-key .data/tls/server.key
Restart=on-failure
[Install]
WantedBy=default.target
```

Without `loginctl enable-linger $USER` a user service stops when you log out and does not start at boot.
A laptop that sleeps takes the hub with it; put accounts on an always-on machine.

To deploy a new version: `git pull && bun install && bun run web:build && systemctl --user restart dither-chat`.
Installed apps notice the new service worker when reopened (or within an hour) and show a reload bar.

Check a deployment with a private browser that trusts only this CA:

```sh
bun scripts/verify-pwa.ts https://laptop.ts.example.net:8460/ .data/tls/ca.crt
```

## Trusting the CA: once per device

The device must be on the tailnet. Open **http://laptop.ts.example.net:8461/trust**, which links the certificate
and shows its fingerprint. Plain HTTP is fine for this step because WireGuard already authenticates the tailnet; compare
the fingerprint if you want to be sure. Then:

**Android.** Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate →
CA certificate → pick `dither-chat-ca.crt`. Menus vary by vendor; search Settings for "CA certificate". Android warns that the
network may be monitored, which is its standard text for any user CA. Open `https://laptop.ts.example.net:8460/`
in Chrome → menu → Install app. If Chrome offers only "Add to Home screen", that still opens standalone. Untested on a real
device: Chrome may be unable to mint a full WebAPK for a site on a private CA.

**iOS / iPadOS.** Open the `/trust` page in **Safari** and download the certificate → Settings → Profile Downloaded → Install →
then the step that is easy to miss: Settings → General → About → Certificate Trust Settings → turn on *dither-chat private CA*.
Open the HTTPS address in Safari → Share → Add to Home Screen. iOS allows Web Push only for apps added this way (16.4+).

**Linux.** Chromium/Chrome: `certutil -A -d sql:$HOME/.pki/nssdb -t C,, -n dither-chat -i dither-chat-ca.crt`
(from `nss.tools`), or Settings → Privacy and security → Security → Manage certificates → Authorities → Import.
Firefox has its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.

**macOS.** Double-click the file, then in Keychain Access set *dither-chat private CA* to Always Trust.

**Windows.** Double-click → Install Certificate → Current User → Place in *Trusted Root Certification Authorities*. Firefox needs its own import.

To undo: remove the CA in the same settings screen. A trusted CA is sensitive, so `.data/tls/ca.key` should never leave the hub.

## Later, the cleaner route: a real certificate through DNS-01

No per-device step at all. Run Caddy (or `lego`) on the hub with a wildcard such as `*.tn.example.net`, using the DNS-01
challenge through Njalla's API. This requires a Njalla API token that only you can create. MagicDNS answers NXDOMAIN for unknown names under
`ts.example.net`, so the name has to live outside it, with a public A record to the tailnet address. Tailscale's own `tailscale cert`
/`serve` needs Headscale 0.30, which is unreleased. Once a public certificate is in place, start the hub with those files
and remove the private CA from each device.

## Moving real accounts here

Accounts stay on hub-machine until you decide otherwise. One Discord or Signal session must not run from two hubs at once.

1. Stop the source hub: `systemctl --user stop dither-chat` on hub-machine, and leave it stopped.
2. Copy `.data/` over an encrypted channel (`rsync -a` over Tailscale), excluding `.data/tls` so the destination keeps its own CA.
   It holds `accounts/<id>/secret.json`, Signal keys and Discord browser profiles.
3. Remove `--demo` from the destination's service. Existing demo accounts stay until deleted on the Accounts page.
4. Start the destination and check every account on the Accounts page. Discord may ask for a captcha or re-login from a new
   machine; do that in the live view yourself. Signal linked devices move with their keys.
5. Delete `.data` from the source only after the destination has run cleanly for a while.

An always-on machine is the right home for real accounts: a laptop that sleeps misses live messages and pushes.
