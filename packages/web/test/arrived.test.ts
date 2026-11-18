/** src/arrived.ts: pushes' copies laid over the snapshot until the hub answers. The hub's side: packages/hub/test/arrived.test.ts. */
import { beforeEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { addArrived, dropArrived, heldEnds, isArrivedCopy, openArrived, planOverlay, resetArrived, type ArrivedRecord } from '../src/arrived.ts';
import { db, inbox, timelines } from '../src/store.ts';
import { upsertInto } from '../src/syncmodel.ts';

const msg = (id: string, ts: number, extra: Partial<P.MessageView> = {}): P.MessageView =>
  ({ id, conversationId: 'cnv_a', network: 'discord', nativeId: id, authorId: 'idn_ann', ts, editedTs: null, kind: 'text', body: `body ${id}`, replyToId: null, threadId: null, mentionsSelf: false, deleted: false, attachments: [], embeds: [], reactions: [], seenVia: [], triage: { decision: 'push' } as any, ...extra }) as any;
const vant = (unread: number, lastReadTs = 100): P.VantageView[] => [{ accountId: 'acc_1', unread, mentions: 0, lastReadTs }];
const conv = (id: string, lastAt: number, unread = 0): P.ConversationView =>
  ({ id, shape: 'group', lastMessage: { id: `last_${id}`, authorId: 'idn_bob', ts: lastAt, kind: 'text', text: 'old' }, lastMessageAt: lastAt, vantages: vant(unread) }) as any;
/** A push's record: the message, and its conversation as the hub had it then. */
const pushed = (m: P.MessageView, at: number, unread: number, extra: Partial<P.PushArrived> = {}): ArrivedRecord => ({
  key: `m:${m.id}`,
  kind: 'message',
  conv: m.conversationId,
  at,
  arrived: { message: m, lastMessage: { id: m.id, authorId: m.authorId, ts: m.ts, kind: m.kind, text: m.body }, lastMessageAt: m.ts, vantages: vant(unread), ...extra },
});
const read = (convId: string, at: number, upTo?: number): ArrivedRecord => ({ key: `c:${convId}:${at}:0`, kind: 'clear', conv: convId, at, ...(upTo !== undefined ? { upTo } : {}) });

test('only what is newer than the snapshot shows; each row takes its newest push', () => {
  const snap = new Map([['cnv_a', conv('cnv_a', 1000, 1)]]);
  const plan = planOverlay(
    [pushed(msg('m_old', 900), 1, 1), pushed(msg('m_1', 1100), 2, 2), pushed(msg('m_2', 1200), 3, 3), pushed(msg('m_x', 1300, { conversationId: 'cnv_gone' }), 4, 1), { junk: true }, null],
    (id) => snap.get(id),
  );
  expect(plan.messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
  expect(plan.convs.get('cnv_a')!.lastMessageAt).toBe(1200);
  expect(plan.convs.get('cnv_a')!.vantages[0].unread).toBe(3);
  expect(plan.convs.has('cnv_gone')).toBe(false);
  // Records in any order: the newest still wins.
  const shuffled = planOverlay([pushed(msg('m_2', 1200), 3, 3), pushed(msg('m_1', 1100), 2, 2)], (id) => snap.get(id));
  expect(shuffled.convs.get('cnv_a')!.lastMessageAt).toBe(1200);
  expect(shuffled.messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
});

test('a read elsewhere after the push, up to its message, leaves the row read; one before it or short of it does not', () => {
  const snap = new Map([['cnv_a', conv('cnv_a', 1000, 1)]]);
  const at = (rs: ArrivedRecord[]) => planOverlay(rs, (id) => snap.get(id)).convs.get('cnv_a')!.vantages[0];
  expect(at([pushed(msg('m_1', 1100), 5, 2), read('cnv_a', 6, 1100)]).unread).toBe(0);
  expect(at([pushed(msg('m_1', 1100), 5, 2), read('cnv_a', 6, 1100)]).lastReadTs).toBe(1100);
  expect(at([pushed(msg('m_1', 1100), 5, 2), read('cnv_a', 4, 1100)]).unread).toBe(2);
  expect(at([pushed(msg('m_1', 1100), 5, 2), read('cnv_a', 6, 1050)]).unread).toBe(2);
  // A read alone, of what the snapshot already had: read. Without upTo (an older hub), read too.
  expect(at([read('cnv_a', 6, 1000)]).unread).toBe(0);
  expect(at([read('cnv_a', 6)]).unread).toBe(0);
});

test('a cut copy says so', () => {
  const snap = new Map([['cnv_a', conv('cnv_a', 1000)]]);
  const plan = planOverlay([pushed(msg('m_1', 1100, { body: 'a long mess' }), 1, 1, { cut: true })], (id) => snap.get(id));
  expect(plan.messages[0].body).toBe('a long mess…');
});

beforeEach(() => {
  resetArrived();
  db.conversations.clear();
  timelines.clear();
  inbox.value = [];
});

test('laid over the snapshot, and taken away whole before the hub answers; the hub’s copies stay', () => {
  const before = conv('cnv_a', 1000, 0);
  db.conversations.set('cnv_a', before);
  const kept = msg('m_kept', 1000);
  timelines.set('c:cnv_a', { key: 'c:cnv_a', messages: [kept], hasMore: true, loading: false });
  addArrived([pushed(msg('m_1', 1100), 1, 1), pushed(msg('m_2', 1200), 2, 2)]);
  // Nothing before the snapshot is up.
  expect(db.conversations.get('cnv_a')).toBe(before);
  openArrived(true);
  const t = timelines.get('c:cnv_a')!;
  expect(t.messages.map((m) => m.id)).toEqual(['m_kept', 'm_1', 'm_2']);
  expect(isArrivedCopy(t.messages[1])).toBe(true);
  expect(db.conversations.get('cnv_a')!.vantages[0].unread).toBe(2);
  expect(inbox.value.map((m) => m.id)).toEqual(['m_2', 'm_1']);
  // The hub is asked from what it sent, not from a copy.
  expect(heldEnds(t.messages)).toEqual({ newest: 1000, oldest: 1000 });
  // The hub's own m_1 came first (a timeline's catch-up): it stays when the layer goes; the copy m_2 goes.
  const real = msg('m_1', 1100, { body: 'the hub’s' });
  upsertInto(t.messages, real);
  dropArrived();
  expect(t.messages).toEqual([kept, real]);
  expect(db.conversations.get('cnv_a')).toBe(before);
  expect(inbox.value).toEqual([]);
  // Closed: later records do nothing.
  addArrived([pushed(msg('m_3', 1300), 3, 3)]);
  expect(db.conversations.get('cnv_a')).toBe(before);
});

test('a row something else replaced meanwhile is left as it is', () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  openArrived(true);
  addArrived([pushed(msg('m_1', 1100), 1, 1)]);
  const other = { ...db.conversations.get('cnv_a')!, name: 'renamed' } as P.ConversationView;
  db.conversations.set('cnv_a', other);
  dropArrived();
  expect(db.conversations.get('cnv_a')).toBe(other);
});

test('a later batch (the app’s, after the worker’s) plans again from all of them: an older push does not win', () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  openArrived(true);
  addArrived([pushed(msg('m_2', 1200), 2, 2)]);
  addArrived([pushed(msg('m_1', 1100), 1, 1)]);
  expect(db.conversations.get('cnv_a')!.lastMessageAt).toBe(1200);
  expect(db.conversations.get('cnv_a')!.vantages[0].unread).toBe(2);
  // The same message twice (both stores kept it): one copy.
  addArrived([pushed(msg('m_2', 1200), 2, 2)]);
  timelines.set('c:cnv_a', { key: 'c:cnv_a', messages: [], hasMore: true, loading: false });
  addArrived([read('cnv_a', 1, 0)]);
  expect(timelines.get('c:cnv_a')!.messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
});

test('a start from the hub shows none of it', () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  addArrived([pushed(msg('m_1', 1100), 1, 1)]);
  openArrived(false);
  expect(db.conversations.get('cnv_a')!.lastMessageAt).toBe(1000);
});
