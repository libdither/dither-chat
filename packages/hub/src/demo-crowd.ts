/**
 * DITHER_DEMO_SCENARIO=crowd (demo.ts): a bigger world for the people graph and Same person? (docs/same-person.md).
 * About 120 people on all five networks in eight more servers and eleven group chats, nine people already known to be
 * one person on two or three networks (merged by the overlay), and ten pairs planted for Same person? to find, from
 * sure to faint:
 *
 *  - Dana: a Discord profile links her Telegram (claims);
 *  - Felix: one phone number on Signal and WhatsApp (contact);
 *  - Gus: a Matrix bridge's stand-in for his Discord account (bridge);
 *  - Moth: the same handle and the same picture on Discord and Matrix (name, picture);
 *  - Pippa: a Discord handle that is her Signal name, and the Discord chat went quiet as the Signal one began (name, handoff);
 *  - fernweh and Juno: the same picture, and nothing else (picture);
 *  - nightjar and Rosa: a similar picture and two friends in common (picture, friends);
 *  - Marguerite: names alike and a similar picture (name, picture);
 *  - kestrel and Wes: four friends in common, and nothing else (friends).
 *
 * Every side is in a server or a group, so the graph draws both. Everything here is invented.
 */
import type * as P from '@dither-chat/protocol';
import { room, snow, tgUser, uuid, wgroup } from './demo-ids.ts';

type AccKey = 'dmain' | 'dalt' | 'sig' | 'mx' | 'wa' | 'tg';
type Msg = [minutesAgo: number, author: P.IdentityFact, body: string];
interface Crowd {
  pools: { discord: Record<string, P.IdentityFact>; signal: Record<string, P.IdentityFact>; matrix: Record<string, P.IdentityFact>; whatsapp: Record<string, P.IdentityFact>; telegram: Record<string, P.IdentityFact> };
  spaces: { acc: AccKey[]; fact: P.SpaceFact }[];
  convs: { acc: AccKey[]; fact: P.ConversationFact; msgs: Msg[] }[];
  /** Server members the client saw, kept only with the adversarial `members` setting. */
  members: { acc: AccKey; space: string; total: number; members: P.IdentityFact[] }[];
  /** Discord profiles by pool key, as demo.ts's DISCORD_PROFILES has them. */
  profiles: Record<string, { bio?: string; accent?: string; links?: P.PersonAbout['links'] }>;
  /** People already merged across networks: [name, accounts]. */
  merges: [string, [P.Network, P.IdentityFact][]][];
}

const H = 60;
const DAY = 24 * H;

/** A small fixed-seed generator, so the crowd is the same every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const svg = (bg: string, body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/>${body}</svg>`)}`;
/** The planted pairs' pictures: one picture twice, and pictures redrawn a little (other colours, moved a touch). */
const owl = (bg: string, body: string, dx: number) =>
  svg(bg, `<ellipse cx="${32 + dx}" cy="40" rx="20" ry="22" fill="${body}"/><path d="M${14 + dx} 22 L${20 + dx} 10 L${26 + dx} 20Z M${50 + dx} 22 L${44 + dx} 10 L${38 + dx} 20Z" fill="${body}"/><circle cx="${24 + dx}" cy="32" r="8" fill="#fff"/><circle cx="${40 + dx}" cy="32" r="8" fill="#fff"/><circle cx="${24 + dx}" cy="33" r="4" fill="#111"/><circle cx="${40 + dx}" cy="33" r="4" fill="#111"/><path d="M${29 + dx} 40 L${35 + dx} 40 L${32 + dx} 46Z" fill="#f2a541"/>`);
const daisy = (bg: string, petal: string, dx: number) =>
  svg(bg, `<g transform="translate(${dx} 0)"><g fill="${petal}">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<ellipse cx="32" cy="14" rx="6" ry="16" transform="rotate(${a} 32 32)"/>`).join('')}</g><circle cx="32" cy="32" r="8" fill="#f7c948"/></g>`);
const PICS = {
  owlA: owl('#2d2a4a', '#8a6a4f', 0),
  owlB: owl('#3b3560', '#9a7658', 2),
  moth: svg('#1d1b26', `<path d="M32 18 C 18 6, 4 16, 10 30 C 4 42, 18 54, 32 40 C 46 54, 60 42, 54 30 C 60 16, 46 6, 32 18Z" fill="#e8d9b0"/><rect x="30" y="16" width="4" height="30" rx="2" fill="#5a4a3a"/>`),
  fern: svg('#e9f5e1', `<path d="M32 58 C 32 40, 30 22, 34 6" stroke="#2f6b3a" stroke-width="3" fill="none"/>${[12, 20, 28, 36, 44].map((y, i) => `<path d="M33 ${y} C ${44 - i} ${y - 6}, ${52 - i} ${y - 2}, ${56 - i * 2} ${y + 2} M32 ${y + 3} C ${21 + i} ${y - 3}, ${12 + i} ${y + 1}, ${8 + i * 2} ${y + 5}" stroke="#3f8f4a" stroke-width="3" fill="none"/>`).join('')}`),
  // 8 bits apart in a 64-bit difference hash: "a similar profile picture". The owls come out 4 apart: "nearly the same".
  daisyA: daisy('#5aa9e6', '#ffffff', 0),
  daisyB: daisy('#4f97d1', '#fff6e8', 2),
};

const FIRST = ['Ada', 'Bram', 'Cleo', 'Dev', 'Esme', 'Finn', 'Gia', 'Hugo', 'Iris', 'Jonah', 'Kira', 'Luca', 'Maya', 'Nico', 'Oona', 'Pia', 'Rafe', 'Suki', 'Tavi', 'Ugo', 'Vik', 'Willa', 'Xavi', 'Yuki', 'Zane', 'Arun', 'Bex', 'Cyrus', 'Della', 'Emil', 'Fen', 'Greta', 'Hal', 'Ivo', 'Juna', 'Kofi', 'Lark', 'Milo', 'Nell', 'Orrin'];
const LAST = ['Moss', 'Quill', 'Reyes', 'Sato', 'Thorne', 'Underhill', 'Vasquez', 'Wilde', 'Yoon', 'Zeller', 'Ashby', 'Brandt', 'Castillo', 'Dunmore', 'Eklund', 'Farrow', 'Gale', 'Holm', 'Ibarra', 'Jansen', 'Kowal', 'Lund', 'Marsh', 'Novak', 'Oduya', 'Pike', 'Rook', 'Strand', 'Tamura', 'Voss'];

/** Phone numbers in the +1 555 01xx range the demo world does not use yet. */
const TAKEN = new Set([100, 101, 102, 103, 118, 122, 131, 137, 142, 144, 149, 161, 177, 188, 190, 199]);
const FREE_PHONES = Array.from({ length: 100 }, (_, i) => 100 + i).filter((n) => !TAKEN.has(n));

export function crowd(self: Record<AccKey, P.IdentityFact>): Crowd {
  const rand = rng(20261117);
  const pick = <T>(l: T[]) => l[Math.floor(rand() * l.length)];
  const sample = <T>(l: T[], n: number) => {
    const c = [...l];
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c.slice(0, n);
  };
  const names = sample(
    FIRST.flatMap((f) => LAST.map((l) => [f, l] as const)),
    130,
  );
  let phone = 0;
  const nextPhone = () => FREE_PHONES[phone++];
  const dc = (k: string, handle: string, displayName: string, avatarUrl?: string): P.IdentityFact => ({ nativeId: snow('c-' + k), handle, displayName, ...(avatarUrl ? { avatarUrl } : {}) });
  const sg = (k: string, displayName: string, n = nextPhone(), avatarUrl?: string): P.IdentityFact => ({ nativeId: uuid('c-' + k), handle: `+1 555 0${n}`, displayName, ...(avatarUrl ? { avatarUrl } : {}) });
  const mx = (user: string, displayName: string, avatarUrl?: string): P.IdentityFact => ({ nativeId: user, handle: user, displayName, ...(avatarUrl ? { avatarUrl } : {}) });
  const wa = (displayName: string, n = nextPhone(), avatarUrl?: string): P.IdentityFact => ({ nativeId: `15550${n}@s.whatsapp.net`, handle: `+15550${n}`, displayName, ...(avatarUrl ? { avatarUrl } : {}) });
  const tg = (k: string, username: string, displayName: string, avatarUrl?: string): P.IdentityFact => ({ nativeId: tgUser('c-' + k), handle: `@${username}`, displayName, ...(avatarUrl ? { avatarUrl } : {}) });

  // ---------------- people on one network
  const lower = (s: string) => s.toLowerCase();
  const counts = { discord: 70, telegram: 14, signal: 14, whatsapp: 10, matrix: 14 };
  const crowdOf = { discord: [] as P.IdentityFact[], telegram: [] as P.IdentityFact[], signal: [] as P.IdentityFact[], whatsapp: [] as P.IdentityFact[], matrix: [] as P.IdentityFact[] };
  let at = 0;
  for (const [net, n] of Object.entries(counts) as [keyof typeof counts, number][])
    for (let i = 0; i < n; i++) {
      const [f, l] = names[at++];
      const full = `${f} ${l}`;
      const k = `${net}-${lower(f)}-${lower(l)}`;
      crowdOf[net].push(
        net === 'discord'
          ? dc(k, pick([`${lower(f)}.${lower(l)}`, `${lower(f)}${lower(l[0])}`, `${lower(l)}_${lower(f)}`]), full)
          : net === 'telegram'
            ? tg(k, `${lower(f)}_${lower(l)}`, full)
            : net === 'signal'
              ? sg(k, full)
              : net === 'whatsapp'
                ? wa(full)
                : mx(`@${lower(f)}${lower(l)}:matrix.org`, full),
      );
    }

  // ---------------- people already known to be one person (merged in the overlay)
  const K = {
    odette: { d: dc('odette', 'odette.v', 'Odette'), t: tg('odette', 'odettev', 'Odette Vance'), s: sg('odette', 'Odette Vance') },
    pavel: { d: dc('pavel', 'pavel.r', 'Pavel'), s: sg('pavel', 'Pavel Ruiz') },
    rhea: { t: tg('rhea', 'rhea_l', 'Rhea Lindqvist'), w: wa('Rhea') },
    silas: { d: dc('silas', 'silas.grey', 'Silas'), m: mx('@silas:matrix.org', 'Silas Grey') },
    tess: { s: sg('tess', 'Tess Abara'), t: tg('tess', 'tessab', 'Tess') },
    umar: { d: dc('umar', 'umar.s', 'Umar'), w: wa('Umar Saleh'), s: sg('umar', 'Umar Saleh') },
    vera: { m: mx('@vera:nixos.dev', 'Vera Kim'), t: tg('vera', 'verakim', 'Vera Kim') },
    wyatt: { d: dc('wyatt', 'wyatt.cho', 'Wyatt'), t: tg('wyatt', 'wyattc', 'Wyatt Cho') },
    yara: { d: dc('yara', 'yara.fenn', 'Yara'), s: sg('yara', 'Yara Fenn') },
  };

  // ---------------- the planted pairs
  const X = {
    danaD: dc('dana', 'dana.okoye', 'Dana'),
    danaT: tg('dana', 'danaok', 'D. Okoye'),
    felixS: sg('felix', 'Felix', 131),
    felixW: wa('Felix B.', 131),
    gusD: dc('gus', 'gus.writes', 'Gus'),
    gusM: mx(`@discord_${snow('c-gus')}:bridge.example.org`, 'Gus (Discord)'),
    mothD: dc('moth', 'mothlight', 'Moth', PICS.moth),
    mothM: mx('@mothlight:matrix.org', 'moth', PICS.moth),
    pippaD: dc('pippa', 'pippa22', 'pip'),
    pippaS: sg('pippa', 'Pippa'),
    fernD: dc('fernweh', 'fernweh', 'fernweh', PICS.fern),
    junoT: tg('juno', 'juno_reads', 'Juno', PICS.fern),
    nightjarD: dc('nightjar', 'nightjar', 'nightjar', PICS.owlA),
    rosaT: tg('rosa', 'rosa_m', 'Rosa M', PICS.owlB),
    margW: wa('Marguerite L.', nextPhone(), PICS.daisyA),
    margM: mx('@mlam:matrix.org', 'Marguerite Lam', PICS.daisyB),
    kestrelD: dc('kestrel', 'kestrel_w', 'kestrel'),
    wesS: sg('wes', 'Wes Hart'),
  };

  const pools: Crowd['pools'] = { discord: {}, signal: {}, matrix: {}, whatsapp: {}, telegram: {} };
  const put = (net: keyof Crowd['pools'], k: string, i: P.IdentityFact) => (pools[net][`c_${k}`] = i);
  const NET: Record<string, keyof Crowd['pools']> = { d: 'discord', t: 'telegram', s: 'signal', w: 'whatsapp', m: 'matrix' };
  for (const [net, l] of Object.entries(crowdOf) as [keyof Crowd['pools'], P.IdentityFact[]][]) l.forEach((i, n) => put(net, `${net[0]}${n}`, i));
  for (const [name, accs] of Object.entries(K)) for (const [n, i] of Object.entries(accs)) put(NET[n], `${name}_${n}`, i);
  for (const [k, i] of Object.entries(X)) put(NET[k.at(-1)!.toLowerCase()], k, i);

  // ---------------- servers
  const spaces: Crowd['spaces'] = [];
  const convs: Crowd['convs'] = [];
  const members: Crowd['members'] = [];
  const LINES = ['anyone around this weekend?', 'posted the photos', 'nice one', 'same time next week?', 'this is great', 'who has the link from before', 'on my way', 'thanks all', 'agreed', 'late again, sorry'];
  const chatter = (who: P.IdentityFact[], n: number, from: number): Msg[] => Array.from({ length: Math.min(n, who.length) }, (_, i) => [from - i * 37, who[i], LINES[(i * 7 + from) % LINES.length]]);
  const SERVERS: [key: string, name: string, acc: AccKey, channel: string, total: number, planted: P.IdentityFact[], known: P.IdentityFact[]][] = [
    ['nightmarket', 'Night Market Makers', 'dmain', 'show-and-tell', 2140, [X.danaD], [K.odette.d, K.wyatt.d]],
    ['tidepool', 'Tidepool Ecology', 'dmain', 'sightings', 860, [X.fernD], [K.silas.d, K.yara.d]],
    ['openhw', 'Open Hardware Guild', 'dmain', 'boards', 5320, [X.gusD, X.kestrelD], [K.pavel.d, K.umar.d]],
    ['beta', 'Bouldering Beta', 'dmain', 'projects', 410, [X.pippaD], [K.odette.d, K.yara.d]],
    ['lantern', 'Lantern Games Jam', 'dalt', 'jam-chat', 1290, [X.nightjarD], [K.wyatt.d, K.silas.d]],
    ['synthwave', 'Synthwave Lounge', 'dalt', 'tracks', 3075, [X.mothD], [K.pavel.d]],
  ];
  SERVERS.forEach(([k, name, acc, channel, total, planted, known], s) => {
    const id = snow('c-srv-' + k);
    spaces.push({ acc: [acc], fact: { nativeId: id, kind: 'community', name } });
    const who = [...planted, ...known, ...sample(crowdOf.discord, 12 + Math.floor(rand() * 10))];
    members.push({ acc, space: id, total, members: who });
    convs.push({ acc: [acc], fact: { nativeId: snow(`c-srv-${k}-${channel}`), shape: 'channel', name: channel, spaces: [{ nativeId: id, position: '0000' }] }, msgs: chatter(sample(who, 4), 4, (s + 1) * 5 * H) });
  });
  const MX_SPACES: [key: string, name: string, channel: string, who: P.IdentityFact[]][] = [
    ['fedi', 'Fediverse Admins', 'moderation', [K.silas.m, K.vera.m, ...crowdOf.matrix.slice(0, 7)]],
    ['typeset', 'Typesetting Circle', 'fonts', [X.gusM, X.mothM, K.vera.m, ...crowdOf.matrix.slice(7)]],
  ];
  MX_SPACES.forEach(([k, name, channel, who], s) => {
    const id = room('c-' + k, 'matrix.org');
    spaces.push({ acc: ['mx'], fact: { nativeId: id, kind: 'community', name } });
    convs.push({ acc: ['mx'], fact: { nativeId: room(`c-${k}-${channel}`, 'matrix.org'), shape: 'channel', name: channel, spaces: [{ nativeId: id, position: '0000' }], participants: [self.mx.nativeId, ...who.map((i) => i.nativeId)] }, msgs: chatter(who, 3, (s + 2) * 7 * H) });
  });

  // ---------------- group chats
  const group = (acc: AccKey, nativeId: string, name: string, who: P.IdentityFact[], ago: number, x: Partial<P.ConversationFact> = {}) =>
    convs.push({ acc: [acc], fact: { nativeId, shape: 'group', name, participants: [self[acc].nativeId, ...who.map((i) => i.nativeId)], ...x }, msgs: chatter(who, 3, ago) });
  const sgid = (k: string) => `group:${Buffer.from(snow('c-sg-' + k)).toString('base64').slice(0, 43)}=`;
  group('dmain', snow('c-gdm-jam'), 'jam team', [X.nightjarD, K.wyatt.d, K.odette.d], 3 * H);
  group('dmain', snow('c-gdm-studio'), 'studio', [X.kestrelD, K.pavel.d, K.umar.d], 9 * H);
  group('dmain', snow('c-gdm-print'), 'print club', [X.kestrelD, K.odette.d, K.yara.d], 2 * DAY);
  group('dalt', snow('c-gdm-zine'), 'zine swap', [X.fernD, ...crowdOf.discord.slice(0, 3)], 4 * DAY);
  group('tg', 'chat:5810001', 'Hiking Thursdays', [X.danaT, K.tess.t, K.rhea.t, ...crowdOf.telegram.slice(0, 5)], 5 * H);
  group('tg', 'chat:5810002', 'Board games 🎲', [X.rosaT, K.wyatt.t, K.odette.t, K.vera.t, ...crowdOf.telegram.slice(5, 7)], DAY);
  group('tg', 'chat:5810003', 'Flat 4B', [X.junoT, ...crowdOf.telegram.slice(7, 10)], 3 * DAY);
  group('sig', sgid('dinners'), 'Thursday dinners', [X.wesS, K.odette.s, K.pavel.s], 7 * H, { encrypted: true });
  group('sig', sgid('band'), 'Band practice', [X.wesS, K.umar.s, K.yara.s], 2 * DAY, { encrypted: true });
  group('sig', sgid('books'), 'Book swap', [X.felixS, X.pippaS, K.tess.s, ...crowdOf.signal.slice(0, 6)], 6 * DAY, { encrypted: true });
  group('wa', wgroup('c-pottery'), 'Pottery class', [X.felixW, X.margW, K.umar.w, K.rhea.w, ...crowdOf.whatsapp.slice(0, 6)], 20 * H, { encrypted: true });
  group('mx', room('c-reading', 'matrix.org'), 'Reading room', [X.margM, K.silas.m, ...crowdOf.matrix.slice(3, 6)], 30 * H, { encrypted: true });

  // ---------------- Pippa's direct chats: Discord until about 200 days ago, then Signal
  convs.push({
    acc: ['dmain'],
    fact: { nativeId: snow('c-dm-pippa'), shape: 'direct', participants: [self.dmain.nativeId, X.pippaD.nativeId] },
    msgs: [
      [330 * DAY, X.pippaD, 'did you finish the route on the left wall?'],
      [329 * DAY, self.dmain, 'not yet, the crux is mean'],
      [260 * DAY, X.pippaD, 'gym on thursday?'],
      [205 * DAY, X.pippaD, "i'm off discord for a bit, text me"],
    ],
  });
  convs.push({
    acc: ['sig'],
    fact: { nativeId: `dm:${self.sig.nativeId}:${X.pippaS.nativeId}`, shape: 'direct', participants: [self.sig.nativeId, X.pippaS.nativeId], encrypted: true },
    msgs: [
      [198 * DAY, X.pippaS, 'hi, new number for texts'],
      [198 * DAY - 30, self.sig, 'saved!'],
      [12 * DAY, X.pippaS, 'thursday at the gym?'],
    ],
  });

  return {
    pools,
    spaces,
    convs,
    members,
    profiles: {
      c_danaD: { bio: 'linocuts, zines and night markets', accent: '#B5651D', links: [{ label: 'Telegram', value: 'danaok', url: 'https://t.me/danaok' }] },
      c_gusD: { bio: 'writing a typeface, slowly' },
      c_mothD: { bio: 'synths and moths' },
      c_kestrelD: { bio: 'prints and pcbs' },
    },
    merges: [
      ['Odette Vance', [['discord', K.odette.d], ['telegram', K.odette.t], ['signal', K.odette.s]]],
      ['Pavel Ruiz', [['discord', K.pavel.d], ['signal', K.pavel.s]]],
      ['Rhea Lindqvist', [['telegram', K.rhea.t], ['whatsapp', K.rhea.w]]],
      ['Silas Grey', [['discord', K.silas.d], ['matrix', K.silas.m]]],
      ['Tess Abara', [['signal', K.tess.s], ['telegram', K.tess.t]]],
      ['Umar Saleh', [['discord', K.umar.d], ['whatsapp', K.umar.w], ['signal', K.umar.s]]],
      ['Vera Kim', [['matrix', K.vera.m], ['telegram', K.vera.t]]],
      ['Wyatt Cho', [['discord', K.wyatt.d], ['telegram', K.wyatt.t]]],
      ['Yara Fenn', [['discord', K.yara.d], ['signal', K.yara.s]]],
    ],
  };
}
