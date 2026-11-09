import { expect, test } from 'bun:test';
import { type AddRef, addCapability, describeAddRef, parseAdd, validAddRef } from '../src/add.ts';

const inv = (network: AddRef['network'], code: string, url: string): AddRef => ({ kind: 'invite', network, code, url });
const per = (network: AddRef['network'], handle: string): AddRef => ({ kind: 'person', network, handle });
const name = (n: string): AddRef => ({ kind: 'name', network: 'telegram', name: n });
const place = (address: string, via?: string[]): AddRef => ({ kind: 'place', network: 'matrix', address, ...(via ? { via } : {}) });
const phone = (p: string) => (['signal', 'whatsapp', 'telegram', 'gmessages'] as const).map((n) => per(n, p));

const TABLE: [string, AddRef[]][] = [
  // Discord
  ['https://discord.gg/rust', [inv('discord', 'rust', 'https://discord.gg/rust')]],
  ['discord.gg/Ab-12cd', [inv('discord', 'Ab-12cd', 'https://discord.gg/Ab-12cd')]],
  ['https://discord.com/invite/rust', [inv('discord', 'rust', 'https://discord.gg/rust')]],
  ['https://discordapp.com/invite/rust', [inv('discord', 'rust', 'https://discord.gg/rust')]],
  ['https://www.discord.com/invite/rust', [inv('discord', 'rust', 'https://discord.gg/rust')]],
  ['https://discord.com/users/123456789012345678', [per('discord', '123456789012345678')]],
  ['alice.chen', [per('discord', 'alice.chen')]],
  ['zy', [per('discord', 'zy')]],
  // WhatsApp
  ['https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv', [inv('whatsapp', 'AbCdEfGhIjKlMnOpQrStUv', 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv')]],
  ['chat.whatsapp.com/AbCdEfGhIjKl', [inv('whatsapp', 'AbCdEfGhIjKl', 'https://chat.whatsapp.com/AbCdEfGhIjKl')]],
  ['https://wa.me/15551234567', [per('whatsapp', '+15551234567')]],
  // Telegram
  ['https://t.me/+AbCdEf_123', [inv('telegram', 'AbCdEf_123', 'https://t.me/+AbCdEf_123')]],
  ['t.me/joinchat/AbCdEf_123', [inv('telegram', 'AbCdEf_123', 'https://t.me/+AbCdEf_123')]],
  ['https://telegram.me/joinchat/AbCdEf_123', [inv('telegram', 'AbCdEf_123', 'https://t.me/+AbCdEf_123')]],
  ['tg://join?invite=AbCdEf_123', [inv('telegram', 'AbCdEf_123', 'https://t.me/+AbCdEf_123')]],
  ['https://t.me/dithernews', [name('dithernews')]],
  ['t.me/dithernews/42', [name('dithernews')]],
  ['https://t.me/s/dithernews', [name('dithernews')]],
  ['tg://resolve?domain=dithernews', [name('dithernews')]],
  ['https://t.me/+15551234567', [per('telegram', '+15551234567')]],
  // @name: Telegram first, then X and Instagram where it fits their rules
  ['@lena_k', [name('lena_k'), per('x', 'lena_k'), per('instagram', 'lena_k')]],
  ['@abc', [per('x', 'abc'), per('instagram', 'abc')]],
  ['@a.photo', [per('instagram', 'a.photo')]],
  ['@a_very_long_handle_name', [name('a_very_long_handle_name'), per('instagram', 'a_very_long_handle_name')]],
  // Signal
  ['https://signal.group/#CjQKIAbc-def_123', [inv('signal', 'https://signal.group/#CjQKIAbc-def_123', 'https://signal.group/#CjQKIAbc-def_123')]],
  ['https://signal.me/#eu/AbCdEfGh1234_-', [per('signal', 'https://signal.me/#eu/AbCdEfGh1234_-')]],
  ['https://signal.me/#p/+15551234567', [per('signal', '+15551234567')]],
  ['priya.07', [per('signal', 'priya.07'), per('discord', 'priya.07')]],
  ['Priya.07', [per('signal', 'Priya.07')]],
  // Matrix
  ['https://matrix.to/#/#rust:matrix.org?via=matrix.org&via=mozilla.org', [place('#rust:matrix.org', ['matrix.org', 'mozilla.org'])]],
  ['https://matrix.to/#/%23rust%3Amatrix.org', [place('#rust:matrix.org')]],
  ['https://matrix.to/#/!abcDEF:matrix.org?via=matrix.org', [place('!abcDEF:matrix.org', ['matrix.org'])]],
  ['https://matrix.to/#/!abcDEF:matrix.org/$event?via=matrix.org', [place('!abcDEF:matrix.org', ['matrix.org'])]],
  ['https://matrix.to/#/@mira:matrix.org', [per('matrix', '@mira:matrix.org')]],
  ['@mira:matrix.org', [per('matrix', '@mira:matrix.org')]],
  ['#rust-gamedev:matrix.org', [place('#rust-gamedev:matrix.org')]],
  ['!abcDEF:matrix.org', [place('!abcDEF:matrix.org')]],
  ['#nix:nixos.org:8448', [place('#nix:nixos.org:8448')]],
  // Phones, any spacing
  ['+15551234567', phone('+15551234567')],
  ['+1 (555) 123-4567', phone('+15551234567')],
  ['+44 20 7183 0042', phone('+442071830042')],
  // X, Instagram, Messenger
  ['https://x.com/dither_chat', [per('x', 'dither_chat')]],
  ['twitter.com/dither_chat', [per('x', 'dither_chat')]],
  ['https://www.instagram.com/film.photo/', [per('instagram', 'film.photo')]],
  ['https://facebook.com/lena.kowalski', [per('messenger', 'lena.kowalski')]],
  ['https://www.facebook.com/profile.php?id=100012345678', [per('messenger', '100012345678')]],
  ['https://m.me/lena.kowalski', [per('messenger', 'lena.kowalski')]],
];

// Close to a reading, but not one.
const NEAR_MISSES = [
  '',
  '   ',
  'a',
  'Alice',
  'a..b',
  'hello world',
  'discord.gg/',
  'https://discord.gg/rust/extra',
  'https://discord.com/invite/',
  'https://discord.com/users/12',
  'https://evil.example/discord.gg/rust',
  'https://discord.gg.evil.example/rust',
  'ftp://discord.gg/rust',
  'javascript:alert(1)',
  'data:text/html,hi',
  'mailto:a@b.c',
  'localhost:8080',
  'chat.whatsapp.com/',
  'https://chat.whatsapp.com/short',
  'https://wa.me/abc',
  'https://t.me/+',
  'https://t.me/abc',
  'https://t.me/joinchat/',
  'tg://resolve',
  'tg://msg?text=hi',
  'https://signal.group/',
  'https://signal.me/#p/12',
  'https://matrix.to/',
  'https://matrix.to/#/rust',
  '#rust',
  '!room',
  '@',
  '@has space',
  '@mira:',
  '+123',
  '+0 555 123 4567',
  'https://x.com/home',
  'https://x.com/this_handle_is_too_long',
  'https://instagram.com/p/AbCd',
  'https://facebook.com/groups/12345',
  'https://example.com/someone',
];

test('every reading in the table', () => {
  for (const [input, want] of TABLE) expect({ input, got: parseAdd(input) }).toEqual({ input, got: want });
});

test('near misses read as nothing', () => {
  for (const input of NEAR_MISSES) expect({ input, got: parseAdd(input) }).toEqual({ input, got: [] });
});

test('the hub takes back exactly the readings parseAdd gives', () => {
  for (const [, refs] of TABLE) for (const r of refs) expect({ r, ok: validAddRef(r) }).toEqual({ r, ok: true });
  const bad: unknown[] = [
    null,
    'discord.gg/rust',
    { kind: 'invite', network: 'discord', code: 'rust', url: 'https://evil.example/rust' },
    { kind: 'invite', network: 'whatsapp', code: 'rust', url: 'https://discord.gg/rust' },
    { kind: 'invite', network: 'discord', code: 'rust', url: 'https://discord.gg/rust', extra: 1 },
    { kind: 'place', network: 'matrix', address: '#rust:matrix.org', via: ['not a host'] },
    { kind: 'place', network: 'discord', address: '#rust:matrix.org' },
    { kind: 'name', network: 'telegram', name: 'ab' },
    { kind: 'person', network: 'discord', handle: 'Alice' },
    { kind: 'person', network: 'email', handle: 'a@b.c' },
    { kind: 'person', network: 'signal', handle: '+1' },
    { kind: 'join', network: 'discord', code: 'rust' },
  ];
  for (const x of bad) expect({ x, ok: validAddRef(x) }).toEqual({ x, ok: false });
});

test('each reading says what it is in a few words', () => {
  expect(describeAddRef(parseAdd('discord.gg/abc')[0])).toBe('Discord invite discord.gg/abc');
  expect(describeAddRef(parseAdd('@lena_k')[0])).toBe('Telegram @lena_k');
  expect(describeAddRef(parseAdd('#rust:matrix.org')[0])).toBe('Matrix address #rust:matrix.org');
  expect(describeAddRef(parseAdd('https://signal.group/#abcdef')[0])).toBe('Signal group link');
  expect(describeAddRef(parseAdd('+15551234567')[1])).toBe('WhatsApp +15551234567');
});

test('join and ask need join, friend follow and contact need connect, message needs openDirect', () => {
  expect(['join', 'ask', 'friend', 'follow', 'contact', 'message'].map((a) => addCapability(a as never))).toEqual(['join', 'join', 'connect', 'connect', 'connect', 'openDirect']);
});
