# Events: Luma and Partiful

Two event sites as networks: **Luma** (`luma`) and **Partiful** (`partiful`). Each is a chat network with a feed, as X
is: its events come in as posts (`PostFact.event`, an `EventFact`), its chats as ordinary DMs and groups, its
notifications as the account's `feed` conversation. The accounts run in dither-accounts like the others; the hub reads
them through the same commands (`home`, `profile`, `history`, `send`, `action`).

Code: `packages/protocol/src/feed.ts` (`EventFact`, the who-is-going rule), `packages/hub/src/events.ts` (an event's
page, RSVP), `packages/hub/src/eventseen.ts` (who was seen where, the people you know at an event),
`packages/hub/src/demo-events.ts` (the demo world's two accounts), `packages/web/src/ui/events/` (the card and the
page, a chunk of their own).

## The shapes

An event is a post whose `event` says when (`start`, `end`, `timeZone`), where (`place`: name, address, city, a map
point; or `online`; or neither, when the site shows the address only after an RSVP), the price (`price`), who hosts
(`hosts`, identity native ids), who is going (`going`, a count; `guests`, the people the site shows; `guestsShown`),
your RSVP (`rsvp`, `hosting`), the event's conversation (`conversation`) and its calendar file (`ics`).

`guestsShown` is how much of the list the host lets guests see:

| `guestsShown` | What the site shows | What the hub keeps |
| --- | --- | --- |
| `all` | every guest | every guest |
| `sample` | some ("Sam, Jules and 40 others") | those it showed |
| `count` | only how many | the count; no guest |
| `hidden` | nothing | nothing but the hosts |

**A list the host hides is never kept.** `withoutHiddenGuests` (protocol) drops `event.guests` from any post whose list
is `count` or `hidden`, inside reposts and quotes too, and the hub runs it wherever an event can come in: a feed
item (`Timelines.keep`), a logged post (`Posts.record`), and any message's `extra.post` or `extra.feed.post`
(`scrubEventGuests`, in `Store` before a message is written). An extractor that sends guests anyway is overruled; an
event whose list was shown and is later hidden loses the guests the hub had recorded (`event_seen`, below). Hosts are
public on both sites and stay.

## The feeds

An event site's account has two timelines (`homeFeedsOf`): **Explore** (`explore`, its city's listing: Luma's
Discover for the account's city, Partiful's Discover) and **Your events** (`following`: events you are going to or
hosting, upcoming soonest first, then the past). They have no For you. Both keep the site's order, not time order, and
Explore is read a page at a time by the site's cursor, as X's For you is.

Following and Discover leave event sites out: a list of parties is not a timeline of posts. The **Events** feed
(`#/feed/events`, built in, there once an account of an event site is) takes every event site's Explore and Your
events, taking turns. A feed of your own can take them as any timeline.

The composer is hidden on a feed made only of event sites: nothing is posted on them from here.

### The event card

`EventCard` (ui/events/Event.tsx): a date block (month and day, in the event's zone), the cover, the title, when in the
event's zone and in yours when your clock differs ("Sat 2:00 AM your time"), where (or "Address shown after you
RSVP"), the price, your RSVP, the network, the hosts, and the guests' faces with "N going". The people you know come
first among the faces, ringed, and are named under them ("You know Sam and Jules").

Someone you know is someone you have a direct chat or group with, through any of their person's accounts
(`knownOf`); an event's own conversation makes no one known. The hub orders the guests (known first, then the site's
order), trims them to `EVENT_CARD_GUESTS` (12) and says how many more (`PostView.eventView`: `known`, `guestsMore`,
`conversationId`, `accountId`).

### The event's page

A card opens the event's page where a post would open its thread (`#/feed/<source>/p/<post key>`): the cover, when and
where, the address and a map link, Open on the site, the calendar file, the event's conversation, the RSVP buttons,
the description, the hosts and **Who is going** (every guest the site showed, the people you know first, a note when
the list is a sample or hidden).

`GET /api/events/:network/:event?account=` gives it (`EventPageView`), from what the hub logged: an event the hub has
not seen in a feed is a 404.

**RSVP** (`POST /api/events/:network/:event/rsvp { account, status, note? }`) is a write the host and the guests see,
so the page asks first ("Tell Luma “Going”? The host and the other guests will see it."). It sends the account's
`action` `rsvp` with `EventRsvpArgs` (`going`, `maybe`, `interested`, `declined`; Luma offers Going, Interested and
Can't go, Partiful Going, Maybe and Can't go) and logs the event as the site answers it, or, when the site answers
nothing, with your RSVP set. In dither-accounts the `rsvp` action needs `manage`.

## People

Hosts and guests are identities of the event site, with their profile (`PersonAbout`) when the extractor gives one;
the socials on a Luma or Partiful profile (X, Instagram, LinkedIn, TikTok, a website) are claims for Same person?
(docs/same-person.md). Guests get no person of their own, no DM and no group: they stay out of People until they are
someone you talk to, or a Same person? merge says who they are.

**Who was seen where**: `event_seen` (identity, network, event, role `host` or `guest`, their RSVP when it is yours,
first and last seen) is written each time an event is logged or kept (`recordEvents`). A host stays a host; a guest
list that stops being shown removes its guests (you stay).

A person's profile has **Events** (`ProfileView.events`, `eventsOf`): the events any of their accounts hosted or went
to, hosting first, then upcoming soonest, then the past, each with its time, place and role; one opens its page.

The picture-hashing queue for Same person? takes event guests after its own priorities (the sides of pairs, then
direct chats and groups), the latest seen first, at most 300 (`EVENT_PICTURES`, packages/hub/src/matches.ts), so a
guest with the picture of someone you know is found. Two people known only from events are never paired with each
other: the list would fill with strangers.

## Conversations

- **Notifications**: the account's `feed` conversation, read-only, as X's.
- **An event's conversation**: `event:<event id>` (`eventConvNativeId`), its messages joined to the event through
  `extra.event`. A host's announcement to every guest (a Luma blast, a Partiful text blast) has `extra.blast` and
  shows as an announcement (`MessageView.blast`).
- **Luma** has no comments: writing in a Luma event's conversation is refused (`sendBlocker`: "Luma events take no
  comments: only the hosts write here, on Luma"). Partiful's event conversation takes comments.
- **Chats**: Luma's and Partiful's own messages are ordinary DMs and groups.

Neither site takes attachments here (`ATTACHMENT_LIMITS` 0). Luma's reactions are one each, Partiful's several, from
a fixed set.

## The demo world

`bun run hub -- --demo --data <temp dir> --port <free port>` adds two accounts in an invented city, Brightwater:

- **Luma · events**: six events in Explore (one with every guest shown, one with a sample, one count-only, one online
  and paid, one craft night, one past that you hosted), Your events, a group chat "Climbing crew" with Sam and Jules
  (so they are people you know), and an event conversation with two blasts.
- **Partiful · parties**: four events (every guest, a sample, a hidden list, a past one), a DM with Priya, and an
  event conversation with comments and a text blast.

Some guests are the demo's own people (Maya with the same picture as her X account, Nora linking her X account), so
Same person? has leads. RSVP, comments and sending are answered by the demo itself; nothing leaves the machine.

## Checks

- `packages/protocol/test/events.test.ts`: both networks in every list, their feeds and names, the who-is-going rule
  (also inside reposts and quotes), Luma's refused comments.
- `packages/hub/test/events.test.ts`: the Events feed, Explore by pages in the site's order, Your events, the card's
  people-you-know-first and trim, the event's page, an RSVP sent and logged, `event_seen` (hosts, guests, a
  count-only list), a profile's Events order, guests with no person, a hidden list never kept (feed item, logged
  post, a message's extra, `recordEvents` alone, a list hidden later), and the table made on an older database.
- `packages/web/test/events.test.ts`: the date block, the time there and here, where, who is going, the RSVP words
  and buttons.
- The network tables (`network-tables.test.ts`, hub and web) say what each table does for the two networks.
