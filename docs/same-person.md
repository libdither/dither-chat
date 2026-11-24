# Same person?

Who may be one person with accounts on several networks: pairs of people the hub thinks are the same, each with the
evidence for it, for you to merge or turn down. Nothing is merged without a click.

**Getting there.** The merge button in the People header (after the graph button), or `#/people/same`. On a phone it is
a page of its own over the People list. A profile shows the suggestions with that person in them ("Maybe the same
person", docs/profile.md), and the people graph shades each group of them together, with a card to merge them in full
or in part, when its "Same person?" chip is on (docs/people-graph.md).

Code: `packages/hub/src/matches.ts` (the engine), `matches-worker.ts` (runs it off the hub's thread),
`samepeople.ts` (`SameMatches`: the list, decisions, merging, jev; `ProfileCollector`: collecting profiles),
`packages/protocol/src/matches.ts` (the types), `packages/web/src/same/` (the page, picture hashing, the review's
merge sets), `packages/web/src/ui/SameBox.tsx` (the profile card). Tests: `packages/hub/test/matches.test.ts`,
`packages/web/test/same.test.ts`; end to end, `scripts/verify-same-person.ts`.

## A side

A side is a row of the people list: a person (`per_…`), or an identity no person holds yet (`idn_…`), as in the
people graph. You, bots, and T3 and calendar accounts are left out.

## Finding pairs

Not every pair is compared. Pairs come from keys two sides share (blocking):

- **Claims and contacts**: a profile's connected accounts and bio links (X, Telegram, GitHub, Instagram, Bluesky,
  Reddit, Twitch, YouTube, Steam, Matrix, LinkedIn, TikTok, Luma, Partiful), phone numbers (last ten digits) and email addresses, set against what each
  side's own accounts are: a Signal or WhatsApp number, a Telegram phone, a Matrix id, a handle on a site.
- **Bridges**: a Matrix puppet of a Discord, Telegram, Signal, WhatsApp, X, Instagram or Facebook user
  (`@discord_…:server`) and the account it stands for.
- **Names and handles**, the rarer the more they count; a handle on one that is the name on the other.
- **Pictures**: profile picture hashes, in four bands of 16 bits so near ones meet too.
- **People around them**: people already one person across networks who are friends or group mates of both (group
  chats of 60 or fewer; a profile's friends and mutual friends). Server membership is left out, as a server says little
  about who someone is, and so are your own accounts' friend lists: they say who you know, not who they are. One
  network's user seen by two of your accounts (two Discord accounts in different servers) is one identity already,
  with nothing to merge.

Each key brings in a few pairs at most, so a common name or a big group adds little work.
Two sides known only from events (guests and hosts on Luma or Partiful, with no chat of yours) are never a pair: a
party's guest list would fill the page with strangers (docs/events.md, "People").

## Scoring

Each pair's evidence is a log-odds weight by kind; their sum, through a logistic, is the chance shown (the ring on each
card). In rough order of strength:

| Kind | What | Weight |
| --- | --- | --- |
| `bridge` | a bridge's stand-in for the other | 9 |
| `claims` | one side's profile names an account the other has; both ways or verified count more | 5.5 to 7 |
| `contact` | the same phone number or email on both | 7 |
| `name` | the same handle (3.8; a Matrix id's own part is its handle), a handle less its number that is the name on the other (`pippa22` and Pippa, 2.4), a rare full name (up to 3.7), close names (Jaro-Winkler), shared words; a phone number shown as a name is not one | to ~5 |
| `picture` | the same picture (3.2), a similar one (1.6); a picture more than three sides have (a default) counts for nothing | 1.6 to 3.2 |
| `friends` | people known to be one person around both, weighted down by how big the group is | up to 3.5 |
| `bio` | bios alike | up to 1.4 |
| `handoff` | direct chats that hand over: one went quiet as the other began | 0.9 |
| `model` | jev's reading (below) | ±2.2 |
| `against` | both on the same network (one person seldom has two accounts you see there), or direct chats with both going on at once for over a month on one network | −2.6, −1.6 |

The base is −3.1, so a shared name alone is not enough, and a claim alone nearly is. A pair under 35% is not shown
unless asked for: from 15% up to that the page keeps them as fainter pairs (`faint`, at most 60), shown by the button
at the end of the list. "Merge all over…" offers pairs at 90% or more.

Weak leads add up. The same picture alone is about even odds; a similar one (a few bits of the hash apart) needs
another lead, such as names alike or friends in common; four friends in common in small groups, and nothing else, come
to a little over a third.

**Learning.** Once you have decided at least four pairs each way, a scale per kind is fitted to your decisions by
logistic regression (merges are yes, including people you had already merged across networks; Not the same is no),
pulled toward 1 so a few decisions move it a little. The page's status line says how many it has learned from and
whether it uses them yet. Each decision keeps the evidence as it was then (`match_decision.features`).

**jev**, the machine's local yes/no model (docs/deploy.md, "Categories and local models"), reads both profiles of up to
40 pairs in the uncertain middle (25% to 90%) after a run; its answer is kept in `match_model` with a hash of what it
read, and asked again only when that changes. Nothing goes to a hosted service. Off on a demo hub, and with
`DITHER_MATCH_MODEL=off`; `DITHER_JEV_URL` points elsewhere.

## Running

A run reads the database on a connection of its own in a worker, so the hub's thread never waits; it writes nothing.
It runs when the list is first asked for, when it is older than 15 minutes, a few seconds after a merge or a decision
(several clicks make one run), and from the page's refresh button. On a copy of a large hub it takes about a second.

**Pictures.** The hub decodes no images, so the page hashes them: `GET /api/matches/pictures` hands it pictures to
hash (the sides of pairs first, then people you have direct chats or groups with, then up to 300 people seen at
events, the latest first: docs/events.md "People"), the page draws each to a 9×8 canvas
and makes a 64-bit difference hash, and `POST /api/matches/pictures` stores them in `picture_hash` with the URL they
came from, so a changed picture is hashed again. The status line says "Comparing pictures" while it works.

## The page

The list is in bands, each with a heading: almost surely one person (90% or more), likely (60%), maybe (35%), and,
when asked, faint. Each piece of evidence has a three-bar meter for how much it counts (a little, some, a lot; red
when it counts against). A bridge's stand-in shows as what it stands for ("Discord, through a bridge", its Matrix id on
hover).

To see it on a bigger world: `DITHER_DEMO_SCENARIO=crowd bun run hub -- --demo --adversarial --data <temp dir>
--port <port>`, then `bun scripts/shots-same-person.ts http://127.0.0.1:<port> <dir>`, which hashes the pictures,
prints every pair with its evidence and takes screenshots of the page and the graph (docs/deploy.md, "Demo and test
hubs").

## Deciding

- **Merge** makes the sides one person (the first person among them keeps its name; an identity no person holds gets
  one). Split them again from the profile. Merging you, or one of your accounts, is refused.
- **Not the same** keeps the pair out for good; **Later** for a month. Both have Undo.
- **Groups**: suggestions joined by a side they share (A~B and B~C, each at even odds or better, 3 to 8 sides) are one
  card: Merge all, or look at each pair.
- **Merge all over 90%…** opens a review with every pair at 90% or more ticked; untick any that are wrong, then merge.
  Pairs that share someone become one merge.

## Collecting profiles

Profiles are what the strongest evidence comes from, and the hub only has the ones someone opened. The adversarial
switch "Collect profiles" (docs/history.md) opens them in the background, one at a time per account and slower than a
person clicking through them, through the same command as opening a profile:

| Network | One every | At most a day |
| --- | --- | --- |
| Signal | 20 s | 1,500 |
| Matrix | 30 s | 800 |
| Telegram | 60 s | 500 |
| Discord | 90 s | 400 |
| Zulip | 90 s | 400 |
| Luma, Partiful | 10 min | 60 |
| X | 5 min | 120 |
| Messenger | 5 min | 100 |
| WhatsApp | 6 min | 100 |

In order: people you have direct chats with, then your groups, then servers' channels, then server members your
accounts recorded. A profile asked in the last 14 days is not asked again; one the network would not give is tried
again after a day. Settings shows how far each network has got.

While the switch is on, each profile's distinct versions are kept (`profile_version`): old names, handles and links
still count as evidence after they change. Turning it off is asked first and stops collecting; the versions are kept
until you forget them under Message history ("Profile versions").

## API

- `GET /api/matches` (`?side=` for one side's suggestions, without `faint`): `MatchesView`.
- `POST /api/matches/refresh`: work it out again.
- `POST /api/matches/decide` `{ key, decision: 'no' | 'later' }`, or `{ key, undo: true }`.
- `POST /api/matches/merge` `{ sides }`: returns `{ person }`.
- `GET /api/matches/pictures?limit=`, `POST /api/matches/pictures` `{ hashes: [{ identityId, url, hash | null }] }`.
- `GET /api/profiles/collect`: `ProfileCollectStatus`.
