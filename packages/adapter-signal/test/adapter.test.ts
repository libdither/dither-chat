/**
 * The whole adapter (link flow, daemon supervision, JSON-RPC over the UNIX
 * socket, commands) against test/fake-signal-cli.ts, which speaks signal-cli's
 * CLI/stdout/JSON-RPC protocol without any network. Steps share one adapter
 * and run in order.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent } from '@dither-chat/protocol';
import { type AdapterHost, CAPABILITIES, LINK_MESSAGE, SignalAdapter, socketPathFor } from '../src/adapter.ts';

const FAKE = join(import.meta.dir, 'fake-signal-cli.ts');
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';
const GID = 'Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI=';
const GROUP = `group:${GID}`;
const DM_ALICE = `dm:${SELF}:${ALICE}`;
const T = 1793330000000;

let dir: string;
let signalDir: string;
let adapter: SignalAdapter;
const events: AdapterEvent[] = [];
const logs: string[] = [];
let secret: Record<string, any> = {};

const until = async <T>(what: string, fn: () => T | undefined | null | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${logs.slice(-15).join('\n')}`);
    await Bun.sleep(20);
  }
};
const of = <K extends AdapterEvent['t']>(t: K, from = 0) => events.slice(from).filter((e): e is Extract<AdapterEvent, { t: K }> => e.t === t);
const lastStatus = () => of('status').at(-1);
const records = () =>
  existsSync(join(signalDir, 'fake-rpc.jsonl'))
    ? readFileSync(join(signalDir, 'fake-rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const calls = (method: string) => records().filter((r) => r.t === 'rpc' && r.method === method);
const argvs = (sub: string) => records().filter((r) => r.t === 'argv' && r.argv.includes(sub));
const alive = (pid: number) => existsSync(`/proc/${pid}`);
let pushes = 0;
const push = (fixture: string | object) => {
  mkdirSync(join(signalDir, 'fake-push'), { recursive: true });
  const body = typeof fixture === 'string' ? readFileSync(join(import.meta.dir, 'fixtures', `${fixture}.json`), 'utf8') : JSON.stringify(fixture);
  const tmp = join(signalDir, `push-${pushes}.tmp`);
  writeFileSync(tmp, body);
  require('node:fs').renameSync(tmp, join(signalDir, 'fake-push', `${String(pushes++).padStart(4, '0')}.json`));
};
const cmd = (c: any) => adapter.command({ id: String(Math.random()), ...c });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-sig-'));
  signalDir = join(dir, 'signal-cli');
  process.env.FAKE_LINK_TIMEOUT_MS = '5000';
  const host: AdapterHost = {
    emit: (ev) => events.push(ev),
    log: (level, msg) => logs.push(`[${level}] ${msg}`),
    accountDir: dir,
    config: {},
    secret: () => secret,
    saveSecret: (v) => {
      secret = v as Record<string, any>;
    },
  };
  adapter = new SignalAdapter(host, {
    signalCli: async () => [process.execPath, FAKE],
    linkRotateMs: 600,
    restartBackoffMs: [100, 200, 400],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    daemonHealthEveryMs: 300,
  });
});

afterAll(async () => {
  await adapter?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('signal adapter against a fake signal-cli', () => {
  test('starts linking: hello, then attention link_device with the QR URI', async () => {
    await adapter.start();
    expect(events[0]).toEqual({ t: 'hello', network: 'signal', version: expect.any(String), capabilities: CAPABILITIES });
    const st = await until('a QR code', () => of('status').find((s) => s.attention?.qr));
    expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', message: LINK_MESSAGE, qr: expect.stringMatching(/^sgnl:\/\/linkdevice\?uuid=FAKE\d+&pub_key=KEY\d+$/) } });
    const argv = argvs('link')[0].argv as string[];
    expect(argv.slice(0, 6)).toEqual(['--config', signalDir, '--trust-new-identities', 'always', 'link', '-n']);
    expect(argv[6]).toBe('dither-chat');
  });

  test('rotates the QR code before it expires and retires the old link process', async () => {
    const first = of('status').find((s) => s.attention?.qr)!.attention!.qr;
    const second = await until('a new QR code', () => of('status').find((s) => s.attention?.qr && s.attention.qr !== first));
    expect(second.attention!.kind).toBe('link_device');
    const firstPid = argvs('link')[0].pid;
    await until('the first link process to exit', () => !alive(firstPid));
  });

  test('scanning links the device, starts the daemon and goes online with self', async () => {
    const mark = events.length;
    writeFileSync(join(signalDir, 'fake-scan'), '');
    const online = await until('online', () => of('status', mark).find((s) => s.status === 'online'));
    expect(of('status', mark)[0]).toMatchObject({ status: 'connecting', attention: null });
    expect(online.self).toEqual({ nativeId: SELF, handle: '+15550100', displayName: 'Zyan', isSelf: true });
    expect(secret).toMatchObject({ number: '+15550100', aci: SELF });
    const d = argvs('daemon')[0].argv as string[];
    expect(d).toEqual(expect.arrayContaining(['-a', SELF, 'daemon', '--socket', '--receive-mode', 'on-connection', '--no-receive-stdout', '--ignore-stories']));
    // no link process survives
    for (const r of argvs('link')) expect(alive(r.pid)).toBe(false);
  });

  test('snapshot: contacts, groups and Note to Self', async () => {
    await until('group conversation', () => of('conversation').find((c) => c.conversation.nativeId === GROUP));
    const idn = (id: string) => of('identity').find((e) => e.identity.nativeId === id)?.identity;
    expect(idn(ALICE)).toEqual({ nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', contact: true });
    expect(idn(SAM)).toEqual({ nativeId: SAM, handle: '+15550161', displayName: 'Sam Rivera', contact: true });
    expect(of('conversation').find((c) => c.conversation.nativeId === GROUP)!.conversation).toEqual({
      nativeId: GROUP,
      shape: 'group',
      encrypted: true,
      name: 'Climbing crew 🧗',
      topic: 'thursday nights',
      participants: [SELF, ALICE, SAM],
    });
    expect(of('conversation').find((c) => c.conversation.nativeId === `dm:${SELF}:${SELF}`)!.conversation.shape).toBe('self');
    expect(calls('listContacts').length).toBeGreaterThanOrEqual(2);
  });

  test('incoming envelopes become live messages', async () => {
    push('text-styles-mentions');
    const m = await until('message', () => of('message').find((e) => e.message.nativeId === `${ALICE}:${T + 1000}`));
    expect(m.live).toBe(true);
    expect(m.message).toMatchObject({ conversation: GROUP, author: ALICE, mentionsSelf: true, body: expect.stringContaining('**purple V4**') });
  });

  test('send: Markdown -> text styles, mentions, quote; echo emitted as your message', async () => {
    const mark = events.length;
    const res = (await cmd({ t: 'send', conversation: GROUP, body: `**on it** <@${ALICE}>`, replyTo: `${ALICE}:${T + 1000}` })) as { nativeId: string };
    expect(res.nativeId).toMatch(new RegExp(`^${SELF}:\\d+$`));
    const p = calls('send').at(-1).params;
    expect(p).toMatchObject({ groupId: GID, message: 'on it ￼', textStyle: ['0:5:BOLD'], mention: [`6:1:${ALICE}`], quoteTimestamp: T + 1000, quoteAuthor: ALICE });
    expect(p.quoteMessage).toContain('purple V4');
    const echo = of('message', mark).find((e) => e.message.nativeId === res.nativeId)!;
    expect(echo.message).toMatchObject({ conversation: GROUP, author: SELF, body: `**on it** <@${ALICE}>`, replyTo: `${ALICE}:${T + 1000}` });
  });

  test('send to a new 1:1 announces the conversation; Note to Self uses noteToSelf', async () => {
    const mark = events.length;
    await cmd({ t: 'send', conversation: `dm:${SELF}:${SAM}`, body: 'hi Sam' });
    expect(calls('send').at(-1).params).toEqual({ recipient: [SAM], message: 'hi Sam' });
    expect(of('conversation', mark).map((c) => c.conversation)).toContainEqual({ nativeId: `dm:${SELF}:${SAM}`, shape: 'direct', participants: [SELF, SAM], encrypted: true });
    await cmd({ t: 'send', conversation: `dm:${SELF}:${SELF}`, body: 'note' });
    expect(calls('send').at(-1).params).toEqual({ noteToSelf: true, message: 'note' });
  });

  test('reaction context: nothing fancy, and leaving a group ends it', async () => {
    expect(await cmd({ t: 'reactionContext', conversation: DM_ALICE })).toEqual({ canReact: true, custom: [] });
    expect(await cmd({ t: 'reactionContext', conversation: GROUP })).toEqual({ canReact: true, custom: [] });
  });

  test('react, edit, redact, markRead', async () => {
    let mark = events.length;
    await cmd({ t: 'react', conversation: GROUP, message: `${ALICE}:${T + 1000}`, key: '🔥' });
    expect(calls('sendReaction').at(-1).params).toEqual({ groupId: GID, emoji: '🔥', targetAuthor: ALICE, targetTimestamp: T + 1000 });
    expect(of('reaction', mark)).toEqual([{ t: 'reaction', conversation: GROUP, message: `${ALICE}:${T + 1000}`, author: SELF, key: '🔥' }]);
    await cmd({ t: 'react', conversation: GROUP, message: `${ALICE}:${T + 1000}`, key: '🔥', remove: true });
    expect(calls('sendReaction').at(-1).params.remove).toBe(true);

    const sent = (await cmd({ t: 'send', conversation: DM_ALICE, body: 'typo' })) as { nativeId: string };
    const ts = Number(sent.nativeId.split(':')[1]);
    mark = events.length;
    await cmd({ t: 'edit', conversation: DM_ALICE, message: sent.nativeId, body: 'fixed *now*' });
    expect(calls('send').at(-1).params).toEqual({ recipient: [ALICE], message: 'fixed now', textStyle: ['6:3:ITALIC'], editTimestamp: ts });
    expect(of('message', mark)[0].message).toMatchObject({ nativeId: sent.nativeId, ts, editedTs: expect.any(Number), body: 'fixed *now*' });

    mark = events.length;
    await cmd({ t: 'redact', conversation: DM_ALICE, message: sent.nativeId });
    expect(calls('remoteDelete').at(-1).params).toEqual({ recipient: [ALICE], targetTimestamp: ts });
    expect(of('delete', mark)).toEqual([{ t: 'delete', conversation: DM_ALICE, nativeId: sent.nativeId }]);
    await expect(cmd({ t: 'redact', conversation: GROUP, message: `${ALICE}:${T + 1000}` })).rejects.toThrow(/own messages/);

    await cmd({ t: 'markRead', conversation: GROUP, upTo: `${ALICE}:${T + 1000}` });
    expect(calls('sendReceipt').at(-1).params).toEqual({ recipient: ALICE, targetTimestamp: [T + 1000], type: 'read' });
    const before = calls('sendReceipt').length;
    await cmd({ t: 'markRead', conversation: GROUP, upTo: `${ALICE}:${T + 1000}` }); // already acknowledged: no second receipt
    expect(calls('sendReceipt').length).toBe(before);
  });

  test('editing a reply sends the quote again', async () => {
    const sent = (await cmd({ t: 'send', conversation: GROUP, body: 'agreed', replyTo: `${ALICE}:${T + 1000}` })) as { nativeId: string };
    await cmd({ t: 'edit', conversation: GROUP, message: sent.nativeId, body: 'agreed!!' });
    expect(calls('send').at(-1).params).toMatchObject({ groupId: GID, message: 'agreed!!', editTimestamp: Number(sent.nativeId.split(':')[1]), quoteTimestamp: T + 1000, quoteAuthor: ALICE });
  });

  test('history, fetchMedia, typing action, bad input', async () => {
    expect(await cmd({ t: 'history', conversation: GROUP, limit: 50 })).toEqual({ count: 0, done: true });
    mkdirSync(join(signalDir, 'attachments'), { recursive: true });
    writeFileSync(join(signalDir, 'attachments', 'x.png'), Buffer.from('89504e470d0a1a0a00', 'hex'));
    expect(await cmd({ t: 'fetchMedia', url: `file://${signalDir}/attachments/x.png` })).toEqual({ mime: 'image/png', base64: Buffer.from('89504e470d0a1a0a00', 'hex').toString('base64') });
    await expect(cmd({ t: 'fetchMedia', url: 'file:///etc/passwd' })).rejects.toThrow();
    await expect(cmd({ t: 'fetchMedia', url: 'https://example.org/a.png' })).rejects.toThrow();
    await cmd({ t: 'action', action: 'typing', args: { conversation: GROUP } });
    expect(calls('sendTyping').at(-1).params).toEqual({ groupId: GID });
    const lists = calls('listGroups').length;
    expect(await cmd({ t: 'action', action: 'resync' })).toEqual({ ok: true });
    expect(calls('sendSyncRequest')).toHaveLength(1);
    expect(calls('listGroups').length).toBe(lists + 1);
    await expect(cmd({ t: 'action', action: 'nope' })).rejects.toThrow(/unknown action/);
    await expect(cmd({ t: 'send', conversation: '!room:matrix.org', body: 'x' })).rejects.toThrow(/not a Signal conversation/);
    await expect(cmd({ t: 'send', conversation: DM_ALICE, body: 'FAIL' })).rejects.toThrow(/Failed to send/);
  });

  test('disappearing messages are deleted (with their files) once read and expired', async () => {
    push('disappearing');
    const id = `${ALICE}:${T + 20000}`;
    await until('disappearing message', () => of('message').find((e) => e.message.nativeId === id));
    const file = join(signalDir, 'attachments', 'D00rC0de1jpg2aaa3bbb.jpg');
    writeFileSync(file, 'jpeg');
    let mark = events.length;
    adapter.sweepExpired(Date.now() + 7200_000);
    // Your own "hi Sam" (Sam's chat has a 1 h timer, started at send) is gone; Alice's unread message is not.
    expect(of('delete', mark).map((d) => d.conversation)).toEqual([`dm:${SELF}:${SAM}`]);
    mark = events.length;
    await cmd({ t: 'markRead', conversation: DM_ALICE, upTo: id });
    adapter.sweepExpired(Date.now() + 3599_000);
    expect(of('delete', mark)).toHaveLength(0);
    adapter.sweepExpired(Date.now() + 3601_000);
    expect(of('delete', mark)).toEqual([{ t: 'delete', conversation: DM_ALICE, nativeId: id }]);
    expect(existsSync(file)).toBe(false);
  });

  test('remote delete drops the downloaded attachment files too', async () => {
    mkdirSync(join(signalDir, 'attachments'), { recursive: true });
    const file = join(signalDir, 'attachments', 'Xq3vM8kTt0aQ1bC2dE4f.jpg');
    writeFileSync(file, 'jpeg');
    push('attachment');
    await until('photo message', () => of('message').find((e) => e.message.nativeId === `${ALICE}:${T + 3000}`));
    const del = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'remote-delete.json'), 'utf8'));
    del.envelope.dataMessage.remoteDelete.timestamp = T + 3000;
    del.envelope.timestamp = del.envelope.dataMessage.timestamp = T + 3500;
    const mark = events.length;
    push(del);
    await until('delete', () => of('delete', mark).find((d) => d.nativeId === `${ALICE}:${T + 3000}`));
    expect(existsSync(file)).toBe(false);
  });

  test('daemon crash: restarted with backoff, back online', async () => {
    const mark = events.length;
    const pid = argvs('daemon').at(-1).pid;
    writeFileSync(join(signalDir, 'fake-exit'), '3');
    await until('connecting', () => of('status', mark).find((s) => s.status === 'connecting'));
    await until('online again', () => of('status', mark).find((s) => s.status === 'online'));
    expect(alive(pid)).toBe(false);
    expect(argvs('daemon').length).toBe(2);
    expect(logs.some((l) => l.includes('signal-cli daemon stopped'))).toBe(true);
  });

  test('a hung daemon (socket open, no answers) is killed and restarted', async () => {
    const mark = events.length;
    const pid = argvs('daemon').at(-1).pid;
    writeFileSync(join(signalDir, 'fake-hang'), String(pid));
    await until('connecting', () => of('status', mark).find((s) => s.status === 'connecting'));
    await until('online again', () => of('status', mark).find((s) => s.status === 'online'));
    expect(alive(pid)).toBe(false);
    expect(logs.filter((l) => l.startsWith('[warn] signal-cli stopped answering'))).toHaveLength(1);
    expect(calls('version').length).toBeGreaterThanOrEqual(2); // the two unanswered probes
    rmSync(join(signalDir, 'fake-hang'));
  });

  test('unlinked from the phone: back to linking, data kept', async () => {
    const mark = events.length;
    const accFile = join(signalDir, 'data', 'accounts.json');
    const acc = JSON.parse(readFileSync(accFile, 'utf8'));
    acc.accounts[0].registered = false;
    writeFileSync(accFile, JSON.stringify(acc));
    writeFileSync(join(signalDir, 'fake-exit'), '0');
    const st = await until('relink QR', () => of('status', mark).find((s) => s.attention?.qr));
    expect(st.attention!.message).toStartWith('This device was unlinked from your phone.');
    expect(existsSync(accFile)).toBe(true);
    await expect(cmd({ t: 'send', conversation: DM_ALICE, body: 'x' })).rejects.toThrow(/not connected/);
    await expect(cmd({ t: 'action', action: 'resync' })).rejects.toThrow(/not connected/);
  });

  test('relink action wipes signal-cli data and starts over', async () => {
    const mark = events.length;
    expect(await cmd({ t: 'action', action: 'relink' })).toEqual({ ok: true });
    expect(secret.number).toBeUndefined();
    expect(secret.aci).toBeUndefined();
    const st = await until('fresh QR', () => of('status', mark).find((s) => s.attention?.qr));
    expect(st.attention!.message).toBe(LINK_MESSAGE);
    expect(existsSync(join(signalDir, 'data', 'accounts.json')) && JSON.parse(readFileSync(join(signalDir, 'data', 'accounts.json'), 'utf8')).accounts.length).toBeFalsy();
  });

  test('QR rotation pauses when nobody scans, and startLink resumes it', async () => {
    // a second adapter with a short attention span, on its own dir
    const dir2 = mkdtempSync(join(tmpdir(), 'dither-sig-'));
    const ev2: AdapterEvent[] = [];
    const a2 = new SignalAdapter(
      { emit: (e) => ev2.push(e), log: () => {}, accountDir: dir2, config: { deviceName: 'test-device' }, secret: () => ({}), saveSecret: () => {} },
      { signalCli: async () => [process.execPath, FAKE], linkRotateMs: 200, linkMaxActiveMs: 500 },
    );
    try {
      await a2.start();
      const st2 = () => ev2.filter((e): e is Extract<AdapterEvent, { t: 'status' }> => e.t === 'status');
      await until('paused', () => st2().find((s) => s.attention?.message.startsWith('The QR code expired')));
      const qrs = new Set(st2().map((s) => s.attention?.qr).filter(Boolean));
      expect(qrs.size).toBeGreaterThanOrEqual(2);
      const mark = ev2.length;
      expect(await a2.command({ t: 'action', id: 'x', action: 'startLink' })).toEqual({ ok: true });
      const fresh = await until('fresh QR after resume', () => ev2.slice(mark).find((e) => e.t === 'status' && !!e.attention?.qr));
      expect(qrs.has((fresh as any).attention.qr)).toBe(false);
      const argv = readFileSync(join(dir2, 'signal-cli', 'fake-rpc.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0].argv;
      expect(argv).toEqual(['--config', join(dir2, 'signal-cli'), '--trust-new-identities', 'always', 'link', '-n', 'test-device']);
    } finally {
      await a2.shutdown();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('a scan that fails during registration says so next to the new code', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'dither-sig-'));
    const ev3: AdapterEvent[] = [];
    const a3 = new SignalAdapter(
      { emit: (e) => ev3.push(e), log: () => {}, accountDir: dir3, config: {}, secret: () => ({}), saveSecret: () => {} },
      { signalCli: async () => [process.execPath, FAKE] },
    );
    try {
      await a3.start();
      const st3 = () => ev3.filter((e): e is Extract<AdapterEvent, { t: 'status' }> => e.t === 'status');
      const first = await until('qr', () => st3().find((s) => s.attention?.qr));
      writeFileSync(join(dir3, 'signal-cli', 'fake-scan'), 'fail');
      const next = await until('second qr', () => st3().find((s) => s.attention?.qr && s.attention.qr !== first.attention!.qr));
      expect(next.attention!.message).toBe('Linking failed: Link request error: Failed to register as secondary device (NonSuccessfulResponseCodeException). ' + LINK_MESSAGE);
      expect(st3().some((s) => s.status === 'connecting' && s.attention === null)).toBe(true); // while it was finishing
    } finally {
      await a3.shutdown();
      rmSync(dir3, { recursive: true, force: true });
    }
  });

  test('shutdown stops every signal-cli process', async () => {
    const pids = records()
      .filter((r) => r.t === 'argv')
      .map((r) => r.pid);
    await adapter.shutdown();
    await until('children gone', () => pids.every((p) => !alive(p)), 5000);
  });
});

describe('socket path', () => {
  test('lives in the account dir, or a private runtime dir when that path is too long for a UNIX socket', () => {
    expect(socketPathFor('/tmp/dither/accounts/acc_x')).toBe('/tmp/dither/accounts/acc_x/signal-cli.sock');
    const long = '/tmp/' + 'x'.repeat(120) + '/accounts/acc_y';
    const p = socketPathFor(long);
    expect(Buffer.byteLength(p)).toBeLessThan(108);
    expect(p).toMatch(/\/dither-signal-[0-9a-f]{16}\/rpc\.sock$/);
    expect(socketPathFor(long)).toBe(p); // stable per account
    const st = require('node:fs').statSync(require('node:path').dirname(p));
    expect(st.mode & 0o777).toBe(0o700);
    rmSync(require('node:path').dirname(p), { recursive: true, force: true });
  });
});
