import { expect, test } from 'bun:test';
import { findInvites, inviteKind, inviteRef, MAX_INVITE_CARDS, shortLink } from '../src/invites.ts';
import { renderMarkdown } from '../src/markdown.ts';

const found = (body: string) => findInvites(body).map((f) => [f.url, f.ref.kind, f.ref.network]);

test('invite links in a body: with or without https://, in order, each once', () => {
  expect(found('join us at https://discord.gg/pixelart! or discord.gg/pixelart, and the film swap group is t.me/+FilmSwap2026x')).toEqual([
    ['https://discord.gg/pixelart', 'invite', 'discord'],
    ['https://t.me/+FilmSwap2026x', 'invite', 'telegram'],
  ]);
  expect(found('https://discord.com/invite/pixelart')).toEqual([['https://discord.com/invite/pixelart', 'invite', 'discord']]);
  expect(found('garden: https://chat.whatsapp.com/MapleGardenSwap26.')).toEqual([['https://chat.whatsapp.com/MapleGardenSwap26', 'invite', 'whatsapp']]);
  expect(found('https://signal.group/#CjQKIDemoGroupLink')).toEqual([['https://signal.group/#CjQKIDemoGroupLink', 'invite', 'signal']]);
  expect(found('(see [the room](https://matrix.to/#/#rust-gamedev:matrix.org?via=matrix.org))')).toEqual([['https://matrix.to/#/#rust-gamedev:matrix.org?via=matrix.org', 'place', 'matrix']]);
  expect(found('and t.me/dithernews has the release notes now')).toEqual([['https://t.me/dithernews', 'name', 'telegram']]);
  // The same thing by two links is one card.
  expect(found('discord.gg/pixelart https://discord.com/invite/pixelart')).toHaveLength(1);
});

test('not invites: other links, phones, messages in a room or channel, code, and words that only look like hosts', () => {
  expect(found('https://example.com/discord.gg/x https://github.com/libdither')).toEqual([]);
  expect(found('call t.me/+15551234567')).toEqual([]);
  expect(found('https://t.me/dithernews/42 and https://matrix.to/#/#rust-gamedev:matrix.org/$event:matrix.org')).toEqual([]);
  expect(found('`discord.gg/pixelart` and\n```\nt.me/+FilmSwap2026x\n```')).toEqual([]);
  expect(found('next.me/thing notdiscord.gg/abc user@t.me/abc')).toEqual([]);
  expect(found('https://discord.com/users/123456789012345678 https://wa.me/15551234567')).toEqual([]);
  expect(found('')).toEqual([]);
  expect(found('nothing here at all')).toEqual([]);
});

test('at most a few cards under one message', () => {
  const body = ['a', 'b', 'c', 'd', 'e'].map((c) => `discord.gg/code${c}`).join(' ');
  expect(findInvites(body)).toHaveLength(MAX_INVITE_CARDS);
});

test('a link is an invite by the same rules, for a click on it', () => {
  expect(inviteRef('https://discord.gg/pixelart')).toMatchObject({ kind: 'invite', code: 'pixelart' });
  expect(inviteRef('https://matrix.to/#/!abc:matrix.org')).toMatchObject({ kind: 'place', address: '!abc:matrix.org' });
  expect(inviteRef('https://t.me/s/dithernews')).toMatchObject({ kind: 'name', name: 'dithernews' });
  expect(inviteRef('https://matrix.to/#/@ann:matrix.org')).toBeNull();
  expect(inviteRef('https://x.com/someone')).toBeNull();
  expect(inviteRef('https://example.com/')).toBeNull();
});

test('what kind of link, before anything is looked up', () => {
  const kind = (s: string) => inviteKind(findInvites(s)[0].ref);
  expect(kind('discord.gg/pixelart')).toBe('Discord server invite');
  expect(kind('chat.whatsapp.com/MapleGardenSwap26')).toBe('WhatsApp group invite');
  expect(kind('t.me/+FilmSwap2026x')).toBe('Telegram group invite');
  expect(kind('https://signal.group/#CjQKIDemoGroupLink')).toBe('Signal group link');
  expect(kind('matrix.to/#/#rust-gamedev:matrix.org')).toBe('Matrix room');
  expect(kind('t.me/dithernews')).toBe('Telegram channel, group or person');
  expect(shortLink('https://discord.gg/pixelart')).toBe('discord.gg/pixelart');
  expect(shortLink(`https://signal.group/#${'x'.repeat(80)}`)).toHaveLength(44);
});

test('an invite written without https:// is a link in the message, as Telegram shows it', () => {
  const md = (s: string) => renderMarkdown(s, { network: 'telegram', user: () => null, room: () => null });
  expect(md('the group is t.me/+FilmSwap2026x if you want in')).toBe('the group is <a href="https://t.me/+FilmSwap2026x" target="_blank" rel="noreferrer noopener">t.me/+FilmSwap2026x</a> if you want in');
  expect(md('https://discord.gg/x')).toBe('<a href="https://discord.gg/x" target="_blank" rel="noreferrer noopener">https://discord.gg/x</a>');
  expect(md('see next.me/x')).toBe('see next.me/x');
});
