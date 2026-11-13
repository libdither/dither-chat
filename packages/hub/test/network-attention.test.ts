/**
 * What a network knows about your attention, as the hub takes it in (protocol attention.ts, docs/notifications.md
 * "From the network itself"): mentions heard late are triaged only while young by their own time, a read point the
 * network moved back by hand moves back here, many reads go in one request where the account can, @everyone in a
 * server that suppresses it would not have notified, a request filed as spam never notifies, and a mute set on the
 * network goes through every account that can.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { LATE_NEWS_MS } from '@dither-chat/protocol';
import { AboutError } from '../src/about.ts';
import { lateNews } from '../src/latenews.ts';
import { setNativeMute } from '../src/nativemute.ts';
import { ReadQueue } from '../src/readqueue.ts';
import { judgeRequest } from '../src/requestnotify.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { markUnreadFrom } from '../src/unread.ts';

let dir: string;
let store: Store;
let d: AccountRow;
let n = 0;
const MIN = 60_000;

const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
const vantage = (native: string) => store.one<{ unread: number; mentions: number; last_read_ts: number }>(`SELECT unread, mentions, last_read_ts FROM vantage WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`, d.id, cid(native))!;
const msg = (conversation: string, ts: number, over: Partial<P.MessageFact> = {}): P.MessageFact => ({ nativeId: `m${++n}`, conversation, author: 'ann', ts, body: 'hi <@me>', mentionsSelf: true, ...over });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-netattn-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  store.ingest(d, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(d, { t: 'space', space: { nativeId: 'g', kind: 'community', name: 'Guild' } });
  for (const c of ['general', 'quiet', 'old'])
    store.ingest(d, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', name: c, spaces: [{ nativeId: 'g' }] } });
  d = store.account(d.id)!;
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mentions heard late', () => {
  test('young by its own time: triaged as a live one would be; old: only unread', () => {
    const now = Date.now();
    const young = msg('general', now - 2 * MIN);
    const old = msg('general', now - LATE_NEWS_MS - MIN);
    expect(store.ingest(d, { t: 'message', message: young, live: false, late: true })).toHaveLength(1);
    expect(store.ingest(d, { t: 'message', message: old, live: false, late: true })).toEqual([]);
    expect(vantage('general')).toMatchObject({ unread: 2, mentions: 2 });
  });

  test('never news twice, and never without `late`', () => {
    const now = Date.now();
    const m = msg('general', now - MIN);
    expect(store.ingest(d, { t: 'message', message: m, live: true })).toHaveLength(1);
    expect(store.ingest(d, { t: 'message', message: m, live: false, late: true })).toEqual([]);
    expect(store.ingest(d, { t: 'message', message: msg('general', now - MIN), live: false })).toEqual([]);
  });

  test('the rule itself: live wins, a time ahead of the clock is not news, nor a missing one', () => {
    const now = Date.UTC(2026, 10, 12, 12);
    const ev = (ts: number, o: Partial<Extract<P.AdapterEvent, { t: 'message' }>> = {}): Extract<P.AdapterEvent, { t: 'message' }> => ({ t: 'message', message: msg('general', ts), live: false, late: true, ...o });
    expect(lateNews(ev(now - LATE_NEWS_MS), now)).toBe(true);
    expect(lateNews(ev(now - LATE_NEWS_MS - 1), now)).toBe(false);
    expect(lateNews(ev(now, { live: true }), now)).toBe(false);
    expect(lateNews(ev(now, { late: undefined }), now)).toBe(false);
    expect(lateNews(ev(now + 2 * LATE_NEWS_MS), now)).toBe(false);
    expect(lateNews(ev(Number.NaN), now)).toBe(false);
  });
});

describe('a read point moved back on the network', () => {
  test('marked unread by hand: it moves back and the unread are counted again; otherwise it only moves forward', () => {
    const t0 = Date.now() - 60 * MIN;
    for (let i = 0; i < 3; i++) store.ingest(d, { t: 'message', message: msg('old', t0 + i * MIN, { mentionsSelf: false, body: 'x' }), live: false });
    store.ingest(d, { t: 'read', conversation: 'old', upToTs: t0 + 2 * MIN, unread: 0, mentions: 0 });
    expect(vantage('old')).toMatchObject({ unread: 0, last_read_ts: t0 + 2 * MIN });
    store.ingest(d, { t: 'read', conversation: 'old', upToTs: t0 });
    expect(vantage('old').last_read_ts).toBe(t0 + 2 * MIN);
    store.ingest(d, { t: 'read', conversation: 'old', upToTs: t0, manual: true });
    expect(vantage('old')).toMatchObject({ unread: 2, last_read_ts: t0 });
  });
});

describe('Mark Unread from a message', () => {
  test('the read point moves back to just before it, counted again, and a network that can is told', () => {
    const t0 = Date.now() - 30 * MIN;
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'mu', shape: 'group', name: 'mu' } });
    for (let i = 0; i < 3; i++) store.ingest(d, { t: 'message', message: msg('mu', t0 + i * MIN, { nativeId: `mu-${i}`, mentionsSelf: i === 2 }), live: false });
    store.ingest(d, { t: 'read', conversation: 'mu', upToTs: t0 + 5 * MIN, unread: 0, mentions: 0 });
    const sent: any[] = [];
    const link = { online: () => true, command: async (_a: string, c: any) => void sent.push(c) };
    const id = (n: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', n)!.id;
    expect(markUnreadFrom(store, link, id('mu-1'))).toEqual({ conversationId: cid('mu'), told: [] });
    expect(vantage('mu')).toMatchObject({ unread: 2, mentions: 1, last_read_ts: t0 + MIN - 1 });
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead', 'markUnread'] });
    expect(markUnreadFrom(store, link, id('mu-2'))?.told).toEqual([d.id]);
    expect(sent).toEqual([{ t: 'markUnread', conversation: 'mu', from: 'mu-2' }]);
    expect(vantage('mu')).toMatchObject({ unread: 1, mentions: 1 });
    expect(markUnreadFrom(store, link, 'msg_nothing')).toBeNull();
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead'] });
  });
});

describe('many read in one request', () => {
  test('an account with markReadMany gets one batch; one without, one at a time', async () => {
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead', 'markReadMany'] });
    for (const c of ['b1', 'b2', 'b3']) {
      store.ingest(d, { t: 'conversation', conversation: { nativeId: c, shape: 'group', name: c } });
      store.ingest(d, { t: 'message', message: msg(c, Date.now() - MIN, { nativeId: `${c}-1`, mentionsSelf: false }), live: true });
    }
    const sent: any[] = [];
    const q = new ReadQueue(store, { online: () => true, command: async (_a, c) => void sent.push(c) }, { discord: 1500 } as any);
    q.add(['b1', 'b2', 'b3'].map(cid));
    await q.tick(10_000);
    expect(sent).toEqual([{ t: 'markReadMany', items: [{ conversation: 'b1', upTo: 'b1-1' }, { conversation: 'b2', upTo: 'b2-1' }, { conversation: 'b3', upTo: 'b3-1' }] }]);
    expect(q.pending()).toBe(0);
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead'] });
  });

  test('a refused batch waits and is tried again as one', async () => {
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead', 'markReadMany'] });
    store.ingest(d, { t: 'message', message: msg('b1', Date.now(), { nativeId: 'b1-2', mentionsSelf: false }), live: true });
    let fail = true;
    const sent: any[] = [];
    const q = new ReadQueue(store, { online: () => true, command: async (_a, c) => { if (fail) throw new Error('rate limited'); sent.push(c); } }, { discord: 1500 } as any);
    q.add([cid('b1')]);
    await q.tick(20_000);
    expect(q.pending()).toBe(1);
    fail = false;
    await q.tick(20_000 + 31_000);
    expect(sent).toEqual([{ t: 'markReadMany', items: [{ conversation: 'b1', upTo: 'b1-2' }] }]);
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead'] });
  });
});

describe('@everyone in a server that suppresses it', () => {
  test('would not have notified: the network-notify fact is off there, and on elsewhere', async () => {
    const triage = new Triage(store);
    triage.judge = async () => 0.01;
    store.ingest(d, { t: 'space', space: { nativeId: 'loud', kind: 'community', name: 'Loud' } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'ann1', shape: 'channel', name: 'ann1', spaces: [{ nativeId: 'loud' }] } });
    const everyone = (c: string) => {
      const m = msg(c, Date.now(), { body: '@everyone meeting', mentionsSelf: true, mentionsAll: true });
      store.ingest(d, { t: 'message', message: m, live: true });
      return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', m.nativeId)!.id;
    };
    expect((await triage.decide(everyone('ann1')))?.facts?.notify).toBe(true);
    store.ingest(d, { t: 'space', space: { nativeId: 'loud', kind: 'community', name: 'Loud', mute: { suppressEveryone: true } } });
    expect((await triage.decide(everyone('ann1')))?.facts?.notify).toBe(false);
  });
});

describe('a request the network filed as spam', () => {
  test('never notifies, even from someone the account knows', () => {
    // Ann shares a server with the account: someone it knows.
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'req', shape: 'direct', participants: ['me', 'ann'] } });
    const ts = Date.now();
    store.ingest(d, { t: 'request', request: { nativeId: 'message:1', kind: 'message', from: 'ann', target: { kind: 'conversation', nativeId: 'req' }, ts, answers: ['accept', 'decline'], spam: true, warning: 'Discord filed this message as spam' } });
    expect(judgeRequest(store, d.id, 'message:1', ts + 30_000)).toBeNull();
    store.ingest(d, { t: 'request', request: { nativeId: 'friend:ann', kind: 'friend', from: 'ann', ts, answers: ['accept'] } });
    expect(judgeRequest(store, d.id, 'friend:ann', ts + 30_000)).not.toBeNull();
  });
});

describe('muting on the network', () => {
  const link = (o: { online?: boolean; fail?: string } = {}) => {
    const sent: any[] = [];
    return {
      sent,
      online: () => o.online ?? true,
      command: async <T,>(_a: string, c: any): Promise<T> => {
        if (o.fail) throw new Error(o.fail);
        sent.push(c);
        return { level: 'none', muted: true } as T;
      },
    };
  };
  const quiet = () => cid('quiet');

  test('needs a connected account that can, and one of the timers', async () => {
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead'] });
    await expect(setNativeMute(store, link(), 'conversation', quiet(), { muted: true })).rejects.toMatchObject({ status: 409 });
    store.ingest(d, { t: 'hello', network: 'discord', version: 't', capabilities: ['markRead', 'mute'] });
    await expect(setNativeMute(store, link({ online: false }), 'conversation', quiet(), { muted: true })).rejects.toMatchObject({ status: 409 });
    await expect(setNativeMute(store, link(), 'conversation', quiet(), { muted: true, minutes: 7 })).rejects.toBeInstanceOf(AboutError);
    await expect(setNativeMute(store, link(), 'conversation', 'cnv_nothing', { muted: true })).rejects.toMatchObject({ status: 404 });
  });

  test('a timer becomes an end; until turned off, none; unmute carries no end', async () => {
    const l = link();
    const now = Date.UTC(2026, 10, 12, 12);
    const r = await setNativeMute(store, l, 'conversation', quiet(), { muted: true, minutes: 60 }, now);
    expect(r).toEqual({ done: [{ accountId: d.id, mute: { level: 'none', muted: true } }], failed: [] });
    await setNativeMute(store, l, 'conversation', quiet(), { muted: true, minutes: null }, now);
    await setNativeMute(store, l, 'conversation', quiet(), { muted: false, minutes: 60 }, now);
    expect(l.sent).toEqual([
      { t: 'mute', target: { kind: 'conversation', nativeId: 'quiet' }, muted: true, until: now + 60 * MIN },
      { t: 'mute', target: { kind: 'conversation', nativeId: 'quiet' }, muted: true },
      { t: 'mute', target: { kind: 'conversation', nativeId: 'quiet' }, muted: false },
    ]);
  });

  test("the network's refusal is its sentence, as a 502", async () => {
    await expect(setNativeMute(store, link({ fail: 'Missing Access (403)' }), 'conversation', quiet(), { muted: true })).rejects.toMatchObject({ status: 502, message: 'Missing Access (403)' });
  });
});
