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
and the box keeps what you were writing.

## A person's networks

*(Written with the tabs: `ui/Pairs.tsx`, `chatroutes.ts`.)*

## A thread as a chat or a tree

*(Written with the thread views: `ui/feed/Thread.tsx`, `ui/feed/Comments.tsx`.)*

## The box

*(Written with the box: `ui/feed/Composer.tsx`.)*
