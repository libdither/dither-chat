/**
 * The hub's side of calls: what it asks the adapter, what it tells the device, and what it refuses.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Calls } from '../src/calls.ts';

type Sent = any[];

function setup(reply: (cmd: any) => unknown = () => ({})) {
  const commands: any[] = [];
  const store = {
    account: (id: string) => ({ id, network: 'discord', capabilities: '["calls"]' }),
    nativeOf: () => ({ network: 'discord', nativeId: '1100000000000000001' }),
    identitiesByIds: () => [],
  } as any;
  const sup = {
    online: () => true,
    command: async (_acc: string, cmd: any) => {
      commands.push(cmd);
      const r = reply(cmd);
      if (r instanceof Error) throw r;
      return r;
    },
  } as any;
  const calls = new Calls(store, sup, { turn: { urls: ['turn:100.64.0.10:3478?transport=udp'], secret: 'shh' }, pickAccount: (_c, a) => a ?? 'acc_a' });
  const socket = () => {
    const sent: Sent = [];
    const ws = { data: { kind: 'call' } as any, sent, closed: false, send: (m: string) => sent.push(JSON.parse(m)), close() { this.closed = true; } };
    return ws;
  };
  return { calls, commands, socket };
}

const join = (mode: 'bridge' | 'direct', account = 'acc_a') => JSON.stringify({ op: 'join', account, conversation: 'cnv_x', mode });
const tick = () => Bun.sleep(5);

const direct = { network: 'discord', endpoint: 'c-iad20-1234.discord.media:2087', token: 't0k', serverId: 'g', channelId: '1100000000000000001', userId: 'u', sessionId: 's' };

describe('calls', () => {
  test('a direct join asks the adapter with the native conversation and hands out TURN credentials', async () => {
    const { calls, commands, socket } = setup((c) => (c.op === 'join' ? { direct } : {}));
    const ws = socket();
    calls.message(ws as any, join('direct'));
    await tick();
    expect(commands[0]).toMatchObject({ t: 'call', op: 'join', conversation: '1100000000000000001', mode: 'direct' });
    const joined = ws.sent.find((m) => m.t === 'joined');
    expect(joined.direct.session.endpoint).toBe(direct.endpoint);
    expect(joined.direct.relayOnly).toBe(true);
    expect(joined.direct.socket).toBe(`/api/call/${joined.call}/voice`);
    const ice = joined.iceServers[0];
    expect(ice.credential).toBe(createHmac('sha1', 'shh').update(ice.username).digest('base64'));
    expect(Number(ice.username.split(':')[0])).toBeGreaterThan(Date.now() / 1000);
  });

  test('a voice endpoint outside the network is refused', async () => {
    const { calls, socket } = setup((c) => (c.op === 'join' ? { direct: { ...direct, endpoint: 'evil.example.com:443' } } : {}));
    const ws = socket();
    calls.message(ws as any, join('direct'));
    await tick();
    expect(ws.sent.some((m) => m.t === 'joined')).toBe(false);
    expect(ws.sent.find((m) => m.t === 'error')?.message).toContain('usable voice server');
    expect(calls.stats()).toHaveLength(0);
  });

  test('a moved voice server is followed only to the network own hosts', async () => {
    const { calls, socket } = setup((c) => (c.op === 'join' ? { direct } : {}));
    const ws = socket();
    calls.message(ws as any, join('direct'));
    await tick();
    const id = ws.sent.find((m) => m.t === 'joined').call;
    calls.onAdapterEvent('acc_a', { t: 'call', call: id, signal: { kind: 'voice-server', endpoint: 'evil.example.com', token: 'x' } });
    expect(ws.sent.filter((m) => m.t === 'signal')).toHaveLength(0);
    calls.onAdapterEvent('acc_a', { t: 'call', call: id, signal: { kind: 'voice-server', endpoint: 'c-ord1-9.discord.media', token: 'y' } });
    expect(ws.sent.filter((m) => m.t === 'signal')).toHaveLength(1);
  });

  test('one call per account: a second device takes it over', async () => {
    const { calls, commands, socket } = setup();
    const a = socket();
    const b = socket();
    calls.message(a as any, join('bridge'));
    await tick();
    calls.message(b as any, join('bridge'));
    await tick();
    expect(a.sent.find((m) => m.t === 'ended')?.reason).toContain('another device');
    expect(a.closed).toBe(true);
    expect(calls.stats()).toHaveLength(1);
    // Closing the remaining device's socket leaves the call.
    calls.close(b as any);
    expect(commands.at(-1)).toMatchObject({ op: 'leave' });
    expect(calls.stats()).toHaveLength(0);
  });

  test('events from another account do not reach this call', async () => {
    const { calls, socket } = setup();
    const ws = socket();
    calls.message(ws as any, join('bridge'));
    await tick();
    const id = ws.sent.find((m) => m.t === 'joined').call;
    calls.onAdapterEvent('acc_b', { t: 'call', call: id, ended: 'nope' });
    expect(ws.sent.some((m) => m.t === 'ended')).toBe(false);
    calls.onAdapterEvent('acc_a', { t: 'call', call: id, state: { conversation: 'x', participants: [{ id: '42', muted: true, deafened: false, speaking: false }] } });
    const st = ws.sent.find((m) => m.t === 'state').state;
    expect(st.conversation).toBe('cnv_x');
    expect(st.participants[0].id).toStartWith('idn_');
  });
});
