# Search: one box for every network

Search covers every account on the hub at once: Discord, Signal, WhatsApp and Matrix in one list. It works like
Discord's search and adds a few things Discord lacks:

| | Discord | Here |
|---|---|---|
| Which messages | one server, or your DMs | every network and account together; `network:` and `account:` narrow it |
| Operators | from, mentions, has, before, after, during, in, pinned | the same, plus `is:edited`, `is:deleted`, `-word` and `"phrases"` |
| Suggestions while typing | yes | yes: people with their pictures, chats and communities, kinds, accounts, dates |
| Recent searches | yes | yes, on this device |
| Results | grouped by channel, with jump-to | the same, with the line before and after each hit |
| Sort | newest, oldest, relevant | the same |
| Misspellings | no | corrected when nothing matches as typed |
| Inside words, CJK | no | yes, as a fallback |
| Keyboard | — | Up and Down walk the results, Enter opens one; Ctrl+F in a chat searches that chat |

Code: `packages/protocol/src/search.ts` (`parseSearch` and the operator helpers), `packages/hub/src/store.ts`
(`search`, `searchOnce`, `surround`, `spellFix`, `editDistance`), `GET /api/search?q=&cursor=&limit=&context=`;
`packages/web/src/ui/SearchBox.tsx` (the box, its suggestions, recent searches), `ui/Search.tsx` (filters,
results, Ctrl+F). Tests: `packages/hub/test/search.test.ts`; in a browser, `scripts/verify-search.ts`.

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
| `is:deleted` | deleted and disappeared messages the hub kept (docs/history.md); nothing when Settings → Message history hides them |
| `network:signal` | from that network; repeat it for either of two |
| `account:main` | reached the hub through that account (by label or id) |
| `before:`, `after:`, `during:` | a day `2026-01-15`, a month `2026-01`, `today` or `yesterday`; `after:` a day means from the next day |
| `sort:` | `newest` (the default), `oldest`, `relevance` (best match, then newest) |

Operators other than `network:` must all hold. `searchOp`, `setSearchOp`, `searchOps` and `toggleSearchOp` read and
edit one operator in the text, which is how the filter chips work: the query stays in the URL and the box.

## How a search runs

1. **Full text** through SQLite FTS5 (`message_fts`, kept current by triggers), filters as SQL beside it.
2. **Inside words** with `LIKE` when the full text finds nothing, or when a word has CJK in it (unspaced Japanese is one
   long token). The results say so.
3. **Corrected**: still nothing, so each word the index does not have is swapped for the nearest one it does: same first
   letter, one edit for words under seven letters, two for longer ones, a swap of two letters counting as one; the
   commonest wins a tie. The words come from `message_fts_vocab` (an `fts5vocab` table). The page carries
   `corrected`, the query it is really for, and the next pages use it. About 60 ms for 200 000 messages.

Paging is by cursor (time and rowid), or by offset for `sort:relevance`. `context=n` (at most 3) adds the n messages
before and after each hit in its conversation; the web asks for one.

## In the app

- **The box** (the search page and the inbox's) lists the operators when empty, under recent searches. Typing a word
  lists operators it starts; after `from:`, `in:` and the rest it lists values. Up and Down choose, Enter or Tab take
  (with a value half typed, the first is chosen already), Escape closes. A direct chat goes in as its id, shown as a
  chip under the box rather than in the text.
- **Filters** under the box: networks, kinds, mentions, pinned, edited, deleted (hidden when kept messages are set to
  stay out of sight), the sort, and From, In, After, Before fields.
- **Results**: hits in a row from the same conversation share a heading; each hit has its line before and after,
  dimmed. Click a hit or a line to jump there. Down from the box goes into the results.
- **Ctrl+F** in a chat opens search in that chat; on the search page it goes to the box.
- Recent searches live in `localStorage` (`dc.recentSearches`, eight), per device, cleared from the list.

## Left out

- `has:poll`: no adapter stores polls yet.
- Earlier versions of edited messages are not searched, only what a message says now.
- Typo correction does not fix the first letter, phrases, or words in scripts without spaces.
- No search on the networks themselves: only what the hub has fetched is found.
