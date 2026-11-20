# Approvals: a service asks, you answer from your phone or laptop, and the answer is signed

A program on the tailnet (a deploy, a rebuild, a merge bot) asks you a question with a few actions. You answer on
your phone (the approver app, fingerprint) or on the laptop (the page, then the laptop's fingerprint reader). The
answer comes back **signed by a key that never leaves the device**, over bytes that name the request, its payload and
the action, so the asker (or anyone later, like a deploy reading a commit) can check it with the device's public key
and nothing else. The hub that carries it is not trusted for the decision: it only queues, shows and delivers.

```
 asker (CLI or HTTP) ──POST /api/approvals──▶ hub (packages/hub/src/approvals.ts)
       ▲                                       │ keeps the request, shows it (page, Notices, push)
       │ GET /api/approvals/:id?wait=          │ approvals.ask
       │ (answer + signature)                  ▼
       │                         dither-accounts manager (built-in account `approver`, interface `approvals`)
       │                                       │ {t:"request", op:"approve"} on /approver/ws
       │                                       ▼
       └──────────── approvals.answer ◀── phone (approver app)  /  laptop (desk signer, fprintd)
```

Code: `packages/approvals` (the formats, signing and checking, `dither-ask`, the review watcher and merge bot),
`packages/hub/src/approvals.ts` (the queue, the routes, the page's answers), `packages/web/src/ui/Approvals*.tsx`;
in dither-accounts: `packages/manager/src/approvers.ts` and `approvals.ts`, `apps/android` (the phone),
`apps/desk-signer` (the laptop).

**This page is a contract.** The CLI, its exit codes and JSON, the statement and payload formats, the commit trailers
and the verifier below are what other repositories (the NixOS configuration's deploy and rebuild tools) build
against. Change them only by adding: a new kind, a new optional field, a new `v2` beside `v1`.

## Kinds

| kind | asked by | actions | payload (what is enforced) |
| --- | --- | --- | --- |
| `alert` | anything | none (it is a notice with an urgency: `high`, `normal`, `low`) | none |
| `rebuild` | `nrb-request` on a host | `approve`, `deny` | `dither-rebuild-v1`: host, the running commit, the hash of the uncommitted diff, the system's store path |
| `deploy` | `nixos-deploy` on a host | the asker's: `resume`, `hold`, `rollback`, `drop-local`, … and `deny` | `dither-deploy-v1`: host, the commit, what failed |
| `merge` | the review watcher | `approve`, `deny` | `dither-merge-v1`: repo, target, branch, base, head, tree |
| `policy` | you, once (`dither-ask policy`) | `approve`, `deny` | `dither-policy-v1`: a standing approval for one narrow kind of commit (below) |

Every kind that has actions also has `deny`, which never needs a signature. An action an asker marks `signed`
(every `approve`, and for `deploy` whichever the asker says) counts only with a device's signature; one it marks
`any` may also come from the page unsigned (`hold` a deploy, say), and the JSON says `"signed": false`.

The body is text shown under the title: for `rebuild` the closure diff and the changed files, for `merge` the
commits, the diff stat and the CI results. It is bound to the signature (`display-sha256`, below), so a device signs
what it showed. A device shows the payload's lines as well, and for `merge` checks its fields are well formed.

## The statement: the bytes a device signs

UTF-8 text, one `key value` per line, each line ending in `\n`, in exactly this order. The asker's part:

```
dither-approval-v1
id apv_3qJ0d1x8Yc4mT2bE9kQwZp
kind merge
asker review
created 1763600000000
expires 1763603600000
payload-sha256 9f2c…(64 lowercase hex)
display-sha256 41aa…(64 lowercase hex)
```

then the device's answer:

```
action approve
message-sha256 e3b0c442…(sha256 of the message's UTF-8, of "" when there is none)
device dev_Q2hTcFk3a0xYb1pW
signed 1763600123456
```

- `id`: `apv_` + 22 base64url characters (16 random bytes). `asker`: the asker's name, `[a-z0-9-]{1,32}`.
  `created`, `expires`, `signed`: milliseconds since the epoch.
- `payload-sha256`: SHA-256 of the payload's exact bytes (below; empty payload for `alert`).
- `display-sha256`: SHA-256 of `title + "\n\n" + body` (UTF-8). The title is one line (control characters become
  spaces, at most 200 characters), the body at most 32 KiB.
- `action`: `[a-z0-9-]{1,32}`, one of the request's actions.
- The signature: ECDSA P-256 with SHA-256 over the whole statement's bytes, DER, base64url. The key is the device's
  **approval key** (not the identity key it signs in to the manager with): P-256 in the phone's Keystore (StrongBox
  when there is one) with user authentication required on every use, or the laptop signer's key, which only its own
  system user can read. A device identifies its key by its SPKI; its fingerprint is SHA-256 of the SPKI's bytes, the
  first 8 bytes as lowercase hex pairs joined by colons, as the approver's identity key's is.

A signature can't be moved onto another request: the id, the payload's hash and what was shown are all in it.

### Payloads

Same line format (`key value\n`, first line the format's name), ASCII, at most 4 KiB.

```
dither-merge-v1            dither-rebuild-v1              dither-deploy-v1           dither-policy-v1
repo system-config        host laptop                    host laptop                name app-bump
target main                running <40 hex commit>        commit <40 hex>            repo system-config
branch review/fix-caddy    diff-sha256 <64 hex>           state failed               target main
base <40 hex>              system /nix/store/…-nixos-…    reason <one line>          path <file>   (repeatable)
head <40 hex>                                                                        line <regex>  (repeatable)
tree <40 hex>                                                                        max-lines <n>
```

`merge`: `base` is the target's tip when asked (the merge commit's first parent), `head` the review branch's head
(its second parent), `tree` the tree of the merge's result. `rebuild`: `diff-sha256` is SHA-256 of
`git diff --binary <running>` in the tree being built, plus the list of untracked files (`dither-ask` computes it with
`dither-ask diff-hash <dir> --base <running>`): SHA-256 over `git diff --binary <running>`'s output followed, for each
untracked file (not ignored) in sorted order of its path, by `\0untracked <path>\0` and its blob id (`git hash-object
--no-filters`). `policy`: below.

## `dither-ask`: the CLI

A flake output of this repository: `packages.<system>.dither-ask` (needs only `bun` at run time; the verifier needs
`git`). It talks to the hub at `$DITHER_ASK_URL` with the token in `$DITHER_ASK_TOKEN_FILE` (or `--url`,
`--token-file`).

```
dither-ask request --kind rebuild --title TEXT [--body-file F] [--payload-file F] [--action ID[:signed|:any][=LABEL]]...
                   [--urgency high|normal|low] [--expires SECONDS] [--wait SECONDS] [--keys FILE]
dither-ask alert   --title TEXT [--body-file F] [--urgency high|normal|low]
dither-ask status  ID [--wait SECONDS] [--keys FILE]
dither-ask cancel  ID [--reason TEXT]
dither-ask keys                                    the paired devices' approval keys, as a keys file (below)
dither-ask verify  --keys FILE (--statement-file F --signature SIG | --json F)     one answer
dither-ask verify-commit REV  --keys FILE [--repo NAME] [--policies DIR] [--json]
dither-ask verify-range BASE TIP --keys FILE [--repo NAME] [--policies DIR] [--json]
dither-ask diff-hash DIR [--base REV]              the rebuild payload's diff-sha256
dither-ask policy  --name N --repo R --target T --path P... --line RE... --max-lines N --expires-days D
                   [--wait SECONDS] --out FILE           ask for a standing approval; writes its trailers
dither-ask review status BRANCH [--repo R]         the latest merge request for review/BRANCH
dither-ask review watch --config F                 the review watcher and merge bot (below)
```

`request` without `--action` asks `approve` (signed) and `deny`. `--wait` blocks until an answer or that many seconds
(default: return at once with the id); `status --wait` waits on an earlier one. **With `--keys`, the CLI checks the
signature itself** against those keys and the request it made, and an answer that doesn't check out counts as no
answer (exit 76). Callers that act on an approval must pass `--keys` with keys baked into their own system, never
fetched from the hub.

**Exit codes** (as `nrb-request`'s):

| code | means |
| --- | --- |
| 0 | answered with an action other than `deny` (which: `.action` in the JSON); for `alert`, sent |
| 77 | denied |
| 75 | no answer yet: `--wait` ran out, or the request expired or was cancelled (`.state` says which) |
| 76 | answered, but the answer doesn't verify against `--keys` (or is unsigned where the action needs a signature) |
| 69 | the hub can't be reached, or refused the token |
| 64 | bad arguments |

**JSON** on stdout (one object; stderr has the human lines):

```json
{
  "id": "apv_…", "kind": "rebuild", "state": "answered",
  "action": "approve", "message": "ok, but rebuild the other host after", "signed": true,
  "device": { "id": "dev_…", "name": "Pixel 8", "kind": "phone" },
  "statement": "dither-approval-v1\nid apv_…\n…signed 1763600123456\n",
  "signature": "MEUCIQ…", "verified": true
}
```

`state` is one of `waiting`, `answered`, `expired`, `cancelled`, and `sent` for an `alert`. `message` is what you typed with the answer ("The
user's message: …" is how an asker should pass it on), `null` when nothing. `verified` is present only with `--keys`.
`statement` and `signature` are absent for unsigned answers.

### Keys file

What `dither-ask keys` prints, and what a host bakes in (e.g. `/etc/dither-approvals/keys`): one device a line,
`#` comments allowed:

```
# device-id  kind  approval-key (SPKI, base64)  fingerprint  name
dev_Q2hTcFk3a0xYb1pW phone MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE… 3f:a1:09:7c:52:e0:4b:d8 Pixel 8
```

Compare each fingerprint with the one the device itself shows before baking a line in.

## Who may ask: asker tokens

`POST /api/approvals` and `GET /api/approvals/:id` take an **asker token** (`Authorization: Bearer …`), made on the hub
with `bun packages/hub/src/cli.ts asker add <name> [--kinds rebuild,deploy]` (it prints the token once; the hub keeps
only its SHA-256, in `<data>/askers.json`, 0600). A token may ask only its kinds (default: all but `policy`) and see
only its own requests, at most 50 waiting at once. It answers nothing: answers come from a device or from your
session on the page. The hub's service token and your session can do everything an asker can, and list all.

Why tokens, not a socket or an address list: askers live on several hosts and reach the hub over the tailnet through
the proxy, where the hub sees the proxy's address, not the asker's. A token names the asker in the request and
statement. It is no secret worth much: an agent that reads one can only ask you things, and the answers that matter
are signed by a device and checked by the asker against its own keys.

### HTTP

```
POST /api/approvals          { kind, title, body?, payload?, actions?: [{ id, label?, needs: "signed"|"any" }],
                               urgency?, expiresIn?: seconds }            → 201 the request (as GET)
GET  /api/approvals/:id[?wait=SECONDS]                                    → the request, its answer when answered
POST /api/approvals/:id/cancel { reason? }
GET  /api/approvals?state=waiting                                         your session or the service token: all
POST /api/approvals/:id/answer { action, message? }                       your session only (the page)
GET  /api/approvals/keys                                                  the devices' approval keys (as `keys`)
```

`wait` holds the answer up to 60 s at a time (the CLI asks again until its own `--wait`).

## Answering

- **The phone** (dither-accounts' approver app): a wake-up opens its link; it shows the title, body, payload lines,
  asker, the actions and a box for a message; an action marked `signed` runs the approval key behind the fingerprint
  prompt. It checks `payload-sha256` and `display-sha256` against what it shows before it signs.
- **The page** (`#/approvals`, and each request as a notice under Notices, so it reaches your phone's and browsers'
  notifications): every request, its body and payload, the actions and a message box. `deny` and actions marked `any`
  are answered from the page directly (unsigned). An action marked `signed` asks the laptop signer, when one is paired
  and online: the page says "Touch the fingerprint reader", the desk signer checks your finger through fprintd and
  signs; otherwise the page says to answer on the phone.
- **First answer wins.** The others are cancelled on every device.

### Why the laptop signs through a desk signer, not WebAuthn in the browser

Browsers on Linux have no platform authenticator: Chrome and Firefox there can use a USB security key or a phone
over Bluetooth (which is the phone again), and the fingerprint reader is reachable only through fprintd. And a key
the browser holds is a key every process running as you can use, agents included. So the laptop's answer comes from
a **second paired device**: `apps/desk-signer` in dither-accounts, a small daemon that runs as its own system user
(its key in a directory only it can read), connects to the manager like the phone, and signs only after fprintd
reports a matching finger for you. It speaks the phone's protocol, so the statement, the keys file and the verifier
treat it as any device (`kind desk`).

What it doesn't protect: the laptop's screen. An agent running as you on the laptop can make the page show one thing
while the signer is asked to sign another; the signer prints the title and action it is about to sign in its own
notification, but that runs in your session too. The phone's screen is the one an agent can't touch. Hosts can trust
only phone keys for some kinds by listing only those in the keys file they use for them.

An unsigned answer (a `deny`, an action marked `any`) is only as good as the hub's login, and anything that can read
the hub's service token can make a session: mark an action `any` only when anyone answering it does no harm.

## The manager's side (dither-accounts)

The phone and the desk signer are dither-accounts' **approver devices** (its docs/approver.md: pairing, the link, the
wake-up). Approvals add to that protocol, and the manager offers them to the hub as an interface.

### The link: what approvals add

```
device  {t:"keys", kind, approval, sig}         after "ready", on every link: kind "phone" | "desk", approval the
                                                approval key's SPKI (base64), sig by the IDENTITY key over UTF-8
                                                "dither-approver-key-v1\n" + deviceId + "\n" + kind + "\n" + approval
server  {t:"request", id, op:"approve",         ask: the statement's asker part (its exact text, eight lines);
         ask, display, expiresAt}               display: { kind, asker, title, body, payload, urgency,
                                                actions: [{ id, label, needs: "signed"|"any" }] } (deny always among them)
device  {t:"response", id, ok:true, op:"approve", action, message, signed, signature?}
                                                signature (base64url DER) over ask + the four answer lines, with this
                                                device's id at this manager; absent for an action that needs none
device  {t:"response", id, ok:false, reason}   expired, refused (a check failed), error
server  {t:"cancel", id}                        answered elsewhere, cancelled or expired: drop it
server  {t:"intent", id, action, message}       desk devices only: the page asked to sign this action (below)
```

- `approve` requests are **not** one at a time: each goes to every online device with an approval key as soon as it is
  asked, and to the others when they connect, until it is answered, cancelled or expires. Passkey requests keep their
  one-at-a-time queue. A device without a link is woken (`{"t":"wake"}`) as for passkeys.
- Before it shows anything, a device checks: `ask` parses as the eight asker lines; its `id` is the request's; its
  `payload-sha256` is SHA-256 of `display.payload`, its `display-sha256` of `title + "\n\n" + body`; `kind` and
  `asker` equal `display`'s; `expires` is in the future; the actions are well formed and include `deny`. A failed
  check answers `refused`.
- The manager checks each answer before it passes it on: the action is one offered; a `signed` action carries a
  signature that verifies with the device's approval key over the full statement it rebuilds; an answer to a
  request it no longer holds is dropped. A good answer cancels the request on every other device.
- A key's `kind` and `approval` replace the device's previous ones (logged; the page shows the fingerprint). The page's
  Approvers section shows each device's kind and approval key fingerprint.
- **The desk signer** keeps each request it is sent, and signs only on an `intent` for it: it checks your fingerprint
  (fprintd, `fprintd-verify <user>` must report a match within 30 s), then answers as above. An intent for an action
  that needs no signature is answered without the fingerprint. It never answers on its own.

### The interface: `approvals`, on the built-in account `approver`

The manager answers it itself (as its built-in `notices` account), and the hub asks for it at `write`.

```
approvals.devices   read   {}                                → { devices: [{ id, name, kind, approvalKey, fingerprint, online }] }
                                                               (approvalKey and fingerprint null until a keys frame came)
approvals.ask       write  { ask, display, expiresAt }       → { devices: n }  (how many devices it went to now)
approvals.cancel    write  { id, reason? }                   → {}
approvals.intent    write  { id, action, message? }          → { sent: n }     (desk devices online that hold it)
approvals.answers   read   { ids: [...] }                    → { answers: [answer…] }  (kept a day: catch-up after a gap)
event approvals.answer     { id, ok:true, action, message, signed, signature?, device, deviceName, deviceKind }
                         | { id, ok:false, reason, device, deviceName }
```

`approvals.ask` refuses (`invalid`) an `ask` that doesn't parse, whose hashes don't match `display`, or that has
expired. The manager keeps no request past its expiry, and keeps no body or payload in its audit (the `approval`
table gets op `approve`, the asker as the account column, the kind as the reason).

## Change review without GitHub's API

Agents push a branch `review/<name>` to the repository's remote (plain git). The **review watcher**
(`dither-ask review watch --config F`, a user unit on the machine that holds the merge bot) fetches each configured
repository every minute:

1. A new head on `review/<name>`: it waits for the repo's **CI source** to have a result for that commit, then asks a
   `merge` request: title "Merge review/<name> into <target> (<repo>)", body the commits (`git log --oneline
   base..head`), `git diff --stat` and the CI's lines, payload `dither-merge-v1` with the tree of
   `git merge-tree --write-tree <base> <head>` (a conflict is reported as a `merge` that only offers `deny`, saying so).
2. A newer head on the same branch cancels the request for the older one and asks again. A deleted branch cancels it.
3. **Approve** (signed): the bot fetches again; if the target's tip is still `base` and the branch's head still
   `head`, it makes the merge commit (parents `base`, `head`, tree `tree`; checked equal), signed with the bot's own
   SSH key, its message carrying the approval trailers (below), and pushes it to the target without force. If the
   target moved, it asks again for the new base (the old approval covers a tree that is no longer the result). After
   the push it deletes `review/<name>`.
4. **Deny**: the request closes with your message; the branch stays for the agent to push a fix. The agent reads the
   outcome with `dither-ask review status <name> [--repo R]` (the latest request for that branch: state, action,
   message).

**CI sources** are per repository in the watcher's config:

- `command`: a command with `{rev}` in its arguments that prints one line per check, `<name> <ok|FAILED|pending>
  [details]`; exit 0 when it has a result, anything else for "not yet". A NixOS CI that prints
  `<host> ok /nix/store/…` or `<host> FAILED` per host fits as it is.
- `none`: ask at once.

Config (on the machine; paths and addresses never in this repo):

```json
{ "hub": "https://chat.example", "tokenFile": "~/.config/dither-review/token",
  "botKey": "~/.local/share/dither-review/bot_ed25519", "botName": "dither review bot", "botEmail": "review-bot@localhost",
  "repos": [ { "name": "system-config", "remote": "git@example.com:you/system-config.git", "target": "main",
               "ci": { "kind": "command", "command": ["my-ci", "results", "{rev}"] } } ] }
```

## Approvals in commits: the trailers

The bot's merge commit (and a commit covered by a standing policy) carries, at the end of its message:

```
Approval-Statement: <base64url of the whole signed statement>
Approval-Payload: <base64url of the payload bytes>
Approval-Signature: <base64url DER signature>
```

and, for a policy, `Approval-Policy: <name>`. The message above them may quote your message ("The user's message:
…"); the verifier ignores everything but the trailers.

### What `verify-commit` and `verify-range` check

`verify-range BASE TIP` walks the **first-parent** chain from `TIP` back to (not including) `BASE`, which must be an
ancestor of `TIP` (else it fails), and requires every commit on it to be covered. Commits reached only through a merge's
second parent are covered by that merge's approval (its tree is what you approved). A commit is covered when:

- **merge**: it has exactly two parents; the statement's signature checks with a key in `--keys`; its `kind` is `merge`,
  `action` is `approve`, `payload-sha256` matches the payload; the payload is `dither-merge-v1` with `repo` equal to
  `--repo` (when given), `base` and `head` equal to the commit's parents in order, and `tree` equal to its tree.
- **policy**: it has exactly one parent and an `Approval-Policy` trailer; the statement checks as above with `kind`
  `policy`, the payload's `name` equals the trailer, its `repo` equals `--repo` (when given), and it has not expired
  (`expires` after now); and the commit's change from its parent obeys the payload: every changed file is a `path`
  line, every removed and added line (whole lines, without the leading `-`/`+`) matches one of the `line` regexes
  (JavaScript syntax, anchored by the regex itself), as many lines added as removed, at most `max-lines` changed, no
  file added, deleted, renamed or changed in mode.

The bot's own SSH signature on the commit is not checked here (the deploy can keep checking SSH signatures as well).
Exit 0 when every commit is covered, 1 when one isn't (each uncovered commit and why on stderr; `--json` prints
`{ ok, commits: [{ rev, covered, by: "merge"|"policy", device, reason }] }`), 64/65 on bad arguments or a range that
isn't a range. A host's deploy calls it with the range from the commit it runs to the one it would deploy, the keys
baked into the running system, and `--repo` its repository's name; neither an agent (no device key) nor the bot (no
device key either) can get a commit past it.

### Standing approvals: a bot's version bump

A bot that pins new releases of an app commits "app: <version>" changing only the `version` and `hash` lines of two
files, and no one should have to tap for it. Its standing approval is a `policy` request you answer once on the phone:

```
dither-ask policy --name app-bump --repo system-config --target main \
  --path pkgs/app.nix --path pkgs/app-cli.nix \
  --line '^ *version = "[0-9A-Za-z.+-]+";$' --line '^ *hash = "sha256-[A-Za-z0-9+/]+=*";$' \
  --max-lines 8 --expires-days 365 --wait 600 --out app-bump.approval
```

It writes the three trailers (plus `Approval-Policy: app-bump`) to `app-bump.approval`; the bump appends them to its
commit message (`git commit -F` with the message and that file). The verifier then checks each bump against the
policy's lines. What it still trusts: the release the hashes come from (the URL in those files is unchanged by the
policy, so only a release published under the same repository can be pinned).

## Not done

- The dither-chat deployer as a consumer (merging its own reviews this way instead of GitHub's `check` status).
- A WebAuthn security key as a third kind of device on the page.
- Showing a `rebuild`'s closure diff with structure (it is the asker's text today).
