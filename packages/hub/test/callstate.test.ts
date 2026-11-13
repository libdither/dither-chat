/**
 * Calls ringing you (callstate.ts, docs/calls.md "Ringing"): a ring alerts once and stops on any device answering or
 * declining; never again on a reconnect, never for an old call (by the call's own time); a ring left hanging ends as
 * missed; a call only goes forward; how it ended, and for how long. Voice channels: only with the adversarial `voice`
 * setting, joins and leaves logged like presence, the status line kept regardless.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { callLine, DEFAULT_RETENTION, RING } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { callRoute, currentCalls, endedOutcome, ingestCall, markDeclined, onRing, ringMuted, ringStep, ringWords, sweepCalls, voiceChannels, type RingNotice } from '../src/callstate.ts';
import { Store, type AccountRow } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-callstate-'));
let store: Store;
let dc: AccountRow;
let rings: RingNotice[] = [];
const DM = 'dm1';
const cid = hubId('cnv', 'discord', DM);
const me = hubId('idn', 'discord', 'dme');
const ann = hubId('idn', 'discord', 'ann');
const acc = () => store.account(dc.id)!;
const fact = (f: Partial<P.CallFact> & { nativeId: string }): P.CallFact => ({ conversation: DM, startedAt: Date.now() - 2_000, state: 'ringing', caller: 'ann', ...f });
const hear = (f: P.CallFact, now = Date.now()) => store.db.transaction(() => ingestCall(store, acc(), f, now))();
const extras = () => store.flush().filter((e): e is Extract<P.ClientEvent, { t: 'calls' }> => e.t === 'calls');

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  store.updateAccount(dc.id, { capabilities: JSON.stringify(['calls', 'callStates', 'declineCall']) });
  store.ingest(acc(), { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
  store.ingest(acc(), { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
  store.ingest(acc(), { t: 'conversation', conversation: { nativeId: DM, shape: 'direct', participants: ['dme', 'ann'] } });
  onRing(store, (n) => rings.push(n));
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rings = [];
  store.flush();
});

describe('the ring rule by itself', () => {
  const now = 1_000_000_000;
  test('rings once, for a fresh call only', () => {
    expect(ringStep(null, true, now - 1000, now)).toBe('ring');
    expect(ringStep({ ringing: true, alerted: true }, true, now - 1000, now)).toBeNull();
    expect(ringStep(null, true, now - RING.freshMs - 1, now)).toBeNull();
  });
  test('stops only what it rang', () => {
    expect(ringStep({ ringing: true, alerted: true }, false, now, now)).toBe('stop');
    expect(ringStep({ ringing: true, alerted: false }, false, now, now)).toBeNull();
    expect(ringStep({ ringing: false, alerted: true }, false, now, now)).toBeNull();
  });
  test('an ending without words', () => {
    const r = { declined_at: null, rang_self: 1, outgoing: 0, participants: [ann] };
    expect(endedOutcome(r, me)).toBe('missed');
    expect(endedOutcome({ ...r, participants: [ann, me] }, me)).toBe('answered');
    expect(endedOutcome({ ...r, declined_at: 5 }, me)).toBe('declined');
    expect(endedOutcome({ ...r, rang_self: 0, outgoing: 1, participants: [me] }, me)).toBe('cancelled');
    expect(endedOutcome({ ...r, rang_self: 0 }, me)).toBeNull();
  });
});

describe('ringing', () => {
  test('a call that rings you alerts once, and the reconnect that says it again does not', () => {
    hear(fact({ nativeId: 'c1', ringsSelf: true }));
    expect(rings.map((r) => r.kind)).toEqual(['ring']);
    const [view] = extras().flatMap((e) => e.calls);
    expect(view).toMatchObject({ conversationId: cid, callerId: ann, ringing: true, state: 'ringing', canDecline: true, canAnswer: true });
    hear(fact({ nativeId: 'c1', ringsSelf: true }));
    hear(fact({ nativeId: 'c1', ringsSelf: true }));
    expect(rings.map((r) => r.kind)).toEqual(['ring']);
  });

  test('answered on another device: it stops ringing everywhere, and ends answered with a duration', () => {
    const t0 = Date.now() - 5_000;
    hear(fact({ nativeId: 'c2', ringsSelf: true, startedAt: t0 }));
    hear(fact({ nativeId: 'c2', state: 'ongoing', ringsSelf: false, startedAt: t0, participants: ['ann', 'dme'], answeredAt: t0 + 3_000 }));
    expect(rings.map((r) => r.kind)).toEqual(['ring', 'stop']);
    hear(fact({ nativeId: 'c2', state: 'ended', startedAt: t0, endedAt: t0 + 3_000 + 12 * 60_000 }));
    const c = currentCalls(store).find((v) => v.id === rings[0].call.id)!;
    expect(c).toMatchObject({ state: 'ended', outcome: 'answered', duration: 720, ringing: false });
    expect(callLine({ state: 'ended', outcome: 'answered', startedAt: t0, answeredAt: t0 + 3_000, endedAt: t0 + 3_000 + 12 * 60_000 })).toBe('📞 Call, 12 min');
  });

  test('an old call heard ringing (an adapter catching up) never alerts', () => {
    hear(fact({ nativeId: 'c3', ringsSelf: true, startedAt: Date.now() - RING.freshMs - 10_000 }));
    expect(rings).toEqual([]);
    expect(currentCalls(store).find((v) => v.messageId === null && v.startedAt < Date.now() - RING.freshMs)?.ringing).toBe(true);
  });

  test('declined here: it stops on every device, and stays declined when the network only says you were not in it', () => {
    hear(fact({ nativeId: 'c4', ringsSelf: true }));
    const id = rings[0].call.id;
    markDeclined(store, id);
    expect(rings.map((r) => r.kind)).toEqual(['ring', 'stop']);
    // The network has not caught up yet: still says it rings you. It does not ring again.
    hear(fact({ nativeId: 'c4', ringsSelf: true }));
    hear(fact({ nativeId: 'c4', state: 'ended', outcome: 'missed' }));
    expect(rings.map((r) => r.kind)).toEqual(['ring', 'stop']);
    expect(currentCalls(store).find((v) => v.id === id)?.outcome).toBe('declined');
  });

  test('a call only goes forward: an ended call heard ringing again stays ended and silent', () => {
    hear(fact({ nativeId: 'c5', ringsSelf: true }));
    hear(fact({ nativeId: 'c5', state: 'ended' }));
    hear(fact({ nativeId: 'c5', ringsSelf: true }));
    expect(rings.map((r) => r.kind)).toEqual(['ring', 'stop']);
    expect(currentCalls(store).find((v) => v.id === rings[0].call.id)).toMatchObject({ state: 'ended', outcome: 'missed' });
  });

  test('a ring the network leaves hanging ends as missed', () => {
    const now = Date.now();
    // The calls above that still ring are swept too: only this one's matter here.
    hear(fact({ nativeId: 'c6', ringsSelf: true }), now + 60_000);
    const id = rings[0].call.id;
    const mine = () => rings.filter((r) => r.call.id === id).map((r) => r.kind);
    sweepCalls(store, now + 60_000 + RING.maxMs - 1);
    expect(mine()).toEqual(['ring']);
    sweepCalls(store, now + 60_000 + RING.maxMs + 1);
    expect(mine()).toEqual(['ring', 'stop']);
    expect(currentCalls(store, now + RING.maxMs + 1).find((v) => v.id === id)).toMatchObject({ state: 'ended', outcome: 'missed' });
  });

  test('a mute on the chat keeps the ring off devices; the words name the caller', () => {
    hear(fact({ nativeId: 'c7', ringsSelf: true }));
    const view = rings[0].call;
    expect(ringMuted(store, view)).toBe(false);
    expect(ringWords(store, view)).toEqual({ title: 'Ann is calling', body: 'Discord call. Answer or decline.' });
    store.setRule('conversation', cid, 'none');
    expect(ringMuted(store, view)).toBe(true);
  });

  test('Decline goes to the adapter, the network way, then stops the ring', async () => {
    hear(fact({ nativeId: 'c8', ringsSelf: true }));
    const id = rings[0].call.id;
    const sent: unknown[] = [];
    const deps = { store, online: () => true, command: async <T,>(_a: string, c: unknown) => (sent.push(c), {} as T), flush: () => {} };
    const res = await callRoute(deps, new Request(`http://hub/api/calls/${id}/decline`, { method: 'POST' }), new URL(`http://hub/api/calls/${id}/decline`), `/api/calls/${id}/decline`);
    expect(res!.status).toBe(200);
    expect(sent).toEqual([{ t: 'declineCall', conversation: DM, call: 'c8' }]);
    expect(rings.map((r) => r.kind)).toEqual(['ring', 'stop']);
    // The network refusing says so in a sentence.
    hear(fact({ nativeId: 'c9', ringsSelf: true }));
    const id2 = rings[2].call.id;
    const refuse = { ...deps, command: async () => Promise.reject(new Error('Missing Access')) };
    const r2 = await callRoute(refuse, new Request(`http://hub/api/calls/${id2}/decline`, { method: 'POST' }), new URL(`http://hub/api/calls/${id2}/decline`), `/api/calls/${id2}/decline`);
    expect(r2!.status).toBe(502);
    expect((await r2!.json()).error).toContain('Missing Access');
  });
});

describe('voice channels', () => {
  const VC = 'vc1';
  const vcid = hubId('cnv', 'discord', VC);
  const voice = (members: P.VoiceMember[]) => store.ingest(acc(), { t: 'voice', conversation: VC, space: 'g1', members });
  const log = () => store.db.query(`SELECT target_id, old, new FROM change_log WHERE field = 'voice' ORDER BY id`).all() as Record<string, any>[];

  test('nothing kept while the adversarial voice setting is off; the status line is kept regardless', () => {
    store.setRetention(DEFAULT_RETENTION);
    voice([{ who: 'ann' }]);
    store.ingest(acc(), { t: 'voiceStatus', conversation: VC, text: 'playing chess' });
    expect(voiceChannels(store)).toEqual([{ conversationId: vcid, members: [], at: expect.any(Number), status: 'playing chess' }]);
    expect(log()).toEqual([]);
  });

  test('with it on: who is there now, and joins and leaves in the change log', () => {
    store.setRetention({ ...DEFAULT_RETENTION, adversarial: true, voice: true });
    voice([{ who: 'ann', muted: true }]);
    expect(voiceChannels(store)[0].members).toEqual([{ identityId: ann, muted: true }]);
    voice([{ who: 'ann', muted: true }]);
    voice([]);
    expect(voiceChannels(store)[0].members).toEqual([]);
    expect(log()).toEqual([
      { target_id: ann, old: null, new: JSON.stringify(vcid) },
      { target_id: ann, old: JSON.stringify(vcid), new: null },
    ]);
    expect(store.keptKinds().voice).toBe(true);
    store.eraseKept('voice');
    expect(log()).toEqual([]);
  });
});
