import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSearch, searchOps, setSearchOp, toggleSearchOp } from '@dither-chat/protocol';
import { editDistance, Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let d: AccountRow;
let s: AccountRow;

const say = (acc: AccountRow, nativeId: string, conversation: string, author: string, ts: number, body: string, more: object = {}) =>
  store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body, ...more } });
const find = (q: string) => store.search(q, 50).hits.map((h) => h.message.nativeId);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-search-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  s = store.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'alice', displayName: 'Alice Chen', handle: 'alice_c' } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'bob', displayName: 'Bob' } });
  store.ingest(s, { t: 'identity', identity: { nativeId: '+1', displayName: 'Carol' } });
  store.ingest(d, { t: 'space', space: { nativeId: 'g', kind: 'community', name: 'Rust Server' } });
  store.ingest(d, { t: 'space', space: { nativeId: 'sec', kind: 'section', name: 'Help', parents: [{ nativeId: 'g' }] } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'help', shape: 'channel', name: 'help', spaces: [{ nativeId: 'sec' }] } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'off', shape: 'channel', name: 'off-topic' } });
  store.ingest(s, { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Family' } });
  say(d, 'm1', 'help', 'alice', 1000, 'the borrow checker rejected my lifetime', { mentionsSelf: true });
  say(d, 'm2', 'help', 'bob', 2000, 'try cloning, the Borrow checker is strict');
  say(d, 'm3', 'off', 'bob', 3000, 'see https://example.com/a for borrow tips', { attachments: [{ kind: 'image', url: 'x', name: 'a.png' }] });
  say(s, 'm4', 'grp', '+1', new Date(2026, 0, 15).getTime(), 'Café dinner at seven?');
  say(s, 'm5', 'grp', '+1', 5000, '東京で会いましょう');
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the query language', () => {
  test('text, phrases, exclusions, operators', () => {
    const q = parseSearch('rust "borrow checker" -async from:alice in:"off topic" has:image mentions:me network:Discord sort:relevance');
    expect(q).toMatchObject({ terms: ['rust'], phrases: ['borrow checker'], not: ['async'], from: ['alice'], in: ['off topic'], has: ['image'], mentionsMe: true, network: ['discord'], relevance: true });
  });
  test('what is not an operator stays text', () => {
    expect(parseSearch('http://x.y foo:bar has:nonsense').terms).toEqual(['http://x.y', 'foo:bar', 'has:nonsense']);
  });
  test('filter buttons edit one operator', () => {
    expect(setSearchOp('hi from:bob', 'from', 'Alice Chen')).toBe('hi from:"Alice Chen"');
    expect(setSearchOp('hi from:"Alice Chen"', 'from', null)).toBe('hi');
  });
});

describe('matching', () => {
  test('words in any order, any case, newest first; the last word as a prefix', () => {
    expect(find('checker BORROW')).toEqual(['m2', 'm1']);
    expect(find('lifet')).toEqual(['m1']);
  });
  test('phrases and exclusions', () => {
    expect(find('"borrow tips"')).toEqual(['m3']);
    expect(find('borrow -cloning')).toEqual(['m3', 'm1']);
  });
  test('diacritics fold', () => expect(find('cafe')).toEqual(['m4']));
  test('nothing a user types is a syntax error', () => {
    for (const q of ['"', 'AND', 'a OR', 'NEAR(', '*', 'a:b', "'; DROP TABLE message;--", '(((', '-']) expect(() => store.search(q)).not.toThrow();
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message')!.n).toBe(5);
  });
  test('falls back to substrings for the inside of a word and CJK', () => {
    const r = store.search('京で');
    expect(r.mode).toBe('substring');
    expect(r.hits[0].message.nativeId).toBe('m5');
    expect(r.hits[0].snippet).toContain('\u0001京で\u0002');
    expect(store.search('orro').hits.length).toBe(3);
  });
  test('highlights in snippets', () => {
    expect(store.search('lifetime').hits[0].snippet).toContain('\u0001lifetime\u0002');
    expect(store.search('lifetime').mode).toBe('fulltext');
  });
});

describe('filters', () => {
  test('from a person, by display name or handle', () => {
    expect(find('borrow from:alice_c')).toEqual(['m1']);
    expect(find('from:Bob')).toEqual(['m3', 'm2']);
  });
  test('in a channel, or anywhere under a community through sections', () => {
    expect(find('borrow in:off-topic')).toEqual(['m3']);
    expect(find('borrow in:"Rust Server"')).toEqual(['m2', 'm1']);
    // The conversation header scopes by id: a direct chat has no name to match on.
    const help = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'help'`)!.id;
    expect(find(`borrow in:${help}`)).toEqual(['m2', 'm1']);
    expect(find(`in:${help}`)).toEqual(['m2', 'm1']);
  });
  test('network, attachment, link, mentions', () => {
    expect(find('network:signal').sort()).toEqual(['m4', 'm5']);
    expect(find('has:image')).toEqual(['m3']);
    expect(find('has:link')).toEqual(['m3']);
    expect(find('mentions:me')).toEqual(['m1']);
    expect(find('has:reaction')).toEqual([]);
  });
  test('date range', () => {
    expect(find('after:2026-01-14 before:2026-01-16')).toEqual(['m4']);
    expect(find('network:signal before:2026-01-01')).toEqual(['m5']);
  });
  test('an unknown name filters to nothing, not everything', () => expect(find('borrow from:nobody')).toEqual([]));
  test('people are found by name', () => {
    expect(store.search('alice').people.length).toBe(1);
  });
});

describe('staying current', () => {
  test('edits, deletions and removed accounts reach the index', () => {
    say(d, 'e1', 'off', 'bob', 6000, 'quizzical zebra');
    expect(find('zebra')).toEqual(['e1']);
    say(d, 'e1', 'off', 'bob', 6000, 'quizzical yak');
    expect(find('zebra')).toEqual([]);
    expect(find('yak')).toEqual(['e1']);
    store.ingest(d, { t: 'delete', conversation: 'off', nativeId: 'e1' });
    expect(find('yak')).toEqual([]);
    const x = store.createAccount({ network: 'matrix', label: 'x', color: '#222', adapter: 'matrix' });
    store.ingest(x, { t: 'conversation', conversation: { nativeId: 'r', shape: 'group', name: 'R' } });
    store.ingest(x, { t: 'message', message: { nativeId: 'gone', conversation: 'r', author: 'u', ts: 7000, body: 'ephemeral walrus' } });
    expect(find('walrus')).toEqual(['gone']);
    store.deleteAccount(x.id);
    expect(find('walrus')).toEqual([]);
    expect(() => store.db.exec(`INSERT INTO message_fts (message_fts) VALUES ('integrity-check')`)).not.toThrow();
  });
  test('a database from before full-text search is backfilled', () => {
    const p = join(dir, 'old.sqlite');
    const a = new Store(p, (r) => r ?? null);
    const acc = a.createAccount({ network: 'matrix', label: 'm', color: '#000', adapter: 'matrix' });
    a.ingest(acc, { t: 'conversation', conversation: { nativeId: 'r', shape: 'group', name: 'R' } });
    a.ingest(acc, { t: 'message', message: { nativeId: 'old', conversation: 'r', author: 'u', ts: 1, body: 'venerable tortoise' } });
    a.db.close();
    const raw = new Database(p);
    raw.exec(`DROP TRIGGER message_fts_insert; DROP TRIGGER message_fts_delete; DROP TRIGGER message_fts_update; DROP TABLE message_fts; DELETE FROM meta WHERE key = 'fts_backfilled';`);
    raw.close();
    const b = new Store(p, (r) => r ?? null);
    expect(b.search('tortoise').hits.map((h) => h.message.nativeId)).toEqual(['old']);
    b.db.close();
  });
  test('unspaced Japanese is found inside a longer run, even beside a whole-token hit', () => {
    say(d, 'ja1', 'off', 'bob', 20_000, '明日札幌で会いましょう');
    say(d, 'ja2', 'off', 'bob', 20_001, '札幌');
    expect(find('札幌').sort()).toEqual(['ja1', 'ja2']);
  });
  test('substring results page without repeating or stopping early', () => {
    for (let i = 0; i < 7; i++) say(d, `sub${i}`, 'off', 'bob', 30_000 + (i < 4 ? 0 : i), `xxquokkaxx ${i}`);
    for (const q of ['quokka', 'quokka sort:relevance']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r = store.search(q, 3, cursor);
        seen.push(...r.hits.map((h) => h.message.nativeId));
        cursor = r.next;
      } while (cursor);
      expect(new Set(seen).size).toBe(7);
      expect(seen.length).toBe(7);
    }
  });
  test('-word excludes in substring mode and with nothing else to search for', () => {
    say(d, 'neg1', 'off', 'bob', 40_000, 'yyocelotyy keep');
    say(d, 'neg2', 'off', 'bob', 40_001, 'yyocelotyy drop');
    expect(find('ocelot -drop')).toEqual(['neg1']);
    expect(find('from:bob -ocelot')).not.toContain('neg1');
    expect(find('-ocelot')).not.toContain('neg1');
  });
  test('pages do not repeat or skip', () => {
    for (let i = 0; i < 7; i++) say(d, `p${i}`, 'off', 'bob', 10_000 + (i < 4 ? 0 : i), 'pagination marmot');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = store.search('marmot', 3, cursor);
      seen.push(...r.hits.map((h) => h.message.nativeId));
      cursor = r.next;
    } while (cursor);
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe('jumping to a message', () => {
  test('gives what surrounds it, and says what lies beyond', () => {
    for (let i = 0; i < 9; i++) say(d, `j${i}`, 'help', 'bob', 20_000 + i, `line ${i}`);
    const id = store.search('"line 4"').hits[0].message.id;
    const c = store.messageContext(id, 2)!;
    expect(c.messages.map((m) => m.nativeId)).toEqual(['j2', 'j3', 'j4', 'j5', 'j6']);
    expect(c.hasMore).toBe(true);
    expect(c.hasNewer).toBe(true);
    expect(store.messagesAfter(c.messages[0].conversationId, 20_006, 10).messages.map((m) => m.nativeId)).toEqual(['j7', 'j8']);
  });
});

describe('more like Discord', () => {
  test('the new operators parse, and Discord spellings work', () => {
    const q = parseSearch('pinned:true is:edited has:sound has:embed mentions:Bob account:main sort:oldest during:2026-01');
    expect(q).toMatchObject({ is: ['pinned', 'edited'], has: ['audio', 'embed'], mentions: ['Bob'], account: ['main'], oldest: true, mentionsMe: false });
    expect(q.after).toBe(new Date(2026, 0, 1).getTime());
    expect(q.before).toBe(new Date(2026, 1, 1).getTime());
    const now = new Date(2026, 4, 10, 15);
    expect(parseSearch('during:yesterday', now)).toMatchObject({ after: new Date(2026, 4, 9).getTime(), before: new Date(2026, 4, 10).getTime() });
    expect(parseSearch('is:nonsense').terms).toEqual(['is:nonsense']);
  });
  test('repeating operators toggle one value at a time', () => {
    expect(toggleSearchOp('hi has:link', 'has', 'image')).toBe('hi has:link has:image');
    expect(toggleSearchOp('hi has:link has:image', 'has', 'link')).toBe('hi has:image');
    expect(searchOps('has:link x has:IMAGE', 'has')).toEqual(['link', 'image']);
  });
  test('during a day', () => expect(find('during:2026-01-15')).toEqual(['m4']));
  test('oldest first, and paging that way', () => {
    expect(find('borrow sort:oldest')).toEqual(['m1', 'm2', 'm3']);
    const a = store.search('borrow sort:oldest', 2);
    expect(store.search('borrow sort:oldest', 2, a.next).hits.map((h) => h.message.nativeId)).toEqual(['m3']);
  });
  test('mentions of someone by name', () => {
    say(d, 'mn1', 'off', 'alice', 50_000, 'ping <@bob> about the release');
    say(d, 'mn2', 'off', 'alice', 50_001, 'ping <@!bob> again');
    say(d, 'mn3', 'off', 'alice', 50_002, 'bob is away');
    expect(find('mentions:Bob')).toEqual(['mn2', 'mn1']);
    expect(find('ping mentions:alice')).toEqual([]);
  });
  test('pinned, as the last pin or unpin says', () => {
    say(d, 'pin1', 'off', 'bob', 51_000, 'rules of the house');
    say(d, 'pin2', 'off', 'bob', 51_001, 'old rules');
    store.ingest(d, { t: 'pin', conversation: 'off', message: 'pin1', pinned: true, ts: 52_000 });
    store.ingest(d, { t: 'pin', conversation: 'off', message: 'pin2', pinned: true, ts: 52_000 });
    store.ingest(d, { t: 'pin', conversation: 'off', message: 'pin2', pinned: false, ts: 53_000 });
    expect(find('rules is:pinned')).toEqual(['pin1']);
    expect(find('pinned:true')).toEqual(['pin1']);
  });
  test('edited, sticker, embed, account', () => {
    say(d, 'ed1', 'off', 'bob', 54_000, 'frobnicate first');
    say(d, 'ed1', 'off', 'bob', 54_000, 'frobnicate second', { editedTs: 54_500 });
    say(d, 'st1', 'off', 'bob', 54_001, 'frobnicate', { kind: 'sticker' });
    say(d, 'em1', 'off', 'bob', 54_002, 'frobnicate https://x.test', { extra: { embeds: [{ url: 'https://x.test', title: 'X' }] } });
    expect(find('frobnicate is:edited')).toEqual(['ed1']);
    expect(find('frobnicate has:sticker')).toEqual(['st1']);
    expect(find('frobnicate has:embed')).toEqual(['em1']);
    expect(find('frobnicate account:d').length).toBe(3);
    expect(find('frobnicate account:s')).toEqual([]);
    expect(find('cafe account:S')).toEqual(['m4']);
  });
  test('kept deleted messages only when asked for, with adversarial features shown, and not when set to stay hidden', () => {
    store.setRetention({ ...store.retention(), adversarial: true, deleted: true });
    say(d, 'del1', 'off', 'bob', 55_000, 'regrettable platypus');
    store.ingest(d, { t: 'delete', conversation: 'off', nativeId: 'del1' });
    expect(find('platypus')).toEqual([]);
    expect(find('platypus is:deleted')).toEqual(['del1']);
    expect(find('is:deleted')).toContain('del1');
    store.setRetention({ ...store.retention(), show: 'hidden' });
    expect(find('platypus is:deleted')).toEqual([]);
    store.setRetention({ ...store.retention(), show: 'collapsed', adversarial: false });
    expect(find('platypus is:deleted')).toEqual([]);
    store.setRetention({ ...store.retention(), adversarial: true });
  });
  test('context around each hit', () => {
    for (let i = 0; i < 5; i++) say(s, `cx${i}`, 'grp', '+1', 60_000 + i, i === 2 ? 'the kettle is on' : `chatter ${i}`);
    const h = store.search('kettle', 10, null, 2).hits[0];
    expect(h.before!.map((m) => m.nativeId)).toEqual(['cx0', 'cx1']);
    expect(h.after!.map((m) => m.nativeId)).toEqual(['cx3', 'cx4']);
    expect(store.search('kettle').hits[0].before).toBeUndefined();
  });
  test('a misspelt word is corrected when nothing matches as typed', () => {
    say(d, 'ty1', 'off', 'bob', 56_000, 'the rhinoceros charged');
    say(d, 'ty2', 'off', 'bob', 56_001, 'definitely tomorrow');
    let r = store.search('rhinocerus charged');
    expect(r.corrected).toBe('rhinoceros charged');
    expect(r.hits.map((h) => h.message.nativeId)).toEqual(['ty1']);
    r = store.search('defintely from:bob');
    expect(r.corrected).toBe('definitely from:bob');
    expect(store.search('rhinoceros').corrected).toBeUndefined();
    // A word that is there but not with the others is no typo.
    expect(store.search('rhinoceros tomorrow').corrected).toBeUndefined();
    expect(store.search('xqzvw').hits).toEqual([]);
  });
  test('edit distance counts a swap as one', () => {
    expect(editDistance('teh', 'the', 2)).toBe(1);
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3);
  });
});
