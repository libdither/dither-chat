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

Every place has the same head (`PlaceHead` in `ui/PlaceHead.tsx`), drawn in one order whatever the place is:

1. **Back**, where the page has one (a phone, a thread opened from another thread).
2. **The tile**: the place's picture with its network's badge and, for a person, whether they are around; or a kind's
   glyph where a place has no picture (the envelope of a mail thread, a channel's #). For a chat or a post it opens
   the profile behind it.
3. **The name**, and what follows it: a lock for an end-to-end encrypted chat, the pencil of a nickname.
4. **The line under it**, whatever the place has to say there: where your message goes (a DM, a person), where a
   channel is (its server and section), who is on a mail thread, "On X" for a post.
5. **The buttons**, always in this order, a button the place has no use for simply not there: the orb when the hub is
   out of reach; the place's own (join a call, About, a mail thread's Archive, a post's Follow replies); **Search** in
   this place; **the bell**, the place's notification rule; **Details**, the panel beside the page; and **⋯**.

| Place | Its own buttons | Search | Bell | Details | ⋯ |
| --- | --- | --- | --- | --- | --- |
| A chat, a group, a channel, a stream | call, About (not a DM) | `in:<conversation>` | its rule | the conversation's panel | on a phone only |
| A person | call | `in:<person>`: every chat with them | a rule on each of their chats | the person's panel | on a phone only |
| A mail thread | Archive | none yet (below) | the thread's own rule | the thread's panel (`ui/MailDetails.tsx`) | the thread's filing: Mark read, Star, Move to, Junk, Trash |
| A post's thread | Follow replies | none | the follow chat's rule, once followed | the post's panel (`ui/feed/PostDetails.tsx`) | Open on X, Copy link to the post, Stop following or Follow again |

**On a phone** the place's own buttons and Search stay in the head; the bell, Details and a place's About or Profile
move under ⋯, which opens as a sheet: the place's own entries first, then About or Profile and Details, then the
notification rules. On a computer ⋯ shows only for a place with entries of its own (a mail thread, a post).

**Right-click** on the head, or a long press on a phone, opens the place's menu: a chat's or a person's (`menus.tsx`),
a mail thread's filing, a post's ⋯.

**The details panel** sits where a chat's does, beside the page, and the same Details button opens and closes it:

- a mail thread's: who is on it, each From, To and Cc with their address under the name and a link to their page where
  they are a person, you last; its files and links as the chat holds them; when it started and its newest mail; which
  of your mail accounts it is in; and Archive, Star and Trash.
- a post's: its author, to their profile; when it was posted and its counts; who liked it and who reposted it
  (`ReactorsList`, opened from the panel); Open on the network; and for a post you follow what the follow says: since
  when, when it was last checked and when it is checked next, or that it stopped and why.

The Feed page has no details panel: its list and a thread beside it fill the width, so a post's head there has no
Details.

**A post's thread opens anywhere a chat does.** Its id (`pst_<network>_<post>`) under a space, a folder or search
(`#/s/<space>/c/pst_…`) opens the thread as under the inbox (`placePane` in `ui/App.tsx`).

**Where it lives.** `PlaceHead` is in the app's start, so the Timeline chunk (chats, mail threads) and the feed chunk
(a post's thread, given it through `kit` in `ui/feed/lazy.tsx`) draw it without either loading the other. It moved
the notification rules' menu out of the Timeline chunk with it: about 4.3 KB more at the start (1.4 KB gzipped), 3.6 KB
less in the Timeline chunk.

**Not yet: Search in a mail thread.** Mail search has no way to stay in one thread: `in:` names a mailbox there, and the
search page leaves mail out when the query has `in:` (`mailSearchable`). It would need an operator for a thread in the
hub's mail search (`hub/src/mail/search.ts` filters by thread already, for `among`), `mailSearchable` letting it
through, and the search box's chip naming the thread.

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
