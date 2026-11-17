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

describe('when each reacted (docs/reactions.md "When")', () => {
  const T = Date.UTC(2025, 0, 2, 12);
  const who = (acc: AccountRow, native: string) => hubId('idn', acc.network, native);
  const mid = (acc: AccountRow, native: string) => hubId('msg', acc.network, native);

  test("the network's time, or when the hub heard where it gives none", () => {
    const s = post(signal, 'c');
    react(signal, s, 'a', '👍', { ts: T });
    expect(view(signal, s).reactions[0]).toMatchObject({ at: { [who(signal, 'a')]: T } });
    expect(view(signal, s).reactions[0].seenAt).toBeUndefined();
    const heard = Date.now();
    const d = post(discord, 'c');
    react(discord, d, 'a', '👍');
    const r = view(discord, d).reactions[0];
    expect(r.at).toBeUndefined();
    expect(r.seenAt![who(discord, 'a')]).toBeGreaterThanOrEqual(heard);
  });

  test('seconds, or a time days ahead, are no time: the hub keeps when it heard', () => {
    const s = post(signal, 'c');
    react(signal, s, 'a', '👍', { ts: T / 1000 });
    react(signal, s, 'b', '👍', { ts: Date.now() + 7 * 86_400_000 });
    const r = view(signal, s).reactions[0];
    expect(r.at).toBeUndefined();
    expect(Object.keys(r.seenAt!).sort()).toEqual([who(signal, 'a'), who(signal, 'b')].sort());
  });

  test("the network's time replaces when the hub heard: your own reaction, echoed with its time", () => {
    const s = post(signal, 'c');
    react(signal, s, 'sig-me', '👍');
    react(signal, s, 'sig-me', '👍', { ts: T });
    expect(view(signal, s).reactions[0].at).toEqual({ [who(signal, 'sig-me')]: T });
    expect(view(signal, s).reactions[0].seenAt).toBeUndefined();
  });

  test('taken back and made again: the list of who reacted and Message history have each time', () => {
    const s = post(signal, 'c');
    react(signal, s, 'a', '👍', { ts: T });
    react(signal, s, 'a', '👍', { ts: T + 60_000, remove: true });
    react(signal, s, 'a', '👍', { ts: T + 120_000 });
    const v = store.reactorsView(mid(signal, s), '👍', 'normal');
    expect(v.at).toEqual({ [who(signal, 'a')]: T + 120_000 });
    expect(v.takenBack).toEqual([{ identityId: who(signal, 'a'), at: T + 60_000, added: T }]);
    const h = store.messageHistory(mid(signal, s))!;
    expect(h.reactions).toEqual([{ identityId: who(signal, 'a'), key: '👍', style: 'normal', at: T + 120_000 }]);
    expect(h.events).toEqual([{ kind: 'unreact', at: T + 60_000, actorId: who(signal, 'a'), data: { key: '👍', style: 'normal', added: T } }]);
  });

  test('on Signal a new reaction takes the old one back, at its own time', () => {
    const s = post(signal, 'c');
    react(signal, s, 'a', '👍', { ts: T });
    react(signal, s, 'a', '🔥', { ts: T + 5000 });
    expect(store.reactorsView(mid(signal, s), '👍', 'normal').takenBack).toEqual([{ identityId: who(signal, 'a'), at: T + 5000, added: T }]);
  });

  test('your own taken back are not kept', () => {
    const s = post(signal, 'c');
    react(signal, s, 'sig-me', '👍', { ts: T });
    react(signal, s, 'sig-me', '👍', { ts: T + 1000, remove: true });
    expect(store.reactorsView(mid(signal, s), '👍', 'normal').takenBack).toEqual([]);
  });

  test('a snapshot: none on a message new to the hub, when it heard on one it had, the network\'s own where given', () => {
    const d = post(discord, 'c', [{ key: '🎉', count: 2, authors: [SELF] }]);
    expect([view(discord, d).reactions[0].at, view(discord, d).reactions[0].seenAt]).toEqual([undefined, undefined]);
    store.ingest(discord, { t: 'message', live: false, message: { nativeId: d, conversation: 'c', author: 'someone', ts: 1, body: 'hi', reactions: [{ key: '🎉', count: 2, authors: [SELF, 'b'] }] } });
    expect(view(discord, d).reactions[0].seenAt).toEqual({ [who(discord, 'b')]: expect.any(Number) });
    const s = post(signal, 'c', [{ key: '🔥', authors: ['a'], at: { a: T } }]);
    expect(view(signal, s).reactions[0].at).toEqual({ [who(signal, 'a')]: T });
  });

  test('a full list again keeps the times the hub had', () => {
    const s = post(signal, 'c');
    react(signal, s, 'a', '🔥', { ts: T });
    store.ingest(signal, { t: 'message', live: false, message: { nativeId: s, conversation: 'c', author: 'someone', ts: 1, body: 'hi', reactions: [{ key: '🔥', authors: ['a', 'b'] }] } });
    expect(view(signal, s).reactions[0]).toMatchObject({ at: { [who(signal, 'a')]: T }, seenAt: { [who(signal, 'b')]: expect.any(Number) } });
  });

  test('names behind a total come at no known time, unless the network says', () => {
    const d = post(discord, 'c', [{ key: '🎉', count: 2, authors: [] }]);
    store.addKnownReactors(discord, mid(discord, d), '🎉', 'normal', ['a', 'b'], { a: T });
    expect([view(discord, d).reactions[0].at, view(discord, d).reactions[0].seenAt]).toEqual([{ [who(discord, 'a')]: T }, undefined]);
  });

  test('an import fills in times the hub did not have, and a dry run only counts them', () => {
    const s = post(signal, 'c', [{ key: '❤️', authors: ['a'] }]);
    const again = (dryRun: boolean) =>
      store.importBatch(
        signal,
        { conversation: { nativeId: 'c', shape: 'group', name: 'c' }, identities: [], messages: [{ nativeId: s, conversation: 'c', author: 'someone', ts: 1, body: 'hi', reactions: [{ key: '❤️', authors: ['a'], at: { a: T } }] }] },
        { sourceSha: 'sha', runId: 'r', dryRun, archiveNew: false, first: true },
      );
    expect(again(true).filled).toBe(1);
    expect(view(signal, s).reactions[0].at).toBeUndefined();
    expect(again(false).filled).toBe(1);
    expect(view(signal, s).reactions[0].at).toEqual({ [who(signal, 'a')]: T });
    expect(again(false)).toMatchObject({ filled: 0, same: 1 });
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
