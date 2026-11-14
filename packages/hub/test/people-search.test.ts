import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let d: AccountRow;
let s: AccountRow;

const who = (id: string) => store.identitiesByIds([id])[0];
const names = (q: string) => store.findPeople(q).map((h) => who(h.id).displayName);
const matchOf = (q: string, name: string) => store.findPeople(q).find((h) => who(h.id).displayName === name)?.match;
const idOf = (network: string, nativeId: string) => store.db.query('SELECT id FROM identity WHERE network = ? AND native_id = ?').get(network, nativeId) as { id: string };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-people-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  s = store.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'big', shape: 'channel', name: 'general' } });
  // A crowd of strangers who talk a lot and share a word, and one person you know whose name says nothing of it.
  for (let i = 0; i < 20; i++) {
    store.ingest(d, { t: 'identity', identity: { nativeId: `q${i}`, displayName: `Quilla ${i}`, handle: `quilla${i}` } });
    for (let j = 0; j < 5; j++) store.ingest(d, { t: 'message', message: { nativeId: `q${i}m${j}`, conversation: 'big', author: `q${i}`, ts: i * 10 + j, body: 'hi' } });
  }
  store.ingest(d, { t: 'identity', identity: { nativeId: 'wren', displayName: 'Wren', handle: 'quillwrenfeather', contact: true } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'ferris', displayName: 'Ferris', handle: 'crab' } });
  store.ingest(s, { t: 'identity', identity: { nativeId: 'tanaka', displayName: '田中花子', handle: '+10' } });
  store.ingest(s, { t: 'identity', identity: { nativeId: 'zoe', displayName: 'Zoë', handle: '+11', contact: true } });
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('finding people', () => {
  test('a person you know comes up by their handle, ahead of strangers whose names match', () => {
    expect(store.findPeople('quill').length).toBe(12);
    expect(names('quill')[0]).toBe('Wren');
    expect(matchOf('quill', 'Wren')).toBe('\u0001quill\u0002wrenfeather');
  });
  test('words can land in different fields', () => {
    expect(names('wren quill')).toEqual(['Wren']);
  });
  test('a whole name beats the start of one', () => {
    expect(names('quilla 1')[0]).toBe('Quilla 1');
  });
  test('their bio and status, your note, and CJK', () => {
    const ferris = idOf('discord', 'ferris').id;
    store.db.query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)').run(ferris, d.id, JSON.stringify({ bio: 'I hack on a compiler for fun' }), 1);
    expect(names('compiler')).toEqual(['Ferris']);
    expect(matchOf('compiler', 'Ferris')).toContain('\u0001compiler\u0002');
    store.ingest(d, { t: 'customStatus', who: 'ferris', text: 'gardening today' });
    expect(names('gardening')).toEqual(['Ferris']);
    expect(names('zoë')).toEqual(['Zoë']);
    expect(names('田中')).toEqual(['田中花子']);
    store.updatePerson(who(idOf('signal', 'zoe').id).personId!, { note: 'met at the pottery class' });
    expect(names('pottery')).toEqual(['Zoë']);
    expect(matchOf('pottery', 'Zoë')).toBe('Note: met at the \u0001pottery\u0002 class');
  });
  test('a name from before a rename still finds them', () => {
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ferris', displayName: 'Crustacean' } });
    expect(names('ferris')).toEqual(['Crustacean']);
    expect(matchOf('ferris', 'Crustacean')).toBe('was \u0001Ferris\u0002');
  });
  test('one row per person, whichever account matched best', () => {
    store.ingest(s, { t: 'identity', identity: { nativeId: 'wren-sig', displayName: 'Wren Q', handle: '+12', contact: true } });
    const a = who(idOf('discord', 'wren').id).personId!;
    store.mergePersons(a, who(idOf('signal', 'wren-sig').id).personId!);
    expect(store.findPeople('wren').filter((h) => who(h.id).personId === a).length).toBe(1);
  });
  test('search pages carry them, with what matched', () => {
    const p = store.search('compiler').people;
    expect(p.map((x) => who(x.id).displayName)).toEqual(['Crustacean']);
    expect(p[0].match).toContain('compiler');
  });
});
