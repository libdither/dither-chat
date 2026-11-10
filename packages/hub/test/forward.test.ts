/**
 * Forwarding: which account sends and how, what the message says when it is sent again, and the whole route
 * through the hub with a stand-in supervisor.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_LIMITS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { forwardText, planForward, plainTokens } from '../src/forward.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

describe('who sends a forward, and how', () => {
  const on = () => true;
  const can = (a: string) => a !== 'old';
  test('another network: whoever sends there anyway', () => {
    expect(planForward({ network: 'discord', seenVia: ['d1'] }, { network: 'matrix', accounts: ['m1'] }, { picked: 'm1', canForward: can, online: on })).toEqual({ mode: 'cross', accountId: 'm1' });
  });
  test('same network: native when the sender can read the original', () => {
    expect(planForward({ network: 'discord', seenVia: ['d1'] }, { network: 'discord', accounts: ['d1'] }, { picked: 'd1', canForward: can, online: on })).toEqual({ mode: 'native', accountId: 'd1' });
  });
  test('same network: another account that sees both beats the default sender, unless one was chosen', () => {
    const dest = { network: 'discord' as const, accounts: ['d1', 'd2'] };
    const src = { network: 'discord' as const, seenVia: ['d2'] };
    expect(planForward(src, dest, { picked: 'd1', canForward: can, online: on })).toEqual({ mode: 'native', accountId: 'd2' });
    expect(planForward(src, dest, { picked: 'd1', requested: 'd1', canForward: can, online: on })).toEqual({ mode: 'resend', accountId: 'd1' });
  });
  test('same network without a native forward: the content again', () => {
    expect(planForward({ network: 'signal', seenVia: ['old'] }, { network: 'signal', accounts: ['old'] }, { picked: 'old', canForward: can, online: on })).toEqual({ mode: 'resend', accountId: 'old' });
    expect(planForward({ network: 'discord', seenVia: ['d1'] }, { network: 'discord', accounts: ['d1'] }, { picked: 'd1', canForward: can, online: () => false })).toEqual({ mode: 'resend', accountId: 'd1' });
  });
  test('nobody to send', () => {
    expect(planForward({ network: 'discord', seenVia: [] }, { network: 'matrix', accounts: [] }, { picked: null, canForward: can, online: on })).toBeNull();
  });
});

describe('what a re-sent forward says', () => {
  test('across networks: the note, then where it came from, then the original quoted', () => {
    const t = forwardText({ note: 'look', text: 'hello\nworld', author: 'Alice', source: '#general · Rust', network: 'discord', dest: 'matrix', mode: 'cross' });
    expect(t).toBe('look\n\n↪ Forwarded from **Alice** (#general · Rust, Discord)\n> hello\n> world');
  });
  test('within a network the network goes unsaid, and a file alone still says where it came from', () => {
    expect(forwardText({ text: '', author: 'Bo', source: 'Family', network: 'matrix', dest: 'matrix', mode: 'resend' })).toBe('↪ Forwarded from **Bo** (Family)');
  });
  test('Signal forwards like its own app: the content, without a line', () => {
    expect(forwardText({ note: 'fyi', text: 'hi', author: 'Bo', source: 'Family', network: 'signal', dest: 'signal', mode: 'resend' })).toBe('fyi\n\nhi');
    expect(forwardText({ text: 'hi', author: 'Bo', source: null, network: 'discord', dest: 'signal', mode: 'cross' })).toContain('Forwarded from **Bo** (Discord)');
  });
  test('mentions become names, so nobody is pinged again', () => {
    const names = (k: string, id: string) => (k === 'user' && id === '1' ? 'Alice' : k === 'room' && id === '9' ? 'general' : null);
    expect(plainTokens('<@1> <@!2> <#9> <:blob:123> @everyone <@&5>', names)).toBe('@Alice @someone #general :blob: @​everyone @role');
  });
});

describe('forwarding through the hub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-fwd-'));
  let port = 0;
  let url = '';
  const sent: { account: string; cmd: any; files?: string[] }[] = [];
  let answer: (account: string, cmd: any) => unknown = () => ({ nativeId: `n${sent.length}` });
  let store: Store;
  let hub: HubServer;
  let d1: AccountRow, d2: AccountRow, mx: AccountRow, sg: AccountRow;
  const cnv = (net: 'discord' | 'matrix' | 'signal', id: string) => hubId('cnv', net, id);
  const msg = (net: 'discord' | 'matrix' | 'signal', id: string) => hubId('msg', net, id);
  const forward = (id: string, body: unknown) => fetch(`${url}/api/messages/${id}/forward`, { method: 'POST', body: JSON.stringify(body) });

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = {
      authorize: () => null,
      online: () => true,
      command: async (account: string, cmd: any) => {
        sent.push({ account, cmd, files: cmd.attachments?.map((f: any) => readFileSync(f.path, 'utf8')) });
        return answer(account, cmd);
      },
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = hub.start().port!;
    url = `http://127.0.0.1:${port}`;
    const acc = (network: 'discord' | 'matrix' | 'signal', label: string, caps: string[], self: string) => {
      const a = store.createAccount({ network, label, color: '#000', adapter: network });
      store.ingest(a, { t: 'hello', network, version: '1', capabilities: caps as any });
      store.ingest(a, { t: 'status', status: 'online', self: { nativeId: self, isSelf: true, displayName: label } });
      return store.account(a.id)!;
    };
    d1 = acc('discord', 'main', ['send', 'sendMedia', 'forward'], 'me1');
    d2 = acc('discord', 'alt', ['send', 'sendMedia', 'forward'], 'me2');
    mx = acc('matrix', 'mx', ['send', 'sendMedia'], '@me:x.org');
    sg = acc('signal', 'phone', ['send'], 'aci-me');
    store.ingest(d1, { t: 'space', space: { nativeId: 'g1', kind: 'community', name: 'Rust' } });
    store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'c-src', shape: 'channel', name: 'general', spaces: [{ nativeId: 'g1' }] } });
    store.ingest(d1, { t: 'conversation', conversation: { nativeId: 'c-dst', shape: 'channel', name: 'off-topic', spaces: [{ nativeId: 'g1' }] } });
    store.ingest(d2, { t: 'conversation', conversation: { nativeId: 'c-alt', shape: 'group', name: 'alt only' } });
    store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!r:x.org', shape: 'group', name: 'Room' } });
    store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!e:x.org', shape: 'group', name: 'Secret', encrypted: true } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'group:abc', shape: 'group', name: 'Family' } });
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'u-alice', displayName: 'Alice' } });
    store.ingest(d1, {
      t: 'message',
      message: {
        nativeId: 'm1',
        conversation: 'c-src',
        author: 'u-alice',
        ts: 1000,
        body: 'hi <@me1>',
        attachments: [
          { kind: 'image', mime: 'image/png', name: 'a.png', url: `data:image/png;base64,${Buffer.from('png!').toString('base64')}` },
          { kind: 'file', mime: 'application/zip', name: 'big.zip', url: `data:application/zip;base64,${Buffer.from('z'.repeat(64)).toString('base64')}` },
        ],
      },
    });
    store.flush();
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('within Discord, the account that reads the original forwards it natively, note and all', async () => {
    const res = await forward(msg('discord', 'm1'), { targets: [{ conversationId: cnv('discord', 'c-dst') }], note: ' see this ' });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ conversationId: cnv('discord', 'c-dst'), ok: true, mode: 'native', accountId: d1.id }]);
    expect(sent.at(-1)).toMatchObject({ account: d1.id, cmd: { t: 'forward', conversation: 'c-dst', source: { conversation: 'c-src', message: 'm1' }, note: 'see this' } });
    const nid = `n${sent.length}`;
    store.ingest(d1, { t: 'message', message: { nativeId: nid, conversation: 'c-dst', author: 'me1', ts: 2000, body: 'hi <@me1>', forward: { conversation: 'c-src', message: 'm1', space: 'g1' } } });
    expect(store.messageView(msg('discord', nid))?.forward).toMatchObject({ messageId: msg('discord', 'm1'), authorName: 'Alice', source: '#general · Rust', sentAs: 'native' });
  });

  test('across networks, the content goes again with a line saying where from, and the files are uploaded again', async () => {
    const res = await forward(msg('discord', 'm1'), { targets: [{ conversationId: cnv('matrix', '!r:x.org') }] });
    const r = (await res.json()).results[0];
    expect(r).toMatchObject({ ok: true, mode: 'cross', accountId: mx.id });
    const last = sent.at(-1)!;
    expect(last.cmd).toMatchObject({ t: 'send', conversation: '!r:x.org', body: '↪ Forwarded from **Alice** (#general · Rust, Discord)\n> hi @main' });
    expect(last.files).toEqual(['png!', 'z'.repeat(64)]);
    for (const f of last.cmd.attachments) expect(() => readFileSync(f.path)).toThrow();
    const nid = `n${sent.length}`;
    store.ingest(mx, { t: 'message', message: { nativeId: nid, conversation: '!r:x.org', author: '@me:x.org', ts: 3000, body: last.cmd.body } });
    expect(store.messageView(msg('matrix', nid))?.forward).toMatchObject({ sentAs: 'cross', text: 'hi @main', authorName: 'Alice', network: 'discord' });
  });

  test('a file the destination cannot take stays behind, and says so', async () => {
    const limit = ATTACHMENT_LIMITS.signal;
    expect(limit.bytes).toBeGreaterThan(64);
    const r = (await (await forward(msg('discord', 'm1'), { targets: [{ conversationId: cnv('signal', 'group:abc') }] })).json()).results[0];
    // This Signal account cannot send files at all.
    expect(r).toMatchObject({ ok: true, mode: 'cross', skipped: ['a.png', 'big.zip'] });
    expect(sent.at(-1)!.cmd.attachments).toBeUndefined();
  });

  test('an adapter that has no native forward for this pair falls back to sending the content', async () => {
    answer = (_a, cmd) => (cmd.t === 'forward' ? { fallback: 'not here' } : { nativeId: 'fb' });
    const r = (await (await forward(msg('discord', 'm1'), { targets: [{ conversationId: cnv('discord', 'c-dst') }] })).json()).results[0];
    expect(r).toMatchObject({ ok: true, mode: 'resend' });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'send', conversation: 'c-dst' });
    expect(sent.at(-1)!.cmd.body).toStartWith('↪ Forwarded from **Alice** (#general · Rust)\n');
    answer = () => ({ nativeId: `n${sent.length}` });
  });

  test('an account that cannot read the original sends the content instead', async () => {
    const r = (await (await forward(msg('discord', 'm1'), { targets: [{ conversationId: cnv('discord', 'c-alt') }] })).json()).results[0];
    expect(r).toMatchObject({ ok: true, mode: 'resend', accountId: d2.id });
  });

  test('each destination answers for itself; refusals never reach an adapter', async () => {
    const before = sent.length;
    const res = await forward(msg('discord', 'm1'), { targets: [{ conversationId: cnv('matrix', '!e:x.org') }, { conversationId: 'cnv_nope' }] });
    const rs = (await res.json()).results;
    expect(rs[0]).toMatchObject({ ok: false });
    expect(rs[0].error).toContain('encrypted');
    expect(rs[1]).toMatchObject({ ok: false, error: 'no such conversation' });
    expect(sent.length).toBe(before);
  });

  test('a forward someone else sent shows where it came from, as far as this hub knows', () => {
    store.ingest(d1, { t: 'identity', identity: { nativeId: 'u-bob', displayName: 'Bob' } });
    store.ingest(d1, { t: 'message', message: { nativeId: 'in1', conversation: 'c-dst', author: 'u-bob', ts: 5000, body: 'from elsewhere', forward: { conversation: 'c-unseen', message: 'x', space: 'g1' } } });
    expect(store.messageView(msg('discord', 'in1'))?.forward).toEqual({ messageId: null, conversationId: null, authorId: null, authorName: null, network: 'discord', source: 'Rust', ts: null });
    store.ingest(d1, { t: 'message', message: { nativeId: 'in2', conversation: 'c-dst', author: 'u-bob', ts: 6000, body: 'hi', forward: { conversation: 'c-src', message: 'm1' } } });
    expect(store.messageView(msg('discord', 'in2'))?.forward).toMatchObject({ messageId: msg('discord', 'm1'), authorId: hubId('idn', 'discord', 'u-alice'), source: '#general · Rust', ts: 1000 });
  });

  test('bad requests', async () => {
    expect((await forward(msg('discord', 'm1'), { targets: [] })).status).toBe(400);
    expect((await forward('msg_nope', { targets: [{ conversationId: cnv('discord', 'c-dst') }] })).status).toBe(404);
    const many = Array.from({ length: 6 }, (_, i) => ({ conversationId: `c${i}` }));
    expect((await forward(msg('discord', 'm1'), { targets: many })).status).toBe(400);
    const res = await fetch(`${url}/api/messages/${msg('discord', 'm1')}/forward`, { method: 'POST', body: JSON.stringify({ targets: [{ conversationId: cnv('discord', 'c-dst') }] }), headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});
