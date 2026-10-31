/**
 * The reaction model against a real Store: the semantics each network needs, in one place.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let discord: AccountRow;
let alt: AccountRow;
let signal: AccountRow;
let seq = 0;

const SELF = 'me';
const conv = (acc: AccountRow, id: string) => store.ingest(acc, { t: 'conversation', conversation: { nativeId: id, shape: 'group', name: id } });

function post(acc: AccountRow, conversation: string, reactions?: P.ReactionFact[]) {
  const nativeId = `m${++seq}`;
  store.ingest(acc, { t: 'message', live: false, message: { nativeId, conversation, author: 'someone', ts: 1000 + seq, body: 'hi', ...(reactions ? { reactions } : {}) } });
  return nativeId;
}
const view = (acc: AccountRow, nativeId: string) => store.messageView(hubId('msg', acc.network, nativeId))!;
const pills = (acc: AccountRow, nativeId: string) => view(acc, nativeId).reactions.map((r) => [r.key, r.style, r.count, r.identityIds.length]);
const react = (acc: AccountRow, message: string, author: string, key: string, more: Partial<Extract<P.AdapterEvent, { t: 'reaction' }>> = {}) =>
  store.ingest(acc, { t: 'reaction', conversation: 'c', message, author, key, ...more });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-rx-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  discord = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
  alt = store.createAccount({ network: 'discord', label: 'alt', color: '#111', adapter: 'discord' });
  signal = store.createAccount({ network: 'signal', label: 'signal', color: '#222', adapter: 'signal' });
  store.ingest(discord, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true } });
  store.ingest(alt, { t: 'status', status: 'online', self: { nativeId: 'alt-me', isSelf: true } });
  store.ingest(signal, { t: 'status', status: 'online', self: { nativeId: 'sig-me', isSelf: true } });
  discord = store.account(discord.id)!;
  alt = store.account(alt.id)!;
  signal = store.account(signal.id)!;
  conv(discord, 'c');
  conv(alt, 'c');
  conv(signal, 'c');
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('networks that name every reactor', () => {
  test('count is the people named, and a person counts once', () => {
    const m = post(signal, 'c', [{ key: '🔥', authors: ['a', 'b'] }]);
    expect(pills(signal, m)).toEqual([['🔥', 'normal', 2, 2]]);
    react(signal, m, 'a', '🔥');
    expect(pills(signal, m)).toEqual([['🔥', 'normal', 2, 2]]);
  });

  test('an empty reaction disappears', () => {
    const m = post(discord, 'c');
    react(discord, m, 'a', '👍');
    react(discord, m, 'a', '👍', { remove: true });
    expect(view(discord, m).reactions).toEqual([]);
  });
});

describe('Signal: one reaction per person', () => {
  test('a new reaction replaces your old one; other people keep theirs', () => {
    const m = post(signal, 'c');
    react(signal, m, 'a', '👍');
    react(signal, m, 'b', '👍');
    react(signal, m, 'a', '🔥');
    expect(pills(signal, m)).toEqual([['👍', 'normal', 1, 1], ['🔥', 'normal', 1, 1]]);
    react(signal, m, 'b', '🔥');
    expect(pills(signal, m)).toEqual([['🔥', 'normal', 2, 2]]);
  });
});

describe('Discord: totals without names', () => {
  test('a snapshot shows the total, not the names we happen to know', () => {
    const m = post(discord, 'c', [{ key: '🎉', count: 40, authors: [SELF] }, { key: 'party:7', count: 3, authors: [], emoji: { key: 'party:7', name: 'party', url: 'https://x/7.webp', animated: true } }]);
    const [a, b] = view(discord, m).reactions;
    expect([a.count, a.identityIds.length]).toEqual([40, 1]);
    expect([b.count, b.emoji]).toEqual([3, { key: 'party:7', name: 'party', url: 'https://x/7.webp', animated: true }]);
  });

  test('live events move the total; a name we did not know can still leave', () => {
    const m = post(discord, 'c', [{ key: '🎉', count: 40, authors: [] }]);
    react(discord, m, 'x', '🎉');
    expect(pills(discord, m)).toEqual([['🎉', 'normal', 41, 1]]);
    react(discord, m, 'x', '🎉'); // the gateway's echo of what the adapter already said
    expect(pills(discord, m)).toEqual([['🎉', 'normal', 41, 1]]);
    react(discord, m, 'stranger', '🎉', { remove: true });
    expect(pills(discord, m)).toEqual([['🎉', 'normal', 40, 1]]);
  });

  test('your own removal echoed by the gateway only counts once', () => {
    const m = post(discord, 'c', [{ key: '🎉', count: 5, authors: [SELF] }]);
    react(discord, m, SELF, '🎉', { remove: true });
    react(discord, m, SELF, '🎉', { remove: true });
    expect(pills(discord, m)).toEqual([['🎉', 'normal', 4, 0]]);
  });

  test('super and normal are separate, and the same person can do both', () => {
    const m = post(discord, 'c');
    react(discord, m, 'a', '🎉', { style: 'super', colors: ['#f00', '#0f0'] });
    react(discord, m, 'a', '🎉');
    const rs = view(discord, m).reactions;
    expect(rs.map((r) => [r.style, r.count, r.colors])).toEqual([['super', 1, ['#f00', '#0f0']], ['normal', 1, undefined]]);
    react(discord, m, 'a', '🎉', { style: 'super', remove: true });
    expect(pills(discord, m)).toEqual([['🎉', 'normal', 1, 1]]);
  });

  test('a later snapshot keeps names we learned, and drops what is gone', () => {
    const m = post(discord, 'c', [{ key: '🎉', count: 2, authors: [] }, { key: '🔥', count: 1, authors: [] }]);
    store.addKnownReactors(discord, hubId('msg', 'discord', m), '🎉', 'normal', ['a', 'b']);
    expect(pills(discord, m)[0]).toEqual(['🎉', 'normal', 2, 2]);
    store.ingest(discord, { t: 'message', live: false, message: { nativeId: m, conversation: 'c', author: 'someone', ts: 1, body: 'hi', reactions: [{ key: '🎉', count: 3, authors: [] }] } });
    expect(pills(discord, m)).toEqual([['🎉', 'normal', 3, 2]]);
  });

  test('a snapshot saying you did not react takes your name off, without touching other accounts', () => {
    const m = post(discord, 'c', [{ key: '🎉', count: 2, authors: [SELF] }]);
    store.ingest(alt, { t: 'message', live: false, message: { nativeId: m, conversation: 'c', author: 'someone', ts: 1, body: 'hi', reactions: [{ key: '🎉', count: 2, authors: ['alt-me'] }] } });
    expect(view(discord, m).reactions[0].identityIds.length).toBe(2);
    store.ingest(discord, { t: 'message', live: false, message: { nativeId: m, conversation: 'c', author: 'someone', ts: 1, body: 'hi', reactions: [{ key: '🎉', count: 1, authors: [] }] } });
    expect(view(discord, m).reactions[0].identityIds).toEqual([hubId('idn', 'discord', 'alt-me')]);
  });

  test('moderators can clear one reaction or all of them', () => {
    const m = post(discord, 'c', [{ key: '🎉', count: 2, authors: [] }, { key: '🔥', count: 1, authors: ['a'] }]);
    store.ingest(discord, { t: 'reactionsCleared', conversation: 'c', message: m, key: '🎉' });
    expect(pills(discord, m)).toEqual([['🔥', 'normal', 1, 1]]);
    store.ingest(discord, { t: 'reactionsCleared', conversation: 'c', message: m });
    expect(view(discord, m).reactions).toEqual([]);
  });

  test('taking a reaction back goes through the account that made it', () => {
    const m = post(discord, 'c');
    react(alt, m, 'alt-me', '🎉');
    expect(store.reactionAccount(hubId('msg', 'discord', m), '🎉', 'normal')).toBe(alt.id);
    expect(store.reactionAccount(hubId('msg', 'discord', m), '🔥', 'normal')).toBeNull();
  });
});

describe('every network', () => {
  test('spellings of one emoji are one reaction', () => {
    const m = post(discord, 'c');
    react(discord, m, 'a', '❤');
    react(discord, m, 'b', '❤️');
    expect(pills(discord, m)).toEqual([['❤️', 'normal', 2, 2]]);
  });

  test('a reaction is not news: it never turns a message live', () => {
    store.flush();
    const m = post(discord, 'c');
    store.flush();
    react(discord, m, 'a', '👍');
    const ev = store.flush().find((e) => e.t === 'message') as Extract<P.ClientEvent, { t: 'message' }>;
    expect(ev.message.reactions[0].key).toBe('👍');
    expect(ev.live).toBe(false);
  });

  test('your usage feeds the quick row, per network', () => {
    const m = post(signal, 'c');
    react(signal, m, 'sig-me', '🫡');
    const usage = store.bootstrap().reactionUsage;
    expect(usage.find((u) => u.key === '🫡')).toMatchObject({ network: 'signal', count: 1 });
  });

  test('offered emoji are remembered for later reactions', () => {
    const v = store.reactionContextView(discord.id, 'discord', { canReact: true, custom: [{ id: 'g', name: 'Guild', emoji: [{ key: 'blob:1', name: 'blob', url: 'https://x/1.webp' }] }], super: { available: false } });
    expect(v.custom[0].emoji[0]).toEqual({ key: 'blob:1', name: 'blob', url: 'https://x/1.webp', animated: false });
    expect(store.customEmoji('discord', 'blob:1')?.name).toBe('blob');
    const m = post(discord, 'c');
    react(discord, m, 'a', 'blob:1');
    expect(view(discord, m).reactions[0].emoji?.name).toBe('blob');
  });
});

describe('upgrading a database from before tallies', () => {
  test('old rows become reactions, with spellings merged', () => {
    const path = join(dir, 'old.sqlite');
    const seedStore = new Store(path, (raw) => raw ?? null);
    const acc = seedStore.createAccount({ network: 'signal', label: 's', color: '#333', adapter: 'signal' });
    seedStore.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c', shape: 'group', name: 'c' } });
    seedStore.ingest(acc, { t: 'message', live: false, message: { nativeId: 'm', conversation: 'c', author: 'a', ts: 1, body: 'hi' } });
    seedStore.ingest(acc, { t: 'identity', identity: { nativeId: 'b', displayName: 'B' } });
    seedStore.db.close();

    const raw = new Database(path);
    raw.exec(`DROP TABLE reaction; DROP TABLE reaction_tally;
      CREATE TABLE reaction (message_id TEXT NOT NULL, identity_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (message_id, identity_id, key));`);
    const mid = hubId('msg', 'signal', 'm');
    raw.query('INSERT INTO reaction VALUES (?, ?, ?)').run(mid, hubId('idn', 'signal', 'a'), '❤');
    raw.query('INSERT INTO reaction VALUES (?, ?, ?)').run(mid, hubId('idn', 'signal', 'b'), '❤️');
    raw.close();

    const upgraded = new Store(path, (r) => r ?? null);
    expect(upgraded.messageView(mid)!.reactions.map((r) => [r.key, r.style, r.count])).toEqual([['❤️', 'normal', 2]]);
    upgraded.db.close();
  });
});
