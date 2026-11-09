/**
 * Adding (add.ts, docs/add.md) against the demo world's adapters run in process: each route's checks before any
 * adapter hears of it, previews and results in hub ids, pacing that survives a restart, the requests list, and an
 * open message request that the hub keeps quiet about.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { parseAdd } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { ADD_LIMITS, Adding, PREVIEW_CACHE, requestHeld, requestViews, takePace } from '../src/add.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-add-'));
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
const MX = 'acc_demo-matrix';
const SIG = 'acc_demo-signal';
const WA = 'acc_demo-whatsapp';
const TG = 'acc_demo-telegram';
const ref = (s: string, network?: P.Network) => parseAdd(s).find((r) => !network || r.network === network)!;

function command<T>(account: string, cmd: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    sent.push({ account, cmd });
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    adapters.get(account)!.command({ ...cmd, id });
  });
}

const newAdding = (s: Store) => new Adding({ store: s, online: (a) => !offline.has(a), command, note: (account, line) => notes.push({ account, line }), flush: () => s.flush(), liveView: () => false, now: () => clock });

async function call(method: string, path: string, body?: unknown, a = adding): Promise<{ status: number; json: any }> {
  const req = new Request(`http://hub${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = (await a.route(req, new URL(req.url), path))!;
  return { status: res.status, json: await res.json() };
}
const resolve = (accountId: string, r: unknown, a?: Adding) => call('POST', '/api/add/resolve', { accountId, ref: r }, a);
const add = (accountId: string, r: unknown, action: string) => call('POST', '/api/add', { accountId, ref: r, action });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
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
  store.flush();
  adding = newAdding(store);
});

afterAll(() => {
  for (const a of adapters.values()) a.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('resolve', () => {
  test('what cannot work is refused before any adapter hears of it', async () => {
    const asked = sent.length;
    expect((await resolve('acc_nope', ref('discord.gg/pixelart'))).status).toBe(404);
    expect((await resolve(MAIN, 'discord.gg/pixelart')).status).toBe(400);
    expect((await resolve(MAIN, { kind: 'invite', network: 'discord', code: 'pixelart', url: 'https://evil.example/pixelart' })).status).toBe(400);
    const wrong = await resolve(MAIN, ref('@lena_k'));
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('That is Telegram @lena_k, and main is a Discord account');
    offline.add(MAIN);
    expect((await resolve(MAIN, ref('discord.gg/pixelart'))).status).toBe(409);
    offline.delete(MAIN);
    expect(sent.length).toBe(asked);
  });

  test('an account without the capability says so plainly', async () => {
    const acc = store.account(WA)!;
    store.updateAccount(WA, { capabilities: JSON.stringify((JSON.parse(acc.capabilities) as string[]).filter((c) => c !== 'resolve')) });
    const r = await resolve(WA, ref('https://chat.whatsapp.com/MapleGardenSwap26'));
    store.updateAccount(WA, { capabilities: acc.capabilities });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Joining from WhatsApp invites isn't built for this account yet");
  });

  test('a Discord invite: the server, its counts, who invited, in hub ids', async () => {
    const r = await resolve(MAIN, ref('https://discord.gg/pixelart'));
    expect(r.status).toBe(200);
    const v = r.json as P.AddPreviewView;
    expect(v).toMatchObject({ accountId: MAIN, what: 'space', name: 'Pixel Art Club', members: 5321, online: 802, actions: ['join'], joined: null });
    expect(v.inviter).toStartWith('idn_');
    expect(v.identities.map((i) => i.id)).toEqual([v.inviter!]);
    expect(v.expires).toBeGreaterThan(clock);
  });

  test('a server you are in already says so, with its hub id', async () => {
    const v = (await resolve(ALT, ref('discord.gg/libdither'))).json as P.AddPreviewView;
    const libdither = store.one<{ id: string }>(`SELECT id FROM space WHERE name = 'libdither'`)!.id;
    expect(v.joined).toEqual({ space: libdither });
    expect(v.actions).toEqual([]);
  });

  test("an expired invite is the network's own sentence", async () => {
    const r = await resolve(MAIN, ref('discord.gg/oldparty'));
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('This invite has expired or was revoked');
  });

  test('a partial preview is not "not found": a Discord username and a Signal group link', async () => {
    const u = (await resolve(MAIN, ref('mara'))).json as P.AddPreviewView;
    expect(u).toMatchObject({ what: 'person', name: 'mara', partial: true, nativeId: null, members: null, actions: ['friend'] });
    const g = (await resolve(SIG, ref('https://signal.group/#CjQKINewBoardGames'))).json as P.AddPreviewView;
    expect(g).toMatchObject({ what: 'group', partial: true, actions: ['join'] });
    expect(g.notes[0]).toContain('only once you join');
  });

  test('actions are what this account can do: no friend button without connect', async () => {
    const acc = store.account(ALT)!;
    store.updateAccount(ALT, { capabilities: JSON.stringify((JSON.parse(acc.capabilities) as string[]).filter((c) => c !== 'connect')) });
    const v = (await resolve(ALT, ref('mara'))).json as P.AddPreviewView;
    store.updateAccount(ALT, { capabilities: acc.capabilities });
    expect(v.actions).toEqual([]);
  });

  test('a Telegram @name may be a channel or a person', async () => {
    const ch = (await resolve(TG, ref('@dithernews'))).json as P.AddPreviewView;
    expect(ch).toMatchObject({ what: 'channel', name: 'Dither News', actions: ['join'] });
    const p = (await resolve(TG, ref('@lena_k'))).json as P.AddPreviewView;
    expect(p).toMatchObject({ what: 'person', name: 'Lena K', actions: ['message', 'contact'] });
    expect(p.identityId).toBe(hubId('idn', 'telegram', p.nativeId!));
  });
});

describe('add', () => {
  test('a message goes through POST /api/directs, and an unknown action is refused', async () => {
    expect((await add(TG, ref('@lena_k'), 'message')).status).toBe(400);
    expect((await add(TG, ref('@lena_k'), 'poke')).status).toBe(400);
  });

  test('joining a Discord server: its facts first, then the result to open, and a line in its log', async () => {
    const r = await add(MAIN, ref('discord.gg/pixelart'), 'join');
    expect(r.status).toBe(200);
    const v = r.json as P.AddResultView;
    expect(v.spaceId).toStartWith('spc_');
    expect(store.one('SELECT 1 FROM space WHERE id = ?', v.spaceId)).toBeTruthy();
    expect(v.conversation).toMatchObject({ name: 'welcome', shape: 'channel' });
    expect(v).toMatchObject({ pending: false, check: null });
    expect(notes.at(-1)).toEqual({ account: MAIN, line: '[add] joined Discord invite discord.gg/pixelart' });
    // And the next look says you are in it.
    expect(((await resolve(MAIN, ref('discord.gg/pixelart'))).json as P.AddPreviewView).joined).toEqual({ space: v.spaceId! });
  });

  test('a check comes back as itself, never an error, and nothing was joined', async () => {
    const before = store.raw('SELECT id FROM space').length;
    const r = await add(MAIN, ref('discord.gg/speedrun'), 'join');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ check: 'captcha', spaceId: null, conversation: null, liveView: false });
    expect(store.raw('SELECT id FROM space').length).toBe(before);
    expect(notes.at(-1)!.line).toContain('captcha check wanted first, nothing done');
  });

  test('a friend request and a knock wait on the other side', async () => {
    expect((await add(ALT, ref('mara'), 'friend')).json).toMatchObject({ pending: true, relationship: 'requested' });
    expect((await add(MX, ref('#private-lab:matrix.org'), 'ask')).json).toMatchObject({ pending: true, notes: ['Asked; the admins decide'] });
  });

  test('joining a Matrix room by address opens it', async () => {
    const v = (await add(MX, ref('#rust-gamedev:matrix.org'), 'join')).json as P.AddResultView;
    expect(v.conversation).toMatchObject({ name: 'Rust Gamedev', network: 'matrix' });
  });
});

describe('previews kept for the hour', () => {
  const paced = (id: string) => store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = 'resolve'`, id)!.n;
  const resolves = () => sent.filter((s) => s.cmd.t === 'resolve').length;

  test('a second look within the hour asks nobody and costs nothing', async () => {
    const r = ref('https://t.me/+FilmSwap2026x');
    const first = await resolve(TG, r);
    expect(first.json).toMatchObject({ name: 'Film Photo Swap', actions: ['join'] });
    const [n, used] = [resolves(), paced(TG)];
    expect((await resolve(TG, ref('t.me/joinchat/FilmSwap2026x'))).json).toEqual(first.json);
    expect([resolves(), paced(TG)]).toEqual([n, used]);
  });

  test('a kept preview is served past the pace; a new reading is not', async () => {
    for (let i = paced(TG); i < ADD_LIMITS.resolve.max; i++) takePace(store.db, store.account(TG)!, 'resolve', clock);
    expect((await resolve(TG, ref('t.me/+ClimbAsk2026'))).status).toBe(429);
    expect((await resolve(TG, ref('t.me/+FilmSwap2026x'))).status).toBe(200);
    store.db.query('DELETE FROM add_pace WHERE account_id = ?').run(TG);
  });

  test('kept per account: another account asks for itself, and the page gets each without asking', async () => {
    const r = ref('discord.gg/pixelart');
    const n = resolves();
    expect(((await resolve(ALT, r)).json as P.AddPreviewView).accountId).toBe(ALT);
    expect(resolves()).toBe(n + 1);
    const got = await call('POST', '/api/add/cached', { refs: [r, ref('discord.gg/notlookedup'), { kind: 'invite', network: 'discord', code: 'x', url: 'https://evil.example/x' }] });
    expect(got.status).toBe(200);
    expect((got.json.previews as P.AddPreviewView[]).map((v) => `${v.accountId}:${v.name}`).sort()).toEqual([`${ALT}:Pixel Art Club`, `${MAIN}:Pixel Art Club`]);
    expect(resolves()).toBe(n + 1);
    expect((await call('POST', '/api/add/cached', { refs: 'discord.gg/pixelart' })).status).toBe(400);
    expect((await call('POST', '/api/add/cached', { refs: Array(PREVIEW_CACHE.perRequest + 1).fill(r) })).status).toBe(400);
  });

  test('joined after a look: the kept preview says so from then on, and a server you are in shows from the hub', async () => {
    const r = ref('https://chat.whatsapp.com/MapleGardenSwap26');
    expect((await resolve(WA, r)).json).toMatchObject({ joined: null, actions: ['join'] });
    const done = (await add(WA, r, 'join')).json as P.AddResultView;
    const n = resolves();
    expect((await resolve(WA, r)).json).toMatchObject({ joined: { conversation: done.conversation!.id }, actions: [] });
    expect(resolves()).toBe(n);
    // ALT never joined Pixel Art Club, but main did: the hub holds the server, so it is joined here.
    expect(((await resolve(ALT, ref('discord.gg/pixelart'))).json as P.AddPreviewView).joined).toEqual({ space: hubId('spc', 'discord', store.one<{ native_id: string }>(`SELECT native_id FROM space WHERE name = 'Pixel Art Club'`)!.native_id) });
  });

  test('an hour on it asks again; errors are never kept; the least used goes first', async () => {
    let t = clock;
    const a = new Adding({ store, online: () => true, command, note() {}, flush: () => store.flush(), liveView: () => false, now: () => t });
    const r = ref('t.me/+FilmSwap2026x');
    const n = resolves();
    await resolve(TG, r, a);
    t += PREVIEW_CACHE.ttlMs - 1;
    await resolve(TG, r, a);
    expect(resolves()).toBe(n + 1);
    t += 1;
    await resolve(TG, r, a);
    expect(resolves()).toBe(n + 2);
    expect((await resolve(MAIN, ref('discord.gg/oldparty'), a)).status).toBe(502);
    expect((await resolve(MAIN, ref('discord.gg/oldparty'), a)).status).toBe(502);
    expect(resolves()).toBe(n + 4);
    const max = PREVIEW_CACHE.max;
    PREVIEW_CACHE.max = 2;
    try {
      await resolve(TG, ref('@dithernews'), a);
      await resolve(TG, r, a); // used again: now the newest
      await resolve(TG, ref('@lena_k'), a); // three kept: @dithernews, the oldest used, goes
      const m = resolves();
      await resolve(TG, r, a);
      await resolve(TG, ref('@lena_k'), a);
      expect(resolves()).toBe(m);
      await resolve(TG, ref('@dithernews'), a);
      expect(resolves()).toBe(m + 1);
    } finally {
      PREVIEW_CACHE.max = max;
    }
    store.db.query('DELETE FROM add_pace WHERE account_id IN (?, ?) AND at > ?').run(TG, MAIN, clock);
  });
});

describe('pacing', () => {
  test('the limits are one constant', () => {
    expect(ADD_LIMITS.resolve).toMatchObject({ max: 60, networks: { whatsapp: 20 } });
    expect(ADD_LIMITS.join).toMatchObject({ max: 10, networks: { whatsapp: 5 } });
    expect(ADD_LIMITS.connect.max).toBe(20);
  });

  test('past the limit: 429 with when it frees up, and a restart does not reset it', async () => {
    const r = ref('#nixos:nixos.org');
    const used = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = 'resolve'`, MX)!.n;
    // A different address each time: one looked up within the hour is answered again without the network.
    for (let i = used; i < 60; i++) expect((await resolve(MX, ref(`#pace-${i}:nixos.org`))).status).toBe(502);
    const asked = sent.length;
    const over = await resolve(MX, r);
    expect(over.status).toBe(429);
    expect(over.json.error).toMatch(/^Matrix matrix\.org has looked up 60 links and names in the last hour, the most dither-chat lets one account\. The next frees up in \d+ minutes?\.$/);
    expect(over.json.retryAt).toBeGreaterThan(clock);
    expect(sent.length).toBe(asked);
    // The same database opened again, as after a restart.
    const again = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    expect((await resolve(MX, r, newAdding(again))).status).toBe(429);
    again.db.close();
    clock += 3_600_001;
    expect((await resolve(MX, r)).status).toBe(200);
  });

  test('joins: 10 a day, WhatsApp 5; adding people 20', () => {
    const acc = (network: P.Network, id: string) => ({ id, network, label: 'x' });
    store.createAccount({ id: 'acc_pace-d', network: 'discord', label: 'x', color: '#000', adapter: 'discord' });
    store.createAccount({ id: 'acc_pace-w', network: 'whatsapp', label: 'x', color: '#000', adapter: 'whatsapp' });
    const t = clock;
    for (let i = 0; i < 10; i++) expect(takePace(store.db, acc('discord', 'acc_pace-d'), 'join', t + i).ok).toBe(true);
    const no = takePace(store.db, acc('discord', 'acc_pace-d'), 'join', t + 20);
    expect(no.ok).toBe(false);
    if (!no.ok) {
      expect(no.retryAt).toBe(t + 86_400_000);
      expect(no.error).toContain('The next frees up in 24 hours.');
    }
    for (let i = 0; i < 5; i++) expect(takePace(store.db, acc('whatsapp', 'acc_pace-w'), 'join', t + i).ok).toBe(true);
    expect(takePace(store.db, acc('whatsapp', 'acc_pace-w'), 'join', t + 9).ok).toBe(false);
    for (let i = 0; i < 20; i++) expect(takePace(store.db, acc('discord', 'acc_pace-d'), 'connect', t + i).ok).toBe(true);
    expect(takePace(store.db, acc('discord', 'acc_pace-d'), 'connect', t + 30).ok).toBe(false);
    for (let i = 0; i < 20; i++) expect(takePace(store.db, acc('whatsapp', 'acc_pace-w'), 'resolve', t + i).ok).toBe(true);
    expect(takePace(store.db, acc('whatsapp', 'acc_pace-w'), 'resolve', t + 30).ok).toBe(false);
    // Forgotten with the account.
    store.deleteAccount('acc_pace-d');
    expect(store.one(`SELECT 1 FROM add_pace WHERE account_id = 'acc_pace-d'`)).toBeNull();
  });
});

describe('requests', () => {
  const ids = () => requestViews(store).map((r) => `${r.accountId}:${r.kind}`).sort();

  test('the demo says what waits after connect: a friend, a room invite, a message request', async () => {
    expect(ids()).toEqual([`${MX}:invite`, `${SIG}:message`, `${MAIN}:friend`].sort());
    const list = (await call('GET', '/api/requests')).json.requests as P.RequestView[];
    const friend = list.find((r) => r.kind === 'friend')!;
    expect(friend.id).toStartWith('req_');
    expect(friend.from).toBe(store.one<{ id: string }>(`SELECT id FROM identity WHERE handle = 'nova.wav'`)!.id);
    const invite = list.find((r) => r.kind === 'invite')!;
    expect(invite.target).toEqual({ kind: 'conversation', id: null, name: 'Nix Hackathon 2026', members: 23 });
    const msg = list.find((r) => r.kind === 'message')!;
    expect(msg.target!.id).toStartWith('cnv_');
  });

  test('one new, one gone, and a snapshot replaces only its own account', () => {
    const acc = store.account(WA)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: '15550142@s.whatsapp.net', handle: '+15550142' } });
    store.ingest(acc, { t: 'request', request: { nativeId: 'w1', kind: 'join', from: '15550142@s.whatsapp.net', target: { kind: 'conversation', nativeId: '120363000000000001@g.us', name: 'Book club' }, ts: 1, answers: ['accept', 'decline'] } });
    store.ingest(acc, { t: 'request', request: { nativeId: 'w2', kind: 'friend', ts: 2, answers: ['accept', 'bogus' as never] } });
    expect(ids().filter((x) => x.startsWith(WA))).toEqual([`${WA}:friend`, `${WA}:join`]);
    expect(requestViews(store).find((r) => r.nativeId === 'w2')!.answers).toEqual(['accept']);
    store.ingest(acc, { t: 'requestGone', nativeId: 'w2' });
    expect(ids().filter((x) => x.startsWith(WA))).toEqual([`${WA}:join`]);
    store.ingest(acc, { t: 'requests', requests: [] });
    expect(ids()).toEqual([`${MX}:invite`, `${SIG}:message`, `${MAIN}:friend`].sort());
    const events = store.flush();
    expect(events.filter((e) => e.t === 'requests')).toHaveLength(1);
  });

  test('connect, disconnect and restart leave the list alone; only a requests event replaces it', () => {
    const acc = store.account(MAIN)!;
    store.ingest(acc, { t: 'status', status: 'offline' });
    store.ingest(acc, { t: 'hello', network: 'discord', version: 'demo', capabilities: JSON.parse(acc.capabilities) });
    store.ingest(acc, { t: 'status', status: 'online' });
    expect(ids()).toContain(`${MAIN}:friend`);
  });

  test("a message request: out of the inbox, silent, and nothing told to the network", async () => {
    const r = requestViews(store).find((x) => x.kind === 'message')!;
    const cid = r.target!.id!;
    expect(requestHeld(store.db, cid)).toBe(true);
    const mid = store.one<{ id: string }>('SELECT id FROM message WHERE conversation_id = ?', cid)!.id;
    const d = await new Triage(store).decide(mid);
    expect(d?.decision).toBe('silent');
    expect(d?.reasons[0]).toContain('message request');

    const told: any[] = [];
    const sup = { authorize: () => null, online: () => true, command: async (id: string, c: any) => (told.push([id, c]), {}), note() {}, liveViewUrl: () => null } as any;
    const hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    const port = hub.start().port;
    try {
      store.setPrivacy({ ...store.privacy(), shareTyping: true });
      const read = await fetch(`http://127.0.0.1:${port}/api/conversations/${cid}/read`, { method: 'POST', body: JSON.stringify({ upToTs: Date.now() }) });
      expect(read.status).toBe(200);
      expect(hub.typing(cid, undefined, false)).toEqual({ sent: false, why: 'a message request' });
      expect(told.filter(([, c]) => c.t === 'markRead' || c.t === 'typing')).toEqual([]);
      // Any other conversation still is.
      const other = store.one<{ id: string }>(`SELECT c.id FROM conversation c JOIN vantage v ON v.target_id = c.id WHERE v.account_id = ? AND c.shape = 'direct' AND c.id != ? AND c.last_message_id IS NOT NULL`, SIG, cid)!.id;
      await fetch(`http://127.0.0.1:${port}/api/conversations/${other}/read`, { method: 'POST', body: JSON.stringify({ upToTs: Date.now() }) });
      expect(told.some(([, c]) => c.t === 'markRead')).toBe(true);
    } finally {
      hub.stop();
    }
  });

  test('answers: only what the request offers, and an accepted one is gone', async () => {
    const invite = requestViews(store).find((r) => r.kind === 'invite')!;
    const bad = await call('POST', `/api/requests/${invite.id}`, { answer: 'block' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('This request can be answered with accept, decline');
    expect((await call('POST', '/api/requests/req_nope', { answer: 'accept' })).status).toBe(404);
    const ok = await call('POST', `/api/requests/${invite.id}`, { answer: 'accept' });
    expect(ok.status).toBe(200);
    expect((ok.json as P.AddResultView).conversation).toMatchObject({ name: 'Nix Hackathon 2026' });
    expect(requestViews(store).some((r) => r.id === invite.id)).toBe(false);
    expect(notes.at(-1)).toEqual({ account: MX, line: '[add] accepted the invite request (Nix Hackathon 2026)' });
  });

  test('an account without the capability cannot answer', async () => {
    const friend = requestViews(store).find((r) => r.kind === 'friend')!;
    const acc = store.account(MAIN)!;
    store.updateAccount(MAIN, { capabilities: JSON.stringify((JSON.parse(acc.capabilities) as string[]).filter((c) => c !== 'requests')) });
    const r = await call('POST', `/api/requests/${friend.id}`, { answer: 'accept' });
    store.updateAccount(MAIN, { capabilities: acc.capabilities });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Answering Discord requests isn't built for this account yet");
  });

  test('forgotten with the account', () => {
    store.deleteAccount(SIG);
    expect(requestViews(store).some((r) => r.accountId === SIG)).toBe(false);
  });
});
