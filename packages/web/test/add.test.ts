import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { addRows, expiresIn, isLink, messagePeer, offlineNetworks, partialLine, previewCounts, previewKind } from '../src/add.ts';

const acc = (id: string, network: P.Network, capabilities: P.Capability[], status: P.AccountStatus = 'online') => ({ id, network, status, capabilities }) as P.AccountView;
const LOOK: P.Capability[] = ['openDirect', 'resolve', 'join', 'connect'];

test('one row per reading whose network has a connected account, in parseAdd order', () => {
  const all = [acc('tg', 'telegram', LOOK), acc('x', 'x', ['send']), acc('ig', 'instagram', LOOK, 'offline')];
  const rows = addRows('@lena_k', all);
  expect(rows.map((r) => [r.label, r.state.kind])).toEqual([
    ['Telegram @lena_k', 'resolve'],
    ['X @lena_k', 'unbuilt'],
  ]);
  expect(rows[1].state).toEqual({ kind: 'unbuilt', line: "Adding people on X isn't built for this account yet" });
});

test("an invite on a network whose accounts cannot resolve is a plain line, never a button", () => {
  const rows = addRows('https://discord.gg/rust', [acc('d', 'discord', ['send', 'openDirect'])]);
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toEqual({ kind: 'unbuilt', line: "Joining from Discord invites isn't built for this account yet" });
});

test('without resolve, someone openDirect can reach still gets Message, as New message always did', () => {
  const rows = addRows('@ann:matrix.org', [acc('m', 'matrix', ['openDirect'])]);
  expect(rows[0].state).toMatchObject({ kind: 'direct', peer: '@ann:matrix.org' });
  const phone = addRows('+1 555 123 4567', [acc('s', 'signal', ['openDirect']), acc('w', 'whatsapp', LOOK)]);
  expect(phone.map((r) => [r.ref.network, r.state.kind])).toEqual([
    ['signal', 'direct'],
    ['whatsapp', 'resolve'],
  ]);
  // A Discord username is not something openDirect takes.
  expect(addRows('mara', [acc('d', 'discord', ['openDirect'])])[0].state.kind).toBe('unbuilt');
});

test('only accounts that can resolve are offered to look it up', () => {
  const rows = addRows('discord.gg/rust', [acc('a', 'discord', LOOK), acc('b', 'discord', ['send']), acc('c', 'discord', LOOK, 'offline'), acc('d', 'discord', LOOK)]);
  expect(rows[0].state.kind === 'resolve' && rows[0].state.accounts.map((a) => a.id)).toEqual(['a', 'd']);
});

test('nothing connected on the network: no row, and which network it was', () => {
  expect(addRows('#rust:matrix.org', [acc('d', 'discord', LOOK)])).toEqual([]);
  expect(offlineNetworks('#rust:matrix.org', [acc('d', 'discord', LOOK)])).toEqual(['matrix']);
});

test('links resolve at once; a bare word or @name waits for a click', () => {
  for (const s of ['https://discord.gg/rust', 'discord.gg/rust', 'tg://join?invite=AbCdEf_123', '#rust:matrix.org', '!abc:matrix.org', 'https://matrix.to/#/@a:b.org']) expect({ s, link: isLink(s) }).toEqual({ s, link: true });
  for (const s of ['@lena_k', 'mara', '+15551234567', 'priya.07', '@a:b.org']) expect({ s, link: isLink(s) }).toEqual({ s, link: false });
});

test('the card says what it is, its counts, when it runs out, and what a partial preview cannot say', () => {
  expect(previewKind({ what: 'space' }, 'discord')).toBe('Discord server');
  expect(previewKind({ what: 'channel' }, 'telegram')).toBe('Telegram channel');
  expect(previewKind({ what: 'person' }, 'telegram')).toBe('Person on Telegram');
  expect(previewCounts({ members: 5321, online: 802 })).toBe('5,321 members · 802 online');
  expect(previewCounts({ members: 1, online: null })).toBe('1 member');
  expect(previewCounts({ members: null, online: null })).toBeNull();
  expect(expiresIn(6 * 86_400_000 + 1000, 0)).toBe('Invite runs out in 6 days');
  expect(expiresIn(3 * 3_600_000, 0)).toBe('Invite runs out in 3 hours');
  expect(partialLine(['join'])).toBe("Can't preview this without joining");
  expect(partialLine(['friend'])).toBe("Can't preview this without asking");
});

test('Message reaches them by the id the network gave, else by what was typed', () => {
  expect(messagePeer({ nativeId: '123456789012345678', ref: { kind: 'person', network: 'discord', handle: '123456789012345678' } })).toBe('123456789012345678');
  expect(messagePeer({ nativeId: null, ref: { kind: 'name', network: 'telegram', name: 'lena_k' } })).toBe('@lena_k');
  expect(messagePeer({ nativeId: null, ref: { kind: 'person', network: 'discord', handle: 'mara' } })).toBeNull();
});
