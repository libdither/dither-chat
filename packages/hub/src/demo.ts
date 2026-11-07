/**
 * Demo world: five in-process adapters (two Discord accounts, Signal, Matrix, WhatsApp)
 * that emit the same facts real adapters do, so the whole pipeline (dedupe,
 * person merging, triage, folders) runs on realistic data.
 *
 * Native ids are shaped like the real thing (snowflakes, UUIDs, !room:server)
 * so the source panels look right. Timestamps are relative to an epoch fixed at
 * first seed and stored in the account config.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL as P_ABOUT_LABEL, BIO_LIMIT as P_BIO_LIMIT, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

type AccKey = 'dmain' | 'dalt' | 'sig' | 'mx' | 'wa';

export const DEMO_ACCOUNTS: { key: AccKey; id: string; network: P.Network; label: string; color: string }[] = [
  { key: 'dmain', id: 'acc_demo-discord-main', network: 'discord', label: 'main', color: '#F2A541' },
  { key: 'dalt', id: 'acc_demo-discord-alt', network: 'discord', label: 'alt', color: '#E86A92' },
  { key: 'sig', id: 'acc_demo-signal', network: 'signal', label: 'personal', color: '#B794F6' },
  { key: 'mx', id: 'acc_demo-matrix', network: 'matrix', label: 'matrix.org', color: '#FF8C61' },
  { key: 'wa', id: 'acc_demo-whatsapp', network: 'whatsapp', label: 'personal', color: '#7FD1AE' },
];

// ------------------------------------------------------------------ id shapes

const h = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest();
const snow = (k: string) => (BigInt('0x' + h('d' + k).toString('hex').slice(0, 15)) % 900000000000000000n + 1000000000000000000n).toString();
const uuid = (k: string) => {
  const x = h('s' + k).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
};
const room = (k: string, server: string) => `!${h('m' + k).toString('base64url').slice(0, 18)}:${server}`;
const event = (k: string) => `$${h('e' + k).toString('base64url').slice(0, 43)}`;

// ------------------------------------------------------------------ people

const did = (k: string, handle: string, displayName: string, x: Partial<P.IdentityFact> = {}): P.IdentityFact => ({ nativeId: snow(k), handle, displayName, ...x });
const D = {
  zyan: did('zyan', 'zyansheep', 'zyan'),
  zyn: did('zyn', 'zyn.alt', 'zyn'),
  alice: did('alice', 'alice.chen', 'Alice', { contact: true }),
  ravi: did('ravi', 'ravi_p', 'Ravi', { contact: true }),
  jordan: did('jordan', 'jordanruns', 'Jordan', { contact: true }),
  theo: did('theo', 'theo.k', 'Theo', { contact: true }),
  quinn: did('quinn', 'quinn.dev', 'Quinn', { contact: true }),
  lev: did('lev', 'lev', 'Lev'),
  pixelfox: did('pixelfox', 'pixelfox', 'pixelfox'),
  ci: did('ci', 'dither-ci', 'dither-ci', { isBot: true }),
  ferris: did('ferris', 'ferris', 'Ferris', { isBot: true }),
  mara: did('mara', 'mara', 'Mara'),
  owl: did('owl', 'oxidized_owl', 'owl'),
  tim: did('tim', 'tokio_tim', 'Tim'),
  bea: did('bea', 'borrowck', 'Bea'),
  hannah: did('hannah', 'helpful_hannah', 'Hannah'),
  gorb: did('gorb', 'gorb', 'Gorb'),
  pat: did('pat', 'pantheon_pat', 'Pat'),
  shade: did('shade', 'shade.skip', 'Shade'),
};
const sid = (k: string, phone: string, displayName: string, contact = true): P.IdentityFact => ({ nativeId: uuid(k), handle: phone, displayName, contact });
const S = {
  self: sid('self', '+1 555 0100', 'zyan', false),
  alice: sid('alice', '+1 555 0137', 'Alice Chen'),
  mom: sid('mom', '+1 555 0102', 'Mom'),
  dad: sid('dad', '+1 555 0103', 'Dad'),
  mei: sid('mei', '+1 555 0177', 'Mei'),
  sam: sid('sam', '+1 555 0161', 'Sam Rivera'),
  priya: sid('priya', '+1 555 0149', 'Priya'),
  theo: sid('theo', '+1 555 0122', 'Theo K'),
  quinn: sid('quinn', '+1 555 0190', 'Quinn'),
  lev: sid('lev', '+1 555 0118', 'Lev'),
};
const wid = (phone: string, displayName: string, contact = true): P.IdentityFact => ({ nativeId: `${phone}@s.whatsapp.net`, handle: `+${phone}`, displayName, contact });
const W = {
  self: wid('15550100', 'zyan', false),
  alice: wid('15550137', 'Alice Chen'),
  nana: wid('442071830042', 'Nana'),
  marco: wid('393471112233', 'Marco'),
  ines: wid('34611222333', 'Inês'),
  hoa: wid('15550188', 'Hoa (garden swap)', false),
};
const wgroup = (k: string) => `120363${BigInt('0x' + h('w' + k).toString('hex').slice(0, 12)).toString().padStart(12, '0').slice(0, 12)}@g.us`;
const mid = (user: string, displayName: string, x: Partial<P.IdentityFact> = {}): P.IdentityFact => ({ nativeId: user, handle: user, displayName, ...x });
const M = {
  self: mid('@zyansheep:matrix.org', 'zyan'),
  alice: mid('@alicechen:matrix.org', 'Alice Chen', { contact: true }),
  kai: mid('@kai:nixos.dev', 'kai', { contact: true }),
  sam: mid('@samr:matrix.org', 'Sam Rivera', { contact: true }),
  lina: mid('@lina:nixos.dev', 'Lina'),
  bort: mid('@bort:matrix.org', 'bort'),
  nixbot: mid('@nixbot:nixos.dev', 'NixOS Bot', { isBot: true }),
  ferrous: mid('@ferrous:matrix.org', 'ferrous'),
  mira: mid('@mira:matrix.org', 'Mira'),
  jules: mid('@jules:matrix.org', 'Jules'),
  noor: mid('@noor:matrix.org', 'Noor'),
  ben: mid('@ben:matrix.org', 'Ben'),
};
const at = (i: P.IdentityFact) => `<@${i.nativeId}>`;

// ------------------------------------------------------------------ pictures

const svg = (w: number, hgt: number, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">${body}</svg>`)}`;
const ART = {
  wall: svg(
    640,
    420,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b3f58"/><stop offset="1" stop-color="#1d2030"/></linearGradient></defs>
     <rect width="640" height="420" fill="url(#g)"/><path d="M0 330 L640 250 L640 420 L0 420Z" fill="#14161f"/>
     ${[[120, 300], [170, 240], [230, 205], [300, 160], [350, 120], [420, 95], [470, 60]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="17" ry="12" fill="#9b6bff"/>`).join('')}
     ${[[90, 120], [520, 300], [560, 140], [260, 330], [400, 260]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="10" fill="#f2c14e"/>`).join('')}
     <text x="24" y="44" font-family="sans-serif" font-size="22" fill="#e8e6ff" font-weight="700">V4 · purple</text>`,
  ),
  garden: svg(
    640,
    420,
    `<rect width="640" height="420" fill="#cfe8b7"/><rect y="300" width="640" height="120" fill="#6b4f35"/>
     ${[80, 200, 320, 440, 560].map((x) => `<path d="M${x} 300 C ${x - 20} 220, ${x + 20} 180, ${x} 110" stroke="#3f7d3a" stroke-width="8" fill="none"/>`).join('')}
     ${[[70, 170], [95, 220], [205, 150], [190, 235], [330, 185], [310, 140], [450, 210], [430, 160], [570, 190], [555, 240]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="17" fill="#e5483b"/>`).join('')}`,
  ),
  route: svg(
    640,
    360,
    `<rect width="640" height="360" fill="#0d1018"/><g stroke="#2a3145" stroke-width="1">${Array.from({ length: 16 }, (_, i) => `<line x1="${i * 40}" y1="0" x2="${i * 40}" y2="360"/>`).join('')}</g>
     <path d="M40 300 Q 160 80 260 220 T 460 120 T 600 70" stroke="#f5f5f5" stroke-width="4" fill="none" stroke-dasharray="10 8"/>
     <rect x="300" y="160" width="60" height="18" fill="#c0392b" transform="rotate(-20 330 169)"/>
     <circle cx="600" cy="70" r="10" fill="#ffd166"/><text x="24" y="36" font-family="monospace" font-size="18" fill="#9fb3ff">white palace · saw skip</text>`,
  ),
  whiteboard: svg(
    640,
    400,
    `<rect width="640" height="400" fill="#fbfaf6"/>
     <g font-family="sans-serif" font-size="17" fill="#1d3557"><rect x="40" y="60" width="150" height="60" rx="8" fill="none" stroke="#1d3557" stroke-width="3"/><text x="62" y="96">adapters</text>
     <rect x="250" y="150" width="140" height="70" rx="8" fill="none" stroke="#e63946" stroke-width="3"/><text x="295" y="191">hub</text>
     <rect x="450" y="60" width="150" height="60" rx="8" fill="none" stroke="#1d3557" stroke-width="3"/><text x="488" y="96">PWA</text>
     <rect x="450" y="260" width="150" height="60" rx="8" fill="none" stroke="#2a9d8f" stroke-width="3"/><text x="488" y="296">triage</text>
     <path d="M190 95 L250 175 M390 175 L450 95 M390 200 L450 285" stroke="#1d3557" stroke-width="3"/></g>`,
  ),
  crab: svg(
    480,
    360,
    `<rect width="480" height="360" fill="#ffe8d6"/><ellipse cx="240" cy="210" rx="120" ry="78" fill="#f74c00"/>
     <circle cx="205" cy="150" r="15" fill="#fff"/><circle cx="275" cy="150" r="15" fill="#fff"/><circle cx="205" cy="152" r="7"/><circle cx="275" cy="152" r="7"/>
     <path d="M120 190 Q 60 140 90 100 M360 190 Q 420 140 390 100" stroke="#f74c00" stroke-width="22" fill="none" stroke-linecap="round"/>`,
  ),
};
const img = (url: string, name: string, w: number, hh: number): P.AttachmentFact => ({ kind: 'image', mime: 'image/svg+xml', name, width: w, height: hh, url });

// ------------------------------------------------------------------ places

const SUPER_COLORS = ['#ff7ad9', '#7c5cff', '#4ad7ff'];

/** A small solid badge, so the demo's custom emoji need nothing from the network. */
const badge = (glyph: string, a: string, b: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="44" font-size="34" text-anchor="middle" font-family="sans-serif" fill="#fff">${glyph}</text></svg>`)}`;

const DEMO_EMOJI: P.CustomEmojiFact[] = [
  { key: 'dither:9001', name: 'dither', url: badge('D', '#7c5cff', '#b79bff') },
  { key: 'shipit:9002', name: 'shipit', url: badge('!', '#ff8c61', '#e86a92') },
  { key: 'lgtm:9003', name: 'lgtm', url: badge('✓', '#2ecc71', '#0dbd8b') },
  { key: 'wat:9004', name: 'wat', url: badge('?', '#f2a541', '#f7d154') },
  { key: 'ferris:9005', name: 'ferris', url: badge('R', '#d9480f', '#f76707') },
  { key: 'borrowck:9006', name: 'borrowck', url: badge('&amp;', '#5c7cfa', '#364fc7') },
];

interface MsgOpts {
  reply?: number;
  react?: Record<string, P.IdentityFact[]>;
  /** Reactions as Discord reports them: totals, super reactions, custom emoji. */
  fancy?: P.ReactionFact[];
  edited?: boolean;
  kind?: P.MessageKind;
  att?: P.AttachmentFact[];
  thread?: string;
  /** A forward, as Discord marks one. */
  fwd?: P.ForwardFact;
}
type Msg = [minutesAgo: number, author: P.IdentityFact, body: string, opts?: MsgOpts];
interface DemoConv {
  acc: AccKey[];
  fact: P.ConversationFact;
  msgs: Msg[];
  unread?: number;
}
interface DemoSpace {
  acc: AccKey[];
  fact: P.SpaceFact;
}

const pos = (n: number) => String(n).padStart(4, '0');
const H = 60;
const DAY = 24 * H;

// Discord: Rust Programming Language (main), libdither (main + alt), Hollow Knight Speedrunning (alt)
const g = {
  rust: snow('g-rust'),
  dither: snow('g-dither'),
  hk: snow('g-hk'),
};
const cat = (k: string) => snow('cat-' + k);
const ch = (k: string) => snow('ch-' + k);

const SPACES: DemoSpace[] = [
  { acc: ['dmain'], fact: { nativeId: g.rust, kind: 'community', name: 'Rust Programming Language', topic: 'The unofficial community server for Rust' } },
  ...(
    [
      ['rust-info', 'Information', 0],
      ['rust-help', 'Help', 1],
      ['rust-chat', 'Discussion', 2],
      ['rust-voice', 'Voice', 3],
    ] as const
  ).map(([k, name, i]): DemoSpace => ({ acc: ['dmain'], fact: { nativeId: cat(k), kind: 'section', name, parents: [{ nativeId: g.rust, position: pos(i) }] } })),
  { acc: ['dmain', 'dalt'], fact: { nativeId: g.dither, kind: 'community', name: 'libdither', topic: 'Dither: a coordinate-routed p2p network' } },
  ...(
    [
      ['dither-general', 'General', 0],
      ['dither-dev', 'Development', 1],
      ['dither-voice', 'Voice', 2],
    ] as const
  ).map(([k, name, i]): DemoSpace => ({ acc: ['dmain', 'dalt'], fact: { nativeId: cat(k), kind: 'section', name, parents: [{ nativeId: g.dither, position: pos(i) }] } })),
  { acc: ['dalt'], fact: { nativeId: g.hk, kind: 'community', name: 'Hollow Knight Speedrunning' } },
  ...(
    [
      ['hk-community', 'Community', 0],
      ['hk-runs', 'Runs', 1],
    ] as const
  ).map(([k, name, i]): DemoSpace => ({ acc: ['dalt'], fact: { nativeId: cat(k), kind: 'section', name, parents: [{ nativeId: g.hk, position: pos(i) }] } })),
  // Matrix: NixOS (with a nested subspace) and Rust Community; "Nix + Rust" sits in both.
  { acc: ['mx'], fact: { nativeId: room('nixos', 'nixos.org'), kind: 'community', name: 'NixOS', topic: 'The NixOS community space' } },
  { acc: ['mx'], fact: { nativeId: room('nix-eco', 'nixos.org'), kind: 'community', name: 'Nix Ecosystems', parents: [{ nativeId: room('nixos', 'nixos.org'), position: pos(9) }] } },
  { acc: ['mx'], fact: { nativeId: room('rust-space', 'matrix.org'), kind: 'community', name: 'Rust Community', topic: 'Rust rooms on Matrix' } },
  // WhatsApp: a community is its parent group; its groups are channels in it.
  { acc: ['wa'], fact: { nativeId: wgroup('nbh'), kind: 'community', name: 'Maple Street', topic: 'Neighbours on Maple Street' } },
];

const dch = (acc: AccKey[], k: string, name: string, section: string, i: number, x: Partial<P.ConversationFact> = {}): P.ConversationFact & { _acc?: AccKey[] } => ({
  nativeId: ch(k),
  shape: 'channel',
  name,
  spaces: [{ nativeId: cat(section), position: pos(i) }],
  ...x,
});
const mroom = (k: string, server: string, name: string, spaces: [string, number][], x: Partial<P.ConversationFact> = {}): P.ConversationFact => ({
  nativeId: room(k, server),
  shape: 'channel',
  name,
  spaces: spaces.map(([s, i]) => ({ nativeId: s, position: pos(i) })),
  ...x,
});
const sdm = (peer: P.IdentityFact): P.ConversationFact => ({ nativeId: `dm:${S.self.nativeId}:${peer.nativeId}`, shape: 'direct', participants: [S.self.nativeId, peer.nativeId], encrypted: true });
const sgroup = (k: string, name: string, members: P.IdentityFact[]): P.ConversationFact => ({
  nativeId: `group:${h('sg' + k).toString('base64').slice(0, 43)}=`,
  shape: 'group',
  name,
  participants: [S.self.nativeId, ...members.map((m) => m.nativeId)],
  encrypted: true,
});

const T = {
  rustHelpAsync: snow('t-rust-async'),
  rustHelpWs: snow('t-rust-ws'),
  ditherBoot: snow('t-dither-boot'),
  nixHelpFlake: `${room('nixos-help', 'nixos.org')}|${event('nix-help-root')}`,
};

const CONVS: DemoConv[] = [
  // ---------------- Discord: DMs and group DMs
  {
    acc: ['dmain'],
    fact: { nativeId: snow('dm-alice'), shape: 'direct', participants: [D.zyan.nativeId, D.alice.nativeId] },
    msgs: [
      [2 * DAY + 90, D.alice, 'did you see the new Celeste mod drop? the one with the dither shader 👀'],
      [2 * DAY + 80, D.zyan, 'no?? link'],
      [2 * DAY + 79, D.alice, 'https://gamebanana.com/mods/celeste-dither'],
      [2 * DAY + 60, D.zyan, 'ok that is gorgeous', { react: { '💜': [D.alice] } }],
      [DAY + 200, D.alice, "also pls stop getting pinged by me on three apps, I'll use signal for real stuff 😅"],
    ],
  },
  {
    acc: ['dmain'],
    fact: { nativeId: snow('dm-ravi-main'), shape: 'direct', participants: [D.zyan.nativeId, D.ravi.nativeId] },
    msgs: [
      [3 * DAY + 30, D.ravi, 'raid saturday? we need a healer'],
      [3 * DAY + 20, D.zyan, 'my healer is on my alt'],
      [3 * DAY + 19, D.ravi, "ah right, I'll ping you there"],
    ],
  },
  {
    acc: ['dalt'],
    fact: { nativeId: snow('dm-ravi-alt'), shape: 'direct', participants: [D.zyn.nativeId, D.ravi.nativeId] },
    msgs: [
      [2 * DAY + 10, D.ravi, 'ok pinging the alt: raid saturday 8pm, you are healing'],
      [2 * DAY + 5, D.zyn, 'ok ok'],
      [62, D.ravi, "we're short one dps, can you bring a friend?"],
    ],
    unread: 1,
  },
  {
    acc: ['dalt'],
    fact: { nativeId: snow('dm-jordan'), shape: 'direct', participants: [D.zyn.nativeId, D.jordan.nativeId] },
    msgs: [
      [4 * DAY, D.jordan, 'watched your pantheon run, the radiance fight was clean'],
      [4 * DAY - 10, D.zyn, 'thanks!! still losing time in the pogo section'],
      [6 * H, D.jordan, 'try the route in #routes, saves like 2s'],
    ],
    unread: 1,
  },
  {
    acc: ['dmain'],
    fact: { nativeId: snow('gdm-raid'), shape: 'group', name: 'weekend raid', participants: [D.zyan.nativeId, D.ravi.nativeId, D.theo.nativeId] },
    msgs: [
      [2 * DAY + 40, D.ravi, "ok who's in for saturday"],
      [2 * DAY + 38, D.theo, 'me'],
      [2 * DAY + 30, D.zyan, 'me (on the alt lol)'],
      [31, D.theo, 'can we push it to 9? dinner thing'],
    ],
    unread: 1,
  },

  // ---------------- Discord: Rust Programming Language
  { acc: ['dmain'], fact: dch(['dmain'], 'rust-rules', 'rules', 'rust-info', 0, { variant: 'rules' }), msgs: [[30 * DAY, D.ferris, 'Be kind. Read the [code of conduct](https://www.rust-lang.org/policies/code-of-conduct) before posting.']] },
  {
    acc: ['dmain'],
    fact: dch(['dmain'], 'rust-ann', 'announcements', 'rust-info', 1, { variant: 'announcement' }),
    msgs: [[5 * DAY, D.mara, '**New stable release is out!** Async closures in traits got a big ergonomics pass. Release notes: https://blog.rust-lang.org/', { react: { '🎉': [D.owl, D.tim, D.bea, D.hannah] } }]],
  },
  {
    acc: ['dmain'],
    fact: dch(['dmain'], 'rust-beginners', 'beginners', 'rust-help', 0, { topic: 'No question is too small' }),
    msgs: [
      [3 * H + 10, D.tim, 'why does `let x: Vec<u8> = vec![]; x.push(1);` fail?'],
      [3 * H + 8, D.hannah, '`x` is not `mut`. try `let mut x`', { reply: 0 }],
      [3 * H + 5, D.tim, 'oh. thank you 🙏'],
      [2 * H + 20, D.bea, 'anyone know a good resource for lifetimes that is not the book?'],
      [2 * H + 10, D.owl, '"Common Rust Lifetime Misconceptions" by pretzelhammer is the classic', { reply: 3 }],
      [H + 15, D.mara, 'also the rustonomicon chapter on subtyping'],
      [26, D.tim, 'is this the idiomatic way?\n```rust\nfn longest<\'a>(a: &\'a str, b: &\'a str) -> &\'a str {\n    if a.len() > b.len() { a } else { b }\n}\n```'],
      [21, D.hannah, "yep, that's straight from the book 👍", { reply: 6 }],
    ],
    unread: 5,
  },
  { acc: ['dmain'], fact: dch(['dmain'], 'rust-help', 'help', 'rust-help', 1, { variant: 'forum', topic: 'One post per question' }), msgs: [] },
  {
    acc: ['dmain'],
    fact: { nativeId: T.rustHelpAsync, shape: 'thread', name: 'Lifetime error with async closures', parentConversation: ch('rust-help') },
    msgs: [
      [7 * H, D.owl, 'I get `lifetime may not live long enough` when I capture `&self` in an async closure passed to `tokio::spawn`. Minimal repro: https://play.rust-lang.org/?gist=1a2b3c'],
      [6 * H, D.hannah, '`tokio::spawn` needs `\'static`. Clone what you need into the closure, or use `Arc<Self>`.'],
      [5 * H, D.owl, 'Arc worked, thanks!', { react: { '✅': [D.hannah] } }],
    ],
  },
  {
    acc: ['dmain'],
    fact: { nativeId: T.rustHelpWs, shape: 'thread', name: 'Workspace layout for a CLI + lib?', parentConversation: ch('rust-help') },
    msgs: [
      [DAY + 300, D.bea, 'How do people lay out a workspace with a library, a CLI, and some shared test fixtures?'],
      [DAY + 250, D.zyan, 'I do `crates/core`, `crates/cli`, and a virtual manifest at the root. Fixtures go in `crates/core/tests/fixtures`.'],
      [40, D.bea, `${at(D.zyan)} that's clean, do you share one target dir across them?`, { reply: 1 }],
    ],
    unread: 1,
  },
  {
    acc: ['dmain'],
    fact: dch(['dmain'], 'rust-offtopic', 'off-topic', 'rust-chat', 0),
    msgs: [
      [DAY + 100, D.owl, 'my ferris plushie arrived', {
          att: [img(ART.crab, 'ferris.png', 480, 360)],
          react: { '🦀': [D.tim, D.mara, D.bea] },
          fancy: [
            { key: DEMO_EMOJI[4].key, style: 'super', count: 6, authors: [D.tim.nativeId], colors: SUPER_COLORS, emoji: DEMO_EMOJI[4] },
            { key: '🎉', style: 'super', count: 2, authors: [D.mara.nativeId], colors: ['#ffd166', '#ef476f'] },
            { key: DEMO_EMOJI[0].key, count: 41, authors: [D.bea.nativeId], emoji: DEMO_EMOJI[0] },
            { key: '❤️', count: 128, authors: [] },
          ],
        }],
      [DAY + 95, D.tim, 'rewrite the plushie in rust'],
      [DAY + 90, D.mara, 'it is already memory safe, it has no pointers'],
      [3 * H, D.bea, 'hot take: `unwrap()` in examples is fine'],
      [2 * H + 50, D.hannah, 'hot take: hot takes in #off-topic are fine'],
    ],
    unread: 2,
  },
  {
    acc: ['dmain'],
    fact: dch(['dmain'], 'rust-showcase', 'showcase', 'rust-chat', 1),
    msgs: [
      [2 * DAY, D.owl, 'made a tiny TUI for ntfy notifications: https://github.com/example/ntfy-tui'],
      [DAY + 400, D.mara, 'this is great, starring it'],
    ],
  },
  { acc: ['dmain'], fact: dch(['dmain'], 'rust-voice-general', 'General', 'rust-voice', 0, { variant: 'voice' }), msgs: [] },

  // ---------------- Discord: libdither (both accounts are members)
  {
    acc: ['dmain', 'dalt'],
    fact: dch(['dmain', 'dalt'], 'dither-general', 'general', 'dither-general', 0),
    msgs: [
      [2 * DAY + 100, D.lev, 'welcome to the new folks from the HN thread 👋'],
      [2 * DAY + 95, D.quinn, 'pinned the getting-started doc'],
      [DAY + 500, D.pixelfox, 'pixelfox joined the server.', { kind: 'system' }],
      [DAY + 490, D.pixelfox, 'is dither like libp2p?'],
      [DAY + 470, D.zyan, 'similar goals, but routing is coordinate-based instead of a Kademlia DHT. see #routing-research', { reply: 3 }],
      [DAY + 460, D.pixelfox, 'oh neat, reading now', { react: { '👍': [D.zyan] } }],
    ],
  },
  {
    acc: ['dmain', 'dalt'],
    fact: dch(['dmain', 'dalt'], 'dither-ann', 'announcements', 'dither-general', 1, { variant: 'announcement' }),
    msgs: [[6 * DAY, D.quinn, '**dither-sim v0.4** is out: 10k-node simulations in the browser. https://github.com/libdither/dither-sim', { react: { '🚀': [D.lev, D.pixelfox, D.zyan] } }]],
  },
  {
    acc: ['dmain', 'dalt'],
    fact: dch(['dmain', 'dalt'], 'dither-dev', 'dev', 'dither-dev', 0, { topic: 'Development of libdither and friends' }),
    msgs: [
      [DAY + 120, D.lev, 'CI is red on main, the hashdb bump broke a doctest'],
      [DAY + 118, D.ci, '❌ `main` · build #482 failed · `hashdb`: doctest `insert_get`'],
      [DAY + 40, D.lev, 'fixed in #211'],
      [DAY + 35, D.lev, '**dither-sim v0.4** is out: 10k-node simulations in the browser. https://github.com/libdither/dither-sim', { fwd: { conversation: ch('dither-ann'), message: `${ch('dither-ann')}~0`, space: g.dither } }],
      [DAY + 30, D.ci, '✅ `main` · build #483 passed'],
      [3 * H, D.quinn, 'starting a thread for the bootstrap refactor', { thread: T.ditherBoot }],
      [58, D.quinn, `${at(D.zyan)} can you review the bootstrap PR before Friday? it touches the handshake`],
    ],
    unread: 2,
  },
  {
    acc: ['dmain', 'dalt'],
    fact: { nativeId: T.ditherBoot, shape: 'thread', name: 'DHT bootstrap refactor', parentConversation: ch('dither-dev') },
    msgs: [
      [3 * H - 1, D.quinn, "plan: drop the static seed list and bootstrap from any peer's coordinate table"],
      [2 * H + 30, D.lev, 'what about a cold start with zero peers?'],
      [2 * H + 10, D.quinn, 'fall back to DNS seeds, but only then', { reply: 1 }],
    ],
    unread: 3,
  },
  {
    acc: ['dmain', 'dalt'],
    fact: dch(['dmain', 'dalt'], 'dither-routing', 'routing-research', 'dither-dev', 1),
    msgs: [
      [4 * DAY, D.zyan, 'notes on greedy embedding into hyperbolic space: https://github.com/zyansheep/routing-research'],
      [4 * DAY - 30, D.lev, 'the stretch numbers look great'],
      [DAY + 60, D.pixelfox, 'read the notes. how do you handle churn?'],
    ],
    unread: 1,
  },
  { acc: ['dmain', 'dalt'], fact: dch(['dmain', 'dalt'], 'dither-hangout', 'hangout', 'dither-voice', 0, { variant: 'voice' }), msgs: [] },

  // ---------------- Discord: Hollow Knight Speedrunning (alt only)
  {
    acc: ['dalt'],
    fact: dch(['dalt'], 'hk-general', 'general', 'hk-community', 0, { mute: { level: 'none' } }),
    msgs: [
      [5 * H, D.gorb, 'anyone doing pantheon races this weekend?'],
      [5 * H - 5, D.pat, 'maybe sunday'],
      [4 * H, D.shade, 'new patch broke the dash buffer again'],
      [4 * H - 2, D.gorb, 'nooo'],
      [3 * H, D.jordan, 'rolled back to 1.4.3.2, works fine'],
      [2 * H, D.pat, 'sunday 6pm UTC then?'],
    ],
    unread: 6,
  },
  {
    acc: ['dalt'],
    fact: dch(['dalt'], 'hk-routes', 'routes', 'hk-community', 1),
    msgs: [
      [DAY + 30, D.shade, 'new pogo route for white palace: skip the second saw', { att: [img(ART.route, 'route.png', 640, 360)] }],
      [6 * H, D.gorb, 'confirmed, saves about 2s'],
      [2 * H + 5, D.pat, `${at(D.zyn)} you were asking about this one, right?`, { reply: 0 }],
    ],
    unread: 2,
  },
  {
    acc: ['dalt'],
    fact: dch(['dalt'], 'hk-pb', 'pb-showcase', 'hk-runs', 0),
    msgs: [[2 * DAY, D.jordan, 'new PB! **42:17** any%', { react: { '🎉': [D.gorb, D.pat, D.zyn] } }]],
  },

  // ---------------- Signal
  {
    acc: ['sig'],
    fact: sdm(S.alice),
    msgs: [
      [26 * H, S.alice, 'are we still on for bouldering thursday?'],
      [26 * H - 4, S.self, 'yes! 7pm at Mesa?'],
      [25 * H, S.alice, "perfect. I'll bring the spare chalk bag"],
      [41, S.alice, "hey, can you grab my belay device from Theo's? I left it in his car"],
      [38, S.alice, 'no rush, just before thursday'],
    ],
    unread: 2,
  },
  {
    acc: ['sig'],
    fact: sdm(S.mom),
    msgs: [
      [3 * DAY, S.mom, 'Did you get the package?'],
      [3 * DAY - 30, S.self, 'yes! thank you ❤️'],
      [5 * H + 5, S.mom, 'Are you coming for dinner Sunday? Dad is making dumplings 🥟'],
      [5 * H, S.mom, "Bring a jacket, it's supposed to rain"],
    ],
    unread: 2,
  },
  {
    acc: ['sig'],
    fact: sdm(S.sam),
    msgs: [
      [DAY + 60, S.sam, 'lmk when the matrix bridge thing is ready, I want to try it'],
      [DAY + 50, S.self, 'soon™. doing a hub + PWA instead of bridges'],
      [DAY + 49, S.sam, 'ooh fancy'],
    ],
  },
  { acc: ['sig'], fact: sdm(S.theo), msgs: [[3 * H, S.theo, 'found a belay device in my car, yours?']], unread: 1 },
  {
    acc: ['sig'],
    fact: { nativeId: `dm:${S.self.nativeId}:${S.self.nativeId}`, shape: 'self', name: 'Note to Self', participants: [S.self.nativeId], encrypted: true },
    msgs: [
      [4 * DAY, S.self, 'idea: triage feedback button → few-shot examples for the local model'],
      [2 * DAY, S.self, 'ntfy topic for dither-chat: keep it tailnet-only'],
      [DAY, S.self, 'whiteboard from today', { att: [img(ART.whiteboard, 'whiteboard.png', 640, 400)] }],
    ],
  },
  {
    acc: ['sig'],
    fact: sgroup('climb', 'Climbing crew 🧗', [S.alice, S.sam, S.priya, S.theo]),
    msgs: [
      [2 * DAY + 30, S.priya, 'new set at Mesa is up! the purple V4 is evil'],
      [2 * DAY + 20, S.sam, 'I flashed it 😤', { react: { '🔥': [S.alice, S.theo] } }],
      [2 * DAY + 19, S.priya, 'liar', { reply: 1 }],
      [DAY + 80, S.theo, 'carpool thursday? I can fit 3'],
      [DAY + 70, S.alice, 'me + zyan'],
      [DAY + 60, S.self, '👍'],
      [50, S.priya, "anyone have a spare harness? mine's being retired"],
      [45, S.sam, 'I have one, three sizes too big though'],
      [20, S.priya, 'ok here is the purple V4, look at this heel hook', { att: [img(ART.wall, 'v4.jpg', 640, 420)] }],
    ],
    unread: 3,
  },
  {
    acc: ['sig'],
    fact: sgroup('family', 'Family', [S.mom, S.dad, S.mei]),
    msgs: [
      [DAY + 200, S.dad, 'photos from the garden', { att: [img(ART.garden, 'garden.jpg', 640, 420)] }],
      [DAY + 190, S.mei, 'the tomatoes!! 🍅'],
      [DAY + 185, S.mom, 'Your father is very proud of them', { react: { '😂': [S.mei, S.self] } }],
      [2 * H, S.mei, "who's bringing dessert sunday"],
    ],
    unread: 1,
  },
  {
    acc: ['sig'],
    fact: sgroup('dithercore', 'dither core', [S.quinn, S.lev]),
    msgs: [
      [3 * DAY, S.quinn, "keeping this group for anything we don't want in the public discord"],
      [DAY + 100, S.lev, 'a security report came in for the handshake code, forwarding it here'],
      [DAY + 90, S.self, 'on it tomorrow'],
      [4 * H, S.quinn, "reminder: we said we'd pick the transport crate this week. zyan, your call?"],
    ],
    unread: 1,
  },

  // ---------------- WhatsApp: DMs, a group, and a community with its announcements channel
  {
    acc: ['wa'],
    fact: { nativeId: W.nana.nativeId, shape: 'direct', participants: [W.self.nativeId, W.nana.nativeId], encrypted: true },
    msgs: [
      [2 * DAY, W.nana, 'Did you eat today? 🍲'],
      [2 * DAY - 30, W.self, 'yes nana, promise'],
      [3 * H, W.nana, 'Here is the recipe you asked for', { att: [img(ART.garden, 'recipe.jpg', 640, 420)] }],
      [3 * H - 1, W.nana, 'Call me on Sunday ❤️'],
    ],
    unread: 2,
  },
  {
    acc: ['wa'],
    fact: { nativeId: W.marco.nativeId, shape: 'direct', participants: [W.self.nativeId, W.marco.nativeId], encrypted: true },
    msgs: [
      [DAY + 40, W.marco, 'ciao! still up for the trip in march?'],
      [DAY + 35, W.self, '*yes*, booking the train this week'],
      [DAY + 30, W.marco, '🔥', { react: { '👍': [W.self] } }],
    ],
  },
  {
    acc: ['wa'],
    fact: { nativeId: W.alice.nativeId, shape: 'direct', participants: [W.self.nativeId, W.alice.nativeId], encrypted: true },
    msgs: [[6 * H, W.alice, 'sent you the bouldering video on whatsapp, signal kept compressing it']],
    unread: 1,
  },
  {
    acc: ['wa'],
    fact: { nativeId: wgroup('books'), shape: 'group', name: 'Book club 📚', participants: [W.self.nativeId, W.ines.nativeId, W.marco.nativeId, W.alice.nativeId], encrypted: true },
    msgs: [
      [3 * DAY, W.ines, 'next pick: The Dispossessed?'],
      [3 * DAY - 10, W.marco, 'yes!!', { react: { '❤️': [W.ines, W.alice] } }],
      [40, W.ines, 'reminder we meet thursday, chapters 1-5'],
    ],
    unread: 1,
  },
  {
    acc: ['wa'],
    fact: { nativeId: wgroup('nbh-ann'), shape: 'channel', variant: 'announcement', name: 'Maple Street neighbours', spaces: [{ nativeId: wgroup('nbh'), position: '0' }], encrypted: true },
    msgs: [[DAY + 300, W.hoa, 'Street party moved to Saturday the 14th because of the rain forecast.']],
  },
  {
    acc: ['wa'],
    fact: { nativeId: wgroup('nbh-swap'), shape: 'channel', name: 'Garden swap', spaces: [{ nativeId: wgroup('nbh'), position: '1' }], participants: [W.self.nativeId, W.hoa.nativeId, W.nana.nativeId], encrypted: true },
    msgs: [
      [DAY + 100, W.hoa, 'Anyone want rhubarb? I have way too much'],
      [DAY + 90, W.self, 'me! can pick up tomorrow'],
      [2 * H, W.hoa, 'Left it by the gate 🌿', { reply: 1 }],
    ],
    unread: 1,
  },

  // ---------------- Matrix
  {
    acc: ['mx'],
    fact: { nativeId: room('dm-alice', 'matrix.org'), shape: 'direct', participants: [M.self.nativeId, M.alice.nativeId], encrypted: true },
    msgs: [
      [3 * DAY + 100, M.alice, 'sending you the paper on CRDT-based chat sync I mentioned'],
      [3 * DAY + 99, M.alice, 'local-first-chat-sync.pdf', { kind: 'media', att: [{ kind: 'file', mime: 'application/pdf', name: 'local-first-chat-sync.pdf', size: 2_400_000, url: 'data:application/pdf;base64,' }] }],
      [3 * DAY + 60, M.self, 'thanks! reading it tonight'],
    ],
  },
  {
    acc: ['mx'],
    fact: { nativeId: room('dm-kai', 'nixos.dev'), shape: 'direct', participants: [M.self.nativeId, M.kai.nativeId], encrypted: true },
    msgs: [
      [DAY + 30, M.kai, 'your nix-env repo — mind if I steal the zsh module?'],
      [DAY + 20, M.self, 'go for it'],
      [4 * H, M.kai, 'did you ever get nix-ld working with the playwright chromium?'],
    ],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: { nativeId: room('dm-sam', 'matrix.org'), shape: 'direct', participants: [M.self.nativeId, M.sam.nativeId], encrypted: true },
    msgs: [[6 * DAY, M.sam, 'room for the hackathon is up: #hackweek:matrix.org']],
  },
  {
    acc: ['mx'],
    fact: { nativeId: room('house', 'matrix.org'), shape: 'group', name: 'Housemates', participants: [M.self.nativeId, M.jules.nativeId, M.noor.nativeId, M.ben.nativeId], encrypted: true },
    msgs: [
      [2 * DAY, M.jules, 'rent split for november is in the sheet'],
      [DAY + 300, M.noor, 'who left the oven on 😭'],
      [DAY + 290, M.ben, 'guilty', { react: { '😂': [M.noor, M.jules] } }],
      [DAY + 100, M.noor, '', { kind: 'encrypted' }],
      [3 * H, M.jules, 'internet guy is coming tomorrow 9-12, can someone be home?'],
    ],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: mroom('libdither-mx', 'matrix.org', 'libdither', [], { topic: 'Matrix home of the Dither project · also on Discord' }),
    msgs: [
      [2 * DAY + 40, M.mira, "is there a matrix bridge for the discord? I'd rather not join discord"],
      [2 * DAY + 20, M.self, 'working on something better than a bridge 👀'],
      [70, M.mira, 'ok now I have to ask, what is dither-chat? saw it in the commit log'],
    ],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: mroom('nixos-main', 'nixos.org', 'NixOS', [[room('nixos', 'nixos.org'), 0]], { topic: 'General NixOS discussion' }),
    msgs: [
      [6 * H, M.lina, '26.11 branch-off is next week, get your PRs in'],
      [5 * H, M.bort, 'is the systemd 260 bump going in?'],
      [5 * H - 10, M.lina, 'already merged to staging'],
      [3 * H, M.kai, 'unstable channel advanced 🎉'],
      [2 * H + 30, M.bort, 'finally'],
    ],
    unread: 3,
  },
  {
    acc: ['mx'],
    fact: mroom('nixos-help', 'nixos.org', 'NixOS Help', [[room('nixos', 'nixos.org'), 1]], { topic: 'Ask anything. Paste errors in full.' }),
    msgs: [
      [2 * H, M.bort, 'my flake.lock keeps changing in CI, any idea why?', { thread: T.nixHelpFlake }],
      [80, M.lina, 'answered in the thread'],
    ],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: { nativeId: T.nixHelpFlake, shape: 'thread', name: 'my flake.lock keeps changing in CI', parentConversation: room('nixos-help', 'nixos.org') },
    msgs: [
      [100, M.lina, 'is it the nixpkgs input? pin it with a rev'],
      [52, M.bort, 'that was it, thanks!'],
      [30, M.kai, 'also run `nix flake lock --no-update-lock-file` in CI so it fails loudly'],
    ],
    unread: 3,
  },
  {
    acc: ['mx'],
    fact: mroom('nix-dev', 'nixos.org', 'Nix Development', [[room('nixos', 'nixos.org'), 2]]),
    msgs: [[DAY, M.kai, 'lazy trees landed in nightly. eval of nixpkgs is ~3x faster here']],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: mroom('nixos-ann', 'nixos.org', 'NixOS Announcements', [[room('nixos', 'nixos.org'), 3]], { variant: 'announcement' }),
    msgs: [[5 * DAY, M.nixbot, 'NixOS 26.11 branch-off is scheduled for **2026-11-04**.']],
  },
  {
    acc: ['mx'],
    fact: mroom('nix-rust', 'nixos.org', 'Nix + Rust', [
      [room('nix-eco', 'nixos.org'), 0],
      [room('rust-space', 'matrix.org'), 2],
    ]),
    msgs: [
      [DAY + 60, M.ferrous, 'crane or naersk in 2026?'],
      [DAY + 55, M.kai, 'crane, no contest'],
      [DAY - 200, M.self, '+1 crane, I use it for libdither'],
      [2 * H, M.ferrous, `${at(M.self)} do you cache the deps derivation in CI?`, { reply: 2 }],
    ],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: mroom('nix-python', 'nixos.org', 'Nix + Python', [[room('nix-eco', 'nixos.org'), 1]]),
    msgs: [
      [3 * DAY, M.bort, 'uv2nix or poetry2nix?'],
      [3 * DAY - 20, M.lina, 'uv2nix these days'],
    ],
  },
  {
    acc: ['mx'],
    fact: mroom('rust-mx', 'matrix.org', 'Rust', [[room('rust-space', 'matrix.org'), 0]]),
    msgs: [
      [8 * H, M.mira, 'anyone going to RustConf next year?'],
      [7 * H, M.ferrous, 'if the talk gets accepted 🤞'],
      [5 * H, M.mira, 'good luck!'],
    ],
    unread: 2,
  },
  {
    acc: ['mx'],
    fact: mroom('rust-async-mx', 'matrix.org', 'Rust Async', [[room('rust-space', 'matrix.org'), 1]]),
    msgs: [
      [2 * DAY, M.ferrous, 'is there a consensus on structured concurrency crates yet?'],
      [2 * DAY - 40, M.mira, 'not really, but task scopes are getting close'],
    ],
  },
];

// ------------------------------------------------------------------ live behaviour

/** Background chatter so the review instance stays alive. One line every ~1.5-3 minutes. */
const CHATTER: [AccKey, string, P.IdentityFact, string][] = [
  ['dmain', ch('rust-beginners'), D.tim, 'does `cargo fmt` pick up a rustfmt.toml in a workspace subdir?'],
  ['dalt', ch('hk-general'), D.gorb, 'pantheon 5 races sunday, sign up in the sheet'],
  ['mx', room('nixos-main', 'nixos.org'), M.lina, 'reminder: 26.11 branch-off is next week'],
  ['sig', sgroup('climb', '', []).nativeId, S.theo, 'thursday 7pm still good for everyone?'],
  ['dmain', ch('dither-dev'), D.ci, '✅ `main` · build #484 passed'],
  ['mx', room('rust-mx', 'matrix.org'), M.mira, 'the new borrow checker diagnostics are so much better'],
  ['dmain', ch('dither-general'), D.pixelfox, `${at(D.zyan)} the routing notes were super helpful, thanks!`],
  ['mx', room('house', 'matrix.org'), M.ben, "I'll be home tomorrow morning for the internet guy"],
  ['dmain', ch('rust-offtopic'), D.owl, 'what is everyone listening to while coding'],
  ['sig', sgroup('family', '', []).nativeId, S.mom, 'Mei is bringing dessert! 🍰'],
  ['wa', wgroup('books'), W.ines, 'I am only on chapter 3, no spoilers 🙈'],
  ['dalt', ch('hk-routes'), D.shade, 'found an even faster skip, video soon'],
  ['mx', room('nix-dev', 'nixos.org'), M.kai, 'anyone benchmarked the new evaluator on darwin?'],
];

const REPLIES: Record<string, string[]> = {
  [S.alice.nativeId]: ['haha ok', 'sounds good!', 'omw', '👍', 'you are the best'],
  [D.alice.nativeId]: ['lol', 'ok ok', 'sending it on signal'],
  [M.alice.nativeId]: ['let me know what you think of section 3'],
  [S.mom.nativeId]: ['Ok sweetie', 'Love you! See you Sunday', '❤️'],
  [W.nana.nativeId]: ['❤️', 'Good. Eat vegetables too'],
  [S.theo.nativeId]: ["I'll leave it at the gym desk"],
  [D.ravi.nativeId]: ['bet', 'ok see you at 8', 'healer secured'],
  [D.jordan.nativeId]: ['gl on the run!', 'lmk your time'],
  [M.kai.nativeId]: ['nice, I owe you one', 'ahh that makes sense'],
};

// ------------------------------------------------------------------ about and settings (docs/group-settings.md)

/**
 * Where each demo account stands, so the panel can show both sides: an owner who may change everything, a member
 * who may change nothing and is told why, and the networks' own in-between rules.
 */
const ADMIN_IN: Record<AccKey, string[]> = {
  dmain: [g.dither, ...['dither-general', 'dither-ann', 'dither-dev', 'dither-routing', 'dither-hangout'].map(ch), T.ditherBoot],
  dalt: [],
  sig: [sgroup('climb', '', []).nativeId, sgroup('dithercore', '', []).nativeId],
  mx: [room('house', 'matrix.org')],
  wa: [wgroup('books')],
};
/** Matrix: your power level where it is not 100 or 0. */
const MX_LEVEL: Record<string, number> = { [room('libdither-mx', 'matrix.org')]: 50 };
/** Settings that differ from each network's defaults. */
const DEMO_VALUES: Record<string, Partial<P.AboutValues>> = {
  [ch('dither-dev')]: { slowMode: 0 },
  [ch('rust-offtopic')]: { slowMode: 10 },
  [ch('hk-general')]: { slowMode: 5 },
  [sgroup('climb', '', []).nativeId]: { disappearing: 7 * 86_400, editInfo: 'everyone' },
  [sgroup('family', '', []).nativeId]: { editInfo: 'admins', addMembers: 'admins' },
  [sgroup('dithercore', '', []).nativeId]: { editInfo: 'admins', addMembers: 'admins', disappearing: 28 * 86_400 },
  [wgroup('books')]: { disappearing: 7 * 86_400 },
  [wgroup('nbh-swap')]: { editInfo: 'everyone' },
  [wgroup('nbh-ann')]: { announceOnly: true, editInfo: 'admins' },
  [room('nixos-main', 'nixos.org')]: { joinRule: 'open', history: 'world_readable' },
  [room('nixos-help', 'nixos.org')]: { joinRule: 'open', history: 'world_readable' },
  [room('libdither-mx', 'matrix.org')]: { joinRule: 'ask', history: 'shared' },
};
const DEMO_PINS: Record<string, string[]> = {
  [ch('dither-general')]: [`${ch('dither-general')}~1`],
  [ch('rust-beginners')]: [`${ch('rust-beginners')}~4`, `${ch('rust-beginners')}~1`],
  [room('house', 'matrix.org')]: [],
};
const DISCORD_ROLES: Record<string, P.AboutRole[]> = {
  [g.dither]: [
    { id: snow('role-maint'), name: 'Maintainer', color: '#F2A541', rank: 100 },
    { id: snow('role-contrib'), name: 'Contributor', color: '#7FD1AE', rank: 50 },
    { id: g.dither, name: '@everyone', rank: 0 },
  ],
  [g.rust]: [
    { id: snow('role-mod'), name: 'Moderator', color: '#E86A92', rank: 100 },
    { id: snow('role-helper'), name: 'Helper', color: '#5C7CFA', rank: 50 },
    { id: g.rust, name: '@everyone', rank: 0 },
  ],
  [g.hk]: [{ id: g.hk, name: '@everyone', rank: 0 }],
};
const DISCORD_STAFF: Record<string, string> = {
  [D.zyan.nativeId]: 'role-maint',
  [D.quinn.nativeId]: 'role-maint',
  [D.lev.nativeId]: 'role-contrib',
  [D.mara.nativeId]: 'role-mod',
  [D.hannah.nativeId]: 'role-helper',
};

/** A demo place's settings, changed in memory by `configure` until the hub restarts. */
interface DemoPlace {
  values: Partial<P.AboutValues>;
  pinned: string[];
  invite: string | null;
}
const demoPlaces = new Map<string, DemoPlace>();

const lc = (s: string) => s[0].toUpperCase() + s.slice(1);
const NETWORK_META_NAME: Record<P.Network, string> = Object.fromEntries(Object.entries(NETWORK_META).map(([k, m]) => [k, m.name])) as Record<P.Network, string>;

const running = new Map<AccKey, DemoAdapter>();
let chatterTimer: Timer | undefined;
let chatterIdx = 0;

function scheduleChatter() {
  if (chatterTimer) return;
  const tick = () => {
    const line = CHATTER[chatterIdx++ % CHATTER.length];
    running.get(line[0])?.typeThenSay(line[1], line[2], line[3]);
    chatterTimer = setTimeout(tick, 90_000 + Math.random() * 90_000);
  };
  chatterTimer = setTimeout(tick, 45_000);
}

// ------------------------------------------------------------------ profiles (docs/profile.md)

type GuildKey = keyof typeof g;
const DISCORD_PROFILES: Record<string, { bio?: string; pronouns?: string; status?: { text?: string; emoji?: string }; accent?: string; servers?: GuildKey[]; nick?: Partial<Record<GuildKey, string>>; roles?: Partial<Record<GuildKey, { name: string; color?: string }[]>>; friends?: string[]; links?: P.PersonAbout['links'] }> = {
  alice: {
    bio: 'climbing, film photography, and too many browser tabs.\nbelay partner wanted on weekends 🧗',
    pronouns: 'she/her',
    status: { text: 'at the crag', emoji: '🧗' },
    accent: '#C0504D',
    servers: ['dither', 'hk'],
    nick: { dither: 'alice (testing)' },
    roles: { dither: [{ name: 'Testers', color: '#3BA55C' }] },
    friends: ['ravi', 'jordan', 'theo'],
    links: [{ label: 'GitHub', value: 'alicechen', url: 'https://github.com/alicechen', verified: true }],
  },
  quinn: {
    bio: 'networking nerd. working on the handshake in libdither.',
    pronouns: 'they/them',
    accent: '#2F7D95',
    servers: ['dither', 'rust'],
    roles: { dither: [{ name: 'Core', color: '#E67E22' }, { name: 'Reviewers', color: '#9B59B6' }], rust: [{ name: 'Helper', color: '#1ABC9C' }] },
    friends: ['alice', 'theo'],
    links: [{ label: 'GitHub', value: 'quinn-dev', url: 'https://github.com/quinn-dev', verified: true }, { label: 'Website', value: 'quinn.example', url: 'https://quinn.example' }],
  },
  ravi: { bio: 'raid leader on tuesdays', accent: '#4B6CB7', servers: ['hk'], friends: ['alice'], status: { text: 'grinding', emoji: '⚔️' } },
  jordan: { pronouns: 'he/him', servers: ['hk'], friends: ['alice'] },
  theo: { bio: 'has your belay device', servers: ['dither'], friends: ['alice', 'quinn'] },
  lev: { bio: 'p2p, routing, coffee', servers: ['dither', 'rust'], roles: { dither: [{ name: 'Maintainer', color: '#E91E63' }] } },
};
const SIGNAL_ABOUT: Record<string, { text: string; emoji: string }> = {
  alice: { text: 'on the wall, back at 8', emoji: '🧗' },
  mom: { text: 'Call me!', emoji: '☎️' },
  sam: { text: 'Busy, text me', emoji: '📵' },
};
/** Bios the demo's own accounts set (setProfile), by `${network}:${native id}`, over the ones above. */
const OWN_BIO = new Map<string, string>();
const WHATSAPP_ABOUT: Record<string, string> = {
  alice: 'Available',
  nana: 'Grandchildren are the best ❤️',
  marco: 'Ciao!',
};

class DemoAdapter implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private timers = new Set<Timer>();
  private typingLog: { conversation: string; stop: boolean; at: number }[] = [];
  private self: P.IdentityFact;
  private network: P.Network;

  constructor(
    private key: AccKey,
    private acc: AccountRow,
    private dir: string,
  ) {
    this.network = acc.network;
    this.self = key === 'dmain' ? D.zyan : key === 'dalt' ? D.zyn : key === 'sig' ? S.self : key === 'wa' ? W.self : M.self;
  }

  /** The demo plays a Nitro account on Discord, and a room image pack on Matrix, so every path can be tried. */
  private reactionContext(): P.ReactionContext {
    if (this.network === 'discord') {
      return {
        canReact: true,
        custom: [
          { id: 'demo-here', name: 'This server', emoji: DEMO_EMOJI.slice(0, 4) },
          { id: 'demo-other', name: 'Rust Programming Language', emoji: DEMO_EMOJI.slice(4) },
        ],
        super: { available: true },
      };
    }
    if (this.network === 'matrix') return { canReact: true, custom: [{ id: 'demo-pack', name: 'Housemates pack', emoji: DEMO_EMOJI.slice(0, 3).map((e) => ({ ...e, key: `mxc://demo/${e.name}` })) }] };
    return { canReact: true, custom: [] };
  }

  private findConv(nativeId: string): DemoConv | undefined {
    return CONVS.find((c) => c.fact.nativeId === nativeId && c.acc.includes(this.key));
  }

  private findSpace(nativeId: string): DemoSpace | undefined {
    return SPACES.find((x) => x.fact.nativeId === nativeId && x.acc.includes(this.key));
  }

  /** The Discord server a channel is in, through its category. */
  private guildOf(c: DemoConv): string | null {
    const parent = c.fact.parentConversation ? this.findConv(c.fact.parentConversation) : null;
    const sec = (parent ?? c).fact.spaces?.[0]?.nativeId;
    const space = sec ? SPACES.find((x) => x.fact.nativeId === sec) : null;
    return space?.fact.kind === 'section' ? (space.fact.parents?.[0]?.nativeId ?? null) : (space?.fact.nativeId ?? null);
  }

  private place(target: P.AboutTarget): { place: DemoPlace; conv?: DemoConv; space?: DemoSpace } {
    const conv = target.kind === 'conversation' ? this.findConv(target.nativeId) : undefined;
    const space = target.kind === 'space' ? this.findSpace(target.nativeId) : undefined;
    if (!conv && !space) throw new Error(`this demo account is not in that ${target.kind}`);
    let place = demoPlaces.get(target.nativeId);
    if (!place) {
      const f = conv?.fact ?? space!.fact;
      const base: Partial<P.AboutValues> = { name: f.name ?? '', topic: f.topic ?? '' };
      if (this.network === 'signal' || this.network === 'whatsapp') Object.assign(base, { disappearing: 0, announceOnly: conv?.fact.variant === 'announcement', editInfo: 'admins', addMembers: 'admins', joinApproval: false, encrypted: true });
      if (this.network === 'matrix') Object.assign(base, { announceOnly: conv?.fact.variant === 'announcement', joinRule: space ? 'open' : conv?.fact.shape === 'channel' ? 'space' : 'invite', history: 'shared', encrypted: !!conv?.fact.encrypted });
      if (this.network === 'discord' && conv) Object.assign(base, { slowMode: 0, nsfw: false, announceOnly: conv.fact.variant === 'announcement' });
      const invite =
        this.network === 'signal' && target.nativeId === sgroup('climb', '', []).nativeId
          ? 'https://signal.group/#CjQKIDemoClimbingCrewLink'
          : this.network === 'discord' && space?.fact.kind === 'community'
            ? `https://discord.gg/demo${target.nativeId.slice(-6)}`
            : null;
      place = { values: { ...base, ...DEMO_VALUES[target.nativeId] }, pinned: [...(DEMO_PINS[target.nativeId] ?? [])], invite };
      demoPlaces.set(target.nativeId, place);
    }
    return { place, conv, space };
  }

  /** The same answers real adapters give, by each network's own rules. */
  /** What each network's profile shows for someone (docs/profile.md), as its adapter would say it. */
  private profile(who: string): P.PersonAbout {
    const pool = this.network === 'discord' ? D : this.network === 'signal' ? S : this.network === 'whatsapp' ? W : M;
    const key = (Object.entries(pool) as [string, P.IdentityFact][]).find(([, i]) => i.nativeId === who)?.[0];
    const me = who === this.self.nativeId;
    const contacts = Object.values(pool).filter((i) => i.contact && i !== this.self);
    if (this.network === 'discord') {
      const mine = SPACES.filter((x) => x.acc.includes(this.key) && x.fact.kind === 'community').map((x) => x.fact.nativeId);
      const own = OWN_BIO.get(`discord:${who}`);
      const p = { ...DISCORD_PROFILES[key ?? ''], ...(own !== undefined ? { bio: own } : {}) };
      for (const f of contacts) this.emit({ t: 'identity', identity: f });
      return {
        ...(p.bio ? { bio: p.bio } : {}),
        ...(p.pronouns ? { pronouns: p.pronouns } : {}),
        ...(p.status ? { status: p.status } : {}),
        accent: p.accent ?? '#5865F2',
        createdAt: Date.UTC(2017 + (who.length % 6), (who.charCodeAt(3) ?? 0) % 12, 9),
        relationship: me ? undefined : pool[key as keyof typeof pool]?.contact ? 'friend' : 'stranger',
        ...(me ? { friends: contacts.map((i) => i.nativeId) } : {
          mutualSpaces: (p.servers ?? []).map((k) => ({ k, id: g[k] })).filter((x) => mine.includes(x.id)).map((x) => ({ id: x.id, ...(p.nick?.[x.k] ? { nick: p.nick[x.k] } : {}), roles: p.roles?.[x.k] ?? [] })),
          mutualFriends: contacts.filter((i) => i.nativeId !== who && (p.friends ?? []).includes(Object.entries(D).find(([, x]) => x === i)?.[0] ?? '')).map((i) => i.nativeId),
        }),
        ...(p.links ? { links: p.links } : {}),
      };
    }
    const me_ = pool[key as keyof typeof pool] as P.IdentityFact | undefined;
    if (this.network === 'signal') {
      const own = OWN_BIO.get(`signal:${who}`);
      const about = own !== undefined ? (own ? { text: own, emoji: SIGNAL_ABOUT[key ?? '']?.emoji ?? '' } : undefined) : SIGNAL_ABOUT[key ?? ''];
      return {
        ...(about ? { bio: about.text, status: { emoji: about.emoji } } : {}),
        relationship: me ? undefined : me_?.contact ? 'contact' : 'stranger',
        ...(me_?.handle ? { links: [{ label: 'Phone', value: me_.handle, url: `tel:${me_.handle.replace(/\s/g, '')}` }] } : {}),
        ...(me ? { friends: contacts.map((i) => i.nativeId) } : {}),
      };
    }
    if (this.network === 'whatsapp') {
      return {
        bio: OWN_BIO.get(`whatsapp:${who}`) ?? WHATSAPP_ABOUT[key ?? ''] ?? 'Hey there! I am using WhatsApp.',
        relationship: me ? undefined : me_?.contact ? 'contact' : 'stranger',
        ...(me_?.handle ? { links: [{ label: 'Phone', value: me_.handle, url: `https://wa.me/${me_.handle.replace(/\D/g, '')}` }] } : {}),
        ...(key === 'hoa' ? { facts: [{ label: 'Business', value: 'Maple Street Garden Swap' }] } : {}),
        ...(me ? { friends: contacts.map((i) => i.nativeId) } : {}),
      };
    }
    return { ...(key === 'kai' ? { pronouns: 'they/them', facts: [{ label: 'Local time', value: 'Europe/Berlin' }] } : {}) };
  }

  private about(target: P.AboutTarget): P.About {
    const { place, conv, space } = this.place(target);
    const v = place.values;
    const net = this.network;
    const shape = conv?.fact.shape;
    const where = conv && net === 'discord' && shape !== 'direct' && shape !== 'group' ? this.guildOf(conv) : null;
    const admin = ADMIN_IN[this.key].includes(target.nativeId) || (!!where && ADMIN_IN[this.key].includes(where));
    const level = net === 'matrix' ? (MX_LEVEL[target.nativeId] ?? (admin || shape === 'direct' || shape === 'self' ? 100 : 0)) : admin ? 100 : 0;
    const fields: P.AboutFields = {};
    const set = <K extends P.AboutKey>(k: K, canEdit: boolean, reason?: string) => {
      if (k in v || k === 'avatar') (fields as Record<string, P.AboutSetting>)[k] = { value: (v[k] ?? null) as never, canEdit, ...(reason && !canEdit ? { reason } : {}) };
    };
    const rules: P.AboutRule[] = [];
    const members: P.AboutMember[] = [];
    const pool = Object.values(net === 'discord' ? D : net === 'signal' ? S : net === 'whatsapp' ? W : M);
    const ids = new Set<string>(conv?.fact.participants ?? []);
    if (!ids.size) {
      ids.add(this.self.nativeId);
      for (const c of conv ? [conv] : CONVS.filter((c) => c.acc.includes(this.key) && c.fact.spaces?.some((sp) => sp.nativeId === target.nativeId || SPACES.some((x) => x.fact.nativeId === sp.nativeId && x.fact.parents?.some((pp) => pp.nativeId === target.nativeId)))))
        for (const m of c.msgs) ids.add(m[1].nativeId);
    }
    const pic = 'Changing the picture is not supported yet.';
    let noun = 'Group';
    if (net === 'discord') {
      const guild = space?.fact.kind === 'community' ? space.fact.nativeId : where;
      const roles = guild ? DISCORD_ROLES[guild] ?? [] : [];
      for (const id of ids) {
        const staff = id === this.self.nativeId ? (admin ? 'role-maint' : null) : DISCORD_STAFF[id];
        const role = roles.find((r) => r.id === snow(staff ?? '')) ?? roles.find((r) => r.rank === 0);
        members.push({ id, ...(role ? { role: role.name, rank: role.rank } : {}), ...(role?.color ? { color: role.color } : {}) });
      }
      if (space?.fact.kind === 'section') {
        noun = 'Category';
        set('name', admin, 'You need the Manage Channels permission.');
      } else if (space) {
        noun = 'Server';
        set('name', admin, 'You need the Manage Server permission.');
        set('topic', false, 'Only Community servers have a description, set in Discord.');
        set('avatar', false, pic);
      } else if (shape === 'direct') {
        noun = 'Direct message';
      } else if (shape === 'group') {
        set('name', true);
        set('avatar', false, pic);
        rules.push({ what: 'Rename, change the icon, add people', who: 'Everyone in the group', you: true }, { what: 'Remove people', who: 'The group owner', you: false });
      } else {
        noun = shape === 'thread' ? 'Thread' : 'Channel';
        const need = 'You need the Manage Channels permission.';
        set('name', admin, need);
        if (shape !== 'thread') set('topic', admin, need);
        set('slowMode', admin, need);
        if (shape !== 'thread') set('nsfw', admin, need);
        set('announceOnly', false, admin ? "Change who can send in the channel's permissions, in Discord." : need);
      }
      if (shape !== 'direct' && shape !== 'group') {
        rules.push(
          { what: 'Change the name, topic and slow mode', who: 'Manage Channels', you: admin },
          { what: 'Change the server', who: 'Manage Server', you: admin },
          { what: 'Pin messages', who: 'Pin Messages', you: admin },
          { what: 'Create invites', who: 'Create Instant Invite', you: true },
        );
      }
      return {
        noun,
        fields,
        members: { list: members, total: space || where ? Math.max(members.length, 1200) : members.length, complete: !(space || where) },
        ...(roles.length ? { roles } : {}),
        rules,
        you: { role: admin ? 'Maintainer' : 'Member', rank: admin ? 100 : 0 },
        ...(space?.fact.kind === 'community' ? { invite: { link: place.invite, canCreate: true, canRevoke: admin && !!place.invite, ...(admin ? {} : { reason: 'Only people with Manage Server can turn invites off.' }) } } : {}),
        ...(conv && shape !== 'thread' ? { pinned: { messages: place.pinned, canEdit: admin || shape === 'direct' || shape === 'group', reason: 'You need the Pin Messages permission.' } } : {}),
        ...(space?.fact.kind === 'community' ? { facts: [{ label: 'Verification level', value: 'Low: a verified email' }] } : {}),
      };
    }
    if (net === 'signal' || net === 'whatsapp') {
      const wa = net === 'whatsapp';
      noun = space ? 'Community' : shape === 'direct' ? 'Chat' : shape === 'self' ? 'Note to Self' : 'Group';
      for (const id of ids) {
        const isAdmin = id === this.self.nativeId ? admin : wa ? id === W.ines.nativeId || id === W.hoa.nativeId : id === S.priya.nativeId || id === S.mom.nativeId || id === S.quinn.nativeId;
        const owner = wa && isAdmin && id !== this.self.nativeId;
        members.push({ id, role: owner ? 'Group owner' : isAdmin ? 'Admin' : 'Member', rank: owner ? 110 : isAdmin ? 100 : 0 });
      }
      if (shape === 'direct' || shape === 'self') {
        set('disappearing', true);
        set('encrypted', false, `Always on in ${NETWORK_META_NAME[net]}.`);
        return { noun, fields, members: { list: members, complete: true }, rules: [{ what: 'Change disappearing messages', who: shape === 'self' ? 'You' : 'Either of you', you: true }] };
      }
      const info = admin || v.editInfo === 'everyone';
      const onlyAdmins = 'Only admins can change this.';
      const lockedInfo = wa ? 'Only admins can edit this group’s info.' : 'Only admins can edit this group’s details.';
      set('name', info, lockedInfo);
      set('topic', info, lockedInfo);
      set('avatar', false, info ? pic : lockedInfo);
      set('disappearing', info, lockedInfo);
      set('announceOnly', admin, onlyAdmins);
      set('editInfo', admin, onlyAdmins);
      set('addMembers', admin, onlyAdmins);
      set('joinApproval', admin, onlyAdmins);
      set('encrypted', false, `Always on in ${NETWORK_META_NAME[net]}.`);
      if (!wa && fields.joinApproval) fields.joinApproval = { value: null, canEdit: false, reason: 'Signal does not say whether approval is on.' };
      const who = (w: P.Who | undefined) => (w === 'everyone' ? 'All members' : 'Only admins');
      rules.push(
        { what: 'Edit name, description and disappearing messages', who: who(v.editInfo), you: info },
        { what: 'Add members', who: who(v.addMembers), you: admin || v.addMembers === 'everyone' },
        { what: 'Send messages', who: v.announceOnly ? 'Only admins' : 'All members', you: admin || !v.announceOnly },
        { what: 'Change these settings and the invite link', who: 'Only admins', you: admin },
      );
      return {
        noun,
        fields,
        members: { list: members, complete: true },
        roles: [
          ...(wa ? [{ id: 'superadmin', name: 'Group owner', rank: 110 }] : []),
          { id: 'admin', name: 'Admin', rank: 100, count: members.filter((m) => (m.rank ?? 0) >= 100).length },
          { id: 'member', name: 'Member', rank: 0, count: members.filter((m) => !m.rank).length },
        ],
        rules,
        you: { role: admin ? 'Admin' : 'Member', rank: admin ? 100 : 0 },
        invite: { link: admin ? place.invite : wa ? null : place.invite, canCreate: admin, canRevoke: admin && !!place.invite, ...(admin ? {} : { reason: 'Only admins can change the invite link.' }) },
        ...(wa && conv ? { facts: [{ label: 'Created', value: '2024-03-02' }] } : []),
      };
    }
    // Matrix: power levels.
    noun = space ? 'Space' : 'Room';
    const pl = (n: number) => level >= n;
    const need = (n: number) => `Needs power level ${n}; yours is ${level}.`;
    set('name', pl(50), need(50));
    set('topic', pl(50), need(50));
    set('avatar', false, pl(50) ? pic : need(50));
    if (conv) set('announceOnly', pl(100), need(100));
    set('joinRule', pl(100), need(100));
    if (conv) set('history', pl(100), need(100));
    if (conv) set('encrypted', !v.encrypted && pl(100), v.encrypted ? 'Encryption cannot be turned off once on.' : need(100));
    for (const id of ids) {
      const lvl = id === this.self.nativeId ? level : id === M.kai.nativeId || id === M.lina.nativeId || id === M.jules.nativeId ? 100 : id === M.nixbot.nativeId ? 50 : 0;
      members.push({ id, rank: lvl, role: lvl >= 100 ? 'Admin' : lvl >= 50 ? 'Moderator' : 'Member' });
    }
    const alias = conv?.fact.name ? `#${conv.fact.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${target.nativeId.split(':')[1]}` : null;
    rules.push(
      { what: 'Change name, topic and picture', who: 'Moderators (50)', you: pl(50) },
      { what: 'Change join rules, history and encryption', who: 'Admins (100)', you: pl(100) },
      { what: 'Invite people', who: 'Everyone (0)', you: true },
      { what: 'Remove or ban people', who: 'Moderators (50)', you: pl(50) },
      { what: 'Pin messages', who: 'Moderators (50)', you: pl(50) },
    );
    return {
      noun,
      fields,
      members: { list: members, complete: true },
      roles: [
        { id: '100', name: 'Admin', rank: 100 },
        { id: '50', name: 'Moderator', rank: 50 },
        { id: '0', name: 'Member', rank: 0 },
      ],
      rules,
      you: { role: lc(level >= 100 ? 'admin' : level >= 50 ? 'moderator' : 'member'), rank: level },
      invite: { link: `https://matrix.to/#/${encodeURIComponent(alias ?? target.nativeId)}`, canCreate: false, derived: true, reason: 'Matrix links are made from the room’s address, not issued.' },
      ...(conv ? { pinned: { messages: place.pinned, canEdit: pl(50), reason: need(50) } } : {}),
      facts: [{ label: 'Room version', value: '11' }],
    };
  }

  /** Apply a change the hub has checked, and say so the way the network would. */
  private configure(target: P.AboutTarget, change: P.AboutChange): P.About {
    const { place, conv, space } = this.place(target);
    if (change.key === 'invite') place.invite = change.op === 'create' ? `https://${this.network === 'signal' ? 'signal.group/#' : this.network === 'whatsapp' ? 'chat.whatsapp.com/' : 'discord.gg/'}demo${Date.now().toString(36)}` : null;
    else if (change.key === 'pin') {
      place.pinned = place.pinned.filter((m) => m !== change.message);
      if (!change.remove) place.pinned.unshift(change.message);
    } else (place.values as Record<string, unknown>)[change.key] = change.value;
    if (change.key === 'name' || change.key === 'topic') {
      if (conv) {
        conv.fact = { ...conv.fact, [change.key]: change.value };
        this.emit({ t: 'conversation', conversation: conv.fact });
      } else if (space) {
        space.fact = { ...space.fact, [change.key]: change.value };
        this.emit({ t: 'space', space: space.fact });
      }
    }
    if (conv && (this.network === 'signal' || this.network === 'whatsapp') && change.key !== 'pin') {
      const what = change.key === 'invite' ? (change.op === 'create' ? 'reset the group link' : 'turned off the group link') : `changed ${P_ABOUT_LABEL[change.key].toLowerCase()}`;
      this.emit({ t: 'message', live: false, message: { nativeId: `${target.nativeId}~cfg-${Date.now()}`, conversation: target.nativeId, author: this.self.nativeId, ts: Date.now(), kind: 'system', body: `You ${what}.` } });
    }
    return this.about(target);
  }

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    running.set(this.key, this);
    const epoch: number = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    const marker = join(this.dir, 'seeded');
    const firstRun = !existsSync(marker);
    const ago = (min: number) => epoch - min * 60_000;

    // Discord's demo accounts forward natively, as the real adapter does; the others leave it to the hub.
    // Matrix has no bio, so its demo account cannot edit one.
    const caps: P.Capability[] = ['send', 'history', 'react', 'markRead', 'threads', 'edit', 'redact', 'sendMedia', 'openDirect', 'typing', 'about', 'configure', 'profile', ...(this.network === 'matrix' ? [] : (['editProfile'] as const))];
    emit({ t: 'hello', network: this.network, version: 'demo', capabilities: this.network === 'discord' ? [...caps, 'forward'] : caps });
    emit({ t: 'status', status: 'online', self: { ...this.self, isSelf: true } });
    const pool = this.network === 'discord' ? D : this.network === 'signal' ? S : this.network === 'whatsapp' ? W : M;
    for (const i of Object.values(pool)) if (i !== this.self && !(this.network === 'discord' && (i === D.zyan || i === D.zyn))) emit({ t: 'identity', identity: i });
    if (this.key === 'dmain') emit({ t: 'identity', identity: D.zyn });
    if (this.key === 'dalt') emit({ t: 'identity', identity: D.zyan });

    for (const s of SPACES) if (s.acc.includes(this.key)) emit({ t: 'space', space: s.fact });
    for (const c of CONVS) {
      if (!c.acc.includes(this.key)) continue;
      const msgs = c.msgs;
      const lastAt = msgs.length ? ago(Math.min(...msgs.map((m) => m[0]))) : undefined;
      emit({ t: 'conversation', conversation: { ...c.fact, lastMessageAt: lastAt } });
      const ids = msgs.map((_, i) => `${c.fact.nativeId}~${i}`);
      msgs.forEach(([min, author, body, o = {}], i) => {
        const unreadTail = c.unread ?? 0;
        const live = firstRun && i >= msgs.length - unreadTail && author !== this.self;
        emit({
          t: 'message',
          live,
          message: {
            nativeId: ids[i],
            conversation: c.fact.nativeId,
            author: author.nativeId,
            ts: ago(min),
            editedTs: o.edited ? ago(min) + 60_000 : undefined,
            kind: o.kind ?? (o.att?.length ? 'media' : 'text'),
            body,
            replyTo: o.reply !== undefined ? ids[o.reply] : undefined,
            threadRoot: o.thread,
            mentionsSelf: body.includes(`<@${this.self.nativeId}>`),
            attachments: o.att,
            ...(o.fwd ? { forward: o.fwd } : {}),
            reactions: o.react || o.fancy ? [...(o.fancy ?? []), ...Object.entries(o.react ?? {}).map(([key, who]) => ({ key, authors: who.map((w) => w.nativeId) }))] : undefined,
          },
        });
      });
      const readUpTo = msgs.length - (c.unread ?? 0) - 1;
      if (readUpTo >= 0) emit({ t: 'read', conversation: c.fact.nativeId, upToTs: ago(msgs[readUpTo][0]) });
    }
    if (firstRun) this.seedHistory(ago);
    if (firstRun) writeFileSync(marker, String(Date.now()));
    scheduleChatter();
  }

  /** Things that changed and things taken back, once, so history has something to show (docs/history.md). */
  private seedHistory(ago: (min: number) => number) {
    if (this.key !== 'sig') return;
    const climb = CONVS.find((c) => c.fact.nativeId === sgroup('climb', '', []).nativeId)!.fact;
    const emit = this.emit;
    emit({ t: 'conversation', conversation: { ...climb, topic: 'Tuesdays at Mesa' } });
    emit({ t: 'conversation', conversation: { ...climb, topic: 'Tuesdays and Thursdays at Mesa. Bring your own chalk.' } });
    emit({ t: 'conversation', conversation: { ...climb, participants: [...climb.participants!, S.mei.nativeId] } });
    const msg = (nativeId: string, author: P.IdentityFact, min: number, body: string, x: Partial<P.MessageFact> = {}) =>
      emit({ t: 'message', live: false, message: { nativeId, conversation: climb.nativeId, author: author.nativeId, ts: ago(min), body, ...x } });
    msg(`${climb.nativeId}~h-edit`, S.priya, 70, 'meet at 6');
    msg(`${climb.nativeId}~h-edit`, S.priya, 70, 'meet at 6:30, traffic', { editedTs: ago(68) });
    msg(`${climb.nativeId}~h-del`, S.sam, 65, 'wrong chat lol, ignore this');
    emit({ t: 'delete', conversation: climb.nativeId, nativeId: `${climb.nativeId}~h-del` });
    msg(`${climb.nativeId}~h-gone`, S.alice, 60, 'door code for the gym is 4471');
    emit({ t: 'delete', conversation: climb.nativeId, nativeId: `${climb.nativeId}~h-gone`, reason: 'expired' });
    // A pin, a reaction taken back, a role, a status, and your message read.
    msg(`${climb.nativeId}~h-pin`, S.priya, 58, 'Mesa is open till 10 on Thursdays now');
    emit({ t: 'pin', conversation: climb.nativeId, message: `${climb.nativeId}~h-pin`, pinned: true, by: S.alice.nativeId, ts: ago(57) });
    emit({ t: 'reaction', conversation: climb.nativeId, message: `${climb.nativeId}~h-pin`, author: S.sam.nativeId, key: '😢' });
    emit({ t: 'reaction', conversation: climb.nativeId, message: `${climb.nativeId}~h-pin`, author: S.sam.nativeId, key: '😢', remove: true });
    emit({ t: 'role', target: { kind: 'conversation', nativeId: climb.nativeId }, member: S.sam.nativeId, role: 'Admin', given: true, by: S.priya.nativeId, ts: ago(56) });
    emit({ t: 'customStatus', who: S.alice.nativeId, text: 'out climbing', emoji: '🧗', ts: ago(200) });
    emit({ t: 'customStatus', who: S.alice.nativeId, text: 'on the wall, back at 8', emoji: '🧗', ts: ago(55) });
    msg(`${climb.nativeId}~h-mine`, S.self, 54, 'I can drive, leaving at 6');
    for (const [who, state, min] of [[S.alice, 'delivered', 53], [S.alice, 'read', 52], [S.priya, 'delivered', 53], [S.priya, 'read', 50]] as const)
      emit({ t: 'receipt', conversation: climb.nativeId, messages: [`${climb.nativeId}~h-mine`], who: who.nativeId, state, ts: ago(min) });
  }

  /** What this adapter sent since it started, for forwarding it. */
  private sent = new Map<string, { body: string; att?: P.AttachmentFact[] }>();

  /** A message's content by native id: seeded ones by position, sent ones from memory. */
  private contentOf(nativeId: string): { body: string; att?: P.AttachmentFact[] } | null {
    const mine = this.sent.get(nativeId);
    if (mine) return mine;
    const at = nativeId.lastIndexOf('~');
    const conv = CONVS.find((c) => c.fact.nativeId === nativeId.slice(0, at) && c.acc.includes(this.key));
    const m = conv?.msgs[Number(nativeId.slice(at + 1))];
    return m ? { body: m[2], att: m[3]?.att } : null;
  }

  /** Conversations opened since this adapter started: conversation id -> the peer. */
  private opened = new Map<string, string>();

  /** The same answers real adapters give, with the Signal rule that nothing exists until the first send. */
  private openDirect(peer: string): P.OpenDirectResult {
    const signal = this.network === 'signal';
    if (this.network === 'whatsapp') return this.openWhatsApp(peer);
    const pool = Object.values(this.network === 'discord' ? D : signal ? S : M);
    const known = pool.find((i) => i.nativeId === peer || i.handle === peer);
    if (signal && peer.startsWith('+') && !known && peer.endsWith('00')) throw new Error(`${peer} is not on Signal`);
    const nativeId = known?.nativeId ?? (signal && peer.startsWith('+') ? `d0000000-0000-4000-8000-${peer.slice(1).padStart(12, '0').slice(-12)}` : peer);
    const existing = CONVS.find((c) => c.acc.includes(this.key) && c.fact.shape === 'direct' && c.fact.participants?.includes(nativeId));
    if (existing) return { conversation: existing.fact.nativeId, existed: true, ...(signal ? { startsAtFirstSend: true } : {}) };
    const conversation = signal ? `dm:${this.self.nativeId}:${nativeId}` : this.network === 'matrix' ? `!direct-${nativeId.replace(/\W/g, '')}:demo` : snow(`dm-${this.key}-${nativeId}`);
    const existed = this.opened.has(conversation);
    this.opened.set(conversation, nativeId);
    if (!known) this.emit({ t: 'identity', identity: { nativeId, handle: peer } });
    this.emit({ t: 'conversation', conversation: { nativeId: conversation, shape: 'direct', participants: [this.self.nativeId, nativeId], ...(signal ? { encrypted: true } : {}) } });
    return { conversation, existed, ...(signal ? { startsAtFirstSend: true } : {}) };
  }

  /** WhatsApp: a phone number or JID is the chat; nothing exists until the first send. */
  private openWhatsApp(peer: string): P.OpenDirectResult {
    const jid = peer.includes('@') ? peer : `${peer.replace(/\D/g, '')}@s.whatsapp.net`;
    if (jid.startsWith('1555000')) throw new Error(`${peer} is not on WhatsApp`);
    const existed = CONVS.some((c) => c.acc.includes(this.key) && c.fact.nativeId === jid) || this.opened.has(jid);
    if (!existed) {
      this.opened.set(jid, jid);
      if (!Object.values(W).some((i) => i.nativeId === jid)) this.emit({ t: 'identity', identity: { nativeId: jid, handle: `+${jid.split('@')[0]}` } });
      this.emit({ t: 'conversation', conversation: { nativeId: jid, shape: 'direct', participants: [this.self.nativeId, jid], encrypted: true } });
    }
    return { conversation: jid, existed, startsAtFirstSend: !existed };
  }

  /** Someone types for a few seconds, then says it. */
  typeThenSay(conversation: string, author: P.IdentityFact, body: string) {
    this.emit({ t: 'typing', conversation, author: author.nativeId });
    this.later(4000, () => this.say(conversation, author, body));
  }

  /** A live message from someone else. */
  say(conversation: string, author: P.IdentityFact, body: string) {
    this.emit({
      t: 'message',
      live: true,
      message: {
        nativeId: `${conversation}~live-${Date.now()}`,
        conversation,
        author: author.nativeId,
        ts: Date.now(),
        body,
        mentionsSelf: body.includes(`<@${this.self.nativeId}>`),
      },
    });
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  command(cmd: P.AdapterCommand) {
    const reply = (result?: unknown) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: true, result });
    switch (cmd.t) {
      case 'send': {
        const nativeId = `${cmd.conversation}~sent-${Date.now()}`;
        // The file leaves the spool once this returns, and a demo has nowhere else to keep it.
        const attachments = cmd.attachments?.map((f) => ({ kind: f.kind, mime: f.mime, name: f.name, size: f.size, url: `data:${f.mime};base64,${readFileSync(f.path).toString('base64')}` }));
        this.emit({ t: 'message', live: true, message: { nativeId, conversation: cmd.conversation, author: this.self.nativeId, ts: Date.now(), body: cmd.body, replyTo: cmd.replyTo, kind: attachments?.length && !cmd.body ? 'media' : 'text', attachments } });
        this.sent.set(nativeId, { body: cmd.body, att: attachments });
        reply({ nativeId });
        const conv = CONVS.find((c) => c.fact.nativeId === cmd.conversation);
        const peer = this.opened.get(cmd.conversation);
        const others = peer ? [peer] : (conv?.fact.participants ?? []).filter((p) => p !== this.self.nativeId);
        if ((peer || conv?.fact.shape === 'direct') && others[0]) {
          const lines = REPLIES[others[0]] ?? ['👀', 'got it', 'nice'];
          const author = Object.values({ ...D, ...S, ...M }).find((i) => i.nativeId === others[0]) ?? { nativeId: others[0] };
          // They type first, the way an answer arrives on the real networks; their message ends it.
          this.later(1200, () => this.emit({ t: 'typing', conversation: cmd.conversation, author: author.nativeId }));
          this.later(3500 + Math.random() * 3000, () => this.say(cmd.conversation, author, lines[Math.floor(Math.random() * lines.length)]));
        } else if (others.length) {
          const who = others[Math.floor(Math.random() * others.length)];
          this.later(2500, () => this.emit({ t: 'reaction', conversation: cmd.conversation, message: nativeId, author: who, key: '👍' }));
          // A group stirs: a few people start typing, then think better of it.
          const typers = [...others].sort(() => Math.random() - 0.5).slice(0, Math.min(4, others.length));
          typers.forEach((who, i) => {
            this.later(900 + i * 500, () => this.emit({ t: 'typing', conversation: cmd.conversation, author: who }));
            this.later(6500 + i * 700, () => this.emit({ t: 'typing', conversation: cmd.conversation, author: who, stop: true }));
          });
        }
        break;
      }
      case 'forward': {
        const src = this.contentOf(cmd.source.message);
        if (!src) {
          reply({ fallback: 'this demo account does not have that message' });
          break;
        }
        const nativeId = `${cmd.conversation}~fwd-${Date.now()}`;
        const forward = { conversation: cmd.source.conversation, message: cmd.source.message };
        this.emit({ t: 'message', live: true, message: { nativeId, conversation: cmd.conversation, author: this.self.nativeId, ts: Date.now(), body: src.body, kind: src.att?.length && !src.body ? 'media' : 'text', attachments: src.att, forward } });
        if (cmd.note) this.emit({ t: 'message', live: true, message: { nativeId: `${nativeId}-note`, conversation: cmd.conversation, author: this.self.nativeId, ts: Date.now() + 1, body: cmd.note } });
        this.sent.set(nativeId, src);
        reply({ nativeId });
        break;
      }
      case 'openDirect':
        try {
          reply(this.openDirect(cmd.peer));
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'react':
        this.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: this.self.nativeId, key: cmd.key, remove: cmd.remove, style: cmd.style, ...(cmd.style === 'super' ? { colors: SUPER_COLORS } : {}), emoji: cmd.emoji });
        reply();
        break;
      case 'edit':
        this.emit({ t: 'message', live: false, message: { nativeId: cmd.message, conversation: cmd.conversation, author: this.self.nativeId, ts: 0, editedTs: Date.now(), body: cmd.body } });
        reply();
        break;
      case 'redact':
        this.emit({ t: 'delete', conversation: cmd.conversation, nativeId: cmd.message });
        reply();
        break;
      case 'reactionContext':
        reply(this.reactionContext());
        break;
      case 'profile':
        reply(this.profile(cmd.who));
        break;
      case 'setProfile': {
        // As the real adapters do: the network's limit, then the About as a status on Signal and WhatsApp.
        const bio = cmd.change.bio;
        const limit = P_BIO_LIMIT[this.network];
        if (bio !== undefined && limit !== undefined && [...bio].length > limit) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: `bio is longer than ${limit} characters` });
          break;
        }
        if (bio !== undefined) {
          OWN_BIO.set(`${this.network}:${this.self.nativeId}`, bio);
          if (this.network === 'signal' || this.network === 'whatsapp') this.emit({ t: 'customStatus', who: this.self.nativeId, text: bio, ts: Date.now() });
        }
        reply(this.profile(this.self.nativeId));
        break;
      }
      case 'about':
      case 'configure':
        try {
          reply(cmd.t === 'about' ? this.about(cmd.target) : this.configure(cmd.target, cmd.change));
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'reactors':
        reply({ authors: Object.values(D).filter((i) => i !== D.zyan && i !== D.zyn).slice(0, 5).map((i) => i.nativeId) });
        break;
      case 'history':
        reply({ count: 0, done: true });
        break;
      case 'markRead':
        reply();
        break;
      case 'typing':
        // Kept for verify scripts (action typingLog): what the hub told this account to say about your typing.
        this.typingLog.push({ conversation: cmd.conversation, stop: !!cmd.stop, at: Date.now() });
        if (this.typingLog.length > 50) this.typingLog.shift();
        reply();
        break;
      case 'fetchMedia':
        this.emit({ t: 'reply', id: cmd.id, ok: false, error: 'demo media is inline' });
        break;
      case 'action':
        reply(cmd.action === 'typingLog' ? { typing: this.typingLog } : { note: 'demo adapters have no actions' });
        break;
      default:
        if ('id' in cmd) reply();
    }
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    running.delete(this.key);
    if (!running.size && chatterTimer) {
      clearTimeout(chatterTimer);
      chatterTimer = undefined;
    }
  }
}

export function demoFactory(acc: AccountRow, dir: string): InprocAdapter | null {
  if (acc.adapter !== 'demo') return null;
  const key = DEMO_ACCOUNTS.find((d) => d.id === acc.id)?.key;
  return key ? new DemoAdapter(key, acc, dir) : null;
}

export function createDemoAccounts(store: Store): AccountRow[] {
  const epoch = Date.now();
  return DEMO_ACCOUNTS.map((d) => store.createAccount({ id: d.id, network: d.network, label: d.label, color: d.color, adapter: 'demo', demo: true, config: { epoch } }));
}

/** Hub-side organisation for the demo: merged people, stars, folders, rules. Applied once. */
export function applyDemoOverlay(store: Store) {
  if (store.one(`SELECT 1 FROM meta WHERE key = 'demo_overlay'`)) return;
  const idn = (net: P.Network, i: P.IdentityFact) => hubId('idn', net, i.nativeId);
  const personOf = (net: P.Network, i: P.IdentityFact) => store.ensurePerson(idn(net, i));
  const merge = (name: string, starred: boolean, ...ids: [P.Network, P.IdentityFact][]) => {
    const [first, ...rest] = ids.map(([n, i]) => personOf(n, i));
    for (const r of rest) store.mergePersons(first, r);
    store.updatePerson(first, { name, starred });
    return first;
  };
  const alice = merge('Alice Chen', true, ['signal', S.alice], ['discord', D.alice], ['matrix', M.alice], ['whatsapp', W.alice]);
  const sam = merge('Sam Rivera', false, ['signal', S.sam], ['matrix', M.sam]);
  merge('Theo', false, ['signal', S.theo], ['discord', D.theo]);
  merge('Quinn', false, ['discord', D.quinn], ['signal', S.quinn]);
  store.updatePerson(personOf('signal', S.mom), { starred: true });

  const cnv = (net: P.Network, nativeId: string) => hubId('cnv', net, nativeId);
  const spc = (net: P.Network, nativeId: string) => hubId('spc', net, nativeId);
  store.setFolders([
    {
      id: 'fld_demo-dither',
      name: 'Dither',
      icon: '◐',
      color: '#F2A541',
      items: [
        { kind: 'space', id: spc('discord', g.dither) },
        { kind: 'conversation', id: cnv('matrix', room('libdither-mx', 'matrix.org')) },
        { kind: 'conversation', id: cnv('signal', sgroup('dithercore', '', []).nativeId) },
      ],
    },
    {
      id: 'fld_demo-rust',
      name: 'Rust',
      icon: '🦀',
      color: '#FF8C61',
      items: [
        { kind: 'space', id: spc('discord', g.rust) },
        { kind: 'space', id: spc('matrix', room('rust-space', 'matrix.org')) },
      ],
    },
    {
      id: 'fld_demo-friends',
      name: 'Friends',
      icon: '✿',
      color: '#E86A92',
      items: [
        { kind: 'person', id: alice },
        { kind: 'person', id: sam },
        { kind: 'conversation', id: cnv('signal', sgroup('climb', '', []).nativeId) },
        { kind: 'conversation', id: cnv('discord', snow('gdm-raid')) },
        { kind: 'conversation', id: cnv('matrix', room('house', 'matrix.org')) },
      ],
    },
  ]);
  store.setRule('space', spc('discord', g.rust), 'digest');
  store.setRule('conversation', cnv('discord', ch('dither-ann')), 'all');
  store.setRule('conversation', cnv('signal', sgroup('family', '', []).nativeId), 'all');
  store.setRule('conversation', cnv('discord', ch('hk-routes')), 'smart');
  store.setRule('keyword', 'dither-chat', 'all');
  store.setRule('keyword', 'zyan', 'all');
  store.db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_overlay', ?)`).run(String(Date.now()));
}
