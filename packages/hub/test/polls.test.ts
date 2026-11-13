/**
 * Polls (protocol poll.ts, docs/polls.md): a poll as its message carries it, Signal's whole votes tallied with the
 * latest of each voter winning, Discord's counts and changes by one, a poll ending, the vote / make / end routes and
 * the quiet message-request rule; and pins the hub saw added to a network's About that keeps no list.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { pollDraftProblem, pollVoteProblem } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { pinnedSeen } from '../src/about.ts';
import { pollFact } from '../src/polls.ts';
import { HubServer } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const SELF = 'self-aci';
const ALICE = 'alice-aci';
const BOB = 'bob-aci';
const GROUP = 'group:g1';
const T = 1_793_330_000_000;
const DSELF = '100';
const CHAN = '500';

const dir = mkdtempSync(join(tmpdir(), 'dither-polls-'));
let store: Store;
let hub: HubServer;
let sig: AccountRow;
let dis: AccountRow;
let base = '';
const commands: { account: string; cmd: any }[] = [];
const online = new Set<string>();
let answer: (cmd: any) => unknown = () => ({});

const POLL: P.PollFact = { question: 'Which night?', options: [{ id: '0', text: 'Tue' }, { id: '1', text: 'Thu' }, { id: '2', text: 'Both' }] };
const view = (network: P.Network, nativeId: string) => store.messageView(hubId('msg', network, nativeId))!;
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: r.status, body: (await r.json()) as any };
};
const vote = (voter: string, options: string[], seq: number, message = `${ALICE}:${T}`) =>
  store.ingest(sig, { t: 'pollUpdate', conversation: GROUP, message, vote: { voter, options, seq, ts: T + seq } });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const sup = {
    authorize: () => null,
    online: (id: string) => online.has(id),
    stop: async () => {},
    command: async (account: string, cmd: any) => (commands.push({ account, cmd }), answer(cmd)),
  } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  base = `http://127.0.0.1:${hub.start().port}`;
  sig = store.createAccount({ network: 'signal', label: 'sig', color: '#111', adapter: 'signal' });
  store.ingest(sig, { t: 'hello', network: 'signal', version: '1', capabilities: ['send', 'polls', 'pollVote', 'pollCreate', 'pollEnd', 'pin'] });
  store.ingest(sig, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true } });
  online.add(sig.id);
  for (const [id, name] of [[ALICE, 'Alice'], [BOB, 'Bob']]) store.ingest(sig, { t: 'identity', identity: { nativeId: id, displayName: name } });
  store.ingest(sig, { t: 'conversation', conversation: { nativeId: GROUP, shape: 'group', name: 'Crew', participants: [SELF, ALICE, BOB] } });
  store.ingest(sig, { t: 'message', live: false, message: { nativeId: `${ALICE}:${T}`, conversation: GROUP, author: ALICE, ts: T, body: '📊 Which night?', extra: { poll: POLL } } });

  dis = store.createAccount({ network: 'discord', label: 'dis', color: '#222', adapter: 'discord' });
  store.ingest(dis, { t: 'hello', network: 'discord', version: '1', capabilities: ['send', 'polls', 'pollVote', 'pollCreate', 'pollEnd'] });
  store.ingest(dis, { t: 'status', status: 'online', self: { nativeId: DSELF, isSelf: true } });
  online.add(dis.id);
  store.ingest(dis, { t: 'conversation', conversation: { nativeId: CHAN, shape: 'channel', name: 'general' } });
});

afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the model', () => {
  test("reads the shape older Signal adapters wrote, options by position", () => {
    expect(pollFact({ question: 'Q', options: ['a', 'b'], allowMultiple: true })).toEqual({ question: 'Q', options: [{ id: '0', text: 'a' }, { id: '1', text: 'b' }], multi: true });
    expect(pollFact({ question: 'Q', options: [] })).toBeNull();
    expect(pollFact('nope')).toBeNull();
  });

  test('a draft as each network allows it', () => {
    const d = { question: 'Lunch?', options: ['Pizza', 'Tacos'], multi: false };
    expect(pollDraftProblem('discord', { ...d, hours: 24 })).toBeNull();
    expect(pollDraftProblem('discord', { ...d, hours: 5 })).toContain('durations');
    expect(pollDraftProblem('signal', { ...d, hours: 24 })).toContain('no timer');
    expect(pollDraftProblem('signal', { ...d, options: ['Pizza'] })).toContain('at least 2');
    expect(pollDraftProblem('signal', { ...d, options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).toContain('at most 10');
    expect(pollDraftProblem('signal', { ...d, options: ['Pizza', 'pizza'] })).toContain('same');
    expect(pollDraftProblem('matrix', d)).toContain('no polls');
  });

  test('a vote as the choice rule allows it', () => {
    const p = { options: POLL.options, multi: false, ended: false };
    expect(pollVoteProblem(p, ['0'])).toBeNull();
    expect(pollVoteProblem(p, [])).toBeNull();
    expect(pollVoteProblem(p, ['0', '1'])).toContain('one choice');
    expect(pollVoteProblem({ ...p, multi: true }, ['0', '1'])).toBeNull();
    expect(pollVoteProblem(p, ['9'])).toContain('Not an option');
    expect(pollVoteProblem({ ...p, ended: true }, ['0'])).toContain('ended');
  });
});

describe("Signal's votes", () => {
  test('a poll with no votes yet', () => {
    const p = view('signal', `${ALICE}:${T}`).poll!;
    expect(p).toMatchObject({ question: 'Which night?', multi: false, ended: false, counted: false, voters: null });
    expect(p.options.map((o) => o.count)).toEqual([0, 0, 0]);
  });

  test('each voter counts once, by their latest vote; an older one heard late changes nothing; voters are named', () => {
    vote(ALICE, ['0'], 1);
    vote(BOB, ['2'], 1);
    vote(ALICE, ['1'], 2);
    vote(ALICE, ['0'], 1); // late and older
    const p = view('signal', `${ALICE}:${T}`).poll!;
    expect(p.counted).toBe(true);
    expect(p.voters).toBe(2);
    expect(p.options.map((o) => o.count)).toEqual([0, 1, 1]);
    expect(p.options[1].voters).toEqual([hubId('idn', 'signal', ALICE)]);
  });

  test('your own vote is marked, with its number for the next one; taking it back counts you out', () => {
    vote(SELF, ['2'], 3);
    let p = view('signal', `${ALICE}:${T}`).poll!;
    expect(p.options[2]).toMatchObject({ count: 2, mine: true });
    expect(p.seq).toBe(3);
    vote(SELF, [], 4);
    p = view('signal', `${ALICE}:${T}`).poll!;
    expect(p.options[2].mine).toBe(false);
    expect(p.voters).toBe(2);
  });

  test('a vote on a poll the hub does not have is dropped', () => {
    vote(BOB, ['0'], 1, `${ALICE}:${T - 99}`);
    expect(store.db.query('SELECT COUNT(*) AS n FROM poll_vote').get()).toEqual({ n: 3 });
  });

  test('voting goes to the account with the last number; a choice the poll does not take is refused first', async () => {
    commands.length = 0;
    const id = hubId('msg', 'signal', `${ALICE}:${T}`);
    expect((await post(`/api/messages/${id}/vote`, { options: ['0', '1'] })).body.error).toContain('one choice');
    const r = await post(`/api/messages/${id}/vote`, { options: ['1'] });
    expect(r.status).toBe(200);
    expect(commands.at(-1)?.cmd).toMatchObject({ t: 'pollVote', conversation: GROUP, message: `${ALICE}:${T}`, options: ['1'], seq: 4 });
  });

  test('only the author ends a poll', async () => {
    const r = await post(`/api/messages/${hubId('msg', 'signal', `${ALICE}:${T}`)}/end-poll`);
    expect(r.status).toBe(403);
  });
});

describe("Discord's counts", () => {
  const MSG = '900';
  test('counts from the message, then changes by one, then a fresh message wins', () => {
    const poll: P.PollFact = { question: 'Lunch?', options: [{ id: '1', text: 'Pizza' }, { id: '2', text: 'Tacos' }], expires: Date.now() + 86_400_000, counts: { '1': 3, '2': 1 } };
    store.ingest(dis, { t: 'message', live: false, message: { nativeId: MSG, conversation: CHAN, author: DSELF, ts: T, body: '**Lunch?**', extra: { poll } } });
    expect(view('discord', MSG).poll!.options.map((o) => o.count)).toEqual([3, 1]);
    store.ingest(dis, { t: 'pollUpdate', conversation: CHAN, message: MSG, add: { '2': 1 } });
    // Your own vote said alone: the counts move by what changed in it.
    store.ingest(dis, { t: 'pollUpdate', conversation: CHAN, message: MSG, mine: ['1'] });
    expect(view('discord', MSG).poll!.options.map((o) => [o.count, o.mine])).toEqual([[4, true], [2, false]]);
    store.ingest(dis, { t: 'pollUpdate', conversation: CHAN, message: MSG, mine: ['2'] });
    let p = view('discord', MSG).poll!;
    expect(p.options.map((o) => [o.count, o.mine])).toEqual([[3, false], [3, true]]);
    expect(p.options[0].voters).toBeUndefined();
    store.ingest(dis, { t: 'message', live: false, message: { nativeId: MSG, conversation: CHAN, author: DSELF, ts: T, body: '**Lunch?**', extra: { poll: { ...poll, counts: { '1': 5, '2': 5 } } } } });
    p = view('discord', MSG).poll!;
    expect(p.options.map((o) => o.count)).toEqual([5, 5]);
  });

  test('your own poll ends early through its account, and shows ended', async () => {
    commands.length = 0;
    const r = await post(`/api/messages/${hubId('msg', 'discord', MSG)}/end-poll`);
    expect(r.status).toBe(200);
    expect(commands.at(-1)?.cmd).toMatchObject({ t: 'pollEnd', conversation: CHAN, message: MSG });
    expect(view('discord', MSG).poll!.ended).toBe(true);
    expect((await post(`/api/messages/${hubId('msg', 'discord', MSG)}/vote`, { options: ['1'] })).body.error).toContain('ended');
  });

  test('a poll past its time is ended', () => {
    store.ingest(dis, { t: 'message', live: false, message: { nativeId: '901', conversation: CHAN, author: DSELF, ts: T, body: 'old', extra: { poll: { question: 'Old?', options: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }], expires: Date.now() - 1000 } } } });
    expect(view('discord', '901').poll!.ended).toBe(true);
  });

  test('making a poll checks it, picks the default duration, and sends it', async () => {
    commands.length = 0;
    answer = (cmd) => (cmd.t === 'pollCreate' ? { nativeId: '950' } : {});
    const cid = hubId('cnv', 'discord', CHAN);
    expect((await post(`/api/conversations/${cid}/polls`, { question: 'Q', options: ['a'] })).body.error).toContain('at least 2');
    const r = await post(`/api/conversations/${cid}/polls`, { question: 'Q', options: ['a', 'b'], multi: true });
    expect(r.body).toMatchObject({ ok: true, messageId: hubId('msg', 'discord', '950') });
    expect(commands.at(-1)?.cmd).toMatchObject({ t: 'pollCreate', conversation: CHAN, poll: { question: 'Q', options: ['a', 'b'], multi: true, hours: 24 } });
    answer = () => ({});
  });
});

describe('a message request stays quiet', () => {
  test('no vote and no poll in a conversation an open request is about', async () => {
    const REQ = `dm:${SELF}:stranger`;
    store.ingest(sig, { t: 'conversation', conversation: { nativeId: REQ, shape: 'direct', participants: [SELF, 'stranger'] } });
    store.ingest(sig, { t: 'message', live: false, message: { nativeId: `stranger:${T}`, conversation: REQ, author: 'stranger', ts: T, body: 'poll', extra: { poll: POLL } } });
    store.ingest(sig, { t: 'request', request: { nativeId: 'req-1', kind: 'message', from: 'stranger', target: { kind: 'conversation', nativeId: REQ }, ts: T, answers: ['accept', 'delete'] } as any });
    commands.length = 0;
    expect((await post(`/api/messages/${hubId('msg', 'signal', `stranger:${T}`)}/vote`, { options: ['0'] })).body.error).toContain('Accept');
    expect((await post(`/api/conversations/${hubId('cnv', 'signal', REQ)}/polls`, { question: 'Q', options: ['a', 'b'] })).body.error).toContain('Accept');
    expect(commands).toEqual([]);
  });
});

describe('pins the hub saw', () => {
  test('the latest pin or unpin of each message decides, newest pin first', () => {
    for (const [n, at] of [['p1', 1], ['p2', 2], ['p3', 3]] as const) {
      store.ingest(sig, { t: 'message', live: false, message: { nativeId: `${ALICE}:${n}`, conversation: GROUP, author: ALICE, ts: T, body: n } });
      store.ingest(sig, { t: 'pin', conversation: GROUP, message: `${ALICE}:${n}`, pinned: true, ts: T + at });
    }
    store.ingest(sig, { t: 'pin', conversation: GROUP, message: `${ALICE}:p2`, pinned: false, ts: T + 10 });
    expect(pinnedSeen(store, hubId('cnv', 'signal', GROUP))).toEqual([hubId('msg', 'signal', `${ALICE}:p3`), hubId('msg', 'signal', `${ALICE}:p1`)]);
  });
});
