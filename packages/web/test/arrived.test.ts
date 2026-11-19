/** src/arrived.ts: pushes' copies laid over the snapshot until the hub answers. The hub's side: packages/hub/test/arrived.test.ts. */
import { beforeEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { addArrived, carryArrived, dropArrived, heldEnds, isArrivedCopy, openArrived, planOverlay, resetArrived, stripArrived, type ArrivedRecord } from '../src/arrived.ts';
import { db, inbox, timelines } from '../src/store.ts';
import { upsertInto } from '../src/syncmodel.ts';

const msg = (id: string, ts: number, extra: Partial<P.MessageView> = {}): P.MessageView =>
  ({ id, conversationId: 'cnv_a', network: 'discord', nativeId: id, authorId: 'idn_ann', ts, editedTs: null, kind: 'text', body: `body ${id}`, replyToId: null, threadId: null, mentionsSelf: false, deleted: false, attachments: [], embeds: [], reactions: [], seenVia: [], triage: { decision: 'push' } as any, ...extra }) as any;
const vant = (unread: number, lastReadTs = 100): P.VantageView[] => [{ accountId: 'acc_1', unread, mentions: 0, lastReadTs }];
const conv = (id: string, lastAt: number, unread = 0): P.ConversationView =>
  ({ id, shape: 'group', lastMessage: { id: `last_${id}`, authorId: 'idn_bob', ts: lastAt, kind: 'text', text: 'old' }, lastMessageAt: lastAt, vantages: vant(unread) }) as any;
/** Records are kept at T + their `at` here: what is older than three days is left out. */
const T = Date.now() - 60_000;
/** A push's record: the message, and its conversation as the hub had it then. */
const pushed = (m: P.MessageView, at: number, unread: number, extra: Partial<P.PushArrived> = {}): ArrivedRecord => ({
  key: `m:${m.id}`,
  kind: 'message',
  conv: m.conversationId,
  at: T + at,
  arrived: { message: m, lastMessage: { id: m.id, authorId: m.authorId, ts: m.ts, kind: m.kind, text: m.body }, lastMessageAt: m.ts, vantages: vant(unread), ...extra },
});
const read = (convId: string, at: number, upTo?: number): ArrivedRecord => ({ key: `c:${convId}`, kind: 'clear', conv: convId, at: T + at, ...(upTo !== undefined ? { upTo } : {}) });

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
  // A read alone, of what the snapshot already had: read. Without upTo it is no read (the hub took a phone-list row
  // back): the row stays as it was.
  expect(at([read('cnv_a', 6, 1000)]).unread).toBe(0);
  expect(planOverlay([read('cnv_a', 6)], (id) => snap.get(id)).convs.has('cnv_a')).toBe(false);
  expect(at([pushed(msg('m_1', 1100), 5, 2), read('cnv_a', 6)]).unread).toBe(2);
});

test('nothing kept longer than three days shows', () => {
  const snap = new Map([['cnv_a', conv('cnv_a', 1000)]]);
  const plan = planOverlay([pushed(msg('m_1', 1100), -4 * 24 * 3600 * 1000, 1), pushed(msg('m_2', 1200), 0, 2)], (id) => snap.get(id));
  expect(plan.messages.map((m) => m.id)).toEqual(['m_2']);
});

test("the preview's text, left out when it repeats the body, comes from the body", () => {
  const snap = new Map([['cnv_a', conv('cnv_a', 1000)]]);
  const m = msg('m_1', 1100, { body: 'see you there' });
  const r = pushed(m, 1, 1, { lastMessage: { id: 'm_1', authorId: 'idn_ann', ts: 1100, kind: 'text', text: '' } });
  expect(planOverlay([r], (id) => snap.get(id)).convs.get('cnv_a')!.lastMessage!.text).toBe('see you there');
  // Cut: the preview says so too.
  const cut = pushed(m, 1, 1, { cut: true, lastMessage: { id: 'm_1', authorId: 'idn_ann', ts: 1100, kind: 'text', text: '' } });
  expect(planOverlay([cut], (id) => snap.get(id)).convs.get('cnv_a')!.lastMessage!.text).toBe('see you there…');
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

test('copies that pushed messages off a full inbox put them back when they go', () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  const full = Array.from({ length: 300 }, (_, i) => msg(`m_in${i}`, 900 - i, { triage: { decision: 'push' } as any }));
  inbox.value = full;
  openArrived(true);
  addArrived([pushed(msg('m_1', 1100), 1, 1), pushed(msg('m_2', 1200), 2, 2)]);
  expect(inbox.value.length).toBe(300);
  expect(inbox.value.some((m) => m.id === 'm_in299')).toBe(false);
  dropArrived();
  expect(inbox.value.map((m) => m.id)).toEqual(full.map((m) => m.id));
});

test('a copy changed in place (a reaction) is still a copy, and still goes', () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  timelines.set('c:cnv_a', { key: 'c:cnv_a', messages: [], hasMore: true, loading: false });
  openArrived(true);
  addArrived([pushed(msg('m_1', 1100), 1, 1)]);
  const t = timelines.get('c:cnv_a')!;
  const next = { ...t.messages[0], reactions: [{ key: '👍', identityIds: ['idn_me'] }] } as P.MessageView;
  carryArrived(t.messages[0], next);
  t.messages[0] = next;
  expect(isArrivedCopy(next)).toBe(true);
  dropArrived();
  expect(t.messages).toEqual([]);
});

test("a row the hub replaced while the layer showed stays the hub's, through later batches", () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  openArrived(true);
  addArrived([pushed(msg('m_1', 1100), 1, 1)]);
  const hubs = { ...conv('cnv_a', 1050, 5), name: 'the hub’s' } as P.ConversationView;
  db.conversations.set('cnv_a', hubs);
  addArrived([pushed(msg('m_2', 1200), 2, 2)]);
  expect(db.conversations.get('cnv_a')).toBe(hubs);
  dropArrived();
  expect(db.conversations.get('cnv_a')).toBe(hubs);
});

test('a chat still loading its page keeps its copies when the layer goes, until the page comes', () => {
  db.conversations.set('cnv_a', conv('cnv_a', 1000));
  timelines.set('c:cnv_a', { key: 'c:cnv_a', messages: [], hasMore: true, loading: true });
  openArrived(true);
  addArrived([pushed(msg('m_1', 1100), 1, 1)]);
  const t = timelines.get('c:cnv_a')!;
  expect(t.messages.map((m) => m.id)).toEqual(['m_1']);
  dropArrived();
  expect(t.messages.map((m) => m.id)).toEqual(['m_1']);
  t.loading = false;
  stripArrived(t);
  expect(t.messages).toEqual([]);
});
