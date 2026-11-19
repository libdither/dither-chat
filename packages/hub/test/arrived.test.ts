/** src/arrived.ts: the copy of a message a push carries, and what of it fits. The device's side: packages/web/test/arrived.test.ts. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { arrivedCopy, fitArrived, PUSH_BYTES } from '../src/arrived.ts';
import { Notifier } from '../src/notify.ts';

const msg = (body: string, extra: Partial<P.MessageView> = {}): P.MessageView =>
  ({
    id: 'msg_1',
    conversationId: 'cnv_1',
    network: 'discord',
    nativeId: 'n1',
    authorId: 'idn_ann',
    ts: 1000,
    editedTs: null,
    kind: 'text',
    body,
    replyToId: null,
    threadId: null,
    mentionsSelf: false,
    deleted: false,
    attachments: [],
    embeds: [{ url: 'https://example.com/a' }],
    reactions: [{ key: '👍', identityIds: ['idn_bob'] }],
    seenVia: ['acc_a'],
    triage: null,
    pinned: true,
    ...extra,
  }) as any;
const conv = (m: P.MessageView): P.ConversationView =>
  ({ id: 'cnv_1', lastMessage: { id: m.id, authorId: m.authorId, ts: m.ts, kind: m.kind, text: m.body }, lastMessageAt: m.ts, vantages: [{ accountId: 'acc_a', unread: 3, mentions: 0, lastReadTs: 500 }], participantIds: ['a', 'b'] }) as any;
const storeOf = (m: P.MessageView | null) => ({ messageView: () => m, conversationView: () => (m ? conv(m) : null) });
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

test('the copy is the message without embeds, reactions or extras, with where its conversation stands', () => {
  const a = arrivedCopy(storeOf(msg('hello')), 'cnv_1', 'msg_1')!;
  expect(a.message.body).toBe('hello');
  expect(a.message.embeds).toEqual([]);
  expect(a.message.reactions).toEqual([]);
  expect((a.message as any).pinned).toBeUndefined();
  expect(a.vantages[0].unread).toBe(3);
  expect(a.lastMessageAt).toBe(1000);
  expect((a as any).participantIds).toBeUndefined();
  // The preview says what the body says: its text is not sent twice.
  expect(a.lastMessage!.text).toBe('');
  expect(a.lastMessage!.id).toBe('msg_1');
  // None for a deleted message, one of another conversation, or one the store does not have.
  expect(arrivedCopy(storeOf(msg('x', { deleted: true })), 'cnv_1', 'msg_1')).toBeNull();
  expect(arrivedCopy(storeOf(msg('x')), 'cnv_2', 'msg_1')).toBeNull();
  expect(arrivedCopy(storeOf(null), 'cnv_1', 'msg_1')).toBeNull();
});

test('what does not fit goes: the attachments first, then the body is cut, and nothing past the limit is sent', () => {
  const att = { id: 'att_1', kind: 'image', url: '/api/media/' + 'x'.repeat(600), name: 'a.png' } as any;
  const small = arrivedCopy(storeOf(msg('short', { attachments: [att] })), 'cnv_1', 'msg_1')!;
  const payload = { title: 'Ann', body: 'short', lines: [] };
  expect(fitArrived(payload, small)).toBe(small);
  // A crowded payload: the attachments go.
  const crowded = { ...payload, filler: 'y'.repeat(PUSH_BYTES - 1200) };
  const noAtt = fitArrived(crowded, small)!;
  expect(noAtt.message.attachments).toEqual([]);
  // Marked as not whole, so the device does not show it as the whole message.
  expect(noAtt.cut).toBe(true);
  expect(bytes({ ...crowded, arrived: noAtt })).toBeLessThanOrEqual(PUSH_BYTES);
  // A long body, in characters of several bytes: cut, and the list's preview with it.
  const long = arrivedCopy(storeOf(msg('日本語のメッセージ'.repeat(200))), 'cnv_1', 'msg_1')!;
  const cut = fitArrived(payload, long)!;
  expect(cut.cut).toBe(true);
  expect(long.message.body.startsWith(cut.message.body)).toBe(true);
  expect(cut.lastMessage!.text.length).toBeLessThanOrEqual(cut.message.body.length);
  expect(bytes({ ...payload, arrived: cut })).toBeLessThanOrEqual(PUSH_BYTES);
  // Pictures alone that do not fit: nothing would be left, so no copy.
  expect(fitArrived(crowded, arrivedCopy(storeOf(msg('', { attachments: [att] })), 'cnv_1', 'msg_1')!)).toBeNull();
  // No room at all: no copy.
  expect(fitArrived({ ...payload, filler: 'y'.repeat(PUSH_BYTES) }, long)).toBeNull();
});

test("a message's push carries the copy; a held one does not, nor does a hub whose store cannot make one", async () => {
  const m = msg('hi there');
  const pushes: Record<string, unknown>[] = [];
  const make = (store: any) =>
    new Notifier({
      store: { notifyLook: () => ({}), one: () => null, ...store },
      phone: { list: () => ({ send: true }), higher: () => {} } as any,
      activity: { notification: () => 'nid_1', sent: () => {} },
      devices: { addressed: () => false, quietOn: () => [] },
      push: { desktops: () => [], notify: async (_t, _b, _c, extra) => (pushes.push(extra), { devices: 1, accepted: 1 }) },
      delivery: { listDue: () => true, plan: () => ({ alert: true, count: 1, conv: { title: 'c', shape: 'direct' }, sender: { name: 'Ann', key: 'ann' }, lines: [], icons: {} }) },
      server: { notify: () => {}, warm: async () => {} },
    });
  const n = make(storeOf(m));
  n.message('Ann', 'hi there', 'cnv_1', 'msg_1', [], {}, 'message', 'push');
  await n.last;
  expect((pushes[0].arrived as P.PushArrived).message.id).toBe('msg_1');
  n.message('Reminder', 'hi', 'cnv_1', 'msg_1', [], {}, 'held', 'push');
  await n.last;
  expect(pushes[1].arrived).toBeUndefined();
  const old = make({});
  old.message('Ann', 'hi there', 'cnv_1', 'msg_1', [], {}, 'message', 'push');
  await old.last;
  expect(pushes[2].arrived).toBeUndefined();
});
