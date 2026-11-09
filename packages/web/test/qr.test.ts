import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { parseAdd } from '@dither-chat/protocol';
import jsQR from 'jsqr';
import { encode } from 'uqr';
import { addRows } from '../src/add.ts';
import { ownCode, qrSvg, readScan } from '../src/qr.ts';

const me = (nativeId: string, handle: string | null = null) => ({ nativeId, handle });

test("each network's own link, from the account's own identity", () => {
  const cases: [P.Network, ReturnType<typeof me>, string, boolean][] = [
    ['matrix', me('@zyan:matrix.example', '@zyan:matrix.example'), 'https://matrix.to/#/@zyan:matrix.example', false],
    ['telegram', me('100200300', '@zyan_sheep'), 'https://t.me/zyan_sheep', false],
    ['whatsapp', me('15550100@s.whatsapp.net', '+15550100'), 'https://wa.me/15550100', true],
    ['discord', me('100000000000000001', 'zyan'), 'https://discord.com/users/100000000000000001', false],
    ['x', me('900', 'zyan_x'), 'https://x.com/zyan_x', false],
    ['instagram', me('901', 'zyan.pics'), 'https://instagram.com/zyan.pics', false],
    ['signal', me('00000000-0000-4000-8000-000000000001', '+1 555 0100'), 'https://signal.me/#p/+15550100', true],
    ['messenger', me('100000000000001', 'zyan.sheep'), 'https://m.me/zyan.sheep', false],
  ];
  for (const [network, identity, url, number] of cases) {
    const c = ownCode(network, identity).code;
    expect([network, c?.url, !!c?.number]).toEqual([network, url, number]);
  }
});

test('the number is the only code where there is no name, and it is flagged for hiding', () => {
  // Telegram without a username: its number, with a note saying how to get a code that hides it.
  const tg = ownCode('telegram', me('100200300', '+15550100'));
  expect(tg.code).toMatchObject({ url: 'https://t.me/+15550100', number: true });
  expect(tg.notes.join(' ')).toContain('no Telegram username');
  expect(ownCode('telegram', me('100200300', null)).code).toBeNull();
  // WhatsApp: the number from the handle, or from a phone JID; a LID alone says nothing.
  expect(ownCode('whatsapp', me('15550100@s.whatsapp.net', null)).code?.url).toBe('https://wa.me/15550100');
  const lid = ownCode('whatsapp', me('123456789012345@lid', null));
  expect(lid.code).toBeNull();
  expect(lid.notes[0]).toContain('has not said');
  // Signal: a username needs the adapter, said every time.
  const sig = ownCode('signal', me('00000000-0000-4000-8000-000000000001', '@zyan.42'));
  expect(sig.code).toBeNull();
  expect(sig.notes.join(' ')).toContain("needs the account's adapter");
  expect(ownCode('signal', me('00000000-0000-4000-8000-000000000001', '+15550100')).notes.join(' ')).toContain('username');
});

test('no code where the identity does not make a link', () => {
  expect(ownCode('discord', me('not-a-snowflake')).code).toBeNull();
  expect(ownCode('matrix', me('zyan')).code).toBeNull();
  expect(ownCode('x', me('900', 'home')).code).toBeNull(); // a page of the site, not a profile
  expect(ownCode('x', me('900', null)).code).toBeNull();
  expect(ownCode('gmessages', me('+15550100', '+15550100'))).toEqual({ code: null, notes: ['Google Messages has no profile link: people reach you by your phone number.'] });
  // Messenger with only its numeric id: the profile page.
  expect(ownCode('messenger', me('100000000000001', null)).code?.url).toBe('https://www.facebook.com/profile.php?id=100000000000001');
  // Every line that says why there is none is a sentence.
  for (const n of ['discord', 'matrix', 'x'] as const) expect(ownCode(n, me('?')).notes.length).toBe(1);
});

test('every code our Scan reads back as the same person on the same network', () => {
  const ids: [P.Network, ReturnType<typeof me>, string][] = [
    ['matrix', me('@zyan:matrix.example'), '@zyan:matrix.example'],
    ['telegram', me('1', '@zyan_sheep'), 'zyan_sheep'],
    ['whatsapp', me('15550100@s.whatsapp.net'), '+15550100'],
    ['discord', me('100000000000000001'), '100000000000000001'],
    ['x', me('1', 'zyan_x'), 'zyan_x'],
    ['instagram', me('1', 'zyan.pics'), 'zyan.pics'],
    ['signal', me('u', '+15550100'), '+15550100'],
    ['messenger', me('100000000000001', 'zyan.sheep'), 'zyan.sheep'],
  ];
  for (const [network, identity, who] of ids) {
    const url = ownCode(network, identity).code!.url;
    expect(readScan(url)).toEqual({ kind: 'reading', text: url });
    const r = parseAdd(url)[0];
    expect([r.network, r.kind === 'name' ? r.name : r.kind === 'person' ? r.handle : null]).toEqual([network, who]);
  }
});

test('a scan of a link or an address fills the box like a paste; anything else is shown as text', () => {
  for (const s of [
    'https://discord.gg/pixelart',
    'https://signal.group/#CjQKIDemoClimbingCrewLink',
    'https://chat.whatsapp.com/MapleGardenSwap26',
    'https://wa.me/15550100',
    'https://t.me/+FilmSwap2026x',
    'https://t.me/dithernews',
    'tg://resolve?domain=dithernews',
    'https://matrix.to/#/#rust-gamedev:matrix.org?via=matrix.org',
    '#rust-gamedev:matrix.org',
    '@zyan:matrix.example',
    '+1 555 0100',
  ])
    expect(readScan(s).kind).toBe('reading');
  // Scanners hand over trailing newlines.
  expect(readScan('https://discord.gg/pixelart\n')).toEqual({ kind: 'reading', text: 'https://discord.gg/pixelart' });
  for (const s of ['WIFI:S:DemoCafe;T:WPA;P:example;;', 'hello', 'mara', 'https://example.com/join', 'javascript:alert(1)', 'BEGIN:VCARD\nFN:Demo\nEND:VCARD', 'mailto:someone@example.com', ''])
    expect(readScan(s).kind).toBe('other');
  const login = readScan('tg://login?token=AAAA');
  expect(login.kind === 'other' && login.hint).toContain('Telegram sign-in code');
});

test('a scanned link lands on the same reading a pasted one does', () => {
  const acc = { id: 'd', network: 'discord', status: 'online', capabilities: ['openDirect', 'resolve', 'join', 'connect'] } as unknown as P.AccountView;
  const r = readScan('https://discord.gg/pixelart');
  expect(r.kind).toBe('reading');
  const rows = addRows(r.text, [acc]);
  expect(rows.map((x) => [x.label, x.state.kind])).toEqual([['Discord invite discord.gg/pixelart', 'resolve']]);
});

/** Draw what uqr encodes as an RGBA image, the way a camera would see a printed code, and read it with jsQR. */
function decode(text: string): string | null {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  const scale = 4;
  const w = size * scale;
  const px = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const v = data[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
  return jsQR(px, w, w)?.data ?? null;
}

test('codes decode back to their link, and draw black on white with a quiet zone', () => {
  for (const url of ['https://matrix.to/#/@zyan:matrix.example', 'https://signal.me/#p/+15550100', 'https://discord.gg/pixelart']) expect(decode(url)).toBe(url);
  const svg = qrSvg('https://discord.gg/pixelart');
  expect(svg).toContain('shape-rendering="crispEdges"');
  expect(svg).toMatch(/<rect fill="#ffffff"/);
  expect(svg).toContain('fill="#000000"');
  // The four-module quiet zone: the first dark module is 4 modules (40 units) in.
  expect(svg).toMatch(/d="M40,40h10v10h-10z/);
});
