/**
 * People links (add.ts, docs/add.md "Relationships"): each account's list kept in person_link from the relationships
 * events, the People filter, a profile's relationship from it, a DM's pending request either way, the confirm round
 * trip on a flagged request and on Add friend, and POST /api/people/:id/remove with its checks and its own pace.
 * Against the demo world's adapters run in process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { parseAdd } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { ADD_LIMITS, Adding, linkOf, linksOf, pendingLinks, requestViews } from '../src/add.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { People } from '../src/people.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-links-'));
let store: Store;
let adding: Adding;
let clock = Date.now();
const offline = new Set<string>();
const sent: { account: string; cmd: any }[] = [];
const notes: { account: string; line: string }[] = [];
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void; stop(): void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';
const TG = 'acc_demo-telegram';
const SIG = 'acc_demo-signal';

function command<T>(account: string, cmd: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    sent.push({ account, cmd });
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    adapters.get(account)!.command({ ...cmd, id });
  });
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const req = new Request(`http://hub${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const url = new URL(req.url);
  const res = (await adding.route(req, url, url.pathname))!;
  return { status: res.status, json: await res.json() };
}
const page = { origin: 'http://hub' };
const remove = (identityId: string, body: unknown, headers = page) => call('POST', `/api/people/${identityId}/remove`, body, headers);
const action = (account: string, name: string, args: unknown) => command(account, { t: 'action', action: name, args });

const idn = (network: P.Network, handle: string) => store.one<{ id: string; native_id: string }>('SELECT id, native_id FROM identity WHERE network = ? AND handle = ?', network, handle)!;

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  // The world's first events in one transaction: one write to disk, not one per event (seconds on a busy disk).
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      const adir = join(dir, acc.id);
      mkdirSync(adir, { recursive: true });
      const a = demoFactory(acc, adir)! as unknown as { command: (c: P.AdapterCommand) => void; stop(): void; start(e: (ev: P.AdapterEvent) => void): void };
      adapters.set(acc.id, a);
      a.start((ev) => {
        if (ev.t === 'reply') {
          const p = pending.get(ev.id);
          pending.delete(ev.id);
          if (ev.ok) p?.resolve(ev.result);
          else p?.reject(new Error(ev.error));
          return;
        }
        store.ingest(store.account(acc.id)!, ev);
      });
    }
  })();
  store.flush();
  adding = new Adding({ store, online: (a) => !offline.has(a), command, note: (account, line) => notes.push({ account, line }), flush: () => store.flush(), liveView: () => false, now: () => clock });
});

afterAll(() => {
  for (const a of adapters.values()) a.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the lists', () => {
  test('after connect: Discord friends, a block and a request sent; Telegram contacts and a block; none where the account has no list', () => {
    const of = (acc: string) => (store.raw('SELECT identity_id, relationship FROM person_link WHERE account_id = ?', acc) as { identity_id: string; relationship: string }[]).map((r) => r.relationship).sort();
    expect(of(MAIN).filter((r) => r === 'friend').length).toBe(5);
    expect(linkOf(store.db, MAIN, idn('discord', 'oxidized_owl').id)).toBe('blocked');
    expect(linkOf(store.db, ALT, idn('discord', 'mara').id)).toBe('requested');
    expect(linkOf(store.db, TG, idn('telegram', '@crypto_signals_vip').id)).toBe('blocked');
    expect(linkOf(store.db, TG, idn('telegram', '@alicechen').id)).toBe('contact');
    expect(of(SIG)).toEqual([]);
    // Incoming requests stay requests: Nova is not on main's list.
    expect(linkOf(store.db, MAIN, idn('discord', 'nova.wav').id)).toBeNull();
  });

  test('one changes, one goes, junk is dropped, and a whole list replaces only its own account', () => {
    const acc = store.account(TG)!;
    const lena = idn('telegram', '@lena_k');
    store.ingest(acc, { t: 'relationship', fact: { identity: lena.native_id, relationship: 'contact', since: 5 } });
    expect(linkOf(store.db, TG, lena.id)).toBe('contact');
    store.ingest(acc, { t: 'relationship', fact: { identity: lena.native_id, relationship: 'requesting' as never } });
    store.ingest(acc, { t: 'relationship', fact: { identity: '', relationship: 'friend' } });
    expect(linkOf(store.db, TG, lena.id)).toBe('contact');
    store.ingest(acc, { t: 'relationship', fact: { identity: lena.native_id, relationship: 'stranger' } });
    expect(linkOf(store.db, TG, lena.id)).toBeNull();
    const main = store.raw('SELECT COUNT(*) AS n FROM person_link WHERE account_id = ?', MAIN);
    store.ingest(acc, { t: 'relationships', list: [{ identity: lena.native_id, relationship: 'blocked' }, { identity: 'x', relationship: 'bogus' as never }] });
    expect(store.raw('SELECT relationship FROM person_link WHERE account_id = ?', TG)).toEqual([{ relationship: 'blocked' }]);
    expect(store.raw('SELECT COUNT(*) AS n FROM person_link WHERE account_id = ?', MAIN)).toEqual(main);
    // Put Telegram back as the demo has it.
    store.ingest(acc, { t: 'relationships', list: [{ identity: idn('telegram', '@alicechen').native_id, relationship: 'contact' }, { identity: idn('telegram', '@noor_h').native_id, relationship: 'contact' }, { identity: idn('telegram', '@crypto_signals_vip').native_id, relationship: 'blocked' }] });
  });

  test('GET /api/people: by relationship and by account, by name, with the identities to draw them', async () => {
    const all = (await call('GET', '/api/people?relationship=friend')).json as P.PeopleLinksView;
    expect(all.links.every((l) => l.relationship === 'friend')).toBe(true);
    expect(new Set(all.links.map((l) => l.accountId))).toEqual(new Set([MAIN, ALT]));
    const names = all.links.filter((l) => l.accountId === MAIN).map((l) => all.identities.find((i) => i.id === l.identityId)!.displayName);
    expect(names).toEqual(['Alice', 'Jordan', 'Quinn', 'Ravi', 'Theo']);
    // Alice is one person here: her link says so.
    expect(all.links.find((l) => l.identityId === idn('discord', 'alice.chen').id)!.personId).toStartWith('per_');
    const contacts = (await call('GET', `/api/people?relationship=contact&account=${TG}`)).json as P.PeopleLinksView;
    expect(contacts.links.map((l) => l.accountId)).toEqual([TG, TG]);
    expect((await call('GET', `/api/people?relationship=following`)).json.links).toEqual([]);
    expect((await call('GET', '/api/people?relationship=requesting')).status).toBe(400);
    expect(((await call('GET', '/api/people')).json as P.PeopleLinksView).links.length).toBeGreaterThan(all.links.length);
  });

  test("a profile's relationship comes from the list when the account has them on it", () => {
    const owl = idn('discord', 'oxidized_owl');
    const people = new People({ store, online: () => true, command: async () => ({}) as never });
    expect(people.view(owl.id, MAIN, { relationship: 'stranger', bio: 'hi' }, 1, undefined).relationship).toBe('blocked');
    // Not on that account's list: what the profile said.
    expect(people.view(owl.id, ALT, { relationship: 'stranger' }, 1, undefined).relationship).toBe('stranger');
    expect(linksOf(store.db, [owl.id])).toEqual([{ accountId: MAIN, identityId: owl.id, personId: null, relationship: 'blocked', since: expect.any(Number) }]);
  });
});

describe("a DM's pending request", () => {
  const dm = (acc: string, peer: string, self: string) => {
    const nativeId = `dm-test-${peer}`;
    store.ingest(store.account(acc)!, { t: 'conversation', conversation: { nativeId, shape: 'direct', participants: [self, peer] } });
    store.flush();
    return hubId('cnv', 'discord', nativeId);
  };

  test('incoming: they asked this account, with the request to answer', () => {
    const nova = idn('discord', 'nova.wav');
    const id = dm(MAIN, nova.native_id, idn('discord', 'zyansheep').native_id);
    const req = requestViews(store).find((r) => r.from === nova.id)!;
    expect(store.conversationView(id)!.pending).toEqual({ accountId: MAIN, identityId: nova.id, incoming: true, requestId: req.id });
    // The bootstrap says the same.
    expect(store.bootstrap().conversations.find((c) => c.id === id)!.pending).toEqual({ accountId: MAIN, identityId: nova.id, incoming: true, requestId: req.id });
  });

  test('outgoing: the account asked them; none for a friend', () => {
    const mara = idn('discord', 'mara');
    const id = dm(ALT, mara.native_id, idn('discord', 'zyn.alt').native_id);
    expect(store.conversationView(id)!.pending).toEqual({ accountId: ALT, identityId: mara.id, incoming: false, requestId: null });
    expect(store.conversationViews([id])[0].pending).toEqual(store.conversationView(id)!.pending!);
    const alice = store.raw(`SELECT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id WHERE c.shape = 'direct' AND p.identity_id = ?`, idn('discord', 'alice.chen').id) as { id: string }[];
    expect(alice.length).toBeGreaterThan(0);
    for (const c of alice) expect(store.conversationView(c.id)!.pending).toBeUndefined();
    expect(pendingLinks(store.db, [mara.id]).size).toBe(1);
  });

  test('a list without the request takes the banner away, and the DM goes out again', () => {
    const mara = idn('discord', 'mara');
    const conv = hubId('cnv', 'discord', `dm-test-${mara.native_id}`);
    store.flush();
    store.ingest(store.account(ALT)!, { t: 'relationship', fact: { identity: mara.native_id, relationship: 'stranger' } });
    const events = store.flush();
    expect(events.some((e) => e.t === 'conversation' && e.conversation.id === conv && !e.conversation.pending)).toBe(true);
    store.ingest(store.account(ALT)!, { t: 'relationship', fact: { identity: mara.native_id, relationship: 'requested' } });
    expect(store.conversationView(conv)!.pending?.incoming).toBe(false);
  });
});

describe('confirm', () => {
  test("a flagged request: Accept without confirm does nothing and says Discord's words; Accept anyway goes through", async () => {
    const drops = idn('discord', 'free.nitro.drops');
    const r = requestViews(store).find((x) => x.from === drops.id)!;
    expect(r.warning).toBe('Discord filed this request as possible spam');
    const first = await call('POST', `/api/requests/${r.id}`, { answer: 'accept' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ confirm: 'You must confirm the friend request to add this user.', relationship: null, check: null });
    expect(requestViews(store).some((x) => x.id === r.id)).toBe(true);
    expect(sent.at(-1)!.cmd).toEqual({ t: 'answer', request: r.nativeId, answer: 'accept' });
    expect(notes.at(-1)!.line).toBe('[add] accepted the friend request - the network wants a confirm first, nothing done');
    // Only a real true confirms.
    await call('POST', `/api/requests/${r.id}`, { answer: 'accept', confirm: 'yes' });
    expect(sent.at(-1)!.cmd.confirm).toBeUndefined();
    const second = await call('POST', `/api/requests/${r.id}`, { answer: 'accept', confirm: true });
    expect(sent.at(-1)!.cmd).toEqual({ t: 'answer', request: r.nativeId, answer: 'accept', confirm: true });
    expect(second.json).toMatchObject({ confirm: null, relationship: 'friend', identityId: drops.id });
    expect(requestViews(store).some((x) => x.id === r.id)).toBe(false);
    expect(linkOf(store.db, ALT, drops.id)).toBe('friend');
    expect(notes.at(-1)!.line).toBe('[add] accepted the friend request, confirmed');
  });

  test('Add friend on someone you share nothing with: the confirm first, its slot given back, then Add anyway', async () => {
    const ref = parseAdd('kestrel.dev').find((r) => r.network === 'discord')!;
    const used = () => store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = 'connect'`, MAIN)!.n;
    const before = used();
    const first = await call('POST', '/api/add', { accountId: MAIN, ref, action: 'friend' });
    expect(first.json).toMatchObject({ confirm: 'You must confirm the friend request to add this user.', pending: false, identityId: null });
    expect(used()).toBe(before);
    const second = await call('POST', '/api/add', { accountId: MAIN, ref, action: 'friend', confirm: true });
    expect(second.json).toMatchObject({ confirm: null, pending: true, relationship: 'requested' });
    expect(used()).toBe(before + 1);
    expect(linkOf(store.db, MAIN, second.json.identityId)).toBe('requested');
  });
});

describe('remove', () => {
  test('refused before any adapter hears of it: not from the page, not a relationship, no such person, no account that can', async () => {
    const asked = sent.length;
    const alice = idn('discord', 'alice.chen');
    expect((await remove(alice.id, { relationship: 'friend', accountId: MAIN }, {} as typeof page)).status).toBe(403);
    expect((await remove(alice.id, { relationship: 'requesting', accountId: MAIN })).status).toBe(400);
    expect((await remove('idn_nope', { relationship: 'friend' })).status).toBe(404);
    // A friend of both Discord accounts: which one?
    const which = await remove(alice.id, { relationship: 'friend' });
    expect(which.status).toBe(400);
    expect(which.json.error).toBe('Which Discord account?');
    expect((await remove(alice.id, { relationship: 'friend', accountId: TG })).status).toBe(400);
    const acc = store.account(MAIN)!;
    store.updateAccount(MAIN, { capabilities: JSON.stringify((JSON.parse(acc.capabilities) as string[]).filter((c) => c !== 'disconnect')) });
    const cannot = await remove(alice.id, { relationship: 'friend', accountId: MAIN });
    store.updateAccount(MAIN, { capabilities: acc.capabilities });
    expect(cannot.status).toBe(409);
    expect(cannot.json.error).toBe("Removing people on Discord isn't built for this account yet");
    offline.add(MAIN);
    expect((await remove(alice.id, { relationship: 'friend', accountId: MAIN })).status).toBe(409);
    offline.delete(MAIN);
    expect(sent.length).toBe(asked);
  });

  test('what the owner saw must be so now', async () => {
    const r = await remove(idn('discord', 'alice.chen').id, { relationship: 'blocked', accountId: MAIN });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('That changed; look again');
  });

  test('each kind ends: a friend, a request sent, a block, a contact, a follow', async () => {
    const ravi = idn('discord', 'ravi_p');
    const friend = await remove(ravi.id, { relationship: 'friend', accountId: MAIN });
    expect(friend.json).toMatchObject({ accountId: MAIN, identityId: ravi.id, relationship: 'stranger', confirm: null });
    expect(sent.at(-1)!.cmd).toEqual({ t: 'remove', identity: ravi.native_id, relationship: 'friend' });
    expect(linkOf(store.db, MAIN, ravi.id)).toBeNull();
    // Still a friend of the alt account.
    expect(linkOf(store.db, ALT, ravi.id)).toBe('friend');
    expect(notes.at(-1)!.line).toBe('[add] removed the friend ravi_p');

    // The one account whose list says so, without naming it.
    const mara = idn('discord', 'mara');
    expect((await remove(mara.id, { relationship: 'requested' })).json).toMatchObject({ accountId: ALT, relationship: 'stranger' });
    expect(store.conversationView(hubId('cnv', 'discord', `dm-test-${mara.native_id}`))!.pending).toBeUndefined();

    const owl = idn('discord', 'oxidized_owl');
    expect((await remove(owl.id, { relationship: 'blocked', accountId: MAIN })).json.relationship).toBe('stranger');
    expect(notes.at(-1)!.line).toBe('[add] unblocked oxidized_owl');

    const noor = idn('telegram', '@noor_h');
    expect((await remove(noor.id, { relationship: 'contact' })).json).toMatchObject({ accountId: TG, relationship: 'stranger' });

    // Following: no demo network has it, so the demo account is told to.
    const lena = idn('telegram', '@lena_k');
    await action(TG, 'relate', { who: lena.native_id, relationship: 'following' });
    expect(linkOf(store.db, TG, lena.id)).toBe('following');
    expect((await remove(lena.id, { relationship: 'following', accountId: TG })).json.relationship).toBe('stranger');
    expect(linkOf(store.db, TG, lena.id)).toBeNull();
    expect(notes.at(-1)!.line).toBe('[add] unfollowed @lena_k');
  });

  test('a profile kept from before says so too, until it is asked again', async () => {
    const jordan = idn('discord', 'jordanruns');
    store.db.query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)').run(jordan.id, MAIN, JSON.stringify({ relationship: 'friend', bio: 'runs' }), 1);
    await remove(jordan.id, { relationship: 'friend', accountId: MAIN });
    expect(JSON.parse(store.one<{ data: string }>('SELECT data FROM about WHERE target_id = ? AND account_id = ?', jordan.id, MAIN)!.data)).toEqual({ relationship: 'stranger', bio: 'runs' });
  });

  test('paced on its own: 20 a day per account, a restart does not reset it', async () => {
    expect(ADD_LIMITS.disconnect).toMatchObject({ max: 20, windowMs: 86_400_000 });
    const quinn = idn('discord', 'quinn.dev');
    const used = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = 'disconnect'`, MAIN)!.n;
    for (let i = used; i < 20; i++) store.db.query(`INSERT INTO add_pace (account_id, kind, at) VALUES (?, 'disconnect', ?)`).run(MAIN, clock - i);
    const asked = sent.length;
    const over = await remove(quinn.id, { relationship: 'friend', accountId: MAIN });
    expect(over.status).toBe(429);
    expect(over.json.error).toMatch(/^Discord main has removed or unblocked 20 people in the last day, the most dither-chat lets one account\. The next frees up in \d+ hours?\.$/);
    expect(sent.length).toBe(asked);
    // Another account, and adding, are paced apart.
    expect((await remove(quinn.id, { relationship: 'friend', accountId: ALT })).status).toBe(200);
    clock += 86_400_001;
    expect((await remove(quinn.id, { relationship: 'friend', accountId: MAIN })).status).toBe(200);
  });

  test('forgotten with the account', () => {
    store.deleteAccount(TG);
    expect(store.one('SELECT 1 FROM person_link WHERE account_id = ?', TG)).toBeNull();
  });
});
