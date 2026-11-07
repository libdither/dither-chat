# People graph

Who shares what: everyone your accounts know and the servers and group chats they are in, drawn as one graph, so you
can see who is in a server with whom — including someone you talk to on one account who shares a server with someone
you talk to on another.

**Getting there.** The graph button in the People header (between New message and Order), or `#/people/graph`. On a
phone it is a page of its own over the People list.

Code: `packages/hub/src/graph.ts` (`GET /api/graph`), `packages/web/src/graph/` (the view: `GraphView.tsx`, the
filters in `model.ts`, the force layout in `layout.ts` run by `layout.worker.ts`, WebGL drawing in `render.ts`,
`engine.ts` tying them to the canvas), `packages/web/src/ui/GraphPane.tsx` (loads it). Checked end to end by
`scripts/verify-graph.ts`.

## What it shows

- **People**: a person stands for all their identities (merge and split them on their profile); an identity in no
  person stands alone. You are left out. A person on several networks is drawn in the accent colour, a bot grey,
  everyone else in their network's colour.
- **Places**: servers and spaces (squares; a channel or category counts toward its server) and group chats
  (diamonds), in their network's colour, bigger the more people the hub knows there.
- **Links** between a person and a place, each pair once, from what the hub already has:
  - the participants of group chats, and of channels inside a server that list them;
  - the servers a profile you opened said you share (`mutualSpaces`, docs/profile.md);
  - server members your accounts' clients saw — only while the adversarial "Record server members" is on
    (docs/history.md). Turned off, those links go, and people only they named go with them.

No message text, avatars or profile fields are sent: ids, names, networks, which of your accounts see each place and
which have a direct chat with each person, and the network's member count of a server when members are recorded.
Nothing is guessed: two identities are one person only if you (or a direct chat) made them one.

## Using it

- **Move**: drag to pan, scroll or pinch to zoom, the buttons at the bottom right (zoom in, out, fit everything), or
  `+`, `-` and `0` with the graph focused.
- **Hover** a node for what it is; **click** it for a card: who or what, its networks, the accounts with a direct chat
  with them (or that see the place), Profile / About and Chats / Open, the places a person is in, and who they share
  places with — tagged "other account" when you have direct chats with each of them on different accounts. A place's
  card lists the places that share the most people with it, and "Only this". **Double-click** opens the page.
- **Find** a person, server or group by name; if the filters hide it, they widen to show it.
- **Filters**: networks (none picked is all), one account (the places it sees and who is in them), one server or
  group (its people and the other places they are in), group chats on or off, only people in two places or more, and
  bots (off by default). Filters other than the account and place are remembered on this device.
- **Cap**: at most 2,000, 6,000 (the default) or 20,000 nodes. Over it, the busiest places are kept (up to a quarter
  of the cap) and then the people most connected to them; the line at the bottom says "Showing N of M people · … ,
  the busiest".

With nothing linked yet, it says how the graph fills in, with a way to Adversarial features. Without recorded
members, a note at the top says servers show only who profiles and channels named.

## How it stays quick

The hub builds the graph in one pass over its tables (about 35 ms for ~2k people and 150 places) and sends links as
flat index triples. The page loads the view as its own chunk only when opened. The layout (Barnes–Hut repulsion,
springs, a pull to the middle) runs in a worker, about 14 ms a step at 11k nodes, and posts positions each frame;
links and nodes are drawn with WebGL (a 2D canvas where WebGL is missing, which the status line says). Picking scans
the shown nodes once a frame at most; labels are capped and skip any that would overlap.
