/**
 * Same person? (matches.ts, samepeople.ts): reading claims out of profiles, pairs found by what they share, each kind
 * of evidence, you and bots left out, decisions kept, merging, learning, picture hashes, and profiles collected only
 * with the adversarial switch on, at its pace.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { claimsOf, fitScales, jaroWinkler, nameHandle, norm, ownKeys, pairKey, phoneKey, puppetOf, run } from '../src/matches.ts';
import { keepAbout } from '../src/people.ts';
import { COLLECT_PACE, ProfileCollector, SameMatches } from '../src/samepeople.ts';
import { Store, type AccountRow } from '../src/store.ts';

const did = (n: string) => hubId('idn', 'discord', n);
const sid = (n: string) => hubId('idn', 'signal', n);
const xid = (n: string) => hubId('idn', 'x', n);
const mid = (n: string) => hubId('idn', 'matrix', n);

describe('reading profiles', () => {
  test('names and phone numbers compare as their letters and digits', () => {
    expect(norm('Ána-Lee_99')).toBe('analee99');
    expect(phoneKey('+1 (555) 010-0118')).toBe('5550100118');
    expect(phoneKey('12')).toBeNull();
    expect(jaroWinkler('annalee', 'annaleee')).toBeGreaterThan(0.95);
    expect(jaroWinkler('annalee', 'bobsmith')).toBeLessThan(0.6);
  });

  test("connected accounts, links in the bio, and contacts become claims; a site's own words are kept", () => {
    const c = claimsOf({
      links: [
        { label: 'X', value: 'ann_lee', url: 'https://x.com/ann_lee', verified: true },
        { label: 'GitHub', value: 'annlee', url: 'https://github.com/annlee' },
      ],
      bio: 'code at github.com/annlee · t.me/annlee_tg · mail ann@example.com · signal +1 555 0142',
    });
    const keys = c.map((x) => x.key).sort();
    expect(keys).toEqual(['email:ann@example.com', 'github:annlee', 'phone:15550142', 'telegram:annlee_tg', 'x:ann_lee'].sort());
    expect(c.find((x) => x.key === 'x:ann_lee')).toMatchObject({ network: 'x', handle: 'ann_lee', verified: true });
  });

  test('an account is known by its handle, number or address; a bridge stand-in by what it stands for', () => {
    expect(ownKeys({ network: 'x', native_id: '1', handle: '@Ann_Lee' }).map((k) => k.key)).toEqual(['x:ann_lee']);
    expect(ownKeys({ network: 'whatsapp', native_id: '15550142@s.whatsapp.net' }).map((k) => k.key)).toEqual(['phone:15550142']);
    expect(ownKeys({ network: 'signal', native_id: 'uuid-1', handle: '+1 555 0142' }).map((k) => k.key)).toEqual(['phone:15550142']);
    expect(puppetOf('@discord_700000000000000001:bridge.example')).toEqual({ network: 'discord', native: '700000000000000001' });
    expect(puppetOf('@whatsapp_15550142:bridge.example')).toEqual({ network: 'whatsapp', native: '15550142@s.whatsapp.net' });
    expect(puppetOf('@ann:matrix.example')).toBeNull();
  });

  test('a fit to decisions needs a few of each, and moves weights toward what was decided', () => {
    expect(fitScales([{ x: { name: 3 }, y: 1 }])).toBeNull();
    const rows = [
      ...Array.from({ length: 6 }, () => ({ x: { name: 3.7 }, y: 0 as const })),
      ...Array.from({ length: 6 }, () => ({ x: { claims: 5.5 }, y: 1 as const })),
    ];
    const f = fitScales(rows)!;
    expect(f.scales.name).toBeLessThan(1);
    expect(f.scales.claims).toBeGreaterThanOrEqual(1);
  });
});

describe('suggestions on a hub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-matches-'));
  let store: Store;
  let dc: AccountRow;
  let sg: AccountRow;
  let xa: AccountRow;
  let mx: AccountRow;

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
    sg = store.createAccount({ network: 'signal', label: 's', color: '#222', adapter: 'signal' });
    xa = store.createAccount({ network: 'x', label: 'x', color: '#333', adapter: 'x' });
    mx = store.createAccount({ network: 'matrix', label: 'm', color: '#444', adapter: 'matrix' });
    store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'me-d', displayName: 'Me', handle: 'me', isSelf: true } });
    store.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'me-s', displayName: 'Me', isSelf: true } });
    store.ingest(xa, { t: 'status', status: 'online', self: { nativeId: 'me-x', displayName: 'Me', handle: 'me', isSelf: true } });
    store.ingest(mx, { t: 'status', status: 'online', self: { nativeId: '@me:matrix.example', displayName: 'Me', isSelf: true } });
    // Ann: Discord, whose profile links her X account.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', handle: 'ann.l' } });
    store.ingest(xa, { t: 'identity', identity: { nativeId: '9001', displayName: 'Ann', handle: 'ann_lee' } });
    keepAbout(store, did('ann'), dc.id, 'discord', { links: [{ label: 'X', value: 'ann_lee', verified: true }] }, Date.now());
    // Bo: Discord, with his Signal number in the bio.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'bo', displayName: 'Bo', handle: 'bo.k' } });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'uuid-bo', displayName: 'Bo K', handle: '+1 555 0161' } });
    keepAbout(store, did('bo'), dc.id, 'discord', { bio: 'signal me: +1 555 0161' }, Date.now());
    // Cy: a bridge's stand-in on Matrix for Cy on Discord.
    store.ingest(dc, { t: 'identity', identity: { nativeId: '700000000000000003', displayName: 'Cyril', handle: 'cyril' } });
    store.ingest(mx, { t: 'identity', identity: { nativeId: '@discord_700000000000000003:bridge.example', displayName: 'Cyril (Discord)' } });
    // Dee and Dee: one rare full name on two networks, nothing else.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'dee', displayName: 'Delphine Quarry', handle: 'dq' } });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'uuid-dee', displayName: 'Delphine Quarry' } });
    // Eve on Discord and a different Eve on Discord: same network, so less likely.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'eve1', displayName: 'Evangeline Moss', handle: 'evem' } });
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'eve2', displayName: 'Evangeline Moss', handle: 'evangeline' } });
    // A bot named like Ann, and you: never suggested.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'annbot', displayName: 'Ann', handle: 'ann_lee', isBot: true } });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'uuid-me-again', displayName: 'Me', handle: 'me' } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const find = (r: { suggestions: P.MatchSuggestion[] }, a: string, b: string) => r.suggestions.find((s) => s.key === pairKey(a, b));

  test('a profile linking the other account is near certain, and says which', () => {
    const r = run(store.db);
    const s = find(r, did('ann'), xid('9001'));
    expect(s?.p).toBeGreaterThan(0.95);
    expect(s?.evidence[0]).toMatchObject({ kind: 'claims' });
    expect(s?.evidence[0].text).toContain("Ann's Discord profile links X ann_lee (verified): Ann's X account");
  });

  test('a phone number in a bio matches the Signal account with it', () => {
    const s = find(run(store.db), did('bo'), sid('uuid-bo'));
    expect(s?.p).toBeGreaterThan(0.95);
    expect(s?.evidence.map((e) => e.kind)).toContain('claims');
  });

  test("a bridge's stand-in is the account it stands for", () => {
    const s = find(run(store.db), did('700000000000000003'), mid('@discord_700000000000000003:bridge.example'));
    expect(s?.evidence[0].kind).toBe('bridge');
    expect(s?.p).toBeGreaterThan(0.95);
  });

  test('a rare full name is a fair guess; the same name on one network counts against', () => {
    const r = run(store.db);
    const dee = find(r, did('dee'), sid('uuid-dee'));
    expect(dee?.p).toBeGreaterThan(0.5);
    expect(dee?.p).toBeLessThan(0.9);
    const eve = find(r, did('eve1'), did('eve2'));
    expect(eve === undefined || eve.p < dee!.p).toBe(true);
    if (eve) expect(eve.evidence.some((e) => e.kind === 'against')).toBe(true);
  });

  test('bots and you are never suggested', () => {
    const r = run(store.db);
    const ids = new Set(r.suggestions.flatMap((s) => [s.a.id, s.b.id]));
    expect(ids.has(did('annbot'))).toBe(false);
    for (const self of [did('me-d'), sid('me-s'), xid('me-x')]) expect(ids.has(self)).toBe(false);
  });

  test('the same picture counts; a picture many share does not', () => {
    const put = store.db.query('INSERT OR REPLACE INTO picture_hash (identity_id, url, hash, at) VALUES (?, ?, ?, 0)');
    put.run(did('dee'), 'u1', 'f0f0f0f0f0f0f0f0');
    put.run(sid('uuid-dee'), 'u2', 'f0f0f0f0f0f0f0f1');
    const r = run(store.db);
    expect(find(r, did('dee'), sid('uuid-dee'))?.evidence.some((e) => e.kind === 'picture')).toBe(true);
    // Four more with the same picture: a default one, saying nothing.
    for (const id of [did('ann'), did('bo'), did('eve1'), did('eve2')]) put.run(id, 'u', 'f0f0f0f0f0f0f0f0');
    expect(find(run(store.db), did('dee'), sid('uuid-dee'))?.evidence.some((e) => e.kind === 'picture')).toBe(false);
    store.db.query('DELETE FROM picture_hash').run();
  });

  test('Not the same keeps a pair out; Later for a month; merging makes one person and is learned as a yes', async () => {
    const m = new SameMatches({ store, file: null, jevUrl: null });
    await m.refresh();
    const key = pairKey(did('dee'), sid('uuid-dee'));
    expect(m.view().suggestions.some((s) => s.key === key)).toBe(true);
    m.decide(key, 'no');
    expect(m.view().suggestions.some((s) => s.key === key)).toBe(false);
    await m.refresh();
    expect(m.view().suggestions.some((s) => s.key === key)).toBe(false);
    await m.undecide(key);
    expect(m.view().suggestions.some((s) => s.key === key)).toBe(true);
    // Undo while a run is going (one started by the decision): it waits for a run that began after it.
    m.decide(key, 'no');
    const going = m.refresh();
    await m.undecide(key);
    expect(m.view().suggestions.some((s) => s.key === key)).toBe(true);
    await going;

    const bo = pairKey(did('bo'), sid('uuid-bo'));
    m.decide(bo, 'later');
    expect(m.view().suggestions.some((s) => s.key === bo)).toBe(false);
    expect((store.db.query('SELECT until FROM match_decision WHERE key = ?').get(bo) as { until: number }).until).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const person = m.merge([did('ann'), xid('9001')]);
    const ids = (store.db.query('SELECT id FROM identity WHERE person_id = ? ORDER BY id').all(person) as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([did('ann'), xid('9001')].sort());
    const yes = store.db.query('SELECT decision, features FROM match_decision WHERE key = ?').get(pairKey(did('ann'), xid('9001'))) as { decision: string; features: string };
    expect(yes.decision).toBe('yes');
    expect(JSON.parse(yes.features).claims).toBeGreaterThan(0);
    expect(m.view().suggestions.some((s) => s.a.id === did('ann') || s.b.id === did('ann'))).toBe(false);
    expect(() => m.merge([did('me-d'), did('bo')])).toThrow();
    m.stop();
  });

  test('picture hashes are taken only as 16 hex digits, and a picture hashed is not asked for again', async () => {
    const m = new SameMatches({ store, file: null, jevUrl: null });
    store.db.query("UPDATE identity SET avatar_url = 'https://cdn.example/dee.png' WHERE id = ?").run(did('dee'));
    await m.refresh();
    expect(m.pictures(100).some((p) => p.identityId === did('dee'))).toBe(true);
    expect(m.savePictures([{ identityId: did('dee'), url: 'https://cdn.example/dee.png', hash: 'not hex' }])).toBe(0);
    expect(m.savePictures([{ identityId: did('dee'), url: 'https://cdn.example/dee.png', hash: '0123456789abcdef' }])).toBe(1);
    expect(m.pictures(100).some((p) => p.identityId === did('dee'))).toBe(false);
    m.stop();
  });

  test('profiles are collected only with the switch on, one per network per gap, and each new version is kept', async () => {
    const asked: string[] = [];
    let now = 1_000_000_000_000;
    // The command answers as a profile open would: kept through keepAbout.
    const people = {
      get: async (id: string) => {
        asked.push(id);
        keepAbout(store, id, dc.id, 'discord', { bio: `seen at ${now}` }, now);
        return { identityId: id } as P.PersonAboutView;
      },
    };
    store.db.query('UPDATE account SET capabilities = ? WHERE id = ?').run(JSON.stringify(['profile']), dc.id);
    store.ingest(dc, { t: 'conversation', conversation: { nativeId: 'dm-eve', shape: 'direct', participants: ['me-d', 'eve1'] } });
    store.ingest(dc, { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Friends', participants: ['me-d', 'eve1', 'dee'] } });
    const c = new ProfileCollector({ store, people, online: (a) => a === dc.id, now: () => now });
    store.setRetention({ ...DEFAULT_RETENTION });
    expect(await c.tick()).toEqual([]);
    store.setRetention({ ...DEFAULT_RETENTION, adversarial: true, profiles: true });
    const first = await c.tick();
    // People you have direct chats with first.
    expect(first).toEqual([did('eve1')]);
    // Within the gap, nothing more.
    now += COLLECT_PACE.discord!.gapMs - 1;
    expect(await c.tick()).toEqual([]);
    now += 2;
    const second = await c.tick();
    // Then your groups.
    expect(second).toEqual([did('dee')]);
    const versions = (store.db.query('SELECT COUNT(*) AS n FROM profile_version WHERE identity_id = ?').get(did('eve1')) as { n: number }).n;
    expect(versions).toBe(1);
    // The same again is not a new version; a change is.
    keepAbout(store, did('eve1'), dc.id, 'discord', { bio: `seen at ${1_000_000_000_000}` }, now);
    expect((store.db.query('SELECT COUNT(*) AS n FROM profile_version WHERE identity_id = ?').get(did('eve1')) as { n: number }).n).toBe(1);
    keepAbout(store, did('eve1'), dc.id, 'discord', { bio: 'new bio' }, now + 1);
    expect((store.db.query('SELECT COUNT(*) AS n FROM profile_version WHERE identity_id = ?').get(did('eve1')) as { n: number }).n).toBe(2);
    expect(c.status()).toMatchObject({ on: true, versions: expect.any(Number) });
    // Off again: nothing kept as versions, nothing asked.
    store.setRetention({ ...DEFAULT_RETENTION });
    keepAbout(store, did('eve1'), dc.id, 'discord', { bio: 'newer bio' }, now + 2);
    expect((store.db.query('SELECT COUNT(*) AS n FROM profile_version WHERE identity_id = ?').get(did('eve1')) as { n: number }).n).toBe(2);
    now += 10 * COLLECT_PACE.discord!.gapMs;
    expect(await c.tick()).toEqual([]);
  });
});

describe('weaker leads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-matches-weak-'));
  let store: Store;
  const wid = (n: string) => hubId('idn', 'whatsapp', n);

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    const acc = (network: P.Network, self: string) => {
      const a = store.createAccount({ network, label: network, color: '#111', adapter: network });
      store.ingest(a, { t: 'status', status: 'online', self: { nativeId: self, displayName: 'Me', isSelf: true } });
      return a;
    };
    const dc = acc('discord', 'me-d');
    const sg = acc('signal', 'me-s');
    const mx = acc('matrix', '@me:matrix.example');
    const wa = acc('whatsapp', '15550100@s.whatsapp.net');
    // Moth: one handle, the Matrix one inside its id.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'moth', displayName: 'Moth', handle: 'mothlight' } });
    store.ingest(mx, { t: 'identity', identity: { nativeId: '@mothlight:matrix.example', displayName: 'night moth', handle: '@mothlight:matrix.example' } });
    // Pippa: a Discord handle with a number on the end, her Signal name.
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'pip', displayName: 'pip', handle: 'pippa22' } });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'uuid-pippa', displayName: 'Pippa', handle: '+1 555 0139' } });
    // Two strangers whose names are their numbers, a digit apart.
    store.ingest(wa, { t: 'identity', identity: { nativeId: '15550121@s.whatsapp.net', handle: '+15550121' } });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'uuid-other', displayName: '+1 555 0120', handle: '+1 555 0120' } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const all = (r: { suggestions: P.MatchSuggestion[]; faint: P.MatchSuggestion[] }) => [...r.suggestions, ...r.faint];
  const find = (r: { suggestions: P.MatchSuggestion[]; faint: P.MatchSuggestion[] }, a: string, b: string) => all(r).find((s) => s.key === pairKey(a, b));

  test("a Matrix id's own part is a handle like any other", () => {
    const s = find(run(store.db), did('moth'), mid('@mothlight:matrix.example'));
    expect(s?.evidence.find((e) => e.kind === 'name')?.text).toContain('The same handle, mothlight');
  });

  test('a handle less its number is the name on the other', () => {
    const s = find(run(store.db), did('pip'), sid('uuid-pippa'));
    expect(s?.evidence.find((e) => e.kind === 'name')?.text).toContain('less its number, is the name on the other: pippa');
  });

  test('a phone number is not a name: numbers a digit apart are no lead', () => {
    expect(find(run(store.db), wid('15550121@s.whatsapp.net'), sid('uuid-other'))).toBeUndefined();
  });

  test('pairs under the shown mark are kept apart as faint, and never under the faint one', () => {
    const r = run(store.db);
    for (const s of r.faint) expect(s.p).toBeLessThan(0.35);
    for (const s of r.faint) expect(s.p).toBeGreaterThanOrEqual(0.15);
    for (const s of r.suggestions) expect(s.p).toBeGreaterThanOrEqual(0.35);
  });
});

describe('Zulip addresses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-matches-zulip-'));
  let store: Store;
  const zid = (n: string) => hubId('idn', 'zulip', n);
  const eid = (n: string) => hubId('idn', 'email', n);

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    const zu = store.createAccount({ network: 'zulip', label: 'z', color: '#111', adapter: 'zulip' });
    const dc = store.createAccount({ network: 'discord', label: 'd', color: '#222', adapter: 'discord' });
    store.ingest(zu, { t: 'status', status: 'online', self: { nativeId: 'chat.example.org/u/1', displayName: 'Me', isSelf: true } });
    store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'me-d', displayName: 'Me', isSelf: true } });
    // Sam on Zulip, whose address is the one mail knows, and Sam's handle on Discord, the address's own part.
    store.ingest(zu, { t: 'identity', identity: { nativeId: 'chat.example.org/u/7', displayName: 'S. Quill', handle: 'Sam.Quill@Example.org' } });
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'samq', displayName: 'sq', handle: 'sam.quill' } });
    // Four others at the same place, nothing else alike.
    for (const [n, name, local] of [['8', 'Wren Ashby', 'wren'], ['9', 'Tomas Ilk', 'tilk'], ['10', 'Ola Varn', 'ola.v'], ['11', 'Ruth Mbeki', 'rmbeki']] as const)
      store.ingest(zu, { t: 'identity', identity: { nativeId: `chat.example.org/u/${n}`, displayName: name, handle: `${local}@example.org` } });
    const at = Date.now();
    for (const [addr, name] of [['sam.quill@example.org', 'Sam Quill'], ['wren.other@example.org', 'Jo Pell']])
      store.db.query('INSERT INTO identity (id, network, native_id, display_name, updated_at) VALUES (?, ?, ?, ?, ?)').run(eid(addr), 'email', addr, name, at);
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const all = (r: { suggestions: P.MatchSuggestion[]; faint: P.MatchSuggestion[] }) => [...r.suggestions, ...r.faint];

  test("a Zulip account is known by its address, and its handle is the address's own part", () => {
    expect(ownKeys({ network: 'zulip', native_id: 'chat.example.org/u/7', handle: 'Sam.Quill@Example.org' }).map((k) => k.key)).toEqual(['email:sam.quill@example.org']);
    expect(ownKeys({ network: 'zulip', native_id: 'chat.example.org/u/7' })).toEqual([]);
    expect(nameHandle('zulip', 'Sam.Quill@Example.org')).toBe('Sam.Quill');
    expect(nameHandle('email', 'sam@example.org')).toBeNull();
    expect(nameHandle('discord', 'sam.quill')).toBe('sam.quill');
  });

  test('the same address in mail is a contact match, and the handle matches the address\'s own part elsewhere', () => {
    const r = run(store.db);
    const mail = all(r).find((s) => s.key === pairKey(zid('chat.example.org/u/7'), eid('sam.quill@example.org')));
    expect(mail?.evidence.find((e) => e.kind === 'contact')?.text).toBe('The same email address on both (sam.quill@example.org)');
    expect(mail?.p).toBeGreaterThan(0.95);
    const dis = all(r).find((s) => s.key === pairKey(zid('chat.example.org/u/7'), did('samq')));
    expect(dis?.evidence.find((e) => e.kind === 'name')?.text).toContain('The same handle, samquill');
  });

  test('sharing the domain makes no pair', () => {
    const zulip = ['7', '8', '9', '10', '11'].map((n) => zid(`chat.example.org/u/${n}`));
    const r = run(store.db);
    for (const s of all(r)) {
      const [a, b] = s.key.split('+');
      // Only Sam's pairs: none between people who share nothing but where their address is.
      if (zulip.includes(a) && zulip.includes(b)) throw new Error(`paired ${s.key}`);
      if (s.key.includes(eid('wren.other@example.org'))) throw new Error(`paired ${s.key}`);
    }
    // Every pair is two of Sam's three accounts.
    const sam = [zid('chat.example.org/u/7'), did('samq'), eid('sam.quill@example.org')];
    expect(all(r).map((s) => s.key).sort()).toEqual([pairKey(sam[0], sam[1]), pairKey(sam[0], sam[2]), pairKey(sam[1], sam[2])].sort());
  });
});
