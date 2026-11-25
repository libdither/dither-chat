# Search: one box for every network

Search covers every account on the hub at once: Discord, Signal, WhatsApp and Matrix in one list. It works like
Discord's search and adds a few things Discord lacks:

| | Discord | Here |
|---|---|---|
| Which messages | one server, or your DMs | every network and account together; `network:` and `account:` narrow it |
| Operators | from, mentions, has, before, after, during, in, pinned | the same, plus `is:edited`, `is:deleted`, `-word` and `"phrases"` |
| Results | after Enter | as you type, a moment after the last key |
| Suggestions while typing | yes | yes: people with their pictures, chats and communities, kinds, accounts, dates; and Jump to, Ctrl+K's matches |
| Recent searches | yes | yes, on this device |
| Results | grouped by channel, with jump-to | the same, with the line before and after each hit |
| Sort | newest, oldest, relevant | the same, and by default the three best matches above the newest |
| Misspellings | no | corrected when nothing matches as typed |
| Inside words, CJK | no | yes, as a fallback |
| Keyboard | — | Up and Down walk the results, Enter opens one; Ctrl+F in a chat searches that chat |

Code: `packages/protocol/src/search.ts` (`parseSearch` and the operator helpers), `packages/hub/src/store.ts`
(`search`, `searchOnce`, `matchPool`, `rankMatches`, `fillSearchIndexSteps`, `findPeople`, `surround`, `spellFix`,
`editDistance`), `GET /api/search?q=&cursor=&limit=&context=`; `packages/web/src/ui/SearchBox.tsx` (the box, its
suggestions, recent searches), `ui/Search.tsx` (tabs, filter chips, Jump to, results, Ctrl+F), `jump.ts` (what Ctrl+K
and Jump to list). Tests: `packages/hub/test/search.test.ts`, `search-time.test.ts`, `people-search.test.ts`; in a
browser, `scripts/verify-search.ts`.

## The query language

Words match whole words in any order and case, accents folded; the last word also matches as a prefix, so results
come as you type. `"two words"` is a phrase, `-word` leaves out messages with it. Anything that is not a known
operator is plain text (`http://x`, `foo:bar`).

| Operator | Means |
|---|---|
| `from:alice` | sent by people whose name, username or person name contains it |
| `mentions:me`, `mentions:alice` | mentioning you; mentioning someone (every network writes a mention as `<@id>`) |
| `in:dev`, `in:"Rust Server"` | in conversations of that name, or anywhere under a community of that name; the chat header's search uses the conversation's id |
| `has:` | `link`, `image`, `video`, `audio` (or `sound`), `file`, `attachment`, `embed`, `sticker`, `reaction` |
| `is:pinned` (or `pinned:true`) | pinned now, as the last pin or unpin the hub saw says |
| `is:edited` | edited |
| `is:deleted` | deleted and disappeared messages the hub kept (docs/history.md); nothing unless Settings → Adversarial features are shown, or when they hide kept messages |
| `network:signal` | from that network; repeat it for either of two |
| `account:main` | reached the hub through that account (by label or id) |
| `before:`, `after:`, `during:` | a day `2026-01-15`, a month `2026-01`, `today` or `yesterday`; `after:` a day means from the next day |
| `sort:` | none: the three best matches above the rest newest first; `newest` (only that), `oldest`, `relevance` (best match first, "Ranking") |

Operators other than `network:` must all hold. `searchOp`, `setSearchOp`, `searchOps` and `toggleSearchOp` read and
edit one operator in the text, which is how the filter chips work: the query stays in the URL and the box.

## How a search runs

1. **Full text** through SQLite FTS5, filters as SQL beside it. Newest or oldest first goes through `search_time`, the
   words again keyed by when each message was sent (ts × 1024, plus a few bits for messages of the same millisecond;
   `search_key` maps a key to its message). FTS5 hands rows out in key order, so a page is a walk along the index that
   stops after it, however many messages match. Prefix indexes for one and two letters keep a short last word quick:
   on about a million messages, the newest matches for `m` or `meeting t` in under 5 ms, against 160 and 440 ms without
   them and 0.4 to 0.8 s sorting every match by time. They cost about 0.3 ms more to write each new message. The older
   `message_fts` still serves the inside-words fallback, the words for corrections, and every search until
   `search_time` is filled in.
2. **Inside words** with `LIKE` when the full text finds nothing, or when a word has CJK in it (unspaced Japanese is one
   long token). The results say so.
3. **Corrected**: still nothing, so each word the index does not have is swapped for the nearest one it does: same first
   letter, one edit for words under seven letters, two for longer ones, a swap of two letters counting as one; the
   commonest wins a tie. The words come from `message_fts_vocab` (an `fts5vocab` table). The page carries
   `corrected`, the query it is really for, and the next pages use it. About 60 ms for 200 000 messages.

Paging is by cursor: `t<key>` along `search_time`, time and rowid the old way, an offset for `sort:relevance`.
`context=n` (at most 3) adds the n messages before and after each hit in its conversation; the web asks for one.

**Filling in the time index.** Triggers on `message` keep `search_time` current. A database from before it gets its
older messages put in once, newest first, 128 to a slice (`fillSearchIndexSteps`, started by main.ts 90 s after the
hub starts; meta `search_time_rowid` is how far down it got, so a restart goes on from there, and
`search_time_ready` says it is done). On a copy of a hub with about a million messages that took about two minutes, a
slice 11 ms at the median and 116 ms at the 99th percentile, with a handful near a second (FTS5 merging its segments).
A taken key moves up to the next free one, in the trigger and the fill alike, so a message always goes in.

## Ranking

Best match (`sort:relevance`) and the top matches rank the newest matches (2000 for Best match, 600 for the top
three) by `rankMatches`:

```
score = text × lately × (0.5 + closeness + who)

text      = 0.45 × how much of the message is the words (words matched / (words in it + 4)), against the most in
            the pool + 0.4 × the share of words matched whole (the last, still being typed, counts half as the start
            of a longer word) + 0.15 × the words together, in order. Not FTS5's bm25: for a short last word it scores
            every word that word starts, 100 to 800 ms on a big hub.
lately    = 0.3 + 0.7 × 2^(−age / 60 days)
closeness = 0.4 a DM, 0.25 a group, 0.1 a channel; + 0.35 × (1 − e^(−your messages there / 20)) + 0.25 × 2^(−since
            you last wrote there / 30 days)                        (conv_feature, the inbox's fold: docs/inbox.md)
who       = 0.1 when you said it or the author is a person of yours
```

Each top match carries `why`, its reasons in a few words ("recent · DM · you talk often"), shown under it. There are
top matches only with no `sort:`, on the first page, when there are more than three hits, and once a word has three
letters (ranking all that `m` starts is slow and says little).

Times on that copy, the whole search with people and one line of context: tens of ms for one or two letters and
about 100 to 200 ms for longer words on a machine under heavy load (before: 120 ms for a rare word to 2 s for one
letter, unloaded). Drawing the 50 hits and their context is most of what is left.

## People

The first page also carries the people the words find (`SearchPage.people`, `findPeople` in store.ts), best first,
twelve at most and one identity per person. It looks in a list held in memory, every identity's names and notes folded
into one string: loaded once in slices after start (`loadPeopleSteps`), then kept current from `people_dirty`, which
triggers on identity, person, about and change_log fill with the identities written since. A search reads only those
again. (Before, each search ran `LIKE` over every identity, its old names and kept bios: 120 to 250 ms a key.) Every word must be somewhere among an account's display name, handle,
names and handles from before a rename (the change log, docs/history.md), your nickname for it, the person's name,
your note, the network's nickname and note, their status, and the bio from their kept profile (docs/profile.md).

Ranked by where the words landed: the name shown, then the display name, the handle, a nickname, an old name, a note,
and a status or bio last; all of the name beats its start, its start beats a word inside it, and that beats the middle
of a word. Several words typed as the whole name beat the same words scattered. Then a person of yours counts for more
than how much someone posts, so a friend whose handle holds the word comes before busy strangers whose names start
with it, though not before one whose name is the word. Each person carries `match`, what matched when the name shown
does not: their handle, "was <old name>", a note or a piece of their bio, with the words marked.

Case and accents fold on both sides: `zoe` finds Zoë. (`from:` is still `LIKE`, where accents must be typed.)

## In the app

- **As you type**: results come 150 ms after the last key (`TYPE_PAUSE_MS`), no Enter needed; what was found for the
  last words stays, dimmed, with a spinner in the box, until the new answer replaces it. On a computer the first
  letter typed in the inbox's box opens the search page, which takes the cursor and the letter. On a phone a tap on
  the inbox's box opens the search page with the keyboard up. A search goes into Recent on Enter or when you open
  one of its results, not at every key.
- **Loading**: the search page is a chunk of its own (`ui/Search.tsx`, its styles in `ui/search.css`), loaded the
  first time it opens; focusing the inbox's box starts loading it, so it is usually there by the first key. Ctrl+F
  and the box's focus signal stay in the startup bundle (`ui/SearchLazy.tsx`).
- **The box** (the search page and the inbox's) lists the operators when empty, under recent searches. Typing a word
  lists operators it starts; after `from:`, `in:` and the rest it lists values. Up and Down choose, Enter or Tab take
  (with a value half typed, the first is chosen already), Escape closes; with the list closed, Escape leaves search
  for where you were (docs/desktop.md "Escape and back"). A chat picked after `in:` goes in as its id
  (names repeat, and a direct chat has none), shown as the In chip under the box rather than in the text; the box keeps
  the words. An `in:` typed with a name replaces the chip.
- **Tabs** under the box: All, Messages, People, Chats, Pictures (`has:image`, as a grid), Links (`has:link`), Files
  (`has:file`). A tab adds its `has:` to what is sent, not to the box.
- **Filter chips**, one row: From, In (both pick from what Ctrl+K would jump to, or take a name as typed), Date (today,
  the last 7 or 30 days, this year, or two dates), Network (only with accounts on more than one), Mentions me, More
  (pinned, edited, deleted when kept messages are shown, has a file, link, embed or reactions), and the sort. A set chip
  shows its value and an × that clears it.
- **Jump to** first: Ctrl+K's matches for the words (`jump.ts`), people, chats, communities and folders, ranked as
  Ctrl+K ranks them, from what the app holds, so they show at the first letter, before the hub answers. Only names that
  hold the words as typed: Ctrl+K's scattered letters are left out. Five in All, every one in People and Chats.
- **People** next: the hub's, less those Jump to shows, each with what matched under the name when the name does not
  show it.
- **Top matches**, then **Newest**: with no sort, the three best ("Ranking") with their reasons, then the rest newest
  first.
- **Results**: hits in a row from the same conversation share a heading; each hit has its line before and after,
  dimmed. Click a hit or a line to jump there. Down from the box goes into the results.
- **Ctrl+F** in a chat opens search in that chat; on the search page it goes to the box.
- **Mail**: when the hub has mail, a Mail group sits above the results with mail's own top five threads and a way into
  Mail's search (docs/mail.md). It is a request of its own, so the chats' results never wait for it, and it is left out
  when the query is about chats (`network:`, `mentions:`, `in:`, `is:`, a kind of file: `mailSearchable`).
- Recent searches live in `localStorage` (`dc.recentSearches`, eight), per device, cleared from the list.

## Left out

- `has:poll`: no adapter stores polls yet.
- Earlier versions of edited messages are not searched, only what a message says now.
- Typo correction does not fix the first letter, phrases, or words in scripts without spaces.
- The networks' own search is a separate step you start, under the results: docs/indexing.md, "Network search".
  To have a whole server searchable here, index it (same doc).
