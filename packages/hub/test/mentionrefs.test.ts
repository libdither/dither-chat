/**
 * Person and identity references on send (mentionrefs.ts, docs/mentions.md "References"): the pure lowering (names
 * escaped, unknown ids, several references, code left alone), what the store says each becomes (an account on the
 * chat's network is mentioned, anyone else is a plain name), and every path that sends a body through the hub: the
 * send, a chat's send, an edit, Send later's Send now and a forward's note. An account with 'personRefs' gets them as
 * written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { lowerForSend, lowerRefs, plainMention, type RefResolve, storeResolve } from '../src/mentionrefs.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-mentionrefs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ZW = '​';

describe('lowering, pure', () => {
  const look: RefResolve = (kind, id) =>
    ({ 'person:per_alice': { name: 'Alice Chen' }, 'person:per_bea': { nativeId: '42' }, 'identity:idn_bob': { name: 'Bob' }, 'identity:idn_cy': { nativeId: '@cy:example.org' }, 'person:per_evil': { name: 'everyone <@1> <#2> ok' } })[`${kind}:${id}`] ?? null;

  test('a person or account becomes their mention on this network, or a plain name', () => {
    expect(lowerRefs('hi <@person:per_alice>!', look)).toBe('hi @Alice Chen!');
    expect(lowerRefs('hi <@person:per_bea>', look)).toBe('hi <@42>');
    expect(lowerRefs('<@identity:idn_bob> and <@identity:idn_cy>', look)).toBe('@Bob and <@@cy:example.org>');
  });

  test('several in one body, each its own way, and nothing else touched', () => {
    const body = '<@person:per_alice> <@person:per_bea> <@123> <@&9> @everyone <#5> <@person:per_alice>';
    expect(lowerRefs(body, look)).toBe('@Alice Chen <@42> <@123> <@&9> @everyone <#5> @Alice Chen');
  });

  test('an id nobody knows is @someone: the raw id never goes out', () => {
    const out = lowerRefs('ask <@person:per_gone> and <@identity:idn_gone>', look);
    expect(out).toBe('ask @someone and @someone');
    expect(out).not.toContain('per_gone');
    expect(out).not.toContain('idn_gone');
  });

  test('inside code they stay as written', () => {
    const body = 'see `<@person:per_alice>` and\n```\n<@identity:idn_bob>\n```\nbut <@person:per_alice>';
    expect(lowerRefs(body, look)).toBe('see `<@person:per_alice>` and\n```\n<@identity:idn_bob>\n```\nbut @Alice Chen');
    // An unclosed backtick is no code.
    expect(lowerRefs('` <@person:per_alice>', look)).toBe('` @Alice Chen');
  });

  test('a name can make no token and ping nobody', () => {
    const out = lowerRefs('<@person:per_evil>', look);
    expect(out).toBe(`@${ZW}everyone <${ZW}@${ZW}1> <${ZW}#2> ok`);
    expect(out).not.toMatch(/<@\d+>|<#\d+>|@everyone/);
    expect(plainMention('here')).toBe(`@${ZW}here`);
    expect(plainMention('Room 101')).toBe(`@${ZW}Room 101`);
    expect(plainMention('Hereward')).toBe('@Hereward');
    expect(plainMention('a@b.c')).toBe(`@a@${ZW}b.c`);
    expect(plainMention('  two\n lines ')).toBe('@two lines');
    expect(plainMention('')).toBe('@someone');
  });

  test('a body without references is the same string', () => {
    const body = 'plain <@1> text';
    expect(lowerRefs(body, () => {
      throw new Error('not asked');
    })).toBe(body);
  });
});

describe('the store and the routes', () => {
  const sent: any[] = [];
  let hub: HubServer;
  let store: Store;
  let port = 0;
  let dcAcc = '';
  let calAcc = '';
  const dc = hubId('cnv', 'discord', '200');
  const cal = hubId('cnv', 'calendar', 'cal-chat');
  const alicePerson = () => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'signal', 'aci-alice'))!.person_id;
  const bea = hubId('idn', 'discord', '2');
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) });

  beforeAll(() => {
    store = new Store(join(dir, 'refs.sqlite'), mediaSigner('s'));
    const sup = { authorize: () => null, online: () => true, command: async (_: string, c: any) => (sent.push(c), { nativeId: `n${sent.length}` }) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, 'hub'), webDist: dir, secret: 's' });
    port = hub.start().port!;
    const a = store.createAccount({ network: 'discord', label: 'dc', color: '#000', adapter: 'discord' });
    dcAcc = a.id;
    store.ingest(a, { t: 'hello', network: 'discord', version: '1', capabilities: ['send', 'edit', 'forward'] });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: '1', isSelf: true } });
    store.ingest(a, { t: 'identity', identity: { nativeId: '2', displayName: 'Bea', contact: true } });
    store.ingest(a, { t: 'identity', identity: { nativeId: '3', displayName: 'Bea (alt)', contact: true } });
    store.ingest(a, { t: 'conversation', conversation: { nativeId: '200', shape: 'group', name: 'g', participants: ['1', '3'] } });
    store.ingest(a, { t: 'message', message: { nativeId: '300', conversation: '200', author: '1', ts: Date.now(), body: 'mine' } });
    const s = store.createAccount({ network: 'signal', label: 'sig', color: '#000', adapter: 'signal' });
    store.ingest(s, { t: 'status', status: 'online', self: { nativeId: 'aci-me', isSelf: true } });
    store.ingest(s, { t: 'identity', identity: { nativeId: 'aci-alice', displayName: 'Alice Chen', contact: true } });
    store.ingest(s, { t: 'identity', identity: { nativeId: 'aci-bea', displayName: 'Bea on Signal', contact: true } });
    // Bea is one person on two networks, with two Discord accounts; Alice is on Signal only.
    const beaPerson = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', bea)!.person_id;
    for (const other of [hubId('idn', 'discord', '3'), hubId('idn', 'signal', 'aci-bea')]) store.mergePersons(beaPerson, store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', other)!.person_id);
    const c = store.createAccount({ network: 'calendar', label: 'cal', color: '#000', adapter: 'calendar' });
    calAcc = c.id;
    store.ingest(c, { t: 'hello', network: 'calendar', version: '1', capabilities: ['send', 'personRefs'] });
    store.ingest(c, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true } });
    store.ingest(c, { t: 'conversation', conversation: { nativeId: 'cal-chat', shape: 'direct', name: 'Calendar', participants: ['me'] } });
    store.flush();
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
  });

  test('from the store: an account here is mentioned, prefering the one in the chat; elsewhere, its own name or the person', () => {
    const r = storeResolve(store, dc);
    const beaPerson = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', bea)!.person_id;
    // Bea has two Discord accounts; the one in the conversation is the one named.
    expect(r('person', beaPerson)).toEqual({ nativeId: '3' });
    expect(r('person', alicePerson())).toEqual({ name: 'Alice Chen' });
    expect(r('identity', bea)).toEqual({ nativeId: '2' });
    expect(r('identity', hubId('idn', 'signal', 'aci-bea'))).toEqual({ name: 'Bea on Signal' });
    expect(r('identity', 'idn_nobody')).toBeNull();
    expect(r('person', 'per_nobody')).toBeNull();
    // An account that keeps references gets them as written.
    expect(lowerForSend(store, cal, ['send', 'personRefs'], `<@person:${alicePerson()}>`)).toBe(`<@person:${alicePerson()}>`);
  });

  test('the send: a person off this network is plain text, an account on it its mention', async () => {
    const body = `hi <@person:${alicePerson()}> and <@identity:${bea}>`;
    const r = await post(`/api/conversations/${dc}/send`, { body });
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'send', conversation: '200', body: 'hi @Alice Chen and <@2>' });
  });

  test("a chat's send goes the same way", async () => {
    const r = await post(`/api/chats/${dc}/messages`, { body: `<@identity:${hubId('idn', 'signal', 'aci-bea')}>` });
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'send', body: '@Bea on Signal' });
  });

  test('an edit that adds a reference is lowered too', async () => {
    const r = await post(`/api/messages/${hubId('msg', 'discord', '300')}/edit`, { body: `now with <@person:${alicePerson()}>` });
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'edit', message: '300', body: 'now with @Alice Chen' });
  });

  test("Send later keeps the reference, and lowers it when it goes", async () => {
    const r = await post('/api/scheduled', { conversationId: dc, body: `later <@person:${alicePerson()}>`, dueAt: Date.now() + 3_600_000 });
    expect(r.status).toBe(200);
    const v = (await r.json()) as P.ScheduledSendView;
    expect(v.body).toBe(`later <@person:${alicePerson()}>`);
    expect((await post(`/api/scheduled/${v.id}/send`, {})).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'send', body: 'later @Alice Chen' });
  });

  test("a forward's note is lowered for where it goes", async () => {
    const r = await post(`/api/messages/${hubId('msg', 'discord', '300')}/forward`, { targets: [{ conversationId: dc }], note: `for <@person:${alicePerson()}>` });
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ note: 'for @Alice Chen' });
  });

  test("an account with 'personRefs' (the calendar) gets references as written", async () => {
    const body = `lunch with <@person:${alicePerson()}> and <@identity:${bea}>`;
    const r = await post(`/api/conversations/${cal}/send`, { body, accountId: calAcc });
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'send', conversation: 'cal-chat', body });
    expect(dcAcc).toBeTruthy();
  });
});
