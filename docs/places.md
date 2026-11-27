# One page for every place

A **place** is anything that opens in the middle of the app: a direct chat, a person reached by several routes, a
group, a channel, a mail thread, a post's thread on X, Reddit or Mastodon. Each used to have a page of its own make-up:
a chat's header was not a mail thread's, a post's thread had its own reply box, and a person's networks hid behind a
small `+4 ▾`. Now every place is the same page, made of four parts in the same order, and a part is there whenever
the place has something for it.

| Part | What it is | Code |
| --- | --- | --- |
| **The head** | whose or what place it is, where it is, and the same buttons in the same order | `ui/PlaceHead.tsx` |
| **The switch row** | the ways this one place can be looked at, when it has more than one | `PlaceTabs` in `ui/bits.tsx` |
| **The body** | its messages: by time as a chat, or under what each answers as a thread | `Timeline`, `ui/feed/Comments.tsx` |
| **The box** | where you write, with one line over it saying where it goes and as whom | `Composer`, `ui/feed/Composer.tsx` |

What each kind of place puts in them:

| Place | Head | Switch row | Body | Box |
| --- | --- | --- | --- | --- |
| A direct chat, a group, a channel | picture, name, where it is | a channel with threads: Stream · Topics · Channel | chat | "To #general · via main" |
| A person | their picture and name, where your message goes | their networks: All · Signal · Discord · Email · Posts | chat, every route together or one network's | "To Sam on Signal ⌄" |
| A mail thread | envelope, subject, who is on it | Chat · Thread, when a mail has more than one answer | chat, or mails under the one each answers | "Everyone · 3 ⌄" |
| A post's thread | the author's picture, whose post, on which network | Chat · Thread | the post and its replies as a tree, or by time | "Reply to Alice on X · as @you ⌄" |

## The head

*(Written with the head: `ui/PlaceHead.tsx`.)*

## The switch row

One row of tabs under the head (`PlaceTabs`, `ui/bits.tsx`), drawn only when the place has two ways or more. It is the
same row wherever it shows: the same look, the same place on the page, the same keys. A click or Enter picks a tab;
with the row focused the arrow keys move through the tabs as through radio buttons, and Home and End go to the ends.
A row wider than the page scrolls sideways, as on a phone with someone on six networks. A tab may carry a small
picture before its name (a network's glyph) and how many are unread there.

What the row switches is never where you are, only how the place shows: the address stays, Back is not changed by it,
and the box keeps what you were writing. **Ctrl+Shift+]** and **Ctrl+Shift+[** move to the next and the previous tab
of the open page's row from anywhere on it, the message box included, which keeps its focus (`tabkeys.ts`;
docs/desktop.md says why those keys). On a phone a sideways drag on a row wider than the page scrolls it, at its ends
too, and is never the page's swipe back (`ui/Pager.ts`).

## A person's networks

Someone you reach on several networks (docs/chats.md) has the row under their head: **All**, then a tab for each
network you reach them on, its glyph and name ("Signal", "Discord", "Email") and how many are unread there. A person
on one network by several routes (three Discord accounts) gets All and Discord. The networks go by their names, mail
last, so a tab never moves as messages come in and your eyes and keys find it where they left it. The tabs are made by
one function, `personTabs` in `chattabs.ts`, which takes tabs to add after the networks: their **Posts**, last.

- **A network's tab** shows every route on that network together, interleaved as All shows everything, and your
  next message goes through that network: its route of the latest message, unless the route in use is already on
  it. A network of one route shows that conversation's own timeline; one of several, the person's timeline with only
  those routes' messages in it. Reading reads what is shown.
- **All** shows everything again and leaves where your message goes as it was.
- **Switching the route in the message box's line** to another network, with a network's tab chosen, moves the tab
  to that network. A message that comes in on another network does not: the tab stays, and so does the route.
- **The list of routes** (their account, yours, unread, when last active, "➤ sending") opens from the line under the
  name, which says where your message goes. Picking one route there shows that route alone: the row has its
  network's tab chosen, and the line says `only this ✕`. Until 2026-11-26 the networks were only in that list,
  behind a small pill after the line (`+4 ▾`, and only `+4 ▾` on a phone).
- What the page shows is kept per person for the session (`viewing` in `ui/Pairs.tsx`: `all`, `net:<network>` or a
  route's id), never in the address. Where a message goes is kept by the hub, an email route too
  (`PATCH /api/chats/person:<id>`), so after a reload the page shows All and still sends where you left it.
- **Posts** ends the row when they have an account on a network of posts (X, Mastodon, Reddit, Bluesky, …) that one
  of your accounts reads (`postNetsOf` in `ui/Pairs.tsx`, `postNetworks` in `chattabs.ts`): their identities and your
  accounts, both already on the page, so the tab costs nothing at start and asks nothing. When they post on one
  network the tab carries its glyph before "Posts". Someone you reach by one route who also posts gets the person's page
  (and the row) instead of that chat's own.
- **The Posts tab** shows what they posted in public as the hub logged it, newest first as on the Feed page, each
  drawn with the feed's own row (`ui/feed/PersonPosts.tsx`, in the feed's chunk): `GET /api/persons/:id/posts`
  (`personposts.ts`). Nothing is asked of a network: it lists posts read in a thread or on a profile (variant
  `posts`), replies under a post you follow (`follow`), and their reply, mention or quote in your notifications
  (`feed`, which carries their post whole); a like, a repost or a follow there is not a post of theirs. A post both
  in your notifications and logged shows once, as logged. One written to you says so over it ("Replied to your
  post"). Older pages come as you scroll. A post opens its thread on top of the page; Back or Escape come back to
  the Posts tab, still chosen and scrolled where it was (the list and its place are kept per person for the
  session). With nothing logged, one line says so and opens their profile, whose Recent posts asks the network. The
  head stays; the message box does not (a post is answered in its thread). The route line says no `only this`.
- **What they wrote to you in public**, in All: their reply to a post of yours, their post that mentions or quotes
  you, each one short row at its time among the chat's messages, as their mail in threads with others is ("Theo
  replied to your post on X · 6:05 PM", its first words, **Answer there** opening the post's thread). The hub adds
  them to the page's `elsewhere` (`withPublic`, `ElsewhereView.placeKind: 'post'`); `PublicRow.tsx` draws them.
- When the Same person? suggester is sure (`MATCH_STRONG` or over) that someone else is them, one slim line under
  the row says so: "Also Mom on Signal · Same person? Join · Not them" (`SameLine`). Join merges the two, Not them
  says they are not; nothing is ever joined without you.

## A thread as a chat or a tree

*(Written with the thread views: `ui/feed/Thread.tsx`, `ui/feed/Comments.tsx`.)*

## The box

*(Written with the box: `ui/feed/Composer.tsx`.)*
