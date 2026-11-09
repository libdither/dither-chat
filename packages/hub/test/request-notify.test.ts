/**
 * A new request notifies once, and only from someone you know (requestnotify.ts, docs/add.md "Requests"), against the
 * demo world's adapters run in process: someone in a group with the account, a person here, someone who wrote in a
 * server the account sees; never a stranger, never a message request from one; once per request, also across a
 * reconnect; not when old, answered before it settled, in quiet hours, or where it was set to Nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { requestViews } from '../src/add.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { judgeRequest, knownTo, REQUEST_NOTICE, RequestNotifier, requestChain } from '../src/requestnotify.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-reqnotify-'));
let store: Store;
let notifier: RequestNotifier;
let clock = Date.now();
const adapters: { stop(): void }[] = [];

const MAIN = 'acc_demo-discord-main';
const MX = 'acc_demo-matrix';
const SIG = 'acc_demo-signal';
const settled = () => (clock += REQUEST_NOTICE.settleMs + 1);
const selfNative = (account: string) => store.one<{ native_id: string }>('SELECT i.native_id FROM account a JOIN identity i ON i.id = a.self_identity WHERE a.id = ?', account)!.native_id;
const identity = (network: P.Network, handle: string) => store.one<{ id: string; native_id: string }>('SELECT id, native_id FROM identity WHERE network = ? AND handle = ?', network, handle)!;

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  // Before the adapters: it hears what they send after connecting.
  notifier = new RequestNotifier(store, () => clock);
  for (const acc of createDemoAccounts(store)) {
    const adir = join(dir, acc.id);
    mkdirSync(adir, { recursive: true });
    const a = demoFactory(acc, adir)! as unknown as { stop(): void; start(e: (ev: P.AdapterEvent) => void): void };
    adapters.push(a);
    a.start((ev) => ev.t !== 'reply' && store.ingest(store.account(acc.id)!, ev));
  }
  store.flush();
});

afterAll(() => {
  for (const a of adapters) a.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A request as an adapter sends one. */
function request(account: string, f: Partial<P.RequestFact> & { nativeId: string }) {
  store.ingest(store.account(account)!, { t: 'request', request: { kind: 'friend', ts: clock - 60_000, answers: ['accept', 'decline'], ...f } });
}

describe('who is known', () => {
  test('after the demo connects: the room invite from a housemate notifies, the strangers and the message request do not', () => {
    expect(requestViews(store)).toHaveLength(5);
    expect(notifier.due(clock)).toEqual([]);
    const out = notifier.due(settled());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ accountId: MX, network: 'matrix', title: 'Jules invited you to Nix Hackathon 2026', body: 'On Matrix matrix.org. It waits under Requests.' });
    expect(out[0].requestId).toStartWith('req_');
    expect(notifier.due(settled())).toEqual([]);
  });

  test('once per request: the same list again after a reconnect is not news', () => {
    const acc = store.account(MX)!;
    const facts = requestViews(store)
      .filter((r) => r.accountId === MX)
      .map((r): P.RequestFact => ({ nativeId: r.nativeId, kind: r.kind, ts: r.ts, answers: r.answers, from: store.one<{ native_id: string }>('SELECT native_id FROM identity WHERE id = ?', r.from)!.native_id }));
    store.ingest(acc, { t: 'requests', requests: [] });
    store.ingest(acc, { t: 'requests', requests: facts });
    expect(notifier.due(settled())).toEqual([]);
  });

  test('a person here: a Discord friend', () => {
    const alice = identity('discord', 'alice.chen');
    expect(knownTo(store.db, MAIN, alice.id, null)).toBe(true);
    request(MAIN, { nativeId: 'friend-alice', from: alice.native_id });
    const out = notifier.due(settled());
    expect(out.map((n) => n.title)).toEqual(['Alice wants to be friends']);
  });

  test('someone who wrote in a server channel the account sees', () => {
    const tim = identity('discord', 'tokio_tim');
    expect(store.one('SELECT person_id FROM identity WHERE id = ?', tim.id)).toEqual({ person_id: null });
    expect(knownTo(store.db, MAIN, tim.id, null)).toBe(true);
    request(MAIN, { nativeId: 'friend-tim', kind: 'follow', from: tim.native_id });
    expect(notifier.due(settled()).map((n) => n.title)).toEqual(['Tim asked to follow you']);
  });

  test('a stranger: silent, on the row only', () => {
    const acc = store.account(MAIN)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: '991100000000000001', handle: 'nobody.here', displayName: 'Nobody' } });
    request(MAIN, { nativeId: 'friend-nobody', from: '991100000000000001' });
    expect(notifier.due(settled())).toEqual([]);
    expect(requestViews(store).some((r) => r.nativeId === 'friend-nobody')).toBe(true);
  });
});

describe('message requests', () => {
  const peer = 'b0b0b0b0-0000-4000-8000-000000000001';
  const dm = () => `dm:${selfNative(SIG)}:${peer}`;

  test('from a stranger: silent, though its conversation made them a person', () => {
    const jamie = requestViews(store).find((r) => r.kind === 'message')!;
    const pid = store.one<{ person_id: string | null }>('SELECT person_id FROM identity WHERE id = ?', jamie.from)!.person_id;
    expect(pid).toStartWith('per_');
    expect(knownTo(store.db, SIG, jamie.from!, jamie.target!.id)).toBe(false);
    expect(judgeRequest(store, SIG, jamie.nativeId, clock)).toBeNull();
  });

  test('from someone in a group with the account: it notifies', () => {
    const acc = store.account(SIG)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: peer, handle: '+1 555 0444', displayName: 'Rowan' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: dm(), shape: 'direct', participants: [selfNative(SIG), peer], encrypted: true } });
    request(SIG, { nativeId: `msgreq-${peer}`, kind: 'message', from: peer, target: { kind: 'conversation', nativeId: dm() }, answers: ['accept', 'decline', 'block'] });
    // Alone: only the conversation it is about, which says nothing.
    const held = hubId('cnv', 'signal', dm());
    expect(knownTo(store.db, SIG, hubId('idn', 'signal', peer), held)).toBe(false);
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'group:rowan-and-me', shape: 'group', name: 'Board games', participants: [selfNative(SIG), peer] } });
    expect(knownTo(store.db, SIG, hubId('idn', 'signal', peer), held)).toBe(true);
    expect(notifier.due(settled()).map((n) => n.title)).toEqual(['Rowan sent you a message request']);
  });
});

describe('when not', () => {
  const alice = () => identity('discord', 'alice.chen');

  test('older than two days when first heard: not news', () => {
    request(MAIN, { nativeId: 'friend-old', from: alice().native_id, ts: clock - REQUEST_NOTICE.recentMs - 60_000 });
    expect(notifier.due(settled())).toEqual([]);
  });

  test('answered or withdrawn before it settled: nothing, and judged when it comes back', () => {
    request(MAIN, { nativeId: 'friend-gone', from: alice().native_id });
    store.ingest(store.account(MAIN)!, { t: 'requestGone', nativeId: 'friend-gone' });
    expect(notifier.due(settled())).toEqual([]);
    request(MAIN, { nativeId: 'friend-gone', from: alice().native_id });
    expect(notifier.due(settled())).toHaveLength(1);
  });

  test('quiet hours hold it; a starred person gets through where you let them', () => {
    const d = new Date(clock);
    const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const now = d.getUTCHours() * 60 + d.getUTCMinutes();
    store.setQuietHours({ enabled: true, start: hhmm(now + 1440 - 60), end: hhmm(now + 60), timezone: 'UTC', allowStarred: true });
    request(MAIN, { nativeId: 'friend-quiet', from: alice().native_id });
    expect(notifier.due(settled())).toEqual([]);
    const pid = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', alice().id)!.person_id;
    store.db.query('UPDATE person SET starred = 1 WHERE id = ?').run(pid);
    request(MAIN, { nativeId: 'friend-starred', from: alice().native_id });
    expect(notifier.due(settled())).toHaveLength(1);
    store.db.query('UPDATE person SET starred = 0 WHERE id = ?').run(pid);
    store.setQuietHours({ enabled: false, start: '22:00', end: '07:00', timezone: 'UTC', allowStarred: true });
  });

  test('the account or the network set to Nothing or the digest: silent', () => {
    store.setRule('account', MAIN, 'none');
    request(MAIN, { nativeId: 'friend-muted', from: alice().native_id });
    expect(notifier.due(settled())).toEqual([]);
    store.setRule('account', MAIN, null);
    store.setRule('network', 'discord', 'digest');
    request(MAIN, { nativeId: 'friend-digest', from: alice().native_id });
    expect(notifier.due(settled())).toEqual([]);
    store.setRule('network', 'discord', null);
    // A level that notifies leaves it be.
    store.setRule('account', MAIN, 'mentions');
    request(MAIN, { nativeId: 'friend-mentions', from: alice().native_id });
    expect(notifier.due(settled())).toHaveLength(1);
    store.setRule('account', MAIN, null);
  });
});

describe('around it', () => {
  test('device rules for a request: its account, then its network', () => {
    const r = requestViews(store).find((x) => x.accountId === MAIN)!;
    expect(requestChain(store.db, r.id)).toEqual([`account:${MAIN}`, 'network:discord']);
    expect(requestChain(store.db, 'req_nope')).toBeNull();
  });

  test('requests the hub held before it judged any are not news', () => {
    const acc = store.account(MAIN)!;
    store.ingest(acc, { t: 'request', request: { nativeId: 'friend-before', kind: 'friend', from: identity('discord', 'alice.chen').native_id, ts: clock, answers: ['accept'] } });
    store.db.exec('DROP TABLE add_request_seen');
    // A hub that predates the table opens the same database.
    const again = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    try {
      expect(judgeRequest(again, MAIN, 'friend-before', clock)).toBeNull();
    } finally {
      again.db.close();
    }
  });
});
