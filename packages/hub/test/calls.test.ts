/**
 * The hub's side of calls: what it asks the adapter, what it tells the device, and what it refuses.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { hubId } from '@dither-chat/protocol/ids';
import { Calls } from '../src/calls.ts';

type Sent = any[];

function setup(reply: (cmd: any) => unknown = () => ({}), caps: string[] = ['calls']) {
  const commands: any[] = [];
  const store = {
    account: (id: string) => ({ id, network: 'discord', capabilities: JSON.stringify(caps) }),
    nativeOf: (kind: string, id: string) => ({ network: id.startsWith('idn_signal_') ? 'signal' : 'discord', nativeId: kind === 'identity' ? id.replace(/^idn_[a-z]+_/, '') : '1100000000000000001' }),
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

  test('in a call: one person\'s volume and mute, the microphone, a stage, the soundboard, each only where the account can', async () => {
    const all = ['calls', 'callVolume', 'callInput', 'stage', 'soundboard'];
    const { calls, commands, socket } = setup((c) => (c.op === 'sounds' ? { sounds: [{ id: '5', name: 'airhorn', guild: '0' }] } : {}), all);
    const ws = socket();
    calls.message(ws as any, JSON.stringify({ op: 'join', account: 'acc_a', conversation: 'cnv_x', mode: 'bridge', input: { noiseSuppression: false, sensitivity: -50.4 } }));
    await tick();
    expect(commands[0]).toMatchObject({ op: 'join', input: { noiseSuppression: false, sensitivity: -50 } });
    const send = (m: unknown) => calls.message(ws as any, JSON.stringify(m));
    send({ op: 'local', user: 'idn_discord_42', volume: 350 });
    send({ op: 'local', user: 'idn_discord_42', muted: true });
    send({ op: 'input', input: { noiseSuppression: true, sensitivity: 7 } });
    send({ op: 'stage', action: 'raiseHand' });
    send({ op: 'stage', action: 'invite', user: 'idn_discord_43' });
    send({ op: 'sounds' });
    send({ op: 'sound', sound: '5', guild: '0' });
    await tick();
    expect(commands.slice(1).map(({ call: _c, t: _t, ...rest }) => rest)).toEqual([
      { op: 'local', user: '42', volume: 200 },
      { op: 'local', user: '42', muted: true },
      { op: 'input', input: { noiseSuppression: true, sensitivity: 'auto' } },
      { op: 'stage', action: 'raiseHand' },
      { op: 'stage', action: 'invite', user: '43' },
      { op: 'sounds' },
      { op: 'sound', sound: '5', guild: '0' },
    ]);
    expect(ws.sent.find((m) => m.t === 'sounds')).toEqual({ t: 'sounds', sounds: [{ id: '5', name: 'airhorn', guild: '0' }] });
    // Out of shape: refused here, nothing asked.
    const before = commands.length;
    send({ op: 'stage', action: 'invite' });
    send({ op: 'stage', action: 'raiseHand', user: 'idn_discord_43' });
    send({ op: 'stage', action: 'dance' });
    send({ op: 'sound', sound: '../x', guild: '0' });
    send({ op: 'local', user: 'idn_signal_42', volume: 50 });
    await tick();
    expect(commands.length).toBe(before);
    expect(ws.sent.filter((m) => m.t === 'error').map((m) => m.message)).toEqual(['Whom?', 'That is about yourself.', 'Not a stage action.', 'Which sound?', 'Nobody by that id in this call.']);
  });

  test("an old adapter: volume, stages and sounds are refused in words; the microphone's handling is kept on the device", async () => {
    const { calls, commands, socket } = setup();
    const ws = socket();
    calls.message(ws as any, JSON.stringify({ op: 'join', account: 'acc_a', conversation: 'cnv_x', mode: 'bridge', input: { noiseSuppression: false, sensitivity: 'auto' } }));
    await tick();
    expect(commands[0].input).toBeUndefined();
    for (const m of [{ op: 'local', user: 'idn_discord_42', volume: 50 }, { op: 'input', input: {} }, { op: 'stage', action: 'raiseHand' }, { op: 'sounds' }]) calls.message(ws as any, JSON.stringify(m));
    await tick();
    expect(commands.length).toBe(1);
    expect(ws.sent.filter((m) => m.t === 'error').map((m) => m.message)).toEqual(["Changing one person's volume isn't available for this account.", "Stages isn't available for this account.", "The soundboard isn't available for this account."]);
  });

  test("the adapter's effects and stage reach the device in hub ids", async () => {
    const { calls, socket } = setup();
    const ws = socket();
    calls.message(ws as any, join('bridge'));
    await tick();
    const id = ws.sent.find((m) => m.t === 'joined').call;
    calls.onAdapterEvent('acc_a', { t: 'call', call: id, effect: { who: '42', emoji: '🎉' } });
    calls.onAdapterEvent('acc_a', { t: 'call', call: id, state: { conversation: 'c', participants: [{ id: '42', muted: false, deafened: false, speaking: false, stage: 'hand', volume: 50 }], stage: { topic: 'Town hall', moderator: true } } });
    expect(ws.sent.find((m) => m.t === 'effect')).toEqual({ t: 'effect', effect: { who: hubId('idn', 'discord', '42'), emoji: '🎉' } });
    const st = ws.sent.find((m) => m.t === 'state').state;
    expect(st.stage).toEqual({ topic: 'Town hall', moderator: true });
    expect(st.participants[0]).toMatchObject({ id: hubId('idn', 'discord', '42'), stage: 'hand', volume: 50 });
  });

  test('video and watching go to the adapter only in bridge mode, only where it can, with native ids', async () => {
    const { calls, commands, socket } = setup((c) => (c.op === 'join' ? { direct } : {}), ['calls', 'callVideo', 'watchStreams']);
    const ws = socket();
    calls.message(ws as any, join('bridge'));
    await tick();
    calls.message(ws as any, JSON.stringify({ op: 'video', camera: true, screen: false }));
    calls.message(ws as any, JSON.stringify({ op: 'watch', user: 'idn_discord_42', on: true }));
    await tick();
    expect(commands.find((c) => c.op === 'video')).toMatchObject({ t: 'call', op: 'video', camera: true, screen: false });
    expect(commands.find((c) => c.op === 'watch')).toMatchObject({ op: 'watch', user: '42', on: true });

    // Direct mode carries no video: the device is told why.
    const d = socket();
    calls.message(d as any, join('direct', 'acc_b'));
    await tick();
    calls.message(d as any, JSON.stringify({ op: 'video', camera: true, screen: false }));
    await tick();
    expect(d.sent.find((m) => m.t === 'error')?.message).toContain('bridge mode');

    // An adapter without the capability: refused in words, nothing asked.
    const old = setup(() => ({}), ['calls']);
    const o = old.socket();
    old.calls.message(o as any, join('bridge'));
    await tick();
    old.calls.message(o as any, JSON.stringify({ op: 'watch', user: 'idn_discord_42', on: true }));
    await tick();
    expect(o.sent.find((m) => m.t === 'error')?.message).toContain("isn't available");
    expect(old.commands.some((c) => c.op === 'watch')).toBe(false);
  });

  test("the account's own state and the video slots reach the device in hub ids", async () => {
    const { calls, socket } = setup();
    const ws = socket();
    calls.message(ws as any, join('bridge'));
    await tick();
    const id = ws.sent.find((m) => m.t === 'joined').call;
    calls.onAdapterEvent('acc_a', {
      t: 'call',
      call: id,
      state: {
        conversation: 'c',
        participants: [{ id: '42', muted: false, deafened: false, speaking: true, video: true, streaming: true }],
        self: { connected: true, muted: false, deafened: false, camera: true, watching: ['42'] },
        video: [
          { slot: '4', who: '42', source: 'camera' },
          { slot: '5', who: '42', source: 'stream' },
        ],
      },
    });
    const st = ws.sent.find((m) => m.t === 'state').state;
    const who = hubId('idn', 'discord', '42');
    expect(st.self).toEqual({ connected: true, muted: false, deafened: false, camera: true, watching: [who] });
    expect(st.video).toEqual([
      { slot: '4', who, source: 'camera' },
      { slot: '5', who, source: 'stream' },
    ]);
  });
});
