/**
 * Demo world: four in-process adapters (two Discord accounts, Signal, Matrix)
 * that emit the same facts real adapters do, so the whole pipeline (dedupe,
 * person merging, triage, folders) runs on realistic data.
 *
 * Native ids are shaped like the real thing (snowflakes, UUIDs, !room:server)
 * so the source panels look right. Timestamps are relative to an epoch fixed at
 * first seed and stored in the account config.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

type AccKey = 'dmain' | 'dalt' | 'sig' | 'mx';

export const DEMO_ACCOUNTS: { key: AccKey; id: string; network: P.Network; label: string; color: string }[] = [
  { key: 'dmain', id: 'acc_demo-discord-main', network: 'discord', label: 'main', color: '#F2A541' },
  { key: 'dalt', id: 'acc_demo-discord-alt', network: 'discord', label: 'alt', color: '#E86A92' },
  { key: 'sig', id: 'acc_demo-signal', network: 'signal', label: 'personal', color: '#B794F6' },
  { key: 'mx', id: 'acc_demo-matrix', network: 'matrix', label: 'matrix.org', color: '#FF8C61' },
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
  ['dalt', ch('hk-routes'), D.shade, 'found an even faster skip, video soon'],
  ['mx', room('nix-dev', 'nixos.org'), M.kai, 'anyone benchmarked the new evaluator on darwin?'],
];

const REPLIES: Record<string, string[]> = {
  [S.alice.nativeId]: ['haha ok', 'sounds good!', 'omw', '👍', 'you are the best'],
  [D.alice.nativeId]: ['lol', 'ok ok', 'sending it on signal'],
  [M.alice.nativeId]: ['let me know what you think of section 3'],
  [S.mom.nativeId]: ['Ok sweetie', 'Love you! See you Sunday', '❤️'],
  [S.theo.nativeId]: ["I'll leave it at the gym desk"],
  [D.ravi.nativeId]: ['bet', 'ok see you at 8', 'healer secured'],
  [D.jordan.nativeId]: ['gl on the run!', 'lmk your time'],
  [M.kai.nativeId]: ['nice, I owe you one', 'ahh that makes sense'],
};

const running = new Map<AccKey, DemoAdapter>();
let chatterTimer: Timer | undefined;
let chatterIdx = 0;

function scheduleChatter() {
  if (chatterTimer) return;
  const tick = () => {
    const line = CHATTER[chatterIdx++ % CHATTER.length];
    running.get(line[0])?.say(line[1], line[2], line[3]);
    chatterTimer = setTimeout(tick, 90_000 + Math.random() * 90_000);
  };
  chatterTimer = setTimeout(tick, 45_000);
}

class DemoAdapter implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private timers = new Set<Timer>();
  private self: P.IdentityFact;
  private network: P.Network;

  constructor(
    private key: AccKey,
    private acc: AccountRow,
    private dir: string,
  ) {
    this.network = acc.network;
    this.self = key === 'dmain' ? D.zyan : key === 'dalt' ? D.zyn : key === 'sig' ? S.self : M.self;
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

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    running.set(this.key, this);
    const epoch: number = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    const marker = join(this.dir, 'seeded');
    const firstRun = !existsSync(marker);
    const ago = (min: number) => epoch - min * 60_000;

    emit({ t: 'hello', network: this.network, version: 'demo', capabilities: ['send', 'history', 'react', 'markRead', 'threads'] });
    emit({ t: 'status', status: 'online', self: { ...this.self, isSelf: true } });
    const pool = this.network === 'discord' ? D : this.network === 'signal' ? S : M;
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
            reactions: o.react || o.fancy ? [...(o.fancy ?? []), ...Object.entries(o.react ?? {}).map(([key, who]) => ({ key, authors: who.map((w) => w.nativeId) }))] : undefined,
          },
        });
      });
      const readUpTo = msgs.length - (c.unread ?? 0) - 1;
      if (readUpTo >= 0) emit({ t: 'read', conversation: c.fact.nativeId, upToTs: ago(msgs[readUpTo][0]) });
    }
    if (firstRun) writeFileSync(marker, String(Date.now()));
    scheduleChatter();
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
        this.emit({ t: 'message', live: true, message: { nativeId, conversation: cmd.conversation, author: this.self.nativeId, ts: Date.now(), body: cmd.body, replyTo: cmd.replyTo } });
        reply({ nativeId });
        const conv = CONVS.find((c) => c.fact.nativeId === cmd.conversation);
        const others = (conv?.fact.participants ?? []).filter((p) => p !== this.self.nativeId);
        if (conv?.fact.shape === 'direct' && others[0]) {
          const lines = REPLIES[others[0]] ?? ['👀', 'got it', 'nice'];
          const author = Object.values({ ...D, ...S, ...M }).find((i) => i.nativeId === others[0])!;
          this.later(3500 + Math.random() * 3000, () => this.say(cmd.conversation, author, lines[Math.floor(Math.random() * lines.length)]));
        } else if (others.length) {
          const who = others[Math.floor(Math.random() * others.length)];
          this.later(2500, () => this.emit({ t: 'reaction', conversation: cmd.conversation, message: nativeId, author: who, key: '👍' }));
        }
        break;
      }
      case 'react':
        this.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: this.self.nativeId, key: cmd.key, remove: cmd.remove, style: cmd.style, ...(cmd.style === 'super' ? { colors: SUPER_COLORS } : {}), emoji: cmd.emoji });
        reply();
        break;
      case 'reactionContext':
        reply(this.reactionContext());
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
      case 'fetchMedia':
        this.emit({ t: 'reply', id: cmd.id, ok: false, error: 'demo media is inline' });
        break;
      case 'action':
        reply({ note: 'demo adapters have no actions' });
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
  const alice = merge('Alice Chen', true, ['signal', S.alice], ['discord', D.alice], ['matrix', M.alice]);
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
