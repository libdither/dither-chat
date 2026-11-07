/**
 * The people graph (graph.ts): people collapse their identities, a category counts toward its server, each
 * person–place pair is one link with every source it came from, you are left out, and members seen are used only
 * while the adversarial members setting is on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION, GRAPH_SOURCE } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { peopleGraph } from '../src/graph.ts';
import { Store, type AccountRow } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-graph-'));
let store: Store;
let d1: AccountRow;
let d2: AccountRow;
let sg: AccountRow;
const ON: P.RetentionSettings = { ...DEFAULT_RETENTION, adversarial: true, members: true };
const G = hubId('spc', 'discord', 'g1');
const H = hubId('spc', 'discord', 'g2');
const GROUP = hubId('cnv', 'signal', 'group:x');
const did = (n: string) => hubId('idn', 'discord', n);
const sid = (n: string) => hubId('idn', 'signal', n);

/** Links as readable triples: person name, place id, sources. */
function named(g: P.PeopleGraph) {
  const out: [string, string, number][] = [];
  for (let i = 0; i < g.links.length; i += 3) out.push([g.people[g.links[i]].name, g.places[g.links[i + 1]].id, g.links[i + 2]]);
  return out.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d1 = store.createAccount({ network: 'discord', label: 'main', color: '#111', adapter: 'discord' });
  d2 = store.createAccount({ network: 'discord', label: 'alt', color: '#222', adapter: 'discord' });
  sg = store.createAccount({ network: 'signal', label: 's', color: '#333', adapter: 'signal' });
  store.ingest(d1, { t: 'status', status: 'online', self: { nativeId: 'me1', displayName: 'Me', isSelf: true } });
  store.ingest(d2, { t: 'status', status: 'online', self: { nativeId: 'me2', displayName: 'Me too', isSelf: true } });
  store.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'mes', displayName: 'Me', isSelf: true } });
  for (const a of ['ann', 'bob', 'cy', 'dee', 'eve']) store.ingest(d1, { t: 'identity', identity: { nativeId: a, displayName: a.toUpperCase() } });
  store.ingest(sg, { t: 'identity', identity: { nativeId: 'ann-s', displayName: 'Ann on Signal' } });
  store.ingest(sg, { t: 'identity', identity: { nativeId: 'fay', displayName: 'FAY' } });
  // g1 seen by both Discord accounts, with a category under it; g2 by the main one only.
  for (const acc of [d1, d2]) store.ingest(acc, { t: 'space', space: { nativeId: 'g1', kind: 'community', name: 'Guild one' } });
  store.ingest(d1, { t: 'space', space: { nativeId: 'cat', kind: 'section', name: 'Talk', parents: [{ nativeId: 'g1' }] } });
  store.ingest(d1, { t: 'space', space: { nativeId: 'g2', kind: 'community', name: 'Guild two' } });
  // A channel in the category that lists its members.
  store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'ch', shape: 'channel', name: 'general', spaces: [{ nativeId: 'cat' }], participants: ['me1', 'dee'] } });
  // Direct chats make people: Ann on Discord (main) and on Signal, merged into one; Bob on the alt.
  store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me1', 'ann'] } });
  store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm:mes:ann-s', shape: 'direct', participants: ['mes', 'ann-s'] } });
  store.ingest(d2, { t: 'conversation', conversation: { nativeId: 'dm-bob', shape: 'direct', participants: ['me2', 'bob'] } });
  store.mergePersons(store.ensurePerson(did('ann')), store.ensurePerson(sid('ann-s')));
  // A Signal group with Ann and Fay.
  store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'group:x', shape: 'group', name: 'Friends', participants: ['mes', 'ann-s', 'fay'] } });
  // Cy's profile, asked through the main account, named g2 and a server the hub does not know.
  store.db
    .query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)')
    .run(did('cy'), d1.id, JSON.stringify({ mutualSpaces: [{ id: 'g2' }, { id: 'unknown' }], bio: 'not sent' }), 1);
  // Ann's profile names g1, which members seen also say.
  store.db.query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)').run(did('ann'), d1.id, JSON.stringify({ mutualSpaces: [{ id: 'g1' }] }), 1);
  // Members seen in g1, recorded while the setting is on; Eve only this way.
  store.setRetention(ON);
  store.ingest(d1, { t: 'members', space: 'g1', source: 'seen', members: [{ who: 'ann' }, { who: 'bob' }, { who: 'eve' }, { who: 'me1' }], total: 40 });
  store.ingest(d2, { t: 'members', space: 'g1', source: 'seen', members: [{ who: 'ann' }, { who: 'bob' }] });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('with members recorded', () => {
  test('people collapse their identities; groups and servers are places', () => {
    store.setRetention(ON);
    const g = peopleGraph(store);
    expect(g.members).toBe(true);
    const ann = g.people.find((p) => p.name === 'ANN')!;
    expect(ann.identity).toBeUndefined();
    expect(ann.networks.sort()).toEqual(['discord', 'signal']);
    expect(g.people.filter((p) => p.name === 'ANN' || p.name === 'Ann on Signal')).toHaveLength(1);
    expect(g.people.find((p) => p.name === 'EVE')).toMatchObject({ id: did('eve'), identity: true });
    expect(g.places.map((p) => [p.id, p.kind]).sort()).toEqual([[GROUP, 'group'], [G, 'space'], [H, 'space']].sort());
    expect(g.places.find((p) => p.id === G)!.total).toBe(40);
  });

  test('each pair once, with every source; a category counts toward its server; you are left out', () => {
    const g = peopleGraph(store);
    expect(named(g)).toEqual([
      ['ANN', GROUP, GRAPH_SOURCE.participant],
      ['ANN', G, GRAPH_SOURCE.members | GRAPH_SOURCE.profile],
      ['BOB', G, GRAPH_SOURCE.members],
      ['CY', H, GRAPH_SOURCE.profile],
      ['DEE', G, GRAPH_SOURCE.participant],
      ['EVE', G, GRAPH_SOURCE.members],
      ['FAY', GROUP, GRAPH_SOURCE.participant],
    ]);
    const pairs = new Set<string>();
    for (let i = 0; i < g.links.length; i += 3) pairs.add(`${g.links[i]}:${g.links[i + 1]}`);
    expect(pairs.size).toBe(g.links.length / 3);
    expect(g.people.some((p) => p.name.startsWith('Me'))).toBe(false);
  });

  test('which accounts see a place, and which have a direct chat with a person', () => {
    const g = peopleGraph(store);
    const ix = (a: AccountRow) => g.accounts.indexOf(a.id);
    expect(g.places.find((p) => p.id === G)!.accounts.sort()).toEqual([ix(d1), ix(d2)].sort());
    expect(g.places.find((p) => p.id === H)!.accounts).toEqual([ix(d1)]);
    expect(g.places.find((p) => p.id === GROUP)!.accounts).toEqual([ix(sg)]);
    expect(g.people.find((p) => p.name === 'ANN')!.dm.sort()).toEqual([ix(d1), ix(sg)].sort());
    expect(g.people.find((p) => p.name === 'BOB')!.dm).toEqual([ix(d2)]);
    expect(g.people.find((p) => p.name === 'EVE')!.dm).toEqual([]);
  });

  test('no message text or profile fields go out', () => {
    const s = JSON.stringify(peopleGraph(store));
    expect(s).not.toContain('not sent');
    expect(s).not.toContain('unknown');
  });
});

describe('with members not recorded', () => {
  test('members seen are not used, and who only they named is not there', () => {
    for (const r of [DEFAULT_RETENTION, { ...DEFAULT_RETENTION, members: true }, { ...ON, adversarial: false }]) {
      store.setRetention(r);
      const g = peopleGraph(store);
      expect(g.members).toBe(false);
      expect(named(g)).toEqual([
        ['ANN', GROUP, GRAPH_SOURCE.participant],
        ['ANN', G, GRAPH_SOURCE.profile],
        ['CY', H, GRAPH_SOURCE.profile],
        ['DEE', G, GRAPH_SOURCE.participant],
        ['FAY', GROUP, GRAPH_SOURCE.participant],
      ]);
      expect(g.people.find((p) => p.name === 'EVE' || p.name === 'BOB')).toBeUndefined();
      expect(g.places.find((p) => p.id === G)!.total).toBeUndefined();
    }
  });
});
