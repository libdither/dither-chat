/**
 * Same person? (docs/same-person.md): which people in the hub may be one person with accounts on several networks.
 *
 * It reads only what the hub has: identities and their persons, the profiles kept in `about` and `profile_version`,
 * picture hashes the browser made (`picture_hash`), who is in which group chat, direct chats' first and last
 * messages, jev's answers kept in `match_model`, and your own decisions in `match_decision`. It runs on a connection of
 * its own in a worker (matches-worker.ts), so the hub's thread never waits for it, and writes nothing.
 *
 * A side is a row of the people list: a person, or an identity no person holds. Pairs of sides are found by keys they
 * share (blocking), so not every pair is compared:
 *   - claims and contacts: a profile's connected accounts and bio links, phone numbers and email addresses, bridge
 *     puppets (a Matrix `@discord_…` user) - near certain;
 *   - names and handles, rarer ones counting more;
 *   - picture hashes in four bands of 16 bits;
 *   - people already merged across networks around both (friends, group mates).
 * Each pair's evidence is a log-odds weight per kind; the sum, through a logistic, is the chance they are one person.
 * Once you have decided enough pairs, a weight per kind is fitted to your decisions (merges are yes, Not the same is
 * no), pulled toward the hand-set ones.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { MATCH_FAINT, MATCH_SHOWN, NETWORK_META } from '@dither-chat/protocol';

type Row = Record<string, any>;
type Network = P.Network;

export interface MatchRun {
  suggestions: P.MatchSuggestion[];
  /** Under MATCH_SHOWN, at least MATCH_FAINT: shown when asked. */
  faint: P.MatchSuggestion[];
  groups: P.MatchGroup[];
  learned: P.MatchesView['learned'];
  /** Pairs worth asking jev about: cards for both sides. */
  ask: { key: string; card: string; hash: string }[];
  /** Identities whose picture to hash next (sides of pairs, people you talk to). */
  pictures: { identityId: string; url: string; via: string | null }[];
  ms: number;
}

// ------------------------------------------------------------------ reading names

/** Lower case, no accents, letters and digits only. */
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Words of a name: lower case, accents off, at least two letters. */
function tokens(s: string | null | undefined): string[] {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++)
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true;
        m++;
        break;
      }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++)
    if (am[i]) {
      while (!bm[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let l = 0;
  while (l < 4 && a[l] === b[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

// ------------------------------------------------------------------ reading contacts and claims

/** A phone number as its digits, when it looks like one (8 to 15 digits). */
export function phoneKey(s: string): string | null {
  const d = s.replace(/[^\d+]/g, '').replace(/^\+/, '');
  return /^\d{8,15}$/.test(d) ? d.slice(-10) : null;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
const PHONE = /(?:\+\d[\d\s().-]{7,18}\d)/g;

/** Sites whose profile links name an account: the key is `<site>:<handle>`; a site a network of ours is on says which. */
const SITES: { re: RegExp; site: string; network?: Network }[] = [
  { re: /(?:^|[\s/(])(?:www\.)?(?:x|twitter)\.com\/(?!i\/|intent|home|search|share)@?([A-Za-z0-9_]{1,15})\b/g, site: 'x', network: 'x' },
  { re: /(?:^|[\s/(])t\.me\/([A-Za-z0-9_]{4,32})\b/g, site: 'telegram', network: 'telegram' },
  { re: /(?:^|[\s/(])github\.com\/([A-Za-z0-9-]{1,39})\b/g, site: 'github' },
  { re: /(?:^|[\s/(])(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})\b/g, site: 'instagram' },
  { re: /(?:^|[\s/(])bsky\.app\/profile\/([A-Za-z0-9.:-]{3,64})\b/g, site: 'bluesky', network: 'bluesky' },
  { re: /(?:^|[\s/(])(?:www\.)?reddit\.com\/u(?:ser)?\/([A-Za-z0-9_-]{3,20})\b/g, site: 'reddit', network: 'reddit' },
  { re: /(?:^|[\s(])\/?u\/([A-Za-z0-9_-]{3,20})\b/g, site: 'reddit', network: 'reddit' },
  { re: /(?:^|[\s/(])substack\.com\/@([A-Za-z0-9_-]{2,40})\b/g, site: 'substack', network: 'substack' },
  { re: /(?:^|[\s/(])(?:www\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})\b/g, site: 'twitch' },
  { re: /(?:^|[\s/(])(?:www\.)?youtube\.com\/@([A-Za-z0-9_.-]{3,30})\b/g, site: 'youtube' },
  { re: /(?:^|[\s/(])steamcommunity\.com\/(?:id|profiles)\/([A-Za-z0-9_-]{2,32})\b/g, site: 'steam' },
  { re: /(?:^|[\s/(])matrix\.to\/#\/(@[\w.=/-]+:[\w.-]+)/g, site: 'matrix', network: 'matrix' },
];

/** "@name@server", or "https://server/@name" (not a site that puts @names in its paths for itself). */
const FEDI = /(?:^|[\s(])@([A-Za-z0-9_]{1,30})@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b|(?:^|[\s(])(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\/@([A-Za-z0-9_]{1,30})\b/g;
const NOT_FEDI = /(^|\.)(youtube\.com|medium\.com|tiktok\.com|x\.com|twitter\.com|threads\.net|substack\.com|bsky\.app)$/;

/** A connected account's label as a site, and the network of ours it is. */
const LABEL_SITES: Record<string, { site: string; network?: Network }> = {
  x: { site: 'x', network: 'x' },
  twitter: { site: 'x', network: 'x' },
  telegram: { site: 'telegram', network: 'telegram' },
  github: { site: 'github' },
  instagram: { site: 'instagram' },
  bluesky: { site: 'bluesky', network: 'bluesky' },
  reddit: { site: 'reddit', network: 'reddit' },
  substack: { site: 'substack', network: 'substack' },
  lemmy: { site: 'lemmy', network: 'lemmy' },
  twitch: { site: 'twitch' },
  youtube: { site: 'youtube' },
  steam: { site: 'steam' },
  spotify: { site: 'spotify' },
  tiktok: { site: 'tiktok' },
  mastodon: { site: 'mastodon', network: 'mastodon' },
  domain: { site: 'domain' },
  website: { site: 'domain' },
  'battle.net': { site: 'battlenet' },
  'epic games': { site: 'epic' },
  'riot games': { site: 'riot' },
  'league of legends': { site: 'riot' },
  'playstation network': { site: 'psn' },
  xbox: { site: 'xbox' },
  roblox: { site: 'roblox' },
  matrix: { site: 'matrix', network: 'matrix' },
  discord: { site: 'discord', network: 'discord' },
  email: { site: 'email', network: 'email' },
};

/** A handle as a key compares it: lower case, no leading @. */
const handleKey = (s: string) => s.trim().replace(/^@/, '').toLowerCase();

interface Claim {
  /** `site:handle`, or `phone:<digits>` / `email:<address>`. */
  key: string;
  /** Words for the card: "links x.com/annlee". */
  text: string;
  /** The network of ours an account with this key would be on, and its handle there. */
  network?: Network;
  handle?: string;
  /** The network itself vouched for it (a verified connected account). */
  verified?: boolean;
  /** The network whose profile said it. */
  from?: Network;
}

/** What a profile says about other accounts of theirs: connected accounts, links and contacts in the bio, facts. */
export function claimsOf(about: P.PersonAbout): Claim[] {
  const out = new Map<string, Claim>();
  const add = (c: Claim) => {
    if (!out.has(c.key) || (c.verified && !out.get(c.key)!.verified)) out.set(c.key, c);
  };
  for (const l of about.links ?? []) {
    const s = LABEL_SITES[l.label.toLowerCase()];
    const v = l.value?.trim();
    if (!v) continue;
    if (s) {
      const h = handleKey(s.site === 'domain' ? v.replace(/^https?:\/\//, '').replace(/\/$/, '') : v);
      add({ key: `${s.site}:${h}`, text: `links ${l.label} ${v}`, ...(s.network ? { network: s.network, handle: h } : {}), ...(l.verified ? { verified: true } : {}) });
    }
    // A link's address can name a site the label does not (a website that is someone's GitHub).
    if (l.url) for (const c of claimsInText(l.url)) add({ ...c, ...(l.verified ? { verified: true } : {}) });
  }
  const text = [about.bio, ...(about.facts ?? []).map((f) => f.value)].filter(Boolean).join('\n');
  for (const c of claimsInText(text)) add(c);
  return [...out.values()];
}

/** Links, email addresses and phone numbers written in text. */
function claimsInText(text: string): Claim[] {
  const out: Claim[] = [];
  if (!text) return out;
  for (const { re, site, network } of SITES)
    for (const m of text.matchAll(re)) {
      const h = handleKey(m[1]);
      out.push({ key: `${site}:${h}`, text: `links ${site === 'x' ? 'x.com/' : site === 'telegram' ? 't.me/' : `${site} `}${m[1]}`, ...(network ? { network, handle: h } : {}) });
    }
  // A fediverse handle (@name@server) or a profile link (server/@name): Mastodon's, as Mastodon writes them.
  for (const m of text.matchAll(FEDI)) {
    const h = `${m[1] ?? m[4]}@${m[2] ?? m[3]}`.toLowerCase();
    if (NOT_FEDI.test(m[3] ?? '')) continue;
    out.push({ key: `mastodon:${h}`, text: `links Mastodon @${h}`, network: 'mastodon', handle: h });
  }
  for (const m of text.matchAll(EMAIL)) {
    // "@name@server" is a fediverse handle, not an address.
    if (text[m.index! - 1] === '@') continue;
    const e = m[0].toLowerCase();
    out.push({ key: `email:${e}`, text: `gives the address ${e}`, network: 'email', handle: e });
  }
  for (const m of text.matchAll(PHONE)) {
    const p = phoneKey(m[0]);
    if (p) out.push({ key: `phone:${p}`, text: `gives a phone number ending ${p.slice(-4)}` });
  }
  return out;
}

/** The keys an identity itself is known by: its handle on its network, its phone number or address. */
export function ownKeys(i: { network: Network; native_id: string; handle?: string | null }): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const net = NETWORK_META[i.network]?.name ?? i.network;
  const h = i.handle ? handleKey(i.handle) : null;
  const site = i.network === 'x' ? 'x' : i.network === 'telegram' ? 'telegram' : i.network === 'discord' ? 'discord' : i.network === 'matrix' ? 'matrix' : null;
  if (site && h) out.push({ key: `${site}:${h}`, text: `${net} ${i.handle}` });
  if (i.network === 'matrix') out.push({ key: `matrix:${i.native_id.toLowerCase()}`, text: `Matrix ${i.native_id}` });
  if (i.network === 'email') out.push({ key: `email:${i.native_id.toLowerCase()}`, text: i.native_id.toLowerCase() });
  const phone =
    i.network === 'whatsapp'
      ? phoneKey(i.native_id.split('@')[0])
      : i.network === 'signal' && i.native_id.startsWith('tel:')
        ? phoneKey(i.native_id.slice(4))
        : (i.network === 'telegram' || i.network === 'signal') && i.handle && /^\+?\d[\d\s().-]{7,}$/.test(i.handle)
          ? phoneKey(i.handle)
          : null;
  if (phone) out.push({ key: `phone:${phone}`, text: `the phone number ending ${phone.slice(-4)}` });
  return out;
}

/**
 * A bridge's stand-in on Matrix for an account on another network (mautrix and the like name them `@discord_<id>`,
 * `@telegram_<id>`, `@signal_<uuid>`, `@whatsapp_<number>`): the network and native id it stands for.
 */
export function puppetOf(matrixId: string): { network: Network; native: string } | null {
  const m = /^@(discord|telegram|signal|whatsapp|instagram|facebook|twitter)_([^:]+):/.exec(matrixId);
  if (!m) return null;
  const n = m[1];
  const id = m[2].replace(/=([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (n === 'discord' && /^\d{15,21}$/.test(id)) return { network: 'discord', native: id };
  if (n === 'telegram' && /^\d+$/.test(id)) return { network: 'telegram', native: id };
  if (n === 'signal' && /^[0-9a-f-]{36}$/.test(id)) return { network: 'signal', native: id };
  if (n === 'whatsapp' && /^\d{8,15}$/.test(id)) return { network: 'whatsapp', native: `${id}@s.whatsapp.net` };
  if (n === 'twitter' && /^\d+$/.test(id)) return { network: 'x', native: id };
  if ((n === 'facebook' || n === 'instagram') && /^\d+$/.test(id)) return { network: 'messenger', native: id };
  return null;
}

// ------------------------------------------------------------------ the weights

/** Hand-set log-odds weights; a fit to your decisions scales each kind (fitScales). */
const W = {
  base: -3.1,
  claimOne: 5.5,
  claimBoth: 7,
  /** Two profiles linking the same third account (both link one GitHub). */
  claimShared: 5,
  contact: 7,
  bridge: 9,
  picture: 3.2,
  pictureNear: 1.6,
  handle: 3.8,
  handleDigits: 1.4,
  handleName: 2.4,
  nameRare: 3.7,
  nameJW: 1.1,
  token: 0.7,
  friendsMax: 3.5,
  bio: 1.4,
  handoff: 0.9,
  model: 2.2,
  sameNetwork: -2.6,
  overlap: -1.6,
} as const;

const KINDS: P.MatchEvidenceKind[] = ['claims', 'contact', 'bridge', 'picture', 'name', 'friends', 'bio', 'handoff', 'model', 'against'];

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// ------------------------------------------------------------------ the sides

interface Ident {
  id: string;
  network: Network;
  native_id: string;
  handle: string | null;
  display_name: string | null;
  nickname: string | null;
  avatar_url: string | null;
  seen_via: string | null;
  is_bot: number;
  person_id: string | null;
}

interface Side {
  id: string;
  name: string;
  idents: Ident[];
  networks: Set<Network>;
  /** Every name and handle they went by, normalised, with the identity's network. */
  names: Set<string>;
  handles: Set<string>;
  words: Set<string>;
  keys: Map<string, string>;
  claims: Claim[];
  bio: Set<string>;
  bioText: string;
  hashes: bigint[];
  /** Sides around them: group mates, profile friends; weights by how small the group was. */
  around: Map<string, number>;
  direct: { first: number; last: number; n: number } | null;
  directNets: Set<Network>;
}

const STOP = new Set('the and for you are with this that from your have just like what about they them their there here when were been will would could should into than then also only more most some such very much'.split(' '));

/** Bio words for comparing bios: at least four letters, no common ones. */
const bioWords = (s: string) => new Set(tokens(s).filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t)));

interface Loaded {
  sides: Map<string, Side>;
  /** Side id of each identity. */
  sideOf: Map<string, string>;
  self: Set<string>;
  decisions: Map<string, { decision: 'no' | 'later' | 'yes'; until: number | null; features: Record<string, number> | null }>;
  model: Map<string, { card: string; p: number }>;
  /** How many sides have each picture hash. */
  hashCount: Map<bigint, number>;
}

/** Everything the run needs, read in a few queries. */
function load(db: Database, now = Date.now()): Loaded {
  const self = new Set<string>();
  for (const r of db.query('SELECT self_identity FROM account WHERE self_identity IS NOT NULL').all() as Row[]) self.add(r.self_identity);
  for (const r of db.query('SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1').all() as Row[]) self.add(r.id);
  const persons = new Map<string, string>((db.query('SELECT id, name FROM person').all() as Row[]).map((r) => [r.id, r.name]));

  const sides = new Map<string, Side>();
  const sideOf = new Map<string, string>();
  const idents = db
    .query(`SELECT id, network, native_id, handle, display_name, nickname, avatar_url, seen_via, is_bot, person_id FROM identity WHERE network NOT IN ('t3', 'calendar')`)
    .all() as Ident[];
  // A side with you in it is left out whole: merging into yourself is not offered.
  const selfPersons = new Set(idents.filter((i) => self.has(i.id) && i.person_id).map((i) => i.person_id));
  for (const i of idents) {
    if (self.has(i.id) || (i.person_id && selfPersons.has(i.person_id))) continue;
    const sid = i.person_id ?? i.id;
    let s = sides.get(sid);
    if (!s) {
      s = {
        id: sid,
        name: (i.person_id && persons.get(i.person_id)) || i.nickname || i.display_name || i.handle || 'Someone',
        idents: [],
        networks: new Set(),
        names: new Set(),
        handles: new Set(),
        words: new Set(),
        keys: new Map(),
        claims: [],
        bio: new Set(),
        bioText: '',
        hashes: [],
        around: new Map(),
        direct: null,
        directNets: new Set(),
      };
      sides.set(sid, s);
    }
    s.idents.push(i);
    s.networks.add(i.network);
    sideOf.set(i.id, sid);
    for (const n of [i.display_name, i.nickname, i.network === 'email' ? null : i.handle]) addName(s, n);
    if (i.handle && i.network !== 'email') s.handles.add(norm(i.handle));
    // A Matrix id's own part is the handle people pick (@mothlight:matrix.org is mothlight); a bridge's stand-in is not.
    const local = i.network === 'matrix' && !puppetOf(i.native_id) ? /^@([^:]+):/.exec(i.native_id)?.[1] : undefined;
    if (local) s.handles.add(norm(local));
    for (const k of ownKeys(i)) s.keys.set(k.key, k.text);
    if (i.network === 'matrix') {
      const p = puppetOf(i.native_id);
      if (p) s.keys.set(`native:${p.network}:${p.native}`, `a bridge's stand-in for their ${NETWORK_META[p.network].name} account`);
    }
    s.keys.set(`native:${i.network}:${i.native_id}`, `${NETWORK_META[i.network]?.name ?? i.network} ${i.handle ?? ''}`.trim());
  }
  // Bots stay out: a bot is no one's other account here.
  for (const [id, s] of sides) if (s.idents.every((i) => i.is_bot)) sides.delete(id);

  // Profiles: the last answer, and earlier versions' names and handles (what they went by before).
  for (const r of db.query('SELECT target_id, data FROM about').all() as Row[]) {
    const s = sides.get(sideOf.get(r.target_id) ?? '');
    if (!s) continue;
    let a: P.PersonAbout;
    try {
      a = JSON.parse(r.data);
    } catch {
      continue;
    }
    addProfile(s, a, r.target_id, sideOf);
  }
  for (const r of db.query('SELECT identity_id, data FROM profile_version').all() as Row[]) {
    const s = sides.get(sideOf.get(r.identity_id) ?? '');
    if (!s) continue;
    try {
      const a = JSON.parse(r.data) as P.PersonAbout;
      addName(s, a.displayName);
      if (a.handle) s.handles.add(norm(a.handle));
      for (const c of claimsOf(a)) if (!s.claims.some((x) => x.key === c.key)) s.claims.push(c);
    } catch {}
  }

  const hashCount = new Map<bigint, number>();
  for (const r of db.query('SELECT identity_id, url, hash FROM picture_hash WHERE hash IS NOT NULL').all() as Row[]) {
    const s = sides.get(sideOf.get(r.identity_id) ?? '');
    if (!s || !/^[0-9a-f]{16}$/.test(r.hash)) continue;
    const h = BigInt('0x' + r.hash);
    if (!s.hashes.includes(h)) {
      s.hashes.push(h);
      hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
    }
  }

  // Group mates: the smaller the group, the more it says. Server channels say little, and are left out.
  const groups = new Map<string, string[]>();
  for (const r of db.query(`SELECT p.conversation_id AS c, p.identity_id AS i FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE c.shape = 'group'`).all() as Row[]) {
    const sid = sideOf.get(r.i);
    if (!sid || !sides.has(sid)) continue;
    const l = groups.get(r.c);
    if (l) l.push(sid);
    else groups.set(r.c, [sid]);
  }
  for (const members of groups.values()) {
    if (members.length < 2 || members.length > 60) continue;
    const w = 1 / Math.log2(1 + members.length);
    for (const a of members) {
      const s = sides.get(a)!;
      for (const b of members) if (a !== b) s.around.set(b, Math.max(s.around.get(b) ?? 0, w));
    }
  }

  // Your direct chats with each side: when they began and when they went quiet, on which networks.
  for (const r of db
    .query(
      `SELECT p.identity_id AS i, c.network AS network, MIN(m.ts) AS first, MAX(m.ts) AS last, COUNT(*) AS n
       FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN message m ON m.conversation_id = c.id
       WHERE c.shape = 'direct' GROUP BY p.identity_id, c.network`,
    )
    .all() as Row[]) {
    const s = sides.get(sideOf.get(r.i) ?? '');
    if (!s || !r.first) continue;
    s.direct = s.direct ? { first: Math.min(s.direct.first, r.first), last: Math.max(s.direct.last, r.last), n: s.direct.n + r.n } : { first: r.first, last: r.last, n: r.n };
    s.directNets.add(r.network);
  }

  const decisions = new Map<string, { decision: 'no' | 'later' | 'yes'; until: number | null; features: Record<string, number> | null }>();
  for (const r of db.query('SELECT key, decision, until, features FROM match_decision').all() as Row[]) {
    if (r.decision === 'later' && r.until && r.until < now) continue;
    decisions.set(r.key, { decision: r.decision, until: r.until ?? null, features: r.features ? JSON.parse(r.features) : null });
  }
  const model = new Map<string, { card: string; p: number }>((db.query('SELECT key, card, p FROM match_model').all() as Row[]).map((r) => [r.key, { card: r.card, p: r.p }]));
  return { sides, sideOf, self, decisions, model, hashCount };
}

function addName(s: Side, n: string | null | undefined) {
  const k = norm(n);
  // A phone number for a name (Signal and WhatsApp show the number) is a contact, not a name: keys compare those.
  if (/^\d+$/.test(k)) return;
  if (k.length >= 3) s.names.add(k);
  for (const t of tokens(n)) if (t.length >= 3 && !/^\d+$/.test(t)) s.words.add(t);
}

function addProfile(s: Side, a: P.PersonAbout, identityId: string, sideOf: Map<string, string>) {
  addName(s, a.displayName);
  if (a.handle) s.handles.add(norm(a.handle));
  if (a.username?.name) s.handles.add(norm(a.username.name));
  for (const f of a.facts ?? []) if (/originally known as/i.test(f.label)) addName(s, f.value.replace(/#\d{4}$/, ''));
  const from = s.idents.find((i) => i.id === identityId)?.network;
  for (const c of claimsOf(a)) if (!s.claims.some((x) => x.key === c.key)) s.claims.push({ ...c, ...(from ? { from } : {}) });
  if (a.bio) {
    s.bioText = a.bio;
    for (const w of bioWords(a.bio)) s.bio.add(w);
  }
  // A profile's friends are people around them, as much as a small group's members.
  const net = identityId.split('_')[1];
  for (const f of [...(a.mutualFriends ?? []), ...(a.friends ?? [])]) {
    const other = sideOf.get(`idn_${net}_${f}`) ?? sideOf.get(f);
    if (other && other !== s.id) s.around.set(other, Math.max(s.around.get(other) ?? 0, 0.5));
  }
}

// ------------------------------------------------------------------ finding pairs

export const pairKey = (a: string, b: string) => (a < b ? `${a}+${b}` : `${b}+${a}`);

const popcount = (x: bigint) => {
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
};

/** Pairs worth comparing, from keys they share. */
function candidates(L: Loaded): Set<string> {
  const pairs = new Set<string>();
  const index = new Map<string, string[]>();
  const put = (k: string, sid: string) => {
    const l = index.get(k);
    if (!l) index.set(k, [sid]);
    else if (l[l.length - 1] !== sid) l.push(sid);
  };
  for (const s of L.sides.values()) {
    for (const k of s.keys.keys()) put(`k:${k}`, s.id);
    for (const c of s.claims) put(`k:${c.key}`, s.id);
    for (const n of s.names) if (n.length >= 4) put(`n:${n}`, s.id);
    for (const h of s.handles) {
      if (h.length >= 4) put(`n:${h}`, s.id);
      const bare = h.replace(/\d+$/, '');
      if (bare.length >= 4 && bare !== h) put(`n:${bare}`, s.id);
    }
    for (const w of s.words) if (w.length >= 4) put(`w:${w}`, s.id);
    for (const h of s.hashes) for (let b = 0; b < 4; b++) put(`p${b}:${(h >> BigInt(b * 16)) & 0xffffn}`, s.id);
  }
  // Common keys say nothing and cost much: a name forty people share is no lead, a word a dozen share no lead.
  const LIMIT: Record<string, number> = { k: 8, n: 40, w: 12, p: 6 };
  for (const [k, l] of index) {
    if (l.length < 2 || l.length > (LIMIT[k[0]] ?? 6)) continue;
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) if (l[i] !== l[j]) pairs.add(pairKey(l[i], l[j]));
  }
  // People already known to be one person on several networks tie together those around them on each.
  const bridges = [...L.sides.values()].filter((s) => s.networks.size > 1 && s.around.size);
  const co = new Map<string, number>();
  for (const b of bridges) {
    const near = [...b.around.keys()].map((id) => L.sides.get(id)).filter((x): x is Side => !!x).slice(0, 80);
    for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++) {
        const x = near[i];
        const y = near[j];
        if ([...x.networks].some((n) => y.networks.has(n))) continue;
        const k = pairKey(x.id, y.id);
        co.set(k, (co.get(k) ?? 0) + 1);
      }
  }
  for (const [k, n] of co) if (n >= 2) pairs.add(k);
  return pairs;
}

// ------------------------------------------------------------------ comparing two sides

interface Scored {
  key: string;
  a: Side;
  b: Side;
  evidence: P.MatchEvidence[];
  /** Weight per kind, before any fitted scale. */
  byKind: Record<string, number>;
}

/** How many sides share each name, for how rare a name is. */
function nameCounts(L: Loaded): Map<string, number> {
  const df = new Map<string, number>();
  for (const s of L.sides.values()) for (const n of new Set([...s.names, ...s.handles])) df.set(n, (df.get(n) ?? 0) + 1);
  return df;
}

const netName = (n: Network) => NETWORK_META[n]?.name ?? n;
const on = (s: Side) => [...s.networks].map(netName).join(' and ');

function compare(L: Loaded, a: Side, b: Side, df: Map<string, number>): Scored {
  const ev: P.MatchEvidence[] = [];
  const add = (kind: P.MatchEvidenceKind, text: string, weight: number) => ev.push({ kind, text, weight });

  // Claims: what one side's profile says another account of theirs is, and the other side is.
  const claimOne = (x: Side, y: Side): string | null => {
    for (const c of x.claims) {
      if (!y.keys.has(c.key)) continue;
      const to = y.idents.find((i) => ownKeys(i).some((k) => k.key === c.key))?.network;
      const what = c.key.startsWith('phone:') ? 'number' : c.key.startsWith('email:') ? 'address' : 'account';
      return `${x.name}'s ${c.from ? netName(c.from) : on(x)} profile ${c.text}${c.verified ? ' (verified)' : ''}: ${y.name}'s ${to ? `${netName(to)} ` : ''}${what}`;
    }
    return null;
  };
  const ab = claimOne(a, b);
  const ba = claimOne(b, a);
  const claimed = ab || ba;
  if (ab && ba) add('claims', `${ab}; and the other way round`, W.claimBoth);
  else if (claimed) add('claims', claimed, W.claimOne);
  if (!claimed) {
    const shared = a.claims.find((c) => !c.key.startsWith('domain:') && b.claims.some((d) => d.key === c.key));
    if (shared) add('claims', `Both profiles ${shared.text}`, W.claimShared);
  }
  // Contacts and bridges: the same phone number or address, a bridge's stand-in for the other.
  for (const [k, t] of a.keys) {
    if (!b.keys.has(k)) continue;
    if (k.startsWith('native:')) add('bridge', `${t}: the same account through a bridge`, W.bridge);
    else if (k.startsWith('phone:') || k.startsWith('email:')) add('contact', `The same ${k.startsWith('phone:') ? 'phone number' : 'email address'} on both (${t})`, W.contact);
    else continue;
    break;
  }
  if (!ev.some((e) => e.kind === 'contact'))
    for (const c of a.claims)
      if ((c.key.startsWith('phone:') || c.key.startsWith('email:')) && b.claims.some((d) => d.key === c.key)) {
        add('contact', `Both profiles ${c.text}`, W.contact - 1);
        break;
      }

  // Pictures: the closest pair of hashes, leaving out pictures many share (a network's default picture).
  let best = 65;
  for (const x of a.hashes) for (const y of b.hashes) if ((L.hashCount.get(x) ?? 0) <= 3) best = Math.min(best, popcount(x ^ y));
  if (best <= 4) add('picture', best === 0 ? 'The same profile picture' : 'Nearly the same profile picture', W.picture);
  else if (best <= 9) add('picture', 'A similar profile picture', W.pictureNear);

  // Names: a handle the same on both, then a name, the rarer the stronger, then close spellings, then a shared word.
  // A handle all digits is a phone number: the contact line above says it already.
  const handle = [...a.handles].find((h) => h.length >= 4 && !/^\d+$/.test(h) && (b.handles.has(h) || b.names.has(h)));
  const bareA = new Set([...a.handles].map((h) => h.replace(/\d+$/, '')).filter((h) => h.length >= 4));
  const bare = handle ? undefined : [...b.handles].map((h) => h.replace(/\d+$/, '')).find((h) => bareA.has(h));
  const name = [...a.names].filter((n) => b.names.has(n)).sort((x, y) => (df.get(x) ?? 1) - (df.get(y) ?? 1))[0];
  if (handle) {
    const both = b.handles.has(handle);
    const where = `${netName(whereNamed(a, handle, true))} and ${netName(whereNamed(b, handle, both))}`;
    add('name', both ? `The same handle, ${handle}, on ${where}` : `A handle on one is the name on the other: ${handle} (${where})`, W.handle * rarity(df.get(handle) ?? 2) * (both ? 1 : 0.85));
  }
  else if (bare) add('name', `Handles alike: ${bare}…`, W.handleDigits);
  else {
    // A handle with a number on the end, the name on the other: pippa22 and Pippa.
    const named = [...bareA].find((h) => !a.handles.has(h) && b.names.has(h)) ?? [...b.handles].map((h) => h.replace(/\d+$/, '')).find((h) => h.length >= 4 && !b.handles.has(h) && a.names.has(h));
    if (named) add('name', `A handle on one, less its number, is the name on the other: ${named}`, W.handleName * rarity(df.get(named) ?? 2));
  }
  if (name && name !== handle) {
    const r = rarity(df.get(name) ?? 2);
    // A short single word (a first name) says less than a full name.
    const short = name.length < 7 && ![...a.words].some((w) => w !== name && name.includes(w) && w.length >= 3);
    add('name', `The same name, ${shown(a, name)}${(df.get(name) ?? 0) > 2 ? `, which ${df.get(name)} people share` : ''}`, W.nameRare * r * (short ? 0.45 : 1));
  } else if (!handle && !bare) {
    let jw = 0;
    let pair: [string, string] | null = null;
    for (const x of a.names) for (const y of b.names) if (x.length >= 6 && y.length >= 6) {
      const s = jaroWinkler(x, y);
      if (s > jw) [jw, pair] = [s, [x, y]];
    }
    if (jw >= 0.92 && pair) add('name', `Names alike: ${pair[0]} and ${pair[1]}`, W.nameJW);
    else {
      const w = [...a.words].filter((x) => x.length >= 4 && b.words.has(x));
      if (w.length) add('name', `A word of their names in common: ${w[0]}`, W.token * Math.min(2, w.length));
    }
  }

  // Friends: people around both, the same people (a merged person on both networks), smaller groups counting more.
  let around = 0;
  const common: string[] = [];
  for (const [id, wa] of a.around) {
    const wb = b.around.get(id);
    if (wb === undefined) continue;
    around += Math.min(wa, wb);
    common.push(L.sides.get(id)?.name ?? 'someone');
  }
  if (around >= 0.5)
    add('friends', `${common.length} ${common.length === 1 ? 'person' : 'people'} around both: ${common.slice(0, 3).join(', ')}${common.length > 3 ? '…' : ''}`, Math.min(W.friendsMax, 1.3 * around));

  // Bios alike.
  if (a.bio.size >= 3 && b.bio.size >= 3) {
    let inter = 0;
    for (const w of a.bio) if (b.bio.has(w)) inter++;
    const j = inter / (a.bio.size + b.bio.size - inter);
    if (j >= 0.25) add('bio', `Bios alike (${Math.round(j * 100)}% of words)`, Math.min(W.bio, W.bio * j * 2.5));
  }

  // Direct chats with you: one went quiet as the other began (within three weeks), or both going on at once.
  if (a.direct && b.direct) {
    const [x, y] = a.direct.first <= b.direct.first ? [a.direct, b.direct] : [b.direct, a.direct];
    const gap = y.first - x.last;
    const DAY = 86_400_000;
    if (gap >= -3 * DAY && gap <= 21 * DAY && x.n >= 3) add('handoff', `Your chat on ${x === a.direct ? on(a) : on(b)} went quiet as the one on ${x === a.direct ? on(b) : on(a)} began`, W.handoff);
    else if (gap < -30 * DAY && [...a.directNets].some((n) => b.directNets.has(n))) add('against', `You talk to both at once on ${[...a.directNets].filter((n) => b.directNets.has(n)).map(netName).join(', ')}`, W.overlap);
  }

  // Both on one network: one person seldom has two accounts you see there.
  const same = [...a.networks].filter((n) => b.networks.has(n) && n !== 'email');
  if (same.length) add('against', `Both are on ${same.map(netName).join(' and ')}`, W.sameNetwork);

  const key = pairKey(a.id, b.id);
  const m = L.model.get(key);
  if (m) add('model', `jev read both profiles: ${Math.round(m.p * 100)}% one person`, Math.max(-W.model, Math.min(W.model, Math.log(m.p / (1 - m.p + 1e-6)) * 0.6)));

  const byKind: Record<string, number> = {};
  for (const e of ev) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.weight;
  return { key, a, b, evidence: ev.sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight)), byKind };
}

/** The network of a side's account with this handle (or name). */
function whereNamed(s: Side, n: string, handle: boolean): Network {
  for (const i of s.idents) if (handle ? norm(i.handle) === n : [i.display_name, i.nickname, i.handle].some((x) => norm(x) === n)) return i.network;
  return s.idents[0].network;
}

/** How much a name says by how many share it: 1 for one other, down to 0.3 for a crowd. */
const rarity = (n: number) => Math.max(0.3, Math.min(1, 1.4 - 0.4 * Math.log2(Math.max(2, n))));

/** The name as they wrote it, for the card, rather than squashed. */
function shown(s: Side, n: string): string {
  for (const i of s.idents) for (const x of [i.display_name, i.nickname, i.handle]) if (x && norm(x) === n) return x;
  return n;
}

// ------------------------------------------------------------------ learning from decisions

/**
 * Scales per evidence kind fitted to your decisions: logistic regression on the kinds' summed weights, each scale
 * pulled toward 1 (the hand-set weights) so a few decisions move it a little. Yes: pairs you merged here, and the
 * networks of people you merged before; no: pairs you said are not the same.
 */
export function fitScales(rows: { x: Record<string, number>; y: 0 | 1 }[]): { scales: Record<string, number>; bias: number } | null {
  const yes = rows.filter((r) => r.y === 1).length;
  if (yes < 4 || rows.length - yes < 4) return null;
  const scales: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 1]));
  let bias = 0;
  const lr = 0.05;
  const pull = 0.5;
  for (let step = 0; step < 400; step++) {
    const g: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 0]));
    let gb = 0;
    for (const r of rows) {
      let z = W.base + bias;
      for (const k of KINDS) z += (r.x[k] ?? 0) * scales[k];
      const d = sigmoid(z) - r.y;
      gb += d;
      for (const k of KINDS) g[k] += d * (r.x[k] ?? 0);
    }
    for (const k of KINDS) scales[k] -= lr * (g[k] / rows.length + pull * (scales[k] - 1));
    bias -= lr * (gb / rows.length + pull * bias);
    for (const k of KINDS) scales[k] = Math.max(0.2, Math.min(3, scales[k]));
  }
  return { scales, bias };
}

/** Each person you merged on several networks, compared as its networks' parts: what a yes looks like. */
function mergedExamples(L: Loaded, df: Map<string, number>): Record<string, number>[] {
  const out: Record<string, number>[] = [];
  for (const s of L.sides.values()) {
    if (s.networks.size < 2) continue;
    const parts = [...s.networks].map((n) => partOf(s, n));
    for (let i = 1; i < parts.length; i++) out.push(compare(L, parts[0], parts[i], df).byKind);
    if (out.length > 200) break;
  }
  return out;
}

/** A side's identities on one network, as a side of its own (for learning from merges already made). */
function partOf(s: Side, n: Network): Side {
  const idents = s.idents.filter((i) => i.network === n);
  const p: Side = { ...s, id: `${s.id}#${n}`, idents, networks: new Set([n]), names: new Set(), handles: new Set(), words: new Set(), keys: new Map(), claims: [], bio: new Set(), hashes: [] };
  for (const i of idents) {
    for (const x of [i.display_name, i.nickname, i.network === 'email' ? null : i.handle]) addName(p, x);
    if (i.handle && i.network !== 'email') p.handles.add(norm(i.handle));
    for (const k of ownKeys(i)) p.keys.set(k.key, k.text);
  }
  // Claims and bios are the side's as a whole; kept only on the part whose network made them would need the source.
  p.claims = n === [...s.networks][0] ? s.claims : [];
  return p;
}

// ------------------------------------------------------------------ the run

/** A short text card of a side for jev: names, handles, networks, bio. No message text. */
function card(s: Side): string {
  const ids = s.idents.map((i) => `${netName(i.network)}${i.handle ? ` ${i.handle}` : ''}${i.display_name && i.display_name !== i.handle ? ` (${i.display_name})` : ''}`).slice(0, 4);
  const bio = s.bioText ? ` Bio: ${s.bioText.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `${s.name}: ${ids.join('; ')}.${bio}`;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

function sideView(s: Side): P.MatchSide {
  const avatar = s.idents.find((i) => i.avatar_url)?.avatar_url ?? null;
  return {
    id: s.id,
    name: s.name,
    avatar,
    identities: s.idents.slice(0, 8).map((i) => ({ id: i.id, network: i.network, handle: i.handle, name: i.nickname ?? i.display_name })),
    ...(s.direct ? { direct: true } : {}),
  };
}

export function run(db: Database, opts: { now?: number; limit?: number } = {}): MatchRun {
  const t0 = performance.now();
  const now = opts.now ?? Date.now();
  const L = load(db, now);
  const df = nameCounts(L);
  const pairs = candidates(L);

  // Learn from decisions: each decided pair as it was when decided, merges made before as yes.
  const rows: { x: Record<string, number>; y: 0 | 1 }[] = [];
  for (const d of L.decisions.values()) if (d.features && d.decision !== 'later') rows.push({ x: d.features, y: d.decision === 'yes' ? 1 : 0 });
  const yesBefore = mergedExamples(L, df);
  for (const x of yesBefore) rows.push({ x, y: 1 });
  const fit = fitScales(rows);

  const scored: (Scored & { p: number })[] = [];
  for (const k of pairs) {
    const [x, y] = k.split('+');
    const a = L.sides.get(x);
    const b = L.sides.get(y);
    if (!a || !b) continue;
    const d = L.decisions.get(k);
    if (d && d.decision !== 'yes') continue;
    const s = compare(L, a, b, df);
    let z = W.base + (fit?.bias ?? 0);
    for (const [kind, w] of Object.entries(s.byKind)) z += w * (fit?.scales[kind] ?? 1);
    const p = sigmoid(z);
    if (p >= MATCH_FAINT) scored.push({ ...s, p });
  }
  scored.sort((x, y) => y.p - x.p);
  const limit = opts.limit ?? 400;
  const shownPairs = scored.filter((s) => s.p >= MATCH_SHOWN).slice(0, limit);

  const view = (s: Scored & { p: number }): P.MatchSuggestion => ({ key: s.key, a: sideView(s.a), b: sideView(s.b), p: Math.round(s.p * 1000) / 1000, evidence: s.evidence });
  const suggestions = shownPairs.map(view);
  const faint = scored.filter((s) => s.p < MATCH_SHOWN).slice(0, 60).map(view);

  // Groups: suggestions joined by a side they share, held by links of at least even odds.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const s of suggestions) if (s.p >= 0.5) {
    for (const id of [s.a.id, s.b.id]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(s.a.id), find(s.b.id));
  }
  const byRoot = new Map<string, P.MatchGroup>();
  for (const s of suggestions) {
    if (s.p < 0.5) continue;
    const r = find(s.a.id);
    const g = byRoot.get(r) ?? { sides: [], keys: [], p: 1 };
    for (const id of [s.a.id, s.b.id]) if (!g.sides.includes(id)) g.sides.push(id);
    g.keys.push(s.key);
    g.p = Math.min(g.p, s.p);
    byRoot.set(r, g);
  }
  const groups = [...byRoot.values()].filter((g) => g.sides.length >= 3 && g.sides.length <= 8);

  // jev: pairs in the uncertain middle whose cards it has not read as they are now.
  const ask: MatchRun['ask'] = [];
  for (const s of scored) {
    if (ask.length >= 40) break;
    if (s.p < 0.25 || s.p > 0.9) continue;
    const c = `Account 1 - ${card(s.a)}\nAccount 2 - ${card(s.b)}`;
    const h = hash(c);
    if (L.model.get(s.key)?.card === h) continue;
    ask.push({ key: s.key, card: c, hash: h });
  }

  // Pictures to hash: the sides of pairs first, then people you have direct chats or groups with.
  const pictures: MatchRun['pictures'] = [];
  const hashed = new Map<string, string>((db.query('SELECT identity_id, url FROM picture_hash').all() as Row[]).map((r) => [r.identity_id, r.url]));
  const seen = new Set<string>();
  const want = (s: Side) => {
    for (const i of s.idents) {
      if (pictures.length >= 2000 || seen.has(i.id) || !i.avatar_url || hashed.get(i.id) === i.avatar_url) continue;
      seen.add(i.id);
      pictures.push({ identityId: i.id, url: i.avatar_url, via: i.seen_via });
    }
  };
  for (const s of scored) {
    want(s.a);
    want(s.b);
  }
  for (const s of L.sides.values()) if (s.direct || s.around.size) want(s);

  const decided = [...L.decisions.values()];
  return {
    suggestions,
    faint,
    groups,
    learned: { yes: decided.filter((d) => d.decision === 'yes').length + yesBefore.length, no: decided.filter((d) => d.decision === 'no').length, fitted: !!fit },
    ask,
    pictures,
    ms: Math.round(performance.now() - t0),
  };
}
