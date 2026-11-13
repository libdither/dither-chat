/**
 * What the page makes of a network's own attention settings: requests the network filed as spam (last, and off the
 * Requests row's count) and its own mute ("Mute on Discord").
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { canMuteOnNetwork, canUnmute, networkMuteLine } from '../src/nativemute.ts';
import { groupRequests, requestsRow, SPAM_TITLE } from '../src/requests.ts';

const req = (id: string, kind: P.RequestView['kind'], ts: number, spam = false): P.RequestView => ({
  id,
  accountId: 'acc',
  network: 'discord',
  nativeId: id,
  kind,
  from: id,
  target: null,
  ts,
  answers: ['accept', 'decline'],
  warning: spam ? 'Discord filed this message as spam' : null,
  ...(spam ? { spam: true } : {}),
});

test('spam waits last, under a heading of its own, newest first', () => {
  const g = groupRequests([req('s1', 'message', 9, true), req('m', 'message', 5), req('f', 'friend', 1), req('s2', 'message', 12, true)]);
  expect(g.map((x) => [x.title, x.requests.map((r) => r.id)])).toEqual([
    ['Friend requests', ['f']],
    ['Message requests', ['m']],
    [SPAM_TITLE, ['s2', 's1']],
  ]);
});

test("the Requests row counts no spam and names no spammer, but says it is there", () => {
  const names: Record<string, string> = { m: 'Jules', s: 'Free Nitro' };
  expect(requestsRow([req('m', 'message', 5), req('s', 'message', 9, true)], (id) => names[id!]!)).toEqual({ count: 1, names: ['Jules'], lastAt: 5, spam: 1 });
  expect(requestsRow([req('s', 'message', 9, true)], (id) => names[id!]!)).toEqual({ count: 0, names: [], lastAt: 9, spam: 1 });
  expect(requestsRow([req('m', 'message', 5)], (id) => names[id!]!)).toEqual({ count: 1, names: ['Jules'], lastAt: 5 });
});

test('Mute on Discord is offered only where an account can', () => {
  expect(canMuteOnNetwork([{ capabilities: ['send'] }, undefined])).toBe(false);
  expect(canMuteOnNetwork([{ capabilities: ['send'] }, { capabilities: ['send', 'mute'] }])).toBe(true);
});

test('how the mute on the network reads, and when Unmute applies', () => {
  const now = new Date(2026, 10, 12, 12).getTime();
  expect(networkMuteLine('discord', null, now)).toBe('Not muted on Discord');
  expect(networkMuteLine('discord', {}, now)).toBe('Not muted on Discord');
  expect(networkMuteLine('discord', { level: 'mentions' }, now)).toBe('Discord notifies only mentions here');
  expect(networkMuteLine('discord', { level: 'none', muted: true }, now)).toBe('Muted on Discord');
  expect(networkMuteLine('discord', { level: 'none' }, now)).toBe('Discord notifies nothing here');
  expect(networkMuteLine('discord', { level: 'none', muted: true, until: now + 3_600_000 }, now)).toMatch(/^Muted on Discord until 1:00/);
  // Run out: not muted any more.
  expect(networkMuteLine('discord', { level: 'none', muted: true, until: now - 1 }, now)).toBe('Not muted on Discord');
  expect(canUnmute({ level: 'none', muted: true }, now)).toBe(true);
  expect(canUnmute({ level: 'none' }, now)).toBe(false);
  expect(canUnmute({ level: 'none', muted: true, until: now - 1 }, now)).toBe(false);
});
