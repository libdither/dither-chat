/** src/outbox.ts: sends kept on the device across a reload, and which message replaces a pending copy. */
import { expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { ECHO_SKEW, mayBeOut, openOutbox, settled, type Echo, type OutboxEntry, type Sent } from '../src/outbox.ts';

const entry = (tempId: string, x: Partial<OutboxEntry> = {}): OutboxEntry => ({ tempId, conversationId: 'cnv_a', body: 'hi', ts: 1000, ...x });

test('what is put survives a new start (a reload opens the outbox again), files and all', async () => {
  const idb = new IDBFactory();
  const before = openOutbox(idb);
  const file = new Blob(['picture bytes'], { type: 'image/png' });
  await before.put(entry('tmp-1', { ts: 2000, files: [{ name: 'a.png', type: 'image/png', blob: file }] }));
  await before.put(entry('tmp-2', { ts: 1000, body: 'first' }));
  await before.put(entry('tmp-3', { ts: 3000 }));
  await before.remove('tmp-3');

  const after = openOutbox(idb);
  const kept = await after.all();
  // Oldest first, so they go out in the order they were written.
  expect(kept.map((e) => e.tempId)).toEqual(['tmp-2', 'tmp-1']);
  expect(kept[0].body).toBe('first');
  const f = kept[1].files![0];
  expect(f.name).toBe('a.png');
  expect(await new Response(f.blob).text()).toBe('picture bytes');
});

test('the upload ids and a refusal are kept with it', async () => {
  const idb = new IDBFactory();
  const o = openOutbox(idb);
  const e = entry('tmp-1');
  await o.put(e);
  e.attachments = ['upl_1'];
  e.failed = 'that upload has expired';
  await o.put(e);
  expect(await openOutbox(idb).all()).toEqual([{ ...entry('tmp-1'), attachments: ['upl_1'], failed: 'that upload has expired' }]);
});

test('without IndexedDB it still works, in memory, as before', async () => {
  const o = openOutbox(undefined);
  await o.put(entry('tmp-1'));
  expect((await o.all()).map((e) => e.tempId)).toEqual(['tmp-1']);
  await o.remove('tmp-1');
  expect(await o.all()).toEqual([]);
});

// ------------------------------------------------------------------ matching

const sent = (tempId: string, x: Partial<Sent> = {}): Sent => ({ tempId, conversationId: 'cnv_a', body: 'hi', ts: 10_000, acked: true, ...x });
const echo = (id: string, x: Partial<Echo> = {}): Echo => ({ id, conversationId: 'cnv_a', body: 'hi', ts: 10_500, attachments: 0, ...x });

test('by the id the hub answered with, whatever the network did to the text', () => {
  const claimed = new Set<string>();
  // The network turned :) into an emoji and a name into a mention.
  expect(settled([sent('t1', { body: 'hi :) @sam', messageId: 'msg_1' })], [echo('msg_1', { body: 'hi 🙂 <@123>' })], claimed)).toEqual(['t1']);
  expect([...claimed]).toEqual(['msg_1']);
});

test('a copy with an id waits for its own message, not one with the same text', () => {
  expect(settled([sent('t1', { messageId: 'msg_2' })], [echo('msg_1')], new Set())).toEqual([]);
});

test('two identical sends are two copies: one message replaces one of them', () => {
  const claimed = new Set<string>();
  const both = [sent('t1', { ts: 10_000 }), sent('t2', { ts: 10_100 })];
  // Without ids (a network that did not say), by text: the first message takes the first copy only.
  expect(settled(both, [echo('msg_1')], claimed)).toEqual(['t1']);
  // The same message again (a later frame, a sync) takes nothing more.
  expect(settled([both[1]], [echo('msg_1')], claimed)).toEqual([]);
  expect(settled([both[1]], [echo('msg_1'), echo('msg_2', { ts: 10_600 })], claimed)).toEqual(['t2']);
  // With ids, each its own.
  const ids = [sent('t3', { messageId: 'msg_3' }), sent('t4', { messageId: 'msg_4' })];
  expect(settled(ids, [echo('msg_4')], new Set())).toEqual(['t4']);
});

test('a copy not yet sent to the hub is matched by nothing', () => {
  // Waiting for the hub, or still uploading: no message can be its own yet.
  expect(settled([sent('t1', { acked: false })], [echo('msg_1', { seen: 11_000 })], new Set())).toEqual([]);
  expect(settled([sent('t1', { messageId: 'msg_1' })], [echo('msg_1')], new Set())).toEqual(['t1']);
});

// ------------------------------------------------------------------ the message before the answer (a slow link)

/** Sent to the hub at `postedAt`, no answer yet. */
const posted = (tempId: string, x: Partial<Sent> = {}): Sent => sent(tempId, { acked: false, postedAt: 10_050, ...x });

test('its message before the answer: the copy is matched at once, and is that message\'s when the answer comes', () => {
  const claimed = new Set<string>();
  const e = echo('msg_1', { seen: 10_400 });
  expect(settled([posted('t1')], [e], claimed)).toEqual(['t1']);
  expect([...claimed]).toEqual(['msg_1']);
  // Hidden meanwhile (state.ts). The answer names it, or does not: either way it goes.
  expect(settled([posted('t1', { echoed: true, acked: true, messageId: 'msg_1' })], [e], claimed)).toEqual(['t1']);
  expect(settled([posted('t1', { echoed: true, acked: true })], [e], claimed)).toEqual(['t1']);
  // Still waiting for its answer: nothing more to do.
  expect(settled([posted('t1', { echoed: true })], [e], claimed)).toEqual([]);
});

test('the answer before its message: matched by id when the message comes, as before', () => {
  const claimed = new Set<string>();
  const s = posted('t1', { acked: true, messageId: 'msg_1' });
  expect(settled([s], [], claimed)).toEqual([]);
  // Another message of ours with the same text is not it.
  expect(settled([s], [echo('msg_0', { seen: 10_300 })], claimed)).toEqual([]);
  expect(settled([s], [echo('msg_0', { seen: 10_300 }), echo('msg_1', { seen: 10_600 })], claimed)).toEqual(['t1']);
  // The hub's `sent` event names it before the answer: by id too.
  expect(settled([posted('t2', { messageId: 'msg_2' })], [echo('msg_2', { seen: 10_600 })], new Set())).toEqual(['t2']);
});

test('two identical quick sends: each copy takes its own message, in send order', () => {
  const claimed = new Set<string>();
  const both = [posted('t1', { ts: 10_000, postedAt: 10_010 }), posted('t2', { ts: 10_100, postedAt: 10_110 })];
  const first = echo('msg_1', { ts: 10_300, seen: 10_400 });
  expect(settled(both, [first], claimed)).toEqual(['t1']);
  // The first message again (an edit, a later frame) takes nothing more; the second takes the second copy.
  expect(settled([both[1]], [first], claimed)).toEqual([]);
  expect(settled([both[1]], [first, echo('msg_2', { ts: 10_350, seen: 10_450 })], claimed)).toEqual(['t2']);
  // Both in one frame: one each.
  expect(settled(both, [echo('msg_3', { ts: 10_300, seen: 10_400 }), echo('msg_4', { ts: 10_350, seen: 10_400 })], new Set())).toEqual(['t1', 't2']);
});

test('the same text sent earlier from another device does not take the copy', () => {
  // "ok" from the laptop came on the socket before this "ok" went to the hub, dated within the skew.
  const laptop = echo('msg_0', { body: 'ok', ts: 9_000, seen: 9_100 });
  const s = posted('t1', { body: 'ok' });
  expect(settled([s], [laptop], new Set())).toEqual([]);
  // Nor once the hub took it without saying which message it became.
  expect(settled([{ ...s, acked: true }], [laptop], new Set())).toEqual([]);
  // Read from a page (when it came is not known): not before the answer.
  expect(settled([s], [echo('msg_0', { body: 'ok', ts: 10_200 })], new Set())).toEqual([]);
  // Dated well before the copy, even if it came after: not it either.
  expect(settled([s], [echo('msg_0', { body: 'ok', ts: 10_000 - ECHO_SKEW - 1, seen: 10_400 })], new Set())).toEqual([]);
  // Its own message after it: that one.
  expect(settled([s], [laptop, echo('msg_1', { body: 'ok', seen: 10_400 })], new Set())).toEqual(['t1']);
});

test('before the answer, only plainly the same message: its text, its files, its account', () => {
  const after = { seen: 10_400 };
  expect(settled([posted('t1')], [echo('msg_1', { ...after, body: 'hi there' })], new Set())).toEqual([]);
  // The network changed the text (an emoji, a mention): left to the answer's id.
  expect(settled([posted('t1', { body: 'hi :)' })], [echo('msg_1', { ...after, body: 'hi 🙂' })], new Set())).toEqual([]);
  expect(settled([posted('t1', { body: 'look', files: ['a.png', 'b.png'] })], [echo('msg_1', { ...after, body: 'look', attachments: 1 })], new Set())).toEqual([]);
  expect(settled([posted('t1', { body: 'look', files: ['a.png', 'b.png'] })], [echo('msg_1', { ...after, body: 'look', attachments: 2 })], new Set())).toEqual(['t1']);
  expect(settled([posted('t1')], [echo('msg_1', { ...after, attachments: 1 })], new Set())).toEqual([]);
  expect(settled([posted('t1', { accountId: 'acc_a' })], [echo('msg_1', { ...after, accountId: 'acc_b' })], new Set())).toEqual([]);
  expect(settled([posted('t1', { accountId: 'acc_a' })], [echo('msg_1', { ...after, accountId: 'acc_a' })], new Set())).toEqual(['t1']);
  expect(settled([posted('t1')], [echo('msg_1', { ...after, conversationId: 'cnv_b' })], new Set())).toEqual([]);
});

test('a failed send whose message came anyway is matched; a refused one is not', () => {
  // No answer, a 504 ("it may have been sent"), an error after the hub handed it on: it may be out, and keeps postedAt,
  // so its message coming later means it went (state.ts then drops the copy and its outbox entry).
  expect(mayBeOut(new TypeError('Failed to fetch'))).toBe(true);
  expect(mayBeOut(Object.assign(new Error('The network did not answer in time'), { status: 504 }))).toBe(true);
  expect(mayBeOut(Object.assign(new Error('adapter failed'), { status: 500 }))).toBe(true);
  expect(settled([posted('t1')], [echo('msg_1', { seen: 20_000 })], new Set())).toEqual(['t1']);
  // A refusal: the hub never sent it. postedAt is cleared, so a message like it is another send's.
  for (const status of [400, 404, 409, 410, 413]) expect(mayBeOut(Object.assign(new Error('no'), { status }))).toBe(false);
  expect(settled([sent('t1', { acked: false, postedAt: undefined })], [echo('msg_1', { seen: 20_000 })], new Set())).toEqual([]);
});
