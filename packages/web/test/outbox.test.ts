/** src/outbox.ts: sends kept on the device across a reload, and which message replaces a pending copy. */
import { expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { ECHO_SKEW, openOutbox, settled, type Echo, type OutboxEntry, type Sent } from '../src/outbox.ts';

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

test('a copy the hub has not answered for yet is not matched by text', () => {
  // Its answer may still name another message; an echo that came first is found when it does.
  expect(settled([sent('t1', { acked: false })], [echo('msg_1')], new Set())).toEqual([]);
  expect(settled([sent('t1', { messageId: 'msg_1' })], [echo('msg_1')], new Set())).toEqual(['t1']);
});

test('text matching: the same conversation, not older than the copy, files for files', () => {
  expect(settled([sent('t1')], [echo('msg_1', { conversationId: 'cnv_b' })], new Set())).toEqual([]);
  // "ok" sent yesterday is not today's "ok".
  expect(settled([sent('t1')], [echo('msg_1', { ts: 10_000 - ECHO_SKEW - 1 })], new Set())).toEqual([]);
  expect(settled([sent('t1')], [echo('msg_1', { ts: 10_000 - ECHO_SKEW + 1 })], new Set())).toEqual(['t1']);
  expect(settled([sent('t1', { body: '', files: ['a.png'] })], [echo('msg_1', { body: '', attachments: 0 })], new Set())).toEqual([]);
  expect(settled([sent('t1', { body: '', files: ['a.png'] })], [echo('msg_1', { body: '', attachments: 1 })], new Set())).toEqual(['t1']);
  // A message another copy waits for by id is not taken by text.
  expect(settled([sent('t1'), sent('t2', { messageId: 'msg_1', ts: 10_200 })], [echo('msg_1')], new Set())).toEqual(['t2']);
  expect(settled([sent('t1'), sent('t2', { messageId: 'msg_2', ts: 10_200 })], [echo('msg_2')], new Set())).toEqual(['t2']);
});
