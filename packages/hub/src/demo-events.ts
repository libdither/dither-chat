/**
 * The demo world's Luma and Partiful accounts (docs/events.md "The demo world"), as dither-accounts' `luma` and
 * `partiful` kinds send them: Explore (the city's listing, in two pages) and Your events, events with hosts and who is
 * going as the site shows it (a whole list, a sample, a count only, a hidden list), a read-only `feed` of notifications,
 * an event's conversation (Partiful: comments and a text blast; Luma: a host's blasts only), and the sites' own chats.
 * Everyone and everything here is made up; no place is a real city.
 *
 * What it exercises: people you know at an event (a Partiful guest you have a DM with, Luma guests in a group chat of
 * yours, shown first and ringed); Same person? leads from a guest (one with the picture of a demo X account, one whose
 * Luma profile links that X account); an RSVP sent (action `rsvp`, logged by writeLog, the event answered as it now
 * stands); Luma refusing a comment in an event's conversation (sendBlocker); hidden lists that send no guests.
 */
import type * as P from '@dither-chat/protocol';
import { eventConvNativeId } from '@dither-chat/protocol';
import type { AccountRow } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

type EventNet = 'luma' | 'partiful';

export const DEMO_EVENT_ACCOUNTS: { id: string; network: EventNet; label: string; color: string }[] = [
  { id: 'acc_demo-luma', network: 'luma', label: 'events', color: '#E0399F' },
  { id: 'acc_demo-partiful', network: 'partiful', label: 'parties', color: '#7C3AED' },
];

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

const pic = (bg: string, fg: string, letter: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="42" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="${fg}">${letter}</text></svg>`)}`;
const cover = (bg: string, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" width="640" height="640"><rect width="640" height="640" fill="${bg}"/>${body}</svg>`)}`;

const COVERS = {
  sheaves: cover('#1f2a4a', `<g stroke="#5cc8ff" stroke-width="6" fill="none"><circle cx="320" cy="320" r="180"/><path d="M140 320 Q320 120 500 320 Q320 520 140 320"/></g><g fill="#f7d154"><circle cx="320" cy="140" r="18"/><circle cx="320" cy="500" r="18"/><circle cx="140" cy="320" r="18"/><circle cx="500" cy="320" r="18"/></g>`),
  market: cover('#2b1d3a', `<g fill="#ffd36e">${[90, 210, 330, 450, 570].map((x, i) => `<circle cx="${x}" cy="${120 + (i % 2) * 40}" r="22"/>`).join('')}</g><path d="M40 120 Q320 220 600 120" stroke="#ffd36e" stroke-width="4" fill="none"/><g fill="#e8590c"><rect x="80" y="360" width="160" height="180" rx="10"/><rect x="400" y="360" width="160" height="180" rx="10"/></g><rect x="0" y="540" width="640" height="100" fill="#3b82c4"/>`),
  robots: cover('#e9f5ff', `<rect x="220" y="180" width="200" height="220" rx="30" fill="#5c7cfa"/><circle cx="280" cy="270" r="22" fill="#fff"/><circle cx="360" cy="270" r="22" fill="#fff"/><rect x="300" y="120" width="40" height="60" fill="#5c7cfa"/><circle cx="320" cy="110" r="18" fill="#e8590c"/><rect x="250" y="400" width="40" height="110" fill="#364fc7"/><rect x="350" y="400" width="40" height="110" fill="#364fc7"/>`),
  zines: cover('#fff4e6', `<g transform="rotate(-8 320 320)"><rect x="150" y="160" width="220" height="300" fill="#f783ac"/><rect x="270" y="190" width="220" height="300" fill="#74c0fc"/></g><text x="320" y="580" font-family="sans-serif" font-size="56" font-weight="700" text-anchor="middle" fill="#495057">ZINES</text>`),
  reading: cover('#e6fcf5', `<rect x="160" y="200" width="320" height="240" rx="12" fill="#0ca678"/><rect x="180" y="220" width="130" height="200" fill="#fff"/><rect x="330" y="220" width="130" height="200" fill="#fff"/>`),
  dumplings: cover('#fff9db', `<g fill="#f8f0e3" stroke="#c9a227" stroke-width="6">${[[200, 300], [330, 260], [440, 340], [270, 420]].map(([x, y]) => `<path d="M${x - 80} ${y} Q${x} ${y - 110} ${x + 80} ${y} Z"/>`).join('')}</g>`),
  karaoke: cover('#212529', `<rect x="290" y="160" width="60" height="200" rx="30" fill="#ced4da"/><rect x="310" y="360" width="20" height="160" fill="#868e96"/><g fill="#f06595"><circle cx="150" cy="150" r="14"/><circle cx="500" cy="220" r="10"/><circle cx="460" cy="480" r="16"/></g>`),
  supper: cover('#3b2f2f', `<circle cx="320" cy="320" r="170" fill="#f1f3f5"/><circle cx="320" cy="320" r="120" fill="#e9ecef"/><rect x="110" y="180" width="16" height="280" fill="#adb5bd"/><rect x="514" y="180" width="16" height="280" fill="#adb5bd"/>`),
  housewarming: cover('#d3f9d8', `<path d="M160 340 L320 180 L480 340 Z" fill="#e8590c"/><rect x="200" y="340" width="240" height="180" fill="#fff"/><rect x="295" y="420" width="50" height="100" fill="#5c940d"/>`),
};

interface Person {
  id: string;
  name: string;
  handle?: string;
  bg: string;
  fg?: string;
  bio?: string;
  links?: P.PersonAbout['links'];
}

const ident = (p: Person): P.IdentityFact => ({ nativeId: p.id, displayName: p.name, ...(p.handle ? { handle: p.handle } : {}), avatarUrl: pic(p.bg, p.fg ?? '#fff', p.name[0]!) });

interface DemoEvent {
  post: P.PostFact;
  /** In which of the account's timelines, with the site's section. */
  explore?: P.HomeReason;
  mine?: boolean;
}

interface World {
  network: EventNet;
  me: Person;
  people: Person[];
  events: DemoEvent[];
  /** The account's own chats: conversations and their messages. */
  chats: { conv: P.ConversationFact; messages: { id: string; who: string; min: number; body: string; extra?: Record<string, unknown> }[] }[];
  /** Notifications, oldest first. */
  feed: { min: number; who: string; id: string; body: string }[];
  capabilities: P.Capability[];
}

/** Twenty-odd invented people who go to things. */
const crowd = (prefix: string, names: string[], colors: string[]): Person[] => names.map((name, i) => ({ id: `${prefix}${(i + 11).toString(36)}${name.toLowerCase().replace(/[^a-z]/g, '')}`, name, bg: colors[i % colors.length]! }));
const COLORS = ['#e8590c', '#5c7cfa', '#0ca678', '#f08c00', '#ae3ec9', '#1971c2', '#c2255c', '#2f9e44'];
const NAMES = ['Avery Lund', 'Blake Moreno', 'Cass Whitfield', 'Dev Anand', 'Elif Kaya', 'Finn Byrne', 'Gia Romano', 'Hugo Lambert', 'Iris Novak', 'Jonah Reyes', 'Kira Sato', 'Luca Bianchi', 'Mina Farah', 'Noel Grant', 'Opal Chen', 'Pax Moreau'];

// ------------------------------------------------------------------ Luma

function luma(epoch: number): World {
  const me: Person = { id: 'usr-demo-self', name: 'Zyan', handle: 'zyan', bg: '#F7D154', fg: '#2b2b33' };
  const rowan: Person = { id: 'usr-demo-rowan', name: 'Rowan Pike', handle: 'rowanpike', bg: '#1971c2', bio: 'Hosts a reading night for people who like their maths with snacks.', links: [{ label: 'Website', value: 'rowanpike.example', url: 'https://rowanpike.example' }] };
  const nadia: Person = { id: 'usr-demo-nadia', name: 'Nadia Ortiz', handle: 'nadiaortiz', bg: '#c2255c', bio: 'Night markets, street food, lanterns.', links: [{ label: 'Instagram', value: 'nadia.makes.markets', url: 'https://instagram.com/nadia.makes.markets' }] };
  const club: Person = { id: 'usr-demo-robotclub', name: 'Tinker Robotics Club', handle: 'tinkerbots', bg: '#5c7cfa' };
  // People you know: in your Luma group chat (Climbing crew).
  const sam: Person = { id: 'usr-demo-sam', name: 'Sam Rivera', handle: 'samr', bg: '#5277c3', bio: 'Climbs, cooks, reads.' };
  const jules: Person = { id: 'usr-demo-jules', name: 'Jules', handle: 'jules', bg: '#2f9e44' };
  // Same person? leads: Maya with the very picture of the demo X account maya_k; Nora linking the X account nora_on_nets.
  const maya: Person = { id: 'usr-demo-maya', name: 'Maya K.', handle: 'mayak', bg: '#f2a541', fg: '#2b2b33', bio: 'Graphs and gardens.' };
  const nora: Person = { id: 'usr-demo-nora', name: 'Nora', handle: 'nora', bg: '#495057', bio: 'Networks, mostly the social kind.', links: [{ label: 'X', value: 'nora_on_nets', url: 'https://x.com/nora_on_nets' }, { label: 'LinkedIn', value: 'nora-on-nets', url: 'https://linkedin.com/in/nora-on-nets' }] };
  const many = crowd('usr-demo-g', NAMES, COLORS);
  const at = (days: number, hour: number) => epoch - (epoch % DAY) + days * DAY + hour * H;
  const ev = (id: string, title: string, text: string, img: string, e: P.EventFact, ts = epoch - 3 * DAY): P.PostFact => ({ id, url: `https://luma.com/${id.replace(/^evt-/, '')}`, ts, author: e.hosts[0], text, title, media: [{ kind: 'image', url: img, width: 640, height: 640, alt: '' }], event: e });
  const events: DemoEvent[] = [
    {
      mine: true,
      explore: { text: 'Popular in Brightwater', kind: 'topic' },
      post: ev('evt-demo-sheaves', 'Sheaves & Snacks: a reading night', 'We read the first chapter of a friendly book on sheaves, then argue about it over dumplings.\n\nNo background needed. Bring a question.', COVERS.sheaves, {
        start: at(2, 19),
        end: at(2, 22),
        timeZone: 'Europe/Lisbon',
        place: { name: 'Lantern Hall', address: '12 Quay Lane, Brightwater', city: 'Brightwater' },
        hosts: [rowan.id],
        going: 20,
        guests: [many[0]!.id, sam.id, many[1]!.id, maya.id, many[2]!.id, jules.id, many[3]!.id, many[4]!.id, many[5]!.id, nora.id, many[6]!.id, many[7]!.id, many[8]!.id, many[9]!.id, many[10]!.id, many[11]!.id, many[12]!.id, many[13]!.id, me.id],
        guestsShown: 'all',
        price: 'Free',
        rsvp: 'going',
        conversation: eventConvNativeId('evt-demo-sheaves'),
        ics: 'https://luma.example/ics/evt-demo-sheaves.ics',
        tags: ['Science', 'Books'],
      }),
    },
    {
      explore: { text: 'Trending', kind: 'topic' },
      post: ev('evt-demo-market', 'Night Market by the Water', 'Forty stalls, a lantern walk at nine, and a band that only plays sea shanties.', COVERS.market, {
        start: at(4, 18),
        end: at(4, 23),
        timeZone: 'America/New_York',
        place: { name: 'Harbour Steps', city: 'Brightwater' },
        hosts: [nadia.id],
        going: 240,
        guests: [maya.id, nora.id, many[14]!.id, sam.id, many[15]!.id, many[2]!.id, many[5]!.id, many[9]!.id],
        guestsShown: 'sample',
        price: 'Free',
        rsvp: null,
        tags: ['Food & Drink'],
      }),
    },
    {
      explore: { text: 'Tech', kind: 'topic' },
      post: ev('evt-demo-robots', 'Robot Petting Zoo', 'Small friendly robots, and the people who built them. Ages 6 and up.', COVERS.robots, {
        start: at(6, 11),
        end: at(6, 15),
        timeZone: 'Asia/Tokyo',
        hosts: [club.id],
        going: 85,
        // The host shows only the count: no guests are sent.
        guestsShown: 'count',
        price: '$12',
        rsvp: null,
        tags: ['Tech'],
      }),
    },
    {
      explore: { text: 'Curated by Brightwater Reads', kind: 'topic' },
      post: ev('evt-demo-online', 'Slow Reading Club (online)', 'One poem a week, read slowly, together.', COVERS.reading, {
        start: at(3, 20),
        end: at(3, 21),
        timeZone: 'Europe/Lisbon',
        online: true,
        hosts: [rowan.id],
        going: 12,
        guests: [many[4]!.id, many[8]!.id, jules.id],
        guestsShown: 'all',
        price: '$10',
        rsvp: null,
      }),
    },
    {
      explore: { text: 'Arts', kind: 'topic' },
      post: ev('evt-demo-craft', 'Linocut Afternoon', 'Carve a stamp, print a card, take both home.', COVERS.zines, {
        start: at(9, 14),
        timeZone: 'Europe/Lisbon',
        hosts: [nadia.id],
        going: 9,
        guests: [many[10]!.id, many[11]!.id],
        guestsShown: 'all',
        price: '$25',
        rsvp: null,
      }),
    },
    {
      mine: true,
      post: ev('evt-demo-zines', 'Zine Swap', 'Bring ten copies, leave with ten different ones.', COVERS.zines, {
        start: at(-12, 15),
        end: at(-12, 18),
        timeZone: 'Europe/Lisbon',
        place: { name: 'The Long Table', city: 'Brightwater' },
        hosts: [me.id, jules.id],
        going: 14,
        guests: [sam.id, many[0]!.id, many[3]!.id],
        guestsShown: 'all',
        price: 'Free',
        rsvp: 'going',
        hosting: true,
      }, epoch - 30 * DAY),
    },
  ];
  const climbing = 'chat-demo-climbing';
  const sheavesConv = eventConvNativeId('evt-demo-sheaves');
  return {
    network: 'luma',
    me,
    people: [rowan, nadia, club, sam, jules, maya, nora, ...many],
    events,
    chats: [
      {
        conv: { nativeId: sheavesConv, shape: 'group', variant: 'text', name: 'Sheaves & Snacks: a reading night', avatarUrl: COVERS.sheaves, participants: [me.id, rowan.id], lastMessageAt: epoch - 3 * H },
        messages: [
          { id: 'blast-demo-1', who: rowan.id, min: 26 * 60, body: 'Thanks for signing up! We start at 7 sharp; the door is round the back, by the bikes.', extra: { blast: true, event: 'evt-demo-sheaves' } },
          { id: 'blast-demo-2', who: rowan.id, min: 3 * 60, body: 'Reminder: chapter one only. Dumplings are on me this time.', extra: { blast: true, event: 'evt-demo-sheaves' } },
        ],
      },
      {
        conv: { nativeId: climbing, shape: 'group', variant: 'text', name: 'Climbing crew', participants: [me.id, sam.id, jules.id], lastMessageAt: epoch - 50 * MIN },
        messages: [
          { id: 'm-demo-c1', who: sam.id, min: 120, body: 'Going to the sheaves thing on Thursday?' },
          { id: 'm-demo-c2', who: jules.id, min: 90, body: 'Yes! Saw you on the list.' },
          { id: 'm-demo-c3', who: me.id, min: 50, body: 'Me too. Climb first, maths after?' },
        ],
      },
    ],
    feed: [
      { min: 5 * DAY / MIN, who: rowan.id, id: 'n-demo-1', body: 'Rowan Pike invited you to Sheaves & Snacks: a reading night' },
      { min: 2 * DAY / MIN, who: nadia.id, id: 'n-demo-2', body: 'Night Market by the Water is trending near you' },
      { min: 26 * 60, who: rowan.id, id: 'n-demo-3', body: 'New blast in Sheaves & Snacks' },
    ],
    capabilities: ['send', 'history', 'markRead', 'react', 'profile', 'home'],
  };
}

// ------------------------------------------------------------------ Partiful

function partiful(epoch: number): World {
  const me: Person = { id: 'pf-demo-self', name: 'Zyan', bg: '#F7D154', fg: '#2b2b33' };
  // People you know: Priya, who you have a Partiful chat with.
  const priya: Person = { id: 'pf-demo-priya', name: 'Priya N.', bg: '#ae3ec9', bio: 'Will fold dumplings for friends.', links: [{ label: 'Instagram', value: 'priya.folds', url: 'https://instagram.com/priya.folds' }] };
  const marco: Person = { id: 'pf-demo-marco', name: 'Marco', bg: '#e8590c', bio: 'Karaoke enthusiast, regrettably.' };
  const hoa: Person = { id: 'pf-demo-hoa', name: 'Hoa', bg: '#0ca678' };
  const sup: Person = { id: 'pf-demo-supper', name: 'Supper Society', bg: '#3b2f2f' };
  const maya: Person = { id: 'pf-demo-maya', name: 'Maya K.', bg: '#f2a541', fg: '#2b2b33' };
  const many = crowd('pf-demo-g', NAMES.slice(4), COLORS.slice(2));
  const at = (days: number, hour: number) => epoch - (epoch % DAY) + days * DAY + hour * H;
  const ev = (id: string, title: string, text: string, img: string, e: P.EventFact, ts = epoch - 4 * DAY): P.PostFact => ({ id, url: `https://partiful.com/e/${id}`, ts, author: e.hosts[0], text, title, media: [{ kind: 'image', url: img, width: 640, height: 640, alt: '' }], event: e });
  const events: DemoEvent[] = [
    {
      mine: true,
      post: ev('pfdemodumplings', 'Dumpling Folding Party', 'I make the filling, you fold, we all eat. Vegetarian filling too.', COVERS.dumplings, {
        start: at(5, 18),
        end: at(5, 22),
        timeZone: 'America/New_York',
        place: { name: "Priya's place", city: 'Brightwater' },
        hosts: [priya.id],
        going: 12,
        guests: [hoa.id, many[0]!.id, maya.id, many[1]!.id, many[2]!.id, marco.id, many[3]!.id, many[4]!.id, many[5]!.id, many[6]!.id, many[7]!.id],
        guestsShown: 'all',
        rsvp: 'maybe',
        conversation: eventConvNativeId('pfdemodumplings'),
        ics: 'https://partiful.example/ics/pfdemodumplings.ics',
      }),
    },
    {
      explore: { text: 'Trending this week', kind: 'topic' },
      post: ev('pfdemokaraoke', 'Karaoke Night for Bad Singers', 'Talent strictly discouraged. Duets encouraged.', COVERS.karaoke, {
        start: at(3, 21),
        timeZone: 'America/New_York',
        place: { name: 'The Velvet Room', city: 'Brightwater' },
        hosts: [marco.id],
        going: 64,
        guests: [many[8]!.id, priya.id, many[9]!.id, many[10]!.id],
        guestsShown: 'sample',
        price: '$15',
        rsvp: null,
      }),
    },
    {
      explore: { text: 'Food', kind: 'topic' },
      post: ev('pfdemosupper', 'Secret Supper Club', 'Seven courses, one long table, address sent the day before.', COVERS.supper, {
        start: at(8, 19),
        timeZone: 'America/New_York',
        hosts: [sup.id],
        going: 30,
        // The host hides the list and the address: no guests, no place.
        guestsShown: 'hidden',
        price: '$80',
        rsvp: null,
      }),
    },
    {
      mine: true,
      post: ev('pfdemohouse', 'Housewarming!', 'New flat, old friends. Bring a plant if you like.', COVERS.housewarming, {
        start: at(-20, 17),
        timeZone: 'America/New_York',
        place: { name: 'Third floor, green door', city: 'Brightwater' },
        hosts: [hoa.id],
        going: 22,
        guests: [priya.id, many[2]!.id, many[11]!.id],
        guestsShown: 'all',
        rsvp: 'going',
      }, epoch - 40 * DAY),
    },
  ];
  const dumplings = eventConvNativeId('pfdemodumplings');
  return {
    network: 'partiful',
    me,
    people: [priya, marco, hoa, sup, maya, ...many],
    events,
    chats: [
      {
        conv: { nativeId: dumplings, shape: 'group', variant: 'text', name: 'Dumpling Folding Party', avatarUrl: COVERS.dumplings, participants: [me.id, priya.id, hoa.id, marco.id], lastMessageAt: epoch - 40 * MIN },
        messages: [
          { id: 'cmt-demo-1', who: hoa.id, min: 30 * 60, body: 'Can I bring a friend who folds faster than me?', extra: { event: 'pfdemodumplings' } },
          { id: 'cmt-demo-2', who: priya.id, min: 29 * 60, body: 'Always.', extra: { event: 'pfdemodumplings' } },
          { id: 'blast-demo-pf', who: priya.id, min: 6 * 60, body: 'Text blast: doors at 6, filling is ready at 6:30. Buzz 3B.', extra: { blast: true, event: 'pfdemodumplings' } },
          { id: 'cmt-demo-3', who: marco.id, min: 40, body: 'I will bring chilli oil 🌶️', extra: { event: 'pfdemodumplings' } },
        ],
      },
      {
        conv: { nativeId: 'room-demo-priya', shape: 'direct', participants: [me.id, priya.id], lastMessageAt: epoch - 2 * H },
        messages: [
          { id: 'dm-demo-1', who: priya.id, min: 3 * 60, body: 'You coming on Saturday? I put you down as maybe.' },
          { id: 'dm-demo-2', who: me.id, min: 2 * 60, body: 'Probably! Will know by Thursday.' },
        ],
      },
    ],
    feed: [
      { min: 4 * DAY / MIN, who: priya.id, id: 'n-demo-pf1', body: 'Priya N. invited you to Dumpling Folding Party' },
      { min: 6 * 60, who: priya.id, id: 'n-demo-pf2', body: 'Priya N. sent a text blast to Dumpling Folding Party' },
      { min: 40, who: marco.id, id: 'n-demo-pf3', body: 'Marco commented on Dumpling Folding Party' },
    ],
    capabilities: ['send', 'history', 'markRead', 'react', 'profile', 'home'],
  };
}

const WORLDS: Record<EventNet, (epoch: number) => World> = { luma, partiful };

/** Explore's page size: two pages of the city's listing, so paging shows. */
const EXPLORE_PAGE = 3;

/**
 * One event site, played. Nothing is sent anywhere: an RSVP, a comment or a message is logged (action writeLog) and
 * answered as the site would.
 */
export class DemoEvents implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private w!: World;
  private epoch = 0;
  private rsvps = new Map<string, P.EventRsvp>();
  private writes: string[] = [];
  private homeLog: { feed: P.HomeFeed; cursor?: string; at: number }[] = [];
  private sent = 0;

  constructor(
    private acc: AccountRow,
    _dir: string,
  ) {}

  private get network(): EventNet {
    return this.acc.network as EventNet;
  }

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    this.epoch = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    this.w = WORLDS[this.network](this.epoch);
    const w = this.w;
    emit({ t: 'hello', network: this.network, version: 'demo', capabilities: w.capabilities });
    emit({ t: 'status', status: 'online', self: { ...ident(w.me), isSelf: true } });
    for (const p of w.people) emit({ t: 'identity', identity: ident(p) });
    for (const p of w.people.filter((x) => x.bio || x.links)) emit({ t: 'personAbout', who: p.id, about: this.about(p), ts: this.epoch - 2 * H });
    emit({ t: 'conversation', conversation: { nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications', lastMessageAt: this.epoch - (w.feed[w.feed.length - 1]?.min ?? 0) * MIN } });
    for (const n of w.feed)
      emit({ t: 'message', live: false, message: { nativeId: `other:${n.id}:${n.who}`, conversation: 'feed', author: n.who, ts: this.epoch - n.min * MIN, kind: 'system', body: n.body, extra: { feed: { type: 'other', text: n.body } satisfies P.FeedItem } } });
    for (const c of w.chats) {
      emit({ t: 'conversation', conversation: c.conv });
      for (const m of c.messages) emit({ t: 'message', live: false, message: { nativeId: m.id, conversation: c.conv.nativeId, author: m.who, ts: this.epoch - m.min * MIN, body: m.body, ...(m.extra ? { extra: m.extra } : {}) } });
    }
  }

  private about(p: Person): P.PersonAbout {
    return { displayName: p.name, ...(p.handle ? { handle: p.handle } : {}), avatar: ident(p).avatarUrl, ...(p.bio ? { bio: p.bio } : {}), ...(p.links ? { links: p.links } : {}) };
  }

  /** An event as this account sees it now (its RSVP, once sent). */
  private viewed(p: P.PostFact): P.PostFact {
    const r = this.rsvps.get(p.id);
    if (!r || !p.event) return p;
    const was = p.event.rsvp === 'going';
    const going = (p.event.going ?? 0) + (r === 'going' && !was ? 1 : r !== 'going' && was ? -1 : 0);
    return { ...p, event: { ...p.event, rsvp: r, going } };
  }

  command(cmd: P.AdapterCommand) {
    const reply = (result?: unknown) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: true, result });
    const fail = (error: string) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: false, error });
    const site = this.network === 'luma' ? 'Luma' : 'Partiful';
    switch (cmd.t) {
      case 'home': {
        this.homeLog.push({ feed: cmd.feed, ...(cmd.cursor ? { cursor: cmd.cursor } : {}), at: Date.now() });
        if (cmd.feed === 'foryou') return fail(`${site} has no For you`);
        if (cmd.feed === 'following') {
          // Upcoming soonest first, then the past, newest first.
          const now = Date.now();
          const mine = this.w.events.filter((e) => e.mine || this.rsvps.has(e.post.id)).map((e) => e.post);
          const up = mine.filter((p) => p.event!.start >= now).sort((a, b) => a.event!.start - b.event!.start);
          const past = mine.filter((p) => p.event!.start < now).sort((a, b) => b.event!.start - a.event!.start);
          return reply({ items: [...up, ...past].map((post) => ({ post: this.viewed(post) })), more: null, top: null } satisfies P.HomePage);
        }
        const all = this.w.events.filter((e) => e.explore);
        const from = cmd.cursor === 'page-2' ? EXPLORE_PAGE : 0;
        const page = all.slice(from, from + EXPLORE_PAGE);
        return reply({ items: page.map((e) => ({ post: this.viewed(e.post), reason: e.explore! })), more: from + EXPLORE_PAGE < all.length ? 'page-2' : null, top: null } satisfies P.HomePage);
      }
      case 'profile': {
        const p = [this.w.me, ...this.w.people].find((x) => x.id === cmd.who);
        return p ? reply(this.about(p)) : fail('no such user');
      }
      case 'action': {
        if (cmd.action === 'rsvp') {
          const a = (cmd.args ?? {}) as Partial<P.EventRsvpArgs>;
          const e = this.w.events.find((x) => x.post.id === a.eventId);
          if (!e || !a.status) return fail(`${site} has no such event`);
          this.writes.push(`rsvp:${a.eventId}:${a.status}`);
          this.rsvps.set(e.post.id, a.status);
          return reply(this.viewed(e.post));
        }
        return reply(cmd.action === 'writeLog' ? { writes: this.writes } : cmd.action === 'homeLog' ? { home: this.homeLog } : { note: `demo ${site} has no such action` });
      }
      case 'send': {
        if (this.network === 'luma' && cmd.conversation.startsWith('event:')) return fail('Luma events have no comments');
        this.writes.push(`send:${cmd.conversation}`);
        const nativeId = `sent-demo-${++this.sent}`;
        this.emit({ t: 'message', live: true, message: { nativeId, conversation: cmd.conversation, author: this.w.me.id, ts: Date.now(), body: cmd.body } });
        return reply({ nativeId });
      }
      case 'react':
        this.writes.push('react');
        return reply({});
      case 'history':
        return reply({ count: 0, done: true } satisfies P.HistoryResult);
      case 'markRead':
        return reply({});
      default:
        if ('id' in cmd) fail(`the demo ${site} account cannot do that`);
    }
  }

  stop() {}
}
