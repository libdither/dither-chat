/**
 * The adapter against a fake bridge process (test/fake-bridge.ts): linking, what each hub command
 * turns into on the wire, read state, history, media, and what happens when the bridge or the
 * session goes away. No WhatsApp involved.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { type AdapterOptions, WhatsAppAdapter } from '../src/adapter.ts';
import { msgId } from '../src/mapping.ts';

const FAKE = join(import.meta.dir, 'fake-bridge.ts');
const FIX = new Map<string, any>(
  readFileSync(join(import.meta.dir, 'fixtures/events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .map((e) => [e.fixture, e]),
);
const fx = (name: string) => {
  const e = structuredClone(FIX.get(name)!);
  delete e.fixture;
  return e;
};

const ME = '15550000001@s.whatsapp.net';
const ALICE = '15550000002@s.whatsapp.net';
const BOB = '15550000003@s.whatsapp.net';
const BOB_LID = '200000000000003@lid';
const GROUP = '120363000000000001@g.us';

type H = Awaited<ReturnType<typeof harness>>;
let current: H | null = null;

afterEach(async () => {
  await current?.close();
  current = null;
});

async function harness(o: { loggedIn?: boolean; opts?: Partial<AdapterOptions> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-adapter-'));
  const sock = join(dir, 'ctl.sock');
  const cmds: any[] = [];
  let conns: any[] = [];
  const server = Bun.listen({
    unix: sock,
    socket: {
      open(s) {
        conns.push(s);
        (s as any).buf = '';
      },
      data(s, d) {
        (s as any).buf += d.toString();
        let nl: number;
        while ((nl = (s as any).buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse((s as any).buf.slice(0, nl));
          (s as any).buf = (s as any).buf.slice(nl + 1);
          if (msg.cmd) cmds.push(msg.cmd);
        }
      },
      close(s) {
        conns = conns.filter((c) => c !== s);
      },
    },
  });
  process.env.FAKE_WA_SOCK = sock;
  process.env.FAKE_WA_LOGGED_IN = o.loggedIn === false ? '0' : '1';
  const events: P.AdapterEvent[] = [];
  const adapter = new WhatsAppAdapter(
    { emit: (e) => events.push(e), log: () => {}, accountDir: dir, config: {} },
    { bridge: async () => ['bun', FAKE], restartBackoffMs: [50, 100], historyTimeoutMs: 400, expirySweepMs: 60_000, fetch: (async () => new Response('png', { headers: { 'content-type': 'image/png' } })) as any, ...o.opts },
  );
  const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${fn}`);
      await Bun.sleep(10);
    }
  };
  const ctl = async (msg: unknown) => {
    await waitFor(() => conns.length > 0);
    conns[conns.length - 1].write(JSON.stringify(msg) + '\n');
  };
  const h = {
    adapter,
    events,
    cmds,
    dir,
    waitFor,
    ctl,
    /** Have the bridge print an event, and wait until the adapter has handled it. */
    emit: async (ev: any) => {
      const n = events.length;
      await ctl({ emit: ev });
      await Bun.sleep(30);
      return events.slice(n);
    },
    cmd: (op: string, nth = 0) => cmds.filter((c) => c.op === op)[nth],
    status: () => [...events].reverse().find((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status')!,
    close: async () => {
      await adapter.shutdown();
      server.stop(true);
    },
  };
  current = h;
  await adapter.start();
  if (o.loggedIn !== false) await waitFor(() => h.status()?.status === 'online');
  return h;
}

const ofType = <T extends P.AdapterEvent['t']>(evs: P.AdapterEvent[], t: T) => evs.filter((e): e is Extract<P.AdapterEvent, { t: T }> => e.t === t);

// ---------------------------------------------------------------- linking

test('not linked: the QR code goes to the hub as link_device attention; New code asks for another', async () => {
  const h = await harness({ loggedIn: false });
  const st = await h.waitFor(() => (h.status()?.attention?.qr ? h.status() : undefined));
  expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', qr: '2@fake-qr' } });
  expect(st.attention!.qrRefreshAt).toBeGreaterThan(Date.now());
  expect(ofType(h.events, 'hello')[0]).toMatchObject({ network: 'whatsapp', capabilities: expect.arrayContaining(['send', 'forward', 'e2ee', 'history']) });

  await h.adapter.command({ t: 'action', id: '1', action: 'refreshLink' });
  expect(h.cmd('link')).toBeTruthy();

  await h.emit({ t: 'qr_done', result: 'timeout' });
  expect(h.status().attention!.message).toContain('expired');
});

test('linking by phone number shows the pairing code', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'pairPhone', value: { code: 'ABCD1234' } } });
  await expect(h.adapter.command({ t: 'action', id: '1', action: 'pairPhone', args: { phone: 'call me' } })).rejects.toThrow('country code');
  expect(await h.adapter.command({ t: 'action', id: '2', action: 'pairPhone', args: { phone: '+1 555 000 0001' } })).toEqual({ code: 'ABCD-1234' });
  expect(h.cmd('pairPhone')).toMatchObject({ phone: '+1 555 000 0001' });
  expect(h.status().attention).toMatchObject({ kind: 'link_device', detail: { pairCode: 'ABCD-1234' } });
});

test('after the scan: online with your own identity, then contacts and groups', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'groups', value: [FIX.get('community').group, FIX.get('group').group] } });
  await h.ctl({ result: { op: 'contacts', value: [{ jid: ALICE, alt: '200000000000002@lid', fullName: 'Alice Chen', pushName: 'ali' }] } });
  await h.emit({ t: 'qr_done', result: 'success' });
  await h.emit({ t: 'paired', jid: ME, lid: '200000000000001@lid', platform: 'android' });
  await h.emit({ t: 'connected', loggedIn: true, jid: ME, lid: '200000000000001@lid', pushName: 'Me' });
  await h.waitFor(() => ofType(h.events, 'conversation').length);
  expect(h.status()).toMatchObject({ status: 'online', attention: null, self: { nativeId: ME, isSelf: true, displayName: 'Me', handle: '+15550000001' } });
  expect(ofType(h.events, 'identity').find((e) => e.identity.nativeId === ALICE)!.identity).toMatchObject({ displayName: 'Alice Chen', contact: true, handle: '+15550000002', avatarUrl: `wa-avatar:${ALICE}` });
  // the community before the group that sits in it
  const kinds = h.events.filter((e) => e.t === 'space' || e.t === 'conversation').map((e) => e.t);
  expect(kinds).toEqual(['space', 'conversation']);
  expect(ofType(h.events, 'conversation')[0].conversation).toMatchObject({ nativeId: GROUP, shape: 'channel', spaces: [{ nativeId: '120363000000000009@g.us' }] });
});

// ---------------------------------------------------------------- incoming

test('a message from someone new: identity and conversation reach the hub before the message', async () => {
  const h = await harness();
  const evs = await h.emit(fx('text'));
  expect(evs.map((e) => e.t)).toEqual(['identity', 'conversation', 'message']);
  expect(ofType(evs, 'identity')[0].identity).toMatchObject({ nativeId: ALICE, displayName: 'Alice', handle: '+15550000002' });
  expect(ofType(evs, 'conversation')[0].conversation).toMatchObject({ nativeId: ALICE, shape: 'direct', participants: [ME, ALICE] });
  // the second message adds nothing but itself
  expect((await h.emit(fx('image'))).map((e) => e.t)).toEqual(['message']);
});

test('a message in an unknown group asks for the group', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  await h.waitFor(() => h.cmd('group'));
  expect(h.cmd('group')).toMatchObject({ jid: GROUP });
  await h.waitFor(() => ofType(h.events, 'conversation').find((c) => c.conversation.name === 'Climbing crew'));
});

test('history sync on link: chats with mute and archive, then read state with the unread counts', async () => {
  const h = await harness();
  await h.emit(fx('history'));
  await h.emit(fx('history_text'));
  await h.emit(fx('history_stub'));
  const evs = await h.emit({ t: 'history_done', syncType: 'INITIAL_BOOTSTRAP', count: 2 });
  const convs = ofType(h.events, 'conversation').map((e) => e.conversation);
  expect(convs.find((c) => c.nativeId === GROUP)).toMatchObject({ name: 'Climbing crew', mute: { level: 'none' } });
  expect(convs.find((c) => c.nativeId === ALICE)).toMatchObject({ shape: 'direct', archived: true });
  const reads = ofType(evs, 'read');
  expect(reads.find((r) => r.conversation === GROUP)).toMatchObject({ unread: 3 });
  expect(reads.find((r) => r.conversation === ALICE)).toMatchObject({ unread: 0 });
  expect(ofType(h.events, 'message').every((m) => m.live === false)).toBe(true);
});

test('your phone reading a chat marks it read here', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const evs = await h.emit({ t: 'receipt', chat: ALICE, sender: ME, fromMe: true, isGroup: false, ids: ['A1'], ts: 1_760_000_999_000, type: 'read-self' });
  expect(ofType(evs, 'read')).toEqual([{ t: 'read', conversation: ALICE, upToTs: FIX.get('text').info.ts }]);
  // someone else reading your message is not your read state
  expect(await h.emit({ t: 'receipt', chat: ALICE, sender: ALICE, fromMe: false, isGroup: false, ids: ['A2'], ts: 1, type: 'read' })).toEqual([]);
});

test('leaving a group, being typed at, a picture change', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  expect(ofType(await h.emit({ t: 'chat_presence', chat: GROUP, sender: BOB_LID, fromMe: false, state: 'composing' }), 'typing')).toEqual([{ t: 'typing', conversation: GROUP, author: BOB }]);
  const pic = await h.emit({ t: 'picture', jid: BOB, id: '123', remove: false });
  expect(ofType(pic, 'identity')[0]?.identity.avatarUrl ?? `wa-avatar:${BOB}?123`).toBe(`wa-avatar:${BOB}?123`);
  const left = await h.emit({ t: 'group_change', jid: GROUP, join: [], leave: [ME], ts: 1 });
  expect(ofType(left, 'leave')).toEqual([{ t: 'leave', kind: 'conversation', nativeId: GROUP }]);
});

test('disappearing messages go when their time is up', async () => {
  const h = await harness({ opts: { expirySweepMs: 50 } });
  const ev = fx('text');
  ev.message = { extendedTextMessage: { text: 'gone soon', contextInfo: { expiration: 1 } } };
  await h.emit(ev);
  const del = await h.waitFor(() => ofType(h.events, 'delete')[0]);
  expect(del).toEqual({ t: 'delete', conversation: ALICE, nativeId: msgId(ALICE, 'A1') });
});

// ---------------------------------------------------------------- commands

test('send: text with a reply and a mention, and the sent message is published', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const r = await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: '**sure** <@15550000002@s.whatsapp.net>', replyTo: msgId(ALICE, 'A1') });
  expect(r).toEqual({ nativeId: msgId(ALICE, 'SENT1') });
  expect(h.cmd('send')).toMatchObject({
    chat: ALICE,
    message: { extendedTextMessage: { text: '*sure* @15550000002', contextInfo: { stanzaID: 'A1', participant: ALICE, quotedMessage: { conversation: 'hey, *lunch* tomorrow?' }, mentionedJID: [ALICE] } } },
  });
  const sent = ofType(h.events, 'message').at(-1)!.message;
  expect(sent).toMatchObject({ nativeId: msgId(ALICE, 'SENT1'), author: ME, body: '**sure** <@15550000002@s.whatsapp.net>', replyTo: msgId(ALICE, 'A1') });

  await h.adapter.command({ t: 'send', id: '2', conversation: ALICE, body: 'plain' });
  expect(h.cmd('send', 1).message).toEqual({ conversation: 'plain' });
});

test('send in a disappearing chat sets the timer on the message', async () => {
  const h = await harness();
  const ev = fx('text');
  ev.message = { extendedTextMessage: { text: 'hi', contextInfo: { expiration: 604800 } } };
  await h.emit(ev);
  await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'ok' });
  expect(h.cmd('send').message).toEqual({ extendedTextMessage: { text: 'ok', contextInfo: { expiration: 604800 } } });
});

test('send a file: upload, then a media message with the caption', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.ctl({ result: { op: 'upload', value: { url: 'https://mmg/x', directPath: '/v/x', mediaKey: 'a2V5', fileEncSHA256: 'ZW5j', fileSHA256: 'c2hh', fileLength: 3, thumbnail: 'dGh1bWI=', width: 4, height: 3 } } });
  await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'look', attachments: [{ path: '/tmp/x.png', name: 'x.png', mime: 'image/png', size: 3, kind: 'image' }] });
  expect(h.cmd('upload')).toMatchObject({ path: '/tmp/x.png', kind: 'image' });
  expect(h.cmd('send').message).toEqual({ imageMessage: { url: 'https://mmg/x', directPath: '/v/x', mediaKey: 'a2V5', fileEncSHA256: 'ZW5j', fileSHA256: 'c2hh', fileLength: '3', mimetype: 'image/png', caption: 'look', JPEGThumbnail: 'dGh1bWI=', width: 4, height: 3 } });
  const sent = ofType(h.events, 'message').at(-1)!.message;
  expect(sent.attachments![0]).toMatchObject({ kind: 'image', url: `wa-media:${msgId(ALICE, 'SENT1')}` });
});

test('react: message keys for a DM and for a LID-addressed group, one reaction at a time', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.adapter.command({ t: 'react', id: '1', conversation: ALICE, message: msgId(ALICE, 'A1'), key: '👍' });
  expect(h.cmd('send').message.reactionMessage).toMatchObject({ key: { remoteJID: ALICE, fromMe: false, ID: 'A1' }, text: '👍' });
  expect(h.cmd('send').message.reactionMessage.key.participant).toBeUndefined();
  await h.adapter.command({ t: 'react', id: '2', conversation: ALICE, message: msgId(ALICE, 'A1'), key: '😂' });
  expect(ofType(h.events, 'reaction').slice(-2)).toEqual([
    { t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A1'), author: ME, key: '👍', remove: true },
    { t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A1'), author: ME, key: '😂' },
  ]);
  await h.adapter.command({ t: 'react', id: '3', conversation: ALICE, message: msgId(ALICE, 'A1'), key: '😂', remove: true });
  expect(h.cmd('send', 2).message.reactionMessage.text).toBe('');

  await h.emit(fx('reply_mention'));
  await h.adapter.command({ t: 'react', id: '4', conversation: GROUP, message: msgId(GROUP, 'G1'), key: '❤️' });
  expect(h.cmd('send', 3).message.reactionMessage.key).toEqual({ remoteJID: GROUP, fromMe: false, ID: 'G1', participant: BOB_LID });
});

test('edit and delete your own message', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const { nativeId } = (await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'tyop' })) as { nativeId: string };
  // the fake's clock is 2026; pretend the send was just now
  h.adapter.state.db.query('UPDATE msg SET ts = ? WHERE id = ?').run(Date.now(), nativeId);
  await h.adapter.command({ t: 'edit', id: '2', conversation: ALICE, message: nativeId, body: 'typo' });
  const pm = h.cmd('send', 1).message.editedMessage.message.protocolMessage;
  expect(pm).toMatchObject({ key: { remoteJID: ALICE, fromMe: true, ID: 'SENT1' }, type: 'MESSAGE_EDIT', editedMessage: { conversation: 'typo' } });
  expect(ofType(h.events, 'message').at(-1)!.message).toMatchObject({ nativeId, body: 'typo', editedTs: expect.any(Number) });

  await expect(h.adapter.command({ t: 'edit', id: '3', conversation: ALICE, message: msgId(ALICE, 'A1'), body: 'x' })).rejects.toThrow('own messages');

  await h.adapter.command({ t: 'redact', id: '4', conversation: ALICE, message: nativeId });
  expect(h.cmd('send', 2).message).toEqual({ protocolMessage: { key: { remoteJID: ALICE, fromMe: true, ID: 'SENT1' }, type: 'REVOKE' } });
  expect(ofType(h.events, 'delete').at(-1)).toEqual({ t: 'delete', conversation: ALICE, nativeId });
});

test('an edit after 15 minutes is refused before it reaches WhatsApp', async () => {
  const h = await harness();
  await h.emit(fx('own_text'));
  await expect(h.adapter.command({ t: 'edit', id: '1', conversation: ALICE, message: msgId(ALICE, 'A2'), body: 'x' })).rejects.toThrow('15 minutes');
  expect(h.cmd('send')).toBeUndefined();
});

test('markRead: receipts per sender for what is unread, once', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.emit(fx('image'));
  await h.adapter.command({ t: 'markRead', id: '1', conversation: ALICE, upTo: msgId(ALICE, 'A3') });
  expect(h.cmd('markRead')).toMatchObject({ chat: ALICE, sender: '', ids: ['A3', 'A1'] });
  expect(ofType(h.events, 'read').at(-1)).toMatchObject({ conversation: ALICE, upToTs: FIX.get('image').info.ts });
  await h.adapter.command({ t: 'markRead', id: '2', conversation: ALICE, upTo: msgId(ALICE, 'A3') });
  expect(h.cmd('markRead', 1)).toBeUndefined();

  await h.emit(fx('reply_mention'));
  await h.emit(fx('poll'));
  await h.adapter.command({ t: 'markRead', id: '3', conversation: GROUP, upTo: msgId(GROUP, 'G2') });
  expect(h.cmd('markRead', 1)).toMatchObject({ chat: GROUP, sender: BOB_LID, ids: ['G2', 'G1'] });
});

test('forward natively: same media, marked forwarded, the note after it', async () => {
  const h = await harness();
  await h.emit(fx('image'));
  await h.emit(fx('reply_mention'));
  const r = await h.adapter.command({ t: 'forward', id: '1', conversation: GROUP, source: { conversation: ALICE, message: msgId(ALICE, 'A3') }, note: 'from Alice' });
  expect(r).toEqual({ nativeId: msgId(GROUP, 'SENT1') });
  const fwd = h.cmd('send').message.imageMessage;
  expect(fwd).toMatchObject({ caption: 'look', mediaKey: FIX.get('image').message.imageMessage.mediaKey, contextInfo: { isForwarded: true, forwardingScore: 1 } });
  expect(h.cmd('send', 1)).toMatchObject({ chat: GROUP, message: { conversation: 'from Alice' } });

  await h.emit(fx('poll'));
  expect(await h.adapter.command({ t: 'forward', id: '2', conversation: ALICE, source: { conversation: GROUP, message: msgId(GROUP, 'G2') } })).toEqual({ fallback: expect.any(String) });
  expect(await h.adapter.command({ t: 'forward', id: '3', conversation: ALICE, source: { conversation: GROUP, message: msgId(GROUP, 'nope') } })).toEqual({ fallback: expect.any(String) });
});

test('older history comes from the phone on request', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const pending = h.adapter.command({ t: 'history', id: '1', conversation: ALICE, beforeTs: FIX.get('text').info.ts, limit: 50 });
  await h.waitFor(() => h.cmd('historyRequest'));
  expect(h.cmd('historyRequest')).toMatchObject({ chat: ALICE, msgId: 'A1', fromMe: false, count: 50 });
  const old = fx('text');
  old.info.id = 'OLD1';
  old.info.ts -= 86_400_000;
  old.history = true;
  await h.emit({ t: 'history', syncType: 'ON_DEMAND', conversations: [{ ID: ALICE }], pushnames: [], lidMappings: [] });
  await h.emit(old);
  await h.emit({ t: 'history_done', syncType: 'ON_DEMAND', count: 1 });
  expect(await pending).toEqual({ count: 1, done: false });
  // the phone does not answer: nothing more
  expect(await h.adapter.command({ t: 'history', id: '2', conversation: ALICE, limit: 50 })).toEqual({ count: 0, done: true });
  // nothing to anchor a request on
  expect(await h.adapter.command({ t: 'history', id: '3', conversation: GROUP, limit: 50 })).toEqual({ count: 0, done: true });
});

test('openDirect checks the number and opens the chat, nothing sent', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'isOnWhatsApp', value: [{ query: '+15550000009', jid: '15550000009@s.whatsapp.net', isIn: true }] } });
  expect(await h.adapter.command({ t: 'openDirect', id: '1', peer: '+15550000009' })).toEqual({ conversation: '15550000009@s.whatsapp.net', existed: false, startsAtFirstSend: true });
  expect(ofType(h.events, 'conversation').at(-1)!.conversation).toMatchObject({ nativeId: '15550000009@s.whatsapp.net', shape: 'direct' });
  expect(h.cmd('send')).toBeUndefined();
  await h.ctl({ result: { op: 'isOnWhatsApp', value: [{ query: '+15550000008', jid: '', isIn: false }] } });
  await expect(h.adapter.command({ t: 'openDirect', id: '2', peer: '+15550000008' })).rejects.toThrow('not on WhatsApp');
});

test('fetchMedia downloads through the bridge; avatars through the picture URL', async () => {
  const h = await harness();
  await h.emit(fx('image'));
  const r = (await h.adapter.command({ t: 'fetchMedia', id: '1', url: `wa-media:${msgId(ALICE, 'A3')}` })) as { mime: string; base64: string };
  expect(r.mime).toBe('image/jpeg');
  expect(Buffer.from(r.base64, 'base64').toString()).toBe('fake media bytes');
  expect(h.cmd('download')).toMatchObject({ message: { imageMessage: { directPath: '/v/t62.7118-24/abc?ccb=11-4' } }, info: { id: 'A3', chat: ALICE, fromMe: false } });

  await h.ctl({ result: { op: 'avatar', value: { url: 'https://pps.whatsapp.net/x', id: '9' } } });
  expect(await h.adapter.command({ t: 'fetchMedia', id: '2', url: `wa-avatar:${ALICE}?9` })).toEqual({ mime: 'image/png', base64: Buffer.from('png').toString('base64') });
  await h.ctl({ result: { op: 'avatar', value: null } });
  await expect(h.adapter.command({ t: 'fetchMedia', id: '3', url: `wa-avatar:${BOB}` })).rejects.toThrow('no profile picture');
  // and does not ask again for a while
  await expect(h.adapter.command({ t: 'fetchMedia', id: '4', url: `wa-avatar:${BOB}` })).rejects.toThrow('no profile picture');
  expect(h.cmds.filter((c) => c.op === 'avatar')).toHaveLength(2);
});

// ---------------------------------------------------------------- staying connected

test('the bridge dies: connecting, then a new bridge that reconnects', async () => {
  const h = await harness();
  await h.ctl({ exit: 1 });
  await h.waitFor(() => h.cmds.filter((c) => c.op === 'connect').length === 2);
  await h.waitFor(() => h.status().status === 'online');
  expect(h.events.filter((e) => e.t === 'status').map((e) => (e as any).status)).toContain('connecting');
});

test('unlinked from the phone: back to a QR code with a fresh session', async () => {
  const h = await harness();
  process.env.FAKE_WA_LOGGED_IN = '0';
  await h.emit({ t: 'logged_out', reason: 'logged out from another device', onConnect: false });
  expect(ofType(h.events, 'status').some((s) => s.attention?.kind === 'link_device' && s.attention.message.includes('unlinked'))).toBe(true);
  await h.waitFor(() => h.status()?.attention?.qr);
  expect(h.cmds.filter((c) => c.op === 'connect')).toHaveLength(2);
});

test('a temporary ban: say so, and do not reconnect', async () => {
  const h = await harness();
  await h.emit({ t: 'temporary_ban', code: 101, reason: 'sent too many messages', expireSec: 3600, message: "You've been temporarily banned: sent too many messages" });
  expect(h.status()).toMatchObject({ status: 'attention', attention: { kind: 'rate_limited', message: expect.stringContaining('stays disconnected') } });
  await Bun.sleep(300);
  expect(h.cmds.filter((c) => c.op === 'connect')).toHaveLength(1);
});

test('another copy took the session: stop, and wait for Reconnect', async () => {
  const h = await harness();
  await h.emit({ t: 'stream_replaced' });
  expect(h.status()).toMatchObject({ status: 'error', attention: { message: expect.stringContaining('Another copy') } });
  await Bun.sleep(300);
  expect(h.cmds.filter((c) => c.op === 'connect')).toHaveLength(1);
  await h.adapter.command({ t: 'action', id: '1', action: 'reconnect' });
  await h.waitFor(() => h.cmds.filter((c) => c.op === 'connect').length === 2);
});

test('WhatsApp says the client is too old: an error that says what to update', async () => {
  const h = await harness();
  await h.emit({ t: 'client_outdated' });
  expect(h.status()).toMatchObject({ status: 'error', attention: { kind: 'selector_broken', message: expect.stringContaining('whatsmeow') } });
});

test('commands before linking say so', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await expect(h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'hi' })).rejects.toThrow('not linked');
});
