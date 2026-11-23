# One document for everything written

Research and a design, 2026-11-22, in its second round. Nothing in the app uses it yet. It asks whether one data
structure can hold what a person writes for every network (a chat message, a post, a comment, a mail), and whether
one editor can write it, as small as a chat box or as large as a mail window. The answer here is yes, with one
condition that the first round missed: the model has to check its own output, because a table of what each network
"supports" is not enough to promise that what arrives is what was written. A prototype on the branch
`research/writing-model` tries it against fifteen networks (`packages/protocol/src/writing`, with tests, and a page
in `packages/web/proto/writing`).

## Today: three models, three boxes

| | Chats | Posts | Mail |
|---|---|---|---|
| What is kept | `body`: a Discord-flavoured Markdown string with tokens (`<@id>`, `<t:…>`), `protocol/src/adapter.ts` | `text`: plain, links expanded (`protocol/src/feed.ts`) | the mail's HTML, plus Markdown for the text part |
| The box | a `<textarea>` with a chip layer (`ui/Timeline.tsx` `Composer`); no formatting controls | two more textareas (`ui/feed/Composer.tsx`, `FeedPage.tsx`) | Tiptap with four views (`ui/mail/editor`) |
| To the network | each adapter converts the string itself: `toSignal`, `toTelegram`, `toWhatsApp`, `markdownToMatrix`, `toZulip`, `toPlain` (dither-accounts) | the string as typed; Bluesky finds facets in it | the hub builds the parts |
| From the network | each adapter converts to the string; Matrix tables, Telegram custom emoji and headings are approximated | Mastodon's HTML, Substack's marks and Bluesky's mention facets are dropped | kept whole |
| What is lost on the way out | not said to the writer: underline vanishes on Signal, a spoiler is readable on WhatsApp | | said only for pictures |

The three share no code: the mail editor's formatting helpers, the chat box's mention and emoji pickers and the
post box's counters each serve one box. Chat and mail Markdown are different dialects (`__x__` is underline in
one and bold in the other).

## What the networks carry

Read from each network's own documentation or source on 2026-11-22. "Unconfirmed" means no primary source was
found. A wire form is how formatted text goes: **marks** (marker characters typed into the text), **ranges**
(plain text with a list of stretches beside it), **HTML**, **blocks** (the network's own tree), or **plain**.

### Chats

| Network | Wire form | Styles | Blocks | In the text | Offsets | Limit |
|---|---|---|---|---|---|---|
| [Discord](https://docs.discord.com/developers/reference#message-formatting) | marks | bold, italic, underline, strike, code, spoiler, link with words | heading 1–3, subtext, list, quote, code | user, role, channel, everyone, command, custom emoji, time | | 2000 characters |
| [Signal](https://raw.githubusercontent.com/signalapp/Signal-Android/main/lib/libsignal-service/src/main/protowire/SignalService.proto) | ranges | bold, italic, strike, monospace, spoiler | none | user (one stand-in character) | UTF-16 units | 2 KiB in the message, longer as a file |
| [Telegram](https://core.telegram.org/api/entities) | ranges (a [block tree](https://core.telegram.org/bots/api#rich-messages) too, for bots) | bold, italic, underline, strike, code, spoiler, link with words | quote, folding quote, code with language | user, custom emoji, tag, command | UTF-16 units | 4096; a caption 1024 |
| [WhatsApp](https://faq.whatsapp.com/539178204879377) | marks (wire unpublished) | bold, italic, strike, monospace, code | list, quote | member, all | | unconfirmed |
| [Matrix](https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes) | HTML and a plain `body` | bold, italic, underline, strike, code, sub, sup, colour, spoiler, link | heading 1–6, quote, list, code with language, table, rule, details | user and room (in `m.mentions`), picture, maths | | the event, 65536 bytes |
| [Slack](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block) | blocks and a marks fallback | bold, italic, underline, strike, code, link | list (nested by indent, not as a tree), quote, code with language | user, group, channel, broadcast, emoji, date | | 40,000 |
| [Zulip](https://zulip.com/help/format-your-message-using-markdown) | marks out, HTML back | bold, italic, strike, code, link, LaTeX | list, quote, code with language, spoiler block, table, rule | user, group, all, topic, channel, time, emoji | | 10,000 code points (the server's) |
| [Teams](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0) | HTML | bold, italic, underline, strike, link | rule, code block | `<at>` with a list beside it, emoji | | about 100 KB |
| [Google Chat](https://developers.google.com/workspace/chat/format-messages) | marks out (two dialects), ranges back | bold, italic, strike, code, link | list, quote, code; headings and tables in one dialect | user, all, custom emoji | unstated | 32,000 bytes |
| [iMessage](https://support.apple.com/guide/iphone/format-text-and-animate-messages-iphe5c5af4d4/ios) | unconfirmed | bold, italic, underline, strike, eight animated effects | none | person | | unconfirmed |
| [SMS](https://www.etsi.org/deliver/etsi_ts/123000_123099/123040/18.00.00_60/ts_123040v180000p.pdf) | plain | none | none | none | | 160 plain letters or 70 others a text; 153 or 67 once split |
| [RCS](https://media.gsma.com/assets/2026/rcs/RCC.71+v4.0.pdf) | ranges | bold, italic, underline, strike | none | none | UTF-16 units | 8192 bytes |
| [Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-platform-send-api.md), Instagram | plain | none documented | none | none documented | | 2000; 1000 bytes |
| [IRC](https://modern.ircdocs.horse/formatting) | marks (control characters) | bold, italic, underline, strike, monospace, colour | none | none | | 512 bytes a line |
| XMPP ([0393](https://xmpp.org/extensions/xep-0393.html), [0394](https://xmpp.org/extensions/xep-0394.html)) | marks, or ranges | strong, emphasis, strike, code | quote, code | | code points | |
| [X messages](https://docs.x.com/x-api/direct-messages/create-dm-message-by-participant-id.md) | plain | none | none | found by the server | unstated | unconfirmed |

### Posts, comments and mail

| Network | Wire form | Styles | Blocks | In the text | Beside the text | Limit |
|---|---|---|---|---|---|---|
| [X](https://docs.x.com/fundamentals/counting-characters) | plain; entities found by the server | none | none | mention, tag, link | who can reply, poll | 280 weighted, a link 23 |
| [Mastodon](https://docs.joinmastodon.org/methods/statuses/) | plain out, [HTML](https://docs.joinmastodon.org/spec/activitypub/) back | back: bold, italic, underline, strike, code, link | back: quote, list, code | mention, tag, `:emoji:` | content warning, audience, language, poll | 500, a link 23 |
| [Bluesky](https://raw.githubusercontent.com/bluesky-social/bsky/main/lexicons/app/bsky/richtext/facet.json) | ranges | none | none | mention, link with words, tag | languages, labels, who can reply | 300 graphemes and 3000 bytes; offsets in bytes |
| [Threads](https://developers.facebook.com/documentation/threads/posts) | plain, spoiler ranges | spoiler | none | one tag | who can reply, alt text, poll | 500 |
| [Reddit](https://www.reddit.com/dev/api/) | marks, or [blocks](https://raw.githubusercontent.com/reddit/devvit/main/packages/shared-types/src/richtext/types.ts) | bold, italic, strike, sup, code, spoiler, link | heading, list, quote, code, table, rule | `u/`, `r/` | title, subreddit, flair | unconfirmed (10,000 and 40,000 in old source) |
| [Lemmy](https://raw.githubusercontent.com/LemmyNet/lemmy-ui/main/src/shared/utils/markdown.ts) | marks | bold, italic, strike, sub, sup, code, link | heading, list, quote, code, rule, spoiler block | user, community | title, community, language | 50,000 a post, 10,000 a comment |
| Substack | blocks (ProseMirror), seen not documented | bold, italic, link | paragraph | mention | | unconfirmed |
| [LinkedIn](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format) | marks, for mentions only | none | none | mention, tag | audience | unconfirmed |
| Nostr ([10](https://raw.githubusercontent.com/nostr-protocol/nips/master/10.md), [23](https://raw.githubusercontent.com/nostr-protocol/nips/master/23.md)) | plain; long-form Markdown | none; Markdown's | none; Markdown's | `nostr:` links | subject, warning, title | the relay's |
| [GitHub](https://github.github.com/gfm/) | marks, HTML allowed inside | bold, italic, strike, code, link; underline, sub, sup as HTML | heading, list, task list, quote, code, table, rule, alert, details | user, team, issue | | unconfirmed |
| [Hacker News](https://news.ycombinator.com/formatdoc) | marks, with `\*` for a star | italic | code | | | |
| [YouTube](https://support.google.com/youtube/answer/6000964?hl=en) | marks | bold, italic, strike | none | | | unstated |
| [Tumblr](https://raw.githubusercontent.com/tumblr/docs/master/npf-spec.md) | blocks, each with ranges | bold, italic, strike, small, colour, link | heading, quote, list, picture | mention | tags | 4096 a block; offsets in code points |
| Mail ([RFC 2046](https://www.rfc-editor.org/rfc/rfc2046.txt), [3676](https://www.rfc-editor.org/rfc/rfc3676.txt)) | HTML and a plain copy | anything HTML and the reader's app allow ([Gmail's list](https://developers.google.com/workspace/gmail/design/css)) | anything | | subject, To, Cc, Bcc | lines of 998 |


### What follows

- **There are five wire forms, and no one of them holds the others.** Marks cannot say overlapping styles without
  splitting them, and cannot say every run of styles at all (`***` then `*` reads as one longer mark). Ranges have
  no blocks. HTML is forbidden on some networks and has no safe subset for mail. Each network's blocks are its own.
- **The same characters mean different things.** `*x*` is bold on WhatsApp, Slack, Google Chat, XMPP and YouTube,
  and italic on Discord, Zulip, Reddit and GitHub. `~x~` is strike on WhatsApp and subscript on Lemmy. A line break
  is a new line in a chat and nothing at all in GitHub's Markdown. A string of marks is only meaningful together
  with the name of its dialect.
- **Two networks cannot write a marker as itself.** WhatsApp and YouTube have no escape: `2 *3* 4` typed there
  turns bold, whatever the writer meant. Everywhere else a marker can be escaped, each dialect in its own way.
- **Ranges may overlap on some networks and not on others** (Signal and RCS: freely; Telegram: only nested;
  Bluesky and Threads: not at all), and offsets count three different things: UTF-16 units, bytes, code points.
- **What goes out is often not what comes back.** Mastodon takes plain text and returns HTML. Zulip takes marks
  and returns HTML. Slack takes blocks and a fallback string.
- **Length is counted seven ways:** UTF-16 units, code points, graphemes, bytes, X's weights, links at a fixed
  23, and SMS's texts of 160 or 70.
- **A mention is an id, not words,** and the same person has a different id in every place: a user id, a DID, a
  URN that must match the name, one stand-in character with a range over it.
- **Half of a post is beside its text:** a title, a place, a content warning, an audience, who may reply, a
  subject and recipients. The same thing has four shapes: a spoiler is a style (Discord), a block (Zulip, Lemmy),
  a range (Threads) or a warning over the whole post (Mastodon).
- **Some features have one home:** animated text (iMessage), subtext (Discord), a folding quote (Telegram).
- **The limits belong to a place, not a network:** a Mastodon server sets its own length, a Telegram caption is
  shorter than a message, a Reddit comment has no title, a Discord server has its own emoji and roles.

## The model

One tree and five functions (`packages/protocol/src/writing`, about 2,500 lines):

```
send(words, place) = make sound → fit → encode → count, split → read back → compare
outcome(draft)     = send for each of its places, and whether it may go
```

| Part | File | What it is |
|---|---|---|
| the document | `doc.ts` | what was written: a tree |
| a profile | `profile.ts` | what one place carries: data, and the few small functions its wire needs |
| fit | `fit.ts` | the draft, stepped down to what the place carries, with every change listed |
| encode | `encode.ts` | the fitted draft as that place's wire |
| read | `read.ts` | a marker string read as its place reads it |
| check | `check.ts` | two trees compared: words lost, hidden text shown, a line read differently |
| a draft | `draft.ts` | the words, the places they go to, what is one place's alone, and where it has been |

### 1. The document

A tree, in the shape the editor already uses (ProseMirror's JSON: `type`, `attrs`, `content`, `marks`, `text`),
so the draft being edited, the draft that is saved and what is handed on are the same value. A stored draft says
which version of the format it is in (`Draft.v`).

- **Blocks:** paragraph, heading, quote, list, code block, rule, table, picture, **fold** (a titled block the
  reader opens: a spoiler block, details; it says whether it hides something or only saves room) and **raw** (a
  block kept exactly in a format of its own, with its words beside it: the mail editor's "kept as its own HTML").
- **Text is runs with a set of marks,** never nested marks: bold, italic, underline, strike, code, spoiler, link,
  colour, sub, sup. Two styles overlap freely, as on Signal, and a network that needs nesting gets it made when
  the text is written out. No offsets are kept, so no unit is chosen.
- **Things in the text that are not words:** a mention, a time, a custom emoji. A mention is a person (or a
  role, a channel, everyone) with a label and **their id in each place they can be reached**; which id goes is
  decided when it is sent.
- **A paragraph is a line, and an empty paragraph is an empty line.** There is no line break inside a paragraph.
  That is what Enter means in a chat box, and it writes out exactly on every network: one new line in a chat, a
  hard break in GitHub's Markdown, a `<div>` in mail.
- **A kind this version does not know is never dropped unsaid.** Its children go on as what they are, its words
  are kept, and the change is listed.
- **A tree from elsewhere is untrusted, and is made sound once, before anything else** (`sound`): another
  device, a newer client and a pasted page can hand over anything. Text is text, a line end inside a line becomes
  a new line, a name that is not a name goes as words, a level, a time and a start are numbers in range, an id
  is made of the characters ids are made of, an attribute is a word or a number and never a thing with code in
  it, words standing where their kind cannot stand are put where it can (a word directly under a list becomes an
  item), and what is nested deeper than forty goes as its words. An address is parsed and, where a marker would
  end at one of its characters, percent-encoded. The writers lean on this. Two reviews each found a place where
  they leaned too far, and the tests now hold every case either used; that is a list of cases, not a proof.

**Raw is what makes the structure total, for blocks.** Anything a network sends that the tree has no kind for is
kept as a raw block in that network's own format, so receiving never has to destroy anything, and a writer who
wants a newsletter's exact HTML, or their own HTML, keeps it. Raw HTML stands among other text only if it **keeps
to itself** (`contained`): every tag it opens it closes, no comment is left open, and nothing in it reaches
outside (a style sheet, a title, something marked hidden). Otherwise it would swallow, restyle or uncover the
writer's own words around it, so it goes as its words and that is said. There is no raw for a thing inside a
line yet (inline maths, a command mention, a task-list box): those go as their words.

### 2. A place's profile

A place is where something written goes: a chat on Signal, a subreddit, a mail thread. Its profile is mostly
data: the blocks, marks and things in the text it carries as themselves; its rules (how deep a quote may nest, which kinds
of mention exist, whether a table cell is one line, whether text inside code may be styled); its limits, how each
is counted and what happens past them (refused, split into messages, or a thread); the fields it has beside the
text; and how its wire is written. The rest is a handful of one-line functions for what a table cannot say:
how its wire names a person, how it escapes a character, what goes beside the text.

Three rules came out of the second review, and each is one word in a profile rather than code in a writer:

- **`space`**: whose ids a place's people and emoji are known by. Two Slack workspaces are two spaces; a mention
  and a custom emoji carry an id for each space, and a Discord emoji id is never sent to Telegram.
- **`apart`**: a mention found by its characters must not touch a letter (`mail@kitten` is someone else), and
  on Zulip must follow a space. Fitting puts the space in.
- **what a file can do**: no files at all (IRC), a file that can be hidden (Discord, Telegram), a shorter limit
  for a caption.

**A profile is a slice of the document**, and the slices the question asked about are profiles: Signal's is
"lines, five marks, mentions"; Reddit's is "most blocks, seven marks, a title and a subreddit"; mail's is
"nearly everything, and raw HTML"; SMS's is "words".

**A profile belongs to a place, not a network.** `at(profile, changes)` makes the profile of one place from its
network's: a Reddit comment is Reddit without a title, a Mastodon server brings its own length, a caption its
shorter limit. `PostRules` (`protocol/src/compose.ts`) is already this for six networks' fields and counters; a
profile is that for every place and for the text too.

### 3. Fitting: every kind has a ladder

`fit(draft, profile)` returns a draft the place can carry and a list of what changed. It knows no network. Each
kind has a fixed ladder of steps down, ending in plain words, and the profile says where a step is available:

| Kind | Steps down |
|---|---|
| heading | a smaller heading → a bold line → a line |
| quote, a quote in a quote | lines starting with `>` |
| list, a list in a list | lines starting with a dash or a number, indented |
| code block | without its language → lines of code → lines |
| table | lined-up text in a code block → that code block's own steps → lines `a \| b` |
| fold | hidden text under a bold title → **open text** |
| raw | its words |
| picture | a file beside the text |
| rule | a line of dashes |
| spoiler | **open text** |
| link with words | the words, then the address in brackets |
| strike, sub, sup | the plain-text convention (`~x~`, `^x`, `_x`) where the place has no such style |
| other marks | dropped |
| mention | their name as words: **tells nobody** |
| time | written out in one time zone |
| custom emoji | `:name:` |

A step lands on the next step, not at the bottom: a table on Signal becomes monospace lines, because Signal has
no code block but has code. What is hidden stays hidden through every step: a hidden cell of a table that became
lines is still hidden.

A person who cannot be told in a place goes as their name, and **a name tells nobody**: it is its owner's choice
of words, so an `@` or a `u/` inside it is taken out, or "Kit (@nasa)" would tell a stranger. What stands in for a
custom emoji is an emoji of everyone's or its `:name:`, never words. What comes right after a web address (a
mention, the words of another link) is kept apart from it by a space, or every network would take it for part of
the address.

Every change has a level, and the levels decide what the writer is shown:

| Level | Example | Shown |
|---|---|---|
| restyled | a heading in bold | only in "How it arrives" |
| flattened | a list as dashes | only in "How it arrives" |
| dropped | underline on Signal, a subject on a chat | only in "How it arrives" |
| **exposed** | a spoiler on WhatsApp or SMS: something the writer hid can be read | in the text, under the box, and asked about at Send |
| **blocked** | over a limit that refuses, a missing title, words that would not arrive | Send is off for that place |

Fitting twice changes nothing more and says nothing more, and a fitted draft only holds what its place carries
(both tested on random drafts).

### 4. Writing out: two tables and a side channel

`encode(fitted, profile)` writes the wire. The first round had four families of writer. Networks do not fall
into families that cleanly, so a writer is now three independent choices a profile makes:

| Choice | The options | Who |
|---|---|---|
| how blocks are written | marker lines, HTML, the network's own tree, or none (lines only) | |
| how text is written | marker characters, ranges beside plain text, HTML, the network's tree | |
| what goes beside the text | `allowed_mentions`, `m.mentions`, `spoiler_text`, a subject, recipients | Discord, Matrix, Mastodon, mail |

Markers differ in the character for each style and block, the escape, whether a paragraph is a line or needs a
blank line, how a marker is told from a star in the text (by the words around it on WhatsApp, by CommonMark's
flanking rule on GitHub, Reddit and Zulip), and whether runs of spaces collapse. Ranges differ in the unit, the
names, and whether ranges may cross (Telegram's must nest, so a crossing pair is cut in two).

### 5. Reading back: the model checks itself

The first round promised "encode loses nothing". A review found that false in a dozen ways: a star typed between
two words turned bold on WhatsApp, a URL beside an underscore lost its tail, hidden text inside code came out
readable, two lists side by side merged. A table of features cannot see any of that.

So `send` does not trust its writers. For a marker network it **reads its own wire back** the way that network
reads it, and compares three trees, the draft, the fitted draft and the wire as read:

- a word of the draft that is not in what was read: **blocked**, "Some words would not arrive", with the words;
- text hidden in the draft that is readable in what was read: **exposed**, with the words;
- a line that reads differently from what was fitted: "A line is read another way there", with the first such
  line.

The comparison is by run of text, in order: each run of the draft has to be found, whole, after the one before
it, in letters no other run was found in ("no" is not found inside the "know" of the line above), and a hidden
run inside what is still hidden. (The second review broke an earlier version that only asked whether the
hidden letters turned up anywhere: "Sam" counted as still hidden because an `s`, an `a` and an `m` were hidden
somewhere else.) Text with no letter in it, a price in `$$$`, an emoji, is checked too.

Loss and exposure are therefore computed from the result, not from the list of steps taken. For marker wires a
bug in a ladder or a writer shows up as a notice to the writer instead of a silent leak. For the other three
families there is nothing to read back, and what protects them is the fit and the tests. The reader is also a
model of each network's parser, not the parser, so the tests carry **a second reading that shares no code with
the model** (`test/writing-oracle.ts`): what each wire shows without a tap, by the network's documented syntax,
with GitHub's read by a real CommonMark parser. See "The prototype" and "What is not shown" below.

Two leaks that no reader of the main wire could see were closed by rule. A network's **plain copy** (Matrix's
`body`, a mail's text part) is what a notification shows, so hidden text is left out of it and "[hidden]" stands
in. A **picture inside a fold** goes as a file marked hidden where the place can do that, and is said to be shown
where it cannot.

### Beside the text

Fields exist **only where a place has them**. A title written for Reddit is not turned into a bold first line on
X behind the writer's back; it is left out there and that is said, with one click to put it first. A content
warning written for Mastodon is an exposure on X, with one click to send the text there under a fold or as hidden
text titled with the warning; and where a place puts the whole post behind its warning, text that was hidden
inline counts as behind a tap, not as shown.

| Beside the text | Where the place has none |
|---|---|
| subject or title | left out, said; or the first line, in bold, if asked |
| content warning | said as an exposure; or a fold over the text, if asked |
| recipients (To, Cc, Bcc) | they are the place itself: see "A draft and its places" |
| a reply | the network's own reply → a quote of the original above the text → nothing |
| a file, a picture in the text | attached → a link to it |
| silent, send later, disappearing | the network's own → the hub's (send later) → not offered |

The prototype does the first three rows and pictures.

### What is stored

The tree is the truth; a string is one writing of it. The chat `body` stays as it is: it is a marker dialect with
our own table. Two things follow from the review:

- `body` is read in more than one place today (the web, the hub's search and previews, each adapter). It needs
  **one shared reader and a dialect version**, so a change to the dialect cannot make old messages read
  differently.
- A message **we sent** keeps its draft tree beside the string, so editing it later starts from what was written,
  not from a reading of what one network made of it. Nothing already stored has to change.

### Where it runs

The hub fits and writes; an adapter carries the wire it is handed and reports what the network said. The web
runs the same code (it is in `protocol`) to show what will arrive while typing, and the hub does it again at
send, since it does not trust a client's tree. Today each of dither-accounts' converters (`toSignal`,
`toTelegram`, `toWhatsApp`, `markdownToMatrix`, `toZulip`, `toPlain`) does this in its own way; with this each is
a profile, tested once together.

## The editor

One box (`packages/web/proto/writing/main.tsx` is a rough one). It has no modes and no sizes to choose. What it
shows follows from where the draft goes.

- **As small as the draft.** A chat with one way to reach someone is a line of text and Send: no fields, no
  toolbar, no route. The box grows with the text. `Aa` opens the row of styles and blocks; one button opens the
  box up for long writing. A mail starts opened up. The first round's four named sizes are gone: nobody should
  have to pick one.
- **Controls come from the places.** A control is there when some place the draft goes to carries what it makes.
  Writing to Signal offers five styles; to SMS, nothing, and `Aa` is not shown at all; to mail, the lot.
- **Typing follows the same rule.** `**bold**`, `> `, `- `, `||hidden||` and `@kit ` turn into what they mean as
  they are typed, but only where some chosen place carries it: in a draft for SMS, stars stay stars. Pasted text
  is not converted. Italic needs its stars tight against the words, so `2 * 3 * 4` and `snake_case` stay as
  typed. `[words](https://…)` is a link where a link can have words of its own.
- **How the box behaves comes from what is written at the places chosen, not from the page it is on.** Every
  profile has a role: chat, post, comment or mail. Enter sends when the draft goes to one chat and the box is
  not opened up; anywhere else it is a new line and Ctrl+Enter sends. A mail starts opened up. The word on the
  button and the hint in the empty box come from the role too. Shift+Enter is always a new line, and a new line
  is always a new paragraph.
- **Fields only where a place has them.** Subject for mail, title and subreddit for Reddit, a content warning for
  Mastodon. They appear with the place and go with it; what was typed in them is kept, and with several places
  chosen each field says whose it is. What the thing under the caret holds beside its words (a link's address, a
  fold's title) is one line in the box while the caret is there.
- **Quiet while what arrives is what was typed.** No dots, no counters far from a limit, and "How it arrives" is
  closed until asked for. A count shows on a short post's place always, and elsewhere only near the limit.
- **When it is not, the words are marked where they stand.** Hidden text that some place would show is tinted
  with a red line under it (not a wavy one: that reads as a spelling mistake) and says where on hover; a mention
  that some place cannot deliver is dotted. Under the box, one line for each
  problem names the places and the words ("Hidden text can be read on X, Bluesky and Mastodon: “ends at the
  lighthouse”"), with what can be done about it: make it a thread, give it a content warning, write that place
  separately, leave it out. Send asks before it exposes anything: send anyway, send to the others only, or go
  back.
- **Nothing out of reach.** A tool is also there while the caret is on the thing it makes, so hidden words can be
  un-hidden in a draft that now goes by mail; a style's keys (Ctrl+B) do nothing where no place carries the style;
  Escape leaves a menu, the question before sending and a link being added; undo stays inside one draft, so what
  was sent, or typed for another place, never comes back into the box.
- **A draft goes whole.** While one place cannot take it (too long, no title), Send waits and says which place
  and why, and the button counts every place chosen. The earlier design sent to the rest and quietly skipped
  that place, which a review rightly called the worst outcome: half a post out, and nothing saying so. When the
  writer chooses "to the others only", the places it went to are ticked and the draft stays for the rest.
- **Every choice has a way back.** A thread, a title put as the first line and a warning put first are chips
  under the box, each with a ✕. A place left out keeps what was written for it, and has it again when put back.
- **Everything else is one line:** "Looks different on Signal · See how" opens "How it arrives", which shows, for
  each place, every change, the draft as its readers will get it (the wire, read back; a thread post by post),
  the wire itself, and the draft as it is kept. It is also in every place's menu.
- **One place or several.** In a chat the route is a switch ("To Kit on Signal ▾"): one at a time, and the draft
  stays when it is switched. For a post the places are chips, any number, each with a menu of its own (thread,
  write separately, leave out). A place written separately gets a tab with its own wording; the shared draft goes
  to the rest.
- **Blocks with an editor of their own** stay as they are in the mail editor: a raw block is drawn as it will
  arrive with its source under it, a code block is a code editor, a quote of an original carries who wrote it.
  A draft is in that sense already "different editors for different sections", and that is the only place the
  idea is needed.
- **Three ways to write the same draft.** Rich text with the buttons, Markdown with the markers left standing,
  HTML. The next section.

### Ways of writing: rich text, Markdown, HTML

A person may write the draft, or one part of it, another way (`packages/protocol/src/writing/lens.ts`, and
`packages/web/proto/writing/parts.ts` for the editor side):

- **Rich text**: the tree itself. A style is put on the words with a button, a key or typed markers that go away.
- **Markdown**: the markers stay where they were typed, drawn quietly, and the words between them are drawn as
  they will read (bold is bold while the stars are still there), the way Discord's box does it.
- **HTML**: typed as it is sent, with a look at it beneath that runs nothing and fetches nothing.

A part written another way is a `source` block in the draft: `{ type: 'source', attrs: { lang }, content: lines }`,
where a line is a paragraph. It is kept **as typed**, never tidied, and only ever at the top of a draft. `fit()`
reads every part into the tree first, so fitting, writing out, counting and reading back do not know that ways of
writing exist, and every check they make holds for a part as it does for a paragraph.

The rule everything here follows: **changing the way a part is written never changes what is sent.** `toSource`
writes blocks out, reads its own lines back, and leaves as it was whatever does not come back the same. So:

- A block the way of writing has no words for (a picture or a fold, in Markdown) stays between the parts as
  itself. A draft "written as Markdown" may hold a picture; it is still one draft.
- Inside a Markdown line, what no marker says (a colour, raised text, a mention, a time) stays in the line as the
  thing it is. The line is a hybrid: typed markers and real styles side by side.
- Reading is total. Any lines are some tree, and it is the tree that draft sends.

**The Markdown is ours**, the same wherever the draft goes: it is a way of typing, not what a network gets (Signal
still gets ranges, a mail still gets HTML). It follows from "a paragraph is one line":

- A line is one block. A marker ends with a space (`- `, `> `, `# `, `1. `), so a `-` or a `#tag` being typed is
  not a list or a heading for a moment. Containers are a chain of markers (`> - text`); more of an item is set in
  by the width of its marker. Code is fenced, a rule is `---`, a table is rows between bars with a line of dashes
  under the first.
- A style is a pair of the same marker: `**` bold, `*` or `_` italic, `__` underline, `~~` strike, `||` hidden.
  Each kind is paired by itself (the first with the second, the third with the fourth), so two styles may cross,
  as they may in the tree and as CommonMark's nesting cannot say. A star alone between spaces, an underscore
  inside a word and a bare web address are words. A backslash makes any marker a word.
- In a part the markers always mean what they mean, whatever the place carries: writing to SMS, `**x**` in a
  Markdown part is bold that is then stepped down and said, like bold from a button. (In rich text, typed markers
  become a style only where some place carries it.)

**HTML is read into the tree where the tree says the same thing.** A piece that says more (a style attribute, a
`<p>` with its own margins, a tag with no kind here, a comment) is kept whole as a `raw` block, with what could
be read of it as its fallback for a place that takes no HTML. So nothing typed is thrown away, a mail gets it
character for character, and Signal gets its words. The look beneath says how many pieces are kept that way.

**In the editor** (the prototype):

- `Rich | Markdown | HTML` at the start of the row of tools writes the **whole draft** that way. It is offered
  where it means something: Markdown where some chosen place carries a style at all, HTML where some chosen place
  takes HTML as typed (a mail, Matrix). The way a kind of writing was last written is how the next one starts (a
  chat as Markdown stays Markdown), kept on the device.
- A tag beside the text, where the box is opened up, says how **the part the caret is in** is written and writes
  that part another way: a mail may be rich text with one table typed as HTML and one paragraph as Markdown.
  Inside a Markdown part only the blocks the selection is in change; the lines around them stay as typed.
- The buttons work in every way of writing: in a part they put the markers or the tags around the words chosen,
  and take them away again. Enter in a list is the next item, and on an empty item ends the list.
- A newsletter kept as its own HTML is not touched by a change of the whole draft: its plain words were written
  by its sender, and reading them again from the HTML could change them. Its tag offers "HTML to edit" and
  "Text", both of which say what they do.
- One step, one undo. The markers shrink away or grow in over a fifth of a second, not at all for someone who
  asked for less motion.

Not done: an HTML part changes as a whole (it is not split by block); alignment is not read from typed HTML (the
piece is kept whole instead); text typed after a picture in a Markdown draft is rich until its tag is used; there
is no key for the switch; the caret goes to the end of what changed.

### A draft and its places

A send is: places, a draft, and what is beside it. A chat, a post and a mail differ only in which places they
offer and what those places have. That is the whole of "one sending interface".

- **A draft** (`draft.ts`) is `{ v, chat, doc, fields, places }`, and a place in it is `{ key, doc?, fields?,
  options?, off?, agreed?, sent? }`: words of its own where it is written separately, a field of its own
  (another title), the choices made for it, whether it is left out for now, which hidden words the writer agreed
  to show there (asked once, and the hub neither asks again nor guesses), and when it went there. `key` names an account and a chat there and the model never
  looks inside it, so two accounts on one network are two places. Every change is a function from a draft to a
  draft (`write`, `apart`, `together`, `choose`, `add`, `leave`, `agree`, `move`, `went`), and `outcome(draft)`
  is the one answer to "may it go, and what does each place get" that the box, the hub and the tests share.
  Whether there is anything to send is judged from what would arrive (a picture that cannot be loaded is nothing;
  a mail with a subject and no text is a mail), not from what the draft holds.
- **Nothing in it is tied to the chat it was started in.** A mention and a custom emoji carry their id for every
  space, a limit comes from the place's profile, and a profile is computed from the place each time.
- **The chat a draft is in is a pointer that can change.** Today a draft is stored under its chat's id
  (`dither-chat:draft:<chat>`); it needs an id of its own and a field saying which chat holds it, so it can move
  with its fields and files. Only the message it answers is bound to a chat: it survives a move if that message
  exists in the new chat, and is dropped and said otherwise.
- **The set of places can change under an open draft,** in number and in kind. Adding a Cc turns a mail thread
  into a group; the box does not care, because it draws from whatever places it is handed each time.
- **Which places are offered is the chat's business, not the box's.** In a person's chat: that person's own
  one-to-one routes, one at a time. For a post: the accounts, several at once. The box takes a list and whether
  one or many may be chosen.
- **Recipients are the place, not a field of the text.** To, Cc and Bcc decide where a mail goes and what kind
  of conversation it is, so they belong to the place and are edited there: shown with the mail place when the box
  is opened up, summed up in the route line otherwise. Subject and content warning are fields of the draft. The
  prototype still keeps `to` and `cc` in the draft's fields as a stand-in; typing a Cc there already moves the
  draft (`move`) to the group's chat, and "What is kept" shows that only the pointer changed.
- **Still to come in the draft,** and the third review's list of what one sending interface needs before mail and
  posts share it: the message it answers or edits (one per place, since a message exists in one place); files
  that are not pictures in the text, with their size and kind; what came back from a send (message ids, and
  which post of a thread failed), where `sent` is only a time today; a place that does not exist yet (a new
  mail, a new group), which today has no key; and fields beyond the five (Bcc, From, audience, language), which
  are a closed list in the code.

For the mail-in-chats design's three questions: (a) nothing in the draft or profile model is keyed by the
starting chat, except where a draft is stored, which has to change as above; (b) "a draft that goes to a chat and
a mail thread at once" means places inside one chat (one person's routes) and, for posts, several accounts; it
never spans two chats, and picking a group moves the draft to the group's chat; (c) To and Cc live with the
place, as in the last point.

## Steps to get there

Each is a pull request that stands on its own.

1. **The model, and what is exposed said in today's chat box.** `protocol/src/writing` with the shared reader for
   the chat string; the chat box, still a textarea, says the one thing that can hurt ("Hidden text can be read on
   WhatsApp") and asks at Send. No editor changes; the first use is a safety one.
2. **Plain mail as a profile.** "Plain" in the mail editor becomes a send choice written by the plain writer: the
   text goes as typed. Closes the gap left in the mail editor's reviews.
3. **Adapters use the writers.** Each of dither-accounts' converters is replaced by `fit` and `encode`, one
   network at a time, each checked against the converter's own tests and against the network itself.
4. **Drafts get an id.** A draft is stored by its own id with the chat as a field. Needed by mail in chats
   whatever the editor is.
5. **The box in chats.** Typing rules, styles under `Aa`, mentions and custom emoji as things in the text (the
   chip layer goes). The editor is loaded when the box is first used.
6. **Posts in the same box.** `PostRules` folds into profiles; the two post composers go.
7. **Mail in the same box.** Islands become raw blocks; the four views become source views.
8. **Reading in.** Posts and Matrix messages keep their formatting: Mastodon's HTML, Bluesky's facets and
   Substack's marks are read into the tree instead of being flattened.

## The prototype

`bun test packages/protocol/test/writing-lens.test.ts`: 19 tests for the ways of writing. Examples of the
dialect and of typed HTML (what is a marker and what is not, crossing styles, what is kept whole), then for 120
random drafts each, as Markdown and as HTML, with and without marker characters among the words: written out and
read back, **the draft hands every place the same thing it did before** (compared as what is sent, not by this
file's own idea of sameness), and most of each draft could be written (a writer that left everything alone would
pass otherwise). Sixty more drafts are changed from way to way six times, part of the draft and then all of it.
Random lines of marker and tag fragments are read without a throw, and ten inputs built to be slow stay fast.
The first run of these found that what was sent depended on the order an editor listed a run's styles in; styles
are now kept in one order when a draft is made sound.

`bun test packages/protocol/test/writing.test.ts`: 47 tests. Twelve are examples (offsets in UTF-16 units and in
bytes, crossing styles, the same line on every wire, each ladder, hidden text through every step, unknown kinds,
mentions per place, fields only where owned, markers read back, lines, an untrusted tree, the seven counters with
threads, splits and captions). Two hold every case the second and third reviews broke, one is the draft (it goes
whole, it moves, it goes once to each place), one throws everything JSON can carry at every place, one holds two
inputs that used to take seconds. The other thirty write 250 random drafts each, with and without marker
characters typed among the words, to one of the fifteen places and require:

- nothing throws;
- the fitted draft holds only what the place carries, and fitting it again changes and says nothing;
- every word arrives and nothing hidden is shown, **or the writer is told**, by the model's own check **and by
  the second reading**, which shares no code with it;
- without marker characters among the words, every network that can escape (Discord, GitHub, Reddit, Zulip)
  reads back exactly what was meant.

The same on 3,000 drafts for each place, outside the test run (`bun packages/protocol/test/writing-fuzz.ts
3000`, 90,000 sends):

| Drafts | Read another way, and said | Unsaid, by the model's check | Unsaid, by the second reading |
|---|---|---|---|
| no marker characters among the words | WhatsApp 1,263, IRC 1, every other place 0 | 0 | 0 |
| marker characters among the words | WhatsApp 1,313, GitHub 123, Zulip 123, Reddit 66, Discord 63, the rest 0 | 0 | 0 |

WhatsApp has no escape and styles whole words only, so two fifths of random styled drafts cannot be written
there as meant, and 120 of the 3,000 with typed markers are refused outright (a mention caught between two typed
backticks would arrive as a phone number). On the networks that can escape, what is left is a web address
touching a marker and three styles changing at once inside one word. In every case the writer is told, with the
first line it happens on.

The page (`cd packages/web && bun build proto/writing/main.tsx --outdir <dir>`, with `index.html` and `style.css`
beside it) is the box above in five settings: a chat with five routes, a post to four networks, a mail, a
forwarded newsletter, and all fifteen places at once.

### What three reviews found

Each round was handed to a reviewer told to break it, with real parsers as judges where there are any.

- **Round 1** broke "encode loses nothing" a dozen ways. Answer: the wire is read back and compared.
- **Round 2** broke the comparison (letters found anywhere), found injection through attributes, and page bugs.
  Answer: `sound`, comparison by run, a second reading in the tests, the `Draft` type.
- **Round 3** (`discord-markdown`, a CommonMark parser, a browser, `twitter-text`) found the reader sharing the
  writer's blind spots: hidden text on Discord let out by an address or an id holding `||`; a display name
  telling a stranger; raw HTML swallowing the text around it; words dropped from a mis-shaped tree; a draft that
  arrives as nothing called ready; values that threw; two inputs that took seconds; undo on the page reaching
  into another draft. All fixed and held by tests. It could not break structured wires (7,200 sends to Signal,
  Telegram and Bluesky), splitting (1,438 cases) or fitting twice.

Its verdict stands and is the main thing to take from this document: **the shape is right (one tree, a profile
per place, ladders that say what they did, one `outcome`), and the hand-written reader is the weak part.** Every
leak found in three rounds was a place where `read.ts` and the real network disagree. Before this is the basis
of the real editor, step 3 has to hold each marker wire to that network's own parser in the tests (Discord's
rules exist as a library; GitHub and Reddit are CommonMark), and use a structured wire instead of markers
wherever the network has one (Reddit and Slack do).

### What is not shown

- **The reader is a model, not each network's parser.** Known gaps: Zulip joining a paragraph to a list above it,
  WhatsApp's rule for which words a marker may touch, Discord's long code fences, a numbered line breaking into
  a paragraph, a bracket inside Reddit's `^( )`. Each writer and reader follows its network's documentation;
  step 3 checks them against the networks.
- **Only marker wires are read back.** Ranges, HTML and block wires are compared with what was fitted by
  construction, not by a reader.
- **The second reading is still ours.** It knows eight wires' rules for what is hidden and nothing about how a
  line is styled. It is a check on the model, not the networks.
- **Counting follows each network's published rule, not its code.** Known gaps: X counts a bare domain
  (`example.org` with no `https://`) as a link and checks that a domain's ending exists; the counter here only
  sees links that say `http`. IRC's limit is a line's, and is counted here for the whole message. Signal sends
  text past 2 KiB as a file, which is not modelled.
- **Only paragraphs are cut.** A list, a quote or a code block longer than a place's limit is refused, not
  split.
- **One space for each profile.** On Discord people are known network-wide and roles, channels and emoji by
  server; one `space` cannot say both.
- **A new kind of block costs about twelve edits** (the types, `sound`, two places in `fit`, three in `check`,
  four writers, the preview, the reader, the editor's schema). A table of kinds would cut that.
- **The page lacks** alignment, subscript, heading levels, colours, table rows and columns, custom emoji and a
  title of one place's own, all of which the model carries; and its mail toolbar is seventeen buttons in a row
  that slides on a phone, which is the next thing to design.
- **Hidden words in a line, where a place can only fold a block** (Zulip, GitHub): said to be shown. Folding the
  whole paragraph there instead would hide more than was asked, never less, and could be offered as a fix.
- **Where a thread breaks** is the model's choice (a paragraph end where one fits), not yet the writer's.
- **`read` is not yet a way in.** It recognises a mention by the string the writer made for it, so it reads our
  own wire, not a stranger's message. Reading in (step 8) needs each network's ids resolved.
- Not built: source views, replies and files stepping down, a field of one place's own on the page (the draft
  has it), storing a draft (so `move` runs only in the page and the tests), late loading of the editor, anything
  against a live network.

## Open questions

- **Markers while typing: answered.** Both, by choice: rich text hides them, Markdown keeps them, and the box
  remembers which per kind of writing (above, "Ways of writing").
- **A Markdown part's markers on a place that carries nothing.** They mean what they mean and are stepped down
  (the design). The other way is to read them as plain words there, as typed markers in rich text are.
- **Hidden text that would show.** The design marks it, says it and asks at Send. It could refuse instead.
- **A draft goes whole.** Send waits while one chosen place cannot take the draft (the design). The other way is
  to send to the rest and keep the draft for that place, said plainly; that is what "to the others only" already
  does when the writer picks it.
- **A title on a place without one.** Left out and said, with one click to put it first (the design), or put
  first without asking.
- **A mention of someone who is not in a place.** Goes as their name and is marked (the design), or is refused.
- **WhatsApp's unwritable lines.** Told to the writer (the design). An invisible character between the star and
  the word would write most of them, at the cost of putting an invisible character in text someone may copy.
